// Page features (docs/tng50/js/features.js, UX round 4): the pure parts, no browser. createHistory (undo and redo of
// instrument snapshots), keyAction (the page's key map and where it is ignored), pickRandom (never the current id when
// there is a choice), csvCell, spectraCSV (plotted window only, sigma scalar or per pixel) and fitCSV (lower limits carry
// logN_lower and no errors); plus the copy rules for the new controls (each has a data-tip of <= 12 words, no dot
// separators anywhere in the module's strings).
// Usage: node tests/js/features_unit.mjs
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {createHistory, keyAction, pickRandom, csvCell, spectraCSV, fitCSV} from "../../docs/tng50/js/features.js";
import {ROOT, checker, sepHits} from "./lib/browser.mjs";
import {jsStrings} from "./lib/jsscan.mjs";

const C = checker(), check = C.check;

/* ---- createHistory ---- */
{ const H = createHistory(); H.reset({a: 1});
  check(!H.canUndo && !H.canRedo && H.undo() === null && H.redo() === null, "history: a fresh history has nothing to undo or redo");
  check(H.push({a: 1}) === false && H.size === 1, "history: pushing the current state again adds no step");
  H.push({a: 2}); H.push({a: 3});
  check(H.canUndo && JSON.stringify(H.undo()) === '{"a":2}' && JSON.stringify(H.undo()) === '{"a":1}' && H.undo() === null, "history: undo walks back to the first state and stops");
  check(JSON.stringify(H.redo()) === '{"a":2}' && H.canRedo, "history: redo walks forward");
  check(H.push({a: 2}) === false && H.canRedo, "history: re-applying the undone state (the page echoes it) keeps the redo branch");
  H.push({a: 9});
  check(!H.canRedo && JSON.stringify(H.current) === '{"a":9}' && JSON.stringify(H.undo()) === '{"a":2}', "history: a new change drops the redo branch"); }
{ const H = createHistory({limit: 5}); H.reset(0); for (let i = 1; i <= 20; i++) H.push(i);
  let n = 0; while (H.undo() !== null) n++;
  check(H.size === 5 && n === 4 && H.current === 16, `history: capped at the limit (${H.size} kept, ${n} undo steps, oldest ${H.current})`); }

/* ---- keyAction ---- */
const k = (key, o = {}) => ({key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...o});
check(keyAction(k("?", {shiftKey: true})) === "help" && keyAction(k("?", {shiftKey: true}), "3d") === "help", "keys: ? opens the list on the page and on the 3D canvas");
check(keyAction(k("u")) === "undo" && keyAction(k("U", {shiftKey: true})) === "redo", "keys: u undoes, shift U redoes");
check(keyAction(k("z", {ctrlKey: true})) === "undo" && keyAction(k("z", {metaKey: true})) === "undo" && keyAction(k("Z", {ctrlKey: true, shiftKey: true})) === "redo"
  && keyAction(k("y", {ctrlKey: true})) === "redo", "keys: ctrl or cmd Z undoes, with shift (or ctrl Y) redoes");
check(keyAction(k("d")) === "random" && keyAction(k("l")) === "link" && keyAction(k("1")) === "tab-spectra" && keyAction(k("2")) === "tab-3d", "keys: d random, l link, 1 and 2 tabs");
check(["u", "d", "l", "1", "?"].every(x => keyAction(k(x), "text") === null) && keyAction(k("z", {ctrlKey: true}), "text") === null, "keys: nothing fires in a text field (native undo stays)");
check(["u", "d", "l", "1", "f", "r", "c"].every(x => keyAction(k(x), "3d") === null) && keyAction(k("z", {ctrlKey: true}), "3d") === null, "keys: the 3D canvas keeps its own letters");
check(keyAction(k("d", {altKey: true})) === null && keyAction(k("c", {ctrlKey: true})) === null && keyAction(k("j")) === null && keyAction(k("a")) === null
  && keyAction({...k("u"), isComposing: true}) === null, "keys: alt, ctrl copy, keys owned elsewhere (j k) and IME composition pass through");

