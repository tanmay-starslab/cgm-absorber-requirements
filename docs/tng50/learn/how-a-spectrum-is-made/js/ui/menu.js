// The one menu (DESIGN_final §1.3 P1-3): Explore, Physics, Read as text, Try another beam, Watch, Share, Keys.
// A 44 px icon button in the HUD (in the rail in phone landscape) opening a sheet on the modal layer (z 60). Esc or a click
// outside closes it and returns focus to the button. Each entry calls a hook; entries without a hook are not shown.
//
// Keys (DESIGN §9.3): U_motion's bindInput owns Space-hold, arrows, Shift+arrows, PageUp/PageDown, Home/End; the shell
// claims the rest through bindInput({onKey}) with keyAction (pure): ? help, F formula trail, T colour preset, R / N focus
// the sliders, G grab the camera, M music on/off, Esc release, Space = play/pause while Watch runs.
//
// Pure: KEYMAP, keyAction(e, state). DOM: createMenu(button, sheet, hooks), createKeyHelp(host, {onClose}),
// createCredits(host, {galaxy, onClose}) (Data and credits: Simulation, Spectra, Music, Code; creditSections(galaxy)).

export const ENTRIES = Object.freeze([
  {id: "watch", label: "Watch the flight", hint: null},          // length comes from hooks.watchHint() (the beats' Watch schedule)
  {id: "explore", label: "Explore this beam", hint: "your controls, same galaxy"},
  {id: "picker", label: "Try another beam", hint: "any galaxy of the sample"},
  {id: "physics", label: "Science details", hint: "numbers, equations and caveats", toggle: true},
  {id: "text", label: "Read as text", hint: "the whole story, no motion"},
  {id: "share", label: "Copy link to this moment"},
  {id: "keys", label: "Keys and help"},
  {id: "credits", label: "Data and credits"},
  {id: "explorer", label: "Back to the explorer", href: true},
]);

export function createMenu(button, sheet, hooks = {}) {
  button.setAttribute("aria-haspopup", "true"); button.setAttribute("aria-expanded", "false");
  sheet.setAttribute("role", "menu"); sheet.hidden = true; sheet.dataset.noscrub = "";
  const list = ENTRIES.filter(e => hooks[e.id] || (e.href && hooks.explorerHref));
  const hintOf = e => (e.id === "watch" && hooks.watchHint ? hooks.watchHint() : e.hint);
  sheet.innerHTML = list.map(e => e.href
    ? `<a class="mn-i" role="menuitem" href="${hooks.explorerHref()}" data-id="${e.id}"><span class="mn-l">${e.label}</span></a>`
    : `<button class="mn-i" role="${e.toggle ? "menuitemcheckbox" : "menuitem"}" type="button" data-id="${e.id}"${e.toggle ? ' aria-checked="false"' : ""}>` +
      `<span class="mn-l">${e.label}</span>${hintOf(e) ? `<span class="mn-h" data-num>${hintOf(e)}</span>` : ""}</button>`).join("");
  const items = () => [...sheet.querySelectorAll(".mn-i")];
  let open = false;
  function set(o) {
    open = o; sheet.hidden = !o; button.setAttribute("aria-expanded", String(o));
    if (o) { const ex = hooks.explorerHref && sheet.querySelector('[data-id="explorer"]'); if (ex) ex.href = hooks.explorerHref();
             (items()[0] || sheet).focus(); hooks.onOpen && hooks.onOpen(); }
    else hooks.onClose && hooks.onClose();
  }
  button.addEventListener("click", e => { e.stopPropagation(); set(!open); });
  sheet.addEventListener("click", e => {
    const it = e.target.closest(".mn-i"); if (!it) return;
    const id = it.dataset.id, entry = ENTRIES.find(x => x.id === id);
    if (entry && entry.toggle) { const on = it.getAttribute("aria-checked") !== "true"; it.setAttribute("aria-checked", String(on)); hooks[id](on); return; }
    if (!entry.href) { e.preventDefault(); set(false); button.focus(); hooks[id](); }
  });
  sheet.addEventListener("keydown", e => {
    const its = items(), i = its.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set(false); button.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); its[(i + 1) % its.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); its[(i - 1 + its.length) % its.length].focus(); }
    else if (e.key === "Tab") { set(false); }
    e.stopPropagation();
  });
  document.addEventListener("pointerdown", e => { if (open && !sheet.contains(e.target) && !button.contains(e.target)) set(false); });
  return {
    get open() { return open; }, set,
    setChecked(id, on) { const it = sheet.querySelector(`[data-id="${id}"]`); if (it) it.setAttribute("aria-checked", String(!!on)); },
  };
}

