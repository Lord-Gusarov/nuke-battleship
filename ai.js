'use strict';

// ── AI ship placement ──

function generateAIPlacement(config) {
  if (config.difficulty === 'hard') {
    return generateHardPlacement(config);
  }
  return generateNormalPlacement(config);
}

function generateNormalPlacement(config) {
  const gridSize = config.GRID_SIZE;
  const occupied = new Set();

  const ships = [];
  for (const shipDef of config.SHIPS) {
    let placed = false;
    for (let attempt = 0; attempt < 1000 && !placed; attempt++) {
      const orient = Math.random() > 0.5 ? 'h' : 'v';
      const r = Math.floor(Math.random() * gridSize);
      const c = Math.floor(Math.random() * gridSize);

      const cells = [];
      let valid = true;
      for (let i = 0; i < shipDef.size; i++) {
        const cr = orient === 'v' ? r + i : r;
        const cc = orient === 'h' ? c + i : c;
        if (cr < 0 || cr >= gridSize || cc < 0 || cc >= gridSize) { valid = false; break; }
        const key = `${cr},${cc}`;
        if (occupied.has(key)) { valid = false; break; }
        cells.push({ r: cr, c: cc });
      }

      if (valid) {
        for (const { r: cr, c: cc } of cells) occupied.add(`${cr},${cc}`);
        ships.push({ name: shipDef.name, cells });
        placed = true;
      }
    }
    if (!placed) {
      return generateNormalPlacement(config);
    }
  }
  return ships;
}

function generateHardPlacement(config) {
  const gridSize = config.GRID_SIZE;
  let bestPlacement = null;
  let bestEdgeScore = -1;

  for (let candidate = 0; candidate < 10; candidate++) {
    const occupied = new Set();
    const buffer = new Set();   // 1-cell gap around placed ships
    const ships = [];
    let success = true;

    for (const shipDef of config.SHIPS) {
      let placed = false;
      for (let attempt = 0; attempt < 1000 && !placed; attempt++) {
        const orient = Math.random() > 0.5 ? 'h' : 'v';
        const r = Math.floor(Math.random() * gridSize);
        const c = Math.floor(Math.random() * gridSize);

        const cells = [];
        let valid = true;
        for (let i = 0; i < shipDef.size; i++) {
          const cr = orient === 'v' ? r + i : r;
          const cc = orient === 'h' ? c + i : c;
          if (cr < 0 || cr >= gridSize || cc < 0 || cc >= gridSize) { valid = false; break; }
          const key = `${cr},${cc}`;
          if (occupied.has(key) || buffer.has(key)) { valid = false; break; }
          cells.push({ r: cr, c: cc });
        }

        if (valid) {
          for (const { r: cr, c: cc } of cells) {
            occupied.add(`${cr},${cc}`);
            // Add 1-cell buffer around each ship cell
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const br = cr + dr;
                const bc = cc + dc;
                if (br >= 0 && br < gridSize && bc >= 0 && bc < gridSize) {
                  const bkey = `${br},${bc}`;
                  if (!occupied.has(bkey)) buffer.add(bkey);
                }
              }
            }
          }
          ships.push({ name: shipDef.name, cells });
          placed = true;
        }
      }
      if (!placed) { success = false; break; }
    }

    if (!success) continue;

    // Score by how many cells are on the grid border
    let edgeScore = 0;
    for (const ship of ships) {
      for (const { r, c } of ship.cells) {
        if (r === 0 || r === gridSize - 1 || c === 0 || c === gridSize - 1) edgeScore++;
      }
    }

    if (edgeScore > bestEdgeScore) {
      bestEdgeScore = edgeScore;
      bestPlacement = ships;
    }
  }

  // Fallback to normal placement if all 10 candidates failed (extremely unlikely)
  return bestPlacement || generateNormalPlacement(config);
}

// ── AI state ──

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createAIState(config) {
  const gridSize = config.GRID_SIZE;
  const difficulty = config.difficulty || 'normal';

  // Checkerboard-first ordering: smallest ship is size 2, so every ship
  // occupies at least one cell where (r+c) % 2 === 0
  const primary = [];
  const secondary = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if ((r + c) % 2 === 0) primary.push({ r, c });
      else secondary.push({ r, c });
    }
  }
  shuffle(primary);
  shuffle(secondary);

  return {
    difficulty,
    mode: 'hunt',
    huntCells: [...primary, ...secondary],
    targetQueue: [],
    hitStack: [],       // unsunk hit cells — used for orientation detection
    triedCells: new Set(),
    sunkShipNames: [],  // track sunk ships for probability map
    missilesUntilNuke: difficulty === 'hard' ? 0 : 2 + Math.floor(Math.random() * 4),
    lastWasNuke: false,
  };
}

