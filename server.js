/**
 * 成語擂台 — 連線伺服器
 * 遊戲製作：Eric Hu
 *
 * 功能：玩家名稱＋密碼登入、搶答對戰房間（1～4 真人＋0～4 電腦）、永久金榜。
 * 資料庫：設定環境變數 DATABASE_URL（Neon 的 PostgreSQL 連線字串）就會永久保存；
 *        沒設定時改存在伺服器本機檔案（Render 重新啟動後會消失，只適合測試）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const E = require('./engine.js');

const PORT = process.env.PORT || 3000;
const GAME_KEYS = Object.keys(E.GAMES);

// ═════════════════════════ 資料庫 ═════════════════════════
function makeDb() {
  if (process.env.DATABASE_URL || global.__TEST_PG_POOL__) {
    let pool = global.__TEST_PG_POOL__;
    if (!pool) {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
    }
    const q = (sql, params) => pool.query(sql, params);
    return {
      kind: 'postgres',
      async init() {
        await q(`CREATE TABLE IF NOT EXISTS idiom_users (name TEXT PRIMARY KEY, hash TEXT NOT NULL, avatar TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
        await q(`CREATE TABLE IF NOT EXISTS idiom_scores (name TEXT NOT NULL, game TEXT NOT NULL, best INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (name, game))`);
        await q(`CREATE TABLE IF NOT EXISTS idiom_rush (name TEXT PRIMARY KEY, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW())`);
        await q(`CREATE TABLE IF NOT EXISTS idiom_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      },
      async getUser(name) { const r = await q(`SELECT name, hash, avatar FROM idiom_users WHERE name = $1`, [name]); return r.rows[0] || null; },
      async createUser(name, hash, avatar) { await q(`INSERT INTO idiom_users (name, hash, avatar) VALUES ($1, $2, $3)`, [name, hash, avatar]); },
      async setAvatar(name, avatar) { await q(`UPDATE idiom_users SET avatar = $2 WHERE name = $1`, [name, avatar]); },
      async submitScore(name, game, score) {
        const r0 = await q(`SELECT best, plays FROM idiom_scores WHERE name = $1 AND game = $2`, [name, game]);
        if (r0.rows[0]) {
          const best = Math.max(r0.rows[0].best, score);
          await q(`UPDATE idiom_scores SET best = $3, plays = $4, updated_at = NOW() WHERE name = $1 AND game = $2`, [name, game, best, r0.rows[0].plays + 1]);
          return best;
        }
        await q(`INSERT INTO idiom_scores (name, game, best, plays) VALUES ($1, $2, $3, 1)`, [name, game, score]);
        return score;
      },
      async myBests(name) {
        const r = await q(`SELECT game, best FROM idiom_scores WHERE name = $1`, [name]);
        const out = {}; r.rows.forEach((x) => { out[x.game] = x.best; }); return out;
      },
      async topScores(game, limit) {
        const r = await q(`SELECT s.name, s.best, u.avatar FROM idiom_scores s LEFT JOIN idiom_users u ON u.name = s.name WHERE s.game = $1 ORDER BY s.best DESC, s.updated_at ASC LIMIT $2`, [game, limit]);
        return r.rows.map((x) => ({ name: x.name, value: x.best, avatar: x.avatar }));
      },
      async recordRush(name, win, points) {
        const r0 = await q(`SELECT games, wins, points FROM idiom_rush WHERE name = $1`, [name]);
        if (r0.rows[0]) {
          const o = r0.rows[0];
          await q(`UPDATE idiom_rush SET games = $2, wins = $3, points = $4, updated_at = NOW() WHERE name = $1`, [name, o.games + 1, o.wins + (win ? 1 : 0), o.points + points]);
        } else {
          await q(`INSERT INTO idiom_rush (name, games, wins, points) VALUES ($1, 1, $2, $3)`, [name, win ? 1 : 0, points]);
        }
      },
      async topRush(limit) {
        const r = await q(`SELECT r.name, r.games, r.wins, r.points, u.avatar FROM idiom_rush r LEFT JOIN idiom_users u ON u.name = r.name ORDER BY r.wins DESC, r.points DESC LIMIT $1`, [limit]);
        return r.rows.map((x) => ({ name: x.name, value: x.wins, games: x.games, points: x.points, avatar: x.avatar }));
      },
      async getMeta(k) { const r = await q(`SELECT v FROM idiom_meta WHERE k = $1`, [k]); return r.rows[0] ? r.rows[0].v : null; },
      async setMeta(k, v) { await q(`INSERT INTO idiom_meta (k, v) VALUES ($1, $2)`, [k, v]); },
    };
  }
  // ── 沒有資料庫時：存成本機檔案 ──
  const file = path.join(__dirname, 'local-data.json');
  let d = { users: {}, scores: {}, rush: {}, meta: {} };
  try { d = Object.assign(d, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* 第一次啟動 */ }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(d)); } catch (e) { /* 忽略 */ } };
  return {
    kind: 'file',
    async init() {},
    async getUser(name) { return d.users[name] ? { name, ...d.users[name] } : null; },
    async createUser(name, hash, avatar) { d.users[name] = { hash, avatar }; save(); },
    async setAvatar(name, avatar) { if (d.users[name]) { d.users[name].avatar = avatar; save(); } },
    async submitScore(name, game, score) {
      const k = name + '\u0000' + game; const o = d.scores[k] || { name, game, best: 0, plays: 0, t: 0 };
      if (score > o.best) { o.best = score; o.t = Date.now(); }
      o.plays++; d.scores[k] = o; save(); return o.best;
    },
    async myBests(name) { const out = {}; Object.values(d.scores).filter((s) => s.name === name).forEach((s) => { out[s.game] = s.best; }); return out; },
    async topScores(game, limit) {
      return Object.values(d.scores).filter((s) => s.game === game).sort((a, b) => b.best - a.best || a.t - b.t)
        .slice(0, limit).map((s) => ({ name: s.name, value: s.best, avatar: d.users[s.name] && d.users[s.name].avatar }));
    },
    async recordRush(name, win, points) {
      const o = d.rush[name] || { games: 0, wins: 0, points: 0 };
      o.games++; if (win) o.wins++; o.points += points; d.rush[name] = o; save();
    },
    async topRush(limit) {
      return Object.entries(d.rush).map(([name, o]) => ({ name, value: o.wins, games: o.games, points: o.points, avatar: d.users[name] && d.users[name].avatar }))
        .sort((a, b) => b.value - a.value || b.points - a.points).slice(0, limit);
    },
    async getMeta(k) { return d.meta[k] || null; },
    async setMeta(k, v) { d.meta[k] = v; save(); },
  };
}
const db = makeDb();

