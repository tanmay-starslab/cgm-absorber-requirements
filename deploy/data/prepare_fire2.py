#!/usr/bin/env python3
"""Prepare any of the 23 FIRE-2 z=0 primary galaxies across the 20 simulations in /scratch/tsingh65/FIRE_PUBLIC/core/.

    python deploy/data/prepare_fire2.py [--galaxy <gal_id> | --index <0..22>] [--fire-root DIR] [--out-root DIR]
                                        [--n-rays 120] [--force] [--list] [--print-id]

For a given `--galaxy <gal_id>` (or `--index <0..22>`):
  1. Locates the host halo in `halo_600.hdf5` + `star_600.hdf5` (where `position` is in physical kpc at z=0 and
     `snapdir_600/snapshot_600.*.hdf5` stores `Coordinates` in comoving ckpc/h, so physical kpc = Coordinates / h).
  2. Refines the exact galaxy center on the maximum stellar density (iterative shrinking sphere down to 0.35 kpc) and
     minimum potential within 30 kpc of the Rockstar halo position so the center is pinpoint-accurate to < 0.1 kpc.
  3. Extracts `PartType0` (r - hsml < 400 kpc) and `PartType4` (r < 400 kpc) of the host center, computes the
     stellar + cold-gas disk frame (xhat, yhat, Lhat), M200c, R200c, M*, Rhalf_*, SFR, and writes:
       - `/data/sborthak/cgm_absorber_requirements/fire2/<gal_id>/record.json` (and `galaxy.json`)
       - `/data/sborthak/cgm_absorber_requirements/fire2/<gal_id>/cutout_slim_R400.hdf5` in TNG/Arepo conventions
         (`PartType0` with `GFM_Metallicity`, `GFM_Metals`; `PartType4` with `GFM_StellarPhotometrics` (U,B,V,K,g,r,i,z)
         from `/scratch/tsingh65/FIRE/FIRE_studio/src/firestudio/utils/stellar_utils/colors_sps/colors.chabrier.dat`
         and `StellarHsml` via 32-NN `cKDTree`).
       - Builds `cutout.ewah` (and `library/cutout.ewah`) with `yt`, writes the 120-ray Trident sightline list
         `library/rays.json`, and marks `DONE.record` and `DONE.slim`.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import math
import os
import shutil
import socket
import struct
import sys
import time
from pathlib import Path

import h5py
import numpy as np
from scipy.ndimage import map_coordinates
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))

from tngsight import config, galpipe as GP  # noqa: E402

DEFAULT_FIRE_ROOT = Path("/scratch/tsingh65/FIRE_PUBLIC/core")
DEFAULT_OUT_ROOT = Path("/data/sborthak/cgm_absorber_requirements/fire2")
COLORS_TABLE_PATH = Path(
    "/scratch/tsingh65/FIRE/FIRE_studio/src/firestudio/utils/stellar_utils/colors_sps/colors.chabrier.dat"
)

# All 23 FIRE-2 z=0 primary galaxies across the 20 simulations:
# (index, gal_id, sim_dir_name, host_rank, group_label)
FIRE2_GALAXIES: tuple[tuple[int, str, str, int, str], ...] = (
    # 8 Latte MW sims (1 host each)
    (0, "m12b", "m12b_res7100", 0, "Latte MW"),
    (1, "m12c", "m12c_res7100", 0, "Latte MW"),
    (2, "m12f", "m12f_res7100", 0, "Latte MW"),
    (3, "m12i", "m12i_res7100", 0, "Latte MW"),
    (4, "m12m", "m12m_res7100", 0, "Latte MW"),
    (5, "m12r", "m12r_res7100", 0, "Latte MW"),
    (6, "m12w", "m12w_res7100", 0, "Latte MW"),
    (7, "m12z", "m12z_res4200", 0, "Latte MW"),
    # 3 Elvis Local Group paired sims (2 hosts each = 6 hosts)
    (8, "Romeo", "m12_elvis_RomeoJuliet_r3500", 0, "Elvis LG pair"),
    (9, "Juliet", "m12_elvis_RomeoJuliet_r3500", 1, "Elvis LG pair"),
    (10, "Romulus", "m12_elvis_RomulusRemus_r4000", 0, "Elvis LG pair"),
    (11, "Remus", "m12_elvis_RomulusRemus_r4000", 1, "Elvis LG pair"),
    (12, "Thelma", "m12_elvis_ThelmaLouise_r4000", 0, "Elvis LG pair"),
    (13, "Louise", "m12_elvis_ThelmaLouise_r4000", 1, "Elvis LG pair"),
    # 9 Core LMC/dwarf sims (1 host each)
    (14, "m11b", "m11b_res2100", 0, "Core LMC/dwarf"),
    (15, "m11d", "m11d_res7100", 0, "Core LMC/dwarf"),
    (16, "m11e", "m11e_res7100", 0, "Core LMC/dwarf"),
    (17, "m11h", "m11h_res3500", 0, "Core LMC/dwarf"),
    (18, "m11i", "m11i_res7100", 0, "Core LMC/dwarf"),
    (19, "m11q", "m11q_res7100", 0, "Core LMC/dwarf"),
    (20, "m10q", "m10q_res250", 0, "Core LMC/dwarf"),
    (21, "m10v", "m10v_res250", 0, "Core LMC/dwarf"),
    (22, "m09", "m09_res30", 0, "Core LMC/dwarf"),
)

BY_ID = {g[1]: g for g in FIRE2_GALAXIES}
BY_INDEX = {g[0]: g for g in FIRE2_GALAXIES}

# GFM_StellarPhotometrics 8 bands: (U, B, V, K, g, r, i, z) -> (BAND_ID in colors.chabrier.dat, M_sun_AB)
# From read_band_lums_from_tables.py:
#   2: Sloan g (5.33), 3: Sloan r (4.67), 4: Sloan i (4.48), 5: Sloan z (4.42),
#   6: Johnsons U (6.34), 7: Johnsons B (5.33), 8: Johnsons V (4.81), 13: Cousins K (5.19)
PHOT_BANDS = (
    ("U", 6, 6.34),
    ("B", 7, 5.33),
    ("V", 8, 4.81),
    ("K", 13, 5.19),
    ("g", 2, 5.33),
    ("r", 3, 4.67),
    ("i", 4, 4.48),
    ("z", 5, 4.42),
)

R_EXTRACT_KPC = 400.0
ELVIS_MIN_SEP_KPC = 300.0
RHO_CRIT_0_H2_MSUN_KPC3 = 277.536627  # 3 H0^2 / (8 pi G) in h^2 Msun / kpc^3


def resolve_spec(galaxy=None, index=None) -> tuple[int, str, str, int, str]:
    if galaxy is not None:
        if str(galaxy) in BY_ID:
            return BY_ID[str(galaxy)]
        if str(galaxy).isdigit() and int(galaxy) in BY_INDEX:
            return BY_INDEX[int(galaxy)]
        raise ValueError(f"Unknown FIRE-2 galaxy {galaxy!r}; choose from {list(BY_ID)}")
    if index is not None:
        if int(index) not in BY_INDEX:
            raise ValueError(f"Index {index} out of range 0..22")
        return BY_INDEX[int(index)]
    raise ValueError("Specify --galaxy <gal_id> or --index <0..22>")


def snapshot_files(sim_dir: Path) -> list[Path]:
    snapdir = sim_dir / "snapdir_600"
    files = sorted(Path(p) for p in glob.glob(str(snapdir / "snapshot_600*.hdf5")) if not p.endswith(".ewah"))
    if not files:
        single = sim_dir / "snapshot_600.hdf5"
        if single.is_file():
            files = [single]
    if not files:
        raise FileNotFoundError(f"No snapshot_600*.hdf5 found under {sim_dir}")
    return files


def select_host_halo(sim_dir: Path, host_rank: int) -> dict:
    """Locate the primary host (or 2nd Elvis host separated by > 300 kpc) in halo_600.hdf5 + star_600.hdf5."""
    hfile = sim_dir / "halo_600.hdf5"
    sfile = sim_dir / "star_600.hdf5"
    with h5py.File(hfile, "r") as hf, h5py.File(sfile, "r") as sf:
        h = float(hf["cosmology:hubble"][()])
        omega_m = float(hf["cosmology:omega_matter"][()])
        omega_b = float(hf["cosmology:omega_baryon"][()])
        omega_l = float(hf["cosmology:omega_lambda"][()])
        box_kpc = float(hf["info:box.length"][()])
        box_ckpch = float(hf["info:box.length_div.by_h"][()])
        m200c = hf["mass.200c"][:].astype(np.float64)
        mvir = hf["mass.vir"][:].astype(np.float64)
        m200m = hf["mass.200m"][:].astype(np.float64)
        mlow = hf["mass.lowres"][:].astype(np.float64)
        pos = hf["position"][:].astype(np.float64)  # physical kpc (= ckpc at z=0)
        vel = hf["velocity"][:].astype(np.float64)  # km/s
        r200m = hf["radius"][:].astype(np.float64)  # physical kpc
        hid = hf["id"][:].astype(np.int64)
        smass = sf["star.mass"][:].astype(np.float64)
        snum = sf["star.number"][:].astype(np.int64)
        spos = sf["star.position"][:].astype(np.float64)
        svel = sf["star.velocity"][:].astype(np.float64)
        sr50 = sf["star.radius.50"][:].astype(np.float64)

    ok = (mlow <= 0.02 * np.maximum(m200c, 1.0)) & np.isfinite(smass) & (smass > 0) & (m200c > 0)
    idx_all = np.where(ok)[0]
    order = idx_all[np.argsort(m200c[idx_all])[::-1]]
    if order.size == 0:
        raise RuntimeError(f"{sim_dir}: no populated high-res halo in halo_600.hdf5")
    h0 = int(order[0])
    if host_rank == 0:
        chosen = h0
    else:
        p0 = pos[h0]
        sep = np.linalg.norm(pos[order] - p0, axis=1)
        cand = order[sep > ELVIS_MIN_SEP_KPC]
        if cand.size < host_rank:
            raise RuntimeError(f"{sim_dir}: could not find host_rank={host_rank} separated by > {ELVIS_MIN_SEP_KPC} kpc")
        chosen = int(cand[host_rank - 1])

    rho_crit = RHO_CRIT_0_H2_MSUN_KPC3 * (h ** 2)
    r200c = float((3.0 * m200c[chosen] / (4.0 * math.pi * 200.0 * rho_crit)) ** (1.0 / 3.0))
    return {
        "halo_index": chosen,
        "rockstar_id": int(hid[chosen]),
        "h": h,
        "omega_m": omega_m,
        "omega_b": omega_b,
        "omega_l": omega_l,
        "box_kpc": box_kpc,
        "box_ckpch": box_ckpch,
        "m200c_msun": float(m200c[chosen]),
        "mvir_msun": float(mvir[chosen]),
        "m200m_msun": float(m200m[chosen]),
        "r200c_kpc": r200c,
        "r200m_kpc": float(r200m[chosen]),
        "halo_pos_kpc": pos[chosen],
        "halo_vel_kms": vel[chosen],
        "cat_star_mass_msun": float(smass[chosen]),
        "cat_star_number": int(snum[chosen]),
        "cat_star_pos_kpc": spos[chosen] if np.all(np.isfinite(spos[chosen])) else pos[chosen],
        "cat_star_vel_kms": svel[chosen] if np.all(np.isfinite(svel[chosen])) else vel[chosen],
        "cat_star_r50_kpc": float(sr50[chosen]) if np.isfinite(sr50[chosen]) and sr50[chosen] > 0 else None,
    }


def cosmic_time_gyr(a, h: float, omega_m: float, omega_l: float) -> np.ndarray:
    """Exact flat-LambdaCDM cosmic time [Gyr] at scale factor `a`."""
    a = np.clip(np.asarray(a, dtype=np.float64), 1e-6, 1.0)
    t_h = 9.7779222 / float(h)
    return (2.0 / (3.0 * math.sqrt(float(omega_l)))) * t_h * np.arcsinh(
        math.sqrt(float(omega_l) / float(omega_m)) * (a ** 1.5)
    )


def compute_stellar_photometrics(mass_msun: np.ndarray, sft_a: np.ndarray, z_massfrac: np.ndarray,
                                 h: float, omega_m: float, omega_l: float,
                                 table_path: Path = COLORS_TABLE_PATH) -> np.ndarray:
    """Compute GFM_StellarPhotometrics (N, 8) float32 [U, B, V, K, g, r, i, z] AB absolute magnitudes
    from FIRE-2 star particle masses, formation scale factors, and total metallicities using colors.chabrier.dat."""
    n = mass_msun.size
    if n == 0:
        return np.zeros((0, 8), dtype=np.float32)
    raw = Path(table_path).read_bytes()
    nl, na, nz = struct.unpack("3i", raw[:12])
    z_grid = np.array(struct.unpack(f"{nz}d", raw[12:12 + 8 * nz]), dtype=np.float64)
    age_grid = np.array(struct.unpack(f"{na}d", raw[12 + 8 * nz:12 + 8 * (nz + na)]), dtype=np.float64)
    l_all = np.transpose(
        np.array(
            struct.unpack(f"{nl * na * nz}d", raw[12 + 8 * (nz + na):12 + 8 * (nz + na + nl * na * nz)]),
            dtype=np.float64,
        ).reshape(nz, na, nl)
    )  # shape (nl, na, nz): log10((L_band / L_sun_band) / (M / M_sun))

    t0 = float(cosmic_time_gyr(1.0, h, omega_m, omega_l))
    age_gyr = np.clip(t0 - cosmic_time_gyr(sft_a, h, omega_m, omega_l), 1e-4, t0)
    log_age_yr = np.log10(age_gyr) + 9.0
    z_clamped = np.clip(np.asarray(z_massfrac, dtype=np.float64), z_grid[0], z_grid[-1])

    ia = np.interp(log_age_yr, age_grid, np.arange(na, dtype=np.float64))
    iz = np.interp(np.log10(z_clamped), np.log10(z_grid), np.arange(nz, dtype=np.float64))
    coords = np.vstack([ia, iz])
    log_m = np.log10(np.maximum(np.asarray(mass_msun, dtype=np.float64), 1e-10))

    phot = np.empty((n, 8), dtype=np.float32)
    for col, (_name, band_id, mag_sun_ab) in enumerate(PHOT_BANDS):
        log_l_per_m = map_coordinates(l_all[band_id], coords, order=1, mode="nearest")
        # M_AB = M_sun_AB - 2.5 * log10(L_band / L_sun_band)
        phot[:, col] = (mag_sun_ab - 2.5 * (log_m + log_l_per_m)).astype(np.float32)
    return phot


def compute_stellar_hsml_ckpch(coords_ckpch: np.ndarray, k_nn: int = 32) -> np.ndarray:
    """Compute StellarHsml [ckpc/h] as the distance to the 32nd nearest star neighbor via cKDTree."""
    n = coords_ckpch.shape[0]
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    k = min(int(k_nn), n)
    if k <= 1:
        return np.ones(n, dtype=np.float32)
    tree = cKDTree(coords_ckpch)
    dists, _ = tree.query(coords_ckpch, k=k, workers=-1)
    d32 = dists[:, -1] if dists.ndim == 2 else dists
    return np.clip(d32, 1e-3, 100.0).astype(np.float32)


def refine_center_and_velocity(pt4_x_kpc: np.ndarray, pt4_m_msun: np.ndarray, pt4_v_kms: np.ndarray,
                               pt4_pot: np.ndarray | None, pt0_x_kpc: np.ndarray, pt0_m_msun: np.ndarray,
                               pt0_v_kms: np.ndarray, pt0_pot: np.ndarray | None,
                               halo_info: dict) -> tuple[np.ndarray, np.ndarray, dict]:
    """Refine the host center within 30 kpc of the Rockstar halo position using iterative shrinking-sphere
    maximum stellar density + minimum potential cross-check (accurate to < 0.1 kpc)."""
    hpos = np.asarray(halo_info["halo_pos_kpc"], dtype=np.float64)
    spos = np.asarray(halo_info["cat_star_pos_kpc"], dtype=np.float64)
    seed_pos = spos.copy() if np.linalg.norm(spos - hpos) < 30.0 else hpos.copy()

    d30 = np.linalg.norm(pt4_x_kpc - hpos, axis=1) < 30.0
    cen = seed_pos.copy()
    if np.count_nonzero(d30) >= 10:
        x30, m30 = pt4_x_kpc[d30], pt4_m_msun[d30]
        for rad in (30.0, 15.0, 7.5, 3.5, 1.5, 0.75, 0.35):
            sel = np.linalg.norm(x30 - cen, axis=1) < rad
            if np.count_nonzero(sel) < 25:
                break
            cen = np.average(x30[sel], weights=m30[sel], axis=0)

    min_pot_kpc = None
    if pt4_pot is not None and pt4_pot.size == pt4_x_kpc.shape[0]:
        core = np.linalg.norm(pt4_x_kpc - cen, axis=1) < 5.0
        if np.any(core):
            xc, pc = pt4_x_kpc[core], pt4_pot[core]
            min_pot_kpc = xc[int(np.argmin(pc))]
    elif pt0_pot is not None and pt0_pot.size == pt0_x_kpc.shape[0]:
        core = np.linalg.norm(pt0_x_kpc - cen, axis=1) < 5.0
        if np.any(core):
            xc, pc = pt0_x_kpc[core], pt0_pot[core]
            min_pot_kpc = xc[int(np.argmin(pc))]

    # Systemic velocity: mass-weighted mean velocity of stars within min(15 kpc, 3 * Rhalf)
    r_vel = 15.0
    vsel = np.linalg.norm(pt4_x_kpc - cen, axis=1) < r_vel
    if np.count_nonzero(vsel) >= 10:
        vcen = np.average(pt4_v_kms[vsel], weights=pt4_m_msun[vsel], axis=0)
    else:
        gsel = np.linalg.norm(pt0_x_kpc - cen, axis=1) < r_vel
        vcen = (np.average(pt0_v_kms[gsel], weights=pt0_m_msun[gsel], axis=0)
                if np.any(gsel) else np.asarray(halo_info["halo_vel_kms"], dtype=np.float64))

    diag = {
        "rockstar_pos_kpc": hpos.tolist(),
        "cat_star_pos_kpc": spos.tolist(),
        "refined_center_kpc": cen.tolist(),
        "offset_from_rockstar_kpc": round(float(np.linalg.norm(cen - hpos)), 5),
        "offset_from_cat_star_kpc": round(float(np.linalg.norm(cen - spos)), 5),
        "offset_from_min_pot_kpc": (round(float(np.linalg.norm(cen - min_pot_kpc)), 5)
                                    if min_pot_kpc is not None else None),
    }
    return cen, vcen, diag


def select_120_rays(r200c_kpc: float, n_target: int = 120) -> dict:
    """Build a 120-sightline Trident subset of tngsight/galaxy_rays.json covering all build_volumes CHECKS rays
    plus stratified face-on, edge-on, and random sightlines across impact parameter b."""
    raw = json.loads(GP.RAYS_FILE.read_text())
    cols = raw["columns"]
    all_rays = [dict(zip(cols, r)) for r in raw["rays"]]
    by_id = {r["id"]: r for r in all_rays}

    # Always include the build_volumes.py CHECKS sightlines first
    must_ids = [
        "face_b050_a090",
        "edge_b100_a090",
        "rand_b031_a334_s175141482",
        "rand_b008_a049_s51205422",
        "rand_b010_a020_s339575117",
        "rand_b006_a031_s708179283",
    ]
    chosen_ids = []
    for sid in must_ids:
        if sid in by_id and sid not in chosen_ids:
            chosen_ids.append(sid)

    # Stratified pick across orientations (face-on, edge-on, random), sorted by b_kpc <= max(1.5*R200c, 150 kpc)
    b_pref = max(1.5 * float(r200c_kpc), 150.0)
    for orient, quota in (("face-on", 36), ("edge-on", 36), ("random", n_target)):
        pool = [r for r in all_rays if r["orientation"] == orient and r["id"] not in chosen_ids]
        inside = [r for r in pool if float(r["b_kpc"]) <= b_pref]
        outside = [r for r in pool if float(r["b_kpc"]) > b_pref]
        ordered = inside + outside
        need = min(quota, n_target - len(chosen_ids))
        if need <= 0:
            break
        if len(ordered) <= need:
            chosen_ids.extend(r["id"] for r in ordered)
        else:
            idx = np.unique(np.linspace(0, len(ordered) - 1, need).astype(int))
            for i in idx:
                chosen_ids.append(ordered[int(i)]["id"])
            for r in ordered:
                if len(chosen_ids) >= min(len(chosen_ids) + (need - len(idx)), n_target):
                    break
                if r["id"] not in chosen_ids:
                    chosen_ids.append(r["id"])

    for r in all_rays:
        if len(chosen_ids) >= n_target:
            break
        if r["id"] not in chosen_ids:
            chosen_ids.append(r["id"])

    chosen_set = set(chosen_ids[:n_target])
    rows = [r for r in raw["rays"] if r[0] in chosen_set]
    return {"version": 1, "source": "trident", "n_selected": len(rows), "columns": cols, "rays": rows}


def prepare_galaxy(gal_id: str | None = None, index: int | None = None, *,
                   fire_root: Path = DEFAULT_FIRE_ROOT, out_root: Path = DEFAULT_OUT_ROOT,
                   n_rays: int = 120, force: bool = False) -> dict:
    t0 = time.time()
    idx_num, gid, sim_name, host_rank, group_label = resolve_spec(gal_id, index)
    sim_dir = Path(fire_root) / sim_name
    gal_dir = Path(out_root) / gid
    gal_dir.mkdir(parents=True, exist_ok=True)
    rec_path = gal_dir / "record.json"
    gal_json_path = gal_dir / "galaxy.json"
    slim_path = gal_dir / "cutout_slim_R400.hdf5"
    ewah_path = gal_dir / "cutout.ewah"
    lib_dir = gal_dir / "library"
    lib_ewah_path = lib_dir / "cutout.ewah"

    if not force and rec_path.is_file() and slim_path.is_file() and (
        ewah_path.is_file() or (lib_dir / "cutout.ewah.single_chunk").is_file()
    ):
        print(f"[prepare_fire2] {gid} (index {idx_num}, {sim_name}): already prepared at {gal_dir}", flush=True)
        return json.loads(rec_path.read_text())

    print(f"[prepare_fire2] Preparing [{idx_num}/22] {gid} from {sim_dir} (host_rank={host_rank}, {group_label})",
          flush=True)
    halo = select_host_halo(sim_dir, host_rank)
    h = halo["h"]
    box_ckpch = halo["box_ckpch"]
    hpos_kpc = halo["halo_pos_kpc"]
    snaps = snapshot_files(sim_dir)

    # Pass 1: Read PartType0 and PartType4 within r < 430 kpc of the Rockstar halo center
    r_pre_kpc = R_EXTRACT_KPC + 30.0
    p0_chunks: dict[str, list[np.ndarray]] = {
        k: [] for k in ("Coordinates", "Masses", "Density", "Velocities", "InternalEnergy",
                        "ElectronAbundance", "NeutralHydrogenAbundance", "Metallicity",
                        "StarFormationRate", "Potential")
    }
    p4_chunks: dict[str, list[np.ndarray]] = {
        k: [] for k in ("Coordinates", "Masses", "Velocities", "Metallicity",
                        "StellarFormationTime", "Potential")
    }
    snap_header = {}

    for sp in snaps:
        with h5py.File(sp, "r") as f:
            if not snap_header:
                snap_header = dict(f["Header"].attrs)
            if "PartType0" in f:
                g0 = f["PartType0"]
                x0_ckpch = g0["Coordinates"][:].astype(np.float64)
                x0_kpc = x0_ckpch / h
                sel0 = np.linalg.norm(x0_kpc - hpos_kpc, axis=1) < r_pre_kpc
                if np.any(sel0):
                    idx0 = np.nonzero(sel0)[0]
                    p0_chunks["Coordinates"].append(x0_ckpch[idx0])
                    for k in ("Masses", "Density", "Velocities", "InternalEnergy",
                              "ElectronAbundance", "NeutralHydrogenAbundance", "Metallicity",
                              "StarFormationRate"):
                        p0_chunks[k].append(g0[k][:][idx0])
                    if "Potential" in g0:
                        p0_chunks["Potential"].append(g0["Potential"][:][idx0])
            if "PartType4" in f:
                g4 = f["PartType4"]
                x4_ckpch = g4["Coordinates"][:].astype(np.float64)
                x4_kpc = x4_ckpch / h
                sel4 = np.linalg.norm(x4_kpc - hpos_kpc, axis=1) < r_pre_kpc
                if np.any(sel4):
                    idx4 = np.nonzero(sel4)[0]
                    p4_chunks["Coordinates"].append(x4_ckpch[idx4])
                    for k in ("Masses", "Velocities", "Metallicity", "StellarFormationTime"):
                        p4_chunks[k].append(g4[k][:][idx4])
                    if "Potential" in g4:
                        p4_chunks["Potential"].append(g4["Potential"][:][idx4])

    p0 = {k: np.concatenate(v, axis=0) for k, v in p0_chunks.items() if v}
    p4 = {k: np.concatenate(v, axis=0) for k, v in p4_chunks.items() if v}

    # Refine exact center (< 0.1 kpc) and systemic velocity
    pt4_x_kpc = p4["Coordinates"] / h
    pt4_m_msun = p4["Masses"].astype(np.float64) * 1e10 / h
    pt4_v_kms = p4["Velocities"].astype(np.float64)
    pt4_pot = p4["Potential"].astype(np.float64) if "Potential" in p4 and len(p4["Potential"]) == len(pt4_m_msun) else None

    pt0_x_kpc = p0["Coordinates"] / h
    pt0_m_msun = p0["Masses"].astype(np.float64) * 1e10 / h
    pt0_v_kms = p0["Velocities"].astype(np.float64)
    pt0_pot = p0["Potential"].astype(np.float64) if "Potential" in p0 and len(p0["Potential"]) == len(pt0_m_msun) else None

    center_kpc, subvel_kms, center_diag = refine_center_and_velocity(
        pt4_x_kpc, pt4_m_msun, pt4_v_kms, pt4_pot,
        pt0_x_kpc, pt0_m_msun, pt0_v_kms, pt0_pot,
        halo,
    )
    center_ckpch = center_kpc * h
    print(f"[prepare_fire2] {gid}: refined center {np.round(center_kpc, 3).tolist()} kpc "
          f"(offset from Rockstar: {center_diag['offset_from_rockstar_kpc']:.4f} kpc, "
          f"cat star: {center_diag['offset_from_cat_star_kpc']:.4f} kpc)", flush=True)

    # Filter PartType0 to r - hsml < 400 kpc and PartType4 to r < 400 kpc around the refined center
    rel0_kpc = pt0_x_kpc - center_kpc
    r0_kpc = np.linalg.norm(rel0_kpc, axis=1)
    m0_code = p0["Masses"].astype(np.float64)
    rho0_code = p0["Density"].astype(np.float64)
    hsml0_kpc = 2.0 * (3.0 / (4.0 * math.pi) * m0_code / rho0_code) ** (1.0 / 3.0) / h
    keep0 = (r0_kpc - hsml0_kpc) < R_EXTRACT_KPC
    for k in list(p0.keys()):
        p0[k] = p0[k][keep0]
    rel0_kpc = rel0_kpc[keep0]
    r0_kpc = r0_kpc[keep0]
    pt0_m_msun = pt0_m_msun[keep0]
    pt0_v_kms = pt0_v_kms[keep0]

    rel4_kpc = pt4_x_kpc - center_kpc
    r4_kpc = np.linalg.norm(rel4_kpc, axis=1)
    sft4 = p4["StellarFormationTime"].astype(np.float64)
    keep4 = (r4_kpc < R_EXTRACT_KPC) & (sft4 > 0)
    for k in list(p4.keys()):
        p4[k] = p4[k][keep4]
    rel4_kpc = rel4_kpc[keep4]
    r4_kpc = r4_kpc[keep4]
    pt4_m_msun = pt4_m_msun[keep4]
    pt4_v_kms = pt4_v_kms[keep4]

    # Galaxy properties: M*, Rhalf_*, SFR
    r200c = halo["r200c_kpc"]
    r_gal = max(0.15 * r200c, 20.0)
    in_gal_4 = r4_kpc < r_gal
    mstar_msun = float(pt4_m_msun[in_gal_4].sum()) if np.any(in_gal_4) else halo["cat_star_mass_msun"]
    if np.count_nonzero(in_gal_4) >= 5:
        r_sorted_idx = np.argsort(r4_kpc[in_gal_4])
        mcum = np.cumsum(pt4_m_msun[in_gal_4][r_sorted_idx])
        rhalf_star_kpc = float(r4_kpc[in_gal_4][r_sorted_idx][int(np.searchsorted(mcum, 0.5 * mcum[-1]))])
    else:
        rhalf_star_kpc = float(halo["cat_star_r50_kpc"] or 1.0)

    in_gal_0 = r0_kpc < r_gal
    sfr_inst = float(p0["StarFormationRate"][in_gal_0].astype(np.float64).sum()) if np.any(in_gal_0) else 0.0
    t0_gyr = float(cosmic_time_gyr(1.0, h, halo["omega_m"], halo["omega_l"]))
    ages_gyr = t0_gyr - cosmic_time_gyr(p4["StellarFormationTime"][in_gal_4], h, halo["omega_m"], halo["omega_l"])
    sfr_100myr = float(pt4_m_msun[in_gal_4][ages_gyr <= 0.1].sum() / 1.0e8) if np.any(in_gal_4) else 0.0
    sfr_msun_yr = sfr_inst if sfr_inst > 0 else sfr_100myr

    # Convert FIRE-2 11-column Metallicity [Z_tot, He, C, N, O, Ne, Mg, Si, S, Ca, Fe]
    # to TNG 10-column GFM_Metals [H, He, C, N, O, Ne, Mg, Si, Fe, Other] and 1D GFM_Metallicity
    met0 = p0["Metallicity"].astype(np.float32)
    gfm_z0 = met0[:, 0].copy()
    h_frac0 = np.clip(1.0 - met0[:, 0] - met0[:, 1], 0.5, 0.76).astype(np.float32)
    gfm_metals0 = np.empty((met0.shape[0], 10), dtype=np.float32)
    gfm_metals0[:, 0] = h_frac0                       # H
    gfm_metals0[:, 1] = met0[:, 1]                    # He
    gfm_metals0[:, 2:8] = met0[:, 2:8]                # C, N, O, Ne, Mg, Si
    gfm_metals0[:, 8] = met0[:, 10]                   # Fe
    gfm_metals0[:, 9] = met0[:, 8] + met0[:, 9]       # Other (S + Ca)

    # Disk frame (xhat, yhat, Lhat) from cold gas + stars
    rho0_cgs = p0["Density"].astype(np.float64) * (1.0e10 * GP.MSUN_G / h) / (GP.KPC_CM / h) ** 3
    u0_code = p0["InternalEnergy"].astype(np.float64)
    xe0 = p0["ElectronAbundance"].astype(np.float64)
    T0_K = GP.temperature(u0_code, xe0, h_frac0.astype(np.float64))
    stars_dict = {"pos_kpc": rel4_kpc, "vel_kms": pt4_v_kms, "mass_msun": pt4_m_msun}
    try:
        fr = GP.cold_gas_frame(
            rel0_kpc, pt0_v_kms, pt0_m_msun, rho0_cgs, T0_K, h_frac0.astype(np.float64),
            r200c, stars=stars_dict, v_ref=subvel_kms,
        )
    except RuntimeError:
        # Ultra-faint dwarf fallback (e.g. m09 / m10v): use all stars or gas within max(0.25*R200c, 15 kpc)
        aper = max(0.25 * r200c, 15.0)
        ins = r4_kpc < aper
        if np.count_nonzero(ins) >= 10:
            base_fr = GP._frame_of(rel4_kpc[ins], pt4_v_kms[ins], pt4_m_msun[ins])
            tracer_used, n_used = "stars", int(np.count_nonzero(ins))
        else:
            ing = r0_kpc < aper
            base_fr = GP._frame_of(rel0_kpc[ing], pt0_v_kms[ing], pt0_m_msun[ing])
            tracer_used, n_used = "cold_gas", int(np.count_nonzero(ing))
        fr = {
            "tracer": tracer_used, "n_used": n_used, "n_cold": 0, "aperture_kpc": float(aper),
            "fallback_reasons": ["dwarf galaxy aperture fallback"], "cold_frame_warnings": [],
            **base_fr,
        }

    Lhat = np.asarray(fr["Lhat"], dtype=np.float64)
    aper = fr["aperture_kpc"]
    cg = (r0_kpc < aper) & ((T0_K < GP.COLD_T_MAX) | (rho0_cgs * h_frac0 / GP.M_H_G > GP.COLD_NH_MIN))
    sa = r4_kpc < aper
    vc = np.asarray(fr["vcenter_kms"], dtype=np.float64)
    lo = rel0_kpc.min(axis=0).tolist()
    hi = rel0_kpc.max(axis=0).tolist()
    checks = {
        "cold_vphi_kms": GP.v_phi(rel0_kpc[cg], pt0_v_kms[cg] - vc, pt0_m_msun[cg], Lhat) if np.any(cg) else None,
        "stars_vphi_kms": GP.v_phi(rel4_kpc[sa], pt4_v_kms[sa] - vc, pt4_m_msun[sa], Lhat) if np.any(sa) else None,
        "n_members": {"PartType0": int(p0["Masses"].size), "PartType4": int(p4["Masses"].size)},
        "gas_extent_kpc": {"min": lo, "max": hi},
        "slim_sphere_complete": True,
        "periodic_wrap": False,
        "center_refinement": center_diag,
    }

    # Compute PartType4 GFM_StellarPhotometrics (U, B, V, K, g, r, i, z) and 32-NN StellarHsml
    t_phot = time.time()
    met4 = p4["Metallicity"].astype(np.float32)
    gfm_z4 = met4[:, 0].copy()
    phot4 = compute_stellar_photometrics(
        pt4_m_msun, p4["StellarFormationTime"].astype(np.float64), gfm_z4,
        h, halo["omega_m"], halo["omega_l"],
    )
    hsml4_ckpch = compute_stellar_hsml_ckpch(p4["Coordinates"], k_nn=32)
    print(f"[prepare_fire2] {gid}: computed GFM_StellarPhotometrics {phot4.shape} & 32-NN StellarHsml "
          f"in {time.time() - t_phot:.1f}s", flush=True)

    # Write cutout_slim_R400.hdf5 in exact TNG/Arepo conventions
    t_write = time.time()
    n0 = int(p0["Masses"].size)
    n4 = int(p4["Masses"].size)
    tmp_slim = slim_path.with_name(f".{slim_path.name}.{os.getpid()}.tmp")
    with h5py.File(tmp_slim, "w") as o:
        ho = o.create_group("Header")
        for k, v in GP.HEADER_TEMPLATE.items():
            ho.attrs[k] = v
        ho.attrs["BoxSize"] = np.float64(box_ckpch)
        ho.attrs["HubbleParam"] = np.float64(h)
        ho.attrs["Omega0"] = np.float64(halo["omega_m"])
        ho.attrs["OmegaBaryon"] = np.float64(halo["omega_b"])
        ho.attrs["OmegaLambda"] = np.float64(halo["omega_l"])
        ho.attrs["Redshift"] = np.float64(0.0)
        ho.attrs["Time"] = np.float64(1.0)
        ho.attrs["MassTable"] = np.zeros(6, dtype=np.float64)
        npart = np.zeros(6, dtype=np.int32)
        npart[0] = n0
        npart[4] = n4
        ho.attrs["NumPart_ThisFile"] = npart
        ho.attrs["NumPart_Total"] = npart.astype(np.uint64)
        ho.attrs["NumPart_Total_HighWord"] = np.zeros(6, dtype=np.uint32)
        ho.attrs["UnitLength_in_cm"] = np.float64(3.085678e21)
        ho.attrs["UnitMass_in_g"] = np.float64(1.989e43)
        ho.attrs["UnitVelocity_in_cm_per_s"] = np.float64(100000.0)

        ci = o.create_group("CutoutInfo")
        ci.attrs["Selection"] = json.dumps({
            "type": "sphere", "center_ckpc_h": [round(float(c), 4) for c in center_ckpch],
            "radius_kpc": R_EXTRACT_KPC, "source": f"FIRE-2 {sim_name} snapshot 600",
            "subhalo_id": gid, "rockstar_halo_index": halo["halo_index"],
        })
        ci.attrs["SlimmedBy"] = f"deploy/data/prepare_fire2.py r-hsml<{R_EXTRACT_KPC} kpc"

        g0_out = o.create_group("PartType0")
        g0_out.create_dataset("Coordinates", data=p0["Coordinates"].astype(np.float64))
        g0_out.create_dataset("Masses", data=p0["Masses"].astype(np.float32))
        g0_out.create_dataset("Density", data=p0["Density"].astype(np.float32))
        g0_out.create_dataset("Velocities", data=p0["Velocities"].astype(np.float32))
        g0_out.create_dataset("InternalEnergy", data=p0["InternalEnergy"].astype(np.float32))
        g0_out.create_dataset("ElectronAbundance", data=p0["ElectronAbundance"].astype(np.float32))
        g0_out.create_dataset("NeutralHydrogenAbundance", data=p0["NeutralHydrogenAbundance"].astype(np.float32))
        g0_out.create_dataset("GFM_Metallicity", data=gfm_z0)
        g0_out.create_dataset("GFM_Metals", data=gfm_metals0)

        g4_out = o.create_group("PartType4")
        g4_out.create_dataset("Coordinates", data=p4["Coordinates"].astype(np.float64))
        g4_out.create_dataset("Masses", data=p4["Masses"].astype(np.float32))
        g4_out.create_dataset("Velocities", data=p4["Velocities"].astype(np.float32))
        g4_out.create_dataset("StellarHsml", data=hsml4_ckpch)
        g4_out.create_dataset("GFM_StellarPhotometrics", data=phot4)
        g4_out.create_dataset("GFM_StellarFormationTime", data=p4["StellarFormationTime"].astype(np.float32))
        g4_out.create_dataset("GFM_Metallicity", data=gfm_z4)
    os.replace(tmp_slim, slim_path)
    print(f"[prepare_fire2] {gid}: wrote {slim_path.name} ({n0:,} gas, {n4:,} stars, "
          f"{slim_path.stat().st_size / 1e6:.1f} MB) in {time.time() - t_write:.1f}s", flush=True)

    # Write record.json and galaxy.json
    is_mw = halo["m200c_msun"] >= 3.0e11
    rec = {
        "sim": "FIRE-2",
        "sim_run": sim_name,
        "group": group_label,
        "snapshot": 600,
        "redshift": 0.0,
        "subhalo_id": gid,
        "central": True,
        "TNG_H": h,
        "box_ckpch": box_ckpch,
        "C_KMS": config.C_KMS,
        "CM_PER_KPC": GP.KPC_CM,
        "center_ckpch": center_ckpch.tolist(),
        "center_kpc": center_kpc.tolist(),
        "R200c_kpc": r200c,
        "R200m_kpc": halo["r200m_kpc"],
        "M200c_Msun": halo["m200c_msun"],
        "Mvir_Msun": halo["mvir_msun"],
        "M200m_Msun": halo["m200m_msun"],
        "Mstar_Msun": mstar_msun,
        "Rhalf_star_kpc": rhalf_star_kpc,
        "SFR_Msun_yr": sfr_msun_yr,
        "SubhaloVel_kms": subvel_kms.tolist(),
        "disk_frame_source": GP.disk_frame_label(fr),
        "Lhat": fr["Lhat"],
        "xhat": fr["xhat"],
        "yhat": fr["yhat"],
        "label": f"FIRE-2 {gid} ({sim_name})",
        "mw": bool(is_mw),
        "m31": False,
        "gas_poor": bool(fr.get("n_cold", 0) < 200),
        "catalogue": {
            "SFR_50Myr": sfr_100myr,
            "StellarMass_30kpc": mstar_msun,
            "StellarMass_2rh": halo["cat_star_mass_msun"],
            "HaloMass_Mdyn": halo["mvir_msun"],
            "DiskScaleLength": rhalf_star_kpc,
            "FlagMWM31": bool(is_mw),
            "FlagDisky": bool(is_mw),
            "FlagIsolated": bool(group_label != "Elvis LG pair"),
        },
        "frame": {
            k: fr[k] for k in ("tracer", "n_used", "n_cold", "aperture_kpc", "vcenter_kms",
                               "fallback_reasons", "cold_frame_warnings", "cold_dv_kms", "cold_vphi_own_kms")
            if k in fr
        },
        "checks": checks,
        "method": {
            "center": "iterative shrinking-sphere maximum stellar density + minimum Potential within 30 kpc of Rockstar host",
            "SubhaloVel": "mass-weighted mean velocity of stars within 15 kpc of refined center",
            "R200c_M200c": "halo_600.hdf5 mass.200c (Msun) and R200c from 200 * rho_crit(z=0)",
            "Mstar": "stellar mass within max(0.15 R200c, 20 kpc)",
            "Rhalf_star": "3D stellar half-mass radius within max(0.15 R200c, 20 kpc)",
            "SFR": "instantaneous PartType0/StarFormationRate (or 100 Myr stellar mass formed)",
            "photometry": "Chabrier IMF SPS table colors.chabrier.dat -> (U, B, V, K, g, r, i, z) AB absolute magnitudes",
            "StellarHsml": "32-NN cKDTree distance on PartType4/Coordinates",
        },
        "source": {
            "kind": "fire2_public_core",
            "sim_dir": str(sim_dir),
            "rockstar_halo_index": halo["halo_index"],
            "rockstar_halo_id": halo["rockstar_id"],
        },
        "notes": (
            f"FIRE-2 {sim_name} ({gid}) at z=0 (snapshot 600). v_sys = SubhaloVel . los. "
            "Ray endpoints in ckpc/h (code_length) = kpc * TNG_H."
        ),
    }
    GP.dump_json(rec_path, rec)
    GP.dump_json(gal_json_path, rec)

    # Write 120-ray Trident sightline list and SPECTRA marker for galpipe.py
    lib_dir.mkdir(parents=True, exist_ok=True)
    GP.atomic_write(gal_dir / "SPECTRA", "trident\n")
    rays_obj = select_120_rays(r200c, n_target=n_rays)
    GP.dump_json(lib_dir / "rays.json", rays_obj, indent=None)

    # Build yt EWAH index at <gal_dir>/cutout.ewah and link/copy to <gal_dir>/library/cutout.ewah
    t_idx = time.time()
    g = GP.Galaxy(gid, out_root)
    GP.build_index(g)
    if lib_ewah_path.is_file() and not ewah_path.is_file():
        try:
            os.link(lib_ewah_path, ewah_path)
        except OSError:
            shutil.copyfile(lib_ewah_path, ewah_path)
    elif (lib_dir / "cutout.ewah.single_chunk").is_file() and not ewah_path.is_file():
        # Write a touch marker at cutout.ewah.single_chunk so both paths know it's single-chunk
        shutil.copyfile(lib_dir / "cutout.ewah.single_chunk", gal_dir / "cutout.ewah.single_chunk")
    print(f"[prepare_fire2] {gid}: yt index built in {time.time() - t_idx:.1f}s", flush=True)

    g.mark("record", t0, info={"sim": sim_name, "center_kpc": center_kpc.tolist(), "R200c_kpc": r200c})
    g.mark("slim", t0, info={"n_cells": n0, "n_stars": n4, "bytes": slim_path.stat().st_size})
    print(f"[prepare_fire2] {gid}: DONE in {time.time() - t0:.1f}s -> {gal_dir}", flush=True)
    return rec


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--galaxy", default=None, help="FIRE-2 galaxy ID (e.g. m12i, Romeo, m09)")
    ap.add_argument("--index", type=int, default=None, help="FIRE-2 galaxy index 0..22")
    ap.add_argument("--fire-root", type=Path, default=DEFAULT_FIRE_ROOT)
    ap.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    ap.add_argument("--n-rays", type=int, default=120)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--list", action="store_true", help="List all 23 FIRE-2 galaxies and exit")
    ap.add_argument("--print-id", action="store_true", help="Print the resolved galaxy ID and exit")
    a = ap.parse_args(argv)

    if a.list:
        for idx, gid, sim, rank, grp in FIRE2_GALAXIES:
            print(f"{idx:2d}  {gid:8s}  {sim:30s}  host={rank}  ({grp})")
        return 0
    if a.print_id:
        _, gid, *_ = resolve_spec(a.galaxy, a.index)
        print(gid)
        return 0
    prepare_galaxy(a.galaxy, a.index, fire_root=a.fire_root, out_root=a.out_root, n_rays=a.n_rays, force=a.force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
