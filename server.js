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

const normalize = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim();

const isLikelyBotOrMetaComment = (msg) => {
  const m = normalize(msg).toLowerCase();
  if (!m) return true;
  // Отсекаем служебный мусор и "пустые" комменты
  if (m.length < 2) return true;
  if (/^(\.|!|\?|:|,)+$/.test(m)) return true;
  return false;
};

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

// 1) ЖЁСТКО английский
// 2) 1-2 предложения
// 3) ОДИН вопрос в конце, чтобы тянуть ветку
// 4) Без упоминания AI/ботов, без хештегов
// 5) Вопросы, которые запускают диалог: выбор, опыт, уточнение
const buildPrompt = (comment) => {
  const message = normalize(comment?.message);

  return [
    "You are the friendly admin of the Facebook page T.Lifehack USA.",
    "Reply ONLY in English.",
    "Goal: make the user leave a follow-up comment.",
    "Write 1 to 2 short sentences.",
    "End with EXACTLY ONE specific question.",
    "Be warm, helpful, and natural.",
    "Do not mention AI, bots, rules, or policies.",
    "Do not use hashtags.",
    "Avoid long explanations.",
    "",
    `User comment: "${message}"`
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
  return "";
};

app.post("/webhook", (req, res) => {
  console.log("WEBHOOK IN", new Date().toISOString(), {
    method: req.method,
    path: req.path,
    object: req.body?.object,
    hasEntry: Array.isArray(req.body?.entry),
    bodyKeys: req.body ? Object.keys(req.body) : []
  });

  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const body = req.body || {};

      const entries = Array.isArray(body.entry) ? body.entry : [];
      if (!entries.length) {
        console.log("WEBHOOK SKIP: no entry", JSON.stringify(body).slice(0, 2000));
        return;
      }

      const pageToken = process.env.FB_PAGE_TOKEN;
      if (!pageToken) throw new Error("FB_PAGE_TOKEN is not set");

      const pageId = String(process.env.PAGE_ID || "").trim();
      // Рекомендуется выставить PAGE_ID в Render ENV
      // PAGE_ID=102508869198983

      for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];

        if (!changes.length) {
          console.log("WEBHOOK ENTRY WITHOUT CHANGES", JSON.stringify(entry).slice(0, 2000));
          continue;
        }

        for (const change of changes) {
          const field = change?.field;
          const value = change?.value;

          console.log("WEBHOOK CHANGE", { field, item: value?.item, verb: value?.verb });

          // Обрабатываем только комменты
          const commentId = extractCommentIdFromChangeValue(value);
          if (!commentId) continue;

          if (wasProcessed(commentId)) continue;

          const comment = await fetchComment(commentId, pageToken);

          // 1) НЕ отвечать самому себе
          if (pageId && String(comment?.from?.id || "") === pageId) {
            console.log("SKIP: self comment", { commentId });
            rememberComment(commentId);
            continue;
          }

          // 2) НЕ отвечать на мусор/пустые комменты
          if (isLikelyBotOrMetaComment(comment?.message)) {
            console.log("SKIP: empty/low-signal", { commentId });
            rememberComment(commentId);
            continue;
          }

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
