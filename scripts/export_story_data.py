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

story-data/2 (explainer v2, notes/story2/DESIGN_final.md section 3.6) adds, from the cutout and the cell dump: the kernel
geometry of every ray cell (centre, h, impact d, projected centre lc, kernel entry/exit s_in/s_out), the yt cubic-kernel
chord CDF table for the stateless live spectrum tau(v; s) = sum_i W_i(s) tau_i(v), n_crossed, the clouds rebuilt on the
story ray (scripts/build_story_clouds.py) and their letter names, the near-field tube (scripts/build_story_tube.py), the
explorer fields hint and the v2 facts/keys (facts2). Full chain per galaxy: scripts/story_data.sbatch.

  cuts   (SLURM) three yt partial rays p0 -> point(l) (M10 check), compared in build.

Usage:
  python scripts/export_story_data.py cells [--galaxy 488530] [--ray rand_b062_a062] [--work DIR]
  python scripts/export_story_data.py cuts  [--galaxy 488530] [--ray rand_b062_a062] [--work DIR]
  python scripts/export_story_data.py build [--galaxy 488530 411449 ...] [--ray ...] [--work DIR] [--out DIR]
Physics is the pipeline's (R_physics section 2); nothing here changes it.
"""
from __future__ import annotations
import argparse
import gzip
import json
import re
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
SCHEMA = "story-data/2"
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
GZ_BUDGET = 140 * 1024               # story-data/2 adds kernel geometry (672 cells) and the kernel CDF table
# acceptance of the rounded cell sum against the stored Trident spectrum (PLAN_final section 6). DF_MAX binds the
# reference story; on other sightlines Trident's own deposition can differ from the point-sampled cell Voigt sum by
# more (about 1 % in tau near strong cores), so there the rounding must not add more than ROUND_SLACK over the
# full-precision mismatch, which itself must stay below DF_CEIL.
DF_MAX = {"HI": 2e-3, "OVI": 3e-4}
DF_CEIL = {"HI": 5e-3, "OVI": 2e-3}
ROUND_SLACK = 1.1
EW_RTOL = 1e-3
# Non-reference rays: like dF, the EW limit is the rounding slack over the full-precision cell sum, capped by a
# ceiling. Damped H I (log N > 20, EW > 10 A) gives EW_rel 1.007e-3 at full precision on rand_b050_a215 (wing
# sampling, not rounding), which the hero-tuned 1e-3 rejected.
EW_CEIL = 3e-3
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


def gen_workdir(work: Path) -> Path:
    """Generator workdir (holds Trident's config.tri): job-private under TNG_WORKDIR when the sbatch sets it, so
    concurrent array tasks never rewrite one shared config file; else <work>/gen."""
    jd = os.environ.get("TNG_WORKDIR")
    return Path(jd) / "gen" if jd else Path(work) / "gen"


def story_library(gid, ray, work: Path, paths: dict) -> Path:
    """The library a story reads: the one-ray Trident library stage_cells made in <work>/lib_<gid>/ when it holds the
    ray (a host without the ray, or whose library is SBI), else the galaxy's own library."""
    priv = Path(work) / f"lib_{int(gid)}"
    if (priv / "sightlines" / f"{ray}.npz").exists():
        return priv
    return Path(paths["library"])


def is_sbi_ray(npz: Path, ray) -> bool:
    """True when a stored library ray comes from the SBI GPU pipeline (CLOUDY tables), not the Trident generator:
    its spectrum cannot be the parity reference for Trident cells, only its geometry is reused."""
    from tngsight.library import load_npz
    g = load_npz(str(npz), id=ray).get("geom") or {}
    return str(g.get("source", "")).lower().startswith("sbi")


def make_library_ray(gen, gid, ray, work: Path, paths: dict, geom: dict | None = None) -> Path:
    """A one-ray library for a host without one (any of the 198): the pipeline's own generator, npz writer, web
    encoder and Voigt fitter (deploy/data/regen_library.py), written to <work>/lib_<gid>/. Returns that dir.
    `geom` (an SBI library ray's stored geometry) is regenerated as is; without it the hero ray's geometry is
    transferred to the host (transfer_geometry)."""
    from tngsight import components as Cm
    from tngsight import library as Lb
    gal = json.loads(paths["galaxy_json"].read_text())
    if geom is None:
        geom = transfer_geometry(reference_geom(ray), gal)
    else:
        # same anchor and direction, recast over +-R200c like the hero ray (SBI rays span +-half_kpc ~ 2 R200c)
        g0 = {k: v for k, v in geom.items() if k != "id"}
        n = _unit(np.asarray(g0["n_los"], float)); anchor = np.asarray(g0["anchor_kpc"], float)
        c = np.asarray(gal["center_kpc"], float); half = float(gal["R200c_kpc"]); H = float(gal["TNG_H"])
        start, end = anchor - half * n, anchor + half * n
        d = anchor - c
        # v_sys in the subhalo frame the Trident cells use (SBI stores (SubhaloVel - V_bulk).n_los, another frame)
        geom = dict(g0, n_los=n.tolist(), half_kpc=half,
                    v_sys_kms=float(np.dot(np.asarray(gal["SubhaloVel_kms"], float), n)),
                    v_sys_kms_library=g0.get("v_sys_kms"), b_perp_check_kpc=float(np.linalg.norm(d - np.dot(d, n) * n)),
                    start_kpc=start.tolist(), end_kpc=end.tolist(), start_ckpch=(start * H).tolist(),
                    end_ckpch=(end * H).tolist(), geometry_from=g0.get("source"), half_kpc_library=g0.get("half_kpc"),
                    source="story_trident")
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
    if not (paths["library"] / "sightlines" / f"{ray}.npz").exists():
        ref = galaxy_paths(REF_GALAXY)["library"] / "sightlines" / f"{ray}.npz"
        if not ref.exists():
            # neither the host's library nor the reference library holds the id: a seeded host ray that the galaxy
            # pipeline has since moved out of the library (logs/unselected/; seen on 428177 during staging rerun
            # 1222540). Fail before loading the cutout; RAY=auto rejects the try and moves on.
            raise SystemExit(f"ray {ray} is in neither {paths['library']} nor the reference library "
                             f"(moved out of the host library after selection?)")
    cut = cutout_view(Path(paths["cutout"]), idx.parent)
    gen = G.Generator(cutout=cut, index_filename=idx, workdir=gen_workdir(work), fit_components=False)
    gen.load()
    ds = gen.ds
    npz = paths["library"] / "sightlines" / f"{ray}.npz"
    if not npz.exists():
        paths["library"] = make_library_ray(gen, gid, ray, work, paths)
        npz = paths["library"] / "sightlines" / f"{ray}.npz"
    elif (Path(work) / f"lib_{int(gid)}" / "sightlines" / f"{ray}.npz").exists() and int(gid) != REF_GALAXY:
        paths["library"] = Path(work) / f"lib_{int(gid)}"                  # regenerated by an earlier run
        npz = paths["library"] / "sightlines" / f"{ray}.npz"
    elif int(gid) != REF_GALAXY and is_sbi_ray(npz, ray):
        # SBI spectra use other ion tables: keep the ray's geometry, regenerate its spectrum through Trident
        paths["library"] = make_library_ray(gen, gid, ray, work, paths, geom=load_npz(str(npz), id=ray)["geom"])
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


# ----------------------------------------------------------------------------------------------- stage: cuts (M10)
CUT_L = (-130.0, -35.0, 90.0)          # partial rays p0 -> point(l): inside cloud A, at cell 263, inside cloud D


def stage_cuts(gid, ray, work: Path, paths: dict, cut_l=CUT_L) -> Path:
    """yt partial rays from p0 to three intermediate points, through the pipeline's generator, recorded for the M10
    check: which cells yt selects, their dl, and Trident's O VI / H I optical depth of the partial ray. yt keeps a
    particle whose kernel touches the segment with its FULL kernel column (dl does not depend on where the segment
    ends), so the partial ray is the upper bound of the story's kernel-weighted sum; the build stage compares."""
    import h5py
    from tngsight import generate as G
    from tngsight.library import load_npz
    idx = check_private_index(work, paths)
    cut = cutout_view(Path(paths["cutout"]), idx.parent)
    gen = G.Generator(cutout=cut, index_filename=idx, workdir=gen_workdir(work), fit_components=False)
    gen.load()
    ds = gen.ds
    paths["library"] = story_library(gid, ray, work, paths)
    p = load_npz(str(paths["library"] / "sightlines" / f"{ray}.npz"), id=ray)
    sl, _ = G.resolve_geometry(dict(p["geom"], id=ray))
    s0 = np.array(sl["start_ckpch"], float); s1 = np.array(sl["end_ckpch"], float)
    Lc = float(np.linalg.norm(s1 - s0)); nv = (s1 - s0) / Lc
    half = float(p["geom"]["half_kpc"]); H = Lc / (2 * half)                   # ckpc/h per kpc
    ds.domain_left_edge = ds.domain_left_edge.copy(); ds.domain_right_edge = ds.domain_right_edge.copy()
    res = []
    for lk in cut_l:
        e = s0 + nv * (lk + half) * H
        tmp = work / f"{stem(gid, ray)}_cut_{lk:+.0f}.h5"
        if tmp.exists():
            tmp.unlink()
        rayobj = gen._trident.make_simple_ray(ds, start_position=ds.arr(s0, "code_length"),
                                              end_position=ds.arr(e, "code_length"), fields=list(G.RAY_FIELDS),
                                              ftype="gas", data_filename=str(tmp))
        with h5py.File(tmp, "r") as h:
            g = h["grid"]
            xyz = np.stack([g["x"][()], g["y"][()], g["z"][()]], 1) / KPC_CM
            dl = g["dl"][()]
        cols = G.ray_columns(str(tmp))
        taus = {}
        for key in STORY_IONS:
            W = I.gen_window(key, cols[key])
            lam0, dlam, tau = G.make_line_spectrum(gen._trident, rayobj, key, W, gen._ld, gen.min_tau)
            rest = float(I.get(key)["lam0_A"])
            u = C * ((float(lam0) + np.arange(len(tau)) * float(dlam)) / rest - 1)     # Doppler frame, km/s
            taus[key] = {"u": u.tolist(), "tau": np.asarray(tau, float).tolist()}
        res.append({"l": lk, "xyz_kpc": xyz.tolist(), "dl_cm": dl.tolist(), "cols": cols, "spec": taus})
        tmp.unlink()
        print(f"cut l={lk:+.1f}: {dl.size} cells, logN {cols}", flush=True)
    outp = work / f"{stem(gid, ray)}_cuts.json"
    outp.write_text(json.dumps({"galaxy": int(gid), "ray": ray, "cuts": res}, default=float))
    return outp


def compare_cuts(work: Path, gid, ray, raw, geo, ions, tab, vsys, Vr):
    """M10 third clause, honest version: for each yt partial ray (stage_cuts) check that yt selected exactly the cells
    whose kernel starts before the cut (s_in < l_cut), with unchanged dl, that Trident's partial spectrum equals the
    full-column sum over those cells, and that the story's kernel-weighted sum lies between the cells already left
    (s_out < l_cut) and that upper bound."""
    p = work / f"{stem(gid, ray)}_cuts.json"
    if not p.exists():
        return None
    from scipy.spatial import cKDTree
    cj = json.loads(p.read_text())
    xd = np.stack([raw["x"], raw["y"], raw["z"]], 1) / KPC_CM
    tree = cKDTree(xd)
    out = []
    for c in cj["cuts"]:
        lk = float(c["l"])
        dist, j = tree.query(np.asarray(c["xyz_kpc"], float))
        touch = set(np.flatnonzero(geo["s_in"] < lk).tolist())                 # kernel sphere touches the segment
        expect = set(np.flatnonzero(geo["lc"] - geo["h"] < lk).tolist())        # yt: sphere extent along the ray
        got = set(int(x) for x in j)
        dl_rel = float(np.max(np.abs(np.asarray(c["dl_cm"]) / raw["dl"][j] - 1))) if j.size else 0.0
        row = {"l": lk, "n_yt": int(j.size), "n_expected": len(expect), "missing": sorted(expect - got)[:10],
               "extra": sorted(got - expect)[:10], "n_kernel_touching": len(touch),
               "yt_minus_touching": sorted(got - touch)[:10], "match_max_kpc": float(dist.max()) if j.size else 0.0,
               "dl_rel_max": dl_rel, "ions": {}}
        W = cell_weights(geo, lk, tab)
        for key in STORY_IONS:
            ic = ions[key]
            Nr = np.array([10 ** x if x is not None else 0.0 for x in ic["logN"]])
            u = np.asarray(c["spec"][key]["u"], float) + vsys
            t_yt = np.asarray(c["spec"][key]["tau"], float)
            tm = tau_matrix(ic["atom"], Nr, Vr, np.asarray(ic["b"], float), np.asarray(ic["a"], float), u)
            up = np.zeros(len(Nr)); up[sorted(got)] = 1.0
            lo = (geo["s_out"] < lk).astype(float)
            t_up = up @ tm; t_lo = lo @ tm; t_w = W @ tm
            row["ions"][key] = {"max_dF_trident_vs_fullcolumn_sum": float(np.max(np.abs(np.exp(-t_yt) - np.exp(-t_up)))),
                                "weighted_between_bounds": bool(np.all(t_w <= t_up + 1e-9) and np.all(t_w >= t_lo - 1e-9)),
                                "logN_yt": float(c["cols"][key]), "logN_weighted": float(np.log10(max(W @ Nr, 1e-300))),
                                "logN_left": float(np.log10(max(lo @ Nr, 1e-300)))}
        out.append(row)
    return {"cuts": out, "note": "yt selects every particle with lc - h < l_cut (its sphere's extent along the ray, "
                                 "ignoring the impact parameter, so a few kernels that miss the segment are included) "
                                 "and keeps each with its full column; the story weights straddling cells by the kernel "
                                 "CDF, so it lies between the cells already left and the yt partial ray"}


# ----------------------------------------------------------------------------------------------- geometry (story-data/2)
# yt treats Arepo cells as smoothed particles: h = 2 (3V/4pi)^(1/3) (yt arepo smoothing_factor 2), cubic spline kernel
# with support q = r/h <= 1, and the ray's dl_i = I(d_i^2/h_i^2) V_i / h_i^2 with I the kernel column (yt
# SPHKernelInterpolationTable). Trident deposits each cell's whole column N_i = n_i dl_i at its V_i, wherever along the
# ray the kernel sits. The live spectrum of the story at probe position s therefore weights each cell by the fraction of
# its kernel column already crossed: W_i(s) = K_cdf(d_i/h_i, (s - l_i)/c_i), c_i = sqrt(h_i^2 - d_i^2) (R_tech 13.2.2).
KCDF_NQ, KCDF_NU = 33, 65              # table rows q = d/h in [0, 1], columns u = (s - l)/c in [-1, 1], both linear
H_FACTOR = 2.0                          # yt arepo smoothing_factor
MATCH_TOL_KPC = 0.02                    # dump position vs cutout generator (float32 ckpc/h rounding)
CROSS_STEP_KPC = 0.005                  # nearest-generator sampling step for n_crossed (vortrace definition, 5 pc)


def yt_cubic(q):
    """yt's cubic spline kernel (pixelization_routines sph_kernel_cubic): 8/pi {1 - 6q^2(1 - q), 2(1 - q)^3}, q <= 1."""
    q = np.asarray(q, float)
    return (8.0 / math.pi) * np.where(q <= 0.5, 1 - 6 * q * q * (1 - q), np.where(q <= 1.0, 2 * (1 - q) ** 3, 0.0))


def kernel_chord_cdf(q, u, n=256):
    """Exact (Gauss-Legendre, n nodes per piece) fraction of the kernel column at impact q = d/h that lies at
    z/c <= u along the chord; c = sqrt(1 - q^2). Vectorised over u for one q. Used to build the table and to test it."""
    q = float(q); u = np.atleast_1d(np.asarray(u, float))
    c = math.sqrt(max(1.0 - q * q, 0.0))
    if c <= 0:
        return np.where(u >= 0, 1.0, 0.0)
    x, w = np.polynomial.legendre.leggauss(n)
    # integrate in z over [-c, uc]; the kernel has a kink at r = 0.5 (z0 = sqrt(0.25 - q^2) when q < 0.5)
    def integ(a, b):
        brk = [a, b]
        if q < 0.5:
            z0 = math.sqrt(0.25 - q * q)
            brk = sorted({a, b, *[z for z in (-z0, z0) if a < z < b]})
        tot = 0.0
        for lo, hi in zip(brk[:-1], brk[1:]):
            z = 0.5 * (hi - lo) * x + 0.5 * (hi + lo)
            tot += 0.5 * (hi - lo) * float(np.sum(w * yt_cubic(np.sqrt(q * q + z * z))))
        return tot
    full = integ(-c, c)
    return np.array([0.0 if uu <= -1 else 1.0 if uu >= 1 else integ(-c, uu * c) / full for uu in u])


def kernel_cdf_table(nq=KCDF_NQ, nu=KCDF_NU):
    qg = np.linspace(0.0, 1.0, nq); ug = np.linspace(-1.0, 1.0, nu)
    tab = np.array([kernel_chord_cdf(min(q, 1 - 1e-9), ug) for q in qg])
    tab[:, 0] = 0.0; tab[:, -1] = 1.0
    return qg, ug, tab


def kcdf_eval(tab, q, u):
    """Bilinear lookup in the shipped table (the client does exactly this): q = d/h, u = (s - l)/c."""
    tab = np.asarray(tab, float); nq, nu = tab.shape
    q = np.clip(np.asarray(q, float), 0, 1) * (nq - 1)
    u = (np.clip(np.asarray(u, float), -1, 1) + 1) * 0.5 * (nu - 1)
    i = np.minimum(np.floor(q).astype(int), nq - 2); j = np.minimum(np.floor(u).astype(int), nu - 2)
    tq = q - i; tu = u - j
    return ((1 - tq) * (1 - tu) * tab[i, j] + tq * (1 - tu) * tab[i + 1, j] + (1 - tq) * tu * tab[i, j + 1]
            + tq * tu * tab[i + 1, j + 1])


def cell_weights(geo, s, tab):
    """W_i(s) for every cell (s in the l frame, kpc): 0 before s_in, 1 after s_out, kernel CDF in between."""
    c = np.asarray(geo["c"], float)
    u = (s - np.asarray(geo["lc"], float)) / np.maximum(c, 1e-12)
    return kcdf_eval(tab, np.asarray(geo["q"], float), u)


def galaxy_frame(gal: dict):
    """(centre_kpc, R) of a galaxy record: disk frame rows xhat, yhat, Lhat; x_disk = (x - centre) @ R^T."""
    return np.asarray(gal["center_kpc"], float), np.array([gal["xhat"], gal["yhat"], gal["Lhat"]], float)


def story_ray(geom: dict, gal: dict) -> dict:
    """The story ray in the disk frame: p0 (s = 0), p1, unit n, half length; l = s - half (l = 0 at the ray midpoint,
    which is the closest approach to the galaxy centre). `frame` = right-handed basis (n, up, side) in disk axes:
    up = disk z projected off n (fallback disk y when |n.z| > 0.95), side = n x up."""
    c, R = galaxy_frame(gal)
    p0 = (np.asarray(geom["start_kpc"], float) - c) @ R.T
    p1 = (np.asarray(geom["end_kpc"], float) - c) @ R.T
    L = float(np.linalg.norm(p1 - p0)); n = (p1 - p0) / L
    z = np.array([0.0, 0.0, 1.0]) if abs(n[2]) <= 0.95 else np.array([0.0, 1.0, 0.0])
    up = z - np.dot(z, n) * n; up /= np.linalg.norm(up)
    side = np.cross(n, up)
    return {"p0": p0, "p1": p1, "n": n, "L": L, "half": 0.5 * L, "up": up, "side": side, "centre": c, "R": R}


def cutout_cells(cutout: Path, H: float):
    """(positions in box kpc, h kpc, V cm^3) of every gas cell, h5py order (= slim-cutout = yt order)."""
    import h5py
    with h5py.File(cutout, "r") as f:
        x = f["PartType0/Coordinates"][:].astype(np.float64) / H
        m = f["PartType0/Masses"][:].astype(np.float64)
        rho = f["PartType0/Density"][:].astype(np.float64)
    vol_code = m / rho                                          # (ckpc/h)^3 at a = 1
    r_eq = (3.0 * vol_code / (4.0 * math.pi)) ** (1.0 / 3.0) / H     # kpc
    return x, H_FACTOR * r_eq, (r_eq * KPC_CM) ** 3 * 4.0 * math.pi / 3.0


def cell_geometry(raw, gal: dict, geom: dict, cutout: Path, tab) -> dict:
    """Per-cell kernel geometry of the story's ray cells (dump order = yt order, sorted by the projection l) and the
    checks that tie it to the dump: generator match, yt's l, yt's dl from the kernel column, n_crossed."""
    from scipy.spatial import cKDTree
    from yt.utilities.lib.pixelization_routines import SPHKernelInterpolationTable
    ray = story_ray(geom, gal)
    H = float(gal["TNG_H"])
    xb, h_all, Vcm3 = cutout_cells(cutout, H)
    pb0 = np.asarray(geom["start_kpc"], float); nb = (np.asarray(geom["end_kpc"], float) - pb0) / ray["L"]
    rel = xb - pb0; t = rel @ nb
    perp = np.linalg.norm(rel - t[:, None] * nb, axis=1)
    near = np.flatnonzero((perp < h_all + 1.0) & (t > -50) & (t < ray["L"] + 50))   # kernels that can touch the ray
    xd = np.stack([raw["x"], raw["y"], raw["z"]], 1) / KPC_CM
    dist, j = cKDTree(xb[near]).query(xd)
    gidx = near[j]
    if dist.max() > MATCH_TOL_KPC:
        raise SystemExit(f"cell geometry: ray cell does not match a cutout generator (max {dist.max():.4f} kpc)")
    h = h_all[gidx]; V = Vcm3[gidx]
    lc_s = t[gidx]                                          # projection on the ray from p0 (kpc)
    d = perp[gidx]
    q = d / h
    if np.any(q >= 1):
        raise SystemExit(f"cell geometry: {int(np.sum(q >= 1))} ray cells with d >= h")
    c = h * np.sqrt(1 - q * q)
    itab = SPHKernelInterpolationTable("cubic")
    dl_kern = itab.interpolate_array(q * q) * V / (h * KPC_CM) ** 2               # cm
    dl_rel = float(np.max(np.abs(dl_kern / raw["dl"] - 1)))
    l_yt = raw["l"] / KPC_CM
    dl_proj = float(np.max(np.abs(lc_s - l_yt)))
    order_ok = bool(np.all(np.diff(l_yt) >= 0))
    lc = lc_s - ray["half"]
    centre = (xb[gidx] - ray["centre"]) @ ray["R"].T
    # Voronoi cells actually crossed: nearest generator at every 5 pc along the segment (vortrace definition)
    ss = np.arange(0.0, ray["L"] + 1e-9, CROSS_STEP_KPC)
    pts = pb0 + ss[:, None] * nb
    tube = np.flatnonzero((perp < 15.0) & (t > -20) & (t < ray["L"] + 20))
    _, k = cKDTree(xb[tube]).query(pts)
    crossed = np.unique(tube[k])
    crossed_in_ray = float(np.isin(crossed, gidx).mean())
    chk = {"match_max_kpc": float(dist.max()), "dl_kernel_vs_yt_max_rel": dl_rel, "l_proj_vs_yt_max_kpc": dl_proj,
           "sorted_by_l": order_ok, "n_crossed_in_kernel_set_frac": crossed_in_ray, "q_max": float(q.max())}
    if dl_rel > 2e-3 or dl_proj > MATCH_TOL_KPC or not order_ok:
        raise SystemExit(f"cell geometry checks failed: {chk}")
    return {"gidx": gidx, "centre": centre, "h": h, "d": d, "q": q, "c": c, "lc": lc, "s_in": lc - c, "s_out": lc + c,
            "n_crossed": int(crossed.size), "crossed_gidx": crossed, "ray": ray, "checks": chk}


# ----------------------------------------------------------------------------------------------- story-data/2 facts
# Beat windows along the ray (l, kpc) used by the data keys (DESIGN.md section 3 with DESIGN_final section 3.5: B8 and
# B9 split at +30). ROOT/beats.json (U_motion) wins when it exists and carries l0/l1 for these ids.
BEAT_L = {"B3": (-246.0, -212.0), "B4": (-212.0, -165.0), "B5": (-165.0, -124.0), "B6": (-124.0, -42.0),
          "B7a": (-42.0, -34.05), "B7d": (-34.05, -18.0), "B7e": (-18.0, -1.0), "B8": (-1.0, 30.0),
          "B9": (30.0, 81.0), "B10": (81.0, 122.0), "B11": (122.0, 246.0)}
# cloud letters: a letter names the CREST clouds (any ion) that hold most of their on-ray column inside its window
LETTER_BEATS = {"A": ("B5",), "B": ("B7a", "B7d"), "C": ("B9",), "D": ("B10",)}
LETTER_MIN_SHARE = 0.5
NEW_DIP_DTAU = 0.05                     # a "new dip" of a beat: local max of the tau gained over the beat >= this
SAT_F = 1e-4                            # an intrinsic spectrum at or below this is a black (saturated) trough
MINIMA_TAU = 0.05                       # spectral minima: local max (+-3 km/s) of the intrinsic tau >= this
TUBE_RADIUS_MIN = 20.0                  # D4 capsule radius floor (kpc)


REF_HALF = 246.35                      # half length (kpc) of the hero ray; beats.json meta.refHalf


def beat_windows(root: Path = ROOT, half: float | None = None) -> tuple:
    """(windows, source): l ranges per beat id, from beats.json when present, else BEAT_L. beats.json l values are kpc
    on the hero ray and scale with the ray's half length for other rays (beats.json meta), so with `half` given every
    window is multiplied by half / refHalf (exactly 1 on 488530)."""
    p = root / "beats.json"
    w = dict(BEAT_L); src = "export_story_data.BEAT_L (DESIGN section 3 + DESIGN_final 3.5)"
    ref = REF_HALF
    if p.exists():
        try:
            bj = json.loads(p.read_text())
            items = bj.get("beats", bj) if isinstance(bj, dict) else bj
            if isinstance(bj, dict):
                ref = float((bj.get("meta") or {}).get("refHalf") or REF_HALF)
            got = {b["id"]: (float(b["l0"]), float(b["l1"])) for b in items
                   if isinstance(b, dict) and b.get("id") in BEAT_L and b.get("l0") is not None and b.get("l1") is not None}
            if got:
                w.update(got); src = f"beats.json ({len(got)} beats) over BEAT_L"
        except (ValueError, KeyError, TypeError):
            pass
    if half is not None and abs(half / ref - 1) > 1e-4:
        s = half / ref
        w = {k: (a * s, b * s) for k, (a, b) in w.items()}
        src += f", scaled by half/refHalf = {s:.4f}"
    return w, src


def tau_matrix(atom, N, V, b, a, vgrid):
    """tau_i(v) per cell (rows), the same per-cell Voigt as cell_tau (H I keeps its full wings)."""
    out = np.zeros((len(N), vgrid.size))
    k = atom["k_tau"]
    for i, (Ni, Vi, bi, ai) in enumerate(zip(N, V, b, a)):
        if Ni > 0 and bi > 0:
            out[i] = k * Ni * voigt_H(ai, (vgrid - Vi) / bi) / bi
    return out


def depth_of(tau):
    return float(1 - math.exp(-float(np.max(tau)))) if np.size(tau) else 0.0


def peaks(y, vgrid, thr, half=3):
    """local maxima of y (+-half samples) above thr -> [(V, y)] sorted by V"""
    return [(float(vgrid[k]), float(y[k])) for k in local_maxima(y, half) if y[k] >= thr]


def half_peak_T(fion: dict, lognH: float) -> dict:
    """f_OVI(T) at fixed log n_H, linear in log n_H between the two bracketing shipped slices (B7c); returns the peak
    and the half-peak temperatures on both sides (linear in log T between samples)."""
    xs = list(fion["logNH_slices"]); lT = np.asarray(fion["logT"], float)
    j = int(np.clip(np.searchsorted(xs, lognH) - 1, 0, len(xs) - 2))
    w = (lognH - xs[j]) / (xs[j + 1] - xs[j])
    f = (1 - w) * np.asarray(fion["f_slices"][j], float) + w * np.asarray(fion["f_slices"][j + 1], float)
    k = int(np.argmax(f)); half = 0.5 * f[k]

    def cross(rng):
        for a_, b_ in rng:
            if (f[a_] - half) * (f[b_] - half) <= 0 and f[a_] != f[b_]:
                return float(lT[a_] + (half - f[a_]) / (f[b_] - f[a_]) * (lT[b_] - lT[a_]))
        return None
    lo = cross([(i, i + 1) for i in range(k - 1, -1, -1)])
    hi = cross([(i, i + 1) for i in range(k, len(f) - 1)])
    return {"lognH": lognH, "slices": [xs[j], xs[j + 1]], "w": w, "logT_peak": float(lT[k]), "f_peak": float(f[k]),
            "logT_cool_fade": lo, "logT_hot_fade": hi}


def spectral_minima(F, vgrid, f_sat=SAT_F):
    """Minima of an intrinsic spectrum: (unsaturated, saturated). Saturated troughs (F <= f_sat, black at 5-decimal
    rounding) are single entries [V_centre, V_lo, V_hi]; elsewhere local maxima (+-3 km/s) of tau >= MINIMA_TAU as
    [V, depth]."""
    sat = F <= f_sat
    runs, i = [], 0
    while i < len(F):
        if sat[i]:
            j = i
            while j + 1 < len(F) and sat[j + 1]:
                j += 1
            runs.append([round(0.5 * (vgrid[i] + vgrid[j]), 1), float(vgrid[i]), float(vgrid[j])])
            i = j + 1
        else:
            i += 1
    tau = -np.log(np.maximum(F, f_sat))
    un = [[v, round(1 - math.exp(-t), 4)] for v, t in peaks(tau, vgrid, MINIMA_TAU)
          if not sat[int(round((v - vgrid[0]) / (vgrid[1] - vgrid[0])))] and t < -math.log(f_sat) - 1e-9]
    return un, runs


def segment_box(p0, p1, half):
    """[t0, t1] (fractions of the segment) inside the cube |x|_inf <= half (slab method), or None"""
    d = p1 - p0; t0, t1 = 0.0, 1.0
    for k in range(3):
        if abs(d[k]) < 1e-12:
            if abs(p0[k]) > half:
                return None
            continue
        a, b = sorted(((-half - p0[k]) / d[k], (half - p0[k]) / d[k]))
        t0, t1 = max(t0, a), min(t1, b)
        if t0 > t1:
            return None
    return t0, t1


def fields_hint(gid, ray) -> dict:
    """explorer volume fields the stage can load for this galaxy, and the cube levels the story ray enters"""
    man = REPO / "docs" / "tng50" / "data" / "viz" / "manifest_v2.json"
    out = {"manifest": None, "available": [], "velocity": False, "levels": {}}
    if not man.exists():
        return out
    m = json.loads(man.read_text())
    if int(m.get("galaxy", {}).get("subhalo_id", -1)) != int(gid):
        out["note"] = "the shipped explorer manifest is another galaxy's; fields come from that galaxy's hosted manifest"
        return out
    out["manifest"] = "docs/tng50/data/viz/manifest_v2.json"
    out["available"] = sorted(m["gas"]["fields"])
    out["velocity"] = bool(m["gas"].get("vectors"))
    for lv in m["gas"]["levels"]:
        hk = float(m["levels"][lv]["half_kpc"])
        seg = segment_box(ray["p0"], ray["p1"], hk)
        out["levels"][lv] = None if seg is None else [round(seg[0] * ray["L"] - ray["half"], 2),
                                                       round(seg[1] * ray["L"] - ray["half"], 2)]
    out["levels_note"] = "l range of the story ray inside each cube level (null = never enters)"
    return out


def letter_windows(win: dict) -> dict:
    return {L: (min(win[b][0] for b in bs), max(win[b][1] for b in bs)) for L, bs in LETTER_BEATS.items()}


def cloud_names(clouds_web: dict, geo: dict, win: dict, Nion: dict) -> dict:
    """letter -> CREST clouds per ion with shares (H6). A cloud is listed under a letter when >= LETTER_MIN_SHARE of its
    on-ray column (members weighted by N_i) has its kernel centre inside the letter's window; share = that fraction,
    of_ion = the cloud's fraction of the ion's ray column. Clouds under no letter are named '<ion> structure'."""
    lw = letter_windows(win); lc = np.asarray(geo["lc"], float)
    out = {"rule": f"clouds with >= {LETTER_MIN_SHARE:g} of their on-ray column (kernel centres) inside the letter's "
                   "beat window; others are '<ion> structure'",
           "windows": {L: [round(a, 2), round(b, 2)] for L, (a, b) in lw.items()},
           "beats": {L: list(bs) for L, bs in LETTER_BEATS.items()}, "letters": {}, "unnamed": {}}
    for L in lw:
        out["letters"][L] = {}
    for key, ion in (clouds_web or {}).get("ions", {}).items():
        N = Nion.get(key)
        if N is None:
            continue
        for cl in ion["clouds"]:
            m = np.asarray(cl["members"], int)
            tot = float(N[m].sum())
            best = None
            for L, (a, b) in lw.items():
                inside = (lc[m] >= a) & (lc[m] < b)
                sh = float(N[m][inside].sum() / tot) if tot > 0 else 0.0
                if sh >= LETTER_MIN_SHARE and (best is None or sh > best[1]):
                    best = (L, sh)
            ent = {"id": cl["id"], "of_ion": cl["frac_ion_column"], "l": [cl["l_in"], cl["l_out"]]}
            if best:
                out["letters"][best[0]].setdefault(key, []).append(dict(ent, share=round(best[1], 4)))
            else:
                out["unnamed"].setdefault(key, []).append(dict(ent, label=f"{key} structure"))
    return out


# copy.json flags (R_content section 10 rules); every threshold here is the rule's own number
FIRST_OVI_TAU0 = 0.05                  # has_first_ovi: a cell in flight order with O VI tau0 above this (B4)
COOL_PEAK_TAU = 1.0                    # hi_black: a cool (H I) cloud whose own peak tau exceeds this (B5, B10, B12a)
SKIN_DL_KPC, SKIN_DV_KMS = 10.0, 20.0  # has_ovi_skin: O VI cells within 10 kpc of the cool cloud and |dV| < 20 km/s
KNOT_DL_KPC, KNOT_DV_KMS = 15.0, 50.0  # has_cold_knot: H I group within 15 kpc of an O VI group with |dV| > 50 km/s
HOT_STRETCH_KPC, HOT_STRETCH_T = 40.0, 1e6   # has_hot_stretch: >= 40 kpc, median T > 1e6 K, no visible cell


def _gap(a, b) -> float:
    """distance (kpc) between two l intervals, 0 when they overlap"""
    return max(0.0, max(a[0], b[0]) - min(a[1], b[1]))


def cloud_facts(cw, names, geo, tm, Nion, ions, Vr, T, vgrid) -> dict:
    """Facts behind the copy.json flags that need clouds or per-cell spectra. A cloud's velocity is the minimum of its
    own spectrum (argmax of the summed member tau on the 1 km/s grid), i.e. positions come from spectral minima."""
    out = {"cloud_V": {}, "cold_knot": None, "ovi_skin": None, "richest_ovi": None, "hi_black_cloud": None,
           "hot_stretch": None}
    lc = np.asarray(geo["lc"], float)
    Vr = np.asarray(Vr, float)
    lettered = {}
    for L, byion in ((names or {}).get("letters") or {}).items():
        for es in byion.values():
            for e in es:
                lettered[e["id"]] = L
    cl = {}
    for key in STORY_IONS:
        for c in ((cw or {}).get("ions", {}).get(key, {}).get("clouds") or []):
            m = np.asarray(c.get("members") or [], int)
            if m.size == 0:
                continue
            t = tm[key][m].sum(0)
            k = int(np.argmax(t))
            cl[c["id"]] = {"id": c["id"], "ion": key, "l": (float(c["l_in"]), float(c["l_out"])), "V": float(vgrid[k]),
                           "peak_tau": float(t[k]), "N": float(Nion[key][m].sum()), "letter": lettered.get(c["id"])}
            out["cloud_V"][c["id"]] = {"V": float(vgrid[k]), "peak_tau": round(float(t[k]), 4)}
    his = [c for c in cl.values() if c["ion"] == "HI"]
    ovs = [c for c in cl.values() if c["ion"] == "OVI"]
    # hi_black: the most H I-rich cloud whose own core is black (peak tau > 1)
    cool = [h for h in his if h["peak_tau"] > COOL_PEAK_TAU]
    if cool:
        h = max(cool, key=lambda c: c["N"])
        out["hi_black_cloud"] = {"id": h["id"], "peak_tau": h["peak_tau"], "l": list(h["l"]), "letter": h["letter"]}
    # O VI skin: around cloud A's H I when lettered, else the most H I-rich black cloud
    skin_host = None
    a_hi = [h for h in cool if h["letter"] == "A"]
    if a_hi:
        skin_host = max(a_hi, key=lambda c: c["N"])
    elif cool:
        skin_host = max(cool, key=lambda c: c["N"])
    if skin_host is not None:
        t0 = np.asarray([x or 0.0 for x in ions["OVI"]["tau0"]], float)
        sk = [int(i) for i in np.flatnonzero(t0 > FIRST_OVI_TAU0)
              if _gap((lc[i], lc[i]), skin_host["l"]) <= SKIN_DL_KPC and abs(Vr[i] - skin_host["V"]) < SKIN_DV_KMS]
        if sk:
            out["ovi_skin"] = {"host": skin_host["id"], "cells": sk, "host_V": skin_host["V"]}
    # cold knot: an H I cloud within 15 kpc of an O VI cloud moving > 50 km/s differently. Unlettered H I clouds first
    # (lettered clouds already have their own beats), then the largest H I column.
    cands = []
    for h in his:
        part = [o for o in ovs if _gap(h["l"], o["l"]) <= KNOT_DL_KPC and abs(h["V"] - o["V"]) > KNOT_DV_KMS]
        if part:
            cands.append((h["letter"] is None, h["N"], h))
    if cands:
        h = max(cands, key=lambda x: (x[0], x[1]))[2]
        beside = sorted({round(o["V"]) for o in ovs if _gap(h["l"], o["l"]) <= KNOT_DL_KPC})
        out["cold_knot"] = {"HI": h["id"], "l": list(h["l"]), "HI_V": h["V"],
                            "OVI": [o["id"] for o in ovs if _gap(h["l"], o["l"]) <= KNOT_DL_KPC], "OVI_V": beside,
                            "rule": f"H I cloud within {KNOT_DL_KPC:g} kpc of an O VI cloud with |dV| > {KNOT_DV_KMS:g} "
                                    "km/s (cloud V = its own spectral minimum); unlettered first, then largest N(H I); "
                                    "OVI_V lists every O VI cloud within the same distance"}
    # richest O VI group (largest column) and whether it holds the closest-approach point l = 0
    if ovs:
        o = max(ovs, key=lambda c: c["N"])
        out["richest_ovi"] = {"id": o["id"], "l": list(o["l"]), "contains_l0": bool(o["l"][0] <= 0.0 <= o["l"][1])}
    # hot stretch: longest run (in l order) of cells none of which is visible in O VI or H I
    vis = np.zeros(len(lc), bool)
    for key in STORY_IONS:
        vis |= np.asarray([x or 0.0 for x in ions[key]["tau0"]], float) > VISIBLE_TAU0
    order = np.argsort(lc)
    best, run = None, []
    for i in list(order) + [None]:
        if i is not None and not vis[i]:
            run.append(int(i)); continue
        if len(run) >= 2:
            span = float(lc[run[-1]] - lc[run[0]]); medT = float(np.median(T[run]))
            if span >= HOT_STRETCH_KPC and medT > HOT_STRETCH_T and (best is None or span > best["span_kpc"]):
                best = {"l": [float(lc[run[0]]), float(lc[run[-1]])], "span_kpc": span, "median_T": medT,
                        "n_cells": len(run)}
        run = []
    out["hot_stretch"] = best
    return out


def story_v2(gid, ray, raw, gal, geom, paths, out: Path, cells, ions, Vr, l_mid, select_pair, work_dir=None) -> tuple:
    """story-data/2 blocks: (geometry, clouds, cloud_names, tube, facts2). Needs the cutout (cell matching)."""
    qg, ug, tab = kernel_cdf_table()
    geo = cell_geometry(raw, gal, geom, Path(paths["cutout"]), tab)
    n = len(geo["lc"])
    win, win_src = beat_windows(half=float(geo["ray"]["half"]))
    vgrid = np.arange(GRID[0], GRID[1] + 1e-9, GRID[2])
    T = np.asarray(cells["T"], float); nH = np.asarray(cells["nH"], float)
    tm, Nion = {}, {}
    for key in STORY_IONS:
        ic = ions[key]
        Nr = np.array([10 ** x if x is not None else 0.0 for x in ic["logN"]])
        tm[key] = tau_matrix(ic["atom"], Nr, Vr, np.asarray(ic["b"], float), np.asarray(ic["a"], float), vgrid)
        Nion[key] = Nr

    def tau_at(key, s):
        return cell_weights(geo, s, tab) @ tm[key]

    def frac_at(key, s):
        return float(cell_weights(geo, s, tab) @ Nion[key] / Nion[key].sum())
    # ---- end-of-flight equals the stored spectrum on the 1 km/s grid (the client's F)
    eof = {}
    for key in STORY_IONS:
        Fst = np.asarray(ions[key]["F_intrinsic"], float)
        eof[key] = float(np.max(np.abs(np.exp(-tau_at(key, geo["lc"].max() + geo["c"].max() + 1)) - Fst)))
    # ---- clouds (rebuilt on the story ray by build_story_clouds.py)
    cdir = out / "clouds" / stem(gid, ray)
    cw = json.loads((cdir / "clouds.json").read_text()) if (cdir / "clouds.json").exists() else None
    names = cloud_names(cw, geo, win, Nion) if cw else None
    # ---- worked cells
    S5 = int(np.argmax(Nion["OVI"]))
    a_hi = (names or {}).get("letters", {}).get("A", {}).get("HI", [])
    cf = cloud_facts(cw, names, geo, tm, Nion, ions, Vr, T, vgrid)
    core, cid, core_src = None, None, None
    if a_hi and cw:
        cid = max(a_hi, key=lambda e: e["share"] * e["of_ion"])["id"]; core_src = "letter A H I cloud"
    elif cf.get("hi_black_cloud") and cw:
        # no H I cloud in the A window (another ray): cloud A is the black H I cloud the hi_black flag names
        cid = cf["hi_black_cloud"]["id"]; core_src = "hi_black cloud (no H I cloud lettered A)"
    if cid is not None:
        mem = next(c["members"] for c in cw["ions"]["HI"]["clouds"] if c["id"] == cid)
        core = int(max(mem, key=lambda i: Nion["HI"][i]))
    xHI = np.asarray(ions["HI"]["f_ion"], float)

    def b_th(Tk, el):
        return math.sqrt(2 * KB * Tk / (TRIDENT_MASS[el] * AMU)) / 1e5
    vsys = float(geom["v_sys_kms"]) if "v_sys_kms" in geom else None
    facts = {"n_kernels": n, "n_crossed": geo["n_crossed"], "beat_windows": {k: list(v) for k, v in win.items()},
             "beat_windows_source": win_src, "end_of_flight_max_dF": eof, "S5_cell": S5}
    if core is not None:
        facts.update(cloudA_core_cell=core, cloudA_xHI=float(xHI[core]), cloudA_core_T=float(T[core]),
                     cloudA_core_bH=b_th(T[core], "H"), cloudA_core_bO=b_th(T[core], "O"))
    facts["hot_cell"] = S5
    facts["hot_xHI"] = float(xHI[S5])
    if core is not None and xHI[S5] > 0:
        facts["xHI_ratio"] = float(xHI[core] / xHI[S5])
    # ---- beat depths (O VI partial spectrum)
    facts["b3_ovi_depth"] = depth_of(tau_at("OVI", win["B3"][1]))
    vis = np.flatnonzero(np.asarray(ions["OVI"]["tau0"], float) > VISIBLE_TAU0)
    first = int(vis[0]) if vis.size else None                  # no visible O VI cell: the B4 keys stay NA
    facts["b4_first_cell"] = first
    facts["b4_end_depth"] = depth_of(tau_at("OVI", win["B4"][1]))
    if first is not None:
        facts["b4_first_depth"] = float(1 - math.exp(-float(ions["OVI"]["tau0"][first])))
        facts["b3_depth_before_first"] = depth_of(tau_at("OVI", float(geo["s_in"][first])))
        facts["b3_first_cell_straddles_end"] = bool(geo["s_in"][first] < win["B3"][1] < geo["s_out"][first])
    d5 = tau_at("OVI", win["B5"][1]) - tau_at("OVI", win["B5"][0]); k5 = int(np.argmax(d5))
    facts["b5_ovi_depth"] = float(1 - math.exp(-d5[k5])); facts["b5_ovi_V"] = float(vgrid[k5])
    facts["b5_rule"] = "depth of the O VI optical depth gained over B5, at its maximum"
    # ---- new dips per beat (G13): local maxima of the tau gained over the beat, and its argmax
    nd = {}
    for b_, (l0, l1) in win.items():
        nd[b_] = {}
        for key in STORY_IONS:
            dt = tau_at(key, l1) - tau_at(key, l0)
            k = int(np.argmax(dt))
            nd[b_][key] = {"V_argmax": float(vgrid[k]), "dtau_max": float(dt[k]),
                           "dips": [[v, round(x, 4)] for v, x in peaks(dt, vgrid, NEW_DIP_DTAU)]}
    facts["new_dips"] = nd
    facts["b8_new_dips"] = nd["B8"]["OVI"]["dips"]; facts["b9_new_dips"] = nd["B9"]["OVI"]["dips"]
    # ---- spectral minima of the full intrinsic spectrum (positions shown as dips come only from these, H2)
    for key, kk in (("OVI", "ovi_minima"), ("HI", "hi_minima")):
        facts[kk], facts[kk + "_saturated"] = spectral_minima(np.asarray(ions[key]["F_intrinsic"], float), vgrid)
    # ---- O VI temperature fades at the hot cell's density (B7c)
    fp = out / "fion_OVI_slice.json"
    if not fp.exists():
        build_fion(out)
    hp = half_peak_T(json.loads(fp.read_text()), math.log10(nH[S5]))
    facts["ovi_T_fade"] = hp
    facts["ovi_T_hot_fade"] = 10 ** hp["logT_hot_fade"] if hp["logT_hot_fade"] is not None else None
    facts["ovi_T_cool_fade"] = 10 ** hp["logT_cool_fade"] if hp["logT_cool_fade"] is not None else None
    # ---- E4 sign and the galaxy velocity
    facts["v_gal"] = -vsys if vsys is not None else None
    facts["frac_before_l0"] = {key: frac_at(key, 0.0) for key in STORY_IONS}
    # ---- per-cloud spectral minima, cold knot, O VI skin, richest O VI group, hot stretch (copy.json flags)
    facts.update(cf)
    facts["cloudA_source"] = core_src
    # ---- S6 thread: how many pairs pass the rule, and the pair's facts
    t0o = np.asarray(ions["OVI"]["tau0"], float); bo = np.asarray(ions["OVI"]["b"], float)
    cand = np.where(t0o > 0.05)[0]
    npairs = sum(1 for x in range(len(cand)) for y in range(x + 1, len(cand))
                 if abs(Vr[cand[x]] - Vr[cand[y]]) < 0.5 * min(bo[cand[x]], bo[cand[y]])
                 and abs(l_mid[cand[x]] - l_mid[cand[y]]) >= 50)
    facts["n_pairs"] = int(npairs)
    if select_pair:
        i, j = select_pair["cells"]
        facts["pair_dlc_kpc"] = float(abs(geo["lc"][j] - geo["lc"][i]))
    facts["hubble_kms"] = H0_KMS_PER_KPC * float(gal["R200c_kpc"])
    facts["yt_partial_cuts"] = compare_cuts(Path(work_dir), gid, ray, raw, geo, ions, tab, vsys, Vr) if work_dir else None
    # ---- geometry block (client: W_i(s) = bilinear(kernel_cdf, d/h, (s - lc)/c))
    r = geo["ray"]
    crossed_idx = np.flatnonzero(np.isin(geo["gidx"], geo["crossed_gidx"]))
    geometry = {
        "ray": {"p0": [round(float(x), 4) for x in r["p0"]], "p1": [round(float(x), 4) for x in r["p1"]],
                "n": [round(float(x), 7) for x in r["n"]], "L": round(r["L"], 4), "half": round(r["half"], 4),
                "frame": {"n": [round(float(x), 7) for x in r["n"]], "up": [round(float(x), 7) for x in r["up"]],
                          "side": [round(float(x), 7) for x in r["side"]]},
                "note": "disk frame (xhat, yhat, Lhat) kpc from the galaxy centre, the frame of the explorer cubes; "
                        "point(l) = p0 + (l + half) n"},
        "cells": {"idx": list(range(n)), "centre": [round(float(x), 3) for x in geo["centre"].ravel()],
                  "h": col(geo["h"], lambda x: sig(x, 5)), "d": col(geo["d"], lambda x: sig(x, 5)),
                  "lc": col(geo["lc"], lambda x: fixed(x, 4)),
                  "s_in": col(geo["s_in"], lambda x: fixed(x, 4)), "s_out": col(geo["s_out"], lambda x: fixed(x, 4))},
        "kernel_cdf": {"q": [round(float(x), 6) for x in qg], "u": [round(float(x), 6) for x in ug],
                       "table": [[round(float(x), 6) for x in row] for row in tab],
                       "interp": "bilinear on the linear (q, u) grid; q = d/h clipped to [0, 1], u = (s - lc)/c clipped "
                                 "to [-1, 1], c = sqrt(h^2 - d^2); W_i(s) = table(q_i, u_i); tau(v; s) = sum_i W_i(s) tau_i(v)",
                       "kernel": "yt cubic spline (yt arepo frontend: h = 2 (3V/4pi)^(1/3)); yt's ray dl_i = I(q_i^2) V_i/h_i^2",
                       "max_abs_err_vs_exact": None},
        "n_kernels": n, "n_crossed": geo["n_crossed"], "crossed": [int(i) for i in crossed_idx],
        # a Voronoi cell can be crossed although its kernel misses the ray (h = 2 (3V/4pi)^(1/3) is a volume-equivalent
        # radius; an elongated cell reaches further): it counts in n_crossed but has no bead (1 on rand_b050_a215)
        "n_crossed_outside_kernels": int(geo["n_crossed"] - crossed_idx.size),
        "conventions": {"lc": "kernel centre projected on the ray, l = s - half (kpc; 0 at the ray midpoint = closest "
                              "approach); exact yt ray l. Use lc, s_in, s_out for every position along the ray",
                        "l_kpc_v1": "ions.*.cells.l_kpc (v1) is yt l + dl/2 - half, offset from lc by up to "
                                    f"{0.5 * float(np.max(raw['dl'])) / KPC_CM:.1f} kpc; kept for v1 compatibility only",
                        "d": "impact parameter of the generator from the ray (kpc)", "h": "kernel support radius (kpc)",
                        "crossed": "ray cells whose Voronoi polyhedron the ray actually crosses (nearest generator every "
                                   f"{CROSS_STEP_KPC * 1000:.0f} pc); the rest only touch the ray with their kernel"},
        "checks": geo["checks"]}
    rng = np.random.default_rng(7); err = 0.0
    for qq in rng.uniform(0, 0.999, 24):
        uu = rng.uniform(-1, 1, 40)
        err = max(err, float(np.abs(kcdf_eval(tab, np.full(40, qq), uu) - kernel_chord_cdf(qq, uu)).max()))
    geometry["kernel_cdf"]["max_abs_err_vs_exact"] = sig(err, 3)
    clouds = None
    if cw:
        cs = {}
        for key, ion in cw["ions"].items():
            cs[key] = {"n_iso_log": ion["n_iso_log"], "iso_steps_end": ion["iso_steps"][-1],
                       "clouds": [{"id": c["id"], "l": [c["l_in"], c["l_out"]], "logN": c["logN_ray"],
                                   "of_ion": c["frac_ion_column"], "open": c["at_R_max"]} for c in ion["clouds"]]}
        clouds = {"path": f"clouds/{stem(gid, ray)}/clouds.json", "schema": cw["schema"], "summary": cs}
    geometry["fields"] = fields_hint(gid, geo["ray"])
    tdir = out / "tube" / f"{stem(gid, ray)}.json"
    tube = json.loads(tdir.read_text()) if tdir.exists() else None
    if tube:
        tube = {k: tube[k] for k in ("path", "n", "radius_kpc", "bytes_gz", "enc") if k in tube}
    return geometry, clouds, names, tube, facts, geo


def v2_template_keys(d) -> dict:
    """display strings of the story-data/2 keys (copy.json {{key}}); NA when a fact is missing"""
    f = d.get("facts2") or {}
    k = {}

    def put(name, val, fmt):
        k[name] = fmt(val) if val is not None else NA
    put("n_kernels", f.get("n_kernels"), str)
    put("n_crossed", f.get("n_crossed"), str)
    put("n_pairs", f.get("n_pairs"), str)
    put("cloudA_xHI", f.get("cloudA_xHI"), lambda x: f"{x:.2f}")
    put("hot_xHI", f.get("hot_xHI"), lambda x: fmt_pow(x, 0))
    put("xHI_ratio", f.get("xHI_ratio"), lambda x: fmt_int(round(x, -int(math.floor(math.log10(x))) + 1)))
    put("cloudA_core_T", f.get("cloudA_core_T"), lambda x: fmt_pow(x, 2))
    put("cloudA_core_bH", f.get("cloudA_core_bH"), lambda x: f"{x:.1f}")
    put("cloudA_core_bO", f.get("cloudA_core_bO"), lambda x: f"{x:.2f}")
    put("cloudA_bH_bO", (f["cloudA_core_bH"] / f["cloudA_core_bO"]) if f.get("cloudA_core_bO") else None,
        lambda x: f"{x:.2f}")
    put("b3_ovi_depth", f.get("b3_ovi_depth"), lambda x: f"{100 * x:.1f}")
    put("b4_first_depth", f.get("b4_first_depth"), lambda x: f"{100 * x:.1f}")
    put("b4_end_depth", f.get("b4_end_depth"), lambda x: f"{100 * x:.0f}")
    put("b5_ovi_depth", f.get("b5_ovi_depth"), lambda x: f"{100 * x:.0f}")
    put("b5_ovi_V", f.get("b5_ovi_V"), lambda x: f"{x:+.0f}")
    put("ovi_T_hot_fade", f.get("ovi_T_hot_fade"), lambda x: fmt_pow(x, 1))
    put("ovi_T_cool_fade", f.get("ovi_T_cool_fade"), lambda x: fmt_pow(x, 1))
    put("v_gal", f.get("v_gal"), lambda x: f"{x:+.1f}")
    fb = f.get("frac_before_l0") or {}
    put("ovi_frac_half", fb.get("OVI"), lambda x: f"{100 * x:.1f}")
    put("hi_frac_half", fb.get("HI"), lambda x: f"{100 * x:.1f}")
    put("b5_ovi_drop", f.get("b5_ovi_drop"), lambda x: f"{100 * x:.0f}")
    put("b5_ovi_depth_after", f.get("b5_ovi_depth_after"), lambda x: f"{100 * x:.0f}")
    for nm in ("b8_new_dips", "b9_new_dips", "ovi_minima", "hi_minima", "b9_new_minima", "b9_deepened_minima"):
        v = f.get(nm) or []
        k[nm] = ", ".join(f"{x[0]:+.0f}" for x in v) if v else NA
    for nm in ("ovi_minima_saturated", "hi_minima_saturated"):
        v = f.get(nm) or []
        k[nm] = ", ".join(f"{x[1]:+.0f} to {x[2]:+.0f}" for x in v) if v else NA
    put("b3_depth_before_first", f.get("b3_depth_before_first"), lambda x: f"{100 * x:.1f}")
    # keys requested by copy.json keys_contract (signed values with a unicode minus, as the contract asks)
    ck = f.get("cold_knot") or {}
    put("b7e_hi_v", ck.get("HI_V"), signed)
    put("b7e_ovi_v", ck.get("OVI_V") or None, lambda v: " and ".join(signed(x) for x in v))
    feat = (d.get("select") or {}).get("S10_feature") or {}
    put("s10_feature_v", feat.get("V_kms"), signed)
    put("pix_per_resel", ((d.get("worked") or {}).get("S10") or {}).get("pix_per_resel"), lambda x: f"{x:g}")
    s5 = (d.get("select") or {}).get("S5_cell")
    lN = d["ions"]["OVI"]["cells"]["logN"] if "ions" in d else []
    Ntot = sum(10 ** x for x in lN if x is not None)
    put("c263_ovi_share", (10 ** lN[s5] / Ntot) if s5 is not None and lN[s5] is not None and Ntot > 0 else None,
        lambda x: f"{100 * x:.1f}")
    return k


def signed(x) -> str:
    """'+35' / '−55' (unicode minus), whole km/s"""
    s = f"{float(x):+.0f}"
    return s.replace("-", "−") if s != "-0" else "0"


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
    paths["library"] = story_library(gid, ray, work, paths)   # one-ray Trident library from stage_cells, if any
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
        ew_rel_full = abs(rest_ew_mA(tfull, du, atom["lam0_A"]) / ew_st - 1)
        ew_lim = EW_RTOL if ref else max(EW_RTOL, ROUND_SLACK * ew_rel_full)
        logN_tot = float(np.log10(np.sum(N)))
        chk = {"max_abs_dF_cellsum_vs_stored": dF, "max_abs_dF_fullprecision": dF_full, "dF_limit": lim,
               "EW_mA_stored": ew_st,
               "EW_mA_cellsum": ew_cs, "EW_rel": abs(ew_cs / ew_st - 1), "EW_rel_fullprecision": ew_rel_full,
               "EW_limit": ew_lim, "logN_cells": logN_tot,
               "logN_library": float(p["logN"][key]), "dlogN": abs(logN_tot - float(p["logN"][key])),
               "regen_max_abs_dtau": meta["regen_max_abs_dtau"].get(key)}
        if key == "HI":
            xr = raw[ff] * nH
            m = xr > 0
            chk["nHI_over_xHI_nH_minus1"] = float(np.max(np.abs(nion[m] / xr[m] - 1))) if m.any() else 0.0
        checks[key] = chk
        if dF > lim or dF_full > DF_CEIL[key] or chk["EW_rel"] > ew_lim or ew_rel_full > EW_CEIL or chk["dlogN"] > 1e-6:
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
    geometry, clouds, names, tube, facts2, _geo = story_v2(gid, ray, raw, gal, geom, paths, out, cells, ions, Vr,
                                                          l_mid, pair, work)
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
            "worked": worked,
            "geometry": geometry, "clouds": clouds, "cloud_names": names, "tube": tube, "facts2": facts2}
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
BRANCHED_FAILS = ("no S6 pair", "no sane invented-cloud fit")   # copy.json has_pair / has_invented branches
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
    # informational only (the verdict above stays the published rule): v2's copy.json branches the S6 thread (has_pair)
    # and the invented example (has_invented), so those two fails need not block a v2-only story
    f2 = [x for x in fails if x not in BRANCHED_FAILS]
    return k, {"eligible": not fails, "fails": fails, "rule": ELIGIBILITY_RULE, "eligible_v2": not f2, "fails_v2": f2}


