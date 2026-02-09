console.log("SERVER VERSION 2024-02-09 WEBHOOK DEBUG");

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "2mb" }));

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v19.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const MAX_PROCESSED = 5000;
const processedComments = new Map();

const rememberComment = (commentId) => {
  processedComments.set(commentId, Date.now());
  if (processedComments.size <= MAX_PROCESSED) return;
  const oldest = processedComments.keys().next().value;
  if (oldest) processedComments.delete(oldest);
};

const wasProcessed = (commentId) => processedComments.has(commentId);

const fetchComment = async (commentId, pageToken) => {
  const url = new URL(`${GRAPH_API_BASE}/${commentId}`);
  url.searchParams.set("fields", "message,from,permalink_url");
  url.searchParams.set("access_token", pageToken);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch comment: ${response.status} ${text}`);
  }
  return response.json();
};

const buildPrompt = (comment) => {
  const message = comment?.message || "";
  return [
    "Ты дружелюбный админ страницы T.Lifehack USA.",
    "Ответь на комментарий коротко, 1-2 предложения, живо и по делу.",
    "Если уместно, задай один вопрос в конце.",
    "",
    `Комментарий: "${message}"`
  ].join("\n");
};

const extractOpenAiText = (data) => {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const outputs = Array.isArray(data?.output) ? data.output : [];
  for (const output of outputs) {
    const contentItems = Array.isArray(output?.content) ? output.content : [];
    for (const item of contentItems) {
      if (item?.type === "output_text" && typeof item?.text === "string") {
        const text = item.text.trim();
        if (text) return text;
      }
    }
  }
  return "";
};

const generateReply = async (comment) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: buildPrompt(comment),
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${text}`);
  }

  const data = await response.json();
  const reply = extractOpenAiText(data);
  if (!reply) throw new Error("OpenAI response was empty");
  return reply;
};

const postReply = async (commentId, replyText, pageToken) => {
  const response = await fetch(`${GRAPH_API_BASE}/${commentId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: replyText,
      access_token: pageToken
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to post reply: ${response.status} ${text}`);
  }
  return response.json();
};

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.FB_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

const extractCommentIdFromChangeValue = (value) => {
  if (!value) return "";
  if (typeof value.comment_id === "string") return value.comment_id;
  if (value.comment && typeof value.comment.id === "string") return value.comment.id;
  if (typeof value.commentId === "string") return value.commentId;
  if (typeof value.post_id === "string" && value.item === "comment" && typeof value.parent_id === "string") {
    return "";
  }
  return "";
};

app.post("/webhook", (req, res) => {
  // Всегда логируем вход. Без условий.
  console.log("WEBHOOK IN", new Date().toISOString(), {
    method: req.method,
    path: req.path,
    object: req.body?.object,
    hasEntry: Array.isArray(req.body?.entry),
    bodyKeys: req.body ? Object.keys(req.body) : []
  });

  // Всегда быстро отвечаем 200, чтобы Meta не считала доставку проваленной.
  res.sendStatus(200);

  // Дальше обработка асинхронно.
  setImmediate(async () => {
    try {
      const body = req.body || {};

      // Тестовые события и любые события без entry просто логируем.
      const entries = Array.isArray(body.entry) ? body.entry : [];
      if (!entries.length) {
        console.log("WEBHOOK SKIP: no entry", JSON.stringify(body).slice(0, 2000));
        return;
      }

      const pageToken = process.env.FB_PAGE_TOKEN;
      if (!pageToken) throw new Error("FB_PAGE_TOKEN is not set");

      for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];

        // Иногда прилетают не changes, а другие форматы. Логируем и идём дальше.
        if (!changes.length) {
          console.log("WEBHOOK ENTRY WITHOUT CHANGES", JSON.stringify(entry).slice(0, 2000));
          continue;
        }

        for (const change of changes) {
          const field = change?.field;
          const value = change?.value;

          // Логируем любой field, чтобы видеть реальность.
          console.log("WEBHOOK CHANGE", { field, item: value?.item, verb: value?.verb });

          const commentId = extractCommentIdFromChangeValue(value);

          // Тестовый feed status и любые события без comment_id пропускаем.
          if (!commentId) continue;

          if (wasProcessed(commentId)) continue;

          const comment = await fetchComment(commentId, pageToken);
          const replyText = await generateReply(comment);
          await postReply(commentId, replyText, pageToken);
          rememberComment(commentId);

          console.log("REPLIED", { commentId, permalink: comment?.permalink_url || "" });
        }
      }
    } catch (error) {
      console.error("WEBHOOK ASYNC ERROR:", error);
    }
  });
});

app.get("/", (req, res) => {
  res.send("Bot is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));

