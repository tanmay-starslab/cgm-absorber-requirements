#!/usr/bin/env python3
"""Build the explorer's sightline library from the read-only npz set.

This is the v1 copy tool (the 672 three-line npz files, copied as they are). The Phase-3 data v2 library (12 registry
lines, npz v2, TNGS v2, components v2) is made by deploy/data/regen_library.py instead. Through tngsight.library the
web binaries written here are TNGS v2 with the two registry lines a v1 npz holds (O VI, C III).

    python deploy/data/build_library.py [--src DIR] [--out DIR] [-j N] [--force] [--verify] [--legacy-index CSV]
    (--index is the old name of --legacy-index)

Writes into `--out` (default tngsight.config.library_dir()):
  sightlines/<id>.npz   byte copy of cgm_sid488530_<id>.npz (mtime preserved)
  web/<id>.bin          tngsight.library.encode_web
  catalog.json          tngsight.library.catalog_entry(..., source="library"), scores from
                        tngsight.scoring.score_payload (fixed +v_sys frame, dλ=0.002 — the frame every plot uses),
                        rank = 1..N over library entries by showcase_score; catalog["scoring"] = SCORING_TAG.
                        tng50/data/grid_index.csv was scored in the legacy (−v_sys, median dλ) frame and is kept
                        for history only (--legacy-index reproduces the old catalog from it).
Idempotent: an id whose copy (same size+mtime), web bin and catalog entry exist is not read at all — unless
the catalog's "scoring" tag differs from SCORING_TAG, in which case every library entry is rescored.
Existing catalog entries of other ids (e.g. source "generated") are kept. The source tree is only read.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))
from tngsight import library as L  # noqa: E402
from tngsight.config import NPZ_PREFIX, library_dir  # noqa: E402
from tngsight.scoring import SCORING_TAG, assign_ranks, score_payload  # noqa: E402

SRC = Path("/Volumes/LaCie/cgm_qso_488530/data/sightlines")
INDEX = ROOT / "tng50" / "data" / "grid_index.csv"


def read_scores(path) -> dict:
    """grid_index.csv rows keyed by geom_id (values left as strings; catalog_entry parses them)."""
    with open(path, newline="") as fh:
        return {r["geom_id"]: r for r in csv.DictReader(fh)}


def _sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def _atomic(path: Path, data: bytes, mtime=None):
    tmp = path.with_name(f".{path.name}.{os.getpid()}.part")
    tmp.write_bytes(data)
    if mtime is not None:
        os.utime(tmp, (mtime, mtime))
    os.replace(tmp, path)


def copy_ok(src: Path, dst: Path) -> bool:
    if not dst.is_file():
        return False
    a, b = src.stat(), dst.stat()
    return a.st_size == b.st_size and int(a.st_mtime) == int(b.st_mtime)


def build_one(src: str, out: str, sid: str, scores: dict | None, force=False, verify=False):
    """Copy + encode + score one sightline. `scores` None -> score_payload (fixed frame); a dict (legacy
    grid_index row) is used as is. Returns (sid, entry, actions)."""
    src, out = Path(src), Path(out)
    npz, web = out / "sightlines" / f"{sid}.npz", out / "web" / f"{sid}.bin"
    acts = []
    if force or not copy_ok(src, npz):
        _atomic(npz, src.read_bytes(), src.stat().st_mtime); acts.append("copy")
    if verify and _sha(src) != _sha(npz):
        raise RuntimeError(f"{sid}: copy differs from source")
    payload = L.load_npz(npz)
    if payload["id"] != sid:
        raise RuntimeError(f"{sid}: load_npz id {payload['id']!r}")
    blob = L.encode_web(payload)
    if force or not web.is_file() or web.read_bytes() != blob:
        _atomic(web, blob); acts.append("web")
    return sid, L.catalog_entry(payload, scores if scores is not None else score_payload(payload), "library"), acts


def _rank_key(row):
    try:
        return (0, int(float(row["rank"])))
    except (TypeError, ValueError, KeyError):
        return (1, 0)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", type=Path, default=SRC, help="directory of cgm_sid488530_<id>.npz (read-only)")
    ap.add_argument("--legacy-index", "--index", dest="legacy_index", type=Path, default=None, metavar="CSV",
                    help=f"take scores+rank from a legacy-frame grid_index.csv (e.g. {INDEX.relative_to(ROOT)}) "
                         "instead of rescoring; history only")
    ap.add_argument("--out", type=Path, default=None, help="library root (default tngsight library_dir())")
    ap.add_argument("-j", "--jobs", type=int, default=4, help="worker processes (USB disk: 4 is plenty)")
    ap.add_argument("--force", action="store_true", help="rewrite every file and entry")
    ap.add_argument("--verify", action="store_true", help="sha256-compare every copy with its source")
    ap.add_argument("--limit", type=int, default=None, help="only the first N ids (testing)")
    a = ap.parse_args(argv)
    out = (a.out or library_dir()).resolve()
    src = a.src.resolve()
    if out == src or src in out.parents:
        ap.error("--out must not be inside --src (the source tree is read-only)")
    for d in ("sightlines", "web"):
        (out / d).mkdir(parents=True, exist_ok=True)

    files = {p.stem[len(NPZ_PREFIX):]: p for p in sorted(src.glob(f"{NPZ_PREFIX}*.npz"))}
    legacy = a.legacy_index is not None
    scores = read_scores(a.legacy_index) if legacy else {}
    tag = f"legacy grid_index ({a.legacy_index.name})" if legacy else SCORING_TAG
    ids = sorted(files, key=lambda s: (_rank_key(scores.get(s, {})), s))[:a.limit]
    miss_s = [s for s in ids if s not in scores] if legacy else []
    miss_f = sorted(set(scores) - set(files)) if legacy and a.limit is None else []
    cat = L.Catalog(out / "catalog.json")
    rescore = cat.data.get("scoring") != tag
    todo = [s for s in ids if a.force or a.verify or rescore or cat.get(s) is None
            or not copy_ok(files[s], out / "sightlines" / f"{s}.npz") or not (out / "web" / f"{s}.bin").is_file()]
    print(f"{len(files)} npz in {src}; scores: {tag}{' (rescoring all)' if rescore else ''}; "
          f"{len(todo)} to (re)build -> {out}", flush=True)
    if miss_s:
        print(f"WARNING: {len(miss_s)} npz without a grid_index row (rank null): {miss_s[:5]}", flush=True)
    if miss_f:
        print(f"WARNING: {len(miss_f)} grid_index rows without an npz: {miss_f[:5]}", flush=True)

    t0, n_copy, n_web, errors, done = time.time(), 0, 0, [], {}
    with ProcessPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        futs = {ex.submit(build_one, str(files[s]), str(out), s, scores.get(s, {}) if legacy else None,
                          a.force, a.verify): s
                for s in todo}
        for i, f in enumerate(as_completed(futs), 1):
            s = futs[f]
            try:
                sid, entry, acts = f.result()
                done[sid] = entry; n_copy += "copy" in acts; n_web += "web" in acts
            except Exception as e:                      # report all failures, keep going
                errors.append((s, f"{e.__class__.__name__}: {e}"))
            if i % 100 == 0 or i == len(futs):
                print(f"  {i}/{len(futs)}  {time.time() - t0:.0f}s", flush=True)
    if not legacy and done:                             # re-rank all library entries in the fixed frame
        lib = {e["id"]: e for e in cat.entries() if e.get("source") == "library"}
        lib.update(done)
        assign_ranks(list(lib.values()))
        done = {s: lib[s] for s in sorted(lib, key=lambda s: (lib[s]["rank"] is None, lib[s]["rank"] or 0, s))}
    for s in (done if not legacy else ids):             # upsert in rank order
        if s in done:
            cat.upsert(done[s])
    if not errors:
        cat.data["scoring"] = tag
    if done or rescore or not (out / "catalog.json").exists():
        cat.save()
    n_lib = sum(1 for e in cat.entries() if e.get("source") == "library")
    size = lambda d: sum(p.stat().st_size for p in (out / d).iterdir() if p.is_file())  # noqa: E731
    print(f"copied {n_copy}, web bins written {n_web}, entries updated {len(done)}, errors {len(errors)}; "
          f"catalog: {len(cat.entries())} entries ({n_lib} library); "
          f"sightlines {size('sightlines') / 1e6:.1f} MB, web {size('web') / 1e6:.1f} MB, "
          f"catalog {(out / 'catalog.json').stat().st_size / 1e3:.0f} kB; {time.time() - t0:.0f}s")
    for s, e in errors:
        print(f"ERROR {s}: {e}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
