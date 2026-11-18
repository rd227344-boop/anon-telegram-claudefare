// Nexus Anonymous Chat Bot - Cloudflare Workers + D1
//
// Required:  D1 binding named DB, secret BOT_TOKEN
// Optional:  ADMIN_IDS (comma separated Telegram ids), BROADCAST_CHUNK, GAP_MIN_SECONDS,
//            GAP_MAX_SECONDS, AUTO_BAN_REPORTS
// After deploy open  https://<your-worker>.workers.dev/setup  once.

// ---------------------------------------------------------------- Config

const DEFAULTS = {
  GAP_MIN_SECONDS: 10, // do log ke beech kam se kam itna gap, phir wahi dobara match ho sakte hain
  GAP_MAX_SECONDS: 15, // aur zyada se zyada itna (random)
  BROADCAST_CHUNK: 30, // ek baar mein itne users ko broadcast (free plan ki limit ke andar)
  AUTO_BAN_REPORTS: 5, // itne alag alag users report karein to auto ban
  MAX_PENDING_MEDIA: 10, // request ke intezaar mein ek category ke max items
  WARN_AFTER_REPORTS: 3, // itne alag users ki report ke baad har nayi report par warning
  MIN_REPORT_TEXT: 25, // underage report / appeal mein kam se kam itne characters
};
const cfg = (env, key) => {
  const v = Number(env[key]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULTS[key];
};

const IST_OFFSET = 330 * 60; // admin ko time IST mein dikhta hai

const CAT_OF = {
  photo: "photo",
  sticker: "sticker",
  video: "video",
  video_note: "video",
  animation: "video",
  document: "file",
  audio: "file",
  voice: "file",
};
const CAT_NAME = { photo: "photo", sticker: "sticker", video: "video", file: "file or voice message" };
const CAT_PLURAL = { photo: "photos", sticker: "stickers", video: "videos", file: "files and voice messages" };

// Typed hone ki sambhavna kam rakhne ke liye lambe labels
const BTN_NEXT = "Next Partner";
const BTN_STOP = "Stop Chat";
const BTN_SAVE = "Save Partner";
const BTN_SAVED = "Saved Partners";
const BUTTONS = [BTN_NEXT, BTN_STOP, BTN_SAVE, BTN_SAVED];

const MAIN_KEYBOARD = {
  keyboard: [[{ text: BTN_NEXT }, { text: BTN_STOP }], [{ text: BTN_SAVE }, { text: BTN_SAVED }]],
  resize_keyboard: true,
};

const MATCH_MSG = "**Connected with a stranger.** Say hello!\nUse the buttons below to control the chat.";
const FEEDBACK_TEXT = "If you wish, report your partner. It helps us keep the community safe.";
const REASONS = { sp: "Spam / Advertising", vg: "Vulgar partner", ua: "Underage user", rp: "Other report" };
const BAN_LADDER_DAYS = [30, 365]; // 1st ban 30 din, 2nd 1 saal, 3rd se permanent
const APPEAL_KB = { inline_keyboard: [[{ text: "Appeal", callback_data: "appeal_start" }]] };

// ---------------------------------------------------------------- Schema

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    gender TEXT,
    age TEXT,
    language TEXT,
    waiting_nick INTEGER,
    created_at INTEGER,
    last_seen INTEGER,
    banned INTEGER DEFAULT 0,
    ban_reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS saved_partners (
    user_id INTEGER, partner_id INTEGER, nickname TEXT,
    PRIMARY KEY (user_id, partner_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chats (user_id INTEGER PRIMARY KEY, partner_id INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS queue (user_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS recent (
    user_id INTEGER PRIMARY KEY, partner_id INTEGER NOT NULL, ts INTEGER NOT NULL, gap INTEGER DEFAULT 15
  )`,
  `CREATE TABLE IF NOT EXISTS media_consent (
    sender_id INTEGER, receiver_id INTEGER, cat TEXT, state TEXT NOT NULL,
    PRIMARY KEY (sender_id, receiver_id, cat)
  )`,
  `CREATE TABLE IF NOT EXISTS media_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER, receiver_id INTEGER, cat TEXT, kind TEXT, file_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER, reported_id INTEGER, reason TEXT, ts INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports (reported_id, ts)`,
  `CREATE TABLE IF NOT EXISTS daily_stats (day TEXT PRIMARY KEY, chats INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER, mode TEXT, text TEXT, from_chat_id INTEGER, from_message_id INTEGER,
    status TEXT, total INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
    cursor INTEGER DEFAULT 0, lock_until INTEGER, created_at INTEGER, finished_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS user_state (user_id INTEGER PRIMARY KEY, kind TEXT, data TEXT, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, text TEXT, ts INTEGER, status TEXT
  )`,
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  // purane version ke database ko naye columns de do
  const addMissing = async (table, defs) => {
    const have = (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results.map((r) => r.name);
    for (const [name, def] of Object.entries(defs)) {
      if (!have.includes(name)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`).run();
    }
  };
  await addMissing("users", {
    created_at: "INTEGER", last_seen: "INTEGER", banned: "INTEGER DEFAULT 0", ban_reason: "TEXT",
    ban_until: "INTEGER", ban_count: "INTEGER DEFAULT 0", appeal_state: "INTEGER DEFAULT 0", report_floor: "INTEGER DEFAULT 0",
  });
  await addMissing("reports", { details: "TEXT", shot: "TEXT" });
  await addMissing("recent", { gap: "INTEGER DEFAULT 15" });
  await env.DB.batch([env.DB.prepare("DROP TABLE IF EXISTS consent"), env.DB.prepare("DROP TABLE IF EXISTS pending_media")]);
  schemaReady = true;
}

// ---------------------------------------------------------------- Small helpers

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (env, ms) => (env.SLEEP_FN ? env.SLEEP_FN(ms) : new Promise((r) => setTimeout(r, ms)));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (ts) => (ts ? new Date((ts + IST_OFFSET) * 1000).toISOString().slice(0, 16).replace("T", " ") + " IST" : "never");
const dayKey = (ts) => new Date((ts + IST_OFFSET) * 1000).toISOString().slice(0, 10);
const startOfToday = (ts) => Math.floor((ts + IST_OFFSET) / 86400) * 86400 - IST_OFFSET;
const pct = (n, total) => (total ? Math.round((n * 100) / total) + "%" : "0%");

const adminIds = (env) =>
  String(env.ADMIN_IDS || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(Boolean);
const isAdmin = (env, id) => adminIds(env).includes(id);

async function count(env, sql, ...args) {
  const r = await env.DB.prepare(sql).bind(...args).first();
  return r ? Object.values(r)[0] || 0 : 0;
}

// settings (maintenance, media switch) thodi der cache hoti hain
let settingsCache = null;
async function getSettings(env) {
  if (settingsCache && Date.now() - settingsCache.ts < 20000) return settingsCache.map;
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const map = {};
  for (const r of results) map[r.key] = r.value;
  settingsCache = { ts: Date.now(), map };
  return map;
}
async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
  settingsCache = null;
}

// ---------------------------------------------------------------- Telegram API

async function tg(env, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    console.log("tg error", method, String(e));
    return { ok: false, description: String(e) };
  }
}

async function send(env, chatId, text, extra = {}) {
  let r = await tg(env, "sendMessage", { chat_id: chatId, text, ...extra });
  if (!r.ok && extra.parse_mode && /parse entities/i.test(r.description || "")) {
    const { parse_mode, ...rest } = extra;
    r = await tg(env, "sendMessage", { chat_id: chatId, text, ...rest });
  }
  if (!r.ok) console.log("sendMessage failed", chatId, r.description);
  return r;
}

async function editText(env, chatId, messageId, text, extra = {}) {
  let r = await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
  if (!r.ok && extra.parse_mode && /parse entities/i.test(r.description || "")) {
    const { parse_mode, ...rest } = extra;
    r = await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, ...rest });
  }
  return r;
}

async function sendMedia(env, chatId, kind, fileId) {
  const map = {
    photo: ["sendPhoto", "photo"],
    video: ["sendVideo", "video"],
    video_note: ["sendVideoNote", "video_note"],
    animation: ["sendAnimation", "animation"],
    sticker: ["sendSticker", "sticker"],
    document: ["sendDocument", "document"],
    voice: ["sendVoice", "voice"],
    audio: ["sendAudio", "audio"],
  };
  const m = map[kind];
  if (!m) return;
  const r = await tg(env, m[0], { chat_id: chatId, [m[1]]: fileId });
  if (!r.ok) console.log(m[0], "failed", chatId, r.description);
}

// ---------------------------------------------------------------- DB helpers

