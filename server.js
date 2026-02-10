console.log("SERVER VERSION 2024-02-09 WEBHOOK PROD");

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "2mb" }));

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v19.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const MAX_PROCESSED = 5000;
const processedComments = new Map();

// очередь: храним задачи с временем, когда их разрешено выполнять
const replyQueue = [];
let processingQueue = false;

// глобальная защита “между ответами”
let nextReplyAllowedAt = 0;

const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH || 20);

const FIRST_REPLY_MIN_MS = Number(process.env.FIRST_REPLY_MIN_MS || 20000);
const FIRST_REPLY_MAX_MS = Number(process.env.FIRST_REPLY_MAX_MS || 30000);

const BETWEEN_REPLY_MIN_MS = Number(process.env.BETWEEN_REPLY_MIN_MS || 15000);
const BETWEEN_REPLY_MAX_MS = Number(process.env.BETWEEN_REPLY_MAX_MS || 45000);

// лимиты и вероятности
const MAX_REPLIES_PER_HOUR = Number(process.env.MAX_REPLIES_PER_HOUR || 40);
const MAX_REPLIES_PER_DAY = Number(process.env.MAX_REPLIES_PER_DAY || 300);
const MAX_BOT_REPLIES_PER_THREAD = Number(process.env.MAX_BOT_REPLIES_PER_THREAD || 3);

const REPLY_PROB_TOP = Number(process.env.REPLY_PROB_TOP || 0.9);
const REPLY_PROB_REPLY = Number(process.env.REPLY_PROB_REPLY || 0.7);

const IGNORE_OLD_COMMENTS_MIN = Number(process.env.IGNORE_OLD_COMMENTS_MIN || 5);

// контекст поста
const POST_CONTEXT_MAX_CHARS = Number(process.env.POST_CONTEXT_MAX_CHARS || 800);
const POST_CACHE_TTL_MS = Number(process.env.POST_CACHE_TTL_MS || 10 * 60 * 1000);
const postCache = new Map();

// логирование webhook и пропусков
const LOG_WEBHOOK_MESSAGE = String(process.env.LOG_WEBHOOK_MESSAGE || "0").trim() === "1";
const WEBHOOK_MESSAGE_MAX_CHARS = Number(process.env.WEBHOOK_MESSAGE_MAX_CHARS || 220);
const SKIP_MESSAGE_MAX_CHARS = Number(process.env.SKIP_MESSAGE_MAX_CHARS || 160);

// кеш комментариев, чтобы не дергать Graph два раза
const COMMENT_CACHE_TTL_MS = Number(process.env.COMMENT_CACHE_TTL_MS || 2 * 60 * 1000);
const commentCache = new Map();

const replyHour = [];
const replyDay = [];
const threadReplies = new Map();

const inflight = new Set();

const isBotEnabled = () => String(process.env.BOT_ENABLED || "").trim() === "1";
// По умолчанию 1. Выключение: REPLY_TO_REPLIES=0
const replyToRepliesEnabled = () => String(process.env.REPLY_TO_REPLIES || "1").trim() === "1";

const nowMs = () => Date.now();

const safeSlice = (s, n) => {
  const t = String(s || "");
  if (!n || n <= 0) return "";
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/\s+/g, " ").trim();
};

const logJson = (tag, obj) => {
  try {
    console.log(tag, JSON.stringify(obj));
  } catch (e) {
    console.log(tag, String(e));
  }
};

const logWebhookEvent = (meta) => {
  logJson("WEBHOOK_EVENT", meta || {});
};

const logSkip = (reason, meta) => {
  logJson("SKIP", { reason, ...(meta || {}) });
};

const randInt = (min, max) => {
  const a = Number(min);
  const b = Number(max);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
};

const prune = (arr, windowMs) => {
  const cutoff = nowMs() - windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
};

const canReplyByRate = () => {
  prune(replyHour, 60 * 60 * 1000);
  prune(replyDay, 24 * 60 * 60 * 1000);
  return replyHour.length < MAX_REPLIES_PER_HOUR && replyDay.length < MAX_REPLIES_PER_DAY;
};

const markReply = () => {
  const t = nowMs();
  replyHour.push(t);
  replyDay.push(t);
};

const pruneThreadReplies = () => {
  const cutoff = nowMs() - 48 * 60 * 60 * 1000;
  for (const [k, v] of threadReplies.entries()) {
    if (!v || v.ts < cutoff) threadReplies.delete(k);
  }
};

const getThreadKey = (value, commentId) => {
  const parentId = String(value?.parent_id || "");
  const postId = String(value?.post_id || "");
  if (parentId && postId && parentId !== postId) return parentId;
  return commentId;
};

