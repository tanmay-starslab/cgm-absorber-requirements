#!/usr/bin/env python3
"""Build the static TNG50 sightline explorer under docs/tng50/ from the sightline library.

    python scripts/export_tng50_web.py [--library DIR] [--out DIR] [--space-url URL] [--local-url URL]
                                       [--include-generated] [--prune] [--components FILE] [--viz-dir DIR]
                                       [--viz-base URL] [--viz-local] [--chat] [--ids a,b,...] [--allow-v1]
                                       [--galaxies-root DIR --galaxies all|id,id,... [--gal-base URL]
                                        [--gal-viz-base URL-with-{id}] [--pack-out DIR]]

Reads <library>/catalog.json and <library>/web/<id>.bin (or generated/<id>.bin), as written by
deploy/data/build_library.py and the server; writes
  <out>/data/catalog.json      entries that have a valid web binary (library ones by default)
  <out>/data/s/<id>.bin        byte copies of the web binaries
  <out>/index.html             docs/tng50/_template.html with a small config (CFG v3: the ion registry's page_ions,
                               bands, S/N range and defaults) injected at /*__DATA__*/null
  <out>/data/components.json   byte copy of --components (default <library>/components.json), if present
  <out>/data/viz/manifest_v2.json  byte copy of <viz-dir>/manifest_v2.json (default <library>/viz), validated with
                               tngsight.vizpack; the cubes themselves are NOT copied: the page fetches them from the
                               public HF dataset (CFG.viz.base), falling back to data/viz/ (design-2b §5.10, §6.4)
  <out>/data/luts/luts.json    copy of docs/tng50/data/luts/luts.json (only when --out is not docs/tng50)
  <out>/js/*.js, <out>/css/*.css  the page's modules and stylesheet (copied from docs/tng50 when --out is elsewhere)
--viz-local also copies every cube into <out>/data/viz/ and points CFG.viz.base there (refused for docs/tng50:
big cubes never go into git). --prune also deletes <out>/data/vol/ (the Phase-2 volumes).
Every exported entry carries p0/p1 (ray start/end, physical kpc from the galaxy centre, box axes, 0.01 kpc), read
from the npz `geom` member when the catalogue lacks them, and has_components. Custom (cust_) ids are exported only
with --include-generated.
Web binaries must be TNGS v2 (12 lines keyed by registry key); v1 binaries (O VI, H I Lyβ, C III) are accepted only with
--allow-v1, and an export that would mix v1 and v2 binaries is refused. The catalogue is passed through (v2 rows).
Multi-galaxy (galaxy-sample spec, web contract): --galaxies adds galaxies of the pipeline's data root (<id>/galaxy.json,
<id>/library/{catalog.json,web/,components.json}, <id>/viz/manifest_v2.json) as packs under --pack-out (default
<out>/data/gal; refused inside docs/tng50): <id>/catalog.json, <id>/s/<sid>.bin, <id>/components.json, <id>/galaxy.json
(public fields + disk frame) and <id>/viz/manifest_v2.json (cubes too with --viz-local), and writes the picker index
CFG.galaxies = {default, base (--gal-base), viz_base (--gal-viz-base or null), list: [{id, label, Mstar, SFR, M200c,
R200c, central, mw, m31, n, viz, src?, gas_poor?, base?}]}. The default galaxy (--library) keeps data/ and CFG.viz exactly
as before; without --galaxies CFG.galaxies is null and the page shows no galaxy picker. Galaxies that are not ready, or
whose check.json fails (unless --allow-unchecked), are reported, not listed. --gal-index (upload_galaxies.py --index-out)
gives each galaxy its own base (packs sharded over several HF datasets) and lists only the galaxies it holds.
The library is only read. The public Space URL comes from --space-url or the TNG_SPACE_URL environment
variable; without one (or with the literal placeholder "TNG_SPACE_URL") it is left out of the page's
backend list and a warning is printed: the published page is then library-only for every visitor who
is not running the laptop server."""
from __future__ import annotations
import argparse, json, os, re, shutil, struct, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
MARK = "/*__DATA__*/null"
PLACEHOLDER = "TNG_SPACE_URL"
URL_RE = re.compile(r"^https?://[^\s/]+")
ID_RE = re.compile(r"^((face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?|cust_[0-9a-f]{10})$")   # = server.storage.ID_RE (design-2 §2)
GAL_PUBLIC = ("sim", "snapshot", "redshift", "subhalo_id", "central", "R200c_kpc", "M200c_Msun", "Mstar_Msun", "SFR_Msun_yr")
FITTER = {"worker": "js/fitworker.js", "budget_ms": 300, "cap_ms": 1500, "version": "fit/1"}
NPZ_PREFIX = "cgm_sid488530_"
THREE_VERSION = "0.169.0"
WEBLLM = {"webllm": "0.2.85", "model": "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"}
CUSTOM = {"r_max_kpc": 395, "l_min_kpc": 20, "l_max_kpc": 800}
VIZ_DATASET = "tanmay-starslab/tng50-sub488530-viz"
VIZ_BASE = f"https://huggingface.co/datasets/{VIZ_DATASET}/resolve/main/"
VIZ_FALLBACK = "data/viz/"
VIZ_MANIFEST = "data/viz/manifest_v2.json"
GAL_BASE = "data/gal/"     # galaxy packs, relative to the page (an HF dataset base when published)
DOCS_OUT = ROOT / "docs" / "tng50"
PAGE_LAYOUT = "1"          # the page opens on one large case (owner's pick, Phase 3); 2 R, 2 S/N and 2x2 are one click away


