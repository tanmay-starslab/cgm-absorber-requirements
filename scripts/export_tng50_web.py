#!/usr/bin/env python3
"""Build the static TNG50 sightline explorer under docs/tng50/ from the sightline library.

    python scripts/export_tng50_web.py [--library DIR] [--out DIR] [--space-url URL] [--local-url URL]
                                       [--include-generated] [--prune] [--components FILE] [--vol-dir DIR]
                                       [--chat] [--ids a,b,...]

Reads <library>/catalog.json and <library>/web/<id>.bin (or generated/<id>.bin), as written by
deploy/data/build_library.py and the server; writes
  <out>/data/catalog.json      entries that have a valid web binary (library ones by default)
  <out>/data/s/<id>.bin        byte copies of the web binaries
  <out>/index.html             docs/tng50/_template.html with a small config injected at /*__DATA__*/null
  <out>/data/components.json   byte copy of --components (default <library>/components.json), if present
  <out>/data/vol/              manifest.json + the files it lists, from --vol-dir (default <library>/vol), sha256-checked
  <out>/js/*.js                the page's lazy modules (copied from docs/tng50/js when --out is elsewhere)
Every exported entry carries p0/p1 (ray start/end, physical kpc from the galaxy centre, box axes, 0.01 kpc), read
from the npz `geom` member when the catalogue lacks them, and has_components. Custom (cust_) ids are exported only
with --include-generated.
The library is only read. The public Space URL comes from --space-url or the TNG_SPACE_URL environment
variable; without one (or with the literal placeholder "TNG_SPACE_URL") it is left out of the page's
backend list and a warning is printed: the published page is then library-only for every visitor who
is not running the laptop server."""
from __future__ import annotations
import argparse, hashlib, json, os, re, shutil, struct, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
MARK = "/*__DATA__*/null"
PLACEHOLDER = "TNG_SPACE_URL"
URL_RE = re.compile(r"^https?://[^\s/]+")
ID_RE = re.compile(r"^((face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?|cust_[0-9a-f]{10})$")   # = server.storage.ID_RE (design-2 §2)
LINE_KEYS = ("OVI", "HILyb", "CIII")
GAL_PUBLIC = ("sim", "snapshot", "redshift", "subhalo_id", "central", "R200c_kpc", "M200c_Msun", "Mstar_Msun", "SFR_Msun_yr")
LABELS = {"OVI": "O VI λ1032", "HILyb": "H I Lyβ", "CIII": "C III λ977"}
COLORS = {"OVI": "#D81E5B", "HILyb": "#1D4E89", "CIII": "#1B998B"}
R_OPTS = [20000, 30000, 40000, 60000, 80000, 100000]
NPZ_PREFIX = "cgm_sid488530_"
THREE_VERSION = "0.169.0"
WEBLLM = {"webllm": "0.2.85", "model": "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"}
CUSTOM = {"r_max_kpc": 395, "l_min_kpc": 20, "l_max_kpc": 800}
VOL_KEYS = ("nH", "T", "Z", "OVI", "HI", "CIII")


def galaxy_frame() -> dict:
    """Disk frame + R200c for the 3D view, from the package galaxy JSON (center_kpc is the frame origin)."""
    g = json.loads((ROOT / "tngsight" / "galaxy_488530.json").read_text())
    return {k: g[k] for k in ("Lhat", "xhat", "yhat", "R200c_kpc")}


def find_npz(lib: Path, sid: str) -> Path | None:
    for p in (lib / "sightlines" / f"{NPZ_PREFIX}{sid}.npz", lib / "sightlines" / f"{sid}.npz",
              lib / "generated" / f"{NPZ_PREFIX}{sid}.npz", lib / "generated" / f"{sid}.npz"):
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


