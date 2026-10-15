// Smoke test of the Phase-3 TNG50 page (design 6.6): it drives the page through window.tngApp v3 and the data-testid /
// data-* hooks in headless Edge, and never matches copy text.
// Usage: TNG_BROWSER=1 node tests/js/page_smoke.mjs <exported docs/tng50 dir> [backend URL | --api-uds SOCKET]
//            [--page FILE] [--viz DIR] [--port N] [--profile DIR] [--inject shim.js] [--edge BIN] [--shots DIR] [--strict-timing]
//   The page is <dir>/index.html when it is a Phase-3 export, else <dir>/_template.html (or --page FILE); the rest of
//   <dir> (data/, js/, css/) is served beside it on 127.0.0.1:<port> (default: OS-chosen). Requests to the owner's
//   laptop server (127.0.0.1:8787), *.hf.space and huggingface.co are blocked, so without a backend URL the page is
//   offline; --viz DIR (or TNG_VIZ) serves local 3D cubes at /viz/ and passes ?viz= to the page.
//   With a backend URL (a server started with TNG_GENERATOR=server.testing:FakeGenerator) it also checks the live pill,
//   geometry jobs (job_done, ready, bound_b), and custom rays (busy, server_422, the custom gallery entry).
//   --api-uds SOCKET instead of a URL: the server listens on a unix socket (uvicorn --uds) and this test proxies /api/
//   to it under its own port, so the backend run needs no second port and no CORS entry (same origin).
// Without TNG_BROWSER=1 (e.g. under run_all.mjs) it runs only the static page checks (importmap) and says so.
// Covered (brief section C): C1 R slider per band (log map, band ends), C2 S/N 2..100, C3 pan by keys and drag, zoom,
// never pinned, C4 window down to 10 km/s, C5 on-the-fly fits for every displayed case, C6 gallery popover search and
// keyboard pick, C7 12-ion multi-select (and the labelled chips of pick.md), C8 layouts 1, 2R, 2SN, 4 with the case
// table of design 6.3, C10 info popovers (click, hover, Esc), plus the v3 bridge, events, hash v3 and legacy hashes.
import {readFileSync, existsSync} from "node:fs";
import {join, resolve} from "node:path";
import {ROOT, parseArgs, checker, loadRegistry, serve, launch, READY, UI_LIB, BLOCK, pickPage, readInjects, sleep, sepHits} from "./lib/browser.mjs";

const {pos, opt} = parseArgs(process.argv.slice(2));
const [dirArg, apiArg] = pos;
let api = apiArg;     // --api-uds SOCKET: the backend is a server on a unix socket, proxied under this test's own port and origin
if (!dirArg) { console.error("usage: page_smoke.mjs <docs/tng50 dir> [backend URL | --api-uds SOCKET] [--page FILE] [--port N] [--viz DIR] [--inject shim.js]"); process.exit(2); }
const DIR = resolve(dirArg), PAGE = pickPage(DIR, opt.page || process.env.TNG_SMOKE_FILE);
if (!existsSync(PAGE)) { console.error("no page file " + PAGE); process.exit(2); }
const C = checker(), check = C.check, note = C.note;
const REG = loadRegistry(), KEYS = REG.ions.map(i => i.key), LABEL = Object.fromEntries(REG.ions.map(i => [i.key, i.label])), BAND = Object.fromEntries(REG.ions.map(i => [i.key, i.band]));
const STRICT = !!opt["strict-timing"] || !!process.env.TNG_STRICT_TIMING;
const CASES = {"1": [[0, 0]], "2R": [[0, 0], [1, 0]], "2SN": [[0, 0], [0, 1]], "4": [[0, 0], [1, 0], [0, 1], [1, 1]]};   // design 6.3 (R index, S/N index)
const html = readFileSync(PAGE, "utf8");
console.log("page file: " + PAGE.replace(ROOT + "/", ""));

/* ---------------------------------------------------------------- static (always) */
{ const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  let ok = false; try { const im = JSON.parse(m[1]), I = im.integrity || {}, cdn = "https://cdn.jsdelivr.net/npm/three@0.169.0/";
    ok = im.imports.three === cdn + "build/three.module.min.js" && /^sha384-/.test(I[im.imports.three] || "") && /^sha384-/.test(I[im.imports["three/addons/"] + "controls/OrbitControls.js"] || "")
      && Object.keys(I).every(u => u.startsWith(cdn)) && html.indexOf("importmap") < html.search(/<script(?![^>]*importmap)[^>]*>/); } catch {}
  check(ok, "three@0.169.0 importmap with SRI, in <head> before any other script"); }
if (!process.env.TNG_BROWSER) { console.log("browser part skipped (set TNG_BROWSER=1 to drive the page in headless Edge)"); process.exit(C.finish()); }

/* ---------------------------------------------------------------- browser */
const srv = await serve({dir: DIR, page: PAGE, port: opt.port, viz: opt.viz || process.env.TNG_VIZ, apiUds: opt["api-uds"] || null});
if (opt["api-uds"]) api = srv.origin;
const P = await launch({profile: opt.profile, edge: opt.edge, inject: readInjects(opt.inject), block: BLOCK});
const st = () => P.eval("tngApp.getState()");
const PENDING = "rand_b199_a359_s1";   // a deep-linked id no catalogue has: kept in the URL while the default is shown (offline)
const url = (hash = "") => srv.base + (srv.query || (api ? "?" : "")) + (api ? (srv.query ? "&" : "") + "api=" + encodeURIComponent(api) : "") + hash;
async function load(hash, what) {
  await P.goto(url(hash)); const t = await P.waitFor(READY, 180000, 250);
  check(t >= 0, `${what}: page ready in ${(t / 1000).toFixed(1)} s`); if (t < 0) throw new Error("page never became ready"); await P.eval(UI_LIB); await sleep(300); return t;
}
const setRange = (id, v) => P.fn(`const e = document.getElementById(${JSON.stringify(id)}); if (!e) return null; e.value = String(${JSON.stringify(v)});
  e.dispatchEvent(new Event("input", {bubbles: true})); e.dispatchEvent(new Event("change", {bubbles: true})); return e.value;`);