MINIMA_MATCH_KMS = 10.0   # a minimum at the end of a beat "was there before" if one sat within this many km/s at its start
MINIMA_NEW_DEPTH = 0.15   # ... and was at least this deep; shallower forerunners (e.g. +91 at 11 %) count as new dips
MINIMA_DEEPEN = 0.05      # a pre-existing minimum "deepens" when its depth grows by at least this much over the beat


def partial_tau_fn(d, key):
    """tau(l) on the 1 km/s grid of ion `key`, rebuilt from the shipped story JSON alone (geometry + per-cell N, V, b, a),
    with the same kernel and Voigt code the build uses; tau(+inf) reproduces F_intrinsic (review2 science M1/M3)"""
    g, kc, ic = d["geometry"]["cells"], d["geometry"]["kernel_cdf"], d["ions"][key]
    h, dd = np.asarray(g["h"], float), np.asarray(g["d"], float)
    q = dd / h
    geo = {"q": q, "c": h * np.sqrt(np.clip(1 - q * q, 0, None)), "lc": np.asarray(g["lc"], float)}
    tab = np.asarray(kc["table"], float)
    cells = ic["cells"]
    vg = np.asarray(d.get("vgrid") or np.arange(-400, 401, 1.0), float)
    N = np.array([10 ** x if x is not None else 0.0 for x in cells["logN"]])
    tm = tau_matrix(ic["atom"], N, np.asarray(cells["V"], float), np.asarray(cells["b"], float), np.asarray(cells["a"], float), vg)
    return (lambda s: cell_weights(geo, s, tab) @ tm), vg


