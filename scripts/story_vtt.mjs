#!/usr/bin/env node
// story_vtt.mjs: captions, chapters and the render stamp of the v2 film "How a spectrum is made" (DESIGN_final §5.9),
// all derived from ROOT/film.json + beats.json + copy.json and the story data (never hand-edited).
//
//   node scripts/story_vtt.mjs [--root DIR] [--cut film|beams] [--data FILE] [--lenient]
//        writes ROOT/media/story[.<cut>].en.vtt, story[.<cut>].chapters.vtt, story[.<cut>].ffmeta
//   node scripts/story_vtt.mjs --stamp   also sets data-duration in ROOT/render.html to the film length and writes
//        ROOT/build/film_copy.json (copy.json with every {{key}} filled by the copy lint's own renderer, so the page shows
//        exactly the numbers the lint checked; G10)
//   node scripts/story_vtt.mjs --check   exit 1 if render.html's data-duration is stale or a caption has a literal number
//   node scripts/story_vtt.mjs --json    print the timeline (cut, duration, chunks, cues) as JSON
//
// Caption cues: each beat line (beats.json text slots, copy.json display + sub) at the film time its u window plays in its
// chunk (film time -> p is render.html's eased map, inverted here by bisection), then the chunk caption (copy.json
// film.captions) during the chunk's hold. Chapters: one per chunk, titled by its caption. An unresolved {{key}} is an
// error unless --lenient (drafts only). Kept from v1: the VTT/ffmeta writers and the --stamp/--check/--json contract.
import {readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "docs/tng50/learn/how-a-spectrum-is-made");

/* ---- the film timeline: the same function as render.html's filmTimeline (story_film test compares the two sources) */
export function filmTimeline(film, beats, cut = "film") {
  const B = new Map(beats.map(b => [b.id, b])), fps = film.fps || 30, R = film.render || {};
  const C = film.cuts && film.cuts[cut];
  if (!C) throw new Error(`film.json has no cut "${cut}"`);
  const pick = C.chunks === "all" || !C.chunks ? film.chunks : film.chunks.filter(c => C.chunks.includes(c.id));
  let f = 0; const chunks = [];
  for (const c of pick) {
    const bs = c.beats.map(id => B.get(id)); if (bs.some(x => !x)) throw new Error(`chunk ${c.id}: unknown beat in ${c.beats}`);
    const n = Math.round(c.s * fps); if (Math.abs(n / fps - c.s) > 1e-6) throw new Error(`chunk ${c.id}: ${c.s} s is not a whole number of frames`);
    // the chunk's beats keep their Watch proportions (beats.json watch_s: reading time), scaled to the chunk's length
    // inside a beat the camera dwells where a text line is up (weight 1 + dwell) and moves on between lines
    const ws = bs.map(b => Math.max(0.1, +b.watch_s || (b.p1 - b.p0) * 300)), wt = ws.reduce((a, x) => a + x, 0), dwell = R.dwell ?? 3;
    let acc = 0; const knots = [{x: 0, p: bs[0].p0}];
    bs.forEach((b, i) => {
      const win = (b.text || []).filter(t => !t.when || t.when === "default").map(t => [Math.max(0, t.u0), Math.min(1, t.u1)]);
      const cuts = [...new Set([0, 1, ...win.flat()])].sort((x, y) => x - y);
      const seg = cuts.slice(1).map((u1, k) => { const u0 = cuts[k], m = (u0 + u1) / 2; return {u1, w: (u1 - u0) * (1 + (win.some(([a, z]) => m > a && m < z) ? dwell : 0))}; });
      const sw = seg.reduce((a, x) => a + x.w, 0) || 1;
      for (const g of seg) { acc += ws[i] / wt * g.w / sw; knots.push({x: acc, p: b.p0 + (b.p1 - b.p0) * g.u1}); }
    });
    chunks.push({...c, p0: bs[0].p0, p1: bs[bs.length - 1].p1, f0: f, f1: f + n, frames: n, knots});
    f += n;
  }
  return {fps, frames: f, duration: f / fps, chunks, hold: R.hold_s ?? 1.6, fade: R.fade_s ?? 0.4, capS: R.caption_s ?? 2.4, ease: R.ease ?? 0.15};
}
/* travel fraction x (0..1) -> story position p: velocity ramps up over the first `ease` of the travel and down over the
   last (smoothstep velocity), constant between; then the Watch-proportional knots of the chunk's beats */
