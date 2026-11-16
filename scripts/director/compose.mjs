// Director step 1-3 and 10-11 (DESIGN_tierA §6.2): skeleton, l-windows, timing, p ranges, visual-state continuity, the
// per-story TF block and the film plan. Pure and deterministic: no Date, no randomness, fixed iteration order.
//
//   sequence(S, caseCfg)            -> {items: [{id, kind, l0, l1, cell?}], letters, log}   the ordered on-beats with l-windows
//   readSeconds(beats, copy, ctx)   -> {beatId: {read_s, words, lines}}                   words of the active copy lines
//   allocate(items, opts)           -> watch_s per beat (base_s, flex shared by w, cap)
//   buildBeats(S, caseCfg, tpl, T)  -> {doc, log}                                         story-beats/3 document
//   tfBlock(S, beatsDoc)            -> meta.tf
//   filmPlan(S, caseCfg, doc)       -> films/<id>.json
//
// S is the story context built by story_director.mjs: {id, data, half, lStart, lead, flags, caseId, copy, lookup, ...}.
import {deriveTFBlock, galaxyVolWindow} from "../../tests/js/story_g11.mjs";   // fix2: the empty halo TF (R4 block)

export const KIND_BASE = Object.freeze({gate: 6, hold: 8, flight: 6, stop: 10, still: 12});
export const WPS = 3.0, LINE_PAD = 1.5, BEAT_CAP = 40;
/* minimum p width of the long camera moves: the hero's own (B3 dive 0.059, B11 pull-out 0.06); B10w and B7p, which the hero
   lacks, are side moves of the same size as the B11 pull-out: B7p 0.06, B10w 0.05, so the dolly into the tableau settles by mid-beat */
export const P_MIN = Object.freeze({B3: 0.059, B11: 0.06, B10w: 0.05, B7p: 0.06});
export const FLIGHT_KPC_PER_P = 1350;
const r3 = x => Math.round(x * 1000) / 1000;
const r6 = x => Math.round(x * 1e6) / 1e6;

