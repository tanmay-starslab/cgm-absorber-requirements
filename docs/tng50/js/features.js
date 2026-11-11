// Small page features of the TNG50 explorer (UX round 4, spec section C). Every feature uses data the page has already
// loaded; each new control carries a one-line data-tip (tips.js). app.js passes a context object (initFeatures(ctx)).
//   1 copy a link to the current view (#share, key l): the URL hash already holds the whole state
//   2 keyboard shortcuts overlay (#keys-open, key ?): a popover listing every key of the page and the 3D view
//   3 random sightline (#rand, key d): from the gallery's current filter, never the selected one
//   4 undo and redo of instrument changes (#undo, #redo; u and shift U, ctrl or cmd Z and shift Z): lines, layout, R,
//     S/N, velocity window, overlays; coalesced so a slider drag is one step
//   5 solo a line: shift-click a line chip shows only that line (undo brings the others back)
//   6 CSV export (Save menu #dlcsv, #dlfit): the degraded spectra in the plotted window, and the fitted components
//   7 loading feedback: a thin running bar on the spectra while a sightline loads
// The pure parts (createHistory, keyAction, pickRandom, csvCell, spectraCSV, fitCSV) need no DOM and are node-tested in
// tests/js/features_unit.mjs.

/* ---------------- pure parts ---------------- */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* linear undo history of snapshots: reset(s) starts it, push(s) records a new state (ignored when it equals the current
   one, so re-applying an undone state never adds a step), undo() and redo() return the snapshot to apply or null */
export function createHistory({limit = 60, eq = same} = {}) {
  let list = [], i = -1;
  return {
    reset(s) { list = s === undefined ? [] : [s]; i = list.length - 1; },
    push(s) { if (i >= 0 && eq(list[i], s)) return false;
      list = list.slice(0, i + 1); list.push(s); if (list.length > limit) list.shift(); i = list.length - 1; return true; },
    undo() { if (i <= 0) return null; i--; return list[i]; },
    redo() { if (i >= list.length - 1) return null; i++; return list[i]; },
    get canUndo() { return i > 0; }, get canRedo() { return i < list.length - 1; },
    get current() { return i >= 0 ? list[i] : null; }, get size() { return list.length; }
  };
}

/* the action of a key press, or null. where: "text" (a text field, select or the chat: nothing), "3d" (the 3D canvas,
   which owns its letter keys: only ? passes), anything else is the page */
export function keyAction(ev, where = "page") {
  if (!ev || ev.isComposing || where === "text") return null;
  const k = ev.key, mod = ev.ctrlKey || ev.metaKey;
  if (mod && !ev.altKey) {
    if (where === "3d") return null;
    if (k === "z" || k === "Z") return ev.shiftKey ? "redo" : "undo";
    if ((k === "y" || k === "Y") && ev.ctrlKey && !ev.shiftKey) return "redo";
    return null;
  }
  if (ev.altKey || ev.ctrlKey || ev.metaKey) return null;
  if (k === "?") return "help";
  if (where === "3d") return null;
  return {u: "undo", U: "redo", d: "random", l: "link", "1": "tab-spectra", "2": "tab-3d"}[k] || null;
}

/* a random id from list (entries with .id), avoiding current when there is any other choice; rnd() in [0, 1) */
export function pickRandom(list, current, rnd = Math.random) {
  const ids = (list || []).map(e => e && e.id).filter(Boolean), pool = ids.length > 1 ? ids.filter(id => id !== current) : ids;
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
}

