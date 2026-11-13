#!/usr/bin/env python3
"""Build the nested raw-resolution gas cubes of the 3D viewer (Phase-2b design §4.1–4.3).

    python deploy/data/build_volumes.py [--library DIR] [--viz DIR] [--cache DIR] [--index FILE] [--cutout FILE]
                                        [--levels L0,L1,L2] [--fields nH,T,Z,<ion keys>,vx,vy,vz] [--workers 4]
                                        [--deposit-workers 1] [--lock FILE] [--force] [--check] [--report FILE]
                                        [--no-merge-manifest]

Stages (each resumable from --cache):
  1. cells   — every gas cell of the slim cutout through `Generator.load()` (yt + trident, same metallicity override
               and ion table as the rays), order-checked against the h5py file, cached as cells_<name>.npy.
  2. deposit — per level ONE `tngsight.deposit.scatter` of the extensive quantities the --fields need (N_nH and m
               always); float32 cubes <L>_<field>.npy + <L>.json (DepositResult numbers). A level whose cubes for
               --fields are cached is reused unless --force (so the 9 Phase-3 ions can be added to an existing cache).
  3. encode  — shared full-range log10 → u8 per field (L0 masked at r > 400 kpc), proj/vol windows, WebP atlases
               (process pool, --workers) + gzip raw, content-hashed, under <viz>/gas/<L>/; <viz>/gas/manifest_gas.json.
               Unchanged cubes (same raw sha256, files intact) are not re-encoded.
  4. checks  — conservation, lost fractions, sizes, and the column checks of design §4.3 items 3–5 (`column_checks`):
               each cube column against the field the cube holds, the h_eff = max(h, 2Δ) SPH line integral averaged
               over a 3×3 voxel-footprint bundle (`volume.smoothed_columns`), within `volume.SMOOTH_TOL` (0.05 dex).
               The thin-ray difference (npz ray column, or the cell-h line integral) is reported only.
Velocity fields (vel3d contract): vx, vy, vz are the mass-weighted disk-frame velocity relative to SubhaloVel
(`volume.cell_velocities`, read from the cutout's PartType0/Velocities in h5py order and cached as cells_vel_disk.npy;
a velocity-only run needs only the cached pos_disk, h, V_cm3, m and nH cells, not the yt load), deposited as m·v_i
with the T/Z kernel and floor, and encoded "linear" with one ±V (vizpack.vel_range over L0) shared by the three
components and all levels. A velocity-only run skips the ion column checks and instead checks the u8 round trip.
When <viz>/manifest_v2.json exists, the fields built in this run (and gas.vectors) are merged into it in place
(`vizpack.merge_gas_fields`): every other field and block stays byte-identical. --no-merge-manifest skips that.
--check alone runs only stage 4 (+ manifest validation) from the cache and writes nothing but the report (--report,
default <cache>/check_report.json), so --cache and --viz may be read-only. viz/manifest_v2.json is never written
here except by the velocity/field merge above (`python -m tngsight.vizpack merge` rebuilds it at integration).
Defaults: --library tngsight.config.library_dir(), --viz <library>/viz, --cache <library>/viz_cache/gas, --index
$TNG_INDEX_FILE or <library>/cutout.ewah. Heavy I/O (stage 1) runs under the fcntl lock --lock (default
$TNG_HEAVY_LOCK; unset or '' = no lock). --deposit-workers sets the scatter processes (CORE measured 1 as fastest
for 7 quantities); --workers the encoders.
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

DEFAULT_LOCK = Path(os.environ["TNG_HEAVY_LOCK"]).expanduser() if os.environ.get("TNG_HEAVY_LOCK") else None
CM = V.CM_PER_KPC
IONS = tuple((k, k) for k in V.ION_KEYS)                         # (VOL key, npz line key): the registry keys
# Column-check sightlines per level. L0 uses the full ray, L1/L2 its segment inside the box. rand_b010_a020 was
# info-only on L1 under the Phase-2b thin-ray check (+0.64 dex Si IV, the clump the thin ray misses); against the
# smoothed reference it is an ordinary hard check (+0.001 dex in the C1 gate notes).
CHECKS = {"L1": ("face_b050_a090", "rand_b031_a334_s175141482", "rand_b008_a049_s51205422",
                 "rand_b010_a020_s339575117"),
          "L2": ("rand_b010_a020_s339575117", "rand_b008_a049_s51205422", "rand_b006_a031_s708179283"),
          "L0": ("face_b050_a090", "edge_b100_a090", "rand_b031_a334_s175141482")}
U8_TOL = 0.02                        # u8 cube column against the float cube column (dex)
REF_TOL = 0.02                       # cell-h line integral against the npz ray column on full rays (dex)
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
BASE_CELLS = ("pos_disk", "h", "V_cm3", "m", "nH")          # what a velocity-only deposit needs (N_nH, m, m·v)


def cell_names_for(keys) -> tuple:
    return V.CELL_NAMES if [k for k in keys if k not in V.VEL_KEYS] else BASE_CELLS


def get_cells(cache: Path, index, lock, force=False, keys=V.VOL_KEYS, cutout=None) -> dict:
    cells = _get_base_cells(cache, index, lock, force, cell_names_for(keys))
    if [k for k in keys if k in V.VEL_KEYS]:
        vc = None if force else V.load_cells(cache, V.VEL_CELL_NAMES)
        if vc is None:
            t = time.time()
            cut = cutout or config.cutout_path()
            vd = V.cell_velocities(cut, cells["pos_disk"])
            V.save_cells({"vel_disk": vd}, cache, V.VEL_CELL_NAMES)
            print(f"[cells] velocities from {Path(cut).name}: (v - SubhaloVel) @ R^T, order checked, "
                  f"{time.time() - t:.0f}s", flush=True)
            vc = {"vel_disk": vd}
        if vc["vel_disk"].shape != (len(cells["m"]), 3):
            raise RuntimeError(f"cells_vel_disk shape {vc['vel_disk'].shape} != ({len(cells['m'])}, 3)")
        cells.update(vc)
    return cells


def _get_base_cells(cache: Path, index, lock, force, names) -> dict:
    cells = None if force else V.load_cells(cache, names)
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
    """{cube name: npy} (every field + "m", the voxel mass of the velocity weight) and the level side file."""
    return {k: cache / f"{L}_{k}.npy" for k in V.ALL_KEYS + ("m",)}, cache / f"{L}.json"


def cache_names(keys) -> set:
    """The cached cubes a set of fields needs: the fields, nH (always deposited) and m with any velocity."""
    return set(keys) | {"nH"} | ({"m"} if set(keys) & set(V.VEL_KEYS) else set())


def level_cached(cache, L, keys=V.VOL_KEYS) -> bool:
    """True when the level's side file is current and the cubes of every field in `keys` (+ nH, + m) exist."""
    npys, side = level_paths(cache, L)
    if not side.is_file() or not all(npys[k].is_file() for k in cache_names(keys)):
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
    keys = tuple(k for k in V.ALL_KEYS if k in set(keys) | {"nH"})
    cubes, dep = V.build_level(cells, L, workers=workers, progress=prog, keys=keys)
    nums = V.deposit_numbers(dep)
    for q in ("N_nH", "m"):
        if nums["conservation_rel"][q] > 1e-6:
            raise RuntimeError(f"{L}: conservation {q} {nums['conservation_rel'][q]:.2e} > 1e-6")
    mom = {}
    for q in V.VEL_QUANTITIES:                 # Σ m·v_i ≈ 0 after bulk subtraction: relative to Σ m·|v_i| instead
        if q in dep.grids:
            i = "xyz".index(q[2])
            scale = float(np.sum(cells["m"] * np.abs(cells["vel_disk"][:, i])))
            mom[q] = abs(float(dep.grids[q].sum()) - dep.q_in[q]) / max(scale, 1e-300)
    if mom:
        nums["momentum_conservation_rel"] = mom
        if max(mom.values()) > 1e-6:
            raise RuntimeError(f"{L}: momentum conservation {mom} > 1e-6 of sum m|v|")
    npys, side = level_paths(cache, L)
    cache.mkdir(parents=True, exist_ok=True)
    for k, a in cubes.items():
        tmp = npys[k].with_name(npys[k].name + ".part.npy")
        np.save(tmp, a.astype(np.float32)); tmp.replace(npys[k])
    if side.is_file():                                          # fields deposited by earlier (subset) runs
        try:
            prev = json.loads(side.read_text())
            if prev.get("side_version") == SIDE_VERSION and prev.get("n") == V.N:
                for d in ("conservation_rel", "lost_fraction", "q_in", "q_full_inside", "q_lost",
                          "momentum_conservation_rel"):
                    nums[d] = {**(prev.get(d) or {}), **(nums.get(d) or {})}
        except ValueError:
            pass
    nums.update({"side_version": SIDE_VERSION, "volume": V.GENERATOR, "level": L, "n": V.N,
                 "gas_h_min_vox": V.GAS_H_MIN_VOX,
                 "half_kpc": V.GAS_LEVELS[L], "wall_s": round(time.time() - t, 1)})
    side.write_text(json.dumps(nums, indent=1))
    print(f"[deposit] {L}: {nums['n_elements']:,} elements, {nums['n_straddling']:,} straddling, "
          f"levels {nums['level_counts']}, {nums['pairs'] / 1e6:.0f} M pairs, scatter {nums['seconds']:.1f}s, "
          f"wall {nums['wall_s']:.1f}s; conservation N_nH {nums['conservation_rel']['N_nH']:.1e} "
          f"m {nums['conservation_rel']['m']:.1e}; lost m {nums['lost_fraction']['m']:.3%}"
          + (f"; m·v {max(mom.values()):.1e} of sum m|v|" if mom else ""), flush=True)
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
    vel_keys = [k for k in keys if k in V.VEL_KEYS]
    keys = [k for k in keys if k not in V.VEL_KEYS]
    VV = None
    if vel_keys:
        VV = V.vel_V(cubes)
        for k in vel_keys:
            entries[k] = V.vel_field_entry(k, VV, {})
        print(f"[range] {','.join(vel_keys)} linear [-{VV:.0f}, +{VV:.0f}] km/s (mass-weighted p99.9 of |v_i| "
              f"over L0, rounded up to {V.VP.VEL_STEP if hasattr(V.VP, 'VEL_STEP') else 50:.0f})", flush=True)
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
        for k in vel_keys + keys:
            e = entries[k]
            if k in V.VEL_KEYS:
                q = V.VP.quantize_linear(cubes[L][k], msk, VV)
                vel_roundtrip(cubes[L][k], q, VV, f"{L}/{k}")
                stats = V.vel_stats(cubes[L][k], q, cubes[L]["m"])
            else:
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