// ═════════════════════════ 登入憑證 ═════════════════════════
let SECRET = process.env.SESSION_SECRET || '';
function sign(name) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 60; // 60 天
  const body = Buffer.from(JSON.stringify({ n: name, e: exp })).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.e > Date.now() ? o.n : null; } catch (e) { return null; }
}
function cleanName(s) { return String(s || '').trim().replace(/\s+/g, ' '); }
function validName(n) { return [...n].length >= 1 && [...n].length <= 12 && !/[<>"'&]/.test(n); }

// ═════════════════════════ HTTP ═════════════════════════
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/engine.js': 'engine.js' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });
}

async function api(req, res, url) {
  const p = url.pathname;
  try {
    if (p === '/api/ping') return sendJson(res, 200, { ok: true, db: db.kind, name: '成語擂台' });
    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req); const name = cleanName(b.name); const pw = String(b.password || '');
      if (!validName(name)) return sendJson(res, 400, { error: '名稱需為 1～12 個字，且不能含特殊符號' });
      if (pw.length < 4 || pw.length > 32) return sendJson(res, 400, { error: '密碼需為 4～32 個字元' });
      if (await db.getUser(name)) return sendJson(res, 409, { error: '這個名稱已經有人使用了' });
      const avatar = E.AVATARS.includes(b.avatar) ? b.avatar : E.pick(null, E.AVATARS);
      await db.createUser(name, await bcrypt.hash(pw, 10), avatar);
      return sendJson(res, 200, { token: sign(name), name, avatar, bests: {} });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req); const name = cleanName(b.name); const pw = String(b.password || '');
      const u = await db.getUser(name);
      if (!u || !(await bcrypt.compare(pw, u.hash))) return sendJson(res, 401, { error: '名稱或密碼不正確' });
      return sendJson(res, 200, { token: sign(name), name, avatar: u.avatar, bests: await db.myBests(name) });
    }
    if (p === '/api/me' && req.method === 'POST') {
      const b = await readBody(req); const name = verify(b.token);
      if (!name) return sendJson(res, 401, { error: '登入已過期，請重新登入' });
      const u = await db.getUser(name);
      if (!u) return sendJson(res, 401, { error: '找不到這個帳號' });
      if (b.avatar && E.AVATARS.includes(b.avatar)) { await db.setAvatar(name, b.avatar); u.avatar = b.avatar; }
      return sendJson(res, 200, { name, avatar: u.avatar, bests: await db.myBests(name) });
    }
    if (p === '/api/score' && req.method === 'POST') {
      const b = await readBody(req); const name = verify(b.token);
      if (!name) return sendJson(res, 401, { error: '請先登入才能登上金榜' });
      const game = String(b.game); const score = Math.floor(Number(b.score));
      if (!GAME_KEYS.includes(game) || !(score >= 0) || score > (game === 'rank' ? 10000000 : 50000)) return sendJson(res, 400, { error: '成績格式不正確' });
      const best = await db.submitScore(name, game, score);
      return sendJson(res, 200, { best });
    }
    if (p === '/api/leaderboard') {
      const game = url.searchParams.get('game') || 'rush';
      if (game === 'rush') return sendJson(res, 200, { game, rows: await db.topRush(50) });
      if (!GAME_KEYS.includes(game)) return sendJson(res, 400, { error: '沒有這個遊戲' });
      return sendJson(res, 200, { game, rows: await db.topScores(game, 50) });
    }
    return sendJson(res, 404, { error: '找不到' });
  } catch (err) {
    console.error('API 錯誤', err);
    return sendJson(res, 500, { error: '伺服器發生錯誤，請稍後再試' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  const f = STATIC[url.pathname];
  if (f) {
    const fp = path.join(__dirname, f);
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(fp).pipe(res);
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('成語擂台伺服器運作中');
});

// ═════════════════════════ 房間與對戰 ═════════════════════════
const io = new Server(server, { cors: { origin: '*' } });
const rooms = new Map();

function makeCode() {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c; do { c = Array.from({ length: 5 }, () => ch[Math.floor(Math.random() * ch.length)]).join(''); } while (rooms.has(c));
  return c;
}
function roomView(room) {
  return {
    code: room.code, host: room.host, humanMax: room.humanMax, aiCount: room.aiCount, aiLevel: room.aiLevel,
    rounds: room.rounds, qtype: room.qtype, mode: room.mode, game: room.game, raceRounds: room.raceRounds, state: room.state,
    members: room.members.map((m) => ({ name: m.name, avatar: m.avatar, online: !!m.socketId, host: m.name === room.host })),
  };
}
function pushRoom(room) { io.to(room.code).emit('room', roomView(room)); }
function scheduleCleanup(room) {
  clearTimeout(room.cleanup);
  room.cleanup = setTimeout(() => {
    if (room.members.every((m) => !m.socketId)) { if (room.match) room.match.stop(); rooms.delete(room.code); }
  }, 1000 * 60 * 3);
}

io.on('connection', (socket) => {
  let me = null; // { name, avatar }
  let myRoom = null;

  socket.on('auth', async ({ token } = {}, cb = () => {}) => {
    const name = verify(token);
    if (!name) return cb({ error: '登入已過期，請重新登入' });
    const u = await db.getUser(name).catch(() => null);
    if (!u) return cb({ error: '找不到這個帳號' });
    me = { name, avatar: u.avatar || '🙂' };
    cb({ ok: true, name });
  });

  function leave() {
    if (!myRoom) return;
    const room = myRoom; myRoom = null;
    socket.leave(room.code);
    const m = room.members.find((x) => x.name === me.name);
    if (room.state === 'waiting') {
      room.members = room.members.filter((x) => x.name !== me.name);
      if (room.host === me.name && room.members[0]) room.host = room.members[0].name;
      if (!room.members.length) { rooms.delete(room.code); return; }
    } else if (m) { m.socketId = null; }
    pushRoom(room); scheduleCleanup(room);
  }

  socket.on('create_room', (opt = {}, cb = () => {}) => {
    if (!me) return cb({ error: '請先登入' });
    leave();
    const humanMax = Math.min(4, Math.max(1, opt.humanMax | 0 || 2));
    const aiCount = Math.min(4, Math.max(0, opt.aiCount | 0));
    const room = {
      code: makeCode(), host: me.name, humanMax, aiCount,
      aiLevel: E.AI_LEVELS[opt.aiLevel] ? opt.aiLevel : 'normal',
      rounds: [10, 15, 20].includes(opt.rounds) ? opt.rounds : 10,
      qtype: E.RUSH_TYPES.includes(opt.qtype) ? opt.qtype : 'mix',
      mode: opt.mode === 'race' ? 'race' : 'rush',
      game: E.RACE_TIME[opt.game] ? opt.game : 'search',
      raceRounds: [3, 5, 8].includes(opt.raceRounds) ? opt.raceRounds : 5,
      state: 'waiting', members: [{ name: me.name, avatar: me.avatar, socketId: socket.id }], match: null,
    };
    rooms.set(room.code, room);
    myRoom = room; socket.join(room.code);
    cb({ ok: true, room: roomView(room) });
    pushRoom(room);
  });

  socket.on('join_room', ({ code } = {}, cb = () => {}) => {
    if (!me) return cb({ error: '請先登入' });
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return cb({ error: '找不到這個房間，請確認房號' });
    const existing = room.members.find((m) => m.name === me.name);
    if (!existing) {
      if (room.state !== 'waiting') return cb({ error: '這個房間已經開始比賽了' });
      if (room.members.length >= room.humanMax) return cb({ error: '房間真人座位已滿' });
    }
    if (myRoom && myRoom !== room) leave();
    if (existing) existing.socketId = socket.id;
    else room.members.push({ name: me.name, avatar: me.avatar, socketId: socket.id });
    myRoom = room; socket.join(room.code);
    cb({ ok: true, room: roomView(room), snapshot: room.match && room.state === 'playing' ? room.match.snapshot() : null });
    pushRoom(room);
  });

  socket.on('room_settings', (opt = {}) => {
    const room = myRoom;
    if (!room || room.host !== me.name || room.state !== 'waiting') return;
    if (opt.humanMax) room.humanMax = Math.min(4, Math.max(room.members.length, opt.humanMax | 0));
    if (opt.aiCount !== undefined) room.aiCount = Math.min(4, Math.max(0, opt.aiCount | 0));
    if (E.AI_LEVELS[opt.aiLevel]) room.aiLevel = opt.aiLevel;
    if ([10, 15, 20].includes(opt.rounds)) room.rounds = opt.rounds;
    if (opt.qtype === 'mix' || E.RUSH_TYPES.includes(opt.qtype)) room.qtype = opt.qtype;
    if (opt.mode === 'race' || opt.mode === 'rush') room.mode = opt.mode;
    if (E.RACE_TIME[opt.game]) room.game = opt.game;
    if ([3, 5, 8].includes(opt.raceRounds)) room.raceRounds = opt.raceRounds;
    pushRoom(room);
  });

  socket.on('start_match', (_, cb = () => {}) => {
    const room = myRoom;
    if (!room || room.host !== me.name) return cb({ error: '只有房主可以開始' });
    if (room.state === 'playing') return cb({ error: '比賽已經開始' });
    if (room.members.length + room.aiCount < 2) return cb({ error: '至少要兩位參賽者（可以加入電腦）' });
    const names = E.shuffle(null, E.AI_NAMES).slice(0, room.aiCount);
    const aiAv = E.shuffle(null, E.AVATARS);
    const players = [
      ...room.members.map((m) => ({ id: m.name, name: m.name, avatar: m.avatar })),
      ...names.map((n, i) => ({ id: 'ai' + i, name: n + '（電腦）', ai: true, avatar: aiAv[i] })),
    ];
    room.state = 'playing';
    const Match = room.mode === 'race' ? E.RaceMatch : E.RushMatch;
    room.match = new Match({
      game: room.game, players, rounds: room.mode === 'race' ? room.raceRounds : room.rounds, aiLevel: room.aiLevel, types: room.qtype && room.qtype !== 'mix' ? [room.qtype] : null,
      emit: (evt, data) => {
        io.to(room.code).emit('m', { evt, data });
        if (evt === 'match_end') finishRoom(room, data.ranking);
      },
    });
    pushRoom(room);
    room.match.start();
    cb({ ok: true });
  });

  socket.on('answer', ({ choice } = {}) => {
    if (!myRoom || !myRoom.match || !me) return;
    myRoom.match.answer(me.name, choice | 0);
  });

  socket.on('race_done', ({ k } = {}) => {
    if (!myRoom || !myRoom.match || !me || !myRoom.match.done) return;
    myRoom.match.done(me.name, k | 0);
  });

  socket.on('chat', ({ text } = {}) => {
    if (!myRoom || !me) return;
    const t = String(text || '').slice(0, 30);
    if (t) io.to(myRoom.code).emit('chat', { name: me.name, text: t });
  });

  socket.on('leave_room', () => leave());
  socket.on('disconnect', () => { if (me) leave(); });
});

async function finishRoom(room, ranking) {
  room.state = 'waiting';
  room.match = null;
  const humans = ranking.filter((r) => !r.ai);
  for (const r of humans) {
    try { await db.recordRush(r.name, r.rank === 1, r.score); } catch (e) { console.error('記錄對戰失敗', e); }
  }
  // 比賽中離線的人，比賽結束後移出房間
  room.members = room.members.filter((m) => m.socketId);
  if (!room.members.find((m) => m.name === room.host) && room.members[0]) room.host = room.members[0].name;
  if (!room.members.length) { rooms.delete(room.code); return; }
  setTimeout(() => pushRoom(room), 200);
}

async function boot() {
  await db.init();
  if (!SECRET) {
    SECRET = await db.getMeta('secret');
    if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); await db.setMeta('secret', SECRET); }
  }
  server.listen(PORT, () => console.log(`成語擂台伺服器啟動：連接埠 ${PORT}，資料存放方式：${db.kind === 'postgres' ? '資料庫' : '本機檔案'}`));
}
if (require.main === module) boot().catch((e) => { console.error('啟動失敗', e); process.exit(1); });
module.exports = { boot, server, db };
