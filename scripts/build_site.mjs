#!/usr/bin/env node
// Builds the Cloudflare site (galaxies.tanmaysingh.uk) from docs/ into dist/, no dependencies:
//   /                                   the TNG50 explorer          (docs/tng50/)
//   /learn/how-a-spectrum-is-made/      the explainer               (docs/tng50/learn/...)
//   /detect/                            Detect & Resolve            (docs/index.html, also served at /observe/ and /requirements/)
// The relative links inside the explorer and the explainer already work at this layout; only the links between
// Detect & Resolve and the explorer are rewritten. dist/_redirects keeps old /tng50/... and /requirements/ paths working.
//   /learn/how-a-spectrum-is-made/<id>/ one page per listed Tier A story, only when data/index.json has picker "cases"
// Used by Cloudflare Workers Builds (build command: node scripts/build_site.mjs) and locally.
// Test hooks (tests/js/site_paths.mjs): BUILD_SITE_OUT (output dir), BUILD_SITE_INDEX (an index.json used as the shipped one).
import {cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync} from "node:fs";
import {gzipSync} from "node:zlib";
import {join, basename, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "docs"), OUT = process.env.BUILD_SITE_OUT || join(ROOT, "dist");
const SKIP_NAMES = new Set(["_template.html", ".gitignore", ".DS_Store", "build"]);
const SKIP_EXT = [".md", ".py", ".sh"];
const skip = p => { const b = basename(p); return SKIP_NAMES.has(b) || SKIP_EXT.some(e => b.endsWith(e)) || b.endsWith(".mp4"); };

rmSync(OUT, {recursive: true, force: true});
mkdirSync(OUT, {recursive: true});
cpSync(join(SRC, "tng50"), OUT, {recursive: true, filter: src => !skip(src)});

// Detect & Resolve at /detect/ (with /observe/ and /requirements/ also populated so every short or legacy URL serves HTTP 200):
let dr = readFileSync(join(SRC, "index.html"), "utf8");
dr = dr.replaceAll('href="tng50/learn/', 'href="/learn/').replaceAll('href="tng50/"', 'href="/"').replaceAll('href="tng50/favicon.ico"', 'href="/favicon.ico"').replaceAll('href="tng50/img/icon/', 'href="/img/icon/').replaceAll('href="tng50/site.webmanifest"', 'href="/site.webmanifest"')
  .replaceAll('href="tng50/css/', 'href="/css/').replaceAll('href="tng50/fonts/', 'href="/fonts/')   // shared tokens.css, page.css and fonts
  .replaceAll('from "tng50/js/', 'from "/js/');                                            // the explorer's liquidtabs.js
for (const slug of ["detect", "observe", "requirements"]) {
  mkdirSync(join(OUT, slug), {recursive: true});
  writeFileSync(join(OUT, slug, "index.html"), dr);
}

// the explorer's companion links (were ../ on GitHub Pages)
const ix = join(OUT, "index.html");
writeFileSync(ix, readFileSync(ix, "utf8").replaceAll('href="../" data-req=""', 'href="/detect/" data-req=""')
  .replaceAll('data-req="" href="../"', 'data-req="" href="/detect/"')
  .replaceAll('<a href="../">Detect and resolve', '<a href="/detect/">Detect and resolve'));

// perf R5, dist only (docs/ keeps the raw files the tests and the local server read):
//  - data/s/*.bin gzipped in place (about 72 -> 9 kB each; js/app.js and the explainer's engine.js fetchBin inflate gzip magic);
//  - data/components.json split into data/c/<id>.json (that sightline's rows and AOD plus the catalogue's params), announced
//    to the page as CFG.components_dir, so the first fits load a few kB instead of the whole catalogue (Find and Ask still
//    load the whole file).
const SDIR = join(OUT, "data", "s");
if (existsSync(SDIR)) for (const f of readdirSync(SDIR)) if (f.endsWith(".bin")) { const p = join(SDIR, f), b = readFileSync(p);
  if (!(b[0] === 0x1f && b[1] === 0x8b)) writeFileSync(p, gzipSync(b, {level: 9})); }
const COMP = join(OUT, "data", "components.json");
if (existsSync(COMP)) {
  const {entries = {}, aod = {}, ...meta} = JSON.parse(readFileSync(COMP, "utf8")), CDIR = join(OUT, "data", "c");
  mkdirSync(CDIR, {recursive: true});
  for (const [id, rows] of Object.entries(entries)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`build: component id ${JSON.stringify(id)} cannot be a file name`);
    writeFileSync(join(CDIR, id + ".json"), JSON.stringify({...meta, entries: {[id]: rows}, aod: id in aod ? {[id]: aod[id]} : {}}));
  }
  const html = readFileSync(ix, "utf8"), key = '"components_url":"data/components.json"';
  if (!html.includes(key)) throw new Error("build: the explorer config has no components_url; update the components_dir edit");
  writeFileSync(ix, html.replace(key, key + ',"components_dir":"data/c/"'));
}
// perf R5 (mobile LCP): phones show the default sightline's story still in the first-visit card (js/app.js storyEntry); preload
// it from the head at high priority instead of fetching it when the card opens
{ const html = readFileSync(ix, "utf8"), cfg = JSON.parse((html.match(/const DATA = (\{.*?\});\nwindow\.TNG_DATA/s) || [0, "{}"])[1]);
  const g = cfg.galaxy?.subhalo_id, id = cfg.defaults?.id, img = `learn/how-a-spectrum-is-made/img/poster_${g}_${id}_card.webp`, css = '<link rel="stylesheet" href="css/page.css">';
  if (g && id && existsSync(join(OUT, img)) && html.includes(css))
    writeFileSync(ix, html.replace(css, `<link rel="preload" as="image" href="${img}" fetchpriority="high" media="(max-width: 639px)">\n` + css)); }