async function getProfile(env, id) {
  return await env.DB.prepare(
    "SELECT gender, age, language, waiting_nick, banned, ban_reason, ban_until, ban_count, appeal_state, report_floor, last_seen FROM users WHERE user_id = ?"
  ).bind(id).first();
}

const isComplete = (p) => !!(p && p.gender && p.age && p.language);

async function setField(env, user, col, val) {
  if (!["gender", "age", "language", "username", "waiting_nick"].includes(col)) throw new Error("bad column");
  await env.DB.prepare("INSERT OR IGNORE INTO users (user_id, username, created_at) VALUES (?, ?, ?)")
    .bind(user.id, user.username ?? null, nowSec())
    .run();
  await env.DB.prepare(`UPDATE users SET ${col} = ? WHERE user_id = ?`).bind(val, user.id).run();
}

// Chhoti baatcheet ka state (underage report likhna, appeal likhna). 15 minute mein expire.
async function getState(env, id) {
  const r = await env.DB.prepare("SELECT kind, data, ts FROM user_state WHERE user_id = ?").bind(id).first();
  if (!r) return null;
  if (nowSec() - r.ts > 900) {
    await clearState(env, id);
    return null;
  }
  return r;
}
async function setState(env, id, kind, data) {
  await env.DB.prepare("INSERT OR REPLACE INTO user_state (user_id, kind, data, ts) VALUES (?, ?, ?, ?)").bind(id, kind, data || "", nowSec()).run();
}
async function clearState(env, id) {
  await env.DB.prepare("DELETE FROM user_state WHERE user_id = ?").bind(id).run();
}

