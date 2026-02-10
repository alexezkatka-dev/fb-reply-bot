console.log("SERVER VERSION 2026-02-11 WEBHOOK PROD");

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "2mb" }));

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v19.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const MAX_PROCESSED = 5000;
const processedComments = new Map();

// очередь: задачи с временем, когда их разрешено выполнять
const replyQueue = [];
let processingQueue = false;

// глобальная защита “между ответами”
let nextReplyAllowedAt = 0;
// глобальная защита “между лайками”
let nextLikeAllowedAt = 0;

const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH || 20);

const FIRST_REPLY_MIN_MS = Number(process.env.FIRST_REPLY_MIN_MS || 20000);
const FIRST_REPLY_MAX_MS = Number(process.env.FIRST_REPLY_MAX_MS || 30000);

const BETWEEN_REPLY_MIN_MS = Number(process.env.BETWEEN_REPLY_MIN_MS || 15000);
const BETWEEN_REPLY_MAX_MS = Number(process.env.BETWEEN_REPLY_MAX_MS || 45000);

// лайк перед ответом
const LIKE_ENABLED = String(process.env.LIKE_ENABLED || "1").trim() === "1";
const LIKE_MIN_MS = Number(process.env.LIKE_MIN_MS || 0);
const LIKE_MAX_MS = Number(process.env.LIKE_MAX_MS || 3000);

const REPLY_AFTER_LIKE_MIN_MS = Number(process.env.REPLY_AFTER_LIKE_MIN_MS || 25000);
const REPLY_AFTER_LIKE_MAX_MS = Number(process.env.REPLY_AFTER_LIKE_MAX_MS || 60000);

const BETWEEN_LIKE_MIN_MS = Number(process.env.BETWEEN_LIKE_MIN_MS || 2000);
const BETWEEN_LIKE_MAX_MS = Number(process.env.BETWEEN_LIKE_MAX_MS || 8000);

// лимиты и вероятности
const MAX_REPLIES_PER_HOUR = Number(process.env.MAX_REPLIES_PER_HOUR || 40);
const MAX_REPLIES_PER_DAY = Number(process.env.MAX_REPLIES_PER_DAY || 300);
const MAX_BOT_REPLIES_PER_THREAD = Number(process.env.MAX_BOT_REPLIES_PER_THREAD || 3);

// по умолчанию отвечаем на все, можно опустить через env
const REPLY_PROB_TOP = Number(process.env.REPLY_PROB_TOP || 1);
const REPLY_PROB_REPLY = Number(process.env.REPLY_PROB_REPLY || 1);

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

