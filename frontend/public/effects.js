// Sounds (generated with Web Audio, no files) and confetti
const Effects = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('hitster:muted') === '1'; } catch (e) {}

  // Browsers only allow audio after a user interaction
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  document.addEventListener('pointerdown', () => { if (!muted) audio(); }, { once: true });

  function tone(freq, start, duration, { type = 'sine', gain = 0.18, slideTo } = {}) {
    const ac = audio();
    if (!ac) return;
    const t0 = ac.currentTime + start;
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  const SOUNDS = {
    correct: () => [523, 659, 784].forEach((f, i) => tone(f, i * 0.09, 0.25, { type: 'triangle' })),
    wrong: () => tone(220, 0, 0.45, { type: 'sawtooth', gain: 0.08, slideTo: 110 }),
    songline: () => { tone(880, 0, 0.12, { type: 'square', gain: 0.07 }); tone(1175, 0.12, 0.2, { type: 'square', gain: 0.07 }); },
    turn: () => { tone(660, 0, 0.12); tone(990, 0.12, 0.18); },
    next: () => tone(440, 0, 0.1, { gain: 0.06 }),
    win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.3, { type: 'triangle' })),
  };

  function sound(name) {
    if (muted || !SOUNDS[name]) return;
    try { SOUNDS[name](); } catch (e) {}
  }

  function setMuted(value) {
    muted = value;
    try { localStorage.setItem('hitster:muted', value ? '1' : '0'); } catch (e) {}
    if (!muted) audio();
  }

  function confetti(count = 150) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    document.body.appendChild(canvas);
    const c = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    c.scale(dpr, dpr);
    const colors = ['#a855f7', '#ec4899', '#fbbf24', '#22c55e', '#3b82f6', '#ffffff'];
    const parts = Array.from({ length: count }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.4,
      y: innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 14 - 4,
      size: 5 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));
    const end = performance.now() + 2800;
    (function frame(now) {
      c.clearRect(0, 0, innerWidth, innerHeight);
      parts.forEach(p => {
        p.vy += 0.35; p.vx *= 0.99;
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.rot);
        c.fillStyle = p.color;
        c.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        c.restore();
      });
      if (now < end) requestAnimationFrame(frame);
      else canvas.remove();
    })(performance.now());
  }

  return { sound, confetti, setMuted, isMuted: () => muted };
})();

function toggleSound() {
  Effects.setMuted(!Effects.isMuted());
  syncSoundButton();
}

function syncSoundButton() {
  const btn = document.getElementById('sound-toggle');
  if (btn) btn.textContent = Effects.isMuted() ? '🔇' : '🔊';
}
window.addEventListener('DOMContentLoaded', syncSoundButton);
