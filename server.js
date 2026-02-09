const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const GRAPH_API_VERSION = "v19.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const MAX_PROCESSED = 5000;
const processedComments = new Map();

const rememberComment = (commentId) => {
  processedComments.set(commentId, Date.now());
  if (processedComments.size <= MAX_PROCESSED) {
    return;
  }
  const oldest = processedComments.keys().next().value;
  if (oldest) {
    processedComments.delete(oldest);
  }
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
    "Ответь на комментарий коротко (1-2 предложения), живо и по делу.",
    "Добавь лёгкий призыв к вовлечению, если уместно.",
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
        if (text) {
          return text;
        }
      }
    }
  }
  return "";
};

const generateReply = async (comment) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
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
  if (!reply) {
    throw new Error("OpenAI response was empty");
  }
  return reply;
};

const postReply = async (commentId, replyText, pageToken) => {
  const response = await fetch(`${GRAPH_API_BASE}/${commentId}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
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

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const commentId =
      value?.comment_id || value?.comment?.id || value?.commentId;

    if (!commentId) {
      return res.sendStatus(200);
    }

    if (wasProcessed(commentId)) {
      return res.sendStatus(200);
    }

    const pageToken = process.env.FB_PAGE_TOKEN;
    if (!pageToken) {
      throw new Error("FB_PAGE_TOKEN is not set");
    }

    const comment = await fetchComment(commentId, pageToken);
    const replyText = await generateReply(comment);
    await postReply(commentId, replyText, pageToken);
    rememberComment(commentId);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    return res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("Bot is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));