export function travelP(TL, c, x) {
  const e = Math.min(0.49, Math.max(1e-3, TL.ease)), S = t => t * t * t - t * t * t * t / 2, A = 1 - e;
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  const pos = (x < e ? e * S(x / e) : x <= 1 - e ? e / 2 + (x - e) : A - e * S((1 - x) / e)) / A;
  const K = c.knots; let i = 1; while (i < K.length - 1 && pos > K[i].x) i++;
  const a = K[i - 1], b = K[i], t = (pos - a.x) / Math.max(1e-12, b.x - a.x);
  return Math.min(c.p1 - 1e-6 * (c.p1 - c.p0), a.p + (b.p - a.p) * (t < 0 ? 0 : t > 1 ? 1 : t));
}
/* film time of story position p inside chunk c (inverse of p = p0 + (p1 - p0) smoother(t / travel)) */
export function timeOfP(TL, c, p) {
  const s = c.frames / TL.fps, travel = Math.max(1e-6, s - (c.card ? 0 : TL.hold));
  if (p <= c.p0) return c.f0 / TL.fps;
  if (p >= travelP(TL, c, 1)) return c.f0 / TL.fps + travel;
  let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (travelP(TL, c, m) < p) lo = m; else hi = m; }
  return c.f0 / TL.fps + lo * travel;
}
/* --check: render.html must carry the same timeline functions as this file (one map from film time to p) */
export function timelineSourceMatches(html, self) {
  const grab = (src, name) => { const i = src.indexOf(`function ${name}(`); if (i < 0) return null; let d = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1).replace(/\s+/g, " "); } return null; };
  return ["filmTimeline", "travelP"].every(n => grab(html, n) && grab(html, n) === grab(self, n));
}

/* ---- copy with keys filled (the lint's renderer: the numbers the lint checked are the numbers shown) */
async function lintHelpers() { return import(pathToFileURL(join(HERE, "..", "tests/js/story_copy_lint.mjs")).href); }
export function resolveCopy(copy, data, L) {
  const derived = L.deriveKeys(copy, data), flags = L.copyFlags ? L.copyFlags(copy, data) : {};
  const missing = new Set();
  const walk = v => {
    if (typeof v === "string") { const s = L.render(v, data, derived, {}); for (const m of s.matchAll(/\{\{\s*([^$}][^}]*?)\s*\}\}/g)) missing.add(m[1]); return s; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ["lint", "rules", "derive", "keys_contract"].includes(k) ? x : walk(x)]));
    return v;
  };
  const out = walk(copy);
  out.meta = {...(out.meta || {}), resolved: true, resolved_by: "scripts/story_vtt.mjs --stamp (tests/js/story_copy_lint.mjs render)", flags};
  return {copy: out, missing: [...missing]};
}

