#!/usr/bin/env node
// Per-case story paths in the built site (DESIGN_tierA §7.3, unit R6b): scripts/build_site.mjs emits
// /learn/how-a-spectrum-is-made/<id>/ for every story listed in data/index.json (picker "cases", gates.all), else nothing.
// Node part (always): builds dist into temp dirs (BUILD_SITE_OUT; BUILD_SITE_INDEX swaps in a test story-index/2)
//   - the shipped index (picker "off" or story-index/1) emits no case path;
//   - a test index with picker "cases" emits exactly the listed stories (one story unlisted, and picker "off", emit none);
//   - each page: data-story, <base href="../">, the ?story shim before every other script, its own canonical/og:url;
//   - a story id that is not a safe path segment fails the build; dist growth reported (raw, gzip) and < 50 kB gzip.
// Browser part (TNG_BROWSER=1; [--shots DIR]): the dist served with the Worker's static-asset rules (auto-trailing-slash:
//   a directory without the slash redirects to it, <dir>/ serves <dir>/index.html; anything else missing is 404). Every
//   path boots its story (beats ids equal beats.<id>.json, its story file fetched, the address stays on the path) and makes
//   the same same-origin requests with the same statuses as index.html?story=<id> (every request 200 except 404s the
//   ?story= page shares, which are data gaps, not path faults, and are listed as notes); /<id> redirects to /<id>/; the
//   hero path keeps working.
import {readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync, statSync} from "node:fs";
import {join, resolve, extname} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";
import {gzipSync, gunzipSync} from "node:zlib";
import {ROOT as REPO, parseArgs, checker, launch, BLOCK, sleep} from "./lib/browser.mjs";

const {opt} = parseArgs(process.argv.slice(2));
const C = checker(), check = C.check, note = C.note;
const BUILD = join(REPO, "scripts/build_site.mjs"), STORY = "learn/how-a-spectrum-is-made", SROOT = join(REPO, "docs/tng50", STORY);
const CASE_IDS = ["clean", "multiphase", "damped", "empty", "hot"];
const TMP = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "r6b-site-"));
const IX = JSON.parse(readFileSync(join(SROOT, "data/index.json"), "utf8"));

/* a story-index/2 with picker "cases" (test only): the shipped one when it is /2, else the hero entry plus the director's
   beats.<id>.json (as tests/js/story_handoff.mjs tierIndex) */
function testIndex(listed = CASE_IDS, picker = "cases") {
  if (IX.schema === "story-index/2") return {...IX, picker, stories: IX.stories.map(e => ({...e, gates: {...(e.gates || {}), all: e.case === "full" || listed.includes(e.id)}}))};
  const st = [{...IX.stories[0], id: "full", case: "full", beats: "beats.json", shots: "shots.json", gates: {all: true}}];
  for (const id of CASE_IDS) {
    const f = join(SROOT, `beats.${id}.json`); if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, "utf8")).meta || {}, file = String(m.generator?.data?.file || "").split("/data/").pop();
    if (!file) continue;
    let subcase = null; try { subcase = JSON.parse(readFileSync(join(SROOT, "data", file), "utf8")).case?.subcase ?? null; } catch { /* none */ }
    st.push({id, galaxy: +m.refGalaxy, ray: m.refRay, case: m.case, subcase, story: file, page_fits: file.replace(/story_/, "page_fits_"),
             beats: `beats.${id}.json`, shots: `shots.${id}.json`, label: `Subhalo ${m.refGalaxy}`, eligible: true, gates: {all: listed.includes(id)}});
  }
  return {schema: "story-index/2", default: IX.default, default_story: "full", picker, ...(IX.fion ? {fion: IX.fion} : {}), stories: st};
}
function build(name, index) {
  const out = join(TMP, name), env = {...process.env, BUILD_SITE_OUT: out};
  if (index) { const f = join(TMP, name + ".index.json"); writeFileSync(f, JSON.stringify(index)); env.BUILD_SITE_INDEX = f; } else delete env.BUILD_SITE_INDEX;
  try { execFileSync(process.execPath, [BUILD], {env, stdio: "pipe"}); return {out, err: null}; }
  catch (e) { return {out, err: String(e.stderr || e.message)}; }
}
const casePages = out => readdirSync(join(out, STORY)).filter(d => existsSync(join(out, STORY, d, "index.html")));
const sizes = (out, ids) => ids.reduce((a, id) => { const b = readFileSync(join(out, STORY, id, "index.html")); return {raw: a.raw + b.length, gz: a.gz + gzipSync(b, {level: 9}).length}; }, {raw: 0, gz: 0});

