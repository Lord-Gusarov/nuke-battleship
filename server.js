const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: BASE_PATH ? `${BASE_PATH}/socket.io/` : '/socket.io/',
});

// ── Logging ──

function ts() {
  return new Date().toISOString();
}

function log(tag, msg, data) {
  const line = data !== undefined
    ? `[${ts()}] [${tag}] ${msg} ${JSON.stringify(data)}`
    : `[${ts()}] [${tag}] ${msg}`;
  console.log(line);
}

app.use(express.json());

// Serve static files and routes under BASE_PATH
app.use(BASE_PATH || '/', express.static(path.join(__dirname, 'public')));

// Client error reporting endpoint
app.post(`${BASE_PATH}/client-log`, (req, res) => {
  const { level, message, data, playerIdx, roomId, userAgent } = req.body || {};
  const tag = `CLIENT:P${playerIdx ?? '?'}:${roomId ?? '?'}`;
  if (level === 'error') {
    console.error(`[${ts()}] [${tag}] ${message}`, data || '');
  } else {
    log(tag, message, data);
  }
  res.sendStatus(204);
});

// Game configuration
const CONFIG = {
  GRID_SIZE: 10,
  NUKES_PER_PLAYER: 2, // default, overridable per room
  SHIPS: [
    { name: 'Carrier', size: 5 },
    { name: 'Battleship', size: 4 },
    { name: 'Cruiser', size: 3 },
    { name: 'Submarine', size: 3 },
    { name: 'Destroyer', size: 2 },
  ],
};

// Active games: roomId -> game state
const games = new Map();

function createEmptyGrid() {
  return Array.from({ length: CONFIG.GRID_SIZE }, () =>
    Array(CONFIG.GRID_SIZE).fill(null)
  );
}

function createPlayerState() {
  return {
    socketId: null,
    shipGrid: createEmptyGrid(),   // 'S' = ship segment
    shotGrid: createEmptyGrid(),   // 'hit' | 'miss' | 'nuke_hit' | 'nuke_miss'
    ships: [],                     // [{ name, cells: [{r,c}], sunk: false }]
    shipsPlaced: false,
    nukes: CONFIG.NUKES_PER_PLAYER,
    alive: true,
  };
}

function createGame(roomId, nukesPerPlayer) {
  const nukes = Math.max(0, Math.min(10, Math.floor(nukesPerPlayer || CONFIG.NUKES_PER_PLAYER)));
  const game = {
    roomId,
    nukesPerPlayer: nukes,
    players: [createPlayerState(), createPlayerState()],
    phase: 'waiting',
    turn: 0,
    winner: null,
  };
  game.players[0].nukes = nukes;
  game.players[1].nukes = nukes;
  return game;
}

function validatePlacement(ships) {
  if (!Array.isArray(ships) || ships.length !== CONFIG.SHIPS.length) return false;

  const occupied = new Set();

  for (let i = 0; i < ships.length; i++) {
    const ship = ships[i];
    const expected = CONFIG.SHIPS[i];
    if (!ship || !Array.isArray(ship.cells) || ship.cells.length !== expected.size) return false;

    const cells = ship.cells;
    for (const { r, c } of cells) {
      if (r < 0 || r >= CONFIG.GRID_SIZE || c < 0 || c >= CONFIG.GRID_SIZE) return false;
      const key = `${r},${c}`;
      if (occupied.has(key)) return false;
      occupied.add(key);
    }

    const allSameRow = cells.every(cell => cell.r === cells[0].r);
    const allSameCol = cells.every(cell => cell.c === cells[0].c);
    if (!allSameRow && !allSameCol) return false;

    if (allSameRow) {
      const cols = cells.map(cell => cell.c).sort((a, b) => a - b);
      for (let j = 1; j < cols.length; j++) {
        if (cols[j] !== cols[j - 1] + 1) return false;
      }
    } else {
      const rows = cells.map(cell => cell.r).sort((a, b) => a - b);
      for (let j = 1; j < rows.length; j++) {
        if (rows[j] !== rows[j - 1] + 1) return false;
      }
    }
  }

  return true;
}

