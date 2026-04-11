const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ==================== UPSTASH REDIS ====================
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || 'https://solid-mantis-61880.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'AfG4AAIncDIyM2Y2MTM5NjIwNTY0MzBhYWEyMDFkZDIwNTFkY2JiM3AyNjE4ODA';

function redis(cmd) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(cmd);
    const url = new URL(UPSTASH_URL);
    const opts = {
      hostname: url.hostname, port: 443, path: '/pipeline', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Single redis command helper
function redisCmd(...args) {
  return redis([args]).then(r => r && r[0] ? r[0].result : null);
}

// ==================== IN-MEMORY CACHE ====================
let leaderboard = [];
let profiles = {};
let physics = null; // server-side physics overrides (null = use client defaults)

// Load leaderboard from Redis on startup
async function loadLB() {
  try {
    const data = await redisCmd('GET', 'icy:leaderboard');
    if (data) leaderboard = JSON.parse(data);
    console.log('Loaded leaderboard from Redis:', leaderboard.length, 'entries');
  } catch (e) { console.log('Redis LB load failed, starting empty:', e.message); }
}
async function saveLB() {
  try { await redisCmd('SET', 'icy:leaderboard', JSON.stringify(leaderboard)); } catch (e) { console.log('Redis LB save failed:', e.message); }
}

// Load profiles from Redis on startup
async function loadProfiles() {
  try {
    const data = await redisCmd('GET', 'icy:profiles');
    if (data) profiles = JSON.parse(data);
    console.log('Loaded profiles from Redis:', Object.keys(profiles).length, 'profiles');
  } catch (e) { console.log('Redis profiles load failed, starting empty:', e.message); }
}
async function saveProfiles() {
  try { await redisCmd('SET', 'icy:profiles', JSON.stringify(profiles)); } catch (e) { console.log('Redis profiles save failed:', e.message); }
}

// Load physics config from Redis
async function loadPhysics() {
  try {
    const data = await redisCmd('GET', 'icy:physics');
    if (data) physics = JSON.parse(data);
    console.log('Loaded physics from Redis:', physics ? Object.keys(physics).length + ' keys' : 'none (using defaults)');
  } catch (e) { console.log('Redis physics load failed, using defaults:', e.message); }
}
async function savePhysics() {
  try { await redisCmd('SET', 'icy:physics', JSON.stringify(physics)); } catch (e) { console.log('Redis physics save failed:', e.message); }
}

function hashPin(pin, salt) { return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex'); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(); } });
  });
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ==================== HTTP SERVER ====================
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /leaderboard — return top 10
  if (req.url === '/leaderboard' && req.method === 'GET') {
    return json(res, 200, leaderboard);
  }

  // POST /score — submit a score, update if top 10
  if (req.url === '/score' && req.method === 'POST') {
    try {
      const { name, floor, score } = await readBody(req);
      if (!name || !floor || floor < 1) return json(res, 400, {});
      const entry = { name: String(name).slice(0, 12).toUpperCase(), floor: Number(floor), score: Number(score || 0), date: new Date().toISOString() };
      if (leaderboard.length < 10 || entry.floor > leaderboard[leaderboard.length - 1].floor) {
        leaderboard.push(entry);
        leaderboard.sort((a, b) => b.floor - a.floor || b.score - a.score);
        leaderboard = leaderboard.slice(0, 10);
        await saveLB();
      }
      const rank = leaderboard.findIndex(e => e.name === entry.name && e.floor === entry.floor && e.date === entry.date);
      return json(res, 200, { rank: rank >= 0 ? rank + 1 : 0, leaderboard });
    } catch { return json(res, 400, {}); }
  }

  // ==================== PROFILE AUTH ====================

  // POST /register — create account { username, pin }
  if (req.url === '/register' && req.method === 'POST') {
    try {
      const { username, pin } = await readBody(req);
      const name = String(username || '').trim().toUpperCase().replace(/[^A-Z0-9_\- ]/g, '').slice(0, 12);
      const pinStr = String(pin || '');
      if (!name || name.length < 2) return json(res, 400, { error: 'Name must be 2-12 characters' });
      if (!/^\d{4}$/.test(pinStr)) return json(res, 400, { error: 'PIN must be 4 digits' });
      if (profiles[name]) return json(res, 409, { error: 'Username taken' });

      const salt = crypto.randomBytes(8).toString('hex');
      profiles[name] = {
        pinHash: hashPin(pinStr, salt),
        salt,
        wallet: 0,
        cosmetics: { shoes: 'default', body: 'default', trail: 'default', owned: ['default'] },
        stats: { gamesPlayed: 0, totalCoins: 0, bestFloor: 0, totalFloors: 0, totalPlaytime: 0, bestScore: 0 },
        created: new Date().toISOString(),
        lastLogin: new Date().toISOString()
      };
      await saveProfiles();
      const p = profiles[name];
      return json(res, 201, { ok: true, profile: { username: name, wallet: p.wallet, cosmetics: p.cosmetics, stats: p.stats } });
    } catch { return json(res, 400, { error: 'Invalid request' }); }
  }

  // POST /login — authenticate { username, pin }
  if (req.url === '/login' && req.method === 'POST') {
    try {
      const { username, pin } = await readBody(req);
      const name = String(username || '').trim().toUpperCase();
      const pinStr = String(pin || '');
      if (!profiles[name]) return json(res, 404, { error: 'Account not found' });
      const p = profiles[name];
      if (hashPin(pinStr, p.salt) !== p.pinHash) return json(res, 401, { error: 'Wrong PIN' });
      p.lastLogin = new Date().toISOString();
      await saveProfiles();
      return json(res, 200, { ok: true, profile: { username: name, wallet: p.wallet, cosmetics: p.cosmetics, stats: p.stats } });
    } catch { return json(res, 400, { error: 'Invalid request' }); }
  }

  // POST /profile/sync — save profile data { username, pin, wallet, cosmetics, stats }
  if (req.url === '/profile/sync' && req.method === 'POST') {
    try {
      const data = await readBody(req);
      const name = String(data.username || '').trim().toUpperCase();
      const pinStr = String(data.pin || '');
      if (!profiles[name]) return json(res, 404, { error: 'Account not found' });
      const p = profiles[name];
      if (hashPin(pinStr, p.salt) !== p.pinHash) return json(res, 401, { error: 'Wrong PIN' });

      // Merge: take higher values for stats, keep server wallet if higher (anti-cheat basic)
      if (data.wallet !== undefined) p.wallet = Math.max(p.wallet, Number(data.wallet) || 0);
      if (data.cosmetics) {
        p.cosmetics = data.cosmetics;
        if (!p.cosmetics.owned || !Array.isArray(p.cosmetics.owned)) p.cosmetics.owned = ['default'];
        if (!p.cosmetics.owned.includes('default')) p.cosmetics.owned.push('default');
      }
      if (data.stats) {
        const s = data.stats;
        p.stats.gamesPlayed = Math.max(p.stats.gamesPlayed, s.gamesPlayed || 0);
        p.stats.totalCoins = Math.max(p.stats.totalCoins, s.totalCoins || 0);
        p.stats.bestFloor = Math.max(p.stats.bestFloor, s.bestFloor || 0);
        p.stats.totalFloors = Math.max(p.stats.totalFloors, s.totalFloors || 0);
        p.stats.totalPlaytime = Math.max(p.stats.totalPlaytime, s.totalPlaytime || 0);
        p.stats.bestScore = Math.max(p.stats.bestScore, s.bestScore || 0);
      }
      await saveProfiles();
      return json(res, 200, { ok: true, profile: { username: name, wallet: p.wallet, cosmetics: p.cosmetics, stats: p.stats } });
    } catch { return json(res, 400, { error: 'Invalid request' }); }
  }

  // ==================== PHYSICS CONFIG ====================

  // GET /physics — any player loads the global physics config
  if (req.url === '/physics' && req.method === 'GET') {
    return json(res, 200, physics || {});
  }

  // POST /physics — god panel pushes new physics (password protected)
  if (req.url === '/physics' && req.method === 'POST') {
    try {
      const data = await readBody(req);
      if (data.password !== 'ivory') return json(res, 401, { error: 'Wrong password' });
      delete data.password; // don't store the password
      physics = data;
      await savePhysics();
      console.log('Physics updated:', Object.keys(physics).length, 'keys');
      return json(res, 200, { ok: true });
    } catch { return json(res, 400, { error: 'Invalid request' }); }
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Falling Up Game Server');
});

