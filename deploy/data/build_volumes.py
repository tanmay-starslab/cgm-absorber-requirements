#!/usr/bin/env python3
"""Build the nested raw-resolution gas cubes of the 3D viewer (Phase-2b design §4.1–4.3).

    python deploy/data/build_volumes.py [--viz DIR] [--cache DIR] [--index FILE] [--levels L0,L1,L2]
                                        [--fields nH,T,Z,<ion keys>] [--workers 4] [--deposit-workers 1]
                                        [--lock FILE] [--force] [--check]

Stages (each resumable from --cache):
  1. cells   — every gas cell of the slim cutout through `Generator.load()` (yt + trident, same metallicity override
               and ion table as the rays), order-checked against the h5py file, cached as cells_<name>.npy.
  2. deposit — per level ONE `tngsight.deposit.scatter` of the extensive quantities the --fields need (N_nH and m
               always); float32 cubes <L>_<field>.npy + <L>.json (DepositResult numbers). A level whose cubes for
               --fields are cached is reused unless --force (so the 9 Phase-3 ions can be added to an existing cache).
  3. encode  — shared full-range log10 → u8 per field (L0 masked at r > 400 kpc), proj/vol windows, WebP atlases
               (process pool, --workers) + gzip raw, content-hashed, under <viz>/gas/<L>/; <viz>/gas/manifest_gas.json.
               Unchanged cubes (same raw sha256, files intact) are not re-encoded.
  4. checks  — conservation, lost fractions, sizes, the column checks of design §4.3 items 3–5.
--check alone runs only stage 4 (+ manifest validation) from the cache. viz/manifest_v2.json is never written here
(`python -m tngsight.vizpack merge` does that at integration). Heavy I/O (stage 1) runs under the fcntl lock --lock.
--deposit-workers sets the scatter processes (CORE measured 1 as fastest for 7 quantities); --workers the encoders.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import math
import os
import resource
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))
import numpy as np  # noqa: E402
from tngsight import config, deposit as D, volume as V  # noqa: E402

DEFAULT_LOCK = Path(os.environ["TNG_HEAVY_LOCK"]) if os.environ.get("TNG_HEAVY_LOCK") else None
CM = V.CM_PER_KPC
IONS = tuple((k, k) for k in V.ION_KEYS)                         # (VOL key, npz line key): the registry keys
CHECKS = {"L1": ("face_b050_a090", "rand_b031_a334_s175141482", "rand_b008_a049_s51205422"),
          "L2": ("rand_b010_a020_s339575117", "rand_b008_a049_s51205422", "rand_b006_a031_s708179283"),
          "L0": ("face_b050_a090", "edge_b100_a090", "rand_b031_a334_s175141482")}
INFO_L1 = ("rand_b010_a020_s339575117",)
TOL = {k: 0.15 for k in V.ION_KEYS} | {"OVI": 0.10, "CIII": 0.10}    # L1/L2 segment checks; L0 full ray: 0.15 all
SIDE_VERSION = 2                     # 2: gas h floor GAS_H_MIN_VOX = 2 Δ (tune1)


@contextlib.contextmanager
def heavy_lock(path):
    if path is None:
        yield
        return
    with open(path, "a") as fh:
        t = time.time()
        fcntl.flock(fh, fcntl.LOCK_EX)
        if time.time() - t > 1:
            print(f"[lock] waited {time.time() - t:.0f}s for {path}", flush=True)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def rss_gb():
    s = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    c = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    k = 1e9 if sys.platform == "darwin" else 1e6                 # macOS reports bytes, Linux kB
    return s / k, c / k


# ------------------------------------------------------------------------------------------ stage 1: cells
def get_cells(cache: Path, index, lock, force=False) -> dict:
    cells = None if force else V.load_cells(cache)
    if cells is not None:
        print(f"[cells] cached: {len(cells['m']):,} cells from {cache}", flush=True)
        return cells
    with heavy_lock(lock):
        from tngsight.generate import Generator
        t0 = time.time()
        g = Generator(index_filename=index, workdir=cache / "_work")
        g.load()
        t1 = time.time()
        cells = V.cell_arrays(g.ds)
        t2 = time.time()
        dpos = V.check_order(cells["pos_disk"], g.cutout)
        try:
            h_yt = g.ds.all_data()["PartType0", "smoothing_length"].to("kpc").d
            dh = float(np.max(np.abs(h_yt / cells["h"] - 1.0)))
        except Exception as e:                                   # diagnostic only
            dh = f"n/a ({type(e).__name__})"
    if dpos != 0.0:
        raise RuntimeError(f"cell order differs from the h5py file order: max|Δpos| = {dpos} kpc")
    V.save_cells(cells, cache)
    meta = {"n_cells": int(len(cells["m"])), "cutout": str(g.cutout), "order_max_dpos_kpc": dpos,
            "h_vs_yt_smoothing_length_max_rel": dh, "load_s": round(t1 - t0, 1), "fields_s": round(t2 - t1, 1),
            "volume": V.GENERATOR}
    (cache / "cells_meta.json").write_text(json.dumps(meta, indent=1))
    print(f"[cells] {meta['n_cells']:,} cells: load {t1 - t0:.0f}s, fields {t2 - t1:.0f}s, order max|Δpos| {dpos}, "
          f"h vs yt smoothing_length max rel {dh}", flush=True)
    return cells


# ------------------------------------------------------------------------------------------ stage 2: deposit
def level_paths(cache: Path, L):
    return {k: cache / f"{L}_{k}.npy" for k in V.VOL_KEYS}, cache / f"{L}.json"


def level_cached(cache, L, keys=V.VOL_KEYS) -> bool:
    """True when the level's side file is current and the cubes of every field in `keys` (+ nH) exist."""
    npys, side = level_paths(cache, L)
    if not side.is_file() or not all(npys[k].is_file() for k in set(keys) | {"nH"}):
        return False
    try:
        s = json.loads(side.read_text())
        return s.get("side_version") == SIDE_VERSION and s.get("volume") == V.GENERATOR \
            and s.get("deposit_generator", "").startswith(D.GENERATOR) and s.get("n") == V.N
    except ValueError:
        return False


