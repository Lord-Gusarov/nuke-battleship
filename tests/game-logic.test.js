'use strict';

const {
  CONFIG, createEmptyGrid, createPlayerState, createGame,
  validatePlacement, checkSunk, checkAllSunk, processShot, placeShipsOnPlayer,
} = require('../game-logic');

// ── Helper: build a valid placement array ──

function makeShips() {
  return [
    { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }, { r: 0, c: 3 }, { r: 0, c: 4 }] }, // Carrier 5
    { cells: [{ r: 2, c: 0 }, { r: 2, c: 1 }, { r: 2, c: 2 }, { r: 2, c: 3 }] },                   // Battleship 4
    { cells: [{ r: 4, c: 0 }, { r: 4, c: 1 }, { r: 4, c: 2 }] },                                   // Cruiser 3
    { cells: [{ r: 6, c: 0 }, { r: 6, c: 1 }, { r: 6, c: 2 }] },                                   // Submarine 3
    { cells: [{ r: 8, c: 0 }, { r: 8, c: 1 }] },                                                     // Destroyer 2
  ];
}

function setupBattleGame() {
  const game = createGame('test-room', 2);
  const ships0 = makeShips();
  const ships1 = makeShips();
  placeShipsOnPlayer(game.players[0], ships0);
  placeShipsOnPlayer(game.players[1], ships1);
  game.phase = 'battle';
  game.turn = 0;
  return game;
}

// ═══════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════

describe('CONFIG', () => {
  test('has 10x10 grid', () => {
    expect(CONFIG.GRID_SIZE).toBe(10);
  });

  test('has 5 ships totaling 17 cells', () => {
    expect(CONFIG.SHIPS).toHaveLength(5);
    const total = CONFIG.SHIPS.reduce((sum, s) => sum + s.size, 0);
    expect(total).toBe(17);
  });
});

// ═══════════════════════════════════════════
//  createEmptyGrid
// ═══════════════════════════════════════════

describe('createEmptyGrid', () => {
  test('creates 10x10 grid of nulls by default', () => {
    const grid = createEmptyGrid();
    expect(grid).toHaveLength(10);
    expect(grid[0]).toHaveLength(10);
    expect(grid[5][5]).toBeNull();
  });

  test('creates custom size grid', () => {
    const grid = createEmptyGrid(5);
    expect(grid).toHaveLength(5);
    expect(grid[0]).toHaveLength(5);
  });

  test('rows are independent (not shared references)', () => {
    const grid = createEmptyGrid();
    grid[0][0] = 'X';
    expect(grid[1][0]).toBeNull();
  });
});

// ═══════════════════════════════════════════
//  createPlayerState
// ═══════════════════════════════════════════

describe('createPlayerState', () => {
  test('creates default player state', () => {
    const p = createPlayerState();
    expect(p.socketId).toBeNull();
    expect(p.ships).toEqual([]);
    expect(p.shipsPlaced).toBe(false);
    expect(p.nukes).toBe(CONFIG.NUKES_PER_PLAYER);
    expect(p.alive).toBe(true);
    expect(p.shipGrid).toHaveLength(10);
    expect(p.shotGrid).toHaveLength(10);
  });

  test('accepts custom nuke count', () => {
    const p = createPlayerState(5);
    expect(p.nukes).toBe(5);
  });
});

// ═══════════════════════════════════════════
//  createGame
// ═══════════════════════════════════════════

describe('createGame', () => {
  test('creates game with default nukes', () => {
    const game = createGame('room1');
    expect(game.roomId).toBe('room1');
    expect(game.phase).toBe('waiting');
    expect(game.turn).toBe(0);
    expect(game.winner).toBeNull();
    expect(game.players).toHaveLength(2);
    expect(game.players[0].nukes).toBe(2);
    expect(game.players[1].nukes).toBe(2);
  });

  test('creates game with custom nukes', () => {
    const game = createGame('room2', 5);
    expect(game.nukesPerPlayer).toBe(5);
    expect(game.players[0].nukes).toBe(5);
  });

  test('clamps nukes to 0-10 range', () => {
    expect(createGame('r', -3).nukesPerPlayer).toBe(0);
    expect(createGame('r', 99).nukesPerPlayer).toBe(10);
  });
});

// ═══════════════════════════════════════════
//  validatePlacement
// ═══════════════════════════════════════════

