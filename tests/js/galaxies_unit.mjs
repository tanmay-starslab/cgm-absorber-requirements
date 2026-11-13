// Unit tests of the galaxy picker's pure part (docs/tng50/js/galaxies.js; galaxy-sample spec, web contract): the index
// from CFG.galaxies, the URL state g=<id>, where a galaxy's pack lives (the default galaxy keeps the legacy data/ paths),
// sort with missing values last, search terms and cuts, and the number formats. Usage: node tests/js/galaxies_unit.mjs
import assert from "node:assert/strict";
import {galaxyIndex, parseGalaxy, resolveGalaxy, galaxyHashPart, packFor, sortGalaxies, matchGalaxy, lg, fmtSfr, galaxyTip, galaxyAria, galaxyCard,
  unlistedGalaxy, nearestSightline, defaultSightline, srcOf, packBase} from "../../docs/tng50/js/galaxies.js";

let n = 0;
const ok = (name, f) => { f(); n++; console.log("ok " + name); };
const LIST = [
  {id: 488530, label: "Subhalo 488530", Mstar: 1.114e11, SFR: 7.08, M200c: 1.595e12, R200c: 246.4, central: true, mw: null, m31: null, n: 672, viz: true},
  {id: 900001, label: "Subhalo 900001", Mstar: 6.2e10, SFR: 2.31, M200c: 9.8e11, R200c: 205, central: true, mw: true, m31: null, n: 683, viz: true},
  {id: 900002, label: "Subhalo 900002", Mstar: 2.4e11, SFR: 0.04, M200c: 3.1e12, R200c: 301, central: false, mw: null, m31: true, n: 683, viz: false},
  {id: 512345, label: "Subhalo 512345", Mstar: null, SFR: null, M200c: 1.2e12, R200c: 220, central: null, n: 10, viz: true}];
const CFG = {galaxies: {default: 488530, base: "data/gal", viz_base: null, list: LIST}};
const LEG = {catalog_url: "data/catalog.json", bin_dir: "data/s/", components_url: "data/components.json", viz: {manifest_url: "data/viz/manifest_v2.json", base: "https://hf/x/"}};

