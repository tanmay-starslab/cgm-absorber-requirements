#!/usr/bin/env python3
"""Fit Voigt components for every library sightline and write the components catalogue.

    python deploy/data/build_components.py [--library DIR] [--out FILE] [--cache DIR] [--jobs N] [--ids a,b]
           [--include-generated] [--copy-to docs/tng50/data/components.json] [--lock FILE] [--force]
           [--rows]

Reads `<library>/catalog.json` for the ids (source "library"; plus "generated" with --include-generated) and
`<library>/sightlines/<id>.npz` (generated: `<library>/generated/<id>.npz`; npz v2 or v1, every registry line
present). Per sightline the fit
(tngsight.components.fit_payload) is cached as `<cache>/<id>.json` = {"id","fitter","params_tag","components",
"aod","seconds"}; a cache file with the current params_tag (and an "aod" record) is reused, so an interrupted run
resumes. Writes the catalogue (tngsight.components.make_catalogue, compact sorted JSON, with the per-sightline
AOD columns under "aod") to `--out` (default <library>/components.json) and optionally byte-copies it to
`--copy-to`. With --rows the cache files use the regen_library.py layout ({"id","fitter","params_tag",
"components": {k: rows},"aod"}), so `--cache <out>/components` refits a regenerated library into a separate
directory (the library itself is only read). The heavy-I/O lock (design §1) is held for the whole run. Prints totals, wall time and
POORFIT/SAT/MAXCOMP/DAMPED counts per ion.
"""
from __future__ import annotations
import argparse
import fcntl
import json
import multiprocessing as mp
import os
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))
from tngsight import components as C  # noqa: E402
from tngsight import vpfit  # noqa: E402
from tngsight import ions as I  # noqa: E402
from tngsight.config import library_dir  # noqa: E402

ID_RE = re.compile(r"^((face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?|cust_[0-9a-f]{10})$")
LOCK = os.environ.get("TNG_HEAVY_LOCK", "")   # opt-in heavy-I/O lock file


@contextmanager
def heavy_lock(path):
    if not path:
        yield; return
    with open(path, "a") as fh:
        t0 = time.time()
        fcntl.flock(fh, fcntl.LOCK_EX)
        if time.time() - t0 > 1:
            print(f"waited {time.time() - t0:.0f} s for {path}", flush=True)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.part")
    tmp.write_bytes(data)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def _init_worker():
    for v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        os.environ.setdefault(v, "1")