def minima_facts(d):
    """review2 science M1/M3: beat claims from spectral MINIMA of the partial spectrum (DESIGN_final H2), not from peaks of
    the optical depth gained. B9: minima at the end of the beat with no minimum (>= MINIMA_NEW_DEPTH deep) within
    MINIMA_MATCH_KMS at its start are new; matched ones that deepen by >= MINIMA_DEEPEN are 'deepened'. B5: the O VI light
    removed over the beat at b5_ovi_V, F(start) - F(end), and the depth there after the beat."""
    f2 = d.get("facts2") or {}
    win = f2.get("beat_windows") or {}
    out = {}
    try:
        tau, vg = partial_tau_fn(d, "OVI")
    except (KeyError, TypeError, ValueError):
        return out
    if "B9" in win:
        l0, l1 = win["B9"]
        F0, F1 = np.exp(-tau(l0)), np.exp(-tau(l1))
        m0 = spectral_minima(F0, vg)[0]
        m1 = spectral_minima(F1, vg)[0]
        new, deep = [], []
        for v, dep in m1:
            near = [x for x in m0 if abs(x[0] - v) <= MINIMA_MATCH_KMS and x[1] >= MINIMA_NEW_DEPTH]
            if not near:
                new.append([v, dep])
            else:
                k = int(round(v - vg[0]))
                if dep - (1 - F0[k]) >= MINIMA_DEEPEN:
                    deep.append([v, dep])
        out.update(b9_minima_start=m0, b9_minima_end=m1, b9_new_minima=new, b9_deepened_minima=deep)
    if "B5" in win and f2.get("b5_ovi_V") is not None:
        l0, l1 = win["B5"]
        k = int(round(float(f2["b5_ovi_V"]) - vg[0]))
        Fa, Fb = float(np.exp(-tau(l0))[k]), float(np.exp(-tau(l1))[k])
        out.update(b5_ovi_drop=Fa - Fb, b5_ovi_depth_after=1 - Fb)
    return out


