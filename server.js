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

const MIN_REPLY_INTERVAL_MS = Number(process.env.MIN_REPLY_INTERVAL_MS || 3000);
const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH || 20);

const inflight = new Set();

const isBotEnabled = () => String(process.env.BOT_ENABLED || "").trim() === "1";
// По умолчанию 1. Выключение: REPLY_TO_REPLIES=0
const replyToRepliesEnabled = () => String(process.env.REPLY_TO_REPLIES || "1").trim() === "1";

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

const isNoiseOnly = (msg) => {
  const m = normalize(msg);
  if (!m) return true;
  if (m.length < 2) return true;

  if (/^(?:[\p{P}\p{S}\p{Z}]+)$/u.test(m)) return true;
  if (/^(?:[\p{Z}\p{Emoji_Presentation}\p{Extended_Pictographic}]+)$/u.test(m)) return true;

  return false;
};

// parent_id != post_id => это ответ в ветке
const isReplyEvent = (value) => {
  const postId = String(value?.post_id || "");
  const parentId = String(value?.parent_id || "");
  if (!postId || !parentId) return false;
  return parentId !== postId;
};

const fetchComment = async (commentId, pageToken) => {
  const url = new URL(`${GRAPH_API_BASE}/${commentId}`);
  url.searchParams.set("fields", "message,from{id,name},permalink_url");
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

const looksNotEnglish = (text) => /[А-Яа-яЁё]/.test(String(text || ""));

const callOpenAi = async (input, temperature = 0.7) => {
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
      input,
      temperature,
      max_output_tokens: 120
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI error ${r.status}: ${t}`);
  }

  const data = await r.json();
  return extractOpenAiText(data);
};

const generateReply = async (comment) => {
  const first = trimReply(await callOpenAi(buildPrompt(comment), 0.7));
  if (!first) throw new Error("Empty OpenAI reply");

  if (!looksNotEnglish(first)) return first;

  const retryPrompt = [
    "Rewrite the reply strictly in English.",
    "Keep it 1 to 2 short sentences.",
    "End with exactly one question.",
    "",
    `Reply to rewrite: "${first}"`
  ].join("\n");

  const second = trimReply(await callOpenAi(retryPrompt, 0.3));
  if (second && !looksNotEnglish(second)) return second;

  return first;
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

const pickId = (obj) => String(obj?.id || obj?.comment_id || obj?.commentId || "").trim();

let runtimePageId = String(process.env.PAGE_ID || "").trim();
let pageIdResolveAttempted = false;

const resolvePageIdOnce = async (pageToken) => {
  if (runtimePageId) return;
  if (pageIdResolveAttempted) return;
  pageIdResolveAttempted = true;

  try {
    const url = new URL(`${GRAPH_API_BASE}/me`);
    url.searchParams.set("fields", "id,name");
    url.searchParams.set("access_token", pageToken);

    const r = await fetch(url.toString());
    if (!r.ok) {
      const t = await r.text();
      console.log("PAGE_ID_AUTO_RESOLVE_FAILED", r.status, t.slice(0, 500));
      return;
    }

    const data = await r.json();
    if (data?.id) {
      runtimePageId = String(data.id).trim();
      console.log("PAGE_ID_AUTO_RESOLVED", runtimePageId, data?.name || "");
    }
  } catch (e) {
    console.log("PAGE_ID_AUTO_RESOLVE_ERROR", String(e));
  }
};

const scheduleQueueProcessing = () => {
  if (processingQueue) return;
  processingQueue = true;

  const runNext = async () => {
    if (!isBotEnabled()) {
      replyQueue.length = 0;
      processingQueue = false;
      console.log("BOT_DISABLED_CLEAR_QUEUE");
      return;
    }

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
      if (replied) lastReplyAt = Date.now();
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

app.post("/webhook", (req, res) => {
  console.log("WEBHOOK IN", new Date().toISOString());
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      if (!isBotEnabled()) {
        console.log("BOT_DISABLED");
        return;
      }

      const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
      if (!entries.length) return;

      const pageToken = process.env.FB_PAGE_TOKEN;
      if (!pageToken) throw new Error("FB_PAGE_TOKEN missing");

      await resolvePageIdOnce(pageToken);
      const pageId = String(runtimePageId || "").trim();

      for (const e of entries) {
        const changes = Array.isArray(e?.changes) ? e.changes : [];
        for (const c of changes) {
          const value = c?.value;

          if (c?.field !== "feed" || value?.item !== "comment" || value?.verb !== "add") {
            continue;
          }

          const commentId = extractCommentId(value);
          if (!commentId) continue;

          if (wasProcessed(commentId)) {
            console.log("SKIP_DUPLICATE", commentId);
            continue;
          }

          if (inflight.has(commentId)) {
            console.log("SKIP_INFLIGHT", commentId);
            continue;
          }

          if (!replyToRepliesEnabled() && isReplyEvent(value)) {
            rememberComment(commentId);
            console.log("SKIP_REPLY_THREAD", commentId);
            continue;
          }

          if (replyQueue.length >= MAX_QUEUE_LENGTH) {
            rememberComment(commentId);
            console.log("RATE_LIMIT_SKIP", commentId);
            continue;
          }

          inflight.add(commentId);

          replyQueue.push(async () => {
            try {
              if (!isBotEnabled()) {
                console.log("BOT_DISABLED_DROP", commentId);
                return false;
              }

              if (wasProcessed(commentId)) {
                console.log("SKIP_DUPLICATE_LATE", commentId);
                return false;
              }

              const comment = await fetchComment(commentId, pageToken);

              if (pageId && String(comment?.from?.id || "") === pageId) {
                rememberComment(commentId);
                console.log("SKIP_SELF", commentId);
                return false;
              }

              if (isNoiseOnly(comment?.message)) {
                rememberComment(commentId);
                console.log("SKIP_NOISE", commentId);
                return false;
              }

              const reply = await generateReply(comment);
              const posted = await postReply(commentId, reply, pageToken);

              rememberComment(commentId);

              const postedId = pickId(posted);
              if (postedId) rememberComment(postedId);

              console.log("REPLIED", comment?.permalink_url || commentId, reply, postedId);
              return true;
            } finally {
              inflight.delete(commentId);
            }
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
