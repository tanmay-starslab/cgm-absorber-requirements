// Equation bindings, number formats and ghost physics for the floating equations (DESIGN_final §5.5 U_eq).
// Pure: no DOM, no time, no Math.random; the same functions run in node (tests, film) and in the page.
//
// A term's binding names where its number comes from (eq/eq.json terms[*].bind):
//   {src: "cell",    field}   data.ions[ion].cells[field][idx]   (nH, T, Z, V, l_kpc, dl_kpc shared; f_ion, logN, b, tau0, a per ion)
//   {src: "atom",    field}   data.ions[ion].atom[field]          (lam0_A, f, gamma_s, mass_amu)
//   {src: "totals",  field}   data.ions[ion].totals[field]
//   {src: "aod",     field}   data.ions[ion].library.aod[field]
//   {src: "spec",    field}   FrameState.spec[field]              (R, sn: overrides already applied by seek)
//   {src: "live",    field}   ctx.live[field] from the spectrum dock (tau_peak, F_min, chi2nu, logNa); optional
//   {src: "derived", fn}      DERIVED[fn](ctx), computed from the sources above only
// "fallback" is tried when the source is missing (and, with when: "totals", only when the anchor is the totals view).
// Every displayed number therefore comes from story data or FrameState (G10); nothing is typed.

export const C_KMS = 299792.458;           // speed of light, km/s
export const K_TAU = 1.4975e-15;            // tau0 = K_TAU N f lambda[A] / b[km/s]  (lines.py, story data conventions)
export const KPC_CM = 3.0856775814913673e21;
const K_B = 1.380649e-16, AMU = 1.66053906660e-24;
const MINUS = "−", THIN = " ";

/** A key of the story data as a number. Keys are pre-formatted strings ("+69.3", "\u221251.6", "3.9\u00d710\u2075",
 *  "5\u00d710\u207b\u2076") or numbers; full-precision values live in data.facts2 and win wherever they exist. */
const SUP = {"\u2070": "0", "\u00b9": "1", "\u00b2": "2", "\u00b3": "3", "\u2074": "4", "\u2075": "5", "\u2076": "6", "\u2077": "7", "\u2078": "8", "\u2079": "9", "\u207b": "-", "\u207a": "+"};
export function num(x) {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string") return null;
  let t = x.replace(/\u2212/g, "-").replace(/[\s\u2009\u202f,]/g, "");
  const m = t.match(/^([+-]?[\d.]+)(?:[\u00d7x]10\^?([\u207a\u207b\u2070-\u2079\u00b9\u00b2\u00b3+-]*\d*))?$/);
  if (!m) return null;
  const e = m[2] ? +[...m[2]].map(c => SUP[c] ?? c).join("") : 0;
  const v = Number(`${m[1]}e${e}`);                         // exact decimal parse (no 1.15 * 10^4 rounding)
  return Number.isFinite(v) ? v : null;
}
/** Full-precision fact from data.facts2 (U_data, story-data/2), else the parsed display key, else null. */
export function fact(data, name) {
  const f = data && data.facts2 && data.facts2[name];
  if (typeof f === "number" && Number.isFinite(f)) return f;
  return data && data.keys ? num(data.keys[name]) : null;
}

/* ------------------------------------------------------------------ physics helpers */
/** Thermal Doppler parameter b = sqrt(2kT/m) in km/s. */
export const doppler = (T, amu) => Math.sqrt(2 * K_B * T / (amu * AMU)) / 1e5;
/** Line-centre optical depth (Doppler core). */
export const tau0Of = (logN, f, lam, b) => K_TAU * 10 ** logN * f * lam / b;
/** logN that gives a line-centre optical depth tau0. */
export const logNOfTau0 = (tau0, f, lam, b) => Math.log10(tau0 * b / (K_TAU * f * lam));
/** Damping parameter a = Gamma lambda / (4 pi b), lambda in A, b in km/s. */
export const dampingA = (gamma, lam, b) => gamma * lam * 1e-8 / (4 * Math.PI * b * 1e5);
/** E4: V = c (lambda/lambda0 - 1) - v_gal (DESIGN_final M2), and its inverse. */
export const vOfLam = (lam, lam0, vgal) => C_KMS * (lam / lam0 - 1) - vgal;
export const lamOfV = (V, lam0, vgal) => lam0 * (1 + (V + vgal) / C_KMS);
/** Galaxy velocity in the E4 sign convention: v_gal = -v_sys of the story data (V there is c(l/l0-1) + v_sys). */
export function vGal(data) {
  const f = data && data.facts2 && data.facts2.v_gal;
  if (typeof f === "number") return f;
  const vs = data && data.meta && data.meta.v_sys_kms;
  if (typeof vs === "number") return -vs;                    // exact; the display key is rounded
  return data && data.keys ? num(data.keys.v_gal) : null;
}

