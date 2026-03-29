'use strict';

const CONFIG = {
  GRID_SIZE: 10,
  NUKES_PER_PLAYER: 2,
  SHIPS: [
    { name: 'Carrier', size: 5 },
    { name: 'Battleship', size: 4 },
    { name: 'Cruiser', size: 3 },
    { name: 'Submarine', size: 3 },
    { name: 'Destroyer', size: 2 },
  ],
};

function createEmptyGrid(size) {
  const gs = size || CONFIG.GRID_SIZE;
  return Array.from({ length: gs }, () => Array(gs).fill(null));
}

function createPlayerState(nukes) {
  return {
    socketId: null,
    shipGrid: createEmptyGrid(),
    shotGrid: createEmptyGrid(),
    ships: [],
    shipsPlaced: false,
    nukes: nukes != null ? nukes : CONFIG.NUKES_PER_PLAYER,
    alive: true,
  };
}

function createGame(roomId, nukesPerPlayer) {
  const nukes = Math.max(0, Math.min(10, Math.floor(nukesPerPlayer || CONFIG.NUKES_PER_PLAYER)));
  const game = {
    roomId,
    nukesPerPlayer: nukes,
    players: [createPlayerState(nukes), createPlayerState(nukes)],
    phase: 'waiting',
    turn: 0,
    winner: null,
  };
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
  const sunkShips = defender.ships.filter(s => s.sunk).map(s => ({ name: s.name, cells: s.cells }));

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

function placeShipsOnPlayer(player, ships) {
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
}

module.exports = {
  CONFIG,
  createEmptyGrid,
  createPlayerState,
  createGame,
  validatePlacement,
  checkSunk,
  checkAllSunk,
  processShot,
  placeShipsOnPlayer,
};