describe('validatePlacement', () => {
  test('accepts a valid horizontal placement', () => {
    expect(validatePlacement(makeShips())).toBe(true);
  });

  test('accepts valid vertical placement', () => {
    const ships = [
      { cells: [{ r: 0, c: 0 }, { r: 1, c: 0 }, { r: 2, c: 0 }, { r: 3, c: 0 }, { r: 4, c: 0 }] },
      { cells: [{ r: 0, c: 2 }, { r: 1, c: 2 }, { r: 2, c: 2 }, { r: 3, c: 2 }] },
      { cells: [{ r: 0, c: 4 }, { r: 1, c: 4 }, { r: 2, c: 4 }] },
      { cells: [{ r: 0, c: 6 }, { r: 1, c: 6 }, { r: 2, c: 6 }] },
      { cells: [{ r: 0, c: 8 }, { r: 1, c: 8 }] },
    ];
    expect(validatePlacement(ships)).toBe(true);
  });

  test('rejects wrong number of ships', () => {
    expect(validatePlacement(makeShips().slice(0, 3))).toBe(false);
  });

  test('rejects wrong ship size', () => {
    const ships = makeShips();
    ships[0].cells = ships[0].cells.slice(0, 3); // Carrier should be 5, not 3
    expect(validatePlacement(ships)).toBe(false);
  });

  test('rejects overlapping ships', () => {
    const ships = makeShips();
    ships[1].cells[0] = { r: 0, c: 0 }; // overlaps with Carrier
    expect(validatePlacement(ships)).toBe(false);
  });

  test('rejects out-of-bounds cells', () => {
    const ships = makeShips();
    ships[4].cells = [{ r: 9, c: 9 }, { r: 9, c: 10 }]; // c=10 out of bounds
    expect(validatePlacement(ships)).toBe(false);
  });

  test('rejects diagonal placement', () => {
    const ships = makeShips();
    ships[4].cells = [{ r: 5, c: 5 }, { r: 6, c: 6 }]; // diagonal
    expect(validatePlacement(ships)).toBe(false);
  });

  test('rejects non-contiguous cells', () => {
    const ships = makeShips();
    ships[4].cells = [{ r: 5, c: 0 }, { r: 5, c: 2 }]; // gap at c=1
    expect(validatePlacement(ships)).toBe(false);
  });

  test('rejects null/undefined input', () => {
    expect(validatePlacement(null)).toBe(false);
    expect(validatePlacement(undefined)).toBe(false);
    expect(validatePlacement('not an array')).toBe(false);
  });
});

// ═══════════════════════════════════════════
//  placeShipsOnPlayer
// ═══════════════════════════════════════════

describe('placeShipsOnPlayer', () => {
  test('populates shipGrid, ships array, and shipsPlaced', () => {
    const player = createPlayerState();
    placeShipsOnPlayer(player, makeShips());

    expect(player.shipsPlaced).toBe(true);
    expect(player.ships).toHaveLength(5);
    expect(player.ships[0].name).toBe('Carrier');
    expect(player.ships[0].sunk).toBe(false);
    expect(player.shipGrid[0][0]).toBe('S');
    expect(player.shipGrid[1][0]).toBeNull(); // empty row
  });

  test('places correct number of S cells (17 total)', () => {
    const player = createPlayerState();
    placeShipsOnPlayer(player, makeShips());
    let count = 0;
    for (let r = 0; r < 10; r++)
      for (let c = 0; c < 10; c++)
        if (player.shipGrid[r][c] === 'S') count++;
    expect(count).toBe(17);
  });
});

// ═══════════════════════════════════════════
//  checkSunk / checkAllSunk
// ═══════════════════════════════════════════

describe('checkSunk', () => {
  test('marks ship as sunk when all cells hit', () => {
    const player = createPlayerState();
    placeShipsOnPlayer(player, makeShips());

    // Hit all Destroyer cells (row 8, cols 0-1)
    player.shipGrid[8][0] = 'hit';
    player.shipGrid[8][1] = 'hit';

    checkSunk(player);
    const destroyer = player.ships.find(s => s.name === 'Destroyer');
    expect(destroyer.sunk).toBe(true);
  });

  test('does not mark partially hit ship as sunk', () => {
    const player = createPlayerState();
    placeShipsOnPlayer(player, makeShips());

    player.shipGrid[0][0] = 'hit'; // only 1 of 5 Carrier cells

    checkSunk(player);
    const carrier = player.ships.find(s => s.name === 'Carrier');
    expect(carrier.sunk).toBe(false);
  });
});

describe('checkAllSunk', () => {
  test('returns false when ships remain', () => {
    const player = createPlayerState();
    placeShipsOnPlayer(player, makeShips());
    checkSunk(player);
    expect(checkAllSunk(player)).toBe(false);
  });

  test('returns true when all ships sunk', () => {
    const player = createPlayerState();
    placeShipsOnPlayer(player, makeShips());

    // Hit every ship cell
    for (const ship of player.ships) {
      for (const { r, c } of ship.cells) {
        player.shipGrid[r][c] = 'hit';
      }
    }
    checkSunk(player);
    expect(checkAllSunk(player)).toBe(true);
  });
});

// ═══════════════════════════════════════════
//  processShot — Missiles
// ═══════════════════════════════════════════