/* ------------------------------------------------------------------ f(O VI) table (data/fion_OVI_slice.json) */
/** log10 f at (log n_H, log T): linear in log T on each slice, then linear in log n_H between the two bracketing
 *  slices (C_science M5: "interpolation in log n_H between the -4.0 and -3.5 slices" for cell 263). log f floored at -9. */
export function fionAt(fion, lognH, logT) {
  const S = fion.logNH_slices, T = fion.logT;
  const onSlice = k => {
    const row = fion.f_slices[k];
    const x = Math.min(Math.max(logT, T[0]), T[T.length - 1]);
    let i = 0; while (i < T.length - 2 && T[i + 1] < x) i++;
    const t = (x - T[i]) / (T[i + 1] - T[i]);
    const lf = v => Math.log10(Math.max(v, 1e-9));
    return lf(row[i]) * (1 - t) + lf(row[i + 1]) * t;
  };
  const y = Math.min(Math.max(lognH, S[0]), S[S.length - 1]);
  let k = 0; while (k < S.length - 2 && S[k + 1] < y) k++;
  const u = (y - S[k]) / (S[k + 1] - S[k]);
  const lf = onSlice(k) * (1 - u) + onSlice(k + 1) * u;
  return lf <= -9 ? 0 : 10 ** lf;
}
/** Half-peak temperatures of f(O VI) at fixed n_H: {cool, peak, hot} in K (the "Too cool"/"Too hot" triggers of B7c).
 *  The exporter's ovi_T_cool_fade / ovi_T_hot_fade (facts2, else keys) win at the n_H they were computed for
 *  (facts2.ovi_T_fade.lognH, cell 263; or any n_H when only keys exist and no lognH is recorded). */
export function fadeTemps(fion, lognH, data = null) {
  const T = fion.logT, f = T.map(t => fionAt(fion, lognH, t));
  let ip = 0; for (let i = 1; i < f.length; i++) if (f[i] > f[ip]) ip = i;
  const half = f[ip] / 2;
  const cross = (i0, step) => {
    for (let i = i0; i + step >= 0 && i + step < f.length; i += step) {
      const a = f[i], b = f[i + step];
      if ((a - half) * (b - half) <= 0 && a !== b) return T[i] + (T[i + step] - T[i]) * (half - a) / (b - a);
    }
    return null;
  };
  const lc = cross(ip, -1), lh = cross(ip, +1);
  const out = {cool: lc == null ? null : 10 ** lc, peak: 10 ** T[ip], hot: lh == null ? null : 10 ** lh, fpeak: f[ip], source: "table"};
  const at = data && data.facts2 && data.facts2.ovi_T_fade && data.facts2.ovi_T_fade.lognH;
  const cool = fact(data, "ovi_T_cool_fade"), hot = fact(data, "ovi_T_hot_fade");
  if (cool != null && hot != null && (typeof at !== "number" || Math.abs(at - lognH) < 1e-6)) {
    out.cool = cool; out.hot = hot; out.source = data.facts2 && typeof data.facts2.ovi_T_hot_fade === "number" ? "facts2" : "keys";
  }
  return out;
}

