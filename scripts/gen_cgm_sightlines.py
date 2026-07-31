#!/usr/bin/env python3
"""Generate CGM mock-QSO sightlines + HIGH-RES NOISELESS spectra for sub-488530.

Loads the TNG cutout ONCE, adds O VI / C III / H I ion fields, then for each sightline in a grid
casts a Trident ray (±R200c, impact 50-150 kpc, chosen orientation/azimuth) and generates a fine,
noiseless optical-depth spectrum for O VI 1032, H I Lyβ 1026, C III 977 with
use_peculiar_velocity=True, use_doppler_redshift_only=True. Resolution (R) and S/N are applied
LATER as post-processing (degrade.py), so these products are instrument-independent.

Per sightline saved to data/sightlines/cgm_sid488530_<geomid>.npz:
  <ion>_lambda, <ion>_tau (high-res, noiseless) for ion in {OVI,HILyb,CIII}; geometry; v_sys;
  logN_<ion> (integrated ion column from the ray, for validation).

Usage:
  python gen_cgm_sightlines.py validate      # ~30 sightlines for the O VI sanity check
  python gen_cgm_sightlines.py full          # the full ~200 grid
  python gen_cgm_sightlines.py one <orient> <b> <az> [seed]   # a single sightline (GUI on-demand)
"""
from __future__ import annotations
import os, sys, json, itertools
from pathlib import Path
import numpy as np

os.environ.setdefault("HDF5_USE_FILE_LOCKING", "FALSE")
os.environ.setdefault("MPLBACKEND", "Agg")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import h5py                     # noqa: E402
import yt                       # noqa: E402
import trident                  # noqa: E402
yt.set_log_level(50)
import cgm_geometry as G        # noqa: E402

GAL = G.GAL
DATA = ROOT / "data" / "sightlines"; DATA.mkdir(parents=True, exist_ok=True)
INDEX = ROOT / "data" / "grid_index.csv"
C_KMS = GAL["C_KMS"]
LINES = GAL["lines"]            # OVI, HILyb, CIII: trident_line, field, rest_A, f, label
VWIN_KMS = 1500.0               # ± velocity window per line
DLAMBDA = 0.002                 # Å; ~0.6 km/s/pixel at ~1000 Å (high-res underlying spectrum)
RAY_FIELDS = [("gas", "density"), ("gas", "temperature"), ("gas", "metallicity"),
              ("gas", "H_number_density")] + [("gas", L["field"]) for L in LINES.values()]
COL_CONST = 2.654e-15           # pi e^2/(m_e c) cgs, for reference (not used for column here)


def load_ds():
    ds = yt.load(GAL["cutout_hdf5"])
    # alias GFM_Metallicity -> metallicity if needed
    if ("gas", "metallicity") not in ds.derived_field_list:
        def _Z(field, data):
            return data["PartType0", "GFM_Metallicity"]
        ds.add_field(("gas", "metallicity"), function=_Z, sampling_type="local",
                     units="", force_override=True)
    trident.add_ion_fields(ds, ions=[L["ion"] for L in LINES.values()], ftype="gas")
    return ds


def cast_ray(ds, geom, tmp):
    p0 = ds.arr(np.array(geom["start_ckpch"], float), "code_length")
    p1 = ds.arr(np.array(geom["end_ckpch"], float), "code_length")
    # Trident's LightRay mutates domain edges in place; hand it writable copies
    ds.domain_left_edge = ds.domain_left_edge.copy()
    ds.domain_right_edge = ds.domain_right_edge.copy()
    if os.path.exists(tmp):
        os.remove(tmp)
    return trident.make_simple_ray(ds, start_position=p0, end_position=p1,
                                   fields=RAY_FIELDS, ftype="gas", data_filename=tmp)


