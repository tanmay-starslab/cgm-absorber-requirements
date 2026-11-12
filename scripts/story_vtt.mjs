#!/usr/bin/env node
// story_vtt.mjs: captions, chapters and render compositions for the "How a spectrum is made" film,
// all derived from ROOT/steps.json (never hand-edited).
//
//   node scripts/story_vtt.mjs [--root DIR] [--cut film|full] [--data FILE] [--lenient]
//        writes ROOT/media/story[.<cut>].en.vtt, story[.<cut>].chapters.vtt, story[.<cut>].ffmeta
//        (film keeps the plain names story.en.vtt / story.chapters.vtt)
//   node scripts/story_vtt.mjs --stamp     sets data-duration in ROOT/render.html to the film length and
//                                          writes ROOT/build/render_<cut>.html for every other cut
//   node scripts/story_vtt.mjs --check     exit 1 if render.html's data-duration is stale
//   node scripts/story_vtt.mjs --json      print the timeline (cut, duration, steps, chapters) as JSON
//
// Step fields used: id, chapter, title, text, caption, dur_s, film (bool), film_dur_s (film-only length).
// Timing and {{key}} filling come from the story engine itself (ROOT/js/engine.js: buildTimeline,
// resolveTemplate with steps.json "keys"), so captions can never drift from what render.html draws.
// The local fallbacks below are used only if engine.js cannot be imported. An unresolved key is an
// error unless --lenient (drafts only). Data: --data, else meta.data, else data/story_<g>_<ray>.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FPS = 30;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "docs/tng50/learn/how-a-spectrum-is-made");

export function parseArgs(argv) {
  const a = { root: DEFAULT_ROOT, cut: "film", data: null, lenient: false, stamp: false, check: false, json: false, cuts: ["film", "full"] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--root") a.root = resolve(argv[++i]);
    else if (k === "--cut") a.cut = argv[++i];
    else if (k === "--data") a.data = resolve(argv[++i]);
    else if (k === "--lenient") a.lenient = true;
    else if (k === "--stamp") a.stamp = true;
    else if (k === "--check") a.check = true;
    else if (k === "--json") a.json = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

export function loadSteps(root) {
  const raw = JSON.parse(readFileSync(join(root, "steps.json"), "utf8"));
  const steps = Array.isArray(raw) ? raw : raw.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error("steps.json has no steps");
  return { meta: Array.isArray(raw) ? {} : raw, steps };
}

// Duration of a step inside a cut, in whole frames (0 = not in the cut). Mirrors engine.buildTimeline.
export function stepFrames(step, cut) {
  if (cut === "film" && !step.film) return 0;
  const d = cut === "film" && typeof step.film_dur_s === "number" ? step.film_dur_s : step.dur_s;
  const f = Math.round(d * FPS);
  if (!(f > 0)) throw new Error(`step ${step.id}: bad duration ${d}`);
  if (Math.abs(f / FPS - d) > 1e-6) throw new Error(`step ${step.id}: dur ${d} s is not a multiple of 1/${FPS} s`);
  return f;
}

async function loadEngine(root) {
  try { return await import(pathToFileURL(join(root, "js", "engine.js")).href); }
  catch (e) { process.stderr.write(`story_vtt: engine.js not importable (${e.message}); using local timing and resolver\n`); return null; }
}

export function timeline(steps, cut, engine = null) {
  if (cut !== "film" && cut !== "full") throw new Error(`unknown cut ${cut}`);
  const out = [], chapters = [];
  for (const s of steps) stepFrames(s, cut); // validates 1/30 s multiples even when the engine does the timing
  const etl = engine && engine.buildTimeline ? engine.buildTimeline(steps, cut) : null;
  const frames = etl ? new Map(etl.items.map((it) => [it.index, it.frames])) : null;
  let f0 = 0;
  for (const [index, s] of steps.entries()) {
    const n = frames ? frames.get(index) || 0 : stepFrames(s, cut);
    if (!n) continue;
    out.push({ id: s.id, chapter: s.chapter, f0, f1: f0 + n, t0: f0 / FPS, t1: (f0 + n) / FPS, step: s });
    const last = chapters[chapters.length - 1];
    if (last && last.chapter === s.chapter) { last.f1 = f0 + n; last.t1 = (f0 + n) / FPS; }
    else chapters.push({ chapter: s.chapter, title: s.title || null, f0, f1: f0 + n, t0: f0 / FPS, t1: (f0 + n) / FPS });
    f0 += n;
  }
  // chapter title = the chapter's first step title anywhere in the page (the film may skip that step)
  for (const c of chapters) if (!c.title) c.title = (steps.find((s) => s.chapter === c.chapter && s.title) || {}).title || c.chapter;
  return { cut, frames: f0, duration: f0 / FPS, steps: out, chapters };
}

function dotted(obj, key) {
  let v = obj;
  for (const p of key.split(".")) { if (v == null) return undefined; v = v[p]; }
  return v;
}

export function makeResolver(engine, data, keys, lenient) {
  return (str) => {
    if (engine && engine.resolveTemplate) {
      const r = engine.resolveTemplate(str, data, keys);
      if (r.missing.length && !lenient) throw new Error(`unresolved template keys ${r.missing.join(", ")} in "${str}"`);
      if (r.fallback.length) process.stderr.write(`story_vtt: fallback used for ${r.fallback.join(", ")}\n`);
      return r.text;
    }
    return String(str).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, k) => {
      const spec = keys && keys[k];
      let v = dotted(data.vars || {}, spec && spec.path || k) ?? dotted(data, spec && spec.path || k);
      if (v == null && spec && spec.fallback !== undefined) v = spec.fallback;
      if (v === undefined || v === null || typeof v === "object") {
        if (lenient) return all;
        throw new Error(`unresolved template key {{${k}}}`);
      }
      return String(v);
    });
  };
}

