#!/usr/bin/env python
"""Story data for the Learn page "How a spectrum is made" (PLAN_final section 6), for any galaxy with a cutout and a
sightline library: the reference galaxy 488530 (default) or any other TNG50 MW/M31 host processed by the galaxy
pipeline (<work>/data/gal/<id>/: galaxy.json, cutout_slim_R400.hdf5, library/).

Two stages, one sightline per (galaxy, ray):

  cells  (heavy, SLURM: scripts/story_data.sbatch) re-casts the stored sightline through the cutout with the
         pipeline's own generator (tngsight.generate: same endpoints, fields, ion table and deposition) and dumps the
         per-cell ray fields to <work>/<gid>_<ray>_cells.npz (+ _meta.json). Refuses to run unless TNG_INDEX_FILE
         points to a job-private yt index inside --work, so no shared index is ever rewritten.
  build  (light, seconds) turns that dump, the stored library npz, its components and the galaxy record into
         <out>/story_<gid>_<ray>.json (column-oriented, rounded; checks the cell sum against the stored spectrum and
         fails loudly when it misses), <out>/fion_OVI_slice.json (galaxy independent) and <out>/index.json.

Precomputed noisy fits are made by scripts/story_fits.mjs with the page's own fit.js (page_fits_<gid>_<ray>.json).

Usage:
  python scripts/export_story_data.py cells [--galaxy 488530] [--ray rand_b062_a062] [--work DIR]
  python scripts/export_story_data.py build [--galaxy 488530 411449 ...] [--ray ...] [--work DIR] [--out DIR]
Physics is the pipeline's (R_physics section 2); nothing here changes it.
"""
from __future__ import annotations
import argparse
import gzip
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from tngsight import config, ions as I  # noqa: E402

ROOT = REPO / "docs" / "tng50" / "learn" / "how-a-spectrum-is-made"
OUT_DEFAULT = ROOT / "data"
REF_GALAXY = 488530
REF_RAY = "rand_b062_a062"
SCHEMA = "story-data/1"
STORY_IONS = ("HI", "OVI")
C = config.C_KMS
KB = 1.380649e-16
AMU = 1.66053906660e-24
KPC_CM = 3.0856775814913673e21
LY_PER_KPC = 3261.563777
MH_G = 1.6737352238051868e-24          # unyt mass_hydrogen (yt's mh): n_H = X_H rho / mh in the arepo frontend
# Trident's atomic masses (trident/ion_balance.py atomic_mass), the ones its Doppler b uses
TRIDENT_MASS = {"H": 1.00794, "C": 12.0107, "N": 14.0067, "O": 15.9994, "Ne": 20.1797, "Mg": 24.3050, "Si": 28.0855,
                "S": 32.065}
ION_FIELD = {"HI": ("H_p0_number_density", "H_p0_ion_fraction"), "OVI": ("O_p5_number_density", "O_p5_ion_fraction")}
VISIBLE_TAU0 = 0.01                    # a cell "visible" alone: central dip of at least 1 %
TICK_TAU0 = 0.1                        # S9 truth ticks
GRID = (-400.0, 400.0, 1.0)            # F_intrinsic grid (V, km/s, galaxy frame)
GZ_BUDGET = 80 * 1024
# acceptance of the rounded cell sum against the stored Trident spectrum (PLAN_final section 6). DF_MAX binds the
# reference story; on other sightlines Trident's own deposition can differ from the point-sampled cell Voigt sum by
# more (about 1 % in tau near strong cores), so there the rounding must not add more than ROUND_SLACK over the
# full-precision mismatch, which itself must stay below DF_CEIL.
DF_MAX = {"HI": 2e-3, "OVI": 3e-4}
DF_CEIL = {"HI": 5e-3, "OVI": 2e-3}
ROUND_SLACK = 1.1
EW_RTOL = 1e-3
R_LIST = (150000, 30000, 15000, 5000)
N_GALAXIES_FALLBACK = 198               # TNG50 MW/M31 sample (Pillepich et al. 2024), z = 0 hosts


def n_galaxies() -> tuple:
    """(count, source) of the host sample the explorer covers: subhalo cutouts under <work>/data/mwm31."""
    raw = work_root() / "data" / "mwm31" / "10_raw" / "snap_099"
    try:
        n = sum(1 for q in raw.iterdir() if q.name.startswith("subhalo_"))
        if n:
            return n, "count of TNG50 MW/M31 host cutouts (snapshot 99)"
    except OSError:
        pass
    return N_GALAXIES_FALLBACK, "TNG50 MW/M31 sample size (Pillepich et al. 2024)"
FION_LOGNH = (-5.0, -4.5, -4.0, -3.5, -3.0)


# ----------------------------------------------------------------------------------------------- paths
def work_root() -> Path:
    return config.work_root()


def galaxy_paths(gid: int, library=None, cutout=None, galaxy_json=None) -> dict:
    """Inputs of one galaxy. 488530 keeps its shipped files (TNG_CUTOUT, the v3r library, the packaged record); any
    other host uses the galaxy pipeline's layout <work>/data/gal/<id>/."""
    gid = int(gid)
    gdir = work_root() / "data" / "gal" / str(gid)
    if gid == REF_GALAXY:
        lib = Path(library) if library else Path(os.environ.get("TNG_STORY_LIBRARY") or work_root() / "data" / "library_v3r")
        cut = Path(cutout) if cutout else config.cutout_path()
        gj = Path(galaxy_json) if galaxy_json else REPO / "tngsight" / "galaxy_488530.json"
    else:
        lib = Path(library) if library else gdir / "library"
        cut = Path(cutout) if cutout else gdir / "cutout_slim_R400.hdf5"
        if not cutout and not cut.exists():          # every one of the 198 hosts has its raw cutout
            cut = raw_cutout(gid)
        gj = Path(galaxy_json) if galaxy_json else gdir / "galaxy.json"
    return {"galaxy": gid, "library": lib, "cutout": cut, "galaxy_json": gj}


def raw_cutout(gid) -> Path:
    """The host's full TNG50 cutout (snapshot 99) in the MW/M31 sample tree, $TNG_MWM31_ROOT or <work>/data/mwm31."""
    root = Path(os.environ.get("TNG_MWM31_ROOT") or work_root() / "data" / "mwm31")
    return root / "10_raw" / "snap_099" / f"subhalo_{int(gid)}" / "snap_99.hdf5"


SLIM_FIELDS = ("Coordinates", "Masses", "Density", "Velocities", "InternalEnergy", "ElectronAbundance",
               "NeutralHydrogenAbundance", "GFM_Metals", "GFM_Metallicity")    # the slim cutout's gas fields


