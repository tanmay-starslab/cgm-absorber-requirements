// Phase-3 UI contract, static part (design 6.1, 6.2, 6.3, 6.4, 6.6; brief C1-C14 where checkable without a browser;
// pick.md). Merged 2026-10-14 from the tests-unit version and the page agent's version (state.js unit checks kept).
// Usage: node tests/js/ui_static.mjs [docs/tng50 dir] [--page FILE] [--js DIR] [--css DIR]
//            [TNG_BROWSER=1: --serve FILE --viz DIR --port N --profile DIR --inject shim.js --edge BIN]
// Node part (always): reads the page template (default <dir>/_template.html), <dir>/js/*.js and <dir>/css/*.css with
// comments stripped, and checks
//   - every static 6.1 id and data-testid is declared (template, or a page-module string); removed ids are gone;
//   - no forbidden separator (U+00B7, U+2022, U+2027, U+22C5, U+30FB, " . ") in HTML text, attributes, CSS or any JS
//     string literal; no "Interactive companion"; the title is "TNG50 sightlines";
//   - layout radios exactly 1, 2R, 2SN, 4; #v3d-stage CSS aspect-ratio 1 / 1; gallery popover, info buttons;
//   - the exporter's config marker and the module/stylesheet tags;
//   - node unit checks of the pure page state js/state.js (when present): cases, R/S/N/window slider maps, view clamp,
//     hash v3 + legacy + clamping, setInstrument validation.
//   - tips (js/tips.js): every control of the help coverage list carries data-tip (template, page modules, generators),
//     no element has both title and data-tip, every tip line <= 12 words and free of dot separators, tips.js is
//     initialised and styled with the glass tokens.
// Browser part (TNG_BROWSER=1; served page = --serve FILE, else <dir>/index.html when it is a Phase-3 export):
//   - every 6.1 id/test id in the live DOM incl. generated ones (R-<band>-0, ion-<key>, panel-<key>-0, chips);
//   - #title computed font-size <= 14 px; no "Interactive companion" in the document;
//   - default layout is one case (pick.md); #fit/#intr labelled toggles; #v3d-stage square within 1 px at 1440x900.
import {readFileSync, existsSync} from "node:fs";
import {join, resolve, basename} from "node:path";
import {pathToFileURL} from "node:url";
import {ROOT, parseArgs, checker, sepHits, listFiles, loadRegistry, serve, launch, READY, UI_LIB, BLOCK, pickPage, readInjects, sleep} from "./lib/browser.mjs";
import {jsStrings, htmlParts} from "./lib/jsscan.mjs";

const {pos, opt} = parseArgs(process.argv.slice(2));
const DIR = resolve(pos[0] || join(ROOT, "docs/tng50"));
const PAGE = resolve(opt.page || (existsSync(join(DIR, "_template.html")) ? join(DIR, "_template.html") : join(DIR, "index.html")));   // an export dir has only index.html
const JS = listFiles(resolve(opt.js || join(DIR, "js")), /\.m?js$/), CSS = listFiles(resolve(opt.css || join(DIR, "css")), /\.css$/);
const C = checker(), check = C.check;
if (!existsSync(PAGE)) { console.error("no page file " + PAGE); process.exit(2); }
const REG = loadRegistry();

export const STATIC_IDS = ["top", "title", "theme", "pill", "tabs", "tab-spectra", "tab-3d",
  "info-read", "info-methods", "info-licence", "pop-read", "pop-methods", "pop-licence",
  "gal-open", "gal-pop", "gal-id", "gal-copy", "gal-search", "gal-list", "showcase", "filter", "galcount", "prev", "next",
  "ion-open", "ion-pop", "ion-all", "ion-none", "ion-default", "ion-chips", "layout",
  "sn-0", "sn-1", "sn-0-out", "sn-1-out", "vhw", "vhw-out", "vreset", "intr", "fit", "reroll", "dl-menu", "dlpdf", "dlpng",
  "panel-spectra", "spectra", "cv", "readouts", "statusline", "fitstatus",
  "geo-open", "geo-pop", "geo", "gb", "gaz", "gseed", "submit", "prog", "stagebar", "stagenames", "geomsg", "bkd", "apiurl", "apiclear", "apihint", "backends",
  "find-toggle", "find-pop", "find-body", "chat-root", "chat-open", "controls-open",
  "panel-3d", "v3d-stage", "v3d-root", "v3d-controls", "v3d-status", "picker-root"];
export const STATIC_TESTIDS = ["topbar", "title", "gallery-open", "gallery-search", "ion-select", "layout-1", "layout-2R", "layout-2SN", "layout-4",
  "sn-0", "sn-1", "vhw", "view-reset", "fit-toggle", "spectra", "fit-status", "geo-open", "v3d-stage", "v3d-controls", "info-read", "info-methods", "info-licence"];
export const REMOVED_IDS = ["lede", "cap", "h-about", "aboutgal", "rlo", "rhi", "snhi", "snlo", "vwin", "comps", "gallery"];
const VIEWER_IDS = ["v3-species", "v3-fs", "v3-ctl"];

