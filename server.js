const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { generateAIPlacement, createAIState, chooseAIShot, updateAIState } = require('./ai');
const {
  CONFIG, createEmptyGrid, createPlayerState, createGame,
  validatePlacement, checkSunk, checkAllSunk, processShot, placeShipsOnPlayer,
} = require('./game-logic');

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

// Active games: roomId -> game state
const games = new Map();

// Disconnect grace timers: "roomId:playerIdx" -> timeout handle
const disconnectTimers = new Map();
const DISCONNECT_GRACE_MS = 15000;

// ── AI helpers ──

function emitBoardReveal(io, game, roomId) {
  for (let i = 0; i < 2; i++) {
    const opponentIdx = 1 - i;
    const opponentShips = game.players[opponentIdx].ships.map(s => ({
      name: s.name,
      cells: s.cells,
      sunk: s.sunk
    }));
    const sid = game.players[i].socketId;
    if (sid && sid !== '__AI__') {
      io.to(sid).emit('board_reveal', opponentShips);
    }
  }
}

function setupAIPlayer(game) {
  const aiPlayer = game.players[1];
  const configForAI = { ...CONFIG, NUKES_PER_PLAYER: game.nukesPerPlayer, difficulty: game.difficulty || 'normal' };
  const ships = generateAIPlacement(configForAI);

  aiPlayer.socketId = '__AI__';
  placeShipsOnPlayer(aiPlayer, ships);

  game.isAI = true;
  game.ai = createAIState(configForAI);
  game.ai.nukesRemaining = game.nukesPerPlayer;
}