def galaxy_frame() -> dict:
    """Disk frame + R200c for the 3D view, from the package galaxy JSON (center_kpc is the frame origin)."""
    g = json.loads((ROOT / "tngsight" / "galaxy_488530.json").read_text())
    return {k: g[k] for k in ("Lhat", "xhat", "yhat", "R200c_kpc")}


def find_npz(lib: Path, sid: str, prefix: str = NPZ_PREFIX) -> Path | None:
    for p in (lib / "sightlines" / f"{prefix}{sid}.npz", lib / "sightlines" / f"{sid}.npz",
              lib / "generated" / f"{prefix}{sid}.npz", lib / "generated" / f"{sid}.npz"):
        if p.is_file():
            return p
    return None


def npz_endpoints(path: Path) -> tuple[list, list]:
    """(p0, p1) = start/end - center_kpc in physical kpc, 0.01 kpc, from the npz `geom` member only.
    tngsight.library.npz_endpoints when available (U_ray's helper); otherwise the same math here:
    start_ckpch / TNG_H - center_kpc (never center_ckpch / TNG_H, design-2 §2)."""
    try:
        from tngsight.library import npz_endpoints as f
        return f(path)
    except ImportError:
        pass
    import numpy as np
    g = json.loads((ROOT / "tngsight" / "galaxy_488530.json").read_text())
    with np.load(path, allow_pickle=False) as d:
        geom = json.loads(str(d["geom"]))
    c, h = np.asarray(g["center_kpc"], float), float(g["TNG_H"])
    if "start_kpc" in geom and "end_kpc" in geom:
        a, b = np.asarray(geom["start_kpc"], float), np.asarray(geom["end_kpc"], float)
    else:
        a, b = np.asarray(geom["start_ckpch"], float) / h, np.asarray(geom["end_ckpch"], float) / h
    r = lambda v: [round(float(x), 2) + 0.0 for x in v]                       # noqa: E731
    return r(a - c), r(b - c)


def copy_if_changed(src: Path, dst: Path) -> bool:
    data = src.read_bytes()
    if dst.is_file() and dst.stat().st_size == len(data) and dst.read_bytes() == data:
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, dst)
    return True


def _validate_manifest_v2(man: dict, base_dir: Path | None = None) -> None:
    """tngsight.vizpack.validate_manifest_v2 (CORE, design-2b §3.2). ImportError if vizpack is missing."""
    from tngsight import vizpack
    vizpack.validate_manifest_v2(man, base_dir=base_dir)


def manifest_files(man: dict) -> list[str]:
    """Every cube file path (4 WebP parts + gz per cube) listed in a manifest_v2 dict, in manifest order."""
    out = []
    cubes = [c for f in (man.get("gas") or {}).get("fields", {}).values() for c in (f.get("cubes") or {}).values()]
    cubes += list(((man.get("stars") or {}).get("cubes") or {}).values())
    for c in cubes:
        out += list(c["webp"]["paths"]) + [c["gz"]["path"]]
    return out


def export_viz(viz_dir: Path, out: Path, base: str = VIZ_BASE, local: bool = False,
               sub: str = "data/viz") -> tuple[dict | None, str]:
    """Validate <viz_dir>/manifest_v2.json and copy it (only it, unless `local`) to <out>/data/viz/.
    -> (CFG.viz or None, message). Any problem -> None: the 3D tab then says the data is not published."""
    man_p = viz_dir / "manifest_v2.json"
    if not man_p.is_file():
        return None, f"no viz manifest at {man_p} (3D tab will say '3D data not published')"
    try:
        man = json.loads(man_p.read_text())
        if not isinstance(man, dict):
            raise ValueError("not a JSON object")
        _validate_manifest_v2(man, viz_dir if local else None)
    except ImportError as exc:
        return None, f"{man_p}: cannot validate, tngsight.vizpack not importable ({exc}); viz: null"
    except (ValueError, KeyError, TypeError) as exc:
        return None, f"{man_p}: invalid manifest_v2 ({exc}); viz: null"
    out_viz = out / sub
    w = copy_if_changed(man_p, out_viz / "manifest_v2.json")
    msg = f"viz: manifest_v2 ({'written' if w else 'unchanged'}) -> {out_viz / 'manifest_v2.json'}"
    if local:
        files = manifest_files(man)
        n = sum(copy_if_changed(viz_dir / rel, out_viz / rel) for rel in files)
        total = sum((viz_dir / rel).stat().st_size for rel in files)
        msg += f"; --viz-local: {len(files)} cube files, {total / 1e6:.1f} MB ({n} written)"
        base = VIZ_FALLBACK
    else:
        msg += f"; cubes from {base}"
    # fallback_base only where cubes really sit under <out>/data/viz/ (--viz-local): elsewhere (docs/tng50 on Pages, which
    # git-ignores data/viz/*/) every fallback request would be a guaranteed 404 before the "host unreachable" message
    fallback = VIZ_FALLBACK if local else None
    return {"manifest_url": VIZ_MANIFEST, "base": base, "fallback_base": fallback, "dataset": VIZ_DATASET}, msg


