const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('Icy Tower Multiplayer Server');
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // roomCode -> {players: [ws...], seed: number}

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
        // Tell ALL other players someone joined
        for (const p of room.players) {
          if (p !== ws && p.readyState === 1) {
            p.send(JSON.stringify({ type: 'player_joined', playerNum: ws.playerNum, count: room.players.length }));
          }
        }
        break;
      }

      case 'state': {
        // Relay player state to ALL other players in the room
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
        // Host starts the race — relay to all other players
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
        // Tell remaining players
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