/* ---------------------------------------------------------------- data access */
/* cells of an ion sorted by kernel centre lc: {l, tau0, N, V, T} (story-data/2 geometry.cells.lc order = ions.*.cells order) */
/* sorted log n of H I and O VI over the story tube's cells (story-tube/1, decoded by the page's own tube.js) */
export async function tubeSorted(root, dataFile, data) {
  const t = data.tube; if (!t || !t.path) return null;
  const {readFileSync, existsSync} = await import("node:fs"), {gunzipSync} = await import("node:zlib"), {join, dirname} = await import("node:path"), {pathToFileURL} = await import("node:url");
  // tube.path is relative to the page's data/ folder; the data file sits in data/ or data/v3/ (or a build's out/ dir)
  const bases = [dirname(dataFile), dirname(dirname(dataFile)), join(root, "data")];
  const rels = [t.path, t.path.replace(/^v3\//, "")];
  const bin = bases.flatMap(b => rels.map(r => join(b, r))).find(f => existsSync(f)); if (!bin) return null;
  const hdrF = bin.replace(/\.bin\.gz$/, ".json"); if (!existsSync(hdrF)) return null;
  const T = await import(pathToFileURL(join(root, "js/stage/tube.js")).href);
  const buf = gunzipSync(readFileSync(bin)), dec = T.decodeStoryTube(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), JSON.parse(readFileSync(hdrF, "utf8")));
  return {HI: Float64Array.from(dec.nHI).sort(), OVI: Float64Array.from(dec.nOVI).sort()};
}
export function ionCells(data, ion) {
  const ic = data.ions && data.ions[ion] && data.ions[ion].cells, g = data.geometry && data.geometry.cells;
  if (!ic || !g) return {n: 0, l: [], tau0: [], N: [], V: [], T: []};
  const lc = g.lc, n = Math.min(lc.length, (ic.tau0 || []).length);
  const order = [...Array(n).keys()].sort((a, b) => lc[a] - lc[b] || a - b);
  const pick = arr => order.map(i => +(arr ? arr[i] : NaN));
  return {n, l: pick(lc), tau0: pick(ic.tau0), N: ic.logN ? order.map(i => Math.pow(10, +ic.logN[i])) : pick(null),
          V: pick(ic.V), T: pick(ic.T), idx: order.map(i => g.idx ? g.idx[i] : i)};
}
export function tauSum(C, l0, l1) { let s = 0; for (let j = 0; j < C.n; j++) if (C.l[j] >= l0 && C.l[j] <= l1) s += C.tau0[j]; return s; }
export function tauPeak(C, l0, l1) { let s = 0; for (let j = 0; j < C.n; j++) if (C.l[j] >= l0 && C.l[j] <= l1) s = Math.max(s, C.tau0[j]); return s; }
export function colFrac(C, l0, l1) {
  let a = 0, t = 0; for (let j = 0; j < C.n; j++) { const v = C.N[j]; if (!(v > 0)) continue; t += v; if (C.l[j] >= l0 && C.l[j] <= l1) a += v; }
  return t > 0 ? a / t : 0;
}
export function roleL(data, name) {
  const r = data.roles && data.roles[name]; if (!r) return null;
  if (r.cell != null) { const c = data.roles.cells && data.roles.cells[String(r.cell)]; if (c && Number.isFinite(c.l)) return c.l; }
  if (Number.isFinite(r.l)) return r.l;
  return null;
}

/* ---------------------------------------------------------------- 1-2. skeleton and l-windows */
/* the slots of plan/1 in path order, only the "on" letters */
function letters(plan) {
  const order = ["A", "B", "C", "D"], out = [];
  for (const k of order) { const s = plan.slots[k]; if (s && s.on && s.l1 > s.l0) out.push({key: k, ...s}); }
  return out;
}
const inSlot = (s, l) => l != null && l >= s.l0 - 1e-6 && l <= s.l1 + 1e-6;

/* Anchors per case (fixed rules, data-driven; DESIGN_tierA §5 table, §6.2 step 6). Each anchor is an interval owned by
   a flight beat, or a stop at an l. Unassigned stretches between anchors are absorbed by the next flight (logged). */
export function sequence(S, cfg) {
  const {data, half} = S, plan = data.plan, log = [], on = new Set(cfg.beats);
  const L = letters(plan), lS5 = data.roles.S5 && data.roles.S5.ok !== false ? roleL(data, "S5") : roleL(data, "S5");
  const anchors = [];                         // {id, l0, l1} flights or {id, stop: true, l, cell}
  const used = new Set();
  const flight = (id, l0, l1, why) => { if (on.has(id) && l1 > l0 + 0.5) { anchors.push({id, l0, l1, why}); return true; } if (on.has(id)) log.push(`${id}: window ${r3(l0)}..${r3(l1)} too short, beat dropped`); return false; };
  const stopAt = (l, why) => { for (const id of ["B7b", "B7c"]) if (on.has(id)) anchors.push({id, stop: true, l, cell: "@S5", why}); };
  const slotOf = l => L.find(s => inSlot(s, l));
  const lettersUsed = {};
  const mark = (s, ids) => { used.add(s.key); lettersUsed[s.key] = ids; };
  const c = S.caseId;
  if (c === "clean_single") {
    const X = slotOf(lS5) || [...L].sort((a, b) => (b.share || 0) - (a.share || 0))[0];
    if (X && lS5 != null) {
      flight("B5", Math.min(X.l0, lS5 - 5), lS5, "into the cloud to @S5 (= @lead.core when they coincide)");
      stopAt(lS5, "the cloud's O VI cell");
      flight("B10", lS5, Math.max(X.l1, lS5 + 5), "rest of the cloud, O VI saturation slider");
      mark(X, ["B5", "B10"]);
    } else log.push("clean: no slot holds @S5");
  } else if (c === "multiphase") {
    const W = L.find(s => s.lead === "OVI" && inSlot(s, lS5)) || L.find(s => s.lead === "OVI");
    const Cs = L.filter(s => s !== W && s.lead !== "OVI");
    const Cool = Cs.length ? Cs[0] : null;
    if (W) {
      const ls = inSlot(W, lS5) ? lS5 : null;
      // fix2 (review2 R2-B3): with no B7b/B7c stop at @S5, B7a flies the whole hot slot, so the O VI dip is whole by its end
      if (ls != null && (on.has("B7b") || on.has("B7c"))) { flight("B7a", W.l0, ls, "hot gas, broad: to @S5"); stopAt(ls, "O VI cell"); }
      else flight("B7a", W.l0, W.l1, "hot gas, broad");
      mark(W, ["B7a"]);
    }
    if (Cool) { flight("B5", Cool.l0, Cool.l1, "cool gas, narrow"); mark(Cool, ["B5"]); }
    if (W && Cool && on.has("B7p")) {
      const lp = Math.max(W.l1, Cool.l1);
      anchors.push({id: "B7p", hold: true, l: lp, why: "both clouds in one frame (side tableau)", pair: [W, Cool]});
    }
    if (on.has("B9") && S.flags.has_pair) { const R = L.find(s => !used.has(s.key)); if (R) { flight("B9", R.l0, R.l1, "same speed far apart (has_pair)"); mark(R, ["B9"]); } }
  } else if (c === "damped") {
    const lhi = roleL(data, "hiPeak");
    const X = slotOf(lhi) || L.find(s => s.enc === plan.damped_target) || L[0];
    const strong = !!S.flags.ovi_strong && on.has("B7a");
    const Y = strong ? slotOf(lS5) : null;
    if (X) {
      if (Y && Y === X && lS5 != null) {
        flight("B5", X.l0, lS5, "slow chase into the core"); stopAt(lS5, "O VI cell (ovi_strong)"); flight("B7d", lS5, X.l1, "rest of the core");
        mark(X, ["B5", "B7d"]);
      } else { flight("B5", X.l0, X.l1, "slow chase into the core, close orbit @hiPeak"); mark(X, ["B5"]); }
    }
    if (Y && Y !== X && lS5 != null) {
      flight("B7a", Y.l0, lS5, "O VI cloud (ovi_strong)"); stopAt(lS5, "O VI cell"); flight("B7d", lS5, Y.l1, "rest of the O VI cloud");
      mark(Y, ["B7a", "B7d"]);
    }
    const Z = [...L].reverse().find(s => !used.has(s.key));
    if (Z) { flight("B10", Z.l0, Z.l1, "more gas, deeper dip (slider)"); mark(Z, ["B10"]); }
    else { const e = Math.max(...anchors.filter(a => !a.stop && !a.hold).map(a => a.l1), -half); flight("B10", e, Math.min(half - 20, e + 0.1 * half), "slider beat after the core (no letter left)"); }
    if (on.has("B10w")) { const b10 = anchors.find(a => a.id === "B10"); if (b10) anchors.push({id: "B10w", hold: true, l: b10.l1, why: "wide pull-out"}); }
  } else if (c === "hot_only") {
    const X = slotOf(lS5) || L[0];
    if (X) {
      const ls = inSlot(X, lS5) ? lS5 : null;
      flight("B5", Math.max(S.lStart + 0.35 * (X.l0 - S.lStart), X.l0 - 0.25 * half), X.l0, "no cool clump before the hot gas");
      if (ls != null) { flight("B7a", X.l0, ls, "hot gas to @S5"); stopAt(ls, "O VI cell (T drag)");
        if (S.flags.ovi_trough_broad === true) flight("B7d", ls, X.l1, "broad trough"); }
      else flight("B7a", X.l0, X.l1, "hot gas");
      mark(X, ["B7a"]);
      const Z = L.find(s => !used.has(s.key) && s.l0 >= X.l0);
      if (Z) { flight("B6", Z.l0, Z.l1, "hot stretch"); mark(Z, ["B6"]); }
      else { const e = (ls != null ? Math.max(ls, X.l1) : X.l1); flight("B6", e, Math.min(half - 30, e + 0.2 * half), "hot stretch after the cloud"); }
    }
  } else if (c === "hero") {
    // the hand-tuned hero's own mapping (hero check only, §6.3): A -> B5, FAB -> B6, B -> B7a | stop | B7d, B7e, C -> B9,
    // D -> B10, B8 at the closest approach
    const A = L.find(s => s.key === "A"), Bs = L.find(s => s.key === "B"), Cs = L.find(s => s.key === "C"), Ds = L.find(s => s.key === "D");
    if (A) { flight("B5", A.l0, A.l1, "cloud A"); mark(A, ["B5"]); }
    if (A && Bs && Bs.l0 > A.l1 + 1) flight("B6", A.l1, Bs.l0, "too hot to see (FAB)");
    if (Bs && lS5 != null && inSlot(Bs, lS5)) {
      flight("B7a", Bs.l0, lS5, "cloud B to the stop cell"); stopAt(lS5, "cell 263");
      const e = lS5 + 0.7 * (Bs.l1 - lS5); flight("B7d", lS5, e, "rest of B"); flight("B7e", e, Bs.l1, "cold knot"); mark(Bs, ["B7a", "B7d", "B7e"]);
    }
    if (Cs) { flight("B9", Cs.l0, Cs.l1, "cloud C"); mark(Cs, ["B9"]); }
    if (Ds) { flight("B10", Ds.l0, Ds.l1, "cloud D"); mark(Ds, ["B10"]); }
  } else if (c === "empty") {
    // nothing to letter (B synthetic; §4.2 step 4): no anchors
  }
  for (const s of L) if (!used.has(s.key)) log.push(`letter ${s.key} (${s.enc}, ${r3(s.l0)}..${r3(s.l1)}) not shown by a beat of this case: absorbed`);
  // order by l (stops/holds after the flight that ends at their l)
  const key = a => (a.stop || a.hold ? a.l : a.l0);
  anchors.sort((a, b) => key(a) - key(b) || (a.stop || a.hold ? 0 : 1) - (b.stop || b.hold ? 0 : 1) || cfg.beats.indexOf(a.id) - cfg.beats.indexOf(b.id));
  // overlapping flights: later one starts where the earlier ends
  let cur = S.lStart; const items = [];
  const flights = anchors.filter(a => !a.stop && !a.hold);
  const firstStart = flights.length ? flights[0].l0 : (anchors.length ? key(anchors[0]) : null);
  // B3 / B4 cover the approach from lStart to the first anchor; with no anchors they cover up to just before l = 0
  const approachEnd = firstStart != null ? Math.max(S.lStart + 20, firstStart) : Math.min(-0.02 * half, half - 40);
  const split = S.lStart + 0.4 * (approachEnd - S.lStart);
  if (on.has("B3")) items.push({id: "B3", kind: "flight", l0: S.lStart, l1: on.has("B4") ? split : approachEnd, why: "drop into the halo"});
  if (on.has("B4")) items.push({id: "B4", kind: "flight", l0: on.has("B3") ? split : S.lStart, l1: approachEnd, why: "first cells"});
  cur = approachEnd;
  let b8done = !on.has("B8");
  const z0 = -0.004 * half, w8 = 0.12 * half;
  // B8 "halfway" takes the first unassigned stretch past the closest approach (the hero's B8 is the gap after cloud B):
  // [max(gap start, z0), + min(0.12 half, gap)]; with no such gap it is carved from the start of the lookback
  const tryB8 = gapEnd => {
    if (b8done) return;
    const g0 = Math.max(cur, z0);
    if (gapEnd - g0 < 2) return;
    if (g0 > cur + 1e-6) { extendTo(items, g0); cur = g0; }
    const e = Math.min(g0 + w8, gapEnd); items.push({id: "B8", kind: "flight", l0: g0, l1: e, why: "halfway (first stretch past the closest approach)"}); cur = e; b8done = true;
  };
  for (const a of anchors) {
    if (a.stop) { if (Math.abs(a.l - cur) > 1e-6) { log.push(`${a.id}: stop at ${r3(a.l)} but probe at ${r3(cur)}; previous flight extended`); extendTo(items, a.l); cur = a.l; }
      items.push({id: a.id, kind: "stop", l0: r3(a.l), l1: r3(a.l), cell: a.cell, why: a.why}); continue; }
    if (a.hold) { if (a.l > cur + 1e-6) { extendTo(items, a.l); cur = a.l; }
      items.push({id: a.id, kind: "hold", l0: r3(cur), l1: r3(cur), why: a.why, pair: a.pair}); continue; }
    if (a.l0 > z0) tryB8(a.l0);
    let l0 = a.l0;
    if (l0 > cur + 1e-6) log.push(`${a.id}: gap ${r3(cur)}..${r3(l0)} absorbed (flight starts earlier)`);
    if (l0 < cur - 1e-6) log.push(`${a.id}: starts at ${r3(cur)} instead of ${r3(l0)} (previous beat ends there)`);
    l0 = cur;
    if (a.l1 <= l0 + 0.5) { log.push(`${a.id}: no room after ${r3(l0)}, dropped`); continue; }
    items.push({id: a.id, kind: "flight", l0, l1: a.l1, why: a.why}); cur = a.l1;
  }
  tryB8(half - 40);
  if (on.has("B11")) { if (cur > half - 5) log.push("B11: no room before the end"); items.push({id: "B11", kind: "flight", l0: cur, l1: half, why: "lookback"}); cur = half; }
  else extendTo(items, half);
  // holds at the start, stills at the end
  const pre = ["B0", "B1", "B2"].filter(id => on.has(id)).map(id => ({id, kind: id === "B0" ? "gate" : "hold", l0: r3(S.lStart), l1: r3(S.lStart)}));
  const post = cfg.beats.filter(id => ["B12n", "B12a", "B12b", "B13", "B14"].includes(id)).map(id => ({id, kind: "still", l0: r3(half), l1: r3(half)}));
  const all = [...pre, ...items.map(x => ({...x, l0: r3(x.l0), l1: r3(x.l1)})), ...post];
  // letters shown (for G15 and the copy): letter -> beat ids actually carrying it
  const lettersMap = {};
  for (const s of L) if (lettersUsed[s.key]) {
    const ids = lettersUsed[s.key].filter(id => all.some(b => b.id === id));
    // the rest of a letter's slot (e.g. after its stop, when the case has no beat for it) is flown by a neighbouring flight;
    // that flight carries the letter too, so the letter's windows cover its slot (G13r, G15)
    for (const b of all) if (b.kind === "flight" && !ids.includes(b.id) && Math.min(b.l1, s.l1) - Math.max(b.l0, s.l0) > 0.5) {
      ids.push(b.id); log.push(`letter ${s.key}: ${b.id} also carries it (flies ${r3(Math.max(b.l0, s.l0))}..${r3(Math.min(b.l1, s.l1))} of the slot)`); }
    lettersMap[s.key] = ids;
  }
  return {items: all, letters: lettersMap, log};
}
function extendTo(items, l) {
  for (let k = items.length - 1; k >= 0; k--) if (items[k].kind === "flight") { if (l > items[k].l1) items[k].l1 = l; return; }
}

/* ---------------------------------------------------------------- 3. timing */
const wordsOf = s => (typeof s === "string" ? s.replace(/\{\{[^}]*\}\}/g, "X").replace(/\*/g, "").split(/\s+/).filter(Boolean).length : 0);
/* read_s per beat: words of each active line (display + sub, the long variants) / WPS + LINE_PAD per line */
export function readSeconds(beats, D, copy, ctx) {
  const out = {};
  for (const b of beats) out[b.id] = {read_s: 0, words: 0, lines: 0, missing: [], slots: {}};
  const lines = D.activeLines(copy, beats, {flags: ctx.flags, caseId: ctx.caseId, lookup: ctx.lookup, withSkipped: true});
  const seen = new Set();
  for (const ln of lines) {
    const o = out[ln.beat]; if (!o) continue;
    const w = wordsOf(ln.text.display) + wordsOf(ln.text.sub);
    o.words += w; o.lines += 1; o.read_s += w / WPS + LINE_PAD; seen.add(`${ln.beat}/${ln.id}`); o.slots[`${ln.id}|${ln.part}`] = (o.slots[`${ln.id}|${ln.part}`] || 0) + w;
  }
  // lines without copy yet (new Tier A beats before R5b): the template's word estimate stands in, logged
  for (const b of beats) for (const t of b.text || []) {
    if (seen.has(`${b.id}/${t.id}`) || (t.cond && !(ctx.flags && ctx.flags[t.cond] === true))) continue;
    if (D.lineEntry(copy, t.id)) continue;
    const w = t.words || 6; out[b.id].words += w; out[b.id].lines += 1; out[b.id].read_s += w / WPS + LINE_PAD; out[b.id].missing.push(t.id); out[b.id].slots[`${t.id}|${t.part || "all"}`] = w;
  }
  return out;
}
/* watch_s: need = max(read_s, base_s·kb); flex = target − Σ need (≥ 0) shared by w (flights: (lead τ0 sum)^α, else 1);
   each beat capped at BEAT_CAP s */