def finish_story(data, pf=None):
    """template keys (+ the precomputed fits' facts) and the eligibility verdict, in place"""
    data["keys"] = template_keys(data)
    if pf is not None:
        data["keys"].update(pf.get("facts", {}))
    extra, verdict = story_facts(data, pf)
    data["keys"].update(extra)
    if data.get("facts2") is not None:
        data["facts2"]["invented"] = invented_measure(data, pf)
        data["facts2"]["flag_rules"] = FLAG_RULES
        data["facts2"].update(minima_facts(data))
    data["keys"].update(v2_template_keys(data))
    data["flags"] = story_flags(data, pf)
    data["story"] = verdict
    return data


# copy.json flags --------------------------------------------------------------------------------------------------
INVENTED_BETA_MAX = 0.25   # has_invented: the cells claim < 25 % of the narrow component's fitted depth (CREST beta)
FLAG_RULES = {
    "has_first_ovi": f"some cell has O VI tau0 > {FIRST_OVI_TAU0:g}",
    "hi_black": f"an H I cloud's own peak tau > {COOL_PEAK_TAU:g}",
    "has_ovi_skin": f"O VI cells (tau0 > {FIRST_OVI_TAU0:g}) within {SKIN_DL_KPC:g} kpc of the black H I cloud "
                    f"(cloud A when lettered) and |dV| < {SKIN_DV_KMS:g} km/s",
    "has_hot_stretch": f">= {HOT_STRETCH_KPC:g} kpc of consecutive cells, none visible (tau0 > {VISIBLE_TAU0:g}) in O VI "
                       f"or H I, median T > {HOT_STRETCH_T:.0e} K",
    "ovi_strong": "O VI peak tau >= 0.1",
    "has_cold_knot": f"an H I cloud within {KNOT_DL_KPC:g} kpc of an O VI cloud with |dV| > {KNOT_DV_KMS:g} km/s",
    "has_pair": "the v1 S6 pair rule finds a pair",
    "has_invented": "page fits hold the S11c invented component (b < b_O(30000 K)) and CREST says the cells claim "
                    f"< {100 * INVENTED_BETA_MAX:.0f} % of its fitted depth (beta). copy.json's '< 5 % summed "
                    "responsibility' is not met on 488530 by any reading (column share 6.4 %, beta 8.8 %): needs "
                    "U_copy / science sign-off",
    "lite": "false for every exported story (story-lite has no story file)",
    "richest_not_closest": "the O VI cloud with the largest column does not contain l = 0",
    "has_b9_new_dips": "the B9 window gains at least one new O VI spectral minimum (facts2.b9_new_minima non-empty: a minimum "
                       "at the end of B9 with none >= 15 % deep within 10 km/s at its start); gates B9's entry, which quotes "
                       "{{b9_new_minima}} and {{b9_deepened_minima}}",
}


