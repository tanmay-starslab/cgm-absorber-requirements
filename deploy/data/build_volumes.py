#!/usr/bin/env python3
"""Build the 3D viewer's gas volumes (Phase-2 design §3.2) from the slim cutout.

    python deploy/data/build_volumes.py [--out DIR] [--fields nH,T,...] [--n 256] [--cache DIR] [--index FILE]
                                        [--copy-to DIR] [--check-ids ID,ID,...] [--lock FILE] [--force]

Per field: SPH-deposit on the n³ grid ±400 kpc (tngsight.volume.deposit on the Generator dataset) → float32
cache `<cache>/<key>_<n>.npy` (resumable: a cached field is not re-deposited unless --force) → `<out>/<key>.u8.gz`
+ `<key>.<n/2>.u8.gz` → `<out>/manifest.json` (entries of fields not rebuilt this run are kept when their files
still match). Defaults: --out <library>/vol, --cache <library>/vol_cache, --index <library>/cutout.ewah (read-only
use; pass a writable scratch path to build a fresh one). The yt part runs under an exclusive fcntl lock on
--lock FILE serialises heavy I/O with other jobs (default: $TNG_HEAVY_LOCK, else no lock; macOS has no flock(1)).
Validation (printed, not CI): log N of O VI / H I / C III integrated through the grid along the straight segments
of the --check-ids library rays (trilinear, 0.5-voxel steps) vs the npz log N.
"""
from __future__ import annotations
import argparse
import contextlib
import fcntl
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))
import numpy as np  # noqa: E402
from tngsight import config, library as L, volume as V  # noqa: E402

DEFAULT_LOCK = Path(os.environ["TNG_HEAVY_LOCK"]) if os.environ.get("TNG_HEAVY_LOCK") else None
CHECK_IDS = ("face_b050_a090", "edge_b100_a090", "rand_b031_a334_s175141482")
CHECK_PAIRS = (("OVI", "OVI"), ("HI", "HILyb"), ("CIII", "CIII"))      # (VOL key, npz LINE key)


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


def cache_paths(cache: Path, key, n):
    return cache / f"{key}_{n}.npy", cache / f"{key}_{n}.json"


def deposit_missing(keys, n, cache: Path, index, lock, force=False) -> dict:
    """Deposit every key without a cache file; returns {key: source string}."""
    def stale(k):                      # a cache deposited with another SPH normalisation is rebuilt
        npy, meta = cache_paths(cache, k, n)
        if not npy.is_file() or not meta.is_file():
            return True
        try:
            return json.loads(meta.read_text()).get("normalize", True) != V.FIELDS[k]["normalize"]
        except ValueError:
            return True
    todo = [k for k in keys if force or stale(k)]
    if todo:
        cache.mkdir(parents=True, exist_ok=True)
        with heavy_lock(lock):
            from tngsight.generate import Generator
            t0 = time.time()
            g = Generator(index_filename=index, workdir=cache / "_work")
            g.load()
            print(f"[load] dataset ready in {time.time() - t0:.1f}s", flush=True)
            for k in todo:
                t = time.time()
                src = V.field_source(g.ds, k)
                arr = V.deposit(g.ds, k, n).astype(np.float32)
                npy, meta = cache_paths(cache, k, n)
                tmp = npy.with_name(npy.name + ".part.npy")
                np.save(tmp, arr); tmp.replace(npy)
                meta.write_text(json.dumps({"key": k, "n": n, "source": str(tuple(src)),
                                            "normalize": V.FIELDS[k]["normalize"],
                                            "seconds": round(time.time() - t, 1)}))
                print(f"[deposit] {k:4s} n={n} {time.time() - t:7.1f}s source={src}", flush=True)
    out = {}
    for k in keys:
        mp = cache_paths(cache, k, n)[1]
        out[k] = json.loads(mp.read_text())["source"] if mp.is_file() else str(tuple(V.FIELDS[k]["field"]))
    return out


def old_entries(out: Path, n) -> dict:
    p = out / "manifest.json"
    if not p.is_file():
        return {}
    try:
        m = json.loads(p.read_text())
        if str(n) not in m.get("grids", {}):
            return {}
        keep = {}
        for k, e in m["fields"].items():
            try:
                V.validate_manifest({**m, "fields": {k: e}}, base_dir=out)
                keep[k] = e
            except ValueError:
                pass
        return keep
    except (ValueError, KeyError):
        return {}


