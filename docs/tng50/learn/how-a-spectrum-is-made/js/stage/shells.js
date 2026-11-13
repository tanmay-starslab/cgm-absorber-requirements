// Cloud shells (DESIGN_final §3.1 D14, §3.4 row "cloud shells"; DESIGN §3.1 cloud reveals; C_ux P1-6): the CREST-3D iso
// surfaces rebuilt on the story ray by U_data (clouds3d/3, data/clouds/<gid>_<ray>/clouds.json + <id>.mesh.bin.gz), drawn
// with a fresnel rim in the colour of the cloud's ion (H I cool blue, O VI orange) and a faint fill.
//   - rim gain RIM (0.32), >= 3:1 against the dark-sky scene (G4); fill 4 % (closed) or 1.5 % (open); faded within 2-9 kpc of the camera
//     and to 55 % while the camera is inside the shell's box (review M4); no fill once the camera is within ~1.6 radii (H3);
//   - warm-hot shells that percolate (`open`: truncated at R_max, extents are lower limits) fade out with distance from the
//     story ray over 0.5-1.0 R_max instead of ending in a hard cut;
//   - focus: the active cloud (fs.cloud) gets a brighter rim (x1.6) and fill; the others stay as they are;
//   - clouds without a mesh (too few cells for marching cubes: O VI s1, s4, s7 on the story ray) are drawn as the
//     principal-axes ellipsoid of their cells (semi-axes 0.75 x clouds3d `axes`, where axes = 2 sqrt(eigenvalue)).
// Mesh format (clouds3d/3 enc.mesh): nv x 3 u8 vertex, position = cube.lo + v/255 (shape - 1) dx (disk frame kpc), then
// nf x 3 u16 triangle indices (u32 when nv >= 65536).
// makeShells(T) -> {group, items, load(cloudsJson, fetchBin), add(id, verts, faces, opts), update(fsShells, ctx), dispose()}
// meshOf(cloud, buf), ellipsoid(cloud): pure decoders (node-tested).
export const ION_COL = {HI: [0.57, 0.62, 1.0], OVI: [1.0, 0.55, 0.26]};
const VS = `out vec3 vN; out vec3 vV; out vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 cv = viewMatrix * w; vV = -cv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * cv; }`;
const FS = `in vec3 vN; in vec3 vV; in vec3 vW; uniform vec3 uCol, uRayO, uRayN; uniform float uA, uFill, uRim, uOpenR, uFogEnd, uFocDim; uniform vec2 uNearF; uniform vec4 uFoc; out vec4 o;
void main() { vec3 n = normalize(vN), v = normalize(vV); float f = 1.0 - abs(dot(n, v)); float rim = smoothstep(0.62, 0.98, f);   /* review M1 (beauty): a softer fresnel ramp hides the mesh facets */
  float a = uA * smoothstep(uNearF.x, uNearF.y, length(vV));   /* surfaces close to the camera fade (no rim wall in the face) */
  if (uOpenR > 0.0) { vec3 q = vW - uRayO; float rho = length(q - dot(q, uRayN) * uRayN); a *= 1.0 - smoothstep(0.5 * uOpenR, uOpenR, rho); }
  if (uFoc.w > 0.0) a *= mix(uFocDim, 1.0, 1.0 - smoothstep(uFoc.w, 2.0 * uFoc.w, length(vW - uFoc.xyz)));   /* the stage's focus sphere */
  if (uFogEnd > 0.0) a *= 1.0 - 0.7 * smoothstep(0.5 * uFogEnd, uFogEnd, length(vV));
  float far = smoothstep(40.0, 160.0, length(vV));       /* far shells (look-back) read as soft tinted silhouettes, not sub-pixel rims */
  o = vec4(uCol * (uFill + 0.10 * far + uRim * rim * (1.0 - 0.4 * far)) * a, 0.0); }`;

