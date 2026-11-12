'use strict';
/*
 * Полутон — маленький кинозал и музыкальная комната для своих.
 * Один файл: HTTP-сервер, WebSocket, обработка видео, загрузка по ссылке и Telegram-бот.
 * Зависимостей из npm нет: нужны только Node.js 22+, ffmpeg/ffprobe и yt-dlp.
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const dns = require('node:dns');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

/* ═════════════════════════════ Конфигурация ═════════════════════════════ */

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env не обязателен */ }
const env = process.env;
const APP_NAME = 'Полутон';
const IS_WIN = process.platform === 'win32';
const PORT = +env.PORT || 3000;
const DOMAIN = (env.DOMAIN || '').trim().replace(/\/+$/, '');
const PUBLIC_URL = DOMAIN
  ? (/^https?:\/\//i.test(DOMAIN) ? DOMAIN : (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(DOMAIN) ? 'http://' : 'https://') + DOMAIN)
  : `http://localhost:${PORT}`;
const ORIGIN = new URL(PUBLIC_URL).origin;
const SECURE = ORIGIN.startsWith('https:');
const BOT_TOKEN = (env.BOT_TOKEN || '').trim();
const OWNER_TG_ID = +(env.OWNER_ID || 0) || 0;
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const COOKIES_FILE = path.join(DATA_DIR, 'cookies.txt');
const HTML_FILE = path.join(__dirname, 'index.html');
const BIN = { ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ffprobe: env.FFPROBE_PATH || 'ffprobe', ytdlp: env.YTDLP_PATH || 'yt-dlp' };
const YT_PROXY = (env.YTDLP_PROXY || '').trim();     // необязательный прокси для yt-dlp (например socks5://127.0.0.1:1080)
const MAX_DOWNLOADS = 3;
const TRANSCODE_JOBS = Math.max(1, +env.TRANSCODE_JOBS || 1);
const X264_PRESET = env.X264_PRESET || 'veryfast';
const X264_CRF = +env.X264_CRF || 21;
const CHUNK_SIZE = 8 * 1024 * 1024;
const DISK_RESERVE = 1024 * 1024 * 1024;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const COOKIE = 'pt_s';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LADDER = [360, 480, 720, 1080, 1440];
const STD_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
const REACTIONS = ['❤️', '😂', '😮', '😢', '👏', '🔥', '👍', '💀'];

for (const d of [DATA_DIR, MEDIA_DIR, AVATAR_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

/* ═════════════════════════════ Мелочи ═════════════════════════════ */

const now = () => Date.now();
const rid = (n = 9) => crypto.randomBytes(n).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (tag, ...a) => console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} [${tag}]`, ...a);
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg, status = 400, extra) => new HttpError(status, msg, extra);
/** Ошибка с понятным человеку текстом (для карточек и ответов API). */
class UserError extends Error {
  constructor(message, code = '', opts = {}) { super(message); this.user = true; this.code = code; Object.assign(this, opts); }
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/* ═════════════════════════════ База данных ═════════════════════════════ */

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'friend',
  pass TEXT NOT NULL,
  tg_id INTEGER UNIQUE,
  tg_name TEXT,
  avatar INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua TEXT, ip TEXT, via TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by INTEGER,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS media(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  retry INTEGER NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  w INTEGER NOT NULL DEFAULT 0,
  h INTEGER NOT NULL DEFAULT 0,
  fps REAL NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'file',
  source_url TEXT,
  link TEXT,
  orig_file TEXT,
  file TEXT,
  poster INTEGER NOT NULL DEFAULT 0,
  meta TEXT,
  added_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS variants(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  height INTEGER NOT NULL,
  w INTEGER NOT NULL DEFAULT 0,
  h INTEGER NOT NULL DEFAULT 0,
  fps REAL NOT NULL DEFAULT 0,
  vcodec TEXT NOT NULL DEFAULT 'h264',
  file TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  prio INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS variants_media ON variants(media_id);
CREATE TABLE IF NOT EXISTS subs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS uploads(
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  total INTEGER NOT NULL,
  received BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`);
const stmts = new Map();
/** Подготовленный запрос с кешем. */
function q(sql) {
  let s = stmts.get(sql);
  if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
  return s;
}
const dbVal = v => (v === undefined ? null : typeof v === 'boolean' ? +v : v);
function upd(table, id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  q(`UPDATE ${table} SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => dbVal(patch[k])), id);
}
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
const getSetting = (k, d = '') => q('SELECT v FROM settings WHERE k=?').get(k)?.v ?? d;
const setSetting = (k, v) => q('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
const getUser = id => q('SELECT * FROM users WHERE id=?').get(id);
const getMedia = id => q('SELECT * FROM media WHERE id=?').get(id);
const hasOwner = () => !!q("SELECT 1 AS x FROM users WHERE role='owner' LIMIT 1").get();

let SETUP_CODE = (env.OWNER_CODE || '').trim();
if (!hasOwner() && !SETUP_CODE) SETUP_CODE = rid(6);

/* ═════════════════════════════ Пароли, сессии, защита ═════════════════════════════ */

const SCRYPT = { N: 32768, r: 8, p: 1 };
let hashing = 0;
/** scrypt тяжёлый: не даём запускать больше четырёх одновременно, чтобы нельзя было положить сервер. */
async function scryptLimited(pw, salt, p) {
  if (hashing >= 4) {
    for (let i = 0; i < 80 && hashing >= 4; i++) await sleep(50);
    if (hashing >= 4) throw bad('Сервер занят, попробуй через несколько секунд', 503);
  }
  hashing++;
  try {
    return await new Promise((res, rej) => crypto.scrypt(String(pw).normalize('NFKC'), salt, 64,
      { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r }, (e, dk) => (e ? rej(e) : res(dk))));
  } finally { hashing--; }
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = await scryptLimited(pw, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 6 || p[0] !== 'scrypt') return false;
  const params = { N: +p[1], r: +p[2], p: +p[3] };
  if (!(params.N >= 1024 && params.N <= 1 << 20)) return false;
  const want = Buffer.from(p[5], 'base64');
  const got = await scryptLimited(pw, Buffer.from(p[4], 'base64'), params);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// Заглушка, чтобы проверка несуществующего логина занимала столько же времени, сколько настоящая.
let DUMMY_HASH = '';
hashPassword(rid(12)).then(h => { DUMMY_HASH = h; });

/* Счётчики запросов (скользящее окно) */
const rlMap = new Map();
function rateLimit(key, limit, windowMs, msg) {
  const t = now();
  let e = rlMap.get(key);
  if (!e || e.reset < t) { e = { n: 0, reset: t + windowMs }; rlMap.set(key, e); }
  if (++e.n > limit) {
    const sec = Math.ceil((e.reset - t) / 1000);
    throw bad(msg || 'Слишком много запросов. Подожди немного.', 429, { retryAfter: sec });
  }
}
/* Блокировки после неудачных попыток входа: растут с каждым повтором */
const failMap = new Map();
function lockedFor(key) {
  const f = failMap.get(key);
  return f && f.until > now() ? f.until - now() : 0;
}
function addFail(key, max, baseMs) {
  const t = now();
  let f = failMap.get(key);
  if (!f || t - f.last > 6 * 3600e3) f = { n: 0, until: 0, last: t };
  f.n++; f.last = t;
  if (f.n >= max && f.n % max === 0) f.until = t + baseMs * 2 ** Math.min(5, f.n / max - 1);
  failMap.set(key, f);
}
setInterval(() => {
  const t = now();
  for (const [k, e] of rlMap) if (e.reset < t) rlMap.delete(k);
  for (const [k, f] of failMap) if (f.until < t && t - f.last > 6 * 3600e3) failMap.delete(k);
  q('DELETE FROM sessions WHERE expires_at<?').run(t);
  q('DELETE FROM invites WHERE expires_at<? AND used_by IS NULL').run(t - 24 * 3600e3);
  for (const [k, p] of probes) if (t - p.at > 40 * 60e3) probes.delete(k);
}, 60e3).unref();

function checkLoginLocks(ip, login) {
  const ms = Math.max(lockedFor('ip:' + ip), lockedFor('pair:' + ip + '|' + login), lockedFor('login:' + login));
  if (ms > 0) {
    const min = Math.ceil(ms / 60000);
    throw bad(`Слишком много неудачных попыток. Попробуй через ${min} мин.`, 429, { retryAfter: Math.ceil(ms / 1000) });
  }
}
function noteLoginFail(ip, login) {
  addFail('pair:' + ip + '|' + login, 5, 60e3);      // 5 промахов с одного адреса → 1, 2, 4… минут
  addFail('ip:' + ip, 20, 10 * 60e3);                // 20 промахов с адреса по любым логинам → 10+ минут
  addFail('login:' + login, 40, 15 * 60e3);          // распределённый перебор одного логина
}
function noteLoginOk(ip, login) { failMap.delete('pair:' + ip + '|' + login); }

function isPrivateIp(ip) {
  if (!ip) return true;
  ip = String(ip).toLowerCase();
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (!net.isIPv6(ip)) return true;
  const m4 = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (m4) return isPrivateIp(m4[1]);
  // раскрываем адрес до восьми групп
  let [head, tail] = ip.split('::');
  const hs = head ? head.split(':') : [], ts = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? hs : [...hs, ...Array(Math.max(0, 8 - hs.length - ts.length)).fill('0'), ...ts];
  const g = groups.map(x => parseInt(x, 16) || 0);
  if (g.slice(0, 7).every(x => x === 0) && (g[7] === 0 || g[7] === 1)) return true;         // ::, ::1
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return isPrivateIp(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  if ((g[0] & 0xfe00) === 0xfc00) return true;      // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true;      // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true;      // multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateIp(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  return false;
}
/** Адрес клиента. X-Forwarded-For верим только если запрос пришёл от локального прокси (nginx/caddy/docker). */
function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const xff = req.headers['x-forwarded-for'];
  if (xff && isPrivateIp(ip)) {
    const last = String(xff).split(',').pop().trim();
    if (net.isIP(last)) ip = last;
  }
  return ip || 'unknown';
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return false;
  if (o === ORIGIN) return true;
  if (!DOMAIN) { try { return new URL(o).host === req.headers.host; } catch { return false; } }
  return false;
}
function parseCookies(req) {
  const out = [];
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) out.push(part.slice(i + 1).trim());
  }
  return out;
}
function getSession(req) {
  const t = now();
  for (const token of parseCookies(req)) {
    if (!/^[\w-]{20,100}$/.test(token)) continue;
    const sid = sha256(token);
    const s = q('SELECT * FROM sessions WHERE id=?').get(sid);
    if (!s || s.expires_at < t) continue;
    const user = getUser(s.user_id);
    if (!user) continue;
    if (t - s.seen_at > 10 * 60e3) q('UPDATE sessions SET seen_at=?, expires_at=? WHERE id=?').run(t, t + SESSION_MS, sid);
    return { sid, user, via: s.via };
  }
  return null;
}
function setSessionCookie(res, token, framed) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', `Max-Age=${Math.floor(SESSION_MS / 1000)}`];
  // Внутри веб-версии Telegram сайт живёт во фрейме: там нужна «сторонняя» cookie. В остальных случаях — строгая Lax.
  if (SECURE && framed) parts.push('SameSite=None', 'Secure', 'Partitioned');
  else { parts.push('SameSite=Lax'); if (SECURE) parts.push('Secure'); }
  res.appendHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.appendHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${SECURE ? '; Secure' : ''}`);
  if (SECURE) res.appendHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=None; Secure; Partitioned`);
}
function createSession(c, user, via) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  q('INSERT INTO sessions(id,user_id,created_at,seen_at,expires_at,ua,ip,via) VALUES(?,?,?,?,?,?,?,?)')
    .run(sha256(token), user.id, t, t, t + SESSION_MS, String(c.req.headers['user-agent'] || '').slice(0, 200), c.ip, via);
  // не копим бесконечно: у одного человека не больше 20 живых сессий
  q('DELETE FROM sessions WHERE user_id=? AND id NOT IN (SELECT id FROM sessions WHERE user_id=? ORDER BY seen_at DESC LIMIT 20)').run(user.id, user.id);
  setSessionCookie(c.res, token, !!c.body?.framed);
}
function dropSessions(userId, exceptSid) {
  if (exceptSid) q('DELETE FROM sessions WHERE user_id=? AND id<>?').run(userId, exceptSid);
  else q('DELETE FROM sessions WHERE user_id=?').run(userId);
  for (const c of conns.values()) if (c.user.id === userId && c.sid !== exceptSid) c.close(4001, 'logout');
}

/** Проверка подписи данных запуска Mini App (HMAC-SHA256, ключ — HMAC токена бота с «WebAppData»). */
function verifyInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData || initData.length > 8192) return null;
  let p; try { p = new URLSearchParams(initData); } catch { return null; }
  const hash = p.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
  const pairs = [];
  for (const [k, v] of p) if (k !== 'hash') pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  if (!safeEq(calc, hash)) return null;
  const authDate = +p.get('auth_date') * 1000;
  if (!authDate || now() - authDate > 24 * 3600e3 || authDate - now() > 10 * 60e3) return null;
  let u; try { u = JSON.parse(p.get('user') || 'null'); } catch { return null; }
  if (!u || !Number.isSafeInteger(u.id) || u.is_bot) return null;
  return { id: u.id, name: cleanText([u.first_name, u.last_name].filter(Boolean).join(' '), 64), username: cleanText(u.username || '', 40) };
}
function linkTelegram(user, tg) {
  if (!tg || user.tg_id) return user;
  if (q('SELECT 1 AS x FROM users WHERE tg_id=?').get(tg.id)) return user;
  q('UPDATE users SET tg_id=?, tg_name=? WHERE id=?').run(tg.id, tg.username ? '@' + tg.username : tg.name, user.id);
  return getUser(user.id);
}

const userPublic = u => ({ id: u.id, name: u.name, role: u.role, avatar: u.avatar });
const userSelf = u => ({ ...userPublic(u), login: u.login, tg: !!u.tg_id, tgName: u.tg_name || '' });
function validLogin(s) {
  s = String(s ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,23}$/.test(s)) throw bad('Логин: 3–24 символа, латинские буквы, цифры, точка, дефис или подчёркивание');
  return s;
}
function validName(s) {
  s = cleanText(s, 32);
  if (!s) throw bad('Укажи имя');
  return s;
}
function validPassword(pw, login) {
  pw = String(pw ?? '');
  if (pw.length < 8) throw bad('Пароль должен быть не короче 8 символов');
  if (pw.length > 200) throw bad('Пароль слишком длинный');
  if (login && pw.toLowerCase() === String(login).toLowerCase()) throw bad('Пароль не должен совпадать с логином');
  if (/^(.)\1+$/.test(pw) || ['12345678', '123456789', '1234567890', 'password', 'qwertyui', 'qwerty123', '11111111', 'password1'].includes(pw.toLowerCase()))
    throw bad('Слишком простой пароль — придумай посложнее');
  return pw;
}

/* ═════════════════════════════ HTTP: основа ═════════════════════════════ */

const routes = [];
/** route('POST', '/api/x/:id', { auth: 'owner' }, ctx => result) */
function route(method, pattern, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opts, fn });
}
function send(res, status, obj) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, done = false;
    req.on('data', c => {
      if (done) return;
      n += c.length;
      if (n > limit) { done = true; reject(bad('Слишком большой запрос', 413)); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
    req.on('aborted', () => { if (!done) { done = true; reject(bad('Соединение прервано', 400)); } });
  });
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

/* index.html: читаем один раз, считаем хеши встроенных скриптов для строгой CSP, сжимаем */
let page = null;
function loadPage() {
  const st = fs.statSync(HTML_FILE);
  if (page && page.mtime === st.mtimeMs) return page;
  // Переводы строк приводим к \n: браузер считает хеш скрипта по нормализованному тексту.
  const html = fs.readFileSync(HTML_FILE, 'utf8').replace(/\r\n?/g, '\n');
  const raw = Buffer.from(html, 'utf8');
  const hashes = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  const csp = [
    "default-src 'self'",
    `script-src ${hashes.join(' ')} https://telegram.org`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "connect-src 'self' ws: wss:",
    "font-src 'self' data:",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'",
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
  ].join('; ');
  page = {
    mtime: st.mtimeMs, raw, csp,
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }),
    gz: zlib.gzipSync(raw, { level: 8 }),
    etag: `"${sha256(raw).slice(0, 20)}"`,
  };
  return page;
}
function sendIndex(req, res) {
  let p;
  try { p = loadPage(); } catch { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Нет index.html рядом с bot.js'); }
  const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'ETag': p.etag, 'Content-Security-Policy': p.csp, 'Vary': 'Accept-Encoding' };
  if (req.headers['if-none-match'] === p.etag) { res.writeHead(304, h); return res.end(); }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = p.raw;
  if (/\bbr\b/.test(ae)) { body = p.br; h['Content-Encoding'] = 'br'; }
  else if (/\bgzip\b/.test(ae)) { body = p.gz; h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
}
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#000"/><circle cx="32" cy="32" r="17" fill="none" stroke="#fff" stroke-width="3.5"/><path d="M32 15a17 17 0 0 1 0 34z" fill="#fff"/></svg>';

function imageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  return null;
}
const MIME = { '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.vtt': 'text/vtt; charset=utf-8', '.jpg': 'image/jpeg' };
/** Отдача файла с поддержкой Range (перемотка) и условных запросов. */
async function sendFile(req, res, file, type, cache = 'private, max-age=86400') {
  let st;
  try { st = await fsp.stat(file); } catch { res.writeHead(404); return res.end(); }
  if (!st.isFile()) { res.writeHead(404); return res.end(); }
  const size = st.size;
  if (type === 'image') {
    const fd = await fsp.open(file, 'r');
    const head = Buffer.alloc(16);
    try { await fd.read(head, 0, 16, 0); } finally { await fd.close(); }
    type = imageType(head) || 'application/octet-stream';
  }
  const etag = `"${size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'ETag': etag, 'Cache-Control': cache, 'Last-Modified': st.mtime.toUTCString() };
  const range = req.headers.range;
  if (!range && req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
  let start = 0, end = size - 1, status = 200;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') start = Math.max(0, size - +m[2]);
    else { start = +m[1]; if (m[2] !== '') end = Math.min(end, +m[2]); }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
      return res.end();
    }
    status = 206;
    h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  h['Content-Length'] = size ? end - start + 1 : 0;
  res.writeHead(status, h);
  if (req.method === 'HEAD' || !size) return res.end();
  const rs = fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}
const MEDIA_FILE_RE = /^(v_[a-z0-9]+\.mp4|track\.(mp3|m4a|flac)|poster\.jpg|cover\.jpg|sub_\d+\.vtt)$/;
const mediaDir = id => path.join(MEDIA_DIR, id);

async function onRequest(req, res) {
  securityHeaders(res);
  let url;
  try { url = new URL(req.url, ORIGIN); } catch { res.writeHead(400); return res.end(); }
  const p = url.pathname;
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/' || /^\/(i|r)\/[\w-]{1,64}$/.test(p)) return sendIndex(req, res);
      if (p === '/favicon.svg' || p === '/favicon.ico') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800' });
        return res.end(ICON_SVG);
      }
      // Медиа и аватары: доступ проверяется на каждый запрос, включая каждый Range-кусок.
      let m;
      if ((m = /^\/m\/([\w-]{6,24})\/([\w.]+)$/.exec(p))) {
        if (!getSession(req)) { res.writeHead(401, { 'Cache-Control': 'no-store' }); return res.end(); }
        if (!MEDIA_FILE_RE.test(m[2])) { res.writeHead(404); return res.end(); }
        const ext = path.extname(m[2]);
        return await sendFile(req, res, path.join(mediaDir(m[1]), m[2]), /^(poster|cover)\./.test(m[2]) ? 'image' : MIME[ext]);
      }
      if ((m = /^\/avatar\/(\d+)$/.exec(p))) {
        if (!getSession(req)) { res.writeHead(401, { 'Cache-Control': 'no-store' }); return res.end(); }
        return await sendFile(req, res, path.join(AVATAR_DIR, m[1]), 'image');
      }
    }
    if (p.startsWith('/api/')) return await handleApi(req, res, url);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  } catch (e) {
    if (!(e instanceof HttpError)) log('http', req.method, p, e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Внутренняя ошибка сервера', ...(e.extra || {}) });
    else res.destroy();
  }
}
async function handleApi(req, res, url) {
  const p = url.pathname;
  let found = null, params = {};
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(p);
    if (m) { found = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
  }
  if (!found) throw bad('Не найдено', 404);
  const ip = clientIp(req);
  // Любой изменяющий запрос должен прийти с нашей же страницы: защита от CSRF.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req))
    throw bad('Запрос отклонён: неверный источник (Origin). Проверь DOMAIN в .env', 403);
  if (!found.opts.noLimit) rateLimit('api:' + ip, 900, 60e3);
  const session = getSession(req);
  const c = { req, res, url, params, query: url.searchParams, ip, session, user: session?.user || null, body: null };
  if (found.opts.auth !== false) {
    if (!session) throw bad('Нужно войти', 401);
    if (found.opts.auth === 'owner' && c.user.role !== 'owner') throw bad('Это может только владелец', 403);
  }
  if (found.opts.body === 'raw') { /* обработчик сам читает поток */ }
  else if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    const buf = await readBody(req, found.opts.limit || 256 * 1024);
    if (found.opts.body === 'buffer') c.body = buf;
    else {
      if (buf.length && !/^application\/json/i.test(req.headers['content-type'] || '')) throw bad('Ожидался JSON', 415);
      try { c.body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { throw bad('Некорректный JSON'); }
      if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) throw bad('Некорректный JSON');
    }
  }
  const out = await found.fn(c);
  if (!res.headersSent) send(res, 200, out === undefined ? { ok: true } : out);
}

/* ═════════════════════════════ API: вход и аккаунты ═════════════════════════════ */

function bootInfo(user) {
  return {
    me: userSelf(user),
    ice: iceServers(),
    tools: { ffmpeg: tools.ffmpeg, ytdlp: ytdlp.ok },
    canAddMusic: user.role === 'owner' || getSetting('friends_music') === '1',
    reactions: REACTIONS,
    chunk: CHUNK_SIZE,
  };
}
function iceServers() {
  const list = [{ urls: (env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478').split(',').map(s => s.trim()).filter(Boolean) }];
  if (env.TURN_URL) list.push({ urls: env.TURN_URL.split(',').map(s => s.trim()), username: env.TURN_USER || '', credential: env.TURN_PASS || '' });
  return list;
}
route('GET', '/api/boot', { auth: false }, c => ({
  app: APP_NAME,
  hasOwner: hasOwner(),
  bot: bot.ok ? { username: bot.username, mainApp: bot.mainApp } : null,
  ...(c.user ? bootInfo(c.user) : { me: null }),
}));

route('POST', '/api/auth/telegram', { auth: false }, c => {
  rateLimit('tga:' + c.ip, 30, 60e3);
  const tg = verifyInitData(c.body.initData);
  if (!tg) throw bad('Не удалось проверить данные Telegram', 403);
  // Уже вошли по паролю — просто привязываем Telegram к этому аккаунту.
  if (c.user) return bootInfo(linkTelegram(c.user, tg));
  const user = q('SELECT * FROM users WHERE tg_id=?').get(tg.id);
  if (!user) return { me: null, tgName: tg.name, ownerByTg: !hasOwner() && !!OWNER_TG_ID && tg.id === OWNER_TG_ID };
  createSession(c, user, 'tg');
  return bootInfo(user);
});

route('POST', '/api/auth/login', { auth: false }, async c => {
  rateLimit('login:' + c.ip, 30, 60e3);
  const login = String(c.body.login ?? '').trim().toLowerCase().slice(0, 64);
  const password = String(c.body.password ?? '');
  if (!login || !password) throw bad('Введи логин и пароль');
  checkLoginLocks(c.ip, login);
  const user = q('SELECT * FROM users WHERE login=?').get(login);
  const ok = await verifyPassword(password.slice(0, 200), user ? user.pass : DUMMY_HASH);
  if (!user || !ok) {
    noteLoginFail(c.ip, login);
    await sleep(250 + Math.random() * 250);
    throw bad('Неверный логин или пароль', 401);
  }
  noteLoginOk(c.ip, login);
  const linked = linkTelegram(user, verifyInitData(c.body.initData));
  createSession(c, linked, 'web');
  return bootInfo(linked);
});

route('GET', '/api/invite/:code', { auth: false }, c => {
  rateLimit('inv:' + c.ip, 20, 60e3);
  const inv = q('SELECT * FROM invites WHERE code=?').get(c.params.code);
  if (!inv || inv.used_by != null || inv.expires_at < now()) throw bad('Приглашение недействительно или уже использовано', 404);
  return { ok: true, expires: inv.expires_at, by: getUser(inv.created_by)?.name || '' };
});

route('POST', '/api/auth/register', { auth: false }, async c => {
  rateLimit('reg:' + c.ip, 12, 3600e3, 'Слишком много попыток регистрации. Попробуй позже.');
  const code = String(c.body.invite ?? '');
  const login = validLogin(c.body.login);
  const name = validName(c.body.name);
  const password = validPassword(c.body.password, login);
  const inv = q('SELECT * FROM invites WHERE code=?').get(code);
  if (!inv || inv.used_by != null || inv.expires_at < now()) throw bad('Приглашение недействительно или уже использовано', 403);
  if (q('SELECT 1 AS x FROM users WHERE login=?').get(login)) throw bad('Этот логин уже занят', 409);
  const pass = await hashPassword(password);
  const tg = verifyInitData(c.body.initData);
  // Приглашение одноразовое: гасим его и создаём аккаунт одной транзакцией.
  const user = tx(() => {
    const used = q('UPDATE invites SET used_by=0, used_at=? WHERE code=? AND used_by IS NULL AND expires_at>?').run(now(), code, now());
    if (!used.changes) throw bad('Приглашение недействительно или уже использовано', 403);
    if (q('SELECT 1 AS x FROM users WHERE login=?').get(login)) throw bad('Этот логин уже занят', 409);
    const r = q("INSERT INTO users(login,name,role,pass,created_at) VALUES(?,?,'friend',?,?)").run(login, name, pass, now());
    q('UPDATE invites SET used_by=? WHERE code=?').run(Number(r.lastInsertRowid), code);
    return getUser(Number(r.lastInsertRowid));
  });
  const linked = linkTelegram(user, tg);
  createSession(c, linked, 'web');
  broadcast({ t: 'users' });
  log('auth', `новый друг: ${login}`);
  return bootInfo(linked);
});

route('POST', '/api/auth/setup', { auth: false }, async c => {
  rateLimit('setup:' + c.ip, 8, 10 * 60e3, 'Слишком много попыток. Попробуй позже.');
  if (hasOwner()) throw bad('Владелец уже создан', 409);
  const tg = verifyInitData(c.body.initData);
  const byCode = !!SETUP_CODE && safeEq(String(c.body.code ?? '').trim(), SETUP_CODE);
  const byTg = !!tg && !!OWNER_TG_ID && tg.id === OWNER_TG_ID;
  if (!byCode && !byTg) throw bad('Неверный код настройки. Он напечатан в логе сервера при запуске.', 403);
  const login = validLogin(c.body.login);
  const name = validName(c.body.name);
  const password = validPassword(c.body.password, login);
  const pass = await hashPassword(password);
  const user = tx(() => {
    if (hasOwner()) throw bad('Владелец уже создан', 409);
    const r = q("INSERT INTO users(login,name,role,pass,created_at) VALUES(?,?,'owner',?,?)").run(login, name, pass, now());
    return getUser(Number(r.lastInsertRowid));
  });
  SETUP_CODE = '';
  const linked = linkTelegram(user, tg);
  createSession(c, linked, 'web');
  log('auth', `владелец создан: ${login}`);
  return bootInfo(linked);
});

route('POST', '/api/auth/logout', {}, c => {
  q('DELETE FROM sessions WHERE id=?').run(c.session.sid);
  for (const k of conns.values()) if (k.sid === c.session.sid) k.close(4001, 'logout');
  clearSessionCookie(c.res);
});
route('POST', '/api/auth/logout-all', {}, c => {
  dropSessions(c.user.id);
  clearSessionCookie(c.res);
});

route('PATCH', '/api/me', {}, c => {
  const name = validName(c.body.name);
  q('UPDATE users SET name=? WHERE id=?').run(name, c.user.id);
  broadcast({ t: 'users' });
  return { me: userSelf(getUser(c.user.id)) };
});
route('POST', '/api/me/password', {}, async c => {
  rateLimit('pw:' + c.user.id, 10, 10 * 60e3);
  if (!(await verifyPassword(String(c.body.current ?? '').slice(0, 200), c.user.pass))) {
    await sleep(300);
    throw bad('Текущий пароль неверный', 403);
  }
  const pass = await hashPassword(validPassword(c.body.next, c.user.login));
  q('UPDATE users SET pass=? WHERE id=?').run(pass, c.user.id);
  dropSessions(c.user.id, c.session.sid);   // остальные устройства выходят
});
route('POST', '/api/me/avatar', { body: 'buffer', limit: 600 * 1024 }, async c => {
  const type = imageType(c.body);
  if (!type || type === 'image/gif') throw bad('Нужна картинка JPEG, PNG или WebP');
  await fsp.writeFile(path.join(AVATAR_DIR, String(c.user.id)), c.body);
  q('UPDATE users SET avatar=? WHERE id=?').run(now(), c.user.id);
  broadcast({ t: 'users' });
  return { me: userSelf(getUser(c.user.id)) };
});
route('DELETE', '/api/me/avatar', {}, async c => {
  await fsp.rm(path.join(AVATAR_DIR, String(c.user.id)), { force: true });
  q('UPDATE users SET avatar=0 WHERE id=?').run(c.user.id);
  broadcast({ t: 'users' });
  return { me: userSelf(getUser(c.user.id)) };
});
route('POST', '/api/me/unlink-telegram', {}, c => {
  q('UPDATE users SET tg_id=NULL, tg_name=NULL WHERE id=?').run(c.user.id);
  return { me: userSelf(getUser(c.user.id)) };
});

route('GET', '/api/users', {}, c => {
  const owner = c.user.role === 'owner';
  const rows = q("SELECT * FROM users ORDER BY role='owner' DESC, name COLLATE NOCASE").all();
  return {
    users: rows.map(u => owner
      ? { ...userPublic(u), login: u.login, created: u.created_at, seen: u.seen_at, tg: !!u.tg_id }
      : userPublic(u)),
    online: onlineIds(),
  };
});
route('DELETE', '/api/users/:id', { auth: 'owner' }, async c => {
  const id = +c.params.id;
  const u = getUser(id);
  if (!u) throw bad('Нет такого пользователя', 404);
  if (u.role === 'owner') throw bad('Владельца удалить нельзя');
  dropSessions(id);
  q('DELETE FROM users WHERE id=?').run(id);
  await fsp.rm(path.join(AVATAR_DIR, String(id)), { force: true });
  broadcast({ t: 'users' });
  log('auth', `друг удалён: ${u.login}`);
});

function inviteView(inv) {
  return {
    code: inv.code, created: inv.created_at, expires: inv.expires_at,
    url: `${PUBLIC_URL}/i/${inv.code}`,
    tgUrl: bot.ok ? tgLink('inv_' + inv.code) : null,
  };
}
route('GET', '/api/invites', { auth: 'owner' }, () => ({
  invites: q('SELECT * FROM invites WHERE used_by IS NULL AND expires_at>? ORDER BY created_at DESC').all(now()).map(inviteView),
}));
route('POST', '/api/invites', { auth: 'owner' }, c => {
  rateLimit('mkinv:' + c.user.id, 30, 3600e3);
  const code = rid(16);
  q('INSERT INTO invites(code,created_by,created_at,expires_at) VALUES(?,?,?,?)').run(code, c.user.id, now(), now() + 7 * 24 * 3600e3);
  return { invite: inviteView(q('SELECT * FROM invites WHERE code=?').get(code)) };
});
route('DELETE', '/api/invites/:code', { auth: 'owner' }, c => {
  q('DELETE FROM invites WHERE code=? AND used_by IS NULL').run(c.params.code);
});

/* ═════════════════════════════ Внешние процессы ═════════════════════════════ */

const { StringDecoder } = require('node:string_decoder');
const tasks = new Map();   // mediaId → { procs:Set, cancelled }
function newTask(id) { const t = { procs: new Set(), aborts: new Set(), cancelled: false }; tasks.set(id, t); return t; }
function taskOf(id) { return tasks.get(id) || newTask(id); }
function killProc(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    else process.kill(-child.pid, 'SIGKILL');     // вся группа: yt-dlp вместе с его ffmpeg
  } catch { try { child.kill('SIGKILL'); } catch {} }
}
function cancelTask(id) {
  const t = tasks.get(id);
  if (!t) return;
  t.cancelled = true;
  for (const p of t.procs) killProc(p);
  for (const f of t.aborts) { try { f(); } catch {} }
}
const SPAWN_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') };
/**
 * Запуск процесса. Возвращает { code, stdout, stderr (хвост), timedOut, spawnError }.
 * onLine — построчный разбор stdout; stall — убить, если процесс молчит дольше N мс.
 */
function run(cmd, args, { timeout = 0, stall = 0, onLine, task, maxOut = 128 * 1024 * 1024, cwd } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(cmd, args, { cwd, env: SPAWN_ENV, windowsHide: true, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e.message), spawnError: true }); }
    task?.procs.add(child);
    const out = []; let outLen = 0, errTail = '', timedOut = false, done = false, lastAct = now(), lineBuf = '', spawnError = false;
    const dec = new StringDecoder('utf8'), edec = new StringDecoder('utf8');
    const tm = timeout ? setTimeout(() => { timedOut = true; killProc(child); }, timeout) : null;
    const st = stall ? setInterval(() => {
      const ms = typeof stall === 'function' ? stall() : stall;
      if (ms && now() - lastAct > ms) { timedOut = true; killProc(child); }
    }, 5000) : null;
    const finish = code => {
      if (done) return; done = true;
      clearTimeout(tm); clearInterval(st); task?.procs.delete(child);
      if (onLine && lineBuf) { try { onLine(lineBuf); } catch {} }
      resolve({ code, stdout: onLine ? '' : Buffer.concat(out).toString('utf8'), stderr: errTail, timedOut, spawnError });
    };
    child.stdout.on('data', d => {
      lastAct = now();
      if (onLine) {
        lineBuf += dec.write(d);
        let i;
        while ((i = lineBuf.search(/[\r\n]/)) >= 0) {
          const line = lineBuf.slice(0, i); lineBuf = lineBuf.slice(i + 1);
          if (line) { try { onLine(line); } catch (e) { log('run', e); } }
        }
      } else if (outLen < maxOut) { out.push(d); outLen += d.length; }
    });
    child.stderr.on('data', d => { lastAct = now(); errTail = (errTail + edec.write(d)).slice(-20000); });
    child.on('error', e => { spawnError = true; errTail += String(e.message); finish(-1); });
    child.on('close', code => finish(code ?? -1));
  });
}
const lastLines = (s, n = 12) => String(s || '').trim().split(/\r?\n/).slice(-n).join('\n');

const tools = { ffmpeg: false, ffprobe: false, tonemap: false, encoder: 'libx264', version: '' };
async function detectTools() {
  const v = await run(BIN.ffmpeg, ['-hide_banner', '-version'], { timeout: 20000 });
  const p = await run(BIN.ffprobe, ['-hide_banner', '-version'], { timeout: 20000 });
  tools.ffprobe = p.code === 0;
  tools.ffmpeg = v.code === 0 && tools.ffprobe;
  tools.version = (/ffmpeg version (\S+)/.exec(v.stdout) || [])[1] || '';
  if (!tools.ffmpeg) return log('ffmpeg', 'НЕ НАЙДЕН — загрузка и обработка файлов работать не будут. Установи ffmpeg.');
  const f = await run(BIN.ffmpeg, ['-hide_banner', '-filters'], { timeout: 20000 });
  tools.tonemap = /\bzscale\b/.test(f.stdout) && /\btonemap\b/.test(f.stdout);
  const e = await run(BIN.ffmpeg, ['-hide_banner', '-encoders'], { timeout: 20000 });
  tools.encoder = /\blibx264\b/.test(e.stdout) ? 'libx264' : /\blibopenh264\b/.test(e.stdout) ? 'libopenh264' : 'libx264';
  log('ffmpeg', `версия ${tools.version}, кодировщик ${tools.encoder}${tools.tonemap ? ', HDR→SDR доступен' : ''}`);
}
async function ffprobe(target, extra = []) {
  const r = await run(BIN.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extra, target], { timeout: 180000 });
  if (r.spawnError) throw new UserError('На сервере не установлен ffmpeg/ffprobe', 'notools');
  if (r.code !== 0) { log('ffprobe', lastLines(r.stderr, 4)); throw new UserError('Файл не читается: он повреждён или это не видео/аудио', 'badfile'); }
  try { return JSON.parse(r.stdout); } catch { throw new UserError('Файл не читается: он повреждён или это не видео/аудио', 'badfile'); }
}
/** ffmpeg с разбором прогресса (-progress pipe:1). */
function ffmpegRun(args, duration, onProgress, task) {
  return run(BIN.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    task,
    onLine: line => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && duration > 0 && onProgress) onProgress(clamp(+m[1] / 1e6 / duration, 0, 0.999));
    },
  });
}
async function diskInfo() {
  try {
    const s = await fsp.statfs(DATA_DIR);
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch { return { free: 0, total: 0 }; }
}
async function dirSize(dir) {
  let n = 0;
  try { for (const f of await fsp.readdir(dir)) { try { const st = await fsp.stat(path.join(dir, f)); if (st.isFile()) n += st.size; } catch {} } } catch {}
  return n;
}
function fmtSize(b) {
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(1).replace('.', ',') + ' ГБ';
  if (b >= 1 << 20) return Math.round(b / (1 << 20)) + ' МБ';
  return Math.max(1, Math.round(b / 1024)) + ' КБ';
}
async function moveFile(from, to) {
  try { await fsp.rename(from, to); }
  catch (e) { if (e.code !== 'EXDEV') throw e; await fsp.copyFile(from, to); await fsp.rm(from, { force: true }); }
}
const fileOk = f => { try { return fs.statSync(f).size > 0; } catch { return false; } };

/* ═════════════════════════════ Библиотека: состояние и рассылка ═════════════════════════════ */

const live = new Map();   // mediaId → { progress, stage, speed, eta, v:{variantId:progress}, timer }
function liveOf(id) { let l = live.get(id); if (!l) { l = { v: {} }; live.set(id, l); } return l; }
function schedProg(id, l) {
  if (l.timer) return;
  l.timer = setTimeout(() => {
    l.timer = null;
    if (live.get(id) === l) broadcast({ t: 'prog', id, progress: l.progress, stage: l.stage, speed: l.speed, eta: l.eta, v: l.v });
  }, 350);
}
function liveSet(id, patch) { const l = liveOf(id); Object.assign(l, patch); schedProg(id, l); }
function liveVar(id, vid, p) { const l = liveOf(id); l.v[vid] = p; schedProg(id, l); }
function mediaView(m) {
  const l = live.get(m.id);
  return {
    id: m.id, kind: m.kind, title: m.title, artist: m.artist, status: m.status,
    stage: l?.stage ?? m.stage, progress: l?.progress ?? m.progress, speed: l?.speed || 0, eta: l?.eta || 0,
    error: m.error, retry: m.retry, duration: m.duration, w: m.w, h: m.h, fps: m.fps, size: m.size,
    origin: m.origin, poster: m.poster, file: m.file, created: m.created_at, by: m.added_by,
    variants: m.kind !== 'video' ? [] : q('SELECT * FROM variants WHERE media_id=? ORDER BY height DESC, id').all(m.id).map(v => ({
      id: v.id, kind: v.kind, label: v.label, height: v.height, w: v.w, h: v.h, fps: v.fps, vcodec: v.vcodec,
      status: v.status, size: v.size, file: v.status === 'ready' ? v.file : null,
      progress: v.status === 'ready' ? 1 : (l?.v?.[v.id] || 0),
    })),
    subs: m.kind !== 'video' ? [] : q('SELECT id,lang,label,file FROM subs WHERE media_id=? ORDER BY id').all(m.id),
  };
}
function broadcastMedia(id) { const m = getMedia(id); if (m) broadcast({ t: 'media', media: mediaView(m) }); }
function setMedia(id, patch) {
  upd('media', id, patch);
  const l = live.get(id);
  if (l && ('status' in patch || 'stage' in patch || 'progress' in patch)) { delete l.progress; delete l.stage; delete l.speed; delete l.eta; }
  broadcastMedia(id);
}
function failMedia(id, e) {
  const msg = e && e.user ? e.message : 'Не удалось обработать файл';
  if (!(e && e.user)) log('media', id, e);
  if (getMedia(id)) setMedia(id, { status: 'error', error: msg, retry: 1, stage: '' });
}
async function deleteMedia(id) {
  cancelTask(id);
  dlQueue = dlQueue.filter(x => x !== id);
  roomsDropMedia(id);
  const ups = q('SELECT id FROM uploads WHERE media_id=?').all(id);
  for (const u of ups) await closeUpload(u.id);
  q('DELETE FROM uploads WHERE media_id=?').run(id);
  q('DELETE FROM variants WHERE media_id=?').run(id);
  q('DELETE FROM subs WHERE media_id=?').run(id);
  q('DELETE FROM media WHERE id=?').run(id);
  live.delete(id);
  broadcast({ t: 'media-del', id });
  const rm = () => fsp.rm(mediaDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  await rm().catch(() => {});
  setTimeout(() => { rm().catch(() => {}); fsp.rm(path.join(TMP_DIR, id), { recursive: true, force: true }).catch(() => {}); }, 3000);
  pumpTranscodes();
}

/* ═════════════════════════════ Разбор файла ═════════════════════════════ */

const even = x => Math.max(2, Math.round(x / 2) * 2);
function fpsOf(s) {
  const f = r => { const [a, b] = String(r || '').split('/').map(Number); return b ? a / b : (a || 0); };
  let v = f(s.avg_frame_rate);
  if (!(v > 1 && v <= 240)) v = f(s.r_frame_rate);
  if (!(v > 1 && v <= 240)) v = 25;
  return Math.round(v * 1000) / 1000;
}
/** «Номинальная» высота: 1920×800 — это 1080p, вертикальное 1080×1920 — тоже 1080p. */
function nominalOf(w, h) {
  const long = Math.max(w, h), short = Math.min(w, h);
  const n = Math.max(short, Math.round(long * 9 / 16));
  for (const s of STD_HEIGHTS) if (Math.abs(n - s) / s <= 0.07) return s;
  return n;
}
function qualityLabel(nominal, fps) {
  const base = nominal >= 4000 ? '8K' : nominal >= 2000 ? '4K' : nominal >= 1400 ? '2K' : `${nominal}p`;
  return base + (fps >= 49 ? String(Math.round(fps)) : '');
}
const TEXT_SUBS = ['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'];
const LANG_NAMES = { rus: 'Русские', ru: 'Русские', eng: 'English', en: 'English', ukr: 'Українські', uk: 'Українські', ger: 'Deutsch', deu: 'Deutsch', de: 'Deutsch', fre: 'Français', fra: 'Français', fr: 'Français', spa: 'Español', es: 'Español', ita: 'Italiano', it: 'Italiano', jpn: '日本語', ja: '日本語', kor: '한국어', ko: '한국어', chi: '中文', zho: '中文', zh: '中文' };
function analyze(probe) {
  const streams = probe.streams || [];
  const isPic = s => s.disposition?.attached_pic === 1;
  const v = streams.find(s => s.codec_type === 'video' && !isPic(s) && !['mjpeg', 'png', 'bmp', 'gif', 'webp'].includes(s.codec_name))
    || streams.find(s => s.codec_type === 'video' && !isPic(s)) || null;
  const audios = streams.filter(s => s.codec_type === 'audio');
  const langOf = s => String(s.tags?.language || s.tags?.LANGUAGE || '').toLowerCase();
  const isRu = s => /^(ru|rus)$/.test(langOf(s)) || /рус|russian/i.test(String(s.tags?.title || ''));
  // Русская дорожка — по умолчанию.
  const a = audios.find(s => isRu(s) && s.disposition?.default) || audios.find(isRu) || audios.find(s => s.disposition?.default) || audios[0] || null;
  const duration = +probe.format?.duration || +(v?.duration) || +(a?.duration) || 0;
  let w = v ? +v.width || 0 : 0, h = v ? +v.height || 0 : 0;
  const sar = /^(\d+):(\d+)$/.exec(v?.sample_aspect_ratio || '');
  if (sar && +sar[1] > 0 && +sar[2] > 0 && sar[1] !== sar[2]) w = even(w * +sar[1] / +sar[2]);
  const rot = Math.abs(+(v?.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0)) % 180;
  if (rot === 90) [w, h] = [h, w];
  return {
    v, a, duration, w, h,
    fps: v ? fpsOf(v) : 0,
    h264ok: !!v && v.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(v.pix_fmt),
    hdr: !!v && ['smpte2084', 'arib-std-b67'].includes(v.color_transfer),
    interlaced: !!v && ['tt', 'bb', 'tb', 'bt'].includes(v.field_order),
    subs: streams.filter(s => s.codec_type === 'subtitle' && TEXT_SUBS.includes(s.codec_name)),
    cover: streams.find(s => s.codec_type === 'video' && (isPic(s) || ['mjpeg', 'png'].includes(s.codec_name))) || null,
    langOf,
  };
}
function titleFromName(name) {
  return cleanText(String(name).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[._]+/g, ' '), 160) || 'Без названия';
}
function insertVariant(v) {
  const r = q('INSERT INTO variants(media_id,kind,label,height,w,h,fps,vcodec,file,status,prio) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(v.media_id, v.kind, v.label, v.height, v.w, v.h, v.fps, v.vcodec, v.file, v.status, v.prio);
  return Number(r.lastInsertRowid);
}

/* ═════════════════════════════ Обработка после загрузки ═════════════════════════════ */

const subsBusy = new Set();
/**
 * ctx: { task, infoJson?, thumb?, info? } — для загрузок по ссылке передаём превью и список форматов сайта.
 */
async function processMedia(id, ctx = {}) {
  const m = getMedia(id);
  if (!m) return;
  const task = ctx.task || newTask(id);
  ctx.task = task;
  try {
    if (!tools.ffmpeg) throw new UserError('На сервере не установлен ffmpeg — обработка невозможна', 'notools');
    setMedia(id, { status: 'processing', stage: 'Анализ файла', progress: 0, error: '', retry: 0 });
    const input = path.join(mediaDir(id), m.orig_file || '');
    if (!m.orig_file || !fileOk(input)) throw new UserError('Исходный файл не найден — загрузи его заново');
    const probe = await ffprobe(input);
    if (task.cancelled) return;
    if (m.kind === 'audio') await processAudio(m, input, probe, ctx);
    else await processVideo(m, input, probe, ctx);
  } catch (e) {
    if (task.cancelled || !getMedia(id)) return;
    failMedia(id, e);
  }
}

async function makePoster(input, dir, duration, task) {
  const out = path.join(dir, 'poster.jpg');
  for (const t of [clamp(duration * 0.12, 0, 600), 0]) {
    const r = await run(BIN.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', t.toFixed(2), '-i', input,
      '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-update', '1', out], { task, timeout: 180000 });
    if (r.code === 0 && fileOk(out)) return true;
  }
  return false;
}
/** Картинка (превью с сайта, обложка из файла) → аккуратный JPEG. */
async function imageToJpeg(src, out, square, task, map) {
  const vf = square ? "crop='min(iw,ih)':'min(iw,ih)',scale=600:600" : "scale='min(640,iw)':-2";
  const r = await run(BIN.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, ...(map ? ['-map', map] : []),
    '-frames:v', '1', '-vf', vf, '-q:v', '3', '-update', '1', out], { task, timeout: 60000 });
  return r.code === 0 && fileOk(out);
}

async function processVideo(m, input, probe, ctx) {
  const task = ctx.task, dir = mediaDir(m.id);
  const an = analyze(probe);
  if (!an.v || !an.w || !an.h) throw new UserError('В файле нет видеодорожки');
  const nominal = nominalOf(an.w, an.h);
  const codec = an.v.codec_name;
  const meta = { vi: an.v.index, ai: an.a ? an.a.index : -1, hasAudio: !!an.a, interlaced: an.interlaced, hdr: an.hdr, nominal, vcodec: codec };
  setMedia(m.id, { duration: an.duration, w: an.w, h: an.h, fps: an.fps, meta: JSON.stringify(meta), stage: 'Подготовка' });

  // Постер: превью с сайта, а для файлов — кадр из фильма.
  let poster = false;
  if (ctx.thumb) poster = await imageToJpeg(ctx.thumb, path.join(dir, 'poster.jpg'), false, task);
  if (!poster) poster = await makePoster(input, dir, an.duration, task);
  if (task.cancelled) return;
  if (poster) setMedia(m.id, { poster: now() });

  q('DELETE FROM variants WHERE media_id=?').run(m.id);
  q('DELETE FROM subs WHERE media_id=?').run(m.id);
  const label = qualityLabel(nominal, an.fps);
  // То, что браузеры умеют играть, не пересжимаем: только перекладываем в MP4 (faststart, без глав и метаданных).
  const copyable = (codec === 'h264' && an.h264ok) || ['hevc', 'vp9', 'av1'].includes(codec);
  let ready = false;
  if (copyable) {
    const vid = insertVariant({ media_id: m.id, kind: 'source', label, height: nominal, w: an.w, h: an.h, fps: an.fps, vcodec: codec, file: 'v_src.mp4', status: 'working', prio: 0 });
    try {
      await remuxSource(m, input, an, task);
      upd('variants', vid, { status: 'ready', size: fs.statSync(path.join(dir, 'v_src.mp4')).size });
      ready = true;
    } catch (e) {
      if (task.cancelled) return;
      log('media', m.id, 'перепаковка без пересжатия не удалась, перекодирую:', e.message);
      q('DELETE FROM variants WHERE id=?').run(vid);
      await fsp.rm(path.join(dir, 'v_src.tmp.mp4'), { force: true });
    }
  }
  const srcCodec = ready ? codec : 'h264';
  if (!ready) {
    // Старый или несовместимый кодек → H.264 того же разрешения и частоты кадров (первым в очереди).
    insertVariant({ media_id: m.id, kind: 'source', label, height: nominal, w: even(an.w), h: even(an.h), fps: an.fps, vcodec: 'h264', file: 'v_src.mp4', status: 'pending', prio: 0 });
  }
  // Лесенка качеств в H.264. Для VP9/HEVC/AV1 добавляем ещё и совместимую версию в исходном разрешении (не выше 2K).
  const hold = !!ctx.info;
  const targets = LADDER.filter(t => t < nominal * 0.94);
  if (srcCodec !== 'h264') { const top = Math.min(nominal, 1440); if (!targets.includes(top)) targets.push(top); }
  for (const t of targets) {
    const k = t / nominal;
    insertVariant({ media_id: m.id, kind: 'h264', label: qualityLabel(t, an.fps), height: t, w: even(an.w * k), h: even(an.h * k), fps: an.fps,
      vcodec: 'h264', file: `v_${t}.mp4`, status: hold ? 'held' : 'pending', prio: t <= 720 ? 1 : 2 });
  }
  if (ready) setMedia(m.id, { status: 'ready', stage: '', progress: 1, size: await dirSize(dir) });
  else setMedia(m.id, { stage: 'Перекодирование в H.264', progress: 0 });
  pumpTranscodes();

  // Субтитры и готовые версии с сайта — уже в фоне, фильм можно смотреть.
  subsBusy.add(m.id);
  try {
    if (an.subs.length) await extractSubs(m, input, an, task);
    if (ctx.info && !task.cancelled) await fetchSiteVersions(m.id, ctx, an);
  } catch (e) { if (!task.cancelled) log('media', m.id, e); }
  finally {
    subsBusy.delete(m.id);
    if (!task.cancelled && getMedia(m.id)) {
      q("UPDATE variants SET status='pending' WHERE media_id=? AND status='held'").run(m.id);
      broadcastMedia(m.id);
      pumpTranscodes();
      await cleanupOrig(m.id);
    }
  }
}

async function remuxSource(m, input, an, task) {
  const dir = mediaDir(m.id), out = path.join(dir, 'v_src.mp4'), tmp = path.join(dir, 'v_src.tmp.mp4');
  const args = ['-fflags', '+genpts', '-i', input, '-map', `0:${an.v.index}`];
  if (an.a) args.push('-map', `0:${an.a.index}`);
  args.push('-c:v', 'copy');
  if (an.v.codec_name === 'hevc') args.push('-tag:v', 'hvc1');
  if (an.a) args.push(...(an.a.codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']));
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', tmp);
  const r = await ffmpegRun(args, an.duration, p => liveSet(m.id, { progress: p, stage: 'Подготовка без пересжатия' }), task);
  if (task.cancelled) throw new Error('cancelled');
  if (r.code !== 0) throw new Error(lastLines(r.stderr, 3));
  const chk = analyze(await ffprobe(tmp));
  if (!chk.v || (an.duration > 0 && chk.duration < an.duration * 0.97 - 2)) throw new Error('файл после перепаковки короче исходного');
  await fsp.rename(tmp, out);
}

async function extractSubs(m, input, an, task) {
  const dir = mediaDir(m.id);
  const subs = an.subs.slice(0, 16);
  const outOf = i => path.join(dir, `sub_${i}.vtt`);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input];
  subs.forEach((s, i) => args.push('-map', `0:${s.index}`, '-c:s', 'webvtt', '-f', 'webvtt', outOf(i)));
  const r = await run(BIN.ffmpeg, args, { task });
  if (task.cancelled) return;
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    let ok = r.code === 0 && fileOk(outOf(i));
    if (!ok && r.code !== 0) {   // один битый поток не должен ломать остальные
      const one = await run(BIN.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-map', `0:${s.index}`, '-c:s', 'webvtt', '-f', 'webvtt', outOf(i)], { task });
      if (task.cancelled) return;
      ok = one.code === 0 && fileOk(outOf(i));
    }
    if (!ok) { await fsp.rm(outOf(i), { force: true }); continue; }
    const lang = an.langOf(s);
    const label = cleanText(s.tags?.title || '', 60) || LANG_NAMES[lang] || (lang ? lang.toUpperCase() : `Дорожка ${i + 1}`);
    q('INSERT INTO subs(media_id,lang,label,file) VALUES(?,?,?,?)').run(m.id, lang, label, `sub_${i}.vtt`);
  }
  broadcastMedia(m.id);
}

/** Исходник больше не нужен, когда все версии готовы: остаётся только v_src.mp4 и лесенка. */
async function cleanupOrig(id) {
  const m = getMedia(id);
  if (!m || m.kind !== 'video' || !m.orig_file || subsBusy.has(id)) return;
  const left = q("SELECT COUNT(*) AS n FROM variants WHERE media_id=? AND status IN ('pending','working','held')").get(id).n;
  const src = q("SELECT status FROM variants WHERE media_id=? AND kind='source'").get(id);
  if (left || !src || src.status !== 'ready') return;
  await fsp.rm(path.join(mediaDir(id), m.orig_file), { force: true }).catch(() => {});
  upd('media', id, { orig_file: null });
  setMedia(id, { size: await dirSize(mediaDir(id)) });
}

/* Очередь перекодирования: сначала исходники в H.264, затем лёгкие версии (до 720p), затем тяжёлые */
let txActive = 0;
function pumpTranscodes() {
  while (txActive < TRANSCODE_JOBS) {
    const v = q(`SELECT v.* FROM variants v JOIN media m ON m.id=v.media_id
                 WHERE v.status='pending' ORDER BY v.prio, m.created_at, v.height LIMIT 1`).get();
    if (!v) return;
    upd('variants', v.id, { status: 'working' });
    txActive++;
    transcodeVariant(v).catch(e => log('transcode', e)).finally(() => { txActive--; pumpTranscodes(); });
  }
}
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
async function transcodeVariant(v) {
  const m = getMedia(v.media_id);
  if (!m) return;
  const task = taskOf(m.id);
  if (task.cancelled) return;
  const dir = mediaDir(m.id);
  let meta = {}; try { meta = JSON.parse(m.meta || '{}'); } catch {}
  const origPath = m.orig_file ? path.join(dir, m.orig_file) : '';
  const fromOrig = !!origPath && fileOk(origPath);
  const srcV = q("SELECT * FROM variants WHERE media_id=? AND kind='source' AND status='ready'").get(m.id);
  const input = fromOrig ? origPath : (srcV ? path.join(dir, srcV.file) : '');
  const fail = msg => {
    upd('variants', v.id, { status: 'error' });
    if (v.kind === 'source') setMedia(m.id, { status: 'error', error: msg, retry: 1, stage: '' });
    else broadcastMedia(m.id);
  };
  if (!input) return fail('Исходный файл не найден — загрузи его заново');
  const out = path.join(dir, v.file), tmp = out.replace(/\.mp4$/, '.tmp.mp4');
  const vf = [];
  if (meta.interlaced) vf.push('yadif');
  if (meta.hdr && tools.tonemap) vf.push(TONEMAP);
  vf.push(`scale=${v.w}:${v.h}:flags=bicubic`, 'setsar=1', 'format=yuv420p');
  const fps = m.fps || 30;
  const crf = X264_CRF + (v.height <= 360 ? 3 : v.height <= 480 ? 2 : v.height <= 720 ? 1 : 0);
  const args = ['-i', input, '-map', fromOrig && meta.vi >= 0 ? `0:${meta.vi}` : '0:v:0'];
  if (meta.hasAudio) args.push('-map', fromOrig && meta.ai >= 0 ? `0:${meta.ai}` : '0:a:0?');
  args.push('-vf', vf.join(','), '-c:v', tools.encoder);
  if (tools.encoder === 'libx264') args.push('-preset', X264_PRESET, '-crf', String(crf), '-profile:v', 'high');
  else args.push('-b:v', `${Math.round(v.w * v.h * fps * 0.09 / 1000)}k`);
  args.push('-pix_fmt', 'yuv420p', '-g', String(Math.round(fps * 2)));     // частоту кадров не трогаем: 60 остаются 60
  if (meta.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-max_muxing_queue_size', '4096',
    '-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', tmp);
  const isSrc = v.kind === 'source';
  if (!isSrc) broadcastMedia(m.id);
  const r = await ffmpegRun(args, m.duration, p => {
    if (isSrc) liveSet(m.id, { progress: p, stage: 'Перекодирование в H.264' });
    else liveVar(m.id, v.id, p);
  }, task);
  if (task.cancelled || !getMedia(m.id)) { await fsp.rm(tmp, { force: true }).catch(() => {}); return; }
  if (r.code !== 0 || !fileOk(tmp)) {
    log('transcode', m.id, v.label, 'ошибка ffmpeg:\n' + lastLines(r.stderr, 8));
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return fail(/No space left/i.test(r.stderr) ? 'Не хватает места на диске' : 'Не удалось перекодировать видео');
  }
  await fsp.rename(tmp, out);
  upd('variants', v.id, { status: 'ready', size: fs.statSync(out).size });
  const l = live.get(m.id); if (l) delete l.v[v.id];
  if (isSrc) setMedia(m.id, { status: 'ready', stage: '', progress: 1, error: '', size: await dirSize(dir) });
  else setMedia(m.id, { size: await dirSize(dir) });   // версия сразу появляется у зрителей
  await cleanupOrig(m.id);
}

async function processAudio(m, input, probe, ctx) {
  const task = ctx.task, dir = mediaDir(m.id);
  const an = analyze(probe);
  const a = an.a;
  if (!a) throw new UserError('В файле нет звуковой дорожки');
  const duration = +probe.format?.duration || +a.duration || 0;
  const tags = {};
  for (const src of [a.tags, probe.format?.tags]) for (const [k, v] of Object.entries(src || {})) tags[k.toLowerCase()] = String(v);
  const fmt = String(probe.format?.format_name || '');
  const codec = a.codec_name;
  let ext, enc, direct = false;
  if (codec === 'mp3') { ext = 'mp3'; enc = ['-c:a', 'copy', '-f', 'mp3']; direct = fmt === 'mp3' && !an.cover; }
  else if (codec === 'aac') { ext = 'm4a'; enc = ['-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4']; }
  else if (codec === 'flac') { ext = 'flac'; enc = ['-c:a', 'copy', '-f', 'flac']; direct = fmt === 'flac' && !an.cover; }
  else if (/^pcm_|^alac$|^ape$|^wavpack$|^tta$/.test(codec)) { ext = 'flac'; enc = ['-c:a', 'flac', '-f', 'flac']; }   // без потерь → FLAC
  else { ext = 'm4a'; enc = ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'mp4']; }
  const file = `track.${ext}`, out = path.join(dir, file);
  setMedia(m.id, { stage: 'Обработка', duration });
  // Обложка: из файла или превью с сайта.
  let cover = false;
  if (an.cover) cover = await imageToJpeg(input, path.join(dir, 'cover.jpg'), true, task, `0:${an.cover.index}`);
  if (!cover && ctx.thumb) cover = await imageToJpeg(ctx.thumb, path.join(dir, 'cover.jpg'), true, task);
  if (task.cancelled) return;
  if (direct) await moveFile(input, out);
  else {
    const tmp = path.join(dir, `track.tmp.${ext}`);
    const r = await ffmpegRun(['-i', input, '-map', `0:${a.index}`, '-vn', '-map_metadata', '-1', '-map_chapters', '-1', ...enc, '-progress', 'pipe:1', '-nostats', tmp],
      duration, p => liveSet(m.id, { progress: p, stage: 'Обработка' }), task);
    if (task.cancelled) return;
    if (r.code !== 0 || !fileOk(tmp)) { log('audio', m.id, lastLines(r.stderr, 6)); throw new UserError('Не удалось обработать аудиофайл'); }
    await fsp.rename(tmp, out);
    await fsp.rm(input, { force: true }).catch(() => {});
  }
  // Название и исполнитель — из тегов файла; если тегов нет, пробуем «Исполнитель - Название».
  let meta = {}; try { meta = JSON.parse(m.meta || '{}'); } catch {}
  let title = m.title, artist = m.artist;
  if (meta.auto) {
    const tt = cleanText(tags.title, 160), ta = cleanText(tags.artist || tags.album_artist || '', 120);
    if (tt) { title = tt; artist = ta || artist; }
    else {
      const sp = /^(.{1,80}?)\s+[-–—]\s+(.{1,120})$/.exec(title);
      if (sp) { artist = ta || sp[1]; title = sp[2]; } else if (ta) artist = ta;
    }
  }
  upd('media', m.id, { orig_file: null, file, title, artist, duration });
  setMedia(m.id, { status: 'ready', stage: '', progress: 1, poster: cover ? now() : 0, size: await dirSize(dir) });
}

/* ═════════════════════════════ API: библиотека и файлы ═════════════════════════════ */

const canAddMusic = u => u.role === 'owner' || getSetting('friends_music') === '1';
const canManage = (u, m) => u.role === 'owner' || (m.kind === 'audio' && m.added_by === u.id);
const bitCount = buf => { let n = 0; for (const b of buf) { let x = b; while (x) { n += x & 1; x >>= 1; } } return n; };

route('GET', '/api/media', {}, c => {
  const rows = q('SELECT * FROM media ORDER BY created_at DESC').all();
  const ups = new Map(q('SELECT * FROM uploads WHERE user_id=?').all(c.user.id).map(u => [u.media_id, u]));
  return {
    media: rows.map(m => {
      const v = mediaView(m), u = ups.get(m.id);
      if (u) v.upload = { id: u.id, name: u.name, size: u.size, total: u.total, received: bitCount(u.received) };
      return v;
    }),
  };
});
route('GET', '/api/disk', { auth: 'owner' }, async () => {
  const d = await diskInfo();
  return { ...d, used: q('SELECT COALESCE(SUM(size),0) AS n FROM media').get().n };
});
route('PATCH', '/api/media/:id', {}, c => {
  const m = getMedia(c.params.id);
  if (!m) throw bad('Не найдено', 404);
  if (!canManage(c.user, m)) throw bad('Недостаточно прав', 403);
  const patch = {};
  if (c.body.title !== undefined) { patch.title = cleanText(c.body.title, 160); if (!patch.title) throw bad('Название не может быть пустым'); }
  if (c.body.artist !== undefined && m.kind === 'audio') patch.artist = cleanText(c.body.artist, 120);
  let meta = {}; try { meta = JSON.parse(m.meta || '{}'); } catch {}
  delete meta.auto; patch.meta = JSON.stringify(meta);
  setMedia(m.id, patch);
  roomsTouchMedia(m.id);
});
route('DELETE', '/api/media/:id', {}, async c => {
  const m = getMedia(c.params.id);
  if (!m) return;
  if (!canManage(c.user, m)) throw bad('Недостаточно прав', 403);
  await deleteMedia(m.id);
});
route('POST', '/api/media/:id/cancel', {}, async c => {
  const m = getMedia(c.params.id);
  if (!m) return;
  if (!canManage(c.user, m)) throw bad('Недостаточно прав', 403);
  if (m.status === 'ready') throw bad('Уже готово');
  await deleteMedia(m.id);     // отмена: убиваем процессы и чистим временные файлы
});
route('POST', '/api/media/:id/retry', {}, async c => {
  const m = getMedia(c.params.id);
  if (!m) throw bad('Не найдено', 404);
  if (!canManage(c.user, m)) throw bad('Недостаточно прав', 403);
  const dir = mediaDir(m.id);
  if (m.status === 'ready') {
    // Готовый фильм, но какая-то версия не получилась: пробуем её ещё раз.
    q("UPDATE variants SET status='pending' WHERE media_id=? AND status='error'").run(m.id);
    broadcastMedia(m.id);
    return pumpTranscodes();
  }
  if (m.status !== 'error') throw bad('Сейчас повторить нельзя');
  cancelTask(m.id);
  const haveOrig = m.orig_file && fileOk(path.join(dir, m.orig_file));
  if (m.origin === 'link' && !haveOrig) {
    q('DELETE FROM variants WHERE media_id=?').run(m.id);
    setMedia(m.id, { status: 'queued', stage: 'В очереди', progress: 0, error: '', retry: 0 });
    return startLinkJob(m.id);
  }
  if (!haveOrig) throw bad('Исходный файл не сохранился — загрузи его заново');
  newTask(m.id);
  processMedia(m.id);
});

/* Загрузка файлов кусками */
const upHandles = new Map();   // uploadId → { fh, refs, timer }
async function openUpload(id, file) {
  let h = upHandles.get(id);
  if (!h) { h = { fh: await fsp.open(file, 'r+'), refs: 0, timer: null }; upHandles.set(id, h); }
  clearTimeout(h.timer);
  h.refs++;
  return h.fh;
}
function releaseUpload(id) {
  const h = upHandles.get(id);
  if (!h) return;
  if (--h.refs <= 0) h.timer = setTimeout(() => closeUpload(id), 30e3);
}
async function closeUpload(id) {
  const h = upHandles.get(id);
  if (!h) return;
  upHandles.delete(id); clearTimeout(h.timer);
  try { await h.fh.close(); } catch {}
}
function uploadView(u) {
  return { id: u.id, mediaId: u.media_id, chunk: CHUNK_SIZE, total: u.total, size: u.size, bits: Buffer.from(u.received).toString('base64') };
}
route('POST', '/api/upload/init', {}, async c => {
  const kind = c.body.kind === 'audio' ? 'audio' : 'video';
  if (kind === 'video' ? c.user.role !== 'owner' : !canAddMusic(c.user)) throw bad('Загружать сюда может только владелец', 403);
  if (!tools.ffmpeg) throw bad('На сервере не найден ffmpeg — без него файлы не обработать', 503);
  const name = cleanText(String(c.body.name || 'file').split(/[\\/]/).pop(), 200) || 'file';
  const size = +c.body.size;
  if (!Number.isSafeInteger(size) || size <= 0) throw bad('Файл пустой');
  // Докачка: тот же файл (имя + размер) продолжает с того места, где оборвалось.
  const ex = q('SELECT * FROM uploads WHERE user_id=? AND name=? AND size=?').get(c.user.id, name, size);
  if (ex && getMedia(ex.media_id)?.status === 'uploading') return uploadView(ex);
  const disk = await diskInfo();
  if (disk.total && size + DISK_RESERVE > disk.free) throw bad(`Не хватает места на диске: свободно ${fmtSize(disk.free)}, а файл — ${fmtSize(size)}`, 507);
  const id = rid(9), mediaId = rid(8);
  const ext = (/\.[a-z0-9]{1,5}$/i.exec(name) || ['.bin'])[0].toLowerCase();
  const orig = 'orig' + ext;
  await fsp.mkdir(mediaDir(mediaId), { recursive: true });
  await fsp.writeFile(path.join(mediaDir(mediaId), orig), '');
  const total = Math.ceil(size / CHUNK_SIZE);
  q("INSERT INTO media(id,kind,title,status,stage,origin,orig_file,meta,added_by,created_at) VALUES(?,?,?,'uploading','Загрузка','file',?,?,?,?)")
    .run(mediaId, kind, titleFromName(name), orig, '{"auto":1}', c.user.id, now());
  q('INSERT INTO uploads(id,media_id,user_id,name,size,total,received,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, mediaId, c.user.id, name, size, total, Buffer.alloc(Math.ceil(total / 8)), now());
  broadcastMedia(mediaId);
  return uploadView(q('SELECT * FROM uploads WHERE id=?').get(id));
});
route('PUT', '/api/upload/:id/:idx', { body: 'raw', noLimit: true }, async c => {
  const up = q('SELECT * FROM uploads WHERE id=?').get(c.params.id);
  const m = up && getMedia(up.media_id);
  if (!up || !m || up.user_id !== c.user.id) throw bad('Загрузка не найдена — начни заново', 404);
  const idx = +c.params.idx;
  if (!Number.isInteger(idx) || idx < 0 || idx >= up.total) throw bad('Неверный номер куска');
  const offset = idx * CHUNK_SIZE, want = Math.min(CHUNK_SIZE, up.size - offset);
  if (+c.req.headers['content-length'] !== want) throw bad('Неверный размер куска');
  const fh = await openUpload(up.id, path.join(mediaDir(m.id), m.orig_file));
  try {
    let pos = offset, got = 0;
    for await (const chunk of c.req) {
      got += chunk.length;
      if (got > want) throw bad('Лишние данные в куске');
      await fh.write(chunk, 0, chunk.length, pos);
      pos += chunk.length;
    }
    if (got !== want) throw bad('Кусок получен не полностью');
  } finally { releaseUpload(up.id); }
  const cur = q('SELECT received FROM uploads WHERE id=?').get(up.id);
  if (!cur) throw bad('Загрузка отменена', 404);
  const bits = Buffer.from(cur.received);
  bits[idx >> 3] |= 1 << (idx & 7);
  q('UPDATE uploads SET received=? WHERE id=?').run(bits, up.id);
  const n = bitCount(bits);
  liveSet(m.id, { progress: n / up.total, stage: 'Загрузка' });
  return { ok: true, received: n };
});
route('POST', '/api/upload/:id/complete', {}, async c => {
  const up = q('SELECT * FROM uploads WHERE id=?').get(c.params.id);
  const m = up && getMedia(up.media_id);
  if (!up || !m || up.user_id !== c.user.id) throw bad('Загрузка не найдена — начни заново', 404);
  const bits = Buffer.from(up.received);
  const missing = [];
  for (let i = 0; i < up.total && missing.length < 64; i++) if (!(bits[i >> 3] & (1 << (i & 7)))) missing.push(i);
  if (missing.length) throw bad('Не все части файла дошли до сервера', 409, { missing });
  await closeUpload(up.id);
  const st = await fsp.stat(path.join(mediaDir(m.id), m.orig_file));
  if (st.size !== up.size) throw bad('Размер файла не сошёлся — попробуй загрузить заново', 409);
  q('DELETE FROM uploads WHERE id=?').run(up.id);
  newTask(m.id);
  setMedia(m.id, { status: 'processing', stage: 'Анализ файла', progress: 0 });
  processMedia(m.id);
});
route('DELETE', '/api/upload/:id', {}, async c => {
  const up = q('SELECT * FROM uploads WHERE id=?').get(c.params.id);
  if (!up) return;
  if (up.user_id !== c.user.id && c.user.role !== 'owner') throw bad('Недостаточно прав', 403);
  await deleteMedia(up.media_id);
});

/* API: настройки владельца */
route('GET', '/api/settings', { auth: 'owner' }, async () => {
  let cookies = null;
  try { const st = await fsp.stat(COOKIES_FILE); cookies = { size: st.size, at: Math.floor(st.mtimeMs) }; } catch {}
  return {
    cookies, friendsMusic: getSetting('friends_music') === '1',
    ytdlp: { ok: ytdlp.ok, version: ytdlp.version, checkedAt: ytdlp.checkedAt, busy: !!ytdlp.updating },
    ffmpeg: { ok: tools.ffmpeg, version: tools.version },
    bot: bot.ok ? { username: bot.username, mainApp: bot.mainApp } : null,
    disk: { ...(await diskInfo()), used: q('SELECT COALESCE(SUM(size),0) AS n FROM media').get().n },
  };
});
route('PATCH', '/api/settings', { auth: 'owner' }, c => {
  if (c.body.friendsMusic !== undefined) setSetting('friends_music', c.body.friendsMusic ? '1' : '0');
  broadcast({ t: 'perm' });
});
route('POST', '/api/settings/cookies', { auth: 'owner', body: 'buffer', limit: 3 * 1024 * 1024 }, async c => {
  const text = c.body.toString('utf8').replace(/^\ufeff/, '');
  const rows = text.split(/\r?\n/).filter(l => l && !l.startsWith('#') || l.startsWith('#HttpOnly_'));
  const valid = rows.filter(l => l.split('\t').length >= 7).length;
  if (!valid) throw bad('Это не похоже на cookies.txt. Нужен файл в формате Netscape (расширение «Get cookies.txt LOCALLY» или аналог).');
  const body = /^# (Netscape )?HTTP Cookie File/m.test(text) ? text : '# Netscape HTTP Cookie File\n' + text;
  await fsp.writeFile(COOKIES_FILE, body, { mode: 0o600 });
  return { ok: true, count: valid };
});
route('DELETE', '/api/settings/cookies', { auth: 'owner' }, async () => { await fsp.rm(COOKIES_FILE, { force: true }); });
route('POST', '/api/settings/ytdlp-update', { auth: 'owner' }, async c => {
  rateLimit('ytu:' + c.user.id, 6, 3600e3);
  await ytUpdate(true);
  return { ok: ytdlp.ok, version: ytdlp.version };
});

/* ═════════════════════════════ Сеть без SSRF ═════════════════════════════ */

const ssrfErr = () => new UserError('Эта ссылка ведёт во внутреннюю сеть — такие адреса запрещены', 'ssrf');
/** DNS-резолвер для наших запросов: соединяемся только с внешними адресами (и именно с проверенными). */
function safeLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { all: true, family: options.family || 0 }, (err, list) => {
    if (err) return cb(err);
    const ok = list.filter(a => !isPrivateIp(a.address));
    if (!ok.length) { const e = new Error('private address'); e.code = 'ESSRF'; return cb(e); }
    if (options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}
/** Проверка ссылки перед тем, как отдать её yt-dlp/ffmpeg: только http(s), только внешние адреса. */
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new UserError('Это не похоже на ссылку', 'badurl'); }
  if (!/^https?:$/.test(u.protocol)) throw new UserError('Поддерживаются только ссылки http и https', 'badurl');
  if (u.username || u.password) throw new UserError('Ссылки с логином и паролем не поддерживаются', 'badurl');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw ssrfErr(); return u; }
  if (/^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home\.arpa$/i.test(host) || !host.includes('.')) throw ssrfErr();
  let list;
  try { list = await dns.promises.lookup(host, { all: true }); }
  catch (e) {
    // Имени точно нет — говорим об этом. А если DNS просто не ответил (или загрузчик ходит через прокси, где имена
    // разрешает сам прокси) — не блокируем: локально такой адрес всё равно никуда не ведёт, а yt-dlp разберётся сам.
    if (e.code === 'ENOTFOUND' && !YT_PROXY && !KNOWN_HOSTS.test(host)) throw new UserError('Сайт не найден — проверь ссылку', 'dns');
    return u;
  }
  if (!list.length || list.some(a => isPrivateIp(a.address))) throw ssrfErr();
  return u;
}
function requestOnce(url, { method = 'GET', headers = {}, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new UserError('Это не похоже на ссылку', 'badurl')); }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!/^https?:$/.test(u.protocol) || (net.isIP(host) && isPrivateIp(host))) return reject(Object.assign(new Error('private address'), { code: 'ESSRF' }));
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method, timeout, lookup: safeLookup,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ru,en;q=0.8', ...headers },
    }, resolve);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}
/** Запрос с ручными редиректами: адрес каждого перехода проверяется заново. */
async function safeRequest(url, opts = {}) {
  let cur = url;
  for (let i = 0; i < 7; i++) {
    const res = await requestOnce(cur, opts);
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      cur = new URL(res.headers.location, cur).href;
      continue;
    }
    return { res, url: cur };
  }
  throw new UserError('Слишком много перенаправлений', 'redirects');
}
async function fetchBuffer(url, { max = 4e6, timeout = 15000, headers = {} } = {}) {
  const { res, url: finalUrl } = await safeRequest(url, { headers: { 'Accept-Encoding': 'gzip, br', ...headers }, timeout });
  return new Promise(resolve => {
    const chunks = []; let n = 0, fin = false;
    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
    const stream = /gzip/.test(enc) ? res.pipe(zlib.createGunzip()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
    const done = () => {
      if (fin) return; fin = true; clearTimeout(tm);
      resolve({ status: res.statusCode, type: String(res.headers['content-type'] || '').toLowerCase(), buf: Buffer.concat(chunks), url: finalUrl });
    };
    const tm = setTimeout(() => { res.destroy(); done(); }, timeout);
    stream.on('data', c => {
      if (fin) return;
      n += c.length;
      if (n > max) { chunks.push(c.subarray(0, c.length - (n - max))); res.destroy(); done(); } else chunks.push(c);
    });
    stream.on('end', done); stream.on('error', done); res.on('error', done); res.on('close', done);
  });
}
const KNOWN_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|rutube\.ru|vk\.com|vk\.ru|vkvideo\.ru|ok\.ru|dzen\.ru|soundcloud\.com|vimeo\.com|twitch\.tv|tiktok\.com|dailymotion\.com|bandcamp\.com)$/i;
/** Перед yt-dlp проходим цепочку редиректов сами: если хоть один ведёт внутрь сети — отказ. */
async function preflight(url) {
  if (KNOWN_HOSTS.test(new URL(url).hostname)) return;
  try { const { res } = await safeRequest(url, { timeout: 6000, headers: { Range: 'bytes=0-0' } }); res.destroy(); }
  catch (e) { if (e.code === 'ESSRF' || e.code === 'ssrf') throw ssrfErr(); }
}

/* ═════════════════════════════ yt-dlp ═════════════════════════════ */

const ytdlp = { ok: false, version: '', jsRuntimes: false, checkedAt: 0, updating: null };
async function ytCheck() {
  const v = await run(BIN.ytdlp, ['--version'], { timeout: 90000 });
  ytdlp.ok = v.code === 0 && /\d{4}\.\d+/.test(v.stdout);
  ytdlp.version = ytdlp.ok ? v.stdout.trim().split(/\s+/)[0] : '';
  if (ytdlp.ok) {
    const h = await run(BIN.ytdlp, ['--help'], { timeout: 90000 });
    ytdlp.jsRuntimes = /--js-runtimes/.test(h.stdout);   // старые версии этого ключа не знают
  }
}
async function pipUpdate() {
  for (const [cmd, pre] of [['python3', ['-m', 'pip']], ['python', ['-m', 'pip']], ['pip3', []], ['pip', []]]) {
    let r = await run(cmd, [...pre, 'install', '-U', 'yt-dlp[default]'], { timeout: 300000 });
    if (r.spawnError) continue;
    if (r.code !== 0 && /externally-managed-environment/i.test(r.stderr))
      r = await run(cmd, [...pre, 'install', '-U', '--break-system-packages', 'yt-dlp[default]'], { timeout: 300000 });
    if (r.code === 0) return true;
    log('yt-dlp', 'pip:', lastLines(r.stderr, 3));
  }
  return false;
}
/** Сайты постоянно меняются: держим yt-dlp свежим (при старте, раз в 6 часов и после непонятных ошибок). */
function ytUpdate(force) {
  if (ytdlp.updating) return ytdlp.updating;
  if (!force && now() - ytdlp.checkedAt < 3600e3) return Promise.resolve();
  ytdlp.updating = (async () => {
    try {
      await ytCheck();
      if (!ytdlp.ok) return log('yt-dlp', 'НЕ НАЙДЕН — загрузка по ссылке работать не будет. Установи yt-dlp.');
      const before = ytdlp.version;
      const r = await run(BIN.ytdlp, ['-U'], { timeout: 240000 });
      const text = r.stdout + '\n' + r.stderr;
      if (/with pip|PyPi|pip install/i.test(text)) await pipUpdate();
      else if (/package manager|manual build/i.test(text)) log('yt-dlp', 'установлен пакетным менеджером — обнови его им же, либо поставь официальный бинарник');
      else if (r.code !== 0) log('yt-dlp', 'обновление не удалось:', lastLines(text, 3));
      await ytCheck();
      log('yt-dlp', before === ytdlp.version ? `актуален (${ytdlp.version})` : `обновлён: ${before} → ${ytdlp.version}`,
        ytdlp.jsRuntimes ? '' : '· ключ --js-runtimes не поддерживается этой версией');
    } catch (e) { log('yt-dlp', e); }
    finally { ytdlp.checkedAt = now(); ytdlp.updating = null; }
  })();
  return ytdlp.updating;
}
function ytCommon(referer) {
  const a = ['--ignore-config', '--no-playlist', '--socket-timeout', '30', '--user-agent', UA];
  if (ytdlp.jsRuntimes) a.push('--js-runtimes', 'node');    // YouTube нужен JS-движок, а Node у нас уже есть
  if (YT_PROXY) a.push('--proxy', YT_PROXY);
  if (referer) a.push('--referer', referer);
  return a;
}
/** cookies.txt передаём копией: yt-dlp переписывает файл при выходе, параллельные запуски не должны его портить. */
async function cookieArgs(dir) {
  if (!fileOk(COOKIES_FILE)) return [];
  const copy = path.join(dir, `cookies-${rid(4)}.txt`);
  await fsp.copyFile(COOKIES_FILE, copy);
  return ['--cookies', copy];
}
/** Текст stderr yt-dlp → понятная причина. */
function ytError(stderr, { timedOut } = {}) {
  const s = String(stderr || '');
  const errLine = (s.match(/^ERROR:.*$/gm) || []).pop() || '';
  const t = (errLine || s).toLowerCase(), all = s.toLowerCase();
  const E = (msg, code, opts) => new UserError(msg, code, opts);
  if (/no space left|larger than max-filesize|disk quota/.test(all)) return E('Не хватает места на диске', 'nospace');
  if (/ffmpeg (is )?not (found|installed)|ffprobe.*not found/.test(t)) return E('На сервере не установлен ffmpeg', 'notools');
  if (/\bdrm\b/.test(t)) return E('Видео защищено DRM — скачать его нельзя', 'drm');
  if (/not available in your country|geo.?restrict|geo.?block|blocked in your country|not available from your location|available in your (region|country)|in your region/.test(t))
    return E('Видео недоступно в стране, где стоит сервер', 'geo');
  if (/sign in to confirm|not a bot|login required|sign in to|log in to|requires authentication|authentication required|members[- ]only|registered users|--cookies|age[- ]restricted|confirm your age/.test(t))
    return E('Сайт просит войти в аккаунт или подтвердить, что ты не бот. Владелец может загрузить cookies.txt в настройках — после этого видео скачается.', 'cookies');
  if (/private video|video is private/.test(t)) return E('Это закрытое видео: без доступа его не скачать', 'private');
  if (/video unavailable|has been removed|been deleted|no longer available|does not exist|http error 404|http error 410|account.{0,40}terminated|removed by/.test(t))
    return E('Видео удалено или недоступно', 'gone');
  if (/http error 429|too many requests|rate.?limit/.test(t)) return E('Сайт временно ограничил запросы с сервера — попробуй позже', 'rate');
  if (/http error 403|forbidden/.test(t))
    return E('Сайт отказал в доступе (403). Попробуй позже; если не поможет — загрузи cookies.txt в настройках', 'forbidden', { needUpdate: true, retryable: true });
  if (/unsupported url/.test(t)) return E('Этот сайт не поддерживается', 'unsupported');
  if (/live event will begin|premieres in|not currently live|this live event|is offline/.test(t)) return E('Трансляция ещё не началась или уже закончилась — скачать нечего', 'live');
  if (timedOut || /timed out|timeout|connection reset|connection aborted|temporary failure|name resolution|unable to connect|network is unreachable|remote end closed|incompleteread|getaddrinfo/.test(t))
    return E('Сайт не отвечает — попробуй ещё раз чуть позже', 'timeout', { retryable: true });
  if (/requested format is not available|no video formats found|no formats found/.test(t)) return E('На странице не нашлось видео, которое можно скачать', 'nofmt', { needUpdate: true });
  if (/unable to extract|signature|nsig|unable to download (webpage|json|api)|failed to parse|player response/.test(t))
    return E('Не получилось разобрать страницу сайта — обновляю загрузчик, попробуй ещё раз', 'extract', { needUpdate: true, retryable: true });
  const brief = cleanText(errLine.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?(\S+:\s)?/, ''), 140);
  return E('Не удалось скачать' + (brief ? ': ' + brief : ''), 'unknown', { needUpdate: true });
}
/** Разбор ссылки: yt-dlp -J. Для страниц-подборок — плоский список (первые 40). Таймаут 60 с и один автоповтор. */
async function ytJson(url, referer) {
  const tmp = path.join(TMP_DIR, 'probe-' + rid(6));
  await fsp.mkdir(tmp, { recursive: true });
  try {
    const args = ['-J', '--flat-playlist', '--playlist-end', '40', ...ytCommon(referer), ...(await cookieArgs(tmp)), '--', url];
    let r = await run(BIN.ytdlp, args, { timeout: 60000 });
    if (r.timedOut) { log('yt-dlp', 'разбор не уложился в 60 с — повторяю:', url); r = await run(BIN.ytdlp, args, { timeout: 60000 }); }
    if (r.spawnError) throw new UserError('На сервере не установлен yt-dlp', 'notools');
    const line = r.stdout.trim().split(/\r?\n/).pop() || '';
    if (r.code !== 0 || !line.startsWith('{')) {
      log('yt-dlp', `разбор не удался: ${url}\n` + lastLines(r.stderr, 10));
      throw ytError(r.stderr, r);
    }
    try { return JSON.parse(line); } catch { throw new UserError('Не получилось разобрать ответ загрузчика', 'extract', { needUpdate: true }); }
  } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}
const fmtSizeOf = (f, dur) => +f.filesize || +f.filesize_approx || (f.tbr && dur ? Math.round(f.tbr * 125 * dur) : 0);
const isHls = f => /m3u8|dash|ism/i.test(f.protocol || '') ? 1 : 0;
/** Звук для готовых версий: AAC, оригинальная дорожка — не автодубляж и не «-drc». */
function pickSiteAudio(formats) {
  let list = formats.filter(f => (!f.vcodec || f.vcodec === 'none') && /^mp4a/i.test(f.acodec || ''));
  const clean = list.filter(f => !/drc/i.test(f.format_id || '') && !/drc|dubbed|descriptive/i.test(f.format_note || ''));
  if (clean.length) list = clean;
  list.sort((a, b) => ((b.language_preference ?? -1) - (a.language_preference ?? -1)) || ((b.abr || b.tbr || 0) - (a.abr || a.tbr || 0)));
  return list[0] || null;
}
/** Качества из formats: группируем по высоте, берём максимальный fps, размер = видео + лучший звук. */
function buildQualities(info) {
  const dur = +info.duration || 0;
  const all = Array.isArray(info.formats) ? info.formats : [];
  const vids = all.filter(f => f.height && f.vcodec !== 'none' && f.ext !== 'mhtml' && !/storyboard/i.test(f.format_note || ''));
  const auds = all.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && !/drc/i.test(f.format_id || ''));
  auds.sort((a, b) => (/^mp4a/i.test(b.acodec) - /^mp4a/i.test(a.acodec)) || ((b.language_preference ?? -1) - (a.language_preference ?? -1)) || ((b.abr || b.tbr || 0) - (a.abr || a.tbr || 0)));
  const aSize = auds[0] ? fmtSizeOf(auds[0], dur) : 0;
  const rank = f => (/^(avc|h264)/i.test(f.vcodec || '') ? 3 : /^vp0?9/i.test(f.vcodec || '') ? 2 : /^av01/i.test(f.vcodec || '') ? 1 : 0);
  const groups = new Map();
  for (const f of vids) { if (!groups.has(f.height)) groups.set(f.height, []); groups.get(f.height).push(f); }
  let out = [];
  for (const [h, list] of groups) {
    const fps = Math.max(...list.map(f => Math.round(+f.fps || 0)));
    const best = list.filter(f => Math.round(+f.fps || 0) === fps).sort((a, b) => (rank(b) - rank(a)) || ((b.tbr || 0) - (a.tbr || 0)))[0];
    const muxed = best.acodec && best.acodec !== 'none' || !auds.length;
    const vs = fmtSizeOf(best, dur);
    const nominal = best.width ? nominalOf(best.width, h) : h;
    out.push({ h, nominal, label: qualityLabel(nominal, fps), size: vs ? vs + (muxed ? 0 : aSize) : 0 });
  }
  out.sort((a, b) => b.h - a.h);
  if (out.some(x => x.nominal >= 360)) out = out.filter(x => x.nominal >= 360);   // 144p/240p прячем, если есть лучше
  const seen = new Set();
  out = out.filter(x => !seen.has(x.label) && seen.add(x.label));
  return { list: out, audioSize: aSize };
}
async function describeInfo(info, o, depth = 0) {
  if (!info || typeof info !== 'object') throw new UserError('На странице не нашлось видео', 'nofmt');
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const entries = (info.entries || []).filter(e => e && (Array.isArray(e.formats) || /^https?:\/\//.test(e.webpage_url || e.url || '')));
    if (!entries.length) throw new UserError('На странице не нашлось видео', 'nofmt');
    if (entries.length === 1 && depth < 2) {
      const e = entries[0];
      if (Array.isArray(e.formats)) return describeInfo(e, o, depth + 1);
      const u = (await assertPublicUrl(e.webpage_url || e.url)).href;
      return describeInfo(await ytJson(u, o.referer), { ...o, url: u }, depth + 1);
    }
    return {
      type: 'list', title: cleanText(info.title || '', 160),
      entries: entries.slice(0, 40).map(e => ({ title: cleanText(e.title || e.id || 'Видео', 160), url: e.webpage_url || e.url, duration: +e.duration || 0 })),
    };
  }
  if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming')
    throw new UserError('Это прямая трансляция — скачать её можно будет, когда она закончится', 'live');
  const q = buildQualities(info);
  const audio = o.kind === 'audio';
  const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails.filter(t => t && /^https?:/.test(t.url || '')) : [];
  const title = cleanText(audio ? (info.track || info.title) : info.title, 160) || 'Без названия';
  const artist = audio ? cleanText(String(info.artist || info.creator || info.uploader || '').replace(/ - Topic$/, ''), 120) : '';
  return {
    type: audio ? 'audio' : 'video', mode: 'ytdlp', url: o.url, referer: o.referer || '',
    title, artist, uploader: cleanText(info.uploader || info.channel || '', 80), site: cleanText(info.extractor_key || info.extractor || '', 40),
    duration: +info.duration || 0,
    thumbUrl: info.thumbnail && /^https?:/.test(info.thumbnail) ? info.thumbnail : (thumbs.length ? thumbs[thumbs.length - 1].url : ''),
    qualities: audio ? [] : q.list.map(x => ({ h: x.h, label: x.label, size: x.size })),
    size: audio ? q.audioSize : (q.list[0]?.size || +info.filesize || +info.filesize_approx || 0),
  };
}

/* Своими силами: прямые файлы, HLS и страницы со встроенным плеером */
const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ts|flv|wmv|mpg|mpeg|mp3|m4a|flac|ogg|opus|wav|aac)$/i;
async function probeDirect(url, referer, kind) {
  const { res } = await safeRequest(url, { timeout: 15000, headers: { ...(referer ? { Referer: referer } : {}), Range: 'bytes=0-0' } });
  res.destroy();
  if (res.statusCode >= 400) return null;
  const type = String(res.headers['content-type'] || '').toLowerCase();
  const pathname = new URL(url).pathname;
  if (/mpegurl/.test(type)) return probeHls(url, referer, kind);
  if (!/^(video|audio)\//.test(type) && !(/octet-stream|binary|^$/.test(type) && MEDIA_EXT.test(pathname))) return null;
  const cr = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
  const size = cr ? +cr[1] : (res.statusCode === 200 ? +res.headers['content-length'] || 0 : 0);
  let name = pathname.split('/').pop() || 'video';
  try { name = decodeURIComponent(name); } catch {}
  return { type: /^audio\//.test(type) || kind === 'audio' ? 'audio' : 'video', mode: 'direct', url, referer: referer || '', title: titleFromName(name), artist: '', uploader: '', site: new URL(url).hostname, duration: 0, thumbUrl: '', qualities: [], size };
}
async function probeHls(url, referer, kind) {
  // Плейлист сначала читаем сами: все адреса внутри должны быть внешними, иначе ffmpeg туда не пустим.
  const pl = await fetchBuffer(url, { max: 1e6, headers: referer ? { Referer: referer } : {} });
  const text = pl.buf.toString('utf8');
  if (pl.status >= 400 || !text.trimStart().startsWith('#EXTM3U')) return null;
  const origins = new Set();
  for (const line of text.split(/\r?\n/)) {
    const uris = [...line.matchAll(/URI="([^"]+)"/g)].map(m => m[1]);
    if (line && !line.startsWith('#')) uris.push(line.trim());
    for (const u of uris) {
      let x; try { x = new URL(u, pl.url); } catch { continue; }
      if (/^https?:$/.test(x.protocol)) origins.add(x.origin); else if (x.protocol !== 'data:') throw ssrfErr();
    }
  }
  for (const o of [...origins].slice(0, 12)) await assertPublicUrl(o);
  let an;
  try {
    an = analyze(await ffprobe(url, ['-user_agent', UA, ...(referer ? ['-referer', referer] : []), '-protocol_whitelist', 'http,https,tcp,tls,crypto']));
  } catch { return null; }
  if (!an.v && !an.a) return null;
  let name = new URL(url).pathname.split('/').slice(-2, -1)[0] || 'Видео';
  return { type: kind === 'audio' ? 'audio' : 'video', mode: 'hls', url, referer: referer || '', title: titleFromName(name), artist: '', uploader: '', site: new URL(url).hostname, duration: an.duration, thumbUrl: '', qualities: [], size: 0 };
}
const decodeEntities = s => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const JUNK_FRAMES = /doubleclick|googlesyndication|googletagmanager|google\.com\/recaptcha|facebook\.com\/plugins|widget_comments|metrika|adfox|disqus|about:blank|accounts\.google|captcha/i;
/** Разбор HTML, когда yt-dlp страницу не понял: <video>/<source>, og:video, ссылки на .m3u8/.mp4, iframe-плееры. */
function parseHtmlMedia(html, base) {
  const out = { direct: [], hls: [], frames: [], title: '', image: '' };
  const abs = u => {
    try {
      const x = new URL(decodeEntities(String(u).trim()).replace(/\\\//g, '/'), base);
      return /^https?:$/.test(x.protocol) ? x.href : null;
    } catch { return null; }
  };
  const push = (arr, u) => { if (u && !arr.includes(u) && arr.length < 12) arr.push(u); };
  const classify = (u, loose) => {
    const a = abs(u);
    if (!a) return;
    const p = new URL(a).pathname.toLowerCase();
    if (p.endsWith('.m3u8')) push(out.hls, a);
    else if (/\.(mp4|webm|m4v|mov)$/.test(p)) push(out.direct, a);
    else if (loose === 'frame' && !JUNK_FRAMES.test(a)) push(out.frames, a);
    else if (loose === 'file') push(out.direct, a);
  };
  let m;
  const metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(html))) {
    const key = ((/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(m[0]) || [])[1] || '').toLowerCase();
    const val = (/content\s*=\s*"([^"]*)"/i.exec(m[0]) || /content\s*=\s*'([^']*)'/i.exec(m[0]) || [])[1];
    if (!key || !val) continue;
    if (['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream', 'contenturl'].includes(key)) classify(val, 'frame');
    else if (['twitter:player', 'og:video:iframe', 'embedurl'].includes(key)) classify(val, 'frame');
    else if (key === 'og:title' && !out.title) out.title = cleanText(decodeEntities(val), 160);
    else if (key === 'og:image' && !out.image) out.image = abs(val) || '';
  }
  const srcRe = /<(video|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = srcRe.exec(html))) if (!/^(blob|data):/i.test(m[2])) classify(m[2], 'file');
  const frameRe = /<iframe\b[^>]*?\b(?:data-)?src\s*=\s*["']([^"']+)["']/gi;
  while ((m = frameRe.exec(html))) classify(m[1], 'frame');
  const flat = html.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&');
  const jsonRe = /"(embedUrl|contentUrl|embed_url|file|hls|src|video_url|videoUrl)"\s*:\s*"(https?:[^"\\]+)"/g;
  while ((m = jsonRe.exec(flat))) classify(m[2], /embed/i.test(m[1]) ? 'frame' : null);
  const urlRe = /https?:\/\/[^\s"'<>\\)]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\)]*)?/gi;
  while ((m = urlRe.exec(flat))) classify(m[0]);
  if (!out.title) { const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html); if (t) out.title = cleanText(decodeEntities(t[1]), 160); }
  return out;
}
async function htmlFallback(pageUrl, kind) {
  const pg = await fetchBuffer(pageUrl, { max: 4e6, timeout: 15000, headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  if (pg.status >= 400 || !/html|xml|text\/plain|^$/.test(pg.type)) return null;
  const found = parseHtmlMedia(pg.buf.toString('utf8'), pg.url);
  const fix = r => { if (r && found.title && r.mode !== 'ytdlp') r.title = found.title; if (r && !r.thumbUrl) r.thumbUrl = found.image; return r; };
  // 1) встроенные плееры → yt-dlp с --referer страницы
  if (ytdlp.ok) for (const f of found.frames.slice(0, 5)) {
    try {
      await assertPublicUrl(f);
      const r = await describeInfo(await ytJson(f, pg.url), { url: f, referer: pg.url, kind });
      if (r.type !== 'list') return fix(r);
    } catch (e) { if (e.code === 'cookies' || e.code === 'drm' || e.code === 'geo') throw e; }
  }
  // 2) HLS-плейлисты
  for (const u of found.hls.slice(0, 4)) {
    try {
      await assertPublicUrl(u);
      if (ytdlp.ok) { try { const r = await describeInfo(await ytJson(u, pg.url), { url: u, referer: pg.url, kind }); if (r.type !== 'list') return fix({ ...r, title: found.title || r.title }); } catch {} }
      const r = await probeHls(u, pg.url, kind);
      if (r) return fix(r);
    } catch {}
  }
  // 3) прямые файлы
  for (const u of found.direct.slice(0, 6)) {
    try { const r = await probeDirect(u, pg.url, kind); if (r) return fix(r); } catch {}
  }
  return null;
}

/* Разбор ссылки целиком */
const probes = new Map();   // token → результат разбора (живёт 40 минут)
async function probeLink(raw, kind) {
  let url = String(raw || '').trim();
  if (!url) throw new UserError('Вставь ссылку', 'badurl');
  if (url.length > 2000) throw new UserError('Слишком длинная ссылка', 'badurl');
  if (!/^https?:\/\//i.test(url)) {
    if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(url)) url = 'https://' + url;
    else throw new UserError('Это не похоже на ссылку', 'badurl');
  }
  const u = await assertPublicUrl(url);
  url = u.href;
  const p = u.pathname.toLowerCase();
  let res = null, err = null;
  if (MEDIA_EXT.test(p)) {     // прямая ссылка на файл
    try { res = await probeDirect(url, '', kind); } catch (e) { if (e.code === 'ESSRF' || e.code === 'ssrf') throw ssrfErr(); }
  }
  if (!res && ytdlp.ok) {
    await preflight(url);
    try { res = await describeInfo(await ytJson(url), { url, kind }); }
    catch (e) {
      err = e;
      // Непонятная ошибка разбора чаще всего лечится обновлением yt-dlp — обновляем и пробуем ещё раз.
      if (e.needUpdate && now() - ytdlp.checkedAt > 30 * 60e3) {
        const before = ytdlp.version;
        await ytUpdate(true);
        if (ytdlp.version !== before) { try { res = await describeInfo(await ytJson(url), { url, kind }); err = null; } catch (e2) { err = e2; } }
      }
    }
  }
  if (!res && p.endsWith('.m3u8')) res = await probeHls(url, '', kind).catch(e => { if (e.code === 'ssrf') throw e; return null; });
  if (!res && (!err || ['unsupported', 'nofmt', 'unknown', 'extract', 'forbidden', 'gone'].includes(err.code))) {
    try { res = await htmlFallback(url, kind); }
    catch (e) { if (e.user) err = e; }
  }
  if (!res) {
    if (err && err.code === 'unsupported') throw new UserError('Этот сайт не поддерживается: на странице не нашлось видео, которое можно скачать', 'unsupported');
    throw err || new UserError(ytdlp.ok ? 'На странице не нашлось видео, которое можно скачать'
      : 'На сервере не установлен yt-dlp, а прямой ссылки на видео на странице нет', 'nofmt');
  }
  res.pageUrl = url;
  return res;
}
/*
 * Разбор может идти до пары минут (таймаут 60 с + автоповтор), а прокси перед сервером часто рвут долгие запросы.
 * Поэтому разбор — фоновая задача: POST сразу отдаёт её номер, страница спрашивает результат коротким GET.
 */
const probeJobs = new Map();
route('POST', '/api/link/probe', { limit: 16 * 1024 }, c => {
  const kind = c.body.kind === 'audio' ? 'audio' : 'video';
  if (kind === 'video' ? c.user.role !== 'owner' : !canAddMusic(c.user)) throw bad('Добавлять сюда может только владелец', 403);
  rateLimit('probe:' + c.user.id, 30, 5 * 60e3, 'Слишком много ссылок подряд. Подожди пару минут.');
  const id = rid(9);
  const job = { userId: c.user.id, at: now(), state: 'pending' };
  probeJobs.set(id, job);
  for (const [k, j] of probeJobs) if (now() - j.at > 15 * 60e3) probeJobs.delete(k);
  runProbe(c.user.id, c.body.url, kind).then(
    result => { job.state = 'done'; job.result = result; },
    e => {
      job.state = 'error'; job.code = e.code || '';
      job.error = e.user ? e.message : 'Не получилось разобрать ссылку — попробуй ещё раз';
      if (!e.user) log('probe', e);
    });
  return { job: id };
});
route('GET', '/api/link/probe/:id', {}, c => {
  const job = probeJobs.get(c.params.id);
  if (!job || job.userId !== c.user.id) throw bad('Задача не найдена — разбери ссылку ещё раз', 404);
  if (job.state === 'pending') return { state: 'pending' };
  probeJobs.delete(c.params.id);
  return job.state === 'done' ? { state: 'done', result: job.result } : { state: 'error', error: job.error, code: job.code };
});
async function runProbe(userId, url, kind) {
  const c = { user: { id: userId } };
  const r = await probeLink(url, kind);
  if (r.type === 'list') return { type: 'list', title: r.title, entries: r.entries };
  let thumb = null;
  if (r.thumbUrl) {
    try {
      await assertPublicUrl(r.thumbUrl);
      const t = await fetchBuffer(r.thumbUrl, { max: 2.5e6, timeout: 8000, headers: { 'Accept-Encoding': 'identity' } });
      if (t.status < 400 && imageType(t.buf)) thumb = t.buf;
    } catch {}
  }
  const token = rid(12);
  probes.set(token, { ...r, at: now(), userId: c.user.id, thumb, heights: new Map(r.qualities.map(x => [x.h, x.size])) });
  return {
    token, type: r.type, title: r.title, artist: r.artist, uploader: r.uploader, site: r.site, duration: r.duration,
    qualities: r.qualities, size: r.size,
    thumb: thumb ? `data:${imageType(thumb)};base64,${thumb.toString('base64')}` : null,
  };
}
route('POST', '/api/link/start', { limit: 16 * 1024 }, async c => {
  const p = probes.get(String(c.body.token || ''));
  if (!p || p.userId !== c.user.id) throw bad('Ссылка устарела — разбери её ещё раз', 410);
  const kind = p.type === 'audio' ? 'audio' : 'video';
  if (kind === 'video' ? c.user.role !== 'owner' : !canAddMusic(c.user)) throw bad('Добавлять сюда может только владелец', 403);
  if (!tools.ffmpeg) throw bad('На сервере не найден ffmpeg — без него видео не обработать', 503);
  let height = null;
  if (kind === 'video' && c.body.height != null) {
    height = +c.body.height;
    if (!p.heights.has(height)) throw bad('Такого качества у этого видео нет');
  }
  const expected = (height ? p.heights.get(height) : p.size) || 0;
  const disk = await diskInfo();
  if (disk.total && expected * 2.2 + DISK_RESERVE > disk.free)
    throw bad(`Не хватает места на диске: свободно ${fmtSize(disk.free)}, а нужно около ${fmtSize(expected * 2.2)}`, 507);
  const id = rid(8), dir = mediaDir(id);
  await fsp.mkdir(dir, { recursive: true });
  let poster = 0;
  if (p.thumb) {
    await fsp.writeFile(path.join(dir, 'thumb.src'), p.thumb);
    await fsp.writeFile(path.join(dir, kind === 'audio' ? 'cover.jpg' : 'poster.jpg'), p.thumb);
    poster = now();
  }
  const link = { mode: p.mode, url: p.url, referer: p.referer || '', height, expected };
  q("INSERT INTO media(id,kind,title,artist,status,stage,origin,source_url,link,poster,duration,meta,added_by,created_at) VALUES(?,?,?,?,'queued','В очереди','link',?,?,?,?,'{}',?,?)")
    .run(id, kind, cleanText(c.body.title, 160) || p.title, p.artist || '', p.pageUrl, JSON.stringify(link), poster, p.duration || 0, c.user.id, now());
  probes.delete(String(c.body.token));
  broadcastMedia(id);
  startLinkJob(id);
  return { id };
});

/* ═════════════════════════════ Скачивание по ссылке ═════════════════════════════ */

let dlQueue = [];
let dlActive = 0;
function startLinkJob(id) { if (!dlQueue.includes(id)) dlQueue.push(id); pumpDownloads(); }
function pumpDownloads() {
  while (dlActive < MAX_DOWNLOADS && dlQueue.length) {     // не больше трёх загрузок одновременно
    const m = getMedia(dlQueue.shift());
    if (!m || m.status !== 'queued') continue;
    dlActive++;
    runLinkJob(m).catch(e => log('link', e)).finally(() => { dlActive--; pumpDownloads(); });
  }
}
async function runLinkJob(m) {
  const task = newTask(m.id);
  const tmp = path.join(TMP_DIR, m.id), dir = mediaDir(m.id);
  let spec = {};
  try { spec = JSON.parse(m.link || '{}'); } catch {}
  let ok = false;
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(tmp, { recursive: true });
    await fsp.mkdir(dir, { recursive: true });
    setMedia(m.id, { status: 'downloading', stage: 'Скачивание', progress: 0, error: '', retry: 0 });
    let file;
    for (let attempt = 0; ; attempt++) {
      try {
        file = spec.mode === 'direct' ? await downloadDirect(m, spec, tmp, task)
          : spec.mode === 'hls' ? await downloadHls(m, spec, tmp, task)
          : await downloadYt(m, spec, tmp, task);
        break;
      } catch (e) {
        if (task.cancelled) return;
        if (attempt === 0 && e.retryable) {      // таймаут и похожие сбои → один автоповтор
          log('link', m.id, 'автоповтор после ошибки:', e.message);
          if (e.needUpdate) await ytUpdate();
          liveSet(m.id, { stage: 'Повторная попытка', progress: 0, speed: 0, eta: 0 });
          continue;
        }
        throw e;
      }
    }
    if (task.cancelled) return;
    let info = null;
    const infoJson = path.join(tmp, 'src.info.json');
    try { info = JSON.parse(await fsp.readFile(infoJson, 'utf8')); } catch {}
    const ext = (path.extname(file) || '.mkv').toLowerCase();
    await moveFile(file, path.join(dir, 'orig' + ext));
    upd('media', m.id, { orig_file: 'orig' + ext });
    const thumb = fileOk(path.join(dir, 'thumb.src')) ? path.join(dir, 'thumb.src') : null;
    await processMedia(m.id, { task, thumb, tmp, infoJson, referer: spec.referer, info: spec.mode === 'ytdlp' && m.kind === 'video' ? info : null });
    ok = getMedia(m.id)?.status === 'ready';
  } catch (e) {
    if (task.cancelled || !getMedia(m.id)) return;
    if (!e.user) log('link', m.id, e);
    setMedia(m.id, { status: 'error', error: e.user ? e.message : 'Не удалось скачать видео', retry: 1, stage: '' });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (ok) fsp.rm(path.join(dir, 'thumb.src'), { force: true }).catch(() => {});
  }
}
const PROGRESS_TPL = 'download:PRG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(info.format_id)s';
/** Общий прогресс: видео и звук качаются отдельными файлами, а человеку показываем одну полоску. */
function ytProgress(expected, twoParts, report) {
  const st = { done: 0, cur: 0, curTotal: 0, fmt: null, parts: 0, speed: 0, p: 0, tooBig: false, merging: false };
  st.onLine = line => {
    if (line.startsWith('PRG|')) {
      const [, d, t, e, sp, fmt] = line.split('|');
      const dl = +d || 0, total = +t || +e || 0;
      if (st.fmt !== null && (fmt !== st.fmt || (st.cur > 4e6 && dl < st.cur * 0.25))) { st.done += Math.max(st.cur, 0); st.parts++; }
      st.fmt = fmt; st.cur = dl; st.curTotal = total;
      const have = st.done + dl, partial = st.done + Math.max(total, dl);
      const denom = expected > 0 ? Math.max(expected, partial) : partial * (twoParts && st.parts === 0 ? 1.08 : 1);
      st.p = Math.max(st.p, clamp(have / (denom || 1), 0, 0.995));
      if (+sp > 0) st.speed = st.speed ? st.speed * 0.75 + +sp * 0.25 : +sp;
      report(st.p, st.speed, st.speed > 0 ? Math.max(0, (denom - have) / st.speed) : 0, false);
    } else if (/larger than max-filesize/i.test(line)) st.tooBig = true;
    else if (/^\[(Merger|VideoRemuxer|FixupM3u8|FixupM4a|VideoConvertor)\]/.test(line)) { st.merging = true; report(st.p, 0, 0, true); }
  };
  return st;
}
async function downloadYt(m, spec, tmp, task) {
  if (!ytdlp.ok) throw new UserError('На сервере не установлен yt-dlp', 'notools');
  const disk = await diskInfo();
  const room = disk.total ? Math.floor((disk.free - DISK_RESERVE) / 2.2) : 0;
  if (disk.total && room < 16 * 1024 * 1024) throw new UserError('Не хватает места на диске', 'nospace');
  for (const f of await fsp.readdir(tmp)) if (f.startsWith('src.')) await fsp.rm(path.join(tmp, f), { force: true });
  const H = spec.height, audio = m.kind === 'audio';
  const args = [
    '-f', audio ? 'ba/b' : (H ? `bv*[height<=${H}]+ba/b[height<=${H}]/bv*+ba/b` : 'bv*+ba/b'),
    '-S', audio ? 'acodec:m4a' : 'res,fps,vcodec:h264,acodec:m4a',     // при равном качестве — H.264/AAC: их играют все браузеры
    '--merge-output-format', 'mkv', '--retries', '10', '--fragment-retries', '20', '--concurrent-fragments', '4',
    '--newline', '--progress', '--progress-template', PROGRESS_TPL,
    '--write-info-json', '--no-mtime', '-o', path.join(tmp, 'src.%(ext)s'),
    ...(room ? ['--max-filesize', String(room)] : []),
    ...ytCommon(spec.referer), ...(await cookieArgs(tmp)), '--', spec.url,
  ];
  const st = ytProgress(spec.expected, !audio, (p, speed, eta, merging) =>
    liveSet(m.id, { progress: p, speed, eta, stage: merging ? 'Склейка видео и звука' : 'Скачивание' }));
  // Если загрузка молчит 2,5 минуты — считаем это таймаутом. На склейке yt-dlp молчит законно, там не трогаем.
  const r = await run(BIN.ytdlp, args, { task, stall: () => (st.merging ? 0 : 150e3), onLine: st.onLine });
  if (task.cancelled) throw new Error('cancelled');
  if (r.spawnError) throw new UserError('На сервере не установлен yt-dlp', 'notools');
  if (st.tooBig) throw new UserError('Не хватает места на диске для этого видео', 'nospace');
  if (r.code !== 0) {
    log('yt-dlp', `загрузка не удалась (код ${r.code}): ${spec.url}\n` + lastLines(r.stderr, 10));
    throw ytError(r.stderr, r);
  }
  let best = null;
  for (const f of await fsp.readdir(tmp)) {
    if (!f.startsWith('src.') || /\.(json|part|ytdl|temp|tmp|txt)$/i.test(f) || /\.f[\w-]+\.\w+$/.test(f)) continue;
    const size = fs.statSync(path.join(tmp, f)).size;
    if (!best || size > best.size) best = { f, size };
  }
  if (!best || !best.size) {
    log('yt-dlp', 'загрузчик не оставил файла:\n' + lastLines(r.stderr, 10));
    throw new UserError('Загрузка завершилась без файла — попробуй ещё раз', 'nofile', { retryable: true, needUpdate: true });
  }
  return path.join(tmp, best.f);
}
/**
 * Готовые H.264-версии с сайта, чтобы не пересжимать самим.
 * YouTube отдаёт 2K/4K только в VP9/AV1, но 360p–1080p хранит и в H.264 (avc1) — берём их из того же списка formats
 * через --load-info-json (без повторного разбора страницы), перекладываем в MP4 и проверяем кодек и длительность.
 */
async function fetchSiteVersions(id, ctx, an) {
  const task = ctx.task;
  const formats = Array.isArray(ctx.info?.formats) ? ctx.info.formats : [];
  if (!formats.length || !ytdlp.ok || !fileOk(ctx.infoJson)) return;
  const m = getMedia(id);
  if (!m) return;
  const dir = mediaDir(id), dur = m.duration;
  const audio = pickSiteAudio(formats);
  const held = q("SELECT * FROM variants WHERE media_id=? AND status='held' AND height<=1080 ORDER BY height").all(id);
  for (const v of held) {
    if (task.cancelled || !getMedia(id)) return;
    const f = formats.filter(x => /^(avc|h264)/i.test(x.vcodec || '') && x.height && x.width && nominalOf(x.width, x.height) === v.height
      && Math.abs((+x.fps || an.fps) - an.fps) < 1.5 && !/storyboard/i.test(x.format_note || ''))
      .sort((a, b) => (isHls(a) - isHls(b)) || ((b.tbr || 0) - (a.tbr || 0)))[0];
    if (!f) continue;                                    // на сайте такой версии нет — сделаем сами
    const muxed = f.acodec && f.acodec !== 'none';
    if (!muxed && an.a && !audio) continue;
    const sel = muxed || !an.a ? String(f.format_id) : `${f.format_id}+${audio.format_id}`;
    const expected = fmtSizeOf(f, dur) + (muxed || !an.a ? 0 : fmtSizeOf(audio, dur));
    upd('variants', v.id, { status: 'working' });
    broadcastMedia(id);
    let done = false;
    try {
      const base = `alt_${v.height}`;
      const st = ytProgress(expected, !muxed && !!an.a, p => liveVar(id, v.id, p * 0.95));
      const r = await run(BIN.ytdlp, ['--load-info-json', ctx.infoJson, '-f', sel, '--merge-output-format', 'mkv',
        '--retries', '10', '--fragment-retries', '20', '--concurrent-fragments', '4', '--newline', '--progress', '--progress-template', PROGRESS_TPL,
        '--no-mtime', '-o', path.join(ctx.tmp, base + '.%(ext)s'), ...ytCommon(ctx.referer), ...(await cookieArgs(ctx.tmp))],
        { task, stall: () => (st.merging ? 0 : 150e3), onLine: st.onLine });
      if (task.cancelled) return;
      if (r.code !== 0) throw new Error(lastLines(r.stderr, 3));
      const got = (await fsp.readdir(ctx.tmp)).find(x => x.startsWith(base + '.') && !/\.(json|part|ytdl|temp|tmp|txt)$/i.test(x) && !/\.f[\w-]+\.\w+$/.test(x));
      if (!got) throw new Error('нет файла');
      const src = path.join(ctx.tmp, got), out = path.join(dir, v.file), tmpOut = path.join(dir, v.file.replace(/\.mp4$/, '.tmp.mp4'));
      const pa = analyze(await ffprobe(src));
      const rr = await ffmpegRun(['-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy',
        ...(pa.a ? (pa.a.codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']) : []),
        '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-f', 'mp4', tmpOut], 0, null, task);
      await fsp.rm(src, { force: true }).catch(() => {});
      if (task.cancelled) return;
      if (rr.code !== 0) throw new Error(lastLines(rr.stderr, 3));
      const chk = analyze(await ffprobe(tmpOut));       // проверяем кодек и длительность
      if (!chk.h264ok || Math.abs(chk.duration - dur) > Math.max(2, dur * 0.02) || (an.a && !chk.a)) {
        await fsp.rm(tmpOut, { force: true });
        throw new Error(`проверка не прошла: ${chk.v?.codec_name}, ${chk.duration} c вместо ${dur}`);
      }
      await fsp.rename(tmpOut, out);
      upd('variants', v.id, { status: 'ready', size: fs.statSync(out).size, w: chk.w, h: chk.h });
      const l = live.get(id); if (l) delete l.v[v.id];
      setMedia(id, { size: await dirSize(dir) });
      done = true;
      log('link', id, `готовая версия с сайта: ${v.label} (формат ${sel})`);
    } catch (e) {
      if (task.cancelled) return;
      log('link', id, `версию ${v.label} с сайта взять не удалось, сделаю сам:`, e.message);
    }
    if (!done) { upd('variants', v.id, { status: 'held' }); await fsp.rm(path.join(dir, v.file.replace(/\.mp4$/, '.tmp.mp4')), { force: true }).catch(() => {}); }
  }
}
/** Без yt-dlp: HLS одним проходом ffmpeg без пересжатия. */
async function downloadHls(m, spec, tmp, task) {
  const out = path.join(tmp, 'src.mkv');
  const r = await ffmpegRun(['-user_agent', UA, ...(spec.referer ? ['-referer', spec.referer] : []), '-protocol_whitelist', 'http,https,tcp,tls,crypto',
    '-i', spec.url, '-c', 'copy', '-f', 'matroska', '-progress', 'pipe:1', '-nostats', out],
    m.duration, p => liveSet(m.id, { progress: p, stage: 'Скачивание' }), task);
  if (task.cancelled) throw new Error('cancelled');
  if (r.code !== 0 || !fileOk(out)) {
    log('hls', m.id, lastLines(r.stderr, 8));
    const s = r.stderr.toLowerCase();
    if (/no space left/.test(s)) throw new UserError('Не хватает места на диске', 'nospace');
    if (/403|forbidden/.test(s)) throw new UserError('Сайт отказал в доступе (403)', 'forbidden');
    if (/404|not found/.test(s)) throw new UserError('Видео удалено или недоступно', 'gone');
    throw new UserError('Не удалось скачать поток — попробуй ещё раз', 'timeout', { retryable: true });
  }
  return out;
}
/** Без yt-dlp: прямой файл потоком. Каждый редирект проверяется, обрыв — докачка с того же места. */
async function downloadDirect(m, spec, tmp, task) {
  const disk = await diskInfo();
  const ext = (MEDIA_EXT.exec(new URL(spec.url).pathname) || ['.mp4'])[0].toLowerCase();
  const out = path.join(tmp, 'src' + ext);
  await fsp.rm(out, { force: true });
  const limit = disk.total ? (disk.free - DISK_RESERVE) / 2.2 : Infinity;
  let got = 0, total = 0, speed = 0, mark = now(), markBytes = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const headers = { ...(spec.referer ? { Referer: spec.referer } : {}), ...(got ? { Range: `bytes=${got}-` } : {}) };
      const { res } = await safeRequest(spec.url, { headers, timeout: 30000 });
      if (res.statusCode >= 400) {
        res.resume();
        const c = res.statusCode;
        throw new UserError(c === 403 ? 'Сайт отказал в доступе (403)' : c === 404 || c === 410 ? 'Файл удалён или недоступен' : c === 429 ? 'Сайт временно ограничил запросы — попробуй позже' : `Сайт ответил ошибкой ${c}`, 'http');
      }
      if (got && res.statusCode !== 206) { got = 0; await fsp.rm(out, { force: true }); }     // сервер не умеет докачку — начинаем сначала
      const len = +res.headers['content-length'] || 0;
      if (len) total = got + len;
      if (total > limit) { res.destroy(); throw new UserError('Не хватает места на диске для этого файла', 'nospace'); }
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(out, { flags: got ? 'a' : 'w' });
        let idle, settled = false;
        const abort = () => res.destroy(new Error('cancelled'));
        const end = err => {
          if (settled) return; settled = true;
          clearTimeout(idle); task.aborts.delete(abort);
          if (err) ws.end(() => reject(err)); else resolve();
        };
        const arm = () => { clearTimeout(idle); idle = setTimeout(() => res.destroy(new Error('stalled')), 60e3); };
        task.aborts.add(abort); arm();
        res.on('data', c => {
          got += c.length; arm();
          if (got > limit) return res.destroy(new UserError('Не хватает места на диске для этого файла', 'nospace'));
          const t = now();
          if (t - mark >= 700) {
            const inst = (got - markBytes) / ((t - mark) / 1000);
            speed = speed ? speed * 0.7 + inst * 0.3 : inst; mark = t; markBytes = got;
            liveSet(m.id, { progress: total ? clamp(got / total, 0, 0.995) : 0, stage: 'Скачивание', speed, eta: total && speed ? (total - got) / speed : 0 });
          }
        });
        res.on('error', end); res.on('aborted', () => end(new Error('aborted')));
        ws.on('error', end); ws.on('finish', () => end());
        res.pipe(ws);
      });
      if (total && got < total) throw new Error('incomplete');
      break;
    } catch (e) {
      if (task.cancelled) throw new Error('cancelled');
      if (e.user) throw e;
      if (e.code === 'ESSRF') throw ssrfErr();
      if (attempt >= 4) throw new UserError('Сайт не отвечает — попробуй ещё раз чуть позже', 'timeout', { retryable: true });
      try { got = fs.statSync(out).size; } catch { got = 0; }
      markBytes = got; mark = now();
      await sleep(1500 * (attempt + 1));
    }
  }
  if (!fileOk(out)) throw new UserError('Файл скачался пустым', 'nofile');
  return out;
}

/* ═════════════════════════════ WebSocket (RFC 6455, без библиотек) ═════════════════════════════ */

const conns = new Map();   // cid → Conn
let connSeq = 0;
const WS_MAX = 256 * 1024;
class Conn {
  constructor(socket, user, sid) {
    this.cid = (++connSeq).toString(36) + rid(3);
    this.s = socket; this.user = user; this.sid = sid;
    this.buf = Buffer.alloc(0); this.frags = []; this.fragLen = 0;
    this.alive = true; this.closed = false;
    this.room = null; this.voice = false; this.mic = false; this.buffering = false; this.noHoldUntil = 0;
    this.tokens = 80; this.tokAt = now(); this.chatAt = [];
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => {});
    conns.set(this.cid, this);
  }
  frame(op, payload) {
    if (this.closed && op !== 0x8) return;
    const n = payload.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
    try {
      if (this.s.writableLength > 8 * 1024 * 1024) return this.s.destroy();     // клиент не успевает читать — отключаем
      this.s.write(Buffer.concat([head, payload]));
    } catch {}
  }
  send(obj) { this.frame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const b = Buffer.alloc(2 + Buffer.byteLength(reason));
    b.writeUInt16BE(code, 0); b.write(reason, 2);
    this.frame(0x8, b);
    try { this.s.end(); } catch {}
    setTimeout(() => { try { this.s.destroy(); } catch {} }, 1500).unref();
    this.onClose();
  }
  onClose() {
    if (this.closed) return;
    this.closed = true;
    conns.delete(this.cid);
    leaveRoom(this);
    presenceChanged();
    try { q('UPDATE users SET seen_at=? WHERE id=?').run(now(), this.user.id); } catch {}
  }
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; if (buf.readUInt32BE(2)) return this.close(1009); len = buf.readUInt32BE(6); off = 10; }
      if (!masked || (buf[0] & 0x70)) return this.close(1002);
      if (len > WS_MAX) return this.close(1009);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i & 3];
      this.buf = buf.subarray(off + 4 + len);
      if (op === 0x8) return this.close(1000);
      if (op === 0x9) { this.frame(0xA, payload); continue; }
      if (op === 0xA) { this.alive = true; continue; }
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0x0 && this.frags.length) return this.close(1002);
        this.frags.push(payload); this.fragLen += len;
        if (this.fragLen > WS_MAX) return this.close(1009);
        if (fin) {
          const text = (this.frags.length === 1 ? this.frags[0] : Buffer.concat(this.frags)).toString('utf8');
          this.frags = []; this.fragLen = 0;
          this.alive = true;
          onMessage(this, text);
          if (this.closed) return;
        }
        continue;
      }
      return this.close(1002);
    }
  }
}
function onUpgrade(req, socket) {
  const deny = code => { try { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); } catch {} socket.destroy(); };
  let url;
  try { url = new URL(req.url, ORIGIN); } catch { return deny('400 Bad Request'); }
  if (url.pathname !== '/ws' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return deny('404 Not Found');
  if (!originOk(req)) return deny('403 Forbidden');            // чужие сайты не могут открыть сокет от имени пользователя
  const sess = getSession(req);
  if (!sess) return deny('401 Unauthorized');
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers['sec-websocket-version'] !== '13') return deny('400 Bad Request');
  const mine = [...conns.values()].filter(c => c.user.id === sess.user.id);
  if (mine.length >= 8) mine[0].close(4002, 'too many');
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true); socket.setTimeout(0);
  const c = new Conn(socket, sess.user, sess.sid);
  c.send({ t: 'hello', cid: c.cid, now: now(), online: onlineIds(), rooms: roomsList() });
  presenceChanged();
}
setInterval(() => {
  for (const c of conns.values()) {
    if (!c.alive) { try { c.s.destroy(); } catch {} continue; }
    c.alive = false;
    c.frame(0x9, Buffer.alloc(0));
  }
}, 25e3).unref();

function broadcast(msg, except) {
  const s = JSON.stringify(msg);
  for (const c of conns.values()) if (c !== except) c.send(s);
}
function toRoom(r, msg, exceptCid) {
  const s = JSON.stringify(msg);
  for (const c of r.members.values()) if (c.cid !== exceptCid) c.send(s);
}
const onlineIds = () => [...new Set([...conns.values()].map(c => c.user.id))];
let presTimer = null;
function presenceChanged() {
  if (presTimer) return;
  presTimer = setTimeout(() => { presTimer = null; broadcast({ t: 'presence', online: onlineIds() }); }, 200);
}
function onMessage(c, raw) {
  const t = now();
  c.tokens = Math.min(80, c.tokens + (t - c.tokAt) / 1000 * 25); c.tokAt = t;    // не больше ~25 сообщений в секунду
  if (c.tokens < 1) return;
  c.tokens--;
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string' || !Object.hasOwn(WS, m.t)) return;
  try { WS[m.t](c, m); } catch (e) { log('ws', m.t, e); }
}

/* ═════════════════════════════ Комнаты: просмотр и музыка вместе ═════════════════════════════ */

const rooms = new Map();
function newRoom(kind, mediaId, by) {
  const r = {
    id: kind === 'music' ? 'music' : rid(6), kind, mediaId: mediaId || null, by,
    playing: false, pos: 0, at: now(), rate: 1, duration: 0,     // состояние живёт на сервере
    members: new Map(), hold: new Map(), chat: [], queue: [], cur: null, endTimer: null, emptyTimer: null,
  };
  rooms.set(r.id, r);
  return r;
}
/** Текущая позиция по серверным часам. Пока комната кого-то ждёт — время стоит. */
function roomPos(r, t = now()) {
  if (!r.playing || r.hold.size) return r.pos;
  const p = r.pos + (t - r.at) / 1000 * r.rate;
  return r.duration ? Math.min(r.duration, p) : p;
}
function roomView(r, extra) {
  return {
    t: 'room', id: r.id, kind: r.kind, mediaId: r.mediaId, playing: r.playing, pos: r.pos, at: r.at, rate: r.rate, now: now(),
    hold: [...new Set([...r.hold.keys()].map(cid => r.members.get(cid)?.user.id).filter(Boolean))],
    members: [...r.members.values()].map(c => ({ cid: c.cid, uid: c.user.id, voice: c.voice, mic: c.mic, buf: c.buffering })),
    queue: r.kind === 'music' ? r.queue : undefined, cur: r.cur, ...extra,
  };
}
function roomsList() {
  return [...rooms.values()].filter(r => r.members.size).map(r => {
    const m = r.mediaId ? getMedia(r.mediaId) : null;
    return {
      id: r.id, kind: r.kind, mediaId: r.mediaId, title: m?.title || '', artist: m?.artist || '', poster: m?.poster || 0, duration: m?.duration || 0,
      playing: r.playing && !r.hold.size, pos: roomPos(r), at: now(), rate: r.rate,
      users: [...new Set([...r.members.values()].map(c => c.user.id))],
    };
  });
}
let roomsTimer = null;
function roomsChanged() {
  if (roomsTimer) return;
  roomsTimer = setTimeout(() => { roomsTimer = null; broadcast({ t: 'rooms', rooms: roomsList() }); }, 150);
}
function scheduleEnd(r) {
  clearTimeout(r.endTimer); r.endTimer = null;
  if (!r.playing || r.hold.size || !r.duration || !r.members.size) return;
  const left = (r.duration - roomPos(r)) / r.rate * 1000;
  r.endTimer = setTimeout(() => onEnded(r), clamp(left, 0, 2e9) + 400);
}
function onEnded(r) {
  if (rooms.get(r.id) !== r || !r.playing || r.hold.size) return;
  if (roomPos(r) < r.duration - 0.6) return scheduleEnd(r);
  if (r.kind === 'music') {
    const next = r.queue[r.queue.findIndex(x => x.qid === r.cur) + 1];
    if (next) musicSet(r, next.qid, true);
    else { r.playing = false; r.pos = 0; r.at = now(); }
  } else { r.playing = false; r.pos = r.duration; r.at = now(); }
  pushRoom(r, 0, 'end');
}
function pushRoom(r, by, act) {
  toRoom(r, roomView(r, by !== undefined ? { by, act } : null));
  scheduleEnd(r);
  roomsChanged();
}
function clearHolds(r) { for (const t of r.hold.values()) clearTimeout(t); r.hold.clear(); }
/** Кто-то подгружает видео: комната замирает и ждёт его (но не дольше 12 секунд). */
function holdAdd(r, c) {
  if (!r.hold.size) r.pos = roomPos(r);
  r.hold.set(c.cid, setTimeout(() => {
    c.noHoldUntil = now() + 30e3;            // совсем медленный интернет — догонит перемоткой, остальных не держим
    if (holdDel(r, c.cid)) pushRoom(r);
  }, 12e3));
  r.at = now();
}
function holdDel(r, cid) {
  const t = r.hold.get(cid);
  if (t === undefined) return false;
  clearTimeout(t); r.hold.delete(cid);
  if (!r.hold.size) r.at = now();
  return true;
}
function joinRoom(c, r) {
  if (c.room === r) return c.send({ t: 'joined', room: roomView(r), chat: r.chat.slice(-100) });
  leaveRoom(c);
  clearTimeout(r.emptyTimer); r.emptyTimer = null;
  r.members.set(c.cid, c);
  c.room = r; c.voice = false; c.mic = false; c.buffering = false;
  c.send({ t: 'joined', room: roomView(r), chat: r.chat.slice(-100) });
  pushRoom(r, c.user.id, 'join');
}
function leaveRoom(c) {
  const r = c.room;
  if (!r) return;
  c.room = null; c.voice = false; c.mic = false; c.buffering = false;
  r.members.delete(c.cid);
  holdDel(r, c.cid);
  if (!r.members.size) {
    r.pos = roomPos(r); r.playing = false; clearHolds(r); r.at = now();      // никого нет — ставим на паузу
    if (r.kind !== 'music') r.emptyTimer = setTimeout(() => { if (!r.members.size) { rooms.delete(r.id); clearTimeout(r.endTimer); roomsChanged(); } }, 90e3);
  }
  pushRoom(r, c.user.id, 'leave');
}
function closeRoom(r, msg) {
  toRoom(r, { t: 'closed', id: r.id, msg });
  for (const c of r.members.values()) { c.room = null; c.voice = false; }
  r.members.clear(); clearHolds(r); clearTimeout(r.endTimer); clearTimeout(r.emptyTimer);
  rooms.delete(r.id);
  roomsChanged();
}
function musicSet(r, qid, play) {
  const it = qid ? r.queue.find(x => x.qid === qid) : null;
  const media = it ? getMedia(it.mediaId) : null;
  clearHolds(r);
  if (!media) { r.cur = null; r.mediaId = null; r.playing = false; r.pos = 0; r.duration = 0; }
  else { r.cur = it.qid; r.mediaId = media.id; r.duration = media.duration; r.pos = 0; if (play !== undefined) r.playing = !!play; }
  r.at = now();
}
function roomsDropMedia(id) {
  for (const r of [...rooms.values()]) {
    if (r.kind === 'video') { if (r.mediaId === id) closeRoom(r, 'Фильм удалён из библиотеки'); continue; }
    if (!r.queue.some(x => x.mediaId === id)) continue;
    const i = r.queue.findIndex(x => x.qid === r.cur);
    const wasCur = i >= 0 && r.queue[i].mediaId === id;
    const after = wasCur ? r.queue.slice(i + 1).find(x => x.mediaId !== id) : null;
    r.queue = r.queue.filter(x => x.mediaId !== id);
    if (wasCur) musicSet(r, after ? after.qid : null, r.playing);
    pushRoom(r);
  }
}
function roomsTouchMedia(id) { for (const r of rooms.values()) if (r.mediaId === id) return roomsChanged(); }

const WS = {
  ping(c, m) { c.send({ t: 'pong', c: m.c, s: now() }); },      // сверка часов клиента с сервером
  open(c, m) {
    if (c.user.role !== 'owner') return c.send({ t: 'err', msg: 'Открыть комнату может только владелец' });
    const media = getMedia(String(m.mediaId));
    if (!media || media.kind !== 'video' || media.status !== 'ready') return c.send({ t: 'err', msg: 'Этот фильм ещё не готов' });
    // Один фильм — одна комната: повторное «Смотреть» ведёт в уже идущую.
    let r = [...rooms.values()].find(x => x.kind === 'video' && x.mediaId === media.id);
    const fresh = !r;
    if (!r) { r = newRoom('video', media.id, c.user.id); r.duration = media.duration; }
    joinRoom(c, r);
    if (fresh) {
      const note = JSON.stringify({ t: 'notify', kind: 'watch', roomId: r.id, mediaId: media.id, title: media.title, by: c.user.id });
      for (const k of conns.values()) if (k.user.id !== c.user.id) k.send(note);
    }
  },
  join(c, m) {
    const id = String(m.roomId);
    let r = rooms.get(id);
    if (!r && id === 'music') r = newRoom('music', null, c.user.id);
    if (!r) return c.send({ t: 'err', code: 'noroom', msg: 'Эта комната уже закрыта' });
    joinRoom(c, r);
  },
  leave(c) { leaveRoom(c); },
  close(c) {
    const r = c.room;
    if (r && r.kind === 'video' && c.user.role === 'owner') closeRoom(r, 'Владелец закрыл комнату');
  },
  ctl(c, m) {
    const r = c.room;
    if (!r || !r.mediaId) return;
    const dur = r.duration || 0, cur = roomPos(r);
    if (m.a === 'play') { if (r.playing) return; r.pos = dur && cur >= dur - 0.5 ? 0 : cur; r.playing = true; }
    else if (m.a === 'pause') { if (!r.playing) return; r.pos = cur; r.playing = false; clearHolds(r); }
    else if (m.a === 'seek') { const p = +m.pos; if (!Number.isFinite(p)) return; r.pos = clamp(p, 0, dur || Math.max(0, p)); }
    else if (m.a === 'rate') { const x = +m.rate; if (!(x >= 0.25 && x <= 3)) return; r.pos = cur; r.rate = x; }
    else return;
    r.at = now();
    pushRoom(r, c.user.id, m.a);
  },
  buf(c, m) {
    const r = c.room;
    if (!r) return;
    const on = !!m.on;
    if (c.buffering === on && r.hold.has(c.cid) === on) return;
    c.buffering = on;
    if (on) { if (r.playing && !r.hold.has(c.cid) && now() >= c.noHoldUntil) holdAdd(r, c); }
    else holdDel(r, c.cid);
    pushRoom(r);
  },
  chat(c, m) {
    const r = c.room;
    if (!r) return;
    const text = cleanText(m.text, 500);
    if (!text) return;
    const t = now();
    c.chatAt = c.chatAt.filter(x => t - x < 10e3);
    if (c.chatAt.length >= 8) return c.send({ t: 'err', msg: 'Не так быстро :)' });
    c.chatAt.push(t);
    const msg = { id: rid(6), uid: c.user.id, text, ts: t, at: r.mediaId ? Math.floor(roomPos(r)) : null };
    r.chat.push(msg);
    if (r.chat.length > 200) r.chat.shift();
    toRoom(r, { t: 'chat', msg });
  },
  react(c, m) {
    const r = c.room;
    if (!r || !REACTIONS.includes(m.e)) return;
    toRoom(r, { t: 'react', uid: c.user.id, e: m.e });
  },
  setmedia(c, m) {     // фильм в комнате меняет только владелец
    const r = c.room;
    if (!r || r.kind !== 'video' || c.user.role !== 'owner') return;
    const media = getMedia(String(m.mediaId));
    if (!media || media.kind !== 'video' || media.status !== 'ready') return c.send({ t: 'err', msg: 'Этот фильм ещё не готов' });
    if (media.id === r.mediaId) return;
    if ([...rooms.values()].some(x => x !== r && x.kind === 'video' && x.mediaId === media.id)) return c.send({ t: 'err', msg: 'Этот фильм уже идёт в другой комнате' });
    r.mediaId = media.id; r.duration = media.duration; r.pos = 0; r.playing = false; r.rate = 1; clearHolds(r); r.at = now();
    pushRoom(r, c.user.id, 'media');
  },
  q(c, m) {            // общая очередь музыки
    const r = c.room;
    if (!r || r.kind !== 'music') return;
    const op = String(m.op);
    const curIdx = () => r.queue.findIndex(x => x.qid === r.cur);
    if (op === 'add' || op === 'play') {
      const items = [];
      for (const id of (Array.isArray(m.ids) ? m.ids : [m.mediaId]).slice(0, 300)) {
        const media = getMedia(String(id));
        if (!media || media.kind !== 'audio' || media.status !== 'ready') continue;
        if (r.queue.length + items.length >= 600) break;
        items.push({ qid: rid(5), mediaId: media.id, by: c.user.id });
      }
      if (!items.length) return;
      r.queue.splice(op === 'play' ? curIdx() + 1 : r.queue.length, 0, ...items);
      if (op === 'play' || !r.cur) musicSet(r, items[0].qid, true);
    } else if (op === 'del') {
      const i = r.queue.findIndex(x => x.qid === m.qid);
      if (i < 0) return;
      const wasCur = r.queue[i].qid === r.cur;
      r.queue.splice(i, 1);
      if (wasCur) musicSet(r, r.queue[i] ? r.queue[i].qid : null, r.playing);
    } else if (op === 'move') {
      const i = r.queue.findIndex(x => x.qid === m.qid), to = clamp(Math.trunc(+m.to) || 0, 0, r.queue.length - 1);
      if (i < 0 || i === to) return;
      const [it] = r.queue.splice(i, 1);
      r.queue.splice(to, 0, it);
    } else if (op === 'jump') {
      if (!r.queue.some(x => x.qid === m.qid)) return;
      musicSet(r, m.qid, true);
    } else if (op === 'next') {
      const next = r.queue[curIdx() + 1];
      if (!next) return;
      musicSet(r, next.qid, true);
    } else if (op === 'prev') {
      const i = curIdx();
      if (i < 0) return;
      if (roomPos(r) > 3 || i === 0) { r.pos = 0; r.at = now(); }       // как в обычном плеере: сначала — в начало трека
      else musicSet(r, r.queue[i - 1].qid, true);
    } else if (op === 'clear') { r.queue = []; musicSet(r, null); }
    else return;
    pushRoom(r, c.user.id, 'q' + op);
  },
  voice(c, m) {        // голосовой чат: сервер только сводит участников, звук идёт напрямую (WebRTC mesh)
    const r = c.room;
    if (!r) return;
    const on = !!m.on, was = c.voice;
    if (on && !was && [...r.members.values()].filter(k => k.voice).length >= 8) return c.send({ t: 'err', msg: 'В голосовом чате уже 8 человек — больше не помещается' });
    c.voice = on; c.mic = on && !!m.mic;
    if (on && !was) c.send({ t: 'voice-peers', peers: [...r.members.values()].filter(k => k.voice && k !== c).map(k => ({ cid: k.cid, uid: k.user.id })) });
    pushRoom(r);
  },
  speak(c, m) {
    const r = c.room;
    if (r && c.voice) toRoom(r, { t: 'speak', cid: c.cid, uid: c.user.id, on: !!m.on }, c.cid);
  },
  rtc(c, m) {
    const r = c.room;
    if (!r || !c.voice) return;
    const k = r.members.get(String(m.to));
    if (!k || !k.voice || !m.d || typeof m.d !== 'object') return;
    k.send({ t: 'rtc', from: c.cid, uid: c.user.id, d: m.d });
  },
};

/* ═════════════════════════════ Telegram-бот ═════════════════════════════ */

const bot = { ok: false, username: '', mainApp: false };
async function tgApi(method, params = {}, timeout = 20000) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeout),
  });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error(`${method}: ${j?.description || r.status}`);
  return j.result;
}
/** Ссылка, открывающая Mini App сразу на нужном месте (приглашение, комната). */
function tgLink(payload) {
  if (!bot.ok) return null;
  // Если у бота настроен Main Mini App — открываем его напрямую и сразу на весь экран, иначе через /start с кнопкой.
  return bot.mainApp ? `https://t.me/${bot.username}?startapp=${payload}&mode=fullscreen` : `https://t.me/${bot.username}?start=${payload}`;
}
const appButton = (payload, text = `Открыть «${APP_NAME}»`) => ({
  inline_keyboard: [[{ text, web_app: { url: PUBLIC_URL + '/' + (payload ? '?sp=' + encodeURIComponent(payload) : '') } }]],
});
async function onTgMessage(msg) {
  if (!msg || !msg.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') return;
  const chat_id = msg.chat.id;
  if (!SECURE) return tgApi('sendMessage', { chat_id, text: 'Mini App работает только по HTTPS. Укажи в .env настоящий домен с сертификатом (DOMAIN=tv.example.com).' });
  if (/^\/id\b/.test(msg.text)) return tgApi('sendMessage', { chat_id, text: `Твой Telegram ID: ${msg.from?.id}` });
  const m = /^\/start(?:@\w+)?(?:\s+([\w-]{1,64}))?/.exec(msg.text);
  const payload = m && m[1] ? m[1] : '';
  let text = `«${APP_NAME}» — маленький кинозал для своих: фильмы и музыка вместе с друзьями.\n\nЖми кнопку ниже — откроется на весь экран.`;
  if (payload.startsWith('inv_')) text = `Тебя пригласили в «${APP_NAME}» — кинозал для своих.\n\nОткрой приложение и придумай логин и пароль. Приглашение одноразовое и действует 7 дней.`;
  else if (payload.startsWith('room_')) text = 'Тебя зовут смотреть вместе. Заходи — комната уже открыта.';
  await tgApi('sendMessage', { chat_id, text, reply_markup: appButton(payload) });
}
async function startBot() {
  if (!BOT_TOKEN) return log('bot', 'BOT_TOKEN не задан — Telegram-бот выключен, сайт работает как обычный');
  for (;;) {
    try {
      const me = await tgApi('getMe');
      bot.username = me.username; bot.mainApp = !!me.has_main_web_app; bot.ok = true;
      break;
    } catch (e) { log('bot', 'не удалось подключиться к Telegram:', e.message); await sleep(15e3); }
  }
  log('bot', `@${bot.username} запущен${bot.mainApp ? ' (Main Mini App настроен)' : ''}`);
  try {
    await tgApi('deleteWebhook');
    await tgApi('setMyCommands', { commands: [{ command: 'start', description: `Открыть «${APP_NAME}»` }, { command: 'id', description: 'Мой Telegram ID' }] });
    if (SECURE) await tgApi('setChatMenuButton', { menu_button: { type: 'web_app', text: APP_NAME, web_app: { url: PUBLIC_URL + '/' } } });
    else log('bot', 'DOMAIN без HTTPS — кнопка Mini App не выставлена (Telegram открывает Mini App только по https)');
  } catch (e) { log('bot', e.message); }
  let offset = 0;
  for (;;) {
    try {
      const updates = await tgApi('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 65000);
      for (const u of updates) {
        offset = u.update_id + 1;
        onTgMessage(u.message).catch(e => log('bot', e.message));
      }
    } catch (e) {
      if (!/timeout|aborted/i.test(String(e.message))) log('bot', 'getUpdates:', e.message);
      await sleep(/409/.test(String(e.message)) ? 20e3 : 3e3);
    }
  }
}
/* Позвать друзей в комнату сообщением от бота (тем, у кого привязан Telegram) */
route('POST', '/api/rooms/:id/call', { auth: 'owner' }, async c => {
  rateLimit('call:' + c.user.id, 4, 10 * 60e3, 'Друзей уже позвали — не будем их засыпать сообщениями.');
  const r = rooms.get(c.params.id);
  if (!r) throw bad('Комната уже закрыта', 404);
  if (!bot.ok || !SECURE) throw bad('Telegram-бот не подключён', 503);
  const media = r.mediaId ? getMedia(r.mediaId) : null;
  const text = r.kind === 'music' ? `${c.user.name} зовёт слушать музыку вместе` : `${c.user.name} зовёт смотреть «${media?.title || 'фильм'}»`;
  let sent = 0;
  for (const u of q('SELECT * FROM users WHERE tg_id IS NOT NULL AND id<>?').all(c.user.id)) {
    try { await tgApi('sendMessage', { chat_id: u.tg_id, text, reply_markup: appButton('room_' + r.id, 'Присоединиться') }); sent++; } catch {}
  }
  return { sent };
});

/* ═════════════════════════════ Запуск ═════════════════════════════ */

function recoverAfterRestart() {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  // Недокачанное по ссылке помечаем ошибкой — на карточке появится «Повторить».
  q("UPDATE media SET status='error', error='Загрузка прервана перезапуском сервера', retry=1, stage='', progress=0 WHERE status IN ('queued','downloading')").run();
  q("UPDATE variants SET status='pending' WHERE status IN ('working','held')").run();
  // Старые брошенные загрузки файлов (неделя без движения) убираем.
  for (const u of q('SELECT * FROM uploads WHERE created_at<?').all(now() - 7 * 24 * 3600e3)) deleteMedia(u.media_id).catch(() => {});
  for (const d of fs.readdirSync(MEDIA_DIR)) if (!getMedia(d)) fs.rmSync(path.join(MEDIA_DIR, d), { recursive: true, force: true });
}
function resumeProcessing() {
  // Обработка, прерванная перезапуском, продолжается сама.
  for (const m of q("SELECT * FROM media WHERE status='processing'").all()) {
    const hasSrcJob = q("SELECT 1 AS x FROM variants WHERE media_id=? AND kind='source'").get(m.id);
    if (hasSrcJob) continue;                                  // исходник уже в очереди перекодирования
    if (m.orig_file && fileOk(path.join(mediaDir(m.id), m.orig_file))) processMedia(m.id);
    else setMedia(m.id, { status: 'error', error: 'Обработка прервана перезапуском сервера', retry: 1, stage: '' });
  }
  pumpTranscodes();
}

const tlsOpts = env.TLS_CERT && env.TLS_KEY ? { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) } : null;
const server = tlsOpts ? https.createServer(tlsOpts, onRequest) : http.createServer(onRequest);
server.on('upgrade', onUpgrade);
server.requestTimeout = 30 * 60e3;       // большие куски по медленной сети
server.keepAliveTimeout = 65e3;
server.on('clientError', (e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });

function shutdown() {
  log('main', 'останавливаюсь…');
  for (const id of tasks.keys()) cancelTask(id);
  for (const c of conns.values()) { try { c.s.destroy(); } catch {} }
  server.close();
  setTimeout(() => { try { db.close(); } catch {} process.exit(0); }, 400);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', e => log('main', 'unhandledRejection', e));
process.on('uncaughtException', e => log('main', 'uncaughtException', e));

(async () => {
  recoverAfterRestart();
  server.listen(PORT, env.HOST || '0.0.0.0', () => {
    log('main', `«${APP_NAME}» слушает порт ${PORT} · адрес ${PUBLIC_URL}`);
    if (!DOMAIN) log('main', 'DOMAIN не задан в .env — режим разработки (http://localhost)');
    if (!hasOwner()) log('main', `Владелец ещё не создан. Открой сайт и введи код настройки: ${SETUP_CODE}`);
  });
  await detectTools();
  resumeProcessing();
  ytUpdate(true);
  setInterval(() => ytUpdate(true), 6 * 3600e3).unref();
  startBot();
})();

