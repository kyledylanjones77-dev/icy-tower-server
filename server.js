const http = require('http');
const fs = require('fs');
const { WebSocketServer } = require('ws');

// ==================== LEADERBOARD ====================
const LB_FILE = './leaderboard.json';
let leaderboard = [];
try { leaderboard = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); } catch {}
function saveLB() { try { fs.writeFileSync(LB_FILE, JSON.stringify(leaderboard)); } catch {} }

// ==================== HTTP SERVER ====================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /leaderboard — return top 10
  if (req.url === '/leaderboard' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(leaderboard));
    return;
  }

  // POST /score — submit a score, update if top 10
  if (req.url === '/score' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, floor, score } = JSON.parse(body);
        if (!name || !floor || floor < 1) { res.writeHead(400); res.end('{}'); return; }
        const entry = { name: String(name).slice(0, 12).toUpperCase(), floor: Number(floor), score: Number(score || 0), date: new Date().toISOString() };
        // Only add if it qualifies for top 10
        if (leaderboard.length < 10 || entry.floor > leaderboard[leaderboard.length - 1].floor) {
          leaderboard.push(entry);
          leaderboard.sort((a, b) => b.floor - a.floor || b.score - a.score);
          leaderboard = leaderboard.slice(0, 10);
          saveLB();
        }
        const rank = leaderboard.findIndex(e => e.name === entry.name && e.floor === entry.floor && e.date === entry.date);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rank: rank >= 0 ? rank + 1 : 0, leaderboard }));
      } catch { res.writeHead(400); res.end('{}'); }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Icy Tower Multiplayer Server');
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Icy Tower server on port ${PORT}`));
