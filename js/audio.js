// Web Audio 로 만드는 간단한 효과음 (외부 파일 없음)
let ctx = null;
let muted = false;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function tone(freq, dur = 0.15, type = "sine", vol = 0.15, when = 0, slide = null) {
  if (muted) return;
  try {
    const c = ac(), t = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur + 0.05);
  } catch (e) { /* 무시 */ }
}

function noise(dur = 0.3, vol = 0.3, when = 0, lp = 800) {
  if (muted) return;
  try {
    const c = ac(), t = c.currentTime + when;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp;
    const g = c.createGain(); g.gain.value = vol;
    src.connect(f).connect(g).connect(c.destination);
    src.start(t);
  } catch (e) { /* 무시 */ }
}

export const sfx = {
  wake() { try { ac(); } catch (e) {} },
  key() { tone(880, 0.04, "square", 0.04); },
  correct() { tone(660, 0.1, "square", 0.07); tone(990, 0.18, "square", 0.07, 0.1); },
  wrong() { tone(150, 0.4, "sawtooth", 0.12, 0, 80); },
  thud() { noise(0.6, 0.9, 0, 180); tone(70, 0.7, "sine", 0.6, 0, 30); },
  lockOpen() { noise(0.08, 0.5, 0, 3000); tone(1400, 0.05, "square", 0.06, 0.06); },
  door() { noise(0.15, 0.5, 0, 2000); tone(200, 0.1, "square", 0.08, 0.05); noise(1.4, 0.25, 0.25, 350); },
  tick() { tone(1300, 0.03, "square", 0.035); },
  alarm() { for (let i = 0; i < 3; i++) tone(520, 0.25, "sawtooth", 0.08, i * 0.35, 380); },
  dial(n) { const f = [941, 697, 697, 697, 770, 770, 770, 852, 852, 852][Number(n)] || 941; tone(f, 0.12, "sine", 0.1); tone(1336, 0.12, "sine", 0.08); },
  ring() { for (let i = 0; i < 2; i++) { tone(440, 0.4, "sine", 0.08, i * 1.0); tone(480, 0.4, "sine", 0.08, i * 1.0); } },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, "triangle", 0.1, i * 0.15)); },
  toggle() { muted = !muted; return muted; },
  get muted() { return muted; },
};