/* pure: decode one clouds3d/3 mesh blob (ArrayBuffer of the gunzipped file) -> {verts Float32Array (disk kpc), faces} | null */
/* pure: Taubin lambda|mu smoothing (uniform weights; Taubin 1995): removes the marching-cubes / u8 staircase creases that read as
   "crumpled cellophane" (review2 beauty M3) without the shrinkage of plain Laplacian smoothing. Display only: the cloud's cells,
   N and extents in the copy come from clouds.json, not from the mesh. Returns a new Float32Array. */
export function taubin(verts, faces, iters = 10, lam = 0.5, mu = -0.53) {
  /* CSR adjacency from the 6 directed edges of each face: on a closed manifold every neighbour appears exactly twice, so the
     average stays uniform; typed arrays only (~3x faster than Sets, keeps each mesh's decode a short task) */
  const nv = verts.length / 3, deg = new Int32Array(nv + 1);
  for (let t = 0; t < faces.length; t++) deg[faces[t] + 1] += 2;
  for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
  const adj = new Int32Array(deg[nv]), fill = deg.slice(0, nv);
  for (let t = 0; t < faces.length; t += 3) { const a = faces[t], b = faces[t + 1], c = faces[t + 2];
    adj[fill[a]++] = b; adj[fill[a]++] = c; adj[fill[b]++] = a; adj[fill[b]++] = c; adj[fill[c]++] = a; adj[fill[c]++] = b; }
  let v = Float32Array.from(verts), w = new Float32Array(v.length);
  const pass = f => { for (let i = 0; i < nv; i++) { const e0 = deg[i], e1 = deg[i + 1];
      if (e1 === e0) { w[3 * i] = v[3 * i]; w[3 * i + 1] = v[3 * i + 1]; w[3 * i + 2] = v[3 * i + 2]; continue; }
      let x = 0, y = 0, z = 0; for (let e = e0; e < e1; e++) { const j = 3 * adj[e]; x += v[j]; y += v[j + 1]; z += v[j + 2]; } const k = 1 / (e1 - e0);
      w[3 * i] = v[3 * i] + f * (x * k - v[3 * i]); w[3 * i + 1] = v[3 * i + 1] + f * (y * k - v[3 * i + 1]); w[3 * i + 2] = v[3 * i + 2] + f * (z * k - v[3 * i + 2]); }
    const t = v; v = w; w = t; };
  for (let it = 0; it < iters; it++) { pass(lam); pass(mu); }
  return v;
}
/* pure: one midpoint (1 -> 4) subdivision of a triangle mesh, shared edge midpoints. Coarse meshes (Cloud A's H I hull has 568
   faces) keep straight silhouette edges after smoothing alone; subdividing first lets Taubin round them (review2 beauty M3) */
export function subdivide(verts, faces) {
  const V = Array.from(verts), mid = new Map(), F = [];
  const m = (a, b) => { const k = a < b ? a * 1048576 + b : b * 1048576 + a; let i = mid.get(k);
    if (i === undefined) { i = V.length / 3; V.push((V[3 * a] + V[3 * b]) / 2, (V[3 * a + 1] + V[3 * b + 1]) / 2, (V[3 * a + 2] + V[3 * b + 2]) / 2); mid.set(k, i); } return i; };
  for (let t = 0; t < faces.length; t += 3) { const a = faces[t], b = faces[t + 1], c = faces[t + 2], ab = m(a, b), bc = m(b, c), ca = m(c, a);
    F.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca); }
  const nv = V.length / 3; return {verts: new Float32Array(V), faces: nv >= 65536 ? new Uint32Array(F) : new Uint16Array(F)};
}
/* pure: signed volume of a closed triangle mesh (divergence theorem); for tests */
export function meshVolume(verts, faces) { let V = 0;
  for (let t = 0; t < faces.length; t += 3) { const a = 3 * faces[t], b = 3 * faces[t + 1], c = 3 * faces[t + 2];
    V += verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1]) - verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c]) + verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c]); }
  return V / 6; }
