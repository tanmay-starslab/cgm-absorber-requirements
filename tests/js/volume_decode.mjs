// Volume decoding of docs/tng50/js/viewer3d.js vs tngsight.volume (design-2 §7.9): exact q bytes from the .gz through
// DecompressionStream, decodeU8 vs Python decode_u8 (≤ 1e-6), x-fastest layout, the already-decompressed path and the
// wrong-length error. Usage: node tests/js/volume_decode.mjs [fixture dir]   (default: make_volume_fixture.py → tmp)
import {readFileSync, mkdtempSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {loadManifest, loadVolume, decodeU8, gunzipIfNeeded} from "../../docs/tng50/js/viewer3d.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let dir = process.argv[2];
if (!dir) { dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "tngvol-"));
  execFileSync(process.env.PYTHON || "python", [join(HERE, "make_volume_fixture.py"), "--out", dir], {stdio: "inherit"}); }
let fails = 0; const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const E = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")), base = "http://fixture.test/vol/";
globalThis.fetch = async u => { const p = join(dir, String(u).replace(base, "").split("?")[0]);
  try { return new Response(readFileSync(p)); } catch { return new Response("nf", {status: 404}); } };
console.log(`fixture impl: ${E.impl}`);
const man = await loadManifest(base);
const v = await loadVolume(man, "f", "16", base);
check(v.n === 16 && v.data.length === 4096 && v.data.every((x, i) => x === E.q[i]), `gz → DecompressionStream: ${v.data.length} bytes, exact q bytes`);
const raw = await loadVolume(man, "f", "raw", base);
check(raw.data.every((x, i) => x === E.q[i]), "already-decompressed bytes used as is");
let err = null; try { await loadVolume(man, "f", "bad", base); } catch (x) { err = x.message; }
check(/expected 16³ = 4096/.test(err || ""), "wrong length → error: " + err);
const f = man.fields.f, d = decodeU8(v.data, f.lo, f.hi); let dm = 0, nanOk = true;
for (let i = 0; i < d.length; i++) { const e = E.decoded[i]; if (e === null) { if (!Number.isNaN(d[i])) nanOk = false; } else dm = Math.max(dm, Math.abs(d[i] - e)); }
check(dm <= 1e-6 && nanOk, `decodeU8 vs decode_u8: max|Δ| ${dm.toExponential(2)} (≤ 1e-6), NaN exactly where q = 0 (${E.decoded.filter(x => x === null).length} voxels)`);
check(d[0] !== d[0] && d[1] !== d[1] && d[2] !== d[2], "NaN / 0 / negative inputs encode to empty");
const {i, j, k, value_log10} = E.probe, idx = i + 16 * (j + 16 * k);
check(Math.abs(d[idx] - value_log10) <= (f.hi - f.lo) / 508 + 1e-6, `x-fastest layout: voxel (${i},${j},${k}) at ${idx} decodes to ${d[idx].toFixed(4)} ≈ ${value_log10.toFixed(4)}`);
const plain = await gunzipIfNeeded(new Uint8Array([5, 6, 7]).buffer);
check(plain.length === 3 && plain[0] === 5, "non-gzip buffer passes through");
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
