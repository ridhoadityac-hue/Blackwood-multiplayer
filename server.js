#!/usr/bin/env node
/* ============================================================================
 BLACKWOOD: DEAD COUNTRY — MULTIPLAYER SERVER V1
 Tanpa dependensi (hanya modul bawaan Node.js >= 18). Satu file:
   - REST API  : akun, login, foto profil, teman, Team Code
   - WebSocket : lobby real-time + sinkronisasi pemain (RFC 6455, ditulis sendiri)
 Semua validasi penting dilakukan DI SINI, bukan di game.

 Jalankan :  node server.js
 Developer:  node server.js --create-developer      (membuat/ubah akun Ryusei, ID 01)
 Env      :  PORT, DATA_DIR, ALLOWED_ORIGINS (pisah koma, default *), TRUST_PROXY=1
 ========================================================================== */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

/* ---------------------------------------------------------------- KONFIG */
const CFG = {
  PORT: +process.env.PORT || 8080,
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'data'),
  ORIGINS: (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean),
  TRUST_PROXY: process.env.TRUST_PROXY === '1',
  USERNAME_MIN: 8, USERNAME_MAX: 10,
  PASSWORD_MIN: 8, PASSWORD_MAX: 64,
  TEAM_MAX: 6, TEAM_CODE_LEN: 12,
  TEAM_TTL_MS: 2 * 3600 * 1000,       // kode berlaku 2 jam sejak dibuat / sejak kembali ke lobby
  SESSION_TTL_MS: 400 * 86400 * 1000, // sesi login tersimpan (sliding)
  MAX_SESSIONS: 10, MAX_FRIENDS: 100, MAX_PENDING: 50,
  AVATAR_MAX_BYTES: 200 * 1024, AVATAR_MAX_DIM: 1024,
  DEV_ID: '01', DEV_NAME: 'Ryusei',
  MAX_SPEED: 16,                      // m/s: slide 11.8, mode nyawa-terakhir sprint ~13.6
  SPAWN: { x: 20, z: 0, r: 40 },      // posisi awal game (CH/2, 0) + toleransi
  WORLD_LIM: 2e6
};
const VERSION = '1.0.0';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const now = () => Date.now();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const eq = (a, b) => { a = Buffer.from(a); b = Buffer.from(b); return a.length === b.length && crypto.timingSafeEqual(a, b); };

/* -------------------------------------------------------------- DATABASE */
fs.mkdirSync(path.join(CFG.DATA_DIR, 'avatars'), { recursive: true });
const DB_FILE = path.join(CFG.DATA_DIR, 'db.json');
let db = { v: 1, accounts: {}, names: {}, sessions: {} };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('db.json rusak, server dihentikan agar data tidak tertimpa:', e.message); process.exit(1); }
}
let saveTimer = null, saving = false, dirty = false;
function save() { dirty = true; if (!saveTimer) saveTimer = setTimeout(flush, 250); }
function flush() {
  saveTimer = null; if (saving) { save(); return; } if (!dirty) return;
  saving = true; dirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), (e) => {
    if (e) { saving = false; dirty = true; console.error('gagal simpan:', e.message); return; }
    fs.rename(tmp, DB_FILE, (e2) => { saving = false; if (e2) console.error('gagal rename:', e2.message); if (dirty) save(); });
  });
}
function flushSync() { try { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); } catch (e) { console.error(e.message); } }

/* ---------------------------------------------------------------- AKUN */
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '_': '' };
const squash = (s) => s.toLowerCase().replace(/[013457_]/g, (c) => LEET[c]);
const RESERVED = ['ryusei', 'developer', 'admin', 'moderator', 'official', 'blackwood'];
const isReserved = (name) => { const q = squash(name); return RESERVED.some((r) => q.includes(r)); };

const OUTFITS = 5, SKINS = 6, HAIRS = 5, HAIRCOLS = 6, EYES = 4, BEARDS = 4, MOUTHS = 3;
const DEFAULT_LOOK = { outfit: 0, skin: 0, hair: 1, hairColor: 0, eyes: 0, beard: 0, mouth: 0 };
function cleanLook(o) {
  const L = Object.assign({}, DEFAULT_LOOK), lim = { outfit: OUTFITS, skin: SKINS, hair: HAIRS, hairColor: HAIRCOLS, eyes: EYES, beard: BEARDS, mouth: MOUTHS };
  if (o && typeof o === 'object') for (const k in lim) { const v = o[k]; if (Number.isInteger(v) && v >= 0 && v < lim[k]) L[k] = v; }
  return L;
}
function newId() { for (;;) { const id = String(crypto.randomInt(10000000, 100000000)); if (id !== CFG.DEV_ID && !db.accounts[id]) return id; } }

function scryptHash(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k.toString('hex'))));
}
async function makePass(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: await scryptHash(pw, salt) }; }
async function checkPass(p, pw) { try { return eq(await scryptHash(pw, p.salt), p.hash); } catch (e) { return false; } }
function newRecovery() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = '';
  for (let i = 0; i < 16; i++) { c += A[crypto.randomInt(A.length)]; if (i % 4 === 3 && i < 15) c += '-'; }
  const salt = crypto.randomBytes(8).toString('hex');
  return { code: c, rec: { salt, hash: sha256(salt + c.replace(/-/g, '')) } };
}
const recMatch = (rec, input) => rec && eq(sha256(rec.salt + String(input).toUpperCase().replace(/[^A-Z0-9]/g, '')), rec.hash);