export function meshOf(cloud, buf, {smooth = 10} = {}) {
  const nv = cloud.mesh?.nv | 0, nf = cloud.mesh?.nf | 0, cu = cloud.cube; if (!nv || !nf || !cu) return null;
  const wide = nv >= 65536, need = 3 * nv + 3 * nf * (wide ? 4 : 2), u8 = new Uint8Array(buf);
  if (u8.byteLength < need) throw new Error(`shells: ${cloud.id} mesh ${u8.byteLength} B < ${need} B`);
  const verts = new Float32Array(3 * nv);
  for (let i = 0; i < nv; i++) for (let a = 0; a < 3; a++) verts[3 * i + a] = cu.lo[a] + u8[3 * i + a] / 255 * (cu.shape[a] - 1) * cu.dx;
  const off = 3 * nv, faces = wide ? new Uint32Array(3 * nf) : new Uint16Array(3 * nf), dv = new DataView(buf);
  for (let k = 0; k < 3 * nf; k++) faces[k] = wide ? dv.getUint32(off + 4 * k, true) : dv.getUint16(off + 2 * k, true);
  for (let k = 0; k < faces.length; k++) if (faces[k] >= nv) throw new Error(`shells: ${cloud.id} face index ${faces[k]} >= nv ${nv}`);
  /* weld: marching cubes emits one vertex per edge crossing per cube, so the same (u8-quantised) point appears several times;
     merged vertices give smooth normals and a clean fresnel rim instead of a faceted one */
  const key = new Map(), remap = new Uint32Array(nv), wv = [];
  for (let i = 0; i < nv; i++) { const k = u8[3 * i] | (u8[3 * i + 1] << 8) | (u8[3 * i + 2] << 16); let j = key.get(k);
    if (j === undefined) { j = wv.length / 3; key.set(k, j); wv.push(verts[3 * i], verts[3 * i + 1], verts[3 * i + 2]); } remap[i] = j; }
  const out = wv.length / 3 >= 65536 ? new Uint32Array(faces.length) : new Uint16Array(faces.length); let m = 0;
  for (let t = 0; t < faces.length; t += 3) { const a = remap[faces[t]], b = remap[faces[t + 1]], c = remap[faces[t + 2]]; if (a === b || b === c || a === c) continue; out[m++] = a; out[m++] = b; out[m++] = c; }
  let F = out.slice(0, m), V0 = new Float32Array(wv);
  /* < 6000 faces: one level; < 2000: two (all story meshes: ~25k -> ~110k triangles, additive, no depth; ~10 ms of JS per mesh, each its own task) */
  if (smooth > 0) for (let lv = 0; lv < 2 && F.length / 3 < (lv ? 8000 : 6000); lv++) ({verts: V0, faces: F} = subdivide(V0, F));
  return {verts: smooth > 0 ? taubin(V0, F, smooth) : V0, faces: F, nvRaw: nv};
}
/* pure: an ellipsoid (UV sphere, nu x nv) on the cloud's principal axes; semi-axes = 0.75 axes, floor 0.5 kpc */
export function ellipsoid(cloud, nu = 36, nv = 20) {   // review H3/M1 (beauty): 36 x 20, no visible polygon edge up close
  const c = cloud.centre, E = cloud.evec, ax = (cloud.axes || [1, 1, 1]).map(x => Math.max(0.5, 0.75 * x));
  const verts = new Float32Array(3 * (nu * (nv - 1) + 2)), faces = []; let k = 0;   // nu * (nv - 1) + 2 = 686 < 65536 (u16 faces)
  const put = (x, y, z) => { for (let a = 0; a < 3; a++) verts[3 * k + a] = c[a] + x * ax[0] * E[a][0] + y * ax[1] * E[a][1] + z * ax[2] * E[a][2]; return k++; };
  const top = put(0, 0, 1);
  for (let j = 1; j < nv; j++) { const th = Math.PI * j / nv; for (let i = 0; i < nu; i++) { const ph = 2 * Math.PI * i / nu; put(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)); } }
  const bot = put(0, 0, -1), ring = j => 1 + (j - 1) * nu;
  for (let i = 0; i < nu; i++) faces.push(top, ring(1) + i, ring(1) + (i + 1) % nu);
  for (let j = 1; j < nv - 1; j++) for (let i = 0; i < nu; i++) { const a = ring(j) + i, b = ring(j) + (i + 1) % nu, c2 = ring(j + 1) + i, d = ring(j + 1) + (i + 1) % nu; faces.push(a, c2, b, b, c2, d); }
  for (let i = 0; i < nu; i++) faces.push(bot, ring(nv - 1) + (i + 1) % nu, ring(nv - 1) + i);
  return {verts, faces: new Uint16Array(faces)};
}