export function vttTime(t) {
  const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
const cueText = s => String(s).replace(/\*/g, "").replace(/-->/g, "→").replace(/\s+/g, " ").trim();

/* cues: beat lines by their u windows, then the chunk caption */
export function buildCues(TL, beats, copy) {
  const B = new Map(beats.map(b => [b.id, b])), cues = [], flags = (copy.meta && copy.meta.flags) || {};
  const entry = id => { const dot = id.indexOf("."); const base = copy[dot < 0 ? id : id.slice(0, dot)]; if (dot < 0) return base;
    const suf = id.slice(dot + 1); if (suf === "0") return base;
    return (base && (base.then || []).find(x => x && x.id === id)) || (base && base.states && base.states[suf]) || null; };
  for (const c of TL.chunks) {
    const t1c = c.f1 / TL.fps;
    if (!c.card) for (const id of c.beats) {
      const b = B.get(id);
      for (const t of b.text || []) {
        if (t.when && t.when !== "default") continue;            // override-only variants are not in the film
        if (t.cond && flags[t.cond] !== true) continue;          // copy flag false: the slot does not show
        const e = entry(t.id); if (!e) continue;
        const txt = [t.part !== "sub" ? e.display : null, t.part !== "display" ? e.sub : null].filter(Boolean).map(cueText).join(" ");
        if (!txt) continue;
        const a = timeOfP(TL, c, b.p0 + (b.p1 - b.p0) * t.u0), z = timeOfP(TL, c, b.p0 + (b.p1 - b.p0) * t.u1);
        if (z - a >= 0.8) cues.push({t0: a, t1: Math.min(z, t1c), text: txt, chunk: c.id, beat: id});
      }
    }
    const cap = copy.film && copy.film.captions && copy.film.captions[c.id];
    if (cap && !c.card) cues.push({t0: t1c - TL.capS, t1: t1c - TL.fade, text: cueText(cap), chunk: c.id, kind: "caption"});
    if (c.card) cues.push({t0: c.f0 / TL.fps, t1: t1c, text: cueText((copy.film && copy.film.end_card_title) || "How a spectrum is made"), chunk: c.id, kind: "card"});
  }
  cues.sort((x, y) => x.t0 - y.t0);
  // a caption stays up long enough to read (0.9 s + 0.22 s a word, at most 4 s) unless the next cue starts; never overlapping
  const wordsOf = s => s.split(/\s+/).filter(Boolean).length;
  for (let i = 0; i < cues.length; i++) {
    const next = i + 1 < cues.length ? cues[i + 1].t0 - 0.05 : TL.duration;
    cues[i].t1 = Math.min(next, Math.max(cues[i].t1, cues[i].t0 + Math.min(4, 0.9 + 0.22 * wordsOf(cues[i].text))));
  }
  return cues.filter(q => q.t1 - q.t0 > 0.3);
}
export function buildVtt(TL, cues, copy) {
  const cap = ["WEBVTT", "Kind: captions", "Language: en", ""];
  cues.forEach((q, i) => cap.push(String(i + 1), `${vttTime(q.t0)} --> ${vttTime(q.t1)}`, q.text, ""));
  const chap = ["WEBVTT", "Kind: chapters", "Language: en", ""], meta = [";FFMETADATA1", "title=How a spectrum is made", ""];
  TL.chunks.forEach((c, i) => {
    const title = cueText((copy.film && copy.film.captions && copy.film.captions[c.id]) || c.id);
    chap.push(String(i + 1), `${vttTime(c.f0 / TL.fps)} --> ${vttTime(c.f1 / TL.fps)}`, title, "");
    meta.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${Math.round(c.f0 / TL.fps * 1000)}`, `END=${Math.round(c.f1 / TL.fps * 1000)}`, `title=${title.replace(/[=;#\\\n]/g, x => "\\" + x)}`, "");
  });
  return {captions: cap.join("\n"), chapters: chap.join("\n"), ffmeta: meta.join("\n")};
}
/* G10 for captions: a caption names a parameter; it carries no number (beat lines carry numbers only through {{keys}}) */
export const captionNumbers = copy => Object.entries((copy.film && copy.film.captions) || {}).filter(([k, s]) => k !== "end" && /\d/.test(s)).map(([k]) => k);

export function stampHtml(html, TL) {
  const d = String(+TL.duration.toFixed(6));
  return html.replace(/(<div id="root"[^>]*?data-duration=")[^"]*(")/, `$1${d}$2`).replace(/(<main id="stage"[^>]*?data-duration=")[^"]*(")/, `$1${d}$2`);
}

async function main() {
  const a = {root: DEFAULT_ROOT, cut: "film"};
  const av = process.argv.slice(2);
  for (let i = 0; i < av.length; i++) { const k = av[i];
    if (k === "--root") a.root = resolve(av[++i]); else if (k === "--cut") a.cut = av[++i]; else if (k === "--data") a.data = resolve(av[++i]);
    else if (k === "--lenient") a.lenient = true; else if (k === "--stamp") a.stamp = true; else if (k === "--check") a.check = true; else if (k === "--json") a.json = true;
    else throw new Error(`unknown argument ${k}`); }
  const rd = f => JSON.parse(readFileSync(join(a.root, f), "utf8"));
  const film = rd("film.json"), beats = rd("beats.json").beats, copyRaw = rd("copy.json");
  const TL = filmTimeline(film, beats, a.cut);
  let dataFile = a.data;
  if (!dataFile) { const ix = existsSync(join(a.root, "data/index.json")) ? rd("data/index.json") : null;
    const e = ix && ix.stories.find(s => +s.galaxy === +film.galaxy && s.ray === film.ray); dataFile = join(a.root, "data", e ? e.story : `story_${film.galaxy}_${film.ray}.json`); }
  const data = JSON.parse(readFileSync(dataFile, "utf8"));
  const L = await lintHelpers();
  const {copy, missing} = resolveCopy(copyRaw, data, L);
  const html = readFileSync(join(a.root, "render.html"), "utf8");
  const stale = stampHtml(html, TL) !== html;
  const nums = captionNumbers(copyRaw);
  if (a.check) {
    const bad = [];
    if (stale) bad.push(`render.html data-duration is stale (film ${TL.duration} s): run --stamp`);
    if (nums.length) bad.push(`film captions with literal numbers: ${nums.join(", ")}`);
    if (!timelineSourceMatches(html, readFileSync(fileURLToPath(import.meta.url), "utf8"))) bad.push("render.html and story_vtt.mjs disagree on filmTimeline/travelP");
    // review3 science M3 (fix3): the film's text snapshot and captions must equal what copy.json renders to today, or the
    // film shows numbers the page has withdrawn (+3, +61, +99 and 37 % lingered after the page moved to +61, +98 and 32 %)
    if (a.cut === "film") {
      const fc = join(a.root, "build/film_copy.json"), vt = join(a.root, "media/story.en.vtt");
      if (!existsSync(fc) || readFileSync(fc, "utf8") !== JSON.stringify(copy) + "\n") bad.push("build/film_copy.json is stale against copy.json + data: run --stamp (then rerender the film, U_film)");
      const v = buildVtt(TL, buildCues(TL, beats, copy), copy);
      if (!existsSync(vt) || readFileSync(vt, "utf8") !== v.captions + "\n") bad.push("media/story.en.vtt is stale against copy.json + beats.json: run --stamp (then rerender the film, U_film)");
    }
    if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
    console.log(`ok: film ${TL.duration} s, ${TL.chunks.length} chunks, captions free of literal numbers`); return;
  }
  const cues = buildCues(TL, beats, copy);
  if (a.json) { console.log(JSON.stringify({cut: a.cut, duration: TL.duration, frames: TL.frames, chunks: TL.chunks.map(c => ({id: c.id, beats: c.beats, p0: c.p0, p1: c.p1, f0: c.f0, f1: c.f1})), cues, missing}, null, 1)); return; }
  const unresolved = cues.filter(q => /\{\{/.test(q.text));
  if ((unresolved.length || nums.length) && !a.lenient) {
    console.error(`unresolved keys in film cues: ${[...new Set(unresolved.flatMap(q => [...q.text.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1])))].join(", ")}${nums.length ? `; captions with numbers: ${nums}` : ""}`);
    process.exit(1);
  }
  if (a.stamp) {
    writeFileSync(join(a.root, "render.html"), stampHtml(html, TL));
    mkdirSync(join(a.root, "build"), {recursive: true});
    writeFileSync(join(a.root, "build/film_copy.json"), JSON.stringify(copy) + "\n");
    console.log(`stamped render.html: ${TL.duration} s (${TL.frames} frames); build/film_copy.json (${missing.length} keys still pending${missing.length ? ": " + missing.slice(0, 12).join(", ") : ""})`);
  }
  const v = buildVtt(TL, cues, copy), media = join(a.root, "media"), stem = a.cut === "film" ? "story" : `story.${a.cut}`;
  mkdirSync(media, {recursive: true});
  writeFileSync(join(media, `${stem}.en.vtt`), v.captions + "\n");
  writeFileSync(join(media, `${stem}.chapters.vtt`), v.chapters + "\n");
  writeFileSync(join(media, `${stem}.ffmeta`), v.ffmeta + "\n");
  console.log(`wrote media/${stem}.{en.vtt,chapters.vtt,ffmeta}: ${cues.length} cues, ${TL.chunks.length} chapters, ${TL.duration} s`);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.stack || e); process.exit(1); });
