// The B0 gate of "How a spectrum is made" v2 (DESIGN §3 B0, DESIGN_final §3.2 "B0 gate", §5.8 U_entry) and the entry
// grammar the explorer's call to action writes (docs/tng50/js/app.js storyEntry).
//
// The gate is the first screen: a still of this galaxy's gas and starlight (img/poster_<g>_<ray>.webp, landscape, and
// _p.webp, portrait; scripts/story_posters.mjs), the title, and two equal choices: "Hold to ride" (hold the button or
// Space for HOLD_MS; one press under reduced motion; Enter on the focused button rides at once, so a keyboard never needs
// to hold) and "Watch (<length>)". Below them "Skip intro" and "Read as text", then a one-line credit for the still.
// When the live volume is ready the integrator calls liveReady(): the gate's sky turns transparent; the poster stays until close.
// While the gate is open it owns Space (capture phase), so the story's input layer does not fly before the ride starts;
// a Space held through the end of the hold keeps flying once the gate closes (auto-repeat reaches input.js again).
// Every box is in one flex column, so nothing can overlap; rects() lists the visible boxes for the G1 run (U_qa), and
// the HUD and rail are hidden under html.gate-open (they would sit under the gate's still).
//
// Pure (node-tested in tests/js/story_handoff.mjs): parseEntry, entryFragment, watchLabel, holdProgress, posterSources,
// fill. DOM: createGate(host, opts).
//
// Entry grammar (fragment; the query also accepts g and ray, as store.js):
//   #g=<subhalo>&ray=<sightline id>&ion=<HI|OVI>&R=<int>&sn=<int>[&t=<p 0..1>|&beat=<beat id>]&from=explorer
// Unknown or out-of-range values are dropped (ion not in the story's ions, R or sn outside the explorer's UV ranges are
// clamped as store.js does). Nothing here reads time, the DOM or Math.random in the pure part.

export const HOLD_MS = 450;
export const R_RANGE = Object.freeze({min: 5000, max: 150000});   // = store.js R_RANGE (explorer UV band slider)
export const SN_RANGE = Object.freeze({min: 2, max: 100});        // = store.js SN_RANGE
export const STORY_IONS = Object.freeze(["HI", "OVI"]);
const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;                           // a sightline id as a file-name-safe token (state.js ID_RE is stricter)
const BEAT_RE = /^B\d{1,2}[a-z]?$/;

const clampI = (x, r) => Math.min(r.max, Math.max(r.min, Math.round(x)));
const galaxyId = x => { const m = /^(?:tng50-1-99-)?(\d{1,9})$/i.exec(String(x == null ? "" : x).trim()); return m ? +m[1] : null; };