def cutout_view(cutout: Path, work: Path) -> Path:
    """A cutout yt can open. The slim cutouts load as they are; the raw MW/M31 cutouts lack the snapshot header
    constants yt's arepo frontend needs (NumFilesPerSnapshot, NumPart_*), so this writes a small job-private HDF5
    with a completed Header and PartType0 datasets that are external links into the raw file (no copy). The ray only
    touches cells inside ±R200c, all of which every cutout holds, so the cells are those of the slim cutout."""
    import h5py
    with h5py.File(cutout, "r") as h:
        if "NumFilesPerSnapshot" in h["Header"].attrs:
            return cutout
        ngas = int(h["PartType0/Coordinates"].shape[0])
        attrs = dict(h["Header"].attrs)
        have = [f for f in SLIM_FIELDS if f in h["PartType0"]]
    view = work / f"view_{cutout.parent.name}.hdf5"
    with h5py.File(view, "w") as v:
        H = v.create_group("Header")
        for k, x in attrs.items():
            H.attrs[k] = x
        H.attrs["NumFilesPerSnapshot"] = 1
        H.attrs["NumPart_ThisFile"] = np.array([ngas, 0, 0, 0, 0, 0], np.int32)
        H.attrs["NumPart_Total"] = np.array([ngas, 0, 0, 0, 0, 0], np.uint64)
        H.attrs["NumPart_Total_HighWord"] = np.zeros(6, np.uint32)
        for k, x in (("Flag_Cooling", 1), ("Flag_DoublePrecision", 0), ("Flag_Feedback", 1), ("Flag_Metals", 0),
                     ("Flag_Sfr", 1), ("Flag_StellarAge", 0), ("Composition_vector_length", 0)):
            if k not in H.attrs:
                H.attrs[k] = x
        g = v.create_group("PartType0")
        for f in have:
            g[f] = h5py.ExternalLink(str(Path(cutout).resolve()), f"/PartType0/{f}")
        v.create_group("CutoutInfo").attrs["Source"] = f"external links into {Path(cutout).name} (story data view)"
    return view


def _unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def transfer_geometry(ref: dict, gal: dict) -> dict:
    """The stored geometry `ref` (a library geom of the same id) rebuilt for another host, exactly as the galaxy
    pipeline builds its 683 rays (tngsight.geometry.make_sightline with that host's centre, frame, R200c and
    SubhaloVel): a random direction keeps its box vector (same seed), face/edge/inclined use the host's frame; the
    impact parameter and azimuth keep their values; endpoints at ±R200c."""
    L, X = np.asarray(gal["Lhat"], float), np.asarray(gal["xhat"], float)
    o = str(ref["orientation"]).lower()
    if ref.get("inclination_deg") is not None:
        i = math.radians(float(ref["inclination_deg"]))
        n = _unit(math.cos(i) * L + math.sin(i) * X)
    elif o.startswith("face"):
        n = L.copy()
    elif o.startswith("edge"):
        n = X.copy()
    else:
        n = _unit(ref["n_los"])
    e_minor = L - np.dot(L, n) * n
    if np.linalg.norm(e_minor) < 1e-6:
        e_major = _unit(X - np.dot(X, n) * n); e_minor = _unit(np.cross(n, e_major))
    else:
        e_minor = _unit(e_minor); e_major = _unit(np.cross(n, e_minor))
    phi = math.radians(float(ref["azimuth_deg"]))
    c = np.asarray(gal["center_kpc"], float)
    half = float(gal["R200c_kpc"]); b = float(ref["b_kpc"]); H = float(gal["TNG_H"])
    anchor = c + b * (math.cos(phi) * e_major + math.sin(phi) * e_minor)
    start, end = anchor - half * n, anchor + half * n
    d = anchor - c
    return dict(orientation=str(ref["orientation"]), b_kpc=b, azimuth_deg=float(ref["azimuth_deg"]),
                inclination_deg=ref.get("inclination_deg"), n_los=n.tolist(),
                v_sys_kms=float(np.dot(np.asarray(gal["SubhaloVel_kms"], float), n)), half_kpc=half,
                b_perp_check_kpc=float(np.linalg.norm(d - np.dot(d, n) * n)), anchor_kpc=anchor.tolist(),
                start_kpc=start.tolist(), end_kpc=end.tolist(), start_ckpch=(start * H).tolist(),
                end_ckpch=(end * H).tolist())


def reference_geom(ray) -> dict:
    """The reference library's stored geometry of `ray` (the 488530 v3r library holds all 683 ids)."""
    from tngsight.library import load_npz
    ref = galaxy_paths(REF_GALAXY)["library"] / "sightlines" / f"{ray}.npz"
    return load_npz(str(ref), id=ray)["geom"]


def make_library_ray(gen, gid, ray, work: Path, paths: dict) -> Path:
    """A one-ray library for a host without one (any of the 198): the pipeline's own generator, npz writer, web
    encoder and Voigt fitter (deploy/data/regen_library.py), written to <work>/lib_<gid>/. Returns that dir."""
    from tngsight import components as Cm
    from tngsight import library as Lb
    gal = json.loads(paths["galaxy_json"].read_text())
    geom = transfer_geometry(reference_geom(ray), gal)
    lib = work / f"lib_{int(gid)}"
    for sub in ("sightlines", "web", "components"):
        (lib / sub).mkdir(parents=True, exist_ok=True)
    payload = gen.generate({**geom, "id": ray})
    npz = lib / "sightlines" / f"{ray}.npz"
    Lb.save_npz(npz, payload)
    payload = Lb.load_npz(str(npz), id=ray)
    (lib / "web" / f"{ray}.bin").write_bytes(Lb.encode_web(payload))
    aod = {}
    comps = Cm.fit_payload(payload, aod=aod)
    rec = {"id": ray, "fitter": Cm.FITTER_TAG, "params_tag": Cm.params_tag(),
           "components": {k: Cm.dicts_to_rows(v) for k, v in Cm.validate_components(comps).items()},
           "aod": Cm.validate_aod(aod)}
    (lib / "components" / f"{ray}.json").write_text(json.dumps(rec, sort_keys=True, separators=(",", ":"), allow_nan=False))
    print(f"library ray {gid} {ray}: generated with the pipeline into {lib}", flush=True)
    return lib


