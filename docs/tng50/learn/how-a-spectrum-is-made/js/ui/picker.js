// "Try another beam" (DESIGN_final §5.6; brief req. 5: pick another sightline or galaxy). A dialog on the modal layer.
// The story needs per-ray story data (U_data's story-data/2, listed in data/index.json); only staged rays can be shown.
// Every other galaxy and sightline of the sample lives in the explorer, so the picker ends with that hand-off instead of
// pretending. Rays the data marks ineligible are listed, disabled, with the reason (U_data's rule, e.g. no visible O VI).
//
// Pure: pickerModel(index, current, query) -> {groups: [{galaxy, label, rays: [{ray, label, eligible, reason, current}]}], n, shown}
//       storyHref(galaxy, ray, base)      -> "?g=<id>&ray=<id>" (store.js grammar; the fragment keeps the moment)
// DOM:  createPicker(host, {onPick({galaxy, ray}), explorerHref(galaxy) -> url, onClose}) -> {open(index, current), close, isOpen}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"}[c]));

/* index = data/index.json (schema story-index/1); current = {galaxy, ray}; query filters by galaxy id, label or ray id */
export function pickerModel(index, current = {}, query = "") {
  const stories = (index && Array.isArray(index.stories)) ? index.stories : [];
  const q = String(query || "").trim().toLowerCase();
  const byG = new Map();
  let shown = 0;
  for (const s of stories) {
    const g = +s.galaxy, ray = String(s.ray || ""), label = s.label || `Subhalo ${g}`;
    if (q && !(`${g} ${label} ${ray}`.toLowerCase().includes(q))) continue;
    if (!byG.has(g)) byG.set(g, {galaxy: g, label, rays: []});
    byG.get(g).rays.push({ray, label: rayLabel(ray), eligible: s.eligible !== false, reason: s.eligible === false ? (s.reason || "story not available for this beam") : null,
                          current: g === +current.galaxy && ray === String(current.ray || "")});
    shown++;
  }
  const groups = [...byG.values()].sort((a, b) => (b.rays.some(r => r.current) - a.rays.some(r => r.current)) || a.galaxy - b.galaxy);
  for (const gr of groups) gr.rays.sort((a, b) => (b.current - a.current) || (b.eligible - a.eligible) || a.ray.localeCompare(b.ray));
  return {groups, n: stories.length, shown};
}

/* "rand_b062_a062" -> "impact 62 kpc, azimuth 62°" (the explorer's id grammar); anything else stays as the id */
export function rayLabel(ray) {
  const m = /^(?:rand|ray)?_?b(\d+)_a(\d+)/.exec(String(ray));
  return m ? `impact ${+m[1]} kpc, azimuth ${+m[2]}°` : String(ray);
}
export function storyHref(galaxy, ray, base = "") {
  return `${base}?g=${encodeURIComponent(galaxy)}&ray=${encodeURIComponent(ray)}`;
}

export function createPicker(host, hooks = {}) {
  const el = document.createElement("div");
  el.id = "picker"; el.className = "pk"; el.hidden = true; el.dataset.noscrub = "";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "pk-h");
  el.innerHTML = `<div class="pk-head"><h2 id="pk-h">Try another beam</h2>` +
    `<button type="button" class="hud-btn pk-x" aria-label="Close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>` +
    `<label class="pk-s"><span class="vh">Find a galaxy or beam</span><input type="search" placeholder="Galaxy or beam" autocomplete="off" spellcheck="false"></label>` +
    `<div class="pk-list" role="listbox" aria-labelledby="pk-h" tabindex="-1"></div>` +
    `<p class="pk-foot"></p>`;
  host.appendChild(el);
  const input = el.querySelector("input"), list = el.querySelector(".pk-list"), foot = el.querySelector(".pk-foot");
  let index = null, current = {}, opener = null;

  function render() {
    const m = pickerModel(index, current, input.value);
    list.innerHTML = m.groups.map(g => `<div class="pk-g" role="group" aria-label="${esc(g.label)}"><div class="pk-gl" aria-hidden="true" data-key="galaxy">${esc(g.label)}</div>` +
      g.rays.map(r => `<div class="pk-o" role="option" tabindex="-1" data-g="${g.galaxy}" data-ray="${esc(r.ray)}"` +
        ` aria-selected="${r.current}" aria-disabled="${!r.eligible}">` +
        `<span class="pk-l" data-key="ray">${esc(r.label)}</span>${r.current ? `<span class="pk-t">showing now</span>` : r.reason ? `<span class="pk-t">${esc(r.reason)}</span>` : ""}</div>`).join("") +
      "</div>").join("") || `<p class="pk-none">No staged beam matches.</p>`;
    const g = current.galaxy;
    foot.innerHTML = hooks.explorerHref ? `Every galaxy and sightline of the sample is in the <a href="${esc(hooks.explorerHref(g))}">explorer</a>; ` +
      `beams with a story are listed here.` : "";
  }
  const options = () => [...list.querySelectorAll('.pk-o[aria-disabled="false"]')];
  function pick(o) {
    if (!o || o.getAttribute("aria-disabled") === "true") return;
    const sel = {galaxy: +o.dataset.g, ray: o.dataset.ray};
    if (sel.galaxy === +current.galaxy && sel.ray === String(current.ray)) { close(); return; }
    close(); hooks.onPick && hooks.onPick(sel);
  }
  function open(idx, cur = {}) {
    index = idx; current = cur || {}; opener = document.activeElement; input.value = ""; render();
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