function timeLeft(sec) {
  if (sec <= 60) return "less than a minute";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} day${d > 1 ? "s" : ""} ${h} hour${h !== 1 ? "s" : ""}`;
  if (h) return `${h} hour${h !== 1 ? "s" : ""} ${m} min`;
  return `${m} min`;
}

async function hasRecentReport(env, reporter, reported) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM reports WHERE reporter_id = ? AND reported_id = ? AND ts > ?").bind(reporter, reported, nowSec() - 86400).first());
}

async function getPartner(env, id) {
  const r = await env.DB.prepare("SELECT partner_id FROM chats WHERE user_id = ?").bind(id).first();
  return r ? r.partner_id : null;
}

async function inQueue(env, id) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM queue WHERE user_id = ?").bind(id).first());
}

async function getConsent(env, sender, receiver, cat) {
  const r = await env.DB.prepare("SELECT state FROM media_consent WHERE sender_id = ? AND receiver_id = ? AND cat = ?")
    .bind(sender, receiver, cat)
    .first();
  return r ? r.state : null;
}

async function setConsent(env, sender, receiver, cat, state) {
  await env.DB.prepare("INSERT OR REPLACE INTO media_consent (sender_id, receiver_id, cat, state) VALUES (?, ?, ?, ?)")
    .bind(sender, receiver, cat, state)
    .run();
}

// Chat khatam: chat rows hatao, gap lagao, media permissions reset karo
async function endChat(env, a, b) {
  const t = nowSec();
  const min = cfg(env, "GAP_MIN_SECONDS");
  const max = Math.max(min, cfg(env, "GAP_MAX_SECONDS"));
  const gap = min + Math.floor(Math.random() * (max - min + 1));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chats WHERE user_id IN (?, ?)").bind(a, b),
    env.DB.prepare("INSERT OR REPLACE INTO recent (user_id, partner_id, ts, gap) VALUES (?, ?, ?, ?)").bind(a, b, t, gap),
    env.DB.prepare("INSERT OR REPLACE INTO recent (user_id, partner_id, ts, gap) VALUES (?, ?, ?, ?)").bind(b, a, t, gap),
    env.DB.prepare("DELETE FROM media_consent WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)").bind(a, b, b, a),
    env.DB.prepare("DELETE FROM media_pending WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)").bind(a, b, b, a),
  ]);
}

// ---------------------------------------------------------------- Matching

// userId queue mein hona chahiye. Sirf apne se PEHLE se wait kar rahe user ko uthata hai
// (isse do log ek doosre ko ek saath uthane ki koshish mein atakte nahi), phir khud ko queue se hatata hai.
async function claimPair(env, userId) {
  const now = nowSec();
  const partner = await env.DB.prepare(
    `DELETE FROM queue WHERE user_id = (
       SELECT q.user_id FROM queue q, (SELECT ts AS mts FROM queue WHERE user_id = ?1) m
       WHERE q.user_id != ?1
         AND (q.ts < m.mts OR (q.ts = m.mts AND q.user_id < ?1))
         AND q.user_id NOT IN (SELECT partner_id FROM recent WHERE user_id = ?1 AND ts + gap > ?2)
         AND q.user_id NOT IN (SELECT user_id FROM recent WHERE partner_id = ?1 AND ts + gap > ?2)
       ORDER BY q.ts, q.user_id LIMIT 1
     ) RETURNING user_id, ts`
  ).bind(userId, now).first();
  if (!partner) return null;

  const self = await env.DB.prepare("DELETE FROM queue WHERE user_id = ? RETURNING user_id").bind(userId).first();
  if (!self) {
    // kisi aur ne humein pehle hi match kar diya, partner ko uski purani jagah par wapas daalo
    await env.DB.prepare("INSERT OR IGNORE INTO queue (user_id, ts) VALUES (?, ?)").bind(partner.user_id, partner.ts).run();
    return null;
  }

  const a = userId;
  const b = partner.user_id;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO chats (user_id, partner_id) VALUES (?, ?)").bind(a, b),
    env.DB.prepare("INSERT OR REPLACE INTO chats (user_id, partner_id) VALUES (?, ?)").bind(b, a),
    env.DB.prepare("DELETE FROM recent WHERE user_id IN (?, ?)").bind(a, b),
    env.DB.prepare("INSERT INTO daily_stats (day, chats) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET chats = chats + 1").bind(dayKey(now)),
  ]);
  return b;
}

async function announceMatch(env, a, b) {
  await send(env, a, MATCH_MSG, { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
  await send(env, b, MATCH_MSG, { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
}

// Cron: queue mein atke hue log (gap khatam hone ke baad) ko jod deta hai
async function runMatcher(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT user_id FROM queue ORDER BY ts LIMIT 15").all();
  for (const r of results) {
    if (!(await inQueue(env, r.user_id))) continue;
    const partner = await claimPair(env, r.user_id);
    if (partner) await announceMatch(env, r.user_id, partner);
  }
}

async function searchPartner(env, userId, chatId) {
  const reply = (text, extra) => send(env, chatId, text, extra);
  const profile = await getProfile(env, userId);
  if (!isComplete(profile)) {
    return reply("Please complete your profile first by typing /start");
  }
  if (await getPartner(env, userId)) {
    return reply(`You are already in a chat. Use /stop or ${BTN_NEXT}.`);
  }
  if (await inQueue(env, userId)) {
    return reply("Already searching...");
  }

  await env.DB.prepare("INSERT OR IGNORE INTO queue (user_id, ts) VALUES (?, ?)").bind(userId, nowSec()).run();
  let partner = null;
  for (let i = 0; i < 3 && !partner; i++) {
    if (i > 0 && !(await inQueue(env, userId))) break; // kisi ne match kar liya
    partner = await claimPair(env, userId);
  }
  if (partner) {
    return announceMatch(env, userId, partner);
  }
  if (!(await inQueue(env, userId))) return; // kisi aur ne humein match kar diya, wahi message bhej dega

  await reply("**Searching for a partner...** Please wait.", { parse_mode: "Markdown" });

  // Agar abhi gap chal raha hai (pichle partner se), to gap khatam hote hi ek baar aur try karo
  const rec = await env.DB.prepare("SELECT ts, gap FROM recent WHERE user_id = ?").bind(userId).first();
  if (rec) {
    const remaining = rec.ts + (rec.gap || 15) - nowSec();
    if (remaining > 0 && remaining <= 20) {
      await sleep(env, (remaining + 1) * 1000);
      if (await inQueue(env, userId)) {
        const p = await claimPair(env, userId);
        if (p) await announceMatch(env, userId, p);
      }
    }
  }
}

// ---------------------------------------------------------------- Stop / Next / Feedback

function feedbackKeyboard(partnerId, withSearch) {
  const rows = [[{ text: "⚠️ Report", callback_data: `rpt_${partnerId}` }]];
  if (withSearch) rows.push([{ text: "Search New Partner", callback_data: "action_search" }]);
  return { inline_keyboard: rows };
}

async function sendFeedback(env, chatId, partnerId, withSearch) {
  return send(env, chatId, FEEDBACK_TEXT, { reply_markup: feedbackKeyboard(partnerId, withSearch) });
}

async function stopChat(env, userId, chatId) {
  if (await inQueue(env, userId)) {
    await env.DB.prepare("DELETE FROM queue WHERE user_id = ?").bind(userId).run();
    return send(env, chatId, "Search stopped.", { reply_markup: MAIN_KEYBOARD });
  }
  const partnerId = await getPartner(env, userId);
  if (!partnerId) {
    return send(env, chatId, "You are not in an active chat.", { reply_markup: MAIN_KEYBOARD });
  }
  await endChat(env, userId, partnerId);

  await send(env, chatId, "**You stopped the chat.**\nType /search to find a new partner.", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
  await sendFeedback(env, chatId, partnerId, false);

  await send(env, partnerId, "**Your partner stopped the chat.**\nType /search to find a new partner.", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
  await sendFeedback(env, partnerId, userId, true);
}

async function nextPartner(env, userId, chatId) {
  const partnerId = await getPartner(env, userId);
  if (partnerId) {
    await endChat(env, userId, partnerId);
    await send(env, chatId, "**You skipped your partner.**\nLooking for a new partner...", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
    await sendFeedback(env, chatId, partnerId, false);

    await send(env, partnerId, "**Your partner skipped the chat.**\nType /search to find a new partner.", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
    await sendFeedback(env, partnerId, userId, true);
  }
  await env.DB.prepare("DELETE FROM queue WHERE user_id = ?").bind(userId).run();
  return searchPartner(env, userId, chatId);
}

const banNotice = (until) =>
  until ? `🚫 You have been banned from using this bot.\nTime left: ${timeLeft(until - nowSec())}` : "🚫 You have been banned from using this bot.\nThis ban is permanent.";

// Ban ladder: 1st = 30 din, 2nd = 1 saal, 3rd = permanent. Return: { until, label }
async function banUser(env, id, reason) {
  const t = nowSec();
  const u = await env.DB.prepare("SELECT ban_count FROM users WHERE user_id = ?").bind(id).first();
  const n = ((u && u.ban_count) || 0) + 1;
  const days = BAN_LADDER_DAYS[n - 1];
  const until = days ? t + days * 86400 : null;
  const label = days === 30 ? "30 days" : days === 365 ? "1 year" : "permanent";

  // jinhone report kiya tha unhe baad mein batayenge
  const reporters = (await env.DB.prepare("SELECT DISTINCT reporter_id FROM reports WHERE reported_id = ? AND ts > ?").bind(id, t - 30 * 86400).all()).results.slice(0, 10);

  await env.DB.prepare("UPDATE users SET banned = 1, ban_reason = ?, ban_until = ?, ban_count = ?, appeal_state = 0, report_floor = ? WHERE user_id = ?")
    .bind(reason, until, n, t, id)
    .run();
  await env.DB.prepare("DELETE FROM queue WHERE user_id = ?").bind(id).run();
  await clearState(env, id);
  const partnerId = await getPartner(env, id);
  if (partnerId) {
    await endChat(env, id, partnerId);
    await send(env, partnerId, "**Your partner stopped the chat.**\nType /search to find a new partner.", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
  }
  await send(env, id, banNotice(until), { reply_markup: APPEAL_KB });
  for (const r of reporters) {
    if (r.reporter_id !== id) await send(env, r.reporter_id, "✅ Action was taken on a report you made. Thank you for keeping the community safe.");
  }
  return { until, label };
}

async function liftBan(env, id, message) {
  await env.DB.prepare("UPDATE users SET banned = 0, ban_reason = NULL, ban_until = NULL, appeal_state = 0 WHERE user_id = ?").bind(id).run();
  await clearState(env, id);
  if (message) await send(env, id, message);
}

async function unbanUser(env, id) {
  await liftBan(env, id, "Your access to this bot has been restored. Type /start to continue.");
}

// Jin users ka ban time khatam ho gaya unhe wapas laata hai (cron)
async function expireBans(env) {
  const { results } = await env.DB.prepare("SELECT user_id FROM users WHERE banned = 1 AND ban_until IS NOT NULL AND ban_until <= ? LIMIT 20").bind(nowSec()).all();
  for (const r of results) {
    await liftBan(env, r.user_id, "Your ban has ended and you can use the bot again. Please follow the rules to avoid another ban. Type /start to continue.");
  }
}

// Report record karta hai. Return: "ok", "dup" ya "self"
// Underage report ginti mein nahi aati, wo seedha owner ke paas jaati hai.
async function recordReport(env, reporter, reported, reason, extra = {}) {
  if (reporter === reported) return "self";
  const t = nowSec();
  if (await hasRecentReport(env, reporter, reported)) return "dup";
  await env.DB.prepare("INSERT INTO reports (reporter_id, reported_id, reason, ts, details, shot) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(reporter, reported, reason, t, extra.details ?? null, extra.shot ?? null)
    .run();
  if (reason === REASONS.ua) return "ok";

  const target = await getProfile(env, reported);
  if (!target || target.banned || isAdmin(env, reported)) return "ok";
  const since = Math.max(t - 7 * 86400, target.report_floor || 0);
  const distinct = await count(env, "SELECT COUNT(DISTINCT reporter_id) FROM reports WHERE reported_id = ? AND ts > ? AND reason != ?", reported, since, REASONS.ua);

  if (distinct >= cfg(env, "AUTO_BAN_REPORTS")) {
    const res = await banUser(env, reported, `Auto-ban: reported by ${distinct} users`);
    for (const a of adminIds(env)) {
      await send(env, a, `<b>Auto-ban</b>\nUser <code>${reported}</code> was banned (${res.label}) after reports from ${distinct} different users.\nOpen /user ${reported} to review or unban.`, { parse_mode: "HTML" });
    }
  } else if (distinct >= cfg(env, "WARN_AFTER_REPORTS")) {
    await send(env, reported, `⚠️ Warning: a report was made against you (reason: ${reason}).\nPlease follow the community rules. Repeated reports can lead to a ban.`);
  }
  return "ok";
}

// Underage report: likha hua text (zaroori) + screenshot (optional), seedha owner ko
async function finishUaReport(env, reporterId, d, shot) {
  await clearState(env, reporterId);
  const res = await recordReport(env, reporterId, d.target, REASONS.ua, { details: d.text, shot: shot ? shot[1] : null });
  if (res !== "ok") {
    return send(env, reporterId, "You have already reported this user today. Thank you.", { reply_markup: MAIN_KEYBOARD });
  }
  for (const a of adminIds(env)) {
    await send(env, a, [
      "<b>⚠️ Underage report</b>",
      `Reported user: <code>${d.target}</code>`,
      `Reporter: <code>${reporterId}</code>`,
      "",
      esc(d.text),
    ].join("\n"), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [
        [{ text: "Ban user", callback_data: `adm_ban_${d.target}` }, { text: "Dismiss", callback_data: `adm_dis_${d.target}` }],
        [{ text: "View user", callback_data: `adm_u_${d.target}` }],
      ] },
    });
    if (shot) await sendMedia(env, a, shot[0], shot[1]);
  }
  return send(env, reporterId, "✅ Report received. Our team will review it. Thank you.", { reply_markup: MAIN_KEYBOARD });
}

const SKIP_KB = { inline_keyboard: [[{ text: "Skip", callback_data: "rpt_skip" }]] };

async function handleUaReport(env, msg, st) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  let d = {};
  try { d = JSON.parse(st.data || "{}"); } catch (e) {}
  if (!d.target) {
    await clearState(env, userId);
    return;
  }
  if (d.stage === "text") {
    const text = (msg.text || "").trim();
    const min = cfg(env, "MIN_REPORT_TEXT");
    if (text.length < min) {
      return send(env, chatId, `Please write a little more detail (at least ${min} characters, you wrote ${text.length}). Send /cancel to stop.`);
    }
    await setState(env, userId, "ua", JSON.stringify({ target: d.target, stage: "shot", text }));
    return send(env, chatId, "Got it. If you have a screenshot as proof, send it now (optional).", { reply_markup: SKIP_KB });
  }
  let shot = null;
  if (msg.photo && msg.photo.length) shot = ["photo", msg.photo[msg.photo.length - 1].file_id];
  else if (msg.document && /^image\//.test(msg.document.mime_type || "")) shot = ["document", msg.document.file_id];
  if (!shot) return send(env, chatId, "Please send a photo, or tap Skip.", { reply_markup: SKIP_KB });
  return finishUaReport(env, userId, d, shot);
}

// ---------------------------------------------------------------- Admin panel

const adminKb = (rows) => ({ inline_keyboard: rows });
const backRow = [{ text: "Back", callback_data: "adm_home" }];

async function viewHome(env) {
  const total = await count(env, "SELECT COUNT(*) FROM users");
  const chats = await count(env, "SELECT COUNT(*) FROM chats");
  const queue = await count(env, "SELECT COUNT(*) FROM queue");
  const banned = await count(env, "SELECT COUNT(*) FROM users WHERE banned = 1");
  const s = await getSettings(env);
  const text = [
    "<b>Admin Panel</b>",
    "Nexus Anonymous Chat",
    "",
    `Users: <b>${total}</b>`,
    `Active chats: <b>${Math.floor(chats / 2)}</b>`,
    `Waiting in queue: <b>${queue}</b>`,
    `Banned: <b>${banned}</b>`,
    s.maintenance === "1" ? "\n<b>Maintenance mode is ON</b>" : "",
  ].join("\n");
  return {
    text,
    kb: adminKb([
      [{ text: "Dashboard", callback_data: "adm_dash" }, { text: "Users", callback_data: "adm_users" }],
      [{ text: "Reports", callback_data: "adm_reports" }, { text: "Broadcast", callback_data: "adm_bc" }],
      [{ text: "Settings", callback_data: "adm_set" }, { text: "Refresh", callback_data: "adm_home" }],
      [{ text: "Close", callback_data: "adm_close" }],
    ]),
  };
}

async function distribution(env, col, total) {
  const { results } = await env.DB.prepare(`SELECT ${col} AS k, COUNT(*) AS c FROM users WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY c DESC`).all();
  if (!results.length) return "  no data yet";
  return results.map((r) => `  ${esc(r.k)}: ${r.c} (${pct(r.c, total)})`).join("\n");
}

async function viewDashboard(env) {
  const t = nowSec();
  const today = startOfToday(t);
  const total = await count(env, "SELECT COUNT(*) FROM users");
  const newToday = await count(env, "SELECT COUNT(*) FROM users WHERE created_at >= ?", today);
  const new7 = await count(env, "SELECT COUNT(*) FROM users WHERE created_at >= ?", t - 7 * 86400);
  const act24 = await count(env, "SELECT COUNT(*) FROM users WHERE last_seen >= ?", t - 86400);
  const act7 = await count(env, "SELECT COUNT(*) FROM users WHERE last_seen >= ?", t - 7 * 86400);
  const banned = await count(env, "SELECT COUNT(*) FROM users WHERE banned = 1");
  const chats = await count(env, "SELECT COUNT(*) FROM chats");
  const queue = await count(env, "SELECT COUNT(*) FROM queue");
  const chatsToday = await count(env, "SELECT chats FROM daily_stats WHERE day = ?", dayKey(t));
  const chatsAll = await count(env, "SELECT SUM(chats) FROM daily_stats");
  const repToday = await count(env, "SELECT COUNT(*) FROM reports WHERE ts >= ?", today);
  const text = [
    "<b>Dashboard</b>",
    `<i>${fmt(t)}</i>`,
    "",
    "<b>Users</b>",
    `  Total: ${total}`,
    `  New today: ${newToday}`,
    `  New (7 days): ${new7}`,
    `  Active (24h): ${act24}`,
    `  Active (7 days): ${act7}`,
    `  Banned: ${banned}`,
    "",
    "<b>Live</b>",
    `  Active chats: ${Math.floor(chats / 2)}`,
    `  Waiting in queue: ${queue}`,
    "",
    "<b>Activity</b>",
    `  Chats started today: ${chatsToday}`,
    `  Chats started (all time): ${chatsAll}`,
    `  Reports today: ${repToday}`,
    "",
    "<b>Gender</b>",
    await distribution(env, "gender", total),
    "",
    "<b>Age group</b>",
    await distribution(env, "age", total),
    "",
    "<b>Language</b>",
    await distribution(env, "language", total),
  ].join("\n");
  return { text, kb: adminKb([[{ text: "Refresh", callback_data: "adm_dash" }, ...backRow]]) };
}

async function viewUsers(env) {
  const total = await count(env, "SELECT COUNT(*) FROM users");
  const banned = await count(env, "SELECT COUNT(*) FROM users WHERE banned = 1");
  const { results } = await env.DB.prepare("SELECT user_id, gender, age, created_at FROM users ORDER BY created_at DESC, user_id DESC LIMIT 8").all();
  const lines = results.map((r) => `  <code>${r.user_id}</code>  ${esc(r.gender || "-")}, ${esc(r.age || "-")}, ${fmt(r.created_at)}`);
  const text = [
    "<b>Users</b>",
    `Total: ${total}   Banned: ${banned}`,
    "",
    "Look up a user: /user &lt;id&gt;",
    "Ban: /ban &lt;id&gt; [reason]",
    "Unban: /unban &lt;id&gt;",
    "",
    "<b>Recent signups</b>",
    lines.length ? lines.join("\n") : "  no users yet",
  ].join("\n");
  const rows = results.map((r) => [{ text: `User ${r.user_id}`, callback_data: `adm_u_${r.user_id}` }]);
  rows.push([{ text: "Banned users", callback_data: "adm_banned" }]);
  rows.push(backRow);
  return { text, kb: adminKb(rows) };
}

async function viewBanned(env) {
  const { results } = await env.DB.prepare("SELECT user_id, ban_reason FROM users WHERE banned = 1 ORDER BY user_id DESC LIMIT 10").all();
  const text = ["<b>Banned users</b>", "", results.length ? results.map((r) => `  <code>${r.user_id}</code>  ${esc(r.ban_reason || "")}`).join("\n") : "  nobody is banned"].join("\n");
  const rows = results.map((r) => [{ text: `View ${r.user_id}`, callback_data: `adm_u_${r.user_id}` }]);
  rows.push([{ text: "Back", callback_data: "adm_users" }]);
  return { text, kb: adminKb(rows) };
}

async function viewUserCard(env, id) {
  const u = await env.DB.prepare("SELECT user_id, username, gender, age, language, created_at, last_seen, banned, ban_reason, ban_until, ban_count FROM users WHERE user_id = ?").bind(id).first();
  if (!u) return { text: `User <code>${id}</code> not found.`, kb: adminKb([[{ text: "Back", callback_data: "adm_users" }]]) };
  const partner = await getPartner(env, id);
  const queued = await inQueue(env, id);
  const reps = await env.DB.prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT reporter_id) AS d FROM reports WHERE reported_id = ?").bind(id).first();
  const saved = await count(env, "SELECT COUNT(*) FROM saved_partners WHERE user_id = ?", id);
  let status = "Idle";
  if (u.banned) status = `Banned${u.ban_reason ? " (" + esc(u.ban_reason) + ")" : ""}${u.ban_until ? " until " + fmt(u.ban_until) : ", permanent"}`;
  else if (partner) status = "In a chat";
  else if (queued) status = "Searching";
  const text = [
    `<b>User ${id}</b>`,
    `Username: ${u.username ? "@" + esc(u.username) : "none"}`,
    `Gender: ${esc(u.gender || "-")}`,
    `Age group: ${esc(u.age || "-")}`,
    `Language: ${esc(u.language || "-")}`,
    `Joined: ${fmt(u.created_at)}`,
    `Last seen: ${fmt(u.last_seen)}`,
    `Status: ${status}`,
    `Reports against: ${reps.c} (from ${reps.d} users)`,
    `Saved partners: ${saved}`,
    `Bans so far: ${u.ban_count || 0}`,
  ].join("\n");
  const action = u.banned ? { text: "Unban user", callback_data: `adm_unban_${id}` } : { text: "Ban user", callback_data: `adm_ban_${id}` };
  return { text, kb: adminKb([[action], [{ text: "Refresh", callback_data: `adm_u_${id}` }, { text: "Back", callback_data: "adm_users" }]]) };
}

async function viewReports(env) {
  const t = nowSec();
  const total = await count(env, "SELECT COUNT(*) FROM reports");
  const last24 = await count(env, "SELECT COUNT(*) FROM reports WHERE ts > ?", t - 86400);
  const byReason = (await env.DB.prepare("SELECT reason, COUNT(*) AS c FROM reports GROUP BY reason ORDER BY c DESC").all()).results;
  const top = (await env.DB.prepare("SELECT reported_id, COUNT(DISTINCT reporter_id) AS d FROM reports WHERE ts > ? GROUP BY reported_id ORDER BY d DESC LIMIT 5").bind(t - 7 * 86400).all()).results;
  const latest = (await env.DB.prepare("SELECT reporter_id, reported_id, reason, ts FROM reports ORDER BY id DESC LIMIT 8").all()).results;
  const text = [
    "<b>Reports</b>",
    `Total: ${total}   Last 24h: ${last24}`,
    "",
    "<b>By reason</b>",
    byReason.length ? byReason.map((r) => `  ${esc(r.reason)}: ${r.c}`).join("\n") : "  no reports yet",
    "",
    "<b>Most reported (7 days)</b>",
    top.length ? top.map((r) => `  <code>${r.reported_id}</code>: ${r.d} reporters`).join("\n") : "  none",
    "",
    "<b>Latest</b>",
    latest.length ? latest.map((r) => `  ${fmt(r.ts)}  <code>${r.reporter_id}</code> reported <code>${r.reported_id}</code>: ${esc(r.reason)}`).join("\n") : "  none",
  ].join("\n");
  const rows = top.slice(0, 3).map((r) => [{ text: `View ${r.reported_id}`, callback_data: `adm_u_${r.reported_id}` }]);
  rows.push([{ text: "Refresh", callback_data: "adm_reports" }, ...backRow]);
  return { text, kb: adminKb(rows) };
}

async function viewBroadcast(env) {
  const last = await env.DB.prepare("SELECT * FROM broadcasts WHERE status != 'draft' ORDER BY id DESC LIMIT 1").first();
  const chunk = cfg(env, "BROADCAST_CHUNK");
  const lines = [
    "<b>Broadcast</b>",
    "",
    "Send a message to all users:",
    "  /broadcast &lt;your message&gt;",
    "",
    "Or send any message (text, photo, video, sticker) and reply to it with /broadcast to forward that exact content to everyone.",
    "",
    "You will get a preview with a confirm button before anything is sent.",
    `Delivery speed: ${chunk} users per minute (change with BROADCAST_CHUNK).`,
  ];
  const rows = [];
  if (last) {
    lines.push("", `<b>Last broadcast #${last.id}</b>`, `Status: ${esc(last.status)}`, `Sent: ${last.sent} / ${last.total}   Failed: ${last.failed}`, `Started: ${fmt(last.created_at)}`);
    if (last.status === "running") rows.push([{ text: "Stop broadcast", callback_data: `adm_bcstop_${last.id}` }]);
  }
  rows.push([{ text: "Refresh", callback_data: "adm_bc" }, ...backRow]);
  return { text: lines.join("\n"), kb: adminKb(rows) };
}