def invented_measure(d, pf):
    """CREST share of the S11c invented component: column share (sum_i N_i phi_ik / N) and beta (claimed / fitted
    tau), computed with build_story_clouds.crest on the page fit's own components and windows."""
    inv = ((pf or {}).get("select") or {}).get("s11c_invented")
    if not inv:
        return None
    try:
        import build_story_clouds as B
    except ImportError:
        sys.path.insert(0, str(REPO / "scripts"))
        import build_story_clouds as B
    case = pf["cases"][inv["fit"]]
    ion = case["ion"]
    c = d["ions"][ion]["cells"]
    N = np.array([10 ** x if x is not None else 0.0 for x in c["logN"]])
    ti = B.cell_tau(np.asarray(c["V"], float), N, np.asarray(c["b"], float), ion)
    reg = [[i, w[0], w[1]] for i, w in enumerate(case.get("windows") or [])]
    phi, beta, _ = B.crest(ti, case["comps"], reg, ion)
    j = inv["comp"]
    return {"fit": inv["fit"], "comp": j, "b": inv["b"], "col_share": round(float((N * phi[:, j]).sum() / N.sum()), 4),
            "beta": round(float(beta[j]), 4)}


def story_flags(d, pf=None) -> dict:
    """copy.json `flags` booleans, from the story file (+ page fits). A missing fact counts false (conservative)."""
    f2 = d.get("facts2") or {}
    ov = d["ions"]["OVI"]
    t0 = [x or 0.0 for x in ov["cells"]["tau0"]]
    inv = f2.get("invented")
    ro = f2.get("richest_ovi")
    return {
        "has_first_ovi": bool(t0) and max(t0) > FIRST_OVI_TAU0,
        "hi_black": bool(f2.get("hi_black_cloud")),
        "has_ovi_skin": bool(f2.get("ovi_skin")),
        "has_hot_stretch": bool(f2.get("hot_stretch")),
        "ovi_strong": ov["totals"]["peak_tau"] >= 0.1,
        "has_cold_knot": bool(f2.get("cold_knot")),
        "has_pair": bool((d.get("select") or {}).get("S6_pair")),
        "has_invented": bool(inv) and inv["beta"] < INVENTED_BETA_MAX,
        "lite": False,
        "richest_not_closest": bool(ro) and not ro["contains_l0"],
        # not yet in copy.json (proposed to U_copy): B9's entry quotes {{b9_new_dips}} unconditionally
        "has_b9_new_dips": bool(f2.get("b9_new_minima")),   # review2 science M1: a new spectral minimum, not a dtau peak
    }


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