def deposit_level(cells, L, cache: Path, workers, keys=V.VOL_KEYS) -> dict:
    """Deposit the fields `keys` (+ nH; only the quantities they need) of level L into the cache."""
    t = time.time()
    last = [0.0]

    def prog(done, total):
        if time.time() - last[0] > 20:
            last[0] = time.time()
            print(f"[deposit] {L} {done / max(total, 1):6.1%} of {total / 1e6:.0f} M pairs", flush=True)
    keys = tuple(k for k in V.VOL_KEYS if k in set(keys) | {"nH"})
    cubes, dep = V.build_level(cells, L, workers=workers, progress=prog, keys=keys)
    nums = V.deposit_numbers(dep)
    for q in ("N_nH", "m"):
        if nums["conservation_rel"][q] > 1e-6:
            raise RuntimeError(f"{L}: conservation {q} {nums['conservation_rel'][q]:.2e} > 1e-6")
    npys, side = level_paths(cache, L)
    cache.mkdir(parents=True, exist_ok=True)
    for k, a in cubes.items():
        tmp = npys[k].with_name(npys[k].name + ".part.npy")
        np.save(tmp, a.astype(np.float32)); tmp.replace(npys[k])
    if side.is_file():                                          # fields deposited by earlier (subset) runs
        try:
            prev = json.loads(side.read_text())
            if prev.get("side_version") == SIDE_VERSION and prev.get("n") == V.N:
                for d in ("conservation_rel", "lost_fraction", "q_in", "q_full_inside", "q_lost"):
                    nums[d] = {**(prev.get(d) or {}), **nums[d]}
        except ValueError:
            pass
    nums.update({"side_version": SIDE_VERSION, "volume": V.GENERATOR, "level": L, "n": V.N,
                 "gas_h_min_vox": V.GAS_H_MIN_VOX,
                 "half_kpc": V.GAS_LEVELS[L], "wall_s": round(time.time() - t, 1)})
    side.write_text(json.dumps(nums, indent=1))
    print(f"[deposit] {L}: {nums['n_elements']:,} elements, {nums['n_straddling']:,} straddling, "
          f"levels {nums['level_counts']}, {nums['pairs'] / 1e6:.0f} M pairs, scatter {nums['seconds']:.1f}s, "
          f"wall {nums['wall_s']:.1f}s; conservation N_nH {nums['conservation_rel']['N_nH']:.1e} "
          f"m {nums['conservation_rel']['m']:.1e}; lost m {nums['lost_fraction']['m']:.3%}", flush=True)
    return nums