async function viewSettings(env) {
  const s = await getSettings(env);
  const maint = s.maintenance === "1";
  const mediaOff = s.media_off === "1";
  const text = [
    "<b>Settings</b>",
    "",
    `Maintenance mode: <b>${maint ? "ON" : "OFF"}</b>`,
    "  When ON, only admins can use the bot.",
    `Media sharing: <b>${mediaOff ? "DISABLED" : "ENABLED"}</b>`,
    "  When disabled, only text can be sent in chats.",
    "",
    `Match gap: ${cfg(env, "GAP_MIN_SECONDS")} to ${cfg(env, "GAP_MAX_SECONDS")} seconds`,
    `Warning after: ${cfg(env, "WARN_AFTER_REPORTS")} different reporters`,
    `Auto-ban after: ${cfg(env, "AUTO_BAN_REPORTS")} different reporters`,
    "Ban ladder: 30 days, then 1 year, then permanent.",
    "",
    "Gap and auto-ban values are changed from Worker variables.",
  ].join("\n");
  return {
    text,
    kb: adminKb([
      [{ text: maint ? "Turn maintenance OFF" : "Turn maintenance ON", callback_data: "adm_tog_maint" }],
      [{ text: mediaOff ? "Enable media sharing" : "Disable media sharing", callback_data: "adm_tog_media" }],
      backRow,
    ]),
  };
}

