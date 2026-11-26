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
const MAX_SAVED = 10; // ek user ke max saved partners
const CODE_VERSION = "v13b-users-list"; // worker URL kholne par dikhta hai, isse pata chalta hai nayi file live hui ya nahi
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
const BTN_NEXT = "⏭ Next Partner";
const BTN_STOP = "⛔ Stop Chat";
const BTN_SAVE = "💾 Save Partner";
const BTN_SAVED = "📂 Saved Partners";
const BTN_PLAY = "🎮 Play Game";
const BTN_HIDE = "🔽 Hide Menu";
const BTN_SEARCH = "🔍 Find Partner";
const BTN_PROFILE = "👤 My Profile";
const BTN_FEEDBACK = "💬 Feedback";
const BTN_ID = "🆔 My ID";
const BTN_INVITE = "🤝 Invite Friends";
const BUTTONS = [BTN_NEXT, BTN_STOP, BTN_SAVE, BTN_SAVED, BTN_PLAY, BTN_HIDE, BTN_SEARCH, BTN_PROFILE, BTN_FEEDBACK, BTN_ID, BTN_INVITE];
// purane keyboard wale users abhi purane labels bhejenge, unhe naye button maano
const LEGACY_BTN = { "Next Partner": BTN_NEXT, "Stop Chat": BTN_STOP, "Save Partner": BTN_SAVE, "Saved Partners": BTN_SAVED };

// Teen keyboard: chat ke andar sirf kaam ke buttons, search me sirf Stop, chat ke bahar poora menu
const CHAT_KEYBOARD = { keyboard: [[{ text: BTN_NEXT }, { text: BTN_STOP }], [{ text: BTN_SAVE }, { text: BTN_PLAY }]], resize_keyboard: true };
const SEARCH_KEYBOARD = { keyboard: [[{ text: BTN_STOP }]], resize_keyboard: true };
const IDLE_KEYBOARD = { keyboard: [[{ text: BTN_SEARCH }, { text: BTN_SAVED }], [{ text: BTN_PROFILE }, { text: BTN_INVITE }], [{ text: BTN_FEEDBACK }]], resize_keyboard: true };
// Code me jahan MAIN_KEYBOARD likha hai, send() user ki halat dekhkar sahi keyboard khud chun leta hai
const MAIN_KEYBOARD = { keyboard: IDLE_KEYBOARD.keyboard, resize_keyboard: true };

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
  `CREATE TABLE IF NOT EXISTS ratings (rater_id INTEGER, rated_id INTEGER, v INTEGER, day TEXT, PRIMARY KEY (rater_id, rated_id, day))`,
  `CREATE TABLE IF NOT EXISTS blocks (user_id INTEGER, blocked_id INTEGER, PRIMARY KEY (user_id, blocked_id))`,
  `CREATE TABLE IF NOT EXISTS saved_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER, to_id INTEGER, kind TEXT, ts INTEGER, status TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sr_to ON saved_requests (to_id, status)`,
  `CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, text TEXT, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, admin_id INTEGER, text TEXT, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS referrals (invitee_id INTEGER PRIMARY KEY, inviter_id INTEGER, ts INTEGER, status TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_ref_inviter ON referrals (inviter_id, status)`,
  `CREATE TABLE IF NOT EXISTS user_sources (user_id INTEGER PRIMARY KEY, source TEXT, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, kind TEXT, text TEXT, ts INTEGER, status TEXT DEFAULT 'new')`,
  `CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT, p1 INTEGER, p2 INTEGER, board TEXT, xid INTEGER, turn INTEGER, status TEXT,
    m1 INTEGER, m2 INTEGER, last_act INTEGER, turn_ts INTEGER, miss1 INTEGER DEFAULT 0, miss2 INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS link_state (
    user_id INTEGER PRIMARY KEY, verified INTEGER DEFAULT 0, links_left INTEGER DEFAULT 0, tries INTEGER DEFAULT 0,
    sent INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0, pending TEXT, target TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, text TEXT, ts INTEGER, status TEXT
  )`,
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  // Is version ka schema pehle ban chuka hai to dobara kuch mat chalao (cold start tez rahe)
  try {
    const sv = await env.DB.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first();
    if (sv && sv.value === CODE_VERSION) {
      schemaReady = true;
      return;
    }
  } catch (e) {} // table pehli baar nahi hoti
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
    likes: "INTEGER DEFAULT 0", dislikes: "INTEGER DEFAULT 0", badge_penalty: "INTEGER DEFAULT 0", streak: "INTEGER DEFAULT 0",
    invite_code: "TEXT", ambassador: "INTEGER DEFAULT 0", chat_count: "INTEGER DEFAULT 0", last_active_day: "TEXT", restrict_until: "INTEGER DEFAULT 0", spam_chats: "INTEGER DEFAULT 0", spam_offenses: "INTEGER DEFAULT 0", menu_hidden: "INTEGER DEFAULT 0",
  });
  await addMissing("reports", { details: "TEXT", shot: "TEXT" });
  await addMissing("recent", { gap: "INTEGER DEFAULT 15" });
  await env.DB.batch([env.DB.prepare("DROP TABLE IF EXISTS consent"), env.DB.prepare("DROP TABLE IF EXISTS pending_media")]);
  await env.DB.prepare("UPDATE users SET menu_hidden = 0 WHERE menu_hidden = 1").run();
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)").bind(CODE_VERSION).run();
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
  if (extra.reply_markup === MAIN_KEYBOARD) {
    const kb = await pickKeyboard(env, chatId);
    if (kb) extra = { ...extra, reply_markup: kb };
    else {
      const { reply_markup, ...rest } = extra;
      extra = rest;
    }
  }
  let r = await tg(env, "sendMessage", { chat_id: chatId, text, ...extra });
  if (!r.ok && extra.parse_mode && /parse entities/i.test(r.description || "")) {
    const { parse_mode, ...rest } = extra;
    r = await tg(env, "sendMessage", { chat_id: chatId, text, ...rest });
  }
  if (!r.ok) console.log("sendMessage failed", chatId, r.description);
  return r;
}

// User ki halat ke hisaab se keyboard: chat me / search me / khaali. Menu hide kiya ho to null.
async function pickKeyboard(env, uid, ignoreHidden) {
  const r = await env.DB.prepare(
    "SELECT (SELECT menu_hidden FROM users WHERE user_id = ?1) AS h, EXISTS(SELECT 1 FROM chats WHERE user_id = ?1) AS c, EXISTS(SELECT 1 FROM queue WHERE user_id = ?1) AS q"
  ).bind(uid).first();
  if (r && r.c) return CHAT_KEYBOARD;
  if (r && r.q) return SEARCH_KEYBOARD;
  return IDLE_KEYBOARD;
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
    "SELECT gender, age, language, waiting_nick, banned, ban_reason, ban_until, ban_count, appeal_state, report_floor, last_seen, likes, dislikes, badge_penalty, streak, last_active_day, restrict_until, spam_chats, spam_offenses, menu_hidden, ambassador, (SELECT partner_id FROM chats WHERE user_id = ?1) AS chat_partner, EXISTS(SELECT 1 FROM queue WHERE user_id = ?1) AS in_queue, (SELECT id FROM saved_requests WHERE to_id = ?1 AND kind = 'connect' AND status = 'shown' AND ts > ?2 ORDER BY id LIMIT 1) AS pending_req FROM users WHERE user_id = ?1"
  ).bind(id, nowSec() - 86400).first();
}

// Profile se hi sahi keyboard (extra DB call nahi). Menu hide hai to undefined.
const kbOf = (p) => (p && p.chat_partner ? CHAT_KEYBOARD : p && p.in_queue ? SEARCH_KEYBOARD : IDLE_KEYBOARD);

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
  await Promise.all([finalizeLinks(env, a), finalizeLinks(env, b)]);
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
    env.DB.prepare("UPDATE games SET status = 'done' WHERE status IN ('invite', 'active') AND ((p1 = ? AND p2 = ?) OR (p1 = ? AND p2 = ?))").bind(a, b, b, a),
    env.DB.prepare("DELETE FROM link_state WHERE user_id IN (?, ?)").bind(a, b),
  ]);
}

// ---------------------------------------------------------------- Badges, notices, saved partners

const BADGES = ["🌱 Newcomer", "😊 Friendly", "⭐ Trusted"];
function badgeLevel(u) {
  const likes = (u && u.likes) || 0;
  const lvl = likes >= 20 ? 2 : likes >= 5 ? 1 : 0;
  return Math.max(0, lvl - ((u && u.badge_penalty) || 0));
}
const badgeText = (u) => BADGES[badgeLevel(u)] + (u && u.streak >= 7 ? " 🔥 Streak" : "") + (u && u.ambassador ? " 🤝 Ambassador" : "");

// User kisi aur chat mein hai to message rok lo, chat khatam hone par milega
async function notify(env, userId, text, exceptPartner) {
  const partner = await getPartner(env, userId);
  if (partner && partner !== exceptPartner) {
    await env.DB.prepare("INSERT INTO notices (user_id, text, ts) VALUES (?, ?, ?)").bind(userId, text, nowSec()).run();
    return;
  }
  return send(env, userId, text, { reply_markup: MAIN_KEYBOARD });
}

const reqKb = (prefix, id) => ({ inline_keyboard: [[{ text: "✅ Accept", callback_data: `${prefix}_acc_${id}` }, { text: "❌ Decline", callback_data: `${prefix}_dec_${id}` }]] });

async function savedCount(env, id) {
  return count(env, "SELECT COUNT(*) FROM saved_partners WHERE user_id = ?", id);
}
async function isSaved(env, id, pid) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM saved_partners WHERE user_id = ? AND partner_id = ?").bind(id, pid).first());
}
async function isBlocked(env, by, who) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM blocks WHERE user_id = ? AND blocked_id = ?").bind(by, who).first());
}
async function requestedToday(env, from, to) {
  return (await count(env, "SELECT COUNT(*) FROM saved_requests WHERE from_id = ? AND to_id = ? AND ts > ?", from, to, nowSec() - 86400)) > 0;
}
async function defaultName(env, id) {
  const names = new Set((await env.DB.prepare("SELECT nickname FROM saved_partners WHERE user_id = ?").bind(id).all()).results.map((r) => r.nickname));
  let k = names.size + 1;
  while (names.has(`Partner ${k}`)) k++;
  return `Partner ${k}`;
}