/* ---------------- node part ---------------- */
const ship = build("ship");
check(!ship.err, `shipped index (${IX.schema}, picker ${JSON.stringify(IX.picker || "off")}) builds${ship.err ? ": " + ship.err.slice(0, 300) : ""}`);
if (!ship.err && IX.picker !== "cases") check(!casePages(ship.out).length, `shipped index emits no case path (found: ${casePages(ship.out).join(", ") || "none"})`);
if (!ship.err) {   // ux(a): the shared tokens.css and self-hosted fonts resolve from every page; fonts cached for a year
  const miss = [["index.html", "/"], ["detect/index.html", "/detect/"], ["requirements/index.html", "/requirements/"], [`${STORY}/index.html`, `/${STORY}/`]].flatMap(([f, base]) =>
    [...readFileSync(join(ship.out, f), "utf8").matchAll(/href="([^"]*(?:tokens\.css|\.woff2))"/g)].map(m => new URL(m[1], "http://x" + base).pathname)
      .filter(p => !existsSync(join(ship.out, p))).map(p => `${f}: ${p}`));
  check(!miss.length, `font preloads and tokens.css resolve in dist${miss.length ? ": " + miss.join(", ") : ""}`);
  check(/^\/fonts\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m.test(readFileSync(join(ship.out, "_headers"), "utf8")), "dist/_headers caches /fonts/* for a year");
  // Detect & Resolve reuses the explorer's page.css and liquidtabs.js at /detect/ (and legacy /requirements/): every tng50/ reference is rewritten to the site root
  const dr = readFileSync(join(ship.out, "detect/index.html"), "utf8"), left = [...dr.matchAll(/(?:href|src)="tng50\/[^"]*"|from "tng50\/[^"]*"/g)].map(m => m[0]);
  check(!left.length && existsSync(join(ship.out, "requirements/index.html")) && existsSync(join(ship.out, "observe/index.html")) && existsSync(join(ship.out, "css/page.css")) && existsSync(join(ship.out, "js/liquidtabs.js")), `detect (/detect/, /observe/, /requirements/) page links resolve to the site root${left.length ? ": " + left.join(", ") : ""}`);
  check(readFileSync(join(ship.out, "index.html"), "utf8").includes('id="req-link"') && readFileSync(join(ship.out, "index.html"), "utf8").includes('href="/detect/"'), "dist index.html links #req-link to /detect/");
}
if (IX.picker === "cases") note("shipped index has picker \"cases\": its listed stories get paths (checked below with the test index)");
/* perf R5 dist transforms: gzipped sightline bins that inflate to the repository's bytes, per-sightline component slices
   announced as components_dir, and cache rules where no path gets two Cache-Control headers */
if (!ship.err) {
  const sd = join(REPO, "docs/tng50/data/s"), bins = existsSync(sd) ? readdirSync(sd).filter(f => f.endsWith(".bin")).slice(0, 3) : [];
  for (const f of bins) { const b = readFileSync(join(ship.out, "data/s", f));
    check(b[0] === 0x1f && b[1] === 0x8b && gunzipSync(b).equals(readFileSync(join(sd, f))), `dist data/s/${f} is gzip of the repository file (${b.length} B)`); }
  const comp = join(REPO, "docs/tng50/data/components.json");
  if (existsSync(comp)) { const full = JSON.parse(readFileSync(comp, "utf8")), id = Object.keys(full.entries)[0];
    const one = JSON.parse(readFileSync(join(ship.out, "data/c", id + ".json"), "utf8"));
    check(JSON.stringify(one.entries[id]) === JSON.stringify(full.entries[id]) && one.params_tag === full.params_tag && JSON.stringify(one.params) === JSON.stringify(full.params) && Object.keys(one.entries).length === 1,
      `dist data/c/${id}.json holds that sightline's rows and the catalogue's params`);
    check(readFileSync(join(ship.out, "index.html"), "utf8").includes('"components_dir":"data/c/"'), "dist index.html announces components_dir"); }
  const H = readFileSync(join(ship.out, "_headers"), "utf8"), rules = H.split(/\n(?=\/)/).map(b => ({path: b.split("\n")[0], cc: (b.match(/Cache-Control: (.*)/) || [])[1]})).filter(r => r.cc);
  const re = p => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]\w*/g, "[^/]+").replace("*", ".*") + "$");
  const hits = u => rules.filter(r => re(r.path).test(u)).map(r => r.cc);
  for (const [u, want] of [["/js/app.js", /^no-cache$/], ["/css/page.css", /^no-cache$/], ["/data/s/x.bin", /^no-cache$/], ["/img/og/explorer.jpg", /stale-while-revalidate/], ["/learn/how-a-spectrum-is-made/vendor/katex/katex.min.js", /immutable/],
    ["/learn/how-a-spectrum-is-made/js/main.js", /^no-cache$/], ["/", null], ["/learn/how-a-spectrum-is-made/", null], ["/index.html", null]]) {
    const h = hits(u); check(want ? h.length === 1 && want.test(h[0]) : !h.length, `_headers: ${u} -> ${h.join(" | ") || "default (revalidate)"}`); }
  check(rules.every(r => (r.path.match(/\*/g) || []).length <= 1), "_headers: at most one splat per rule");
}