def fit_one(args):
    """(sid, npz path, cache path, tag) -> (sid, components, aod, seconds, cached)."""
    sid, npz, cache, tag, rows = (tuple(args) + (False,))[:5]
    cp = Path(cache)
    if cp.is_file():
        try:
            rec = json.loads(cp.read_text())
            if rec.get("params_tag") == tag and rec.get("id") == sid and "aod" in rec:
                return (sid, C.validate_components(rec["components"]), C.validate_aod(rec["aod"]),
                        float(rec.get("seconds", 0.0)), True)
        except (ValueError, KeyError):
            pass
    t0 = time.perf_counter()
    aod = {}
    comps = C.fit_sightline(npz, aod=aod)
    dt = time.perf_counter() - t0
    C.validate_components(comps)
    C.validate_aod(aod)
    if rows:                                                  # regen_library.py per-id layout
        rec = {"id": sid, "fitter": C.FITTER_TAG, "params_tag": tag,
               "components": {k: C.dicts_to_rows(v) for k, v in comps.items()}, "aod": aod}
    else:
        rec = {"id": sid, "fitter": C.FITTER_TAG, "params_tag": tag, "components": comps, "aod": aod,
               "seconds": round(dt, 3)}
    _atomic_write(cp, json.dumps(rec, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())
    return sid, comps, aod, dt, False


def collect_ids(lib: Path, include_generated: bool, only=None):
    cat = json.loads((lib / "catalog.json").read_text())
    out = {}
    for e in cat["entries"]:
        sid, src = e["id"], e.get("source")
        if not ID_RE.match(sid):
            raise SystemExit(f"bad id in catalog: {sid!r}")
        if src == "library":
            out[sid] = lib / "sightlines" / f"{sid}.npz"
        elif src == "generated" and include_generated:
            out[sid] = lib / "generated" / f"{sid}.npz"
    if only:
        missing = [s for s in only if s not in out]
        if missing:
            raise SystemExit(f"ids not in catalog (or generated without --include-generated): {missing}")
        out = {s: out[s] for s in only}
    absent = [s for s, p in out.items() if not p.is_file()]
    if absent:
        raise SystemExit(f"{len(absent)} npz missing, e.g. {absent[:3]}")
    return dict(sorted(out.items()))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--library", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--cache", type=Path, default=None)
    ap.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    ap.add_argument("--ids", default="")
    ap.add_argument("--include-generated", action="store_true")
    ap.add_argument("--copy-to", type=Path, default=None)
    ap.add_argument("--lock", default=LOCK, help="heavy-I/O lock file ('' disables)")
    ap.add_argument("--force", action="store_true", help="ignore the per-sightline cache")
    ap.add_argument("--rows", action="store_true", help="write cache files in the regen_library.py layout")
    a = ap.parse_args(argv)
    lib = a.library or library_dir()
    out = a.out or lib / "components.json"
    cache = a.cache or lib / "components"
    only = [s for s in a.ids.split(",") if s] or None
    tag = C.params_tag()
    with heavy_lock(a.lock):
        ids = collect_ids(lib, a.include_generated, only)
        if a.force:
            for s in ids:
                (cache / f"{s}.json").unlink(missing_ok=True)
        cache.mkdir(parents=True, exist_ok=True)
        print(f"{len(ids)} sightlines, params_tag {tag}, jobs {a.jobs}, cache {cache}", flush=True)
        t0 = time.time()
        work = [(s, str(p), str(cache / f"{s}.json"), tag, a.rows) for s, p in ids.items()]
        entries, aods, secs, n_cached = {}, {}, [], 0
        ctx = mp.get_context("spawn")
        with ctx.Pool(max(1, a.jobs), initializer=_init_worker) as pool:
            for i, (sid, comps, aod, dt, cached) in enumerate(pool.imap(fit_one, work), 1):
                entries[sid] = comps; aods[sid] = aod; n_cached += cached
                if not cached:
                    secs.append(dt)
                if i % 50 == 0 or i == len(work):
                    print(f"  {i}/{len(work)}  {time.time() - t0:.0f} s", flush=True)
        if only:                                              # partial run: merge into an existing catalogue
            if out.is_file():
                prev = C.load_catalogue(out)
                if prev["params_tag"] == tag:
                    entries = {**prev["entries"], **entries}
                    aods = {**(prev.get("aod") or {}), **aods}
        cat = C.make_catalogue(entries, aod=aods)
        C.validate_catalogue(cat)
        blob = C.dump_catalogue(cat)
        _atomic_write(out, blob)
        wall = time.time() - t0
    print(f"wrote {out} ({len(blob) / 1e6:.3f} MB, {len(entries)} entries) in {wall:.0f} s; "
          f"{n_cached} cached, {len(secs)} fitted"
          + (f", fit s/sightline median {sorted(secs)[len(secs) // 2]:.2f} max {max(secs):.2f}" if secs else ""))
    for k in I.KEYS:
        n = [len(e[k]) for e in entries.values() if k in e]
        if not n:
            continue
        fl = [c["flag"] for e in entries.values() for c in e.get(k, [])]
        cnt = {f: sum(1 for x in fl if x & vpfit.FLAGS[f]) for f in ("SAT", "POORFIT", "MAXCOMP", "BOUND", "NOERR",
                                                                    "EDGE", "DAMPED")}
        print(f"  {k:5s} comps {sum(n):6d}  per sightline mean {sum(n) / max(1, len(n)):.2f} max {max(n or [0])}"
              f"  empty {sum(1 for x in n if x == 0)}  " + " ".join(f"{f} {v}" for f, v in cnt.items()))
    if a.copy_to:
        dst = a.copy_to
        if not dst.is_file() or dst.read_bytes() != blob:
            _atomic_write(dst, blob)
            print(f"copied to {dst}")
        else:
            print(f"{dst} already identical")
    return 0


if __name__ == "__main__":
    sys.exit(main())