function pub(a) {
  return { id: a.id, username: a.username, title: a.role === 'developer' ? 'Developer' : '', verified: a.role === 'developer',
    role: a.role, avatar: a.avatar ? a.avatar.ver : null, look: a.look, online: isOnline(a.id) };
}
const findAccount = (q) => {
  q = String(q || '').trim(); if (!q) return null;
  if (db.accounts[q]) return db.accounts[q];
  const id = db.names[q.toLowerCase()]; return id ? db.accounts[id] : null;
};

/* ------------------------------------------------------ RATE LIMIT / IP */
const hits = new Map(); // key -> {n, until, t}
function lockLeft(key) { const h = hits.get(key); return h && h.until > now() ? Math.ceil((h.until - now()) / 1000) : 0; }
function fail(key, max, lockMs) {
  const t = now(); let h = hits.get(key); if (!h || t - h.t > 3600e3) h = { n: 0, until: 0, t };
  h.n++; h.t = t; if (h.n >= max) { h.until = t + lockMs * Math.min(8, 2 ** Math.floor((h.n - max) / max)); } hits.set(key, h);
}
const okay = (key) => hits.delete(key);
const bucket = new Map();
function allow(key, max, winMs) { const t = now(); let b = bucket.get(key); if (!b || t > b.r) b = { n: 0, r: t + winMs }; b.n++; bucket.set(key, b); return b.n <= max; }
setInterval(() => { const t = now(); for (const [k, h] of hits) if (h.until < t && t - h.t > 3600e3) hits.delete(k); for (const [k, b] of bucket) if (t > b.r) bucket.delete(k); }, 60e3).unref();
const ipOf = (req) => { if (CFG.TRUST_PROXY) { const f = req.headers['x-forwarded-for']; if (f) return String(f).split(',')[0].trim(); } return req.socket.remoteAddress || '?'; };

/* ---------------------------------------------------------------- SESI */
function newSession(id) {
  const raw = crypto.randomBytes(32).toString('base64url'), t = now();
  const mine = Object.entries(db.sessions).filter(([, s]) => s.id === id).sort((a, b) => a[1].last - b[1].last);
  while (mine.length >= CFG.MAX_SESSIONS) delete db.sessions[mine.shift()[0]];
  db.sessions[sha256(raw)] = { id, created: t, last: t }; save(); return raw;
}
function authToken(raw) {
  if (!raw) return null; const k = sha256(raw), s = db.sessions[k]; if (!s) return null;
  if (now() - s.last > CFG.SESSION_TTL_MS) { delete db.sessions[k]; save(); return null; }
  const a = db.accounts[s.id]; if (!a) { delete db.sessions[k]; return null; }
  if (now() - s.last > 3600e3) { s.last = now(); save(); } return a;
}

