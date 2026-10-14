#!/usr/bin/env python3
"""Build the deposited RGB stellar cubes S0/S1/S2 for the 3D viewer (Phase-2b design §4.4–§4.6).

    python deploy/data/build_stars.py [--viz DIR] [--cache DIR] [--cutout FILE] [--levels S0,S1,S2]
                                      [--workers 4] [--lock FILE] [--force] [--check]

1. PartType4 is read ONCE from the raw cutout (read-only, sequential, under --lock) and cached as
   `<cache>/pt4_<field>.npy`; later runs never open the cutout.
2. Per level: one `deposit.scatter` of the i, r, g luminosities (winds excluded) → float32 densities cached as
   `<cache>/<S>_<band>.npy` + `<cache>/<S>.json` (DepositResult numbers; resumable unless --force). Conservation
   |Σ grid − Σ ℓ·f| ≤ 1e-6 relative per band is enforced.
3. Encode (§2.3 star rule, log10-u8, RGBA raw, 4 WebP RGB parts in a --workers process pool + .rgba.gz) into
   `<viz>/stars/<S>/gri.<id12>.*`; every written cube is decoded back and checked against its raw sha256.
4. `<viz>/stars/manifest_stars.json` (the fragment that `python -m tngsight.vizpack merge` combines). Entries of
   levels not rebuilt this run are kept when their files still match.

--check re-verifies the fragment's files (sizes, sha256, WebP → raw) without building anything.
Defaults: --viz <library>/viz, --cache <library>/viz_cache/stars, --lock $TNG_HEAVY_LOCK.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing as mp
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))
import numpy as np  # noqa: E402
from tngsight import config, stars as S  # noqa: E402

DEFAULT_LOCK = Path(os.environ["TNG_HEAVY_LOCK"]) if os.environ.get("TNG_HEAVY_LOCK") else None
BUDGET_WEBP_MB = {"S0": 3.0, "S1": 5.0, "S2": 9.0}
BUDGET_GZ_MB = {"S0": 6.0, "S1": 9.0, "S2": 14.0}
CONS_GATE = 1e-6


def _rss_gb():
    import resource
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / 2**30 if sys.platform == "darwin" else r / 2**20


def cache_files(cache: Path, level):
    return {b: cache / f"{level}_{b}.npy" for b in S.CHANNELS}, cache / f"{level}.json"


class _Dep:
    """DepositResult numbers restored from a cache sidecar (enough for write_level)."""
    def __init__(self, d):
        self.n_elements = d["n_elements"]
        self.n_straddling = d["n_straddling"]
        self.q_in = d["q_in"]
        self.q_lost = d["q_lost"]
        self.seconds = d["seconds"]
        self.meta = {"workers": d["workers"]}
        self.grids = None


def deposit_level(arr, level, cache: Path, workers, force):
    """Float cubes for `level` (from the cache when valid) + the deposit numbers."""
    npys, side = cache_files(cache, level)
    if not force and side.is_file() and all(p.is_file() for p in npys.values()):
        meta = json.loads(side.read_text())
        if meta.get("stars_version") == S.STARS_VERSION and meta.get("deposit") == S.D.GENERATOR:
            print(f"[{level}] cached deposit ({meta['seconds']:.1f}s when built, cons "
                  f"{max(v['cons_rel'] for v in meta['conservation'].values()):.1e})", flush=True)
            return {b: np.load(p).astype(np.float64) for b, p in npys.items()}, _Dep(meta), meta
    t = time.time()
    cubes, dep = S.build_level(arr, level, workers=workers)
    cons = S.conservation(dep)
    worst = max(v["cons_rel"] for v in cons.values())
    if not worst <= CONS_GATE:
        raise SystemExit(f"[{level}] conservation {worst:.3e} > {CONS_GATE:g}; not writing anything")
    meta = {"stars_version": S.STARS_VERSION, "deposit": S.D.GENERATOR, "level": level,
            "n_elements": dep.n_elements, "n_straddling": dep.n_straddling, "q_in": dep.q_in,
            "q_full_inside": dep.q_full_inside, "q_lost": dep.q_lost, "level_counts": dep.level_counts,
            "seconds": dep.seconds, "workers": workers, "pairs": dep.meta.get("pairs"), "conservation": cons}
    cache.mkdir(parents=True, exist_ok=True)
    for b, p in npys.items():
        tmp = p.with_name(p.name + ".tmp.npy")
        np.save(tmp, cubes[b].astype(np.float32))
        os.replace(tmp, p)
    side.write_text(json.dumps(meta, indent=1))
    print(f"[{level}] deposit {dep.seconds:.1f}s (wall {time.time() - t:.1f}s)  elements {dep.n_elements:,}  "
          f"straddling {dep.n_straddling:,}  levels {dep.level_counts}  pairs {dep.meta.get('pairs'):,}", flush=True)
    for b in S.CHANNELS:
        print(f"[{level}]   {b}: cons {cons[b]['cons_rel']:.2e}  lost {100 * cons[b]['lost_fraction']:.3f} %",
              flush=True)
    # encode from the float32 cache values, so a fresh build and a resumed build give identical bytes
    return {b: cubes[b].astype(np.float32).astype(np.float64) for b in S.CHANNELS}, _Dep(meta), meta


def verify_cube(viz: Path, level, cube) -> list:
    errs = []
    for rel, nb, sh in zip(cube["webp"]["paths"], cube["webp"]["bytes"], cube["webp"]["sha256"]):
        p = viz / rel
        if not p.is_file() or p.stat().st_size != nb or hashlib.sha256(p.read_bytes()).hexdigest() != sh:
            errs.append(f"{level}: {rel} missing or changed")
    g = viz / cube["gz"]["path"]
    if not g.is_file() or g.stat().st_size != cube["gz"]["bytes"] or \
            hashlib.sha256(g.read_bytes()).hexdigest() != cube["gz"]["sha256"]:
        errs.append(f"{level}: {cube['gz']['path']} missing or changed")
    if not errs:
        n = S.N
        dec = [S.VP.decode_webp((viz / p).read_bytes()) for p in cube["webp"]["paths"]]
        if hashlib.sha256(S.VP.atlas_to_raw(dec, n, 3)).hexdigest() != cube["raw_sha256"]:
            errs.append(f"{level}: WebP → raw sha256 mismatch")
        try:
            S.decode_cube_gz(viz, cube)
        except ValueError as e:
            errs.append(f"{level}: gz {e}")
    return errs


def report_sizes(cubes: dict):
    ok = True
    for lv, c in cubes.items():
        wb, gb = sum(c["webp"]["bytes"]) / 1e6, c["gz"]["bytes"] / 1e6
        flag = "OK" if wb <= BUDGET_WEBP_MB[lv] and gb <= BUDGET_GZ_MB[lv] else "OVER BUDGET"
        ok &= flag == "OK"
        print(f"[size] {lv}: webp {wb:.2f} MB (≤ {BUDGET_WEBP_MB[lv]})  gz {gb:.2f} MB (≤ {BUDGET_GZ_MB[lv]})  "
              f"range [{c['vmin']}, {c['vmax']}]  empty {100 * c['stats']['frac_empty']:.1f} %  {flag}")
    return ok


def main(argv=None):
    lib = config.library_dir()
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--viz", type=Path, default=lib / "viz")
    ap.add_argument("--cache", type=Path, default=lib / "viz_cache" / "stars")
    ap.add_argument("--cutout", type=Path, default=S.DEFAULT_CUTOUT)
    ap.add_argument("--levels", default="S0,S1,S2")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    levels = [s.strip() for s in a.levels.split(",") if s.strip()]
    bad = [s for s in levels if s not in S.STAR_LEVELS]
    if bad:
        ap.error(f"unknown levels {bad}; choose from {list(S.STAR_LEVELS)}")
    viz = a.viz
    frag_path = viz / "stars" / "manifest_stars.json"
    print(f"[stars] {S.GENERATOR}  encoding via {S.VIZPACK_SOURCE}", flush=True)

    old = {}
    if frag_path.is_file():
        try:
            old = json.loads(frag_path.read_text())["stars"]["cubes"]
        except (ValueError, KeyError):
            old = {}

    if a.check:
        errs = [e for lv, c in old.items() for e in verify_cube(viz, lv, c)]
        report_sizes(old)
        print("[check] OK" if not errs and old else f"[check] FAIL: {errs or 'no fragment'}")
        return 0 if not errs and old else 1

    t_all = time.time()
    t = time.time()
    pt4 = S.read_pt4(a.cutout, a.cache, lock=a.lock)
    arr = S.star_arrays(pt4)
    del pt4
    mtot = arr["m"].sum()
    print(f"[read] {time.time() - t:.1f}s  stars {arr['n_total']:,}  winds excluded {arr['n_wind']:,}  "
          f"kept {arr['h_kpc'].size:,}  (kept stellar mass {mtot:.4e} Msun)", flush=True)

    cubes_out = {lv: c for lv, c in old.items() if lv not in levels and not verify_cube(viz, lv, c)}
    ctx = mp.get_context("spawn")
    with ProcessPoolExecutor(max_workers=max(1, a.workers), mp_context=ctx) as pool:
        for lv in levels:
            t = time.time()
            cubes, dep, meta = deposit_level(arr, lv, a.cache, a.workers, a.force)
            cube = S.write_level(viz, lv, cubes, dep, workers=a.workers, pool=pool)
            cube["deposit"]["workers"] = int(meta["workers"])
            cubes_out[lv] = cube
            del cubes
            print(f"[{lv}] done in {time.time() - t:.1f}s  rss {_rss_gb():.2f} GB", flush=True)

    frag = S.fragment(cubes_out)
    tmp = frag_path.with_name(frag_path.name + ".tmp")
    frag_path.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(frag, indent=1) + "\n")
    os.replace(tmp, frag_path)
    errs = [e for lv, c in cubes_out.items() for e in verify_cube(viz, lv, c)]
    ok = report_sizes(cubes_out)
    print(f"[stars] fragment {frag_path} ({len(cubes_out)} cubes)  verify {'OK' if not errs else errs}  "
          f"total {time.time() - t_all:.1f}s  peak rss {_rss_gb():.2f} GB", flush=True)
    return 0 if not errs and ok else 1


if __name__ == "__main__":
    sys.exit(main())
