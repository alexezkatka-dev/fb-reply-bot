console.log("SERVER VERSION 2024-02-09 WEBHOOK PROD");

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "2mb" }));

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v19.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const MAX_PROCESSED = 5000;
const processedComments = new Map();
const replyQueue = [];
let processingQueue = false;
let lastReplyAt = 0;
const MIN_REPLY_INTERVAL_MS = 3000;
const MAX_QUEUE_LENGTH = 20;

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

const isLikelyBotOrMetaComment = (msg) => {
  const m = normalize(msg).toLowerCase();
  if (!m) return true;
  if (m.length < 2) return true;
  if (/^(?:[\p{P}\p{S}\p{Z}\p{Emoji_Presentation}\p{Extended_Pictographic}]+)$/u.test(m)) {
    return true;
  }
  if (!m.includes("?")) {
    const words = m.split(/\s+/).filter(Boolean);
    const fillers = new Set(["ok", "okay", "nice", "wow", "cool", "lol"]);
    if (words.length === 1 && fillers.has(words[0])) return true;
  }
  return false;
};

const fetchComment = async (commentId, pageToken) => {
  const url = new URL(`${GRAPH_API_BASE}/${commentId}`);
  url.searchParams.set(
    "fields",
    "message,from{id,name},permalink_url,parent{id,from{id,name}}"
  );
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
    "You are a friendly admin replying to a Facebook Page comment.",
    "Reply ONLY in English.",
    "Write 1 to 2 short sentences total.",
    "Friendly, helpful, natural tone.",
    "No hashtags. Do not mention AI, bots, or policies.",
    "End with EXACTLY ONE specific question that encourages a reply.",
    "Prefer choice questions, experience questions, or quick clarifications.",
    "If the user asked a question, answer briefly and ask a clarifying question.",
    "If they say they will try it or thank you, ask about results or timing.",
    "If they express doubt, ask what seems off or which version they use.",
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

const trimReply = (text, maxChars = 200) => {
  const t = String(text || "").trim();
  if (t.length <= maxChars) return t;
  const clipped = t.slice(0, maxChars);
  const lastSentenceEnd = Math.max(
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("!"),
    clipped.lastIndexOf("?")
  );
  if (lastSentenceEnd > 0) return clipped.slice(0, lastSentenceEnd + 1).trim();
  return clipped.trim();
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
  const reply = trimReply(extractOpenAiText(data));
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

const scheduleQueueProcessing = () => {
  if (processingQueue) return;
  processingQueue = true;

  const runNext = async () => {
    if (!replyQueue.length) {
      processingQueue = false;
      return;
    }

    const now = Date.now();
    const waitMs = Math.max(0, MIN_REPLY_INTERVAL_MS - (now - lastReplyAt));
    if (waitMs > 0) {
      setTimeout(runNext, waitMs);
      return;
    }

    const task = replyQueue.shift();
    try {
      const replied = await task();
      if (replied) {
        lastReplyAt = Date.now();
      }
    } catch (err) {
      console.error("QUEUE_TASK_ERROR", err);
    } finally {
      setImmediate(runNext);
    }
  };

  setImmediate(runNext);
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

const isReplyToPage = (comment, pageId) => {
  if (!pageId) return false;
  return String(comment?.parent?.from?.id || "") === String(pageId);
};

const isWebhookReplyToPage = (value, pageId) => {
  if (!pageId) return false;
  const parentId = String(value?.parent_id || "");
  if (!parentId) return false;
  return parentId.startsWith(`${pageId}_`);
};

app.post("/webhook", (req, res) => {
  console.log("WEBHOOK IN", new Date().toISOString());
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const botEnabled = String(process.env.BOT_ENABLED || "").trim() === "1";
      if (!botEnabled) {
        console.log("BOT_DISABLED");
        return;
      }

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
          if (wasProcessed(commentId)) {
            console.log("SKIP_DUPLICATE", commentId);
            continue;
          }

          if (c?.field !== "feed" || value?.item !== "comment" || value?.verb !== "add") {
            console.log("SKIP_EVENT", c?.field, value?.item, value?.verb);
            continue;
          }

          if (isWebhookReplyToPage(value, pageId)) {
            rememberComment(commentId);
            console.log("SKIP_REPLY_TO_PAGE", commentId);
            continue;
          }

          if (replyQueue.length >= MAX_QUEUE_LENGTH) {
            rememberComment(commentId);
            console.log("RATE_LIMIT_SKIP", commentId);
            continue;
          }

          replyQueue.push(async () => {
            const comment = await fetchComment(commentId, pageToken);

            if (pageId && String(comment?.from?.id || "") === pageId) {
              rememberComment(commentId);
              console.log("SKIP_SELF", commentId);
              return false;
            }

            if (isReplyToPage(comment, pageId)) {
              rememberComment(commentId);
              console.log("SKIP_REPLY_TO_PAGE", commentId);
              return false;
            }

            if (isLikelyBotOrMetaComment(comment?.message)) {
              rememberComment(commentId);
              console.log("SKIP_NOISE", commentId);
              return false;
            }

            const reply = await generateReply(comment);
            await postReply(commentId, reply, pageToken);
            rememberComment(commentId);

            console.log("REPLIED", comment?.permalink_url || commentId, reply);
            return true;
          });

          scheduleQueueProcessing();
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