function checkSunk(playerState) {
  for (const ship of playerState.ships) {
    if (ship.sunk) continue;
    const allHit = ship.cells.every(({ r, c }) => {
      const val = playerState.shipGrid[r][c];
      return val === 'hit';
    });
    if (allHit) {
      ship.sunk = true;
    }
  }
}

function checkAllSunk(playerState) {
  return playerState.ships.every(s => s.sunk);
}

function processShot(game, attackerIdx, r, c, weapon) {
  const defenderIdx = 1 - attackerIdx;
  const attacker = game.players[attackerIdx];
  const defender = game.players[defenderIdx];
  const results = [];

  let targets;
  if (weapon === 'nuke') {
    if (attacker.nukes <= 0) return { error: 'No nukes remaining' };
    attacker.nukes--;
    targets = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < CONFIG.GRID_SIZE && nc >= 0 && nc < CONFIG.GRID_SIZE) {
          targets.push({ r: nr, c: nc });
        }
      }
    }
  } else {
    targets = [{ r, c }];
  }

  for (const t of targets) {
    if (attacker.shotGrid[t.r][t.c]) continue;

    if (defender.shipGrid[t.r][t.c] === 'S') {
      defender.shipGrid[t.r][t.c] = 'hit';
      attacker.shotGrid[t.r][t.c] = 'hit';
      results.push({ r: t.r, c: t.c, result: 'hit' });
    } else {
      attacker.shotGrid[t.r][t.c] = 'miss';
      results.push({ r: t.r, c: t.c, result: 'miss' });
    }
  }

  if (results.length === 0) {
    return { error: 'All targeted cells already shot' };
  }

  checkSunk(defender);
  const sunkShips = defender.ships.filter(s => s.sunk).map(s => s.name);

  let gameOver = false;
  if (checkAllSunk(defender)) {
    game.phase = 'finished';
    game.winner = attackerIdx;
    defender.alive = false;
    gameOver = true;
  }

  game.turn = defenderIdx;

  return { results, sunkShips, gameOver, weapon };
}

// Routes
app.get(`${BASE_PATH}/join`, (req, res) => {
  const roomId = crypto.randomBytes(4).toString('hex');
  log('ROUTE', `New room created via /join`, { roomId });
  res.redirect(`${BASE_PATH}/?room=${roomId}`);
});