# Film contrast beams (U_film's rule, film.json cuts.beams): story-data/2 ships for them, but they are not stories the
# page offers (none passes the eligibility rule; they exist to contrast the hero in the film), so index.json lists
# them under "film_beams", which the picker never reads; the engine loads them by path (DATA_URL).
FILM_BEAMS = {(REF_GALAXY, "rand_b050_a215"): "most_HI", (REF_GALAXY, "rand_b045_a300_s459727623"): "most_OVI",
              (REF_GALAXY, "rand_b143_a150"): "emptiest"}


def write_index(out: Path, entries: list):
    p = out / "index.json"
    old = json.loads(p.read_text()) if p.exists() else {"stories": []}
    by = {(e["galaxy"], e["ray"]): e for e in old.get("stories", [])}
    beams = {(e["galaxy"], e["ray"]): e for e in old.get("film_beams", [])}
    for e in entries:
        k = (e["galaxy"], e["ray"])
        if k in FILM_BEAMS:
            beams[k] = {**e, "role": FILM_BEAMS[k]}
        else:
            by[k] = e
    stories = sorted(by.values(), key=lambda e: (e["galaxy"] != REF_GALAXY, e["galaxy"], e["ray"]))
    data = {"schema": "story-index/1", "default": {"galaxy": REF_GALAXY, "ray": REF_RAY},
            "fion": "fion_OVI_slice.json", "stories": stories}
    if beams:
        data["film_beams"] = sorted(beams.values(), key=lambda e: e["ray"])
    p.write_text(json.dumps(data, indent=1))