def default_library() -> Path:
    try:
        from tngsight.config import library_dir
        return library_dir()
    except Exception:                                    # noqa: BLE001 - tngsight optional for this script
        # tngsight.config's rule: TNG_LIBRARY_DIR, else $TNG_WORK/data/library (TNG_WORK default /Volumes/cgm_work)
        work = Path(os.environ.get("TNG_WORK") or "/Volumes/cgm_work")
        return Path(os.environ.get("TNG_LIBRARY_DIR") or work / "data" / "library")


def registry():
    """tngsight.ions (the ion registry; pure, no numpy)."""
    from tngsight import ions
    return ions


def check_bin(blob: bytes, sid: str, allow_v1: bool = False) -> int:
    """Header + length check of a web binary (Phase-3 design §2.4; no numpy needed). Returns the version (2, or 1
    when allow_v1). v2: 16-byte header, per line char[8] registry key (unique), u32 n (<= 20001), u32 0, 3 f64,
    u16[n]; v1: 8-byte header, 3 lines of u32 n + 4 f64 + u16[n]."""
    if len(blob) < 8 or blob[:4] != b"TNGS":
        raise ValueError(f"{sid}: bad magic")
    ver, nl, _ = struct.unpack_from("<BBH", blob, 4)
    if ver == 1:
        if not allow_v1:
            raise ValueError(f"{sid}: TNGS v1 (pass --allow-v1 to export v1 binaries)")
        if nl != 3:
            raise ValueError(f"{sid}: version 1, {nl} lines")
        off = 8
        for _ in range(nl):
            if off + 36 > len(blob):
                raise ValueError(f"{sid}: truncated")
            n = struct.unpack_from("<I", blob, off)[0]
            off += 36 + 2 * n
    elif ver == 2:
        keys = registry().KEYS
        if not 1 <= nl <= len(keys) or len(blob) < 16:
            raise ValueError(f"{sid}: version 2, {nl} lines")
        off, seen = 16, set()
        for _ in range(nl):
            if off + 40 > len(blob):
                raise ValueError(f"{sid}: truncated")
            kb, n, _r = struct.unpack_from("<8sII", blob, off)
            k = kb.rstrip(b"\0").decode("ascii", "replace")
            if k not in keys or k in seen:
                raise ValueError(f"{sid}: line key {k!r} unknown or repeated")
            if n > 20001:
                raise ValueError(f"{sid}: {k} has {n} samples (> 20001)")
            seen.add(k)
            off += 40 + 2 * n
    else:
        raise ValueError(f"{sid}: version {ver}")
    if off != len(blob):
        raise ValueError(f"{sid}: length {len(blob)} != {off}")
    return ver


def find_bin(lib: Path, sid: str) -> Path | None:
    for p in (lib / "web" / f"{sid}.bin", lib / "generated" / f"{sid}.bin"):
        if p.is_file():
            return p
    return None


def page_config(cat: dict, backends: list, default_id: str | None, n: int, viz: dict | None = None,
                chat: bool = False, galaxies: dict | None = None) -> dict:
    """CFG v3 (Phase-3 design §7): the ion registry (page_ions, bands, snr, defaults) + the existing page keys."""
    I = registry()
    gal = {k: cat.get("galaxy", {}).get(k) for k in GAL_PUBLIC if k in cat.get("galaxy", {})}
    d = I.DEFAULTS
    defaults = {"id": default_id, "ions": list(d["ions"]), "layout": PAGE_LAYOUT,
                "R": {b: list(v["R"]["pair"]) for b, v in I.BANDS.items()}, "sn": list(I.SNR["pair"]),
                "vc": 0, "vhw": d["vhw_kms"], "seed": 0, "intrinsic": True, "fit": True}
    return {"version": 3, "catalog_url": "data/catalog.json", "bin_dir": "data/s/", "n_static": n, "backends": backends,
            "galaxy": gal, "ions": I.page_ions(), "bands": json.loads(json.dumps(I.BANDS)),
            "snr": dict(I.SNR), "defaults": defaults, "grid": {"dv_web": I.GRID["dv_web_kms"]},
            "registry_tag": I.registry_tag(), "fitter": dict(FITTER),
            "frame": galaxy_frame(), "viz": viz, "components_url": "data/components.json",
            "js_base": "js/", "three": THREE_VERSION, "chat": dict(enabled=bool(chat), **WEBLLM), "custom": dict(CUSTOM),
            "galaxies": galaxies}