def check_columns(arrays: dict, ids, lib: Path, half):
    print("[check] log N through the grid vs npz (segment start_kpc → end_kpc)")
    rows = []
    for sid in ids:
        p = lib / "sightlines" / f"{sid}.npz"
        if not p.is_file():
            print(f"[check] {sid}: npz missing at {p}"); continue
        pay = L.load_npz(p)
        p0 = np.array(pay["geom"]["start_kpc"]) - V.CENTER_KPC
        p1 = np.array(pay["geom"]["end_kpc"]) - V.CENTER_KPC
        for vk, lk in CHECK_PAIRS:
            if vk not in arrays:
                continue
            grid = V.integrate_column(arrays[vk], p0, p1, half)
            ref = pay["logN"][lk]
            d = grid - ref
            rows.append((sid, vk, ref, grid, d))
            flag = "" if ref <= 13 or abs(d) <= 0.2 else "  > 0.2 dex"
            print(f"[check] {sid:28s} {vk:4s} npz {ref:7.3f}  grid {grid:7.3f}  Δ {d:+.3f}{flag}", flush=True)
    return rows


def main(argv=None):
    lib = config.library_dir()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=lib / "vol")
    ap.add_argument("--fields", default=",".join(V.VOL_KEYS))
    ap.add_argument("--n", type=int, default=256)
    ap.add_argument("--cache", type=Path, default=lib / "vol_cache")
    ap.add_argument("--index", type=Path, default=config.index_path())
    ap.add_argument("--copy-to", type=Path, default=None)
    ap.add_argument("--check-ids", default=",".join(CHECK_IDS))
    ap.add_argument("--lock", type=Path, default=DEFAULT_LOCK)
    ap.add_argument("--force", action="store_true", help="re-deposit even when a cache file exists")
    a = ap.parse_args(argv)
    keys = [k.strip() for k in a.fields.split(",") if k.strip()]
    bad = [k for k in keys if k not in V.FIELDS]
    if bad:
        ap.error(f"unknown fields {bad}; choose from {V.VOL_KEYS}")
    if a.n % 2 or a.n < 4:
        ap.error("--n must be even and >= 4")

    sources = deposit_missing(keys, a.n, a.cache, a.index, a.lock, a.force)
    mask = V.radial_mask(a.n)
    entries = old_entries(a.out, a.n)
    arrays = {}
    for k in keys:
        t = time.time()
        arr = np.load(cache_paths(a.cache, k, a.n)[0]).astype(np.float64)
        arrays[k] = np.where(mask, arr, np.nan)
        e = V.write_field(a.out, k, arr, mask, source=sources[k])
        entries[k] = e
        hr = str(a.n // 2)
        print(f"[write] {k:4s} lo={e['lo']:+.1f} hi={e['hi']:+.1f} window={e['default_window']} "
              f"{e['bytes'][str(a.n)] / 1e6:6.2f} MB / {e['bytes'][hr] / 1e6:5.2f} MB "
              f"empty={e['stats']['frac_empty']:.3f} p50={e['stats']['p50']:+.2f} ({time.time() - t:.1f}s)",
              flush=True)
    meta = {"n": a.n, "nH_source": entries["nH"]["source"]} if "nH" in entries else {"n": a.n}
    m = V.write_manifest(a.out, entries, meta)
    V.validate_manifest(m, base_dir=a.out)
    total = sum(sum(e["bytes"].values()) for e in m["fields"].values())
    print(f"[manifest] {a.out / 'manifest.json'}: {len(m['fields'])} fields, total {total / 1e6:.2f} MB")
    ids = [s.strip() for s in a.check_ids.split(",") if s.strip()]
    if ids:
        check_columns(arrays, ids, lib, V.HALF_KPC)
    if a.copy_to:
        dst = a.copy_to; dst.mkdir(parents=True, exist_ok=True)
        for e in m["fields"].values():
            for name in e["files"].values():
                shutil.copyfile(a.out / name, dst / name)
        shutil.copyfile(a.out / "manifest.json", dst / "manifest.json")
        V.load_manifest(dst); V.validate_manifest(json.loads((dst / "manifest.json").read_text()), base_dir=dst)
        print(f"[copy] -> {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