async function sendView(env, chatId, view) {
  return send(env, chatId, view.text, { parse_mode: "HTML", reply_markup: view.kb });
}
async function editView(env, chatId, mid, view) {
  return editText(env, chatId, mid, view.text, { parse_mode: "HTML", reply_markup: view.kb });
}

// ---------------------------------------------------------------- Broadcast

async function createBroadcastDraft(env, msg, arg) {
  const reply = msg.reply_to_message;
  if (!reply && !arg) return null;
  const mode = reply ? "copy" : "text";
  const r = await env.DB.prepare(
    "INSERT INTO broadcasts (admin_id, mode, text, from_chat_id, from_message_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'draft', ?) RETURNING id"
  ).bind(msg.from.id, mode, reply ? null : arg, reply ? msg.chat.id : null, reply ? reply.message_id : null, nowSec()).first();
  return { id: r.id, mode };
}

async function onBroadcastCommand(env, msg, arg) {
  const chatId = msg.chat.id;
  const draft = await createBroadcastDraft(env, msg, arg);
  if (!draft) {
    return sendView(env, chatId, await viewBroadcast(env));
  }
  const total = await count(env, "SELECT COUNT(*) FROM users WHERE banned = 0");
  const head = `<b>Broadcast preview</b>\nThis will be sent to <b>${total}</b> users.`;
  if (draft.mode === "text") {
    await send(env, chatId, `${head}\n\n${esc(arg)}`, { parse_mode: "HTML" });
  } else {
    await send(env, chatId, `${head}\nThe message you replied to will be copied to every user.`, { parse_mode: "HTML" });
  }
  return send(env, chatId, "Send this broadcast now?", {
    reply_markup: { inline_keyboard: [[{ text: "Send now", callback_data: `bc_go_${draft.id}` }, { text: "Cancel", callback_data: `bc_cancel_${draft.id}` }]] },
  });
}

async function deliverBroadcast(env, job, userId) {
  const r =
    job.mode === "text"
      ? await tg(env, "sendMessage", { chat_id: userId, text: job.text })
      : await tg(env, "copyMessage", { chat_id: userId, from_chat_id: job.from_chat_id, message_id: job.from_message_id });
  return !!r.ok;
}

// Ek baar mein ek chunk bhejta hai. Cron har minute isse chalata hai.
async function processBroadcast(env) {
  const now = nowSec();
  const job = await env.DB.prepare(
    `UPDATE broadcasts SET lock_until = ?1 WHERE id = (
       SELECT id FROM broadcasts WHERE status = 'running' AND (lock_until IS NULL OR lock_until < ?2) ORDER BY id LIMIT 1
     ) RETURNING *`
  ).bind(now + 60, now).first();
  if (!job) return false;

  const chunk = cfg(env, "BROADCAST_CHUNK");
  const { results: users } = await env.DB.prepare("SELECT user_id FROM users WHERE banned = 0 AND user_id > ? ORDER BY user_id LIMIT ?").bind(job.cursor, chunk).all();

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < users.length; i += 10) {
    await Promise.all(
      users.slice(i, i + 10).map(async (u) => {
        (await deliverBroadcast(env, job, u.user_id)) ? sent++ : failed++;
      })
    );
  }
  const cursor = users.length ? users[users.length - 1].user_id : job.cursor;
  const done = users.length < chunk;
  await env.DB.prepare("UPDATE broadcasts SET sent = sent + ?, failed = failed + ?, cursor = ?, lock_until = NULL, status = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .bind(sent, failed, cursor, done ? "done" : "running", done ? nowSec() : null, job.id)
    .run();
  if (done) {
    const fin = await env.DB.prepare("SELECT sent, failed, total FROM broadcasts WHERE id = ?").bind(job.id).first();
    await send(env, job.admin_id, `<b>Broadcast #${job.id} finished</b>\nDelivered: ${fin.sent} / ${fin.total}\nFailed (blocked or deleted accounts): ${fin.failed}`, { parse_mode: "HTML" });
  }
  return true;
}

// ---------------------------------------------------------------- Gate (ban / maintenance)

// Banned user: sirf ban ka message aur appeal ka option dikhta hai
async function handleBanned(env, user, chatId, profile, input) {
  const min = cfg(env, "MIN_REPORT_TEXT");
  if (input.data === "appeal_start") {
    if (profile.appeal_state === 1) return send(env, chatId, "Your appeal is already with our team. Please wait for a reply.");
    if (profile.appeal_state === 2) return send(env, chatId, "Your appeal for this ban has already been reviewed.");
    await setState(env, user.id, "appeal", "");
    return send(env, chatId, `Please write your appeal in a few lines (at least ${min} characters). Tell us what happened.`);
  }
  const st = await getState(env, user.id);
  if (input.text && !input.text.startsWith("/") && st && st.kind === "appeal" && profile.appeal_state === 0) {
    const text = input.text.trim();
    if (text.length < min) {
      return send(env, chatId, `Please write a little more (at least ${min} characters, you wrote ${text.length}).`);
    }
    await env.DB.prepare("INSERT INTO appeals (user_id, text, ts, status) VALUES (?, ?, ?, 'open')").bind(user.id, text, nowSec()).run();
    await env.DB.prepare("UPDATE users SET appeal_state = 1 WHERE user_id = ?").bind(user.id).run();
    await clearState(env, user.id);
    for (const a of adminIds(env)) {
      await send(env, a, [
        "<b>Ban appeal</b>",
        `User: <code>${user.id}</code>`,
        `Ban: ${profile.ban_until ? "until " + fmt(profile.ban_until) : "permanent"} (ban no. ${profile.ban_count || 1})`,
        `Reason: ${esc(profile.ban_reason || "-")}`,
        "",
        esc(text),
      ].join("\n"), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "Unban", callback_data: `adm_apok_${user.id}` }, { text: "Reject", callback_data: `adm_apno_${user.id}` }], [{ text: "View user", callback_data: `adm_u_${user.id}` }]] },
      });
    }
    return send(env, chatId, "Your appeal has been sent. We will review it.");
  }
  return send(env, chatId, banNotice(profile.ban_until), profile.appeal_state === 0 ? { reply_markup: APPEAL_KB } : {});
}