/* ---------------------------------------------------------------- node part */
const html = readFileSync(PAGE, "utf8"), parts = htmlParts(html);
const htmlText = parts.filter(p => p.kind === "html").map(p => p.s).join("\n");
const srcs = JS.map(f => ({f, src: readFileSync(f, "utf8")})).map(x => ({...x, strs: jsStrings(x.src)}));
const allStr = [...parts.filter(p => p.kind === "js").map(p => ({...p, f: basename(PAGE)})), ...srcs.flatMap(x => x.strs.map(s => ({...s, f: basename(x.f)})))];
const cssText = parts.filter(p => p.kind === "css").map(p => p.s).join("\n") + "\n" + CSS.map(f => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");
console.log(`page ${PAGE.replace(ROOT + "/", "")}; ${JS.length} js modules, ${CSS.length} css files; ${allStr.length} JS strings scanned`);

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const declaredId = id => new RegExp(`\\bid=["']${esc(id)}["']`).test(htmlText) ? "template"
  : allStr.some(x => new RegExp(`\\bid=\\\\?["']${esc(id)}\\\\?["']`).test(x.s)) ? "js"
  : srcs.some(x => new RegExp(`\\.id\\s*=\\s*["'\`]${esc(id)}["'\`]`).test(x.src)) ? "js" : null;
{ const miss = STATIC_IDS.filter(i => !declaredId(i));
  check(!miss.length, `6.1 ids declared (${STATIC_IDS.length - miss.length} of ${STATIC_IDS.length})${miss.length ? "; missing #" + miss.join(" #") : ""}`); }
{ const tid = id => new RegExp(`data-testid=\\\\?["']${esc(id)}\\\\?["']`), miss = STATIC_TESTIDS.filter(t => !tid(t).test(htmlText) && !allStr.some(x => tid(t).test(x.s)) && !srcs.some(x => new RegExp(`dataset\\.testid\\s*=\\s*["'\`]${esc(t)}["'\`]`).test(x.src)));
  check(!miss.length, `6.1 data-testids declared (${STATIC_TESTIDS.length - miss.length} of ${STATIC_TESTIDS.length})${miss.length ? "; missing " + miss.join(" ") : ""}`); }
{ const bad = [];
  for (const id of REMOVED_IDS) {
    if (new RegExp(`\\bid=["']${esc(id)}["']`).test(htmlText)) bad.push(`id="${id}" in the template`);
    const sel = new RegExp(`(^|[\\s,>+~(])#${esc(id)}(?![\\w-])`), byId = new RegExp(`getElementById\\(\\s*["'\`]${esc(id)}["'\`]\\s*\\)`);
    for (const x of allStr) if (sel.test(x.s) || new RegExp(`\\bid=\\\\?["']${esc(id)}\\\\?["']`).test(x.s)) bad.push(`#${id} in ${x.f}:${x.line}`);
    for (const x of [{f: basename(PAGE), src: parts.filter(p => p.kind !== "html").map(p => p.s).join("\n")}, ...srcs]) if (byId.test(x.src)) bad.push(`getElementById("${id}") in ${x.f}`);
  }
  check(!bad.length, `removed ids are gone (${REMOVED_IDS.map(i => "#" + i).join(" ")})${bad.length ? ": " + [...new Set(bad)].slice(0, 12).join(", ") : ""}`); }
{ const hits = [];
  for (const p of parts) if (p.kind !== "js") { p.s.split("\n").forEach((l, k) => { for (const h of sepHits(l)) hits.push(`${basename(PAGE)}:${p.line + k} ${p.kind} ${h.what} "${l.trim().slice(0, 70)}"`); }); }
  for (const x of allStr) for (const h of sepHits(x.s)) hits.push(`${x.f}:${x.line} string ${h.what} "${x.s.trim().slice(0, 70)}"`);
  for (const f of CSS) readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).split("\n").forEach((l, k) => { for (const h of sepHits(l)) hits.push(`${basename(f)}:${k + 1} css ${h.what}`); });
  check(!hits.length, `C12 no dot separators in HTML text, attributes, CSS or JS string literals${hits.length ? ` (${hits.length} hits): ` + hits.slice(0, 15).join("; ") : ""}`); }
{ const re = /interactive\s+companion/i, where = [...(re.test(htmlText) ? [basename(PAGE)] : []), ...allStr.filter(x => re.test(x.s)).map(x => `${x.f}:${x.line}`)];
  check(!where.length, `C11 no "Interactive companion" text${where.length ? ": " + where.join(", ") : ""}`); }
{ const m = htmlText.match(/<h1\b[^>]*\bid="title"[^>]*>([\s\S]*?)<\/h1>/), t = m ? m[1].replace(/<[^>]+>/g, " ").replace(/&\w+;/g, " ").replace(/\s+/g, " ").trim() : null;
  check(t === "TNG50 sightlines" && /data-testid="title"/.test(m[0]), `C11 h1#title reads "TNG50 sightlines" (3 words max) with data-testid title: ${JSON.stringify(t)}`); }
{ const ins = [...htmlText.matchAll(/<input\b[^>]*\bname=["']layout["'][^>]*>/g)].map(m => m[0]), vals = ins.map(s => (s.match(/\bvalue=["']([^"']+)["']/) || [])[1]);
  check(JSON.stringify([...vals].sort()) === JSON.stringify(["1", "2R", "2SN", "4"]) && ins.every(s => /data-testid="layout-/.test(s)), `C8 layout radios input[name=layout] are 1, 2R, 2SN, 4 with test ids (found ${vals.join(", ") || "none"})`); }
check(/#v3d-stage\b[^{]*\{[^}]*aspect-ratio\s*:\s*1\s*(\/\s*1\s*)?[;}]/.test(cssText), "C13 #v3d-stage CSS sets aspect-ratio 1 / 1");
{ /* galaxy sample: the picker group is hidden by default (the page shows it only with CFG.galaxies), its popover is a dialog
     with a search box, a sort header and a listbox; read from the template so a page exported before it still passes */
  const T = readFileSync(join(ROOT, "docs", "tng50", "_template.html"), "utf8"), G = readFileSync(join(ROOT, "docs", "tng50", "js", "galaxies.js"), "utf8");
  check(/<div class="grp" id="grp-gal"[^>]*\bhidden\b/.test(T) && /id="gxy-open"[^>]*aria-controls="gxy-pop"/.test(T) && /<div class="pop" id="gxy-pop" role="dialog"/.test(T)
    && /<input\b(?=[^>]*\bid="gxy-search")(?=[^>]*\btype="search")/.test(T) && /id="gxy-head"/.test(T) && /<ul id="gxy-list" role="listbox"/.test(T)
    && /export function createGalaxyPicker/.test(G) && /galaxy picker \(galaxy-sample web contract; js\/galaxies\.js\) BEGIN/.test(readFileSync(join(ROOT, "docs", "tng50", "css", "page.css"), "utf8")) && /#gxy-pop\{/.test(cssText),
  "galaxy picker: #grp-gal hidden by default, #gxy-pop dialog with search, sort header and listbox, CSS block present"); }
check(!/<select\b[^>]*\bid=["']gallery["']/.test(htmlText) && /\bid="gal-pop"/.test(htmlText) && /<input\b(?=[^>]*\bid="gal-search")(?=[^>]*\btype="search")[^>]*>/.test(htmlText),
  'C6 gallery is a popover (#gal-pop with input#gal-search type search), no <select id="gallery">');
/* ux4 B: the sightline button carries no id text (clean parameters come from gallery.js sightLabel), and the picker's
   filters say what they keep: no bare "new" or "showcase" labels */
{ const btn = (htmlText.match(/<button\b[^>]*\bid="gal-open"[^>]*>[\s\S]*?<\/button>/) || [""])[0], fil = (htmlText.match(/<select\b[^>]*\bid="filter"[^>]*>[\s\S]*?<\/select>/) || [""])[0];
  const labels = [...fil.matchAll(/<option\b[^>]*>([^<]*)<\/option>/g)].map(m => m[1].trim()), sc = (htmlText.match(/id="showcase"[^>]*>([^<]*)</) || [])[1] || "";
  const gal = srcs.find(x => basename(x.f) === "gallery.js");
  check(/class="slab"/.test(btn) && !/class="gid"/.test(btn) && !!gal && /export function sightLabel/.test(gal.src) && /export function sightTip/.test(gal.src),
    "ux4 B: #gal-open holds span.slab (clean parameters from gallery.js sightLabel, id in sightTip), not the id");
  check(labels.length === 5 && !labels.includes("new") && labels.includes("your rays") && /value="new"/.test(fil) && sc.trim() && !/showcase/i.test(sc),
    `ux4 B: picker filters named for what they keep: ${labels.join(", ")}; checkbox "${sc.trim()}"`); }
{ const pops = ["read", "methods", "licence"].map(k => { const b = htmlText.match(new RegExp(`<button\\b[^>]*\\bid="info-${k}"[^>]*>`));
    return !!b && /class="[^"]*\binfo\b/.test(b[0]) && b[0].includes(`data-info="${k}"`) && b[0].includes(`aria-controls="pop-${k}"`) && /aria-expanded="false"/.test(b[0]); });
  check(pops.every(Boolean), `C10 info buttons button.info#info-{read,methods,licence} with data-info, aria-controls pop-*, aria-expanded false (${pops.map(x => (x ? "ok" : "bad")).join(" ")})`); }
/* tf3d: the 3D Transfer function card (js/tfeditor.js): its controls are declared with test ids, every input and select is
   labelled (a <label for>, aria-label or aria-labelledby), the editor canvas is focusable with a description, the four presets of
   js/tf.js are offered, and the card is styled in page.css with the glass tokens */
{ const ed = srcs.find(x => basename(x.f) === "tfeditor.js"), tfm = srcs.find(x => basename(x.f) === "tf.js");
  if (!ed) console.log("note: no js/tfeditor.js; Transfer function card checks skipped");
  else { const tpl = ed.strs.map(x => x.s).join("\n");
    const ids = ["v3-tf", "v3-tf-preset", "v3-tf-cv", "v3-tf-w", "v3-tf-a", "v3-tf-col", "v3-tf-add", "v3-tf-del", "v3-tf-reset", "v3-tf-2d", "v3-tf-shade", "v3-tf-emis", "v3-tf-gamma"];
    const miss = ids.filter(i => !declaredId(i));
    check(!miss.length, `3D TF card ids declared (${ids.length - miss.length} of ${ids.length})${miss.length ? "; missing #" + miss.join(" #") : ""}`);
    const ctl = [...tpl.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]), unl = ctl.filter(t => { const id = (t.match(/\bid="([^"]+)"/) || [])[1];
      return !/aria-label(ledby)?=/.test(t) && !(id && new RegExp(`<label\\b[^>]*for="${esc(id)}"`).test(tpl)) && !/type="checkbox"/.test(t); });
    check(ctl.length >= 10 && !unl.length, `3D TF card: ${ctl.length} inputs and selects, each labelled${unl.length ? "; unlabelled: " + unl.map(t => t.slice(0, 50)).join(" | ") : ""}`);
    check(/<canvas\b(?=[^>]*tabindex="0")(?=[^>]*aria-describedby=)(?=[^>]*aria-labelledby=)[^>]*>/.test(tpl) && /role="status"/.test(tpl), "3D TF editor canvas focusable, labelled and described; a status live region");
    const pre = tfm && (tfm.src.match(/PRESET_LABELS\s*=\s*\{([^}]*)\}/) || [])[1] || "";
    check(["Default ramp", "Gas phases (THOR)", "Iso bands", "Clouds (2D)"].every(l => pre.includes(l)), `3D TF presets in js/tf.js: ${pre.replace(/\s+/g, " ").slice(0, 120)}`);
    check(/\.v3tf[^{]*\{[^}]*var\(--mat-/.test(cssText), "3D TF card styled with the glass tokens (--mat-*)"); } }
if (basename(PAGE) === "_template.html") {   // the exporter contract (scripts/export_tng50_web.py replaces the marker)
  check(html.split("/*__DATA__*/null").length === 2 && /const DATA = \/\*__DATA__\*\/null;\n/.test(html), "exactly one config marker, in the form the exporter test parses");
  check(/<script type="module" src="js\/app\.js"><\/script>/.test(html) && /href="css\/page\.css"/.test(html), "the template loads js/app.js and css/page.css");
}

/* ---------------------------------------------------------------- tips: one-line help on every control (tips spec) */
export const TIP_IDS = ["tab-spectra", "tab-3d", "prev", "gal-open", "next", "geo-open", "find-toggle", "chat-open", "info-read", "info-methods",
  "info-licence", "theme", "side-toggle", "controls-open", "ion-open", "ion-none", "ion-default", "sn-0", "sn-1", "vhw", "vreset", "fit", "intr",
  "reroll", "dl-open", "dlpng", "dlpdf", "filter", "showcase", "gal-copy", "gb", "gaz", "gseed", "submit", "apiurl", "v3d-mini",
  "v3-ctl-toggle", "v3-fs-exit", "v3-lo", "v3-hi", "v3-vw", "v3-weight", "v3-cmap", "v3-fs", "v3-gasmix", "v3-stars", "v3-starmix", "v3-mu0",
  "v3-lines", "v3-guides", "v3-scale", "v3-op", "v3-tf-preset", "v3-tf-cv", "v3-tf-w", "v3-tf-a", "v3-tf-col", "v3-tf-add", "v3-tf-del",
  "v3-tf-reset", "v3-tf-2d", "v3-tf-g0", "v3-tf-g1", "v3-tf-shade", "v3-tf-emis", "v3-tf-gamma", "pk-mode", "pk-use", "pk-clear", "pk-submit"];
export const FIND_IDS = ["fq_ion", "fq_n_lo", "fq_n_hi", "fq_sep_lo", "fq_sep_hi", "fq_logN_lo", "fq_logN_hi", "fq_b_lo", "fq_b_hi", "fq_bkpc_lo", "fq_bkpc_hi", "fq_orient", "fq_sort"];
export const tipWords = s => String(s).replace(/\$\{[^}]*\}/g, "X").split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
{ const raw = srcs.map(x => ({f: basename(x.f), src: x.src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))}));
  const tipsMod = srcs.find(x => basename(x.f) === "tips.js");
  check(!!tipsMod && /export function initTips/.test(tipsMod.src) && /export function placeTip/.test(tipsMod.src) && /export function createLongPress/.test(tipsMod.src),
    "tips: js/tips.js exports initTips, placeTip and createLongPress");
  check(raw.some(x => x.f === "app.js" && /import \{[^}]*\binitTips\b[^}]*\} from "\.\/tips\.js"/.test(x.src) && /\binitTips\(\)/.test(x.src)), "tips: app.js imports and calls initTips()");
  check(/(^|\})\s*\.tip\s*\{[^}]*var\(--mat-thick\)[^}]*var\(--mat-blur-thick\)/m.test(cssText) && /\.tip\s*\{[^}]*pointer-events\s*:\s*none/.test(cssText), "tips: .tip styled with the glass tokens (--mat-thick, --mat-blur-thick), pointer-events none");
  /* the opening tag (template or a JS template string) or the h()/el() attribute object that declares an id */
  const declOf = id => { const out = [], e = esc(id);
    for (const m of htmlText.matchAll(new RegExp(`<[a-z]+\\b[^>]*\\bid="${e}"[^>]*>`, "g"))) out.push({f: basename(PAGE), s: m[0]});
    for (const x of raw) { for (const m of x.src.matchAll(new RegExp(`<[a-z]+\\b[^>]*\\bid=\\\\?"${e}\\\\?"[^>]*>`, "g"))) out.push({f: x.f, s: m[0]});
      for (const m of x.src.matchAll(new RegExp(`\\{[^{}]*\\bid:\\s*"${e}"[^{}]*\\}`, "g"))) out.push({f: x.f, s: m[0]}); }
    return out; };
  const hasTip = s => /data-tip\s*=|"data-tip"\s*:/.test(s);
  const missing = TIP_IDS.filter(id => { const d = declOf(id); return !d.length || !d.some(x => hasTip(x.s)); });
  check(!missing.length, `tips: ${TIP_IDS.length - missing.length} of ${TIP_IDS.length} listed controls declare data-tip${missing.length ? "; missing " + missing.join(" ") : ""}`);
  /* grouped and generated controls */
  const lay = [...htmlText.matchAll(/<input\b[^>]*\bname="layout"[^>]*>/g)].map(m => m[0]), ori = [...htmlText.matchAll(/<input\b[^>]*\bname="orient"[^>]*>/g)].map(m => m[0]);
  const src = f => (raw.find(x => x.f === f) || {src: ""}).src;
  const gen = {
    "layout radios (4)": lay.length === 4 && lay.every(hasTip),
    "orientation radios (3)": ori.length === 3 && ori.every(hasTip),
    "R sliders (instrument.js)": /<input type="range" id="R-\$\{b\}-\$\{i\}"[^>]*data-tip="\$\{rTip\(/.test(src("instrument.js")),
    "Lines menu rows and chips (app.js)": /data-testid="ion-\$\{i\.key\}" data-tip=/.test(src("app.js")) && /class="chip"[^>]*data-tip=/.test(src("app.js")),
    "3D field buttons (viewer3d.js radio)": /name="\$\{name\}"[^>]*data-tip="\$\{escH\(fieldTip\(x\)\)\}"/.test(src("viewer3d.js")),
    "3D mode radios": ["integral", "volume"].every(v => new RegExp(`<input type="radio" name="v3-mode" value="${v}"[^>]*data-tip=`).test(src("viewer3d.js"))),
    "3D view buttons (4)": ["face-on", "edge-on", "sightline", "reset"].every(p => new RegExp(`data-p="${p}" data-tip="`).test(src("viewer3d.js"))),
    "Pick ray endpoint inputs (picker.js inp)": /const inp = \(id, lab\)[\s\S]{0,400}"data-tip":/.test(src("picker.js")),
    "Ask backend radios and New, Close (chat.js)": /const mode = \(value, label, id, tip\)[^\n]*"data-tip": tip/.test(src("chat.js")) && (src("chat.js").match(/mode\("(claude|local)", "[^"]+", "chat-be-\w+", "[^"]+"\)/g) || []).length === 2
      && /closeBtn = el\("button", \{[^}]*"data-tip"/.test(src("chat.js")) && /clearBtn = el\("button", \{[^}]*"data-tip"/.test(src("chat.js")),
    "Find fields (app.js FIND_TIPS for search.js)": FIND_IDS.every(id => new RegExp(`\\b${id}:\\s*"`).test((src("app.js").match(/const FIND_TIPS = \{[\s\S]*?\};/) || [""])[0]))
      && FIND_IDS.every(id => src("search.js").includes(`"${id.replace(/_(lo|hi)$/, "")}"`))};
  const bad = Object.entries(gen).filter(([, ok]) => !ok).map(([k]) => k);
  check(!bad.length, `tips: generated and grouped controls carry data-tip (${Object.keys(gen).length - bad.length} of ${Object.keys(gen).length})${bad.length ? "; missing " + bad.join(", ") : ""}`);
  /* no element with both title and data-tip: tags, attribute objects, and .title set on a tipped id */
  const both = [];
  for (const m of htmlText.matchAll(/<[a-z]+\b[^>]*>/g)) if (/\btitle=/.test(m[0]) && hasTip(m[0])) both.push(`${basename(PAGE)}: ${m[0].slice(0, 60)}`);
  for (const x of raw) { for (const m of x.src.matchAll(/<[a-z]+\b[^<>]*>/g)) if (/\btitle=/.test(m[0]) && hasTip(m[0])) both.push(`${x.f}: ${m[0].slice(0, 60)}`);
    for (const m of x.src.matchAll(/\{[^{}]*\}/g)) if (/\btitle:/.test(m[0]) && hasTip(m[0])) both.push(`${x.f}: ${m[0].slice(0, 60)}`); }
  const tipped = TIP_IDS.concat(FIND_IDS, ["R-", "pk-p0", "pk-p1"]);
  for (const x of raw) for (const m of x.src.matchAll(/(?:\$|q|getElementById|querySelector)\(\s*["'`]#?([\w-]+)["'`]\s*\)\.title\s*=/g)) if (tipped.some(t => m[1].startsWith(t))) both.push(`${x.f}: #${m[1]}.title =`);
  for (const id of ["theme", "side-toggle", "submit", "pk-submit", "pk-mode", "v3-tf-preset"]) for (const x of raw) {
    const v = {"side-toggle": /\$\("#side-toggle"\)/, theme: /\$\("#theme"\)/, submit: /\$\("#submit"\)/, "pk-submit": /bSub/, "pk-mode": /bMode/, "v3-tf-preset": /q\("#v3-tf-preset"\)/}[id];
    for (const line of x.src.split("\n")) if (v.test(line) && /\b(b|p|bSub|bMode|\$\("#submit"\))\.title\s*=/.test(line)) both.push(`${x.f}: ${id} .title in "${line.trim().slice(0, 50)}"`); }
  check(!both.length, `tips: no element has both title and data-tip${both.length ? ": " + [...new Set(both)].slice(0, 8).join("; ") : ""}`);
  /* the copy: every literal tip line <= 12 words, no dot separators */
  const lines = [];
  const lit = (f, expr) => { for (const m of expr.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) { const t = m[1] ?? m[2]; if (/[\p{L}]{3}/u.test(t) && !/^[\w-]+$/.test(t)) lines.push({f, t}); } };
  for (const m of htmlText.matchAll(/data-tip="([^"]*)"/g)) lines.push({f: basename(PAGE), t: m[1]});
  for (const x of raw) {
    for (const m of x.src.matchAll(/data-tip="((?:[^"$]|\$\{[^}]*\})*)"/g)) if (!/^\$\{[^}]*\}$/.test(m[1])) lines.push({f: x.f, t: m[1]});
    for (const m of x.src.matchAll(/"data-tip":\s*("(?:[^"\\]|\\.)*"|`[^`]*`)/g)) lit(x.f, m[1]);
    for (const m of x.src.matchAll(/dataset\.tip\s*=\s*([^;\n]+)/g)) lit(x.f, m[1]);
    for (const name of ["ION_TIPS", "FIND_TIPS", "GAS_TIP", "VEL_TIP"]) { const o = x.src.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`)); if (o) lit(x.f, o[1]); }
    for (const fn of ["rTip", "fieldTip"]) { const o = x.src.match(new RegExp(`(?:function ${fn}\\b|const ${fn} = )[\\s\\S]*?\\n\\s*(?:\\}|[^\\n]*\\};)\\n`)); if (o) lit(x.f, o[0]); } }
  const long = lines.filter(l => tipWords(l.t) > 12), sepd = lines.filter(l => sepHits(l.t.replace(/\$\{[^}]*\}/g, "X")).length);
  check(lines.length >= 100 && !long.length, `tips: ${lines.length} tip lines, each <= 12 words${long.length ? "; too long: " + long.slice(0, 5).map(l => `${l.f} "${l.t}" (${tipWords(l.t)})`).join("; ") : ""}`);
  check(!sepd.length, `tips: no dot separators in tip lines${sepd.length ? ": " + sepd.slice(0, 5).map(l => `${l.f} "${l.t}"`).join("; ") : ""}`);
  console.log(`note: ${lines.length} tip lines scanned, longest ${Math.max(...lines.map(l => tipWords(l.t)))} words`); }

/* ---------------------------------------------------------------- pure state (js/state.js; from the page agent's checks) */
if (!existsSync(join(DIR, "js", "state.js"))) console.log("note: no js/state.js in " + DIR + "; state unit checks skipped");
else {
  const St = await import(pathToFileURL(join(DIR, "js", "state.js")).href);
  const SCFG = {ions: [{key: "HI", order: 0, band: "uv", label: "H I 1216"}, {key: "CIV", order: 7, band: "uv", label: "C IV 1548"}, {key: "NeVIII", order: 10, band: "euv", label: "Ne VIII 770"}, {key: "OVII", order: 11, band: "xray", label: "O VII 21.6"}],
    bands: {uv: {label: "UV", R: {min: 5000, max: 150000, default: 30000, pair: [15000, 50000]}}, euv: {label: "EUV", R: {min: 5000, max: 150000, default: 30000, pair: [15000, 50000]}},
      xray: {label: "X-ray", R: {min: 100, max: 5000, default: 1000, pair: [300, 3000]}}}, snr: {min: 2, max: 100, default: 10, pair: [20, 5]},
    defaults: {id: "edge_b100_a090", ions: ["HI", "CIV", "OVII"], layout: "1", R: {uv: [15000, 50000], euv: [15000, 50000], xray: [300, 3000]}, sn: [20, 5], vc: 0, vhw: 400}};
  const reg = St.makeRegistry(SCFG), S0 = Object.assign(St.cloneState(reg.DEF), {id: "edge_b100_a090"});
  check(reg.DEF.layout === "1" && reg.DEF.ions.join() === "HI,CIV,OVII", "registry defaults: layout 1, default ions");
  check(JSON.stringify(["1", "2R", "2SN", "4"].map(l => St.casesFor(l))) === JSON.stringify([[[0, 0]], [[0, 0], [1, 0]], [[0, 0], [0, 1]], [[0, 0], [1, 0], [0, 1], [1, 1]]]), "cases per layout (§6.3 table)");
  const uv = SCFG.bands.uv.R, xr = SCFG.bands.xray.R;
  check(St.tToR(uv, 0) === 5000 && St.tToR(uv, 1000) === 150000 && St.tToR(xr, 0) === 100 && St.tToR(xr, 1000) === 5000, "R slider ends reachable (UV 5,000 to 150,000; X-ray 100 to 5,000)");
  check([...Array(1001).keys()].every(t => { const R = St.tToR(uv, t); return R === St.sig2(R) || t === 0 || t === 1000; }), "R slider values have 2 significant digits");
  check(St.rToT(uv, 15000) === St.rToT(uv, St.tToR(uv, St.rToT(uv, 15000))), "R slider round trip is stable");
  const stops = St.snStops(2, 100);
  check(stops[0] === 2 && stops.at(-1) === 100 && stops.every((x, i) => !i || x > stops[i - 1]) && stops.every(Number.isInteger), `S/N stops: unique integers 2 to 100 (${stops.length})`);
  check(St.tToV(0, 1500) === 10 && St.tToV(1000, 1500) === 1500 && St.tToV(St.vToT(400, 1500), 1500) === 400, "half-window slider: 10 km/s to vmax, 400 round trips");
  const cvw = St.clampView({vc: 1400, vhw: 400}, 1500); check(cvw.vc === 1100 && cvw.vhw === 400, "clampView keeps the window inside ±vmax");
  const hh = St.parseHash("#id=face_b050_a090&ions=OVII,HI,FOO&lay=4&R=uv:20000,40000;xray:50,9000&sn=1,200&vc=-120&vw=60&seed=3&fit=1&intr=1&tab=3d", reg, S0);
  check(hh.id === "face_b050_a090" && hh.ions.join() === "HI,OVII" && hh.layout === "4" && hh.R.uv.join() === "20000,40000" && hh.R.xray.join() === "100,5000" &&
    hh.sn.join() === "2,100" && hh.vc === -120 && hh.vhw === 60 && hh.seed === 3 && hh.fit && hh.intr && hh.tab === "3d", "hash v3 parses, clamps to the registry ranges and drops unknown ions");
  const lg = St.parseHash("#id=edge_b100_a090&R=20000,40000&sn=8,5&v=300", reg, S0);
  check(lg.R.uv.join() === "20000,40000" && lg.sn.join() === "8,5" && lg.vhw === 300 && lg.layout === "1", "legacy v2 hash maps R to the UV band, sn, v to the half-window");
  check(St.parseHash("#ions=FOO", reg, S0).ions.join() === reg.DEF.ions.join(), "an empty ion list falls back to the defaults");
  const rt = St.parseHash("#" + St.formatHash(hh), reg, S0); check(JSON.stringify(rt) === JSON.stringify(hh), "formatHash / parseHash round trip");
  const vmaxFor = () => 1500, err = o => { try { St.instrumentPatch(o, reg, S0, vmaxFor); return null; } catch (x) { return x instanceof RangeError ? x.message : "not a RangeError: " + x; } };
  check(err({R: {uv: 4000}})?.startsWith("R.uv:") && err({R: {far: 1000}})?.startsWith("R: unknown band") && err({snr: 101})?.startsWith("snr:") && err({layout: "3"})?.startsWith("layout:") &&
    err({ions: []})?.startsWith("ions:") && err({ions: ["HILyb"]})?.startsWith("ions:") && err({vhw: 5})?.startsWith("vhw:") && err({vc: 1200, vhw: 400})?.startsWith("vc:") &&
    err({fit: "yes"})?.startsWith("fit:") && err({zoom: 2})?.startsWith("zoom:"), "setInstrument: each invalid field gives a RangeError naming it");
  const PT = St.instrumentPatch({R: {uv: [20000, 60000], xray: 1000}, snr: [100, 2], layout: "2SN", ions: ["OVII", "HI"], vhw: 20, vc: 30.5, fit: true}, reg, S0, vmaxFor);
  check(PT.R.uv.join() === "20000,60000" && PT.R.xray.join() === "1000,3000" && PT.sn.join() === "100,2" && PT.layout === "2SN" && PT.ions.join() === "HI,OVII" && PT.vhw === 20 && PT.vc === 30.5 && PT.fit === true,
    "setInstrument: a valid patch, ions put into registry order, a scalar R sets the first case");
  check(St.minus(-400) === "−400" && St.fmtNum(-0.004, 2) === "0.00", "U+2212 minus for negatives, no negative zero");
  /* C2: lower limits (owner decision 2), readout flags (code 2), the AOD lower bound, the boot clamp (code 6) */
  { const K = (flag, logN = 15, extra = {}) => Object.assign({v: 0, logN, dlogN: flag & 32 ? null : 0.05, b: 20, db: 1, dv: 0.3, flag}, extra);
    check(St.isLowerLimit(K(1)) && St.isLowerLimit(K(33)) && St.isLowerLimit(K(32)) && !St.isLowerLimit(K(65)) && !St.isLowerLimit(K(0)) && !St.isLowerLimit(K(2 | 8 | 128)),
      "isLowerLimit: NOERR, or SAT without DAMPED, nothing else");
    check(St.limitLogN(K(33, 17.91, {logN_lo: 15.1})) === 15.1 && St.limitLogN(K(1, 14, {logN_lo: 14.6})) === 14 && St.limitLogN(K(1, 14)) === 14, "limitLogN = min(logN, logN_lo)");
    const fc = (c, damped, q) => St.fitClass(c, damped, q);
    check(fc(K(1, 17.9), true, null).limit && !fc(K(1, 20.3), true, null).limit && fc(K(1, 20.3), false, null).limit && fc(K(33, 20.3), true, null).limit,
      "fitClass without fit.js fitQuality: SAT is a lower limit, except a damped-ion fit at log N >= 19 that kept its errors");
    const t1 = fc(K(1 | 2, 15), false, null), t2 = fc(K(2, 13, {dlogN: 2.5}), false, null), t3 = fc(K(0, 13), false, "unconstrained"), t4 = fc(K(1, 15), false, "ok");
    check(t1.limit && t1.tags.join() === "sat,bound" && !t1.hollow && t2.hollow && t2.tags.join() === "bound,unconstrained" && t3.loose && t3.hollow && !t4.limit,
      `fitClass names every flag and follows fitQuality when given (${[t1, t2, t3, t4].map(x => x.tags.join("+")).join(" ")})`);
    const n = 401, v = Float64Array.from({length: n}, (_, i) => -200 + i), tau = Float64Array.from(v, x => Math.exp(-0.5 * (x / 10) ** 2));
    const lnT = Math.log10(3.7679e14 / (0.1325 * 1031.912) * 10 * Math.sqrt(2 * Math.PI));     // tau0 = 1, sigma_v = 10 km/s
    const a = St.aodLogN({v, flux: Float64Array.from(tau, t => Math.exp(-t)), dvp: 1, sigma: 0.001}, -100, 100, 1031.912, 0.1325);
    check(Math.abs(a - lnT) < 0.01, `aodLogN recovers an unsaturated O VI column (${a.toFixed(3)} vs ${lnT.toFixed(3)})`);
    const s = St.aodLogN({v, flux: Float64Array.from(tau, t => Math.exp(-100 * t)), dvp: 1, sigma: 0.02}, -100, 100, 1031.912, 0.1325);
    check(s > lnT && s < lnT + 2, `aodLogN of a saturated trough (tau0 100) is a lower limit (${s.toFixed(2)} < true ${(lnT + 2).toFixed(2)})`);
    const r = {comps: [K(1, 17.0, {v: -10}), K(0, 13.0, {v: 30})], windows: [[-100, 100]]};
    const lim = St.fitLimits(r, {v, flux: Float64Array.from(tau, t => Math.exp(-100 * t)), dvp: 1, sigma: 0.02}, {lam0_A: 1031.912, f: 0.1325}, St.isLowerLimit);
    check(lim.size === 1 && lim.get(r.comps[0]) < 17.0 && lim.get(r.comps[0]) <= s, `fitLimits: the saturated fit at 17.0 reads as > ${lim.get(r.comps[0])?.toFixed(2)}, its share of the window AOD`);
    const deep = St.clampView({vc: 2000, vhw: 6000}, Math.min(20000, Math.max(1500, 6000 + 2000)));
    check(deep.vhw === 6000 && deep.vc === 2000, "boot clamp keeps a deep-linked damped H I window and its centre until the line is decoded"); }}

/* ---------------------------------------------------------------- browser part */
if (!process.env.TNG_BROWSER) { console.log("browser part skipped (set TNG_BROWSER=1 to run it in headless Edge)"); process.exit(C.finish()); }
const SERVE = opt.serve ? resolve(opt.serve) : pickPage(DIR, null);
const srv = await serve({dir: DIR, page: SERVE, port: opt.port, viz: opt.viz || process.env.TNG_VIZ});
const P = await launch({profile: opt.profile, edge: opt.edge, inject: readInjects(opt.inject), block: BLOCK});
try {
  console.log(`serving ${SERVE.replace(ROOT + "/", "")} at ${srv.base}; Edge up in ${(P.startMs / 1000).toFixed(1)} s`);
  await P.viewport(1440, 900); await P.scheme(false); await P.goto(srv.base + srv.query);
  const tReady = await P.waitFor(READY, 180000, 250);
  if (!check(tReady >= 0, `page ready (tngApp v3 and a panel hit box) in ${(tReady / 1000).toFixed(1)} s`)) throw new Error("page never became ready");
  await P.eval(UI_LIB);
  const st = await P.eval("tngApp.getState()");
  { const r = await P.fn(`const ids = ${JSON.stringify(STATIC_IDS)}, tids = ${JSON.stringify(STATIC_TESTIDS)};
      return {ids: ids.filter(i => !document.getElementById(i)), tids: tids.filter(t => !document.querySelector('[data-testid="' + t + '"]'))};`);
    check(!r.ids.length && !r.tids.length, `live DOM has every static 6.1 id and test id${r.ids.length ? "; missing #" + r.ids.join(" #") : ""}${r.tids.length ? "; missing test ids " + r.tids.join(" ") : ""}`); }
  { const want = [...new Set(st.ions.map(k => REG.ions.find(i => i.key === k).band))];
    const r = await P.fn(`const st = tngApp.getState(), bands = ${JSON.stringify(want)}, miss = [];
      for (const b of bands) for (const s of ["R-" + b + "-0", "R-" + b + "-0-out"]) if (!document.getElementById(s)) miss.push("#" + s);
      for (const b of bands) if (!document.querySelector('[data-testid="R-' + b + '-0"]')) miss.push("test id R-" + b + "-0");
      for (const k of ${JSON.stringify(REG.ions.map(i => i.key))}) if (!document.querySelector('input[type=checkbox][data-ion="' + k + '"][data-testid="ion-' + k + '"]')) miss.push("ion-" + k);
      for (const k of st.ions) { if (!document.querySelector('.panel[data-testid="panel-' + k + '-0"][data-ion="' + k + '"][data-case="0"]')) miss.push("panel-" + k + "-0");
        if (!document.querySelector('#ion-chips > button[data-ion="' + k + '"]')) miss.push("chip " + k); }
      return miss;`);
    check(!r.length, `generated ids present: R-<band>-0 for bands ${want.join(", ")}, 12 ion-<key> checkboxes, panel-<key>-0 and a chip per ion${r.length ? "; missing " + r.join(", ") : ""}`); }
  /* tips in the live page: module up, no title next to a data-tip, every line <= 12 words, generated controls tipped,
   the tip shows on screen with the control's line and the control is described by it */
{ const r = await P.fn(`const all = [...document.querySelectorAll("[data-tip]")], w = s => s.split(/\\s+/).filter(x => /[\\p{L}\\p{N}]/u.test(x)).length;
    const gen = [...document.querySelectorAll('#rsliders input[type=range], #ion-list input[data-ion], #ion-chips > button')];
    const sn = document.getElementById("sn-0"); window.tngTips && window.tngTips.show(sn); const t = document.getElementById("tip"), tr = t && t.getBoundingClientRect();
    const d = (sn.getAttribute("aria-describedby") || "").split(/\\s+/).map(i => document.getElementById(i)).filter(Boolean).map(e => e.textContent);
    const out = {api: !!window.tngTips, n: all.length, both: [...document.querySelectorAll("[data-tip][title]")].map(e => e.id || e.tagName),
      long: all.filter(e => w(e.dataset.tip) > 12).map(e => e.dataset.tip), gen: gen.length, untipped: gen.filter(e => !e.dataset.tip).map(e => e.id || e.dataset.ion),
      shown: !!t && !t.hidden && t.textContent === sn.dataset.tip, on: !!tr && tr.left >= 0 && tr.right <= innerWidth && tr.top >= 0 && tr.bottom <= innerHeight, desc: d.includes(sn.dataset.tip)};
    window.tngTips && window.tngTips.hide(); return out;`);
  check(r.api && r.n >= 40 && !r.both.length && !r.long.length, `tips live: tngTips up, ${r.n} tipped elements, none with a title${r.both.length ? " (" + r.both.join(" ") + ")" : ""}, none over 12 words${r.long.length ? " (" + r.long.slice(0, 3).join("; ") + ")" : ""}`);
  check(r.gen >= 12 && !r.untipped.length, `tips live: ${r.gen} generated R sliders, Lines rows and chips all tipped${r.untipped.length ? "; untipped " + r.untipped.join(" ") : ""}`);
  check(r.shown && r.on && r.desc, `tips live: #sn-0 tip shown on screen with its line (${r.shown}, ${r.on}), aria-describedby carries it (${r.desc})`); }
{ const r = await P.fn(`const t = document.getElementById("title"); return {px: parseFloat(getComputedStyle(t).fontSize), text: t.innerText.trim()};`);
    check(r.px <= 14, `C11 #title font-size ${r.px} px (<= 14), text ${JSON.stringify(r.text)}`); }
  check(!(await P.eval(`/interactive\\s+companion/i.test(document.documentElement.innerText + " " + document.documentElement.textContent)`)), 'C11 no "Interactive companion" in the live document');
  { const r = await P.fn(`const st = tngApp.getState(), ps = tngApp.panels(), L = document.querySelector('input[name=layout][value="1"]');
      const shownSecond = [...document.querySelectorAll('[id^="R-"][id$="-1"], #sn-1')].filter(e => e.tagName === "INPUT" && __ui.vis(e)).map(e => e.id);
      return {layout: st.layout, checked: !!(L && L.checked), n: ps.length, ions: st.ions.length, cases: [...new Set(ps.map(p => p.case))], shownSecond};`);
    check(r.layout === "1" && r.checked && r.n === r.ions && r.cases.length === 1 && r.cases[0] === 0 && !r.shownSecond.length,
      `default layout is one case: layout ${r.layout}, layout-1 checked ${r.checked}, ${r.n} panels for ${r.ions} ions, cases [${r.cases}], second sliders shown [${r.shownSecond}]`); }
  { const r = await P.fn(`const out = {}; for (const id of ["fit", "intr"]) { const e = document.getElementById(id);
        out[id] = e ? {type: e.type || e.getAttribute("role"), role: e.getAttribute("role"), label: __ui.label(e)} : null; } return out;`);
    const ok = k => r[k] && (r[k].type === "checkbox" || r[k].role === "switch") && /\p{L}/u.test(r[k].label);
    check(ok("fit") && ok("intr"), `pick.md: #fit and #intr are labelled toggles (fit ${JSON.stringify(r.fit)}, intr ${JSON.stringify(r.intr)})`); }
  { await P.eval(`tngApp.showTab("3d")`); await P.waitFor(`__ui.vis(document.getElementById("v3d-stage"))`, 15000); await sleep(600);
    const r = await P.fn(`return {s: __ui.rect("#v3d-stage"), ar: getComputedStyle(document.getElementById("v3d-stage")).aspectRatio};`);
    check(r.s && Math.abs(r.s.w - r.s.h) <= 1 && r.s.w > 100, `C13 #v3d-stage square at 1440x900: ${r.s ? r.s.w.toFixed(1) + " x " + r.s.h.toFixed(1) : "absent"} (aspect-ratio ${r.ar})`);
    const t3 = await P.waitFor(`${JSON.stringify(VIEWER_IDS)}.every(i => document.getElementById(i))`, 60000, 250);
    const miss = await P.eval(`${JSON.stringify(VIEWER_IDS)}.filter(i => !document.getElementById(i))`);
    // the viewer (and so its ids) needs three.js from the CDN; when that module never arrives, say so instead of failing
    const three = P.requests.filter(r => /three@0\.169\.0\/build\/three\.module/.test(r)).length, mounted = await P.eval("!!window.tngViewer3d");
    if (miss.length && !mounted) C.note(`3D viewer did not mount within 60 s (three.module requested ${three} times; CDN or WebGL2 unavailable here): viewer ids not checked`);
    else check(!miss.length, `3D viewer ids #${VIEWER_IDS.join(" #")} present after the 3D tab opens${miss.length ? "; missing #" + miss.join(" #") : ` (${(t3 / 1000).toFixed(1)} s)`}`);
    if (!miss.length && mounted) { const r = await P.fn(`const c = [...document.querySelectorAll('#v3-ctl input, #v3-ctl select, #v3-ctl button, #v3-ctl canvas')];
        return {n: c.length, untipped: c.filter(e => !e.dataset.tip).map(e => e.id || (e.name + ":" + e.value)).slice(0, 12),
          both: [...document.querySelectorAll("[data-tip][title]")].map(e => e.id || e.tagName)};`);
      check(!r.untipped.length && !r.both.length, `tips live: all ${r.n} 3D controls tipped${r.untipped.length ? "; untipped " + r.untipped.join(" ") : ""}${r.both.length ? "; title and data-tip: " + r.both.join(" ") : ""}`); }
    await P.eval(`tngApp.showTab("spectra")`); }
  check(!P.exceptions.length, `no page exceptions${P.exceptions.length ? ": " + P.exceptions.slice(0, 3).join(" | ") : ""}`);
} catch (x) { check(false, "browser part aborted: " + x.message); }
finally { await P.close(); await srv.close(); }
process.exit(C.finish());
