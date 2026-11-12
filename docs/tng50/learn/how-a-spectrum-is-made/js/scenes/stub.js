// Stub scene: the reference implementation of the scene contract (js/engine.js header) and M1's temporary card for
// S1 to S4: a dark sky, the quasar beam as a warm white line, and the thin spectrum strip flat at 100 % ("all the light
// gets through"). Pure: everything drawn is a function of (state, t, data, env); no clock, no randomness except
// env.noise, no DOM.

export const id = "stub";

export const defaults = {
  beam: 1,          // beam brightness 0..1
  strip: 0,         // spectrum strip opacity 0..1
  dip: 0,           // depth of a demo dip in the strip, 0..1 (0 = flat at 100 %)
  dipV: 0,          // dip position, km/s
  dipB: 20,         // dip width b, km/s
  vRange: 400,      // strip half-range, km/s
  noise: 0,         // noise amplitude on the strip (demonstrates env.noise determinism)
  label: "",        // optional caption drawn on the strip (tests only; real text is DOM)
};
export const interp = {vRange: "log", label: "snap"};

/* frame-independent cache: nothing heavy here; returns a tiny summary so tests can see prepare() ran once */
export async function prepare(data) {
  return {nCells: data && data.ions && data.ions.OVI && Array.isArray(data.ions.OVI.l_kpc) ? data.ions.OVI.l_kpc.length : 0};
}

const SKY = "#05070d", BEAM = "#fff4e0", STRIP = "rgba(255,244,224,0.9)";

export function render(ctx, s, t, data, env) {
  const W = env.width || 1920, H = env.height || 1080;
  ctx.fillStyle = SKY;
  ctx.fillRect(0, 0, W, H);
  // the beam: warm white line across the stage, brightness from state
  const y = Math.round(H * 0.42);
  ctx.globalAlpha = Math.max(0, Math.min(1, s.beam));
  ctx.strokeStyle = BEAM;
  ctx.lineWidth = Math.max(1, H / 540);
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  // the strip: flat line at 100 %, with an optional Gaussian dip
  const a = Math.max(0, Math.min(1, s.strip));
  if (a > 0) {
    const x0 = W * 0.08, x1 = W * 0.92, yTop = H * 0.84, yBot = H * 0.94, n = 200;
    const r = s.noise > 0 ? env.noise("stub") : null;
    ctx.globalAlpha = a;
    ctx.strokeStyle = STRIP;
    ctx.lineWidth = Math.max(1, H / 720);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const v = -s.vRange + 2 * s.vRange * i / n, x = x0 + (x1 - x0) * i / n;
      let F = 1 - s.dip * Math.exp(-(((v - s.dipV) / s.dipB) ** 2));
      if (r) F += s.noise * (r() - 0.5);
      const yy = yBot - (yBot - yTop) * F;
      if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();
    if (s.label) { ctx.fillStyle = STRIP; ctx.font = `${Math.round(H / 54)}px sans-serif`; ctx.fillText(env.text(s.label), x0, yTop - H / 60); }
  }
  ctx.globalAlpha = 1;
}

export default {id, defaults, interp, prepare, render};