const canReplyInThread = (threadKey) => {
  pruneThreadReplies();
  const cur = threadReplies.get(threadKey);
  const count = Number(cur?.count || 0);
  return count < MAX_BOT_REPLIES_PER_THREAD;
};

const markThreadReply = (threadKey) => {
  const cur = threadReplies.get(threadKey);
  const count = Number(cur?.count || 0) + 1;
  threadReplies.set(threadKey, { count, ts: nowMs() });
};

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

  const low = m.toLowerCase();
  const words = low.split(/\s+/).filter(Boolean);
  const fillers = new Set(["ok", "okay", "nice", "wow", "cool", "lol", "thanks", "thx", "great", "good", "gg"]);
  if (words.length === 1 && fillers.has(words[0])) return true;

  return false;
};

// parent_id != post_id => это ответ в ветке
const isReplyEvent = (value) => {
  const postId = String(value?.post_id || "");
  const parentId = String(value?.parent_id || "");
  if (!postId || !parentId) return false;
  return parentId !== postId;
};

const pruneCommentCache = () => {
  const cutoff = nowMs() - COMMENT_CACHE_TTL_MS;
  for (const [k, v] of commentCache.entries()) {
    if (!v || v.ts < cutoff) commentCache.delete(k);
  }
};

const getCachedComment = (commentId) => {
  pruneCommentCache();
  const v = commentCache.get(commentId);
  if (!v) return null;
  if (nowMs() - v.ts > COMMENT_CACHE_TTL_MS) {
    commentCache.delete(commentId);
    return null;
  }
  return v.comment || null;
};

const setCachedComment = (commentId, comment) => {
  pruneCommentCache();
  commentCache.set(commentId, { ts: nowMs(), comment });
};

const fetchComment = async (commentId, pageToken) => {
  const url = new URL(`${GRAPH_API_BASE}/${commentId}`);
  url.searchParams.set(
    "fields",
    "message,from{id,name},permalink_url,created_time,parent{id,message,from{id,name}}"
  );
  url.searchParams.set("access_token", pageToken);

  const r = await fetch(url.toString());
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Fetch comment failed ${r.status}: ${t}`);
  }
  return r.json();
};

const fetchPost = async (postId, pageToken) => {
  if (!postId) return null;

  const url = new URL(`${GRAPH_API_BASE}/${postId}`);
  url.searchParams.set(
    "fields",
    [
      "message",
      "story",
      "permalink_url",
      "created_time",
      "attachments{media_type,title,description,url}"
    ].join(",")
  );
  url.searchParams.set("access_token", pageToken);

  const r = await fetch(url.toString());
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Fetch post failed ${r.status}: ${t}`);
  }
  return r.json();
};

const buildPostContext = (post) => {
  if (!post) return "";

  const parts = [];

  const msg = normalize(post?.message);
  const story = normalize(post?.story);

  if (msg) parts.push(`Post caption: "${msg}"`);
  else if (story) parts.push(`Post text: "${story}"`);

  const att = post?.attachments?.data;
  if (Array.isArray(att) && att.length) {
    const a = att[0];
    const t = normalize(a?.title);
    const d = normalize(a?.description);
    const mt = normalize(a?.media_type);

    if (mt) parts.push(`Attachment type: ${mt}`);
    if (t) parts.push(`Attachment title: "${t}"`);
    if (d) parts.push(`Attachment description: "${d}"`);
  }

  const out = parts.join("\n");
  return safeSlice(out, POST_CONTEXT_MAX_CHARS);
};

const getPostContext = async (postId, pageToken) => {
  if (!postId) return "";

  const cached = postCache.get(postId);
  const now = nowMs();

  if (cached && now - cached.ts < POST_CACHE_TTL_MS) return cached.text || "";

  try {
    const post = await fetchPost(postId, pageToken);
    const text = buildPostContext(post);
    postCache.set(postId, { ts: now, text });
    return text;
  } catch (e) {
    postCache.set(postId, { ts: now, text: "" });
    console.log("POST_CONTEXT_FETCH_FAILED", postId, String(e).slice(0, 300));
    return "";
  }
};