// Socket.io
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerIdx = null;

  log('CONN', `Socket connected`, { socketId: socket.id, ip: socket.handshake.address });

  socket.on('join_room', (data) => {
    // Accept either a string (room ID) or { roomId, nukes } object
    let roomId, nukes;
    if (typeof data === 'string') {
      roomId = data;
    } else if (data && typeof data === 'object') {
      roomId = data.roomId;
      nukes = data.nukes;
    }
    if (!roomId || typeof roomId !== 'string') {
      log('WARN', `Invalid room ID from socket`, { socketId: socket.id, roomId });
      return;
    }
    roomId = roomId.trim().toLowerCase();

    let game = games.get(roomId);
    const isNewGame = !game;

    if (!game) {
      game = createGame(roomId, nukes);
      games.set(roomId, game);
      log('ROOM', `Room created`, { roomId, nukesPerPlayer: game.nukesPerPlayer });
    }

    // Find a slot
    let idx = -1;
    // Check if this socket is already in the game (reconnect)
    for (let i = 0; i < 2; i++) {
      if (game.players[i].socketId === socket.id) {
        idx = i;
        break;
      }
    }

    if (idx === -1) {
      for (let i = 0; i < 2; i++) {
        if (!game.players[i].socketId) {
          idx = i;
          game.players[i].socketId = socket.id;
          break;
        }
      }
    }

    if (idx === -1) {
      log('WARN', `Room full, rejecting`, { roomId, socketId: socket.id, slots: [game.players[0].socketId, game.players[1].socketId] });
      socket.emit('error_msg', 'Room is full');
      return;
    }

    currentRoom = roomId;
    playerIdx = idx;
    socket.join(roomId);

    log('JOIN', `Player joined room`, {
      roomId,
      playerIdx: idx,
      socketId: socket.id,
      isNewGame,
      phase: game.phase,
      slots: [game.players[0].socketId ? 'filled' : 'empty', game.players[1].socketId ? 'filled' : 'empty'],
    });

    socket.emit('joined', {
      playerIdx: idx,
      config: { ...CONFIG, NUKES_PER_PLAYER: game.nukesPerPlayer },
      roomId,
    });

    const bothConnected = game.players[0].socketId && game.players[1].socketId;
    if (bothConnected && game.phase === 'waiting') {
      game.phase = 'placement';
      log('PHASE', `Both players connected, entering placement`, { roomId });
      io.to(roomId).emit('phase', 'placement');
    } else if (game.phase !== 'waiting') {
      log('REJOIN', `Late rejoin, sending current phase`, { roomId, playerIdx: idx, phase: game.phase });
      socket.emit('phase', game.phase);
    }
  });

  socket.on('place_ships', (ships) => {
    if (!currentRoom || playerIdx === null) {
      log('WARN', `place_ships from unjoined socket`, { socketId: socket.id });
      return;
    }
    const game = games.get(currentRoom);
    if (!game || game.phase !== 'placement') {
      log('WARN', `place_ships in wrong phase`, { roomId: currentRoom, playerIdx, phase: game?.phase });
      return;
    }

    const player = game.players[playerIdx];
    if (player.shipsPlaced) {
      log('WARN', `Player already placed ships`, { roomId: currentRoom, playerIdx });
      return;
    }

    if (!validatePlacement(ships)) {
      log('WARN', `Invalid ship placement rejected`, { roomId: currentRoom, playerIdx });
      socket.emit('error_msg', 'Invalid ship placement');
      return;
    }

    player.ships = ships.map((s, i) => ({
      name: CONFIG.SHIPS[i].name,
      cells: s.cells.map(({ r, c }) => ({ r, c })),
      sunk: false,
    }));

    for (const ship of player.ships) {
      for (const { r, c } of ship.cells) {
        player.shipGrid[r][c] = 'S';
      }
    }

    player.shipsPlaced = true;
    socket.emit('ships_confirmed');

    log('PLACE', `Ships placed`, { roomId: currentRoom, playerIdx });

    const opponentSocket = game.players[1 - playerIdx].socketId;
    if (opponentSocket) {
      io.to(opponentSocket).emit('opponent_ready');
    }

    if (game.players[0].shipsPlaced && game.players[1].shipsPlaced) {
      game.phase = 'battle';
      game.turn = 0;
      log('PHASE', `Both placed, entering battle`, { roomId: currentRoom, firstTurn: 0 });
      io.to(currentRoom).emit('phase', 'battle');
      io.to(currentRoom).emit('turn', game.turn);
    }
  });

  socket.on('fire', ({ r, c, weapon }) => {
    if (!currentRoom || playerIdx === null) {
      log('WARN', `fire from unjoined socket`, { socketId: socket.id });
      return;
    }
    const game = games.get(currentRoom);
    if (!game || game.phase !== 'battle') {
      log('WARN', `fire in wrong phase`, { roomId: currentRoom, playerIdx, phase: game?.phase });
      return;
    }
    if (game.turn !== playerIdx) {
      log('WARN', `fire out of turn`, { roomId: currentRoom, playerIdx, expectedTurn: game.turn });
      socket.emit('error_msg', 'Not your turn');
      return;
    }

    if (r < 0 || r >= CONFIG.GRID_SIZE || c < 0 || c >= CONFIG.GRID_SIZE) {
      log('WARN', `fire out of bounds`, { roomId: currentRoom, playerIdx, r, c });
      return;
    }
    if (weapon !== 'missile' && weapon !== 'nuke') {
      log('WARN', `fire with invalid weapon`, { roomId: currentRoom, playerIdx, weapon });
      return;
    }

    log('FIRE', `Shot fired`, { roomId: currentRoom, playerIdx, r, c, weapon });

    const result = processShot(game, playerIdx, r, c, weapon);

    if (result.error) {
      log('WARN', `Shot error`, { roomId: currentRoom, playerIdx, error: result.error });
      socket.emit('error_msg', result.error);
      return;
    }

    const hits = result.results.filter(r => r.result === 'hit').length;
    const misses = result.results.filter(r => r.result === 'miss').length;
    log('RESULT', `Shot resolved`, {
      roomId: currentRoom,
      attackerIdx: playerIdx,
      weapon,
      hits,
      misses,
      sunkShips: result.sunkShips,
      gameOver: result.gameOver,
      nextTurn: game.turn,
    });

    io.to(currentRoom).emit('shot_result', {
      attackerIdx: playerIdx,
      results: result.results,
      sunkShips: result.sunkShips,
      gameOver: result.gameOver,
      winner: result.gameOver ? playerIdx : null,
      weapon: result.weapon,
      nukes: [game.players[0].nukes, game.players[1].nukes],
    });

    if (!result.gameOver) {
      io.to(currentRoom).emit('turn', game.turn);
    } else {
      log('GAME_OVER', `Game finished`, { roomId: currentRoom, winner: playerIdx });
    }
  });

  socket.on('request_rematch', () => {
    if (!currentRoom || playerIdx === null) return;
    const game = games.get(currentRoom);
    if (!game || game.phase !== 'finished') return;

    if (!game.rematchVotes) game.rematchVotes = [false, false];
    game.rematchVotes[playerIdx] = true;

    log('REMATCH', `Player requested rematch`, { roomId: currentRoom, playerIdx, votes: game.rematchVotes });

    // Notify opponent
    const opponentSocket = game.players[1 - playerIdx].socketId;
    if (opponentSocket) {
      io.to(opponentSocket).emit('opponent_wants_rematch');
    }

    // Both agreed — reset the game
    if (game.rematchVotes[0] && game.rematchVotes[1]) {
      log('REMATCH', `Both agreed, resetting game`, { roomId: currentRoom, nukesPerPlayer: game.nukesPerPlayer });

      // Preserve socket IDs and nuke config
      const s0 = game.players[0].socketId;
      const s1 = game.players[1].socketId;
      const nukes = game.nukesPerPlayer;

      // Reset to fresh state
      const fresh = createGame(currentRoom, nukes);
      fresh.players[0].socketId = s0;
      fresh.players[1].socketId = s1;
      fresh.phase = 'placement';
      games.set(currentRoom, fresh);

      io.to(currentRoom).emit('rematch_start', {
        config: { ...CONFIG, NUKES_PER_PLAYER: nukes },
      });
      io.to(currentRoom).emit('phase', 'placement');
    }
  });

  socket.on('disconnect', (reason) => {
    log('DISC', `Socket disconnected`, { socketId: socket.id, roomId: currentRoom, playerIdx, reason });

    if (!currentRoom || playerIdx === null) return;
    const game = games.get(currentRoom);
    if (!game) return;

    game.players[playerIdx].socketId = null;

    const opponentSocket = game.players[1 - playerIdx].socketId;
    if (opponentSocket) {
      io.to(opponentSocket).emit('opponent_disconnected');
    }

    if (!game.players[0].socketId && !game.players[1].socketId) {
      log('CLEANUP', `Both disconnected, removing game`, { roomId: currentRoom, phase: game.phase });
      games.delete(currentRoom);
    }
  });
});

// Periodic stats
setInterval(() => {
  if (games.size > 0) {
    const stats = [];
    for (const [roomId, game] of games) {
      stats.push({
        roomId,
        phase: game.phase,
        turn: game.turn,
        p0: game.players[0].socketId ? 'online' : 'offline',
        p1: game.players[1].socketId ? 'online' : 'offline',
      });
    }
    log('STATS', `Active games: ${games.size}`, stats);
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log('SERVER', `Battleship server running on http://localhost:${PORT}${BASE_PATH}/`);
  log('SERVER', `Share link: http://localhost:${PORT}${BASE_PATH}/join`);
});
