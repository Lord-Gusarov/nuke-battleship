'use strict';

const { generateAIPlacement, createAIState, chooseAIShot, updateAIState, computeProbabilityMap } = require('../ai');
const { CONFIG, createGame, placeShipsOnPlayer, processShot } = require('../game-logic');

const AI_CONFIG = { ...CONFIG, NUKES_PER_PLAYER: 2 };
const HARD_CONFIG = { ...CONFIG, NUKES_PER_PLAYER: 2, difficulty: 'hard' };

// ═══════════════════════════════════════════
//  generateAIPlacement
// ═══════════════════════════════════════════

describe('generateAIPlacement', () => {
  test('returns 5 ships with correct sizes', () => {
    const ships = generateAIPlacement(AI_CONFIG);
    expect(ships).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(ships[i].cells).toHaveLength(CONFIG.SHIPS[i].size);
    }
  });

  test('all cells are within grid bounds', () => {
    const ships = generateAIPlacement(AI_CONFIG);
    for (const ship of ships) {
      for (const { r, c } of ship.cells) {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(CONFIG.GRID_SIZE);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(CONFIG.GRID_SIZE);
      }
    }
  });

  test('no overlapping cells', () => {
    const ships = generateAIPlacement(AI_CONFIG);
    const cells = new Set();
    for (const ship of ships) {
      for (const { r, c } of ship.cells) {
        const key = `${r},${c}`;
        expect(cells.has(key)).toBe(false);
        cells.add(key);
      }
    }
  });

  test('places 17 total cells', () => {
    const ships = generateAIPlacement(AI_CONFIG);
    const total = ships.reduce((sum, s) => sum + s.cells.length, 0);
    expect(total).toBe(17);
  });

  test('produces different placements (randomness)', () => {
    const placements = new Set();
    for (let i = 0; i < 10; i++) {
      const ships = generateAIPlacement(AI_CONFIG);
      const key = ships.map(s => s.cells.map(c => `${c.r},${c.c}`).join('|')).join('||');
      placements.add(key);
    }
    expect(placements.size).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════
//  createAIState
// ═══════════════════════════════════════════

describe('createAIState', () => {
  test('initializes in hunt mode', () => {
    const state = createAIState(AI_CONFIG);
    expect(state.mode).toBe('hunt');
  });

  test('has 100 hunt cells for 10x10 grid', () => {
    const state = createAIState(AI_CONFIG);
    expect(state.huntCells).toHaveLength(100);
  });

  test('checkerboard cells come first', () => {
    const state = createAIState(AI_CONFIG);
    // First 50 cells should all be checkerboard (r+c) % 2 === 0
    const first50 = state.huntCells.slice(0, 50);
    for (const { r, c } of first50) {
      expect((r + c) % 2).toBe(0);
    }
  });

  test('has empty target queue and hit stack', () => {
    const state = createAIState(AI_CONFIG);
    expect(state.targetQueue).toEqual([]);
    expect(state.hitStack).toEqual([]);
    expect(state.triedCells.size).toBe(0);
  });

  test('nuke pacing: missilesUntilNuke is 2-5', () => {
    const values = new Set();
    for (let i = 0; i < 100; i++) {
      values.add(createAIState(AI_CONFIG).missilesUntilNuke);
    }
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
});

// ═══════════════════════════════════════════
//  chooseAIShot — Hunt mode
// ═══════════════════════════════════════════

describe('chooseAIShot — hunt mode', () => {
  test('returns valid coordinates', () => {
    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 0; // disable nukes for this test
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    const shot = chooseAIShot(state, shotGrid, AI_CONFIG);

    expect(shot.r).toBeGreaterThanOrEqual(0);
    expect(shot.r).toBeLessThan(10);
    expect(shot.c).toBeGreaterThanOrEqual(0);
    expect(shot.c).toBeLessThan(10);
    expect(shot.weapon).toBe('missile');
  });

  test('never picks the same cell twice', () => {
    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 0;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    const seen = new Set();

    for (let i = 0; i < 50; i++) {
      const shot = chooseAIShot(state, shotGrid, AI_CONFIG);
      const key = `${shot.r},${shot.c}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      state.triedCells.add(key);
    }
  });

  test('first shot is on checkerboard cell', () => {
    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 0;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    const shot = chooseAIShot(state, shotGrid, AI_CONFIG);
    expect((shot.r + shot.c) % 2).toBe(0);
  });
});

// ═══════════════════════════════════════════
//  chooseAIShot — Target mode
// ═══════════════════════════════════════════

describe('chooseAIShot — target mode', () => {
  test('fires adjacent to hit cell', () => {
    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 0;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));

    // Simulate a hit at (5,5)
    state.triedCells.add('5,5');
    updateAIState(state, { r: 5, c: 5, weapon: 'missile' }, [{ r: 5, c: 5, result: 'hit' }], [], AI_CONFIG);

    expect(state.mode).toBe('target');

    const shot = chooseAIShot(state, shotGrid, AI_CONFIG);
    const dist = Math.abs(shot.r - 5) + Math.abs(shot.c - 5);
    expect(dist).toBe(1); // must be adjacent
  });

  test('detects horizontal orientation and extends the line', () => {
    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 0;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));

    // Simulate two hits in a row: (5,3) and (5,4)
    state.triedCells.add('5,3');
    updateAIState(state, { r: 5, c: 3, weapon: 'missile' }, [{ r: 5, c: 3, result: 'hit' }], [], AI_CONFIG);
    state.triedCells.add('5,4');
    updateAIState(state, { r: 5, c: 4, weapon: 'missile' }, [{ r: 5, c: 4, result: 'hit' }], [], AI_CONFIG);

    const shot = chooseAIShot(state, shotGrid, AI_CONFIG);
    // Should extend left (5,2) or right (5,5)
    expect(shot.r).toBe(5);
    expect([2, 5]).toContain(shot.c);
  });

  test('detects vertical orientation and extends the line', () => {
    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 0;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));

    // Simulate two hits in a column: (3,5) and (4,5)
    state.triedCells.add('3,5');
    updateAIState(state, { r: 3, c: 5, weapon: 'missile' }, [{ r: 3, c: 5, result: 'hit' }], [], AI_CONFIG);
    state.triedCells.add('4,5');
    updateAIState(state, { r: 4, c: 5, weapon: 'missile' }, [{ r: 4, c: 5, result: 'hit' }], [], AI_CONFIG);

    const shot = chooseAIShot(state, shotGrid, AI_CONFIG);
    // Should extend up (2,5) or down (5,5)
    expect(shot.c).toBe(5);
    expect([2, 5]).toContain(shot.r);
  });

  test('returns to hunt mode after sinking a ship', () => {
    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 0;

    // Hit and sink a 2-cell ship
    state.triedCells.add('5,5');
    updateAIState(state, { r: 5, c: 5, weapon: 'missile' }, [{ r: 5, c: 5, result: 'hit' }], [], AI_CONFIG);
    expect(state.mode).toBe('target');

    state.triedCells.add('5,6');
    const sunkShip = { name: 'Destroyer', cells: [{ r: 5, c: 5 }, { r: 5, c: 6 }] };
    updateAIState(state, { r: 5, c: 6, weapon: 'missile' }, [{ r: 5, c: 6, result: 'hit' }], [sunkShip], AI_CONFIG);

    expect(state.mode).toBe('hunt');
    expect(state.hitStack).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════
//  Nuke pacing
// ═══════════════════════════════════════════

describe('AI nuke pacing', () => {
  test('fires missiles before first nuke', () => {
    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 2;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    const minMissiles = state.missilesUntilNuke;

    const weapons = [];
    for (let i = 0; i < minMissiles + 5; i++) {
      const shot = chooseAIShot(state, shotGrid, AI_CONFIG);
      weapons.push(shot.weapon);
      state.triedCells.add(`${shot.r},${shot.c}`);
      if (shot.weapon === 'nuke') {
        state.nukesRemaining--;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const nr = shot.r + dr, nc = shot.c + dc;
            if (nr >= 0 && nr < 10 && nc >= 0 && nc < 10)
              state.triedCells.add(`${nr},${nc}`);
          }
      }
      updateAIState(state, shot, [{ r: shot.r, c: shot.c, result: 'miss' }], [], AI_CONFIG);
    }

    const firstNukeIdx = weapons.indexOf('nuke');
    expect(firstNukeIdx).toBeGreaterThanOrEqual(minMissiles);
  });

  test('never fires two nukes in a row', () => {
    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 2;
    state.missilesUntilNuke = 0; // allow nuke immediately
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));

    const weapons = [];
    for (let i = 0; i < 20; i++) {
      const shot = chooseAIShot(state, shotGrid, AI_CONFIG);
      weapons.push(shot.weapon);
      state.triedCells.add(`${shot.r},${shot.c}`);
      if (shot.weapon === 'nuke') {
        state.nukesRemaining--;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const nr = shot.r + dr, nc = shot.c + dc;
            if (nr >= 0 && nr < 10 && nc >= 0 && nc < 10)
              state.triedCells.add(`${nr},${nc}`);
          }
      }
      updateAIState(state, shot, [{ r: shot.r, c: shot.c, result: 'miss' }], [], AI_CONFIG);
    }

    for (let i = 1; i < weapons.length; i++) {
      if (weapons[i] === 'nuke') {
        expect(weapons[i - 1]).toBe('missile');
      }
    }
  });

  test('nuke hit switches to target mode, follows up with missiles', () => {
    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 2;
    state.missilesUntilNuke = 0;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));

    // Force a nuke shot
    const shot = chooseAIShot(state, shotGrid, AI_CONFIG);
    expect(shot.weapon).toBe('nuke');

    // Simulate nuke hitting one cell
    const results = [
      { r: 5, c: 5, result: 'hit' },
      { r: 5, c: 4, result: 'miss' },
      { r: 5, c: 6, result: 'miss' },
    ];
    for (const res of results) state.triedCells.add(`${res.r},${res.c}`);
    state.nukesRemaining--;
    updateAIState(state, shot, results, [], AI_CONFIG);

    expect(state.mode).toBe('target');

    // Next shot should be a missile targeting around the hit
    const next = chooseAIShot(state, shotGrid, AI_CONFIG);
    expect(next.weapon).toBe('missile');
  });
});

// ═══════════════════════════════════════════
//  AI full game simulation
// ═══════════════════════════════════════════

describe('AI full game simulation', () => {
  test('AI can sink all ships within 100 shots', () => {
    const game = createGame('ai-test', 2);
    const ships = generateAIPlacement(AI_CONFIG);
    placeShipsOnPlayer(game.players[0], ships);
    placeShipsOnPlayer(game.players[1], generateAIPlacement(AI_CONFIG));
    game.phase = 'battle';
    game.turn = 1; // AI's turn

    const state = createAIState(AI_CONFIG);
    state.nukesRemaining = 2;

    let shotCount = 0;
    while (game.phase !== 'finished' && shotCount < 100) {
      const shot = chooseAIShot(state, game.players[1].shotGrid, AI_CONFIG);
      state.triedCells.add(`${shot.r},${shot.c}`);

      const result = processShot(game, 1, shot.r, shot.c, shot.weapon);
      if (result.error) continue;

      if (shot.weapon === 'nuke') {
        state.nukesRemaining = game.players[1].nukes;
        for (const res of result.results) state.triedCells.add(`${res.r},${res.c}`);
      }

      const sunkNames = result.sunkShips.map(s => s.name);
      const newlySunk = game.players[0].ships.filter(s => s.sunk && sunkNames.includes(s.name));
      updateAIState(state, shot, result.results, newlySunk, AI_CONFIG);

      game.turn = 1; // keep AI firing
      shotCount++;
    }

    expect(game.phase).toBe('finished');
    expect(game.winner).toBe(1);
    // Smart AI should finish well under 100 shots
    expect(shotCount).toBeLessThan(100);
  });
});

// ═══════════════════════════════════════════
//  Hard mode — createAIState
// ═══════════════════════════════════════════

describe('Hard mode — createAIState', () => {
  test('sets difficulty to hard', () => {
    const state = createAIState(HARD_CONFIG);
    expect(state.difficulty).toBe('hard');
  });

  test('missilesUntilNuke starts at 0 (nuke available immediately)', () => {
    const state = createAIState(HARD_CONFIG);
    expect(state.missilesUntilNuke).toBe(0);
  });

  test('initializes sunkShipNames as empty array', () => {
    const state = createAIState(HARD_CONFIG);
    expect(state.sunkShipNames).toEqual([]);
  });
});

// ═══════════════════════════════════════════
//  Hard mode — generateAIPlacement
// ═══════════════════════════════════════════

describe('Hard mode — generateAIPlacement', () => {
  test('returns valid placement with 5 ships', () => {
    const ships = generateAIPlacement(HARD_CONFIG);
    expect(ships).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(ships[i].cells).toHaveLength(CONFIG.SHIPS[i].size);
    }
  });

  test('no overlapping cells', () => {
    const ships = generateAIPlacement(HARD_CONFIG);
    const cells = new Set();
    for (const ship of ships) {
      for (const { r, c } of ship.cells) {
        const key = `${r},${c}`;
        expect(cells.has(key)).toBe(false);
        cells.add(key);
      }
    }
  });

  test('ships have 1-cell buffer between them', () => {
    // Run multiple times to increase confidence
    for (let trial = 0; trial < 10; trial++) {
      const ships = generateAIPlacement(HARD_CONFIG);
      // For each pair of ships, no cell should be adjacent
      for (let i = 0; i < ships.length; i++) {
        const cellsA = new Set(ships[i].cells.map(c => `${c.r},${c.c}`));
        for (let j = i + 1; j < ships.length; j++) {
          for (const { r, c } of ships[j].cells) {
            // Check that no cell of ship j is adjacent to any cell of ship i
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                expect(cellsA.has(`${r + dr},${c + dc}`)).toBe(false);
              }
            }
          }
        }
      }
    }
  });

  test('hard placement has more edge cells than average random', () => {
    let hardEdge = 0;
    let normalEdge = 0;
    const trials = 20;

    for (let i = 0; i < trials; i++) {
      const hardShips = generateAIPlacement(HARD_CONFIG);
      const normalShips = generateAIPlacement(AI_CONFIG);

      for (const ship of hardShips) {
        for (const { r, c } of ship.cells) {
          if (r === 0 || r === 9 || c === 0 || c === 9) hardEdge++;
        }
      }
      for (const ship of normalShips) {
        for (const { r, c } of ship.cells) {
          if (r === 0 || r === 9 || c === 0 || c === 9) normalEdge++;
        }
      }
    }

    // Hard placement should average more edge cells
    expect(hardEdge / trials).toBeGreaterThan(normalEdge / trials);
  });
});

// ═══════════════════════════════════════════
//  Hard mode — computeProbabilityMap
// ═══════════════════════════════════════════

describe('Hard mode — computeProbabilityMap', () => {
  test('returns scores for untried cells', () => {
    const state = createAIState(HARD_CONFIG);
    const scores = computeProbabilityMap(state, HARD_CONFIG);
    expect(scores.size).toBeGreaterThan(0);
  });

  test('center cells score higher than corners on empty board', () => {
    const state = createAIState(HARD_CONFIG);
    const scores = computeProbabilityMap(state, HARD_CONFIG);
    const centerScore = scores.get('5,5') || 0;
    const cornerScore = scores.get('0,0') || 0;
    expect(centerScore).toBeGreaterThan(cornerScore);
  });

  test('scores decrease as cells are tried', () => {
    const state = createAIState(HARD_CONFIG);
    const scoresBefore = computeProbabilityMap(state, HARD_CONFIG);
    const totalBefore = Array.from(scoresBefore.values()).reduce((a, b) => a + b, 0);

    // Mark some cells as tried
    for (let c = 0; c < 5; c++) {
      state.triedCells.add(`0,${c}`);
    }
    const scoresAfter = computeProbabilityMap(state, HARD_CONFIG);
    const totalAfter = Array.from(scoresAfter.values()).reduce((a, b) => a + b, 0);

    expect(totalAfter).toBeLessThan(totalBefore);
  });

  test('removes sunk ship sizes from consideration', () => {
    const state = createAIState(HARD_CONFIG);
    const scoresBefore = computeProbabilityMap(state, HARD_CONFIG);
    const totalBefore = Array.from(scoresBefore.values()).reduce((a, b) => a + b, 0);

    // Mark carrier as sunk
    state.sunkShipNames.push('Carrier');
    const scoresAfter = computeProbabilityMap(state, HARD_CONFIG);
    const totalAfter = Array.from(scoresAfter.values()).reduce((a, b) => a + b, 0);

    expect(totalAfter).toBeLessThan(totalBefore);
  });
});

// ═══════════════════════════════════════════
//  Hard mode — chooseAIShot
// ═══════════════════════════════════════════

describe('Hard mode — chooseAIShot', () => {
  test('hunt shot returns valid coordinates', () => {
    const state = createAIState(HARD_CONFIG);
    state.nukesRemaining = 0;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    const shot = chooseAIShot(state, shotGrid, HARD_CONFIG);

    expect(shot.r).toBeGreaterThanOrEqual(0);
    expect(shot.r).toBeLessThan(10);
    expect(shot.c).toBeGreaterThanOrEqual(0);
    expect(shot.c).toBeLessThan(10);
    expect(shot.weapon).toBe('missile');
  });

  test('never picks the same cell twice in hard hunt', () => {
    const state = createAIState(HARD_CONFIG);
    state.nukesRemaining = 0;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    const seen = new Set();

    for (let i = 0; i < 50; i++) {
      const shot = chooseAIShot(state, shotGrid, HARD_CONFIG);
      const key = `${shot.r},${shot.c}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      state.triedCells.add(key);
    }
  });

  test('hard mode target shot fires adjacent to hit', () => {
    const state = createAIState(HARD_CONFIG);
    state.nukesRemaining = 0;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));

    state.triedCells.add('5,5');
    updateAIState(state, { r: 5, c: 5, weapon: 'missile' }, [{ r: 5, c: 5, result: 'hit' }], [], HARD_CONFIG);
    expect(state.mode).toBe('target');

    const shot = chooseAIShot(state, shotGrid, HARD_CONFIG);
    const dist = Math.abs(shot.r - 5) + Math.abs(shot.c - 5);
    expect(dist).toBe(1);
  });

  test('hard mode can fire nuke on first shot', () => {
    const state = createAIState(HARD_CONFIG);
    state.nukesRemaining = 2;
    const shotGrid = Array.from({ length: 10 }, () => Array(10).fill(null));
    const shot = chooseAIShot(state, shotGrid, HARD_CONFIG);
    // On a fresh board, density is high enough for a nuke
    expect(shot.weapon).toBe('nuke');
  });
});

// ═══════════════════════════════════════════
//  Hard mode — sunkShipNames tracking
// ═══════════════════════════════════════════

describe('Hard mode — sunkShipNames tracking', () => {
  test('tracks sunk ship names in both difficulties', () => {
    for (const cfg of [AI_CONFIG, HARD_CONFIG]) {
      const state = createAIState(cfg);
      state.triedCells.add('5,5');
      state.triedCells.add('5,6');
      updateAIState(state, { r: 5, c: 5, weapon: 'missile' }, [{ r: 5, c: 5, result: 'hit' }], [], cfg);
      const sunkShip = { name: 'Destroyer', cells: [{ r: 5, c: 5 }, { r: 5, c: 6 }] };
      updateAIState(state, { r: 5, c: 6, weapon: 'missile' }, [{ r: 5, c: 6, result: 'hit' }], [sunkShip], cfg);
      expect(state.sunkShipNames).toContain('Destroyer');
    }
  });
});

// ═══════════════════════════════════════════
//  Hard mode — full game simulation
// ═══════════════════════════════════════════

describe('Hard mode full game simulation', () => {
  test('Hard AI sinks all ships within 100 shots', () => {
    const game = createGame('ai-hard-test', 2);
    const ships = generateAIPlacement(AI_CONFIG);
    placeShipsOnPlayer(game.players[0], ships);
    placeShipsOnPlayer(game.players[1], generateAIPlacement(HARD_CONFIG));
    game.phase = 'battle';
    game.turn = 1;

    const state = createAIState(HARD_CONFIG);
    state.nukesRemaining = 2;

    let shotCount = 0;
    while (game.phase !== 'finished' && shotCount < 100) {
      const shot = chooseAIShot(state, game.players[1].shotGrid, HARD_CONFIG);
      state.triedCells.add(`${shot.r},${shot.c}`);

      const result = processShot(game, 1, shot.r, shot.c, shot.weapon);
      if (result.error) continue;

      if (shot.weapon === 'nuke') {
        state.nukesRemaining = game.players[1].nukes;
        for (const res of result.results) state.triedCells.add(`${res.r},${res.c}`);
      }

      const sunkNames = result.sunkShips.map(s => s.name);
      const newlySunk = game.players[0].ships.filter(s => s.sunk && sunkNames.includes(s.name));
      updateAIState(state, shot, result.results, newlySunk, HARD_CONFIG);

      game.turn = 1;
      shotCount++;
    }

    expect(game.phase).toBe('finished');
    expect(game.winner).toBe(1);
    expect(shotCount).toBeLessThan(100);
  });

  test('Hard AI averages fewer shots than Normal AI', () => {
    const trials = 10;
    let hardTotal = 0;
    let normalTotal = 0;

    for (let t = 0; t < trials; t++) {
      // Same ship layout for both
      const targetShips = generateAIPlacement(AI_CONFIG);

      for (const mode of ['normal', 'hard']) {
        const cfg = mode === 'hard' ? HARD_CONFIG : AI_CONFIG;
        const game = createGame(`perf-${mode}-${t}`, 2);
        placeShipsOnPlayer(game.players[0], targetShips.map(s => ({ name: s.name, cells: s.cells.map(c => ({ ...c })) })));
        placeShipsOnPlayer(game.players[1], generateAIPlacement(cfg));
        game.phase = 'battle';
        game.turn = 1;

        const state = createAIState(cfg);
        state.nukesRemaining = 2;

        let shots = 0;
        while (game.phase !== 'finished' && shots < 100) {
          const shot = chooseAIShot(state, game.players[1].shotGrid, cfg);
          state.triedCells.add(`${shot.r},${shot.c}`);

          const result = processShot(game, 1, shot.r, shot.c, shot.weapon);
          if (result.error) continue;

          if (shot.weapon === 'nuke') {
            state.nukesRemaining = game.players[1].nukes;
            for (const res of result.results) state.triedCells.add(`${res.r},${res.c}`);
          }

          const sunkNames = result.sunkShips.map(s => s.name);
          const newlySunk = game.players[0].ships.filter(s => s.sunk && sunkNames.includes(s.name));
          updateAIState(state, shot, result.results, newlySunk, cfg);

          game.turn = 1;
          shots++;
        }

        if (mode === 'hard') hardTotal += shots;
        else normalTotal += shots;
      }
    }

    // Hard AI should use fewer shots on average
    expect(hardTotal / trials).toBeLessThan(normalTotal / trials);
  });
});