/* location-like {hash, search} -> {g, ray, ion, R, sn, t, beat, from}; every field null when absent or invalid */
export function parseEntry(loc, {ions = STORY_IONS} = {}) {
  const h = new URLSearchParams(String((loc && loc.hash) || "").replace(/^#/, "")), q = new URLSearchParams(String((loc && loc.search) || "").replace(/^\?/, ""));
  const pick = k => (h.has(k) ? h.get(k) : q.has(k) ? q.get(k) : null);
  const out = {g: galaxyId(pick("g")), ray: null, ion: null, R: null, sn: null, t: null, beat: null, from: null};
  const ray = pick("ray"); if (ray && ID_RE.test(ray)) out.ray = ray;
  const ion = pick("ion"); if (ion && ions.includes(ion)) out.ion = ion;
  const R = Number(h.get("R")); if (h.has("R") && h.get("R") !== "" && Number.isFinite(R)) out.R = clampI(R, R_RANGE);
  const sn = Number(h.get("sn")); if (h.has("sn") && h.get("sn") !== "" && Number.isFinite(sn)) out.sn = clampI(sn, SN_RANGE);
  const t = Number(h.get("t")); if (h.has("t") && h.get("t") !== "" && Number.isFinite(t)) out.t = Math.min(1, Math.max(0, t));
  const beat = h.get("beat"); if (beat && BEAT_RE.test(beat)) out.beat = beat;
  const from = h.get("from"); if (from && /^[a-z]{1,16}$/.test(from)) out.from = from;
  return out;
}

/* the inverse: fields (null/undefined skipped) -> fragment without "#", keys in the explorer's order */
export function entryFragment(o) {
  const p = [];
  if (o.g != null) p.push(`g=${o.g}`);
  if (o.ray) p.push(`ray=${encodeURIComponent(o.ray)}`);
  if (o.ion) p.push(`ion=${o.ion}`);
  if (o.R != null) p.push(`R=${Math.round(o.R)}`);
  if (o.sn != null) p.push(`sn=${Math.round(o.sn)}`);
  if (o.t != null) p.push(`t=${+(+o.t).toFixed(4)}`);
  if (o.beat) p.push(`beat=${o.beat}`);
  if (o.from) p.push(`from=${o.from}`);
  return p.join("&");
}

/* Watch length for the gate button: under 90 s in seconds, else minutes rounded to the half ("2½ min", "5 min") */
export function watchLabel(seconds) {
  const s = Number(seconds);
  if (!(s > 0)) return null;
  if (s < 90) return `${Math.round(s)} s`;
  const half = Math.round(s / 30) / 2, whole = Math.floor(half);
  return `${whole || ""}${half - whole ? "½" : ""} min`;
}

/* hold progress 0..1 after elapsed ms (linear; the ring eases in CSS) */
export const holdProgress = (elapsed, ms = HOLD_MS) => Math.min(1, Math.max(0, (Number(elapsed) || 0) / ms));

/* poster files of a galaxy and story ray, relative to ROOT */
export function posterSources(g, ray, base = "img/") {
  if (g == null || !ray) return null;
  const stem = `${base}poster_${g}_${ray}`;
  return {landscape: `${stem}.webp`, portrait: `${stem}_p.webp`, card: `${stem}_card.webp`, meta: `${stem}.json`};
}

/* {{key}} and {{$key}} from vars; unknown keys stay visible (the copy lint catches them) */
export const fill = (s, vars = {}) => String(s == null ? "" : s).replace(/\{\{\$?([\w.]+)\}\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));

/* ------------------------------------------------------------------------------------------------------------ DOM */
const CSS = `
html.gate-open #hud,html.gate-open #rail,html.gate-open #kinetic,html.gate-open #labels,html.gate-open #dock{visibility:hidden}
.sg{position:absolute;inset:0;z-index:55;overflow:hidden;background:var(--sky,#04050a);color:var(--sky-ink,#f4f1ea);
  font:400 16px/1.5 var(--sans,system-ui,sans-serif);opacity:1;transition:opacity .6s var(--ease-dissolve,ease)}
.sg[hidden]{display:none}
.sg.out{opacity:0;pointer-events:none}
.sg-art{position:absolute;inset:-3%;transition:opacity 1.2s var(--ease-dissolve,ease)}
.sg-art img{width:100%;height:100%;object-fit:cover;display:block;animation:sg-drift 48s ease-in-out infinite alternate}
.sg.no-poster .sg-art{background:radial-gradient(60% 50% at 66% 52%,rgba(255,196,140,.16),transparent 70%),radial-gradient(90% 80% at 70% 50%,#121a33,var(--sky,#04050a))}
.sg.no-poster .sg-art img{display:none}
/* review SC-3/H1: the poster stays until the gate closes (the live B0 frame shows the beam but not the galaxy the credit
   names); the gate's own sky goes transparent once live, so nothing opaque hides the stage behind the poster */
.sg.live{background:transparent}
@keyframes sg-drift{from{transform:scale(1.02) translate(0,0)}to{transform:scale(1.09) translate(-1.2%,.8%)}}
.sg-scrim{position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,rgba(4,5,10,.86) 0%,rgba(4,5,10,.62) 34%,rgba(4,5,10,0) 62%)}
.sg-in{position:absolute;display:flex;flex-direction:column;align-items:flex-start;gap:clamp(12px,2.2vh,22px);
  left:calc(max(24px,6vw) + var(--sal,0px));top:50%;transform:translateY(-50%);width:min(36em,40vw);max-height:calc(100% - 48px)}
.sg-t{margin:0;font:400 clamp(34px,min(5.4vw,9vh),84px)/1.02 var(--serif,Georgia,serif);letter-spacing:-.015em;text-wrap:balance;
  text-shadow:0 2px 24px rgba(0,0,0,.55)}
.sg-s{margin:0;max-width:30em;font-size:clamp(15px,min(1.35vw,2.4vh),20px);color:var(--sky-muted,#b9b6c8);text-shadow:0 1px 12px rgba(0,0,0,.6)}
.sg-c{display:flex;flex-wrap:wrap;gap:12px;margin-top:clamp(4px,1vh,10px)}
.sg-b{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:12px;min-width:12.5em;min-height:52px;padding:0 22px 0 16px;
  border-radius:26px;border:1px solid rgba(255,232,196,.42);background:#0b0f1ce6;color:var(--sky-ink,#f4f1ea);cursor:pointer;
  font:500 16px/1 var(--sans,system-ui,sans-serif);touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;
  transition:border-color .25s var(--ease-ui,ease),box-shadow .25s var(--ease-ui,ease),background .25s}
.sg-b:hover,.sg-b:focus-visible{border-color:var(--beam,#fff4df);box-shadow:0 0 0 3px rgba(255,226,180,.18),0 0 26px -4px var(--beam-glow,rgba(255,226,180,.55))}
.sg-b:focus-visible{outline:2px solid var(--accent,#8fa8ff);outline-offset:3px}
.sg-b svg{flex:none;width:26px;height:26px;overflow:visible}
.sg-ring-bg{fill:none;stroke:rgba(255,244,223,.28);stroke-width:2}
.sg-ring{fill:none;stroke:var(--beam,#fff4df);stroke-width:2.4;stroke-linecap:round;transform:rotate(-90deg);transform-origin:13px 13px;
  stroke-dasharray:69.1;stroke-dashoffset:calc(69.1 * (1 - var(--hold,0)))}
.sg-dot{fill:var(--beam,#fff4df)}
.sg-b.holding{border-color:var(--beam,#fff4df);background:#1a1712f0}
.sg-b.nudge .sg-l::after{content:attr(data-nudge);position:absolute;left:0;right:0;top:calc(100% + 8px);font-size:13px;color:var(--sky-muted,#b9b6c8);text-align:center}
.sg-l{position:relative;white-space:nowrap}
.sg-tri{fill:var(--beam,#fff4df)}
.sg-k{display:flex;flex-wrap:wrap;gap:4px 18px;margin-top:clamp(0px,.6vh,6px)}
.sg-a{min-height:44px;padding:0 2px;border:0;background:none;color:var(--sky-ink,#f4f1ea);font:400 14px/1 var(--sans,system-ui,sans-serif);cursor:pointer;
  text-decoration:underline;text-decoration-color:rgba(244,241,234,.38);text-underline-offset:4px}
.sg-a:hover,.sg-a:focus-visible{text-decoration-color:currentColor}
.sg-a:focus-visible{outline:2px solid var(--accent,#8fa8ff);outline-offset:2px}
.sg-cr{margin:0;font:400 12px/1.45 var(--mono,ui-monospace,monospace);color:var(--sky-muted,#b9b6c8);max-width:36em;text-shadow:0 1px 8px rgba(0,0,0,.7)}
.sg.go .sg-b.hold{box-shadow:0 0 0 6px rgba(255,226,180,.16),0 0 44px 4px var(--beam-glow,rgba(255,226,180,.55))}
/* portrait and short screens: the column sits at the bottom, full width; the scrim runs from the bottom */
@media (orientation:portrait),(max-aspect-ratio:6/5){
  .sg-scrim{background:linear-gradient(0deg,rgba(4,5,10,.9) 0%,rgba(4,5,10,.7) 42%,rgba(4,5,10,0) 72%)}
  .sg-in{left:calc(20px + var(--sal,0px));right:calc(20px + var(--sar,0px));width:auto;top:auto;bottom:calc(20px + var(--sab,0px));transform:none;max-height:calc(100% - 40px)}
  .sg-t{font-size:clamp(30px,min(9vw,6.2vh),56px)}
  .sg-s{font-size:clamp(15px,min(3.6vw,2.2vh),19px)}
  .sg-c{width:100%}
  .sg-b{flex:1 1 10em;min-width:0}
}
@media (max-height:480px) and (min-aspect-ratio:6/5){
  .sg-in{gap:8px;width:min(34em,52vw);left:calc(20px + var(--sal,0px))}
  .sg-t{font-size:clamp(26px,7vh,40px)}.sg-s{font-size:14px}.sg-b{min-height:44px;font-size:15px;min-width:10em}.sg-k{margin-top:0}
}
@media (max-width:440px){.sg-c{flex-direction:column}.sg-b{width:100%;flex:none;min-height:48px}}
@media (max-height:480px){.sg-cr{display:none}}
@media (max-height:300px){.sg-s{display:none}}
@media (max-width:320px){.sg-t{font-size:max(26px,9.4vw)}.sg-c{flex-direction:column}.sg-b{width:100%;flex:none;min-height:44px}.sg-cr{display:none}
  .sg-in{gap:10px}.sg-k{gap:0 16px}.sg-b{padding:6px 12px;gap:8px}.sg-l{white-space:normal;text-align:left}}
@media (max-width:320px) and (max-height:460px){.sg-s{display:none}}
@media (prefers-reduced-motion:reduce){.sg-art img{animation:none}.sg,.sg-art,.sg-b{transition:none}}
html.reduced .sg-art img{animation:none}
[data-gate-focus]:focus{outline:none}
`;

let cssDone = false;
function injectCss(doc) {
  if (cssDone || doc.getElementById("gate-css")) { cssDone = true; return; }
  const st = doc.createElement("style"); st.id = "gate-css"; st.textContent = CSS; doc.head.appendChild(st); cssDone = true;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

/* host: the stage element. opts = {copy, vars: {galaxy, ...}, g, ray, posterBase ("img/"), watchSeconds, reduced,
     credit (string; default from vars), onRide({via, holding}), onWatch(), onSkip(), onText(), autofocus (default true),
     focusAfter (element or () => element; default host: where focus goes on close)}
   -> {el, open(), close({instant}), isOpen(), liveReady(), rects(), setWatch(seconds), destroy()} */
export function createGate(host, opts = {}) {
  const doc = host.ownerDocument || document, win = doc.defaultView || window;
  injectCss(doc);
  const copy = opts.copy || {}, B0 = copy.B0 || {}, ui = copy.ui || {}, vars = {...(opts.vars || {})};
  const reduced = () => (opts.reduced != null ? !!opts.reduced : win.matchMedia ? win.matchMedia("(prefers-reduced-motion: reduce)").matches : false);
  vars.watch_len = watchLabel(opts.watchSeconds) || vars.watch_len;
  const phone = () => Math.min(win.innerWidth, win.innerHeight) <= 480;
  const title = fill(B0.display || "How a spectrum is made", vars);
  const sub = fill(phone() && B0.sub_short ? B0.sub_short : B0.sub || "Ride one beam of quasar light through the gas around a galaxy.", vars);
  const holdL = fill(ui.gate_hold || "Hold to ride", vars);
  const watchL = () => (vars.watch_len ? fill(ui.gate_watch || "Watch ({{$watch_len}})", vars) : "Watch");
  const credit = opts.credit != null ? opts.credit : vars.galaxy != null
    ? `TNG50 galaxy ${vars.galaxy}: gas and starlight from the simulation; the line is the beam.` : "";
  const P = posterSources(opts.g, opts.ray, opts.posterBase || "img/");

  const el = doc.createElement("section");
  el.className = "sg"; el.id = "gate"; el.dataset.noscrub = ""; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "false");
  el.setAttribute("aria-labelledby", "sg-t"); el.setAttribute("aria-describedby", "sg-s"); el.dataset.testid = "story-gate";
  el.innerHTML =
    `<div class="sg-art" aria-hidden="true">${P ? `<picture><source media="(orientation: portrait)" srcset="${esc(P.portrait)}"><img alt="" src="${esc(P.landscape)}" decoding="async" fetchpriority="high"></picture>` : ""}</div>` +
    `<div class="sg-scrim" aria-hidden="true"></div>` +
    `<div class="sg-in">` +
      `<h1 class="sg-t" id="sg-t" data-g1="gate.title">${esc(title)}</h1>` +
      `<p class="sg-s" id="sg-s" data-g1="gate.sub">${esc(sub)}</p>` +
      `<div class="sg-c">` +
        `<button type="button" class="sg-b hold" data-g1="gate.hold" data-testid="gate-hold" aria-describedby="sg-hold-d">` +
          `<svg viewBox="0 0 26 26" aria-hidden="true"><circle class="sg-ring-bg" cx="13" cy="13" r="11"/><circle class="sg-ring" cx="13" cy="13" r="11"/><circle class="sg-dot" cx="13" cy="13" r="3.2"/></svg>` +
          `<span class="sg-l" data-nudge="Keep holding">${esc(holdL)}</span></button>` +
        `<button type="button" class="sg-b watch" data-g1="gate.watch" data-testid="gate-watch">` +
          `<svg viewBox="0 0 26 26" aria-hidden="true"><circle class="sg-ring-bg" cx="13" cy="13" r="11"/><path class="sg-tri" d="M10.5 8.4v9.2l7.6-4.6z"/></svg>` +
          `<span class="sg-l">${esc(watchL())}</span></button>` +
      `</div>` +
      `<span id="sg-hold-d" hidden>Press and hold, or hold Space. Enter starts at once.</span>` +
      `<div class="sg-k">` +
        `<button type="button" class="sg-a" data-g1="gate.skip" data-testid="gate-skip">${esc(fill(ui.skip_intro || "Skip intro", vars))}</button>` +
        `<button type="button" class="sg-a" data-g1="gate.text" data-testid="gate-text">${esc(fill(ui.read_as_text || "Read as text", vars))}</button>` +
      `</div>` +
      (credit ? `<p class="sg-cr" data-g1="gate.credit">${esc(credit)}</p>` : "") +
    `</div>`;
  host.appendChild(el);
  const img = el.querySelector(".sg-art img");
  if (!img) el.classList.add("no-poster"); else img.addEventListener("error", () => el.classList.add("no-poster"), {once: true});
  const holdB = el.querySelector(".sg-b.hold"), watchB = el.querySelector(".sg-b.watch");

  let isOpen = false, t0 = 0, raf = 0, via = null, done = false, nudgeT = 0;
  const setHold = x => holdB.style.setProperty("--hold", x.toFixed(3));
  function tick() {
    const x = holdProgress(win.performance.now() - t0); setHold(x);
    if (x >= 1) { finish(true); return; }
    raf = win.requestAnimationFrame(tick);
  }
  function start(how) {
    if (!isOpen || done || via) return;
    if (reduced()) { via = how; finish(how === "space" || how === "pointer"); return; }
    via = how; t0 = win.performance.now(); holdB.classList.add("holding"); holdB.classList.remove("nudge"); raf = win.requestAnimationFrame(tick);
  }
  function cancel() {
    if (!via || done) return;
    const short = win.performance.now() - t0 < HOLD_MS * 0.6;
    via = null; win.cancelAnimationFrame(raf); holdB.classList.remove("holding"); setHold(0);
    if (short) { holdB.classList.add("nudge"); win.clearTimeout(nudgeT); nudgeT = win.setTimeout(() => holdB.classList.remove("nudge"), 1600); }
  }
  function finish(holding) {
    if (done) return;
    done = true; win.cancelAnimationFrame(raf); setHold(1); el.classList.add("go");
    const how = via || "key"; via = null;
    opts.onRide && opts.onRide({via: how, holding: !!holding});
  }
  holdB.addEventListener("pointerdown", e => { if (e.button !== 0) return; e.preventDefault(); try { holdB.setPointerCapture(e.pointerId); } catch {} start("pointer"); });
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) holdB.addEventListener(t, cancel);
  holdB.addEventListener("contextmenu", e => e.preventDefault());
  holdB.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); via = "key"; finish(false); } });
  holdB.addEventListener("click", e => { if (e.detail === 0 && !done) { via = "key"; finish(false); } });   // keyboard/AT activation (no pointer)
  watchB.addEventListener("click", () => { if (isOpen && !done) { done = true; opts.onWatch && opts.onWatch(); } });
  el.querySelector('[data-testid="gate-skip"]').addEventListener("click", () => { if (isOpen && !done) { done = true; opts.onSkip && opts.onSkip(); } });
  el.querySelector('[data-testid="gate-text"]').addEventListener("click", () => { opts.onText && opts.onText(); });

  /* Space belongs to the gate while it is open: hold to ride from anywhere except the other buttons (where Space
     activates them, as a button should) */
  const onKey = e => {
    if (!isOpen || e.key !== " " && e.code !== "Space") return;
    const tgt = e.target, other = tgt && tgt.closest && tgt.closest(".sg-b.watch, .sg-a");
    if (other) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === "keydown" && !e.repeat) start("space");
    else if (e.type === "keyup") cancel();
  };
  win.addEventListener("keydown", onKey, true); win.addEventListener("keyup", onKey, true);

  const api = {
    el,
    open() {
      isOpen = true; done = false; via = null; setHold(0); el.hidden = false; el.classList.remove("out", "go");
      doc.documentElement.classList.add("gate-open");
      if (opts.autofocus !== false) win.setTimeout(() => { try { holdB.focus({preventScroll: true}); } catch {} }, 0);
      return api;
    },
    close({instant = false} = {}) {
      if (!isOpen) return api;
      isOpen = false; win.cancelAnimationFrame(raf); doc.documentElement.classList.remove("gate-open");
      // review2 perf_a11y L3: focus was on a gate button that is about to vanish; hand it to the stage (or opts.focusAfter)
      // instead of letting it drop to <body>. Only when focus is inside the gate or already lost, so an overlay that
      // took focus (Read as text) keeps it.
      const act = doc.activeElement;
      if (!act || act === doc.body || el.contains(act)) {
        const to = (typeof opts.focusAfter === "function" ? opts.focusAfter() : opts.focusAfter) || host;
        if (to && to.focus) {
          if (!to.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(to.tagName)) { to.setAttribute("tabindex", "-1"); to.dataset.gateFocus = ""; }
          try { to.focus({preventScroll: true}); } catch {}
        }
      }
      if (instant || reduced()) { el.hidden = true; return api; }
      el.classList.add("out"); win.setTimeout(() => { if (!isOpen) el.hidden = true; }, 650);
      return api;
    },
    isOpen: () => isOpen,
    liveReady() { el.classList.add("live"); return api; },
    setWatch(seconds) { const l = watchLabel(seconds); if (l) { vars.watch_len = l; watchB.querySelector(".sg-l").textContent = watchL(); } return api; },
    /* visible boxes for the overlap gate: [{id, x, y, w, h, text}] in CSS px */
    rects() {
      if (!isOpen || el.hidden) return [];
      return [...el.querySelectorAll("[data-g1]")].map(n => { const r = n.getBoundingClientRect();
        return {id: n.dataset.g1, x: r.left, y: r.top, w: r.width, h: r.height, text: true}; }).filter(r => r.w > 0 && r.h > 0);
    },
    destroy() { win.removeEventListener("keydown", onKey, true); win.removeEventListener("keyup", onKey, true); win.cancelAnimationFrame(raf);
      doc.documentElement.classList.remove("gate-open"); el.remove(); },
  };
  return api;
}
