// Galaxy picker of the TNG50 explorer (galaxy-sample spec, web contract): the page's galaxy index (CFG.galaxies, written
// by scripts/export_tng50_web.py --galaxies), the URL state g=<id>, where a galaxy's pack lives, and the glass popover
// #gxy-pop (search, sort by M*, SFR, M200c or id, filter centrals/satellites, tips).
//
// CFG.galaxies = {default, base, viz_base, list: [{id, label, Mstar, SFR, M200c, R200c, central, mw, m31, n, viz, base?,
//                  src?, gas_poor?}]}   (src: "sbi" | "trident", the galaxy's spectra source; gas_poor: no cold gas disk)
// or null (one galaxy: no picker). The default galaxy keeps the page's legacy data/ paths (CFG.catalog_url, bin_dir,
// components_url, viz); every other galaxy is read from <base><id>/:
//   catalog.json  s/<sid>.bin  components.json  galaxy.json  viz/manifest_v2.json   (cubes from viz_base, {id} replaced)
// The pure part (galaxyIndex, parseGalaxy, packFor, sortGalaxies, matchGalaxy, fmt*) runs in node
// (tests/js/galaxies_unit.mjs); createGalaxyPicker needs a DOM.

const esc = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const ID_OK = /^(?:\d{1,9}|[A-Za-z][A-Za-z0-9_]{1,23})$/;
export const normId = x => (/^\d{1,9}$/.test(String(x ?? "")) ? +x : String(x ?? ""));
export const isFire = e => !!(e && (/^fire/i.test(String(e.sim || e.simKey || "")) || /^m\d|^Romeo|^Juliet|^Romulus|^Remus|^Thelma|^Louise/i.test(String(e.id ?? ""))));
export const isSimba = e => !!(e && (/^simba/i.test(String(e.sim || e.simKey || "")) || /^simba\d+_/i.test(String(e.id ?? ""))) && !/^camels/i.test(String(e.sim || e.id || "")));
export const isAgora = e => !!(e && (/^agora/i.test(String(e.sim || e.simKey || "")) || /^agora_/i.test(String(e.id ?? ""))));
export const isCamels = e => !!(e && (/^camels|eagle|astrid/i.test(String(e.sim || e.simKey || "")) || /^camels_/i.test(String(e.id ?? ""))));
export const isAuriga = e => !!(e && (/^auriga/i.test(String(e.sim || e.simKey || "")) || /^(?:Au(?:\d+|L\d+|D\d+)(?:_L\d+)?|auriga_)/i.test(String(e.id ?? ""))));
export const isTng100 = e => !!(e && (/^tng100/i.test(String(e.sim || e.simKey || "")) || /^tng100_/i.test(String(e.id ?? ""))));
export const isTng300 = e => !!(e && (/^tng300/i.test(String(e.sim || e.simKey || "")) || /^tng300_/i.test(String(e.id ?? ""))));
export const isIllustris = e => !!(e && (/^illustris/i.test(String(e.sim || e.simKey || "")) || /^illustris1?_/i.test(String(e.id ?? ""))) && !/tng|camels/i.test(String(e.sim || e.id || "")));
export function inferSim(e) {
  if (e && e.sim) return String(e.sim);
  const id = String(e?.id ?? e ?? "");
  if (/^m\d|^Romeo|^Juliet|^Romulus|^Remus|^Thelma|^Louise/i.test(id)) return "FIRE-2";
  if (/^simba\d+_/i.test(id)) return "SIMBA";
  if (/^agora_/i.test(id)) return "AGORA";
  if (/^camels_eagle/i.test(id)) return "CAMELS-Swift-EAGLE";
  if (/^camels_astrid/i.test(id)) return "CAMELS-Astrid";
  if (/^camels_simba/i.test(id)) return "CAMELS-SIMBA";
  if (/^camels_crocodile/i.test(id)) return "CAMELS-CROCODILE";
  if (/^camels_gz28/i.test(id)) return "CAMELS-GZ28";
  if (/^camels_/i.test(id)) return "CAMELS-IllustrisTNG";
  if (/^(?:Au(?:\d+|L\d+|D\d+)(?:_L\d+)?|auriga_)/i.test(id)) return "Auriga";
  if (/^tng100_/i.test(id)) return "TNG100-1";
  if (/^tng300_/i.test(id)) return "TNG300-1";
  if (/^illustris1?_/i.test(id)) return "Illustris-1";
  return "TNG50-1";
}
export function inferSimKey(e) {
  if (e && e.simKey && ["tng50", "fire2", "simba", "agora", "camels", "auriga", "tng100", "tng300", "illustris"].includes(e.simKey)) return e.simKey;
  const s = inferSim(e).toLowerCase(), id = String(e?.id ?? e ?? "").toLowerCase();
  if (s.startsWith("camels") || id.startsWith("camels_") || s.includes("eagle") || s.includes("astrid")) return "camels";
  if (s.startsWith("agora") || id.startsWith("agora_")) return "agora";
  if (s.startsWith("simba") || id.startsWith("simba")) return "simba";
  if (s.startsWith("auriga") || isAuriga(e)) return "auriga";
  if (s.startsWith("tng100") || id.startsWith("tng100_")) return "tng100";
  if (s.startsWith("tng300") || id.startsWith("tng300_")) return "tng300";
  if (s.startsWith("illustris") || id.startsWith("illustris")) return "illustris";
  if (s.startsWith("fire") || isFire(e)) return "fire2";
  return "tng50";
}
export const SIM_META = {
  tng50:  {label: "TNG50",  title: "TNG50 sightlines",  groupTitle: "TNG50-1 Milky Way and M31 analogues", msg: "TNG50-1 z = 0 Milky Way and M31 analogues", tip: "Show only TNG50-1 galaxies", topTip: "Switch to IllustrisTNG TNG50-1 galaxies", tag: "TNG50", tagTip: "IllustrisTNG TNG50-1 cosmological simulation", credit: "Simulation: IllustrisTNG TNG50-1 (TNG Collaboration)"},
  fire2:  {label: "FIRE-2", title: "FIRE-2 sightlines", groupTitle: "FIRE-2 zoom-in halos", msg: "FIRE-2 z = 0 zoom-in halos", tip: "Show only FIRE-2 zoom-in halos", topTip: "Switch to FIRE-2 zoom-in halos", tag: "FIRE-2", tagTip: "FIRE-2 cosmological zoom-in simulation", credit: "Simulation: FIRE-2 (FIRE Collaboration)"},
  simba:  {label: "SIMBA",  title: "SIMBA sightlines",  groupTitle: "SIMBA-25 and SIMBA-100 galaxies", msg: "SIMBA-25 and SIMBA-100 z = 0 galaxies", tip: "Show only SIMBA-25 and SIMBA-100 galaxies", topTip: "Switch to SIMBA-25 and SIMBA-100 galaxies", tag: "SIMBA", tagTip: "SIMBA cosmological hydrodynamic simulation (m25n512 and m100n1024)", credit: "Simulation: SIMBA m25n512 & m100n1024 (SIMBA Collaboration)"},
  auriga: {label: "Auriga", title: "Auriga sightlines", groupTitle: "Auriga zoom-in halos", msg: "Auriga Level-3 and Level-4 z = 0 zoom-in halos", tip: "Show only Auriga zoom-in halos", topTip: "Switch to Auriga zoom-in halos", tag: "Auriga", tagTip: "Auriga cosmological magnetohydrodynamic zoom-in simulation", credit: "Simulation: Auriga (Auriga Collaboration)"},
  tng100: {label: "TNG100", title: "TNG100 sightlines", groupTitle: "TNG100-1 galaxies", msg: "TNG100-1 z = 0 Milky Way and L* galaxies", tip: "Show only TNG100-1 galaxies", topTip: "Switch to IllustrisTNG TNG100-1 galaxies", tag: "TNG100", tagTip: "IllustrisTNG TNG100-1 cosmological simulation", credit: "Simulation: IllustrisTNG TNG100-1 (TNG Collaboration)"},
  tng300: {label: "TNG300", title: "TNG300 sightlines", groupTitle: "TNG300-1 galaxies", msg: "TNG300-1 z = 0 massive and group galaxies", tip: "Show only TNG300-1 galaxies", topTip: "Switch to IllustrisTNG TNG300-1 galaxies", tag: "TNG300", tagTip: "IllustrisTNG TNG300-1 cosmological simulation", credit: "Simulation: IllustrisTNG TNG300-1 (TNG Collaboration)"},
  illustris: {label: "Illustris", title: "Illustris sightlines", groupTitle: "Illustris-1 galaxies", msg: "Illustris-1 z = 0 Milky Way and L* galaxies", tip: "Show only Illustris-1 galaxies", topTip: "Switch to Illustris-1 galaxies", tag: "Illustris", tagTip: "Original Illustris-1 cosmological simulation", credit: "Simulation: Illustris-1 (Illustris Collaboration)"},
  agora:  {label: "AGORA",  title: "AGORA sightlines",  groupTitle: "AGORA CosmoRun zoom-in halo", msg: "AGORA z = 0 AREPO Milky Way zoom-in halo", tip: "Show only AGORA CosmoRun zoom-in halos", topTip: "Switch to AGORA CosmoRun zoom-in halo", tag: "AGORA", tagTip: "AGORA CosmoRun AREPO Milky Way zoom-in simulation", credit: "Simulation: AGORA CosmoRun AREPO (AGORA Collaboration)"},
  camels: {label: "CAMELS", title: "CAMELS sightlines", groupTitle: "CAMELS and Swift-EAGLE Milky Way halos", msg: "CAMELS (IllustrisTNG, SIMBA, Astrid, Swift-EAGLE) z = 0 halos", tip: "Show only CAMELS and Swift-EAGLE galaxies", topTip: "Switch to CAMELS (IllustrisTNG, SIMBA, Astrid, Swift-EAGLE) halos", tag: "CAMELS", tagTip: "CAMELS project (IllustrisTNG, SIMBA, Astrid, Swift-EAGLE)", credit: "Simulation: CAMELS & Swift-EAGLE (CAMELS Collaboration)"}
};
export const SIM_ORDER = ["tng50", "fire2", "simba", "auriga", "tng100", "tng300", "illustris", "agora", "camels"];
export const galNoun = e => {
  const sk = inferSimKey(e);
  return sk === "fire2" || sk === "auriga" || sk === "agora" || sk === "camels" ? "Halo" : sk === "simba" ? "Galaxy" : "Subhalo";
};
export const galWord = (e, id) => `${galNoun(e || {id})} ${id ?? e?.id ?? ""}`.trim();