def export_volumes(vol_dir: Path, out_vol: Path) -> tuple[dict | None, str]:
    """Validate <vol_dir>/manifest.json (tngsight.volume.validate_manifest when importable) and every listed file's
    sha256, then copy them to out_vol. -> (page-config summary or None, message)."""
    man_p = vol_dir / "manifest.json"
    if not man_p.is_file():
        return None, f"no volumes at {vol_dir} (3D tab will say 'volumes not published')"
    man = json.loads(man_p.read_text())
    try:
        from tngsight.volume import validate_manifest
        validate_manifest(man)
    except ImportError:
        if man.get("version") != 1 or not isinstance(man.get("fields"), dict) or not isinstance(man.get("grids"), dict):
            return None, f"{man_p}: unexpected manifest format"
    except ValueError as exc:
        return None, f"{man_p}: {exc}"
    files = []
    for key, f in man["fields"].items():
        for res, name in f["files"].items():
            p = vol_dir / name
            if not p.is_file():
                return None, f"{p} listed in the manifest is missing"
            want = (f.get("sha256") or {}).get(res)
            if want and hashlib.sha256(p.read_bytes()).hexdigest() != want:
                return None, f"{p}: sha256 does not match the manifest"
            files.append(p)
    n = sum(copy_if_changed(p, out_vol / p.name) for p in files) + copy_if_changed(man_p, out_vol / "manifest.json")
    total = sum(p.stat().st_size for p in files)
    keys = [k for k in VOL_KEYS if k in man["fields"]] + [k for k in man["fields"] if k not in VOL_KEYS]
    return {"keys": keys, "grids": sorted(man["grids"], key=int)}, \
        f"volumes: {len(keys)} fields, {len(files)} files, {total / 1e6:.1f} MB ({n} written) -> {out_vol}"


def default_library() -> Path:
    try:
        from tngsight.config import library_dir
        return library_dir()
    except Exception:                                    # noqa: BLE001 - tngsight optional for this script
        return Path(os.environ.get("TNG_LIBRARY_DIR", "/Volumes/cgm_work/data/library"))


def check_bin(blob: bytes, sid: str) -> None:
    """Header + length check of a design §4 web binary (no numpy needed)."""
    if blob[:4] != b"TNGS":
        raise ValueError(f"{sid}: bad magic")
    ver, nl, _ = struct.unpack_from("<BBH", blob, 4)
    if ver != 1 or nl != len(LINE_KEYS):
        raise ValueError(f"{sid}: version {ver}, {nl} lines")
    off = 8
    for _ in range(nl):
        n, lam0, dg, rest, dl = struct.unpack_from("<Idddd", blob, off)
        off += 36 + 2 * n
    if off != len(blob):
        raise ValueError(f"{sid}: length {len(blob)} != {off}")


def find_bin(lib: Path, sid: str) -> Path | None:
    for p in (lib / "web" / f"{sid}.bin", lib / "generated" / f"{sid}.bin"):
        if p.is_file():
            return p
    return None