export function allocate(items, read, opts) {
  const {target, kb = 1, alpha = 0.5, wOf, cap = {}} = opts;
  const capOf = i => Math.min(BEAT_CAP, cap[items[i].id] ?? BEAT_CAP);   // fix2 (R2-B4): cases.json `cap` {beat: s}
  const need = items.map(b => Math.max(read[b.id] ? read[b.id].read_s : 0, (KIND_BASE[b.kind] ?? 6) * kb));
  const w = items.map(b => (b.kind === "flight" && wOf ? Math.pow(Math.max(wOf(b), 0) + 1, alpha) : 1));
  let flex = Math.max(0, target - need.reduce((s, x) => s + x, 0));
  const out = need.slice();
  // distribute flex by w; beats at the cap pass their share on (fixed number of rounds: deterministic)
  let free = items.map((_, i) => out[i] < capOf(i));
  for (let round = 0; round < 6 && flex > 1e-9; round++) {
    const W = w.reduce((s, x, i) => s + (free[i] ? x : 0), 0); if (!(W > 0)) break;
    let left = 0;
    for (let i = 0; i < items.length; i++) if (free[i]) { const add = flex * w[i] / W, room = capOf(i) - out[i];
      if (add >= room) { out[i] = capOf(i); left += add - room; free[i] = false; } else out[i] += add; }
    flex = left;
  }
  return out.map(x => Math.round(Math.min(Math.max(x, 0), Math.max(BEAT_CAP, x)) * 2) / 2);   // half-second grid
}