def load_level(cache, L, keys=V.VOL_KEYS) -> dict:
    npys, _ = level_paths(cache, L)
    return {k: np.load(npys[k]).astype(np.float64) for k in keys}


def side_numbers(cache, L) -> dict:
    return json.loads(level_paths(cache, L)[1].read_text())


# ------------------------------------------------------------------------------------------ stage 3: encode
def old_fragment(viz: Path):
    p = viz / "gas" / "manifest_gas.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except ValueError:
        return None


def encode(cubes: dict, nums: dict, keys, viz: Path, workers: int, force=False, allow_range=()) -> dict:
    """cubes: {L: {field: float64}} for every built level; returns {field: field entry}."""
    levels = [L for L in V.GAS_LEVELS if L in cubes]
    old = old_fragment(viz)
    old_fields = (old or {}).get("gas", {}).get("fields", {})
    entries, jobs, reuse = {}, [], {}
    problems = []
    for k in keys:
        vmin, vmax = V.field_range(cubes, k)
        problems += V.check_expected_range(k, vmin, vmax)
        proj = V.proj_window(cubes, k)
        vwin = V.vol_window(cubes, k, vmax)
        entries[k] = V.field_entry(k, vmin, vmax, proj, vwin, {})
        print(f"[range] {k:4s} [{vmin:+.1f}, {vmax:+.1f}]  proj [{proj['vmin']:.1f}, {proj['vmax']:.1f}] "
              f"{proj['units']}  vol_window {vwin}", flush=True)
    for p in problems:
        print(f"[range] OUTSIDE design §3.4 bounds: {p}"
              + ("  (accepted by --allow-range)" if p.split(":")[0] in allow_range else ""), flush=True)
    if [p for p in problems if p.split(":")[0] not in allow_range]:
        raise SystemExit("stop: encoding range outside the design §3.4 sanity bounds (nothing written)")
    for L in levels:
        msk = V.level_mask(L)
        for k in keys:
            e = entries[k]
            q = V.VP.quantize(cubes[L][k], msk, e["vmin"], e["vmax"])
            stats = V.cube_stats(cubes[L][k], q)
            prim = V.PRIMARY[k]
            dep = {"n_elements": nums[L]["n_elements"], "n_straddling": nums[L]["n_straddling"],
                   "lost_fraction": round(nums[L]["lost_fraction"][prim], 6), "seconds": nums[L]["seconds"],
                   "workers": int(nums[L]["workers"] or 1)}
            raw_sha = V._sha(V.VP.raw_gas(q))
            oc = old_fields.get(k, {}).get("cubes", {}).get(L)
            if not force and oc and oc.get("raw_sha256") == raw_sha and oc.get("vmin") == e["vmin"] \
                    and oc.get("vmax") == e["vmax"] and V.cube_files_ok(viz, oc):
                reuse[(L, k)] = {**oc, "stats": stats, "deposit": dep}
            else:
                jobs.append((str(viz), L, k, q, e["vmin"], e["vmax"], stats, dep))
    t = time.time()
    print(f"[encode] {len(jobs)} cubes to encode, {len(reuse)} unchanged; {workers} processes", flush=True)
    done = dict(reuse)
    if jobs:
        with ProcessPoolExecutor(max_workers=max(1, workers)) as ex:
            for job, cube in zip(jobs, ex.map(V.encode_cube_job, jobs)):
                done[(job[1], job[2])] = cube
                print(f"[encode] {job[1]}/{job[2]:4s} webp {sum(cube['webp']['bytes']) / 1e6:5.2f} MB  "
                      f"gz {cube['gz']['bytes'] / 1e6:5.2f} MB  ({time.time() - t:.0f}s)", flush=True)
    for (L, k), cube in done.items():
        entries[k]["cubes"][L] = cube
    print(f"[encode] done in {time.time() - t:.0f}s", flush=True)
    return entries


# ------------------------------------------------------------------------------------------ stage 4: checks
def clip_box(p0, p1, half):
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    d = p1 - p0
    t0, t1 = 0.0, 1.0
    for a in range(3):
        if abs(d[a]) < 1e-15:
            if abs(p0[a]) > half:
                return None
            continue
        lo, hi = sorted(((-half - p0[a]) / d[a], (half - p0[a]) / d[a]))
        t0, t1 = max(t0, lo), min(t1, hi)
    return (p0 + t0 * d, p0 + t1 * d) if t1 > t0 else None


