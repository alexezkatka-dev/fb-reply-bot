console.log("SERVER VERSION 2026-02-11 WEBHOOK PROD FIX2 MULTIPAGE LANG LOGS")

const express = require("express")
const fetch = require("node-fetch")

const app = express()
app.use(express.json({ limit: "2mb" }))

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v19.0"
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

const nowMs = () => Date.now()

const isOne = (v) => String(v || "").trim() === "1"
const envBool = (name, def0or1) => {
  const raw = String(process.env[name] ?? "").trim()
  if (!raw) return def0or1 === 1
  return raw === "1" || raw.toLowerCase() === "true"
}

const LOG_WEBHOOK_IN = envBool("LOG_WEBHOOK_IN", 0)
const LOG_WEBHOOK_EVENTS = envBool("LOG_WEBHOOK_EVENTS", 0)
const LOG_SKIPS = envBool("LOG_SKIPS", 0)
const LOG_WEBHOOK_MESSAGE = envBool("LOG_WEBHOOK_MESSAGE", 0)
const LOG_ONLY_MESSAGE_EVENTS = envBool("LOG_ONLY_MESSAGE_EVENTS", 1)

const WEBHOOK_MESSAGE_MAX_CHARS = Number(process.env.WEBHOOK_MESSAGE_MAX_CHARS || 220)
const SKIP_MESSAGE_MAX_CHARS = Number(process.env.SKIP_MESSAGE_MAX_CHARS || 160)

const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH || 20)

const FIRST_REPLY_MIN_MS = Number(process.env.FIRST_REPLY_MIN_MS || 20000)
const FIRST_REPLY_MAX_MS = Number(process.env.FIRST_REPLY_MAX_MS || 30000)

const BETWEEN_REPLY_MIN_MS = Number(process.env.BETWEEN_REPLY_MIN_MS || 15000)
const BETWEEN_REPLY_MAX_MS = Number(process.env.BETWEEN_REPLY_MAX_MS || 45000)

const LIKE_ENABLED = isOne(process.env.LIKE_ENABLED || "1")
const LIKE_MIN_MS = Number(process.env.LIKE_MIN_MS || 0)
const LIKE_MAX_MS = Number(process.env.LIKE_MAX_MS || 3000)

const REPLY_AFTER_LIKE_MIN_MS = Number(process.env.REPLY_AFTER_LIKE_MIN_MS || 25000)
const REPLY_AFTER_LIKE_MAX_MS = Number(process.env.REPLY_AFTER_LIKE_MAX_MS || 60000)

const BETWEEN_LIKE_MIN_MS = Number(process.env.BETWEEN_LIKE_MIN_MS || 2000)
const BETWEEN_LIKE_MAX_MS = Number(process.env.BETWEEN_LIKE_MAX_MS || 8000)

const MAX_REPLIES_PER_HOUR = Number(process.env.MAX_REPLIES_PER_HOUR || 40)
const MAX_REPLIES_PER_DAY = Number(process.env.MAX_REPLIES_PER_DAY || 300)
const MAX_BOT_REPLIES_PER_THREAD = Number(process.env.MAX_BOT_REPLIES_PER_THREAD || 3)

const REPLY_PROB_TOP = Number(process.env.REPLY_PROB_TOP || 1)
const REPLY_PROB_REPLY = Number(process.env.REPLY_PROB_REPLY || 1)

const IGNORE_OLD_COMMENTS_MIN = Number(process.env.IGNORE_OLD_COMMENTS_MIN || 5)

const POST_CONTEXT_MAX_CHARS = Number(process.env.POST_CONTEXT_MAX_CHARS || 800)
const POST_CACHE_TTL_MS = Number(process.env.POST_CACHE_TTL_MS || 10 * 60 * 1000)

const COMMENT_CACHE_TTL_MS = Number(process.env.COMMENT_CACHE_TTL_MS || 2 * 60 * 1000)

const BAIT_ENABLED = isOne(process.env.BAIT_ENABLED || "1")
const BAIT_ON_NEW_POST = isOne(process.env.BAIT_ON_NEW_POST || "1")
const BAIT_ON_FIRST_COMMENT = isOne(process.env.BAIT_ON_FIRST_COMMENT || "0")
const BAIT_FRESH_POST_WINDOW_MIN = Number(process.env.BAIT_FRESH_POST_WINDOW_MIN || 120)

const BAIT_DELAY_MIN_MS = Number(process.env.BAIT_DELAY_MIN_MS || 1500)
const BAIT_DELAY_MAX_MS = Number(process.env.BAIT_DELAY_MAX_MS || 4000)
const BAIT_CACHE_TTL_MS = Number(process.env.BAIT_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000)
const BAIT_MAX_CHARS = Number(process.env.BAIT_MAX_CHARS || 220)

const POST_META_TTL_MS = Number(process.env.POST_META_TTL_MS || 10 * 60 * 1000)

const NEW_POST_ITEMS = new Set(["post", "video", "photo"])

const isBotEnabled = () => String(process.env.BOT_ENABLED || "").trim() === "1"
const replyToRepliesEnabled = () => String(process.env.REPLY_TO_REPLIES || "1").trim() === "1"

const safeSlice = (s, n) => {
  const t = String(s || "")
  if (!n || n <= 0) return ""
  if (t.length <= n) return t
  return t.slice(0, n).replace(/\s+/g, " ").trim()
}

const normalize = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim()

const logJson = (tag, obj) => {
  try {
    console.log(tag, JSON.stringify(obj))
  } catch (e) {
    console.log(tag, String(e))
  }
}

const randInt = (min, max) => {
  const a = Number(min)
  const b = Number(max)
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return Math.floor(lo + Math.random() * (hi - lo + 1))
}

const prune = (arr, windowMs) => {
  const cutoff = nowMs() - windowMs
  while (arr.length && arr[0] < cutoff) arr.shift()
}

const hasCyrillic = (s) => /[А-Яа-яЁё]/.test(String(s || ""))
const hasLatin = (s) => /[A-Za-z]/.test(String(s || ""))