/* ---------------------------------------------------------------- beats document */
const HERO_SHELL = 246.35;
/* clone a template beat, retime its keyframes; returns the beat (without p0/p1) */
function fromTemplate(tpl, id) {
  const t = tpl.beats[id]; if (!t) throw new Error(`template.beats.json has no ${id}`);
  return JSON.parse(JSON.stringify(t));
}
const lastKey = (v, f) => (Array.isArray(v) ? v[v.length - 1][f] : v);
const firstKey = (v, f) => (Array.isArray(v) ? v[0][f] : v);

export function buildBeats(S, cfg, tpl, T, seq) {
  const log = [];
  const beats = seq.items.map(it => {
    const b = fromTemplate(tpl, it.id);
    b.kind = it.kind; b.l0 = it.l0; b.l1 = it.l1;
    if (it.kind === "stop") b.cell = it.cell || b.cell;
    else delete b.cell;
    if (it.kind !== "stop") { delete b.stops; }
    b.shot = it.id;
    // case overrides (ion, tf, dock, cond) from cases.json
    const ov = (cfg.override || {})[it.id] || {};
    for (const [k, v] of Object.entries(ov)) b[k] = JSON.parse(JSON.stringify(v));
    if (b.ion === "@lead") b.ion = S.lead;
    for (const k of b.tf || []) if (k.preset === "ion:@lead") k.preset = "ion:" + S.lead;
    return b;
  });
  // drop a beat whose template cond is false for this ray (a skipped beat would only hold dead p)
  const kept = beats.filter(b => { if (b.cond && !(S.flags[b.cond] === true)) { log.push(`${b.id}: cond ${b.cond} false for this ray, dropped`); return false; } return true; });
  // continuity of tf preset and dock state across beat boundaries (timeline.validate rules)
  for (let i = 1; i < kept.length; i++) {
    const a = kept[i - 1], b = kept[i];
    const pe = a.tf[a.tf.length - 1].preset, bs = b.tf[0].preset;
    if (pe !== bs) {
      const k0 = {...b.tf[0], preset: pe}; const rest = b.tf.map(k => ({...k, u: k.u === 0 ? 0.15 : Math.max(k.u, 0.15)}));
      b.tf = [k0, ...dedupeU(rest)]; log.push(`${b.id}: tf starts at ${pe} (continuity with ${a.id}), template ${bs} from u 0.15`);
    }
    const de = lastKey(a.dock, "state"), ds = firstKey(b.dock, "state");
    if (de !== ds) {
      const ks = Array.isArray(b.dock) ? b.dock : [{u: 0, state: b.dock}];
      b.dock = [{u: 0, state: de}, ...dedupeU(ks.map(k => ({...k, u: Math.max(k.u, 0.12)})))];
      log.push(`${b.id}: dock starts ${de} (continuity with ${a.id}), template ${ds} from u 0.12`);
    }
  }
  // B12n: the telescope still at the page R and S/N (limits are stated at these, §3 empty)
  for (const b of kept) if (b.id === "B12n" && S.data.limits) { const lim = S.data.limits.OVI || S.data.limits.HI || {};
    b.spec = {mode: "observed", R: lim.R || 15000, sn: lim.sn || 10}; }
  // fields: levels from the ray's finest cube level in the beat window (lod.finest), L0 only on L0-only rays (§6.2 step 5)
  for (const b of kept) b.fields = (b.fields || []).map(f => ({name: f.name, level: levelFor(S, b, f.level)}));
  // timing
  const read = readSeconds(kept, T.D, S.copy, {flags: S.copyFlags, caseId: S.caseId, lookup: S.lookup});
  const C = ionCells(S.data, S.lead);
  const watch = allocate(kept, read, {target: cfg.target_s, kb: T.kb, alpha: T.alpha, wOf: b => tauSum(C, Math.min(b.l0, b.l1), Math.max(b.l0, b.l1)), cap: cfg.cap});
  const total = watch.reduce((s, x) => s + x, 0);
  // p widths follow watch time, except the long camera moves, which keep at least the hero's p width (the hero's p widths are
  // hand-tuned apart from watch_s too: its B11 pull-out spans 0.06 p for 9.5 s), so a dolly is never faster per wheel notch
  // than the hero's
  // flights also keep a p width ≥ their length / FLIGHT_KPC_PER_P (the hero's fastest flight below the lookback, B4: 54 kpc
  // in 0.04 p), so no generated flight is faster per wheel notch than the hero's
  const pmin = b => Math.max(P_MIN[b.id] || 0, b.kind === "flight" ? Math.abs(b.l1 - b.l0) / FLIGHT_KPC_PER_P : 0);
  const PM = Object.fromEntries(kept.map(b => [b.id, pmin(b)]));
  const share = kept.map((b, i) => Math.max(watch[i] / total, PM[b.id]));
  const fixed = kept.map(b => PM[b.id] > 0);
  for (let it = 0; it < 4; it++) {          // renormalise the free beats so the shares sum to 1 (fixed order, deterministic)
    const sf = share.reduce((a, x, i) => a + (fixed[i] && share[i] === PM[kept[i].id] ? x : 0), 0);
    const fr = kept.map((b, i) => !(fixed[i] && share[i] === PM[b.id])), sw = kept.reduce((a, b, i) => a + (fr[i] ? watch[i] : 0), 0);
    kept.forEach((b, i) => { if (fr[i]) share[i] = Math.max((1 - sf) * watch[i] / sw, PM[b.id]); });
  }
  const ssum = share.reduce((a, x) => a + x, 0);
  let p = 0;
  kept.forEach((b, i) => { b.watch_s = watch[i]; b.p0 = r6(p); p += share[i] / ssum; b.p1 = i === kept.length - 1 ? 1 : r6(p); });
  kept[0].p0 = 0;
  // text/eq windows: keep the template u-windows, pull them inside the beat by the fade (timeline.validate) and keep the
  // gap between consecutive groups of a band
  const fadeP = 0.004;
  for (const b of kept) { const w = b.p1 - b.p0, m = Math.min(0.45, (fadeP + 1e-4) / w);
    // R8: a window with no fade on a side keeps that edge (timeline.validate counts each item's own fades): B0's line opens
    // the story at u0 0 and B14's stays on to p = 1, as on the hero, so Watch ends on the closing line, not an empty card
    for (const t of b.text || []) { const u0 = Math.max(t.u0, t.fadeIn === 0 ? 0 : m), u1 = Math.min(t.u1, t.fadeOut === 0 ? 1 : 1 - m); if (u0 !== t.u0 || u1 !== t.u1) { t.u0 = r3(Math.min(u0, u1)); t.u1 = r3(Math.max(u0, u1)); } }
    // fix1 round 2 (review beauty F3): each slot's `words` is the story's own resolved line (0 when this story's copy
    // shows nothing there), not the template's full-tour count, so the page's Watch schedule (timeline.js: words / 3 + 1 s
    // per caption) times the words this story shows and no longer stretches its beats past watch_s
    const rd = read[b.id]; for (const t of b.text || []) if (rd) t.words = rd.slots[`${t.id}|${t.part || "all"}`] || 0; }
  extendOverEmpty(kept, log);
  fixGroupGaps(kept, 0.004, fadeP, log);
  // stable key order (schema order)
  const ORDER = ["id", "slot", "cond", "watch_s", "p0", "p1", "kind", "l0", "l1", "lu", "ion", "shot", "cell", "stops", "tf", "dock", "fields", "lead", "textBand", "text", "eqs", "interactions", "copyRef", "spec", "ui", "shells", "cellStops", "quality"];
  const out = kept.map(b => Object.fromEntries([...ORDER.filter(k => k in b).map(k => [k, b[k]]), ...Object.keys(b).filter(k => !ORDER.includes(k)).sort().map(k => [k, b[k]])]));
  return {beats: out, read, log, total};
}
/* fix1 round 2 (review beauty F8): a line whose following slots of the band show nothing in this story (a case nulls them)
   keeps their reading time: its window runs on to the next shown line of the band (or the band's last window end). Starts
   never move (equations and fit phases keep their sync) */