// ── Probability density map (used by hard mode) ──

function computeProbabilityMap(aiState, config) {
  const gridSize = config.GRID_SIZE;
  const scores = new Map();

  // Determine remaining ship sizes
  const remainingShips = config.SHIPS.filter(s => !aiState.sunkShipNames.includes(s.name));

  for (const ship of remainingShips) {
    const size = ship.size;
    // Try horizontal placements
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c <= gridSize - size; c++) {
        let valid = true;
        const cells = [];
        for (let i = 0; i < size; i++) {
          const key = `${r},${c + i}`;
          // Blocked if it's a known miss (in triedCells but NOT in hitStack)
          if (aiState.triedCells.has(key) && !aiState.hitStack.some(h => h.r === r && h.c === c + i)) {
            valid = false;
            break;
          }
          cells.push(key);
        }
        if (valid) {
          for (const key of cells) {
            scores.set(key, (scores.get(key) || 0) + 1);
          }
        }
      }
    }
    // Try vertical placements
    for (let r = 0; r <= gridSize - size; r++) {
      for (let c = 0; c < gridSize; c++) {
        let valid = true;
        const cells = [];
        for (let i = 0; i < size; i++) {
          const key = `${r + i},${c}`;
          if (aiState.triedCells.has(key) && !aiState.hitStack.some(h => h.r === r + i && h.c === c)) {
            valid = false;
            break;
          }
          cells.push(key);
        }
        if (valid) {
          for (const key of cells) {
            scores.set(key, (scores.get(key) || 0) + 1);
          }
        }
      }
    }
  }

  return scores;
}

// ── Shot selection ──

function chooseAIShot(aiState, shotGrid, config) {
  const gridSize = config.GRID_SIZE;
  const isHard = aiState.difficulty === 'hard';

  // Nuke strategy
  if (aiState.nukesRemaining > 0 && aiState.mode === 'hunt') {
    if (isHard) {
      // Hard: no warm-up delay, no back-to-back restriction, density-targeted
      const nukeTarget = pickHardNukeTarget(aiState, config);
      if (nukeTarget) {
        aiState.lastWasNuke = true;
        return { r: nukeTarget.r, c: nukeTarget.c, weapon: 'nuke' };
      }
    } else if (aiState.missilesUntilNuke <= 0 && !aiState.lastWasNuke) {
      // Normal: original nuke logic
      const nukeTarget = pickNukeTarget(aiState, gridSize);
      if (nukeTarget) {
        aiState.lastWasNuke = true;
        aiState.missilesUntilNuke = 1;
        return { r: nukeTarget.r, c: nukeTarget.c, weapon: 'nuke' };
      }
    }
  }

  if (aiState.mode === 'target') {
    if (isHard) {
      // Hard: score target candidates by probability
      return chooseHardTargetShot(aiState, config);
    }
    // Normal: pop untried cells from target queue
    while (aiState.targetQueue.length > 0) {
      const cell = aiState.targetQueue.shift();
      const key = `${cell.r},${cell.c}`;
      if (!aiState.triedCells.has(key)) {
        return { r: cell.r, c: cell.c, weapon: 'missile' };
      }
    }
    // Queue exhausted — fall back to hunt
    aiState.mode = 'hunt';
  }

  // Hunt mode
  if (isHard) {
    return chooseHardHuntShot(aiState, config);
  }

  // Normal hunt: pop next untried cell
  while (aiState.huntCells.length > 0) {
    const cell = aiState.huntCells.shift();
    const key = `${cell.r},${cell.c}`;
    if (!aiState.triedCells.has(key)) {
      return { r: cell.r, c: cell.c, weapon: 'missile' };
    }
  }

  // Fallback: pick any untried cell
  return pickFallbackCell(aiState, gridSize);
}

function chooseHardHuntShot(aiState, config) {
  const gridSize = config.GRID_SIZE;
  const scores = computeProbabilityMap(aiState, config);

  let bestScore = -1;
  const bestCells = [];
  for (const [key, score] of scores) {
    if (aiState.triedCells.has(key)) continue;
    if (score > bestScore) {
      bestScore = score;
      bestCells.length = 0;
      bestCells.push(key);
    } else if (score === bestScore) {
      bestCells.push(key);
    }
  }

  if (bestCells.length > 0) {
    const pick = bestCells[Math.floor(Math.random() * bestCells.length)];
    const [r, c] = pick.split(',').map(Number);
    return { r, c, weapon: 'missile' };
  }

  return pickFallbackCell(aiState, gridSize);
}