/* ---------------- index ---------------- */
/* -> {default, base, vizBase, list, byId} or null when the config lists fewer than two usable galaxies */
export function galaxyIndex(cfg) {
  const G = cfg && cfg.galaxies;
  if (!G || !Array.isArray(G.list)) return null;
  const list = G.list.filter(e => e && ID_OK.test(String(e.id))).map(e => {
    const id = normId(e.id);
    const sim = inferSim({...e, id});
    const simKey = inferSimKey({...e, id, sim});
    return {...e, id, sim, simKey};
  });
  const byId = new Map(list.map(e => [e.id, e]));
  const def = normId(G.default);
  if (byId.size < 2 || !byId.has(def)) return null;
  const base = typeof G.base === "string" && G.base ? G.base.replace(/\/?$/, "/") : "data/gal/";
  return {default: def, base, vizBase: typeof G.viz_base === "string" && G.viz_base.includes("{id}") ? G.viz_base : null, list, byId};
}

export const normSimKey = s => {
  const v = String(s || "").trim().toLowerCase();
  if (v === "fire" || v === "fire2" || v === "fire-2") return "fire2";
  if (v === "tng" || v === "tng50" || v === "tng50-1") return "tng50";
  if (v === "simba" || v === "simba25" || v === "simba100" || v === "simba-25" || v === "simba-100") return "simba";
  if (v === "auriga" || v === "au" || v === "auriga-l4" || v === "auriga-l3") return "auriga";
  if (v === "tng100" || v === "tng100-1") return "tng100";
  if (v === "tng300" || v === "tng300-1") return "tng300";
  if (v === "illustris" || v === "illustris1" || v === "illustris-1") return "illustris";
  if (v === "agora" || v === "agora-arepo" || v === "agora_arepo") return "agora";
  if (v === "camels" || v === "eagle" || v === "astrid" || v === "camels/eagle" || v === "swift-eagle" || v.startsWith("camels-") || v.startsWith("camels_")) return "camels";
  return "";
};