function extendOverEmpty(beats, log) {
  for (const b of beats) for (const band of ["act", "text"]) {
    const ls = (b.text || []).filter(t => t.band === band && !t.alt && (!t.when || t.when === "default")).sort((x, y) => x.u0 - y.u0);
    for (let i = 0; i < ls.length; i++) {
      const t = ls[i]; if (!(t.words > 0)) continue;
      let j = i + 1, skipped = 0; while (j < ls.length && !(ls[j].words > 0)) { skipped++; j++; }
      if (!skipped) continue;
      const end = j < ls.length ? ls[j].u0 - 0.01 : Math.max(...ls.slice(i + 1).map(x => x.u1));
      if (end > t.u1 + 1e-3) { log.push(`${b.id}: ${t.id} runs on over ${skipped} empty slot(s), u1 ${t.u1} -> ${r3(end)}`); t.u1 = r3(end); }
    }
  }
  // a slot this story's copy leaves empty (no cond of its own: the flags are fixed per story) is dropped, so no gap or
  // re-layout rule makes room for a line that never shows
  for (const b of beats) if (b.text) {
    const drop = b.text.filter(t => t.words === 0 && !t.cond && !t.alt && !(b.text.some(x => x.alt && x.band === t.band)));
    if (drop.length) { b.text = b.text.filter(t => !drop.includes(t)); log.push(`${b.id}: empty slot(s) ${drop.map(t => t.id).join(", ")} dropped`); }
  }
}
function dedupeU(keys) { const out = []; for (const k of keys) { if (out.length && Math.abs(out[out.length - 1].u - k.u) < 1e-9) out[out.length - 1] = k; else out.push(k); } return out; }
/* a beat whose own lines of a band sit closer than the group gap (its p width is shorter than the hero's) gets them laid out
   again: same span (or the whole beat, if needed), windows in proportion to each line's words, gaps of gap + 2 fades */