def shared_indexes(paths: dict) -> set:
    """yt index files other jobs use; never let a story job rewrite one."""
    out = {Path(str(paths["cutout"]) + ".ewah"), paths["library"] / "cutout.ewah",
           work_root() / "data" / "library" / "cutout.ewah", config.library_dir() / "cutout.ewah",
           work_root() / "data" / "gal" / str(paths["galaxy"]) / "library" / "cutout.ewah"}
    return {p.resolve() for p in out}


def check_private_index(work: Path, paths: dict) -> Path:
    v = os.environ.get("TNG_INDEX_FILE")
    if not v:
        raise SystemExit("refusing to run: set TNG_INDEX_FILE to a job-private yt index inside --work "
                         "(scripts/story_data.sbatch does this)")
    idx = Path(v).expanduser().resolve()
    if idx in shared_indexes(paths):
        raise SystemExit(f"refusing to run: TNG_INDEX_FILE={idx} is a shared index")
    if work.resolve() not in idx.parents:
        raise SystemExit(f"refusing to run: TNG_INDEX_FILE={idx} is not inside --work {work}")
    return idx


def stem(gid, ray):
    return f"{int(gid)}_{ray}"


# ----------------------------------------------------------------------------------------------- stage: cells
def stage_cells(gid, ray, work: Path, paths: dict) -> Path:
    import h5py
    from tngsight import generate as G
    from tngsight.library import load_npz
    work.mkdir(parents=True, exist_ok=True)
    idx = check_private_index(work, paths)
    cut = cutout_view(Path(paths["cutout"]), idx.parent)
    gen = G.Generator(cutout=cut, index_filename=idx, workdir=work / "gen", fit_components=False)
    gen.load()
    ds = gen.ds
    npz = paths["library"] / "sightlines" / f"{ray}.npz"
    if not npz.exists():
        paths["library"] = make_library_ray(gen, gid, ray, work, paths)
        npz = paths["library"] / "sightlines" / f"{ray}.npz"
    p = load_npz(str(npz), id=ray)
    sl, _ = G.resolve_geometry(dict(p["geom"], id=ray))
    extra = [("gas", "H_nuclei_density"), ("gas", "O_nuclei_density"), ("gas", "H_p0_ion_fraction"),
             ("gas", "O_p5_ion_fraction")]
    fields = [f for f in list(G.RAY_FIELDS) + extra if f in ds.derived_field_list or f in ds.field_list]
    tmp = work / f"{stem(gid, ray)}_ray.h5"
    if tmp.exists():
        tmp.unlink()
    p0 = ds.arr(np.array(sl["start_ckpch"], float), "code_length")
    p1 = ds.arr(np.array(sl["end_ckpch"], float), "code_length")
    ds.domain_left_edge = ds.domain_left_edge.copy()
    ds.domain_right_edge = ds.domain_right_edge.copy()
    rayobj = gen._trident.make_simple_ray(ds, start_position=p0, end_position=p1, fields=fields, ftype="gas",
                                          data_filename=str(tmp))
    cols = G.ray_columns(str(tmp))
    regen = {}
    for key in STORY_IONS:
        W = I.gen_window(key, cols[key])
        _, _, tau = G.make_line_spectrum(gen._trident, rayobj, key, W, gen._ld, gen.min_tau)
        st = np.asarray(p["tau"][key], float)
        regen[key] = float(np.max(np.abs(tau - st))) if tau.shape == st.shape else None
    with h5py.File(tmp, "r") as h:
        g = h["grid"]
        dump = {k: g[k][()] for k in g.keys()}
        units = {k: (g[k].attrs.get("units", b"").decode() if isinstance(g[k].attrs.get("units", b""), bytes)
                     else str(g[k].attrs.get("units", ""))) for k in g.keys()}
    from trident.ion_balance import solar_abundance
    out = work / f"{stem(gid, ray)}_cells.npz"
    np.savez_compressed(out, **dump)
    meta = {"galaxy": int(gid), "ray": ray, "units": units, "cols": cols, "regen_max_abs_dtau": regen,
            "Zsun": float(ds.quan(1.0, "Zsun").to("dimensionless")), "solar_O_by_number": float(solar_abundance["O"]),
            "cutout": paths["cutout"].name, "ion_table": G.ION_TABLE_FILE, "library": str(paths["library"]),
            "fields_on_ray": sorted(dump), "min_tau": gen.min_tau}
    (work / f"{stem(gid, ray)}_meta.json").write_text(json.dumps(meta, indent=1, default=float))
    tmp.unlink()
    print(f"cells {gid} {ray}: {dump['dl'].size} cells, logN HI {cols['HI']:.3f} OVI {cols['OVI']:.3f}, "
          f"regen max|dtau| {regen}", flush=True)
    return out


# ----------------------------------------------------------------------------------------------- helpers
def sig(x, n=4):
    """Round to n significant figures (JSON-safe; None for non-finite)."""
    x = float(x)
    if not math.isfinite(x):
        return None
    if x == 0:
        return 0.0
    return float(f"{x:.{n}g}")


def fixed(x, d):
    x = float(x)
    return round(x, d) if math.isfinite(x) else None


def col(a, f):
    return [f(x) for x in np.asarray(a, float)]


def voigt_H(a, x):
    from scipy.special import wofz
    return wofz(x + 1j * a).real


def cell_tau(atom, N, V, b, a, vgrid):
    """Σ_i k_tau N_i H(a_i, (v − V_i)/b_i)/b_i on vgrid (Trident's per-cell Voigt, point-sampled)."""
    tau = np.zeros_like(vgrid, dtype=float)
    k = atom["k_tau"]
    for Ni, Vi, bi, ai in zip(N, V, b, a):
        if not (Ni > 0 and bi > 0):
            continue
        tau += k * Ni * voigt_H(ai, (vgrid - Vi) / bi) / bi
    return tau


def rest_ew_mA(tau, du, lam0):
    return float(np.sum(-np.expm1(-np.asarray(tau, float))) * du * lam0 / C * 1e3)


def fmt_pow(x, d=2):
    """1.60×10¹² style (display strings)."""
    sup = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")
    e = int(math.floor(math.log10(abs(x))))
    m = x / 10 ** e
    if round(m, d) >= 10:
        m /= 10; e += 1
    return f"{m:.{d}f}×10{str(e).translate(sup)}"


def fmt_int(x):
    """Site number style: thin groups with a space, no comma (200 000)."""
    s = f"{int(round(x)):,}"
    return s.replace(",", " ")


def local_maxima(y, half=3):
    idx = []
    for i in range(half, len(y) - half):
        w = y[i - half:i + half + 1]
        if y[i] == w.max() and y[i] > w.min():
            idx.append(i)
    return idx