def vel_roundtrip(v, q, VV, where) -> float:
    """Hard check of the linear encoding: empty exactly where v is NaN, and |decode(q) − clip(v, ±V)| ≤ V/254
    (half a step) everywhere else. Returns the max error [km/s]."""
    v = np.asarray(v, dtype=np.float64)
    fin = np.isfinite(v)
    if not np.array_equal(q > 0, fin):
        raise RuntimeError(f"{where}: empty voxels (q = 0) differ from the NaN voxels of the float cube")
    if not fin.any():
        return 0.0
    err = float(np.max(np.abs(V.VP.dequantize_linear(q[fin], VV) - np.clip(v[fin], -VV, VV))))
    if err > VV / 254.0 * (1 + 1e-9):
        raise RuntimeError(f"{where}: linear u8 round trip error {err:.3f} km/s > V/254 = {VV / 254:.3f}")
    return err


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


ORIENT_WORDS = {"face": "face-on", "edge": "edge-on", "rand": "random"}


def is_sbi_library(lib: Path) -> bool:
    """An SBI_CGM-imported library (galpipe import_sbi): its npz columns come from CLOUDY FG11 ion tables, not the
    Trident HM2012 fractions the cells carry, so the npz-reference check does not apply."""
    return (lib / "spectra_source.json").is_file()