/* ---------------------------------------------------------------- keys */
/* the key help rows (all keys of the story, whichever module handles them) */
export const KEYMAP = Object.freeze([
  {keys: ["Space"], what: "hold to fly; in Watch, play or pause"},
  {keys: ["←", "→"], what: "move along the beam"},
  {keys: ["Shift", "←", "→"], what: "previous or next cell stop"},
  {keys: ["Page Up", "Page Down"], what: "previous or next moment"},
  {keys: ["Home", "End"], what: "start or end"},
  {keys: ["G"], what: "grab the camera; Esc lets go"},
  {keys: ["F"], what: "formulas seen so far"},
  {keys: ["T"], what: "next colour preset"},
  {keys: ["R"], what: "resolution slider"},
  {keys: ["N"], what: "noise (S/N) slider"},
  {keys: ["?"], what: "this help"},
]);
const SHELL_KEYS = {"?": "help", f: "trail", t: "tf", r: "focusR", n: "focusSN", g: "grab", m: "music"};
/* keydown -> {action, claim} | null. claim = the clock must not see the key. Never acts on modified keys or while typing
   in a field; letters are ignored on sliders' own keys only where they collide (none do). Pure. */
export function keyAction(e, state = {}) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target, tag = t && t.tagName ? t.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) return null;
  if ((e.key === " " || e.key === "Spacebar") && state.watch) return e.repeat ? {action: null, claim: true} : {action: "watchToggle", claim: true};
  if (e.key === "Escape") return state.grab ? {action: "release", claim: true} : null;
  const a = SHELL_KEYS[e.key === "?" ? "?" : String(e.key || "").toLowerCase()];
  return a && !e.repeat ? {action: a, claim: true} : null;
}

/* key help dialog on the modal layer: Esc, the close button or a click outside closes it; focus returns to the opener */
export function createKeyHelp(host, opts = {}) {
  const el = document.createElement("div");
  el.id = "key-help"; el.className = "kh"; el.hidden = true; el.dataset.noscrub = "";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "kh-h");
  el.innerHTML = `<div class="kh-head"><h2 id="kh-h">Keys</h2><button type="button" class="hud-btn kh-x" aria-label="Close">` +
    `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div><dl>` +
    KEYMAP.map(r => `<dt>${r.keys.map(k => `<kbd>${k}</kbd>`).join(" ")}</dt><dd>${r.what}</dd>`).join("") + "</dl>";
  host.appendChild(el);
  let opener = null;
  const close = () => { if (el.hidden) return; el.hidden = true; if (opener && opener.focus) opener.focus(); opts.onClose && opts.onClose(); };
  const open = () => { opener = document.activeElement; el.hidden = false; el.querySelector(".kh-x").focus(); };
  el.querySelector(".kh-x").addEventListener("click", close);
  el.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { e.preventDefault(); el.querySelector(".kh-x").focus(); }   // one control: focus stays inside
    e.stopPropagation();
  });
  document.addEventListener("pointerdown", e => { if (!el.hidden && !el.contains(e.target)) close(); });
  return {open, close, get isOpen() { return !el.hidden; }, el};
}

/* ---------------------------------------------------------------- data and credits */
/* the Data and credits dialog on the modal layer (same pattern as the key help): Esc, the close button or a click outside
   closes it and focus returns to the opener; Tab cycles through its links and the close button */