// ==================== WEBSOCKET ====================
const wss = new WebSocketServer({ server });
const rooms = new Map();

function genCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerNum = 0;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create': {
        const code = genCode();
        rooms.set(code, { players: [ws], seed: msg.seed || Date.now() });
        ws.roomCode = code;
        ws.playerNum = 1;
        ws.send(JSON.stringify({ type: 'created', code, playerNum: 1, seed: rooms.get(code).seed }));
        break;
      }

      case 'join': {
        const room = rooms.get(msg.code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Room not found' })); break; }
        if (room.players.length >= 4) { ws.send(JSON.stringify({ type: 'error', msg: 'Room full (4/4)' })); break; }
        room.players.push(ws);
        ws.roomCode = msg.code;
        ws.playerNum = room.players.length;
        ws.send(JSON.stringify({ type: 'joined', code: msg.code, playerNum: ws.playerNum, seed: room.seed, count: room.players.length }));
        for (const p of room.players) {
          if (p !== ws && p.readyState === 1) {
            p.send(JSON.stringify({ type: 'player_joined', playerNum: ws.playerNum, count: room.players.length }));
          }
        }
        break;
      }

      case 'state': {
        const room = rooms.get(ws.roomCode);
        if (!room) break;
        const payload = JSON.stringify({
          type: 'opponent_state',
          playerNum: ws.playerNum,
          x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy,
          fl: msg.fl, score: msg.score, face: msg.face,
          gnd: msg.gnd, wallSlide: msg.wallSlide, fr: msg.fr,
          alive: msg.alive, combo: msg.combo
        });
        for (const p of room.players) {
          if (p !== ws && p.readyState === 1) p.send(payload);
        }
        break;
      }

      case 'died': {
        const room = rooms.get(ws.roomCode);
        if (!room) break;
        const payload = JSON.stringify({ type: 'opponent_died', playerNum: ws.playerNum, fl: msg.fl, score: msg.score });
        for (const p of room.players) {
          if (p !== ws && p.readyState === 1) p.send(payload);
        }
        break;
      }

      case 'start': {
        const room = rooms.get(ws.roomCode);
        if (!room) break;
        const payload = JSON.stringify({ type: 'race_start', seed: room.seed });
        for (const p of room.players) {
          if (p !== ws && p.readyState === 1) p.send(payload);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        room.players = room.players.filter(p => p !== ws);
        const payload = JSON.stringify({ type: 'player_left', playerNum: ws.playerNum, count: room.players.length });
        for (const p of room.players) {
          if (p.readyState === 1) p.send(payload);
        }
        if (room.players.length === 0) rooms.delete(ws.roomCode);
      }
    }
  });
});

// ==================== STARTUP ====================
const PORT = process.env.PORT || 3000;

async function start() {
  await loadLB();
  await loadProfiles();
  await loadPhysics();
  server.listen(PORT, () => console.log(`Falling Up server on port ${PORT}`));
}
start();