# ----------------------------------------------------------------------------------------------- stage: build
def build_one(gid, ray, work: Path, out: Path, paths: dict) -> dict:
    from tngsight.library import load_npz
    gid = int(gid)
    NGAL = n_galaxies()
    raw = np.load(work / f"{stem(gid, ray)}_cells.npz")
    meta = json.loads((work / f"{stem(gid, ray)}_meta.json").read_text())
    if not (paths["library"] / "sightlines" / f"{ray}.npz").exists():
        paths["library"] = work / f"lib_{gid}"          # made by stage_cells for a host without a library
    p = load_npz(str(paths["library"] / "sightlines" / f"{ray}.npz"), id=ray)
    comps = json.loads((paths["library"] / "components" / f"{ray}.json").read_text())
    gal = json.loads(paths["galaxy_json"].read_text())
    vsys = float(p["v_sys"])
    geom = p["geom"]
    half = float(geom["half_kpc"])
    dl = raw["dl"]; l = raw["l"]; T = raw["temperature"]; rho = raw["density"]
    nH = raw["H_nuclei_density"]
    Zsun = float(meta["Zsun"])
    Z = raw["metallicity"] / Zsun
    V = C * raw["redshift_dopp"] + vsys            # line centre in the galaxy frame (degrade.velocity_axis)
    n = int(dl.size)
    l_mid = (l + 0.5 * dl) / KPC_CM - half
    XH = nH * MH_G / rho

    cells = {"l_kpc": col(l_mid, lambda x: fixed(x, 2)), "dl_kpc": col(dl / KPC_CM, lambda x: sig(x, 4)),
             "nH": col(nH, sig), "T": col(T, sig), "Z": col(Z, sig), "V": col(V, lambda x: fixed(x, 3))}
    Vr = np.array(cells["V"], float)
    vgrid = np.arange(GRID[0], GRID[1] + 1e-9, GRID[2])
    ions = {}
    checks = {}
    for key in STORY_IONS:
        A = I.get(key)
        atom = {"lam0_A": float(A["lam0_A"]), "f": float(A["f"]), "gamma_s": float(A["gamma_s"]),
                "mass_amu": TRIDENT_MASS[A["element"]], "k_tau": float(I.k_tau(key)), "a0_kms": float(I.a0(key))}
        nf, ff = ION_FIELD[key]
        nion = raw[nf]
        N = nion * dl
        b = np.sqrt(2 * KB * T / (atom["mass_amu"] * AMU)) / 1e5
        logN = np.where(N > 0, np.log10(np.where(N > 0, N, 1)), -np.inf)
        cols_ion = {"f_ion": col(raw[ff], sig), "logN": col(logN, lambda x: fixed(x, 5)), "b": col(b, lambda x: sig(x, 5))}
        br = np.array(cols_ion["b"], float)
        a = atom["a0_kms"] / br
        Nr = np.array([10 ** x if x is not None else 0.0 for x in cols_ion["logN"]])
        tau0 = atom["k_tau"] * Nr / br * voigt_H(a, 0.0)
        cols_ion["tau0"] = col(tau0, sig)
        cols_ion["a"] = col(a, lambda x: sig(x, 4))
        # stored Trident spectrum on its native grid, galaxy frame
        u = np.asarray(p["u"][key], float); du = float(p["du"][key]); vn = u + vsys
        st = np.asarray(p["tau"][key], float)
        tsum = cell_tau(atom, Nr, Vr, br, np.array(cols_ion["a"], float), vn)
        dF = float(np.max(np.abs(np.exp(-tsum) - np.exp(-st))))
        tfull = cell_tau(atom, N, V, b, atom["a0_kms"] / b, vn)
        dF_full = float(np.max(np.abs(np.exp(-tfull) - np.exp(-st))))
        ref = (gid, ray) == (REF_GALAXY, REF_RAY)
        lim = DF_MAX[key] if ref else max(DF_MAX[key], ROUND_SLACK * dF_full)
        ew_st = rest_ew_mA(st, du, atom["lam0_A"]); ew_cs = rest_ew_mA(tsum, du, atom["lam0_A"])
        logN_tot = float(np.log10(np.sum(N)))
        chk = {"max_abs_dF_cellsum_vs_stored": dF, "max_abs_dF_fullprecision": dF_full, "dF_limit": lim,
               "EW_mA_stored": ew_st,
               "EW_mA_cellsum": ew_cs, "EW_rel": abs(ew_cs / ew_st - 1), "logN_cells": logN_tot,
               "logN_library": float(p["logN"][key]), "dlogN": abs(logN_tot - float(p["logN"][key])),
               "regen_max_abs_dtau": meta["regen_max_abs_dtau"].get(key)}
        if key == "HI":
            xr = raw[ff] * nH
            m = xr > 0
            chk["nHI_over_xHI_nH_minus1"] = float(np.max(np.abs(nion[m] / xr[m] - 1))) if m.any() else 0.0
        checks[key] = chk
        if dF > lim or dF_full > DF_CEIL[key] or chk["EW_rel"] > EW_RTOL or chk["dlogN"] > 1e-6:
            raise SystemExit(f"{gid} {ray} {key}: cell sum misses the stored spectrum: {chk}")
        tau_g = np.interp(vgrid, vn, st)
        Fint = np.exp(-tau_g)
        order = np.argsort(-N)
        cum = np.cumsum(N[order]) / np.sum(N)
        vis = tau0 > VISIBLE_TAU0
        aod = comps["aod"][key]
        lib = comps["components"][key]
        ions[key] = {
            "atom": atom, **cols_ion,
            "totals": {"logN": round(logN_tot, 4), "logN_library": round(float(p["logN"][key]), 4),
                       "n_cells": int(np.sum(N > 0)), "n_half": int(np.searchsorted(cum, 0.5) + 1),
                       "n_90": int(np.searchsorted(cum, 0.9) + 1), "n_vis": int(vis.sum()),
                       "n_tau0_gt_1": int((tau0 > 1).sum()), "peak_tau": sig(st.max(), 5),
                       "ew_mA": round(ew_st, 2), "logT_Nweighted": round(float(np.average(np.log10(T), weights=N)), 3),
                       "b_visible": [sig(br[vis].min()), sig(br[vis].max())] if vis.any() else None,
                       "V_visible": [fixed(Vr[vis].min(), 1), fixed(Vr[vis].max(), 1)] if vis.any() else None},
            "F_intrinsic": [round(float(x), 5) for x in Fint],
            "library": {"keys": comps.get("keys") or ["v", "dv", "logN", "dlogN", "b", "db", "region", "flag", "EW"],
                        "comps": lib, "aod": {"logN": aod[0], "regions": aod[1]},
                        "note": "tngsight.vpfit on the noiseless native spectrum (the explorer's catalogue fit)"},
        }
        ions[key]["_N"] = N; ions[key]["_tau0"] = tau0; ions[key]["_b"] = br; ions[key]["_taug"] = tau_g

    # ------------------------------------------------------------------- selections (rules recorded)
    hi, ov = ions["HI"], ions["OVI"]
    i_hi = int(np.argmax(hi["_N"])); i_ov = int(np.argmax(ov["_N"]))
    t0o = ov["_tau0"]; bo = ov["_b"]
    cand = np.where(t0o > 0.05)[0]
    best = None
    for x in range(len(cand)):
        for y in range(x + 1, len(cand)):
            i, j = int(cand[x]), int(cand[y])
            if abs(Vr[i] - Vr[j]) < 0.5 * min(bo[i], bo[j]) and abs(l_mid[i] - l_mid[j]) >= 50:
                k = (min(t0o[i], t0o[j]), max(t0o[i], t0o[j]))
                if best is None or k > best[0]:
                    best = (k, i, j)
    pair = None
    if best:
        i, j = sorted((best[1], best[2]), key=lambda c: l_mid[c])
        pair = {"cells": [i, j], "dl_kpc": round(float(abs(l_mid[j] - l_mid[i])), 1),
                "dV_kms": round(float(abs(Vr[j] - Vr[i])), 2), "min_b_kms": sig(min(bo[i], bo[j])),
                "rule": "O VI cells with tau0 > 0.05, |dV| < 0.5 min(b), |dl| >= 50 kpc; maximise (min tau0, max tau0)"}
    tg = ov["_taug"]
    feat = None
    lm = [k for k in local_maxima(tg, 3) if tg[k] >= 0.05]
    if lm:
        k = min(lm, key=lambda q: tg[q])
        feat = {"V_kms": float(vgrid[k]), "tau": sig(tg[k]), "depth": sig(1 - math.exp(-tg[k])),
                "rule": "weakest local maximum (±3 km/s) of the O VI truth tau on the 1 km/s grid with tau >= 0.05"}
    ticks = {key: [int(i) for i in np.where(ions[key]["_tau0"] > TICK_TAU0)[0]] for key in STORY_IONS}

    # ------------------------------------------------------------------- worked numbers
    Ao = ov["atom"]; c5 = i_ov
    tau0_263 = float(t0o[c5])
    b_H_sameT = math.sqrt(2 * KB * T[c5] / (TRIDENT_MASS["H"] * AMU)) / 1e5
    worked = {
        "S5": {"cell": c5, "logN": ov["logN"][c5], "b": ov["b"][c5], "f": Ao["f"], "lam0_A": Ao["lam0_A"],
               "V": cells["V"][c5], "T": cells["T"][c5], "tau0": sig(tau0_263, 3), "centre_light": sig(math.exp(-tau0_263), 3),
               "tau0_formula": "1.4975e-15 N f lam0[A] / b[km/s] (x H(a,0))",
               "b_H_same_T": sig(b_H_sameT, 3), "lam_obs_A": sig(Ao["lam0_A"] * (1 + (cells["V"][c5] - vsys) / C), 7)},
        "S4a": {"cell": i_hi, "T": cells["T"][i_hi], "xHI": hi["f_ion"][i_hi], "nH": cells["nH"][i_hi],
                "logN": hi["logN"][i_hi], "l_kpc": cells["l_kpc"][i_hi]},
        "S4b": {"cell": c5, "T": cells["T"][c5], "f_OVI": ov["f_ion"][c5], "nH": cells["nH"][c5], "Z": cells["Z"][c5],
                "solar_O_by_number": meta["solar_O_by_number"], "Zsun": Zsun},
        "S8": {"logN": hi["totals"]["logN"], "peak_tau": hi["totals"]["peak_tau"]},
        "S9": {"fwhm_kms": {str(R): round(C / R, 1) for R in R_LIST}},
        "S10": {"pix_per_resel": config.PIX_PER_RESEL, "sigma_pix_SN10": sig(math.sqrt(config.PIX_PER_RESEL) / 10, 3),
                "dv_pix_R30000": round(C / 30000 / config.PIX_PER_RESEL, 2), "feature": feat},
    }
    XHv = XH[np.isfinite(XH)]
    dlk = dl / KPC_CM
    meta_out = {
        "schema": SCHEMA, "galaxy": gid, "ray": ray, "sim": gal.get("sim", "TNG50-1"), "snapshot": gal.get("snapshot", 99),
        "redshift": gal.get("redshift", 0.0), "label": gal.get("label") or f"Subhalo {gid}",
        "R200c_kpc": sig(gal["R200c_kpc"], 5), "M200c_Msun": sig(gal["M200c_Msun"], 6), "Mstar_Msun": sig(gal["Mstar_Msun"], 6),
        "SFR_Msun_yr": sig(gal["SFR_Msun_yr"], 3), "v_sys_kms": round(vsys, 3),
        "b_kpc": geom.get("b_kpc"), "azimuth_deg": geom.get("azimuth_deg"), "inclination_deg": geom.get("inclination_deg"),
        "orientation": geom.get("orientation"), "n_los": [round(float(x), 6) for x in geom["n_los"]],
        "n_galaxies": NGAL[0], "n_galaxies_source": NGAL[1],
        "half_kpc": round(half, 3), "length_kpc": round(float(dl.sum() / KPC_CM), 2), "n_cells": n,
        "dl_kpc_median": sig(np.median(dlk), 3), "dl_kpc_max": sig(dlk.max(), 3),
        "X_H_range": [sig(XHv.min(), 3), sig(XHv.max(), 3)],
        "grid": {"V0": GRID[0], "V1": GRID[1], "dV": GRID[2]},
        "conventions": {
            "V": "V = c(lambda/lambda0 - 1) + v_sys (km/s); galaxy systemic at 0; positive = away from the observer",
            "tau": "tau_i(V) = k_tau N_i H(a_i, (V - V_i)/b_i)/b_i; k_tau = 1.4975e-15 f lam0[A] (cm^2 km/s); "
                   "total tau = sum_i tau_i, F = exp(-tau)",
            "b": "b_i = sqrt(2 k T_i / m) with Trident's atomic mass; thermal only (b_turb = 0)",
            "l_kpc": "cell centre along the sightline from its midpoint (path of the kernel line integral, kpc)",
            "logN_total": "total log N = log10 sum_i N_i",
            "F_intrinsic": "exp(-tau) of the stored Trident spectrum, linearly interpolated onto the 1 km/s grid",
            "fion": "n(O VI) = (O/H)sun (Z/Zsun) n_H f_OVI(n_H, T), HM2012 (hm2012_ss_hr), z = 0; "
                    "n(H I) = x_HI n_H with TNG's own x_HI"},
        "sources": {"library": "TNG50 sightline library (" + ("v3r" if gid == REF_GALAXY else "galaxy pipeline") + ")",
                    "web_line": f"the explorer's stored sightline binary for {ray} (S9 to S11 degrade it)",
                    "cutout": meta["cutout"], "ion_table": meta["ion_table"]},
        "checks": checks,
    }
    for key in STORY_IONS:
        for k in ("_N", "_tau0", "_b", "_taug"):
            ions[key].pop(k)
    for key in STORY_IONS:                                       # per ion, all columns (PLAN_final section 6)
        ions[key]["cells"] = {**cells, **{c: ions[key].pop(c) for c in ("f_ion", "logN", "b", "tau0", "a")}}
    data = {"meta": meta_out, "ions": ions,
            "select": {"S4a_cell": i_hi, "S4b_cell": c5, "S5_cell": c5, "S6_pair": pair, "S10_feature": feat,
                       "S9_ticks": ticks, "rules": {"S4a_cell": "H I cell with the largest N",
                                                    "S4b_cell": "O VI cell with the largest N (also S5)",
                                                    "S9_ticks": f"cells with tau0 > {TICK_TAU0}"}},
            "worked": worked}
    pf = out / f"page_fits_{stem(gid, ray)}.json"            # facts of the precomputed fits (scripts/story_fits.mjs)
    finish_story(data, json.loads(pf.read_text()) if pf.exists() else None)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"story_{stem(gid, ray)}.json"
    txt = json.dumps(data, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    path.write_text(txt, encoding="utf-8")
    gz = len(gzip.compress(txt.encode("utf-8"), 9))
    print(f"build {gid} {ray}: {path.name} {len(txt)/1024:.1f} kB, gz {gz/1024:.1f} kB; checks "
          + json.dumps({k: {"dF": v["max_abs_dF_cellsum_vs_stored"], "EW": v["EW_rel"]} for k, v in checks.items()}),
          flush=True)
    if gz > GZ_BUDGET:
        raise SystemExit(f"{path.name}: {gz} B gz exceeds the {GZ_BUDGET} B budget")
    return {"galaxy": gid, "ray": ray, "story": path.name, "page_fits": f"page_fits_{stem(gid, ray)}.json",
            "label": meta_out["label"], "eligible": data["story"]["eligible"]}


NA = "–"                               # display value of a quantity this sightline does not have


def opt(x, f):
    return f(x) if x else NA


def template_keys(d) -> dict:
    """Display strings for the {{key}} templates in steps.json (site style: no thousands comma)."""
    m, w, s = d["meta"], d["worked"], d["select"]
    hi, ov = d["ions"]["HI"]["totals"], d["ions"]["OVI"]["totals"]
    k = {
        "galaxy": str(m["galaxy"]), "ray": m["ray"],
        "R200c_kpc": f"{m['R200c_kpc']:.0f}", "M200c": fmt_pow(m["M200c_Msun"]), "Mstar": fmt_pow(m["Mstar_Msun"]),
        "SFR": f"{m['SFR_Msun_yr']:.1f}", "b_kpc": f"{m['b_kpc']:.1f}", "azimuth_deg": f"{m['azimuth_deg']:.1f}",
        "b_ly": fmt_int(round(m["b_kpc"] * LY_PER_KPC, -3)), "length_kpc": f"{2 * m['half_kpc']:.0f}",
        "n_cells": str(m["n_cells"]), "dl_median_kpc": f"{m['dl_kpc_median']:.2f}", "dl_max_kpc": f"{m['dl_kpc_max']:.1f}",
        "XH_min": f"{m['X_H_range'][0]:.3f}", "XH_max": f"{m['X_H_range'][1]:.3f}", "v_sys": f"{m['v_sys_kms']:.2f}",
        "ovi_n_half": str(ov["n_half"]), "hi_n_half": str(hi["n_half"]), "ovi_n_90": str(ov["n_90"]),
        "ovi_n_visible": str(ov["n_vis"]), "hi_n_visible": str(hi["n_vis"]),
        "ovi_peak_tau": f"{ov['peak_tau']:.2f}", "hi_peak_tau": fmt_int(hi["peak_tau"]),
        "ovi_logN": f"{ov['logN']:.2f}", "hi_logN": f"{hi['logN']:.2f}", "ovi_EW": f"{ov['ew_mA']:.0f}",
        "hi_EW": f"{hi['ew_mA']:.0f}", "ovi_b_min": opt(ov["b_visible"], lambda x: f"{x[0]:.1f}"), "ovi_b_max": opt(ov["b_visible"], lambda x: f"{x[1]:.1f}"),
        "ovi_aod_lo": opt(d["ions"]["OVI"]["library"]["aod"]["regions"], lambda r: f"{r[0][1]:.0f}"),
        "ovi_aod_hi": opt(d["ions"]["OVI"]["library"]["aod"]["regions"], lambda r: f"{r[-1][2]:.0f}"),
        "s4a_T": fmt_int(round(w["S4a"]["T"], -1)), "s4a_xHI": f"{w['S4a']['xHI']:.2f}",
        "s4b_T": fmt_pow(w["S4b"]["T"]), "s4b_fOVI": f"{w['S4b']['f_OVI']:.2f}",
        "s5_logN": f"{w['S5']['logN']:.2f}", "s5_b": f"{w['S5']['b']:.1f}", "s5_f": f"{w['S5']['f']:.3f}",
        "s5_lam0": f"{w['S5']['lam0_A']:.3f}", "s5_tau0": f"{w['S5']['tau0']:.2f}",
        "s5_centre_pct": f"{100 * w['S5']['centre_light']:.0f}", "s5_bH": f"{w['S5']['b_H_same_T']:.0f}",
        "s5_bH_ratio": f"{w['S5']['b_H_same_T'] / w['S5']['b']:.0f}",
        "s10_sigma": f"{w['S10']['sigma_pix_SN10']:.2f}", "s10_dvpix": f"{w['S10']['dv_pix_R30000']:.1f}",
    }
    for R, f in w["S9"]["fwhm_kms"].items():
        k[f"fwhm_{R}"] = f"{f:.1f}"
    k["ngal"] = str(m["n_galaxies"])
    k["s5_T"] = fmt_pow(w["S5"]["T"])
    k.update({"s6_dl_kpc": NA, "s6_l1": NA, "s6_l2": NA})
    if s["S6_pair"]:
        k["s6_dl_kpc"] = f"{s['S6_pair']['dl_kpc']:.0f}"
        lk = d["ions"]["OVI"]["cells"]["l_kpc"]
        k["s6_l1"] = f"{lk[s['S6_pair']['cells'][0]]:+.1f}"
        k["s6_l2"] = f"{lk[s['S6_pair']['cells'][1]]:+.1f}"
    for alias, src in ALIASES.items():
        k[alias] = k[src]
    return k


# ----------------------------------------------------------------------------------------------- story eligibility
H0_KMS_PER_KPC = 0.06774          # TNG50 (Planck 2015): H0 = 67.74 km/s/Mpc
MW_M200C = 1.0e12                 # Milky Way halo mass scale for the lay comparison (order of magnitude, ~1-1.5e12)
LLS_LOGN = 17.2                   # Lyman-limit threshold, log10 N(H I) / cm^-2
OVI_TAU_MIN = 2.0                 # O VI peak tau: a strong dip that looks near-black at high R (e^-2 = 14 % light; S9)
HI_TAU_MIN = 5.0                  # H I peak tau: a black core (S8 "Once black, only wider")
ELIGIBILITY_RULE = (f"O VI peak tau >= {OVI_TAU_MIN:g} (strong, near-black O VI dip for S7/S9); H I peak tau >= "
                    f"{HI_TAU_MIN:g} (black core, S8); a real S6 pair; visible O VI cells (b range, S7); a broad "
                    "single-cloud fit (b >= 2x the widest visible cell b) and an invented narrow cloud whose fit total "
                    "is within 0.5 dex of the truth (S11)")


def mw_compare(m200):
    """lay comparison phrase for the light-1 sentence, from M200c (Msun)"""
    r = m200 / MW_M200C
    if r < 0.6:
        return "smaller than the Milky Way"
    if r < 1.3:
        return "about the size of the Milky Way"
    if r < 2.5:
        return "somewhat bigger than the Milky Way"
    if r < 6:
        return "a few times more massive than the Milky Way"
    return "many times more massive than the Milky Way"


def story_facts(d, pf=None) -> tuple:
    """Extra display keys whose wording (not only number) depends on the galaxy, plus the eligibility verdict.
    -> (keys, {"eligible": bool, "fails": [...], "rule": str})"""
    m, s = d["meta"], d["select"]
    hi, ov = d["ions"]["HI"]["totals"], d["ions"]["OVI"]["totals"]
    k = {"s5_cell": str(s["S5_cell"]) if s.get("S5_cell") is not None else NA,
         "s6_cell_a": NA, "s6_cell_b": NA,
         "hubble_kms": f"{H0_KMS_PER_KPC * m['R200c_kpc']:.0f}",
         "mw_compare": mw_compare(m["M200c_Msun"]),
         "hi_lls": ("above 17.2: a Lyman-limit system" if hi["logN"] >= LLS_LOGN
                    else "below the 17.2 of a Lyman-limit system"),
         "ovi_sat": ("is saturated in its deepest core" if ov["peak_tau"] >= 5 else
                     "is mostly unsaturated, and its deepest core is just starting to saturate" if ov["peak_tau"] >= 1
                     else "is mostly unsaturated"),
         "hi_fit_dlo": NA, "hi_fit_dhi": NA}
    if s.get("S6_pair"):
        k["s6_cell_a"], k["s6_cell_b"] = (str(c) for c in s["S6_pair"]["cells"])
    fails = []
    if not ov["peak_tau"] >= OVI_TAU_MIN:
        fails.append(f"O VI peak tau {ov['peak_tau']:.3g} < {OVI_TAU_MIN:g}")
    if not hi["peak_tau"] >= HI_TAU_MIN:
        fails.append(f"H I peak tau {hi['peak_tau']:.3g} < {HI_TAU_MIN:g} (no black core)")
    if not s.get("S6_pair"):
        fails.append("no S6 pair")
    if not ov.get("b_visible"):
        fails.append("no visible O VI cell")
    if pf is None:
        fails.append("no precomputed fits")
    else:
        sel = pf.get("select") or {}
        hcases = [c for c in pf.get("cases", []) if c.get("ion") == "HI" and c.get("total_logN") is not None]
        if hcases:
            dd = sorted(c["total_logN"] - hi["logN"] for c in hcases)
            k["hi_fit_dlo"], k["hi_fit_dhi"] = f"{dd[0]:+.2f}", f"{dd[-1]:+.2f}"
        br, inv = sel.get("s11c_broad"), sel.get("s11c_invented")
        bmax = ov["b_visible"][1] if ov.get("b_visible") else None
        if not br or bmax is None or br.get("b", 0) < 2 * bmax:
            fails.append("no broad single-cloud fit")
        if not inv or inv.get("total_logN") is None or abs(inv["total_logN"] - ov["logN"]) > 0.5:
            fails.append("no sane invented-cloud fit")
    return k, {"eligible": not fails, "fails": fails, "rule": ELIGIBILITY_RULE}


def finish_story(data, pf=None):
    """template keys (+ the precomputed fits' facts) and the eligibility verdict, in place"""
    data["keys"] = template_keys(data)
    if pf is not None:
        data["keys"].update(pf.get("facts", {}))
    extra, verdict = story_facts(data, pf)
    data["keys"].update(extra)
    data["story"] = verdict
    return data


def patch_story(out: Path, names=None):
    """Recompute keys + eligibility of already-built story files in <out> (no cutout, no yt), refresh index.json."""
    entries = []
    for p in sorted(out.glob("story_*_*.json")) if not names else [out / n for n in names]:
        data = json.loads(p.read_text(encoding="utf-8"))
        g, ray = data["meta"]["galaxy"], data["meta"]["ray"]
        pf = out / f"page_fits_{stem(g, ray)}.json"
        finish_story(data, json.loads(pf.read_text()) if pf.exists() else None)
        p.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False, allow_nan=False), encoding="utf-8")
        v = data["story"]
        print(f"patch {p.name}: eligible={v['eligible']} {'; '.join(v['fails'])}", flush=True)
        entries.append({"galaxy": int(g), "ray": ray, "story": p.name, "page_fits": pf.name,
                        "label": data["meta"].get("label", f"Subhalo {g}"), "eligible": v["eligible"]})
    if entries:
        write_index(out, entries)
    return entries


