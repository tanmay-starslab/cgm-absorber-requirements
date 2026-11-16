// "Try another sightline" (DESIGN_final §5.6; brief req. 5: pick another sightline or galaxy). A dialog on the modal layer.
// The story needs per-ray story data (U_data's story-data/2, listed in data/index.json); only staged rays can be shown.
// Every other galaxy and sightline of the sample lives in the explorer, so the picker ends with that hand-off instead of
// pretending. Rays the data marks ineligible are listed, disabled, with the reason (U_data's rule, e.g. no visible O VI).
// Tier A (DESIGN_tierA §7.2): index.picker "cases" adds a "Stories" group (gates.all entries, B0/B14 only, G12); a card
// reloads on ?story=<id>. Picker "off" renders exactly the v2 dialog.
//
// Pure: pickerModel(index, current, query) -> {groups: [{galaxy, label, rays: [{ray, label, eligible, reason, current}]}], n, shown}
//       casesModel(index, {current, story, atEnd, query}) -> {on, cards: [{id, title, blurb, current}]}
//       storyHref(galaxy, ray, base)      -> "?g=<id>&ray=<id>" (store.js grammar; the fragment keeps the moment)
//       caseHref(id, index)               -> "index.html?story=<id>" ("index.html" for the default story)
//       gateCards(index, story)           -> [{id, title, blurb, img, href}]: the gate's story row (all but the one showing)
// DOM:  createPicker(host, {onPick({galaxy, ray}), onStory(id)?, atEnd()?, explorerHref(galaxy) -> url, onClose}) -> {open(index, current, only), close, isOpen}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"}[c]));
/* a v1 entry or the hero tour ("full"); Tier A entries are cards, never beams */
const isBeam = s => !!s && (!s.case || s.case === "full");

/* index = data/index.json (schema story-index/1 or /2); current = {galaxy, ray}; query filters by galaxy id, label or ray id */
export function pickerModel(index, current = {}, query = "") {
  const stories = (index && Array.isArray(index.stories)) ? index.stories.filter(isBeam) : [];
  const q = String(query || "").trim().toLowerCase();
  const byG = new Map();
  let shown = 0;
  for (const s of stories) {
    const g = +s.galaxy, ray = String(s.ray || ""), label = s.label || `Subhalo ${g}`;
    if (q && !(`${g} ${label} ${ray}`.toLowerCase().includes(q))) continue;
    if (!byG.has(g)) byG.set(g, {galaxy: g, label, rays: []});
    byG.get(g).rays.push({ray, label: rayLabel(ray), eligible: s.eligible !== false, reason: s.eligible === false ? (s.reason || "story not available for this sightline") : null,
                          current: g === +current.galaxy && ray === String(current.ray || "")});
    shown++;
  }
  const groups = [...byG.values()].sort((a, b) => (b.rays.some(r => r.current) - a.rays.some(r => r.current)) || a.galaxy - b.galaxy);
  for (const gr of groups) gr.rays.sort((a, b) => (b.current - a.current) || (b.eligible - a.eligible) || a.ray.localeCompare(b.ray));
  return {groups, n: stories.length, shown};
}

/* card text (§7.2); an index entry's own title/blurb wins; subcase "lls" has its own card */
export const CARDS = {
  full: ["The full tour", "Every lesson on one rich sightline"],
  clean: ["A single cloud", "One cloud, one dip in every line"],
  multiphase: ["Cool and hot gas", "Two gases on one sightline, moving apart"],
  damped: ["A damped system", "So much hydrogen the dip grows wings"],
  lls: ["A Lyman-limit system", "Enough hydrogen to turn the dip black"],
  empty: ["An empty halo", "Almost nothing in the way, and that still counts"],
  hot: ["Hot gas, faint hydrogen", "Gas too hot for much hydrogen to show"]};
/* B14's next story (§5), listed after the one showing */
export const NEXT = {full: "clean", clean: "damped", multiphase: "clean", damped: "clean", empty: "hot", hot: "empty"};
const sid = s => (typeof s === "string" && /^[a-z][a-z0-9_]*$/.test(s) ? s : null);