// true agar user aage badh sakta hai
async function gate(env, user, chatId, profile, input = {}) {
  const admin = isAdmin(env, user.id);
  if (profile && profile.banned && !admin) {
    if (profile.ban_until && profile.ban_until <= nowSec()) {
      await liftBan(env, user.id, "Your ban has ended and you can use the bot again. Please follow the rules to avoid another ban.");
      profile.banned = 0;
    } else {
      await handleBanned(env, user, chatId, profile, input);
      return false;
    }
  }
  const s = await getSettings(env);
  if (s.maintenance === "1" && !admin) {
    await send(env, chatId, "The bot is under maintenance. Please try again in a little while.");
    return false;
  }
  if (profile) {
    const t = nowSec();
    if (!profile.last_seen || t - profile.last_seen > 300) {
      await env.DB.prepare("UPDATE users SET last_seen = ? WHERE user_id = ?").bind(t, user.id).run();
    }
  }
  return true;
}

// ---------------------------------------------------------------- Commands

const ADMIN_COMMANDS = ["admin", "stats", "user", "ban", "unban", "broadcast"];

async function onCommand(env, msg) {
  const chatId = msg.chat.id;
  const user = msg.from;
  const m = msg.text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || "").trim();

  if (ADMIN_COMMANDS.includes(cmd) && !isAdmin(env, user.id)) return; // admin ko hi dikhta hai

  if (cmd === "start") {
    const profile = await getProfile(env, user.id);
    if (isComplete(profile)) {
      await setField(env, user, "username", user.username ?? null);
      return send(env, chatId, "**Welcome back to Nexus Anonymous Chat!**\n\nUse the buttons below:", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
    }
    const keyboard = {
      inline_keyboard: [
        [{ text: "Male", callback_data: "gender_Male" }, { text: "Female", callback_data: "gender_Female" }],
        [{ text: "Other", callback_data: "gender_Other" }],
      ],
    };
    return send(env, chatId, "**Welcome to Nexus Anonymous Chat!**\n\nPlease select your **Gender**:", { reply_markup: keyboard, parse_mode: "Markdown" });
  }

  if (cmd === "search") return searchPartner(env, user.id, chatId);
  if (cmd === "stop") return stopChat(env, user.id, chatId);
  if (cmd === "cancel") {
    await clearState(env, user.id);
    return send(env, chatId, "Cancelled.", { reply_markup: MAIN_KEYBOARD });
  }
  if (cmd === "myid") return send(env, chatId, `Your Telegram ID: <code>${user.id}</code>`, { parse_mode: "HTML" });

  if (cmd === "help") {
    return send(env, chatId, [
      "**Commands**",
      "/start - set up your profile",
      "/search - find a partner",
      "/stop - end the chat or stop searching",
      "/report - report your current partner and end the chat",
      "/myid - show your Telegram ID",
      "",
      `Use the ${BTN_NEXT} button to skip to someone new.`,
    ].join("\n"), { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
  }

  if (cmd === "report") {
    const partnerId = await getPartner(env, user.id);
    if (!partnerId) return send(env, chatId, "You are not in an active chat.", { reply_markup: MAIN_KEYBOARD });
    await recordReport(env, user.id, partnerId, REASONS.rp);
    await send(env, chatId, "✅ Report received. Our team will look into it. Thank you.");
    return stopChat(env, user.id, chatId);
  }

  // ---- admin
  if (cmd === "admin") return sendView(env, chatId, await viewHome(env));
  if (cmd === "stats") return sendView(env, chatId, await viewDashboard(env));

  if (cmd === "user") {
    const id = Number(arg);
    if (!id) return send(env, chatId, "Usage: /user <id>");
    return sendView(env, chatId, await viewUserCard(env, id));
  }

  if (cmd === "ban") {
    const mm = arg.match(/^(\d+)\s*([\s\S]*)$/);
    if (!mm) return send(env, chatId, "Usage: /ban <id> [reason]");
    const id = Number(mm[1]);
    if (isAdmin(env, id)) return send(env, chatId, "You cannot ban an admin.");
    if (!(await getProfile(env, id))) return send(env, chatId, "User not found.");
    const res = await banUser(env, id, mm[2].trim() || "Banned by admin");
    return send(env, chatId, `User ${id} has been banned (${res.label}).`);
  }

  if (cmd === "unban") {
    const id = Number(arg);
    if (!id) return send(env, chatId, "Usage: /unban <id>");
    if (!(await getProfile(env, id))) return send(env, chatId, "User not found.");
    await unbanUser(env, id);
    return send(env, chatId, `User ${id} has been unbanned.`);
  }

  if (cmd === "broadcast") return onBroadcastCommand(env, msg, arg);
}

// ---------------------------------------------------------------- Messages

function detectMedia(msg) {
  if (msg.photo && msg.photo.length) return ["photo", msg.photo[msg.photo.length - 1].file_id];
  if (msg.video) return ["video", msg.video.file_id];
  if (msg.video_note) return ["video_note", msg.video_note.file_id];
  if (msg.animation) return ["animation", msg.animation.file_id]; // GIF, document se pehle check hota hai
  if (msg.sticker) return ["sticker", msg.sticker.file_id];
  if (msg.document) return ["document", msg.document.file_id];
  if (msg.voice) return ["voice", msg.voice.file_id];
  if (msg.audio) return ["audio", msg.audio.file_id];
  return null;
}

async function onMessage(env, msg) {
  if (!msg.from || !msg.chat) return;
  if (msg.chat.type && msg.chat.type !== "private") return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  const profile = await getProfile(env, userId);
  if (!(await gate(env, msg.from, chatId, profile, { text }))) return;

  if (text && text.startsWith("/")) return onCommand(env, msg);

  // Underage report likhne ka intezaar (text zaroori, screenshot optional)
  const st = await getState(env, userId);
  if (st && st.kind === "ua") {
    if (text && BUTTONS.includes(text)) await clearState(env, userId);
    else return handleUaReport(env, msg, st);
  }

  // Nickname ka intezaar
  if (profile && profile.waiting_nick && text && !BUTTONS.includes(text)) {
    const partnerId = profile.waiting_nick;
    const nickname = text.trim();
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO saved_partners (user_id, partner_id, nickname) VALUES (?, ?, ?)").bind(userId, partnerId, nickname),
      env.DB.prepare("INSERT OR IGNORE INTO saved_partners (user_id, partner_id, nickname) VALUES (?, ?, ?)").bind(partnerId, userId, "Anonymous Partner"),
      env.DB.prepare("UPDATE users SET waiting_nick = NULL WHERE user_id = ?").bind(userId),
    ]);
    await send(env, chatId, `**Partner saved successfully with nickname:** \`${nickname}\``, { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
    await send(env, partnerId, "**Your partner accepted your save request and saved you too.** Check your 'Saved Partners'.", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
    return;
  }

  if (text === BTN_NEXT) return nextPartner(env, userId, chatId);
  if (text === BTN_STOP) return stopChat(env, userId, chatId);

  if (text === BTN_SAVE) {
    const partnerId = await getPartner(env, userId);
    if (!partnerId) {
      return send(env, chatId, "You are not in an active chat to save a partner.", { reply_markup: MAIN_KEYBOARD });
    }
    const keyboard = {
      inline_keyboard: [[{ text: "Accept", callback_data: `accept_save_${userId}` }, { text: "Decline", callback_data: `decline_save_${userId}` }]],
    };
    await send(env, partnerId, "**Your chat partner wants to save you.** Do you want to accept?", { reply_markup: keyboard, parse_mode: "Markdown" });
    return send(env, chatId, "**Save request sent to your partner.** Waiting for response...", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
  }

  if (text === BTN_SAVED) {
    const { results } = await env.DB.prepare("SELECT partner_id, nickname FROM saved_partners WHERE user_id = ?").bind(userId).all();
    if (!results.length) {
      return send(env, chatId, "You don't have any saved partners yet.", { reply_markup: MAIN_KEYBOARD });
    }
    const rows = results.map((r) => [{ text: r.nickname || "Saved Partner", callback_data: `view_saved_${r.partner_id}` }]);
    return send(env, chatId, "**Your Saved Partners:**\nSelect one below:", { reply_markup: { inline_keyboard: rows }, parse_mode: "Markdown" });
  }

  // Normal chat message
  const partnerId = await getPartner(env, userId);
  if (!partnerId) {
    return send(env, chatId, `Type /search or press ${BTN_NEXT} to find someone first.`, { reply_markup: MAIN_KEYBOARD });
  }

  if (text) {
    await send(env, partnerId, text);
    return;
  }

  const media = detectMedia(msg);
  if (!media) {
    return send(env, chatId, "This type of message is not supported.", { reply_markup: MAIN_KEYBOARD });
  }
  const s = await getSettings(env);
  if (s.media_off === "1") {
    return send(env, chatId, "Media sharing is currently disabled. You can only send text.", { reply_markup: MAIN_KEYBOARD });
  }

  const [kind, fileId] = media;
  const cat = CAT_OF[kind];
  const name = CAT_NAME[cat];
  const state = await getConsent(env, userId, partnerId, cat);

  if (state === "accepted") {
    await sendMedia(env, partnerId, kind, fileId);
  } else if (state === "declined") {
    await send(env, chatId, `Your partner has not allowed ${CAT_PLURAL[cat]} in this chat.`, { reply_markup: MAIN_KEYBOARD });
  } else if (state === "pending") {
    const waiting = await count(env, "SELECT COUNT(*) FROM media_pending WHERE sender_id = ? AND receiver_id = ? AND cat = ?", userId, partnerId, cat);
    if (waiting >= cfg(env, "MAX_PENDING_MEDIA")) {
      return send(env, chatId, "Too many items are waiting for approval. Please wait for your partner's response.", { reply_markup: MAIN_KEYBOARD });
    }
    await env.DB.prepare("INSERT INTO media_pending (sender_id, receiver_id, cat, kind, file_id) VALUES (?, ?, ?, ?, ?)").bind(userId, partnerId, cat, kind, fileId).run();
    await send(env, chatId, `Still waiting for your partner's approval. Your ${name} will be sent once accepted.`, { reply_markup: MAIN_KEYBOARD });
  } else {
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO media_consent (sender_id, receiver_id, cat, state) VALUES (?, ?, ?, 'pending')").bind(userId, partnerId, cat),
      env.DB.prepare("DELETE FROM media_pending WHERE sender_id = ? AND receiver_id = ? AND cat = ?").bind(userId, partnerId, cat),
      env.DB.prepare("INSERT INTO media_pending (sender_id, receiver_id, cat, kind, file_id) VALUES (?, ?, ?, ?, ?)").bind(userId, partnerId, cat, kind, fileId),
    ]);
    const keyboard = {
      inline_keyboard: [[{ text: "Accept", callback_data: `m_acc_${cat}_${userId}` }, { text: "Decline", callback_data: `m_dec_${cat}_${userId}` }]],
    };
    await send(env, partnerId, `**Your partner wants to send you a ${name}.** Do you want to accept?\n\nIf you accept, further ${CAT_PLURAL[cat]} in this chat will be delivered without asking.`, { reply_markup: keyboard, parse_mode: "Markdown" });
    await send(env, chatId, `**Request sent to your partner.** Your ${name} will be delivered once they accept.`, { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
  }
}

// ---------------------------------------------------------------- Buttons (callbacks)

async function onCallback(env, cq) {
  const data = cq.data || "";
  const user = cq.from;
  const userId = user.id;
  const msg = cq.message;
  const chatId = msg ? msg.chat.id : userId;
  const mid = msg ? msg.message_id : undefined;
  const edit = (text, extra) => editText(env, chatId, mid, text, extra);
  const answer = (text, alert) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text, show_alert: !!alert } : {}) });

  const profile = await getProfile(env, userId);
  if (!(await gate(env, user, chatId, profile, { data }))) {
    return answer();
  }

  // ---- admin buttons
  if (data.startsWith("adm_") || data.startsWith("bc_")) {
    if (!isAdmin(env, userId)) return answer("Not authorised", true);
    await answer();
    const parts = data.split("_");
    const id = Number(parts[2]);

    if (data === "adm_close") return tg(env, "deleteMessage", { chat_id: chatId, message_id: mid });
    if (data === "adm_home") return editView(env, chatId, mid, await viewHome(env));
    if (data === "adm_dash") return editView(env, chatId, mid, await viewDashboard(env));
    if (data === "adm_users") return editView(env, chatId, mid, await viewUsers(env));
    if (data === "adm_banned") return editView(env, chatId, mid, await viewBanned(env));
    if (data === "adm_reports") return editView(env, chatId, mid, await viewReports(env));
    if (data === "adm_bc") return editView(env, chatId, mid, await viewBroadcast(env));
    if (data === "adm_set") return editView(env, chatId, mid, await viewSettings(env));

    if (data === "adm_tog_maint") {
      const s = await getSettings(env);
      await setSetting(env, "maintenance", s.maintenance === "1" ? "0" : "1");
      return editView(env, chatId, mid, await viewSettings(env));
    }
    if (data === "adm_tog_media") {
      const s = await getSettings(env);
      await setSetting(env, "media_off", s.media_off === "1" ? "0" : "1");
      return editView(env, chatId, mid, await viewSettings(env));
    }

    if (data.startsWith("adm_u_")) return editView(env, chatId, mid, await viewUserCard(env, id));
    if (data.startsWith("adm_ban_")) {
      if (isAdmin(env, id)) return answer("You cannot ban an admin", true);
      if (await getProfile(env, id)) await banUser(env, id, "Banned by admin");
      return editView(env, chatId, mid, await viewUserCard(env, id));
    }
    if (data.startsWith("adm_unban_")) {
      if (await getProfile(env, id)) await unbanUser(env, id);
      return editView(env, chatId, mid, await viewUserCard(env, id));
    }

    if (data.startsWith("adm_apok_")) {
      if (await getProfile(env, id)) await unbanUser(env, id);
      await env.DB.prepare("UPDATE appeals SET status = 'approved' WHERE user_id = ? AND status = 'open'").bind(id).run();
      return edit(`Appeal approved. User ${id} has been unbanned.`);
    }
    if (data.startsWith("adm_apno_")) {
      await env.DB.prepare("UPDATE users SET appeal_state = 2 WHERE user_id = ?").bind(id).run();
      await env.DB.prepare("UPDATE appeals SET status = 'rejected' WHERE user_id = ? AND status = 'open'").bind(id).run();
      await send(env, id, "Your appeal was reviewed. The ban stays in place.");
      return edit(`Appeal rejected for user ${id}.`);
    }
    if (data.startsWith("adm_dis_")) return edit(`Report dismissed for user ${id}.`);

    if (data.startsWith("adm_bcstop_")) {
      await env.DB.prepare("UPDATE broadcasts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'").bind(nowSec(), id).run();
      return editView(env, chatId, mid, await viewBroadcast(env));
    }

    if (data.startsWith("bc_go_")) {
      const total = await count(env, "SELECT COUNT(*) FROM users WHERE banned = 0");
      const started = await env.DB.prepare("UPDATE broadcasts SET status = 'running', total = ?, cursor = 0 WHERE id = ? AND status = 'draft' RETURNING id").bind(total, id).first();
      if (!started) return edit("This broadcast was already sent or cancelled.");
      await edit(`Broadcast #${id} started. Sending to ${total} users.\nProgress and the final report will be sent here. You can also check the Broadcast section in /admin.`);
      await processBroadcast(env); // pehla chunk abhi, baaki cron se
      return;
    }
    if (data.startsWith("bc_cancel_")) {
      await env.DB.prepare("UPDATE broadcasts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'draft'").bind(nowSec(), id).run();
      return edit("Broadcast cancelled.");
    }
    return;
  }

  await answer();

  // ---- profile setup
  if (data.startsWith("gender_")) {
    const gender = data.split("_")[1];
    await setField(env, user, "gender", gender);
    const keyboard = {
      inline_keyboard: [
        [{ text: "18-22", callback_data: "age_18-22" }, { text: "23-26", callback_data: "age_23-26" }],
        [{ text: "27+", callback_data: "age_27+" }],
      ],
    };
    return edit(`Selected Gender: **${gender}**\n\nNow, select your **Age Group**:`, { reply_markup: keyboard, parse_mode: "Markdown" });
  }

  if (data.startsWith("age_")) {
    const age = data.split("_")[1];
    await setField(env, user, "age", age);
    const keyboard = {
      inline_keyboard: [
        [{ text: "Hindi", callback_data: "lang_Hindi" }, { text: "English", callback_data: "lang_English" }],
        [{ text: "Hinglish", callback_data: "lang_Hinglish" }, { text: "Other", callback_data: "lang_Other" }],
      ],
    };
    return edit(`Selected Age: **${age}**\n\nFinally, select your **Language**:`, { reply_markup: keyboard, parse_mode: "Markdown" });
  }

  if (data.startsWith("lang_")) {
    const language = data.split("_")[1];
    await setField(env, user, "language", language);
    await edit("**Profile Setup Complete!**\n\nType `/search` or use the menu below to find a partner.", { parse_mode: "Markdown" });
    return send(env, userId, "Controls menu activated. Use the buttons below.", { reply_markup: MAIN_KEYBOARD });
  }

  // ---- search again (feedback wale message ke report buttons bache rehte hain)
  if (data === "action_search") {
    if (mid) {
      const kb = ((msg.reply_markup && msg.reply_markup.inline_keyboard) || []).filter((r) => !r.some((b) => b.callback_data === "action_search"));
      await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: kb } });
    }
    return searchPartner(env, userId, chatId);
  }

  // ---- report: pehle sirf ek "Report" button, dabane par reasons
  if (data === "rpt_skip") {
    const st = await getState(env, userId);
    let d = {};
    try { d = JSON.parse((st && st.data) || "{}"); } catch (e) {}
    if (!st || st.kind !== "ua" || d.stage !== "shot") return edit("This report is no longer active.");
    await edit("Sending your report...");
    return finishUaReport(env, userId, d, null);
  }

  if (data.startsWith("rpt_") || data.startsWith("rptb_")) {
    const pid = Number(data.split("_")[1]);
    if (!pid || !mid) return;
    const keep = ((msg.reply_markup && msg.reply_markup.inline_keyboard) || []).filter((r) => r.some((b) => b.callback_data === "action_search"));
    const rows = data.startsWith("rptb_")
      ? [[{ text: "⚠️ Report", callback_data: `rpt_${pid}` }]]
      : [
          [{ text: REASONS.ua, callback_data: `fb_ua_${pid}` }],
          [{ text: REASONS.vg, callback_data: `fb_vg_${pid}` }],
          [{ text: REASONS.sp, callback_data: `fb_sp_${pid}` }],
          [{ text: REASONS.rp, callback_data: `fb_rp_${pid}` }],
          [{ text: "Back", callback_data: `rptb_${pid}` }],
        ];
    return tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [...rows, ...keep] } });
  }

  // ---- report reason chosen
  if (data.startsWith("fb_")) {
    const [, code, pid] = data.split("_");
    const reported = Number(pid);
    const reason = REASONS[code];
    if (!reason || !reported || reported === userId) return;
    if (await hasRecentReport(env, userId, reported)) return edit("You have already reported this user today. Thank you.");
    if (code === "ua") {
      await setState(env, userId, "ua", JSON.stringify({ target: reported, stage: "text" }));
      return edit(`Underage report\nPlease describe what happened (at least ${cfg(env, "MIN_REPORT_TEXT")} characters).\nSend /cancel to stop.`);
    }
    const res = await recordReport(env, userId, reported, reason);
    if (res === "dup") return edit("You have already reported this user today. Thank you.");
    if (res === "self") return;
    return edit("✅ Report received. Our team will look into it. Thank you.");
  }

  // ---- media requests (photo / sticker / video / file, har ek ki alag request)
  if (data.startsWith("m_acc_") || data.startsWith("m_dec_")) {
    const [, action, cat, sid] = data.split("_");
    const senderId = Number(sid);
    if (!CAT_NAME[cat] || !senderId) return;
    const partnerOfMe = await getPartner(env, userId);
    const state = await getConsent(env, senderId, userId, cat);
    if (partnerOfMe !== senderId || state !== "pending") {
      return edit("This request is no longer valid.");
    }
    if (action === "acc") {
      await setConsent(env, senderId, userId, cat, "accepted");
      const { results } = await env.DB.prepare("SELECT kind, file_id FROM media_pending WHERE sender_id = ? AND receiver_id = ? AND cat = ? ORDER BY id").bind(senderId, userId, cat).all();
      await env.DB.prepare("DELETE FROM media_pending WHERE sender_id = ? AND receiver_id = ? AND cat = ?").bind(senderId, userId, cat).run();
      await edit(`**Accepted.** ${CAT_PLURAL[cat][0].toUpperCase() + CAT_PLURAL[cat].slice(1)} from your partner will now be delivered in this chat.`, { parse_mode: "Markdown" });
      for (const r of results) await sendMedia(env, userId, r.kind, r.file_id);
      return send(env, senderId, `**Your partner accepted your ${CAT_NAME[cat]} request.** You can now send ${CAT_PLURAL[cat]} freely in this chat.`, { parse_mode: "Markdown" });
    }
    await setConsent(env, senderId, userId, cat, "declined");
    await env.DB.prepare("DELETE FROM media_pending WHERE sender_id = ? AND receiver_id = ? AND cat = ?").bind(senderId, userId, cat).run();
    await edit("**You declined the request.**", { parse_mode: "Markdown" });
    return send(env, senderId, `**Your partner declined your ${CAT_NAME[cat]} request.**`, { parse_mode: "Markdown" });
  }

  // ---- save partner
  if (data.startsWith("accept_save_")) {
    const senderId = Number(data.split("_")[2]);
    await setField(env, user, "waiting_nick", senderId);
    return edit("**Accepted.** Now please send a **Nickname** (secret name) for this partner in chat:", { parse_mode: "Markdown" });
  }

  if (data.startsWith("decline_save_")) {
    const senderId = Number(data.split("_")[2]);
    await edit("**You declined the save request.**", { parse_mode: "Markdown" });
    return send(env, senderId, "**Your partner declined the save request.**", { parse_mode: "Markdown" });
  }

  if (data.startsWith("view_saved_")) {
    const pid = Number(data.split("_")[2]);
    const row = await env.DB.prepare("SELECT nickname FROM saved_partners WHERE user_id = ? AND partner_id = ?").bind(userId, pid).first();
    const nickname = row && row.nickname ? row.nickname : "Saved Partner";
    const keyboard = { inline_keyboard: [[{ text: "Remove from Saved", callback_data: `remove_saved_${pid}` }]] };
    return edit(`**Partner Details**\nNickname: \`${nickname}\`\n\nWhat would you like to do?`, { reply_markup: keyboard, parse_mode: "Markdown" });
  }

  if (data.startsWith("remove_saved_")) {
    const pid = Number(data.split("_")[2]);
    await env.DB.prepare("DELETE FROM saved_partners WHERE user_id = ? AND partner_id = ?").bind(userId, pid).run();
    return edit("**Partner removed from your saved list.**", { parse_mode: "Markdown" });
  }
}