// Chat khatam hone ke baad: ruke hue updates aur connect requests dikhao
async function deliverPending(env, userId) {
  const t = nowSec();
  const notes = (await env.DB.prepare("SELECT text FROM notices WHERE user_id = ? ORDER BY id LIMIT 10").bind(userId).all()).results;
  const reqs = (await env.DB.prepare("SELECT id FROM saved_requests WHERE to_id = ? AND kind = 'connect' AND status = 'pending' AND ts > ? ORDER BY id LIMIT 5").bind(userId, t - 86400).all()).results;
  const total = notes.length + reqs.length;
  if (!total) return;
  if (total > 1) await send(env, userId, `📬 You have ${total} pending updates.`);
  if (notes.length) {
    await env.DB.prepare("DELETE FROM notices WHERE user_id = ?").bind(userId).run();
    await send(env, userId, notes.map((n) => n.text).join("\n\n"), { reply_markup: MAIN_KEYBOARD });
  }
  for (const r of reqs) {
    await env.DB.prepare("UPDATE saved_requests SET status = 'shown' WHERE id = ?").bind(r.id).run();
    await send(env, userId, "🔗 Your saved partner wants to chat with you. Accept?", { reply_markup: reqKb("cn", r.id) });
  }
}

// Connect request ka jawab diye bina aage nahi badh sakte
async function blockedByPending(env, userId, chatId) {
  const r = await env.DB.prepare("SELECT id FROM saved_requests WHERE to_id = ? AND kind = 'connect' AND status = 'shown' AND ts > ? ORDER BY id LIMIT 1").bind(userId, nowSec() - 86400).first();
  if (!r) return false;
  await send(env, chatId, "🔗 Please accept or decline this request first.", { reply_markup: reqKb("cn", r.id) });
  return true;
}

async function sweepRequests(env) {
  const t = nowSec();
  await env.DB.prepare("UPDATE saved_requests SET status = 'expired' WHERE status IN ('pending', 'shown') AND ts < ?").bind(t - 86400).run();
  await env.DB.prepare("DELETE FROM notices WHERE ts < ?").bind(t - 3 * 86400).run();
}

async function onSavePressed(env, userId, chatId) {
  const partnerId = await getPartner(env, userId);
  const kb = { reply_markup: MAIN_KEYBOARD };
  if (!partnerId) return send(env, chatId, "You are not in an active chat to save a partner.", kb);
  if (await isSaved(env, userId, partnerId)) return send(env, chatId, "This partner is already in your saved list.", kb);
  if ((await savedCount(env, userId)) >= MAX_SAVED) return send(env, chatId, `Your saved list is full (${MAX_SAVED}). Remove someone first.`, kb);
  if ((await isBlocked(env, partnerId, userId)) || (await savedCount(env, partnerId)) >= MAX_SAVED) {
    return send(env, chatId, "The save request could not be sent.", kb);
  }
  if (await requestedToday(env, userId, partnerId)) return send(env, chatId, "You already sent a request to this partner today.", kb);
  const r = await env.DB.prepare("INSERT INTO saved_requests (from_id, to_id, kind, ts, status) VALUES (?, ?, 'save', ?, 'shown') RETURNING id").bind(userId, partnerId, nowSec()).first();
  await send(env, partnerId, "💾 Your chat partner wants to save you. Accept?", { reply_markup: reqKb("sv", r.id) });
  return send(env, chatId, "💾 Save request sent. Waiting for your partner's reply...", kb);
}

async function showSaved(env, userId, chatId) {
  const { results } = await env.DB.prepare("SELECT partner_id, nickname FROM saved_partners WHERE user_id = ?").bind(userId).all();
  if (!results.length) return send(env, chatId, "You don't have any saved partners yet.", { reply_markup: MAIN_KEYBOARD });
  const rows = results.map((r) => [{ text: r.nickname || "Saved Partner", callback_data: `view_saved_${r.partner_id}` }]);
  return send(env, chatId, `📂 **Your Saved Partners** (${results.length}/${MAX_SAVED})\nSelect one below:`, { reply_markup: { inline_keyboard: rows }, parse_mode: "Markdown" });
}

// ---------------------------------------------------------------- Likes / dislikes

async function applyRating(env, ratedId, v) {
  const before = await env.DB.prepare("SELECT likes, badge_penalty FROM users WHERE user_id = ?").bind(ratedId).first();
  const likes = await count(env, "SELECT COUNT(DISTINCT rater_id) FROM ratings WHERE rated_id = ? AND v = 1", ratedId);
  const dislikes = await count(env, "SELECT COUNT(DISTINCT rater_id) FROM ratings WHERE rated_id = ? AND v = -1", ratedId);
  let pen = (before && before.badge_penalty) || 0;
  if (v === 1 && pen > 0 && likes % 5 === 0) pen -= 1; // achhe behaviour se badge wapas
  await env.DB.prepare("UPDATE users SET likes = ?, dislikes = ?, badge_penalty = ? WHERE user_id = ?").bind(likes, dislikes, pen, ratedId).run();
  if (v === 1) {
    const old = (before && before.likes) || 0;
    if (old < 5 && likes >= 5) await notify(env, ratedId, "😊 You earned the Friendly badge! People liked chatting with you.");
    else if (old < 20 && likes >= 20) await notify(env, ratedId, "⭐ You earned the Trusted badge! Thank you for keeping the community great.");
  }
}

// ---------------------------------------------------------------- Link verification and spam

const LINK_EMOJI = ["🚗", "🐶", "🍎", "⚽", "🌙", "🎵", "🚀", "🏠"];

function hasLink(msg) {
  const ents = msg.entities || [];
  if (ents.some((e) => ["url", "text_link", "mention", "text_mention"].includes(e.type))) return true;
  return /(https?:\/\/|www\.|t\.me\/|\b[a-z0-9-]{2,}\.(com|net|org|io|me|in|xyz|co|app|link|ly|gg)\b|@[a-z0-9_]{4,})/i.test(msg.text || "");
}

async function sendChallenge(env, userId, chatId, text) {
  const target = LINK_EMOJI[Math.floor(Math.random() * LINK_EMOJI.length)];
  const decoys = LINK_EMOJI.filter((e) => e !== target).sort(() => Math.random() - 0.5).slice(0, 3);
  const opts = [target, ...decoys].sort(() => Math.random() - 0.5);
  await env.DB.prepare("UPDATE link_state SET pending = ?, target = ? WHERE user_id = ?").bind(text, target, userId).run();
  return send(env, chatId, `🔒 Quick check before sending a link.\nTap the ${target}`, {
    reply_markup: { inline_keyboard: [opts.map((e) => ({ text: e, callback_data: `lv_${LINK_EMOJI.indexOf(e)}` }))] },
  });
}

async function handleLinkMessage(env, userId, chatId, partnerId, text) {
  await env.DB.prepare("INSERT OR IGNORE INTO link_state (user_id) VALUES (?)").bind(userId).run();
  const ls = await env.DB.prepare("SELECT * FROM link_state WHERE user_id = ?").bind(userId).first();
  if (ls.flagged) return send(env, chatId, "🚫 Links are blocked for you in this chat.", { reply_markup: MAIN_KEYBOARD });
  if (ls.verified && ls.links_left > 0) {
    await send(env, partnerId, text);
    const left = ls.links_left - 1;
    const sent = ls.sent + 1;
    await env.DB.prepare("UPDATE link_state SET links_left = ?, verified = ?, sent = ?, flagged = ? WHERE user_id = ?").bind(left, left > 0 ? 1 : 0, sent, sent >= 6 ? 1 : 0, userId).run();
    return;
  }
  return sendChallenge(env, userId, chatId, text);
}

// Chat khatam: link spam wali chat ginti mein aati hai, saaf chat se ginti reset
async function finalizeLinks(env, id) {
  const ls = await env.DB.prepare("SELECT flagged FROM link_state WHERE user_id = ?").bind(id).first();
  if (!ls || !ls.flagged) {
    await env.DB.prepare("UPDATE users SET spam_chats = 0 WHERE user_id = ? AND spam_chats > 0").bind(id).run();
    return;
  }
  const u = await env.DB.prepare("SELECT spam_chats FROM users WHERE user_id = ?").bind(id).first();
  const n = ((u && u.spam_chats) || 0) + 1;
  if (n >= 7 + (id % 4)) return applySpamPenalty(env, id); // 7 se 10 chats lagatar
  await env.DB.prepare("UPDATE users SET spam_chats = ? WHERE user_id = ?").bind(n, id).run();
}

// 1st = 24h, 2nd = 24h, 3rd = 5-10 din, 4th+ = 1-3 mahine (bot random chunta hai). Permanent nahi.
async function applySpamPenalty(env, id) {
  const u = await env.DB.prepare("SELECT spam_offenses FROM users WHERE user_id = ?").bind(id).first();
  const n = ((u && u.spam_offenses) || 0) + 1;
  const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const secs = n <= 2 ? 86400 : n === 3 ? rnd(5, 10) * 86400 : rnd(30, 90) * 86400;
  await env.DB.prepare("UPDATE users SET restrict_until = ?, spam_offenses = ?, spam_chats = 0 WHERE user_id = ?").bind(nowSec() + secs, n, id).run();
  await env.DB.prepare("DELETE FROM queue WHERE user_id = ?").bind(id).run();
  await send(env, id, `🚫 You have been restricted for link spam.\nTime left: ${timeLeft(secs)}\nPlease follow the rules.`);
}

async function expireRestrictions(env) {
  const { results } = await env.DB.prepare("SELECT user_id FROM users WHERE restrict_until > 0 AND restrict_until <= ? LIMIT 20").bind(nowSec()).all();
  for (const r of results) {
    await env.DB.prepare("UPDATE users SET restrict_until = 0 WHERE user_id = ?").bind(r.user_id).run();
    await send(env, r.user_id, "✅ Your restriction has ended. Please follow the rules to avoid another one.");
  }
}

// ---------------------------------------------------------------- Tic-Tac-Toe

const WIN_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const SYM = { X: "❌", O: "⭕", "-": "⬜" };
const TURN_SECONDS = 30;

function winnerOf(b) {
  for (const [x, y, z] of WIN_LINES) if (b[x] !== "-" && b[x] === b[y] && b[x] === b[z]) return b[x];
  return null;
}
const getGame = (env, id) => env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(id).first();