export function casesModel(index, o = {}) {
  const list = index && index.picker === "cases" && Array.isArray(index.stories) ? index.stories : [];
  const listed = list.filter(s => s && sid(s.id) && s.gates && s.gates.all === true);
  if (!listed.length) return {on: false, cards: []};   // owner 2026-11-16: stories list whenever the picker opens, not only at B0/B14
  const cur = o.current || {};
  const here = sid(o.story) || (listed.find(s => s.case !== "full" && +s.galaxy === +cur.galaxy && String(s.ray) === String(cur.ray || "")) || {}).id ||
    sid(index.default_story) || "full";
  const q = String(o.query || "").trim().toLowerCase();
  const cards = [];
  for (const s of listed) {
    const c = CARDS[s.subcase === "lls" ? "lls" : s.id] || [s.label || s.id, ""];
    const card = {id: s.id, title: s.title || c[0], blurb: s.blurb || c[1], current: s.id === here, img: `img/poster_${+s.galaxy}_${s.ray}_card.webp`};
    if (q && !(`${card.title} ${card.blurb} ${s.galaxy} ${s.ray}`.toLowerCase().includes(q))) continue;
    cards.push(card);
  }
  const rank = c => (c.current ? 0 : c.id === NEXT[here] ? 1 : 2);
  cards.sort((a, b) => rank(a) - rank(b));
  return {on: true, cards};
}
/* the gate's story row (owner 2026-11-16): every listed story but the one showing, in the owner's order */
const ROW = ["full", "clean", "multiphase", "damped", "empty", "hot"];
export function gateCards(index, story) {
  const m = casesModel(index, {story: sid(story) || "full"});
  return m.cards.filter(c => !c.current).sort((a, b) => (ROW.indexOf(a.id) + 1 || 99) - (ROW.indexOf(b.id) + 1 || 99))
    .map(c => ({...c, href: caseHref(c.id, index)}));
}
export function caseHref(id, index) {
  const def = sid(index && index.default_story) || "full";
  return id === def && id === "full" ? "index.html" : `index.html?story=${encodeURIComponent(id)}`;
}

/* "rand_b062_a062" -> "impact 62 kpc, azimuth 62°" (the explorer's id grammar); anything else stays as the id */
export function rayLabel(ray) {
  const m = /^(?:rand|ray)?_?b(\d+)_a(\d+)/.exec(String(ray));
  return m ? `impact ${+m[1]} kpc, azimuth ${+m[2]}°` : String(ray);
}
export function storyHref(galaxy, ray, base = "") {
  return `${base}?g=${encodeURIComponent(galaxy)}&ray=${encodeURIComponent(ray)}`;
}

/* first or last beat (window.__story); no story API counts as an end */
function atEnds() {
  const S = typeof window !== "undefined" && window.__story;
  try { const b = S.beats(), id = S.state().beat.id; return id === b[0].id || id === b[b.length - 1].id; } catch (e) { return true; }
}

