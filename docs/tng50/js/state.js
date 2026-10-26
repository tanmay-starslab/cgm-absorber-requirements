// Pure page state for the TNG50 explorer (Phase-3 design §6.3 to §6.5): the registry view of CFG, the instrument
// cases, the slider mappings, the v3 URL hash (v2 hashes still parse) and setInstrument validation. No DOM, so the
// node tests (tests/js/ui_static.mjs) import it directly.

export const LAYOUTS = ["1", "2R", "2SN", "4"];
export const LAYOUT_LABEL = {"1": "1", "2R": "2 R", "2SN": "2 S/N", "4": "2×2"};
export const LAYOUT_TITLE = {"1": "One case: one R and one S/N", "2R": "Two R at one S/N", "2SN": "Two S/N at one R",
  "4": "Two R by two S/N"};
export const ID_RE = /^((face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?|cust_[0-9a-f]{10})$/;
export const PAGE_LAYOUT = "1";                 // owner's decision (pick.md): the page opens on one large case

/* CFG v3 -> {IONS, ION, KEYS, BANDS, BAND_KEYS, SNR, DEF}. Missing pieces give an empty registry (bare template). */
export function makeRegistry(cfg) {
  const IONS = Array.isArray(cfg.ions) ? cfg.ions.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [];
  /* B_fix R2: null-prototype maps, so a hash or bridge key such as "toString" or "constructor" is unknown, not an
     inherited function */
  const ION = Object.assign(Object.create(null), Object.fromEntries(IONS.map(i => [i.key, i]))), KEYS = IONS.map(i => i.key);
  const BANDS = Object.assign(Object.create(null), cfg.bands || {}), BAND_KEYS = Object.keys(BANDS);
  const SNR = Object.assign({min: 2, max: 100, default: 10, pair: [20, 5]}, cfg.snr || {});
  const d = cfg.defaults || {};
  const R = {}; for (const b of BAND_KEYS) { const r = (d.R || {})[b] || BANDS[b].R.pair || [BANDS[b].R.default, BANDS[b].R.default]; R[b] = [r[0], r[1] ?? r[0]]; }
  const ions = (d.ions || []).filter(k => ION[k]);
  const DEF = {id: d.id || null, ions: ions.length ? ions : KEYS.slice(0, 5), layout: LAYOUTS.includes(d.layout) ? d.layout : PAGE_LAYOUT,
    R, sn: (d.sn || SNR.pair).slice(0, 2), vc: +d.vc || 0, vhw: +d.vhw || 400, seed: +d.seed || 0, intr: !!d.intrinsic, fit: !!d.fit, tab: "spectra"};
  return {IONS, ION, KEYS, BANDS, BAND_KEYS, SNR, DEF};
}
export const cloneState = s => JSON.parse(JSON.stringify(s));

/* B_fix M1: a fitted component whose errors leave it unconstrained is drawn with a hollow tick and named as such in
   the readout, like a component on a bound. C2: the same rule as fit.js fitQuality "unconstrained" (no covariance or
   NOERR, or sigma(log N) above 1 dex); a large sigma(b) alone no longer counts, since an unresolved component has a
   loose b but a well measured column (B_retest item 3). Only used when fit.js does not export fitQuality. */
export const LOOSE_DEX = 1;
export function fitLoose(c) {
  if (!c) return false;
  return !!((+c.flag || 0) & 32) || !Number.isFinite(c.dlogN) || c.dlogN > LOOSE_DEX;
}

/* ---- lower limits (Phase-3 owner decision 2; tngsight/search.py is the reference and tests/search_golden.json
   fixes the rule). A saturated or degenerate catalogue component, flag NOERR, or SAT without DAMPED, on any ion, is
   never a measurement: its column is the lower limit min(logN, logN_lo). annotateLimits gives logN_lo: the AOD
   column of the component's fit region minus the region's measured components, shared among the region's limits in
   proportion to their fitted N, so the limits of a region never add up to more than its exact column. ---- */
export const FLAG = {SAT: 1, BOUND: 2, MAXCOMP: 4, POORFIT: 8, EDGE: 16, NOERR: 32, DAMPED: 64, BUDGET: 128};
const isNum = x => typeof x === "number" && Number.isFinite(x);
const roundAway = (x, d) => { const p = 10 ** d; return Math.sign(x) * Math.floor(Math.abs(x) * p + 0.5) / p + 0; };
export function isLowerLimit(c) {
  const f = c ? +c.flag || 0 : 0;
  return !!(f & FLAG.NOERR) || (!!(f & FLAG.SAT) && !(f & FLAG.DAMPED));
}
export const limitLogN = c => (isNum(c.logN_lo) ? Math.min(c.logN, c.logN_lo) : c.logN);
export const columnOf = c => (isLowerLimit(c) ? limitLogN(c) : c.logN);
/* the share rule on one group (a fit region, or a fit window): total log column A, comps, isLim(c) -> Map(limit ->
   logN_lo). pool = N - M when positive (N = 10^A, M = the measured components), else N W / (W + M) (W = the limits) */
export function shareLimits(A, comps, isLim) {
  const out = new Map(); if (!isNum(A)) return out;
  let M = 0, W = 0; for (const c of comps) if (isNum(c.logN)) { if (isLim(c)) W += 10 ** c.logN; else M += 10 ** c.logN; }
  if (!(W > 0)) return out;
  const N = 10 ** A, pool = N - M > 0 ? N - M : N * W / (W + M), lp = Math.log10(pool), lw = Math.log10(W);
  for (const c of comps) if (isLim(c) && isNum(c.logN)) out.set(c, lp + c.logN - lw);
  return out;
}
/* {ion: [component]} + the sightline's components.json aod {ion: [total, [[region, v_lo, v_hi, logN_aod], ...]]} ->
   new dicts, each lower limit with logN_lo (3 decimals). Mirror of tngsight.search.annotate_limits. */
export function annotateLimits(comps, aod) {
  const out = {};
  for (const [k, lst] of Object.entries(comps || {})) {
    if (!Array.isArray(lst)) continue;
    const reg = new Map(), ent = aod && aod[k];
    for (const g of (Array.isArray(ent) && Array.isArray(ent[1]) ? ent[1] : []))
      if (Array.isArray(g) && g.length >= 4 && isNum(g[3]) && isNum(g[0])) reg.set(g[0], g[3]);
    const res = lst.map(c => Object.assign({}, c)), by = new Map();
    for (const c of res) if (reg.has(c.region)) { if (!by.has(c.region)) by.set(c.region, []); by.get(c.region).push(c); }
    for (const [r, group] of by) for (const [c, lo] of shareLimits(reg.get(r), group, isLowerLimit)) c.logN_lo = roundAway(lo, 3);
    out[k] = res;
  }
  return out;
}
/* AOD column (log10 cm^-2) of degraded data d {v, flux, dvp, sigma} over [lo, hi] km/s for a line (lam0 in A, f):
   tau = -ln max(F, floor), floor = max(sigma per pixel, 0.01), so a saturated trough gives a lower bound
   (Savage and Sembach 1991). NaN without data or absorption. */
export function aodLogN(d, lo, hi, lam0, f) {
  if (!d || !d.v || !(lam0 > 0) || !(f > 0)) return NaN;
  const fl = Math.max(0.01, isNum(d.sigma) ? d.sigma : 0.01); let s = 0;
  for (let i = 0; i < d.v.length; i++) if (d.v[i] >= lo && d.v[i] <= hi) s -= Math.log(Math.max(fl, d.flux[i]));
  const N = 3.7679e14 / (f * lam0) * s * d.dvp;
  return N > 0 ? Math.log10(N) : NaN;
}
/* How a fitted (browser) component reads -> {limit, loose, hollow, tags}. q is fit.js fitQuality(c) ("ok", "sat",
   "unconstrained" or "bound") when the fit module exports it, else null; then the same flag rule applies here: SAT
   without DAMPED is a lower limit, except a saturated fit of the damped ion (H I) at log N >= DAMPED_LOGN that kept its
   errors (its wings measure N). Flags are named after the value: sat, bound, time cap, poor fit, unconstrained. */
export const DAMPED_LOGN = 19;
export function fitClass(c, damped, q) {
  const f = c ? +c.flag || 0 : 0, tags = [];
  const limit = typeof q === "string" ? q === "sat"
    : !!(f & FLAG.SAT) && !(f & FLAG.DAMPED) && !(damped && c.logN >= DAMPED_LOGN && isNum(c.dlogN) && !(f & FLAG.NOERR));
  const loose = !limit && (typeof q === "string" ? q === "unconstrained" : fitLoose(c));
  if (limit) tags.push("sat");
  if (f & FLAG.BOUND) tags.push("bound");
  if (f & FLAG.BUDGET) tags.push("time cap");
  if (f & FLAG.POORFIT) tags.push("poor fit");
  if (loose) tags.push("unconstrained");
  return {limit, loose, hollow: !limit && (loose || !!(f & (FLAG.BOUND | FLAG.BUDGET)) || q === "bound"), tags};
}
/* lower limits of a browser fit result r on its data d: per fit window, the AOD of the data (aodLogN) is shared by
   the window's limits like annotateLimits. -> Map(component -> min(logN, share)); ION entry A gives lam0_A and f */
export function fitLimits(r, d, A, isLim) {
  const out = new Map(), comps = (r && r.comps) || [];
  for (const [a, b] of (r && r.windows) || []) {
    const inW = comps.filter(c => c.v >= a && c.v <= b); if (!inW.some(isLim)) continue;
    for (const [c, lo] of shareLimits(aodLogN(d, a, b, A && A.lam0_A, A && A.f), inW, isLim)) if (!out.has(c)) out.set(c, Math.min(c.logN, lo));
  }
  for (const c of comps) if (isLim(c) && !out.has(c)) out.set(c, c.logN);
  return out;
}

/* cases in column order: [R index, S/N index] (§6.3 table) */
export function casesFor(layout) {
  return layout === "2R" ? [[0, 0], [1, 0]] : layout === "2SN" ? [[0, 0], [0, 1]] : layout === "4" ? [[0, 0], [1, 0], [0, 1], [1, 1]] : [[0, 0]];
}
export const twoR = layout => layout === "2R" || layout === "4";
export const twoSN = layout => layout === "2SN" || layout === "4";
/* bands of the given ions, in registry band order */
export function bandsOf(reg, ions) { const s = new Set(ions.map(k => reg.ION[k]?.band).filter(Boolean)); return reg.BAND_KEYS.filter(b => s.has(b)); }

/* ---- slider mappings ---- */
export const SLIDER_MAX = 1000;
export function sig2(x) { if (!(x > 0)) return x; const p = Math.pow(10, Math.floor(Math.log10(x)) - 1); return Math.round(Math.round(x / p) * p); }
export function rToT(range, R) { const a = Math.log10(range.min), b = Math.log10(range.max);
  return Math.max(0, Math.min(SLIDER_MAX, Math.round(SLIDER_MAX * (Math.log10(R) - a) / (b - a)))); }
export function tToR(range, t) { if (t <= 0) return range.min; if (t >= SLIDER_MAX) return range.max;
  const a = Math.log10(range.min), b = Math.log10(range.max);
  return Math.min(range.max, Math.max(range.min, sig2(Math.pow(10, a + t / SLIDER_MAX * (b - a))))); }
/* S/N: log mapping, integers min..max, unique stops (index = slider value) */
export function snStops(min = 2, max = 100, n = 400) { const s = new Set();
  for (let i = 0; i <= n; i++) s.add(Math.round(Math.pow(10, Math.log10(min) + i / n * (Math.log10(max) - Math.log10(min)))));
  return [...s].sort((a, b) => a - b); }
export function snToT(stops, sn) { let i = stops.indexOf(sn); if (i < 0) i = stops.findIndex(x => x >= sn); return i < 0 ? stops.length - 1 : i; }
/* velocity half-window: log mapping 10..vmax, integer km/s */
export const VHW_MIN = 10;
export const vToT = (v, vmax) => vmax <= VHW_MIN ? 0 : Math.max(0, Math.min(SLIDER_MAX, Math.round(SLIDER_MAX * Math.log(v / VHW_MIN) / Math.log(vmax / VHW_MIN))));
export const tToV = (t, vmax) => Math.max(VHW_MIN, Math.min(Math.round(vmax), Math.round(VHW_MIN * Math.pow(vmax / VHW_MIN, t / SLIDER_MAX))));
/* the window [vc - vhw, vc + vhw] stays inside [-vmax, vmax]; vhw integer in [10, vmax] */
export function clampView(S, vmax) {
  const vm = Math.max(VHW_MIN, vmax || 1500);
  S.vhw = Math.round(Math.min(vm, Math.max(VHW_MIN, +S.vhw || VHW_MIN)));
  const lim = vm - S.vhw; S.vc = Math.min(lim, Math.max(-lim, +S.vc || 0)); if (Object.is(S.vc, -0)) S.vc = 0;
  return S;
}

/* ---- number formatting for UI text (no dot separators; U+2212 for negatives) ---- */
export const nf = new Intl.NumberFormat("en-US");
export const minus = x => (x < 0 ? "−" : "") + Math.abs(x);
export const fmtR = R => nf.format(R);
export function fmtNum(x, d = 0) { if (!Number.isFinite(x)) return "–"; const s = Math.abs(x).toFixed(d); return (x < 0 && +s !== 0 ? "−" : "") + s; }

/* ---- URL hash v3 (§6.4) ---- */
const clampI = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.round(x)));
export function parseHash(hash, reg, S) {
  const h = new URLSearchParams(String(hash || "").replace(/^#/, "")), out = cloneState(S);
  const nums = x => String(x || "").split(",").map(t => t.trim()).filter(t => t !== "").map(Number).filter(Number.isFinite);
  const id = h.get("id"); if (id && ID_RE.test(id)) out.id = id;
  if (h.has("ions")) { const l = [...new Set(h.get("ions").split(",").map(s => s.trim()).filter(k => reg.ION[k]))];
    out.ions = l.length ? reg.KEYS.filter(k => l.includes(k)) : reg.DEF.ions.slice(); }
  if (LAYOUTS.includes(h.get("lay"))) out.layout = h.get("lay");
  const Rs = h.get("R");
  if (Rs && Rs.includes(":")) {
    for (const part of Rs.split(";")) { const [b, v] = part.split(":"); const B = reg.BANDS[b]; if (!B || !v) continue;
      const r = nums(v); if (!r.length) continue;
      out.R[b] = [clampI(r[0], B.R.min, B.R.max), clampI(r[1] ?? out.R[b][1], B.R.min, B.R.max)]; }
  } else if (Rs) {                                         // legacy v2: R=20000,40000 -> uv band
    const B = reg.BANDS.uv, r = nums(Rs);
    if (B && r.length) out.R.uv = [clampI(r[0], B.R.min, B.R.max), clampI(r[1] ?? r[0], B.R.min, B.R.max)];
  }
  const sn = nums(h.get("sn"));
  if (sn.length) out.sn = [clampI(sn[0], reg.SNR.min, reg.SNR.max), clampI(sn[1] ?? out.sn[1], reg.SNR.min, reg.SNR.max)];
  const vw = h.get("vw") ? +h.get("vw") : h.get("v") ? +h.get("v") : NaN;   // v: legacy half-window
  if (Number.isFinite(vw)) out.vhw = Math.round(vw);
  if (h.get("vc") && Number.isFinite(+h.get("vc"))) out.vc = +h.get("vc");
  const sd = +h.get("seed"); if (h.has("seed") && Number.isInteger(sd) && sd >= 0) out.seed = sd % 100000;
  if (h.has("fit")) out.fit = h.get("fit") === "1";
  if (h.has("intr")) out.intr = h.get("intr") === "1";
  out.tab = h.get("tab") === "3d" ? "3d" : "spectra";
  return out;
}
export function formatHash(S, idOverride) {
  const R = Object.entries(S.R).map(([b, r]) => `${b}:${r[0]},${r[1]}`).join(";");
  return `id=${idOverride || S.id || ""}&ions=${S.ions.join(",")}&lay=${S.layout}&R=${R}&sn=${S.sn[0]},${S.sn[1]}` +
    `&vc=${Math.round(S.vc)}&vw=${Math.round(S.vhw)}&seed=${S.seed}&fit=${S.fit ? 1 : 0}&intr=${S.intr ? 1 : 0}${S.tab === "3d" ? "&tab=3d" : ""}`;
}

/* ---- setInstrument v3 (§6.5): validate everything first, then return the patch; RangeError names the field ---- */
const isInt = x => Number.isInteger(x);
export function instrumentPatch(o, reg, S, vmaxFor) {
  if (o == null || typeof o !== "object") throw new RangeError("setInstrument takes an object");
  const known = ["R", "snr", "layout", "ions", "vhw", "vc", "fit"];
  for (const k of Object.keys(o)) if (!known.includes(k)) throw new RangeError(`${k}: unknown field (allowed: ${known.join(", ")})`);
  const P = {};
  if (o.R !== undefined) {
    if (o.R == null || typeof o.R !== "object" || Array.isArray(o.R)) throw new RangeError("R: must be an object {band: R or [R1, R2]}");
    P.R = cloneState(S.R);
    for (const [b, v] of Object.entries(o.R)) { const B = reg.BANDS[b];
      if (!B) throw new RangeError(`R: unknown band ${b} (allowed: ${reg.BAND_KEYS.join(", ")})`);
      const ok = x => isInt(x) && x >= B.R.min && x <= B.R.max, rng = `integers ${B.R.min} to ${B.R.max}`;
      if (Array.isArray(v)) { if (v.length !== 2 || !v.every(ok)) throw new RangeError(`R.${b}: must be one or two ${rng}`); P.R[b] = [v[0], v[1]]; }
      else { if (!ok(v)) throw new RangeError(`R.${b}: must be one of the ${rng}`); P.R[b] = [v, P.R[b][1]]; } }
  }
  if (o.snr !== undefined) { const ok = x => isInt(x) && x >= reg.SNR.min && x <= reg.SNR.max, rng = `integers ${reg.SNR.min} to ${reg.SNR.max}`;
    if (Array.isArray(o.snr)) { if (o.snr.length !== 2 || !o.snr.every(ok)) throw new RangeError(`snr: must be one or two ${rng}`); P.sn = o.snr.slice(); }
    else { if (!ok(o.snr)) throw new RangeError(`snr: must be ${rng}`); P.sn = [o.snr, S.sn[1]]; } }
  if (o.layout !== undefined) { if (!LAYOUTS.includes(o.layout)) throw new RangeError(`layout: must be one of ${LAYOUTS.join(", ")}`); P.layout = o.layout; }
  if (o.ions !== undefined) {
    if (!Array.isArray(o.ions) || !o.ions.length) throw new RangeError(`ions: must be a non-empty list of ${reg.KEYS.join(", ")}`);
    for (const k of o.ions) if (!reg.ION[k]) throw new RangeError(`ions: unknown ion ${k} (allowed: ${reg.KEYS.join(", ")})`);
    if (new Set(o.ions).size !== o.ions.length) throw new RangeError("ions: each ion at most once");
    P.ions = reg.KEYS.filter(k => o.ions.includes(k));     // registry order
  }
  const vmax = vmaxFor(P.ions || S.ions);
  if (o.vhw !== undefined && !(isInt(o.vhw) && o.vhw >= VHW_MIN && o.vhw <= vmax)) throw new RangeError(`vhw: must be an integer from ${VHW_MIN} to ${Math.round(vmax)}`);
  if (o.vhw !== undefined) P.vhw = o.vhw;
  if (o.vc !== undefined) { const hw = P.vhw ?? Math.min(S.vhw, vmax);
    if (!(typeof o.vc === "number" && Number.isFinite(o.vc) && Math.abs(o.vc) + hw <= vmax + 1e-9))
      throw new RangeError(`vc: must keep the window inside ±${Math.round(vmax)} km/s (|vc| <= ${Math.round(vmax - hw)} for a half-window of ${hw})`);
    P.vc = o.vc; }
  if (o.fit !== undefined) { if (typeof o.fit !== "boolean") throw new RangeError("fit: must be true or false"); P.fit = o.fit; }
  return P;
}
