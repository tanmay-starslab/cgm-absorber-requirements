#!/usr/bin/env python
"""Near-field tube of gas cells around the story ray (story-data/2, DESIGN_final D4 / section 3.4 "near field").

Every gas cell whose generator lies within the capsule radius of the story ray segment, packed for instanced kernel
splats: one 14-byte record per cell, sorted by l (the projection on the ray), with an l index so the stage can draw only
the cells inside its travelling capsule (drawRange). The radius is max(20 kpc, the 90 % ion-content radius of the
shells lettered A and D), so the capsule covers those clouds (C_eng P0-4, P2-8).

Usage:
  python scripts/build_story_tube.py [--galaxy 488530] [--ray rand_b062_a062] [--work DIR] [--out DIR]
Needs <work>/<gid>_<ray>_cells.npz (export_story_data cells) and, for cloud ids and the radius, the clouds of
build_story_clouds.py (<out>/clouds/<gid>_<ray>/clouds.json and <work>/<gid>_<ray>_cloud_members.npz).
Writes <out>/tube/<gid>_<ray>.bin.gz and <out>/tube/<gid>_<ray>.json.
"""
from __future__ import annotations
import argparse
import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
import export_story_data as E            # noqa: E402
import build_story_clouds as BC          # noqa: E402

PAD_KPC = 10.0                           # cells this far beyond either end of the segment are kept
REC = np.dtype([("q", "<u2", 3), ("nH", "u1"), ("T", "u1"), ("Z", "u1"), ("r", "u1"), ("hi", "u1"), ("ovi", "u1"),
                ("cl", "u1"), ("v", "i1")])
ENC = {"record": "14 B little endian, packed: u2x3 ray-frame position (l, up, side) = lo + q/65535*span (kpc; l along "
                 "the ray, 0 at its midpoint; up/side along ray.frame), u1 log10 n_H cm^-3 ((x/255)*8 - 7), "
                 "u1 log10 T K ((x/255)*5 + 3), u1 log10 Z/Zsun ((x/255)*4 - 3; Zsun = 0.0127, the explorer cubes convention), u1 log10 r_eq kpc ((x/255)*3.5 - 2; "
                 "kernel h = 2 r_eq), u1 log10 n_HI cm^-3 ((x/255)*16 - 16), u1 log10 n_OVI cm^-3 ((x/255)*16 - 16), "
                 "u1 cloud ids (low nibble H I cloud index + 1, high nibble O VI cloud index + 1; 0 = none, 15 = index >= "
                 "14), i1 V_los / 4 km/s (spectrum frame, galaxy systemic at 0; clipped at +-508)",
       "order": "sorted by l; l_index[k] = first record with l >= l_index_l0 + k (1 kpc bins), last entry = n"}


def q8(x, lo, span):
    return np.clip(np.round((x - lo) / span * 255), 0, 255).astype(np.uint8)