function relayoutBeat(b, band, gap, fadeP, log) {
  const lines = (b.text || []).filter(t => t.band === band && (!t.when || t.when === "default") && !t.alt);
  if (lines.length < 2) return;
  const w = b.p1 - b.p0, g = (gap + 2 * fadeP + 2e-4) / w, m = (fadeP + 2e-4) / w;
  let bad = false; for (let k = 1; k < lines.length; k++) if ((lines[k].u0 - lines[k - 1].u1) < g) bad = true;
  if (!bad) return;
  let U0 = Math.max(m, lines[0].u0), U1 = Math.min(1 - m, lines[lines.length - 1].u1);
  const minLine = 0.04, need = (lines.length - 1) * g + lines.length * minLine;
  if (U1 - U0 < need) { U0 = m; U1 = 1 - m; }
  const avail = U1 - U0 - (lines.length - 1) * g;
  if (avail < lines.length * 0.01) { log.push(`${b.id}: ${lines.length} ${band} lines do not fit its p width ${w.toFixed(4)}`); return; }
  const wt = lines.map(t => Math.max(3, t.words || 8)), W = wt.reduce((s2, x) => s2 + x, 0);
  let u = U0;
  lines.forEach((t, i) => { const len = avail * wt[i] / W; t.u0 = Math.round(u * 1e4) / 1e4; t.u1 = Math.floor((u + len) * 1e4) / 1e4; u += len + g; });
  log.push(`${b.id}: ${band} lines re-laid in proportion to their words (beat too short for the template windows)`);
}
function fixGroupGaps(beats, gap, fadeP, log) {
  for (const b of beats) for (const band of ["act", "text"]) relayoutBeat(b, band, gap, fadeP, log);
  // consecutive lines of a band keep ≥ gap p between their fade windows: first delay the later line (down to 40 % of its
  // window), then end the earlier line sooner (down to 40 % of its window); a line keeps u0 < u1 inside (m, 1 − m)
  for (const band of ["act", "text"]) {
    const wins = [];
    for (const b of beats) for (const t of b.text || []) if (t.band === band && (!t.when || t.when === "default") && !t.alt) wins.push({b, t});
    const win = ({b, t}) => [b.p0 + t.u0 * (b.p1 - b.p0) - fadeP, b.p0 + t.u1 * (b.p1 - b.p0) + fadeP];
    wins.sort((x, y) => win(x)[0] - win(y)[0]);
    for (let k = 1; k < wins.length; k++) {
      const A = wins[k - 1], B = wins[k]; const g = win(B)[0] - win(A)[1];
      if (g >= gap) continue;
      let need = gap - g + 2e-5;
      const wa = A.b.p1 - A.b.p0, wb = B.b.p1 - B.b.p0;
      const db = Math.min(need, Math.max(0, (B.t.u1 - B.t.u0) * 0.6 * wb));
      B.t.u0 = Math.ceil((B.t.u0 + db / wb) * 1e4) / 1e4; need -= db;
      if (need > 0) { const da = Math.min(need, Math.max(0, (A.t.u1 - A.t.u0) * 0.6 * wa)); A.t.u1 = Math.floor((A.t.u1 - da / wa) * 1e4) / 1e4; need -= da; }
      log.push(`band ${band}: ${A.b.id}/${A.t.id} → ${B.b.id}/${B.t.id} gap widened to ${gap}${need > 1e-6 ? " (short by " + need.toExponential(1) + " p)" : ""}`);
    }
  }
}
export function levelFor(S, b, tplLevel) {
  const cover = S.hosted && S.hosted.levels ? Object.keys(S.hosted.levels) : ["L0", "L1", "L2"];
  const fin = S.data.lod && S.data.lod.finest;
  if (!fin) return "L0";
  const keys = Object.keys(fin).map(Number).sort((a, c) => a - c);
  const lvAt = l => { let best = keys[0]; for (const k of keys) if (k <= l + 1e-9) best = k; return fin[String(best)] || "L0"; };
  let lv;
  if (b.kind === "flight") { const lo = Math.min(b.l0, b.l1), hi = Math.max(b.l0, b.l1); const ls = keys.filter(k => k >= lo - 10 && k <= hi);
    const rank = {L0: 0, L1: 1, L2: 2, none: -1}; lv = ls.map(lvAt).reduce((m, x) => (rank[x] > rank[m] ? x : m), "L0"); }
  else if (b.kind === "stop") lv = lvAt(b.l0);
  else lv = "L0";
  const rank = {L0: 0, L1: 1, L2: 2};
  if (!cover.includes(lv) || rank[lv] == null) lv = "L0";
  // never ask for a finer level than the template beat did (the hero's residency plan), except L0-only rays
  const tl = rank[tplLevel] ?? 0;
  return rank[lv] > tl ? tplLevel : lv;
}