/* one CSV cell: numbers with a fixed number of decimals (empty when not finite), text quoted when it needs it */
export function csvCell(x, d) {
  if (typeof x === "number") return Number.isFinite(x) ? (d == null ? String(x) : x.toFixed(d)) : "";
  if (x == null) return "";
  const s = String(x); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const head = meta => Object.entries(meta || {}).filter(([, v]) => v != null && v !== "").map(([k, v]) => `# ${k}: ${String(v).replace(/[\r\n]+/g, " ")}`);

/* long-format CSV of the degraded spectra: one row per pixel inside [v0, v1] for each panel
   panels: [{ion, label, ci, R, sn, seed, v, flux, sigma (number or array), model}] */
export function spectraCSV({meta, panels, v0 = -Infinity, v1 = Infinity}) {
  const out = head(meta); out.push("ion,case,R,snr,seed,v_kms,flux,sigma,model");
  for (const p of panels || []) { if (!p || !p.v) continue;
    const sg = i => (typeof p.sigma === "number" ? p.sigma : p.sigma ? p.sigma[i] : NaN);
    for (let i = 0; i < p.v.length; i++) { const v = p.v[i]; if (v < v0 || v > v1) continue;
      out.push([csvCell(p.label || p.ion), p.ci, p.R, p.sn, p.seed, csvCell(v, 2), csvCell(p.flux[i], 5), csvCell(sg(i), 5), csvCell(p.model ? p.model[i] : NaN, 5)].join(",")); } }
  return out.join("\n") + "\n";
}

/* CSV of the fitted components: one row per component. comps: [{v, dv, logN, dlogN, b, db, limit, lo, tags}] where a
   lower limit (saturated) gives logN_lower = lo and no errors */
export function fitCSV({meta, panels}) {
  const out = head(meta); out.push("ion,case,R,snr,v_kms,dv_kms,logN,dlogN,logN_lower,b_kms,db_kms,flags");
  for (const p of panels || []) for (const c of (p && p.comps) || []) {
    const lim = !!c.limit;
    out.push([csvCell(p.label || p.ion), p.ci, p.R, p.sn, csvCell(c.v, 1), csvCell(lim ? NaN : c.dv, 1), csvCell(lim ? NaN : c.logN, 2),
      csvCell(lim ? NaN : c.dlogN, 2), csvCell(lim ? c.lo : NaN, 2), csvCell(c.b, 1), csvCell(lim ? NaN : c.db, 1), csvCell((c.tags || []).join(" "))].join(","));
  }
  return out.join("\n") + "\n";
}

/* ---------------- page wiring ---------------- */
const ICON = {
  share: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6.6 9.4 9.4 6.6"/><path d="M7.4 4.6 8.6 3.4a2.6 2.6 0 0 1 3.7 3.7l-1.2 1.2M8.6 11.4l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2"/></svg>',
  keys: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="1.8" y="4" width="12.4" height="8" rx="1.8"/><path d="M4.3 6.6h.1M6.8 6.6h.1M9.3 6.6h.1M11.7 6.6h.1M5 9.4h6"/></svg>',
  dice: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2.4"/><circle cx="5.6" cy="5.6" r=".9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="10.4" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/></svg>',
  undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/></svg>',
  redo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10.5 3.5 3 3-3 3"/><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9"/></svg>'
};
const KEYS = [
  ["Page", [["j k", "next, previous sightline"], ["d", "random sightline"], ["1 2", "Spectra, 3D"], ["u", "undo instrument change"],
    ["shift U", "redo"], ["l", "copy a link to this view"], ["?", "this list"], ["Esc", "close"]]],
  ["Spectra", [["← →", "pan"], ["+ −", "zoom"], ["Home", "reset the window"], ["shift click", "a line chip shows only it"]]],
  ["3D", [["drag", "orbit"], ["double-click", "orbit around that point"], ["c", "back to the galaxy centre"], ["f e a r", "face, edge, sightline, reset"],
    ["m", "integral or volume"], ["s g", "stars, guides"], ["p", "pick a ray"], ["shift F", "fullscreen"]]]
];
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const btn = (cls, id, label, tip, html) => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.id = id;
  b.setAttribute("aria-label", label); b.dataset.tip = tip; b.innerHTML = html; return b; };

/* ctx: {S, ION, note(t, cls), save(blob, name), writeHash(), openPop(btn, pop), closePops(), showTab(t), select(id),
   pool() -> entries of the gallery's current list, loaded(id), failed(id), panels() -> [{ion, ci}], data(ion, ci),
   fit(ion, ci), quality(c, ion, r, d), caseRS(ion, ci), entry(id), setIons(list), getSnap(), applySnap(s)} */