def resolve_backends(local_url: str | None, space_url: str | None) -> tuple[list, bool]:
    """Backend list for the page and whether a public Space URL is in it. Unset/placeholder Space URLs are dropped."""
    out = []
    if local_url:
        if not URL_RE.match(local_url.strip()):
            raise ValueError(f"--local-url must start with http:// or https://, got {local_url!r}")
        out.append(local_url.strip().rstrip("/"))
    space = (space_url or "").strip()
    if not space or space == PLACEHOLDER:
        return out, False
    if not URL_RE.match(space):
        raise ValueError(f"--space-url must start with http:// or https://, got {space!r}")
    out.append(space.rstrip("/"))
    return out, True


def export_library(lib: Path, data_out: Path, cat: dict, *, only=frozenset(), include_generated=False, comp_path=None,
                   allow_v1=False, prune=False, endpoints=None, npz_prefix=NPZ_PREFIX) -> dict:
    """Export one sightline library into data_out: catalog.json, s/<id>.bin and components.json (the files the page reads
    at data/ for the default galaxy, or at <pack>/ for a galaxy pack). endpoints(npz) -> (p0, p1) defaults to
    npz_endpoints (the 488530 centre); galaxy packs pass their own centre. Exits on a v1/v2 mix.
    -> {cat, keep, copied, skipped, no_geom, msgs}"""
    endpoints = endpoints or npz_endpoints
    sdir = data_out / "s"
    sdir.mkdir(parents=True, exist_ok=True)
    comp_path = comp_path or lib / "components.json"
    comps = json.loads(comp_path.read_text()).get("entries", {}) if comp_path.is_file() else {}
    keep, skipped, copied, no_geom, versions, pending = [], [], 0, [], {}, []
    for e in cat.get("entries", []):
        sid = e.get("id", "")
        if only and sid not in only:
            continue
        if not ID_RE.match(sid):
            skipped.append((sid, "invalid id")); continue
        if (e.get("source") == "generated" or sid.startswith("cust_")) and not include_generated:
            continue
        src = find_bin(lib, sid)
        if src is None:
            skipped.append((sid, "no web binary")); continue
        blob = src.read_bytes()
        try:
            ver = check_bin(blob, sid, allow_v1=allow_v1)
        except ValueError as exc:
            skipped.append((sid, str(exc))); continue
        versions.setdefault(ver, []).append(sid)
        pending.append((sdir / f"{sid}.bin", blob))
        e = dict(e, source=e.get("source", "library"))
        if not (isinstance(e.get("p0"), list) and isinstance(e.get("p1"), list)):
            npz = find_npz(lib, sid, npz_prefix)
            if npz is None:
                no_geom.append(sid)
            else:
                e["p0"], e["p1"] = endpoints(npz)
        e["has_components"] = sid in comps
        keep.append(e)
    if len(versions) > 1:
        sys.exit(f"refused: the export would mix TNGS v1 ({len(versions[1])}, e.g. {versions[1][0]}) and v2 "
                 f"({len(versions[2])}, e.g. {versions[2][0]}) binaries; regenerate or export one library")
    for dst, blob in pending:
        if not (dst.is_file() and dst.read_bytes() == blob):
            dst.write_bytes(blob); copied += 1
    ids = {e["id"] for e in keep}
    if prune:
        for p in sdir.glob("*.bin"):
            if p.stem not in ids:
                p.unlink()
    out_cat = {k: v for k, v in cat.items() if k != "entries"}            # catalog v2 passthrough (v1: as it is)
    out_cat.setdefault("version", 1); out_cat.setdefault("galaxy", {})
    out_cat["entries"] = keep
    (data_out / "catalog.json").write_text(json.dumps(out_cat, separators=(",", ":"), allow_nan=False))
    msgs = []
    if comp_path.is_file():
        w = copy_if_changed(comp_path, data_out / "components.json")
        msgs.append(f"components: {sum(e['has_components'] for e in keep)}/{len(keep)} entries "
                    f"({'written' if w else 'unchanged'}) -> {data_out / 'components.json'}")
    else:
        msgs.append(f"no components catalogue at {comp_path}; has_components false everywhere")
    return {"cat": out_cat, "keep": keep, "copied": copied, "skipped": skipped, "no_geom": no_geom, "msgs": msgs}


# ---------------------------------------------------------------- multi-galaxy packs (galaxy-sample spec, web contract)
# CFG.galaxies = {"default": <id>, "base": <pack base URL>, "viz_base": <cube base with {id}> | null, "list": [entry...]}
# entry = {id, label, Mstar, SFR, M200c, R200c, central, mw, m31, n, viz}; the default galaxy keeps the legacy data/ paths
# (catalog, s/, components, CFG.viz): every other galaxy is read from <base><id>/ (js/galaxies.js packFor):
#   <id>/catalog.json  <id>/s/<sid>.bin  <id>/components.json  <id>/galaxy.json  <id>/viz/manifest_v2.json
# and its cubes from viz_base with {id} replaced (default <base><id>/viz/). Packs are written under --pack-out.
GAL_ROOT_LAYOUT = ("galaxy.json", "library/catalog.json")      # what a galaxy dir under --galaxies-root must hold
GAL_PACK_PUBLIC = GAL_PUBLIC + ("Lhat", "xhat", "yhat", "mw", "m31", "label")
_ALIASES = {"Mstar": ("Mstar_Msun", "Mstar", "M_star_Msun", "StellarMass_30kpc"),
            "SFR": ("SFR_Msun_yr", "SFR", "SFR_inst", "SFR_50Myr"),
            "M200c": ("M200c_Msun", "M200c", "HaloMass_M200c"),
            "R200c": ("R200c_kpc", "R200c", "HaloVirialRadius_R200c"),
            "central": ("central", "is_central", "FlagCentral"),
            "mw": ("mw", "mw_like", "is_mw", "MW"), "m31": ("m31", "m31_like", "is_m31", "M31")}