const buildPrompt = (comment, postContext) => {
  const text = normalize(comment?.message);
  const parentMsg = normalize(comment?.parent?.message);
  const ctx = normalize(postContext);

  const lines = [
    "You are a friendly admin replying to a Facebook Page comment.",
    "Reply ONLY in English.",
    "Write 1 to 2 short sentences total.",
    "Friendly, helpful, natural tone.",
    "No hashtags. Do not mention AI, bots, or policies.",
    "Use the post context below. Keep your reply aligned with what the video/post is about.",
    "End with EXACTLY ONE specific question that encourages a reply.",
    "Ask a question that matches the post topic and the user comment, not generic app or version questions.",
    "If the user asked a question, answer briefly and ask one clarifying question about their case.",
    "If they say they will try it or thank you, ask about results or timing related to the post topic.",
    "If they express doubt, ask what part seems wrong or what exactly they tried.",
    ""
  ];

  if (ctx) {
    lines.push("Post context:");
    lines.push(ctx);
    lines.push("");
  }

  if (parentMsg) {
    lines.push(`Parent comment in the thread: "${parentMsg}"`);
    lines.push("");
  }

  lines.push(`User comment: "${text}"`);

  return lines.join("\n");
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
      max_output_tokens: 140
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI error ${r.status}: ${t}`);
  }

  const data = await r.json();
  return extractOpenAiText(data);
};

const generateReply = async (comment, postContext) => {
  const first = trimReply(await callOpenAi(buildPrompt(comment, postContext), 0.7));
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

// берём задачу с самым ранним dueAt
const getNextTaskIndex = () => {
  let bestIdx = -1;
  let bestDue = Infinity;
  for (let i = 0; i < replyQueue.length; i++) {
    const dueAt = Number(replyQueue[i]?.dueAt || 0);
    if (dueAt < bestDue) {
      bestDue = dueAt;
      bestIdx = i;
    }
  }
  return bestIdx;
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

    const idx = getNextTaskIndex();
    if (idx < 0) {
      processingQueue = false;
      return;
    }

    const taskObj = replyQueue[idx];
    const now = Date.now();

    const dueAt = Number(taskObj.dueAt || 0);
    const waitForDue = Math.max(0, dueAt - now);

    const waitForGlobal = Math.max(0, nextReplyAllowedAt - now);

    const waitMs = Math.max(waitForDue, waitForGlobal);

    if (waitMs > 0) {
      setTimeout(runNext, waitMs);
      return;
    }

    replyQueue.splice(idx, 1);

    try {
      const replied = await taskObj.run();
      if (replied) {
        const gap = randInt(BETWEEN_REPLY_MIN_MS, BETWEEN_REPLY_MAX_MS);
        nextReplyAllowedAt = Date.now() + gap;
      }
    } catch (err) {
      console.error("QUEUE_TASK_ERROR", err);
      const gap = randInt(BETWEEN_REPLY_MIN_MS, BETWEEN_REPLY_MAX_MS);
      nextReplyAllowedAt = Date.now() + gap;
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
  const ts = new Date().toISOString();
  console.log("WEBHOOK IN", ts);
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

          const postId = String(value?.post_id || "").trim();
          const parentId = String(value?.parent_id || "").trim();
          const isReply = isReplyEvent(value);
          const threadKey = getThreadKey(value, commentId);

          let webhookMsg = "";
          let webhookFrom = "";

          if (LOG_WEBHOOK_MESSAGE) {
            const cached = getCachedComment(commentId);
            if (cached) {
              webhookMsg = safeSlice(cached?.message, WEBHOOK_MESSAGE_MAX_CHARS);
              webhookFrom = String(cached?.from?.name || "");
            } else {
              try {
                const fetched = await fetchComment(commentId, pageToken);
                setCachedComment(commentId, fetched);
                webhookMsg = safeSlice(fetched?.message, WEBHOOK_MESSAGE_MAX_CHARS);
                webhookFrom = String(fetched?.from?.name || "");
              } catch (err) {
                logJson("WEBHOOK_MESSAGE_FETCH_FAILED", {
                  commentId,
                  postId,
                  err: String(err).slice(0, 220)
                });
              }
            }
          }

          logWebhookEvent({
            at: ts,
            commentId,
            postId,
            parentId,
            isReply,
            created_time: value?.created_time || null,
            queueLen: replyQueue.length,
            msg: webhookMsg,
            from: webhookFrom
          });

          if (wasProcessed(commentId)) {
            logSkip("DUPLICATE", { commentId, postId, threadKey, msg: safeSlice(webhookMsg, SKIP_MESSAGE_MAX_CHARS) });
            continue;
          }

          if (inflight.has(commentId)) {
            logSkip("INFLIGHT", { commentId, postId, threadKey, msg: safeSlice(webhookMsg, SKIP_MESSAGE_MAX_CHARS) });
            continue;
          }

          if (!replyToRepliesEnabled() && isReply) {
            rememberComment(commentId);
            logSkip("REPLY_THREAD_DISABLED", {
              commentId,
              postId,
              threadKey,
              msg: safeSlice(webhookMsg, SKIP_MESSAGE_MAX_CHARS)
            });
            continue;
          }

          // игнор старых, чтобы после рестарта не трогать прошлое
          const createdSec = Number(value?.created_time || 0);
          if (createdSec) {
            const createdMs = createdSec * 1000;
            const ageSec = Math.floor((nowMs() - createdMs) / 1000);
            if (nowMs() - createdMs > IGNORE_OLD_COMMENTS_MIN * 60 * 1000) {
              rememberComment(commentId);
              logSkip("OLD_COMMENT", {
                commentId,
                postId,
                threadKey,
                created_time: createdSec,
                ageSec,
                msg: safeSlice(webhookMsg, SKIP_MESSAGE_MAX_CHARS)
              });
              continue;
            }
          }

          // вероятность ответа
          const prob = isReply ? REPLY_PROB_REPLY : REPLY_PROB_TOP;
          const rnd = Math.random();
          if (rnd > prob) {
            rememberComment(commentId);
            logSkip("PROBABILITY", {
              commentId,
              postId,
              threadKey,
              isReply,
              prob,
              rnd,
              msg: safeSlice(webhookMsg, SKIP_MESSAGE_MAX_CHARS)
            });
            continue;
          }

          // лимит по времени
          if (!canReplyByRate()) {
            rememberComment(commentId);
            prune(replyHour, 60 * 60 * 1000);
            prune(replyDay, 24 * 60 * 60 * 1000);
            logSkip("RATE_LIMIT", {
              commentId,
              postId,
              threadKey,
              hourCount: replyHour.length,
              dayCount: replyDay.length,
              msg: safeSlice(webhookMsg, SKIP_MESSAGE_MAX_CHARS)
            });
            continue;
          }

          // лимит на ветку
          pruneThreadReplies();
          const cur = threadReplies.get(threadKey);
          const threadCount = Number(cur?.count || 0);
          if (threadCount >= MAX_BOT_REPLIES_PER_THREAD) {
            rememberComment(commentId);
            logSkip("THREAD_LIMIT", {
              commentId,
              postId,
              threadKey,
              threadCount,
              msg: safeSlice(webhookMsg, SKIP_MESSAGE_MAX_CHARS)
            });
            continue;
          }

          if (replyQueue.length >= MAX_QUEUE_LENGTH) {
            rememberComment(commentId);
            logSkip("QUEUE_FULL", {
              commentId,
              postId,
              threadKey,
              queueLen: replyQueue.length,
              msg: safeSlice(webhookMsg, SKIP_MESSAGE_MAX_CHARS)
            });
            continue;
          }

          inflight.add(commentId);

          const firstDelay = randInt(FIRST_REPLY_MIN_MS, FIRST_REPLY_MAX_MS);
          const dueAt = Date.now() + firstDelay;

          replyQueue.push({
            commentId,
            postId,
            threadKey,
            dueAt,
            run: async () => {
              try {
                if (!isBotEnabled()) {
                  logSkip("BOT_DISABLED_DROP", { commentId, postId, threadKey });
                  return false;
                }

                if (wasProcessed(commentId)) {
                  logSkip("DUPLICATE_LATE", { commentId, postId, threadKey });
                  return false;
                }

                let comment = getCachedComment(commentId);
                if (!comment) {
                  comment = await fetchComment(commentId, pageToken);
                  setCachedComment(commentId, comment);
                }

                const msgNow = safeSlice(comment?.message, SKIP_MESSAGE_MAX_CHARS);

                if (pageId && String(comment?.from?.id || "") === pageId) {
                  rememberComment(commentId);
                  logSkip("SELF", { commentId, postId, threadKey, msg: msgNow });
                  return false;
                }

                if (isNoiseOnly(comment?.message)) {
                  rememberComment(commentId);
                  logSkip("NOISE", { commentId, postId, threadKey, msg: msgNow });
                  return false;
                }

                const postContext = await getPostContext(postId, pageToken);

                const reply = await generateReply(comment, postContext);
                const posted = await postReply(commentId, reply, pageToken);

                rememberComment(commentId);

                const postedId = pickId(posted);
                if (postedId) rememberComment(postedId);

                markReply();
                markThreadReply(threadKey);

                logJson("REPLIED", {
                  commentId,
                  postId,
                  threadKey,
                  firstDelayMs: firstDelay,
                  msg: msgNow,
                  reply,
                  postedId,
                  permalink: comment?.permalink_url || ""
                });

                return true;
              } finally {
                inflight.delete(commentId);
              }
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
