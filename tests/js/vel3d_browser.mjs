// vel3d headless-browser check of the 3D velocity views (opt-in, like viewer_browser.mjs):
//   TNG_BROWSER=1 node tests/js/vel3d_browser.mjs --viz <viz dir whose manifest_v2.json has gas.vectors> [--docs <exported page dir>]
//       [--shots <dir>] [--size 720]
// Uses tests/js/lib/browser.mjs (reduced motion forced: the thumbnail does not spin, so software WebGL keeps up). Opens the
// 3D tab with ?viz=, shows v_los edge-on and checks the receding (red) and approaching (blue) halves of a co-rotating disk
// swap when the camera moves to the opposite side (v_los is projected on the camera ray every frame), the legend words and
// the Field rows, the shader's ⟨v_los⟩ and σ_los on synthetic cubes against vizdata.velRayMoment, σ_los integral-only, the Weight control, the velocity textures freed on leaving, and no page exceptions.
// With --shots it writes a few screenshots. Without TNG_BROWSER=1 it prints "skipped".
import {existsSync, readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {launch, serve, BLOCK, parseArgs, sleep, ROOT} from "./lib/browser.mjs";

if (!process.env.TNG_BROWSER) { console.log("skipped (set TNG_BROWSER=1 and pass --viz DIR to run the 3D velocity browser test)"); process.exit(0); }
const {opt} = parseArgs(process.argv.slice(2)), VIZ = opt.viz && resolve(opt.viz), DOCS = resolve(opt.docs || join(ROOT, "docs/tng50")), SHOTS = opt.shots && resolve(opt.shots);
if (!VIZ || !existsSync(join(VIZ, "manifest_v2.json"))) { console.error("--viz DIR with a manifest_v2.json is required"); process.exit(2); }
const MAN = JSON.parse(readFileSync(join(VIZ, "manifest_v2.json"), "utf8"));
if (!MAN.gas?.vectors?.v) { console.log("skipped (the manifest has no gas.vectors)"); process.exit(0); }
const page = existsSync(join(DOCS, "index.html")) ? join(DOCS, "index.html") : join(DOCS, "_template.html");
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const S = +(opt.size || 720), srv = await serve({dir: DOCS, page, viz: VIZ});
const P = await launch({width: S + 420, height: S, block: BLOCK, reducedMotion: true});
const shot = async n => { if (SHOTS) { await P.shot(join(SHOTS, n)); console.log("     shot " + n); } };
const V = "window.tngViewer3d";
const E = (x, t = 900000) => P.eval(x, t);   // software WebGL: a velocity view decodes 3 cubes (minutes on a GPU-less node)
const settle = async (ms = 600) => { await sleep(ms); await P.waitFor(`${V} && Object.values(${V}.levels().gas).includes("bound") && !${V}.message.startsWith("loading")`, 900000, 1000); await E(`${V}.drawNow()`); await sleep(300); };
try {
  await P.goto(`${srv.base}${srv.query}#tab=3d`);
  const t = await P.waitFor(`${V} && ${V}.species`, 600000, 500);
  check(t >= 0, `viewer mounted with ${await E(`${V} && ${V}.species`)} (${(t / 1000).toFixed(0)} s)`);
  const menu = JSON.parse(await E(`JSON.stringify([...document.querySelectorAll('#v3-species .vel input')].map(i => [i.value, !i.disabled, i.nextElementSibling.innerHTML]))`));
  check(menu.map(m => m[0]).join() === "vlos,vr,vphi,vmag,sigmalos" && menu.every(m => m[1]), `Velocity group: ${menu.map(m => m[2]).join(", ")}, all enabled`);
  /* v_los edge-on, from both sides */
  check(await E(`(async () => { ${V}.setStars({on: false}); const ok = await ${V}.setSpecies("vlos"); ${V}.setPreset("edge-on"); return ok; })()`), "setSpecies(\"vlos\") true");
  await sleep(1200);
  await E(`(() => { const v = ${V}, d = v.camera.position.clone().sub(v.controls.target).setLength(110); v.camera.position.copy(v.controls.target).add(d); v.controls.update(); })()`);
  await settle();
  const patch = `((fx, fy) => { const v = ${V}; v.drawNow(); const gl = v.renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, px = new Uint8Array(100);
    gl.readPixels(Math.round(fx * W) - 2, Math.round(fy * H) - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, px); const m = [0, 0, 0]; for (let i = 0; i < 25; i++) for (let c = 0; c < 3; c++) m[c] += px[4 * i + c] / 25; return m.map(Math.round); })`;
  const sides = async () => JSON.parse(await E(`JSON.stringify({l: ${patch}(0.4, 0.5), r: ${patch}(0.6, 0.5)})`));
  const red = c => c[0] > c[2] + 25, blue = c => c[2] > c[0] + 25;
  const a = await sides(); await shot("v1_vlos_edgeon.png");
  await E(`(() => { const v = ${V}; v.camera.position.sub(v.controls.target).multiplyScalar(-1).add(v.controls.target); v.camera.lookAt(v.controls.target); v.controls.update(); })()`);
  await settle(300); const b = await sides(); await shot("v2_vlos_edgeon_other_side.png");
  /* the sign is fixed by geometry: edge-on, the camera sits at +xhat with up = Lhat, so screen-right is +yhat, where
     co-rotation about +Lhat moves along −xhat, away from the camera: right red (receding), left blue. Mirrored about the
     target (camera at −xhat, same up) screen-right is −yhat, where co-rotation moves along +xhat, again away: same colours */
  check(blue(a.l) && red(a.r), `v_los edge-on: left approaching (blue) ${a.l}, right receding (red) ${a.r}`);
  check(blue(b.l) && red(b.r),
    `from the opposite side the screen halves keep their colours while the disk halves swap sides (left ${b.l}, right ${b.r}): v_los follows the camera`);
  /* the shader's numbers: synthetic cubes bound in place of the real ones (all three levels), stars and overlays off, gas mix 1,
     weight floor off, camera moved 1500 kpc out along a generic disk-frame direction so the centre ray crosses the box
     symmetrically. (1) a uniform velocity: the centre pixel's LUT index gives ⟨v_los⟩, compared with vizdata.velRayMoment
     for the same vector and ray; (2) two half-boxes (z < 0, z > 0) moving at ∓a along z: σ_los = velRayMoment("sigmalos", ...) = a·|d_z| */
  const vU = [90, -60, 40], aS = 150;
  const qr = JSON.parse(await E(`(() => { const v = ${V}, U = v.uniforms, T = v.THREE, n = 32, V0 = U.uVelV.value, gl = v.renderer.getContext();
    const qOf = x => Math.max(1, Math.min(255, 1 + Math.round((x + V0) / (2 * V0) * 254))), dec = q => -V0 + (q - 1) * 2 * V0 / 254;
    const tex = (d, f) => { const t = new T.Data3DTexture(d, n, n, n); t.format = f; t.type = T.UnsignedByteType; t.minFilter = t.magFilter = T.LinearFilter;
      t.wrapS = t.wrapT = t.wrapR = T.ClampToEdgeWrapping; t.unpackAlignment = 1; t.generateMipmaps = false; t.needsUpdate = true; return t; };
    const slots = ["uVel0", "uVel1", "uVel2", "uW0", "uW1", "uW2"], save = Object.fromEntries(slots.map(s => [s, U[s].value]));
    const saveH = [U.uVelHave.value.clone(), U.uWHave.value.clone()], win0 = [U.uWin.value.x, U.uWin.value.y];
    const gm0 = v.setStars({}).gasMix, gmSet = v.setStars({gasMix: 1}), cam0 = v.camera.position.clone(), lut = U.uLut.value.image.data;
    const nearest = c => { let b = 0, bd = 1e9; for (let i = 0; i < 256; i++) { const e = (lut[4 * i] - c[0]) ** 2 + (lut[4 * i + 1] - c[1]) ** 2 + (lut[4 * i + 2] - c[2]) ** 2; if (e < bd) { bd = e; b = i; } } return [b, Math.round(Math.sqrt(bd))]; };
    const centre = () => { v.scene.visible = false; v.drawNow(); const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, px = new Uint8Array(100);
      gl.readPixels(Math.round(W / 2) - 2, Math.round(H / 2) - 2, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, px); v.scene.visible = true;
      const m = [0, 0, 0]; for (let i = 0; i < 25; i++) for (let c = 0; c < 3; c++) m[c] += px[4 * i + c] / 25; return nearest(m.map(Math.round)); };
    const wTex = tex(new Uint8Array(n ** 3).fill(200), T.RedFormat), tmp = [wTex];
    const bindVel = t => { for (let i = 0; i < 3; i++) { U["uVel" + i].value = t; U["uW" + i].value = wTex; } U.uVelHave.value.set(1, 1, 1); U.uWHave.value.set(1, 1, 1); U.uWWin.value.set(-100, -99); };
    /* a generic direction (disk frame (1, 2, 3)/√14), so every velocity channel and every component of uCamDisk counts:
       a vy/vz swap or a sign slip on vy or vz changes ⟨v_los⟩. The expected ray comes from this construction, not from
       uCamDisk. At 1500 kpc the near fade ends at 900 kpc, before the r = 400 kpc data sphere starts at 1100 kpc */
    const V3 = a => new T.Vector3(a[0], a[1], a[2]), gen = [1, 2, 3].map(x => x / Math.sqrt(14)), q0 = v.camera.quaternion.clone();
    const off = V3(v.frame.xhat).normalize().multiplyScalar(gen[0]).addScaledVector(V3(v.frame.yhat).normalize(), gen[1]).addScaledVector(V3(v.frame.Lhat).normalize(), gen[2]);
    v.camera.position.copy(v.controls.target).addScaledVector(off, 1500); v.camera.lookAt(v.controls.target); v.camera.updateMatrixWorld();
    let out;
    try {
      const qU = ${JSON.stringify(vU)}.map(qOf), d1 = new Uint8Array(4 * n ** 3); for (let i = 0; i < n ** 3; i++) d1.set([qU[0], qU[1], qU[2], 255], 4 * i);
      const t1 = tex(d1, T.RGBAFormat); tmp.push(t1); bindVel(t1); U.uVq.value = 1; U.uWin.value.set(win0[0], win0[1]);
      const c1 = centre(), cd = U.uCamDisk.value, r = Math.hypot(cd.x, cd.y, cd.z), camDir = [-cd.x / r, -cd.y / r, -cd.z / r], dir = gen.map(x => -x);
      const ax = 2, qa = qOf(${aS}), qb = qOf(-${aS}), d2 = new Uint8Array(4 * n ** 3);
      for (let i = 0; i < n ** 3; i++) { const c = [i % n, Math.floor(i / n) % n, Math.floor(i / n / n)][ax], q = [128, 128, 128]; q[ax] = c >= n / 2 ? qa : qb; d2.set([...q, 255], 4 * i); }
      const t2 = tex(d2, T.RGBAFormat); tmp.push(t2); bindVel(t2); U.uVq.value = 5; U.uWin.value.set(0, 200);
      const c2 = centre();
      out = {dir, camDir, ax, win1: win0, vDec: qU.map(dec), aDec: dec(qa), c1, c2, target: v.controls.target.length()};
    } finally {
      for (const s of slots) U[s].value = save[s]; U.uVelHave.value.copy(saveH[0]); U.uWHave.value.copy(saveH[1]);
      v.camera.position.copy(cam0); v.camera.quaternion.copy(q0); v.camera.updateMatrixWorld(); v.setStars({gasMix: gm0}); v.setTransfer({}); tmp.forEach(t => t.dispose()); v.render(); }
    return JSON.stringify(out); })()`));
  { const {velRayMoment} = await import("../../docs/tng50/js/vizdata.js");
    const eV = velRayMoment("vlos", [{w: 1, v: qr.vDec, p: [0, 0, 0]}], qr.dir), e = qr.dir.map(() => 0); e[qr.ax] = qr.aDec;
    const eS = velRayMoment("sigmalos", [{w: 1, v: e, p: [0, 0, 0]}, {w: 1, v: e.map(x => -x), p: [0, 0, 0]}], qr.dir);
    const [lo, hi] = qr.win1, gotV = lo + (hi - lo) * qr.c1[0] / 255, gotS = 200 * qr.c2[0] / 255, stepV = (hi - lo) / 255;
    check(qr.dir.every((x, i) => Math.abs(x - qr.camDir[i]) < 1e-3), `uCamDisk gives the constructed ray d = (${qr.dir.map(x => x.toFixed(3))}): (${qr.camDir.map(x => x.toFixed(3))})`);
    check(qr.target < 1e-3 && Math.abs(gotV - eV) <= 3 * stepV + 0.5 && qr.c1[1] <= 12,
      `shader ⟨v_los⟩ for a uniform v = (${qr.vDec.map(x => x.toFixed(1))}) along the centre ray d = (${qr.dir.map(x => x.toFixed(3))}): ${gotV.toFixed(1)} km/s (LUT ${qr.c1[0]}, colour miss ${qr.c1[1]}), velRayMoment ${eV.toFixed(1)}`);
    check(Math.abs(gotS - eS) <= 3 * 200 / 255 + 0.5 && qr.c2[1] <= 12,
      `shader σ_los for two half-boxes at ±${qr.aDec.toFixed(1)} km/s along axis ${"xyz"[qr.ax]}: ${gotS.toFixed(1)} km/s (LUT ${qr.c2[0]}, colour miss ${qr.c2[1]}), velRayMoment ${eS.toFixed(1)}`); }
  const L = JSON.parse(await E(`JSON.stringify({ttl: document.querySelector(".v3d-leg .ttl").textContent, ends: [...document.querySelectorAll(".v3d-leg .ends span")].map(s => s.textContent),
    ticks: [...document.querySelectorAll(".v3d-leg .ticks span")].map(s => s.textContent), lo: document.querySelector("#v3-lo-row").hidden, vw: document.querySelector("#v3-vw-row").hidden,
    w: document.querySelector("#v3-weight-row").hidden, wv: document.querySelector("#v3-vw-o").textContent, aria: ${V}.canvas.getAttribute("aria-label")})`));
  check(L.ends.join() === "toward you,away from you" && /km\/s/.test(L.ttl) && L.lo && !L.vw && !L.w && L.wv === "±200",
    `legend "${L.ttl}" ticks ${L.ticks.join(" ")} with words ${L.ends.join(" / ")}; window ${L.wv} km/s and Weight rows shown, log rows hidden`);
  check(/line-of-sight velocity/.test(L.aria) && /toward you to away from you/.test(L.aria), "canvas label describes the view and its sign");
  const U2 = JSON.parse(await E(`JSON.stringify({cm: document.querySelector("#v3-cmap-row").hidden, ttl: [...document.querySelectorAll('#v3-mode input')].map(i => i.closest("label").title),
    desc: document.querySelector("#v3-vw").hasAttribute("aria-describedby")})`));
  check(U2.cm && /weighted mean along each ray/.test(U2.ttl.join()) && /colour from the velocity/.test(U2.ttl.join()) && !U2.desc,
    `signed view: one-map colours row hidden; mode tooltips "${U2.ttl.join(" | ")}"; window value read once`);
  await E(`${V}.setTransfer({W: 100})`); check((await E(`document.querySelector("#v3-vw-o").textContent`)) === "±100", "the window slider narrows to ±100 km/s");
  await E(`${V}.setTransfer({W: 200})`);
  /* the other views */
  await E(`${V}.setSpecies("vphi").then(() => ${V}.setPreset("face-on"))`); await sleep(1200); await settle(); await shot("v3_vphi_faceon.png");
  check((await E(`[...document.querySelectorAll(".v3d-leg .ends span")].map(s => s.textContent).join()`)) === "counter-rotating,co-rotating", "v_φ legend: counter- / co-rotating");
  await E(`${V}.setSpecies("vr").then(() => { ${V}.setMode("volume"); ${V}.setPreset("reset"); })`); await sleep(1200); await settle(); await shot("v4_vr_volume.png");
  check((await E(`${V}.mode`)) === "volume", "v_r in volume mode");
  const sg = JSON.parse(await E(`(async () => { const ok = await ${V}.setSpecies("sigmalos"); const msg = ${V}.message; const vol = ${V}.setMode("volume");
    return JSON.stringify({ok, msg, vol, mode: ${V}.mode, dis: document.querySelector('#v3-mode input[value="volume"]').disabled}); })()`));
  check(sg.ok && sg.vol === false && sg.mode === "integral" && sg.dis, "σ_los: integral only (volume refused and its button disabled)");
  check(/integral mode/.test(sg.msg), `σ_los chosen in volume mode says the switch: "${sg.msg}"`);
  await E(`${V}.setPreset("edge-on")`); await sleep(1200); await settle(); await shot("v5_sigmalos_edgeon.png");
  await E(`${V}.setSpecies("vmag")`); await settle(); await shot("v6_vmag.png");
  const ions = await E(`[...document.querySelectorAll("#v3-weight option")].map(o => o.value).join()`);
  const wIon = ["OVI", "HI", "CIII"].find(k => ions.split(",").includes(k));
  await E(`${V}.setSpecies("vlos")`); await settle();
  if (wIon) { await E(`${V}.setWeight(${JSON.stringify(wIon)})`); await sleep(1500); await P.waitFor(`${V}.weightBound === ${JSON.stringify(wIon)}`, 900000, 1000); await settle();
    /* the requested weight (viewer.weight) is set at once; the bound one and the legend change only once its cubes bind */
    const wb = JSON.parse(await E(`JSON.stringify({w: ${V}.weight, b: ${V}.weightBound, ttl: document.querySelector(".v3d-leg .ttl").textContent,
      name: document.querySelector('#v3-weight option[value=${JSON.stringify(wIon)}]').textContent})`));
    check(wb.w === wIon && wb.b === wIon && wb.ttl.includes(`${wb.name}-weighted`), `Weight control: v_los weighted by ${wIon}, bound, legend "${wb.ttl}" (options ${ions})`);
    await shot("v7_vlos_weight_" + wIon + ".png"); await E(`${V}.setWeight("nH")`); }
  const gv = JSON.parse(await E(`JSON.stringify({gpu: ${V}.gpuBytes(), keys: ${V}.texKeys().filter(k => k.startsWith("vel|"))})`));
  await E(`${V}.setSpecies("nH")`); await settle();
  const g = JSON.parse(await E(`JSON.stringify({gpu: ${V}.gpuBytes(), keys: ${V}.texKeys().filter(k => k.startsWith("vel|")), rows: document.querySelector("#v3-vw-row").hidden && !document.querySelector("#v3-lo-row").hidden})`));
  check(gv.keys.length > 0 && g.keys.length === 0 && g.gpu < gv.gpu && g.rows,
    `back to nH: the packed velocity cubes (${gv.keys.join(", ")}) are freed (GPU ${(gv.gpu / 1e6).toFixed(1)} → ${(g.gpu / 1e6).toFixed(1)} MB), log rows back`);
  check(P.exceptions.length === 0, `no page exceptions${P.exceptions.length ? ": " + P.exceptions.join(" | ") : ""}`);
} catch (x) { check(false, "error: " + x.message); }
finally { await P.close(); await srv.close(); }
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