export function createPicker(host, hooks = {}) {
  const el = document.createElement("div");
  el.id = "picker"; el.className = "pk"; el.hidden = true; el.dataset.noscrub = "";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "pk-h");
  el.innerHTML = `<div class="pk-head"><h2 id="pk-h">Try another sightline</h2>` +
    `<button type="button" class="hud-btn pk-x" aria-label="Close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>` +
    `<label class="pk-s"><span class="vh">Find a story, galaxy or sightline</span><input type="search" placeholder="Story, galaxy or sightline" autocomplete="off" spellcheck="false"></label>` +
    `<div class="pk-list" role="listbox" aria-labelledby="pk-h" tabindex="-1"></div>` +
    `<p class="pk-foot"></p>`;
  host.appendChild(el);
  const input = el.querySelector("input"), list = el.querySelector(".pk-list"), foot = el.querySelector(".pk-foot");
  let index = null, current = {}, opener = null, atEnd = true, only = null;

  function render() {
    const m = pickerModel(index, current, input.value);
    const story = typeof location !== "undefined" ? new URLSearchParams(location.search).get("story") : null;
    const cm = only === "rays" ? {cards: []} : casesModel(index, {current, story, atEnd, query: input.value});
    const cases = cm.cards.length ? `<div class="pk-g pk-cs" role="group" aria-label="Stories"><div class="pk-gl" aria-hidden="true">Stories</div>` +
      cm.cards.map(c => `<div class="pk-o pk-c" role="option" tabindex="-1" data-story="${esc(c.id)}" aria-selected="${c.current}" aria-disabled="false">` +
        `<img class="pk-im" alt="" src="${esc(c.img)}" loading="lazy"><span class="pk-ct"><span class="pk-l">${esc(c.title)}</span><span class="pk-b">${esc(c.blurb)}</span></span>` +
        `${c.current ? `<span class="pk-t">showing now</span>` : ""}</div>`).join("") + "</div>" : "";
    list.innerHTML = (cases + (only === "stories" ? [] : m.groups).map(g => `<div class="pk-g" role="group" aria-label="${esc(g.label)}"><div class="pk-gl" aria-hidden="true" data-key="galaxy">${esc(g.label)}</div>` +
      g.rays.map(r => `<div class="pk-o" role="option" tabindex="-1" data-g="${g.galaxy}" data-ray="${esc(r.ray)}"` +
        ` aria-selected="${r.current}" aria-disabled="${!r.eligible}">` +
        `<span class="pk-l" data-key="ray">${esc(r.label)}</span>${r.current ? `<span class="pk-t">showing now</span>` : r.reason ? `<span class="pk-t">${esc(r.reason)}</span>` : ""}</div>`).join("") +
      "</div>").join("")) || `<p class="pk-none">Nothing matches.</p>`;
    const g = current.galaxy;
    foot.innerHTML = hooks.explorerHref ? `Every galaxy and sightline of the sample is in the <a href="${esc(hooks.explorerHref(g))}">explorer</a>; ` +
      `those with a story are listed here.` : "";
  }
  const options = () => [...list.querySelectorAll('.pk-o[aria-disabled="false"]')];
  function pick(o) {
    if (!o || o.getAttribute("aria-disabled") === "true") return;
    if (o.dataset.story) {
      const id = o.dataset.story;
      close(); if (o.getAttribute("aria-selected") === "true") return;
      (hooks.onStory || (s => { location.href = caseHref(s, index); }))(id);
      return;
    }
    const sel = {galaxy: +o.dataset.g, ray: o.dataset.ray};
    if (sel.galaxy === +current.galaxy && sel.ray === String(current.ray)) { close(); return; }
    close(); hooks.onPick && hooks.onPick(sel);
  }
  /* only: "stories" (the end card's Try another story), "rays", or null for both */
  function open(idx, cur = {}, o = null) {
    index = idx; current = cur || {}; opener = document.activeElement; input.value = ""; only = o;
    atEnd = !(idx && idx.picker === "cases") || o === "stories" || (hooks.atEnd ? !!hooks.atEnd() : atEnds());
    el.querySelector("h2").textContent = o === "stories" ? "Try another story" : "Try another sightline";
    render();
    el.hidden = false; input.focus();
  }
  function close() {
    if (el.hidden) return;
    el.hidden = true; if (opener && opener.focus) opener.focus(); hooks.onClose && hooks.onClose();
  }
  input.addEventListener("input", render);
  list.addEventListener("click", e => pick(e.target.closest(".pk-o")));
  el.querySelector(".pk-x").addEventListener("click", close);
  el.addEventListener("keydown", e => {
    const os = options(), i = os.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (os[i + 1] || os[0] || input).focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (i > 0 ? os[i - 1] : input).focus(); }
    else if (e.key === "Enter" && i >= 0) { e.preventDefault(); pick(os[i]); }
    e.stopPropagation();                       // the story's keys never fire while the dialog is open
  });
  document.addEventListener("pointerdown", e => { if (!el.hidden && !el.contains(e.target)) close(); });
  return {open, close, get isOpen() { return !el.hidden; }, el};
}