const TIX = testIndex(), ids = TIX.stories.filter(e => e.case !== "full").map(e => e.id);
check(ids.length > 0, `test index lists ${ids.length} stories (${ids.join(", ")})`);
const all = build("cases", TIX);
check(!all.err, `test index with picker "cases" builds${all.err ? ": " + all.err.slice(0, 300) : ""}`);
let pages = [];
if (!all.err) {
  pages = casePages(all.out);
  check(JSON.stringify([...pages].sort()) === JSON.stringify([...ids].sort()), `one page per listed story (${pages.join(", ")})`);
  for (const id of ids) {
    const f = join(all.out, STORY, id, "index.html"); if (!existsSync(f)) continue;
    const h = readFileSync(f, "utf8"), head = h.slice(0, h.indexOf("</head>")), url = `https://galaxies.tanmaysingh.uk/${STORY}/${id}/`;
    const firstScript = head.indexOf("<script"), shimAt = head.indexOf(`q.set("story","${id}")`);
    check(h.includes(`<html lang="en" data-story="${id}"`) && head.includes('<base href="../">') && head.indexOf('<base href="../">') < head.indexOf("<link"),
      `${id}: data-story and <base href="../"> before the first link`);
    check(shimAt > firstScript && shimAt < head.indexOf("</script>"), `${id}: the ?story shim is the first script`);
    check(head.includes(`<link rel="canonical" href="${url}">`) && head.includes(`<meta property="og:url" content="${url}">`), `${id}: canonical and og:url name the path`);
    const body = s => s.slice(s.indexOf("</head>"));
    check(body(h) === body(readFileSync(join(all.out, STORY, "index.html"), "utf8")), `${id}: body identical to the explainer page`);
  }
  const g = sizes(all.out, pages);
  note(`dist growth for ${pages.length} paths: ${(g.raw / 1024).toFixed(1)} kB raw, ${(g.gz / 1024).toFixed(1)} kB gzip`);
  check(g.gz < 50 * 1024, `dist growth < 50 kB gzip (${(g.gz / 1024).toFixed(1)} kB)`);
}
const some = build("some", testIndex(ids.slice(0, -1)));
check(!some.err && JSON.stringify(casePages(some.out).sort()) === JSON.stringify(ids.slice(0, -1).sort()), `an unlisted story (${ids.at(-1)}) gets no path`);
const off = build("off", testIndex(CASE_IDS, "off"));
check(!off.err && !casePages(off.out).length, `picker "off" emits no path even with every story listed`);
const bad = testIndex(); bad.stories.push({...bad.stories.at(-1), id: "../evil", gates: {all: true}});
check(!!build("bad", bad).err, "a story id that is not a path segment fails the build");
for (const n of ["some", "off", "bad", "ship"]) rmSync(join(TMP, n), {recursive: true, force: true});

/* ---------------- browser part ---------------- */
if (!process.env.TNG_BROWSER || all.err) { note(all.err ? "browser part skipped (no build)" : "browser part skipped (set TNG_BROWSER=1)"); finish(); }
else { await browserPart(all.out); finish(); }

function finish() { if (!opt.keep) rmSync(TMP, {recursive: true, force: true}); else note(`kept ${TMP}`); process.exit(C.finish()); }