/* g=<id> from the hash (wins) or the query; null when absent or malformed.
   When gix (index) is given as the 2nd or 3rd argument, also supports #sim=fire2 (picks first matching galaxy if g= is omitted). */
export function parseGalaxy(hash = "", search = "", gix = null) {
  let index = gix, srch = search;
  if (search && typeof search === "object" && Array.isArray(search.list)) { index = search; srch = ""; }
  for (const s of [String(hash).replace(/^#/, ""), String(srch).replace(/^\?/, "")]) {
    const p = new URLSearchParams(s), g = p.get("g"), sim = normSimKey(p.get("sim"));
    if (g != null && ID_OK.test(g.trim())) return normId(g.trim());
    if (sim && index && Array.isArray(index.list)) {
      const hit = index.list.find(e => e.simKey === sim);
      if (hit) return hit.id;
    }
  }
  return null;
}
/* the galaxy to show: the URL's when the index has it, else the default */
export function resolveGalaxy(index, hash, search) {
  if (!index) return null;
  const g = parseGalaxy(hash, search, index);
  return g != null && index.byId.has(g) ? g : index.default;
}
/* the g=<id> the URL asks for when the index does not list it (a typo, a galaxy outside the sample or not published
   yet), else null: the page then says it shows the default galaxy instead (review2_ux S2) */
export function unlistedGalaxy(index, hash, search) {
  if (!index) return null;
  const g = parseGalaxy(hash, search);
  return g != null && !index.byId.has(g) ? g : null;
}
/* the hash prefix for a galaxy: "" for the default (URLs of the default galaxy are unchanged), else "g=<id>&" (or "sim=<simKey>&g=<id>&" for non-TNG50 simulations) */
export const galaxyHashPart = (index, id) => {
  if (!index || id == null || id === index.default) return "";
  const e = index.byId && index.byId.get(normId(id));
  const sk = e && e.simKey;
  return sk && sk !== "tng50" ? `sim=${sk}&g=${id}&` : `g=${id}&`;
};

/* where a galaxy's data lives. legacy = the page's own config for the default galaxy (catalog_url, bin_dir,
   components_url, viz). -> {id, legacy, catalog_url, bin_dir, components_url, galaxy_url, viz} */
/* entry.base: absolute https URL or relative path ending in "/" (no scheme other than https; no "..") */
export function packBase(e) {
  const v = e && typeof e.base === "string" ? e.base : "";
  if (!v || !v.endsWith("/") || v.includes("..")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^https:\/\//i.test(v)) return null;
  return v;
}

export function packFor(index, id, legacy) {
  if (!index || id === index.default || !index.byId.has(id)) {
    return {id: index ? index.default : null, legacy: true, catalog_url: legacy.catalog_url, bin_dir: legacy.bin_dir,
      components_url: legacy.components_url, galaxy_url: null, viz: legacy.viz || null};
  }
  // per-galaxy base (hosting index: packs sharded over several HF datasets) wins over the shared <base><id>/
  const e = index.byId.get(id), b = packBase(e) || index.base + id + "/";
  const viz = e.viz ? {manifest_url: b + "viz/manifest_v2.json", base: index.vizBase ? index.vizBase.split("{id}").join(String(id)) : b + "viz/",
    fallback_base: null, dataset: null} : null;
  return {id, legacy: false, catalog_url: b + "catalog.json", bin_dir: b + "s/", components_url: b + "components.json",
    galaxy_url: b + "galaxy.json", viz};
}

/* ---------------- formatting ---------------- */
export const lg = x => (Number.isFinite(+x) && +x > 0 ? (Math.log10(+x)).toFixed(2) : "–");
export const fmtSfr = x => (!Number.isFinite(+x) || x === null ? "–" : +x >= 10 ? String(Math.round(+x)) : +x >= 0.1 ? (+x).toFixed(1) : +x > 0 ? (+x).toFixed(2) : "0");
export const kindWord = e => (e.central === true ? "central" : e.central === false ? "satellite" : "");
/* the spectra source of an index entry or a catalogue's spectra_source block: "sbi" | "trident" | "" (unknown) */
export const srcOf = x => { const v = String((x && (x.src ?? x.source)) || "").toLowerCase(); return v.startsWith("sbi") ? "sbi" : v === "trident" ? "trident" : ""; };
export const SRC_WORD = {sbi: "THOR spectra", trident: "Trident spectra"};
/* the compact properties of a galaxy (an index entry) for the chat's tools and page snapshot: log masses and SFR rounded,
   the spectra source in words */
export function galaxySummary(e) {
  if (!e) return null;
  const L = x => (Number.isFinite(+x) && +x > 0 ? +Math.log10(+x).toFixed(2) : null), s = srcOf(e);
  return {id: normId(e.id), sim: inferSim(e), logMstar: L(e.Mstar), logM200c: L(e.M200c), R200c_kpc: Number.isFinite(+e.R200c) && +e.R200c > 0 ? Math.round(+e.R200c) : null,
    SFR: e.SFR == null || !Number.isFinite(+e.SFR) ? null : +(+e.SFR).toPrecision(3), central: typeof e.central === "boolean" ? e.central : null,
    gas_poor: !!e.gas_poor, spectra: s === "sbi" ? "THOR" : s === "trident" ? "Trident" : null, n_sightlines: Number.isFinite(+e.n) && e.n !== null ? +e.n : null,
    has_3d: !!e.viz};
}
const simBadgeName = e => {
  const sk = inferSimKey(e);
  return sk === "tng50" ? "" : (SIM_META[sk]?.tag || inferSim(e));
};
/* the full description (aria-label of a row) and the short tip (12 words at most, the page's tip budget) */
export function galaxyAria(e) {
  if (!e) return "";
  const p = [galWord(e), simBadgeName(e), kindWord(e), Number.isFinite(+e.Mstar) && e.Mstar ? `log M* ${lg(e.Mstar)}` : "",
    e.SFR != null ? `SFR ${fmtSfr(e.SFR)} M⊙/yr` : "", Number.isFinite(+e.M200c) && e.M200c ? `log M200c ${lg(e.M200c)}` : "",
    e.n ? `${e.n} sightlines` : "", srcOf(e) ? SRC_WORD[srcOf(e)] : "", e.gas_poor ? "gas-poor, little cold gas" : "",
    e.viz ? "" : "no 3D data"].filter(Boolean);
  return p.join(", ");
}
export function galaxyTip(e) {
  if (!e) return "Pick a galaxy across TNG50, FIRE-2, SIMBA, AGORA and CAMELS";
  return [galWord(e), simBadgeName(e), kindWord(e), e.n ? `${e.n} sightlines` : "", e.gas_poor ? "gas-poor" : "", e.viz ? "" : "no 3D data"].filter(Boolean).join(", ");
}

/* ---------------- sort and search ---------------- */
export const SORTS = {Mstar: "stellar mass", SFR: "star formation rate", M200c: "halo mass", id: "subhalo id"};
/* stable sort; missing values last in either direction */
export function sortGalaxies(list, key = "Mstar", dir = -1) {
  const v = e => (key === "id" ? e.id : Number.isFinite(+e[key]) && e[key] !== null ? +e[key] : null);
  return list.map((e, i) => [e, i]).sort(([a, i], [b, j]) => {
    const x = v(a), y = v(b);
    if (x === null || y === null) return x === null && y === null ? i - j : x === null ? 1 : -1;
    if (key === "id") {
      const nx = typeof x === "number", ny = typeof y === "number";
      if (nx && ny) return (x - y) * dir || i - j;
      if (nx !== ny) return (nx ? -1 : 1) * dir;
      const cmp = String(x).localeCompare(String(y), undefined, {numeric: true});
      return cmp * dir || i - j;
    }
    return (x - y) * dir || i - j;
  }).map(([e]) => e);
}
/* query terms (AND): digits match the subhalo id as a prefix; "central"/"cen", "satellite"/"sat", "mw", "m31" and "3d"
   match flags; "m*>10.8", "sfr<1", "m200>12" compare (log masses, linear SFR); other words match the label */
const CMP = /^(m\*|mstar|ms|sfr|m200c?|mh)(<=|>=|<|>|=)(-?\d+(?:\.\d+)?)$/;
export function matchGalaxy(e, q) {
  const terms = String(q || "").toLowerCase().replace(/\s*(<=|>=|<|>|=)\s*/g, "$1").split(/\s+/).filter(Boolean);
  const sk = inferSimKey(e);
  return terms.every(t => {
    if (/^\d+$/.test(t)) return String(e.id).startsWith(t);
    const m = t.match(CMP);
    if (m) {
      const k = m[1].startsWith("sfr") ? "SFR" : m[1].startsWith("m2") || m[1] === "mh" ? "M200c" : "Mstar";
      const x = k === "SFR" ? (e.SFR == null ? NaN : +e.SFR) : +lg(e[k]), y = +m[3];
      if (!Number.isFinite(x)) return false;
      return {"<": x < y, ">": x > y, "<=": x <= y, ">=": x >= y, "=": Math.abs(x - y) < 0.005}[m[2]];
    }
    if (t === "sim:all") return true;
    if (t.startsWith("sim:")) {
      const want = normSimKey(t.slice(4));
      return want ? sk === want : false;
    }
    if (t === "fire" || t === "fire2" || t === "fire-2") return sk === "fire2";
    if (t === "tng" || t === "tng50" || t === "tng50-1") return sk === "tng50";
    if (t === "simba" || t === "simba25" || t === "simba100" || t === "simba-25" || t === "simba-100") return sk === "simba" || String(e.id || "").toLowerCase().includes("simba");
    if (t === "auriga") return sk === "auriga";
    if (t === "tng100" || t === "tng100-1") return sk === "tng100";
    if (t === "tng300" || t === "tng300-1") return sk === "tng300";
    if (t === "illustris" || t === "illustris1" || t === "illustris-1") return sk === "illustris";
    if (t === "agora") return sk === "agora";
    if (t === "camels" || t === "eagle" || t === "astrid" || t === "swift-eagle") return sk === "camels" && (t === "camels" || `${e.id || ""} ${e.sim || ""} ${e.label || ""}`.toLowerCase().includes(t));
    if (t === "central" || t === "cen" || t === "centrals") return e.central === true;
    if (t === "satellite" || t === "sat" || t === "satellites") return e.central === false;
    if (t === "mw") return e.mw === true;
    if (t === "m31") return e.m31 === true;
    if (t === "3d") return !!e.viz;
    if (t === "gas-poor" || t === "poor") return e.gas_poor === true;
    if (t === "sbi" || t === "trident") return srcOf(e) === t;
    const hay = `${e.id || ""} ${e.label || ""} ${e.sim || ""}`.toLowerCase();
    return hay.includes(t);
  });
}
export function filterGalaxies(list, q = "", filter = "all", sim = "all") {
  const sk = sim === "all" || !sim ? "all" : (normSimKey(sim) || sim);
  return (list || []).filter(e => {
    const esk = inferSimKey(e);
    if (sk !== "all" && esk !== sk) return false;
    if (filter === "central" && e.central !== true) return false;
    if (filter === "satellite" && e.central !== false) return false;
    return matchGalaxy(e, q);
  });
}

/* ---------------- popover ---------------- */
const MAX_ROWS = 400;
const COLS = [["id", "id", "Galaxy or subhalo id; click to sort"], ["Mstar", "log M*", "Stellar mass, log M⊙; click to sort, again to reverse"],
  ["SFR", "SFR", "Star formation rate, M⊙/yr; click to sort, again to reverse"], ["M200c", "log M200", "Halo mass M200c, log M⊙; click to sort, again to reverse"]];
function simTagHtml(e) {
  const sk = inferSimKey(e);
  if (sk === "tng50") return "";
  const m = SIM_META[sk];
  const label = sk === "camels" && /eagle/i.test(String(e.sim || e.id || "")) ? "EAGLE"
    : sk === "camels" && /astrid/i.test(String(e.sim || e.id || "")) ? "Astrid"
    : (m ? m.tag : inferSim(e));
  const tip = m ? m.tagTip : "Cosmological simulation";
  return `<span class="tag" data-tip="${esc(tip)}">${esc(label)}</span>`;
}
function tags(e) {
  const t = [];
  const st = simTagHtml(e);
  if (st) t.push(st);
  if (e.central === false) t.push('<span class="tag" data-tip="A satellite: not the central galaxy of its halo">sat</span>');
  if (e.m31 === true) t.push('<span class="tag" data-tip="M31-like in the sample definition">M31</span>');
  else if (e.mw === true) t.push('<span class="tag" data-tip="Milky Way-like in the sample definition">MW</span>');
  if (e.gas_poor === true) t.push('<span class="tag" data-tip="Little cold gas: expect weak low-ion absorption">gas-poor</span>');
  if (!e.viz) t.push('<span class="tag dim" data-tip="No 3D data published for this galaxy yet">no 3D</span>');
  return t.join("");
}
/* the current galaxy's card: id, kind and its numbers (two spaces between fields in the text form, no dot separators) */
export function galaxyCard(e) {
  if (!e) return "";
  const kv = (k, v, tip) => `<span class="pv" data-tip="${esc(tip)}"><i>${k}</i>${esc(v)}</span>`;
  const head = `${galNoun(e)} ${e.id}`;
  return `<span class="gxid">${esc(head)}</span>${simTagHtml(e)}${kindWord(e) ? `<span class="gxk">${kindWord(e)}</span>` : ""}` +
    kv("log M*", lg(e.Mstar), "Stellar mass, log M⊙") + kv("SFR", fmtSfr(e.SFR), "Star formation rate, M⊙/yr") +
    kv("log M200c", lg(e.M200c), "Halo mass M200c, log M⊙") + (Number.isFinite(+e.R200c) && e.R200c ? kv("R200c", `${Math.round(+e.R200c)} kpc`, "Halo radius R200c") : "") +
    (e.gas_poor ? '<span class="gxk" data-tip="Little cold gas: expect weak low-ion absorption">gas-poor</span>' : "");
}

/* ---------------- sightline matching across galaxies (review2_ux S1) ---------------- */
const orientWord = e => (e && e.orientation) || "random";
/* the entry of `entries` closest to the sightline `cur` of the previous galaxy (rhoCur = its b/R200c): same orientation
   word first, then the impact parameter in units of R200c and the azimuth from the projected major axis; null without
   entries. Library rows only (no custom rays). */
export function nearestSightline(entries, cur, rhoCur, R200c) {
  const R = +R200c, lib = (entries || []).filter(e => e && e.orientation && e.orientation !== "custom" && e.source !== "generated" && Number.isFinite(+e.b_kpc));
  if (!lib.length || !cur || !(R > 0) || !Number.isFinite(+rhoCur)) return null;
  const az0 = +cur.azimuth_deg || 0, w0 = orientWord(cur);
  let best = null, bd = Infinity;
  for (const e of lib) {
    const daz = Math.abs(((+e.azimuth_deg || 0) - az0 + 540) % 360 - 180);
    const d = (orientWord(e) === w0 ? 0 : 100) + Math.abs(+e.b_kpc / R - rhoCur) / 0.05 + daz / 30;
    if (d < bd || (d === bd && String(e.id) < String(best.id))) { bd = d; best = e; }
  }
  return best;
}
/* a galaxy's opening sightline when nothing is carried over: a random-orientation ray near 0.25 R200c (mid CGM, not the
   b ~ 0 disk-centre rays that sort first), the best ranked of the closest ones */
export function defaultSightline(entries, R200c, rho = 0.25) {
  const R = +R200c, lib = (entries || []).filter(e => e && e.orientation && e.orientation !== "custom" && e.source !== "generated" && Number.isFinite(+e.b_kpc));
  if (!lib.length || !(R > 0)) return null;
  const pref = lib.filter(e => e.orientation === "random"), pool = pref.length ? pref : lib;
  const key = e => [Math.round(Math.abs(+e.b_kpc / R - rho) / 0.025), Number.isFinite(+e.rank) && e.rank !== null ? +e.rank : 1e9, String(e.id)];
  return pool.slice().sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); })[0];
}