function boardKb(g, forUser) {
  const mine = g.status === "active" && g.turn === forUser;
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      row.push({ text: SYM[g.board[i]], callback_data: g.board[i] === "-" && mine ? `g_mv_${g.id}_${i}` : `g_wait_${g.id}` });
    }
    rows.push(row);
  }
  if (g.status === "done") rows.push([{ text: "🔁 Rematch", callback_data: `g_re_${g.id}` }]);
  return { inline_keyboard: rows };
}
// Telegram buttons message ki chaudai ke barabar failte hain. Chhota text = chhota board.
// Is liye text ke neeche ek khaali (invisible) lambi line jodte hain taaki board bada dikhe. Chhota/bada karna ho to 34 badlo.
const GAME_PAD = "\u2800".repeat(34);
function gameText(g, forUser, note) {
  if (g.status === "done") return `🎮 Tic-Tac-Toe\n${note || "Game over."}\n${GAME_PAD}`;
  const you = g.xid === forUser ? "❌" : "⭕";
  return `🎮 Tic-Tac-Toe\nYou are ${you}\n${g.turn === forUser ? `Your turn (${TURN_SECONDS}s)` : "Partner's turn"}\n${GAME_PAD}`;
}
async function renderGame(env, g, notes) {
  for (const [uid, mid] of [[g.p1, g.m1], [g.p2, g.m2]]) {
    if (mid) await editText(env, uid, mid, gameText(g, uid, notes && notes[uid]), { reply_markup: boardKb(g, uid) });
  }
}

async function createInvite(env, a, b) {
  const t = nowSec();
  const r = await env.DB.prepare("INSERT INTO games (p1, p2, board, xid, turn, status, last_act, turn_ts) VALUES (?, ?, '---------', ?, ?, 'invite', ?, ?) RETURNING id").bind(a, b, a, a, t, t).first();
  return r.id;
}

async function hideMenu(env, userId, chatId) {
  // Menu chhupana Telegram ka apna keyboard icon karta hai, bot kuch hide nahi karta
  return send(env, chatId, "ℹ️ To hide or show the menu, tap the keyboard icon next to the message box. The menu stays there and opens again anytime.");
}
async function showMenu(env, userId, chatId) {
  return send(env, chatId, "✅ Menu refreshed.", { reply_markup: await pickKeyboard(env, userId, true) });
}

async function handlePlay(env, userId, chatId) {
  const kb = { reply_markup: MAIN_KEYBOARD };
  const partnerId = await getPartner(env, userId);
  if (!partnerId) return send(env, chatId, "You are not in an active chat. Start a chat first, then tap Play Game.", kb);
  const existing = await env.DB.prepare("SELECT id FROM games WHERE status IN ('invite', 'active') AND ((p1 = ?1 AND p2 = ?2) OR (p1 = ?2 AND p2 = ?1)) LIMIT 1").bind(userId, partnerId).first();
  if (existing) return send(env, chatId, "A game is already running or waiting for a reply.", kb);
  const id = await createInvite(env, userId, partnerId);
  await send(env, partnerId, "🎮 Your partner wants to play Tic-Tac-Toe. Accept?", { reply_markup: reqKb("g", id) });
  return send(env, chatId, "🎮 Game invite sent. Waiting for your partner...", kb);
}

function scheduleTurnTimer(env, id, stamp) {
  if (!env.__wait || env.NO_TIMERS) return;
  env.__wait((async () => { await sleep(env, 28000); await expireTurn(env, id, stamp); })());
}

async function launchGame(env, id) {
  const g = await getGame(env, id);
  const first = Math.random() < 0.5 ? g.p1 : g.p2; // pehli chal random
  const t = nowSec();
  await env.DB.prepare("UPDATE games SET status = 'active', xid = ?, turn = ?, last_act = ?, turn_ts = ?, miss1 = 0, miss2 = 0 WHERE id = ?").bind(first, first, t, t, id).run();
  Object.assign(g, { status: "active", xid: first, turn: first, last_act: t, turn_ts: t, miss1: 0, miss2: 0 });
  const r1 = await send(env, g.p1, gameText(g, g.p1), { reply_markup: boardKb(g, g.p1) });
  const r2 = await send(env, g.p2, gameText(g, g.p2), { reply_markup: boardKb(g, g.p2) });
  g.m1 = (r1.result && r1.result.message_id) || null;
  g.m2 = (r2.result && r2.result.message_id) || null;
  await env.DB.prepare("UPDATE games SET m1 = ?, m2 = ? WHERE id = ?").bind(g.m1, g.m2, id).run();
  scheduleTurnTimer(env, id, t);
}

async function finishGame(env, g, winSym, reason) {
  g.status = "done";
  await env.DB.prepare("UPDATE games SET status = 'done', board = ? WHERE id = ?").bind(g.board, g.id).run();
  const notes = {};
  for (const uid of [g.p1, g.p2]) {
    if (reason === "inactive") notes[uid] = "⌛ Game ended (no response).";
    else if (!winSym) notes[uid] = "🤝 It's a draw!";
    else notes[uid] = (uid === g.xid) === (winSym === "X") ? "🏆 You won!" : "😔 Your partner won.";
  }
  await renderGame(env, g, notes);
}

// 30 second mein chal nahi chali: turn samne wale ko. Ek khiladi 3 baar chuka ya 60 second kuch nahi hua to game band.
async function passTurn(env, g) {
  const now = nowSec();
  const col = g.turn === g.p1 ? "miss1" : "miss2";
  const misses = (g[col] || 0) + 1;
  if (misses >= 3 || now - g.last_act >= 55) return finishGame(env, g, null, "inactive");
  const other = g.turn === g.p1 ? g.p2 : g.p1;
  await env.DB.prepare(`UPDATE games SET turn = ?, turn_ts = ?, ${col} = ? WHERE id = ?`).bind(other, now, misses, g.id).run();
  g.turn = other; g.turn_ts = now; g[col] = misses;
  await renderGame(env, g);
  scheduleTurnTimer(env, g.id, now);
}
async function expireTurn(env, id, stamp) {
  const g = await getGame(env, id);
  if (!g || g.status !== "active" || g.turn_ts !== stamp) return;
  return passTurn(env, g);
}
async function sweepGames(env) {
  const t = nowSec();
  await env.DB.prepare("UPDATE games SET status = 'done' WHERE status = 'invite' AND last_act < ?").bind(t - 600).run();
  const { results } = await env.DB.prepare("SELECT * FROM games WHERE status = 'active' AND last_act < ? LIMIT 5").bind(t - 90).all();
  for (const g of results) await finishGame(env, g, null, "inactive");
}

async function onGameCallback(env, cq, userId, chatId, mid, edit, answer, data) {
  const parts = data.split("_");
  const kind = parts[1];
  let g = await getGame(env, Number(parts[2]));
  if (!g || (g.p1 !== userId && g.p2 !== userId)) return answer("This game is not available.");

  if (kind === "acc" || kind === "dec") {
    if (g.status !== "invite" || g.p2 !== userId) return answer("This invite is no longer valid.");
    if (kind === "dec") {
      await env.DB.prepare("UPDATE games SET status = 'done' WHERE id = ?").bind(g.id).run();
      await answer();
      await edit("You declined the game.");
      return send(env, g.p1, "🎮 Your partner declined the game.");
    }
    if ((await getPartner(env, userId)) !== g.p1) {
      await env.DB.prepare("UPDATE games SET status = 'done' WHERE id = ?").bind(g.id).run();
      return answer("The chat has ended.");
    }
    await answer();
    await edit("🎮 Game accepted. Good luck!");
    return launchGame(env, g.id);
  }

  if (g.status === "active" && nowSec() - g.turn_ts >= TURN_SECONDS && (kind === "wait" || kind === "mv")) {
    await passTurn(env, g);
    g = await getGame(env, g.id);
  }

  if (kind === "wait") return answer(g.status === "done" ? "Game over." : "Wait for your turn.");

  if (kind === "mv") {
    if (g.status !== "active") return answer("This game has ended.");
    if (g.turn !== userId) return answer("It is not your turn.");
    const i = Number(parts[3]);
    if (!(i >= 0 && i <= 8) || g.board[i] !== "-") return answer("That square is taken.");
    const sym = g.xid === userId ? "X" : "O";
    g.board = g.board.slice(0, i) + sym + g.board.slice(i + 1);
    const w = winnerOf(g.board);
    const now = nowSec();
    await answer();
    if (w || !g.board.includes("-")) return finishGame(env, g, w, "end");
    const other = g.p1 === userId ? g.p2 : g.p1;
    const col = g.p1 === userId ? "miss1" : "miss2";
    await env.DB.prepare(`UPDATE games SET board = ?, turn = ?, turn_ts = ?, last_act = ?, ${col} = 0 WHERE id = ?`).bind(g.board, other, now, now, g.id).run();
    Object.assign(g, { turn: other, turn_ts: now, last_act: now, [col]: 0 });
    await renderGame(env, g);
    return scheduleTurnTimer(env, g.id, now);
  }

  if (kind === "re") {
    if (g.status !== "done") return answer();
    const other = g.p1 === userId ? g.p2 : g.p1;
    if ((await getPartner(env, userId)) !== other) return answer("The chat has ended.");
    const existing = await env.DB.prepare("SELECT id FROM games WHERE status IN ('invite', 'active') AND ((p1 = ?1 AND p2 = ?2) OR (p1 = ?2 AND p2 = ?1)) LIMIT 1").bind(userId, other).first();
    if (existing) return answer("A rematch is already pending.");
    await answer("Rematch request sent.");
    const id = await createInvite(env, userId, other);
    return send(env, other, "🎮 Your partner wants a rematch. Accept?", { reply_markup: reqKb("g", id) });
  }
  return answer();
}

// ---------------------------------------------------------------- Matching

// userId queue mein hona chahiye. Sirf apne se PEHLE se wait kar rahe user ko uthata hai
// (isse do log ek doosre ko ek saath uthane ki koshish mein atakte nahi), phir khud ko queue se hatata hai.
async function claimPair(env, userId, strict = false) {
  const now = nowSec();
  const partner = await env.DB.prepare(
    `DELETE FROM queue WHERE user_id = (
       SELECT q.user_id FROM queue q JOIN users u ON u.user_id = q.user_id, (SELECT ts AS mts FROM queue WHERE user_id = ?1) m
       WHERE q.user_id != ?1
         AND (q.ts < m.mts OR (q.ts = m.mts AND q.user_id < ?1))
         AND q.user_id NOT IN (SELECT partner_id FROM recent WHERE user_id = ?1 AND ts + gap > ?2)
         AND q.user_id NOT IN (SELECT user_id FROM recent WHERE partner_id = ?1 AND ts + gap > ?2)
         AND q.user_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?1)
         AND q.user_id NOT IN (SELECT user_id FROM blocks WHERE blocked_id = ?1)
         AND (?3 = 0 OR u.language IS NULL OR u.language = 'Any' OR (SELECT language FROM users WHERE user_id = ?1) IN ('Any', u.language))
       ORDER BY q.ts - (CASE WHEN COALESCE(u.likes, 0) >= 20 THEN 20 WHEN COALESCE(u.likes, 0) >= 5 THEN 10 ELSE 0 END) + MIN(COALESCE(u.dislikes, 0), 20), q.user_id LIMIT 1
     ) RETURNING user_id, ts`
  ).bind(userId, now, strict ? 1 : 0).first();
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
    env.DB.prepare("DELETE FROM link_state WHERE user_id IN (?, ?)").bind(a, b),
    env.DB.prepare("UPDATE users SET chat_count = COALESCE(chat_count, 0) + 1 WHERE user_id IN (?, ?)").bind(a, b),
    env.DB.prepare("INSERT INTO daily_stats (day, chats) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET chats = chats + 1").bind(dayKey(now)),
  ]);
  return b;
}