writeFileSync(join(OUT, "_redirects"), ["/tng50/* /:splat 301", "/tng50 / 301", ""].join("\n"));
// Cache rules (Workers static assets _headers: one splat per rule, :placeholders match one path segment, and a header set by
// two matching rules is joined with a comma, so no path matches two Cache-Control rules). Vendor files and fonts never
// change in place: a year, immutable. js, css and data: revalidated every load (no-cache, 304 when unchanged); images: 5 minutes, then stale-while-revalidate. HTML
// (and anything unlisted) keeps the default revalidate-every-time.
// code and data are revalidated on every load (a cheap 304 when unchanged): serving them stale let a browser run an old
// module next to new CSS after a release (the Edge 'Head + Hands' box, 2026-11-21). Only never-edited images keep a short cache.
const SWR = "public, max-age=300, stale-while-revalidate=86400", IMM = "public, max-age=31536000, immutable", FRESH = "no-cache";
const rule = (path, cc) => [path, `  Cache-Control: ${cc}`];
writeFileSync(join(OUT, "_headers"), [
  "/*", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: strict-origin-when-cross-origin",
  // fonts too: the woff2 names are not hashed, so a changed font file must get a new name
  ...rule("/vendor/*", IMM), ...rule("/learn/:story/vendor/*", IMM), ...rule("/fonts/*", IMM),
  ...["js", "css", "data"].flatMap(d => rule(`/${d}/*`, FRESH)), ...rule("/img/*", SWR),
  ...["js", "css", "data", "eq"].flatMap(d => rule(`/learn/:story/${d}/*`, FRESH)),
  ...["img", "media", "films"].flatMap(d => rule(`/learn/:story/${d}/*`, SWR)), ""].join("\n"));
// Per-case story paths (DESIGN_tierA §7.3, behind the picker flag): a copy of the explainer page per listed story, with
// <base href="../"> for its relative assets and the story id put into ?story= before any page script reads it.
// shortcut: the shim rewrites the address to <id>/?story=<id> because js/main.js reads only ?story=; drop it once
// main.js also reads <html data-story>.
const LEARN = join(OUT, "learn", "how-a-spectrum-is-made"), SITE = "https://galaxies.tanmaysingh.uk/learn/how-a-spectrum-is-made/";
if (process.env.BUILD_SITE_INDEX) cpSync(process.env.BUILD_SITE_INDEX, join(LEARN, "data", "index.json"));
const sidx = JSON.parse(readFileSync(join(LEARN, "data", "index.json"), "utf8"));
const caseIds = sidx.picker === "cases" ? (sidx.stories || []).filter(e => e.case && e.case !== "full" && e.gates && e.gates.all === true).map(e => e.id) : [];
const page = caseIds.length ? readFileSync(join(LEARN, "index.html"), "utf8") : "";
for (const id of caseIds) {
  if (!/^[a-z][a-z0-9-]*$/.test(id) || existsSync(join(LEARN, id))) throw new Error(`build: story id ${JSON.stringify(id)} cannot be a path`);
  // <base> would also resolve history.replaceState("#frag") to the hero page, so the shim resolves state URLs against the address.
  const shim = `<script>(function(){var h=history;["pushState","replaceState"].forEach(function(k){var f=h[k];h[k]=function(s,t,u){return f.call(h,s,t,u==null?u:new URL(u,location.href).href);};});var q=new URLSearchParams(location.search);if(q.get("story")!=="${id}"){q.set("story","${id}");history.replaceState(history.state,"",location.pathname+"?"+q+location.hash);}})()</script>`;
  const html = page.replace('<html lang="en"', `<html lang="en" data-story="${id}"`).replace("<head>\n", `<head>\n<base href="../">\n${shim}\n`)
    .replaceAll(`href="${SITE}"`, `href="${SITE}${id}/"`).replaceAll(`content="${SITE}"`, `content="${SITE}${id}/"`);
  if (!html.includes('<base href="../">') || !html.includes(`data-story="${id}"`)) throw new Error("build: explainer page head changed; update the per-story page edit");
  mkdirSync(join(LEARN, id));
  writeFileSync(join(LEARN, id, "index.html"), html);
}
if (!existsSync(join(OUT, "index.html")) || !existsSync(join(LEARN, "index.html")) || caseIds.some(id => !existsSync(join(LEARN, id, "index.html")))) throw new Error("build: missing pages");
console.log("built", OUT);