/* --------------------------------------------------------------- GAMBAR */
function imgInfo(b) {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a && b.length >= 24)
    return { ext: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const f = b.toString('latin1', 12, 16);
    if (f === 'VP8X' && b.length >= 30) return { ext: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (f === 'VP8 ' && b.length >= 30) return { ext: 'webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (f === 'VP8L' && b.length >= 25) { const v = b.readUInt32LE(21); return { ext: 'webp', w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1];
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { i += (m === 0xff ? 1 : 2); continue; }
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { ext: 'jpg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return null;
  }
  return null;
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const avatarPath = (id, ext) => path.join(CFG.DATA_DIR, 'avatars', id + '.' + ext);
function rmAvatar(a) { if (a.avatar) { try { fs.unlinkSync(avatarPath(a.id, a.avatar.ext)); } catch (e) {} a.avatar = null; } }

/* ----------------------------------------------------------- PRESENCE/WS */
const conns = new Map();  // accountId -> Set<Conn>
const isOnline = (id) => { const s = conns.get(id); return !!(s && s.size); };
function pushTo(id, msg) { const s = conns.get(id); if (!s) return; const t = JSON.stringify(msg); for (const c of s) c.send(t); }
function pushFriends(a, msg) { for (const f of a.friends) pushTo(f, msg); }

/* ------------------------------------------------------------------ TEAM */
const teams = new Map(), teamOf = new Map(); // code->team ; accountId->team
function weakCode(c) {
  if (/^(\d)\1+$/.test(c)) return true;
  let asc = 1, desc = 1;
  for (let i = 1; i < c.length; i++) { const d = c.charCodeAt(i) - c.charCodeAt(i - 1); asc = d === 1 ? asc + 1 : 1; desc = d === -1 ? desc + 1 : 1; if (asc >= 5 || desc >= 5) return true; }
  for (const p of [1, 2, 3, 4, 6]) { let rep = true; for (let i = p; i < c.length; i++) if (c[i] !== c[i - p]) { rep = false; break; } if (rep) return true; }
  return c[0] === '0';
}
function newTeamCode() { for (;;) { let c = ''; for (let i = 0; i < CFG.TEAM_CODE_LEN; i++) c += crypto.randomInt(10); if (!weakCode(c) && !teams.has(c)) return c; } }
function teamView(t) {
  return { code: t.code, state: t.state, max: CFG.TEAM_MAX, count: t.members.length, owner: t.owner, expires: t.expires,
    members: t.members.map((m) => { const a = db.accounts[m.id]; return Object.assign(pub(a), { ready: m.ready, owner: m.id === t.owner, slot: m.slot }); }) };
}
const teamPush = (t) => { const v = { t: 'team', team: teamView(t) }; for (const m of t.members) pushTo(m.id, v); };
function dropMember(t, id, why) {
  const i = t.members.findIndex((m) => m.id === id); if (i < 0) return;
  t.members.splice(i, 1); teamOf.delete(id);
  if (why) pushTo(id, { t: 'left', reason: why });
  if (!t.members.length) { teams.delete(t.code); return; }
  if (t.owner === id) t.owner = t.members[0].id;
  for (const m of t.members) pushTo(m.id, { t: 'gone', id });
  teamPush(t);
}
function closeTeam(t, why) { for (const m of t.members) { teamOf.delete(m.id); pushTo(m.id, { t: 'left', reason: why }); } teams.delete(t.code); }
function freeSlot(t) { const used = new Set(t.members.map((m) => m.slot)); for (let i = 0; i < CFG.TEAM_MAX; i++) if (!used.has(i)) return i; return 0; }
function addMember(t, id) { t.members.push({ id, ready: false, slot: freeSlot(t), inGame: false, last: null, viol: [], lastMsg: 0 }); teamOf.set(id, t); }
setInterval(() => { const t0 = now(); for (const t of [...teams.values()]) if (t.state === 'lobby' && t0 > t.expires) closeTeam(t, 'Kode Team sudah kedaluwarsa.'); }, 30e3).unref();

/* ------------------------------------------------------------ HTTP UTIL */
class HttpErr extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
const bad = (m, x) => new HttpErr(400, m, x);
function cors(req, res) {
  const o = req.headers.origin;
  if (CFG.ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (o && CFG.ORIGINS.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}
function send(res, code, obj) {
  const b = JSON.stringify(obj); res.writeHead(code, Object.assign(code === 413 ? { Connection: 'close' } : {}, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(b) })); res.end(b);
}
function readBody(req, max) {
  return new Promise((ok, no) => {
    const cl = +req.headers['content-length']; if (cl > max) { no(new HttpErr(413, 'Data terlalu besar.')); return; }
    const ch = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n > max) { no(new HttpErr(413, 'Data terlalu besar.')); req.destroy(); return; } ch.push(d); });
    req.on('end', () => ok(Buffer.concat(ch))); req.on('error', no);
  });
}
async function readJson(req) {
  const b = await readBody(req, 8192); if (!b.length) return {};
  try { const o = JSON.parse(b.toString('utf8')); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; return o; } catch (e) { throw bad('Format data tidak valid.'); }
}
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');

/* ------------------------------------------------------------- ENDPOINT */
async function validateNewName(name) {
  if (typeof name !== 'string') throw bad('Username tidak valid.');
  if (name.length > CFG.USERNAME_MAX) throw bad('Username terlalu panjang. Maksimal ' + CFG.USERNAME_MAX + ' karakter.');
  if (name.length < CFG.USERNAME_MIN) throw bad('Username terlalu pendek. Minimal ' + CFG.USERNAME_MIN + ' karakter.');
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw bad('Username hanya boleh huruf, angka, dan garis bawah.');
  if (isReserved(name)) throw bad('Username ini dicadangkan dan tidak dapat digunakan.');
  if (db.names[name.toLowerCase()]) throw bad('Username ini sudah digunakan.');
}
function checkPw(pw) {
  if (typeof pw !== 'string' || pw.length < CFG.PASSWORD_MIN) throw bad('Password minimal ' + CFG.PASSWORD_MIN + ' karakter.');
  if (pw.length > CFG.PASSWORD_MAX) throw bad('Password maksimal ' + CFG.PASSWORD_MAX + ' karakter.');
}
const loginKey = (a) => 'acc:' + a;

const routes = {};
const R = (m, p, auth, fn) => { routes[m + ' ' + p] = { auth, fn }; };

R('GET', '/api/health', false, async () => ({ ok: true, name: 'blackwood-mp', version: VERSION, time: now(), config: { usernameMin: CFG.USERNAME_MIN, usernameMax: CFG.USERNAME_MAX, teamMax: CFG.TEAM_MAX } }));

R('POST', '/api/register', false, async (req, ctx) => {
  const ip = ipOf(req), b = await readJson(req); await validateNewName(b.username); checkPw(b.password);
  if (!allow('reg:' + ip, +process.env.REG_PER_HOUR || 8, 3600e3)) throw new HttpErr(429, 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.');
  const rc = newRecovery(), id = newId(), pass = await makePass(b.password);
  if (db.names[b.username.toLowerCase()]) throw bad('Username ini sudah digunakan.'); // cek ulang setelah await
  const a = { id, username: b.username, role: 'player', pass, rec: rc.rec, avatar: null, look: cleanLook(b.look), friends: [], reqIn: [], reqOut: [], created: now() };
  db.accounts[id] = a; db.names[b.username.toLowerCase()] = id; save();
  return { token: newSession(id), me: pub(a), recoveryCode: rc.code };
});

R('POST', '/api/login', false, async (req) => {
  const ip = ipOf(req), b = await readJson(req), q = str(b.id, 40).trim(), pw = str(b.password, 200);
  const wait = Math.max(lockLeft('ip:' + ip), lockLeft(loginKey(q.toLowerCase())));
  if (wait) throw new HttpErr(429, 'Terlalu banyak percobaan. Coba lagi dalam ' + wait + ' detik.', { wait });
  const a = findAccount(q); let good = false;
  if (a) good = await checkPass(a.pass, pw); else await scryptHash(pw || 'x', 'dummy-salt-for-timing');
  if (!good) {
    fail('ip:' + ip, 12, 60e3); fail(loginKey(q.toLowerCase()), a && a.role === 'developer' ? 3 : 5, a && a.role === 'developer' ? 1800e3 : 300e3);
    throw new HttpErr(401, 'Username/ID atau password salah.');
  }
  okay('ip:' + ip); okay(loginKey(q.toLowerCase()));
  return { token: newSession(a.id), me: pub(a) };
});

R('POST', '/api/recover', false, async (req) => {
  const ip = ipOf(req), b = await readJson(req), q = str(b.id, 40).trim();
  const wait = Math.max(lockLeft('ip:' + ip), lockLeft('rec:' + q.toLowerCase()));
  if (wait) throw new HttpErr(429, 'Terlalu banyak percobaan. Coba lagi dalam ' + wait + ' detik.', { wait });
  checkPw(b.newPassword);
  const a = findAccount(q);
  if (!a || a.role === 'developer' || !recMatch(a.rec, str(b.code, 40))) {
    fail('ip:' + ip, 12, 60e3); fail('rec:' + q.toLowerCase(), 5, 900e3);
    throw new HttpErr(401, 'Username/ID atau kode pemulihan salah. (Akun Developer hanya bisa direset lewat server.)');
  }
  okay('rec:' + q.toLowerCase());
  a.pass = await makePass(b.newPassword); const rc = newRecovery(); a.rec = rc.rec;
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].id === a.id) delete db.sessions[k];
  save(); return { ok: true, recoveryCode: rc.code };
});