# ----------------------------------------------------------------------------------------------- curated ray per host
REF_RHO = 61.9 / 246.35            # hero ray b / R200c (488530 rand_b062_a062)
CURATE_RULE = ("story-curate/1: among the host library's rays whose stored (SBI) spectrum already passes the story's "
               f"peak-tau gates (O VI >= {OVI_TAU_MIN:g}, H I >= {HI_TAU_MIN:g}), prefer orientation 'random' (the hero "
               f"ray's), then b/R200c closest to the hero's ({REF_RHO:.3f}), then ray id. Candidates are built in that "
               "order (Trident re-cast of the same geometry) until one passes the full eligibility rule.")


def curate_candidates(gid, n=8) -> list:
    """Ranked candidate rays for one host (CURATE_RULE), from the stored library spectra alone (no catalog needed)."""
    paths = galaxy_paths(gid)
    gal = json.loads(paths["galaxy_json"].read_text())
    R = float(gal["R200c_kpc"])
    rows = []
    for f in sorted((Path(paths["library"]) / "sightlines").glob("*.npz")):
        with np.load(f, allow_pickle=False) as z:
            g = json.loads(str(z["geom"]))
            po, ph = float(np.max(z["OVI_tau"])), float(np.max(z["HI_tau"]))
        rho = float(g["b_kpc"]) / R
        rows.append({"ray": f.stem, "orientation": g.get("orientation"), "b_kpc": float(g["b_kpc"]), "rho": round(rho, 4),
                     "peak_tau_sbi": {"OVI": round(po, 3), "HI": round(ph, 3)},
                     "passes": po >= OVI_TAU_MIN and ph >= HI_TAU_MIN})
    rows.sort(key=lambda r: (not r["passes"], r["orientation"] != "random", abs(r["rho"] - REF_RHO), r["ray"]))
    return [r for r in rows if r["passes"]][:n]