const A = (href, t) => `<a href="${href}" target="_blank" rel="noopener">${t}</a>`;
/* sections: [{h, p: [html | {cls, t}]}]; the story's spectra are always cast with Trident (export_story_data.py, any host) */
export function creditSections(galaxy) {
  const beam = galaxy != null ? `This story's beam through subhalo ${galaxy}` : "This story's beam";
  return [
    {h: "Simulation", p: [
      `IllustrisTNG, TNG50-1 at z = 0 (snapshot 99), from the ${A("https://www.tng-project.org/data/", "TNG public data release")} (free, registration required). ` +
      `The simulation is described in Nelson et al. 2019a (${A("https://arxiv.org/abs/1812.05609", "Computational Astrophysics and Cosmology 6, 2")}), ` +
      `Nelson et al. 2019b (${A("https://arxiv.org/abs/1902.05554", "MNRAS 490, 3234")}) and Pillepich et al. 2019 (${A("https://arxiv.org/abs/1902.05553", "MNRAS 490, 3196")}).`,
      "The TNG team makes these data free to use and asks that any work using them cites those three papers. This site follows that request; the TNG data stay under the TNG team's terms.",
      {cls: "cr-ack", t: "The IllustrisTNG simulations were undertaken with compute time awarded by the Gauss Centre for Supercomputing (GCS) under GCS " +
        "Large-Scale Projects GCS-ILLU and GCS-DWAR on the GCS share of the supercomputer Hazel Hen at the High Performance Computing Center " +
        "Stuttgart (HLRS), as well as on the machines of the Max Planck Computing and Data Facility (MPCDF) in Garching, Germany."}]},
    {h: "Spectra", p: [
      `${beam}: Trident (Hummels, Smith &amp; Silvia 2017) on yt (Turk et al. 2011) with the HM2012 UV background (Haardt &amp; Madau 2012); ` +
      "the 3D ion cubes use the same Trident HM2012 tables.",
      "The explorer's 198 Milky Way and M31 analogues: the SBI_CGM fiducial ray library, with rays through the TNG50 Voronoi mesh traced by THOR " +
      `(Byrohl &amp; Nelson 2025, ${A("https://arxiv.org/abs/2507.11603", "arXiv:2507.11603")}), ion fractions from CLOUDY (Ferland et al. 2017) with the FG11 UV background ` +
      "(Faucher-Giguère et al. 2009) and Rahmati et al. (2013) H I self-shielding."]},
    {h: "Music", p: [
      "Beethoven, Symphony No. 7 in A major, Op. 92, II. Allegretto (orchestral recording); excerpted, faded and looped."]},
    {h: "Code", p: [
      `MIT, ${A("https://github.com/tanmay-starslab/cgm-absorber-requirements", "github.com/tanmay-starslab/cgm-absorber-requirements")}; ` +
      `third-party licences: ${A("https://github.com/tanmay-starslab/cgm-absorber-requirements/blob/main/THIRD_PARTY_LICENSES", "THIRD_PARTY_LICENSES")}`]},
  ];
}
export function createCredits(host, opts = {}) {
  const el = document.createElement("div");
  el.id = "credits"; el.className = "kh cr"; el.hidden = true; el.dataset.noscrub = "";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "cr-h");
  el.innerHTML = `<div class="kh-head"><h2 id="cr-h">Data and credits</h2><button type="button" class="hud-btn kh-x" aria-label="Close">` +
    `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>` +
    creditSections(opts.galaxy).map(s => `<section><h3>${s.h}</h3>` + s.p.map(x => (typeof x === "string" ? `<p>${x}</p>` : `<p class="${x.cls}">${x.t}</p>`)).join("") + "</section>").join("");
  host.appendChild(el);
  let opener = null;
  const close = () => { if (el.hidden) return; el.hidden = true; if (opener && opener.focus) opener.focus(); opts.onClose && opts.onClose(); };
  const open = op => { opener = op && op.focus ? op : document.activeElement; el.hidden = false; el.scrollTop = 0; el.querySelector(".kh-x").focus(); };
  const focusables = () => [...el.querySelectorAll("button, a[href]")];
  el.querySelector(".kh-x").addEventListener("click", close);
  el.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { const f = focusables(), i = f.indexOf(document.activeElement);   // focus stays inside
      e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); }
    e.stopPropagation();
  });
  document.addEventListener("pointerdown", e => { if (!el.hidden && !el.contains(e.target) && !(opener && opener.contains && opener.contains(e.target))) close(); });
  return {open, close, get isOpen() { return !el.hidden; }, el};
}