# the names steps.json (U4) uses for the same quantities
ALIASES = {"R200c": "R200c_kpc", "vsys": "v_sys", "c263_logN": "s5_logN", "c263_b": "s5_b", "c263_tau0": "s5_tau0",
           "c263_Fc": "s5_centre_pct", "c263_T": "s5_T", "c263_bH": "s5_bH", "ovi_f": "s5_f", "ovi_lam": "s5_lam0",
           "ncross": "n_cells", "nvis": "ovi_n_visible", "ovi_peaktau": "ovi_peak_tau", "ovi_ew": "ovi_EW",
           "ovi_bmin": "ovi_b_min", "ovi_bmax": "ovi_b_max", "trough_lo": "ovi_aod_lo", "trough_hi": "ovi_aod_hi",
           "pair_a_l": "s6_l1", "pair_b_l": "s6_l2", "pair_sep": "s6_dl_kpc", "hi_peaktau": "hi_peak_tau",
           "sigma10": "s10_sigma"}


# ----------------------------------------------------------------------------------------------- f_OVI table slice
def build_fion(out: Path, table=None) -> Path:
    import h5py
    table = Path(table) if table else config.ion_table_dir() / "hm2012_ss_hr.h5"
    with h5py.File(table, "r") as h:
        ds = h["O"]
        lnH = np.asarray(ds.attrs["Parameter1"], float); zs = np.asarray(ds.attrs["Parameter2"], float)
        lT = np.asarray(ds.attrs["Temperature"], float)
        iz = int(np.argmin(np.abs(zs)))
        if abs(zs[iz]) > 1e-9:
            raise SystemExit("ion table has no z = 0 slice")
        lf = np.asarray(ds[5, :, iz, :], float)          # O VI = O_p5, log10 fraction, (n_H, T)
    Tg = np.round(np.arange(4.0, 7.0 + 1e-9, 0.025), 3)
    nHg = np.round(np.arange(-6.0, -1.0 + 1e-9, 0.25), 3)

    def interp2(x, y):          # bilinear in (log n_H, log T) on log f, Trident's interpolation at fixed z
        i = np.clip(np.searchsorted(lnH, x) - 1, 0, lnH.size - 2); j = np.clip(np.searchsorted(lT, y) - 1, 0, lT.size - 2)
        tx = (x - lnH[i]) / (lnH[i + 1] - lnH[i]); ty = (y - lT[j]) / (lT[j + 1] - lT[j])
        return ((1 - tx) * (1 - ty) * lf[i, j] + tx * (1 - ty) * lf[i + 1, j] + (1 - tx) * ty * lf[i, j + 1]
                + tx * ty * lf[i + 1, j + 1])

    def frac(lg):
        f = 10.0 ** lg
        return 0.0 if f <= 1e-9 else min(f, 1.0)
    slices = [[sig(frac(interp2(x, t)), 3) for t in Tg] for x in FION_LOGNH]
    grid = [[round(max(float(interp2(x, t)), -9.0), 3) for t in Tg[::2]] for x in nHg]
    peak = [float(Tg[int(np.argmax(r))]) for r in slices]
    data = {"schema": "story-fion/1", "ion": "OVI", "table": table.name, "z": 0.0,
            "note": "f(O VI) = n(O VI)/n(O), HM2012 UV background with self-shielding (Trident hm2012_ss_hr), "
                    "bilinear in (log n_H, log T) on log f as Trident; fractions <= 1e-9 are 0",
            "logT": [float(x) for x in Tg], "logNH_slices": list(FION_LOGNH), "f_slices": slices,
            "logT_peak_per_slice": peak,
            "grid": {"logNH": [float(x) for x in nHg], "logT": [float(x) for x in Tg[::2]], "log10_f": grid,
                     "note": "log10 f(O VI), floored at -9; bilinear interpolation reproduces the table to < 0.01 dex "
                             "inside the CGM range"}}
    out.mkdir(parents=True, exist_ok=True)
    p = out / "fion_OVI_slice.json"
    p.write_text(json.dumps(data, separators=(",", ":")))
    print(f"fion: {p.name} {p.stat().st_size/1024:.1f} kB, peak log T per slice {peak}", flush=True)
    return p