def page_config(cat: dict, backends: list, default_id: str | None, n: int, vol: dict | None = None,
                chat: bool = False) -> dict:
    gal = {k: cat.get("galaxy", {}).get(k) for k in GAL_PUBLIC if k in cat.get("galaxy", {})}
    lines = {k: {"label": LABELS[k], "color": COLORS[k], "rest_A": cat.get("lines", {}).get(k, {}).get("rest_A"),
                 "ion": cat.get("lines", {}).get(k, {}).get("ion"), "dlam_lsf": cat.get("lines", {}).get(k, {}).get("dlam_lsf", 0.002)}
             for k in LINE_KEYS}
    return {"version": 2, "catalog_url": "data/catalog.json", "bin_dir": "data/s/", "n_static": n, "backends": backends,
            "galaxy": gal, "lines": lines, "R_opts": R_OPTS,
            "defaults": {"id": default_id, "R_lo": 20000, "R_hi": 40000, "sn_hi": 8, "sn_lo": 5, "vwin": 400, "seed": 0,
                         "intrinsic": False},
            "frame": galaxy_frame(), "vol": vol, "vol_url": "data/vol/", "components_url": "data/components.json",
            "js_base": "js/", "three": THREE_VERSION, "chat": dict(enabled=bool(chat), **WEBLLM), "custom": dict(CUSTOM)}


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
    ap.add_argument("--default-id", default="edge_b100_a090", help="sightline shown first (if exported)")
    ap.add_argument("--components", type=Path, default=None, help="components catalogue (default <library>/components.json)")
    ap.add_argument("--vol-dir", type=Path, default=None, help="3D volumes dir with manifest.json (default <library>/vol)")
    ap.add_argument("--chat", action="store_true", help="enable the chat ('Ask') button in the page config")
    ap.add_argument("--ids", default="", help="export only these comma-separated ids (testing)")
    a = ap.parse_args(argv)
    try:
        backends, public = resolve_backends(a.local_url, a.space_url)
    except ValueError as exc:
        ap.error(str(exc))
    lib = a.library or default_library()
    cat_path = lib / "catalog.json"
    if not cat_path.is_file():
        sys.exit(f"no catalogue at {cat_path}; build it with deploy/data/build_library.py")
    cat = json.loads(cat_path.read_text())
    sdir = a.out / "data" / "s"
    sdir.mkdir(parents=True, exist_ok=True)
    only = {s.strip() for s in a.ids.split(",") if s.strip()}
    comp_path = a.components or lib / "components.json"
    comps = {}
    if comp_path.is_file():
        comps = json.loads(comp_path.read_text()).get("entries", {})
    keep, skipped, copied, no_geom = [], [], 0, []
    for e in cat.get("entries", []):
        sid = e.get("id", "")
        if only and sid not in only:
            continue
        if not ID_RE.match(sid):
            skipped.append((sid, "invalid id")); continue
        if (e.get("source") == "generated" or sid.startswith("cust_")) and not a.include_generated:
            continue
        src = find_bin(lib, sid)
        if src is None:
            skipped.append((sid, "no web binary")); continue
        blob = src.read_bytes()
        try:
            check_bin(blob, sid)
        except ValueError as exc:
            skipped.append((sid, str(exc))); continue
        dst = sdir / f"{sid}.bin"
        if not (dst.is_file() and dst.read_bytes() == blob):
            dst.write_bytes(blob); copied += 1
        e = dict(e, source=e.get("source", "library"))
        if not (isinstance(e.get("p0"), list) and isinstance(e.get("p1"), list)):
            npz = find_npz(lib, sid)
            if npz is None:
                no_geom.append(sid)
            else:
                e["p0"], e["p1"] = npz_endpoints(npz)
        e["has_components"] = sid in comps
        keep.append(e)
    ids = {e["id"] for e in keep}
    if a.prune:
        for p in sdir.glob("*.bin"):
            if p.stem not in ids:
                p.unlink()
    out_cat = {"version": cat.get("version", 1), "galaxy": cat.get("galaxy", {}), "lines": cat.get("lines", {}), "entries": keep}
    (a.out / "data" / "catalog.json").write_text(json.dumps(out_cat, separators=(",", ":"), allow_nan=False))
    msgs = []
    if comp_path.is_file():
        w = copy_if_changed(comp_path, a.out / "data" / "components.json")
        msgs.append(f"components: {sum(e['has_components'] for e in keep)}/{len(keep)} entries "
                    f"({'written' if w else 'unchanged'}) -> {a.out / 'data' / 'components.json'}")
    else:
        msgs.append(f"no components catalogue at {comp_path}; has_components false everywhere")
    vol, vmsg = export_volumes(a.vol_dir or lib / "vol", a.out / "data" / "vol")
    msgs.append(vmsg)
    js_src, js_dst = ROOT / "docs" / "tng50" / "js", a.out / "js"
    if js_src.resolve() != js_dst.resolve() and js_src.is_dir():
        n_js = sum(copy_if_changed(p, js_dst / p.name) for p in sorted(js_src.glob("*.js")))
        msgs.append(f"js: {len(list(js_src.glob('*.js')))} modules ({n_js} written) -> {js_dst}")
    default_id = a.default_id if a.default_id in ids else (min(keep, key=lambda e: e.get("rank") or 1e9)["id"] if keep else None)
    tpl = a.template.read_text(encoding="utf-8")
    if tpl.count(MARK) != 1:
        sys.exit(f"{a.template}: expected exactly one {MARK}")
    data = json.dumps(page_config(out_cat, backends, default_id, len(keep), vol=vol, chat=a.chat),
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
    for m in msgs:
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