def resolve_checks(lib: Path) -> dict:
    """CHECKS with every sightline missing from <lib>/sightlines replaced by the library ray (from rays.json) of the
    same orientation word whose impact parameter is closest to the named one (ties by id; one ray once per level).
    A library holding the named rays (488530, any Trident library) keeps CHECKS unchanged."""
    p = lib / "rays.json"
    have = lambda s: (lib / "sightlines" / f"{s}.npz").is_file()                       # noqa: E731
    if all(have(s) for v in CHECKS.values() for s in v) or not p.is_file():
        return {L: tuple(v) for L, v in CHECKS.items()}
    rj = json.loads(p.read_text())
    cols = rj["columns"]
    rays = [dict(zip(cols, r)) for r in rj["rays"]]
    rays = [r for r in rays if have(r["id"])]
    out = {}
    for L, names in CHECKS.items():
        used, sel = set(), []
        for s in names:
            if have(s):
                sel.append(s); used.add(s); continue
            word, b = ORIENT_WORDS[s.split("_")[0]], float(s.split("_")[1][1:])
            cand = sorted((abs(float(r["b_kpc"]) - b), r["id"]) for r in rays
                          if r["orientation"] == word and r["id"] not in used)
            if cand:
                sel.append(cand[0][1]); used.add(cand[0][1])
        out[L] = tuple(sel)
    return out