/* ---- pickRandom ---- */
{ const L = [{id: "a"}, {id: "b"}, {id: "c"}]; let seen = new Set(), bad = 0;
  for (let i = 0; i < 300; i++) { const r = pickRandom(L, "b"); seen.add(r); if (r === "b") bad++; }
  check(!bad && seen.has("a") && seen.has("c"), `random: never the current one, all others reachable (${[...seen].join(" ")})`);
  check(pickRandom([{id: "a"}], "a") === "a" && pickRandom([], "a") === null && pickRandom(L, "b", () => 0.999999) === "c", "random: one entry, empty list and the top of the range"); }

/* ---- CSV ---- */
check(csvCell(1.23456, 2) === "1.23" && csvCell(NaN, 2) === "" && csvCell(null) === "" && csvCell('a,"b"') === '"a,""b"""' && csvCell("H I") === "H I", "csv: cells (fixed decimals, empty non-finite, quoting)");
{ const v = Float64Array.from([-30, -10, 0, 10, 30]), p = {ion: "OVI", label: "O VI 1032", ci: 0, R: 20000, sn: 10, seed: 7, v, flux: [1, .9, .5, .9, 1], sigma: 0.1, model: [1, .92, .52, .92, 1]};
  const t = spectraCSV({meta: {sightline: "edge_b100_a090", note: "x\ny"}, panels: [p, null, {...p, ci: 1, sigma: Float64Array.from([1, 2, 3, 4, 5])}], v0: -10, v1: 10}), lines = t.trim().split("\n");
  const hdr = lines.findIndex(l => l.startsWith("ion,")), rows = lines.slice(hdr + 1);
  check(lines[0] === "# sightline: edge_b100_a090" && lines[1] === "# note: x y" && lines[hdr] === "ion,case,R,snr,seed,v_kms,flux,sigma,model", "csv spectra: comment header, then the column names");
  check(rows.length === 6 && rows[0] === "O VI 1032,0,20000,10,7,-10.00,0.90000,0.10000,0.92000" && rows[5].split(",")[7] === "4.00000", `csv spectra: only the plotted window, per panel, sigma scalar or per pixel (${rows.length} rows: ${rows[0]})`); }
{ const t = fitCSV({meta: {sightline: "s"}, panels: [{ion: "CIV", label: "C IV 1548", ci: 0, R: 30000, sn: 20,
    comps: [{v: -12.34, dv: 1.2, logN: 13.456, dlogN: 0.05, b: 8.76, db: 0.9, tags: []}, {v: 40, dv: 2, logN: 14.9, dlogN: 0.4, b: 20, db: 3, limit: true, lo: 14.52, tags: ["sat"]}]}]});
  const rows = t.trim().split("\n").filter(l => !l.startsWith("#"));
  check(rows[0] === "ion,case,R,snr,v_kms,dv_kms,logN,dlogN,logN_lower,b_kms,db_kms,flags" && rows[1] === "C IV 1548,0,30000,20,-12.3,1.2,13.46,0.05,,8.8,0.9,"
    && rows[2] === "C IV 1548,0,30000,20,40.0,,,,14.52,20.0,,sat", `csv fit: values, and a saturated component as a lower limit without errors (${rows[2]})`); }

/* ---- copy rules of the module ---- */
{ const src = readFileSync(join(ROOT, "docs/tng50/js/features.js"), "utf8"), strs = jsStrings(src);
  const tips = [...src.matchAll(/btn\("[^"]*", "[^"]*", "[^"]*", "([^"]+)"/g), ...src.matchAll(/item\("[^"]*", "[^"]*", "([^"]+)"\)/g)].map(m => m[1]);
  const words = s => s.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
  check(tips.length >= 7 && tips.every(t => words(t) <= 12), `copy: ${tips.length} new controls each with a tip of <= 12 words (${tips.map(words).join(" ")})`);
  const sep = strs.flatMap(x => sepHits(x.s).map(h => `${x.line} ${h.what}`));
  check(!sep.length, `copy: no dot separators in the module's strings${sep.length ? ": " + sep.join(", ") : ""}`); }

process.exit(C.finish());