const panelsOK = (ps, s) => { const cs = CASES[s.layout], bad = [];
  if (ps.length !== s.ions.length * cs.length) bad.push(`${ps.length} panels for ${s.ions.length} ions x ${cs.length} cases`);
  for (const k of s.ions) cs.forEach(([ri, si], c) => { const p = ps.find(q => q.ion === k && q.case === c);
    if (!p) { bad.push(`no panel ${k} case ${c}`); return; }
    if (p.R !== s.R[BAND[k]][ri] || p.snr !== s.sn[si]) bad.push(`${k} case ${c}: R ${p.R} S/N ${p.snr}, want ${s.R[BAND[k]][ri]} ${s.sn[si]}`);
    if (p.testid !== `panel-${k}-${c}`) bad.push(`${k} case ${c} testid ${p.testid}`); });
  return bad; };
async function section(name, fn) { try { await fn(); } catch (x) { check(false, `${name}: aborted: ${String(x.message || x).split("\n")[0]}`); } }
const rest = s => { const {api: a, warm, job, ...r} = s; return JSON.stringify(r); };

try {
  console.log(`serving at ${srv.base}; Edge up in ${(P.startMs / 1000).toFixed(1)} s`);
  await P.viewport(1440, 900); await P.scheme(false);
  await load(api ? "" : "#id=" + PENDING, "default load");

  /* ---- bridge, events, defaults ---- */
  await section('bridge, events, defaults', async () => {
    const FNS = ["getState", "entries", "entry", "select", "setInstrument", "setView", "panels", "fit", "submitGeometry", "submitCustom", "components", "componentsIndex", "showTab", "show3d"];
    { const r = await P.fn(`return {v: tngApp.version, miss: ${JSON.stringify(FNS)}.filter(f => typeof tngApp[f] !== "function"), frozen: Object.isFrozen(tngApp.config)};`);
      check(r.v === 3 && !r.miss.length && r.frozen, `window.tngApp v3 bridge (version ${r.v}, config frozen ${r.frozen})${r.miss.length ? "; missing " + r.miss.join(" ") : ""}`); }
    { const ev = await P.events();
      check(ev.some(e => e.type === "tng:ready" && e.detail && e.detail.version === 3), "tng:ready {version: 3} dispatched");
      check(ev.some(e => e.type === "tng:catalog" && e.detail && e.detail.n >= 3), "tng:catalog dispatched with n >= 3"); }
    const s0 = await st();
    { const D = REG.defaults;
      check(s0.layout === "1" && JSON.stringify(s0.ions) === JSON.stringify(D.ions) && s0.vc === 0 && s0.vhw === D.vhw_kms && s0.fit === false && s0.tab === "spectra"
        && JSON.stringify(s0.sn) === JSON.stringify(REG.snr.pair) && Object.entries(REG.bands).every(([b, B]) => JSON.stringify(s0.R[b]) === JSON.stringify(B.R.pair)),
        `default state (design 6.3, layout per pick.md): layout ${s0.layout}, ions ${s0.ions}, vc ${s0.vc}, vhw ${s0.vhw}, S/N ${s0.sn} (want ${REG.snr.pair}), R ${JSON.stringify(s0.R)}, fit ${s0.fit}, tab ${s0.tab}`); }
    { const r = await P.eval(`document.getElementById("statusline")?.dataset.id ?? null`); check(r === s0.id, `#statusline[data-id] ${r} equals getState().id ${s0.id}`); }
    if (!api) { const h = await P.eval("location.hash"); check(h.includes("id=" + PENDING) && s0.id !== PENDING, `unknown deep-linked id kept in the URL while ${s0.id} is shown: ${h.slice(0, 80)}`); }
    { const ps = await P.eval("tngApp.panels()"), bad = panelsOK(ps, s0);
      const dom = await P.fn(`return tngApp.panels().map(p => { const e = document.querySelector('[data-testid="' + p.testid + '"]');
          return e ? {ok: e.dataset.ion === p.ion && +e.dataset.case === p.case && e.getAttribute("role") === "img" && !!(e.getAttribute("aria-label") || "").trim(), lab: e.getAttribute("aria-label")} : {ok: false, lab: null}; });`);
      check(!bad.length && dom.every(d => d.ok), `panels(): ${ps.length} = ions x cases with the 6.3 R and S/N, each with a div.panel[role=img][data-ion][data-case] and an aria-label${bad.length ? "; " + bad.join("; ") : ""}${dom.some(d => !d.ok) ? "; bad hit boxes " + dom.filter(d => !d.ok).length : ""}`);
      check(dom.every(d => !sepHits(d.lab || "").length), "panel aria-labels have no dot separator: " + (dom[0] && dom[0].lab)); }
    { const r = await P.fn(`const v = tngApp.config.viz; if (v === null) return {nullViz: true, vol: "vol" in tngApp.config || "vol_url" in tngApp.config}; return v ? {m: v.manifest_url, b: v.base, f: v.fallback_base, d: typeof v.dataset, vol: "vol" in tngApp.config || "vol_url" in tngApp.config} : null;`);
      if (r && r.nullViz) { check(!r.vol, "CFG.viz is null (export without a viz manifest: the 3D tab says the data is not published), no CFG.vol"); return; }
      check(r && r.m === "data/viz/manifest_v2.json" && /^https:\/\/huggingface\.co\/datasets\/[\w-]+\/[\w.-]+\/resolve\/main\/$|^data\/viz\/$|^https?:\/\//.test(r.b) && (r.f === null || typeof r.f === "string") && r.d === "string" && !r.vol,
        `CFG.viz contract (${r ? r.b : "null"}), no CFG.vol`); }
  });

  /* ---- C8 layouts ---- */
  await section('C8 layouts', async () => {
    { const res = [];
      const lab = await P.fn(`return ["1", "2R", "2SN", "4"].map(v => { const i = document.querySelector('input[name=layout][value="' + v + '"]'); if (!i) return null;
          const L = i.closest("label") || (i.id && document.querySelector('label[for="' + i.id + '"]'));
          return {v, tid: i.dataset.testid, text: L ? L.innerText.replace(/\\s+/g, "") : "", tip: (i.title || (L && L.title) || i.getAttribute("aria-label") || "").trim()}; });`);
      const want = {"1": "1", "2R": "2R", "2SN": "2S/N", "4": "2×2"};
      check(lab.every(l => l && l.tid === "layout-" + l.v && l.text.replace("x", "×") === want[l.v] && l.tip),
        `C8 layout switch reads 1, 2 R, 2 S/N, 2×2 with tooltips (pick.md): ${lab.map(l => (l ? `${l.v}="${l.text}"${l.tip ? "" : " no tooltip"}` : "missing")).join(", ")}`);
      for (const L of ["2R", "2SN", "4", "1"]) {
        await P.click(`input[name=layout][value="${L}"]`) || await P.fn(`document.querySelector('input[name=layout][value="${L}"]').click()`);
        await P.fn(`const i = document.querySelector('input[name=layout][value="${L}"]'); if (!i.checked) { i.click(); }`); await sleep(250);
        const s = await st(), ps = await P.eval("tngApp.panels()"), bad = panelsOK(ps, s);
        const sl = await P.fn(`const v = id => { const e = document.getElementById(id); return !!e && __ui.vis(e); }; return {r1: v("R-uv-1"), s1: v("sn-1"), r0: v("R-uv-0"), s0: v("sn-0")};`);
        const wantR1 = L === "2R" || L === "4", wantS1 = L === "2SN" || L === "4";
        res.push(`${L}: ${ps.length}`);
        check(s.layout === L && !bad.length && sl.r0 && sl.s0 && sl.r1 === wantR1 && sl.s1 === wantS1,
          `C8 layout ${L}: ${ps.length} panels, R-uv-1 shown ${sl.r1}, sn-1 shown ${sl.s1}${bad.length ? "; " + bad.slice(0, 4).join("; ") : ""}`);
      }
      note("panels per layout " + res.join(", ")); }
  });

  /* ---- C7 ions popover and chips ---- */
  await section('C7 ions popover and chips', async () => {
    { await P.click("#ion-open"); await sleep(300);
      const r = await P.fn(`const pop = document.getElementById("ion-pop"), boxes = [...pop.querySelectorAll('input[type=checkbox][data-ion]')];
        return {open: __ui.vis(pop), exp: document.getElementById("ion-open").getAttribute("aria-expanded"), keys: boxes.map(b => b.dataset.ion), tids: boxes.every(b => b.dataset.testid === "ion-" + b.dataset.ion),
          labels: boxes.map(b => (b.closest("label") || b.parentElement).innerText.replace(/\\s+/g, " ").trim()),
          btn: ["ion-all", "ion-none", "ion-default"].every(i => document.getElementById(i))};`);
      check(r.open && r.exp === "true" && JSON.stringify(r.keys) === JSON.stringify(KEYS) && r.tids && r.btn,
        `C7 #ion-pop opens (aria-expanded ${r.exp}) with the 12 registry ions in ladder order and #ion-all/none/default: ${r.keys.join(" ")}`);
      check(r.labels.length === 12 && r.labels.every((t, i) => t.includes(LABEL[KEYS[i]])), `C7 each ion row shows its registry label (${r.labels.slice(0, 3).join(" | ")} ...)`);
      await P.fn(`document.querySelector('#ion-pop input[data-ion="SiIV"]').click()`); await sleep(250);
      let s = await st(); check(s.ions.includes("SiIV") && JSON.stringify(s.ions) === JSON.stringify(KEYS.filter(k => s.ions.includes(k))), `C7 ticking Si IV adds it in registry order: ${s.ions}`);
      await P.fn(`document.getElementById("ion-all").click()`); await sleep(300); s = await st();
      const n12 = (await P.eval("tngApp.panels()")).length;
      check(s.ions.length === 12 && n12 === 12, `C7 #ion-all selects all 12 ions (${n12} panels in layout ${s.layout})`);
      await P.fn(`for (const b of document.querySelectorAll('#ion-pop input[type=checkbox][data-ion]')) if (b.checked) b.click();`); await sleep(250); s = await st();
      check(s.ions.length >= 1, `C7 at least one ion stays selected after unticking all: ${s.ions}`);
      await P.fn(`document.getElementById("ion-default").click()`); await sleep(250); s = await st();
      check(JSON.stringify(s.ions) === JSON.stringify(REG.defaults.ions), `C7 #ion-default restores ${s.ions}`);
      await P.key("Escape"); await sleep(200);
      check(!(await P.eval(`__ui.vis(document.getElementById("ion-pop"))`)), "C7 Esc closes #ion-pop"); }
    { const r = await P.fn(`return [...document.querySelectorAll("#ion-chips > button[data-ion]")].map(b => { const t = __ui.textBox(b); return {k: b.dataset.ion, vis: __ui.vis(b), t: t.text, w: t.w, px: t.px}; });`), s = await st();
      check(JSON.stringify(r.map(c => c.k)) === JSON.stringify(s.ions) && r.every(c => c.vis && c.t.replace(/\s*[×✕x]$/u, "").trim() === LABEL[c.k] && c.w > 10 && c.px >= 9),
        `pick.md: one visible chip per selected ion with its label rendered (text width, font size): ${r.map(c => `${c.k}="${c.t}" ${c.w.toFixed(0)} px wide at ${c.px} px${c.vis ? "" : " hidden"}`).join(", ")}`);
      if (r.length > 1) { await P.click(`#ion-chips > button[data-ion="${r[r.length - 1].k}"]`); await sleep(250); const s2 = await st();
        check(!s2.ions.includes(r[r.length - 1].k) && s2.ions.length === s.ions.length - 1, `clicking the ${r[r.length - 1].k} chip removes it: ${s2.ions}`);
        await P.eval(`tngApp.setInstrument({ions: ${JSON.stringify(REG.defaults.ions)}})`); } }
  });

  /* ---- C1 R sliders per band ---- */
  await section('C1 R sliders per band', async () => {
    { await P.eval(`tngApp.setInstrument({ions: ${JSON.stringify(KEYS)}, layout: "4"})`); await sleep(300);
      const out = [];
      for (const [b, B] of Object.entries(REG.bands)) for (const i of [0, 1]) {
        const id = `R-${b}-${i}`, meta = await P.fn(`const e = document.getElementById("${id}"); return e ? {type: e.type, min: e.min, max: e.max, tid: e.dataset.testid, out: !!document.getElementById("${id}-out"),
            title: (e.title || e.closest("[title]")?.title || "").trim()} : null;`);
        if (!meta) { out.push(`${id} missing`); continue; }
        await setRange(id, meta.min); const lo = (await st()).R[b][i], loTxt = await P.eval(`document.getElementById("${id}-out").textContent`);
        await setRange(id, meta.max); const hi = (await st()).R[b][i], hiTxt = await P.eval(`document.getElementById("${id}-out").textContent`);
        await setRange(id, Math.round((+meta.min + +meta.max) / 2)); const mid = (await st()).R[b][i];
        const geo = Math.sqrt(B.R.min * B.R.max), ok = meta.type === "range" && meta.tid === id && meta.out && lo === B.R.min && hi === B.R.max
          && loTxt.replace(/\D/g, "") === String(lo) && hiTxt.replace(/\D/g, "") === String(hi) && Math.abs(Math.log10(mid / geo)) < 0.05 && (b !== "euv" || !!meta.title);
        check(ok, `C1 ${id}: range ${meta.min}..${meta.max} maps to R ${lo} ("${loTxt}") .. ${hi} ("${hiTxt}"), middle ${mid} (log map, geometric middle ${Math.round(geo)})${b === "euv" ? `, title "${meta.title.slice(0, 40)}"` : ""}`);
      }
      if (out.length) check(false, "C1 R sliders: " + out.join(", "));
      await P.eval(`tngApp.setInstrument({ions: ["HI", "CIV"], layout: "1"})`); await sleep(250);
      const r = await P.fn(`const v = id => { const e = document.getElementById(id); return !!e && __ui.vis(e); }; return {uv: v("R-uv-0"), euv: v("R-euv-0"), xray: v("R-xray-0")};`);
      check(r.uv && !r.euv && !r.xray, `C1 R sliders only for bands of the selected ions (H I, C IV: uv ${r.uv}, euv ${r.euv}, xray ${r.xray})`);
      await P.eval(`tngApp.setInstrument({ions: ${JSON.stringify(REG.defaults.ions)}, layout: "1", R: ${JSON.stringify(Object.fromEntries(Object.entries(REG.bands).map(([b, B]) => [b, B.R.pair])))}})`); }
  });

  /* ---- C2 S/N ---- */
  await section('C2 S/N', async () => {
    { await P.eval(`tngApp.setInstrument({layout: "2SN"})`); await sleep(200);
      for (const i of [0, 1]) {
        const r = await P.fn(`const e = document.getElementById("sn-${i}"); if (!e) return null; const lo = +e.min, hi = +e.max, step = +e.step || 1, seen = [];
          for (let v = lo; v <= hi + 1e-9; v += step) { e.value = String(v); e.dispatchEvent(new Event("input", {bubbles: true})); seen.push(tngApp.getState().sn[${i}]); }
          e.dispatchEvent(new Event("change", {bubbles: true}));
          return {seen, out: document.getElementById("sn-${i}-out")?.textContent ?? null, type: e.type};`);
        if (!r) { check(false, `C2 #sn-${i} missing`); continue; }
        const u = [...new Set(r.seen)], mono = r.seen.every((x, k) => k === 0 || x >= r.seen[k - 1]);
        check(r.type === "range" && r.seen[0] === REG.snr.min && r.seen.at(-1) === REG.snr.max && REG.snr.max === 100 && r.seen.every(Number.isInteger) && mono && u.length >= 20 && (r.out || "").replace(/\D/g, "") === "100",
          `C2 #sn-${i} spans S/N ${r.seen[0]}..${r.seen.at(-1)} in ${u.length} integer stops, monotone ${mono}, output "${r.out}"`);
      }
      await P.eval(`tngApp.setInstrument({snr: ${JSON.stringify(REG.snr.pair)}, layout: "1"})`); }
  });

  /* ---- C4 window, C3 pan and zoom ---- */
  await section('C4 window, C3 pan and zoom', async () => {
    { const lo = await P.fn(`const e = document.getElementById("vhw"); return e ? {min: e.min, max: e.max} : null;`);
      if (!lo) check(false, "C4 #vhw missing");
      else { await setRange("vhw", lo.min); const a = (await st()).vhw, at = await P.eval(`document.getElementById("vhw-out").textContent`);
        await setRange("vhw", lo.max); const b = (await st()).vhw;
        check(a === 10 && /(^|\D)10(\D|$)/.test(at) && b >= 1000 && Number.isInteger(b), `C4 #vhw spans ${a}..${b} km/s (output "${at}")`); }
      await P.eval(`tngApp.setView({vc: 0, vhw: 200})`); await P.eval(`document.getElementById("spectra").focus()`); await sleep(100);
      await P.key("ArrowRight"); await sleep(150); let s = await st();
      check(Math.abs(s.vc - 40) <= 1 && s.vhw === 200, `C3 ArrowRight pans by 10 % of 2 vhw: vc ${s.vc} (want 40)`);
      await P.key("ArrowLeft", {shift: true}); await sleep(150); s = await st();
      check(Math.abs(s.vc - (40 - 200)) <= 1, `C3 Shift+ArrowLeft pans by 50 %: vc ${s.vc} (want -160)`);
      await P.key("-"); await sleep(150); s = await st(); check(Math.abs(s.vhw - 250) <= 1, `C3 "-" zooms out x1.25: vhw ${s.vhw}`);
      await P.key("+"); await sleep(150); s = await st(); check(Math.abs(s.vhw - 200) <= 1, `C3 "+" zooms in x1.25: vhw ${s.vhw}`);
      await P.key("Home"); await sleep(150); s = await st(); check(s.vc === 0 && s.vhw === REG.defaults.vhw_kms, `C3 Home resets: vc ${s.vc}, vhw ${s.vhw}`);
      await P.eval(`tngApp.setView({vc: 0, vhw: 300})`); await sleep(200);
      const p0 = (await P.eval("tngApp.panels()"))[0], cx = p0.rect.x + p0.rect.w / 2, cy = p0.rect.y + p0.rect.h / 2;
      await P.drag(cx, cy, cx + 100, cy); await sleep(250); s = await st();
      const want = -100 * 2 * 300 / p0.rect.w;
      check(Math.abs(s.vc - want) <= Math.max(3, 0.15 * Math.abs(want)), `C3 dragging 100 px right pans: vc ${s.vc.toFixed(1)} (want ${want.toFixed(1)} for a ${p0.rect.w.toFixed(0)} px panel)`);
      await P.wheel(cx, cy, 120, true); await sleep(250); const s2 = await st();
      check(s2.vhw !== s.vhw, `C3 ctrl+wheel zooms about the pointer: vhw ${s.vhw} -> ${s2.vhw}`);
      await P.click("#vreset"); await sleep(200); s = await st(); check(s.vc === 0 && s.vhw === REG.defaults.vhw_kms, `#vreset resets the view: vc ${s.vc}, vhw ${s.vhw}`);
      await P.eval(`tngApp.setView({vc: 60, vhw: 120})`);
      const other = (await P.eval("tngApp.entries().map(e => e.id)")).find(i => i !== s.id);
      if (other) { await P.eval(`tngApp.select(${JSON.stringify(other)}, {source: "test"})`); await sleep(500); s = await st();
        check(s.id === other && s.vc === 60 && s.vhw === 120, `C3 selecting ${other} keeps the window (vc ${s.vc}, vhw ${s.vhw}): never pinned to a centroid`); }
      await P.eval(`tngApp.setView({vc: 0, vhw: ${REG.defaults.vhw_kms}})`); }
  });

  /* ---- setInstrument validation, tng:instrument, hash ---- */
  await section('setInstrument validation, tng:instrument, hash', async () => {
    { const bads = [["snr", {snr: 101}], ["snr", {snr: 1}], ["snr", {snr: 2.5}], ["R", {R: {uv: 4000}}], ["R", {R: {uv: 160000}}], ["R", {R: {xray: 6000}}], ["layout", {layout: "3"}],
        ["ions", {ions: []}], ["ions", {ions: ["XX"]}], ["ions", {ions: ["HI", "HI"]}], ["vhw", {vhw: 5}], ["vhw", {vhw: 20.5}], ["vc", {vc: 1e6}], ["fit", {fit: "yes"}],
        ["snr", {vhw: 300, snr: 500}]];   // the last one: nothing is applied when any field is invalid
      const before = rest(await st()), res = [];
      for (const [field, o] of bads) { const r = await P.fn(`try { tngApp.setInstrument(${JSON.stringify(o)}); return {ok: true}; } catch (x) { return {ok: false, range: x instanceof RangeError, msg: String(x.message)}; }`);
        res.push(!r.ok && r.range && r.msg.toLowerCase().includes(field.toLowerCase()) ? null : `${JSON.stringify(o)} -> ${r.ok ? "accepted" : (r.range ? "" : "not RangeError ") + r.msg}`); }
      const after = rest(await st());
      check(res.every(x => x === null) && before === after, `setInstrument rejects ${bads.length} invalid inputs with a RangeError naming the field, and applies nothing${res.filter(Boolean).length ? ": " + res.filter(Boolean).join("; ") : ""}${before !== after ? "; state changed" : ""}`);
      const t0 = await P.now();
      const s = await P.eval(`tngApp.setInstrument({snr: [30, 7], R: {uv: [20000, 60000]}, vhw: 300})`); await sleep(400);
      const h = await P.eval("location.hash"), ev = await P.events("tng:instrument", t0);
      check(s.sn[0] === 30 && s.sn[1] === 7 && s.R.uv[0] === 20000 && s.R.uv[1] === 60000 && s.vhw === 300 && /(^#|&)vw=300(&|$)/.test(h) && /(^#|&)sn=30,7(&|$)/.test(h) && ev.length >= 1,
        `setInstrument applies snr, R and vhw, writes the v3 hash and fires tng:instrument (${ev.length}): ${h.slice(0, 110)}`);
      await P.eval(`tngApp.setInstrument({ions: ${JSON.stringify(REG.defaults.ions)}, layout: "1", snr: ${JSON.stringify(REG.snr.pair)}, R: {uv: ${JSON.stringify(REG.bands.uv.R.pair)}}, vhw: ${REG.defaults.vhw_kms}})`); }
  });

  /* ---- x tick labels (canvas) ---- */
  await section('x tick labels (canvas)', async () => {
    { await P.eval(`tngApp.setView({vc: 0, vhw: 400})`); await P.eval("__tng.clearText()"); await P.eval(`tngApp.setView({vc: 0, vhw: 399})`); await P.eval(`tngApp.setView({vc: 0, vhw: 400})`); await sleep(400);
      const txt = await P.eval("__tng.text"), ticks = txt.filter(t => /^[−-]?\d+$/.test(t) && Math.abs(parseInt(t.replace("−", "-"))) >= 100);
      const neg = new Set(ticks.filter(t => /^[−-]/.test(t)).map(t => t.slice(1))), posi = new Set(ticks.filter(t => /^\d/.test(t)));
      check(ticks.length > 0 && !ticks.some(t => t.startsWith("-")) && neg.size > 0 && [...neg].every(t => posi.has(t)) && [...posi].every(t => neg.has(t)),
        `x tick labels use U+2212 and are symmetric about 0 at vc 0 (${[...new Set(ticks)].join(" ")})`);
      const bad = txt.filter(t => sepHits(t).length); check(!bad.length, `canvas strings have no dot separator (${txt.length} distinct)${bad.length ? ": " + bad.slice(0, 5).join(" | ") : ""}`); }
  });

  /* ---- C6 gallery popover ---- */
  await section('C6 gallery popover', async () => {
    { check(!(await P.eval(`!!document.querySelector("select#gallery")`)) && !(await P.eval(`__ui.vis(document.getElementById("gal-pop"))`)), "C6 no <select id=gallery>; #gal-pop closed by default");
      await P.click("#gal-open"); await sleep(300);
      const r = await P.fn(`const pop = document.getElementById("gal-pop"), lis = [...pop.querySelectorAll("#gal-list li[data-id]")], s = document.getElementById("gal-search");
        return {open: __ui.vis(pop), role: pop.getAttribute("role"), exp: document.getElementById("gal-open").getAttribute("aria-expanded"), n: lis.length,
          kinds: [...new Set(lis.map(l => l.dataset.kind))], roles: lis.every(l => l.getAttribute("role") === "option"), lb: document.getElementById("gal-list").getAttribute("role"), search: s && s.type,
          cur: document.getElementById("gal-open").innerText.includes(tngApp.getState().id)};`);
      check(r.open && r.role === "dialog" && r.exp === "true" && r.lb === "listbox" && r.roles && r.search === "search" && r.cur,
        `C6 #gal-open opens the #gal-pop dialog with input#gal-search (type ${r.search}) and a listbox; the button shows the current id ${r.cur}`);
      check(r.n >= 3 && r.kinds.every(k => ["library", "generated", "custom"].includes(k)), `C6 #gal-list has ${r.n} li[data-id] options, data-kind ${r.kinds.join(", ")}`);
      const s = await st(), ids = await P.eval("tngApp.entries().map(e => e.id)"), target = ids.find(i => i !== s.id && /^(face|edge)_/.test(i)) || ids.find(i => i !== s.id);
      const q = target;   // the full id: the only match, so ArrowDown + Enter must pick it
      await P.fn(`const e = document.getElementById("gal-search"); e.focus(); e.value = ${JSON.stringify(q)}; e.dispatchEvent(new Event("input", {bubbles: true}));`); await sleep(300);
      const shown = await P.eval(`[...document.querySelectorAll("#gal-list li[data-id]")].filter(l => __ui.vis(l)).map(l => l.dataset.id)`);
      check(shown.length >= 1 && shown.every(i => i.toLowerCase().includes(q.toLowerCase())) && shown.includes(target), `C6 search "${q}" leaves ${shown.length} matching options incl. ${target}`);
      const t0 = await P.now();
      await P.key("ArrowDown"); await sleep(150);
      await P.key("Enter"); await sleep(700); const s2 = await st(), ev = await P.events("tng:select", t0);
      check(s2.id === target && ev.some(e => e.detail && e.detail.id === target) && !(await P.eval(`__ui.vis(document.getElementById("gal-pop"))`)),
        `C6 search, ArrowDown + Enter picks ${target}: state ${s2.id}, tng:select ${ev.map(e => e.detail && e.detail.id + "/" + e.detail.source).join(",") || "none"}, popover closed`);
      await P.key("Escape");
      check(await P.eval(`document.getElementById("statusline")?.dataset.id`) === s2.id, "#statusline[data-id] follows the selection");
      await P.fn(`const e = document.getElementById("gal-search"); e.value = ""; e.dispatchEvent(new Event("input", {bubbles: true}));`);   // prev/next may step through the filtered list
      const t1 = await P.now(); await P.hover(5, 5); await P.click("#next"); await P.waitFor(`tngApp.getState().id !== ${JSON.stringify(s2.id)}`, 15000); const s3 = await st();
      await P.click("#prev"); await P.waitFor(`tngApp.getState().id === ${JSON.stringify(s2.id)}`, 15000); const s4 = await st(), evn = await P.events("tng:select", t1);
      check(s3.id !== s2.id && s4.id === s2.id && evn.length >= 2, `#next moves ${s2.id} -> ${s3.id} and #prev returns (${s4.id})`); }
  });

  /* ---- C10 info popovers ---- */
  await section('C10 info popovers', async () => {
    { const res = [];
      for (const k of ["read", "methods", "licence"]) {
        const okBtn = await P.click(`#info-${k}`); await P.hover(5, 600); await sleep(250);
        const a = await P.fn(`return {open: __ui.vis(document.getElementById("pop-${k}")), exp: document.getElementById("info-${k}").getAttribute("aria-expanded"), tid: document.getElementById("info-${k}").dataset.testid};`);
        await P.key("Escape"); await sleep(200);
        const b = await P.fn(`return {open: __ui.vis(document.getElementById("pop-${k}")), exp: document.getElementById("info-${k}").getAttribute("aria-expanded")};`);
        res.push(okBtn && a.open && a.exp === "true" && a.tid === "info-" + k && !b.open && b.exp === "false" ? null : `${k}: click ${okBtn} open ${a.open}/${a.exp}, Esc ${b.open}/${b.exp}`);
      }
      check(res.every(x => x === null), `C10 #info-read, #info-methods, #info-licence open #pop-* on click (aria-expanded) and Esc closes them${res.filter(Boolean).length ? ": " + res.filter(Boolean).join("; ") : ""}`);
      const r = await P.eval(`__ui.rect("#info-read")`); await P.hover(r.x + r.w / 2, r.y + r.h / 2); await sleep(700);
      const hv = await P.eval(`__ui.vis(document.getElementById("pop-read"))`); await P.hover(5, 600); await P.key("Escape"); await sleep(200);
      check(hv, "C10 hovering #info-read opens #pop-read after the delay"); }
  });

  /* ---- C5 on-the-fly fits for every displayed case ---- */
  await section('C5 on-the-fly fits for every displayed case', async () => {
    { await P.eval(`tngApp.setInstrument({ions: ${JSON.stringify(REG.defaults.ions)}, layout: "4", fit: false})`); await sleep(400);   // 5 ions x 4 cases (design 8)
      const hash = `(() => { const c = document.getElementById("cv"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let h = 2166136261; for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619); } return h >>> 0; })()`;
      const before = await P.eval(hash), t0 = await P.now(), w0 = Date.now(), load = (await import("node:os")).loadavg().map(x => x.toFixed(2)).join(" ");
      const label = await P.eval(`__ui.label(document.getElementById("fit"))`);
      await P.fn(`const f = document.getElementById("fit"); if (!f.checked) f.click();`);
      const tDone = await P.waitFor(`["done", "budget"].includes(document.getElementById("fitstatus")?.dataset.state)`, 120000, 100);
      const wall = Date.now() - w0; await sleep(300);
      const s = await st(), ps = await P.eval("tngApp.panels()"), ev = await P.events("tng:fit", t0), after = await P.eval(hash);
      const state = await P.eval(`document.getElementById("fitstatus").dataset.state`);
      check(s.fit === true && /\p{L}/u.test(label), `C5 #fit is a labelled toggle ("${label}") and sets getState().fit ${s.fit}`);
      check(tDone >= 0, `C5 #fitstatus reaches ${state} for ${ps.length} panels in ${(wall / 1000).toFixed(2)} s (load average ${load})`);
      const miss = ps.filter(p => !ev.some(e => e.detail && e.detail.ion === p.ion && e.detail.case === p.case && e.detail.R === p.R && e.detail.snr === p.snr));
      const okStat = ev.every(e => e.detail && ["ok", "budget", "no_seeds", "error"].includes(e.detail.status));
      check(ps.length === s.ions.length * 4 && !miss.length && okStat, `C5 a tng:fit event for every displayed (ion, case, R, S/N): ${ev.length} events for ${ps.length} panels${miss.length ? "; missing " + miss.slice(0, 6).map(p => p.testid).join(" ") : ""}`);
      check(after !== before, "C5 the fit overlay changes the drawn canvas");
      const ms = ev.map(e => +e.detail.ms).filter(Number.isFinite).sort((a, b) => a - b), q = f => ms.length ? ms[Math.min(ms.length - 1, Math.floor(f * ms.length))] : NaN;
      note(`fit ms per panel: median ${q(0.5)}, p95 ${q(0.95)}, max ${ms.at(-1)} (${ms.length} timed; ${ev.filter(e => e.detail?.status === "no_seeds").length} no_seeds; wall ${wall} ms; load ${load})`);
      const fast = wall <= 3000 && q(0.95) <= 300;
      if (STRICT) check(fast, `C5 timing budget: 20 panels in <= 3 s and p95 <= 300 ms (wall ${wall} ms, p95 ${q(0.95)} ms)`);
      else if (!fast) note(`timing over budget under the current load (${load}); rerun with --strict-timing on a quiet machine`);
      { const d = await P.fn(`const D = tngApp._debug; if (!D || typeof D.draw !== "function") return null; const ms = [];
          for (let i = 0; i < 30; i++) { D.draw(); ms.push(D.drawMs); } ms.sort((a, b) => a - b); return {med: ms[15], max: ms[29], n: tngApp.panels().length};`);
        check(d && d.med <= 16, `design 8 redraw: ${d ? `${d.n} panels with the fit overlay, median ${d.med.toFixed(1)} ms, max ${d.max.toFixed(1)} ms per draw (<= 16 ms; load ${load})` : "no tngApp._debug.draw hook"}`); }
      const nums = await P.eval(`document.getElementById("fitstatus").textContent`); check(!sepHits(nums).length && /\d/.test(nums), `#fitstatus text has counts and no separator: "${nums}"`);
      { const p = ps[0]; await P.hover(p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h / 2); await sleep(300);
        const ro = await P.eval(`document.getElementById("readouts").textContent`); check(/\d/.test(ro) && !sepHits(ro).length, `hover readout has numbers and no separator: "${ro}"`); await P.hover(5, 5); }
      const one = await P.fn(`if (typeof tngApp.fit !== "function") return {missing: true}; const k = tngApp.getState().ions[0]; const r = await tngApp.fit(k, 0); return r ? {status: r.status, comps: Array.isArray(r.comps), n: (r.comps || []).length, chi2: typeof r.chi2, key: typeof r.key} : null;`);
      check(one && ["ok", "budget", "no_seeds"].includes(one.status) && one.comps && one.key === "string", `tngApp.fit(ion, 0) resolves to a 5.4 result: ${JSON.stringify(one)}`);
      await P.fn(`const f = document.getElementById("fit"); if (f.checked) f.click();`); await P.eval(`tngApp.setInstrument({layout: "1"})`); }
  });

  /* ---- tabs ---- */
  await section('tabs', async () => {
    { await P.eval(`tngApp.showTab("3d")`); await sleep(500);
      const a = await P.fn(`return {tab: tngApp.getState().tab, p3: __ui.vis(document.getElementById("panel-3d")), ps: __ui.vis(document.getElementById("panel-spectra")), sel: document.getElementById("tab-3d").getAttribute("aria-selected"), h: location.hash};`);
      await P.eval(`tngApp.showTab("spectra")`); await sleep(300);
      const b = await P.fn(`return {tab: tngApp.getState().tab, p3: __ui.vis(document.getElementById("panel-3d")), ps: __ui.vis(document.getElementById("panel-spectra")), sel: document.getElementById("tab-spectra").getAttribute("aria-selected")};`);
      check(a.tab === "3d" && a.p3 && !a.ps && a.sel === "true" && /tab=3d/.test(a.h) && b.tab === "spectra" && !b.p3 && b.ps && b.sel === "true", `showTab 3d then spectra: ${JSON.stringify(a)} ${JSON.stringify(b)}`); }
  });

  /* ---- offline geometry (no backend) ---- */
  await section('offline geometry (no backend)', async () => {
    if (!api) {
      const pill = await P.eval(`document.getElementById("pill")?.dataset.state`); check(pill === "offline", `#pill[data-state] ${pill} (offline)`);
      const r = await P.eval(`tngApp.submitGeometry({orientation: "face-on", b_kpc: 233, azimuth_deg: 17})`); await sleep(300);
      const code = await P.eval(`document.getElementById("geomsg")?.dataset.code`);
      check(r && r.status === "error" && code === "offline_not_in_library", `offline submit of a geometry outside the library: ${JSON.stringify(r)}, #geomsg[data-code] ${code}`);
      const e = await P.fn(`return tngApp.entries().find(e => e.orientation === "face-on" && e.id !== tngApp.getState().id && Number.isFinite(e.b_kpc)) || null;`);
      if (e) { const r2 = await P.eval(`tngApp.submitGeometry({orientation: "face-on", b_kpc: ${e.b_kpc}, azimuth_deg: ${e.azimuth_deg}})`); await sleep(600);
        check(r2 && r2.status === "ready" && r2.id === e.id && (await st()).id === e.id, `offline submit of a library geometry loads ${e.id}: ${JSON.stringify(r2)}`); }
    }
  });

  /* ---- hashes (reloads) ---- */
  await section('hashes (reloads)', async () => {
    { const ids = await P.eval("tngApp.entries().map(e => e.id)"), id = ids[1] || ids[0];
      await load(`#id=${id}&ions=HI,CIV,OVI&lay=2SN&R=uv:20000,60000;xray:300,3000&sn=30,7&vc=50&vw=150&seed=3&fit=0&intr=1`, "v3 hash");
      let s = await st();
      check(s.id === id && s.ions.join() === "HI,CIV,OVI" && s.layout === "2SN" && s.R.uv.join() === "20000,60000" && s.sn.join() === "30,7" && s.vc === 50 && s.vhw === 150 && s.seed === 3 && s.intrinsic === true,
        `v3 hash parsed: ${JSON.stringify({id: s.id, ions: s.ions, layout: s.layout, R: s.R.uv, sn: s.sn, vc: s.vc, vhw: s.vhw, seed: s.seed, intr: s.intrinsic})}`);
      await load(`#id=${id}&R=20000,40000&sn=8,5&v=300`, "legacy v2 hash"); s = await st();
      check(s.R.uv.join() === "20000,40000" && s.sn.join() === "8,5" && s.vhw === 300, `legacy hash R=20000,40000&sn=8,5&v=300 maps to uv R ${s.R.uv}, S/N ${s.sn}, vhw ${s.vhw}`);
      await load(`#id=${id}&ions=HI,XX,OVII&sn=500,1&R=uv:999999,1;xray:1,99999&vw=3`, "out-of-range hash"); s = await st();
      check(s.ions.join() === "HI,OVII" && s.sn.join() === "100,2" && s.R.uv.join() === `${REG.bands.uv.R.max},${REG.bands.uv.R.min}` && s.R.xray.join() === `${REG.bands.xray.R.min},${REG.bands.xray.R.max}` && s.vhw === 10,
        `out-of-range hash clamped, unknown ion dropped: ions ${s.ions}, S/N ${s.sn}, uv ${s.R.uv}, xray ${s.R.xray}, vhw ${s.vhw}`);
      await load(`#id=${id}&ions=XX`, "empty-ion hash"); s = await st();
      check(JSON.stringify(s.ions) === JSON.stringify(REG.defaults.ions), `a hash with no valid ion falls back to the default ions: ${s.ions}`);
      await load(`#id=${id}&tab=3d`, "3D-tab hash"); s = await st(); check(s.tab === "3d", `hash tab=3d opens the 3D tab: ${s.tab}`); }
  });

  /* ---- with a backend ---- */
  await section('with a backend', async () => {
    if (api) {
      await load("", "backend load");
      const tl = await P.waitFor(`document.getElementById("pill")?.dataset.state === "live"`, 60000, 250);
      check(tl >= 0, `#pill[data-state] live with ${api}`);
      const code = () => P.eval(`document.getElementById("geomsg")?.dataset.code`);
      const seed = 1000 + Math.floor(Math.random() * 1e6), t0 = await P.now();
      const r = await P.eval(`tngApp.submitGeometry({orientation: "random", b_kpc: 77, azimuth_deg: 123, seed: ${seed}})`);
      check(r && r.status === "queued" && /^rand_b077_a123_s\d+$/.test(r.id), "submitGeometry -> queued " + JSON.stringify(r));
      const td = await P.waitFor(`(__tng.events.find(e => e.t >= ${t0} && (e.type === "tng:done" || e.type === "tng:error")))`, 300000, 500);
      const done = (await P.events("tng:done", t0))[0]; await sleep(800);
      check(td >= 0 && done && done.detail.id === r.id && (await code()) === "job_done" && (await st()).id === r.id, `job done in ${(td / 1000).toFixed(1)} s: #geomsg[data-code] ${await code()}, selected ${(await st()).id}`);
      check(await P.eval(`!!document.querySelector('#gal-list li[data-kind="generated"][data-id="${r.id}"]')`), `generated entry listed as li[data-kind=generated][data-id=${r.id}]`);
      const r2 = await P.eval(`tngApp.submitGeometry({orientation: "random", b_kpc: 77, azimuth_deg: 123, seed: ${seed}})`); await sleep(500);
      check(r2.status === "ready" && (await code()) === "ready", `resubmit the same geometry -> ready, #geomsg[data-code] ${await code()}`);
      await P.click("#geo-open"); await sleep(300);
      await P.fn(`const b = document.getElementById("gb"); b.value = "999"; b.dispatchEvent(new Event("input", {bubbles: true})); const f = document.getElementById("geo"); f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event("submit", {cancelable: true}));`);
      await sleep(400); check((await code()) === "bound_b", `client-side bound on b: #geomsg[data-code] ${await code()}`); await P.key("Escape");
      const probe = await fetch(api.replace(/\/+$/, "") + "/api/geometry/custom", {method: "POST", headers: {"Content-Type": "application/json"}, body: '{"p0_kpc":[-100,0,0],"p1_kpc":[100,0,0]}'}).catch(() => null);
      if (!probe || probe.status === 404 || probe.status === 405) note("backend has no custom-ray API; custom submit not tested");
      else {
        const r6 = () => Math.round(Math.random() * 1000) / 10, p0 = [-150 - r6(), 20 + r6(), -10], p1 = [140 + r6(), -30, 25 - r6()], t1 = await P.now();
        const c1 = await P.eval(`tngApp.submitCustom({p0_kpc: ${JSON.stringify(p0)}, p1_kpc: ${JSON.stringify(p1)}})`);
        check(c1.status === "queued" && /^cust_[0-9a-f]{10}$/.test(c1.id), "submitCustom -> queued " + JSON.stringify(c1));
        const c2 = await P.eval(`tngApp.submitCustom({p0_kpc: ${JSON.stringify(p0)}, p1_kpc: [0, 0, 0]})`);
        check(c2.status === "error" && (await code()) === "busy", `second submit while busy -> error, #geomsg[data-code] ${await code()}`);
        const tc = await P.waitFor(`(__tng.events.find(e => e.t >= ${t1} && (e.type === "tng:done" || e.type === "tng:error")))`, 300000, 500); await sleep(800);
        const ev = await P.events(null, t1), stages = [...new Set(ev.filter(e => e.type === "tng:job").map(e => e.detail && e.detail.stage))];
        /* the progress stream reports the stages it sees: a warm generator can finish the middle ones between two events,
           so the fit stage is a note here (the server tests cover the stage list); the job must still end in "save" */
        check(tc >= 0 && ev.some(e => e.type === "tng:done" && e.detail.id === c1.id) && ev.some(e => e.type === "tng:submitted" && e.detail.kind === "custom") && stages.includes("save"),
          `custom job done, tng:submitted kind custom, stages ${stages.join(" ")}`);
        if (!stages.includes("fit")) note("the progress stream skipped the fit stage of the custom job (fast generator)");
        const s = await st(); check(s.id === c1.id && s.tab === "spectra" && await P.eval(`!!document.querySelector('#gal-list li[data-kind="custom"][data-id="${c1.id}"]')`),
          `custom ray selected, Spectra tab, li[data-kind=custom][data-id=${c1.id}] listed`);
        const c3 = await P.eval(`tngApp.submitCustom({p0_kpc: [500, 0, 0], p1_kpc: [0, 0, 0]})`); await sleep(300);
        check(c3.status === "error" && (await code()) === "server_422", `out-of-range endpoint -> #geomsg[data-code] ${await code()}`);
      }
    }
  });

  if (opt.shots) { await load("", "final"); await P.shot(join(resolve(opt.shots), "smoke_1440_light.png")); note("screenshot " + join(resolve(opt.shots), "smoke_1440_light.png")); }
  check(!P.exceptions.length, `no page exceptions${P.exceptions.length ? ": " + [...new Set(P.exceptions)].slice(0, 3).join(" | ") : ""}`);
} catch (x) { check(false, "aborted: " + (x.stack || x.message).split("\n").slice(0, 2).join(" ")); }
finally { await P.close(); await srv.close(); }
process.exit(C.finish());