/* els: {pop, cur, search, filter, head, list, count}; opts: {index, current() -> id, onPick(id)} */
export function createGalaxyPicker(els, opts) {
  let view = [], hl = -1, sort = {key: "Mstar", dir: -1}, simFilter = "all";
  const shown = () => view.slice(0, MAX_ROWS);
  const allList = opts.index.list || [];
  const counts = {};
  for (const sk of SIM_ORDER) counts[sk] = 0;
  for (const e of allList) {
    const sk = inferSimKey(e);
    counts[sk] = (counts[sk] || 0) + 1;
  }
  const activeSimKeys = SIM_ORDER.filter(sk => counts[sk] > 0);
  const sims = new Set(activeSimKeys);
  const multiSim = sims.size > 1;
  let simBar = els.pop ? els.pop.querySelector("#gxy-sim") : null;
  if (multiSim && els.pop && !simBar) {
    simBar = document.createElement("select");
    simBar.id = "gxy-sim";
    simBar.setAttribute("aria-label", "Simulation filter");
    simBar.dataset.tip = "Filter galaxies by simulation suite";
    const items = [
      ["all", `all sims (${allList.length})`],
      ...activeSimKeys.map(sk => [sk, `${SIM_META[sk].label} (${counts[sk]})`])
    ];
    simBar.innerHTML = items.map(([v, lab]) => `<option value="${v}">${esc(lab)}</option>`).join("");
    const fl = els.pop.querySelector(".fl"), filt = els.pop.querySelector("#gxy-filter");
    if (fl && filt) fl.insertBefore(simBar, filt);
    else if (fl) fl.appendChild(simBar);
    else els.pop.prepend(simBar);
  }
  const msgEl = els.pop ? els.pop.querySelector(".galf .msg") : null;
  function updateMsg() {
    if (!msgEl) return;
    if (!multiSim) {
      const onlySk = activeSimKeys[0] || "tng50";
      msgEl.textContent = SIM_META[onlySk]?.msg || "TNG50-1 z = 0 Milky Way and M31 analogues";
      return;
    }
    msgEl.textContent = simFilter !== "all" && SIM_META[simFilter]
      ? SIM_META[simFilter].msg
      : "TNG50, FIRE-2, SIMBA, AGORA and CAMELS z = 0 galaxies grouped by simulation";
  }
  els.head.innerHTML = COLS.map(([k, lab, tip]) => `<button type="button" class="gxs" data-sort="${k}" data-tip="${esc(tip)}" aria-sort="none">${lab}<b aria-hidden="true"></b></button>`).join("") + "<span></span>";
  function row(e, i, cur) {
    const idHtml = multiSim ? `<i class="gxn">${esc(galNoun(e))} </i>${esc(e.id)}` : esc(e.id);
    return `<li role="option" id="gxy-opt-${i}" data-id="${esc(e.id)}" aria-selected="${e.id === cur}" aria-label="${esc(galaxyAria(e))}" data-tip="${esc(galaxyTip(e))}"${i === hl ? ' class="hl"' : ""}>` +
      `<span class="gxid">${idHtml}</span><span class="num">${lg(e.Mstar)}</span><span class="num">${fmtSfr(e.SFR)}</span><span class="num">${lg(e.M200c)}</span><span class="gxt">${tags(e)}</span></li>`;
  }
  function render() {
    const f = els.filter.value, all = opts.index.list, cur = opts.current();
    const filtered = filterGalaxies(all, els.search.value, f, simFilter);
    if (multiSim && simFilter === "all") {
      const curE = opts.index.byId.get(cur), curSk = curE ? inferSimKey(curE) : "tng50";
      const order = [curSk, ...activeSimKeys.filter(sk => sk !== curSk)];
      const groups = order.map(sk => [
        SIM_META[sk]?.groupTitle || sk,
        sortGalaxies(filtered.filter(e => inferSimKey(e) === sk), sort.key, sort.dir)
      ]);
      view = groups.flatMap(([, g]) => g);
      if (hl >= shown().length) hl = shown().length - 1;
      let idx = 0;
      const htmlParts = [];
      for (const [title, g] of groups) {
        if (!g.length) continue;
        htmlParts.push(`<li class="gxy-sec" role="presentation"><span>${esc(title)}</span><b>${g.length}</b></li>`);
        for (const e of g) {
          if (idx >= MAX_ROWS) break;
          htmlParts.push(row(e, idx++, cur));
        }
      }
      els.list.innerHTML = htmlParts.length ? htmlParts.join("")
        : '<li class="empty" role="presentation">No match<button type="button" class="lk" data-act="clear" data-tip="Clear the search and the filter">clear</button></li>';
    } else {
      view = sortGalaxies(filtered, sort.key, sort.dir);
      if (hl >= shown().length) hl = shown().length - 1;
      els.list.innerHTML = view.length ? shown().map((e, i) => row(e, i, cur)).join("")
        : '<li class="empty" role="presentation">No match<button type="button" class="lk" data-act="clear" data-tip="Clear the search and the filter">clear</button></li>';
    }
    els.count.textContent = `${view.length} of ${all.length}`;
    updateMsg();
    for (const b of els.head.querySelectorAll("[data-sort]")) { const on = b.dataset.sort === sort.key;
      b.setAttribute("aria-sort", on ? (sort.dir > 0 ? "ascending" : "descending") : "none"); b.querySelector("b").textContent = on ? (sort.dir > 0 ? "↑" : "↓") : ""; }
    els.cur.innerHTML = galaxyCard(opts.index.byId.get(cur));
    if (hl >= 0) els.search.setAttribute("aria-activedescendant", `gxy-opt-${hl}`); else els.search.removeAttribute("aria-activedescendant");
  }
  function setSort(key) { sort = sort.key === key ? {key, dir: -sort.dir} : {key, dir: key === "id" ? 1 : -1}; hl = -1; render(); }
  function setSim(s) {
    const k = s === "all" ? "all" : (normSimKey(s) || s);
    simFilter = (k === "all" || SIM_ORDER.includes(k)) ? k : "all";
    if (simBar) simBar.value = simFilter;
    hl = -1; render();
  }
  function clear() { els.search.value = ""; els.filter.value = "all"; setSim("all"); els.search.focus(); }
  if (simBar) simBar.addEventListener("change", ev => { if (ev.target) setSim(ev.target.value); });
  els.head.addEventListener("click", ev => { const b = ev.target.closest("[data-sort]"); if (b) setSort(b.dataset.sort); });
  els.list.addEventListener("click", ev => { if (ev.target.closest('[data-act="clear"]')) { setTimeout(clear); return; }
    const li = ev.target.closest("li[data-id]"); if (li) opts.onPick(normId(li.dataset.id)); });
  els.search.addEventListener("input", () => { hl = -1; render(); });
  els.filter.addEventListener("change", () => { hl = -1; render(); });
  els.search.addEventListener("keydown", ev => {
    const n = shown().length;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); if (!n) return;
      const d = ev.key === "ArrowDown" ? 1 : -1, cur = shown().findIndex(e => e.id === opts.current());
      hl = hl >= 0 ? (hl + d + n) % n : cur >= 0 ? (cur + d + n) % n : d > 0 ? 0 : n - 1; render();
      els.list.querySelector("li.hl")?.scrollIntoView({block: "nearest"}); }
    else if (ev.key === "Enter") { ev.preventDefault(); const e = shown()[hl >= 0 ? hl : 0]; if (e) opts.onPick(e.id); } });
  return {render, clear, setSort, setSim, get sim() { return simFilter; }, get sort() { return {...sort}; }, get visible() { return view; },
    onOpen() { hl = -1; render(); const sel = els.list.querySelector('li[aria-selected="true"]');
      if (sel) els.list.scrollTop = Math.max(0, sel.offsetTop - (els.list.clientHeight - sel.offsetHeight) / 2); }};
}
export const mountGalaxyPicker = createGalaxyPicker;