def sightline(lib: Path, sid):
    """(p0, p1, {line: ray logN}) of a library sightline (npz v2 or v1; a v1 file has no H I Lyα column)."""
    from tngsight import library as Lb
    p = lib / "sightlines" / f"{sid}.npz"
    if not p.is_file():
        return None
    pay = Lb.load_npz(p)
    return (D.to_disk(np.array([pay["geom"]["start_kpc"]]))[0], D.to_disk(np.array([pay["geom"]["end_kpc"]]))[0],
            pay["logN"])


def check_ions(cache: Path, keys=None):
    """The (VOL key, npz key) pairs to column-check: requested ions whose cubes are cached on every level."""
    want = [k for k, _ in IONS if keys is None or k in keys]
    return [(k, lk) for k, lk in IONS if k in want
            and all(level_paths(cache, L)[0][k].is_file() for L in CHECKS)]


def log10s(x):
    return math.log10(x) if x > 0 else -math.inf


def column_checks(cells, cache: Path, frag, lib: Path, viz: Path, keys=None) -> dict:
    ions = check_ions(cache, keys)
    ext = {k: cells[k] * cells["V_cm3"] for k, _ in ions}
    pos, h = cells["pos_disk"], cells["h"]
    fields = frag["gas"]["fields"] if frag else {}
    sl = {sid: sightline(lib, sid) for sid in {s for v in CHECKS.values() for s in v} | set(INFO_L1)}
    rows, fails = [], []

    def ref(a, b, k):
        return log10s(D.line_integral(pos, h, ext[k], a, b) / CM ** 2)

    for L in ("L1", "L2", "L0"):
        half = V.GAS_LEVELS[L]
        cub = load_level(cache, L, [k for k, _ in ions])
        ids = CHECKS[L] + (INFO_L1 if L == "L1" else ())
        for sid in ids:
            if sl.get(sid) is None:
                print(f"[check] {sid}: npz missing"); continue
            p0, p1, logN = sl[sid]
            if L == "L0":
                seg = (p0, p1)
            else:
                seg = clip_box(p0, p1, half)
                if seg is None:
                    print(f"[check] {L} {sid}: misses the box"); continue
            a, b = seg
            info = sid in INFO_L1 and L == "L1"
            for k, lk in ions:
                cube4 = log10s(D.cube_column(cub[k], half, a, b, 4.0) * CM)
                cube8 = log10s(D.cube_column(cub[k], half, a, b, 8.0) * CM)
                if L == "L0" and lk not in logN:
                    continue                                    # v1 library npz: no column for this line
                target = logN[lk] if L == "L0" else ref(a, b, k)
                d = cube4 - target
                tol = 0.15 if L == "L0" else TOL[k]
                r = {"level": L, "sid": sid, "ion": k, "seg_kpc": round(float(np.linalg.norm(b - a)), 1),
                     "ref": round(target, 3), "ref_kind": "npz" if L == "L0" else "line_integral",
                     "cube4": round(cube4, 3), "d": round(d, 3), "tol": tol, "info": info}
                if k in fields and L in fields[k]["cubes"]:
                    c = fields[k]["cubes"][L]
                    q = u8_cube(viz, c)
                    u8 = V.VP.column_from_u8(q, c["vmin"], c["vmax"], half, a, b, spv=1.0)
                    r["u8"] = round(u8, 3); r["d_u8"] = round(u8 - cube8, 4)
                    if abs(u8 - cube8) > 0.02 and not info:
                        fails.append(f"u8 {L} {sid} {k} {u8 - cube8:+.3f}")
                if abs(d) > tol and not info:
                    fails.append(f"physics {L} {sid} {k} {d:+.3f}")
                rows.append(r)
                print(f"[check] {L} {sid:27s} {k:4s} seg {r['seg_kpc']:6.1f} kpc  {r['ref_kind']:13s} "
                      f"{target:7.3f}  cube {cube4:7.3f}  Δ {d:+.3f} (≤{tol}){'  [info]' if info else ''}"
                      + (f"  u8-vs-float {r['d_u8']:+.4f}" if "d_u8" in r else ""), flush=True)
        del cub
    full = []
    for sid in sorted(set(CHECKS["L0"]) | set(CHECKS["L1"])):
        if sl.get(sid) is None:
            continue
        p0, p1, logN = sl[sid]
        for k, lk in ions:
            if lk not in logN:
                continue
            r_ = ref(p0, p1, k)
            dd = r_ - logN[lk]
            full.append({"sid": sid, "ion": k, "line_integral": round(r_, 3), "npz": round(logN[lk], 3),
                         "d": round(dd, 4)})
            if abs(dd) > 0.02:
                fails.append(f"reference {sid} {k} {dd:+.3f}")
            print(f"[check] reference full ray {sid:27s} {k:4s} line_integral {r_:7.3f}  npz {logN[lk]:7.3f}  "
                  f"Δ {dd:+.4f} (≤0.02)", flush=True)
    return {"rows": rows, "reference": full, "fails": fails}