const isNoiseOnly = (msg) => {
  const m = normalize(msg)
  if (!m) return true
  if (m.length < 2) return true
  if (/^(?:[\p{P}\p{S}\p{Z}]+)$/u.test(m)) return true
  if (/^(?:[\p{Z}\p{Emoji_Presentation}\p{Extended_Pictographic}]+)$/u.test(m)) return true
  return false
}

const stripHashtags = (text) => {
  const s = String(text || "")
  return normalize(s.replace(/#[\p{L}\p{N}_]+/gu, " "))
}

const getFirstName = (fullName) => {
  const n = normalize(fullName).replace(/[^A-Za-zÀ-ÿА-Яа-яЁё' -]/g, "").trim()
  if (!n) return ""
  const first = n.split(/\s+/)[0] || ""
  return first.slice(0, 24)
}

const extractLocation = (text) => {
  const s = normalize(text)
  if (!s) return ""

  const mEn = s.match(/\b(?:from|in|here in|out in)\s+([A-Za-z][A-Za-z .'-]{2,40})(?:,\s*([A-Z]{2}))?\b/i)
  if (mEn) {
    const raw = normalize(mEn[1] || "")
    const st = normalize(mEn[2] || "")
    const bad = new Set(["this", "the", "a", "my", "your", "that", "it", "here", "there", "video", "post", "comments", "thread"])
    const firstWord = raw.split(/\s+/)[0]?.toLowerCase() || ""
    if (bad.has(firstWord)) return ""
    const cleaned = raw.replace(/[^A-Za-z .'-]/g, "").trim()
    if (!cleaned) return ""
    if (st && /^[A-Z]{2}$/.test(st)) return `${cleaned}, ${st}`
    return cleaned
  }

  const mRu = s.match(/\b(?:из|в|во|тут в|здесь в)\s+([А-Яа-яЁё][А-Яа-яЁё .'-]{2,40})\b/i)
  if (mRu) {
    const raw = normalize(mRu[1] || "")
    const cleaned = raw.replace(/[^A-Za-zÀ-ÿА-Яа-яЁё .'-]/g, "").trim()
    if (!cleaned) return ""
    return cleaned
  }

  return ""
}

const isReplyEvent = (value) => {
  const postId = String(value?.post_id || "")
  const parentId = String(value?.parent_id || "")
  if (!postId || !parentId) return false
  return parentId !== postId
}

const getThreadKey = (value, commentId) => {
  const parentId = String(value?.parent_id || "")
  const postId = String(value?.post_id || "")
  if (parentId && postId && parentId !== postId) return parentId
  return commentId
}

const pickId = (obj) => String(obj?.id || obj?.comment_id || obj?.commentId || "").trim()

const parsePageTokenMap = () => {
  const out = Object.create(null)

  const rawJson = String(process.env.FB_PAGE_TOKENS_JSON || "").trim()
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson)
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          const pid = String(k || "").trim()
          const tok = String(v || "").trim()
          if (pid && tok) out[pid] = tok
        }
      }
    } catch (_) {}
  }

  const raw = String(process.env.FB_PAGE_TOKENS || "").trim()
  if (raw) {
    const parts = raw.split(",").map((x) => x.trim()).filter(Boolean)
    for (const p of parts) {
      const eq = p.indexOf("=")
      if (eq <= 0) continue
      const pid = p.slice(0, eq).trim()
      const tok = p.slice(eq + 1).trim()
      if (pid && tok) out[pid] = tok
    }
  }

  return out
}

const PAGE_TOKENS = parsePageTokenMap()
const SINGLE_PAGE_TOKEN = String(process.env.FB_PAGE_TOKEN || "").trim()

const getPageToken = (pageId) => {
  const pid = String(pageId || "").trim()
  if (pid && PAGE_TOKENS[pid]) return PAGE_TOKENS[pid]
  if (SINGLE_PAGE_TOKEN) return SINGLE_PAGE_TOKEN
  return ""
}

const extractPageId = (entry, value) => {
  const a = String(value?.page_id || "").trim()
  const b = String(entry?.id || "").trim()
  const c = String(entry?.page_id || "").trim()
  return a || b || c
}

const pageStates = new Map()

const createPageState = (pageId) => ({
  pageIdHint: String(pageId || "").trim(),
  pageIdResolved: String(pageId || "").trim(),
  pageName: "",
  forceRussian: false,

  replyQueue: [],
  processingQueue: false,
  nextReplyAllowedAt: 0,
  nextLikeAllowedAt: 0,

  processedComments: new Map(),
  inflight: new Set(),

  replyHour: [],
  replyDay: [],
  threadReplies: new Map(),

  postCache: new Map(),
  commentCache: new Map(),
  postMetaCache: new Map(),

  baitCache: new Map(),
  baitInflight: new Set()
})

const getPageState = (pageId) => {
  const pid = String(pageId || "").trim() || "__unknown__"
  const existing = pageStates.get(pid)
  if (existing) return existing
  const s = createPageState(pid)
  pageStates.set(pid, s)
  return s
}

const rememberComment = (state, id) => {
  const key = String(id || "").trim()
  if (!key) return
  state.processedComments.set(key, nowMs())
  if (state.processedComments.size <= 5000) return
  const oldest = state.processedComments.keys().next().value
  if (oldest) state.processedComments.delete(oldest)
}

const wasProcessed = (state, id) => {
  const key = String(id || "").trim()
  if (!key) return false
  return state.processedComments.has(key)
}

const pruneThreadReplies = (state) => {
  const cutoff = nowMs() - 48 * 60 * 60 * 1000
  for (const [k, v] of state.threadReplies.entries()) {
    if (!v || v.ts < cutoff) state.threadReplies.delete(k)
  }
}

const allowReplyInThread = (state, threadKey) => {
  pruneThreadReplies(state)
  const cur = state.threadReplies.get(threadKey)
  const count = Number(cur?.count || 0)
  return count < MAX_BOT_REPLIES_PER_THREAD
}

const markThreadReply = (state, threadKey) => {
  const cur = state.threadReplies.get(threadKey)
  const count = Number(cur?.count || 0) + 1
  state.threadReplies.set(threadKey, { count, ts: nowMs() })
}

const allowReplyByRate = (state) => {
  prune(state.replyHour, 60 * 60 * 1000)
  prune(state.replyDay, 24 * 60 * 60 * 1000)
  return state.replyHour.length < MAX_REPLIES_PER_HOUR && state.replyDay.length < MAX_REPLIES_PER_DAY
}

const markReply = (state) => {
  const t = nowMs()
  state.replyHour.push(t)
  state.replyDay.push(t)
}

const pruneCommentCache = (state) => {
  const cutoff = nowMs() - COMMENT_CACHE_TTL_MS
  for (const [k, v] of state.commentCache.entries()) {
    if (!v || v.ts < cutoff) state.commentCache.delete(k)
  }
}

const getCachedComment = (state, commentId) => {
  pruneCommentCache(state)
  const v = state.commentCache.get(commentId)
  if (!v) return null
  if (nowMs() - v.ts > COMMENT_CACHE_TTL_MS) {
    state.commentCache.delete(commentId)
    return null
  }
  return v.comment || null
}

const setCachedComment = (state, commentId, comment) => {
  pruneCommentCache(state)
  state.commentCache.set(commentId, { ts: nowMs(), comment })
}

const readGraphResult = async (r) => {
  const t = await r.text()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch (_) {
    return t
  }
}

const fetchComment = async (commentId, pageToken) => {
  const url = new URL(`${GRAPH_API_BASE}/${commentId}`)
  url.searchParams.set("fields", "message,from{id,name},permalink_url,created_time,parent{id,message,from{id,name}}")
  url.searchParams.set("access_token", pageToken)

  const r = await fetch(url.toString())
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Fetch comment failed ${r.status}: ${t}`)
  }
  return r.json()
}

const likeComment = async (commentId, pageToken) => {
  const r = await fetch(`${GRAPH_API_BASE}/${commentId}/likes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: pageToken })
  })

  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Like failed ${r.status}: ${t}`)
  }

  const data = await readGraphResult(r)
  if (data === true) return true
  if (data === "true") return true
  if (data && typeof data === "object" && data.success === true) return true
  return true
}

const fetchPost = async (postId, pageToken) => {
  if (!postId) return null

  const url = new URL(`${GRAPH_API_BASE}/${postId}`)
  url.searchParams.set(
    "fields",
    ["message", "story", "permalink_url", "created_time", "attachments{media_type,title,description,url}"].join(",")
  )
  url.searchParams.set("access_token", pageToken)

  const r = await fetch(url.toString())
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Fetch post failed ${r.status}: ${t}`)
  }
  return r.json()
}

const fetchPostMeta = async (postId, pageToken) => {
  if (!postId) return null

  const url = new URL(`${GRAPH_API_BASE}/${postId}`)
  url.searchParams.set("fields", "created_time,published")
  url.searchParams.set("access_token", pageToken)

  const r = await fetch(url.toString())
  if (!r.ok) return null
  return r.json()
}

const prunePostMetaCache = (state) => {
  const cutoff = nowMs() - POST_META_TTL_MS
  for (const [k, v] of state.postMetaCache.entries()) {
    if (!v || v.ts < cutoff) state.postMetaCache.delete(k)
  }
}

const getPostMeta = async (state, postId, pageToken) => {
  prunePostMetaCache(state)
  const cached = state.postMetaCache.get(postId)
  if (cached && nowMs() - cached.ts < POST_META_TTL_MS) return cached

  try {
    const meta = await fetchPostMeta(postId, pageToken)
    const createdMs = Date.parse(meta?.created_time || "") || 0
    const published = Number(meta?.published ?? 1)
    const out = { ts: nowMs(), createdMs, published }
    state.postMetaCache.set(postId, out)
    return out
  } catch (_) {
    const out = { ts: nowMs(), createdMs: 0, published: 1 }
    state.postMetaCache.set(postId, out)
    return out
  }
}

const buildPostContext = (post) => {
  if (!post) return ""

  const parts = []
  const msg = normalize(post?.message)
  const story = normalize(post?.story)

  if (msg) parts.push(`Post caption: "${msg}"`)
  else if (story) parts.push(`Post text: "${story}"`)

  const att = post?.attachments?.data
  if (Array.isArray(att) && att.length) {
    const a = att[0]
    const t = normalize(a?.title)
    const d = normalize(a?.description)
    const mt = normalize(a?.media_type)
    if (mt) parts.push(`Attachment type: ${mt}`)
    if (t) parts.push(`Attachment title: "${t}"`)
    if (d) parts.push(`Attachment description: "${d}"`)
  }

  const out = parts.join("\n")
  return safeSlice(out, POST_CONTEXT_MAX_CHARS)
}

const getPostContext = async (state, postId, pageToken) => {
  if (!postId) return ""

  const cached = state.postCache.get(postId)
  const now = nowMs()
  if (cached && now - cached.ts < POST_CACHE_TTL_MS) return cached.text || ""

  try {
    const post = await fetchPost(postId, pageToken)
    const text = buildPostContext(post)
    state.postCache.set(postId, { ts: now, text })
    return text
  } catch (e) {
    state.postCache.set(postId, { ts: now, text: "" })
    if (LOG_WEBHOOK_EVENTS) logJson("POST_CONTEXT_FETCH_FAILED", { postId, err: String(e).slice(0, 240) })
    return ""
  }
}

const analyzeSignals = (comment) => {
  const msg = normalize(comment?.message)
  const parent = normalize(comment?.parent?.message)
  const joined = `${parent} ${msg}`.trim()

  const sarcasmLikely =
    /\/s\b|sarcasm|yeah right|sure buddy|captain obvious|thanks a lot|nice one|sure thing|righttt|as if/i.test(joined) ||
    /ага конечно|ну да|капитан очевидность|спасибо блин|смешно|ну-ну/i.test(joined)

  const jinxingLikely =
    /\bjinx\b|don't jinx|dont jinx|knock on wood|touch wood|appliance gods|curse|hex|now you're gonna have|now youre gonna have|you'll have problems|youll have problems/i.test(joined) ||
    /сглаз|не сглазь|постучи по дереву|тьфу тьфу/i.test(joined) ||
    /\b(never breaks|always works|works every time)\b/i.test(joined) ||
    /никогда не ломалось|всегда работает|каждый раз работает/i.test(joined)

  const bsLikely =
    /\b(bullshit|bs|b\s*s|not true|fake|doesn'?t work|does not work|waste of time|scam)\b/i.test(joined) ||
    /\b(cap|trash)\b/i.test(joined) ||
    /бред|херня|фигня|не работает|развод|скам|пиздеж/i.test(joined)

  const debateLikely =
    /\bfake\b|\bcap\b|\bbs\b|doesn'?t work|works\b|i tried|tried it|tested|no it|nah it|prove it/i.test(joined) ||
    /не работает|работает|проверил|пробовал|доказательства|пруф/i.test(joined)

  const worryLikely =
    /\bgonna break\b|\bgoing to break\b|break my|crack|damage|ruin|snap|strip the/i.test(joined) ||
    /сломаю|не сломается|испортит|поцарапает|повредит/i.test(joined)

  const praiseLikely =
    /\b(thanks|thank you|helped|works|worked|love this|awesome|great|genius|saved me|life saver)\b/i.test(joined) ||
    /спасибо|помогло|работает|сработало|круто|топ|огонь|гениально|спасло/i.test(joined)

  const questionLikely = /\?/.test(msg)

  const location = extractLocation(joined)

  const britishLikely =
    /\b(colour|favourite|centre|mum|mate|cheers|rubbish|bloody|queue|flat|loo|washing up)\b/i.test(joined) ||
    /\b(uk|u\.k\.|england|scotland|wales|london|manchester|british)\b/i.test(joined) ||
    /\bfrom\s+(?:the\s+)?uk\b/i.test(joined)

  return { sarcasmLikely, jinxingLikely, bsLikely, debateLikely, worryLikely, praiseLikely, questionLikely, location, britishLikely }
}

const pickCuriosityTimestamp = (seed) => {
  const s = String(seed || "")
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  const times = ["0:12", "0:27", "0:45", "0:58"]
  return times[h % times.length]
}

const detectReplyMode = (state, comment, postContext, signals) => {
  const msg = normalize(comment?.message)
  const parent = normalize(comment?.parent?.message)
  const ctx = normalize(postContext)
  const joined = `${parent} ${msg} ${ctx}`.trim()

  if (state.forceRussian) return { lang: "ru" }
  if (hasCyrillic(joined)) return { lang: "ru" }

  const british = Boolean(signals?.britishLikely)
  return { lang: british ? "en-uk" : "en-us" }
}

const buildPrompt = (comment, postContext, meta = {}) => {
  const text = normalize(comment?.message)
  const parentMsg = normalize(comment?.parent?.message)
  const ctx = normalize(postContext)

  const userName = normalize(meta?.userName)
  const parentName = normalize(meta?.parentName)

  const userFirst = getFirstName(userName)
  const parentFirst = getFirstName(parentName)

  const signals = meta?.signals || {}
  const isReplyInThread = Boolean(meta?.isReply)
  const location = normalize(meta?.location || signals.location || "")
  const lang = String(meta?.lang || "en-us")

  const sigLine = [
    `jinxingLikely=${signals.jinxingLikely ? "true" : "false"}`,
    `sarcasmLikely=${signals.sarcasmLikely ? "true" : "false"}`,
    `bsLikely=${signals.bsLikely ? "true" : "false"}`,
    `debateLikely=${signals.debateLikely ? "true" : "false"}`,
    `worryLikely=${signals.worryLikely ? "true" : "false"}`,
    `praiseLikely=${signals.praiseLikely ? "true" : "false"}`,
    `questionLikely=${signals.questionLikely ? "true" : "false"}`,
    `location=${location ? `"${location}"` : "none"}`,
    `isReplyInThread=${isReplyInThread ? "true" : "false"}`,
    `lang=${lang}`
  ].join(", ")

  const curiosityTime = meta?.curiosityTime || "0:45"

  const baseRules = [
    "Write 1 to 3 short sentences total.",
    "Use 1 to 2 emojis total.",
    "No hashtags.",
    "Do not mention AI, bots, automation, or policies.",
    "ALWAYS end with EXACTLY ONE question that invites a reply.",
    "The question must match the topic and the thread. No generic questions.",
    "If this is a reply thread, react to BOTH sides in a quick, playful way."
  ]

  const logicRulesEn = [
    "If bsLikely is true: empathize, say it worked for you, invite others to share real results.",
    "If sarcasmLikely is true: be witty first, then anchor it to a practical point.",
    "If jinxingLikely is true: US uses 'Knock on wood'. UK uses 'Touch wood'. 'Appliance gods' fits both.",
    "If location is present: acknowledge it with a weather vibe.",
    "If praiseLikely is true: add 'Save this'.",
    `If questionLikely is true: add a curiosity cue like 'rewatch around ${curiosityTime}'.`,
    "If debateLikely is true: jump into the discussion briefly and keep it light.",
    "If nothing special triggers: be relatable and a bit surprised."
  ]

  const logicRulesRu = [
    "Если bsLikely true: спокойно. 'Жаль, что не сработало', 'у меня сработало', 'пусть другие подтвердят'.",
    "Если sarcasmLikely true: коротко, остроумно, потом по делу.",
    "Если jinxingLikely true: 'постучи по дереву', 'не сглазить', 'боги техники'.",
    "Если location есть: отметь локацию и погоду одной фразой.",
    "Если praiseLikely true: добавь 'Сохрани'.",
    `Если questionLikely true: добавь таймкод, например 'пересмотри около ${curiosityTime}'.`,
    "Если ветка спорная: вмешайся коротко и игриво.",
    "Если ничего не триггерит: по-дружески, будто сам удивился."
  ]

  const header =
    lang === "ru"
      ? [
          "Роль: Ты ведёшь страницу T.Lifehack. Ты живой, дружелюбный, чуть дерзкий автор в комментариях.",
          "Цель: вовлечение, сохранения, дискуссии.",
          "",
          "Ответь ТОЛЬКО по-русски.",
          ...baseRules,
          ...logicRulesRu,
          "",
          `Сигналы: ${sigLine}`,
          ""
        ]
      : lang === "en-uk"
      ? [
          "Role: You manage the T.Lifehack page. You are a savvy, friendly, witty creator in the comments.",
          "Goal: maximize engagement, push saves, grow community.",
          "",
          "Reply ONLY in British English.",
          "Use contractions: don't, it's, you're, gonna, kinda, yep, nah.",
          "Use UK vibe when it fits: mate, cheers. Use British spelling: colour, favourite.",
          ...baseRules,
          ...logicRulesEn,
          "",
          `Context signals: ${sigLine}`,
          ""
        ]
      : [
          "Role: You manage the T.Lifehack USA Facebook/Reels page. You are a savvy, friendly, witty American creator.",
          "Goal: maximize engagement, push saves, grow community.",
          "",
          "Reply ONLY in American English.",
          "Use contractions: don't, it's, you're, gonna, kinda, yep, nah.",
          ...baseRules,
          ...logicRulesEn,
          "",
          `Context signals: ${sigLine}`,
          ""
        ]

  const lines = [...header]

  if (ctx) {
    lines.push("Post context:")
    lines.push(ctx)
    lines.push("")
  }

  if (parentMsg) {
    lines.push(`Parent comment (${parentFirst || "viewer"}): "${parentMsg}"`)
    lines.push("")
  }

  lines.push(`New comment (${userFirst || "viewer"}): "${text}"`)
  lines.push("")

  if (isReplyInThread || signals.debateLikely) {
    lines.push("End your final question addressing the new commenter by first name if available.")
    lines.push("")
  }

  return lines.join("\n")
}

const buildBaitPrompt = (postContext, lang) => {
  const ctx = normalize(postContext)

  if (lang === "ru") {
    return [
      "Задача: Напиши ОДИН провокационный комментарий под новым видео T.Lifehack.",
      "Цель: запустить спор, мнения, дискуссию.",
      "Стратегия: полярный вопрос или вызов.",
      "",
      "Правила:",
      "Пиши ТОЛЬКО по-русски.",
      "1 или 2 коротких предложения.",
      "1 или 2 эмодзи.",
      "Без хештегов.",
      "Не упоминай закреп, бота, AI, автоматизацию.",
      "Максимально по теме контекста поста.",
      "В конце ровно 1 вопрос.",
      "",
      "Контекст поста:",
      ctx || "(нет контекста)",
      ""
    ].join("\n")
  }

  if (lang === "en-uk") {
    return [
      "Task: Write ONE engagement bait comment for a new T.Lifehack video.",
      "Goal: spark debate and opinions.",
      "Strategy: a polarising question or a challenge.",
      "",
      "Rules:",
      "Reply ONLY in British English.",
      "1 to 2 short sentences.",
      "Use 1 to 2 emojis.",
      "No hashtags.",
      "Do not mention pinning, bots, AI, or automation.",
      "Make it specific to the post context.",
      "End with EXACTLY ONE question.",
      "",
      "Post context:",
      ctx || "(no context)",
      ""
    ].join("\n")
  }

  return [
    "Task: Write ONE engagement bait comment for a new T.Lifehack USA video.",
    "Goal: spark debate, opinions, arguments, and 'I didn’t know' reactions.",
    "Strategy: use a polarizing question or a challenge.",
    "",
    "Rules:",
    "Reply ONLY in American English.",
    "1 to 2 short sentences.",
    "Use 1 to 2 emojis.",
    "No hashtags.",
    "Do not mention pinning, bots, AI, or automation.",
    "Make it specific to the post context.",
    "End with EXACTLY ONE question.",
    "",
    "Post context:",
    ctx || "(no context)",
    ""
  ].join("\n")
}

const ensureNameInQuestion = (text, name, enabled) => {
  if (!enabled) return text
  const n = String(name || "").trim()
  if (!n) return text

  const s = String(text || "").trim()
  const qPos = s.lastIndexOf("?")
  if (qPos < 0) return s

  const body = s.slice(0, qPos + 1)
  const lower = body.toLowerCase()
  if (lower.includes(n.toLowerCase())) return s

  const prefix = s.slice(0, qPos)
  const suffix = s.slice(qPos)

  const lastSentenceStart = Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("!"))
  const head = lastSentenceStart >= 0 ? prefix.slice(0, lastSentenceStart + 1).trim() : ""
  const question = lastSentenceStart >= 0 ? prefix.slice(lastSentenceStart + 1).trim() : prefix.trim()

  const questionTrim = question.replace(/^[\s"']+/, "")
  if (questionTrim.toLowerCase().startsWith(n.toLowerCase())) return s

  const rebuiltQuestion = `${n}, ${questionTrim}`.replace(/\s+/g, " ").trim()
  const out = `${head ? head + " " : ""}${rebuiltQuestion}${suffix}`.replace(/\s+/g, " ").trim()
  return out
}

const isWrongLanguage = (text, lang) => {
  const s = String(text || "")
  if (!s.trim()) return true
  if (lang === "ru") return !hasCyrillic(s)
  return hasCyrillic(s)
}

const callOpenAi = async (input, temperature = 0.7, maxTokens = 180) => {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("OPENAI_API_KEY missing")

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini"

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
  })

  if (!r.ok) {
    const t = await r.text()
    throw new Error(`OpenAI error ${r.status}: ${t}`)
  }

  const data = await r.json()
  return extractOpenAiText(data)
}

const generateReply = async (comment, postContext, meta = {}) => {
  const lang = String(meta?.lang || "en-us")
  const userFirst = getFirstName(meta?.userName || "")
  const nameQuestion = Boolean(meta?.nameQuestion)

  let first = await callOpenAi(buildPrompt(comment, postContext, meta), 0.9, 180)
  first = trimReply(stripHashtags(first), 240)
  first = enforceOneQuestionAtEnd(first)
  first = ensureNameInQuestion(first, userFirst, nameQuestion)

  if (!first) throw new Error("Empty OpenAI reply")

  if (!isWrongLanguage(first, lang === "ru" ? "ru" : "en")) return first

  const retryPrompt =
    lang === "ru"
      ? [
          "Перепиши ответ строго по-русски.",
          "Сохрани живой тон.",
          "1–3 коротких предложения.",
          "1–2 эмодзи.",
          "В конце ровно 1 вопрос.",
          "Без хештегов.",
          "",
          `Текст: "${first}"`
        ].join("\n")
      : [
          "Rewrite the reply strictly in English.",
          "Keep the same witty, human tone and contractions.",
          "Write 1 to 3 short sentences.",
          "Use 1 to 2 emojis.",
          "End with exactly one question.",
          "No hashtags.",
          "",
          `Reply to rewrite: "${first}"`
        ].join("\n")

  let second = await callOpenAi(retryPrompt, 0.4, 180)
  second = trimReply(stripHashtags(second), 240)
  second = enforceOneQuestionAtEnd(second)
  second = ensureNameInQuestion(second, userFirst, nameQuestion)

  if (second && !isWrongLanguage(second, lang === "ru" ? "ru" : "en")) return second

  return first
}

const generateBaitComment = async (postContext, lang) => {
  let first = await callOpenAi(buildBaitPrompt(postContext, lang), 0.95, 140)
  first = trimReply(stripHashtags(first), BAIT_MAX_CHARS)
  first = enforceOneQuestionAtEnd(first)

  if (!first) throw new Error("Empty OpenAI bait")

  if (!isWrongLanguage(first, lang === "ru" ? "ru" : "en")) return first

  const retryPrompt =
    lang === "ru"
      ? [
          "Перепиши строго по-русски.",
          "1 или 2 коротких предложения.",
          "1 или 2 эмодзи.",
          "В конце ровно 1 вопрос.",
          "Без хештегов.",
          "",
          `Текст: "${first}"`
        ].join("\n")
      : [
          "Rewrite strictly in English.",
          "1 to 2 short sentences.",
          "Use 1 to 2 emojis.",
          "End with exactly one question.",
          "No hashtags.",
          "",
          `Text: "${first}"`
        ].join("\n")

  let second = await callOpenAi(retryPrompt, 0.35, 140)
  second = trimReply(stripHashtags(second), BAIT_MAX_CHARS)
  second = enforceOneQuestionAtEnd(second)

  if (second && !isWrongLanguage(second, lang === "ru" ? "ru" : "en")) return second

  return first
}

const postReply = async (commentId, text, pageToken) => {
  const r = await fetch(`${GRAPH_API_BASE}/${commentId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: text,
      access_token: pageToken
    })
  })

  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Post reply failed ${r.status}: ${t}`)
  }
  return r.json()
}

const postCommentOnPost = async (postId, text, pageToken) => {
  const r = await fetch(`${GRAPH_API_BASE}/${postId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: text,
      access_token: pageToken
    })
  })

  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Post comment failed ${r.status}: ${t}`)
  }
  return r.json()
}

const pruneBaitCache = (state) => {
  const cutoff = nowMs() - BAIT_CACHE_TTL_MS
  for (const [k, v] of state.baitCache.entries()) {
    if (!v || v.ts < cutoff) state.baitCache.delete(k)
  }
}

const wasBaitPosted = (state, postId) => {
  pruneBaitCache(state)
  const v = state.baitCache.get(postId)
  if (!v) return false
  if (nowMs() - v.ts > BAIT_CACHE_TTL_MS) {
    state.baitCache.delete(postId)
    return false
  }
  return true
}

const markBaitPosted = (state, postId, commentId, text) => {
  pruneBaitCache(state)
  state.baitCache.set(postId, { ts: nowMs(), commentId: String(commentId || ""), text: String(text || "") })
}

const gateAtForType = (state, type) => {
  if (type === "like") return state.nextLikeAllowedAt
  return state.nextReplyAllowedAt
}

const getNextTaskIndex = (state) => {
  let bestIdx = -1
  let bestReady = Infinity

  const now = nowMs()
  for (let i = 0; i < state.replyQueue.length; i++) {
    const dueAt = Number(state.replyQueue[i]?.dueAt || 0)
    const type = String(state.replyQueue[i]?.type || "reply")
    const gateAt = gateAtForType(state, type)
    const readyAt = Math.max(dueAt, gateAt, now)

    if (readyAt < bestReady) {
      bestReady = readyAt
      bestIdx = i
    }
  }
  return bestIdx
}

const scheduleQueueProcessing = (state, pageId) => {
  if (state.processingQueue) return
  state.processingQueue = true

  const runNext = async () => {
    if (!isBotEnabled()) {
      state.replyQueue.length = 0
      state.processingQueue = false
      return
    }

    if (!state.replyQueue.length) {
      state.processingQueue = false
      return
    }

    const idx = getNextTaskIndex(state)
    if (idx < 0) {
      state.processingQueue = false
      return
    }

    const taskObj = state.replyQueue[idx]
    const now = nowMs()

    const dueAt = Number(taskObj.dueAt || 0)
    const type = String(taskObj.type || "reply")
    const gateAt = gateAtForType(state, type)
    const readyAt = Math.max(dueAt, gateAt)

    const waitMs = Math.max(0, readyAt - now)
    if (waitMs > 0) {
      setTimeout(runNext, waitMs)
      return
    }

    state.replyQueue.splice(idx, 1)

    try {
      const did = await taskObj.run()
      if (did) {
        if (type === "like") {
          const gap = randInt(BETWEEN_LIKE_MIN_MS, BETWEEN_LIKE_MAX_MS)
          state.nextLikeAllowedAt = nowMs() + gap
        } else {
          const gap = randInt(BETWEEN_REPLY_MIN_MS, BETWEEN_REPLY_MAX_MS)
          state.nextReplyAllowedAt = nowMs() + gap
        }
      }
    } catch (err) {
      logJson("WEBHOOK ERROR", { pageId, err: String(err).slice(0, 400) })
      if (type === "like") {
        const gap = randInt(BETWEEN_LIKE_MIN_MS, BETWEEN_LIKE_MAX_MS)
        state.nextLikeAllowedAt = nowMs() + gap
      } else {
        const gap = randInt(BETWEEN_REPLY_MIN_MS, BETWEEN_REPLY_MAX_MS)
        state.nextReplyAllowedAt = nowMs() + gap
      }
    } finally {
      setImmediate(runNext)
    }
  }

  setImmediate(runNext)
}

const ensureBaitForPost = async (state, postId, pageToken, ts, reason, pageId) => {
  if (!BAIT_ENABLED) return
  const pid = String(postId || "").trim()
  if (!pid) return

  if (!pid.includes("_")) {
    if (LOG_SKIPS) logJson("SKIP", { reason: "BAIT_BAD_POST_ID", pageId, postId: pid, why: reason })
    return
  }

  if (wasBaitPosted(state, pid)) return
  if (state.baitInflight.has(pid)) return

  if (state.replyQueue.length + 1 > MAX_QUEUE_LENGTH) {
    if (LOG_SKIPS) logJson("SKIP", { reason: "BAIT_QUEUE_FULL", pageId, postId: pid, queueLen: state.replyQueue.length, why: reason })
    return
  }

  state.baitInflight.add(pid)

  const dueAt = nowMs() + randInt(BAIT_DELAY_MIN_MS, BAIT_DELAY_MAX_MS)

  state.replyQueue.push({
    type: "bait",
    postId: pid,
    dueAt,
    run: async () => {
      try {
        if (!isBotEnabled()) return false
        if (wasBaitPosted(state, pid)) return false

        const postContext = await getPostContext(state, pid, pageToken)
        if (hasCyrillic(postContext)) state.forceRussian = true

        const lang = state.forceRussian ? "ru" : "en-us"
        const bait = await generateBaitComment(postContext, lang)

        const posted = await postCommentOnPost(pid, bait, pageToken)
        const postedId = pickId(posted)

        markBaitPosted(state, pid, postedId, bait)
        if (postedId) rememberComment(state, postedId)

        logJson("BAIT_POSTED", { at: ts, pageId, postId: pid, postedId, bait, reason })
        return true
      } catch (e) {
        logJson("BAIT_FAILED", { at: ts, pageId, postId: pid, reason, err: String(e).slice(0, 300) })
        return false
      } finally {
        state.baitInflight.delete(pid)
      }
    }
  })

  scheduleQueueProcessing(state, pageId)
}

const extractCommentId = (v) => {
  if (!v) return ""
  if (typeof v.comment_id === "string") return v.comment_id
  if (v.comment?.id) return v.comment.id
  if (v.commentId) return v.commentId
  return ""
}

const extractPostId = (v) => {
  if (!v) return ""
  if (typeof v.post_id === "string") return v.post_id
  if (typeof v.postId === "string") return v.postId
  return ""
}

app.post("/webhook", (req, res) => {
  const ts = new Date().toISOString()
  res.sendStatus(200)

  setImmediate(async () => {
    try {
      if (!isBotEnabled()) return

      const entries = Array.isArray(req.body?.entry) ? req.body.entry : []
      if (!entries.length) return

      let webhookInLogged = false
      const logWebhookInOnce = (meta) => {
        if (!LOG_WEBHOOK_IN) return
        if (webhookInLogged) return
        if (LOG_ONLY_MESSAGE_EVENTS && !meta?.hasRealMessage) return
        webhookInLogged = true
        logJson("WEBHOOK IN", meta || {})
      }

      for (const e of entries) {
        const changes = Array.isArray(e?.changes) ? e.changes : []
        if (!changes.length) continue

        for (const c of changes) {
          if (c?.field !== "feed") continue
          const value = c?.value || {}

          const pageId = extractPageId(e, value)
          const pageToken = getPageToken(pageId)
          if (!pageToken) {
            logJson("WEBHOOK ERROR", { at: ts, pageId: pageId || "unknown", err: "FB_PAGE_TOKEN missing for pageId" })
            continue
          }

          const state = getPageState(pageId)
          if (!state.pageIdResolved && pageId) state.pageIdResolved = String(pageId)

          const item = String(value?.item || "").trim()
          const verb = String(value?.verb || "").trim()
          const postId = String(extractPostId(value) || "").trim()

          if (
            BAIT_ENABLED &&
            BAIT_ON_NEW_POST &&
            verb === "add" &&
            postId &&
            NEW_POST_ITEMS.has(item) &&
            Number(value?.published ?? 1) === 1
          ) {
            await ensureBaitForPost(state, postId, pageToken, ts, `new_post_item=${item}`, pageId)
          }

          if (item !== "comment" || verb !== "add") continue

          const commentId = extractCommentId(value)
          if (!commentId) continue

          const parentId = String(value?.parent_id || "").trim()
          const isReply = isReplyEvent(value)
          const threadKey = getThreadKey(value, commentId)

          if (wasProcessed(state, commentId)) continue
          if (state.inflight.has(commentId)) continue

          if (!replyToRepliesEnabled() && isReply) {
            rememberComment(state, commentId)
            continue
          }

          const createdSec = Number(value?.created_time || 0)
          if (createdSec) {
            const createdMs = createdSec * 1000
            if (nowMs() - createdMs > IGNORE_OLD_COMMENTS_MIN * 60 * 1000) {
              rememberComment(state, commentId)
              continue
            }
          }

          const prob = isReply ? REPLY_PROB_REPLY : REPLY_PROB_TOP
          const rnd = Math.random()
          if (rnd > prob) {
            rememberComment(state, commentId)
            continue
          }

          if (!allowReplyByRate(state)) {
            rememberComment(state, commentId)
            continue
          }

          if (!allowReplyInThread(state, threadKey)) {
            rememberComment(state, commentId)
            continue
          }

          const tasksToAdd = LIKE_ENABLED ? 2 : 1
          if (state.replyQueue.length + tasksToAdd > MAX_QUEUE_LENGTH) {
            rememberComment(state, commentId)
            continue
          }

          let comment = getCachedComment(state, commentId)
          if (!comment) {
            try {
              comment = await fetchComment(commentId, pageToken)
              setCachedComment(state, commentId, comment)
            } catch (err) {
              rememberComment(state, commentId)
              if (LOG_SKIPS) logJson("SKIP", { reason: "COMMENT_FETCH_FAILED", pageId, commentId, postId, threadKey, err: String(err).slice(0, 220) })
              continue
            }
          }

          const msgForLog = safeSlice(comment?.message, WEBHOOK_MESSAGE_MAX_CHARS)
          const msgIsReal = !isNoiseOnly(comment?.message)

          if (LOG_ONLY_MESSAGE_EVENTS && !msgIsReal) {
            rememberComment(state, commentId)
            continue
          }

          logWebhookInOnce({ at: ts, pageId, hasRealMessage: msgIsReal })

          if (LOG_WEBHOOK_EVENTS && (!LOG_ONLY_MESSAGE_EVENTS || msgIsReal)) {
            logJson("WEBHOOK_EVENT", {
              at: ts,
              pageId,
              commentId,
              postId,
              parentId,
              isReply,
              item,
              verb,
              created_time: value?.created_time || null,
              queueLen: state.replyQueue.length
            })
          }

          if (LOG_WEBHOOK_MESSAGE && (!LOG_ONLY_MESSAGE_EVENTS || msgIsReal)) {
            logJson("WEBHOOK_MESSAGE", {
              pageId,
              commentId,
              postId,
              from: String(comment?.from?.name || ""),
              msg: msgForLog,
              parentFrom: String(comment?.parent?.from?.name || ""),
              parentMsg: safeSlice(comment?.parent?.message, WEBHOOK_MESSAGE_MAX_CHARS)
            })
          }

          const selfId = String(state.pageIdResolved || pageId || "").trim()
          if (selfId && String(comment?.from?.id || "") === selfId) {
            rememberComment(state, commentId)
            if (LOG_SKIPS && (!LOG_ONLY_MESSAGE_EVENTS || msgIsReal)) {
              logJson("SKIP", { reason: "SELF", pageId, commentId, postId, threadKey, msg: safeSlice(msgForLog, SKIP_MESSAGE_MAX_CHARS) })
            }
            continue
          }

          if (!msgIsReal) {
            rememberComment(state, commentId)
            if (LOG_SKIPS && (!LOG_ONLY_MESSAGE_EVENTS || msgIsReal)) {
              logJson("SKIP", { reason: "NOISE", pageId, commentId, postId, threadKey, msg: safeSlice(msgForLog, SKIP_MESSAGE_MAX_CHARS) })
            }
            continue
          }

          if (BAIT_ENABLED && BAIT_ON_FIRST_COMMENT && postId) {
            const meta = await getPostMeta(state, postId, pageToken)
            const createdMs = Number(meta?.createdMs || 0)
            const published = Number(meta?.published ?? 1)

            if (published === 1 && createdMs) {
              const ageMin = Math.floor((nowMs() - createdMs) / 60000)
              if (ageMin <= BAIT_FRESH_POST_WINDOW_MIN) {
                await ensureBaitForPost(state, postId, pageToken, ts, "first_comment_fallback", pageId)
              }
            }
          }

          state.inflight.add(commentId)

          const likeDelay = LIKE_ENABLED ? randInt(LIKE_MIN_MS, LIKE_MAX_MS) : 0
          const replyDelay = LIKE_ENABLED
            ? randInt(REPLY_AFTER_LIKE_MIN_MS, REPLY_AFTER_LIKE_MAX_MS)
            : randInt(FIRST_REPLY_MIN_MS, FIRST_REPLY_MAX_MS)

          const dueLikeAt = nowMs() + likeDelay
          const dueReplyAt = nowMs() + likeDelay + replyDelay

          const fromForLog = String(comment?.from?.name || "")
          const parentFromForLog = String(comment?.parent?.from?.name || "")

          if (LIKE_ENABLED) {
            state.replyQueue.push({
              type: "like",
              commentId,
              postId,
              threadKey,
              dueAt: dueLikeAt,
              run: async () => {
                if (!isBotEnabled()) return false
                if (wasProcessed(state, commentId)) return false

                try {
                  await likeComment(commentId, pageToken)
                  return true
                } catch (err) {
                  logJson("LIKE_FAILED", { pageId, commentId, postId, threadKey, err: String(err).slice(0, 240) })
                  return false
                }
              }
            })
          }

          state.replyQueue.push({
            type: "reply",
            commentId,
            postId,
            threadKey,
            dueAt: dueReplyAt,
            run: async () => {
              try {
                if (!isBotEnabled()) return false
                if (wasProcessed(state, commentId)) return false

                const cached = getCachedComment(state, commentId)
                const src = cached || comment

                const signals = analyzeSignals(src)

                const postContext = await getPostContext(state, postId, pageToken)
                if (hasCyrillic(postContext)) state.forceRussian = true

                const mode = detectReplyMode(state, src, postContext, signals)
                if (mode.lang === "ru") state.forceRussian = true

                const meta = {
                  isReply: Boolean(src?.parent?.id) || Boolean(isReply),
                  userName: String(src?.from?.name || fromForLog || ""),
                  parentName: String(src?.parent?.from?.name || parentFromForLog || ""),
                  location: signals.location,
                  signals,
                  lang: mode.lang,
                  curiosityTime: pickCuriosityTimestamp(commentId),
                  nameQuestion: Boolean((Boolean(src?.parent?.message) || Boolean(signals.debateLikely)) && getFirstName(src?.from?.name || fromForLog))
                }

                const reply = await generateReply(src, postContext, meta)
                const posted = await postReply(commentId, reply, pageToken)

                rememberComment(state, commentId)

                const postedId = pickId(posted)
                if (postedId) rememberComment(state, postedId)

                markReply(state)
                markThreadReply(state, threadKey)

                logJson("REPLIED", {
                  at: ts,
                  pageId,
                  commentId,
                  postId,
                  threadKey,
                  likeDelayMs: LIKE_ENABLED ? likeDelay : 0,
                  replyAfterLikeMs: LIKE_ENABLED ? replyDelay : 0,
                  msg: LOG_WEBHOOK_MESSAGE ? safeSlice(src?.message || "", SKIP_MESSAGE_MAX_CHARS) : undefined,
                  signals: LOG_WEBHOOK_MESSAGE ? meta.signals : undefined,
                  lang: mode.lang,
                  reply,
                  postedId,
                  permalink: src?.permalink_url || ""
                })

                return true
              } finally {
                state.inflight.delete(commentId)
              }
            }
          })

          scheduleQueueProcessing(state, pageId)
        }
      }
    } catch (err) {
      logJson("WEBHOOK ERROR", { at: ts, err: String(err).slice(0, 500) })
    }
  })
})

app.get("/", (_, res) => res.send("Bot is running"))

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"]
  const token = req.query["hub.verify_token"]
  const challenge = req.query["hub.challenge"]

  if (mode === "subscribe" && token === process.env.FB_VERIFY_TOKEN) {
    return res.status(200).send(challenge)
  }
  return res.sendStatus(403)
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Server started on ${PORT}`))
