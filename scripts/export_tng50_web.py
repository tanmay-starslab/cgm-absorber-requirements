#!/usr/bin/env python3
"""Build the static TNG50 sightline explorer under docs/tng50/ from the sightline library.

    python scripts/export_tng50_web.py [--library DIR] [--out DIR] [--space-url URL] [--local-url URL]
                                       [--include-generated] [--prune]

Reads <library>/catalog.json and <library>/web/<id>.bin (or generated/<id>.bin), as written by
deploy/data/build_library.py and the server; writes
  <out>/data/catalog.json      entries that have a valid web binary (library ones by default)
  <out>/data/s/<id>.bin        byte copies of the web binaries
  <out>/index.html             docs/tng50/_template.html with a small config injected at /*__DATA__*/null
The library is only read. The public Space URL comes from --space-url or the TNG_SPACE_URL environment
variable; without one (or with the literal placeholder "TNG_SPACE_URL") it is left out of the page's
backend list and a warning is printed: the published page is then library-only for every visitor who
is not running the laptop server."""
from __future__ import annotations
import argparse, json, os, re, struct, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
MARK = "/*__DATA__*/null"
PLACEHOLDER = "TNG_SPACE_URL"
URL_RE = re.compile(r"^https?://[^\s/]+")
ID_RE = re.compile(r"^(face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?$")
LINE_KEYS = ("OVI", "HILyb", "CIII")
GAL_PUBLIC = ("sim", "snapshot", "redshift", "subhalo_id", "central", "R200c_kpc", "M200c_Msun", "Mstar_Msun", "SFR_Msun_yr")
LABELS = {"OVI": "O VI λ1032", "HILyb": "H I Lyβ", "CIII": "C III λ977"}
COLORS = {"OVI": "#D81E5B", "HILyb": "#1D4E89", "CIII": "#1B998B"}
R_OPTS = [20000, 30000, 40000, 60000, 80000, 100000]


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


def page_config(cat: dict, backends: list, default_id: str | None, n: int) -> dict:
    gal = {k: cat.get("galaxy", {}).get(k) for k in GAL_PUBLIC if k in cat.get("galaxy", {})}
    lines = {k: {"label": LABELS[k], "color": COLORS[k], "rest_A": cat.get("lines", {}).get(k, {}).get("rest_A"),
                 "ion": cat.get("lines", {}).get(k, {}).get("ion"), "dlam_lsf": cat.get("lines", {}).get(k, {}).get("dlam_lsf", 0.002)}
             for k in LINE_KEYS}
    return {"version": 1, "catalog_url": "data/catalog.json", "bin_dir": "data/s/", "n_static": n, "backends": backends,
            "galaxy": gal, "lines": lines, "R_opts": R_OPTS,
            "defaults": {"id": default_id, "R_lo": 20000, "R_hi": 40000, "sn_hi": 8, "sn_lo": 5, "vwin": 400, "seed": 0,
                         "intrinsic": False}}


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
    keep, skipped, copied = [], [], 0
    for e in cat.get("entries", []):
        sid = e.get("id", "")
        if not ID_RE.match(sid):
            skipped.append((sid, "invalid id")); continue
        if e.get("source") == "generated" and not a.include_generated:
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
        keep.append(dict(e, source=e.get("source", "library")))
    ids = {e["id"] for e in keep}
    if a.prune:
        for p in sdir.glob("*.bin"):
            if p.stem not in ids:
                p.unlink()
    out_cat = {"version": cat.get("version", 1), "galaxy": cat.get("galaxy", {}), "lines": cat.get("lines", {}), "entries": keep}
    (a.out / "data" / "catalog.json").write_text(json.dumps(out_cat, separators=(",", ":"), allow_nan=False))
    default_id = a.default_id if a.default_id in ids else (min(keep, key=lambda e: e.get("rank") or 1e9)["id"] if keep else None)
    tpl = a.template.read_text(encoding="utf-8")
    if tpl.count(MARK) != 1:
        sys.exit(f"{a.template}: expected exactly one {MARK}")
    data = json.dumps(page_config(out_cat, backends, default_id, len(keep)), separators=(",", ":"), ensure_ascii=False)
    data = data.replace("</", "<\\/")
    (a.out / "index.html").write_text(tpl.replace(MARK, data), encoding="utf-8")
    size = sum(p.stat().st_size for p in sdir.glob("*.bin"))
    print(f"exported {len(keep)} sightlines ({copied} binaries written, {size / 1e6:.1f} MB in {sdir}); "
          f"backends {backends}; default {default_id}")
    if not public:
        print("WARNING: no public sightline server URL (--space-url / TNG_SPACE_URL); the published page can only "
              "generate sightlines for visitors running the laptop server. Re-export with --space-url once the Space "
              "is up.", file=sys.stderr)
    for sid, why in skipped[:20]:
        print(f"  skipped {sid}: {why}")
    if len(skipped) > 20:
        print(f"  ... {len(skipped) - 20} more skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
