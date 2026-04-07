const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('Icy Tower Multiplayer Server');
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // roomCode -> {players: [ws, ws], platforms: [...]}

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
        if (room.players.length >= 2) { ws.send(JSON.stringify({ type: 'error', msg: 'Room full' })); break; }
        room.players.push(ws);
        ws.roomCode = msg.code;
        ws.playerNum = 2;
        ws.send(JSON.stringify({ type: 'joined', code: msg.code, playerNum: 2, seed: room.seed }));
        // Tell player 1 that player 2 joined
        if (room.players[0]?.readyState === 1) {
          room.players[0].send(JSON.stringify({ type: 'opponent_joined' }));
        }
        break;
      }

      case 'state': {
        // Relay player state to the other player in the room
        const room = rooms.get(ws.roomCode);
        if (!room) break;
        const other = room.players.find(p => p !== ws);
        if (other?.readyState === 1) {
          other.send(JSON.stringify({
            type: 'opponent_state',
            x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy,
            fl: msg.fl, score: msg.score, face: msg.face,
            gnd: msg.gnd, wallSlide: msg.wallSlide, fr: msg.fr,
            alive: msg.alive, combo: msg.combo
          }));
        }
        break;
      }

      case 'died': {
        const room = rooms.get(ws.roomCode);
        if (!room) break;
        const other = room.players.find(p => p !== ws);
        if (other?.readyState === 1) {
          other.send(JSON.stringify({ type: 'opponent_died', fl: msg.fl, score: msg.score }));
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
        // Tell remaining player
        for (const p of room.players) {
          if (p.readyState === 1) p.send(JSON.stringify({ type: 'opponent_left' }));
        }
        if (room.players.length === 0) rooms.delete(ws.roomCode);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Icy Tower server on port ${PORT}`));