def _pick(g: dict, key: str):
    """First present alias of `key` in the galaxy record or its "flags"/"catalogue" sub-dicts (the record stage's field
    names are not frozen; see _ALIASES)."""
    for d in (g, g.get("flags") or {}, g.get("catalogue") or {}, g.get("catalog") or {}):
        if isinstance(d, dict):
            for a in _ALIASES[key]:
                if d.get(a) is not None:
                    return d[a]
    return None


def _sig(x, n=4):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return float(f"{x:.{n}g}") if x == x and abs(x) != float("inf") else None


def _flag(x):
    if x is None:
        return None
    if isinstance(x, str):
        return x.strip().lower() in ("1", "true", "yes", "y")
    return bool(x)


def galaxy_entry(gid: int, g: dict, n: int, has_viz: bool, src: str | None = None, gas_poor=None,
                 base: str | None = None) -> dict:
    """One CFG.galaxies.list row from a galaxy record (galaxy.json, or the catalogue's galaxy block for the default).
    src ("sbi" | "trident") and gas_poor feed the picker's tags; base (hosting index) overrides <gal-base><id>/."""
    row = {"id": int(gid), "label": str(g.get("label") or f"Subhalo {gid}"), "Mstar": _sig(_pick(g, "Mstar")),
           "SFR": _sig(_pick(g, "SFR"), 3), "M200c": _sig(_pick(g, "M200c")), "R200c": _sig(_pick(g, "R200c"), 4),
           "central": _flag(_pick(g, "central")), "mw": _flag(_pick(g, "mw")), "m31": _flag(_pick(g, "m31")),
           "n": int(n), "viz": bool(has_viz)}
    if src in ("sbi", "trident"):
        row["src"] = src
    if gas_poor is not None:
        row["gas_poor"] = bool(gas_poor)
    if base:
        row["base"] = base
    return row


def _src_word(ss) -> str | None:
    v = str((ss or {}).get("source", "") if isinstance(ss, dict) else (ss or "")).lower()
    return "sbi" if v.startswith("sbi") else "trident" if v == "trident" else None


def galaxy_flags(gdir: Path, cat: dict) -> tuple[str | None, object]:
    """(src, gas_poor) of a pipeline galaxy: its public web/galaxy.json when the web stage wrote one, else the
    library catalogue (spectra_source block, galaxy.gas_poor)."""
    pub = {}
    if (gdir / "web" / "galaxy.json").is_file():
        try:
            pub = json.loads((gdir / "web" / "galaxy.json").read_text())
        except ValueError:
            pub = {}
    src = _src_word(pub.get("spectra_source")) or _src_word(cat.get("spectra_source"))
    gp = pub.get("gas_poor", (cat.get("galaxy") or {}).get("gas_poor"))
    return src, gp


def check_failed(gdir: Path) -> str | None:
    """Reason when <gdir>/check.json exists and does not pass (such a galaxy is not listed without --allow-unchecked)."""
    p = gdir / "check.json"
    if not p.is_file():
        return None
    try:
        c = json.loads(p.read_text())
    except ValueError:
        return "check.json unreadable"
    if isinstance(c, dict) and c.get("pass") is False:
        bad = [k for k, v in (c.get("gates") or {}).items() if isinstance(v, dict) and v.get("pass") is False]
        return "check failed" + (f" ({', '.join(bad[:4])})" if bad else "")
    return None


def load_gal_index(path: Path) -> dict[int, dict]:
    """Hosting index (deploy/data/upload_galaxies.py --index-out): {id: {repo, base, tier, ...}}; https bases only."""
    d = json.loads(Path(path).read_text())
    gals = d.get("galaxies", d) if isinstance(d, dict) else {}
    out = {}
    for k, v in gals.items():
        if not str(k).isdigit() or not isinstance(v, dict):
            continue
        b = str(v.get("base") or "")
        if not (b.startswith("https://") and b.endswith("/")) or ".." in b:
            raise ValueError(f"--gal-index: galaxy {k} base {b!r} must be an https URL ending in '/'")
        out[int(k)] = v
    return out