export function initFeatures(ctx) {
  const $ = s => document.querySelector(s);
  const F = {};

  /* 1 copy link */
  async function copyLink() {
    try { ctx.writeHash(); } catch { /* hash written later */ }
    const url = location.href;
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(url); ok = true; } } catch { ok = false; }
    if (!ok) { const ta = document.createElement("textarea"); ta.value = url; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta); ta.select(); try { ok = document.execCommand("copy"); } catch { ok = false; } ta.remove(); }
    ctx.note(ok ? "link to this view copied" : "copy failed; the address bar holds the link", ok ? "good" : "bad");
    const b = $("#share"); if (b && ok) { b.classList.add("done"); setTimeout(() => b.classList.remove("done"), 1200); }
    return ok;
  }
  const icons = $("#top .icons"), theme = $("#theme");
  const share = btn("ib hide-m", "share", "Copy a link to this view", "Copy a link to this exact view (l)", ICON.share);
  share.addEventListener("click", copyLink);

  /* 2 shortcuts overlay */
  const keysBtn = btn("ib hide-m", "keys-open", "Keyboard shortcuts", "Keyboard shortcuts (?)", ICON.keys);
  keysBtn.setAttribute("aria-haspopup", "dialog"); keysBtn.setAttribute("aria-controls", "keys-pop"); keysBtn.setAttribute("aria-expanded", "false");
  const pop = document.createElement("div"); pop.className = "pop"; pop.id = "keys-pop"; pop.hidden = true;
  pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Keyboard shortcuts");
  pop.innerHTML = "<h3>Keys</h3>" + KEYS.map(([g, rows]) => `<div class="kgrp"><span class="kg">${esc(g)}</span><dl>` +
    rows.map(([k, t]) => `<dt>${k.split(" ").map(x => `<kbd>${esc(x)}</kbd>`).join("")}</dt><dd>${esc(t)}</dd>`).join("") + "</dl></div>").join("");
  document.body.appendChild(pop);
  const toggleKeys = () => { if (pop.hidden) ctx.openPop(keysBtn, pop); else ctx.closePops(); };
  keysBtn.addEventListener("click", ev => { ev.stopPropagation(); toggleKeys(); });
  if (icons) { icons.insertBefore(share, theme && theme.parentNode === icons ? theme : icons.firstChild); icons.insertBefore(keysBtn, share); }

  /* 3 random sightline */
  const next = $("#next"), rand = btn("pbtn sq", "rand", "Random sightline", "Jump to a random sightline from the list (d)", ICON.dice);
  function random() { const id = pickRandom(ctx.pool(), ctx.S.id); if (id) ctx.select(id); return id; }
  rand.addEventListener("click", random);
  if (next) next.after(rand);

  /* 4 undo and redo */
  const H = createHistory();
  const inst = $("#h-inst"), undoB = btn("ib sm", "undo", "Undo instrument change", "Undo the last instrument or line change (u)", ICON.undo),
    redoB = btn("ib sm", "redo", "Redo instrument change", "Redo the change you undid (shift U)", ICON.redo);
  if (inst) { const hd = document.createElement("div"); hd.className = "hd"; inst.parentNode.insertBefore(hd, inst); hd.appendChild(inst);
    const g = document.createElement("span"); g.className = "undo"; g.append(undoB, redoB); hd.appendChild(g); }
  const syncUndo = () => { undoB.disabled = !H.canUndo; redoB.disabled = !H.canRedo; };
  let pushT = 0;
  const record = () => { clearTimeout(pushT); pushT = setTimeout(() => { H.push(ctx.getSnap()); syncUndo(); }, 500); };
  function undo() { clearTimeout(pushT); H.push(ctx.getSnap()); const s = H.undo(); if (s) { ctx.applySnap(s); ctx.note("undone"); } syncUndo(); return !!s; }
  function redo() { clearTimeout(pushT); const s = H.redo(); if (s) { ctx.applySnap(s); ctx.note("redone"); } syncUndo(); return !!s; }
  undoB.addEventListener("click", undo); redoB.addEventListener("click", redo);
  addEventListener("tng:instrument", record);
  const intr = $("#intr"); if (intr) intr.addEventListener("change", record);
  addEventListener("tng:ready", () => { H.reset(ctx.getSnap()); syncUndo(); });
  H.reset(ctx.getSnap()); syncUndo();

  /* 5 solo a line: shift-click a chip (capture, before the chip's own remove handler) */
  const chips = $("#ion-chips");
  if (chips) chips.addEventListener("click", ev => { const b = ev.target.closest("button[data-ion]"); if (!b || !ev.shiftKey) return;
    ev.preventDefault(); ev.stopImmediatePropagation(); if (ctx.S.ions.length > 1) { ctx.setIons([b.dataset.ion]); ctx.note(`only ${ctx.ION[b.dataset.ion]?.label || b.dataset.ion}; u brings the others back`); } }, true);

  /* 6 CSV export from the Save menu */
  const menu = $("#dl-menu");
  const item = (id, label, tip) => { const b = document.createElement("button"); b.type = "button"; b.id = id; b.setAttribute("role", "menuitem"); b.textContent = label; b.dataset.tip = tip; return b; };
  const csvB = item("dlcsv", "Spectra CSV", "Degraded spectra in the plotted window, one row per pixel");
  const fitB = item("dlfit", "Fit components CSV", "Fitted components of every panel; needs Fitted components on");
  /* phones: the top bar has no room for the link button, so the Save menu carries it (hidden on wider screens, page.css) */
  const linkB = item("dllink", "Copy link", "Copy a link to this exact view");
  linkB.addEventListener("click", () => { ctx.closePops(); copyLink(); });
  if (menu) menu.append(csvB, fitB, linkB);
  const label = k => ctx.ION[k]?.label || k;
  function meta(extra) { const S = ctx.S, e = ctx.entry(S.id) || {};
    const geo = e.orientation === "custom" || e.kind === "endpoints" ? `custom ray, L ${Math.round(+e.length_kpc || 0)} kpc, b ${e.b_kpc} kpc`
      : `${e.orientation || ""}, b ${e.b_kpc} kpc, azimuth ${e.azimuth_deg} deg${e.seed != null ? `, seed ${e.seed}` : ""}`;
    return Object.assign({source: "TNG50 sightlines explorer", sightline: S.id, geometry: geo, view: location.href}, extra); }
  const fname = (S, what) => `tng50_${S.id}_${S.ions.join("-")}_${what}.csv`;
  function exportSpectra() { const S = ctx.S; ctx.closePops(); if (!S.id || !ctx.loaded(S.id)) { ctx.note("the sightline is still loading", "bad"); return null; }
    const panels = ctx.panels().map(p => { const d = ctx.data(p.ion, p.ci); if (!d) return null; const [R, sn] = ctx.caseRS(p.ion, p.ci);
      return {ion: p.ion, label: label(p.ion), ci: p.ci, R, sn, seed: d.seed, v: d.v, flux: d.flux, sigma: d.sigma, model: d.model}; }).filter(Boolean);
    const v0 = S.vc - S.vhw, v1 = S.vc + S.vhw;
    const txt = spectraCSV({meta: meta({window_kms: `${Math.round(v0)} to ${Math.round(v1)}`, units: "v in km/s from systemic; flux normalised; sigma per pixel"}), panels, v0, v1});
    ctx.save(new Blob([txt], {type: "text/csv"}), fname(S, "spectra")); ctx.note("spectra saved as CSV", "good"); return txt; }
  function exportFits() { const S = ctx.S; ctx.closePops();
    if (!S.fit) { ctx.note("turn on Fitted components first", "bad"); return null; }
    const panels = ctx.panels().map(p => { const r = ctx.fit(p.ion, p.ci), d = ctx.data(p.ion, p.ci), [R, sn] = ctx.caseRS(p.ion, p.ci);
      const comps = (r && r.comps || []).map(c => { const q = ctx.quality(c, p.ion, r, d) || {}; return {...c, limit: !!q.limit, lo: q.lo, tags: q.tags || []}; });
      return {ion: p.ion, label: label(p.ion), ci: p.ci, R, sn, comps, done: !!r}; });
    if (panels.some(p => !p.done)) { ctx.note("the fits are still running", "bad"); return null; }
    const txt = fitCSV({meta: meta({units: "v, b in km/s; N in cm^-2; logN_lower for saturated components"}), panels});
    ctx.save(new Blob([txt], {type: "text/csv"}), fname(S, "fit")); ctx.note("fitted components saved as CSV", "good"); return txt; }
  csvB.addEventListener("click", exportSpectra); fitB.addEventListener("click", exportFits);

  /* 7 loading feedback on the spectra */
  const sp = $("#spectra"); let busyT = 0;
  function watchLoad() { clearInterval(busyT); if (!sp) return; const id = ctx.S.id, t0 = Date.now();
    const done = () => !id || id !== ctx.S.id || ctx.loaded(id) || ctx.failed(id) || Date.now() - t0 > 60000;
    if (done()) { delete sp.dataset.busy; sp.removeAttribute("aria-busy"); return; }
    sp.dataset.busy = "1"; sp.setAttribute("aria-busy", "true");
    busyT = setInterval(() => { if (done()) { clearInterval(busyT); if (id === ctx.S.id || !ctx.S.id) { delete sp.dataset.busy; sp.removeAttribute("aria-busy"); } } }, 80); }
  addEventListener("tng:select", () => setTimeout(watchLoad, 0));

  /* keys */
  const where = t => { if (!t || !t.closest) return "page";
    if (t.closest("#chat-root,textarea,select,[contenteditable=''],[contenteditable='true']")) return "text";
    if (t.matches("input") && !/^(range|checkbox|radio|button)$/.test(t.type)) return "text";
    if (t.closest("#v3d-root")) return "3d";
    if (t.closest(".pop") && !t.closest("#keys-pop")) return "text";
    return "page"; };
  addEventListener("keydown", ev => { const a = keyAction(ev, where(ev.target)); if (!a) return;
    if (a === "help") toggleKeys(); else if (a === "undo") undo(); else if (a === "redo") redo(); else if (a === "random") random();
    else if (a === "link") copyLink(); else if (a === "tab-spectra") ctx.showTab("spectra"); else if (a === "tab-3d") ctx.showTab("3d");
    ev.preventDefault(); });

  Object.assign(F, {copyLink, random, undo, redo, exportSpectra, exportFits, history: H});
  return F;
}