ok("index: null without galaxies, with one galaxy, or without the default", () => {
  assert.equal(galaxyIndex({}), null); assert.equal(galaxyIndex({galaxies: null}), null);
  assert.equal(galaxyIndex({galaxies: {default: 488530, list: [LIST[0]]}}), null);
  assert.equal(galaxyIndex({galaxies: {default: 1, list: LIST}}), null);
  const I = galaxyIndex(CFG);
  assert.equal(I.default, 488530); assert.equal(I.base, "data/gal/"); assert.equal(I.list.length, 4); assert.equal(I.byId.get(900002).central, false);
  assert.equal(galaxyIndex({galaxies: {...CFG.galaxies, list: [...LIST, {id: "../x"}]}}).list.length, 4);   // malformed ids dropped
});
ok("g=<id>: hash wins over query, malformed ignored, unknown id -> default", () => {
  assert.equal(parseGalaxy("#g=900001&id=edge_b100_a090", "?g=900002"), 900001);
  assert.equal(parseGalaxy("#id=edge_b100_a090", "?g=900002"), 900002);
  assert.equal(parseGalaxy("#g=abc", ""), null); assert.equal(parseGalaxy("", ""), null);
  const I = galaxyIndex(CFG);
  assert.equal(resolveGalaxy(I, "#g=900002", ""), 900002); assert.equal(resolveGalaxy(I, "#g=42", ""), 488530); assert.equal(resolveGalaxy(I, "", ""), 488530);
  assert.equal(galaxyHashPart(I, 488530), ""); assert.equal(galaxyHashPart(I, 900001), "g=900001&"); assert.equal(galaxyHashPart(null, 5), "");
});
ok("packFor: default keeps the legacy paths; others read <base><id>/", () => {
  const I = galaxyIndex(CFG), d = packFor(I, 488530, LEG);
  assert.equal(d.legacy, true); assert.equal(d.catalog_url, "data/catalog.json"); assert.equal(d.viz, LEG.viz); assert.equal(d.galaxy_url, null);
  const p = packFor(I, 900001, LEG);
  assert.deepEqual([p.catalog_url, p.bin_dir, p.components_url, p.galaxy_url], ["data/gal/900001/catalog.json", "data/gal/900001/s/", "data/gal/900001/components.json", "data/gal/900001/galaxy.json"]);
  assert.deepEqual(p.viz, {manifest_url: "data/gal/900001/viz/manifest_v2.json", base: "data/gal/900001/viz/", fallback_base: null, dataset: null});
  assert.equal(packFor(I, 900002, LEG).viz, null);                                 // no 3D data published
  const H = galaxyIndex({galaxies: {...CFG.galaxies, base: "https://hf.co/d/", viz_base: "https://cubes/{id}/v/"}});
  assert.equal(packFor(H, 900001, LEG).catalog_url, "https://hf.co/d/900001/catalog.json"); assert.equal(packFor(H, 900001, LEG).viz.base, "https://cubes/900001/v/");
  assert.equal(packFor(I, 42, LEG).legacy, true);                                  // an unknown id falls back to the default
});
ok("packFor: a per-galaxy base (sharded HF datasets) wins; unsafe bases are ignored", () => {
  const S = "https://huggingface.co/datasets/o/web-1/resolve/main/900001/";
  const L = LIST.map(e => e.id === 900001 ? {...e, base: S} : e.id === 900002 ? {...e, base: "javascript:alert(1)/"} : e);
  const I = galaxyIndex({galaxies: {...CFG.galaxies, list: L}});
  const p = packFor(I, 900001, LEG);
  assert.equal(p.catalog_url, S + "catalog.json"); assert.equal(p.bin_dir, S + "s/"); assert.equal(p.viz.manifest_url, S + "viz/manifest_v2.json");
  assert.equal(p.viz.base, S + "viz/");
  assert.equal(packFor(I, 900002, LEG).catalog_url, "data/gal/900002/catalog.json");    // unsafe scheme -> shared base
  assert.equal(packBase({base: "../x/"}), null); assert.equal(packBase({base: "no-slash"}), null); assert.equal(packBase({base: "rel/1/"}), "rel/1/");
  assert.equal(packBase({}), null); assert.equal(packBase(null), null);
});
ok("sort: by key and direction, missing last both ways, stable", () => {
  const I = galaxyIndex(CFG), ids = l => l.map(e => e.id);
  assert.deepEqual(ids(sortGalaxies(I.list, "Mstar", -1)), [900002, 488530, 900001, 512345]);
  assert.deepEqual(ids(sortGalaxies(I.list, "Mstar", 1)), [900001, 488530, 900002, 512345]);
  assert.deepEqual(ids(sortGalaxies(I.list, "SFR", -1)), [488530, 900001, 900002, 512345]);
  assert.deepEqual(ids(sortGalaxies(I.list, "M200c", 1)), [900001, 512345, 488530, 900002]);
  assert.deepEqual(ids(sortGalaxies(I.list, "id", 1)), [488530, 512345, 900001, 900002]);
});
ok("search: id prefix, flags, cuts, words; AND of terms", () => {
  const I = galaxyIndex(CFG), f = q => I.list.filter(e => matchGalaxy(e, q)).map(e => e.id);
  assert.deepEqual(f(""), [488530, 900001, 900002, 512345]);
  assert.deepEqual(f("900"), [900001, 900002]); assert.deepEqual(f("48"), [488530]);
  assert.deepEqual(f("sat"), [900002]); assert.deepEqual(f("central"), [488530, 900001]);
  assert.deepEqual(f("mw"), [900001]); assert.deepEqual(f("m31"), [900002]); assert.deepEqual(f("3d"), [488530, 900001, 512345]);
  assert.deepEqual(f("m*>11"), [488530, 900002]); assert.deepEqual(f("m* > 11"), [488530, 900002]);
  assert.deepEqual(f("sfr<1"), [900002]); assert.deepEqual(f("m200>12.2"), [900002]); assert.deepEqual(f("central m*<11"), [900001]);
  assert.deepEqual(f("subhalo 5123"), [512345]); assert.deepEqual(f("zzz"), []);
});
ok("formats: log masses, SFR, tips and card without dot separators", () => {
  assert.equal(lg(1.114e11), "11.05"); assert.equal(lg(null), "–"); assert.equal(lg(0), "–");
  assert.equal(fmtSfr(7.08), "7.1"); assert.equal(fmtSfr(12.4), "12"); assert.equal(fmtSfr(0.04), "0.04"); assert.equal(fmtSfr(null), "–"); assert.equal(fmtSfr(0), "0");
  const t = galaxyTip(LIST[2]), a = galaxyAria(LIST[2]);
  assert.match(t, /Subhalo 900002/); assert.match(t, /satellite/); assert.match(t, /no 3D data/); assert.ok(!/[·•]/.test(t));
  for (const e of LIST) assert.ok(galaxyTip(e).split(/\s+/).length <= 12, galaxyTip(e));                  // the page's tip budget
  assert.match(a, /log M\* 11\.38/); assert.match(a, /SFR 0\.04/); assert.match(a, /log M200c 12\.49/);
  assert.ok(!/[·•]/.test(galaxyCard(LIST[0]))); assert.match(galaxyCard(LIST[0]), /246 kpc/);
});
ok("unlisted g= is reported, listed or absent g= is not (review2_ux S2)", () => {
  const I = galaxyIndex(CFG);
  assert.equal(unlistedGalaxy(I, "#g=999999&id=x", ""), 999999); assert.equal(unlistedGalaxy(I, "#g=900001", ""), null);
  assert.equal(unlistedGalaxy(I, "#id=x", ""), null); assert.equal(unlistedGalaxy(null, "#g=5", ""), null);
  assert.equal(resolveGalaxy(I, "#g=999999", ""), 488530);
});
ok("galaxy switch keeps a comparable sightline (review2_ux S1)", () => {
  const E = [{id: "face_b000_a029_s39", orientation: "face-on", b_kpc: 0.04, azimuth_deg: 29, rank: 1},
    {id: "edge_b050_a090_s1", orientation: "edge-on", b_kpc: 50, azimuth_deg: 90, rank: 9},
    {id: "edge_b060_a010_s2", orientation: "edge-on", b_kpc: 60, azimuth_deg: 10, rank: 3},
    {id: "rand_b051_a080_s3", orientation: "random", b_kpc: 51, azimuth_deg: 80, rank: 2},
    {id: "rand_b049_a200_s4", orientation: "random", b_kpc: 49, azimuth_deg: 200, rank: 5},
    {id: "yours", orientation: "edge-on", b_kpc: 41, azimuth_deg: 90, source: "generated"}];
  const cur = {orientation: "edge-on", b_kpc: 41, azimuth_deg: 90};                 // 0.2 R200c in a 205 kpc halo
  assert.equal(nearestSightline(E, cur, 41 / 205, 250).id, "edge_b050_a090_s1");    // same word, b/R200c, then azimuth
  assert.equal(nearestSightline(E, {orientation: "random", b_kpc: 50, azimuth_deg: 190}, 0.2, 250).id, "rand_b049_a200_s4");
  assert.equal(nearestSightline([], cur, 0.2, 250), null); assert.equal(nearestSightline(E, null, 0.2, 250), null);
  assert.equal(defaultSightline(E, 200).id, "rand_b051_a080_s3");                     // random near 0.25 R200c, best rank
  assert.notEqual(defaultSightline(E, 200).id, "face_b000_a029_s39");
  assert.equal(defaultSightline([], 200), null);
});
ok("spectra source and gas-poor flags in tags, tips, search and card", () => {
  const e = {...LIST[1], src: "sbi", gas_poor: true}, t = {...LIST[0], src: "trident"};
  assert.equal(srcOf(e), "sbi"); assert.equal(srcOf({source: "sbi_cgm"}), "sbi"); assert.equal(srcOf(t), "trident"); assert.equal(srcOf({}), "");
  assert.ok(matchGalaxy(e, "gas-poor") && !matchGalaxy(t, "gas-poor")); assert.ok(matchGalaxy(e, "sbi") && matchGalaxy(t, "trident"));
  assert.match(galaxyTip(e), /gas-poor/); assert.ok(galaxyTip(e).split(/\s+/).length <= 12);
  assert.match(galaxyAria(e), /THOR spectra/); assert.doesNotMatch(galaxyCard(e), /THOR|SBI_CGM/); assert.match(galaxyCard(e), /gas-poor/);   // owner 2026-11-13: no spectra label in the galaxy card
});
console.log(`${n} galaxies_unit checks passed`);
