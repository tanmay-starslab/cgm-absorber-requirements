// Custom-ray picker (design-2 §7.4): pick two endpoints in the 3D view or type them, see the ray's geometry, submit it.
// The math functions are pure (node-testable); attachPicker builds the controls and, when a 3D viewer is given,
// the picking plane, the draggable handles and the preview ray. Positions are physical kpc relative to the galaxy
// centre, box axes (tngsight.geometry.make_endpoints conventions).
export const R_MAX = 395, L_MIN = 20, L_MAX = 800;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = a => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);

/* intersection of the ray origin + t*dir (t ≥ 0) with the plane dot(normal, x) = d; null if parallel or behind */
export function rayPlane(origin, dir, normal, d = 0) {
  const den = dot(normal, dir); if (Math.abs(den) < 1e-12) return null;
  const t = (d - dot(normal, origin)) / den; if (!(t >= 0)) return null;
  return [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
}
export function clampRadius(p, rmax = R_MAX) {
  const r = norm(p); if (!(r > rmax)) return [p[0], p[1], p[2]];
  const s = rmax / r; return [p[0] * s, p[1] * s, p[2] * s];
}
/* §4.1: length, closest-approach b of the infinite line, b of the segment, angle to the disk normal */
export function lineMetrics(p0, p1, Lhat) {
  const d = sub(p1, p0), L = norm(d), n = [d[0] / L, d[1] / L, d[2] / L], t = -dot(p0, n);
  const closest = [p0[0] + t * n[0], p0[1] + t * n[1], p0[2] + t * n[2]], b = norm(closest);
  const b_segment = t >= 0 && t <= L ? b : Math.min(norm(p0), norm(p1));
  const angle_deg = Math.acos(Math.min(1, Math.abs(dot(n, Lhat)))) * 180 / Math.PI;
  return {length: L, b, b_segment, angle_deg, closest, n_los: n, t_star: t};
}
/* Python round(): half-to-even on the binary value (x - floor(x) is exact for |x| < 2^52) */
export function roundHalfEven(x) {
  const f = Math.floor(x), r = x - f;
  return (r > 0.5 ? f + 1 : r < 0.5 ? f : (f % 2 === 0 ? f : f + 1)) + 0;
}
export const tenths = p => p.map(x => roundHalfEven(10 * x) + 0);
export function canonical(p) { return tenths(p).map(t => t / 10 + 0); }
async function sha1hex(s) {
  const c = globalThis.crypto?.subtle; if (!c) throw new Error("crypto.subtle unavailable");
  const h = new Uint8Array(await c.digest("SHA-1", new TextEncoder().encode(s)));
  return [...h].map(b => b.toString(16).padStart(2, "0")).join("");
}
export const idString = (p0, p1) => `${tenths(p0).join(",")};${tenths(p1).join(",")}`;
export async function customId(p0, p1) { return "cust_" + (await sha1hex(idString(p0, p1))).slice(0, 10); }
/* same checks and messages as tngsight.geometry.canonicalize_endpoints, on the quantised values */
export function validate(p0, p1, Lhat = [0, 0, 1]) {
  const errors = [];
  for (const [name, p] of [["p0_kpc", p0], ["p1_kpc", p1]])
    if (!Array.isArray(p) || p.length !== 3 || !p.every(x => typeof x === "number" && Number.isFinite(x))) errors.push(`${name} must be 3 finite numbers`);
  if (errors.length) return {ok: false, errors, metrics: null};
  const q0 = canonical(p0), q1 = canonical(p1);
  for (const [name, q] of [["p0_kpc", q0], ["p1_kpc", q1]]) { const r = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
    if (r > R_MAX) errors.push(`${name}: |p| = ${r.toFixed(1)} kpc exceeds ${R_MAX} kpc`); }
  const L = Math.sqrt((q1[0] - q0[0]) ** 2 + (q1[1] - q0[1]) ** 2 + (q1[2] - q0[2]) ** 2);
  if (!(L >= L_MIN && L <= L_MAX)) errors.push(`length ${L.toFixed(1)} kpc outside [${L_MIN}, ${L_MAX}] kpc`);
  return {ok: !errors.length, errors, metrics: L > 0 ? lineMetrics(q0, q1, Lhat) : null, p0: q0, p1: q1};
}

/* ---------------- UI ---------------- */
export function attachPicker(viewer, root, app) {
  const doc = root.ownerDocument || document, cfg = app.config || {}, frame = (viewer && viewer.frame) || cfg.frame || {};
  const Lhat = frame.Lhat || [0, 0, 1], RM = cfg.custom?.r_max_kpc ?? R_MAX;
  const h = (tag, attrs = {}, ...kids) => { const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === "text") el.textContent = v; else el.setAttribute(k, v);
    for (const c of kids) el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); return el; };
  const inp = (id, lab) => h("label", {class: "pk-in"}, h("span", {text: lab}),
    h("input", {id, type: "number", step: "0.1", min: String(-RM), max: String(RM), inputmode: "decimal", "aria-label": id.replace("pk-", "").replace("-", " ") + " [kpc]"}));
  const bMode = h("button", {type: "button", class: "btn", id: "pk-mode", "aria-pressed": "false", text: "Pick ray"});
  const bUse = h("button", {type: "button", class: "btn", id: "pk-use", text: "Use selected sightline"});
  const bClear = h("button", {type: "button", class: "btn", id: "pk-clear", text: "Clear"});
  const bSub = h("button", {type: "submit", class: "btn primary", id: "pk-submit", text: "Generate this ray"});
  const read = h("div", {class: "readouts pk-read", id: "pk-read"});
  const live = h("p", {class: "msg", id: "pk-live", "aria-live": "polite"});
  const msg = h("p", {class: "msg", id: "pk-msg", "aria-live": "polite"});
  const form = h("form", {class: "pk", id: "pk-form", novalidate: ""},
    h("div", {class: "row"}, bMode, bUse, bClear),
    h("p", {class: "hint", id: "pk-hint", text: viewer ? "Click two points on the plane facing you, then drag the handles; Esc stops. Or type endpoints in kpc (box axes)." :
      "Type the ray's endpoints in kpc from the galaxy centre (simulation box axes)."}),
    h("fieldset", {}, h("legend", {class: "label", text: "start p0 [kpc]"}), h("div", {class: "pk-xyz"}, inp("pk-p0-x", "x"), inp("pk-p0-y", "y"), inp("pk-p0-z", "z"))),
    h("fieldset", {}, h("legend", {class: "label", text: "end p1 [kpc]"}), h("div", {class: "pk-xyz"}, inp("pk-p1-x", "x"), inp("pk-p1-y", "y"), inp("pk-p1-z", "z"))),
    read, h("div", {class: "row"}, bSub), live, msg);
  root.appendChild(form);
  const fld = (w, a) => form.querySelector(`#pk-${w}-${a}`);
  let P = {p0: null, p1: null}, mode = false, plane = null, drag = null, lastId = null, myJob = null;
  const f1 = x => (Math.abs(x) < 0.05 ? 0 : x).toFixed(1);

  function api() { try { return app.getState().api; } catch { return null; } }
  function writeInputs() { for (const w of ["p0", "p1"]) ["x", "y", "z"].forEach((a, i) => { fld(w, a).value = P[w] ? f1(P[w][i]) : ""; }); }
  function readInputs() { const g = w => { const v = ["x", "y", "z"].map(a => fld(w, a).value.trim()); return v.some(s => s === "") ? null : v.map(Number); };
    P.p0 = g("p0"); P.p1 = g("p1"); }
  /* final: a sequence token, so a slower refresh (it awaits customId) that started for an older input state cannot finish
     after a newer one and overwrite its readout and message; the stale call still returns its own validation result */
  let refreshSeq = 0;
  async function refresh(announce) {
    const seq = ++refreshSeq;
    const v = P.p0 && P.p1 ? validate(P.p0, P.p1, Lhat) : null, m = v && v.metrics, rows = [];
    if (m) { rows.push(["L", `${m.length.toFixed(1)} kpc`], ["b", `${m.b.toFixed(1)} kpc`]);
      if (Math.abs(m.b_segment - m.b) > 0.05) rows.push(["b (segment)", `${m.b_segment.toFixed(1)} kpc`]);
      rows.push(["θ to disk normal", `${m.angle_deg.toFixed(1)}°`]); }
    let id = null; if (v && v.ok) { try { id = await customId(v.p0, v.p1); } catch { id = null; } rows.push(["id", id || "—"]); }
    if (seq !== refreshSeq) return v;
    read.textContent = ""; for (const [k, val] of rows) read.appendChild(h("div", {}, h("b", {text: k}), h("span", {class: "num", text: val})));
    const online = !!api();
    bSub.disabled = !(v && v.ok) || !online || !!(app.getState().job);
    bSub.title = !online ? "needs a sightline server" : v && !v.ok ? v.errors.join("; ") : "";
    if (v && !v.ok) setMsg(v.errors.join("; "), "bad");
    else if (!online) setMsg("Generating needs a sightline server; none is online.", "");
    else if (msg.dataset.kind === "val" || msg.dataset.kind === "off" || msg.dataset.kind === "use") setMsg("", "");
    lastId = id;
    if (announce) live.textContent = m ? `Ray ${v.ok ? id : "(invalid)"}: length ${m.length.toFixed(1)} kpc, b ${m.b.toFixed(1)} kpc, ${m.angle_deg.toFixed(1)}° from the disk normal.` :
      P.p0 ? "Start point set; pick the end point." : "";
    draw(); return v;
  }
  function setMsg(t, cls, kind) { msg.textContent = t; msg.className = "msg " + (cls || ""); msg.dataset.kind = kind || (cls === "bad" ? "val" : t ? "off" : ""); }
  function setEndpoints(p0, p1, announce = true) { P.p0 = p0 ? [...p0] : null; P.p1 = p1 ? [...p1] : null; writeInputs(); return refresh(announce); }
  const snap = p => { let c = canonical(clampRadius(p, RM)); if (norm(c) > RM) c = canonical(clampRadius(p, RM - 0.06)); return c; };

  /* ---- 3D: plane disc, handles, preview ---- */
  const T = viewer && viewer.THREE, G = {};
  if (T) {
    G.group = new T.Group(); G.group.renderOrder = 5; viewer.scene.add(G.group);
    G.disc = new T.Mesh(new T.CircleGeometry(RM, 96), new T.MeshBasicMaterial({color: 0x6da7ec, transparent: true, opacity: 0.10, side: T.DoubleSide, depthWrite: false, depthTest: false}));
    G.ring = new T.LineLoop(new T.BufferGeometry().setFromPoints(Array.from({length: 128}, (_, i) => new T.Vector3(RM * Math.cos(i / 64 * Math.PI), RM * Math.sin(i / 64 * Math.PI), 0))),
      new T.LineBasicMaterial({color: 0x6da7ec, transparent: true, opacity: 0.6, depthTest: false}));
    G.disc.add(G.ring); G.disc.visible = false; G.group.add(G.disc);
    const hm = c => new T.Mesh(new T.SphereGeometry(10, 20, 14), new T.MeshBasicMaterial({color: c, depthTest: false, transparent: true, opacity: 0.95}));
    G.h0 = hm(0x2bb673); G.h1 = hm(0xf08f2a); G.h0.visible = G.h1.visible = false; G.group.add(G.h0, G.h1);
    G.line = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]), new T.LineDashedMaterial({color: 0xf08f2a, dashSize: 12, gapSize: 7, depthTest: false, transparent: true}));
    G.line.visible = false; G.group.add(G.line);
    G.cone = new T.Mesh(new T.ConeGeometry(6, 18, 16), new T.MeshBasicMaterial({color: 0xf08f2a, depthTest: false, transparent: true}));
    G.cone.visible = false; G.group.add(G.cone);
    for (const o of [G.disc, G.ring, G.h0, G.h1, G.line, G.cone]) o.renderOrder = 10;
    /* fix-ui FE-14: handles, cone and dashes keep a constant screen size (kpc per CSS px at each object's distance), so
       they do not fill the stage in the ±25 kpc close views */
    const kpcPerPx = (cam, p) => { const h = viewer.canvas.clientHeight || 600; return 2 * cam.position.distanceTo(p) * Math.tan(cam.fov * Math.PI / 360) / h; };
    const fix = (o, px) => { o.onBeforeRender = (r, sc, cam) => { o.scale.setScalar(Math.max(1e-3, px * kpcPerPx(cam, o.position) / 10)); o.updateMatrixWorld(true); }; };
    fix(G.h0, 7); fix(G.h1, 7); for (const o of [G.h0, G.h1, G.cone, G.line]) o.frustumCulled = false;
    G.cone.onBeforeRender = (r, sc, cam) => { if (!P.p0 || !P.p1) return; const k = kpcPerPx(cam, new T.Vector3(...P.p1)), d = new T.Vector3(...sub(P.p1, P.p0)).normalize();
      G.cone.scale.setScalar(Math.max(1e-3, 0.8 * k)); G.cone.position.set(...P.p1).addScaledVector(d, -9 * 0.8 * k); G.cone.updateMatrixWorld(true); };
    G.line.onBeforeRender = (r, sc, cam) => { const k = kpcPerPx(cam, viewer.controls.target); G.line.material.dashSize = 9 * k; G.line.material.gapSize = 6 * k; };
  }
  function draw() { if (!T) return;
    const V = p => new T.Vector3(p[0], p[1], p[2]);
    G.h0.visible = !!P.p0; if (P.p0) G.h0.position.copy(V(P.p0)); G.h1.visible = !!P.p1; if (P.p1) G.h1.position.copy(V(P.p1));
    const both = !!(P.p0 && P.p1 && norm(sub(P.p1, P.p0)) > 0); G.line.visible = G.cone.visible = both;
    if (both) { G.line.geometry.setFromPoints([V(P.p0), V(P.p1)]); G.line.computeLineDistances();
      const d = V(sub(P.p1, P.p0)).normalize(); G.cone.position.copy(V(P.p1)).addScaledVector(d, -9); G.cone.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d); }
    viewer.render(); }
  function px(ev) { const r = viewer.canvas.getBoundingClientRect(); return {x: ev.clientX - r.left, y: ev.clientY - r.top, w: r.width, h: r.height}; }
  function worldRay(ev) { const p = px(ev), rc = new T.Raycaster(); rc.setFromCamera(new T.Vector2(p.x / p.w * 2 - 1, -(p.y / p.h) * 2 + 1), viewer.camera);
    return [rc.ray.origin.toArray(), rc.ray.direction.toArray()]; }
  function screenOf(p) { const r = viewer.canvas.getBoundingClientRect(), v = new T.Vector3(...p).project(viewer.camera);
    return v.z > 1 ? null : {x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height}; }
  function hitHandle(ev) { const p = px(ev), rad = ev.pointerType === "touch" ? 24 : 12; let best = null, bd = rad;
    for (const w of ["p0", "p1"]) { if (!P[w]) continue; const s = screenOf(P[w]); if (!s) continue; const d = Math.hypot(s.x - p.x, s.y - p.y); if (d <= bd) { bd = d; best = w; } }
    return best; }
  function enter() { if (!T || mode) return; mode = true; viewer.picking = true;
    const n = new T.Vector3(); viewer.camera.getWorldDirection(n); plane = n.toArray();
    G.disc.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), n); G.disc.visible = true;
    bMode.setAttribute("aria-pressed", "true"); bMode.textContent = "Picking… (Esc to stop)"; viewer.canvas.style.cursor = "crosshair";
    live.textContent = P.p0 && P.p1 ? "Pick mode: drag a handle to move an endpoint." : "Pick mode: click the start point."; draw(); }
  function exit() { if (!mode) return; mode = false; viewer.picking = false; drag = null; if (G.disc) G.disc.visible = false; viewer.controls.enabled = true;
    bMode.setAttribute("aria-pressed", "false"); bMode.textContent = "Pick ray"; viewer.canvas.style.cursor = ""; live.textContent = "Pick mode off."; draw(); }
  let down = null;
  const onDown = ev => { if (!mode || ev.button > 0) return; const w = hitHandle(ev);
    if (w && P.p0 && P.p1) { drag = {w, id: ev.pointerId}; viewer.controls.enabled = false; ev.stopPropagation(); ev.preventDefault();
      try { viewer.canvas.setPointerCapture(ev.pointerId); } catch {} return; }
    down = {x: ev.clientX, y: ev.clientY, t: performance.now()}; };
  const onMove = ev => { if (!drag || ev.pointerId !== drag.id) return; ev.preventDefault();
    const [o, d] = worldRay(ev), q = rayPlane(o, d, plane, dot(plane, P[drag.w])); if (!q) return;
    P[drag.w] = snap(q); writeInputs(); refresh(false); };
  const onUp = ev => { if (drag && ev.pointerId === drag.id) { drag = null; viewer.controls.enabled = true; refresh(true); ev.stopPropagation(); return; }
    if (!mode || !down) return; const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y), dt = performance.now() - down.t; down = null;
    if (moved >= (ev.pointerType === "touch" ? 6 : 5) || dt > 600) return;
    const [o, d] = worldRay(ev), q = rayPlane(o, d, plane, 0); if (!q) return;
    if (!P.p0 || (P.p0 && P.p1)) { if (P.p0 && P.p1) return; P.p0 = snap(q); } else P.p1 = snap(q);
    writeInputs(); refresh(true); if (P.p1) live.textContent += " Drag the handles to adjust, then Generate."; };
  if (T) {
    viewer.el.addEventListener("pointerdown", onDown, true); addEventListener("pointermove", onMove, {passive: false}); addEventListener("pointerup", onUp, true);
    viewer.hooks.togglePick = () => (mode ? exit() : enter()); viewer.hooks.exitPick = exit;
  } else { bMode.disabled = true; bMode.title = "needs the 3D view (WebGL2)"; }
  bMode.addEventListener("click", () => (mode ? exit() : enter()));
  addEventListener("keydown", ev => { if (ev.key === "Escape" && mode) exit(); });
  bClear.addEventListener("click", () => { if (msg.dataset.kind !== "job") setMsg("", ""); setEndpoints(null, null); live.textContent = mode ? "Cleared; click the start point." : "Endpoints cleared."; });
  bUse.addEventListener("click", () => { const st = app.getState(), e = st.id && app.entry(st.id);
    if (!e) { setMsg("Select a sightline first.", "bad", "use"); return; }
    if (!Array.isArray(e.p0) || !Array.isArray(e.p1)) { setMsg(`${e.id} has no stored endpoints, so it cannot be copied into the form.`, "bad", "use"); return; }
    if (msg.dataset.kind === "use") setMsg("", ""); setEndpoints(e.p0, e.p1); });
  for (const w of ["p0", "p1"]) for (const a of ["x", "y", "z"]) { const el = fld(w, a);
    el.addEventListener("input", () => { if (msg.dataset.kind === "use") setMsg("", ""); readInputs(); refresh(false); }); el.addEventListener("change", () => refresh(true)); }
  form.addEventListener("submit", async ev => { ev.preventDefault(); readInputs(); const v = await refresh(false);
    if (!v || !v.ok || bSub.disabled) return;
    bSub.disabled = true; setMsg("Submitting…", "", "job");
    const r = await app.submitCustom({p0_kpc: v.p0, p1_kpc: v.p1});
    if (r.status === "ready") setMsg(`Loaded ${r.id} (already computed); its spectra are in the Spectra tab.`, "good", "job");
    else if (r.status === "queued") { myJob = r.id; setMsg(`Queued ${r.id}${r.position ? " at position " + r.position : ""}; progress is shown under New sightline and the spectra open when ready.`, "", "job"); }
    else setMsg(r.message || "submission failed", "bad", "job");
    refresh(false); });
  const onDone = ev => { const d = ev.detail || {}; if (!myJob || d.id !== myJob) { refresh(false); return; } myJob = null;
    setMsg(`Generated ${d.id}.`, "good", "job"); app.select(d.id, {source: "job"}); app.showTab("spectra"); refresh(false); };
  const onErr = ev => { const d = ev.detail || {}; if (myJob && d.id === myJob) { myJob = null; setMsg("Generation failed: " + (d.message || "unknown error"), "bad", "job"); } refresh(false); };
  const onAny = () => refresh(false);
  addEventListener("tng:done", onDone); addEventListener("tng:error", onErr); addEventListener("tng:catalog", onAny); addEventListener("tng:backend", onAny);
  refresh(false);
  return {enter, exit, setEndpoints: (a, b) => setEndpoints(a, b), getEndpoints: () => ({p0: P.p0 && [...P.p0], p1: P.p1 && [...P.p1], id: lastId}),
    destroy() { exit(); removeEventListener("tng:done", onDone); removeEventListener("tng:error", onErr); removeEventListener("tng:catalog", onAny);
      removeEventListener("tng:backend", onAny); if (T) { viewer.el.removeEventListener("pointerdown", onDown, true); removeEventListener("pointermove", onMove);
        removeEventListener("pointerup", onUp, true); viewer.scene.remove(G.group); } form.remove(); }};
}
