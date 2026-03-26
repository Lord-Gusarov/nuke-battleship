(() => {
  // Derive base path from current URL so the app works behind any prefix
  const basePath = location.pathname.replace(/\/+$/, '');
  const socket = io({ path: `${basePath}/socket.io/` });

  // ── Client logging — sends to server /client-log endpoint ──

  let _logPlayerIdx = null;
  let _logRoomId = null;

  function clientLog(level, message, data) {
    const payload = {
      level,
      message,
      data,
      playerIdx: _logPlayerIdx,
      roomId: _logRoomId,
      userAgent: navigator.userAgent,
    };
    // Console mirror
    if (level === 'error') {
      console.error(`[GAME] ${message}`, data || '');
    } else {
      console.log(`[GAME] ${message}`, data || '');
    }
    // Fire-and-forget POST to server
    try {
      fetch(`${basePath}/client-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {}); // ignore network errors in the logger itself
    } catch (e) {}
  }

  // Catch unhandled errors and promise rejections
  window.addEventListener('error', (e) => {
    clientLog('error', `Uncaught error: ${e.message}`, {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error?.stack,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    clientLog('error', `Unhandled promise rejection: ${e.reason}`, {
      stack: e.reason?.stack,
    });
  });

  // ── Audio engine (Web Audio API — no files needed) ──
  // All audio is wrapped in try/catch for iOS Safari compatibility.
  // iOS requires a user gesture before AudioContext works, so we
  // lazily create it on first interaction and never let audio errors
  // break game logic.

  let audioCtx = null;

  function getAudioCtx() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        return null;
      }
    }
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch (e) {}
    return audioCtx;
  }

  // ── Socket connection logging ──

  socket.on('connect', () => {
    clientLog('info', 'Socket connected', { socketId: socket.id });
  });

  socket.on('disconnect', (reason) => {
    clientLog('error', 'Socket disconnected', { reason });
  });

  socket.on('reconnect', (attemptNumber) => {
    clientLog('info', 'Socket reconnected', { attemptNumber });
  });

  socket.on('connect_error', (err) => {
    clientLog('error', 'Socket connect error', { message: err.message });
  });

  // Unlock audio on first tap/click (required by iOS Safari)
  function unlockAudio() {
    const ctx = getAudioCtx();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    document.removeEventListener('touchstart', unlockAudio);
    document.removeEventListener('click', unlockAudio);
  }
  document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
  document.addEventListener('touchend', unlockAudio, { once: true, passive: true });
  document.addEventListener('click', unlockAudio, { once: true });

  function playHitSound() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const t = ctx.currentTime;

      // Layer 1: noise burst (explosion body)
      const bufLen = ctx.sampleRate * 0.5;
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.12));
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const nFilter = ctx.createBiquadFilter();
      nFilter.type = 'lowpass';
      nFilter.frequency.setValueAtTime(2000, t);
      nFilter.frequency.exponentialRampToValueAtTime(200, t + 0.4);
      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.4, t);
      nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      noise.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(ctx.destination);
      noise.start(t);

      // Layer 2: low thump (impact punch)
      const osc = ctx.createOscillator();
      const oGain = ctx.createGain();
      osc.connect(oGain);
      oGain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(40, t + 0.25);
      oGain.gain.setValueAtTime(0.5, t);
      oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.start(t);
      osc.stop(t + 0.3);

      // Layer 3: short mid crackle
      const osc2 = ctx.createOscillator();
      const o2Gain = ctx.createGain();
      osc2.connect(o2Gain);
      o2Gain.connect(ctx.destination);
      osc2.type = 'sawtooth';
      osc2.frequency.setValueAtTime(800, t);
      osc2.frequency.exponentialRampToValueAtTime(100, t + 0.15);
      o2Gain.gain.setValueAtTime(0.15, t);
      o2Gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc2.start(t);
      osc2.stop(t + 0.15);
    } catch (e) {}
  }

  function playMissSound() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const t = ctx.currentTime;

      // Layer 1: incoming whistle (missile fly-by)
      const whistle = ctx.createOscillator();
      const wGain = ctx.createGain();
      whistle.connect(wGain);
      wGain.connect(ctx.destination);
      whistle.type = 'sine';
      whistle.frequency.setValueAtTime(1200, t);
      whistle.frequency.exponentialRampToValueAtTime(300, t + 0.15);
      wGain.gain.setValueAtTime(0.08, t);
      wGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      whistle.start(t);
      whistle.stop(t + 0.15);

      // Layer 2: water splash (filtered noise burst, delayed slightly)
      const bufLen = ctx.sampleRate * 0.6;
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) {
        const env = Math.exp(-i / (ctx.sampleRate * 0.15));
        d[i] = (Math.random() * 2 - 1) * env;
      }
      const splash = ctx.createBufferSource();
      splash.buffer = buf;
      const sFilter = ctx.createBiquadFilter();
      sFilter.type = 'bandpass';
      sFilter.frequency.setValueAtTime(600, t + 0.1);
      sFilter.frequency.exponentialRampToValueAtTime(150, t + 0.6);
      sFilter.Q.setValueAtTime(1, t);
      const sGain = ctx.createGain();
      sGain.gain.setValueAtTime(0.001, t);
      sGain.gain.linearRampToValueAtTime(0.25, t + 0.12);
      sGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      splash.connect(sFilter);
      sFilter.connect(sGain);
      sGain.connect(ctx.destination);
      splash.start(t + 0.1);

      // Layer 3: low water thud
      const thud = ctx.createOscillator();
      const tGain = ctx.createGain();
      thud.connect(tGain);
      tGain.connect(ctx.destination);
      thud.type = 'sine';
      thud.frequency.setValueAtTime(80, t + 0.1);
      thud.frequency.exponentialRampToValueAtTime(30, t + 0.35);
      tGain.gain.setValueAtTime(0.001, t);
      tGain.gain.linearRampToValueAtTime(0.15, t + 0.12);
      tGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      thud.start(t + 0.1);
      thud.stop(t + 0.35);
    } catch (e) {}
  }

  function playSirenSound(duration) {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sawtooth';
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      const cycles = Math.floor(duration * 2);
      for (let i = 0; i < cycles; i++) {
        const t = ctx.currentTime + (i * duration) / cycles;
        osc.frequency.setValueAtTime(440, t);
        osc.frequency.linearRampToValueAtTime(880, t + duration / cycles / 2);
        osc.frequency.linearRampToValueAtTime(440, t + duration / cycles);
      }
      gain.gain.setValueAtTime(0.2, ctx.currentTime + duration - 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (e) {}
  }

  function playDoomCountdown() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(60, ctx.currentTime);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {}
  }

  function playExplosionSound() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const bufferSize = ctx.sampleRate * 1.5;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        const env = Math.exp(-i / (ctx.sampleRate * 0.4));
        data[i] = (Math.random() * 2 - 1) * env;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1000, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 1.5);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.5, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start();

      // Sub bass rumble
      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      osc.connect(oscGain);
      oscGain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(50, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(20, ctx.currentTime + 1.5);
      oscGain.gain.setValueAtTime(0.4, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
      osc.start();
      osc.stop(ctx.currentTime + 1.5);
    } catch (e) {}
  }

  function playVictorySound() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const t = ctx.currentTime;

      // Triumphant brass-like fanfare: ascending major chord arpeggiated
      const notes = [
        { freq: 261.6, start: 0,    dur: 0.25 }, // C4
        { freq: 329.6, start: 0.2,  dur: 0.25 }, // E4
        { freq: 392.0, start: 0.4,  dur: 0.25 }, // G4
        { freq: 523.3, start: 0.6,  dur: 0.6  }, // C5 (hold)
        { freq: 659.3, start: 0.9,  dur: 0.6  }, // E5 (hold)
        { freq: 784.0, start: 1.1,  dur: 0.8  }, // G5 (final)
      ];

      for (const n of notes) {
        // Main tone (square for brass feel)
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'square';
        osc.frequency.setValueAtTime(n.freq, t + n.start);
        gain.gain.setValueAtTime(0.001, t + n.start);
        gain.gain.linearRampToValueAtTime(0.12, t + n.start + 0.04);
        gain.gain.setValueAtTime(0.12, t + n.start + n.dur - 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, t + n.start + n.dur);
        osc.start(t + n.start);
        osc.stop(t + n.start + n.dur);

        // Octave shimmer (sine, quieter)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(n.freq * 2, t + n.start);
        gain2.gain.setValueAtTime(0.001, t + n.start);
        gain2.gain.linearRampToValueAtTime(0.04, t + n.start + 0.04);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + n.start + n.dur);
        osc2.start(t + n.start);
        osc2.stop(t + n.start + n.dur);
      }

      // Final chord: sustained C major triad
      const chord = [523.3, 659.3, 784.0];
      for (const freq of chord) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t + 1.5);
        gain.gain.setValueAtTime(0.001, t + 1.5);
        gain.gain.linearRampToValueAtTime(0.08, t + 1.6);
        gain.gain.setValueAtTime(0.08, t + 2.5);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 3.5);
        osc.start(t + 1.5);
        osc.stop(t + 3.5);
      }
    } catch (e) {}
  }

  function playDefeatSound() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const t = ctx.currentTime;

      // Slow descending minor notes — somber, defeated
      const notes = [
        { freq: 392.0, start: 0,   dur: 0.6 }, // G4
        { freq: 349.2, start: 0.5, dur: 0.6 }, // F4
        { freq: 311.1, start: 1.0, dur: 0.6 }, // Eb4
        { freq: 261.6, start: 1.5, dur: 1.2 }, // C4 (long hold, drop)
      ];

      for (const n of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.freq, t + n.start);
        // Last note bends down
        if (n.start === 1.5) {
          osc.frequency.exponentialRampToValueAtTime(200, t + n.start + n.dur);
        }
        gain.gain.setValueAtTime(0.001, t + n.start);
        gain.gain.linearRampToValueAtTime(0.12, t + n.start + 0.05);
        gain.gain.setValueAtTime(0.12, t + n.start + n.dur * 0.6);
        gain.gain.exponentialRampToValueAtTime(0.001, t + n.start + n.dur);
        osc.start(t + n.start);
        osc.stop(t + n.start + n.dur);

        // Detuned second voice for hollow/sad feel
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(n.freq * 0.995, t + n.start); // slightly flat
        if (n.start === 1.5) {
          osc2.frequency.exponentialRampToValueAtTime(199, t + n.start + n.dur);
        }
        gain2.gain.setValueAtTime(0.001, t + n.start);
        gain2.gain.linearRampToValueAtTime(0.06, t + n.start + 0.05);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + n.start + n.dur);
        osc2.start(t + n.start);
        osc2.stop(t + n.start + n.dur);
      }

      // Low rumble underneath — sinking ship ambience
      const bufLen = ctx.sampleRate * 3;
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 1.5));
      }
      const rumble = ctx.createBufferSource();
      rumble.buffer = buf;
      const rFilter = ctx.createBiquadFilter();
      rFilter.type = 'lowpass';
      rFilter.frequency.setValueAtTime(120, t);
      rFilter.frequency.exponentialRampToValueAtTime(40, t + 3);
      const rGain = ctx.createGain();
      rGain.gain.setValueAtTime(0.08, t);
      rGain.gain.exponentialRampToValueAtTime(0.001, t + 3);
      rumble.connect(rFilter);
      rFilter.connect(rGain);
      rGain.connect(ctx.destination);
      rumble.start(t);
    } catch (e) {}
  }

  function playSunkSound() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'square';
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.8);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
      osc.start();
      osc.stop(ctx.currentTime + 0.8);
    } catch (e) {}
  }

  // ── Visual effects ──

  function spawnParticles(cell, count, colors) {
    try {
      const rect = cell.getBoundingClientRect();
      for (let i = 0; i < count; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
        const dist = 20 + Math.random() * 30;
        const dx = Math.cos(angle) * dist;
        const dy = Math.sin(angle) * dist;
        p.style.cssText = `
          left: ${rect.left + rect.width / 2}px;
          top: ${rect.top + rect.height / 2}px;
          position: fixed;
          background: ${colors[Math.floor(Math.random() * colors.length)]};
          --dx: ${dx}px;
          --dy: ${dy}px;
        `;
        document.body.appendChild(p);
        setTimeout(() => p.remove(), 600);
      }
    } catch (e) {}
  }

  function spawnHitParticles(cell) {
    spawnParticles(cell, 10, ['#ff3a3a', '#ff6b35', '#ffb836', '#fff', '#ff3a3a']);
  }

  function spawnNukeParticles(cell) {
    spawnParticles(cell, 18, ['#ffb836', '#ff6b35', '#ff3a3a', '#fff', '#ffb836', '#ff3a3a']);
  }

  function addSplashRing(cell) {
    try {
      const ring = document.createElement('div');
      ring.className = 'splash-ring';
      cell.appendChild(ring);
      setTimeout(() => ring.remove(), 600);
    } catch (e) {}
  }

  function shake(heavy) {
    try {
      document.body.classList.remove('shake', 'shake-heavy');
      void document.body.offsetWidth;
      document.body.classList.add(heavy ? 'shake-heavy' : 'shake');
      setTimeout(() => document.body.classList.remove('shake', 'shake-heavy'), 800);
    } catch (e) {}
  }

  function nukeFlash() {
    try {
      const flash = document.getElementById('nuke-flash');
      flash.classList.add('active');
      setTimeout(() => flash.classList.remove('active'), 150);
    } catch (e) {}
  }

  // ── Nuke countdown sequence ──

  function showNukeCountdown(isAttacker) {
    return new Promise((resolve) => {
      try {
        const overlay = document.getElementById('nuke-countdown');
        const label = document.getElementById('countdown-label');
        const number = document.getElementById('countdown-number');
        const sub = document.getElementById('countdown-sub');

        label.textContent = isAttacker ? 'LAUNCHING NUCLEAR STRIKE' : 'NUCLEAR STRIKE INCOMING';
        sub.textContent = isAttacker ? 'WARHEAD ARMED' : 'SEEK SHELTER IMMEDIATELY';

        overlay.classList.add('active');

        playSirenSound(3);

        let count = 3;
        number.textContent = count;
        playDoomCountdown();

        const interval = setInterval(() => {
          count--;
          if (count > 0) {
            number.textContent = count;
            playDoomCountdown();
          } else {
            clearInterval(interval);
            overlay.classList.remove('active');
            resolve();
          }
        }, 1000);
      } catch (e) {
        resolve(); // Always resolve so game continues
      }
    });
  }

  // ── Toast system ──

  function toast(msg, type) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast-item';
    if (type) el.classList.add(type);
    el.textContent = msg;
    container.appendChild(el);

    setTimeout(() => {
      el.classList.add('removing');
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }

  // ── Battle log ──

  function addLogEntry(msg, type) {
    const container = document.getElementById('log-entries');
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    if (type) entry.classList.add(type);
    entry.textContent = msg;
    container.prepend(entry);

    while (container.children.length > 50) {
      container.lastChild.remove();
    }
  }

  // ── State ──

  let playerIdx = null;
  let config = null;
  let roomId = null;
  let phase = 'lobby';

  // Placement state
  let shipPlacements = [];
  let currentShipIdx = 0;
  let orientation = 'h';
  let placementGrid = [];

  // Battle state
  let selectedWeapon = 'missile';
  let myNukes = 0;
  let attackGrid = [];
  let defenseGrid = [];
  let myTurn = false;
  let sunkEnemyShips = [];
  let processingShot = false;

  // DOM references
  const $status = document.getElementById('status');
  const $roomInfo = document.getElementById('room-info');
  const $gameOver = document.getElementById('game-over');

  // ── Helpers ──

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function setStatus(msg, isActive) {
    $status.textContent = msg;
    $status.classList.toggle('active-turn', !!isActive);
  }

  function buildGrid(container, size, onClick) {
    container.innerHTML = '';
    const cells = [];
    for (let r = 0; r < size; r++) {
      cells[r] = [];
      for (let c = 0; c < size; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.r = r;
        cell.dataset.c = c;
        if (onClick) {
          cell.addEventListener('click', () => onClick(r, c));
        }
        container.appendChild(cell);
        cells[r][c] = cell;
      }
    }
    return cells;
  }

  // Apply ship silhouette CSS (bow/mid/stern + orientation)
  function applyShipVisuals(grid, cells, orient) {
    for (let i = 0; i < cells.length; i++) {
      const { r, c } = cells[i];
      const cell = grid[r][c];
      cell.classList.add('ship', 'ship-placed');
      cell.classList.remove('ship-preview', 'ship-preview-invalid');
      cell.dataset.orient = orient === 'h' ? 'h' : 'v';
      if (i === 0) {
        cell.dataset.part = 'bow';
      } else if (i === cells.length - 1) {
        cell.dataset.part = 'stern';
      } else {
        cell.dataset.part = 'mid';
      }
    }
  }

  function updateTurnIndicator() {
    const attackFrame = document.querySelector('.attack-frame');
    if (attackFrame) {
      attackFrame.classList.toggle('my-turn', myTurn && !processingShot);
    }
  }

  function updateClickableCells() {
    if (!attackGrid.length) return;
    for (let r = 0; r < config.GRID_SIZE; r++) {
      for (let c = 0; c < config.GRID_SIZE; c++) {
        const cell = attackGrid[r][c];
        const alreadyShot = cell.classList.contains('hit') || cell.classList.contains('miss');
        if (myTurn && !processingShot && !alreadyShot) {
          cell.classList.add('clickable');
        } else {
          cell.classList.remove('clickable');
        }
      }
    }
  }

  // ── Lobby ──

  const params = new URLSearchParams(window.location.search);
  const urlRoom = params.get('room');
  if (urlRoom) {
    document.getElementById('room-input').value = urlRoom;
    joinRoom(urlRoom);
  }

  document.getElementById('join-btn').addEventListener('click', () => {
    const code = document.getElementById('room-input').value.trim();
    if (code) joinRoom(code);
  });

  document.getElementById('room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const code = document.getElementById('room-input').value.trim();
      if (code) joinRoom(code);
    }
  });

  document.getElementById('create-btn').addEventListener('click', () => {
    const code = Math.random().toString(36).substring(2, 10);
    document.getElementById('room-input').value = code;
    const nukes = parseInt(document.getElementById('nuke-input').value) || 2;
    joinRoom(code, nukes);
  });

  function joinRoom(code, nukes) {
    if (nukes !== undefined) {
      socket.emit('join_room', { roomId: code, nukes });
    } else {
      socket.emit('join_room', code);
    }
  }

  // ── Socket events ──

  socket.on('joined', (data) => {
    playerIdx = data.playerIdx;
    config = data.config;
    roomId = data.roomId;
    myNukes = config.NUKES_PER_PLAYER;

    _logPlayerIdx = playerIdx;
    _logRoomId = roomId;
    clientLog('info', 'Joined room', { playerIdx, roomId });

    window.history.replaceState({}, '', `${basePath}/?room=${roomId}`);

    const shareUrl = `${location.origin}${basePath}/?room=${roomId}`;
    $roomInfo.innerHTML = `Room: <strong>${roomId}</strong> &mdash; <a href="${shareUrl}" onclick="navigator.clipboard.writeText('${shareUrl}');return false;">Copy invite link</a>`;

    setStatus(`Player ${playerIdx + 1} — waiting for opponent...`);
    showScreen('lobby');
  });

  socket.on('phase', (newPhase) => {
    clientLog('info', `Phase changed: ${newPhase}`);
    phase = newPhase;

    if (phase === 'placement') {
      startPlacement();
    } else if (phase === 'battle') {
      startBattle();
    }
  });

  socket.on('opponent_ready', () => {
    toast('Opponent has placed their ships');
  });

  socket.on('opponent_disconnected', () => {
    clientLog('info', 'Opponent disconnected');
    toast('Opponent disconnected', 'error');
    setStatus('Opponent disconnected — waiting for reconnect...');
  });

  socket.on('error_msg', (msg) => {
    clientLog('error', `Server error: ${msg}`);
    toast(msg, 'error');
  });

  // ── Placement ──

  function startPlacement() {
    showScreen('placement-screen');
    setStatus('Place your ships on the grid');
    shipPlacements = [];
    currentShipIdx = 0;
    orientation = 'h';

    const container = document.getElementById('placement-grid');
    placementGrid = buildGrid(container, config.GRID_SIZE, onPlacementClick);

    updatePlacementLabel();

    container.addEventListener('mouseover', onPlacementHover);
    container.addEventListener('mouseout', clearPreview);

    // Touch support: show ship preview where finger is
    container.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el && el.closest('.cell')) {
        onPlacementHover({ target: el });
      }
    }, { passive: true });
    container.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el && el.closest('.cell')) {
        onPlacementHover({ target: el });
      }
    }, { passive: true });
    container.addEventListener('touchend', clearPreview);
  }

  function updatePlacementLabel() {
    const label = document.getElementById('current-ship-label');
    const confirmBtn = document.getElementById('confirm-placement');

    if (currentShipIdx < config.SHIPS.length) {
      const ship = config.SHIPS[currentShipIdx];
      label.textContent = `Place: ${ship.name} (${ship.size})`;
      confirmBtn.style.display = 'none';
    } else {
      label.textContent = 'All ships placed!';
      confirmBtn.style.display = '';
    }
  }

  function getShipCells(r, c, size, orient) {
    const cells = [];
    for (let i = 0; i < size; i++) {
      cells.push({
        r: orient === 'v' ? r + i : r,
        c: orient === 'h' ? c + i : c,
      });
    }
    return cells;
  }

  function isValidPlacement(cells) {
    const occupied = new Set();
    for (const ship of shipPlacements) {
      for (const cell of ship.cells) {
        occupied.add(`${cell.r},${cell.c}`);
      }
    }

    for (const { r, c } of cells) {
      if (r < 0 || r >= config.GRID_SIZE || c < 0 || c >= config.GRID_SIZE) return false;
      if (occupied.has(`${r},${c}`)) return false;
    }
    return true;
  }

  function clearPreview() {
    for (let r = 0; r < config.GRID_SIZE; r++) {
      for (let c = 0; c < config.GRID_SIZE; c++) {
        placementGrid[r][c].classList.remove('ship-preview', 'ship-preview-invalid');
      }
    }
  }

  function onPlacementHover(e) {
    if (currentShipIdx >= config.SHIPS.length) return;
    const cell = e.target.closest('.cell');
    if (!cell) return;

    clearPreview();

    const r = parseInt(cell.dataset.r);
    const c = parseInt(cell.dataset.c);
    const size = config.SHIPS[currentShipIdx].size;
    const cells = getShipCells(r, c, size, orientation);
    const valid = isValidPlacement(cells);

    for (const { r: cr, c: cc } of cells) {
      if (cr >= 0 && cr < config.GRID_SIZE && cc >= 0 && cc < config.GRID_SIZE) {
        placementGrid[cr][cc].classList.add(valid ? 'ship-preview' : 'ship-preview-invalid');
      }
    }
  }

  function onPlacementClick(r, c) {
    if (currentShipIdx >= config.SHIPS.length) return;

    const size = config.SHIPS[currentShipIdx].size;
    const cells = getShipCells(r, c, size, orientation);

    if (!isValidPlacement(cells)) {
      toast('Invalid placement', 'error');
      return;
    }

    shipPlacements.push({ cells, orientation });

    applyShipVisuals(placementGrid, cells, orientation);

    currentShipIdx++;
    updatePlacementLabel();
  }

  document.getElementById('rotate-btn').addEventListener('click', () => {
    orientation = orientation === 'h' ? 'v' : 'h';
    document.getElementById('rotate-btn').textContent = `Rotate (R) — ${orientation === 'h' ? 'Horizontal' : 'Vertical'}`;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      if (phase === 'placement') {
        orientation = orientation === 'h' ? 'v' : 'h';
        document.getElementById('rotate-btn').textContent = `Rotate (R) — ${orientation === 'h' ? 'Horizontal' : 'Vertical'}`;
      }
    }
  });

  document.getElementById('confirm-placement').addEventListener('click', () => {
    socket.emit('place_ships', shipPlacements);
    setStatus('Waiting for opponent to place ships...');
    document.getElementById('confirm-placement').style.display = 'none';
  });

  socket.on('ships_confirmed', () => {
    toast('Ships confirmed!');
  });

  // ── Battle ──

  function startBattle() {
    showScreen('battle-screen');
    document.getElementById('battle-log').style.display = '';

    const attackContainer = document.getElementById('attack-grid');
    attackGrid = buildGrid(attackContainer, config.GRID_SIZE, onAttackClick);

    const defenseContainer = document.getElementById('defense-grid');
    defenseGrid = buildGrid(defenseContainer, config.GRID_SIZE);

    for (const ship of shipPlacements) {
      applyShipVisuals(defenseGrid, ship.cells, ship.orientation || 'h');
    }

    attackContainer.addEventListener('mouseover', onAttackHover);
    attackContainer.addEventListener('mouseout', clearNukePreview);

    // Touch support: show nuke radius preview where finger is
    attackContainer.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el && el.closest('.cell')) {
        onAttackHover({ target: el });
      }
    }, { passive: true });
    attackContainer.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el && el.closest('.cell')) {
        onAttackHover({ target: el });
      }
    }, { passive: true });
    attackContainer.addEventListener('touchend', clearNukePreview);

    document.getElementById('missile-btn').addEventListener('click', () => selectWeapon('missile'));
    document.getElementById('nuke-btn').addEventListener('click', () => selectWeapon('nuke'));

    updateNukeCount();
    renderShipStatus();
  }

  function selectWeapon(weapon) {
    if (weapon === 'nuke' && myNukes <= 0) return;
    selectedWeapon = weapon;
    document.querySelectorAll('.weapon-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.weapon === weapon);
    });
  }

  function updateNukeCount() {
    document.getElementById('nuke-count').textContent = myNukes;
    const nukeBtn = document.getElementById('nuke-btn');
    nukeBtn.classList.toggle('disabled', myNukes <= 0);
    if (myNukes <= 0 && selectedWeapon === 'nuke') {
      selectWeapon('missile');
    }
  }

  function renderShipStatus() {
    const container = document.getElementById('ship-status');
    // First call: build the tags
    if (!container.children.length) {
      container.innerHTML = config.SHIPS.map(s =>
        `<span class="ship-tag" data-ship="${s.name}">${s.name}</span>`
      ).join('');
    }
    // Update: only add .sunk to newly sunk ships (never re-add, avoids re-triggering animation)
    for (const tag of container.children) {
      const name = tag.dataset.ship;
      if (sunkEnemyShips.includes(name) && !tag.classList.contains('sunk')) {
        tag.classList.add('sunk');
      }
    }
  }

  function clearNukePreview() {
    if (!attackGrid.length) return;
    for (let r = 0; r < config.GRID_SIZE; r++) {
      for (let c = 0; c < config.GRID_SIZE; c++) {
        attackGrid[r][c].classList.remove('nuke-target');
      }
    }
  }

  function onAttackHover(e) {
    clearNukePreview();
    if (selectedWeapon !== 'nuke' || !myTurn) return;

    const cell = e.target.closest('.cell');
    if (!cell) return;

    const r = parseInt(cell.dataset.r);
    const c = parseInt(cell.dataset.c);

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < config.GRID_SIZE && nc >= 0 && nc < config.GRID_SIZE) {
          attackGrid[nr][nc].classList.add('nuke-target');
        }
      }
    }
  }

  function onAttackClick(r, c) {
    if (!myTurn || processingShot) {
      if (!myTurn) toast('Not your turn', 'error');
      clientLog('info', 'Click blocked', { myTurn, processingShot, r, c });
      return;
    }

    clientLog('info', 'Firing', { r, c, weapon: selectedWeapon });
    socket.emit('fire', { r, c, weapon: selectedWeapon });
  }

  socket.on('turn', (turnIdx) => {
    myTurn = turnIdx === playerIdx;
    clientLog('info', `Turn event received`, { turnIdx, myTurn, processingShot });
    updateClickableCells();
    updateTurnIndicator();
    if (!processingShot) {
      setStatus(myTurn ? 'Your turn — fire!' : "Opponent's turn...", myTurn);
    }
  });

  // ── Shot result handling with animations ──

  const shotQueue = [];
  let processingQueue = false;

  socket.on('shot_result', (data) => {
    clientLog('info', 'shot_result received', {
      attackerIdx: data.attackerIdx,
      weapon: data.weapon,
      resultCount: data.results?.length,
      gameOver: data.gameOver,
      queueLen: shotQueue.length,
      processingQueue,
    });
    shotQueue.push(data);
    if (!processingQueue) processNextShot();
  });

  async function processNextShot() {
    if (shotQueue.length === 0) {
      processingQueue = false;
      return;
    }
    processingQueue = true;
    processingShot = true;

    const data = shotQueue.shift();
    try {
      await handleShotResult(data);
    } catch (e) {
      clientLog('error', 'Shot animation error — using fallback', {
        error: e.message,
        stack: e.stack,
      });
      applyResultsFallback(data);
    }

    clientLog('info', 'Shot processing complete', { myTurn, queueRemaining: shotQueue.length });
    processingShot = false;
    updateClickableCells();
    updateTurnIndicator();
    setStatus(myTurn ? 'Your turn — fire!' : "Opponent's turn...", myTurn);
    processNextShot();
  }

  // Fallback: apply cell results without any animation if something crashes
  function applyResultsFallback(data) {
    try {
      const { attackerIdx, results, sunkShips, gameOver, winner, nukes } = data;
      const isMyShot = attackerIdx === playerIdx;
      myNukes = nukes[playerIdx];
      updateNukeCount();

      for (const { r, c, result } of results) {
        if (isMyShot) {
          attackGrid[r][c].classList.add(result);
          attackGrid[r][c].classList.remove('clickable');
        } else {
          defenseGrid[r][c].classList.add(result);
        }
      }

      if (isMyShot && sunkShips) {
        sunkEnemyShips = sunkShips;
        renderShipStatus();
      }

      if (gameOver) {
        showGameOver(winner === playerIdx);
      }
    } catch (e) {
      console.error('Fallback also failed:', e);
    }
  }

  function showGameOver(won) {
    const $title = document.getElementById('game-over-title');
    const $msg = document.getElementById('game-over-msg');
    const $rematchStatus = document.getElementById('rematch-status');
    const $rematchBtn = document.getElementById('rematch-btn');

    $rematchStatus.textContent = '';
    $rematchBtn.disabled = false;
    $rematchBtn.textContent = 'REMATCH';

    if (won) {
      $title.textContent = 'Victory!';
      $msg.textContent = 'You destroyed the enemy fleet.';
      $gameOver.classList.remove('loser');
      playVictorySound();
    } else {
      $title.textContent = 'Defeat';
      $msg.textContent = 'Your fleet has been destroyed.';
      $gameOver.classList.add('loser');
      playDefeatSound();
    }
    $gameOver.classList.add('active');
  }

  // ── Rematch ──

  document.getElementById('rematch-btn').addEventListener('click', () => {
    const btn = document.getElementById('rematch-btn');
    btn.disabled = true;
    btn.textContent = 'WAITING...';
    document.getElementById('rematch-status').textContent = 'WAITING FOR OPPONENT...';
    clientLog('info', 'Requesting rematch');
    socket.emit('request_rematch');
  });

  socket.on('opponent_wants_rematch', () => {
    document.getElementById('rematch-status').textContent = 'OPPONENT WANTS A REMATCH';
  });

  socket.on('rematch_start', (data) => {
    clientLog('info', 'Rematch starting');
    // Reset client state
    config = data.config;
    myNukes = config.NUKES_PER_PLAYER;
    shipPlacements = [];
    currentShipIdx = 0;
    orientation = 'h';
    placementGrid = [];
    attackGrid = [];
    defenseGrid = [];
    selectedWeapon = 'missile';
    myTurn = false;
    sunkEnemyShips = [];
    processingShot = false;

    // Clear battle log
    const logEntries = document.getElementById('log-entries');
    if (logEntries) logEntries.innerHTML = '';
    document.getElementById('battle-log').style.display = 'none';

    // Clear ship status for fresh rebuild
    document.getElementById('ship-status').innerHTML = '';

    // Hide game over
    $gameOver.classList.remove('active', 'loser');

    // placement phase will be triggered by the phase event from server
  });

  async function handleShotResult(data) {
    const { attackerIdx, results, sunkShips, gameOver, winner, weapon, nukes } = data;
    const isMyShot = attackerIdx === playerIdx;

    myNukes = nukes[playerIdx];
    updateNukeCount();

    // ── Nuke: countdown then reveal ──
    if (weapon === 'nuke') {
      await showNukeCountdown(isMyShot);
      nukeFlash();
      playExplosionSound();
      shake(true);

      // Staggered cell reveals
      for (let i = 0; i < results.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 60));
        const { r, c, result } = results[i];
        applyCellResult(r, c, result, isMyShot, true);
      }

      const hits = results.filter(r => r.result === 'hit').length;
      const misses = results.filter(r => r.result === 'miss').length;
      if (isMyShot) {
        toast(`Nuclear blast dealt ${hits} hit${hits !== 1 ? 's' : ''}!`, 'nuke-toast');
        addLogEntry(`NUKE: ${hits} hits, ${misses} misses`, 'log-nuke');
      } else {
        toast('Incoming nuclear strike!', 'nuke-toast');
        addLogEntry(`ENEMY NUKE: ${hits} hits on your fleet`, 'log-nuke');
      }

    } else {
      // ── Standard missile ──
      const { r, c, result } = results[0];
      applyCellResult(r, c, result, isMyShot, false);

      if (result === 'hit') {
        shake(false);
        if (isMyShot) {
          toast('Direct Hit!', 'hit');
          addLogEntry(`Hit at ${String.fromCharCode(65 + c)}${r + 1}`, 'log-hit');
        } else {
          toast('Your ship was hit!', 'hit');
          addLogEntry(`Enemy hit at ${String.fromCharCode(65 + c)}${r + 1}`, 'log-hit');
        }
      } else {
        if (isMyShot) {
          toast('Miss — splash!', 'miss-toast');
          addLogEntry(`Miss at ${String.fromCharCode(65 + c)}${r + 1}`, 'log-miss');
        } else {
          toast('Enemy missed!', 'miss-toast');
          addLogEntry(`Enemy miss at ${String.fromCharCode(65 + c)}${r + 1}`, 'log-miss');
        }
      }
    }

    // Track sunk ships
    if (isMyShot && sunkShips) {
      const previousSunk = [...sunkEnemyShips];
      sunkEnemyShips = sunkShips;
      renderShipStatus();
      const newlySunk = sunkShips.filter(s => !previousSunk.includes(s));
      for (const name of newlySunk) {
        if (!gameOver) {
          playSunkSound();
          await new Promise(resolve => setTimeout(resolve, 400));
          toast(`You sunk their ${name}!`, 'sunk-toast');
          addLogEntry(`SUNK: ${name}`, 'log-sunk');
        }
      }
    }

    // Game over
    if (gameOver) {
      await new Promise(resolve => setTimeout(resolve, 800));
      showGameOver(winner === playerIdx);
    }
  }

  function applyCellResult(r, c, result, isMyShot, isNuke) {
    const grid = isMyShot ? attackGrid : defenseGrid;
    const cell = grid[r][c];
    const cls = isNuke ? (result === 'hit' ? 'nuke-hit' : 'nuke-miss') : result;
    cell.classList.add(cls);
    if (result === 'hit') cell.classList.add('hit');
    if (result === 'miss') cell.classList.add('miss');
    if (isMyShot) cell.classList.remove('clickable');

    // Sound + particles (only attacker plays sounds to avoid double audio)
    if (isMyShot) {
      if (result === 'hit') {
        playHitSound();
        if (isNuke) spawnNukeParticles(cell); else spawnHitParticles(cell);
      } else {
        playMissSound();
        addSplashRing(cell);
      }
    } else {
      if (result === 'hit') {
        if (isNuke) spawnNukeParticles(cell); else spawnHitParticles(cell);
      } else {
        addSplashRing(cell);
      }
    }
  }
})();