R('POST', '/api/logout', true, async (req, ctx) => {
  delete db.sessions[sha256(ctx.token)]; save();
  const s = conns.get(ctx.me.id); if (s) for (const c of [...s]) if (c.token === ctx.token) c.close(4401);
  return { ok: true };
});
R('GET', '/api/me', true, async (req, ctx) => ({ me: pub(ctx.me), team: teamOf.has(ctx.me.id) ? teamView(teamOf.get(ctx.me.id)) : null }));
R('POST', '/api/me/look', true, async (req, ctx) => { const b = await readJson(req); ctx.me.look = cleanLook(b.look); save(); const t = teamOf.get(ctx.me.id); if (t) teamPush(t); return { me: pub(ctx.me) }; });
R('POST', '/api/me/avatar', true, async (req, ctx) => {
  if (!allow('av:' + ctx.me.id, 10, 600e3)) throw new HttpErr(429, 'Terlalu sering mengganti foto. Coba lagi nanti.');
  const body = await readBody(req, CFG.AVATAR_MAX_BYTES + 1);
  if (!body.length) throw bad('File kosong.'); if (body.length > CFG.AVATAR_MAX_BYTES) throw new HttpErr(413, 'Foto terlalu besar. Maksimal ' + (CFG.AVATAR_MAX_BYTES / 1024) + ' KB.');
  const info = imgInfo(body); if (!info) throw bad('Hanya file gambar JPG, PNG, atau WebP yang diterima.');
  if (!info.w || !info.h || info.w > CFG.AVATAR_MAX_DIM || info.h > CFG.AVATAR_MAX_DIM) throw bad('Ukuran gambar tidak valid (maks ' + CFG.AVATAR_MAX_DIM + 'px).');
  rmAvatar(ctx.me); fs.writeFileSync(avatarPath(ctx.me.id, info.ext), body);
  ctx.me.avatar = { ext: info.ext, ver: now() }; save(); notifyProfile(ctx.me); return { me: pub(ctx.me) };
});
R('DELETE', '/api/me/avatar', true, async (req, ctx) => { rmAvatar(ctx.me); save(); notifyProfile(ctx.me); return { me: pub(ctx.me) }; });
function notifyProfile(a) { const t = teamOf.get(a.id); if (t) teamPush(t); pushFriends(a, { t: 'fr' }); }

R('GET', '/api/users/search', true, async (req, ctx, url) => {
  if (!allow('srch:' + ctx.me.id, 40, 60e3)) throw new HttpErr(429, 'Terlalu banyak pencarian.');
  const q = str(url.searchParams.get('q'), 40).trim(); if (!q) throw bad('Ketik username atau Account ID.');
  const a = findAccount(q); if (!a) throw new HttpErr(404, 'Pemain tidak ditemukan.');
  const rel = a.id === ctx.me.id ? 'self' : ctx.me.friends.includes(a.id) ? 'friend' : ctx.me.reqOut.includes(a.id) ? 'sent' : ctx.me.reqIn.includes(a.id) ? 'incoming' : 'none';
  return { user: pub(a), relation: rel };
});