def galaxy_public(gid: int, g: dict) -> dict:
    """The pack's galaxy.json: public fields only (no source paths, no hashes), canonical names, plus the disk frame."""
    out = {k: g[k] for k in GAL_PACK_PUBLIC if k in g and g[k] is not None}
    out["subhalo_id"] = int(gid)
    for k, canon in (("Mstar", "Mstar_Msun"), ("SFR", "SFR_Msun_yr"), ("M200c", "M200c_Msun"), ("R200c", "R200c_kpc"),
                     ("central", "central")):
        v = _pick(g, k)
        if v is not None and canon not in out:
            out[canon] = _flag(v) if k == "central" else float(v)
    out.setdefault("sim", "TNG50-1"); out.setdefault("snapshot", 99); out.setdefault("redshift", 0.0)
    return out


def gal_endpoints(g: dict):
    """endpoints(npz) for a galaxy pack: start/end minus this galaxy's center_kpc (physical kpc, box axes, 0.01 kpc);
    the same math as npz_endpoints but never the 488530 centre."""
    import numpy as np
    c, h = np.asarray(g["center_kpc"], float), float(g.get("TNG_H", 0.6774))

    def f(path: Path):
        with np.load(path, allow_pickle=False) as d:
            geom = json.loads(str(d["geom"]))
        if "start_kpc" in geom and "end_kpc" in geom:
            a, b = np.asarray(geom["start_kpc"], float), np.asarray(geom["end_kpc"], float)
        else:
            a, b = np.asarray(geom["start_ckpch"], float) / h, np.asarray(geom["end_ckpch"], float) / h
        r = lambda v: [round(float(x), 2) + 0.0 for x in v]                   # noqa: E731
        return r(a - c), r(b - c)
    return f


def list_galaxies(root: Path, spec: str) -> list[int]:
    """Galaxy ids under --galaxies-root: "all" (every numeric <id>/; those not ready are reported by export_galaxy_pack)
    or a comma list."""
    if spec.strip().lower() == "all":
        ids = [int(p.name) for p in root.iterdir() if p.is_dir() and p.name.isdigit()] if root.is_dir() else []
        return sorted(ids)
    out = []
    for t in spec.split(","):
        t = t.strip()
        if t:
            if not t.isdigit():
                raise ValueError(f"--galaxies: {t!r} is not a subhalo id")
            out.append(int(t))
    return out


def export_galaxy_pack(root: Path, gid: int, pack_out: Path, *, viz_local=False, include_generated=False,
                       allow_v1=False, prune=False, allow_unchecked=False,
                       hosted: dict | None = None) -> tuple[dict | None, list[str]]:
    """<root>/<gid>/{galaxy.json, library/, viz/} -> <pack_out>/<gid>/ (catalog, s/, components, galaxy.json,
    viz/manifest_v2.json [+ cubes with viz_local]). -> (CFG.galaxies row or None when the galaxy is not ready, messages)."""
    gdir, pdir = root / str(gid), pack_out / str(gid)
    missing = [f for f in GAL_ROOT_LAYOUT if not (gdir / f).is_file()]
    if missing:
        return None, [f"galaxy {gid}: not ready (missing {', '.join(missing)} under its galaxies-root dir)"]
    why = None if allow_unchecked else check_failed(gdir)
    if why:
        return None, [f"galaxy {gid}: not listed, {why} (--allow-unchecked to list it)"]
    g = json.loads((gdir / "galaxy.json").read_text())
    lib = gdir / "library"
    cat = json.loads((lib / "catalog.json").read_text())
    ep = gal_endpoints(g) if "center_kpc" in g else None
    res = export_library(lib, pdir, cat, include_generated=include_generated, allow_v1=allow_v1, prune=prune,
                         endpoints=ep, npz_prefix=f"cgm_sid{gid}_")
    if not res["keep"]:
        return None, [f"galaxy {gid}: no exportable sightlines"] + res["msgs"]
    pub = galaxy_public(gid, g)
    (pdir / "galaxy.json").write_text(json.dumps(pub, separators=(",", ":"), allow_nan=False))
    msgs = [f"galaxy {gid}: {len(res['keep'])} sightlines ({res['copied']} binaries written)"] + ["  " + m for m in res["msgs"]]
    if res["no_geom"]:
        msgs.append(f"  {len(res['no_geom'])} entries without p0/p1")
    viz = gdir / "viz"
    has_viz = False
    if (viz / "manifest_v2.json").is_file():
        cfgv, vmsg = export_viz(viz, pdir, base="viz/", local=viz_local, sub="viz")
        has_viz = cfgv is not None
        msgs.append("  " + vmsg)
    else:
        msgs.append("  no viz manifest (3D tab: not published for this galaxy)")
    src, gp = galaxy_flags(gdir, cat)
    return galaxy_entry(gid, g, len(res["keep"]), has_viz, src, gp, (hosted or {}).get("base")), msgs