describe('processShot — missile', () => {
  test('registers a hit on ship cell', () => {
    const game = setupBattleGame();
    const result = processShot(game, 0, 0, 0, 'missile'); // hit Carrier at (0,0)

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toEqual({ r: 0, c: 0, result: 'hit' });
    expect(result.gameOver).toBe(false);
    expect(game.players[0].shotGrid[0][0]).toBe('hit');
    expect(game.players[1].shipGrid[0][0]).toBe('hit');
  });

  test('registers a miss on empty cell', () => {
    const game = setupBattleGame();
    const result = processShot(game, 0, 1, 0, 'missile'); // row 1 is empty

    expect(result.results[0]).toEqual({ r: 1, c: 0, result: 'miss' });
    expect(game.players[0].shotGrid[1][0]).toBe('miss');
  });

  test('advances turn to defender', () => {
    const game = setupBattleGame();
    expect(game.turn).toBe(0);
    processShot(game, 0, 5, 5, 'missile');
    expect(game.turn).toBe(1);
  });

  test('returns error when shooting same cell twice', () => {
    const game = setupBattleGame();
    processShot(game, 0, 5, 5, 'missile');
    game.turn = 0; // reset turn for test
    const result = processShot(game, 0, 5, 5, 'missile');
    expect(result.error).toBe('All targeted cells already shot');
  });

  test('detects sunk ship', () => {
    const game = setupBattleGame();
    // Sink Destroyer (row 8, cols 0-1) on player 1
    processShot(game, 0, 8, 0, 'missile');
    game.turn = 0;
    const result = processShot(game, 0, 8, 1, 'missile');

    expect(result.sunkShips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Destroyer' }),
      ])
    );
  });

  test('detects game over when all ships sunk', () => {
    const game = setupBattleGame();
    // Sink all of player 1's ships
    const allCells = game.players[1].ships.flatMap(s => s.cells);
    for (const { r, c } of allCells) {
      game.turn = 0;
      processShot(game, 0, r, c, 'missile');
    }

    expect(game.phase).toBe('finished');
    expect(game.winner).toBe(0);
    expect(game.players[1].alive).toBe(false);
  });

  test('sunkShips includes cell data', () => {
    const game = setupBattleGame();
    processShot(game, 0, 8, 0, 'missile');
    game.turn = 0;
    const result = processShot(game, 0, 8, 1, 'missile');

    const sunkDestroyer = result.sunkShips.find(s => s.name === 'Destroyer');
    expect(sunkDestroyer).toBeDefined();
    expect(sunkDestroyer.cells).toHaveLength(2);
    expect(sunkDestroyer.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ r: 8, c: 0 }),
        expect.objectContaining({ r: 8, c: 1 }),
      ])
    );
  });
});

// ═══════════════════════════════════════════
//  processShot — Nukes
// ═══════════════════════════════════════════

describe('processShot — nuke', () => {
  test('hits 3x3 area around target', () => {
    const game = setupBattleGame();
    const result = processShot(game, 0, 5, 5, 'nuke');

    // Center of board: full 9-cell blast
    expect(result.results).toHaveLength(9);
    expect(result.weapon).toBe('nuke');
  });

  test('decrements nuke count', () => {
    const game = setupBattleGame();
    expect(game.players[0].nukes).toBe(2);
    processShot(game, 0, 5, 5, 'nuke');
    expect(game.players[0].nukes).toBe(1);
  });

  test('returns error when no nukes remaining', () => {
    const game = setupBattleGame();
    game.players[0].nukes = 0;
    const result = processShot(game, 0, 5, 5, 'nuke');
    expect(result.error).toBe('No nukes remaining');
  });

  test('clips blast at board edge (corner)', () => {
    const game = setupBattleGame();
    const result = processShot(game, 0, 0, 0, 'nuke');

    // Top-left corner: only 4 cells in bounds (0,0) (0,1) (1,0) (1,1)
    expect(result.results).toHaveLength(4);
  });

  test('clips blast at board edge (side)', () => {
    const game = setupBattleGame();
    const result = processShot(game, 0, 0, 5, 'nuke');

    // Top edge, middle column: 6 cells
    expect(result.results).toHaveLength(6);
  });

  test('nuke can sink ships', () => {
    const game = setupBattleGame();
    // Destroyer is at row 8, cols 0-1. Hit col 0 first.
    processShot(game, 0, 8, 0, 'missile');
    game.turn = 0;
    // Nuke centered on (8,1) — should hit (8,1) and sink Destroyer
    const result = processShot(game, 0, 8, 1, 'nuke');
    expect(result.sunkShips).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Destroyer' })])
    );
  });

  test('nuke skips already-shot cells', () => {
    const game = setupBattleGame();
    processShot(game, 0, 5, 5, 'missile'); // shoot center first
    game.turn = 0;
    const result = processShot(game, 0, 5, 5, 'nuke'); // nuke same center
    // (5,5) was already shot, so only 8 results
    expect(result.results).toHaveLength(8);
  });
});