/* ---------------------------------------------------------------- 10. TF block */
/* TF calibration (§6.2 step 10, refitted once on the hero): the plain [p5, p99.5] tube window misses the hand-tuned hero's
   ion windows (H I −10.5/−0.6, O VI −10.6/−5.6) by up to 2 dex, and no percentile pair can reach them: their upper edges
   lie 1.3 dex above the tube's maximum. The refit keeps a percentile for the lower edge (the hero's own: H I 24.3 %,
   O VI 49.4 % of the tube cells) and puts the upper edge at the tube's p99.5 plus the hero's headroom (H I +1.847, O VI
   +2.055 dex). On the hero this reproduces the hand windows exactly (by construction, to the tube's 8-bit quantisation);
   extra ions take the O VI rule. Computed by scratch/story3_w/R3/explore/tubeq.mjs on the hero tube. */
export const TF_REFIT = Object.freeze({HI: {lo_pct: 24.3, hi_pct: 99.5, hi_add: 1.847}, OVI: {lo_pct: 49.4, hi_pct: 99.5, hi_add: 2.055}});
export function tfBlock(S, tpl, maxDist, tube = null) {
  const tw = S.data.tf_windows || {};
  const lead = "ion:" + S.lead;
  const tf = {source: tw.source === "manifest" ? "manifest" : "tube"};
  if (tw.density) tf.vol_window = tw.density.map(r3);
  // fix2 (review2 R2-B9): the empty halo's tube window (top 10^-4.73) saturates the whole halo; it takes R4's empty block
  // instead (n_H window on the hero's absolute scale, top = the galaxy manifest top, halo gain 3: A100 B2 11.5 % of pixels
  // > 0.15 with a dark text column, R4 jobs 1388845/1390248)
  if (S.caseId === "empty") { const gw = galaxyVolWindow(S.data.galaxy && S.data.galaxy.id || S.data.meta.galaxy);
    if (gw && gw.nH) { const d = deriveTFBlock(S.data, gw); tf.vol_window = d.vol_window; if (d.look) tf.look = d.look; } }
  const ion = {}, refit = {};
  for (const k of Object.keys(tw).filter(k => /^ion:/.test(k)).sort()) {
    const w = tw[k]; if (!Array.isArray(w)) continue;
    let [a, b] = w;
    const id = k.slice(4), arr = tube && tube[id];
    if (arr && arr.length >= 50) {
      const R = TF_REFIT[id] || TF_REFIT.OVI, q = f => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f / 100 * (arr.length - 1))))];
      a = q(R.lo_pct); b = q(R.hi_pct) + R.hi_add; refit[k] = {from: [r3(w[0]), r3(w[1])], rule: R};
    }
    if (b - a < 1) { const c = (a + b) / 2; a = c - 0.5; b = c + 0.5; }
    ion[k] = [r3(a), r3(b)];
  }
  if (Object.keys(refit).length) tf.refit = refit;
  tf.ion = ion;
  tf.lead = lead;
  if (tw.pctl) tf.pctl = tw.pctl.slice();
  // bands: the lead ion's cell log n at 50/80/95 % of the ray's lead-ion column, placed inside the lead window
  const lw = ion[lead];
  const bands = leadBands(S, lw);
  if (bands) tf.bands = bands;
  // speed window ±1.5 max|V| of lettered encounters (≥ 100 km/s)
  const vs = (S.data.plan.encounters || []).filter(e => e.letter).map(e => Math.abs(e.V - (S.data.galaxy.vsys || 0)));
  const vmax = Math.max(100, 1.5 * Math.max(0, ...vs));
  tf.speed = [-r3(vmax), r3(vmax)];
  tf.fog = [r3(0.4 * maxDist.min), r3(1.4 * maxDist.max)];
  return tf;
}
function leadBands(S, lw) {
  if (!lw) return null;
  const ion = S.lead, ic = S.data.ions[ion] && S.data.ions[ion].cells;
  if (!ic || !ic.nH || !ic.f_ion) return null;
  // n_ion = nH · X_el · f_ion is not in the cell block; use log10(nH · f_ion) + log10 abundance (H: 0, O: Z/Zsun · 4.9e-4)
  const vals = [], wts = [];
  for (let j = 0; j < ic.nH.length; j++) {
    const nH = +ic.nH[j], f = +ic.f_ion[j], Z = +ic.Z[j]; if (!(nH > 0) || !(f > 0)) continue;
    const ab = ion === "HI" ? 1 : (Z > 0 ? Z : 0.0127) / 0.0127 * 4.9e-4;
    const v = Math.log10(nH * f * ab); if (!Number.isFinite(v)) continue;
    vals.push(v); wts.push(Math.pow(10, +ic.logN[j]) || 0);
  }
  if (vals.length < 5) return null;
  const ord = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b] || a - b);
  const tot = wts.reduce((s, x) => s + x, 0); if (!(tot > 0)) return null;
  const q = f => { let s = 0; for (const i of ord) { s += wts[i]; if (s >= f * tot) return vals[i]; } return vals[ord[ord.length - 1]]; };
  const lo = lw[0] + 0.06 * (lw[1] - lw[0]), hi = lw[0] + 0.89 * (lw[1] - lw[0]);
  const raw = [q(0.5), q(0.8), q(0.95)].map(v => Math.min(hi, Math.max(lo, v)));
  for (let i = 1; i < raw.length; i++) if (!(raw[i] > raw[i - 1])) raw[i] = Math.min(hi, raw[i - 1] + 0.05);
  if (!(raw[2] > raw[1] && raw[1] > raw[0])) return null;
  return raw.map(r3);
}