async function browserPart(dist) {
  const {createServer} = await import("node:http");
  const QA = await import("./lib/storyqa.mjs");
  const TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css",
                 ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".avif": "image/avif", ".webp": "image/webp", ".bin": "application/octet-stream", ".m4a": "audio/mp4", ".vtt": "text/vtt"};
  const log = [];
  /* Workers static assets, html_handling "auto-trailing-slash", not_found_handling "404-page" (wrangler.jsonc) */
  const srv = createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = decodeURIComponent(u.pathname); let f = resolve(join(dist, p)), code = 200;
    if (f !== dist && !f.startsWith(dist + "/")) f = null;
    if (f && existsSync(f) && statSync(f).isDirectory()) {
      if (!p.endsWith("/")) { code = 307; log.push({p, code}); res.writeHead(307, {Location: p + "/" + u.search}); res.end(); return; }
      f = join(f, "index.html");
    }
    if (!f || !existsSync(f)) { code = 404; log.push({p, code}); res.writeHead(404); res.end("not found"); return; }
    log.push({p, code}); res.writeHead(200, {"Content-Type": TYPES[extname(f)] || "application/octet-stream", "Cache-Control": "no-store"}); res.end(readFileSync(f));
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`, L = `/${STORY}/`;
  const r307 = await fetch(base + L + ids[0], {redirect: "manual"});
  check(r307.status === 307 && r307.headers.get("location") === L + ids[0] + "/", `${L}${ids[0]} redirects to the trailing slash (${r307.status} ${r307.headers.get("location")})`);
  let edge = QA.plainEdge(); if (!edge) { try { const {findBrowser} = await import("./lib/browser.mjs"); edge = findBrowser(); } catch { edge = null; } }
  const P = await launch({edge: edge ? QA.edgeWith(edge, QA.SWIFTSHADER_FLAGS) : undefined, block: BLOCK, reducedMotion: true, width: 1440, height: 900});
  const SHOTS = opt.shots ? resolve(opt.shots) : null;
  const BOOT = `!!(window.__story && __story.ready) || !!window.__storyError || !!(window.__story && __story.beats && __story.beats().length)`;
  const byId = Object.fromEntries(TIX.stories.map(e => [e.id, e]));
  const visit = async (label, url, beatsFile, storyFile, wantPath) => {
    log.length = 0; await P.goto(base + url);
    const t = await P.waitFor(BOOT, 150000, 200); await sleep(1500);
    const err = await P.eval("window.__storyError ? String(window.__storyError) : null").catch(e => "eval: " + e.message);
    const got = await P.eval(`({path: location.pathname, search: location.search, beats: window.__story ? __story.beats().map(b => b.id) : null,
      res: performance.getEntriesByType("resource").map(e => new URL(e.name).pathname)})`);
    const want = JSON.parse(readFileSync(join(SROOT, beatsFile), "utf8")).beats.map(b => b.id);
    check(t >= 0 && !err, `${label}: boots${err ? " (" + err + ")" : t < 0 ? " (timeout)" : ""}`);
    check(JSON.stringify(got.beats) === JSON.stringify(want), `${label}: plays ${beatsFile} (${got.beats ? got.beats.length : 0} beats)`);
    check(got.res.includes(`${L}data/${storyFile}`) || got.res.some(r => r.endsWith("/" + storyFile)), `${label}: fetched data/${storyFile}`);
    check(got.path === wantPath, `${label}: address stays on ${wantPath} (${got.path}${got.search})`);
    if (SHOTS) await P.shot(join(SHOTS, `path_${label.replace(/[^a-z0-9]+/gi, "_")}.png`));
    return new Set(log.filter(x => x.p !== url.split("?")[0]).map(x => x.code + " " + x.p));
  };
  const strict = (label, got) => { const bad = [...got].filter(x => !x.startsWith("200 "));
    check(!bad.length, `${label}: every same-origin request 200${bad.length ? " (" + bad.slice(0, 6).join(", ") + ")" : ""}`); };
  try {
    for (const id of ids) {
      const q = await visit(`?story=${id}`, `${L}index.html?story=${id}`, byId[id].beats, byId[id].story, `${L}index.html`);
      const p = await visit(id, `${L}${id}/`, byId[id].beats, byId[id].story, `${L}${id}/`);
      const onlyP = [...p].filter(x => !q.has(x)), onlyQ = [...q].filter(x => !p.has(x)), gap = [...p].filter(x => !x.startsWith("200 ") && q.has(x));
      check(!onlyP.length && !onlyQ.length, `${id}: the path makes the same ${p.size} same-origin requests as ?story=${id}${onlyP.length || onlyQ.length ? " (path only: " + onlyP.slice(0, 4).join(", ") + "; query only: " + onlyQ.slice(0, 4).join(", ") + ")" : ""}`);
      check([...p].every(x => x.startsWith("200 ") || gap.includes(x)), `${id}: every path request 200 apart from the ?story= page's own 404s`);
      if (gap.length) note(`${id}: data gap shared with ?story=${id} (not a path fault): ${gap.join(", ")}`);
    }
    /* with the gate closed the page writes its #fragment (history.replaceState("#..")); <base> must not move it to the hero page */
    const hid = ids[0]; await P.goto(`${base}${L}${hid}/?nogate`);
    const th = await P.waitFor("location.hash.length > 1", 60000, 250);
    const ha = await P.eval("({path: location.pathname, search: location.search, hash: location.hash})");
    check(th >= 0 && ha.path === `${L}${hid}/` && new URLSearchParams(ha.search).get("story") === hid,
      `${hid}: the page's #fragment write keeps the address on the path (${ha.path}${ha.search}${ha.hash.slice(0, 40)})`);
    strict("hero path", await visit("hero path", L, "beats.json", IX.stories[0].story, L));
    check(!P.exceptions.length, `no uncaught exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
  } finally { await P.close(); srv.close(); }
}