function chooseHardTargetShot(aiState, config) {
  const gridSize = config.GRID_SIZE;
  const hits = aiState.hitStack;

  // Build candidate cells (same logic as normal but scored by probability)
  const candidates = [];
  if (hits.length === 1) {
    candidates.push(...adjacents(hits[0].r, hits[0].c, gridSize));
  } else {
    const allSameRow = hits.every(h => h.r === hits[0].r);
    const allSameCol = hits.every(h => h.c === hits[0].c);

    if (allSameRow) {
      const row = hits[0].r;
      const cols = hits.map(h => h.c).sort((a, b) => a - b);
      if (cols[0] - 1 >= 0) candidates.push({ r: row, c: cols[0] - 1 });
      if (cols[cols.length - 1] + 1 < gridSize) candidates.push({ r: row, c: cols[cols.length - 1] + 1 });
    } else if (allSameCol) {
      const col = hits[0].c;
      const rows = hits.map(h => h.r).sort((a, b) => a - b);
      if (rows[0] - 1 >= 0) candidates.push({ r: rows[0] - 1, c: col });
      if (rows[rows.length - 1] + 1 < gridSize) candidates.push({ r: rows[rows.length - 1] + 1, c: col });
    } else {
      const seen = new Set();
      for (const hit of hits) {
        for (const adj of adjacents(hit.r, hit.c, gridSize)) {
          const key = `${adj.r},${adj.c}`;
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push(adj);
          }
        }
      }
    }
  }

  // Filter to untried and score by probability
  const scores = computeProbabilityMap(aiState, config);
  let bestScore = -1;
  let bestCell = null;
  const tied = [];

  for (const cell of candidates) {
    const key = `${cell.r},${cell.c}`;
    if (aiState.triedCells.has(key)) continue;
    const score = scores.get(key) || 0;
    if (score > bestScore) {
      bestScore = score;
      bestCell = cell;
      tied.length = 0;
      tied.push(cell);
    } else if (score === bestScore) {
      tied.push(cell);
    }
  }

  if (tied.length > 0) {
    const pick = tied[Math.floor(Math.random() * tied.length)];
    return { r: pick.r, c: pick.c, weapon: 'missile' };
  }

  // All target candidates tried — fall back to hunt
  aiState.mode = 'hunt';
  return chooseHardHuntShot(aiState, config);
}

function pickFallbackCell(aiState, gridSize) {
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (!aiState.triedCells.has(`${r},${c}`)) {
        return { r, c, weapon: 'missile' };
      }
    }
  }
  return { r: 0, c: 0, weapon: 'missile' };
}

function pickNukeTarget(aiState, gridSize) {
  let best = null;
  let bestCount = 0;

  // Sample random candidate cells to find a good nuke target
  const candidates = [];
  for (let r = 1; r < gridSize - 1; r++) {
    for (let c = 1; c < gridSize - 1; c++) {
      candidates.push({ r, c });
    }
  }
  shuffle(candidates);
  // Check up to 20 candidates
  for (const { r, c } of candidates.slice(0, 20)) {
    let untried = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
          if (!aiState.triedCells.has(`${nr},${nc}`)) untried++;
        }
      }
    }
    if (untried > bestCount) {
      bestCount = untried;
      best = { r, c };
    }
  }

  return bestCount >= 6 ? best : null; // Only nuke if at least 6 untried cells in blast
}

function pickHardNukeTarget(aiState, config) {
  const gridSize = config.GRID_SIZE;
  const scores = computeProbabilityMap(aiState, config);

  let best = null;
  let bestDensity = 0;

  // Evaluate all valid 3x3 centers (rows 1..8, cols 1..8)
  for (let r = 1; r < gridSize - 1; r++) {
    for (let c = 1; c < gridSize - 1; c++) {
      let density = 0;
      let untried = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const key = `${r + dr},${c + dc}`;
          if (!aiState.triedCells.has(key)) {
            density += scores.get(key) || 0;
            untried++;
          }
        }
      }
      // Need at least 5 untried cells to be worth a nuke
      if (untried >= 5 && density > bestDensity) {
        bestDensity = density;
        best = { r, c };
      }
    }
  }

  // Only fire if density is meaningful (threshold: average > 2 per untried cell)
  return bestDensity >= 10 ? best : null;
}