/* ------------------------------------------------------------------ number formats (KaTeX value spans) */
// formatParts -> {m, e}: m is the mantissa or plain number (null: hidden), e the power of ten (null: "x 10^e" hidden).
// m === null && e !== null renders a pure power "10^e" (column densities, F below 1e-3).
const sgn = s => s.replace(/^-/, MINUS);
function sig(v, n = 3) {
  if (v === 0) return "0";
  const p = Math.floor(Math.log10(Math.abs(v))), d = Math.max(0, n - 1 - p);
  return sgn((Math.round(v * 10 ** d) / 10 ** d).toFixed(d));
}
function grp(v, n = 3) {             // 3 significant figures, thousands grouped with a thin space: 11 500, 287 000
  const p = Math.floor(Math.log10(Math.abs(v))), q = 10 ** Math.max(0, p - n + 1);
  const r = Math.round(v / q) * q;
  if (Math.abs(r) < 1000) return sig(v, n);
  return sgn(String(Math.round(r)).replace(/\B(?=(\d{3})+(?!\d))/g, THIN));
}
function sci(v, n = 3) {
  if (v === 0) return {m: "0", e: null};
  let e = Math.floor(Math.log10(Math.abs(v))), m = v / 10 ** e;
  if (Math.abs(+m.toFixed(n - 1)) >= 10) { e += 1; m /= 10; }
  return {m: sgn(m.toFixed(n - 1)), e: sgn(String(e))};
}
export const FORMATS = {
  sig3: v => (v !== 0 && (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-2) ? sci(v) : {m: Math.abs(v) >= 1000 ? grp(v) : sig(v), e: null}),
  grp: v => (Math.abs(v) >= 1e7 ? sci(v) : {m: grp(v), e: null}),
  sci3: v => sci(v),
  pow2: v => ({m: null, e: sgn(v.toFixed(2))}),                         // v is log10
  fix1s: v => ({m: (v > 0 ? "+" : "") + sgn(v.toFixed(1)), e: null}),
  fix2: v => ({m: sgn(v.toFixed(2)), e: null}),
  fix3: v => ({m: sgn(v.toFixed(3)), e: null}),
  // transmission from optical depth (no underflow): F = e^-tau, shown as 0.523 or 10^-9868
  F: tau => { const lf = -tau / Math.LN10; return lf >= -3 ? {m: (10 ** lf).toFixed(3), e: null} : {m: null, e: sgn(String(Math.round(lf)))}; },
};
export function formatParts(v, fmt) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = FORMATS[fmt]; if (!f) throw new Error(`unknown format ${fmt}`);
  return f(v);
}
/** Plain text of a formatted value for spoken labels and aria-valuetext ("1.15 times ten to the 4"). */
export function spokenValue(v, fmt) {
  const p = formatParts(v, fmt); if (!p) return "not available";
  const m = p.m == null ? null : p.m.replace(MINUS, "minus ").replace(new RegExp(THIN, "g"), "");
  const e = p.e == null ? null : p.e.replace(MINUS, "minus ");
  if (m != null && e != null) return `${m} times ten to the ${e}`;
  if (e != null) return `ten to the ${e}`;
  return m;
}