def check_ions(cache: Path, keys=None):
    """The (VOL key, npz key) pairs to column-check: requested ions whose cubes are cached on every level."""
    want = [k for k, _ in IONS if keys is None or k in keys]
    return [(k, lk) for k, lk in IONS if k in want
            and all(level_paths(cache, L)[0][k].is_file() for L in CHECKS)]


def log10s(x):
    return math.log10(x) if x > 0 else -math.inf


def dlog(a, b) -> float:
    """a − b for log10 columns; two empty columns (−inf, −inf) agree (0), one empty column is an infinite miss."""
    return 0.0 if a == b else a - b


def rnd(x, nd=3):
    return round(float(x), nd) if x is not None and math.isfinite(x) else None


def column_checks(cells, cache: Path, frag, lib: Path, viz: Path, keys=None) -> dict:
    """design §4.3 items 3–5 (Phase 3): every cube column against the field the cube holds.

    Hard checks, on every (level, sightline, ion):
    - physics: |cube − smoothed| ≤ V.SMOOTH_TOL, where `smoothed` is the SPH line integral with the deposited
      h_eff = max(h, h_min_vox·Δ) averaged over the 3×3 voxel-footprint bundle (`volume.smoothed_columns`) and
      `cube` the trilinear column of the float cube (4 samples per voxel), both over the L0 ray or the L1/L2 segment;
    - u8: the shipped u8 cube's column against the float cube's (8 samples per voxel) within U8_TOL;
    - reference (full rays of the L0 and L1 sightlines): the cell-h line integral against the npz ray column within
      REF_TOL, which pins the integrator to Trident.
    Reported only (`thin`, `d_thin`): the thin-ray column (npz ray column at L0, cell-h line integral at L1/L2). The
    cube is smoothed to ≥ 2 Δ and averaged over a voxel, so on clumpy gas the thin ray measures the resolution, not
    the deposit (Phase 3: up to 0.64 dex on Si IV, C IV and N V at L0/L1 while the smoothed check holds to 0.046)."""
    ions = check_ions(cache, keys)
    ext = {k: cells[k] * cells["V_cm3"] for k, _ in ions}
    pos, h = cells["pos_disk"], cells["h"]
    fields = frag["gas"]["fields"] if frag else {}
    checks = resolve_checks(lib)
    if checks != {L: tuple(v) for L, v in CHECKS.items()}:
        print(f"[check] named check sightlines not in {lib / 'sightlines'}; nearest-b substitutes: {checks}",
              flush=True)
    sbi = is_sbi_library(lib)
    sl = {sid: sightline(lib, sid) for sid in {s for v in checks.values() for s in v}}
    rows, fails, meta = [], [], {}

    def thin_li(a, b, k):
        return log10s(D.line_integral(pos, h, ext[k], a, b) / CM ** 2)

    for L in ("L1", "L2", "L0"):
        half = V.GAS_LEVELS[L]
        side = side_numbers(cache, L) if level_paths(cache, L)[1].is_file() else {}
        n = int(side.get("n") or V.N)
        hmin = float(side.get("gas_h_min_vox") or V.GAS_H_MIN_VOX)  # the floor the level was deposited with
        dx = 2.0 * half / n
        meta[L] = {"n": n, "dx_kpc": dx, "h_min_vox": hmin}
        segs = {}
        for sid in checks[L]:
            if sl.get(sid) is None:
                print(f"[check] {sid}: npz missing", flush=True); continue
            p0, p1, logN = sl[sid]
            seg = (p0, p1) if L == "L0" else clip_box(p0, p1, half)
            if seg is None:
                print(f"[check] {L} {sid}: misses the box", flush=True); continue
            sm = V.smoothed_columns(pos, h, ext, seg[0], seg[1], dx, h_min_vox=hmin)
            segs[sid] = (seg, logN, {k: log10s(v / CM ** 2) for k, v in sm.items()})
        for k, lk in ions:
            cub = load_level(cache, L, [k])[k]
            if cub.shape != (n, n, n):
                fails.append(f"shape {L} {k} {cub.shape} != {n}^3")
                continue
            for sid, ((a, b), logN, smooth) in segs.items():
                cube4 = log10s(D.cube_column(cub, half, a, b, 4.0) * CM)
                cube8 = log10s(D.cube_column(cub, half, a, b, 8.0) * CM)
                d = dlog(cube4, smooth[k])
                thin = logN.get(lk) if L == "L0" else thin_li(a, b, k)     # a v1 npz has no column for new lines
                r = {"level": L, "sid": sid, "ion": k, "seg_kpc": round(float(np.linalg.norm(b - a)), 1),
                     "ref": rnd(smooth[k]), "ref_kind": "smoothed_bundle", "cube4": rnd(cube4), "d": rnd(d),
                     "tol": V.SMOOTH_TOL, "thin": rnd(thin), "thin_kind": "npz" if L == "L0" else "line_integral",
                     "d_thin": None if thin is None else rnd(dlog(cube4, thin))}
                if k in fields and L in fields[k]["cubes"]:
                    c = fields[k]["cubes"][L]
                    u8 = V.VP.column_from_u8(u8_cube(viz, c), c["vmin"], c["vmax"], half, a, b, spv=1.0)
                    du = dlog(u8, cube8)
                    r["u8"] = rnd(u8); r["d_u8"] = rnd(du, 4)
                    if not abs(du) <= U8_TOL:
                        fails.append(f"u8 {L} {sid} {k} {du:+.3f}")
                if not abs(d) <= V.SMOOTH_TOL:
                    fails.append(f"physics {L} {sid} {k} {d:+.3f}")
                rows.append(r)
                print(f"[check] {L} {sid:27s} {k:6s} seg {r['seg_kpc']:6.1f} kpc  smoothed {smooth[k]:7.3f}  "
                      f"cube {cube4:7.3f}  Δ {d:+.3f} (≤{V.SMOOTH_TOL})"
                      + ("" if r["d_thin"] is None else f"  thin-ray Δ {r['d_thin']:+.3f} [info]")
                      + (f"  u8-vs-float {r['d_u8']:+.4f}" if r.get("d_u8") is not None else ""), flush=True)
            del cub
    full = []
    if sbi:
        print("[check] reference rows skipped: SBI_CGM npz columns use CLOUDY FG11 ion tables, the cells Trident "
              "HM2012 (the import's own sbi_columns gate grades those columns)", flush=True)
    for sid in ([] if sbi else sorted(set(checks["L0"]) | set(checks["L1"]))):
        if sl.get(sid) is None:
            continue
        p0, p1, logN = sl[sid]
        for k, lk in ions:
            if lk not in logN:
                continue
            r_ = thin_li(p0, p1, k)
            dd = dlog(r_, logN[lk])
            full.append({"sid": sid, "ion": k, "line_integral": rnd(r_), "npz": rnd(logN[lk]), "d": rnd(dd, 4)})
            if not abs(dd) <= REF_TOL:
                fails.append(f"reference {sid} {k} {dd:+.3f}")
            print(f"[check] reference full ray {sid:27s} {k:6s} line_integral {r_:7.3f}  npz {logN[lk]:7.3f}  "
                  f"Δ {dd:+.4f} (≤{REF_TOL})", flush=True)
    worst = max(rows, key=lambda r: abs(r["d"]) if r["d"] is not None else math.inf, default=None)
    ok = [r for r in rows if r["d"] is not None and abs(r["d"]) <= V.SMOOTH_TOL]
    thin_off = [r for r in rows if r["d_thin"] is not None and abs(r["d_thin"]) > V.SMOOTH_TOL]
    summary = {"n_rows": len(rows), "n_pass": len(ok), "thin_over_smooth_tol": len(thin_off),
               "worst": None if worst is None else {x: worst[x] for x in ("level", "sid", "ion", "d")},
               "n_reference": len(full), "n_fails": len(fails)}
    print(f"[check] physics {summary['n_pass']}/{summary['n_rows']} within {V.SMOOTH_TOL} dex of the smoothed "
          f"reference (worst {summary['worst']}); thin ray beyond it on {summary['thin_over_smooth_tol']} rows "
          f"(reported only); {len(fails)} hard failure(s)", flush=True)
    return {"rows": rows, "reference": full, "fails": fails, "summary": summary, "method": "smoothed_bundle",
            "tol": V.SMOOTH_TOL, "u8_tol": U8_TOL, "ref_tol": REF_TOL, "levels": meta,
            "bundle_offsets_vox": list(V.BUNDLE_OFFSETS), "sightlines": {L: list(v) for L, v in checks.items()},
            "reference_skipped": "sbi library (CLOUDY FG11 npz columns vs Trident HM2012 cells)" if sbi else None}


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
def _opt_path(s):
    return Path(s).expanduser() if s else None                  # '' -> None (e.g. --lock '' = no lock)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--library", type=Path, default=None, help="library root whose sightlines/<id>.npz the column "
                    "checks use (default tngsight.config.library_dir())")
    ap.add_argument("--viz", type=Path, default=None, help="default <library>/viz")
    ap.add_argument("--cache", type=Path, default=None, help="default <library>/viz_cache/gas")
    ap.add_argument("--index", type=Path, default=None, help="writable yt index (default $TNG_INDEX_FILE, else "
                    "<library>/cutout.ewah)")
    ap.add_argument("--cutout", type=Path, default=None, help="slim cutout the velocities are read from "
                    "(default tngsight.config.cutout_path(), i.e. $TNG_CUTOUT)")
    ap.add_argument("--no-merge-manifest", action="store_true", help="do not merge the built fields into an "
                    "existing <viz>/manifest_v2.json")
    ap.add_argument("--levels", default=",".join(V.GAS_LEVELS))
    ap.add_argument("--fields", default=",".join(V.VOL_KEYS))
    ap.add_argument("--workers", type=int, default=4, help="WebP/gzip encoder processes")
    ap.add_argument("--deposit-workers", type=int, default=1, help="scatter processes per level")
    ap.add_argument("--lock", type=_opt_path, default=DEFAULT_LOCK, help="heavy-I/O fcntl lock file for stage 1 "
                    "(default $TNG_HEAVY_LOCK; '' = no lock)")
    ap.add_argument("--force", action="store_true", help="re-read cells, re-deposit and re-encode everything")
    ap.add_argument("--check", action="store_true", help="only validation + column checks from the cache")
    ap.add_argument("--report", type=Path, default=None, help="JSON report path (default <cache>/check_report.json "
                    "with --check, else <cache>/build_report.json)")
    ap.add_argument("--allow-range", default="", help="fields whose design §3.4 range bound may be exceeded "
                    "(reported, not fatal); the §2.3 rule still sets the range")
    a = ap.parse_args(argv)
    lib = a.library or config.library_dir()
    a.viz = a.viz or lib / "viz"
    a.cache = a.cache or lib / "viz_cache" / "gas"
    a.index = a.index or (Path(os.environ["TNG_INDEX_FILE"]).expanduser() if os.environ.get("TNG_INDEX_FILE")
                          else lib / "cutout.ewah")             # = config.index_path() for the default library
    levels = [s.strip() for s in a.levels.split(",") if s.strip()]
    keys = [s.strip() for s in a.fields.split(",") if s.strip()]
    if [x for x in levels if x not in V.GAS_LEVELS] or [k for k in keys if k not in V.FIELDS]:
        ap.error(f"levels from {list(V.GAS_LEVELS)}, fields from {V.ALL_KEYS}")
    vel_only = bool(keys) and all(k in V.VEL_KEYS for k in keys)
    if set(keys) & set(V.VEL_KEYS) and not set(V.VEL_KEYS) <= set(keys):
        ap.error("vx, vy and vz share one range V and the gas.vectors block: build them together")
    T0 = time.time()
    timings = {}
    print(f"[build] volume {V.GENERATOR}, deposit {D.GENERATOR}, vizpack impl {V.VIZPACK_IMPL}", flush=True)
    t = time.time()
    cells = get_cells(a.cache, a.index, a.lock, force=a.force and not a.check, keys=keys, cutout=a.cutout)
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
        need = sorted(set(keys) | ({"nH"} if not vel_only else set())
                      | ({"m"} if set(keys) & set(V.VEL_KEYS) else set()))
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
        if not a.no_merge_manifest and (a.viz / "manifest_v2.json").is_file():
            V.VP.merge_gas_fields(a.viz, frag, [k for k in V.ALL_KEYS if k in keys])
            print(f"[manifest] merged {','.join(k for k in V.ALL_KEYS if k in keys)}"
                  f"{' + gas.vectors' if 'vectors' in frag['gas'] else ''} into {a.viz / 'manifest_v2.json'} "
                  f"(other fields unchanged)", flush=True)
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
    if vel_only:
        chk = {"rows": [], "reference": [], "fails": [], "method": "skipped (velocity-only run)",
               "summary": {"skipped": "velocity-only run: no ion column checks; linear u8 round trip checked "
                                      "at encode"}}
        print("[check] velocity-only run: ion column checks skipped (u8 round trip checked at encode)", flush=True)
    else:
        chk = column_checks(cells, a.cache, frag, lib, a.viz, keys=[k for k in keys if k in V.ION_KEYS] or None)
    timings["checks_s"] = round(time.time() - t, 1)
    timings["total_s"] = round(time.time() - T0, 1)
    rs, rc = rss_gb()
    report = {"timings": timings, "peak_rss_gb": {"self": round(rs, 2), "children_max": round(rc, 2)},
              "sizes": sz, "mass": cons, "checks": chk, "vizpack_impl": V.VIZPACK_IMPL}
    out = a.report or a.cache / ("check_report.json" if a.check else "build_report.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1))
    print(f"[build] report {out}", flush=True)
    print(f"[build] timings {timings}; peak RSS self {rs:.2f} GB, largest child {rc:.2f} GB", flush=True)
    if chk["fails"]:
        print(f"[build] CHECK FAILURES: {chk['fails']}", flush=True)
        return 1
    print("[build] all checks pass", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