async function announceMatch(env, a, b, title) {
  const [pa, pb] = await Promise.all([getProfile(env, a), getProfile(env, b)]);
  const head = title || "**Connected with a stranger.** Say hello! 👋";
  const msgFor = (me, other) => {
    const hello = me && badgeLevel(me) >= 1 ? `⭐ Welcome back, ${BADGES[badgeLevel(me)]} user!\n` : "";
    return `${hello}${head}\nPartner badge: ${badgeText(other)}\nUse the buttons below to control the chat.`;
  };
  const chatKb = (pid) => ({ inline_keyboard: [[{ text: "⏭ Next", callback_data: `act_next_${pid}` }, { text: "⛔ Stop", callback_data: `act_stop_${pid}` }]] });
  const kbFor = () => MAIN_KEYBOARD; // chat wala keyboard (Next / Stop / Save / Play)
  await Promise.all([
    send(env, a, msgFor(pa, pb), { reply_markup: kbFor(pa, b), parse_mode: "Markdown" }),
    send(env, b, msgFor(pb, pa), { reply_markup: kbFor(pb, a), parse_mode: "Markdown" }),
  ]);
  try { await creditReferrals(env, a, b); } catch (e) { console.log("referral error", String(e)); }
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

async function searchPartner(env, userId, chatId, pre) {
  const reply = (text, extra) => send(env, chatId, text, extra);
  const profile = pre || (await getProfile(env, userId));
  if (!isComplete(profile)) {
    return reply("Please complete your profile first by typing /start");
  }
  if (profile.pending_req) {
    return reply("🔗 Please accept or decline this request first.", { reply_markup: reqKb("cn", profile.pending_req) });
  }
  if (profile.chat_partner) {
    return reply(`You are already in a chat. Use /stop or ${BTN_NEXT}.`);
  }
  if (profile.in_queue) {
    return reply("Already searching...");
  }

  // Queue me daalna aur "Searching" message ek saath, taaki user ko jawab jaldi dikhe
  await Promise.all([
    env.DB.prepare("INSERT OR IGNORE INTO queue (user_id, ts) VALUES (?, ?)").bind(userId, nowSec()).run(),
    reply("🔍 **Searching for a partner...** Please wait.", { parse_mode: "Markdown", reply_markup: SEARCH_KEYBOARD }),
  ]);
  const partner = await claimPair(env, userId, true); // pehle same language wale ko try
  if (partner) {
    return announceMatch(env, userId, partner);
  }
  if (!(await inQueue(env, userId))) return; // kisi aur ne humein match kar diya, wahi message bhej dega

  // Same language ka thoda intezaar, phir kisi se bhi. Queue me koi aur nahi hai to intezaar bekaar hai.
  const others = await count(env, "SELECT COUNT(*) FROM queue WHERE user_id != ?", userId);
  if (others > 0) {
    const waitMs = Number(env.LANG_WAIT_MS ?? 800); // env LANG_WAIT_MS se badlo, 0 = bilkul intezaar nahi
    if (waitMs > 0) await sleep(env, waitMs);
    if (await inQueue(env, userId)) {
      let p2 = await claimPair(env, userId, true);
      if (!p2 && (await inQueue(env, userId))) p2 = await claimPair(env, userId, false);
      if (p2) return announceMatch(env, userId, p2);
    }
  }

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
  const rows = [
    [{ text: "👍 Like", callback_data: `lk_${partnerId}` }, { text: "👎 Dislike", callback_data: `dl_${partnerId}` }],
    [{ text: "⚠️ Report", callback_data: `rpt_${partnerId}` }],
  ];
  if (withSearch) rows.push([{ text: "Search New Partner", callback_data: "action_search" }]);
  return { inline_keyboard: rows };
}

async function sendFeedback(env, chatId, partnerId, withSearch) {
  return send(env, chatId, FEEDBACK_TEXT, { reply_markup: feedbackKeyboard(partnerId, withSearch) });
}

async function stopChat(env, userId, chatId, pre) {
  const profile = pre || (await getProfile(env, userId)) || {};
  if (profile.in_queue) {
    await Promise.all([
      env.DB.prepare("DELETE FROM queue WHERE user_id = ?").bind(userId).run(),
      send(env, chatId, "Search stopped.", { reply_markup: IDLE_KEYBOARD }),
    ]);
    return;
  }
  const partnerId = profile.chat_partner || null;
  if (!partnerId) {
    return send(env, chatId, "You are not in an active chat.", { reply_markup: MAIN_KEYBOARD });
  }
  await endChat(env, userId, partnerId);

  await Promise.all([
    (async () => {
      await send(env, chatId, "**You stopped the chat.**\nType /search to find a new partner.", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
      await sendFeedback(env, chatId, partnerId, false);
      await deliverPending(env, userId);
    })(),
    (async () => {
      await send(env, partnerId, "**Your partner stopped the chat.**\nType /search to find a new partner.", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
      await sendFeedback(env, partnerId, userId, true);
      await deliverPending(env, partnerId);
    })(),
  ]);
}

async function nextPartner(env, userId, chatId, pre) {
  const partnerId = ((pre || (await getProfile(env, userId))) || {}).chat_partner || null;
  if (partnerId) {
    await endChat(env, userId, partnerId);
    await Promise.all([
      (async () => {
        await send(env, chatId, "**You skipped your partner.**\nLooking for a new partner...", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
        await sendFeedback(env, chatId, partnerId, false);
        await deliverPending(env, userId);
      })(),
      (async () => {
        await send(env, partnerId, "**Your partner skipped the chat.**\nType /search to find a new partner.", { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
        await sendFeedback(env, partnerId, userId, true);
        await deliverPending(env, partnerId);
      })(),
    ]);
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

  if (distinct === cfg(env, "WARN_AFTER_REPORTS")) {
    await env.DB.prepare("UPDATE users SET badge_penalty = MIN(2, COALESCE(badge_penalty, 0) + 1), streak = 0 WHERE user_id = ?").bind(reported).run();
  }
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
        [{ text: "Ban user", callback_data: `adm_ban_${d.target}` }, { text: "⚠️ Warn", callback_data: `adm_warn_${d.target}` }, { text: "Dismiss", callback_data: `adm_dis_${d.target}` }],
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

// ---------------------------------------------------------------- Invites (5 dost = Ambassador tag)

const INVITE_TARGET = 5;
const INVITES_PER_DAY = 10;
let botUsernameCache = null;

async function getBotUsername(env) {
  if (botUsernameCache) return botUsernameCache;
  const r = await tg(env, "getMe", {});
  if (r.ok && r.result && r.result.username) botUsernameCache = r.result.username;
  return botUsernameCache;
}

async function ensureInviteCode(env, userId) {
  const u = await env.DB.prepare("SELECT invite_code FROM users WHERE user_id = ?").bind(userId).first();
  if (u && u.invite_code) return u.invite_code;
  for (let i = 0; i < 5; i++) {
    const code = Math.random().toString(36).slice(2, 10);
    if (code.length < 6) continue;
    const taken = await env.DB.prepare("SELECT 1 AS x FROM users WHERE invite_code = ?").bind(code).first();
    if (taken) continue;
    await env.DB.prepare("UPDATE users SET invite_code = ? WHERE user_id = ?").bind(code, userId).run();
    return code;
  }
  return null;
}

async function showInvite(env, userId, chatId) {
  const p = await getProfile(env, userId);
  if (!isComplete(p)) return send(env, chatId, "Please complete your profile first by typing /start");
  const code = await ensureInviteCode(env, userId);
  const uname = await getBotUsername(env);
  const counted = await count(env, "SELECT COUNT(*) FROM referrals WHERE inviter_id = ? AND status = 'counted'", userId);
  const waiting = await count(env, "SELECT COUNT(*) FROM referrals WHERE inviter_id = ? AND status = 'pending'", userId);
  const link = uname && code ? `https://t.me/${uname}?start=r_${code}` : null;
  const lines = [
    "🤝 Invite friends to Nexus",
    "",
    link ? `Your link:\n${link}` : `Your invite code: r_${code}`,
    "",
    p.ambassador ? "You are a 🤝 Ambassador. Thank you for growing Nexus!" : `Progress: ${counted}/${INVITE_TARGET} friends\nInvite ${INVITE_TARGET} friends to earn the 🤝 Ambassador tag.`,
  ];
  if (waiting > 0) lines.push(`Joined but not counted yet: ${waiting}`);
  lines.push("", "A friend counts after they finish their profile and chat at least twice. You only see numbers, never who joined.");
  const text = encodeURIComponent("Chat anonymously with people around the world on Nexus!");
  const kb = link ? { inline_keyboard: [[{ text: "📤 Share link", url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}` }]] } : MAIN_KEYBOARD;
  return send(env, chatId, lines.join("\n"), { reply_markup: kb });
}

// /start r_CODE: sirf naye user ke liye, khud ko invite nahi, din me max INVITES_PER_DAY
async function recordReferral(env, inviteeId, code) {
  const inv = await env.DB.prepare("SELECT user_id FROM users WHERE invite_code = ?").bind(code).first();
  if (!inv || inv.user_id === inviteeId) return;
  const today = await count(env, "SELECT COUNT(*) FROM referrals WHERE inviter_id = ? AND ts > ?", inv.user_id, nowSec() - 86400);
  if (today >= INVITES_PER_DAY) return;
  await env.DB.prepare("INSERT OR IGNORE INTO referrals (invitee_id, inviter_id, ts, status) VALUES (?, ?, ?, 'pending')").bind(inviteeId, inv.user_id, nowSec()).run();
}

// Dost ne profile poori ki aur 2 chats kar li to inviter ki ginti me +1
async function creditReferrals(env, a, b) {
  const { results } = await env.DB.prepare(
    "SELECT r.invitee_id, r.inviter_id FROM referrals r JOIN users u ON u.user_id = r.invitee_id WHERE r.status = 'pending' AND r.invitee_id IN (?, ?) AND COALESCE(u.chat_count, 0) >= 2"
  ).bind(a, b).all();
  for (const r of results) {
    await env.DB.prepare("UPDATE referrals SET status = 'counted' WHERE invitee_id = ?").bind(r.invitee_id).run();
    const counted = await count(env, "SELECT COUNT(*) FROM referrals WHERE inviter_id = ? AND status = 'counted'", r.inviter_id);
    if (counted >= INVITE_TARGET) {
      const got = await env.DB.prepare("UPDATE users SET ambassador = 1 WHERE user_id = ? AND COALESCE(ambassador, 0) = 0 RETURNING user_id").bind(r.inviter_id).first();
      if (got) await notify(env, r.inviter_id, "🤝 Congratulations! You earned the Ambassador tag for inviting 5 friends. It now shows next to your badge.");
    } else {
      await notify(env, r.inviter_id, `🎉 A friend you invited joined Nexus and started chatting! Progress: ${counted}/${INVITE_TARGET}`);
    }
  }
}

// ---------------------------------------------------------------- Feedback

const FB_KINDS = { bug: "Bug", idea: "Idea", complaint: "Complaint", other: "Other" };
const FB_PER_DAY = 3;

async function startFeedback(env, userId, chatId) {
  const n = await count(env, "SELECT COUNT(*) FROM feedback WHERE user_id = ? AND ts > ?", userId, nowSec() - 86400);
  if (n >= FB_PER_DAY) return send(env, chatId, "You have sent enough feedback for today. Please try again tomorrow. Thank you!", { reply_markup: MAIN_KEYBOARD });
  return send(env, chatId, "💬 What kind of feedback would you like to share?", {
    reply_markup: { inline_keyboard: [
      [{ text: "🐞 Bug", callback_data: "fbk_bug" }, { text: "💡 Idea", callback_data: "fbk_idea" }],
      [{ text: "😕 Complaint", callback_data: "fbk_complaint" }, { text: "📝 Other", callback_data: "fbk_other" }],
    ] },
  });
}

async function handleFeedbackText(env, msg, st) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();
  if (text.length < 10) return send(env, chatId, `Please write a little more (at least 10 characters, you wrote ${text.length}). Send /cancel to stop.`);
  if (hasLink(msg)) return send(env, chatId, "Links are not allowed in feedback. Please describe it in words.");
  const n = await count(env, "SELECT COUNT(*) FROM feedback WHERE user_id = ? AND ts > ?", userId, nowSec() - 86400);
  if (n >= FB_PER_DAY) {
    await clearState(env, userId);
    return send(env, chatId, "You have sent enough feedback for today. Please try again tomorrow.", { reply_markup: MAIN_KEYBOARD });
  }
  const kind = FB_KINDS[st.data] || "Other";
  const r = await env.DB.prepare("INSERT INTO feedback (user_id, kind, text, ts, status) VALUES (?, ?, ?, ?, 'new') RETURNING id").bind(userId, kind, text.slice(0, 1000), nowSec()).first();
  await clearState(env, userId);
  for (const a of adminIds(env)) {
    await send(env, a, `<b>💬 Feedback #${r.id}</b> (${kind})\nFrom: <code>${userId}</code>\n\n${esc(text.slice(0, 1000))}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Reply", callback_data: `adm_fr_${r.id}` }]] },
    });
  }
  return send(env, chatId, "✅ Thank you! Your feedback was sent to the Nexus team.", { reply_markup: MAIN_KEYBOARD });
}

async function handleFeedbackReply(env, msg, st) {
  const adminId = msg.from.id;
  const id = Number(st.data);
  const fb = await env.DB.prepare("SELECT user_id FROM feedback WHERE id = ?").bind(id).first();
  await clearState(env, adminId);
  if (!fb) return send(env, msg.chat.id, "Feedback not found.");
  const text = (msg.text || "").trim().slice(0, 1500);
  await notify(env, fb.user_id, `📩 Reply from the Nexus team:\n\n${text}`); // chat me ho to chat ke baad milega
  await env.DB.prepare("UPDATE feedback SET status = 'replied' WHERE id = ?").bind(id).run();
  return send(env, msg.chat.id, `✅ Reply sent for feedback #${id}.`);
}

// ---------------------------------------------------------------- Official warning (opening + closing fixed, beech ka message admin likhta hai)

const WARN_OPEN = "⚠️ Official Notice from the Nexus Team\n\nDear user,\n\nThis is an official notice regarding your account on Nexus Anonymous Chat.\n\n";
const WARN_CLOSE = "\n\nPlease follow the community rules so that Nexus stays safe and respectful for everyone. Repeated violations may lead to a temporary or permanent ban.\n\nIf you believe this notice was sent by mistake, you can write to us using /feedback.\n\nRegards,\nNexus Team";
const buildWarning = (middle) => WARN_OPEN + middle + WARN_CLOSE;

// text na ho to admin se beech ka message maangta hai, ho to seedha preview dikhata hai
async function startWarn(env, adminId, chatId, uid, middle) {
  if (!(await getProfile(env, uid))) return send(env, chatId, "User not found.");
  if (isAdmin(env, uid)) return send(env, chatId, "You cannot warn an admin.");
  if (!middle) {
    await setState(env, adminId, "warn", String(uid));
    return send(env, chatId, `Write the middle part of the warning for user ${uid} (one message, 10-800 characters).\nThe opening and closing lines are added automatically. /cancel to stop.`);
  }
  middle = middle.trim();
  if (middle.length < 10 || middle.length > 800) return send(env, chatId, `The message must be 10-800 characters (yours: ${middle.length}). Try again.`);
  await setState(env, adminId, "warnp", JSON.stringify({ uid, middle }));
  return send(env, chatId, `<b>Preview for user <code>${uid}</code></b>\n\n${esc(buildWarning(middle))}`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "✅ Send", callback_data: "adm_wsend" }, { text: "Cancel", callback_data: "adm_wcancel" }]] },
  });
}

// ---------------------------------------------------------------- Sources (log kahan se aa rahe hain)

// Admin ke liye: user kahan se aaya. Dost ke invite se aaya ho to kis dost ke link se, aur wo dost khud kahan se aaya tha.
async function describeSource(env, id) {
  const r = await env.DB.prepare("SELECT source FROM user_sources WHERE user_id = ?").bind(id).first();
  if (!r) return "unknown (joined before tracking)";
  if (r.source !== "invite") return r.source;
  const ref = await env.DB.prepare("SELECT inviter_id FROM referrals WHERE invitee_id = ?").bind(id).first();
  if (!ref) return "invite (inviter not recorded)";
  const up = await env.DB.prepare("SELECT source FROM user_sources WHERE user_id = ?").bind(ref.inviter_id).first();
  return `invite, invited by ${ref.inviter_id}` + (up ? ` (who came from ${up.source})` : "");
}

async function viewSources(env, days) {
  const since = days > 0 ? nowSec() - days * 86400 : 0;
  const { results } = await env.DB.prepare(
    `SELECT s.source AS source, COUNT(*) AS joined,
       SUM(CASE WHEN u.gender IS NOT NULL AND u.age IS NOT NULL AND u.language IS NOT NULL THEN 1 ELSE 0 END) AS profiled,
       SUM(CASE WHEN COALESCE(u.chat_count, 0) >= 1 THEN 1 ELSE 0 END) AS chatted,
       SUM(CASE WHEN u.last_seen IS NOT NULL AND u.created_at IS NOT NULL AND u.last_seen - u.created_at >= 86400 THEN 1 ELSE 0 END) AS came_back
     FROM user_sources s LEFT JOIN users u ON u.user_id = s.user_id
     WHERE s.ts > ?1 GROUP BY s.source ORDER BY joined DESC, source LIMIT 15`
  ).bind(since).all();
  const tracked = await count(env, "SELECT COUNT(*) FROM user_sources WHERE ts > ?", since);
  const before = await count(env, "SELECT COUNT(*) FROM users WHERE user_id NOT IN (SELECT user_id FROM user_sources)");
  const lines = results.map((r) => `<code>${esc(r.source)}</code>: ${r.joined} joined, ${r.profiled || 0} finished profile, ${r.chatted || 0} chatted, ${r.came_back || 0} came back`);
  const text = [
    `<b>Sources</b> (${days > 0 ? "last " + days + " days" : "all time"})`,
    `Tracked users: ${tracked}   Joined before tracking: ${before}`,
    "",
    ...(lines.length ? lines : ["No data yet. Share links made with /link name."]),
    "",
    "joined = pressed Start, finished profile = chose gender, age and language, chatted = had at least one chat, came back = used the bot again a day or more later.",
  ].join("\n");
  const srcRows = results.slice(0, 6).map((r) => [{ text: `${r.source} (${r.joined})`.slice(0, 40), callback_data: `adm_up_0_${r.source}`.slice(0, 64) }]);
  if (before > 0) srcRows.push([{ text: `before tracking (${before})`, callback_data: "adm_up_0_old" }]);
  return { text, kb: adminKb([[{ text: "Last 7 days", callback_data: "adm_src7" }, { text: "All time", callback_data: "adm_src" }], ...srcRows, [{ text: "All users list", callback_data: "adm_up_0_" }], backRow]) };
}

async function viewFeedback(env) {
  const total = await count(env, "SELECT COUNT(*) FROM feedback");
  const fresh = await count(env, "SELECT COUNT(*) FROM feedback WHERE status = 'new'");
  const { results } = await env.DB.prepare("SELECT id, kind, user_id, text, status FROM feedback ORDER BY id DESC LIMIT 8").all();
  const lines = [];
  for (const r of results) {
    lines.push(`#${r.id} [${esc(r.kind)}] ${r.status === "new" ? "NEW" : esc(r.status)} - <code>${r.user_id}</code>`);
    lines.push(esc((r.text || "").slice(0, 90)));
    lines.push("");
  }
  const kb = results.slice(0, 6).map((r) => [{ text: `Reply to #${r.id}`, callback_data: `adm_fr_${r.id}` }]);
  return {
    text: ["<b>Feedback</b>", `Total: ${total}   New: ${fresh}`, "", ...(lines.length ? lines : ["No feedback yet."])].join("\n"),
    kb: adminKb([...kb, backRow]),
  };
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
      [{ text: "Feedback", callback_data: "adm_fb" }, { text: "Settings", callback_data: "adm_set" }],
      [{ text: "Sources", callback_data: "adm_src" }, { text: "Refresh", callback_data: "adm_home" }],
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

const agoText = (ts) => {
  if (!ts) return "?";
  const d = nowSec() - ts;
  if (d < 3600) return Math.max(1, Math.floor(d / 60)) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  return Math.floor(d / 86400) + "d ago";
};

// Kaun kahan se aaya: 10 users ek page par. source = naam (jaise botlist), "old" = tracking se pehle wale, null = sab
async function viewUsers(env, page = 0, source = null) {
  const per = 10;
  const filt = source === "old" ? "s.source IS NULL" : source ? "s.source = ?" : "1 = 1";
  const args = source && source !== "old" ? [source] : [];
  const base = `FROM users u LEFT JOIN user_sources s ON s.user_id = u.user_id WHERE ${filt}`;
  const total = await count(env, `SELECT COUNT(*) ${base}`, ...args);
  const banned = await count(env, "SELECT COUNT(*) FROM users WHERE banned = 1");
  const pages = Math.max(1, Math.ceil(total / per));
  page = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
  const { results } = await env.DB.prepare(
    `SELECT u.user_id, u.username, u.gender, u.age, u.language, u.created_at, COALESCE(u.chat_count, 0) AS chats, s.source AS source ${base} ORDER BY u.created_at DESC, u.user_id DESC LIMIT ${per} OFFSET ${page * per}`
  ).bind(...args).all();
  const lines = results.map((r, n) =>
    `${page * per + n + 1}. <code>${r.user_id}</code>${r.username ? " @" + esc(r.username) : ""}\n    ${esc((r.gender || "-").slice(0, 1))} ${esc(r.age || "-")} · ${esc(r.language || "-")} · <b>${esc(r.source || "before tracking")}</b> · ${r.chats} chats · ${agoText(r.created_at)}`
  );
  const label = source === "old" ? "before tracking" : source ? source : "all sources";
  const text = [
    "<b>Users: who came from where</b>",
    `Showing: ${esc(label)}   Page ${page + 1}/${pages}   Total: ${total}   Banned: ${banned}`,
    "",
    lines.length ? lines.join("\n") : "  no users here",
    "",
    "Tap an ID to copy it, then /user ID for the full card.",
    "Filters: /users botlist   /users old   /users 2",
  ].join("\n");
  const src = source || "";
  const nav = [];
  if (page > 0) nav.push({ text: "⬅ Prev", callback_data: `adm_up_${page - 1}_${src}` });
  if (page < pages - 1) nav.push({ text: "Next ➡", callback_data: `adm_up_${page + 1}_${src}` });
  const rows = [];
  if (nav.length) rows.push(nav);
  if (source) rows.push([{ text: "All users", callback_data: "adm_up_0_" }]);
  rows.push([{ text: "Sources summary", callback_data: "adm_src" }, { text: "Banned users", callback_data: "adm_banned" }]);
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
    `Warnings sent: ${await count(env, "SELECT COUNT(*) FROM warnings WHERE user_id = ?", id)}`,
    `Came from: ${esc(await describeSource(env, id))}`,
  ].join("\n");
  const action = u.banned ? { text: "Unban user", callback_data: `adm_unban_${id}` } : { text: "Ban user", callback_data: `adm_ban_${id}` };
  return { text, kb: adminKb([[action, { text: "⚠️ Warn", callback_data: `adm_warn_${id}` }], [{ text: "Refresh", callback_data: `adm_u_${id}` }, { text: "Back", callback_data: "adm_users" }]]) };
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
  if (profile && profile.restrict_until && !admin) {
    const t0 = nowSec();
    if (profile.restrict_until > t0) {
      await send(env, chatId, `🚫 You are restricted for now.\nTime left: ${timeLeft(profile.restrict_until - t0)}`);
      return false;
    }
    await env.DB.prepare("UPDATE users SET restrict_until = 0 WHERE user_id = ?").bind(user.id).run();
    profile.restrict_until = 0;
    await send(env, chatId, "✅ Your restriction has ended. Please follow the rules to avoid another one.");
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
    const today = dayKey(t);
    if (profile.last_active_day !== today) {
      const streak = profile.last_active_day === dayKey(t - 86400) ? (profile.streak || 0) + 1 : 1;
      await env.DB.prepare("UPDATE users SET streak = ?, last_active_day = ? WHERE user_id = ?").bind(streak, today, user.id).run();
    }
  }
  return true;
}

// ---------------------------------------------------------------- Commands

const ADMIN_COMMANDS = ["admin", "stats", "user", "ban", "unban", "broadcast", "warn", "feedbacks", "invites", "health", "link", "sources", "users"];

async function onCommand(env, msg, pre) {
  const chatId = msg.chat.id;
  const user = msg.from;
  const m = msg.text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || "").trim();

  if (ADMIN_COMMANDS.includes(cmd) && !isAdmin(env, user.id)) return; // admin ko hi dikhta hai

  if (cmd === "start") {
    const profile = await getProfile(env, user.id);
    const refm = arg.match(/^r_([a-z0-9]{6,12})$/i);
    const srcm = arg.match(/^src_([a-z0-9_-]{1,40})$/i);
    if (!isComplete(profile)) {
      if (refm) await recordReferral(env, user.id, refm[1].toLowerCase());
      // user kahan se aaya: src_NAAM link se, dost ke invite se ("invite"), ya seedha ("direct")
      const source = srcm ? srcm[1].toLowerCase() : refm ? "invite" : "direct";
      await env.DB.prepare("INSERT OR IGNORE INTO user_sources (user_id, source, ts) VALUES (?, ?, ?)").bind(user.id, source, nowSec()).run();
    }
    if (isComplete(profile)) {
      await setField(env, user, "username", user.username ?? null);
      await send(env, chatId, `**Welcome back to Nexus Anonymous Chat!** 🌍\nYour badge: ${badgeText(profile)}\n\nUse the buttons below:`, { reply_markup: MAIN_KEYBOARD, parse_mode: "Markdown" });
      if (refm) return showInvite(env, user.id, chatId); // dost ka link khola to apna alag link dikhao
      return;
    }
    const keyboard = {
      inline_keyboard: [
        [{ text: "Male", callback_data: "gender_Male" }, { text: "Female", callback_data: "gender_Female" }],
        [{ text: "Other", callback_data: "gender_Other" }],
      ],
    };
    return send(env, chatId, "**Welcome to Nexus Anonymous Chat!** 🌍\n\nMeet people from around the world.\nChat kindly to earn badges: 🌱 → 😊 → ⭐\n\nPlease select your **Gender**:", { reply_markup: keyboard, parse_mode: "Markdown" });
  }

  if (cmd === "search") return searchPartner(env, user.id, chatId, pre);
  if (cmd === "stop") return stopChat(env, user.id, chatId, pre);
  if (cmd === "next") return nextPartner(env, user.id, chatId, pre);
  if (cmd === "play") return handlePlay(env, user.id, chatId);
  if (cmd === "menu") return showMenu(env, user.id, chatId);
  if (cmd === "feedback") return startFeedback(env, user.id, chatId);
  if (cmd === "users") {
    let page = 0;
    let src = null;
    for (const t of arg.trim().split(/\s+/).filter(Boolean)) {
      if (/^\d+$/.test(t)) page = Number(t) - 1;
      else src = t.toLowerCase();
    }
    const v = await viewUsers(env, page, src);
    return send(env, chatId, v.text, { parse_mode: "HTML", reply_markup: v.kb });
  }
  if (cmd === "link") {
    const tag = arg.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
    const uname = await getBotUsername(env);
    if (tag === "old") return send(env, chatId, 'The name "old" is reserved. Please use another name.');
    if (!tag) return send(env, chatId, "Make a tracking link for any place you share the bot.\nUsage: /link name\nExample: /link botlist\nThen use /sources to see how many users came from each link.");
    if (!uname) return send(env, chatId, "Could not read the bot username right now. Try again in a moment.");
    return send(env, chatId, `Link for "${tag}":\nhttps://t.me/${uname}?start=src_${tag}\n\nUse a different name for each place (a channel, a group, an ad swap). See results with /sources.`);
  }
  if (cmd === "sources") {
    const d = Number(arg.trim());
    const v = await viewSources(env, d > 0 && d <= 365 ? Math.floor(d) : 0);
    return send(env, chatId, v.text, { parse_mode: "HTML", reply_markup: v.kb });
  }
  if (cmd === "health") {
    // Kitna time lag raha hai: database ka ek call aur Telegram ka ek call (milliseconds)
    const a0 = Date.now(); await env.DB.prepare("SELECT 1 AS x").first(); const d1 = Date.now() - a0;
    const b0 = Date.now(); await env.DB.prepare("SELECT 1 AS x").first(); const d2 = Date.now() - b0;
    const c0 = Date.now(); await tg(env, "getMe", {}); const t1 = Date.now() - c0;
    return send(env, chatId, `Health check\nDatabase call: ${d1} ms (then ${d2} ms)\nTelegram API call: ${t1} ms\nVersion: ${CODE_VERSION}\n\nGood: database under 50 ms. If it is 150 ms or more, turn on Smart Placement in Cloudflare.`);
  }
  if (cmd === "invite") return showInvite(env, user.id, chatId);
  if (cmd === "invites") {
    const total = await count(env, "SELECT COUNT(*) FROM referrals");
    const counted = await count(env, "SELECT COUNT(*) FROM referrals WHERE status = 'counted'");
    const amb = await count(env, "SELECT COUNT(*) FROM users WHERE ambassador = 1");
    const { results } = await env.DB.prepare("SELECT inviter_id, SUM(CASE WHEN status = 'counted' THEN 1 ELSE 0 END) AS c, COUNT(*) AS t FROM referrals GROUP BY inviter_id ORDER BY c DESC, t DESC LIMIT 10").all();
    const lines = results.map((r) => `<code>${r.inviter_id}</code>: ${r.c} counted / ${r.t} joined`);
    return send(env, chatId, ["<b>Invites</b>", `Joined via invite: ${total}   Counted: ${counted}   Ambassadors: ${amb}`, "", "Top inviters:", ...(lines.length ? lines : ["No invites yet."])].join("\n"), { parse_mode: "HTML" });
  }
  if (cmd === "feedbacks" && isAdmin(env, user.id)) {
    const v = await viewFeedback(env);
    return send(env, chatId, v.text, { parse_mode: "HTML", reply_markup: v.kb });
  }
  if (cmd === "hidemenu") return hideMenu(env, user.id, chatId);
  if (cmd === "profile") {
    const p = pre || (await getProfile(env, user.id));
    if (!isComplete(p)) return send(env, chatId, "Please complete your profile first by typing /start");
    const lvl = badgeLevel(p);
    const likes = p.likes || 0;
    const prog = lvl >= 2 ? "You have the top badge! 🎉" : `Next badge: ${likes}/${likes >= 5 ? 20 : 5} likes`;
    return send(env, chatId, [
      "👤 Your profile",
      `Badge: ${badgeText(p)}`,
      prog + (p.badge_penalty > 0 && (p.likes || 0) >= 5 ? "\n(Your badge was lowered by reports. Keep getting likes to recover.)" : ""),
      `Likes: ${likes}   Streak: ${p.streak || 0} day(s)`,
      `Gender: ${p.gender}   Age: ${p.age}`,
      `Language: ${p.language}`,
      `Saved partners: ${await savedCount(env, user.id)}/${MAX_SAVED}`,
      `Your ID: <code>${user.id}</code> (tap to copy)`,
    ].join("\n"), { reply_markup: kbOf(p), parse_mode: "HTML" });
  }
  if (cmd === "cancel") {
    await clearState(env, user.id);
    return send(env, chatId, "Cancelled.", { reply_markup: MAIN_KEYBOARD });
  }
  if (cmd === "myid") return send(env, chatId, `🆔 Your Telegram ID: <code>${user.id}</code>\n(tap the number to copy it)`, { parse_mode: "HTML", reply_markup: pre ? kbOf(pre) : MAIN_KEYBOARD });

  if (cmd === "help") {
    return send(env, chatId, [
      "**Commands**",
      "/start - set up your profile",
      "/search - find a partner",
      "/next - skip to a new partner",
      "/play - play Tic-Tac-Toe with your partner",
      "/menu - refresh the menu buttons (hide or show them with the keyboard icon)",
      "/feedback - send feedback to the team",
      "/invite - invite friends and earn the Ambassador tag",
      "/profile - see your badge and progress",
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

  if (cmd === "warn") {
    const wm = arg.match(/^(\d+)\s*([\s\S]*)$/);
    if (!wm) return send(env, chatId, "Usage: /warn <id> <your message>\nExample: /warn 123456 We received a report about vulgar language in your chats.");
    return startWarn(env, user.id, chatId, Number(wm[1]), wm[2]);
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
  const text = LEGACY_BTN[msg.text] ?? msg.text;

  const isCmd = !!(text && text.startsWith("/"));
  const [profile, st] = await Promise.all([getProfile(env, userId), isCmd ? null : getState(env, userId), getSettings(env)]); // settings bhi saath me (cache garam)
  if (!(await gate(env, msg.from, chatId, profile, { text }))) return;

  if (isCmd) return onCommand(env, msg, profile);

  // Underage report likhne ka intezaar (text zaroori, screenshot optional)
  if (st && st.kind === "ua") {
    if (text && BUTTONS.includes(text)) await clearState(env, userId);
    else return handleUaReport(env, msg, st);
  }
  if (st && st.kind === "rename") {
    if (!text || BUTTONS.includes(text)) await clearState(env, userId);
    else {
      const nick = text.replace(/[*_`\[\]]/g, "").trim().slice(0, 20);
      if (!nick) return send(env, chatId, "Please send a valid nickname.");
      await env.DB.prepare("UPDATE saved_partners SET nickname = ? WHERE user_id = ? AND partner_id = ?").bind(nick, userId, Number(st.data)).run();
      await clearState(env, userId);
      return send(env, chatId, `✅ Renamed to ${nick}.`, { reply_markup: MAIN_KEYBOARD });
    }
  }
  if (st && st.kind === "fbk") {
    if (!text || BUTTONS.includes(text)) await clearState(env, userId);
    else return handleFeedbackText(env, msg, st);
  }
  if (st && st.kind === "warn" && isAdmin(env, userId)) {
    if (!text || BUTTONS.includes(text)) await clearState(env, userId);
    else return startWarn(env, userId, chatId, Number(st.data), text);
  }
  if (st && st.kind === "fbr" && isAdmin(env, userId)) {
    if (!text || BUTTONS.includes(text)) await clearState(env, userId);
    else return handleFeedbackReply(env, msg, st);
  }

  if (text === BTN_NEXT) return nextPartner(env, userId, chatId, profile);
  if (text === BTN_STOP) return stopChat(env, userId, chatId, profile);

  if (text === BTN_SAVE) return onSavePressed(env, userId, chatId);
  if (text === BTN_SAVED) return showSaved(env, userId, chatId);
  if (text === BTN_PLAY) return handlePlay(env, userId, chatId);
  if (text === BTN_HIDE) return hideMenu(env, userId, chatId);
  if (text === BTN_SEARCH) return searchPartner(env, userId, chatId, profile);
  if (text === BTN_PROFILE) return onCommand(env, { ...msg, text: "/profile" }, profile);
  if (text === BTN_FEEDBACK) return startFeedback(env, userId, chatId);
  if (text === BTN_ID) return onCommand(env, { ...msg, text: "/myid" }, profile);
  if (text === BTN_INVITE) return showInvite(env, userId, chatId);

  // Normal chat message (partner ka pata profile se hi mil gaya, alag query nahi)
  const partnerId = profile ? profile.chat_partner : null;
  if (!partnerId) {
    return send(env, chatId, `Type /search or press ${BTN_NEXT} to find someone first.`, { reply_markup: MAIN_KEYBOARD });
  }

  if (text) {
    if (hasLink(msg)) return handleLinkMessage(env, userId, chatId, partnerId, text);
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
    if (data === "adm_fb") return editView(env, chatId, mid, await viewFeedback(env));
    if (data === "adm_src") return editView(env, chatId, mid, await viewSources(env, 0));
    if (data.startsWith("adm_up_")) {
      const up = data.split("_");
      return editView(env, chatId, mid, await viewUsers(env, Number(up[2]) || 0, up.slice(3).join("_") || null));
    }
    if (data === "adm_src7") return editView(env, chatId, mid, await viewSources(env, 7));
    if (data.startsWith("adm_warn_")) return startWarn(env, userId, chatId, id);
    if (data === "adm_wcancel") {
      await clearState(env, userId);
      return edit("Warning cancelled. Nothing was sent.");
    }
    if (data === "adm_wsend") {
      const st = await getState(env, userId);
      let d = null;
      try { d = JSON.parse((st && st.data) || "null"); } catch (e) {}
      if (!st || st.kind !== "warnp" || !d) return edit("This preview has expired. Use /warn again.");
      await clearState(env, userId);
      await notify(env, d.uid, buildWarning(d.middle)); // user chat me ho to chat ke baad milega
      await env.DB.prepare("INSERT INTO warnings (user_id, admin_id, text, ts) VALUES (?, ?, ?, ?)").bind(d.uid, userId, d.middle, nowSec()).run();
      return edit(`✅ Warning sent to user ${d.uid}.`);
    }
    if (data.startsWith("adm_fr_")) {
      const fb = await env.DB.prepare("SELECT id FROM feedback WHERE id = ?").bind(id).first();
      if (!fb) return send(env, chatId, "Feedback not found.");
      await setState(env, userId, "fbr", String(id));
      return send(env, chatId, `Send your reply for feedback #${id} now (one message). /cancel to stop.`);
    }

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

  if (data.startsWith("act_next_") || data.startsWith("act_stop_")) {
    const pid = Number(data.split("_")[2]);
    if ((await getPartner(env, userId)) !== pid) return answer("This chat has already ended.");
    await answer();
    return data.startsWith("act_next_") ? nextPartner(env, userId, chatId) : stopChat(env, userId, chatId);
  }

  if (data.startsWith("g_")) return onGameCallback(env, cq, userId, chatId, mid, edit, answer, data);

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
        [{ text: "English", callback_data: "lang_English" }, { text: "Spanish", callback_data: "lang_Spanish" }],
        [{ text: "French", callback_data: "lang_French" }, { text: "Arabic", callback_data: "lang_Arabic" }],
        [{ text: "Russian", callback_data: "lang_Russian" }, { text: "Any", callback_data: "lang_Any" }],
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

  // ---- feedback type chuna
  if (data.startsWith("fbk_")) {
    const k = data.split("_")[1];
    if (!FB_KINDS[k]) return;
    await setState(env, userId, "fbk", k);
    return edit(`Write your ${FB_KINDS[k]} feedback in one message (at least 10 characters).\nIt goes to the Nexus team with your user ID, never to your chat partner.\nSend /cancel to stop.`);
  }

  // ---- like / dislike (report se bilkul alag)
  if (data.startsWith("lk_") || data.startsWith("dl_")) {
    const pid = Number(data.split("_")[1]);
    if (!pid || pid === userId) return;
    const v = data.startsWith("lk_") ? 1 : -1;
    if (mid) {
      const kb = ((msg.reply_markup && msg.reply_markup.inline_keyboard) || []).filter((r) => !r.some((b) => /^(lk|dl)_/.test(b.callback_data || "")));
      await tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: kb } });
    }
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO ratings (rater_id, rated_id, v, day) VALUES (?, ?, ?, ?) RETURNING rater_id").bind(userId, pid, v, dayKey(nowSec())).first();
    if (ins) await applyRating(env, pid, v);
    return;
  }

  // ---- link verification
  if (data.startsWith("lv_")) {
    const idx = Number(data.split("_")[1]);
    const ls = await env.DB.prepare("SELECT * FROM link_state WHERE user_id = ?").bind(userId).first();
    if (!ls || !ls.target || !ls.pending) return edit("This check has expired.");
    const partnerId = await getPartner(env, userId);
    if (!partnerId) return edit("The chat has ended.");
    if (LINK_EMOJI[idx] === ls.target) {
      await send(env, partnerId, ls.pending);
      const sent = ls.sent + 1;
      await env.DB.prepare("UPDATE link_state SET verified = 1, links_left = 1, tries = 0, sent = ?, flagged = ?, pending = NULL, target = NULL WHERE user_id = ?").bind(sent, sent >= 6 ? 1 : 0, userId).run();
      return edit("✅ Verified. Your link was sent.");
    }
    const tries = ls.tries + 1;
    if (tries >= 5) {
      await env.DB.prepare("UPDATE link_state SET tries = ?, flagged = 1, pending = NULL, target = NULL WHERE user_id = ?").bind(tries, userId).run();
      return edit("🚫 Too many wrong answers. Links are blocked for you in this chat.");
    }
    await env.DB.prepare("UPDATE link_state SET tries = ? WHERE user_id = ?").bind(tries, userId).run();
    await edit("❌ Wrong answer. Try again.");
    return sendChallenge(env, userId, chatId, ls.pending);
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
    const all = (msg.reply_markup && msg.reply_markup.inline_keyboard) || [];
    const likeRows = all.filter((r) => r.some((b) => /^(lk|dl)_/.test(b.callback_data || "")));
    const keep = all.filter((r) => r.some((b) => b.callback_data === "action_search"));
    const rows = data.startsWith("rptb_")
      ? [[{ text: "⚠️ Report", callback_data: `rpt_${pid}` }]]
      : [
          [{ text: REASONS.ua, callback_data: `fb_ua_${pid}` }],
          [{ text: REASONS.vg, callback_data: `fb_vg_${pid}` }],
          [{ text: REASONS.sp, callback_data: `fb_sp_${pid}` }],
          [{ text: REASONS.rp, callback_data: `fb_rp_${pid}` }],
          [{ text: "Back", callback_data: `rptb_${pid}` }],
        ];
    return tg(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [...likeRows, ...rows, ...keep] } });
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

  // ---- save partner (dono ki marzi se)
  if (data.startsWith("sv_acc_") || data.startsWith("sv_dec_")) {
    const rid = Number(data.split("_")[2]);
    const r = await env.DB.prepare("SELECT * FROM saved_requests WHERE id = ?").bind(rid).first();
    if (!r || r.to_id !== userId || r.kind !== "save" || r.status !== "shown" || r.ts < nowSec() - 86400) return edit("This request has expired.");
    if (data.startsWith("sv_dec_")) {
      await env.DB.prepare("UPDATE saved_requests SET status = 'declined' WHERE id = ?").bind(rid).run();
      await edit("You declined the save request.");
      return notify(env, r.from_id, "Your save request was not accepted.", userId);
    }
    if ((await savedCount(env, userId)) >= MAX_SAVED || (await savedCount(env, r.from_id)) >= MAX_SAVED) {
      await env.DB.prepare("UPDATE saved_requests SET status = 'expired' WHERE id = ?").bind(rid).run();
      return edit(`Could not save: a saved list is full (${MAX_SAVED}).`);
    }
    const nameMine = await defaultName(env, userId);
    const nameTheirs = await defaultName(env, r.from_id);
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO saved_partners (user_id, partner_id, nickname) VALUES (?, ?, ?)").bind(userId, r.from_id, nameMine),
      env.DB.prepare("INSERT OR REPLACE INTO saved_partners (user_id, partner_id, nickname) VALUES (?, ?, ?)").bind(r.from_id, userId, nameTheirs),
      env.DB.prepare("UPDATE saved_requests SET status = 'accepted' WHERE id = ?").bind(rid),
    ]);
    await edit(`✅ Saved as ${nameMine}. You can rename it in Saved Partners.`);
    return notify(env, r.from_id, `💾 Your saved partner accepted your request. Saved as ${nameTheirs}.`, userId);
  }

  // ---- connect request (saved list se)
  if (data.startsWith("cn_acc_") || data.startsWith("cn_dec_")) {
    const rid = Number(data.split("_")[2]);
    const r = await env.DB.prepare("SELECT * FROM saved_requests WHERE id = ?").bind(rid).first();
    if (!r || r.to_id !== userId || r.kind !== "connect" || r.status !== "shown" || r.ts < nowSec() - 86400) return edit("This request has expired.");
    if (data.startsWith("cn_dec_")) {
      await env.DB.prepare("UPDATE saved_requests SET status = 'declined' WHERE id = ?").bind(rid).run();
      await edit("You declined the request.");
      return notify(env, r.from_id, "Your connect request was not accepted.", userId);
    }
    if ((await getPartner(env, userId)) || (await getPartner(env, r.from_id))) {
      await env.DB.prepare("UPDATE saved_requests SET status = 'expired' WHERE id = ?").bind(rid).run();
      return edit("This request is no longer available (someone is in another chat).");
    }
    const a = r.from_id;
    const b = userId;
    await env.DB.batch([
      env.DB.prepare("UPDATE saved_requests SET status = 'accepted' WHERE id = ?").bind(rid),
      env.DB.prepare("DELETE FROM queue WHERE user_id IN (?, ?)").bind(a, b),
      env.DB.prepare("INSERT OR REPLACE INTO chats (user_id, partner_id) VALUES (?, ?)").bind(a, b),
      env.DB.prepare("INSERT OR REPLACE INTO chats (user_id, partner_id) VALUES (?, ?)").bind(b, a),
      env.DB.prepare("DELETE FROM recent WHERE user_id IN (?, ?)").bind(a, b),
      env.DB.prepare("UPDATE users SET chat_count = COALESCE(chat_count, 0) + 1 WHERE user_id IN (?, ?)").bind(a, b),
      env.DB.prepare("INSERT INTO daily_stats (day, chats) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET chats = chats + 1").bind(dayKey(nowSec())),
    ]);
    await edit("✅ Accepted.");
    return announceMatch(env, a, b, "**Connected with your saved partner.** 🔗");
  }

  if (data.startsWith("view_saved_")) {
    const pid = Number(data.split("_")[2]);
    const row = await env.DB.prepare("SELECT nickname FROM saved_partners WHERE user_id = ? AND partner_id = ?").bind(userId, pid).first();
    if (!row) return edit("This partner is no longer in your saved list.");
    const keyboard = {
      inline_keyboard: [
        [{ text: "🔗 Connect", callback_data: `sc_${pid}` }, { text: "✏️ Rename", callback_data: `sr_${pid}` }],
        [{ text: "🗑 Remove", callback_data: `remove_saved_${pid}` }, { text: "🚫 Block", callback_data: `sb_${pid}` }],
      ],
    };
    return edit(`**Saved Partner**\nName: ${row.nickname || "Saved Partner"}\n\nWhat would you like to do?`, { reply_markup: keyboard });
  }

  if (data.startsWith("sc_")) {
    const pid = Number(data.split("_")[1]);
    if (!(await isSaved(env, userId, pid))) return edit("This partner is no longer in your saved list.");
    if (await getPartner(env, userId)) return edit("End your current chat first, then tap Connect.");
    if ((await isBlocked(env, pid, userId)) || (await isBlocked(env, userId, pid))) return edit("The request could not be sent.");
    if (await requestedToday(env, userId, pid)) return edit("You already sent a request to this partner today.");
    const busy = !!(await getPartner(env, pid));
    const r = await env.DB.prepare("INSERT INTO saved_requests (from_id, to_id, kind, ts, status) VALUES (?, ?, 'connect', ?, ?) RETURNING id").bind(userId, pid, nowSec(), busy ? "pending" : "shown").first();
    if (!busy) await send(env, pid, "🔗 Your saved partner wants to chat with you. Accept?", { reply_markup: reqKb("cn", r.id) });
    return edit("🔗 Request sent. They will see it and can accept or decline.");
  }

  if (data.startsWith("sr_")) {
    const pid = Number(data.split("_")[1]);
    await setState(env, userId, "rename", String(pid));
    return edit("✏️ Send a new nickname (up to 20 characters). Send /cancel to stop.");
  }

  if (data.startsWith("sb_")) {
    const pid = Number(data.split("_")[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM saved_partners WHERE (user_id = ? AND partner_id = ?) OR (user_id = ? AND partner_id = ?)").bind(userId, pid, pid, userId),
      env.DB.prepare("INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)").bind(userId, pid),
    ]);
    return edit("🚫 Blocked and removed. You will not be matched with this person again.");
  }

  if (data.startsWith("remove_saved_")) {
    const pid = Number(data.split("_")[2]);
    await env.DB.prepare("DELETE FROM saved_partners WHERE user_id = ? AND partner_id = ?").bind(userId, pid).run();
    return edit("🗑 Partner removed from your saved list.");
  }
}

// ---------------------------------------------------------------- Entry points

async function handleUpdate(env, update) {
  const t0 = Date.now();
  try {
    await ensureSchema(env);
    if (update.message) return await onMessage(env, update.message);
    if (update.callback_query) return await onCallback(env, update.callback_query);
  } finally {
    const ms = Date.now() - t0;
    if (ms > 1500) {
      const what = update.callback_query ? "cb:" + String(update.callback_query.data || "").slice(0, 20) : "msg:" + String((update.message && update.message.text) || "(media)").slice(0, 20);
      console.log("slow update", ms + "ms", what);
    }
  }
}

async function runCron(env) {
  await ensureSchema(env);
  await processBroadcast(env);
  await expireBans(env);
  await expireRestrictions(env);
  await sweepGames(env);
  await sweepRequests(env);
  await runMatcher(env);
}

export default {
  async fetch(request, env0, ctx) {
    const env = env0;
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && env.BOT_TOKEN && url.pathname === `/webhook/${env.BOT_TOKEN}`) {
        const update = await request.json();
        env.__wait = (p) => ctx.waitUntil(p.catch((e) => console.log("timer error", String(e))));
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
        await tg(env, "setMyCommands", {
          commands: [
            { command: "search", description: "Find a partner" },
            { command: "next", description: "Skip to a new partner" },
            { command: "stop", description: "End the chat" },
            { command: "play", description: "Play Tic-Tac-Toe" },
            { command: "menu", description: "Refresh the menu buttons" },
            { command: "feedback", description: "Send feedback to the team" },
            { command: "invite", description: "Invite friends, earn Ambassador tag" },
            { command: "profile", description: "Your badge and progress" },
            { command: "report", description: "Report your current partner" },
            { command: "help", description: "Show commands" },
            { command: "start", description: "Set up your profile" },
          ],
        });
        const admins = adminIds(env).length;
        return new Response(
          r.ok
            ? `Done! Webhook set ho gaya.\nAdmins configured: ${admins}${admins ? "" : " (ADMIN_IDS variable add karo, apna ID bot ke /myid se milega)"}\nAb Telegram mein bot ko /start bhejo.`
            : "Webhook set nahi hua: " + JSON.stringify(r),
          { status: r.ok ? 200 : 500 }
        );
      }

      return new Response(`Bot is running via Webhook!\nBOT_TOKEN: ${env.BOT_TOKEN ? "ok" : "MISSING"}\nDB: ${env.DB ? "ok" : "MISSING"}\nVersion: ${CODE_VERSION}`);
    } catch (e) {
      console.log("fetch error", (e && e.stack) || String(e));
      return new Response("Error", { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env).catch((e) => console.log("cron error", (e && e.stack) || String(e))));
  },
};