function scheduleAITurn(game, roomId) {
  const delay = 3000;
  setTimeout(() => {
    const g = games.get(roomId);
    if (!g || g.phase !== 'battle' || g.turn !== 1 || !g.isAI) return;

    const configForAI = { ...CONFIG, NUKES_PER_PLAYER: g.nukesPerPlayer, difficulty: g.difficulty || 'normal' };
    const shot = chooseAIShot(g.ai, g.players[1].shotGrid, configForAI);

    log('AI_FIRE', `AI firing`, { roomId, r: shot.r, c: shot.c, weapon: shot.weapon });

    const result = processShot(g, 1, shot.r, shot.c, shot.weapon);
    if (result.error) {
      log('AI', `Shot error, retrying`, { roomId, error: result.error });
      scheduleAITurn(g, roomId);
      return;
    }

    if (shot.weapon === 'nuke') g.ai.nukesRemaining = g.players[1].nukes;

    // Build sunk ship objects with cells for AI state update
    const sunkNames = result.sunkShips.map(s => s.name);
    const newlySunk = g.players[0].ships.filter(s => s.sunk && sunkNames.includes(s.name));
    updateAIState(g.ai, shot, result.results, newlySunk, configForAI);

    log('AI_RESULT', `AI shot resolved`, {
      roomId,
      weapon: shot.weapon,
      hits: result.results.filter(r => r.result === 'hit').length,
      misses: result.results.filter(r => r.result === 'miss').length,
      sunkShips: result.sunkShips,
      gameOver: result.gameOver,
      aiMode: g.ai.mode,
      hitStackLen: g.ai.hitStack.length,
    });

    io.to(roomId).emit('shot_result', {
      attackerIdx: 1,
      results: result.results,
      sunkShips: result.sunkShips,
      gameOver: result.gameOver,
      winner: result.gameOver ? 1 : null,
      weapon: result.weapon,
      nukes: [g.players[0].nukes, g.players[1].nukes],
    });

    if (!result.gameOver) {
      io.to(roomId).emit('turn', g.turn);
    } else {
      log('GAME_OVER', `AI won`, { roomId });
      emitBoardReveal(io, g, roomId);
    }
  }, delay);
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
    let roomId, nukes, mode;
    if (typeof data === 'string') {
      roomId = data;
    } else if (data && typeof data === 'object') {
      roomId = data.roomId;
      nukes = data.nukes;
      mode = data.mode;
    }
    if (!roomId || typeof roomId !== 'string') {
      log('WARN', `Invalid room ID from socket`, { socketId: socket.id, roomId });
      return;
    }
    roomId = roomId.trim().toLowerCase();

    let game = games.get(roomId);
    const isNewGame = !game;

    if (!game) {
      const validModes = ['standard', 'classic', 'fog'];
      const gameMode = validModes.includes(mode) ? mode : 'standard';
      if (gameMode === 'classic') nukes = 0;
      game = createGame(roomId, nukes);
      game.mode = gameMode;
      games.set(roomId, game);
      log('ROOM', `Room created`, { roomId, nukesPerPlayer: game.nukesPerPlayer, mode: gameMode });
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

          // Cancel disconnect grace timer if this slot had one
          const timerKey = `${roomId}:${i}`;
          const pending = disconnectTimers.get(timerKey);
          if (pending) {
            clearTimeout(pending);
            disconnectTimers.delete(timerKey);
            log('REJOIN', `Grace timer cancelled — player reconnected`, { roomId, playerIdx: i });
          }
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
      mode: game.mode || 'standard',
    });

    const bothConnected = game.players[0].socketId && game.players[1].socketId;
    if (bothConnected && game.phase === 'waiting') {
      // Notify the player who was already waiting
      const waitingSocket = game.players[1 - idx].socketId;
      if (waitingSocket) io.to(waitingSocket).emit('opponent_joined');

      game.phase = 'placement';
      log('PHASE', `Both players connected, entering placement`, { roomId });
      io.to(roomId).emit('phase', 'placement');
    } else if (game.phase !== 'waiting') {
      log('REJOIN', `Late rejoin, sending current phase`, { roomId, playerIdx: idx, phase: game.phase });
      socket.emit('phase', game.phase);
    }
  });

  socket.on('join_ai_game', (data) => {
    let nukes = (data && typeof data === 'object') ? data.nukes : undefined;
    const difficulty = (data && typeof data === 'object' && (data.difficulty === 'hard' || data.difficulty === 'normal')) ? data.difficulty : 'normal';
    const validModes = ['standard', 'classic', 'fog'];
    const mode = (data && typeof data === 'object' && validModes.includes(data.mode)) ? data.mode : 'standard';
    if (mode === 'classic') nukes = 0;
    const roomId = `ai-${crypto.randomBytes(4).toString('hex')}`;
    const game = createGame(roomId, nukes);
    game.difficulty = difficulty;
    game.mode = mode;
    games.set(roomId, game);

    // Human is player 0
    game.players[0].socketId = socket.id;
    currentRoom = roomId;
    playerIdx = 0;
    socket.join(roomId);

    // AI is player 1
    setupAIPlayer(game);

    game.phase = 'placement';
    log('AI_GAME', `AI game created`, { roomId, nukesPerPlayer: game.nukesPerPlayer, difficulty, mode });

    socket.emit('joined', {
      playerIdx: 0,
      config: { ...CONFIG, NUKES_PER_PLAYER: game.nukesPerPlayer },
      roomId,
      isAI: true,
      mode,
    });
    socket.emit('phase', 'placement');
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

    placeShipsOnPlayer(player, ships);
    socket.emit('ships_confirmed');

    log('PLACE', `Ships placed`, { roomId: currentRoom, playerIdx });

    const opponentSocket = game.players[1 - playerIdx].socketId;
    if (opponentSocket && opponentSocket !== '__AI__') {
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
      // Trigger AI turn if it's the computer's turn
      if (game.isAI && game.turn === 1) {
        scheduleAITurn(game, currentRoom);
      }
    } else {
      log('GAME_OVER', `Game finished`, { roomId: currentRoom, winner: playerIdx });
      emitBoardReveal(io, game, currentRoom);
    }
  });

  socket.on('forfeit', () => {
    if (!currentRoom || playerIdx === null) return;
    const game = games.get(currentRoom);
    if (!game || game.phase !== 'battle') return;

    const winnerIdx = 1 - playerIdx;
    game.phase = 'finished';
    game.winner = winnerIdx;
    game.players[playerIdx].alive = false;

    log('FORFEIT', `Player forfeited`, { roomId: currentRoom, playerIdx, winner: winnerIdx });

    io.to(currentRoom).emit('forfeit_result', {
      loserIdx: playerIdx,
      winnerIdx,
    });

    emitBoardReveal(io, game, currentRoom);
  });

  socket.on('reaction', (reactionId) => {
    if (!currentRoom || playerIdx === null) return;
    const game = games.get(currentRoom);
    if (!game || (game.phase !== 'battle' && game.phase !== 'finished')) return;
    if (typeof reactionId !== 'number' || reactionId < 0 || reactionId > 4) return;
    const opponentSocket = game.players[1 - playerIdx].socketId;
    if (opponentSocket) {
      io.to(opponentSocket).emit('opponent_reaction', reactionId);
    }
  });

  socket.on('chat_message', (msg) => {
    if (!currentRoom || playerIdx === null) return;
    const game = games.get(currentRoom);
    if (!game || (game.phase !== 'battle' && game.phase !== 'finished')) return;
    if (typeof msg !== 'string' || msg.length === 0 || msg.length > 120) return;
    const opponentSocket = game.players[1 - playerIdx].socketId;
    if (opponentSocket && opponentSocket !== '__AI__') {
      io.to(opponentSocket).emit('chat_message', msg);
    }
  });

  socket.on('request_rematch', () => {
    if (!currentRoom || playerIdx === null) return;
    const game = games.get(currentRoom);
    if (!game || game.phase !== 'finished') return;

    if (!game.rematchVotes) game.rematchVotes = [false, false];
    game.rematchVotes[playerIdx] = true;

    // AI auto-accepts rematch
    if (game.isAI) game.rematchVotes[1] = true;

    log('REMATCH', `Player requested rematch`, { roomId: currentRoom, playerIdx, votes: game.rematchVotes });

    // Notify opponent (skip for AI)
    const opponentSocket = game.players[1 - playerIdx].socketId;
    if (opponentSocket && opponentSocket !== '__AI__') {
      io.to(opponentSocket).emit('opponent_wants_rematch');
    }

    // Both agreed — reset the game
    if (game.rematchVotes[0] && game.rematchVotes[1]) {
      const wasAI = game.isAI;
      log('REMATCH', `Both agreed, resetting game`, { roomId: currentRoom, nukesPerPlayer: game.nukesPerPlayer, isAI: wasAI });

      // Preserve socket IDs, nuke config, difficulty, and mode
      const s0 = game.players[0].socketId;
      const s1 = game.players[1].socketId;
      const nukes = game.nukesPerPlayer;
      const difficulty = game.difficulty || 'normal';
      const mode = game.mode || 'standard';

      // Reset to fresh state
      const fresh = createGame(currentRoom, nukes);
      fresh.difficulty = difficulty;
      fresh.mode = mode;
      fresh.players[0].socketId = s0;
      fresh.players[1].socketId = s1;
      fresh.phase = 'placement';

      if (wasAI) {
        setupAIPlayer(fresh);
      }

      games.set(currentRoom, fresh);

      io.to(currentRoom).emit('rematch_start', {
        config: { ...CONFIG, NUKES_PER_PLAYER: nukes },
        isAI: wasAI,
        difficulty,
        mode,
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

    // AI games: clean up immediately when human disconnects
    if (game.isAI) {
      log('CLEANUP', `AI game — human disconnected, removing game`, { roomId: currentRoom });
      games.delete(currentRoom);
      return;
    }

    const timerKey = `${currentRoom}:${playerIdx}`;

    // Start grace period — give the player time to reconnect (e.g. app switch on mobile)
    const timer = setTimeout(() => {
      disconnectTimers.delete(timerKey);
      const g = games.get(currentRoom);
      if (!g) return;

      // Player didn't reconnect in time
      if (!g.players[playerIdx].socketId) {
        log('DISC', `Grace period expired, finalizing disconnect`, { roomId: currentRoom, playerIdx });

        const opponentSocket = g.players[1 - playerIdx].socketId;
        if (opponentSocket) {
          io.to(opponentSocket).emit('opponent_disconnected');
        }

        if (!g.players[0].socketId && !g.players[1].socketId) {
          log('CLEANUP', `Both disconnected, removing game`, { roomId: currentRoom, phase: g.phase });
          games.delete(currentRoom);
        }
      }
    }, DISCONNECT_GRACE_MS);

    disconnectTimers.set(timerKey, timer);
    log('DISC', `Grace period started (${DISCONNECT_GRACE_MS / 1000}s)`, { roomId: currentRoom, playerIdx });
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