# ----------------------------------------------------------------------------------------------- per-galaxy copy check
COPY_SKIP = {"schema", "meta", "beats_order", "flags", "derive", "keys_contract", "live"}
TEMPLATE = re.compile(r"\{\{\s*(\$?[A-Za-z0-9_.]+)\s*\}\}")


def _visible_strings(x, flags, path=""):
    """(path, text) of every string the reader can see given the flags: a dict with `when` shows itself when the flag
    is true, else its `else` block (null: nothing); `when_live` (runtime) shows every state."""
    if isinstance(x, dict):
        if "when" in x and isinstance(x["when"], str):
            if not flags.get(x["when"], False):
                if x.get("else") is not None:
                    yield from _visible_strings(x["else"], flags, path + "/else")
                return
        for k, v in x.items():
            if k in ("when", "else", "when_live"):
                continue
            yield from _visible_strings(v, flags, f"{path}/{k}")
    elif isinstance(x, list):
        for i, v in enumerate(x):
            yield from _visible_strings(v, flags, f"{path}[{i}]")
    elif isinstance(x, str):
        yield path, x


def _lookup(name, d):
    """copy.json template lookup: flat key, then dotted path into keys, then dotted path into the story root"""
    k = d.get("keys") or {}
    if name in k:
        return k[name]
    for root in (k, d):
        cur = root
        for part in name.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                cur = None
                break
        if cur is not None:
            return cur
    return None


def check_story(d, pf, copy_doc) -> list:
    """Problems of one exported story against copy.json and the per-galaxy rules (R_content section 10): '-' (NA) or
    an unresolved key in any visible text; shipped keys / flags / verdict differing from a recomputation on the file
    itself (a contradicted claim); flags inconsistent with the numbers they summarise."""
    import copy as _copy
    probs = []
    flags = d.get("flags") or {}
    derive = {k: v for k, v in (copy_doc.get("derive") or {}).items() if isinstance(v, dict)}
    for sec, body in copy_doc.items():
        if sec in COPY_SKIP:
            continue
        for path, text in _visible_strings(body, flags, sec):
            for name in TEMPLATE.findall(text):
                if name.startswith("$"):
                    continue
                for s_ in (derive[name]["from"] if name in derive else [name]):
                    v = _lookup(s_, d)
                    if v is None:
                        probs.append(f"{path}: {{{{{name}}}}} unresolved ({s_})")
                    elif isinstance(v, str) and NA in v:
                        probs.append(f"{path}: {{{{{name}}}}} shows '{NA}' ({s_})")
    re_ = finish_story(_copy.deepcopy(d), pf)
    for k, v in re_["keys"].items():
        if (d.get("keys") or {}).get(k) != v:
            probs.append(f"key {k}: shipped {(d.get('keys') or {}).get(k)!r} != recomputed {v!r}")
    if re_["flags"] != flags:
        probs.append(f"flags differ from recomputation: {flags} vs {re_['flags']}")
    if (d.get("story") or {}).get("eligible") != re_["story"]["eligible"]:
        probs.append("eligibility verdict differs from recomputation")
    hi, ov = d["ions"]["HI"]["totals"], d["ions"]["OVI"]["totals"]
    if flags.get("hi_black") and not hi["peak_tau"] > COOL_PEAK_TAU:
        probs.append("hi_black but H I peak tau <= 1")
    if flags.get("ovi_strong") != (ov["peak_tau"] >= 0.1):
        probs.append("ovi_strong disagrees with O VI peak tau")
    summ = ((d.get("clouds") or {}).get("summary") or {}).get("OVI", {}).get("clouds") or []
    if summ and "richest_not_closest" in flags:
        top = max(summ, key=lambda c: c["logN"])
        if flags["richest_not_closest"] != (not (top["l"][0] <= 0 <= top["l"][1])):
            probs.append("richest_not_closest disagrees with the cloud summary")
    return probs


def check_dir(out: Path, copy_path: Path = ROOT / "copy.json") -> dict:
    """check_story for every story_*.json under `out` (recursive, rejected tries skipped) -> {stem: {eligible, problems}}"""
    copy_doc = json.loads(copy_path.read_text(encoding="utf-8"))
    res = {}
    for p in sorted(set(Path(out).rglob("story_*.json")) | set(Path(out).glob("*/story_*.json"))):
        if "_rejected" in p.parts:
            continue
        d = json.loads(p.read_text(encoding="utf-8"))
        pfp = p.with_name(p.name.replace("story_", "page_fits_", 1))
        pf = json.loads(pfp.read_text()) if pfp.exists() else None
        res[p.stem] = {"eligible": bool((d.get("story") or {}).get("eligible")), "problems": check_story(d, pf, copy_doc)}
    return res


def write_manifest(stage: Path) -> Path:
    """MANIFEST.json for a staging tree (<stage>/<gid>/...): chosen ray, eligibility, copy check, files, rejected tries."""
    stage = Path(stage)
    copy_doc = json.loads((ROOT / "copy.json").read_text(encoding="utf-8"))
    gals = {}
    for gdir in sorted(q for q in stage.iterdir() if q.is_dir() and q.name.isdigit()):
        files = sorted(str(f.relative_to(stage)) for f in gdir.rglob("*") if f.is_file() and "_rejected" not in f.parts)
        size = sum((stage / f).stat().st_size for f in files)
        rej = []
        for q in sorted((gdir / "_rejected").glob("story_*.json")) if (gdir / "_rejected").exists() else []:
            v = json.loads(q.read_text())["story"]
            rej.append({"file": q.name, "fails": v["fails"], "eligible_v2": v.get("eligible_v2"), "fails_v2": v.get("fails_v2")})
        cand = gdir / "candidates.json"
        ent = {"files": files, "bytes": size, "rejected": rej,
               "candidates": json.loads(cand.read_text()) if cand.exists() else None, "stories": []}
        for p in sorted(gdir.glob("story_*.json")):
            d = json.loads(p.read_text())
            pfp = p.with_name(p.name.replace("story_", "page_fits_", 1))
            probs = check_story(d, json.loads(pfp.read_text()) if pfp.exists() else None, copy_doc)
            ent["stories"].append({"ray": d["meta"]["ray"], "eligible": d["story"]["eligible"], "fails": d["story"]["fails"],
                                   "eligible_v2": d["story"].get("eligible_v2"), "fails_v2": d["story"].get("fails_v2"),
                                   "flags": d.get("flags"), "copy_problems": probs})
        gals[gdir.name] = ent
    ok = [g for g, e in gals.items() if any(s["eligible"] and s["copy_problems"] == [] for s in e["stories"])]
    # informational: hosts ready once copy.json gates B9's entry on has_b9_new_dips (proposed to U_copy)
    import copy as _copy
    cd = json.loads((ROOT / "copy.json").read_text(encoding="utf-8"))
    if "when" not in cd.get("B9", {}):
        cd = _copy.deepcopy(cd); cd["B9"]["when"] = "has_b9_new_dips"; cd["B9"].setdefault("else", None)
    b9 = []
    for g in gals:
        for p in sorted((stage / g).glob("story_*.json")):
            d = json.loads(p.read_text())
            pfp = p.with_name(p.name.replace("story_", "page_fits_", 1))
            if d["story"]["eligible"] and not check_story(d, json.loads(pfp.read_text()) if pfp.exists() else None, cd):
                b9.append(g)
                break
    man = {"schema": "story-stage/1", "rule": CURATE_RULE, "eligibility": ELIGIBILITY_RULE,
           "n_galaxies": len(gals), "n_ready": len(ok), "ready": ok, "not_ready": sorted(set(gals) - set(ok)),
           "ready_with_b9_branch": sorted(set(b9) | set(ok)),
           "v2_rule_would_add": sorted(g for g, e in gals.items() if g not in ok and any(r.get("eligible_v2")
                                                                                       for r in e["rejected"])),
           "galaxies": gals,
           "upload": "owner only: copy <gid>/{story_*,page_fits_*}.json, clouds/, tube/ into ROOT/data and merge index.json"}
    p = stage / "MANIFEST.json"
    p.write_text(json.dumps(man, indent=1))
    return p


# ----------------------------------------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["cells", "cuts", "build", "fion", "all", "patch", "select", "check",
                                       "manifest"])
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
    if a.stage == "select":                                  # ranked candidate rays per host (CURATE_RULE)
        for gid in a.galaxy:
            cands = curate_candidates(gid, int(os.environ.get("STORY_CANDIDATES", "8")))
            if a.work:
                a.work.mkdir(parents=True, exist_ok=True)
                (a.work / f"candidates_{gid}.json").write_text(json.dumps({"rule": CURATE_RULE, "candidates": cands},
                                                                         indent=1))
            print(" ".join(c["ray"] for c in cands))
        return
    if a.stage == "check":                                   # copy.json + per-galaxy rules on every story in --out
        res = check_dir(a.out)
        bad = {k: v for k, v in res.items() if v["eligible"] and v["problems"]}
        for k, v in res.items():
            print(f"{k}: eligible={v['eligible']} problems={len(v['problems'])}")
            for q in v["problems"][:12]:
                print("   ", q)
        raise SystemExit(1 if bad else 0)
    if a.stage == "manifest":
        print(write_manifest(a.out))
        return
    work = a.work or work_root() / "scratch" / "story_data"
    entries = []
    for gid in a.galaxy:
        paths = galaxy_paths(gid, a.library, a.cutout, a.galaxy_json)
        if a.stage in ("cells", "all"):
            stage_cells(gid, a.ray, work, paths)
        if a.stage in ("cuts", "all"):
            stage_cuts(gid, a.ray, work, paths)
        if a.stage in ("build", "all"):
            entries.append(build_one(gid, a.ray, work, a.out, paths))
    if entries:
        write_index(a.out, entries)
    if a.stage in ("build", "fion", "all"):
        build_fion(a.out)


if __name__ == "__main__":
    main()
