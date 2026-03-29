(() => {
  // Derive base path from current URL so the app works behind any prefix
  const basePath = location.pathname.replace(/\/+$/, '');
  const socket = io({ path: `${basePath}/socket.io/` });

  // ── i18n helper ──
  const t = (key, params) => I18n.t(key, params);

  // Ship name translation helper
  function shipName(name) {
    const key = 'ship_' + name.toLowerCase();
    return t(key);
  }

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

  // ── Mute ──

  let muted = localStorage.getItem('naval-command-muted') === 'true';

  function updateMuteUI() {
    const btn = document.getElementById('menu-mute');
    btn.textContent = muted ? t('unmute_sounds') : t('mute_sounds');
    btn.classList.toggle('muted', muted);
  }

  // ── Audio engine (Web Audio API — no files needed) ──
  // All audio is wrapped in try/catch for iOS Safari compatibility.
  // iOS requires a user gesture before AudioContext works, so we
  // lazily create it on first interaction and never let audio errors
  // break game logic.

  let audioCtx = null;

  function getAudioCtx() {
    if (muted) return null;
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
    // Deliberate disconnects don't need reconnecting UI
    if (reason === 'io server disconnect' || reason === 'io client disconnect') return;
    setStatus(t('reconnecting'));
    $status.classList.add('reconnecting');
  });

  socket.io.on('reconnect', (attemptNumber) => {
    clientLog('info', 'Socket reconnected', { attemptNumber });
    $status.classList.remove('reconnecting');
    toast(t('connection_restored'));
    if (roomId) socket.emit('join_room', roomId);
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    clientLog('info', 'Reconnection attempt', { attempt });
    setStatus(t('reconnecting_attempt', { attempt }));
  });

  socket.io.on('reconnect_failed', () => {
    clientLog('error', 'Reconnection failed');
    $status.classList.remove('reconnecting');
    const overlay = document.getElementById('disconnect-overlay');
    overlay.querySelector('h2').textContent = t('connection_lost');
    overlay.querySelector('p').textContent = t('unable_reconnect');
    overlay.classList.add('active');
  });

  socket.on('connect_error', (err) => {
    clientLog('error', 'Socket connect error', { message: err.message });
    setStatus(t('connection_error'));
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

  function playLaunchSound(duration) {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      // Ascending power-up tone — confident, not alarming
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + duration);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime + duration - 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start();
      osc.stop(ctx.currentTime + duration);

      // Subtle rumble underneath
      const rumble = ctx.createOscillator();
      const rGain = ctx.createGain();
      rumble.connect(rGain);
      rGain.connect(ctx.destination);
      rumble.type = 'sine';
      rumble.frequency.setValueAtTime(40, ctx.currentTime);
      rGain.gain.setValueAtTime(0.1, ctx.currentTime);
      rGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      rumble.start();
      rumble.stop(ctx.currentTime + duration);
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

  function playIncomingHitSound() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const tt = ctx.currentTime;
      // Metal impact — short, sharp clang
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(400, tt);
      osc.frequency.exponentialRampToValueAtTime(120, tt + 0.2);
      gain.gain.setValueAtTime(0.25, tt);
      gain.gain.exponentialRampToValueAtTime(0.001, tt + 0.3);
      osc.start(tt);
      osc.stop(tt + 0.3);
    } catch (e) {}
  }

  function playIncomingMissSound() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const tt = ctx.currentTime;
      // Soft water plop nearby
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(200, tt);
      osc.frequency.exponentialRampToValueAtTime(60, tt + 0.15);
      gain.gain.setValueAtTime(0.1, tt);
      gain.gain.exponentialRampToValueAtTime(0.001, tt + 0.2);
      osc.start(tt);
      osc.stop(tt + 0.2);
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
        const icon = document.getElementById('countdown-icon');

        label.textContent = isAttacker ? t('nuke_launching') : t('nuke_incoming');
        sub.textContent = isAttacker ? t('warhead_armed') : t('seek_shelter');

        // Toggle launch vs incoming visual mode
        overlay.classList.toggle('launch-mode', isAttacker);
        overlay.classList.add('active');

        if (isAttacker) {
          playLaunchSound(2);
        } else {
          playSirenSound(2);
        }

        let count = 2;
        number.textContent = count;
        playDoomCountdown();

        const interval = setInterval(() => {
          count--;
          if (count > 0) {
            number.textContent = count;
            playDoomCountdown();
          } else {
            clearInterval(interval);
            overlay.classList.remove('active', 'launch-mode');
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
  let vsComputer = false;

  // Placement state
  let shipPlacements = [];
  let currentShipIdx = 0;
  let orientation = 'h';
  let placementGrid = [];
  let pendingPreview = null;  // { r, c, orient } — locked preview for touch placement
  let lastInputWasTouch = false;
  let touchConfirming = false;  // true when second tap lands on locked preview

  // Battle state
  let selectedWeapon = 'missile';
  let myNukes = 0;
  let attackGrid = [];
  let defenseGrid = [];
  let myTurn = false;
  let sunkEnemyShips = [];
  let processingShot = false;

  // Game stats
  let stats = { shotsFired: 0, hits: 0, misses: 0, nukesUsed: 0, turnsPlayed: 0 };

  // Turn timer
  let turnTimerInterval = null;
  let turnStartTime = null;

  // DOM references
  const $status = document.getElementById('status');
  const $roomInfo = document.getElementById('room-info');
  const $gameOver = document.getElementById('game-over');

  // ── Helpers ──

  function showScreen(id) {
    const current = document.querySelector('.screen.active');
    const next = document.getElementById(id);
    if (current && current !== next) {
      current.classList.add('fading-out');
      current.classList.remove('active');
      setTimeout(() => current.classList.remove('fading-out'), 300);
    }
    next.classList.add('active');
  }

  function setStatus(msg, isActive) {
    $status.textContent = msg;
    $status.classList.toggle('active-turn', !!isActive);
  }

  const $turnTimer = document.getElementById('turn-timer');

  const TURN_TIME_LIMIT = 30; // seconds

  function startTurnTimer() {
    stopTurnTimer();
    turnStartTime = Date.now();
    updateTimerDisplay();
    turnTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - turnStartTime) / 1000);
      const remaining = TURN_TIME_LIMIT - elapsed;
      updateTimerDisplay();
      // Auto-fire when time runs out on your turn
      if (myTurn && remaining <= 0 && !processingShot) {
        fireRandomCell();
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const elapsed = Math.floor((Date.now() - turnStartTime) / 1000);
    const remaining = Math.max(0, TURN_TIME_LIMIT - elapsed);
    $turnTimer.textContent = `${remaining}s`;
    $turnTimer.classList.toggle('timer-urgent', remaining <= 10 && myTurn);
  }

  function stopTurnTimer() {
    if (turnTimerInterval) {
      clearInterval(turnTimerInterval);
      turnTimerInterval = null;
    }
    $turnTimer.textContent = '';
    $turnTimer.classList.remove('timer-urgent');
  }

  function fireRandomCell() {
    if (!myTurn || processingShot || !attackGrid.length) return;
    // Collect all untargeted cells
    const available = [];
    for (let r = 0; r < config.GRID_SIZE; r++) {
      for (let c = 0; c < config.GRID_SIZE; c++) {
        const cell = attackGrid[r][c];
        if (!cell.classList.contains('hit') && !cell.classList.contains('miss')) {
          available.push({ r, c });
        }
      }
    }
    if (available.length === 0) return;
    const target = available[Math.floor(Math.random() * available.length)];
    toast(t('time_up_auto'), 'error');
    socket.emit('fire', { r: target.r, c: target.c, weapon: 'missile' });
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

  // ── Language toggle ──

  const $langBtn = document.getElementById('lang-btn');

  function updateLangButton() {
    $langBtn.textContent = I18n.getLang().toUpperCase();
  }

  $langBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const newLang = I18n.getLang() === 'en' ? 'es' : 'en';
    I18n.setLang(newLang);
  });

  // Re-translate dynamic text when language changes
  window.addEventListener('langchange', () => {
    updateLangButton();
    updateMuteUI();
    refreshDynamicText();
  });

  function refreshDynamicText() {
    // Refresh status text based on current phase
    if (phase === 'lobby') {
      // Don't overwrite connection-specific statuses
    } else if (phase === 'placement') {
      updatePlacementLabel();
      if (document.getElementById('confirm-placement').style.display === 'none' &&
          currentShipIdx >= (config ? config.SHIPS.length : 5)) {
        // Waiting for opponent
      }
    } else if (phase === 'battle') {
      if (myTurn) {
        setStatus(t('your_turn_fire'), true);
      } else {
        setStatus(vsComputer ? t('computer_turn') : t('opponent_turn'));
      }
      renderShipStatus(true);
    }

    // Refresh room info
    if (roomId && vsComputer) {
      $roomInfo.innerHTML = `<strong>${t('vs_computer_label')}</strong>`;
    } else if (roomId) {
      $roomInfo.innerHTML = `Room: <strong>${roomId}</strong>`;
    }

    // Refresh waiting dots if active
    if (waitingDotsInterval) {
      stopWaitingDots();
      startWaitingDots();
    }

    // Refresh nuke info on waiting panel
    if (config && document.getElementById('panel-waiting').style.display !== 'none') {
      document.getElementById('waiting-nuke-info').textContent =
        myNukes > 0 ? t('nukes_per_player_info', { count: myNukes }) : t('nukes_disabled');
    }

    // Refresh rotate button text
    if (phase === 'placement') {
      document.getElementById('rotate-btn').textContent =
        orientation === 'h' ? t('rotate') : (orientation === 'v' ? t('rotate') : t('rotate'));
    }
  }

  // ── Lobby ──

  let waitingDotsInterval;

  // Panel switching within the lobby terminal box
  function showPanel(panelId) {
    document.querySelectorAll('.terminal-panel').forEach(p => p.style.display = 'none');
    document.getElementById(panelId).style.display = '';
  }

  // Auto-join from URL parameter
  const params = new URLSearchParams(window.location.search);
  const urlRoom = params.get('room');
  if (urlRoom) {
    joinRoom(urlRoom);
  }

  // Main → New Game panel
  document.getElementById('new-game-btn').addEventListener('click', () => {
    showPanel('panel-new-game');
  });

  // Main → Join panel
  document.getElementById('join-screen-btn').addEventListener('click', () => {
    showPanel('panel-join');
  });

  // Track whether the next game is vs AI
  let pendingVsAI = false;

  // New Game → choose VS Player → settings
  document.getElementById('choose-player-btn').addEventListener('click', () => {
    pendingVsAI = false;
    document.getElementById('difficulty-row').style.display = 'none';
    showPanel('panel-game-settings');
  });

  // New Game → choose VS Computer → settings
  document.getElementById('choose-ai-btn').addEventListener('click', () => {
    pendingVsAI = true;
    document.getElementById('difficulty-row').style.display = '';
    showPanel('panel-game-settings');
  });

  // Settings → Start Game
  document.getElementById('start-game-btn').addEventListener('click', () => {
    const raw = document.getElementById('nuke-input').value.trim();
    const nukes = raw === '' ? 2 : (parseInt(raw) || 0);
    if (pendingVsAI) {
      const diffBtn = document.querySelector('.diff-btn.selected');
      const difficulty = diffBtn ? diffBtn.dataset.diff : 'normal';
      socket.emit('join_ai_game', { nukes, difficulty });
    } else {
      const code = Math.random().toString(36).substring(2, 10);
      joinRoom(code, nukes);
    }
  });

  // Nuke stepper +/- buttons
  document.getElementById('nuke-minus').addEventListener('click', () => {
    const input = document.getElementById('nuke-input');
    const current = input.value.trim() === '' ? 2 : (parseInt(input.value) || 0);
    input.value = Math.max(0, current - 1);
  });

  document.getElementById('nuke-plus').addEventListener('click', () => {
    const input = document.getElementById('nuke-input');
    const current = input.value.trim() === '' ? 2 : (parseInt(input.value) || 0);
    input.value = Math.min(10, current + 1);
  });

  // Nuke input: only allow digits, clamp on blur
  document.getElementById('nuke-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '');
  });

  document.getElementById('nuke-input').addEventListener('blur', (e) => {
    const val = parseInt(e.target.value);
    if (!isNaN(val)) {
      e.target.value = Math.max(0, Math.min(10, val));
    }
  });

  // Difficulty toggle
  document.querySelectorAll('.diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  // New Game → back
  document.getElementById('new-game-back-btn').addEventListener('click', () => {
    showPanel('panel-main');
  });

  // Settings → back
  document.getElementById('settings-back-btn').addEventListener('click', () => {
    showPanel('panel-new-game');
  });

  // Join → join room
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

  // Join → back
  document.getElementById('join-back-btn').addEventListener('click', () => {
    showPanel('panel-main');
  });

  // Waiting → copy invite link
  document.getElementById('copy-link-btn').addEventListener('click', () => {
    const shareUrl = `${location.origin}${basePath}/?room=${roomId}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      toast(t('invite_copied'));
    });
  });

  // Waiting → leave
  document.getElementById('waiting-back-btn').addEventListener('click', () => {
    stopWaitingDots();
    socket.disconnect();
    window.history.replaceState({}, '', basePath || '/');
    location.reload();
  });

  function joinRoom(code, nukes) {
    if (nukes !== undefined) {
      socket.emit('join_room', { roomId: code, nukes });
    } else {
      socket.emit('join_room', code);
    }
  }

  function startWaitingDots() {
    const el = document.getElementById('waiting-dots');
    if (!el) return;
    let count = 0;
    const baseText = t('waiting_for_opponent');
    clearInterval(waitingDotsInterval);
    waitingDotsInterval = setInterval(() => {
      count = (count + 1) % 4;
      el.textContent = baseText + '.'.repeat(count);
    }, 500);
  }

  function stopWaitingDots() {
    clearInterval(waitingDotsInterval);
  }

  // ── Menu ──

  const $menuBtn = document.getElementById('menu-btn');
  const $menuDropdown = document.getElementById('menu-dropdown');

  $menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    $menuDropdown.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    $menuDropdown.classList.remove('open');
  });

  document.getElementById('menu-mute').addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('naval-command-muted', muted);
    updateMuteUI();
    $menuDropdown.classList.remove('open');
  });
  updateMuteUI();

  document.getElementById('menu-new-game').addEventListener('click', () => {
    $menuDropdown.classList.remove('open');
    socket.disconnect();
    // Reset to lobby
    window.history.replaceState({}, '', basePath || '/');
    location.reload();
  });

  document.getElementById('menu-forfeit').addEventListener('click', () => {
    $menuDropdown.classList.remove('open');
    if (phase === 'battle') {
      socket.emit('forfeit');
    }
  });

  document.getElementById('menu-quit').addEventListener('click', () => {
    $menuDropdown.classList.remove('open');
    socket.disconnect();
    window.history.replaceState({}, '', basePath || '/');
    location.reload();
  });

  // Leave button on game over
  document.getElementById('leave-btn').addEventListener('click', () => {
    location.reload();
  });

  // ── Socket events ──

  socket.on('joined', (data) => {
    playerIdx = data.playerIdx;
    config = data.config;
    roomId = data.roomId;
    myNukes = config.NUKES_PER_PLAYER;
    vsComputer = !!data.isAI;

    _logPlayerIdx = playerIdx;
    _logRoomId = roomId;
    clientLog('info', 'Joined room', { playerIdx, roomId, vsComputer });

    window.history.replaceState({}, '', `${basePath}/?room=${roomId}`);

    if (vsComputer) {
      $roomInfo.innerHTML = `<strong>${t('vs_computer_label')}</strong>`;
      setStatus(t('place_fleet_commander'));
      document.getElementById('reaction-bar').style.display = 'none';
      // AI game — phase event fires immediately, no waiting room needed
    } else {
      $roomInfo.innerHTML = `Room: <strong>${roomId}</strong>`;
      setStatus(t('player_waiting', { num: playerIdx + 1 }));
      // Show waiting room
      document.getElementById('room-code-display').textContent = roomId.toUpperCase();
      document.getElementById('waiting-nuke-info').textContent =
        myNukes > 0 ? t('nukes_per_player_info', { count: myNukes }) : t('nukes_disabled');
      showPanel('panel-waiting');
      startWaitingDots();
    }
  });

  socket.on('phase', (newPhase) => {
    clientLog('info', `Phase changed: ${newPhase}`);
    phase = newPhase;

    document.getElementById('menu-forfeit').style.display = (newPhase === 'battle') ? '' : 'none';

    if (phase === 'placement') {
      startPlacement();
    } else if (phase === 'battle') {
      startBattle();
    }
  });

  socket.on('opponent_joined', () => {
    stopWaitingDots();
    toast(t('opponent_joined'));
  });

  socket.on('opponent_ready', () => {
    toast(t('opponent_placed_ships'));
  });

  socket.on('opponent_disconnected', () => {
    if (vsComputer) return; // AI never disconnects
    clientLog('info', 'Opponent disconnected');
    document.getElementById('disconnect-overlay').classList.add('active');
  });

  document.getElementById('disconnect-new-game').addEventListener('click', () => {
    socket.disconnect();
    window.history.replaceState({}, '', basePath || '/');
    location.reload();
  });

  socket.on('error_msg', (msg) => {
    clientLog('error', `Server error: ${msg}`);
    toast(msg, 'error');
  });

  socket.on('forfeit_result', ({ loserIdx, winnerIdx }) => {
    phase = 'finished';
    const won = winnerIdx === playerIdx;
    if (!won) {
      toast(t('you_forfeited'), 'error');
    } else {
      toast(vsComputer ? t('computer_forfeited') : t('opponent_forfeited'), 'sunk-toast');
    }
    showGameOver(won);
  });

  const REACTIONS_KEYS = ['reaction_nice_shot', 'reaction_missed_me', 'reaction_good_game', '\u{1F525}', '\u{1F631}'];
  socket.on('opponent_reaction', (reactionId) => {
    const key = REACTIONS_KEYS[reactionId];
    if (!key) return;
    // Emoji reactions don't need translation
    const msg = key.startsWith('reaction_') ? t(key) : key;
    toast(t('opponent_reaction', { msg }), 'reaction-toast');
  });

  // ── Placement ──

  function startPlacement() {
    showScreen('placement-screen');
    setStatus(t('place_ships_grid'));
    shipPlacements = [];
    currentShipIdx = 0;
    orientation = 'h';
    pendingPreview = null;
    lastInputWasTouch = false;
    touchConfirming = false;

    // Show mobile hint on touch devices
    const hint = document.getElementById('mobile-hint');
    if (hint && ('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
      hint.classList.add('show');
    }

    const container = document.getElementById('placement-grid');
    placementGrid = buildGrid(container, config.GRID_SIZE, onPlacementClick);

    updatePlacementLabel();
    updateUndoButton();

    // Desktop: live hover preview
    container.addEventListener('mouseover', onPlacementHover);
    container.addEventListener('mouseout', clearPreview);

    // Touch: show preview while dragging, lock on lift
    container.addEventListener('touchstart', (e) => {
      lastInputWasTouch = true;
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const cell = el && el.closest('.cell');
      if (!cell) return;
      const r = parseInt(cell.dataset.r);
      const c = parseInt(cell.dataset.c);

      // If tapping on an existing locked preview, don't clear it — let click confirm
      if (pendingPreview) {
        const prevSize = config.SHIPS[currentShipIdx].size;
        const prevCells = getShipCells(pendingPreview.r, pendingPreview.c, prevSize, pendingPreview.orient);
        if (prevCells.some(pc => pc.r === r && pc.c === c)) {
          touchConfirming = true;
          return;
        }
      }
      touchConfirming = false;
      onPlacementHover({ target: el });
    }, { passive: true });
    container.addEventListener('touchmove', (e) => {
      touchConfirming = false;
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      if (el && el.closest('.cell')) {
        onPlacementHover({ target: el });
      }
    }, { passive: true });
    // On touch end, lock the preview instead of clearing it
    container.addEventListener('touchend', () => {
      if (touchConfirming) return; // let click handler confirm the placement
      lockPreview();
    });
  }

  function updatePlacementLabel() {
    const label = document.getElementById('current-ship-label');
    const confirmBtn = document.getElementById('confirm-placement');

    if (currentShipIdx < config.SHIPS.length) {
      const ship = config.SHIPS[currentShipIdx];
      label.textContent = t('place_ship', { name: shipName(ship.name), size: ship.size });
      confirmBtn.style.display = 'none';
    } else {
      label.textContent = t('all_ships_placed');
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
        placementGrid[r][c].classList.remove('ship-preview', 'ship-preview-invalid', 'ship-preview-locked');
      }
    }
  }

  function lockPreview() {
    if (currentShipIdx >= config.SHIPS.length) return;
    // Find which cells currently have the preview and lock them
    let hasPreview = false;
    let lockedR = -1, lockedC = -1;
    for (let r = 0; r < config.GRID_SIZE; r++) {
      for (let c = 0; c < config.GRID_SIZE; c++) {
        const cell = placementGrid[r][c];
        if (cell.classList.contains('ship-preview')) {
          cell.classList.remove('ship-preview');
          cell.classList.add('ship-preview-locked');
          if (!hasPreview) { lockedR = r; lockedC = c; }
          hasPreview = true;
        }
      }
    }
    if (hasPreview) {
      // Calculate the anchor cell (top-left of the ship)
      const size = config.SHIPS[currentShipIdx].size;
      const cells = getShipCells(lockedR, lockedC, size, orientation);
      // The anchor is the first cell that matches our grid position
      // For horizontal ships, anchor is leftmost; for vertical, topmost
      // lockedR/lockedC will be one of the ship cells — find the anchor
      const minR = Math.min(...cells.map(c => c.r));
      const minC = Math.min(...cells.map(c => c.c));
      pendingPreview = { r: minR, c: minC, orient: orientation };
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

  function placeShipAt(r, c) {
    const size = config.SHIPS[currentShipIdx].size;
    const cells = getShipCells(r, c, size, orientation);

    if (!isValidPlacement(cells)) {
      toast(t('invalid_placement'), 'error');
      return;
    }

    shipPlacements.push({ cells, orientation });
    applyShipVisuals(placementGrid, cells, orientation);
    pendingPreview = null;
    currentShipIdx++;
    updatePlacementLabel();
    updateUndoButton();
  }

  function updateUndoButton() {
    document.getElementById('undo-btn').style.display = shipPlacements.length > 0 ? '' : 'none';
  }

  function rerenderPlacements() {
    // Clear all ship visuals from the grid
    for (let r = 0; r < config.GRID_SIZE; r++) {
      for (let c = 0; c < config.GRID_SIZE; c++) {
        const cell = placementGrid[r][c];
        cell.classList.remove('ship', 'ship-placed', 'ship-preview', 'ship-preview-invalid', 'ship-preview-locked');
        delete cell.dataset.orient;
        delete cell.dataset.part;
      }
    }
    // Re-apply remaining placements
    for (const ship of shipPlacements) {
      applyShipVisuals(placementGrid, ship.cells, ship.orientation);
    }
  }

  function undoLastShip() {
    if (shipPlacements.length === 0) return;
    shipPlacements.pop();
    currentShipIdx--;
    pendingPreview = null;
    rerenderPlacements();
    updatePlacementLabel();
    updateUndoButton();
  }

  function randomPlacement() {
    shipPlacements = [];
    currentShipIdx = 0;
    pendingPreview = null;
    rerenderPlacements();

    for (let i = 0; i < config.SHIPS.length; i++) {
      const size = config.SHIPS[i].size;
      let placed = false;
      for (let attempt = 0; attempt < 1000 && !placed; attempt++) {
        const r = Math.floor(Math.random() * config.GRID_SIZE);
        const c = Math.floor(Math.random() * config.GRID_SIZE);
        const orient = Math.random() > 0.5 ? 'h' : 'v';
        const cells = getShipCells(r, c, size, orient);
        if (isValidPlacement(cells)) {
          shipPlacements.push({ cells, orientation: orient });
          applyShipVisuals(placementGrid, cells, orient);
          currentShipIdx++;
          placed = true;
        }
      }
    }
    updatePlacementLabel();
    updateUndoButton();
  }

  function onPlacementClick(r, c) {
    if (currentShipIdx >= config.SHIPS.length) return;

    if (lastInputWasTouch) {
      lastInputWasTouch = false;

      // Second tap on the locked preview → confirm placement
      if (touchConfirming && pendingPreview) {
        touchConfirming = false;
        clearPreview();
        placeShipAt(pendingPreview.r, pendingPreview.c);
        return;
      }
      touchConfirming = false;

      // Tapped outside preview → already handled by touchstart/touchend
      // Just need to update pendingPreview from whatever lockPreview set
    } else {
      // Mouse: immediate placement (desktop behavior unchanged)
      placeShipAt(r, c);
    }
  }

  function rotateShip() {
    orientation = orientation === 'h' ? 'v' : 'h';
    document.getElementById('rotate-btn').textContent = orientation === 'h' ? t('rotate_horizontal') : t('rotate_vertical');
    // Re-render locked preview in new orientation
    if (pendingPreview) {
      clearPreview();
      const { r, c } = pendingPreview;
      const size = config.SHIPS[currentShipIdx].size;
      const cells = getShipCells(r, c, size, orientation);
      const valid = isValidPlacement(cells);
      for (const { r: cr, c: cc } of cells) {
        if (cr >= 0 && cr < config.GRID_SIZE && cc >= 0 && cc < config.GRID_SIZE) {
          placementGrid[cr][cc].classList.add(valid ? 'ship-preview-locked' : 'ship-preview-invalid');
        }
      }
      pendingPreview = valid ? { r, c, orient: orientation } : null;
    }
  }

  document.getElementById('rotate-btn').addEventListener('click', rotateShip);
  document.getElementById('undo-btn').addEventListener('click', undoLastShip);
  document.getElementById('random-btn').addEventListener('click', randomPlacement);

  document.addEventListener('keydown', (e) => {
    if (phase !== 'placement') return;
    if (e.key === 'r' || e.key === 'R') rotateShip();
    if (e.key === 'z' || e.key === 'Z') undoLastShip();
    if (e.key === 'q' || e.key === 'Q') randomPlacement();
  });

  document.getElementById('confirm-placement').addEventListener('click', () => {
    socket.emit('place_ships', shipPlacements);
    setStatus(t('waiting_opponent_place'));
    document.getElementById('confirm-placement').style.display = 'none';
  });

  socket.on('ships_confirmed', () => {
    toast(t('ships_confirmed'));
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

    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.reaction);
        socket.emit('reaction', id);
        btn.disabled = true;
        setTimeout(() => { btn.disabled = false; }, 3000);
      });
    });

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

  function renderShipStatus(forceRebuild) {
    const container = document.getElementById('ship-status');
    // First call or language change: build the tags
    if (!container.children.length || forceRebuild) {
      const prevSunk = [];
      // Preserve sunk state when rebuilding
      if (forceRebuild) {
        for (const tag of container.children) {
          if (tag.classList.contains('sunk')) prevSunk.push(tag.dataset.ship);
        }
      }
      container.innerHTML = config.SHIPS.map(s =>
        `<span class="ship-tag${sunkEnemyShips.some(es => es.name === s.name) || prevSunk.includes(s.name) ? ' sunk' : ''}" data-ship="${s.name}">${shipName(s.name)}</span>`
      ).join('');
    }
    // Update: only add .sunk to newly sunk ships (never re-add, avoids re-triggering animation)
    const sunkNames = sunkEnemyShips.map(s => s.name);
    for (const tag of container.children) {
      const name = tag.dataset.ship;
      if (sunkNames.includes(name) && !tag.classList.contains('sunk')) {
        tag.classList.add('sunk');
      }
    }
  }

  function renderSunkShipOutline(ship) {
    if (!attackGrid.length || !ship.cells || ship.cells.length === 0) return;
    const cells = ship.cells;

    // Determine orientation from the cells
    const orient = (cells.length === 1) ? 'h'
      : (cells[0].r === cells[1].r) ? 'h' : 'v';

    // Sort cells by position to ensure correct bow→stern order
    const sorted = [...cells].sort((a, b) =>
      orient === 'h' ? a.c - b.c : a.r - b.r
    );

    for (let i = 0; i < sorted.length; i++) {
      const { r, c } = sorted[i];
      if (r >= 0 && r < config.GRID_SIZE && c >= 0 && c < config.GRID_SIZE) {
        const cell = attackGrid[r][c];
        cell.classList.add('sunk-ship');
        cell.dataset.sunkOrient = orient;
        if (i === 0) {
          cell.dataset.sunkPart = 'bow';
        } else if (i === sorted.length - 1) {
          cell.dataset.sunkPart = 'stern';
        } else {
          cell.dataset.sunkPart = 'mid';
        }
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
      if (!myTurn) toast(t('not_your_turn'), 'error');
      clientLog('info', 'Click blocked', { myTurn, processingShot, r, c });
      return;
    }

    const cell = attackGrid[r][c];
    if (cell.classList.contains('hit') || cell.classList.contains('miss')) {
      toast(t('already_targeted'), 'error');
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
    startTurnTimer();
    if (!processingShot) {
      setStatus(myTurn ? t('your_turn_fire') : (vsComputer ? t('computer_turn') : t('opponent_turn')), myTurn);
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
    setStatus(myTurn ? t('your_turn_fire') : (vsComputer ? t('computer_turn') : t('opponent_turn')), myTurn);
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
    stopTurnTimer();
    const $title = document.getElementById('game-over-title');
    const $msg = document.getElementById('game-over-msg');
    const $rematchStatus = document.getElementById('rematch-status');
    const $rematchBtn = document.getElementById('rematch-btn');

    $rematchStatus.textContent = '';
    $rematchBtn.disabled = false;
    $rematchBtn.textContent = t('rematch');

    if (won) {
      $title.textContent = t('victory');
      $msg.textContent = t('victory_msg');
      $gameOver.classList.remove('loser');
      playVictorySound();
    } else {
      $title.textContent = t('defeat');
      $msg.textContent = t('defeat_msg');
      $gameOver.classList.add('loser');
      playDefeatSound();
    }

    // Render stats
    const accuracy = stats.shotsFired > 0 ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100) : 0;
    const $stats = document.getElementById('game-over-stats');
    $stats.innerHTML = `
      <div class="stat"><span class="stat-val">${accuracy}%</span><span class="stat-label">${t('accuracy')}</span></div>
      <div class="stat"><span class="stat-val">${stats.shotsFired}</span><span class="stat-label">${t('shots_fired')}</span></div>
      <div class="stat"><span class="stat-val">${stats.hits}</span><span class="stat-label">${t('hits')}</span></div>
      <div class="stat"><span class="stat-val">${sunkEnemyShips.length}/${config.SHIPS.length}</span><span class="stat-label">${t('ships_sunk')}</span></div>
      <div class="stat"><span class="stat-val">${stats.nukesUsed}</span><span class="stat-label">${t('nukes_used')}</span></div>
      <div class="stat"><span class="stat-val">${stats.turnsPlayed}</span><span class="stat-label">${t('total_turns')}</span></div>
    `;

    $gameOver.classList.add('active');
  }

  // ── Rematch ──

  document.getElementById('rematch-btn').addEventListener('click', () => {
    const btn = document.getElementById('rematch-btn');
    btn.disabled = true;
    btn.textContent = t('waiting_ellipsis');
    document.getElementById('rematch-status').textContent = vsComputer ? '' : t('waiting_for_opponent_ellipsis');
    clientLog('info', 'Requesting rematch');
    socket.emit('request_rematch');
  });

  socket.on('opponent_wants_rematch', () => {
    document.getElementById('rematch-status').textContent = t('opponent_wants_rematch');
  });

  socket.on('rematch_start', (data) => {
    clientLog('info', 'Rematch starting');
    stopTurnTimer();
    // Reset client state
    if (data.isAI) vsComputer = true;
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
    stats = { shotsFired: 0, hits: 0, misses: 0, nukesUsed: 0, turnsPlayed: 0 };

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
        toast(t('nuke_blast_hits', { hits, s: hits !== 1 ? 's' : '' }), 'nuke-toast');
        addLogEntry(t('nuke_log', { hits, misses }), 'log-nuke');
      } else {
        toast(t('incoming_nuke_strike'), 'nuke-toast');
        addLogEntry(t('enemy_nuke_log', { hits }), 'log-nuke');
      }

    } else {
      // ── Standard missile ──
      const { r, c, result } = results[0];
      const targetGrid = isMyShot ? attackGrid : defenseGrid;
      await animateMissile(targetGrid[r][c]);
      applyCellResult(r, c, result, isMyShot, false);

      const coord = `${String.fromCharCode(65 + c)}${r + 1}`;
      if (result === 'hit') {
        shake(false);
        if (isMyShot) {
          toast(t('direct_hit'), 'hit');
          addLogEntry(t('hit_at', { coord }), 'log-hit');
        } else {
          toast(t('ship_was_hit'), 'hit');
          addLogEntry(t('enemy_hit_at', { coord }), 'log-hit');
        }
      } else {
        if (isMyShot) {
          toast(t('miss_splash'), 'miss-toast');
          addLogEntry(t('miss_at', { coord }), 'log-miss');
        } else {
          toast(t('enemy_missed'), 'miss-toast');
          addLogEntry(t('enemy_miss_at', { coord }), 'log-miss');
        }
      }
    }

    // Track stats
    if (isMyShot) {
      stats.shotsFired++;
      stats.hits += results.filter(r => r.result === 'hit').length;
      stats.misses += results.filter(r => r.result === 'miss').length;
      if (weapon === 'nuke') stats.nukesUsed++;
    }
    stats.turnsPlayed++;

    // Track sunk ships
    if (isMyShot && sunkShips) {
      const previousNames = sunkEnemyShips.map(s => s.name);
      sunkEnemyShips = sunkShips;
      renderShipStatus();
      const newlySunk = sunkShips.filter(s => !previousNames.includes(s.name));
      for (const ship of newlySunk) {
        renderSunkShipOutline(ship);
        if (!gameOver) {
          playSunkSound();
          await new Promise(resolve => setTimeout(resolve, 400));
          toast(t('you_sunk_ship', { name: shipName(ship.name) }), 'sunk-toast');
          addLogEntry(t('sunk_log', { name: shipName(ship.name) }), 'log-sunk');
        }
      }
    }

    // Game over
    if (gameOver) {
      await new Promise(resolve => setTimeout(resolve, 800));
      showGameOver(winner === playerIdx);
    }
  }

  function animateMissile(targetCell) {
    return new Promise((resolve) => {
      try {
        const rect = targetCell.getBoundingClientRect();
        const targetX = rect.left + rect.width / 2;
        const targetY = rect.top + rect.height / 2;

        const missile = document.createElement('div');
        missile.className = 'missile-fly';
        // Start from top center of viewport
        missile.style.left = targetX + 'px';
        missile.style.top = '-40px';
        missile.style.setProperty('--target-x', targetX + 'px');
        missile.style.setProperty('--target-y', targetY + 'px');
        document.body.appendChild(missile);

        missile.addEventListener('animationend', () => {
          missile.remove();
          resolve();
        });
        // Safety timeout
        setTimeout(() => { missile.remove(); resolve(); }, 1800);
      } catch (e) {
        resolve();
      }
    });
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
        playIncomingHitSound();
        if (isNuke) spawnNukeParticles(cell); else spawnHitParticles(cell);
      } else {
        playIncomingMissSound();
        addSplashRing(cell);
      }
    }
  }

  // ── Initialize i18n ──
  I18n.init().then(() => {
    updateLangButton();
    updateMuteUI();
  });
})();