// BAIT COMMENT (для закрепа)
const BAIT_ENABLED = String(process.env.BAIT_ENABLED || "1").trim() === "1";
const BAIT_ON_NEW_POST = String(process.env.BAIT_ON_NEW_POST || "1").trim() === "1";
const BAIT_ON_FIRST_COMMENT = String(process.env.BAIT_ON_FIRST_COMMENT || "1").trim() === "1";
const BAIT_DELAY_MIN_MS = Number(process.env.BAIT_DELAY_MIN_MS || 1500);
const BAIT_DELAY_MAX_MS = Number(process.env.BAIT_DELAY_MAX_MS || 4000);
const BAIT_CACHE_TTL_MS = Number(process.env.BAIT_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const BAIT_MAX_CHARS = Number(process.env.BAIT_MAX_CHARS || 220);

const baitCache = new Map(); // postId -> { ts, commentId, text }
const baitInflight = new Set(); // postId

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

const logWebhookEvent = (meta) => logJson("WEBHOOK_EVENT", meta || {});
const logSkip = (reason, meta) => logJson("SKIP", { reason, ...(meta || {}) });

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

const allowReplyByRate = () => {
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

const allowReplyInThread = (threadKey) => {
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

  return false;
};

const getFirstName = (fullName) => {
  const n = normalize(fullName).replace(/[^A-Za-zÀ-ÿ' -]/g, "").trim();
  if (!n) return "";
  const first = n.split(/\s+/)[0] || "";
  return first.slice(0, 24);
};

const extractLocation = (text) => {
  const s = normalize(text);
  if (!s) return "";

  const m = s.match(/\b(?:from|in|here in|out in)\s+([A-Za-z][A-Za-z .'-]{2,40})(?:,\s*([A-Z]{2}))?\b/i);
  if (!m) return "";

  const raw = normalize(m[1] || "");
  const st = normalize(m[2] || "");

  const bad = new Set(["this", "the", "a", "my", "your", "that", "it", "here", "there", "video", "post", "comments", "thread"]);
  const firstWord = raw.split(/\s+/)[0]?.toLowerCase() || "";
  if (bad.has(firstWord)) return "";

  const cleaned = raw.replace(/[^A-Za-z .'-]/g, "").trim();
  if (!cleaned) return "";

  if (st && /^[A-Z]{2}$/.test(st)) return `${cleaned}, ${st}`;
  return cleaned;
};

const analyzeSignals = (comment) => {
  const msg = normalize(comment?.message);
  const parent = normalize(comment?.parent?.message);
  const joined = `${parent} ${msg}`.trim();

  const sarcasmLikely =
    /\/s\b|sarcasm|yeah right|sure buddy|what a discovery|captain obvious|thanks a lot/i.test(joined);

  const jinxingLikely =
    /\bjinx\b|don't jinx|dont jinx|knock on wood|appliance gods|curse|hex|now you're gonna have|now youre gonna have|you'll have problems|youll have problems/i.test(
      joined
    );

  const bsLikely =
    /\b(bullshit|bs|b\s*s|not true|fake|doesn'?t work|does not work|waste of time|scam)\b/i.test(joined);

  const debateLikely =
    /\bfake\b|\bcap\b|\bbs\b|doesn'?t work|works\b|i tried|tried it|tested|no it|nah it/i.test(joined);

  const worryLikely =
    /\bgonna break\b|\bgoing to break\b|break my|crack|damage|ruin|snap|strip the/i.test(joined);

  const praiseLikely =
    /\b(thanks|thank you|helped|works|worked|love this|awesome|great|genius|saved me|life saver)\b/i.test(joined);

  const questionLikely = /\?/.test(msg);

  const location = extractLocation(joined);

  return { sarcasmLikely, jinxingLikely, bsLikely, debateLikely, worryLikely, praiseLikely, questionLikely, location };
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

const readGraphResult = async (r) => {
  const t = await r.text();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch (_) {
    return t;
  }
};

const likeComment = async (commentId, pageToken) => {
  const r = await fetch(`${GRAPH_API_BASE}/${commentId}/likes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: pageToken })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Like failed ${r.status}: ${t}`);
  }

  const data = await readGraphResult(r);
  if (data === true) return true;
  if (data === "true") return true;
  if (data && typeof data === "object" && data.success === true) return true;

  return true;
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

const buildPrompt = (comment, postContext, meta = {}) => {
  const text = normalize(comment?.message);
  const parentMsg = normalize(comment?.parent?.message);
  const ctx = normalize(postContext);

  const userName = normalize(meta?.userName);
  const parentName = normalize(meta?.parentName);

  const userFirst = getFirstName(userName);
  const parentFirst = getFirstName(parentName);

  const signals = meta?.signals || {};
  const isReplyInThread = Boolean(meta?.isReply);
  const location = normalize(meta?.location || signals.location || "");

  const sigLine = [
    `jinxingLikely=${signals.jinxingLikely ? "true" : "false"}`,
    `sarcasmLikely=${signals.sarcasmLikely ? "true" : "false"}`,
    `bsLikely=${signals.bsLikely ? "true" : "false"}`,
    `debateLikely=${signals.debateLikely ? "true" : "false"}`,
    `worryLikely=${signals.worryLikely ? "true" : "false"}`,
    `praiseLikely=${signals.praiseLikely ? "true" : "false"}`,
    `questionLikely=${signals.questionLikely ? "true" : "false"}`,
    `location=${location ? `"${location}"` : "none"}`,
    `isReplyInThread=${isReplyInThread ? "true" : "false"}`
  ].join(", ");

  const lines = [
    "Role: You manage the T.Lifehack USA Facebook/Reels channel. You are a savvy, friendly, witty American creator.",
    "Goal: maximize engagement, push saves, grow community.",
    "",
    "Reply ONLY in English.",
    "Sound human, friendly, witty, like you're in the comments with them.",
    "Use contractions: don't, it's, you're, gonna, kinda, yep, nah.",
    "Write 1 to 3 short sentences total.",
    "Use 1 to 2 relevant emojis total. No hashtags.",
    "Do not mention AI, bots, automation, or policies.",
    "ALWAYS end with EXACTLY ONE question that invites a reply.",
    "The question must match the topic and the thread. No generic questions.",
    "",
    "Logic rules:",
    "1) If bsLikely is true, use the BS strategy: empathize, say it worked for you, invite others to share real results.",
    "2) If sarcasmLikely is true, answer with wit, then anchor it to a practical point.",
    "3) If jinxingLikely is true, use: 'Knock on wood' culture.",
    "4) If location is present, acknowledge it with weather vibe, like: 'Stay warm out there in [Location]'.",
    "5) If praiseLikely is true, add a save trigger in the reply: 'Save this video'.",
    "6) If questionLikely is true, add a curiosity gap cue tied to the video, like: 'rewatch around 0:45'.",
    "7) If this is a reply thread and people are chatting, jump in briefly and keep it playful.",
    "8) If nothing special triggers, be relatable: admit you were surprised too.",
    "",
    `Context signals: ${sigLine}`,
    ""
  ];

  if (ctx) {
    lines.push("Post context:");
    lines.push(ctx);
    lines.push("");
  }

  if (parentMsg) {
    lines.push(`Parent comment (${parentFirst || "viewer"}): "${parentMsg}"`);
    lines.push("");
  }

  lines.push(`New comment (${userFirst || "viewer"}): "${text}"`);
  lines.push("");

  return lines.join("\n");
};

const buildBaitPrompt = (postContext) => {
  const ctx = normalize(postContext);

  const lines = [
    "Task: Write ONE engagement bait comment for a new T.Lifehack USA video.",
    "Goal: spark debate, opinions, arguments, and 'I didn’t know' reactions.",
    "Strategy: use a polarizing question or a challenge.",
    "",
    "Rules:",
    "Reply ONLY in English.",
    "Write 1 to 2 short sentences.",
    "Use 1 to 2 emojis.",
    "No hashtags.",
    "Do not mention pinning, bots, AI, or automation.",
    "Make it specific to the post context. Use the object from the hack if visible in context.",
    "End with EXACTLY ONE question.",
    "",
    "Examples style (do not copy):",
    "Team A vs Team B. Which side are you on?",
    "Scale 1-10. How surprising was this?",
    "",
    "Post context:",
    ctx || "(no context)",
    ""
  ];

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

const trimReply = (text, maxChars = 240) => {
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

const enforceOneQuestionAtEnd = (text) => {
  let s = String(text || "").trim();
  if (!s) return s;

  const qCount = (s.match(/\?/g) || []).length;
  if (qCount > 1) {
    const lastQ = s.lastIndexOf("?");
    let before = s.slice(0, lastQ);
    let after = s.slice(lastQ + 1);

    before = before.replace(/\?/g, ".").replace(/\s+\./g, ".").trim();

    if (/[A-Za-z0-9]/.test(after)) after = "";
    after = after.replace(/\?/g, "").trim();

    s = `${before}?${after ? " " + after : ""}`.trim();
  }

  const lastQ = s.lastIndexOf("?");
  if (lastQ >= 0) {
    const after = s.slice(lastQ + 1);
    if (/[A-Za-z0-9]/.test(after)) {
      s = s.slice(0, lastQ + 1).trim();
    }
  }

  return s;
};

const looksNotEnglish = (text) => /[А-Яа-яЁё]/.test(String(text || ""));

const callOpenAi = async (input, temperature = 0.7, maxTokens = 180) => {
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
      max_output_tokens: maxTokens
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI error ${r.status}: ${t}`);
  }

  const data = await r.json();
  return extractOpenAiText(data);
};

const generateReply = async (comment, postContext, meta = {}) => {
  let first = trimReply(await callOpenAi(buildPrompt(comment, postContext, meta), 0.9, 180), 240);
  first = enforceOneQuestionAtEnd(first);

  if (!first) throw new Error("Empty OpenAI reply");
  if (!looksNotEnglish(first)) return first;

  const retryPrompt = [
    "Rewrite the reply strictly in English.",
    "Keep the same witty, human tone and contractions.",
    "Write 1 to 3 short sentences.",
    "Use 1 to 2 emojis.",
    "End with exactly one question.",
    "",
    `Reply to rewrite: "${first}"`
  ].join("\n");

  let second = trimReply(await callOpenAi(retryPrompt, 0.4, 180), 240);
  second = enforceOneQuestionAtEnd(second);

  if (second && !looksNotEnglish(second)) return second;

  return first;
};

const generateBaitComment = async (postContext) => {
  let first = trimReply(await callOpenAi(buildBaitPrompt(postContext), 0.95, 140), BAIT_MAX_CHARS);
  first = enforceOneQuestionAtEnd(first);

  if (!first) throw new Error("Empty OpenAI bait");
  if (!looksNotEnglish(first)) return first;

  const retryPrompt = [
    "Rewrite strictly in English.",
    "Write 1 to 2 short sentences.",
    "Use 1 to 2 emojis.",
    "End with exactly one question.",
    "No hashtags.",
    "",
    `Text: "${first}"`
  ].join("\n");

  let second = trimReply(await callOpenAi(retryPrompt, 0.35, 140), BAIT_MAX_CHARS);
  second = enforceOneQuestionAtEnd(second);

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

const postCommentOnPost = async (postId, text, pageToken) => {
  const r = await fetch(`${GRAPH_API_BASE}/${postId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: text,
      access_token: pageToken
    })
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Post comment failed ${r.status}: ${t}`);
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

const gateAtForType = (type) => {
  if (type === "like") return nextLikeAllowedAt;
  return nextReplyAllowedAt;
};

// берём задачу с самым ранним readyAt = max(dueAt, gateAt)
const getNextTaskIndex = () => {
  let bestIdx = -1;
  let bestReady = Infinity;

  const now = nowMs();
  for (let i = 0; i < replyQueue.length; i++) {
    const dueAt = Number(replyQueue[i]?.dueAt || 0);
    const type = String(replyQueue[i]?.type || "reply");
    const gateAt = gateAtForType(type);
    const readyAt = Math.max(dueAt, gateAt, now);

    if (readyAt < bestReady) {
      bestReady = readyAt;
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
    const type = String(taskObj.type || "reply");
    const gateAt = gateAtForType(type);
    const readyAt = Math.max(dueAt, gateAt);

    const waitMs = Math.max(0, readyAt - now);
    if (waitMs > 0) {
      setTimeout(runNext, waitMs);
      return;
    }

    replyQueue.splice(idx, 1);

    try {
      const did = await taskObj.run();
      if (did) {
        if (type === "like") {
          const gap = randInt(BETWEEN_LIKE_MIN_MS, BETWEEN_LIKE_MAX_MS);
          nextLikeAllowedAt = Date.now() + gap;
        } else {
          const gap = randInt(BETWEEN_REPLY_MIN_MS, BETWEEN_REPLY_MAX_MS);
          nextReplyAllowedAt = Date.now() + gap;
        }
      }
    } catch (err) {
      console.error("QUEUE_TASK_ERROR", err);
      if (type === "like") {
        const gap = randInt(BETWEEN_LIKE_MIN_MS, BETWEEN_LIKE_MAX_MS);
        nextLikeAllowedAt = Date.now() + gap;
      } else {
        const gap = randInt(BETWEEN_REPLY_MIN_MS, BETWEEN_REPLY_MAX_MS);
        nextReplyAllowedAt = Date.now() + gap;
      }
    } finally {
      setImmediate(runNext);
    }
  };

  setImmediate(runNext);
};

const pruneBaitCache = () => {
  const cutoff = nowMs() - BAIT_CACHE_TTL_MS;
  for (const [k, v] of baitCache.entries()) {
    if (!v || v.ts < cutoff) baitCache.delete(k);
  }
};

const wasBaitPosted = (postId) => {
  pruneBaitCache();
  const v = baitCache.get(postId);
  if (!v) return false;
  if (nowMs() - v.ts > BAIT_CACHE_TTL_MS) {
    baitCache.delete(postId);
    return false;
  }
  return true;
};

const markBaitPosted = (postId, commentId, text) => {
  pruneBaitCache();
  baitCache.set(postId, { ts: nowMs(), commentId: String(commentId || ""), text: String(text || "") });
};

const ensureBaitForPost = async (postId, pageToken, ts, reason) => {
  if (!BAIT_ENABLED) return;
  const pid = String(postId || "").trim();
  if (!pid) return;

  if (wasBaitPosted(pid)) return;
  if (baitInflight.has(pid)) return;

  // очередь ограничена
  if (replyQueue.length + 1 > MAX_QUEUE_LENGTH) {
    logSkip("BAIT_QUEUE_FULL", { postId: pid, queueLen: replyQueue.length, reason });
    return;
  }

  baitInflight.add(pid);

  const dueAt = Date.now() + randInt(BAIT_DELAY_MIN_MS, BAIT_DELAY_MAX_MS);

  replyQueue.push({
    type: "bait",
    postId: pid,
    dueAt,
    run: async () => {
      try {
        if (!isBotEnabled()) return false;
        if (wasBaitPosted(pid)) return false;

        const postContext = await getPostContext(pid, pageToken);
        const bait = await generateBaitComment(postContext);

        const posted = await postCommentOnPost(pid, bait, pageToken);
        const postedId = pickId(posted);

        markBaitPosted(pid, postedId, bait);

        if (postedId) rememberComment(postedId);

        logJson("BAIT_POSTED", {
          at: ts,
          postId: pid,
          postedId,
          bait,
          reason
        });

        return true;
      } catch (e) {
        logJson("BAIT_FAILED", {
          at: ts,
          postId: pid,
          reason,
          err: String(e).slice(0, 300)
        });
        return false;
      } finally {
        baitInflight.delete(pid);
      }
    }
  });

  scheduleQueueProcessing();
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

const extractPostId = (v) => {
  if (!v) return "";
  if (typeof v.post_id === "string") return v.post_id;
  if (typeof v.postId === "string") return v.postId;
  if (typeof v.id === "string") return v.id;
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
          if (c?.field !== "feed") continue;

          const value = c?.value || {};
          const item = String(value?.item || "").trim(); // comment, status, post, video, reaction, etc
          const verb = String(value?.verb || "").trim(); // add, edited, remove
          const postId = String(extractPostId(value) || "").trim();

          // NEW POST => BAIT COMMENT (фильтр: только реальные публикации, не reaction)
          const NEW_POST_ITEMS = new Set(["post", "video", "photo", "status", "share"]);
          if (
            BAIT_ENABLED &&
            BAIT_ON_NEW_POST &&
            verb === "add" &&
            postId &&
            NEW_POST_ITEMS.has(item) &&
            Number(value?.published ?? 1) === 1
          ) {
            await ensureBaitForPost(postId, pageToken, ts, `new_post_item=${item}`);
          }

          // COMMENTS
          if (item !== "comment" || verb !== "add") continue;

          const commentId = extractCommentId(value);
          if (!commentId) continue;

          const parentId = String(value?.parent_id || "").trim();
          const isReply = isReplyEvent(value);
          const threadKey = getThreadKey(value, commentId);

          logWebhookEvent({
            at: ts,
            commentId,
            postId,
            parentId,
            isReply,
            item,
            verb,
            created_time: value?.created_time || null,
            queueLen: replyQueue.length
          });

          if (BAIT_ENABLED && BAIT_ON_FIRST_COMMENT && postId) {
            await ensureBaitForPost(postId, pageToken, ts, "first_comment_fallback");
          }

          if (wasProcessed(commentId)) {
            logSkip("DUPLICATE", { commentId, postId, threadKey });
            continue;
          }

          if (inflight.has(commentId)) {
            logSkip("INFLIGHT", { commentId, postId, threadKey });
            continue;
          }

          if (!replyToRepliesEnabled() && isReply) {
            rememberComment(commentId);
            logSkip("REPLY_THREAD_DISABLED", { commentId, postId, threadKey });
            continue;
          }

          // игнор старых
          const createdSec = Number(value?.created_time || 0);
          if (createdSec) {
            const createdMs = createdSec * 1000;
            const ageSec = Math.floor((nowMs() - createdMs) / 1000);
            if (nowMs() - createdMs > IGNORE_OLD_COMMENTS_MIN * 60 * 1000) {
              rememberComment(commentId);
              logSkip("OLD_COMMENT", { commentId, postId, threadKey, created_time: createdSec, ageSec });
              continue;
            }
          }

          // вероятность ответа
          const prob = isReply ? REPLY_PROB_REPLY : REPLY_PROB_TOP;
          const rnd = Math.random();
          if (rnd > prob) {
            rememberComment(commentId);
            logSkip("PROBABILITY", { commentId, postId, threadKey, isReply, prob, rnd });
            continue;
          }

          // лимит по времени
          if (!allowReplyByRate()) {
            rememberComment(commentId);
            prune(replyHour, 60 * 60 * 1000);
            prune(replyDay, 24 * 60 * 60 * 1000);
            logSkip("RATE_LIMIT", {
              commentId,
              postId,
              threadKey,
              hourCount: replyHour.length,
              dayCount: replyDay.length
            });
            continue;
          }

          // лимит на ветку
          if (!allowReplyInThread(threadKey)) {
            rememberComment(commentId);
            pruneThreadReplies();
            const cur = threadReplies.get(threadKey);
            const threadCount = Number(cur?.count || 0);
            logSkip("THREAD_LIMIT", { commentId, postId, threadKey, threadCount });
            continue;
          }

          const tasksToAdd = LIKE_ENABLED ? 2 : 1;
          if (replyQueue.length + tasksToAdd > MAX_QUEUE_LENGTH) {
            rememberComment(commentId);
            logSkip("QUEUE_FULL", { commentId, postId, threadKey, queueLen: replyQueue.length });
            continue;
          }

          // подтягиваем комментарий один раз, кладем в кеш, валидируем, и для логов тоже
          let comment = getCachedComment(commentId);
          if (!comment) {
            try {
              comment = await fetchComment(commentId, pageToken);
              setCachedComment(commentId, comment);
            } catch (err) {
              rememberComment(commentId);
              logSkip("COMMENT_FETCH_FAILED", { commentId, postId, threadKey, err: String(err).slice(0, 220) });
              continue;
            }
          }

          const msgForLog = safeSlice(comment?.message, WEBHOOK_MESSAGE_MAX_CHARS);
          const fromForLog = String(comment?.from?.name || "");
          const parentFromForLog = String(comment?.parent?.from?.name || "");

          if (LOG_WEBHOOK_MESSAGE) {
            logJson("WEBHOOK_MESSAGE", {
              commentId,
              postId,
              from: fromForLog,
              msg: msgForLog,
              parentFrom: parentFromForLog,
              parentMsg: safeSlice(comment?.parent?.message, WEBHOOK_MESSAGE_MAX_CHARS)
            });
          }

          if (pageId && String(comment?.from?.id || "") === pageId) {
            rememberComment(commentId);
            logSkip("SELF", { commentId, postId, threadKey, msg: safeSlice(msgForLog, SKIP_MESSAGE_MAX_CHARS) });
            continue;
          }

          if (isNoiseOnly(comment?.message)) {
            rememberComment(commentId);
            logSkip("NOISE", { commentId, postId, threadKey, msg: safeSlice(msgForLog, SKIP_MESSAGE_MAX_CHARS) });
            continue;
          }

          inflight.add(commentId);

          const likeDelay = LIKE_ENABLED ? randInt(LIKE_MIN_MS, LIKE_MAX_MS) : 0;

          const replyDelay = LIKE_ENABLED
            ? randInt(REPLY_AFTER_LIKE_MIN_MS, REPLY_AFTER_LIKE_MAX_MS)
            : randInt(FIRST_REPLY_MIN_MS, FIRST_REPLY_MAX_MS);

          const dueLikeAt = Date.now() + likeDelay;
          const dueReplyAt = Date.now() + likeDelay + replyDelay;

          if (LIKE_ENABLED) {
            replyQueue.push({
              type: "like",
              commentId,
              postId,
              threadKey,
              dueAt: dueLikeAt,
              run: async () => {
                if (!isBotEnabled()) return false;
                if (wasProcessed(commentId)) return false;

                try {
                  await likeComment(commentId, pageToken);
                  logJson("LIKED", {
                    commentId,
                    postId,
                    threadKey,
                    from: LOG_WEBHOOK_MESSAGE ? fromForLog : undefined,
                    msg: LOG_WEBHOOK_MESSAGE ? safeSlice(msgForLog, SKIP_MESSAGE_MAX_CHARS) : undefined
                  });
                  return true;
                } catch (err) {
                  logJson("LIKE_FAILED", {
                    commentId,
                    postId,
                    threadKey,
                    err: String(err).slice(0, 240)
                  });
                  return false;
                }
              }
            });
          }

          replyQueue.push({
            type: "reply",
            commentId,
            postId,
            threadKey,
            dueAt: dueReplyAt,
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

                const cached = getCachedComment(commentId);
                const src = cached || comment;

                const msgNow = safeSlice(src?.message || msgForLog, SKIP_MESSAGE_MAX_CHARS);

                const signals = analyzeSignals(src);

                const meta = {
                  isReply: Boolean(src?.parent?.id) || Boolean(isReply),
                  userName: String(src?.from?.name || fromForLog || ""),
                  parentName: String(src?.parent?.from?.name || parentFromForLog || ""),
                  location: signals.location,
                  signals
                };

                const postContext = await getPostContext(postId, pageToken);

                const reply = await generateReply(src, postContext, meta);
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
                  likeDelayMs: LIKE_ENABLED ? likeDelay : 0,
                  replyAfterLikeMs: LIKE_ENABLED ? replyDelay : 0,
                  msg: LOG_WEBHOOK_MESSAGE ? msgNow : undefined,
                  signals: LOG_WEBHOOK_MESSAGE ? meta.signals : undefined,
                  reply,
                  postedId,
                  permalink: src?.permalink_url || ""
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