def write_index(out: Path, entries: list):
    p = out / "index.json"
    old = json.loads(p.read_text()) if p.exists() else {"stories": []}
    by = {(e["galaxy"], e["ray"]): e for e in old.get("stories", [])}
    for e in entries:
        by[(e["galaxy"], e["ray"])] = e
    stories = sorted(by.values(), key=lambda e: (e["galaxy"] != REF_GALAXY, e["galaxy"], e["ray"]))
    data = {"schema": "story-index/1", "default": {"galaxy": REF_GALAXY, "ray": REF_RAY},
            "fion": "fion_OVI_slice.json", "stories": stories}
    p.write_text(json.dumps(data, indent=1))


# ----------------------------------------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["cells", "build", "fion", "all", "patch"])
    ap.add_argument("--galaxy", nargs="+", type=int, default=[REF_GALAXY])
    ap.add_argument("--ray", default=REF_RAY)
    ap.add_argument("--library", help="library dir (one galaxy only)")
    ap.add_argument("--cutout", help="cutout file (one galaxy only)")
    ap.add_argument("--galaxy-json", help="galaxy record (one galaxy only)")
    ap.add_argument("--work", type=Path, default=None, help="scratch for the cell dumps (default <work>/scratch/story_data)")
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    a = ap.parse_args(argv)
    if len(a.galaxy) > 1 and (a.library or a.cutout or a.galaxy_json):
        ap.error("--library/--cutout/--galaxy-json need a single --galaxy")
    if a.stage == "patch":                                   # keys + eligibility only, on existing exports
        patch_story(a.out)
        return
    work = a.work or work_root() / "scratch" / "story_data"
    entries = []
    for gid in a.galaxy:
        paths = galaxy_paths(gid, a.library, a.cutout, a.galaxy_json)
        if a.stage in ("cells", "all"):
            stage_cells(gid, a.ray, work, paths)
        if a.stage in ("build", "all"):
            entries.append(build_one(gid, a.ray, work, a.out, paths))
    if entries:
        write_index(a.out, entries)
    if a.stage in ("build", "fion", "all"):
        build_fion(a.out)


if __name__ == "__main__":
    main()