export const RIM = 0.32;                              // rim gain (additive, before bloom); 0.32 x ion colour is >= 3:1 on the dark sky
/* 0 outside the box (+ margin), 1 deeper than the margin inside, smooth in between */
export function insideK(ud, p, margin = 2) {
  let d = Infinity; for (let a = 0; a < 3; a++) d = Math.min(d, p[a] - ud.lo[a], ud.hi[a] - p[a]);
  const t = Math.max(0, Math.min(1, (d + margin) / (2 * margin))); return t * t * (3 - 2 * t); }
/* 1 when the camera is within 1.2 bounding-sphere radii of the box centre (the shell spans > ~80° of view), 0 beyond 3 radii (review H3 beauty) */
export function nearK(ud, p) {
  const c = [0, 1, 2].map(a => (ud.lo[a] + ud.hi[a]) / 2), r = Math.max(1, 0.5 * Math.hypot(ud.hi[0] - ud.lo[0], ud.hi[1] - ud.lo[1], ud.hi[2] - ud.lo[2]));
  const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]), t = Math.max(0, Math.min(1, (d - 1.2 * r) / (1.8 * r))); return 1 - t * t * (3 - 2 * t); }
export function makeShells(T) {
  const group = new T.Group(), items = new Map();
  const mat = col => new T.ShaderMaterial({glslVersion: T.GLSL3, vertexShader: VS, fragmentShader: FS, transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide,
    uniforms: {uCol: {value: new T.Vector3(...col)}, uA: {value: 0}, uFill: {value: 0.12}, uRim: {value: 1.0}, uOpenR: {value: 0}, uFogEnd: {value: 0}, uNearF: {value: new T.Vector2(2, 9)}, uFoc: {value: new T.Vector4(0, 0, 0, 0)}, uFocDim: {value: 1},
      uRayO: {value: new T.Vector3()}, uRayN: {value: new T.Vector3(0, 0, 1)}},
    blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.OneFactor, blendDst: T.OneFactor, blendSrcAlpha: T.ZeroFactor, blendDstAlpha: T.OneFactor});
  const api = {group, items,
    /* add one mesh: verts Float32Array (disk frame kpc), faces Uint16/32Array; opts {col, ion, open, rMax, fallback} (an array = col, S0 API) */
    add(id, verts, faces, opts = {}) {
      if (Array.isArray(opts)) opts = {col: opts};
      const g = new T.BufferGeometry(); g.setAttribute("position", new T.BufferAttribute(verts, 3)); g.setIndex(new T.BufferAttribute(faces, 1)); g.computeVertexNormals();
      const m = new T.Mesh(g, mat(opts.col || ION_COL[opts.ion] || [0.6, 0.8, 1.0])); m.frustumCulled = false; m.visible = false;
      g.computeBoundingBox(); const bb = g.boundingBox;
      m.userData = {open: !!opts.open, rMax: opts.rMax || 40, ion: opts.ion || null, fallback: !!opts.fallback, lo: bb.min.toArray(), hi: bb.max.toArray()};
      const old = items.get(id); if (old) { group.remove(old); old.geometry.dispose(); old.material.dispose(); }
      group.add(m); items.set(id, m); return m; },
    /* clouds3d/3 JSON + fetchBin(file name in the clouds dir) -> ArrayBuffer (gunzipped); resolves {meshes, ellipsoids, failed} */
    async load(cj, fetchBin) {
      const out = {meshes: 0, ellipsoids: 0, failed: []}, rMax = cj.params?.R_max || 40, jobs = [];
      for (const [ion, I] of Object.entries(cj.ions || {})) for (const c of I.clouds || []) jobs.push((async () => {
        let geo = null;
        try { if (c.mesh?.nv > 0 && c.files?.mesh?.file) geo = meshOf(c, await fetchBin(c.files.mesh.file)); } catch (e) { out.failed.push(`${c.id}: ${e.message}`); }
        const fb = !geo; if (fb) { if (!c.centre || !c.evec) return; geo = ellipsoid(c); }
        api.add(c.id, geo.verts, geo.faces, {ion, open: !!(c.open ?? c.at_R_max), rMax, fallback: fb}); if (fb) out.ellipsoids++; else out.meshes++;
      })());
      await Promise.all(jobs); return out; },
    /* fs.shells [{id, alpha, open}]; ctx {focus: cloud id | null, focusK 0..1, rayO, rayN, fogEnd (kpc, 0 = off), camPos}
       inside a shell's box (2 kpc margin) the shell drops to 20 %: from inside, the cloud is its brightened cells, not a rim wall */
    update(shells = [], ctx = {}) {
      for (const m of items.values()) m.visible = false;
      for (const s of shells) { const m = items.get(s.id); if (!m) continue; const u = m.material.uniforms, foc = ctx.focus === s.id ? (ctx.focusK ?? 1) : 0;
        const open = s.open ?? m.userData.open;
        const ins = ctx.camPos ? insideK(m.userData, ctx.camPos) : 0, near = ctx.camPos ? nearK(m.userData, ctx.camPos) : 0;
        // review M4 (three_d): from inside its box a shell keeps its far walls (the near fade already removes the surfaces at
        // the camera), at 55 %, so the cool cloud the copy names stays visible; review H3 (beauty): a shell the camera is close
        // to (within ~1.6 of its radius) loses its fill and reads as a rim only, never a flat polygon over a third of the frame
        // review2 three_d T7: while the H I colours are on (ion:HI, weight ctx.hiK 0..1) the O VI skins drop to 35 % so the
        // H I cloud the copy names is the shape that reads, not a small orange ellipsoid
        const ionK = ctx.hiK > 0 && /^OVI/.test(String(s.id)) ? 1 - 0.65 * ctx.hiK : 1;
        m.visible = s.alpha > 0; u.uA.value = s.alpha * (1 - 0.45 * ins) * (1 - 0.35 * near) * ionK;
        u.uFill.value = (open ? 0.008 : 0.04) * (1 + foc) * (1 - near); u.uRim.value = RIM * (open ? 0.5 : 1) * (1 + 0.6 * foc);
        u.uOpenR.value = open ? m.userData.rMax : 0; u.uFogEnd.value = ctx.fogEnd || 0;
        if (ctx.focusSphere && ctx.focusSphere.r > 0) { u.uFoc.value.set(...ctx.focusSphere.c, ctx.focusSphere.r); u.uFocDim.value = ctx.focusSphere.dim; } else u.uFoc.value.w = 0;
        if (ctx.rayO) u.uRayO.value.fromArray(ctx.rayO); if (ctx.rayN) u.uRayN.value.fromArray(ctx.rayN); } },
    dispose() { for (const m of items.values()) { m.geometry.dispose(); m.material.dispose(); } items.clear(); }};
  return api;
}