def build(gid, ray_id, work: Path, out: Path):
    from tngsight.library import load_npz
    gid = int(gid)
    paths = E.galaxy_paths(gid)
    st = E.stem(gid, ray_id)
    lib = E.story_library(gid, ray_id, work, paths)   # one-ray Trident library from stage_cells, if any
    p = load_npz(str(lib / "sightlines" / f"{ray_id}.npz"), id=ray_id)
    gal = json.loads(paths["galaxy_json"].read_text())
    ray = E.story_ray(p["geom"], gal)
    # radius from the lettered shells
    cj = out / "clouds" / st / "clouds.json"
    cw = json.loads(cj.read_text()) if cj.exists() else None
    radius, why = E.TUBE_RADIUS_MIN, "floor"
    sp = out / f"story_{st}.json"
    if cw and sp.exists():
        names = json.loads(sp.read_text()).get("cloud_names") or {}
        for L in ("A", "D"):
            for key, lst in names.get("letters", {}).get(L, {}).items():
                for e in lst:
                    c = next(c for c in cw["ions"][key]["clouds"] if c["id"] == e["id"])
                    r = float(c.get("r_perp_90", c["r_perp_max"]))
                    if r > radius:
                        radius, why = r, f"r_perp_90 of {e['id']} (cloud {L})"
    radius = math.ceil(radius)
    cells, src = BC.load_tube_cells(gid, paths, gal, ("HI", "OVI"), float(gal["TNG_H"]), extra=("nH", "Z"))
    extra = {"nH": cells["nH"], "Z": cells["Z"]}                 # Z in Zsun (tngsight.volume convention)
    pos_d = (cells["xb"] - ray["centre"]) @ ray["R"].T
    rel = pos_d - ray["p0"]; s = rel @ ray["n"]
    perp_v = rel - s[:, None] * ray["n"]
    perp = np.linalg.norm(perp_v, axis=1)
    sel = np.flatnonzero((perp <= radius) & (s >= -PAD_KPC) & (s <= ray["L"] + PAD_KPC))
    l = s[sel] - ray["half"]
    order = np.argsort(l, kind="stable"); sel = sel[order]; l = l[order]
    up = perp_v[sel] @ ray["up"]; side = perp_v[sel] @ ray["side"]
    P = np.stack([l, up, side], 1)
    lo = P.min(0); span = np.maximum(P.max(0) - lo, 1e-6)
    rec = np.zeros(sel.size, REC)
    assert REC.itemsize == 14
    rec["q"] = np.round((P - lo) / span * 65535).astype(np.uint16)
    lg = lambda a: np.log10(np.maximum(np.asarray(a)[sel], 1e-30))      # noqa: E731
    rec["nH"] = q8(lg(extra["nH"]), -7, 8)
    rec["T"] = q8(lg(cells["T"]), 3, 5)
    rec["Z"] = q8(lg(extra["Z"]), -3, 4)
    rec["r"] = q8(np.log10(0.5 * np.asarray(cells["h"])[sel]), -2, 3.5)
    rec["hi"] = q8(lg(cells["HI"]), -16, 16)
    rec["ovi"] = q8(lg(cells["OVI"]), -16, 16)
    vrel = cells["vb"][sel] - np.asarray(gal["SubhaloVel_kms"], float)
    V = -(vrel @ np.asarray(p["geom"]["n_los"], float))
    rec["v"] = np.clip(np.round(V / 4), -127, 127).astype(np.int8)
    cl = np.zeros(sel.size, np.uint8)
    mp = work / f"{st}_cloud_members.npz"
    n_in_cloud = {}
    if mp.exists():
        mem = np.load(mp)
        pos_of = {int(g): i for i, g in enumerate(sel)}
        for cid in mem.files:
            key, si = cid.split("_s"); si = int(si)
            idx = np.array([pos_of[g] for g in mem[cid] if int(g) in pos_of], int)
            n_in_cloud[cid] = [int(idx.size), int(mem[cid].size)]
            v = min(si + 1, 15)
            if key == "HI":
                cl[idx] = (cl[idx] & 0xF0) | v
            elif key == "OVI":
                cl[idx] = (cl[idx] & 0x0F) | (v << 4)
    rec["cl"] = cl
    l0 = math.floor(l.min()); nb = math.ceil(l.max()) - l0 + 1
    l_index = [int(x) for x in np.searchsorted(l, l0 + np.arange(nb))] + [int(sel.size)]
    raw = rec.tobytes()
    gz = gzip.compress(raw, 9, mtime=0)
    tdir = out / "tube"; tdir.mkdir(parents=True, exist_ok=True)
    (tdir / f"{st}.bin.gz").write_bytes(gz)
    meta = {"schema": "story-tube/1", "galaxy": gid, "ray": ray_id, "path": f"tube/{st}.bin.gz", "n": int(sel.size),
            "radius_kpc": radius, "radius_rule": f"max({E.TUBE_RADIUS_MIN:g} kpc, r_perp_90 of the shells lettered A and D)",
            "radius_from": why, "pad_kpc": PAD_KPC, "bytes": len(raw), "bytes_gz": len(gz), "enc": ENC,
            "lo": [round(float(x), 4) for x in lo], "span": [round(float(x), 4) for x in span],
            "frame": {"n": ray["n"].round(7).tolist(), "up": ray["up"].round(7).tolist(),
                      "side": ray["side"].round(7).tolist(), "p0": ray["p0"].round(4).tolist(), "half": round(ray["half"], 4)},
            "l_index_l0": l0, "l_index": l_index, "cloud_members_in_tube": n_in_cloud, "cells_source": src,
            "r_eq_kpc_median": round(float(np.median(0.5 * np.asarray(cells["h"])[sel])), 3)}
    (tdir / f"{st}.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(f"tube {st}: {sel.size} cells within {radius} kpc ({why}); {len(raw)/1024:.0f} kB raw, {len(gz)/1024:.0f} kB gz",
          flush=True)
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--galaxy", type=int, default=E.REF_GALAXY)
    ap.add_argument("--ray", default=E.REF_RAY)
    ap.add_argument("--work", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=E.OUT_DEFAULT)
    a = ap.parse_args(argv)
    build(a.galaxy, a.ray, a.work or E.work_root() / "scratch" / "story_data", a.out)


if __name__ == "__main__":
    main()