// ── Post-shot state update ──

function adjacents(r, c, gridSize) {
  const adj = [];
  if (r > 0) adj.push({ r: r - 1, c });
  if (r < gridSize - 1) adj.push({ r: r + 1, c });
  if (c > 0) adj.push({ r, c: c - 1 });
  if (c < gridSize - 1) adj.push({ r, c: c + 1 });
  return adj;
}

function updateAIState(aiState, shot, results, sunkShips, config) {
  const gridSize = config.GRID_SIZE;

  // Track missile/nuke pacing
  if (shot.weapon === 'missile') {
    aiState.missilesUntilNuke--;
    aiState.lastWasNuke = false;
  }

  // Mark all result cells as tried
  for (const res of results) {
    aiState.triedCells.add(`${res.r},${res.c}`);
  }

  // Collect hits from this shot
  const newHits = results.filter(res => res.result === 'hit' || res.result === 'nuke_hit');

  for (const hit of newHits) {
    aiState.hitStack.push({ r: hit.r, c: hit.c });
  }

  // Remove sunk ship cells from hitStack, track sunk ship names
  if (sunkShips && sunkShips.length > 0) {
    const sunkCells = new Set();
    for (const ship of sunkShips) {
      for (const cell of ship.cells) {
        sunkCells.add(`${cell.r},${cell.c}`);
      }
      aiState.sunkShipNames.push(ship.name);
    }
    aiState.hitStack = aiState.hitStack.filter(h => !sunkCells.has(`${h.r},${h.c}`));
  }

  // Decide mode
  if (aiState.hitStack.length === 0) {
    aiState.mode = 'hunt';
    aiState.targetQueue = [];
    return;
  }

  // We have unsunk hits — enter/stay in target mode
  aiState.mode = 'target';
  if (aiState.difficulty !== 'hard') {
    rebuildTargetQueue(aiState, gridSize);
  }
}

function rebuildTargetQueue(aiState, gridSize) {
  const hits = aiState.hitStack;
  aiState.targetQueue = [];

  if (hits.length === 1) {
    // Single hit — try all 4 adjacents
    const adj = adjacents(hits[0].r, hits[0].c, gridSize);
    for (const cell of adj) {
      if (!aiState.triedCells.has(`${cell.r},${cell.c}`)) {
        aiState.targetQueue.push(cell);
      }
    }
    shuffle(aiState.targetQueue);
    return;
  }

  // Multiple hits — detect orientation
  const allSameRow = hits.every(h => h.r === hits[0].r);
  const allSameCol = hits.every(h => h.c === hits[0].c);

  if (allSameRow) {
    const row = hits[0].r;
    const cols = hits.map(h => h.c).sort((a, b) => a - b);
    const minC = cols[0];
    const maxC = cols[cols.length - 1];
    if (minC - 1 >= 0 && !aiState.triedCells.has(`${row},${minC - 1}`)) {
      aiState.targetQueue.push({ r: row, c: minC - 1 });
    }
    if (maxC + 1 < gridSize && !aiState.triedCells.has(`${row},${maxC + 1}`)) {
      aiState.targetQueue.push({ r: row, c: maxC + 1 });
    }
  } else if (allSameCol) {
    const col = hits[0].c;
    const rows = hits.map(h => h.r).sort((a, b) => a - b);
    const minR = rows[0];
    const maxR = rows[rows.length - 1];
    if (minR - 1 >= 0 && !aiState.triedCells.has(`${minR - 1},${col}`)) {
      aiState.targetQueue.push({ r: minR - 1, c: col });
    }
    if (maxR + 1 < gridSize && !aiState.triedCells.has(`${maxR + 1},${col}`)) {
      aiState.targetQueue.push({ r: maxR + 1, c: col });
    }
  } else {
    const seen = new Set();
    for (const hit of hits) {
      for (const adj of adjacents(hit.r, hit.c, gridSize)) {
        const key = `${adj.r},${adj.c}`;
        if (!aiState.triedCells.has(key) && !seen.has(key)) {
          seen.add(key);
          aiState.targetQueue.push(adj);
        }
      }
    }
    shuffle(aiState.targetQueue);
  }
}

module.exports = { generateAIPlacement, createAIState, chooseAIShot, updateAIState, computeProbabilityMap };