R('GET', '/api/friends', true, async (req, ctx) => {
  const me = ctx.me, L = (ids) => ids.map((i) => db.accounts[i]).filter(Boolean).map(pub);
  return { friends: L(me.friends), incoming: L(me.reqIn), outgoing: L(me.reqOut) };
});
function target(ctx, b) { const a = db.accounts[str(b.id, 20)]; if (!a) throw new HttpErr(404, 'Pemain tidak ditemukan.'); return a; }
const pull = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };
R('POST', '/api/friends/request', true, async (req, ctx) => {
  if (!allow('frq:' + ctx.me.id, 30, 600e3)) throw new HttpErr(429, 'Terlalu banyak permintaan. Coba lagi nanti.');
  const me = ctx.me, o = target(ctx, await readJson(req));
  if (o.id === me.id) throw bad('Kamu tidak bisa menambahkan dirimu sendiri.');
  if (me.friends.includes(o.id)) throw bad('Kalian sudah berteman.');
  if (me.reqOut.includes(o.id)) throw bad('Permintaan pertemanan sudah dikirim.');
  if (me.reqIn.includes(o.id)) throw bad('Pemain ini sudah mengirim permintaan kepadamu. Terima di tab Permintaan.');
  if (me.reqOut.length >= CFG.MAX_PENDING || o.reqIn.length >= CFG.MAX_PENDING) throw bad('Daftar permintaan penuh.');
  if (me.friends.length >= CFG.MAX_FRIENDS || o.friends.length >= CFG.MAX_FRIENDS) throw bad('Daftar teman penuh.');
  me.reqOut.push(o.id); o.reqIn.push(me.id); save(); pushTo(o.id, { t: 'fr' }); return { ok: true };
});
R('POST', '/api/friends/accept', true, async (req, ctx) => {
  const me = ctx.me, o = target(ctx, await readJson(req));
  if (!me.reqIn.includes(o.id)) throw bad('Tidak ada permintaan dari pemain ini.');
  pull(me.reqIn, o.id); pull(o.reqOut, me.id); if (!me.friends.includes(o.id)) me.friends.push(o.id); if (!o.friends.includes(me.id)) o.friends.push(me.id);
  save(); pushTo(o.id, { t: 'fr' }); return { ok: true };
});
R('POST', '/api/friends/decline', true, async (req, ctx) => {
  const me = ctx.me, o = target(ctx, await readJson(req));
  if (!me.reqIn.includes(o.id)) throw bad('Tidak ada permintaan dari pemain ini.');
  pull(me.reqIn, o.id); pull(o.reqOut, me.id); save(); pushTo(o.id, { t: 'fr' }); return { ok: true };
});
R('POST', '/api/friends/remove', true, async (req, ctx) => {
  const me = ctx.me, o = target(ctx, await readJson(req));
  pull(me.friends, o.id); pull(o.friends, me.id); pull(me.reqOut, o.id); pull(o.reqIn, me.id); pull(me.reqIn, o.id); pull(o.reqOut, me.id);
  save(); pushTo(o.id, { t: 'fr' }); return { ok: true };
});