// ---------------------------------------------------------------- Entry points

async function handleUpdate(env, update) {
  await ensureSchema(env);
  if (update.message) return onMessage(env, update.message);
  if (update.callback_query) return onCallback(env, update.callback_query);
}

async function runCron(env) {
  await ensureSchema(env);
  await processBroadcast(env);
  await expireBans(env);
  await runMatcher(env);
}

export default {
  async fetch(request, env0, ctx) {
    const env = env0;
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && env.BOT_TOKEN && url.pathname === `/webhook/${env.BOT_TOKEN}`) {
        const update = await request.json();
        // Telegram ko turant OK, kaam background mein
        ctx.waitUntil(handleUpdate(env, update).catch((e) => console.log("update error", (e && e.stack) || String(e))));
        return new Response("OK");
      }

      if (url.pathname === "/setup") {
        if (!env.BOT_TOKEN) return new Response("BOT_TOKEN secret nahi mila. Settings > Variables and Secrets mein add karo.", { status: 500 });
        if (!env.DB) return new Response("DB binding nahi mili. Settings > Bindings mein D1 database add karo, variable name DB.", { status: 500 });
        await ensureSchema(env);
        const webhookUrl = `${url.origin}/webhook/${env.BOT_TOKEN}`;
        const r = await tg(env, "setWebhook", { url: webhookUrl, allowed_updates: ["message", "callback_query"] });
        const admins = adminIds(env).length;
        return new Response(
          r.ok
            ? `Done! Webhook set ho gaya.\nAdmins configured: ${admins}${admins ? "" : " (ADMIN_IDS variable add karo, apna ID bot ke /myid se milega)"}\nAb Telegram mein bot ko /start bhejo.`
            : "Webhook set nahi hua: " + JSON.stringify(r),
          { status: r.ok ? 200 : 500 }
        );
      }

      return new Response(`Bot is running via Webhook!\nBOT_TOKEN: ${env.BOT_TOKEN ? "ok" : "MISSING"}\nDB: ${env.DB ? "ok" : "MISSING"}`);
    } catch (e) {
      console.log("fetch error", (e && e.stack) || String(e));
      return new Response("Error", { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env).catch((e) => console.log("cron error", (e && e.stack) || String(e))));
  },
};