_U8_CACHE: dict = {}


def u8_cube(viz: Path, c) -> np.ndarray:
    """q (n,n,n) [i,j,k] of a CUBE entry from its gzip raw file (sha256-checked)."""
    import gzip
    key = c["raw_sha256"]
    if key not in _U8_CACHE:
        raw = gzip.decompress((Path(viz) / c["gz"]["path"]).read_bytes())
        if V._sha(raw) != c["raw_sha256"]:
            raise RuntimeError(f"{c['gz']['path']}: raw sha256 mismatch")
        n = round(len(raw) ** (1 / 3))
        _U8_CACHE.clear()
        _U8_CACHE[key] = np.frombuffer(raw, np.uint8).reshape(n, n, n).transpose(2, 1, 0)
    return _U8_CACHE[key]


def validate(frag, viz: Path) -> str:
    V.validate_gas_fragment(frag, base_dir=viz)
    msg = "gas fragment OK (sizes + sha256)"
    if hasattr(V.VP, "validate_manifest_v2"):
        V.VP.validate_manifest_v2(V.merged_for_validation(frag), base_dir=viz, sections=("gas",))
        msg += "; vizpack.validate_manifest_v2 on the temporary merged manifest OK"
    else:
        msg += "; tngsight.vizpack not available -> validate_manifest_v2 NOT run (compat twin in use)"
    return msg


def sizes(frag) -> dict:
    out, tw, tg, over = {}, 0, 0, []
    for k, e in frag["gas"]["fields"].items():
        for L, c in e["cubes"].items():
            w, g = sum(c["webp"]["bytes"]), c["gz"]["bytes"]
            out[f"{L}/{k}"] = {"webp_MB": round(w / 1e6, 3), "gz_MB": round(g / 1e6, 3)}
            tw += w; tg += g
            if w > 8.0e6 or g > 12.0e6:
                over.append(f"{L}/{k}")
    return {"cubes": out, "webp_total_MB": round(tw / 1e6, 2), "gz_total_MB": round(tg / 1e6, 2),
            "over_budget": over + (["webp total"] if tw > 130e6 else []) + (["gz total"] if tg > 200e6 else [])}