/* ---------------------------------------------------------------- 11. film plan */
export function filmPlan(S, cfg, doc, fps = 30) {
  const ids = doc.beats.map(b => b.id), B = Object.fromEntries(doc.beats.map(b => [b.id, b]));
  const chunks = [];
  for (const c of cfg.film.chunks) {
    let bs = (c.beats || []).filter(id => B[id]);
    if (!bs.length && c.alt) bs = c.alt.filter(id => B[id]);
    if (!bs.length) continue;
    // contiguous range in the story order
    const i0 = Math.min(...bs.map(id => ids.indexOf(id))), i1 = Math.max(...bs.map(id => ids.indexOf(id)));
    chunks.push({id: c.id, beats: ids.slice(i0, i1 + 1), tf: c.tf ?? null, w: ids.slice(i0, i1 + 1).reduce((s, id) => s + B[id].watch_s, 0)});
  }
  // non-overlapping in story order
  chunks.sort((a, b) => ids.indexOf(a.beats[0]) - ids.indexOf(b.beats[0]));
  const out = []; let last = -1;
  for (const c of chunks) { const i0 = ids.indexOf(c.beats[0]); if (i0 <= last) { const keep = c.beats.filter(id => ids.indexOf(id) > last); if (!keep.length) continue; c.beats = keep; } last = ids.indexOf(c.beats[c.beats.length - 1]); out.push(c); }
  const W = out.reduce((s, c) => s + c.w, 0), target = cfg.film.target_s;
  let acc = 0;
  out.forEach((c, i) => { const s = i === out.length - 1 ? target - acc : Math.max(4, Math.round(target * c.w / W)); c.s = s; acc += s; delete c.w; });
  return {schema: "story-film-plan/1", story: S.id, galaxy: S.data.meta.galaxy, ray: S.data.meta.ray, beats: `beats.${S.id}.json`, shots: `shots.${S.id}.json`,
    fps, target_s: target, duration_s: out.reduce((s, c) => s + c.s, 0), chunks: out.map(c => ({id: c.id, s: c.s, beats: c.beats, tf: c.tf}))};
}
