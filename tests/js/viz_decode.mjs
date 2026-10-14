// Phase-2b cube decoding (design §5.11 item 1): docs/tng50/js/vizdata.js against tngsight.vizpack (or the spec
// fallback in make_viz_fixture.py). atlasToRaw of the PIL-decoded WebP parts reproduces the raw bytes (sha256), the
// gz path gives exact bytes, a wrong length is an error, decodeU8 matches dequantize (≤ 1e-6), and
// validateManifestV2 accepts the fixture and rejects 5 mutations.
// Usage: node tests/js/viz_decode.mjs [fixture dir]   (default: make_viz_fixture.py --out <tmp>)
import {readFileSync, mkdtempSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {atlasToRaw, gunzipIfNeeded, sha256Hex, sha256Js, decodeU8, validateManifestV2, cubeRef, cubeUrls} from "../../docs/tng50/js/vizdata.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let dir = process.argv[2];
if (!dir) { dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "tngviz-"));
  execFileSync(process.env.PYTHON || "python", [join(HERE, "make_viz_fixture.py"), "--out", dir], {stdio: "inherit"}); }
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const E = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")), M = JSON.parse(readFileSync(join(dir, "manifest_v2.json"), "utf8")), n = E.n;
console.log(`fixture impl: ${E.impl}`);
const rd = p => new Uint8Array(readFileSync(join(dir, p)));

let err = null; try { validateManifestV2(M); } catch (x) { err = x.message; }
check(err === null, "validateManifestV2 accepts the fixture manifest" + (err ? ": " + err : ""));
const gc = cubeRef(M, "gas", "nH", "L1"), sc = cubeRef(M, "stars", null, "S1"), U = cubeUrls(gc, "https://h.test/");
check(U.webp.length === 4 && U.webp[0] === "https://h.test/" + gc.webp.paths[0] && U.gz === "https://h.test/" + gc.gz.path, "cubeUrls = base + path, verbatim");

const gRaw = atlasToRaw(gc.webp.paths.map(p => rd(p + ".rgba")), n, "gas");
check(gRaw.length === n ** 3 && await sha256Hex(gRaw) === gc.raw_sha256 && gRaw.every((x, i) => x === E.gas.q[i]), `gas atlas → raw: ${gRaw.length} bytes, sha256 = raw_sha256`);
const sRaw = atlasToRaw(sc.webp.paths.map(p => rd(p + ".rgba")), n, "stars");
check(sRaw.length === 4 * n ** 3 && await sha256Hex(sRaw) === sc.raw_sha256, `star atlas → raw RGBA: ${sRaw.length} bytes, sha256 = raw_sha256`);
{ const {i, j, k, star_q} = E.probe, o = 4 * (i + n * (j + n * k));
  check(sRaw[o] === star_q[0] && sRaw[o + 1] === star_q[1] && sRaw[o + 2] === star_q[2] && sRaw[o + 3] === 255 && sRaw[4 * 3 + 3] === 0,
    `star layout: voxel (${i},${j},${k}) RGBA = q_i,q_r,q_g,255; empty voxel A = 0`); }
check(sha256Js(sRaw) === sc.raw_sha256 && sha256Js(new Uint8Array(0)) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" &&
  sha256Js(new TextEncoder().encode("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "pure-JS SHA-256 fallback agrees (fixture, '', 'abc')");
const gz = await gunzipIfNeeded(rd(gc.gz.path).buffer), sgz = await gunzipIfNeeded(rd(sc.gz.path));
check(await sha256Hex(gz) === gc.raw_sha256 && await sha256Hex(sgz) === sc.raw_sha256, "gz path → DecompressionStream: exact bytes (gas and stars)");
const bad = await gunzipIfNeeded(rd("gas/L1/nH.bad.u8.gz"));
check(bad.length !== gc.raw_bytes, `wrong length detected: ${bad.length} ≠ ${gc.raw_bytes}`);
err = null; try { atlasToRaw(gc.webp.paths.map(p => rd(p + ".rgba").subarray(4)), n, "gas"); } catch (x) { err = x.message; }
check(/expected/.test(err || ""), "atlasToRaw on a short part → error: " + err);
const plain = await gunzipIfNeeded(new Uint8Array([5, 6, 7]).buffer);
check(plain.length === 3 && plain[0] === 5, "non-gzip buffer passes through");
const d = decodeU8(gRaw, gc.vmin, gc.vmax); let dm = 0, nanOk = true;
for (let i = 0; i < d.length; i++) { const e = E.gas.decoded[i]; if (e === null) { if (!Number.isNaN(d[i])) nanOk = false; } else dm = Math.max(dm, Math.abs(d[i] - e)); }
check(dm <= 1e-6 && nanOk && d[0] !== d[0] && d[1] !== d[1] && d[2] !== d[2], `decodeU8 vs dequantize: max|Δ| ${dm.toExponential(2)} (≤ 1e-6); NaN exactly where q = 0`);
{ const {i, j, k, gas_value_log10} = E.probe, idx = i + n * (j + n * k);
  check(Math.abs(d[idx] - gas_value_log10) <= (gc.vmax - gc.vmin) / 508 + 1e-6, `x-fastest layout: voxel (${i},${j},${k}) decodes to ${d[idx].toFixed(4)} ≈ ${gas_value_log10.toFixed(4)}`); }

const mut = [
  ["schema", m => { m.schema = "tng50-viz/1"; }],
  ["raw_sha256 not hex", m => { m.gas.fields.nH.cubes.L1.raw_sha256 = "xyz"; }],
  ["cube vmin ≠ field vmin", m => { m.gas.fields.nH.cubes.L1.vmin += 0.1; }],
  ["3 webp parts", m => { m.stars.cubes.S1.webp.paths.pop(); }],
  ["raw_bytes", m => { m.stars.cubes.S1.raw_bytes = n ** 3; }],
  ["path naming", m => { m.gas.fields.nH.cubes.L1.gz.path = "gas/L1/nH.u8.gz"; }],
  ["unknown field", m => { m.gas.fields.XX = m.gas.fields.nH; }],
];
for (const [name, f] of mut) { const m = JSON.parse(JSON.stringify(M)); f(m); let e = null; try { validateManifestV2(m); } catch (x) { e = x.message; }
  check(e !== null, `validateManifestV2 rejects mutation "${name}": ${e}`); }
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
