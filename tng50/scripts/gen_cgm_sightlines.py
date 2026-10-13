#!/usr/bin/env python3
"""Generate CGM mock-QSO sightlines + HIGH-RES NOISELESS spectra for sub-488530.

Thin CLI over tngsight.generate.Generator: loads the cutout ONCE (tngsight.config.cutout_path(),
the slim r-hsml<400 kpc file by default; yt index at config.index_path(), never next to the
cutout), adds O VI / C III / H I ion fields, then for each sightline casts a Trident ray (±R200c)
and makes a noiseless optical-depth spectrum for O VI 1032, H I Lyβ 1026, C III 977 at
dλ = 0.002 Å with use_peculiar_velocity=True, use_doppler_redshift_only=True (trident fork).
R and S/N are applied later (degrade.py), so these products are instrument-independent.

Per sightline saved (tngsight.library.save_npz, the original key order/dtypes) to
cgm_paths.generated_dir()/<geomid>.npz  (= <TNG_LIBRARY_DIR>/generated, the server's location):
  <ion>_lambda, <ion>_tau, <ion>_rest for ion in {OVI,HILyb,CIII}; geom; v_sys; logN_<ion>.
Index rows are appended to cgm_paths.out_dir()/grid_index.csv. Run from a directory holding
config.tri (trident reads ./config.tri at import), e.g. /Volumes/cgm_work/run.

Usage:
  python gen_cgm_sightlines.py validate      # ~30 sightlines for the O VI sanity check
  python gen_cgm_sightlines.py full          # the full ~200 grid
  python gen_cgm_sightlines.py one <orient> <b> <az> [seed]   # a single sightline (seed required for random)
"""
from __future__ import annotations
import os, sys
from pathlib import Path
import numpy as np

os.environ.setdefault("HDF5_USE_FILE_LOCKING", "FALSE")
os.environ.setdefault("MPLBACKEND", "Agg")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_paths as P           # noqa: E402
import cgm_geometry as G        # noqa: E402
from tngsight import config as TC              # noqa: E402
from tngsight.library import save_npz          # noqa: E402

GAL = G.GAL
C_KMS = TC.C_KMS
LINES = TC.LINES                # OVI, HILyb, CIII: trident_line, field, rest_A, f, label
VWIN_KMS = TC.VWIN_GEN_KMS      # ± velocity window per line
DLAMBDA = TC.DLAMBDA            # Å; ~0.6 km/s/pixel at ~1000 Å (high-res underlying spectrum)


def out_path(gid):
    return P.generated_dir(create=True) / f"{gid}.npz"


def exists(gid):
    try:
        P.find_sightline(gid)
        return True
    except FileNotFoundError:
        return False


def _progress(stage, frac, msg=""):
    print(f"    {stage:<14s} {frac:4.0%} {msg}", flush=True)


def generate(grid, gen=None, skip_existing=False, verbose=False):
    """Generate every geometry dict in `grid` (make_sightline kwargs). Returns index rows."""
    rows = []
    if skip_existing:   # prune BEFORE the (slow) cutout load; also matches legacy seedless rand_ names
        def done(p):
            ids = {G.geom_id(p["orientation"], p["b_kpc"], p["azimuth_deg"], p.get("inclination_deg"), sd)
                   for sd in (p.get("seed"), None)}
            return any(exists(g) for g in ids)
        pruned = [p for p in grid if not done(p)]
        print(f"  skip_existing: {len(grid)-len(pruned)} already done, {len(pruned)} to generate",
              flush=True)
        grid = pruned
    if not grid:
        return rows
    if gen is None:
        from tngsight.generate import Generator
        gen = Generator()
        gen.load(progress=_progress if verbose else None)
    for i, params in enumerate(grid):
        gid = G.geom_id(params["orientation"], params["b_kpc"], params["azimuth_deg"],
                        params.get("inclination_deg"), params.get("seed"))
        geom = dict(orientation=params["orientation"], b_kpc=params["b_kpc"],
                    azimuth_deg=params["azimuth_deg"], seed=params.get("seed"), id=gid)
        pl = gen.generate(geom, progress=_progress if verbose else None)
        fn = out_path(gid)
        save_npz(fn, pl["geom"], pl["logN"], pl["tau"])
        cols = pl["logN"]
        rows.append(dict(geom_id=gid, v_sys=pl["v_sys"], **{f"log{k}": cols[k] for k in LINES},
                         orientation=params["orientation"], b_kpc=params["b_kpc"],
                         azimuth_deg=params["azimuth_deg"], file=fn.name))
        print(f"  [{i+1}/{len(grid)}] {gid}  v_sys={pl['v_sys']:+.0f}  "
              f"logN: OVI={cols['OVI']:.2f} HILyb={cols['HILyb']:.2f} CIII={cols['CIII']:.2f}", flush=True)
    return rows


