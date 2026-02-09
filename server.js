console.log("SERVER VERSION 2024-02-09 WEBHOOK PROD");

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "2mb" }));

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v19.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const MAX_PROCESSED = 5000;
const processedComments = new Map();

const rememberComment = (id) => {
  processedComments.set(id, Date.now());
  if (processedComments.size <= MAX_PROCESSED) return;
  const oldest = processedComments.keys().next().value;
  if (oldest) processedComments.delete(oldest);
};

const wasProcessed = (id) => processedComments.has(id);

const normalize = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim();

const isLowSignal = (msg) => {
  const m = normalize(msg).toLowerCase();
  if (!m) return true;
  if (m.length < 2) return true;
  if (/^(\.|!|\?|,)+$/.test(m)) return true;
  return false;
};

const fetchComment = async (commentId, pageToken) => {
  const url = new URL(`${GRAPH_API_BASE}/${commentId}`);
  url.searchParams.set("fields", "message,from,permalink_url");
  url.searchParams.set("access_token", pageToken);

  const r = await fetch(url.toString());
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Fetch comment failed ${r.status}: ${t}`);
  }
  return r.json();
};

const buildPrompt = (comment) => {
  const text = normalize(comment?.message);

  return [
    "You are a friendly admin of the Facebook page T.Lifehack USA.",
    "Reply ONLY in English.",
    "Write 1 or 2 short sentences.",
    "Sound natural and human.",
    "Do not explain or defend.",
    "Do not mention AI or bots.",
    "End with EXACTLY ONE simple question.",
    "Goal: make the user reply again.",
    "",
    `User comment: "${text}"`
  ].join("\n");
};

const extractOpenAiText = (data) => {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const outputs = Array.isArray(data?.output) ? data.output : [];
  for (const o of outputs) {
    const items = Array.isArray(o?.content) ? o.content : [];
    for (const i of items) {
      if (i?.type === "output_text" && typeof i?.text === "string") {
        const t = i.text.trim();
        if (t) return t;
      }
    }
  }
  return "";
};

const generateReply = async (comment) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const r = await fetch("https://api.openai.com/v1/responses", {
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

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI error ${r.status}: ${t}`);
  }

  const data = await r.json();
  const reply = extractOpenAiText(data);
  if (!reply) throw new Error("Empty OpenAI reply");
  return reply;
};

const postReply = async (commentId, text, pageToken) => {
  const r = await fetch(`${GRAPH_API_BASE}/${commentId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: text,
      access_token: pageToken
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Post reply failed ${r.status}: ${t}`);
  }
  return r.json();
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

const extractCommentId = (v) => {
  if (!v) return "";
  if (typeof v.comment_id === "string") return v.comment_id;
  if (v.comment?.id) return v.comment.id;
  if (v.commentId) return v.commentId;
  return "";
};

app.post("/webhook", (req, res) => {
  console.log("WEBHOOK IN", new Date().toISOString());
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
      if (!entries.length) return;

      const pageToken = process.env.FB_PAGE_TOKEN;
      const pageId = String(process.env.PAGE_ID || "").trim();
      if (!pageToken) throw new Error("FB_PAGE_TOKEN missing");

      for (const e of entries) {
        const changes = Array.isArray(e?.changes) ? e.changes : [];
        for (const c of changes) {
          const value = c?.value;
          const commentId = extractCommentId(value);
          if (!commentId) continue;
          if (wasProcessed(commentId)) continue;

          const comment = await fetchComment(commentId, pageToken);

          if (pageId && String(comment?.from?.id || "") === pageId) {
            rememberComment(commentId);
            continue;
          }

          if (isLowSignal(comment?.message)) {
            rememberComment(commentId);
            continue;
          }

          const reply = await generateReply(comment);
          await postReply(commentId, reply, pageToken);
          rememberComment(commentId);

          console.log("REPLIED", comment?.permalink_url || commentId);
        }
      }
    } catch (err) {
      console.error("WEBHOOK ERROR", err);
    }
  });
});

app.get("/", (_, res) => res.send("Bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));