/* ----- TEAM ----- */
R('POST', '/api/team/create', true, async (req, ctx) => {
  if (teamOf.has(ctx.me.id)) throw bad('Kamu masih berada di Team. Keluar dulu untuk membuat Team baru.');
  if (!allow('tc:' + ctx.me.id, 10, 600e3)) throw new HttpErr(429, 'Terlalu sering membuat Team.');
  const t = { code: newTeamCode(), owner: ctx.me.id, state: 'lobby', members: [], created: now(), expires: now() + CFG.TEAM_TTL_MS };
  teams.set(t.code, t); addMember(t, ctx.me.id); return { team: teamView(t) };
});
function lookupTeam(ctx, code) {
  const wait = lockLeft('tj:' + ctx.me.id); if (wait) throw new HttpErr(429, 'Terlalu banyak kode salah. Coba lagi dalam ' + wait + ' detik.');
  code = String(code || '').replace(/\D/g, '');
  const t = code.length === CFG.TEAM_CODE_LEN ? teams.get(code) : null;
  if (!t) { fail('tj:' + ctx.me.id, 8, 300e3); throw bad(code.length === CFG.TEAM_CODE_LEN ? 'Kode Team salah atau tidak ditemukan.' : 'Team Code harus 12 digit angka.'); }
  if (t.state === 'lobby' && now() > t.expires) { closeTeam(t, 'Kode Team sudah kedaluwarsa.'); throw bad('Kode Team sudah kedaluwarsa.'); }
  return t;
}
function joinChecks(ctx, t) {
  if (t.members.some((m) => m.id === ctx.me.id)) throw bad('Kamu sudah berada di Team ini.');
  if (teamOf.has(ctx.me.id)) throw bad('Kamu masih berada di Team lain. Keluar dulu.');
  if (t.state !== 'lobby') throw bad('Permainan Team ini sudah dimulai.');
  if (t.members.length >= CFG.TEAM_MAX) throw bad('Team sudah penuh. Maksimal ' + CFG.TEAM_MAX + ' pemain.');
}
R('POST', '/api/team/preview', true, async (req, ctx) => {
  const t = lookupTeam(ctx, (await readJson(req)).code); joinChecks(ctx, t);
  const o = db.accounts[t.owner]; return { info: { owner: pub(o), count: t.members.length, max: CFG.TEAM_MAX, state: t.state } };
});
R('POST', '/api/team/join', true, async (req, ctx) => {
  const t = lookupTeam(ctx, (await readJson(req)).code); joinChecks(ctx, t); okay('tj:' + ctx.me.id);
  addMember(t, ctx.me.id); teamPush(t); return { team: teamView(t) };
});
const myTeam = (ctx) => { const t = teamOf.get(ctx.me.id); if (!t) throw bad('Kamu tidak berada di Team.'); return t; };
R('GET', '/api/team', true, async (req, ctx) => ({ team: teamOf.has(ctx.me.id) ? teamView(teamOf.get(ctx.me.id)) : null }));
R('POST', '/api/team/leave', true, async (req, ctx) => { dropMember(myTeam(ctx), ctx.me.id, ''); return { ok: true }; });
R('POST', '/api/team/close', true, async (req, ctx) => { const t = myTeam(ctx); if (t.owner !== ctx.me.id) throw new HttpErr(403, 'Hanya pemilik Team yang dapat menutup Team.'); closeTeam(t, 'Team ditutup oleh pemilik.'); return { ok: true }; });
R('POST', '/api/team/kick', true, async (req, ctx) => {
  const t = myTeam(ctx), b = await readJson(req); if (t.owner !== ctx.me.id) throw new HttpErr(403, 'Hanya pemilik Team yang dapat mengeluarkan pemain.');
  if (b.id === ctx.me.id) throw bad('Gunakan Leave Team atau Tutup Team.');
  if (!t.members.some((m) => m.id === b.id)) throw bad('Pemain tidak ada di Team.');
  dropMember(t, b.id, 'Kamu dikeluarkan dari Team oleh pemilik.'); return { ok: true };
});
R('POST', '/api/team/ready', true, async (req, ctx) => {
  const t = myTeam(ctx), b = await readJson(req); if (t.state !== 'lobby') throw bad('Permainan sudah dimulai.');
  if (t.owner === ctx.me.id) throw bad('Pemilik Team tidak perlu menekan Ready.');
  t.members.find((m) => m.id === ctx.me.id).ready = !!b.ready; teamPush(t); return { ok: true };
});
R('POST', '/api/team/start', true, async (req, ctx) => {
  const t = myTeam(ctx); if (t.owner !== ctx.me.id) throw new HttpErr(403, 'Hanya pemilik Team yang dapat memulai permainan.');
  if (t.state !== 'lobby') throw bad('Permainan sudah dimulai.'); if (t.members.length < 2) throw bad('Butuh minimal 2 pemain untuk memulai.');
  if (!t.members.every((m) => m.id === t.owner || m.ready)) throw bad('Belum semua anggota siap.');
  t.state = 'playing'; for (const m of t.members) { m.inGame = true; m.last = null; m.viol = []; m.ready = false; }
  const msg = { t: 'start', at: now() + 3000, slots: Object.fromEntries(t.members.map((m) => [m.id, m.slot])) };
  for (const m of t.members) pushTo(m.id, msg); teamPush(t); return { ok: true };
});

/* ------------------------------------------------------------ HTTP SERVER */
const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'URL tidak valid.' }); }
  try {
    if (!allow('gen:' + ipOf(req), 600, 60e3)) throw new HttpErr(429, 'Terlalu banyak permintaan.');
    if (req.method === 'GET' && url.pathname.startsWith('/api/avatar/')) {
      const id = url.pathname.slice(12), a = /^\d{1,12}$/.test(id) ? db.accounts[id] : null;
      if (!a || !a.avatar) { res.writeHead(404); return res.end(); }
      return fs.readFile(avatarPath(a.id, a.avatar.ext), (e, d) => {
        if (e) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': MIME[a.avatar.ext], 'Content-Length': d.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }); res.end(d);
      });
    }
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { name: 'Blackwood Multiplayer Server', version: VERSION });
    const r = routes[req.method + ' ' + url.pathname]; if (!r) throw new HttpErr(404, 'Endpoint tidak ditemukan.');
    const ctx = {};
    if (r.auth) {
      const h = String(req.headers.authorization || ''); ctx.token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      ctx.me = authToken(ctx.token); if (!ctx.me) throw new HttpErr(401, 'Sesi berakhir. Silakan login kembali.', { auth: true });
    }
    send(res, 200, await r.fn(req, ctx, url));
  } catch (e) {
    if (e instanceof HttpErr) return send(res, e.code, Object.assign({ error: e.message }, e.extra || {}));
    console.error('error:', e); send(res, 500, { error: 'Kesalahan server.' });
  }
});