def ray_columns(tmp):
    """Integrated ion column log10(N) = log10(sum n_ion * dl) from the ray HDF5."""
    out = {}
    with h5py.File(tmp, "r") as h:
        grid = h["grid"]
        dl = grid["dl"][()]                       # cm (Trident writes ray dl in cm)
        for key, L in LINES.items():
            fld = L["field"]
            n = grid[fld][()] if fld in grid else np.zeros_like(dl)
            N = float(np.sum(n * dl))
            out[key] = np.log10(N) if N > 0 else -np.inf
    return out


def make_line_spectrum(ray, key):
    L = LINES[key]; rest = L["rest_A"]
    lam_min = rest * (1 - VWIN_KMS / C_KMS); lam_max = rest * (1 + VWIN_KMS / C_KMS)
    sg = trident.SpectrumGenerator(lambda_min=lam_min, lambda_max=lam_max, dlambda=DLAMBDA)
    sg.make_spectrum(ray, lines=[L["trident_line"]], use_peculiar_velocity=True,
                     use_doppler_redshift_only=True, ly_continuum=False, njobs=1)
    lam = np.array(sg.lambda_field); tau = np.array(sg.tau_field)
    return lam.astype(np.float32), tau.astype(np.float32)


def generate(grid, ds=None, skip_existing=False):
    close = ds is None
    tmp = f"/tmp/_cgmray_{os.getpid()}.h5"
    rows = []
    # optionally prune already-generated sightlines BEFORE the (slow) cutout load
    if skip_existing:
        pruned = []
        for params in grid:
            gid = G.geom_id(params["orientation"], params["b_kpc"], params["azimuth_deg"],
                            params.get("inclination_deg"))
            if (DATA / f"cgm_sid488530_{gid}.npz").exists():
                continue
            pruned.append(params)
        print(f"  skip_existing: {len(grid)-len(pruned)} already done, {len(pruned)} to generate",
              flush=True)
        grid = pruned
    if not grid:
        return rows
    if ds is None:
        ds = load_ds()
    for i, params in enumerate(grid):
        geom = G.make_sightline(**params)
        gid = G.geom_id(params["orientation"], params["b_kpc"], params["azimuth_deg"],
                        params.get("inclination_deg"), params.get("seed"))
        ray = cast_ray(ds, geom, tmp)
        cols = ray_columns(tmp)
        rec = dict(geom_id=gid, v_sys=geom["v_sys_kms"], **{f"log{k}": cols[k] for k in LINES})
        payload = dict(geom=json.dumps(geom), v_sys=geom["v_sys_kms"], **{f"logN_{k}": cols[k] for k in LINES})
        for key in LINES:
            lam, tau = make_line_spectrum(ray, key)
            payload[f"{key}_lambda"] = lam; payload[f"{key}_tau"] = tau; payload[f"{key}_rest"] = LINES[key]["rest_A"]
        np.savez_compressed(DATA / f"cgm_sid488530_{gid}.npz", **payload)
        rec.update(orientation=params["orientation"], b_kpc=params["b_kpc"],
                   azimuth_deg=params["azimuth_deg"], file=f"cgm_sid488530_{gid}.npz")
        rows.append(rec)
        print(f"  [{i+1}/{len(grid)}] {gid}  v_sys={geom['v_sys_kms']:+.0f}  "
              f"logN: OVI={cols['OVI']:.2f} HILyb={cols['HILyb']:.2f} CIII={cols['CIII']:.2f}", flush=True)
    if os.path.exists(tmp):
        os.remove(tmp)
    if close:
        del ds
    return rows


def append_index(rows):
    import pandas as pd
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


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "validate"
    if mode == "one":
        o, b, az = sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
        seed = int(sys.argv[5]) if len(sys.argv) > 5 else None
        rows = generate([dict(orientation=o, b_kpc=b, azimuth_deg=az, seed=seed)])
        append_index(rows); return
    grid = {"validate": validation_grid, "full": full_grid, "more": more_grid}.get(
        mode, validation_grid)()
    skip = mode in ("full", "more")   # reuse sightlines already on disk
    print(f"[{mode}] {len(grid)} sightlines; loading cutout...", flush=True)
    rows = generate(grid, skip_existing=skip)
    append_index(rows)


if __name__ == "__main__":
    main()