def append_index(rows):
    import pandas as pd
    INDEX = P.out_dir() / "grid_index.csv"
    df = pd.DataFrame(rows)
    if INDEX.exists():
        old = pd.read_csv(INDEX)
        df = pd.concat([old[~old.geom_id.isin(df.geom_id)], df], ignore_index=True)
    df.to_csv(INDEX, index=False)
    print(f"grid_index: {len(df)} sightlines -> {INDEX}")


def validation_grid():
    g = []
    for b in (50, 75, 100, 125, 150):
        for o in ("face-on", "edge-on"):
            for az in (0, 45, 90):
                g.append(dict(orientation=o, b_kpc=b, azimuth_deg=az))
    return g


def full_grid():
    g = []
    for b in (50, 75, 100, 125, 150):
        for o in ("face-on", "edge-on"):
            for az in range(0, 360, 30):
                g.append(dict(orientation=o, b_kpc=b, azimuth_deg=az))
    # random-orientation set (reproducible seeds)
    rng = np.random.default_rng(488530)
    for k in range(40):
        b = float(rng.uniform(50, 150)); az = float(rng.uniform(0, 360))
        g.append(dict(orientation="random", b_kpc=round(b, 1), azimuth_deg=round(az, 1), seed=int(rng.integers(1e9))))
    return g


def more_grid(n=300):
    """300 extra random-orientation sightlines through the CGM, impact 65-195 kpc (the detectable-
    but-unsaturated regime), each with a unique seed -> unique geom_id. Random LOS through the
    clumpy CGM is what naturally produces multiple, non-saturated velocity components, ideal for
    seeing how R and S/N shape the spectra."""
    g = []
    rng = np.random.default_rng(20250730)
    for _ in range(n):
        b = float(rng.uniform(65, 195))
        az = float(rng.uniform(0, 360))
        g.append(dict(orientation="random", b_kpc=round(b, 1), azimuth_deg=round(az, 1),
                      seed=int(rng.integers(1_000_000_000))))
    return g


def inner_grid(n=200):
    """200 random-orientation sightlines through the INNER CGM, impact < 50 kpc (5-49.9 kpc),
    each with a unique seed. Small impact parameters sample the dense inner halo where absorption
    is strong and often saturated. Distinct RNG seed so geom_ids don't collide with more_grid."""
    g = []
    rng = np.random.default_rng(20250804)
    for _ in range(n):
        b = float(rng.uniform(5, 49.9))
        az = float(rng.uniform(0, 360))
        g.append(dict(orientation="random", b_kpc=round(b, 1), azimuth_deg=round(az, 1),
                      seed=int(rng.integers(1_000_000_000))))
    return g


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "validate"
    if mode == "one":
        o, b, az = sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
        seed = int(sys.argv[5]) if len(sys.argv) > 5 else None
        c = G.canonicalize(o, b, az, seed)     # ValueError: random needs a seed, b <= B_MAX_KPC
        rows = generate([dict(orientation=c["orientation"], b_kpc=c["b_kpc"],
                              azimuth_deg=c["azimuth_deg"], seed=c["seed"])], verbose=True)
        append_index(rows); return
    grid = {"validate": validation_grid, "full": full_grid, "more": more_grid,
            "inner": inner_grid}.get(mode, validation_grid)()
    skip = mode in ("full", "more", "inner")   # reuse sightlines already on disk
    print(f"[{mode}] {len(grid)} sightlines; loading cutout...", flush=True)
    rows = generate(grid, skip_existing=skip)
    append_index(rows)


if __name__ == "__main__":
    main()