/* ---------------------------------------------------- WEBSOCKET (RFC 6455) */
const MAXFRAME = 16 * 1024;
class Conn {
  constructor(sock) { this.s = sock; this.buf = Buffer.alloc(0); this.frag = []; this.fragN = 0; this.id = null; this.token = null; this.alive = true; this.seen = now(); this.msgs = 0; this.win = now(); this.closed = false; }
  send(txt) {
    if (this.closed) return; const p = Buffer.from(txt), n = p.length; let h;
    if (n < 126) h = Buffer.from([0x81, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
    try { this.s.write(Buffer.concat([h, p])); } catch (e) {}
  }
  raw(op, payload) { if (this.closed) return; const p = payload || Buffer.alloc(0); try { this.s.write(Buffer.concat([Buffer.from([0x80 | op, p.length]), p])); } catch (e) {} }
  close(code) { if (this.closed) return; const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000); this.raw(8, p); this.closed = true; try { this.s.end(); } catch (e) {} setTimeout(() => { try { this.s.destroy(); } catch (e) {} }, 500).unref(); this.gone(); }
  gone() {
    if (this.dead) return; this.dead = true; this.closed = true;
    if (this.id) { const set = conns.get(this.id); if (set) { set.delete(this); if (!set.size) { conns.delete(this.id); const a = db.accounts[this.id]; if (a) pushFriends(a, { t: 'presence', id: a.id, online: false }); onOffline(this.id); } } }
  }
  feed(d) {
    this.buf = Buffer.concat([this.buf, d]); this.seen = now();
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80); let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2)) return this.close(1009); len = b.readUInt32BE(6); off = 10; }
      if (len > MAXFRAME) return this.close(1009); if (!masked) return this.close(1002);
      if (b.length < off + 4 + len) return;
      const mk = b.subarray(off, off + 4), pl = Buffer.alloc(len); for (let i = 0; i < len; i++) pl[i] = b[off + 4 + i] ^ mk[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) { this.close(1000); return; } if (op === 9) { this.raw(10, pl.subarray(0, 125)); continue; } if (op === 10) continue;
      if (op === 1 || op === 0) {
        if (op === 1) { this.frag = []; this.fragN = 0; } this.frag.push(pl); this.fragN += len; if (this.fragN > MAXFRAME) return this.close(1009);
        if (fin) { const txt = Buffer.concat(this.frag).toString('utf8'); this.frag = []; this.fragN = 0; this.onText(txt); }
      } else if (op === 2) { /* biner tidak dipakai */ } else return this.close(1002);
    }
  }
  onText(txt) {
    const t = now(); if (t - this.win > 1000) { this.win = t; this.msgs = 0; } if (++this.msgs > 60) return; // maks 60 pesan/detik
    let m; try { m = JSON.parse(txt); } catch (e) { return; } if (!m || typeof m !== 'object') return;
    if (!this.id) {
      if (m.t !== 'auth') return this.close(4400);
      const a = authToken(String(m.token || '')); if (!a) { this.send(JSON.stringify({ t: 'authfail' })); return this.close(4401); }
      this.id = a.id; this.token = String(m.token); let set = conns.get(a.id); const first = !set || !set.size; if (!set) conns.set(a.id, set = new Set()); set.add(this);
      if (set.size > 5) { for (const c of set) { if (c !== this) { c.close(4409); break; } } }
      this.send(JSON.stringify({ t: 'ready', me: pub(a), team: teamOf.has(a.id) ? teamView(teamOf.get(a.id)) : null, now: now() }));
      if (first) pushFriends(a, { t: 'presence', id: a.id, online: true });
      const tm = teamOf.get(a.id); if (tm) teamPush(tm); return;
    }
    onGameMsg(this, m);
  }
}
function onOffline(id) { const t = teamOf.get(id); if (t) { teamPush(t); for (const m of t.members) if (m.id !== id) pushTo(m.id, { t: 'gone', id, offline: true }); setTimeout(() => { if (!isOnline(id) && teamOf.get(id) === t) dropMember(t, id, ''); }, 5 * 60e3).unref(); } }

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const r2 = (n) => Math.round(n * 100) / 100;
const EV = new Set(['shoot', 'reload', 'hurt', 'death', 'respawn', 'exit', 'ads', 'inspect']);
function violation(t, m, c, why) {
  const t0 = now(); m.viol = m.viol.filter((x) => t0 - x < 10e3); m.viol.push(t0);
  if (m.last) c.send(JSON.stringify({ t: 'correct', p: m.last.p, why }));
  if (m.viol.length > 12) dropMember(t, m.id, 'Dikeluarkan dari Team: gerakan tidak valid terdeteksi.');
}
function onGameMsg(c, m) {
  const t = teamOf.get(c.id); if (!t || t.state !== 'playing') return;
  const mem = t.members.find((x) => x.id === c.id); if (!mem || !mem.inGame) return; const t0 = now();
  if (m.t === 's') {
    if (t0 - mem.lastMsg < 40) return; mem.lastMsg = t0;
    const p = m.p; if (!Array.isArray(p) || p.length !== 5 || !p.every(finite)) return;
    let [x, y, z, yaw, pitch] = p; if (Math.abs(x) > CFG.WORLD_LIM || Math.abs(z) > CFG.WORLD_LIM || y < -5 || y > 40) return;
    pitch = Math.max(-1.6, Math.min(1.6, pitch));
    const a = Number.isInteger(m.a) && m.a >= 0 && m.a <= 11 ? m.a : 0, h = finite(m.h) ? Math.max(0, Math.min(500, Math.round(m.h))) : 0;
    if (!mem.last) {
      const dx = x - CFG.SPAWN.x, dz = z - CFG.SPAWN.z; if (Math.hypot(dx, dz) > CFG.SPAWN.r) return violation(t, mem, c, 'spawn');
      mem.last = { p: [x, y, z], t: t0 };
    } else {
      const dt = Math.min(2, Math.max(0.03, (t0 - mem.last.t) / 1000)), dx = x - mem.last.p[0], dz = z - mem.last.p[2], dy = y - mem.last.p[1];
      if (Math.hypot(dx, dz) > CFG.MAX_SPEED * dt + 1.2 || Math.abs(dy) > 26 * dt + 1.5) return violation(t, mem, c, 'speed');
      mem.last = { p: [x, y, z], t: t0 };
    }
    const out = { t: 's', i: c.id, p: [r2(x), r2(y), r2(z), r2(yaw), r2(pitch)], a, h };
    for (const o of t.members) if (o.id !== c.id) pushTo(o.id, out);
  } else if (m.t === 'e') {
    if (!EV.has(m.k)) return; if (m.k === 'shoot' && t0 - (mem.lastShot || 0) < 45) return; if (m.k === 'shoot') mem.lastShot = t0;
    if (m.k === 'respawn') { mem.last = null; mem.viol = []; }
    if (m.k === 'exit') {
      mem.inGame = false; mem.last = null; for (const o of t.members) if (o.id !== c.id) pushTo(o.id, { t: 'gone', id: c.id });
      if (!t.members.some((x) => x.inGame)) { t.state = 'lobby'; t.expires = now() + CFG.TEAM_TTL_MS; for (const x of t.members) x.ready = false; }
      teamPush(t); return;
    }
    const msg = { t: 'e', i: c.id, k: m.k }; for (const o of t.members) if (o.id !== c.id) pushTo(o.id, msg);
  }
}
server.on('upgrade', (req, sock) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/ws' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
    const o = req.headers.origin; if (!CFG.ORIGINS.includes('*') && o && !CFG.ORIGINS.includes(o)) { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); sock.destroy(); return; }
    if (!allow('ws:' + ipOf(req), 30, 60e3)) { sock.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); sock.destroy(); return; }
    const key = req.headers['sec-websocket-key']; if (!key) { sock.destroy(); return; }
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
    sock.setNoDelay(true); const c = new Conn(sock);
    sock.on('data', (d) => { try { c.feed(d); } catch (e) { c.close(1011); } }); sock.on('close', () => c.gone()); sock.on('error', () => c.gone());
    setTimeout(() => { if (!c.id && !c.closed) c.close(4408); }, 10e3).unref(); // wajib auth dalam 10 detik
  } catch (e) { try { sock.destroy(); } catch (x) {} }
});
setInterval(() => { const t = now(); for (const set of conns.values()) for (const c of set) { if (t - c.seen > 70e3) c.close(1001); else c.raw(9); } }, 25e3).unref();