/* ------------------------------------------------------------------ binding resolution */
const dig = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
/** Context of one equation in one frame: {data, ion, idx, spec, live, anchorKind, ghost} (ghost from ghostCell). */
export function cellField(ctx, field) {
  const g = ctx.ghost && ctx.ghost.cell;
  if (g && field in g) return g[field];
  const c = dig(ctx.data, `ions.${ctx.ion}.cells.${field}`);
  return Array.isArray(c) && ctx.idx != null ? c[ctx.idx] : undefined;
}
export const DERIVED = {
  // n_ion = N / dl (identical to n_H (O/H)sun Z f for O VI and x_HI n_H for H I in the exporter; R_content §3 E1)
  n_ion: ctx => { const lN = cellField(ctx, "logN"), dl = cellField(ctx, "dl_kpc"); return lN == null || !dl ? undefined : 10 ** lN / (dl * KPC_CM); },
  // the other ion's width at the same T (E2 ghost line "O VI at the same T: 3.45 km/s"): b scales as 1/sqrt(m)
  b_alt: ctx => {
    const other = ctx.ion === "HI" ? "OVI" : "HI";
    const b = cellField(ctx, "b"), m = dig(ctx.data, `ions.${ctx.ion}.atom.mass_amu`), mo = dig(ctx.data, `ions.${other}.atom.mass_amu`);
    return b == null || !m || !mo ? undefined : b * Math.sqrt(m / mo);
  },
  lam_obs: ctx => { const V = cellField(ctx, "V"), l0 = dig(ctx.data, `ions.${ctx.ion}.atom.lam0_A`), vg = vGal(ctx.data); return V == null || !l0 || vg == null ? undefined : lamOfV(V, l0, vg); },
  v_gal: ctx => vGal(ctx.data) ?? undefined,
  F_min: ctx => resolve({src: "live", field: "tau_peak", fallback: {src: "totals", field: "peak_tau", when: "totals"}}, ctx),
  fwhm: ctx => { const R = ctx.spec && ctx.spec.R; return R ? C_KMS / R : undefined; },
  sigma_pix: ctx => { const sn = ctx.spec && ctx.spec.sn; return sn ? Math.sqrt(5) / sn : undefined; },
};
/** Inputs each derived binding reads (the test checks that every one resolves on the story data). */
export const DERIVED_INPUTS = {
  n_ion: [["cell", "logN"], ["cell", "dl_kpc"]], b_alt: [["cell", "b"], ["atom", "mass_amu"]],
  lam_obs: [["cell", "V"], ["atom", "lam0_A"], ["meta", "v_sys_kms"]], v_gal: [["meta", "v_sys_kms"]],
  F_min: [["totals", "peak_tau"]], fwhm: [["spec", "R"]], sigma_pix: [["spec", "sn"]],
};
export function resolve(b, ctx) {
  if (!b) return undefined;
  let v;
  switch (b.src) {
    case "cell": v = cellField(ctx, b.field); break;
    case "atom": v = dig(ctx.data, `ions.${ctx.ion}.atom.${b.field}`); break;
    case "totals": v = (b.when === "totals" && ctx.anchorKind !== "totals") ? undefined : dig(ctx.data, `ions.${ctx.ion}.totals.${b.field}`); break;
    case "aod": v = dig(ctx.data, `ions.${ctx.ion}.library.aod.${b.field}`); break;
    case "spec": v = ctx.spec ? ctx.spec[b.field] : undefined; break;
    case "live": v = ctx.live ? ctx.live[b.field] : undefined; break;
    case "derived": v = DERIVED[b.fn] ? DERIVED[b.fn](ctx) : undefined; break;
    default: throw new Error(`unknown binding source ${b.src}`);
  }
  if ((v == null || !Number.isFinite(v)) && b.fallback) return resolve(b.fallback, ctx);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
/** All bound values of one equation: {termId: number | undefined}. Ghost values replace the dragged term and every
 *  value derived from the ghost cell. */
export function termValues(eqDef, ctx) {
  const out = {};
  for (const [id, t] of Object.entries(eqDef.terms)) out[id] = t.bind ? resolve(t.bind, ctx) : undefined;
  const g = ctx.ghost;
  if (g && g.eq === eqDef.id && g.term in eqDef.terms && g.display != null) out[g.term] = g.display;
  return out;
}

/* ------------------------------------------------------------------ sliders (draggable terms) */
/** Slider range of a draggable term for this cell: {scale, min, max, step, big, now} in the slider's own units
 *  (log10 of the value for log scales, the value itself for lin). null when the term is not draggable here. */
export function sliderSpec(eqDef, termId, ctx) {
  const t = eqDef.terms[termId]; if (!t || !t.drag) return null;
  if (t.ions && !t.ions.includes(ctx.ion)) return null;
  const d = t.drag, cur = resolve(t.bind, {...ctx, ghost: null});
  if (cur == null) return null;
  let min, max, now;
  if (d.scale === "log10value") {           // the value is already log10 (column density)
    [min, max] = d.ion[ctx.ion] || [cur - 3, cur + 3]; now = cur;
  } else if (d.scale === "log") {
    now = Math.log10(cur);
    if (d.via === "N") {                     // tau0 term: dragging tau0 moves N
      const N = eqDef.terms.N.drag.ion[ctx.ion]; const off = now - cellField({...ctx, ghost: null}, "logN");
      [min, max] = [N[0] + off, N[1] + off];
    } else if (d.rel) [min, max] = [now + Math.log10(d.rel[0]), now + Math.log10(d.rel[1])];
    else [min, max] = [Math.log10(d.abs[0]), Math.log10(d.abs[1])];
  } else {
    now = cur;
    const base = d.via === "V" ? cellField({...ctx, ghost: null}, "V") : cur;
    [min, max] = [base + d.rel[0], base + d.rel[1]];
    if (d.clamp) { min = Math.max(min, d.clamp[0]); max = Math.min(max, d.clamp[1]); }
    if (d.via === "V") {                     // the slider moves V; the term shows lambda
      now = base;
    }
  }
  now = Math.min(Math.max(now, min), max);
  return {scale: d.scale, min, max, step: d.step, big: d.big, now, via: d.via || null, override: t.override || null};
}
/** Slider units -> physical value of the term (what the equation displays). */
export function sliderToValue(spec, s, ctx) {
  if (spec.scale === "log") return 10 ** s;
  if (spec.via === "V") { const l0 = dig(ctx.data, `ions.${ctx.ion}.atom.lam0_A`); return lamOfV(s, l0, vGal(ctx.data)); }
  return s;
}

/* ------------------------------------------------------------------ ghosts (never mutate data) */
/** Ghost copy of a cell after a term drag. Returns {eq, term, ion, idx, display, cell: {logN, b, V, tau0, a, T, ...},
 *  wings, regime, fades, notes}. `s` is in slider units (sliderSpec). The real data are never written. */
export function ghostCell(data, fion, {eq, term, ion, idx, s, spec}) {
  const ctx = {data, ion, idx, ghost: null};
  const base = {};
  for (const f of ["logN", "b", "V", "tau0", "a", "T", "nH", "Z", "dl_kpc", "f_ion"]) base[f] = cellField(ctx, f);
  const atom = dig(data, `ions.${ion}.atom`) || {};
  const cell = {...base}, notes = [];
  let display = null, regime = null, fades = null;
  const T = base.T;
  switch (`${eq}.${term}`) {
    case "E1.dl": { const dl = 10 ** s; cell.dl_kpc = dl; cell.logN = base.logN + Math.log10(dl / base.dl_kpc); display = dl; break; }
    case "E1.Z": { const Z = 10 ** s; cell.Z = Z; cell.logN = base.logN + Math.log10(Z / base.Z); display = Z; break; }
    case "E2.T": {
      const T2 = 10 ** s; cell.T = T2; cell.b = base.b * Math.sqrt(T2 / T); display = T2;
      if (ion === "OVI" && fion) {
        const lnH = Math.log10(base.nH), f1 = fionAt(fion, lnH, Math.log10(T)), f2 = fionAt(fion, lnH, s);
        if (f1 > 0) { cell.f_ion = base.f_ion * f2 / f1; cell.logN = f2 > 0 ? base.logN + Math.log10(f2 / f1) : -Infinity; }
        fades = fadeTemps(fion, lnH, data);
        regime = fades.hot != null && T2 > fades.hot ? "hot" : fades.cool != null && T2 < fades.cool ? "cool" : null;
        notes.push("n_H and Z held fixed");
      } else notes.push("H I fraction held fixed");
      break;
    }
    case "E3.N": cell.logN = s; display = s; break;
    case "E3.tau0": cell.logN = logNOfTau0(10 ** s, atom.f, atom.lam0_A, base.b); display = 10 ** s; break;
    case "E3b.V": cell.V = s; display = s; break;
    case "E4.lam": cell.V = s; display = lamOfV(s, atom.lam0_A, vGal(data)); break;
    default: throw new Error(`no ghost for ${eq}.${term}`);
  }
  if (cell.b !== base.b) cell.a = dampingA(atom.gamma_s, atom.lam0_A, cell.b);
  if (cell.logN !== base.logN || cell.b !== base.b) cell.tau0 = Number.isFinite(cell.logN) ? base.tau0 * 10 ** (cell.logN - base.logN) * base.b / cell.b : 0;
  return {eq, term, ion, idx, s, display, cell, wings: Number.isFinite(cell.logN) && cell.logN > 18.5, regime, fades, notes,
    marker: eq === "E4" ? {V: cell.V} : null};
}
/** Named overrides of the frozen interface (DESIGN_final §5.11) a ghost maps to, if any: T125, T263, N492. */
export function namedOverride(g) {
  if (!g) return null;
  if (g.eq === "E2" && g.term === "T" && (g.idx === 125 || g.idx === 263)) return {key: `T${g.idx}`, value: g.cell.T};
  if (g.eq === "E3" && (g.term === "N" || g.term === "tau0") && g.idx === 492) return {key: "N492", value: g.cell.logN};
  return null;
}

/* ------------------------------------------------------------------ spoken form */
export function spoken(template, eqDef, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => spokenValue(values[k], (eqDef.terms[k] || {}).fmt || "sig3"));
}