# ------------------------------------------------------------------------------------------ main
def main(argv=None):
    lib = config.library_dir()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--viz", type=Path, default=lib / "viz")
    ap.add_argument("--cache", type=Path, default=lib / "viz_cache" / "gas")
    ap.add_argument("--index", type=Path, default=config.index_path())
    ap.add_argument("--levels", default=",".join(V.GAS_LEVELS))
    ap.add_argument("--fields", default=",".join(V.VOL_KEYS))
    ap.add_argument("--workers", type=int, default=4, help="WebP/gzip encoder processes")
    ap.add_argument("--deposit-workers", type=int, default=1, help="scatter processes per level")
    ap.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    ap.add_argument("--force", action="store_true", help="re-read cells, re-deposit and re-encode everything")
    ap.add_argument("--check", action="store_true", help="only validation + column checks from the cache")
    ap.add_argument("--allow-range", default="", help="fields whose design §3.4 range bound may be exceeded "
                    "(reported, not fatal); the §2.3 rule still sets the range")
    a = ap.parse_args(argv)
    levels = [s.strip() for s in a.levels.split(",") if s.strip()]
    keys = [s.strip() for s in a.fields.split(",") if s.strip()]
    if [x for x in levels if x not in V.GAS_LEVELS] or [k for k in keys if k not in V.FIELDS]:
        ap.error(f"levels from {list(V.GAS_LEVELS)}, fields from {V.VOL_KEYS}")
    T0 = time.time()
    timings = {}
    print(f"[build] volume {V.GENERATOR}, deposit {D.GENERATOR}, vizpack impl {V.VIZPACK_IMPL}", flush=True)
    t = time.time()
    cells = get_cells(a.cache, a.index, a.lock, force=a.force and not a.check)
    timings["cells_s"] = round(time.time() - t, 1)

    if not a.check:
        nums = {}
        for L in V.GAS_LEVELS:
            if L in levels and (a.force or not level_cached(a.cache, L, keys)):
                t = time.time()
                nums[L] = deposit_level(cells, L, a.cache, a.deposit_workers, keys)
                timings[f"deposit_{L}_s"] = round(time.time() - t, 1)
            elif level_cached(a.cache, L, keys):
                nums[L] = side_numbers(a.cache, L)
                print(f"[deposit] {L}: cached ({nums[L]['seconds']:.1f}s scatter when built)", flush=True)
        missing = [L for L in V.GAS_LEVELS if L not in nums]
        if missing:
            print(f"[deposit] WARNING levels {missing} are not built: ranges use {list(nums)} only", flush=True)
        t = time.time()
        need = sorted(set(keys) | {"nH"})
        cubes = {L: load_level(a.cache, L, need) for L in nums}
        allow = tuple(x.strip() for x in a.allow_range.split(",") if x.strip())
        entries = encode(cubes, nums, keys, a.viz, a.workers, force=a.force, allow_range=allow)
        del cubes
        old = old_fragment(a.viz)
        built = [L for L in V.GAS_LEVELS if L in nums]
        for k, e in ((old or {}).get("gas", {}).get("fields", {}) or {}).items():
            if k not in entries and set(e.get("cubes", {})) == set(built) and \
                    all(V.cube_files_ok(a.viz, c) for c in e["cubes"].values()):
                entries[k] = e
                print(f"[manifest] kept {k} from the previous fragment", flush=True)
        frag = V.gas_fragment(entries, built)
        V.write_fragment(a.viz, frag)
        timings["encode_s"] = round(time.time() - t, 1)
    frag = old_fragment(a.viz)
    if frag is None:
        raise SystemExit(f"no {a.viz / 'gas' / 'manifest_gas.json'}")
    print(f"[manifest] {validate(frag, a.viz)}", flush=True)
    sz = sizes(frag)
    for name, s in sz["cubes"].items():
        print(f"[size] {name:8s} webp {s['webp_MB']:6.2f} MB  gz {s['gz_MB']:6.2f} MB", flush=True)
    print(f"[size] total webp {sz['webp_total_MB']} MB, gz {sz['gz_total_MB']} MB; over budget: "
          f"{sz['over_budget'] or 'none'}", flush=True)
    cons = {}
    for L in frag["gas"]["levels"]:
        s = side_numbers(a.cache, L)
        cons[L] = {"conservation_N_nH": s["conservation_rel"]["N_nH"], "conservation_m": s["conservation_rel"]["m"],
                   "lost_m": s["lost_fraction"]["m"], "lost_N_nH": s["lost_fraction"]["N_nH"],
                   "n_elements": s["n_elements"], "n_straddling": s["n_straddling"], "scatter_s": s["seconds"]}
        print(f"[mass] {L}: conservation N_nH {cons[L]['conservation_N_nH']:.1e}, m {cons[L]['conservation_m']:.1e}; "
              f"lost m {cons[L]['lost_m']:.3%}, N_nH {cons[L]['lost_N_nH']:.3%}", flush=True)
    t = time.time()
    chk = column_checks(cells, a.cache, frag, lib, a.viz, keys=[k for k in keys if k in V.ION_KEYS] or None)
    timings["checks_s"] = round(time.time() - t, 1)
    timings["total_s"] = round(time.time() - T0, 1)
    rs, rc = rss_gb()
    report = {"timings": timings, "peak_rss_gb": {"self": round(rs, 2), "children_max": round(rc, 2)},
              "sizes": sz, "mass": cons, "checks": chk, "vizpack_impl": V.VIZPACK_IMPL}
    (a.cache / ("check_report.json" if a.check else "build_report.json")).write_text(json.dumps(report, indent=1))
    print(f"[build] timings {timings}; peak RSS self {rs:.2f} GB, largest child {rc:.2f} GB", flush=True)
    if chk["fails"]:
        print(f"[build] CHECK FAILURES: {chk['fails']}", flush=True)
        return 1
    print("[build] all checks pass", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