/* ------------------------------------------------------------------ CLI */
async function promptHidden(q) {
  if (process.env.DEV_PASSWORD) return process.env.DEV_PASSWORD;
  return new Promise((ok) => {
    process.stdout.write(q); const si = process.stdin; let s = '';
    if (si.isTTY) si.setRawMode(true); si.resume(); si.setEncoding('utf8');
    const on = (ch) => { for (const c of ch) { if (c === '\r' || c === '\n') { if (si.isTTY) si.setRawMode(false); si.pause(); si.removeListener('data', on); process.stdout.write('\n'); return ok(s); } if (c === '\u0003') process.exit(1); if (c === '\u007f') s = s.slice(0, -1); else s += c; } };
    si.on('data', on);
  });
}
async function createDeveloper() {
  const pw = await promptHidden('Password Developer baru (min 12 karakter): ');
  if (pw.length < 12 || pw.length > CFG.PASSWORD_MAX) { console.error('Password harus 12-' + CFG.PASSWORD_MAX + ' karakter.'); process.exit(1); }
  if (!process.env.DEV_PASSWORD) { const p2 = await promptHidden('Ulangi password: '); if (p2 !== pw) { console.error('Password tidak sama.'); process.exit(1); } }
  const pass = await makePass(pw); let a = db.accounts[CFG.DEV_ID];
  if (a) { a.pass = pass; for (const k of Object.keys(db.sessions)) if (db.sessions[k].id === a.id) delete db.sessions[k]; console.log('Password Developer diperbarui, semua sesi lama dicabut.'); }
  else {
    if (db.names[CFG.DEV_NAME.toLowerCase()]) { console.error('Username Ryusei sudah dipakai akun lain di database. Hentikan: periksa db.json.'); process.exit(1); }
    a = { id: CFG.DEV_ID, username: CFG.DEV_NAME, role: 'developer', pass, rec: null, avatar: null, look: cleanLook({ outfit: 3, skin: 1, hair: 1 }), friends: [], reqIn: [], reqOut: [], created: now() };
    db.accounts[a.id] = a; db.names[CFG.DEV_NAME.toLowerCase()] = a.id; console.log('Akun Developer dibuat: ' + CFG.DEV_NAME + ' (ID ' + CFG.DEV_ID + ').');
  }
  flushSync(); process.exit(0);
}
if (process.argv.includes('--create-developer') || process.argv.includes('--set-developer-password')) { createDeveloper(); }
else if (process.argv.includes('--help')) { console.log('node server.js            jalankan server\nnode server.js --create-developer   buat/ubah password akun Developer (Ryusei, ID 01)'); process.exit(0); }
else {
  if (!db.accounts[CFG.DEV_ID]) console.log('[!] Akun Developer belum dibuat. Jalankan: node server.js --create-developer');
  server.listen(CFG.PORT, () => console.log('Blackwood MP server v' + VERSION + ' aktif di port ' + CFG.PORT + ' | data: ' + CFG.DATA_DIR));
  const bye = () => { flushSync(); process.exit(0); }; process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
module.exports = { server, CFG, db, teams, _t: { weakCode, imgInfo, isReserved } };