export function vttTime(t) {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
}

function cueText(s) { return String(s).replace(/-->/g, "→").replace(/\s+/g, " ").trim(); }

export function buildVtt(tl, fill) {
  const cap = ["WEBVTT", "Kind: captions", "Language: en", ""];
  for (const s of tl.steps) {
    const text = s.step.caption ?? s.step.text;
    if (!text) throw new Error(`step ${s.id}: no caption or text`);
    cap.push(s.id, `${vttTime(s.t0)} --> ${vttTime(s.t1)}`, cueText(fill(text)), "");
  }
  const chap = ["WEBVTT", "Kind: chapters", "Language: en", ""];
  for (const c of tl.chapters) chap.push(c.chapter, `${vttTime(c.t0)} --> ${vttTime(c.t1)}`, cueText(fill(c.title)), "");
  // ffmpeg metadata file: MP4 chapter atoms (players show them as chapter marks)
  const meta = [";FFMETADATA1", "title=How a spectrum is made", ""];
  for (const c of tl.chapters) meta.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${Math.round(c.t0 * 1000)}`, `END=${Math.round(c.t1 * 1000)}`, `title=${fill(c.title).replace(/[=;#\\\n]/g, (x) => "\\" + x)}`, "");
  return { captions: cap.join("\n"), chapters: chap.join("\n"), ffmeta: meta.join("\n") };
}

const DUR_RE = /(<[^>]*data-composition-id="spectrum-story"[^>]*?data-duration=")([0-9.]+)(")/s;

export function stampHtml(html, tl, cut, base) {
  if (!DUR_RE.test(html)) throw new Error("render.html: root data-duration not found");
  let out = html.replace(DUR_RE, `$1${tl.duration}$3`)
    .replace(/(id="stage"[^>]*?data-duration=")([0-9.]+)(")/s, `$1${tl.duration}$3`)
    .replace(/data-cut="[a-z]+"/, `data-cut="${cut}"`);
  if (base) out = out.replace(/<head>/, `<head>\n<base href="${base}" />`);
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const { meta, steps } = loadSteps(a.root);
  const doc = JSON.parse(readFileSync(join(a.root, "steps.json"), "utf8"));
  const engine = await loadEngine(a.root);
  const g = meta.meta && (meta.meta.subhalo ?? meta.meta.g), ray = meta.meta && meta.meta.ray;
  const dataFile = a.data || (meta.meta && meta.meta.data ? join(a.root, meta.meta.data)
    : join(a.root, "data", `story_${g ?? 488530}_${ray ?? "rand_b062_a062"}.json`));
  const renderHtml = join(a.root, "render.html");

  if (a.check || a.stamp) {
    const html = readFileSync(renderHtml, "utf8");
    const film = timeline(steps, "film", engine);
    const cur = Number((html.match(DUR_RE) || [])[2]);
    if (a.check) {
      if (Math.abs(cur - film.duration) > 1e-9) { console.error(`render.html data-duration ${cur} != film ${film.duration}`); process.exit(1); }
      console.log(`render.html data-duration ${cur} s ok`);
      return;
    }
    writeFileSync(renderHtml, stampHtml(html, film, "film", null));
    mkdirSync(join(a.root, "build"), { recursive: true });
    for (const cut of a.cuts.filter((c) => c !== "film")) {
      const tl = timeline(steps, cut, engine);
      writeFileSync(join(a.root, "build", `render_${cut}.html`), stampHtml(html, tl, cut, null)); // base comes from render.html's own script
    }
    console.log(`stamped film ${film.duration} s; build/ for ${a.cuts.filter((c) => c !== "film").join(", ")}`);
    return;
  }

  const tl = timeline(steps, a.cut, engine);
  for (const c of tl.chapters) { const t = (doc.chapters || []).find((x) => x.id === c.chapter); if (t && t.title) c.title = t.title; }
  if (a.json) { console.log(JSON.stringify({ cut: tl.cut, frames: tl.frames, duration: tl.duration, chapters: tl.chapters, steps: tl.steps.map(({ step, ...r }) => r) }, null, 1)); return; }
  const data = existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, "utf8")) : {};
  if (!existsSync(dataFile) && !a.lenient) throw new Error(`data file ${dataFile} not found`);
  const fill = makeResolver(engine, data, doc.keys || null, a.lenient);
  const v = buildVtt(tl, fill);
  const media = join(a.root, "media");
  mkdirSync(media, { recursive: true });
  const stem = a.cut === "film" ? "story" : `story.${a.cut}`;
  writeFileSync(join(media, `${stem}.en.vtt`), v.captions);
  writeFileSync(join(media, `${stem}.chapters.vtt`), v.chapters);
  writeFileSync(join(media, `${stem}.ffmeta`), v.ffmeta);
  console.log(`${a.cut}: ${tl.steps.length} cues, ${tl.chapters.length} chapters, ${tl.duration} s (${tl.frames} frames) -> media/${stem}.*`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error(`story_vtt: ${e.message}`); process.exit(1); });
}