def galaxies_config(default_entry: dict, rows: list[dict], base: str, viz_base: str | None) -> dict | None:
    """CFG.galaxies, or None when the default galaxy is the only one (the page then shows no galaxy picker)."""
    rows = [r for r in rows if r["id"] != default_entry["id"]]
    if not rows:
        return None
    return {"default": default_entry["id"], "base": base, "viz_base": viz_base,
            "list": [default_entry] + sorted(rows, key=lambda r: r["id"])}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", type=Path, default=None, help="library dir (default tngsight.config.library_dir())")
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "tng50")
    ap.add_argument("--template", type=Path, default=ROOT / "docs" / "tng50" / "_template.html")
    ap.add_argument("--space-url", default=os.environ.get("TNG_SPACE_URL", ""),
                    help="public sightline server (HF Space) URL, e.g. https://<user>-<space>.hf.space; default env "
                         "TNG_SPACE_URL; without one the page is library-only")
    ap.add_argument("--local-url", default="http://127.0.0.1:8787", help="laptop server probed first ('' to omit)")
    ap.add_argument("--include-generated", action="store_true", help="also publish source=generated entries")
    ap.add_argument("--prune", action="store_true", help="delete <out>/data/s/*.bin not in the exported catalogue")
    ap.add_argument("--default-id", default="rand_b062_a062", help="sightline shown first (if exported)")
    ap.add_argument("--components", type=Path, default=None, help="components catalogue (default <library>/components.json)")
    ap.add_argument("--viz-dir", type=Path, default=None, help="3D cubes dir with manifest_v2.json (default <library>/viz)")
    ap.add_argument("--viz-base", default=VIZ_BASE, help=f"where the page fetches the cubes (default {VIZ_BASE})")
    ap.add_argument("--viz-local", action="store_true",
                    help="also copy every cube into <out>/data/viz/ and load them from there (refused for docs/tng50)")
    ap.add_argument("--chat", action="store_true", help="enable the chat ('Ask') button in the page config")
    ap.add_argument("--ids", default="", help="export only these comma-separated ids (testing)")
    ap.add_argument("--allow-v1", action="store_true", help="accept TNGS v1 binaries (never mixed with v2)")
    ap.add_argument("--galaxies-root", type=Path, default=None,
                    help="galaxy-sample data root holding <id>/galaxy.json, <id>/library/ and <id>/viz/ (pipeline output)")
    ap.add_argument("--galaxies", default="", help="galaxies to add to the picker: 'all' or comma-separated subhalo ids "
                    "(needs --galaxies-root); the default galaxy (--library) keeps its data/ paths")
    ap.add_argument("--gal-base", default=GAL_BASE, help=f"where the page fetches galaxy packs, ending in '/' (default {GAL_BASE})")
    ap.add_argument("--gal-viz-base", default=None, help="where the page fetches a galaxy's cubes, with {id} (default "
                    "<gal-base><id>/viz/)")
    ap.add_argument("--pack-out", type=Path, default=None, help="where the galaxy packs are written (default <out>/data/gal; "
                    "never inside docs/tng50: stage them for the data host)")
    ap.add_argument("--gal-index", type=Path, default=None,
                    help="hosting index JSON (deploy/data/upload_galaxies.py --index-out): each listed galaxy reads "
                         "its pack from its own base (sharded HF datasets); galaxies not in it are not listed")
    ap.add_argument("--allow-unchecked", action="store_true",
                    help="also list galaxies whose check.json fails (testing only)")
    a = ap.parse_args(argv)
    try:
        backends, public = resolve_backends(a.local_url, a.space_url)
    except ValueError as exc:
        ap.error(str(exc))
    if a.viz_local and a.out.resolve() == DOCS_OUT.resolve():
        ap.error("--viz-local is refused for docs/tng50: the cubes are hosted on Hugging Face, never committed")
    if not a.viz_base.endswith("/") or re.match(r"^[a-z]+:", a.viz_base) and not URL_RE.match(a.viz_base):
        ap.error(f"--viz-base must be an http(s) URL or a relative path, ending in '/', got {a.viz_base!r}")
    gal_ids = []
    if a.galaxies:
        if not a.galaxies_root:
            ap.error("--galaxies needs --galaxies-root")
        try:
            gal_ids = list_galaxies(a.galaxies_root, a.galaxies)
        except ValueError as exc:
            ap.error(str(exc))
    pack_out = a.pack_out or a.out / "data" / "gal"
    if gal_ids:
        if not a.gal_base.endswith("/") or re.match(r"^[a-z]+:", a.gal_base) and not URL_RE.match(a.gal_base):
            ap.error(f"--gal-base must be an http(s) URL or a relative path, ending in '/', got {a.gal_base!r}")
        if a.gal_viz_base is not None and ("{id}" not in a.gal_viz_base or not a.gal_viz_base.endswith("/")):
            ap.error(f"--gal-viz-base must contain {{id}} and end in '/', got {a.gal_viz_base!r}")
        docs = DOCS_OUT.resolve()
        if pack_out.resolve() == docs or docs in pack_out.resolve().parents:
            ap.error("galaxy packs are refused inside docs/tng50 (hundreds of MB per galaxy never go into git): pass "
                     "--pack-out <staging dir> and --gal-base <data host URL>")
    lib = a.library or default_library()
    cat_path = lib / "catalog.json"
    if not cat_path.is_file():
        sys.exit(f"no catalogue at {cat_path}; build it with deploy/data/build_library.py")
    cat = json.loads(cat_path.read_text())
    only = {s.strip() for s in a.ids.split(",") if s.strip()}
    sdir = a.out / "data" / "s"
    res = export_library(lib, a.out / "data", cat, only=only, include_generated=a.include_generated,
                         comp_path=a.components or lib / "components.json", allow_v1=a.allow_v1, prune=a.prune)
    out_cat, keep, copied, skipped, no_geom, msgs = (res[k] for k in ("cat", "keep", "copied", "skipped", "no_geom", "msgs"))
    ids = {e["id"] for e in keep}
    if a.prune and (a.out / "data" / "vol").is_dir():
        shutil.rmtree(a.out / "data" / "vol")                 # the Phase-2 volumes (replaced by data/viz, design-2b §6.4)
    viz, vmsg = export_viz(a.viz_dir or lib / "viz", a.out, base=a.viz_base, local=a.viz_local)
    msgs.append(vmsg)
    luts_src, luts_dst = DOCS_OUT / "data" / "luts" / "luts.json", a.out / "data" / "luts" / "luts.json"
    if luts_src.is_file() and luts_src.resolve() != luts_dst.resolve():
        w = copy_if_changed(luts_src, luts_dst)
        msgs.append(f"luts: {'written' if w else 'unchanged'} -> {luts_dst}")
    for sub, pat in (("js", "*.js"), ("css", "*.css")):             # the page's modules and stylesheets
        src_d, dst_d = ROOT / "docs" / "tng50" / sub, a.out / sub
        if src_d.resolve() != dst_d.resolve() and src_d.is_dir():
            files = sorted(src_d.glob(pat))
            n_w = sum(copy_if_changed(p, dst_d / p.name) for p in files)
            msgs.append(f"{sub}: {len(files)} files ({n_w} written) -> {dst_d}")
    default_id = a.default_id if a.default_id in ids else (min(keep, key=lambda e: e.get("rank") or 1e9)["id"] if keep else None)
    tpl = a.template.read_text(encoding="utf-8")
    if tpl.count(MARK) != 1:
        sys.exit(f"{a.template}: expected exactly one {MARK}")
    gal_cfg, gmsgs = None, []
    if gal_ids:
        pkg = json.loads((ROOT / "tngsight" / "galaxy_488530.json").read_text())      # the default galaxy's record ...
        g0 = {**pkg, **(out_cat.get("galaxy") or {})}                                  # ... under its catalogue's galaxy block
        gid0 = int(g0.get("subhalo_id") or pkg["subhalo_id"])
        rows = []
        hosted = None
        if a.gal_index:
            try:
                hosted = load_gal_index(a.gal_index)
            except (OSError, ValueError) as exc:
                ap.error(str(exc))
        for gid in gal_ids:
            if gid == gid0:
                gmsgs.append(f"galaxy {gid}: the default galaxy (exported from --library at data/), skipped as a pack")
                continue
            if hosted is not None and gid not in hosted:
                gmsgs.append(f"galaxy {gid}: not in the hosting index {a.gal_index.name}, not listed")
                continue
            row, m = export_galaxy_pack(a.galaxies_root, gid, pack_out, viz_local=a.viz_local,
                                        include_generated=a.include_generated, allow_v1=a.allow_v1, prune=a.prune,
                                        allow_unchecked=a.allow_unchecked,
                                        hosted=hosted.get(gid) if hosted is not None else None)
            gmsgs += m
            if row:
                rows.append(row)
        gal_cfg = galaxies_config(galaxy_entry(gid0, g0, len(keep), viz is not None,
                                               _src_word(out_cat.get("spectra_source")) or "trident"),
                                  rows, a.gal_base, a.gal_viz_base)
        gmsgs.insert(0, f"galaxies: {len(gal_cfg['list']) if gal_cfg else 1} in the picker; packs in {pack_out}, "
                        f"fetched from {a.gal_base}")
    data = json.dumps(page_config(out_cat, backends, default_id, len(keep), viz=viz, chat=a.chat, galaxies=gal_cfg),
                      separators=(",", ":"), ensure_ascii=False)
    data = data.replace("</", "<\\/")
    (a.out / "index.html").write_text(tpl.replace(MARK, data), encoding="utf-8")
    size = sum(p.stat().st_size for p in sdir.glob("*.bin"))
    print(f"exported {len(keep)} sightlines ({copied} binaries written, {size / 1e6:.1f} MB in {sdir}); "
          f"backends {backends}; default {default_id}")
    if not public:
        print("WARNING: no public sightline server URL (--space-url / TNG_SPACE_URL); the published page can only "
              "generate sightlines for visitors running the laptop server. Re-export with --space-url once the Space "
              "is up.", file=sys.stderr)
    for m in msgs + gmsgs:
        print("  " + m)
    if no_geom:
        print(f"  {len(no_geom)} entries without p0/p1 (no npz found): {', '.join(no_geom[:10])}{' ...' if len(no_geom) > 10 else ''}")
    for sid, why in skipped[:20]:
        print(f"  skipped {sid}: {why}")
    if len(skipped) > 20:
        print(f"  ... {len(skipped) - 20} more skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
