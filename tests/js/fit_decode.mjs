// TNGS v2 decoder hardening (Phase-3 Code 4): docs/tng50/js/fit.js decodeTNGS on the crafted blobs of
// tests/js/fixtures/fit_tngs_cases.json (written by tests/js/make_fit_fixture.py tngs_cases(), with the expected outcome
// of each case written out by hand there). tests/test_tngsight.py runs the same blobs through
// tngsight.library.decode_web, so both decoders accept and refuse the same set with the same lines and skipped keys.
import {readFileSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {decodeTNGS, REGISTRY_KEYS} from "../../docs/tng50/js/fit.js";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..", "..");
const fx = JSON.parse(readFileSync(join(HERE, "fixtures", "fit_tngs_cases.json"), "utf8"));
const reg = JSON.parse(readFileSync(join(ROOT, "tngsight", "ions.json"), "utf8"));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const ab = s => { const b = Buffer.from(s, "base64"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

const keys = [...reg.ions].sort((a, b) => a.order - b.order).map(i => i.key);
check(keys.join() === REGISTRY_KEYS.join() && Object.isFrozen(REGISTRY_KEYS), `REGISTRY_KEYS equals tngsight/ions.json (${keys.length} keys)`);

let nOk = 0, nRef = 0;
for (const c of fx.cases) {
  for (const [label, arg] of [["registry keys", keys], ["default keys", null]]) {
    let d = null, err = null;
    try { d = decodeTNGS(ab(c.blob), arg); } catch (e) { err = e; }
    if (!c.expect.ok) { const ok = err !== null && d === null; if (ok) nRef++; else check(false, `${c.name} (${label}): must be refused, decoded to ${JSON.stringify(d && Object.keys(d.lines))}`); continue; }
    const got = d ? Object.keys(d.lines) : null;
    const ok = !err && got.join("|") === c.expect.lines.join("|") && JSON.stringify(d.skipped) === JSON.stringify(c.expect.skipped)
      && got.every(k => Object.hasOwn(d.lines, k) && d.lines[k].flux.length === d.lines[k].n && d.lines[k].flux instanceof Float64Array)
      && !("toString" in d.lines && Object.hasOwn(d.lines, "toString"));
    if (ok) nOk++; else check(false, `${c.name} (${label}): lines ${JSON.stringify(got)} skipped ${JSON.stringify(d?.skipped)}${err ? " threw " + err.message : ""}, want ${JSON.stringify(c.expect)}`);
  }
}
const nAcc = fx.cases.filter(c => c.expect.ok).length, nBad = fx.cases.length - nAcc;
check(nOk === 2 * nAcc && nRef === 2 * nBad, `${fx.cases.length} crafted blobs: ${nOk / 2}/${nAcc} accepted with the expected lines and skipped keys, ${nRef / 2}/${nBad} refused (with the registry key list and with the default)`);
// the cases the checker named (C_checks code 4) are in the set
const names = new Set(fx.cases.map(c => c.name));
check(["nlines_0", "nlines_13_header_only", "embedded_nul_key", "key_toString", "n_0", "n_over_max", "du_0", "du_nan", "u0_nan", "rest_inf"].every(n => names.has(n)), "the crafted set covers nlines 0 and 13, an embedded NUL, toString, n 0 and 20002, du 0, NaN u0/du and an infinite rest");
// a caller key list narrower than the registry bounds nlines by its length (the page passes the registry keys)
{ const c = fx.cases.find(x => x.name === "valid_all_registry_lines");
  let threw = false; try { decodeTNGS(ab(c.blob), ["HI", "OVI"]); } catch { threw = true; }
  check(threw, "nlines above the caller's key-list length is refused"); }
// a typed-array view decodes like its ArrayBuffer
{ const c = fx.cases.find(x => x.name === "valid"), b = Buffer.from(c.blob, "base64"), view = new Uint8Array(b.length + 8);
  view.set(b, 4); const d = decodeTNGS(view.subarray(4, 4 + b.length));
  check(Object.keys(d.lines).join() === "HI,OVI" && d.vSys === 12.5, "decodeTNGS reads a Uint8Array view at a non-zero offset"); }

console.log(`${fails ? "FAIL" : "PASS"} fit_decode: ${fx.cases.length} crafted blobs, ${fails} failures`);
process.exit(fails ? 1 : 0);
