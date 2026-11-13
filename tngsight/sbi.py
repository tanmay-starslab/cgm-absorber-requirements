"""Reader/adapter for the SBI_CGM fiducial ray library (galaxy-sample spec, REVISION 2026-11-12).

The SBI_CGM project (read-only here) holds 53,248 GPU spectra per host for all 198 TNG50 MW/M31 hosts:
    <run>/50_rays/<id>/native/geometry.hdf5           per-ray geometry (Sobol; rho <= 1.5 R200c; +-2 R200c long)
    <run>/50_rays/<id>/native/csr_<a>_<b>.hdf5         per-ray cell lists (CLOUDY FG11 ion densities, dl, v_los)
    <run>/50_rays/<id>/gpu/tau_<a>_<b>.hdf5            13 chunks x 4096 rays; per feature tau (4096, 6000) fp64 on
                                                       velocity_log_kms = c ln(lambda/lambda0), -1499.75..1499.75
                                                       step 0.5 km/s, plus lambda_A
The run directories are found under $TNG_SBI_RAYS (os.pathsep-separated list of `50_rays` directories), else every
`<work root>/data/sbi_rays/*` (symlinks to the runs' 50_rays directories). Nothing is ever written there.

Conventions verified on the data (sbi_adapter report; `verify_frame` re-checks every imported galaxy):
- tau is rendered in the galaxy rest frame ("render_velocity_frame_json": kind galaxy_rest_peculiar): a cell of
  velocity v appears at velocity_log = -(v - V_bulk).d, d = unit(end - start) = the source-to-observer direction,
  V_bulk = bulk_velocity_original_xyz_kms (SubhaloVel of the SBI subhalo info). The CSR v_los = v.d is NOT
  host-subtracted. positive v.d blueshifts (relativistic longitudinal Doppler; O(v^2/c) from ours).
- Our npz frame: u = c(lambda/lambda0 - 1) with V = u + VSYS_SIGN v_sys; a cell appears at u = -v.n_los. With
  n_los = d the SBI tau needs no velocity shift; v_sys = (SubhaloVel_ours - V_bulk).d puts our galaxy at V = 0
  (|v_sys| is the difference of the two SubhaloVel estimates, ~0 when they agree).
- The tau grid is resampled from log-lambda (SBI) to our linear-lambda grid by velocity (gas kinematics kept; the
  rest wavelength is ours), at du = DU_SBI = 0.5 km/s over +-W = 1500 km/s (6001 samples, linear interpolation).
- logN of a line = the ray column sum(n_ion dl) from the CSR cell lists (the same definition as our Trident
  library); AOD of the stored tau reproduces it (H I: damped wings beyond +-1500 km/s are truncated).
"""
from __future__ import annotations

import glob
import hashlib
import json
import math
import os
import re
from pathlib import Path

import numpy as np

from . import ions as I
from .config import C_KMS, VSYS_SIGN

# our registry key -> SBI feature id (the 12 explorer lines; all present in the 39-feature SBI bank)
LINE_MAP = {"HI": "HI_lya", "MgII": "MgII_2796", "SiII": "SiII_1260", "CII": "CII_1334", "SiIII": "SiIII_1206",
            "CIII": "CIII_977", "SiIV": "SiIV_1402", "CIV": "CIV_1548", "NV": "NV_1238", "OVI": "OVI_1032",
            "NeVIII": "NeVIII_770", "OVII": "OVII_21"}
DU_SBI = 0.5                      # km/s, the SBI native velocity step (our npz grid for imported rays)
W_SBI = 1500.0                    # km/s half window of the SBI spectra
KPC_CM = 3.0856775814913673e21

# ------------------------------------------------------------------ web subset selection rule (recorded per galaxy)
SELECT_RULE = "sbi-stratified/1"
SELECT_SEED = 20261112
N_TARGET = 700
RHO_EDGES = (0.0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.25, 1.5)   # b / R200c (our centre and R200c)
INC_EDGES = (0.0, 20.0, 70.0, 90.0)                                  # deg from our Lhat (folded)
INC_WORDS = ("face-on", "random", "edge-on")                         # catalogue orientation word per band
ORIENT_PREFIX = {"face-on": "face", "edge-on": "edge", "random": "rand"}

PROVENANCE_TEXT = (
    "Spectra from the SBI_CGM fiducial ray library (53,248 sightlines per galaxy; this page shows a stratified "
    "subset of about 700, equal numbers per b/R200c x inclination stratum, so raw counts are not covering fractions; "
    "each catalogue entry carries w_target, its weight to an area-uniform, isotropic sample within 1.5 R200c). "
    "Ionisation: CLOUDY FG11 tables (THOR) with Rahmati self-shielding instead of Trident HM2012; GPU Voigt optical "
    "depths (fp64) at 0.5 km/s over +-1500 km/s (H I damped wings beyond the window truncated; gas moving faster "
    "than 1500 km/s along the sightline falls outside the spectrum, flagged per ray); sightlines are Sobol-sampled, "
    "+-2 R200c long (half_kpc), impact parameter <= 1.5 R200c. Column densities are the ray columns of those tables; "
    "components are fitted with the SBI atomic data (f, Gamma). The SBI recipe labels the population 'engineering "
    "scope'. The disk frame, b and azimuth are ours; orientation words are inclination bands (face-on < 20 deg, "
    "edge-on >= 70 deg, random between). The 3D ion cubes are not from these tables: they use Trident HM2012 "
    "(H I from the TNG neutral fraction) within r <= 400 kpc, so a sightline drawn through a cube can differ from "
    "its spectrum by up to a few tenths of a dex (H I, Mg II, N V, C IV), and rays beyond 400 kpc pass outside it.")
PROVENANCE_LABEL = "SBI_CGM fiducial pass (CLOUDY FG11)"
PROVENANCE_SHORT = "SBI_CGM, CLOUDY FG11"


def _work_root() -> Path:
    from . import config
    return config.work_root()


def ray_roots() -> list[Path]:
    v = os.environ.get("TNG_SBI_RAYS")
    if v:
        return [Path(p).expanduser() for p in v.split(os.pathsep) if p]
    return [Path(p) for p in sorted(glob.glob(str(_work_root() / "data" / "sbi_rays" / "*")))]


def galaxy_dir(gid, roots=None) -> Path:
    """The SBI `50_rays/<id>` directory of a galaxy (exactly one run must hold a complete copy)."""
    hits = []
    for r in (roots if roots is not None else ray_roots()):
        d = Path(r) / str(int(gid))
        if (d / "native" / "geometry.hdf5").is_file() and list((d / "gpu").glob("tau_*.hdf5")):
            hits.append(d)
    if not hits:
        raise FileNotFoundError(f"galaxy {gid}: no SBI ray directory under {[str(r) for r in (roots or ray_roots())]}"
                                " (set TNG_SBI_RAYS)")
    if len(hits) > 1:
        raise RuntimeError(f"galaxy {gid}: SBI rays found in several runs: {[str(h) for h in hits]}")
    return hits[0]


def run_name(gdir: Path) -> str:
    """The SBI run id of a galaxy directory (`<run>/50_rays/<id>`; symlinks resolved)."""
    r = Path(gdir).resolve()
    return r.parent.parent.name if r.parent.name == "50_rays" else r.parent.name


_CHUNK_RE = re.compile(r"_(\d+)_(\d+)\.hdf5$")


def chunk_files(gdir: Path, kind: str) -> list[tuple[int, int, Path]]:
    """[(lo, hi, path)] of the tau ('gpu/tau') or csr ('native/csr') chunk files, ordered and contiguous."""
    sub, stem = {"tau": ("gpu", "tau"), "csr": ("native", "csr")}[kind]
    out = []
    for p in sorted(Path(gdir, sub).glob(f"{stem}_*.hdf5")):
        m = _CHUNK_RE.search(p.name)
        if m:
            out.append((int(m.group(1)), int(m.group(2)), p))
    out.sort()
    for (a0, a1, _), (b0, _b1, _p) in zip(out, out[1:]):
        if a1 != b0:
            raise RuntimeError(f"{gdir}: {kind} chunks not contiguous at {a1} / {b0}")
    if not out or out[0][0] != 0:
        raise RuntimeError(f"{gdir}: no {kind} chunks from row 0")
    return out


# ------------------------------------------------------------------ geometry
def read_geometry(gdir: Path) -> dict:
    import h5py
    with h5py.File(Path(gdir) / "native" / "geometry.hdf5", "r") as h:
        meta = json.loads(h.attrs["sampler_metadata_json"])
        out = {k: h[k][...] for k in ("ray_id", "point_index", "scramble_index", "start_pkpc", "end_pkpc",
                                      "direction", "closest_point_pkpc", "inclination_folded_rad",
                                      "alpha_folded_rad")}
        out["rho"] = h["proposal_coordinates"][:, 0]
    out["meta"] = meta
    out["n"] = int(out["ray_id"].size)
    return out


def _unit(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.where(n > 0, n, 1)


def box_kpc(rec) -> float:
    return float(rec.get("box_ckpch", 35000.0)) / float(rec["TNG_H"])


def our_geometry(geo: dict, rec: dict) -> dict:
    """Per-ray geometry in our galaxy frame (vectorised): endpoints relative to our centre (periodic-wrapped),
    b (kpc, closest approach of the infinite line to our centre), azimuth (deg; 0 = projected major axis,
    90 = projected minor axis, geometry.sky_axes convention), inclination (deg, folded, 0 = face-on), word."""
    c = np.asarray(rec["center_kpc"], float)
    L = box_kpc(rec)
    lh, xh = _unit(rec["Lhat"]), _unit(rec["xhat"])
    s = geo["start_pkpc"] - c
    s -= L * np.round(s / L)                     # minimum image about our centre
    d = _unit(geo["direction"])
    e = s + (geo["end_pkpc"] - geo["start_pkpc"])
    t = -np.einsum("ij,ij->i", s, d)
    anchor = s + t[:, None] * d
    b = np.linalg.norm(anchor, axis=1)
    cosi = np.einsum("ij,j->i", d, lh)
    inc = np.degrees(np.arccos(np.clip(np.abs(cosi), 0, 1)))
    # sky axes per ray (geometry.sky_axes): e_minor = unit(L - (L.n)n); face-on degenerate -> from xhat
    em = lh[None, :] - cosi[:, None] * d
    deg = np.linalg.norm(em, axis=1) < 1e-6
    em = _unit(em)
    ej = _unit(np.cross(d, em))
    if deg.any():
        xa = _unit(xh[None, :] - np.einsum("ij,j->i", d[deg], xh)[:, None] * d[deg])
        ej[deg] = xa
        em[deg] = _unit(np.cross(d[deg], xa))
    az = np.degrees(np.arctan2(np.einsum("ij,ij->i", anchor, em), np.einsum("ij,ij->i", anchor, ej))) % 360.0
    word = np.array(INC_WORDS)[np.clip(np.searchsorted(INC_EDGES, inc, side="right") - 1, 0, len(INC_WORDS) - 1)]
    return {"start_rel": s, "end_rel": e, "anchor_rel": anchor, "n_los": d, "b_kpc": b, "azimuth_deg": az,
            "inclination_deg": inc, "orientation": word, "half_kpc": 0.5 * np.linalg.norm(e - s, axis=1)}


def ray_sid(orientation, b_kpc, az_deg, ray_id) -> str:
    """`<face|edge|rand>_bBBB_aAAA_s<ray_id>`: the library id grammar (the chat/select regex), unique by the SBI
    ray id. The `_s` number is the SBI ray id, NOT a Trident seed (catalogue seed is null for these rays)."""
    az = int(round(float(az_deg))) % 360
    return f"{ORIENT_PREFIX[str(orientation)]}_b{int(round(float(b_kpc))):03d}_a{az:03d}_s{int(ray_id)}"


# ------------------------------------------------------------------ selection
def _priority(seed, gid, ray_ids) -> np.ndarray:
    """Version-independent pseudo-random order: blake2b(seed:gid:ray_id) as uint64."""
    out = np.empty(len(ray_ids), np.uint64)
    for i, r in enumerate(ray_ids):
        h = hashlib.blake2b(f"{seed}:{int(gid)}:{int(r)}".encode(), digest_size=8).digest()
        out[i] = int.from_bytes(h, "little")
    return out


def allocate(counts, n_target) -> np.ndarray:
    """Equal allocation over strata, capped by stratum size; capped strata's leftover goes equally to the strata
    that still have rays; the final remainder (< number of open strata) goes one each to the open strata with the
    fewest taken, ties by stratum index. Sum = min(n_target, sum(counts))."""
    counts = np.asarray(counts, int)
    take = np.zeros_like(counts)
    total = int(min(int(n_target), int(counts.sum())))
    while int(take.sum()) < total:
        open_ = np.flatnonzero(take < counts)
        left = total - int(take.sum())
        q = left // len(open_)
        if q == 0:
            for i in sorted(open_.tolist(), key=lambda j: (int(take[j]), j))[:left]:
                take[i] += 1
            break
        take[open_] = np.minimum(take[open_] + q, counts[open_])
    return take


def select(ours: dict, rec: dict, ray_ids, gid, n_target=N_TARGET, seed=SELECT_SEED) -> tuple[np.ndarray, dict]:
    """Stratified, reproducible web subset: strata = RHO_EDGES (b/R200c) x INC_EDGES (our frame); equal
    allocation per stratum (allocate); inside a stratum the rays with the lowest blake2b(seed:gid:ray_id)
    priority. Returns (sorted row indices, rule dict with the per-stratum counts)."""
    rho = ours["b_kpc"] / float(rec["R200c_kpc"])
    inc = ours["inclination_deg"]
    ri = np.searchsorted(RHO_EDGES, rho, side="right") - 1
    ii = np.clip(np.searchsorted(INC_EDGES, inc, side="right") - 1, 0, len(INC_EDGES) - 2)
    valid = (ri >= 0) & (ri < len(RHO_EDGES) - 1)
    ns = (len(RHO_EDGES) - 1) * (len(INC_EDGES) - 1)
    sidx = np.where(valid, ri * (len(INC_EDGES) - 1) + ii, -1)
    counts = np.bincount(sidx[valid], minlength=ns)
    take = allocate(counts, n_target)
    pr = _priority(seed, gid, ray_ids)
    chosen = []
    for s in range(ns):
        rows = np.flatnonzero(sidx == s)
        if take[s]:
            order = rows[np.lexsort((np.asarray(ray_ids)[rows], pr[rows]))]
            chosen.append(order[: take[s]])
    sel = np.sort(np.concatenate(chosen)) if chosen else np.zeros(0, int)
    rule = {"rule": SELECT_RULE, "seed": int(seed), "n_target": int(n_target), "n_selected": int(sel.size),
            "n_pool": int(len(ray_ids)), "n_outside": int((~valid).sum()),
            "rho_edges_R200c": list(RHO_EDGES), "inclination_edges_deg": list(INC_EDGES),
            "inclination_words": list(INC_WORDS),
            "description": "strata = b/R200c bins x inclination bands in our disk frame (b from our centre, "
                           "R200c from galaxy.json); equal allocation per stratum (capped by the stratum size, "
                           "leftovers redistributed equally; remainder to the least-filled strata); inside a stratum the rays with the smallest "
                           "blake2b-64(f'{seed}:{galaxy}:{ray_id}') (ties by ray_id)",
            "strata": [{"rho": [RHO_EDGES[s // (len(INC_EDGES) - 1)], RHO_EDGES[s // (len(INC_EDGES) - 1) + 1]],
                        "inc": [INC_EDGES[s % (len(INC_EDGES) - 1)], INC_EDGES[s % (len(INC_EDGES) - 1) + 1]],
                        "pool": int(counts[s]), "taken": int(take[s])} for s in range(ns)]}
    return sel, rule


# ------------------------------------------------------------------ spectra
def _components(feature: dict) -> list:
    """[(lambda_A, f)] of the profile components the SBI tau was rendered with (feature_json profile_components;
    a string-encoded list is parsed); [] when absent."""
    import ast
    pc = feature.get("profile_components")
    if isinstance(pc, str):
        try:
            pc = ast.literal_eval(pc)
        except (ValueError, SyntaxError):
            return []
    out = []
    for c in pc or []:
        lam, f = c.get("wavelength_A"), c.get("oscillator_strength")
        if lam is not None and f is not None:
            out.append((float(lam), float(f)))
    return out


def line_offset_kms(feature: dict) -> float:
    """Where the rendered line sits on the SBI grid: the f*lambda-weighted mean of c ln(lambda_i / lambda0_grid) over
    the profile components (the grid is centred on the legacy Trident lambda0; Ne VIII +7.35, O VII +20.8 km/s,
    the rest within 1 km/s). Subtracted on import so gas at rest sits at u = 0 as in our library."""
    comps = _components(feature)
    lam0 = feature.get("lambda0_A")
    if not comps or not lam0:
        return 0.0
    w = np.array([lam * f for lam, f in comps])
    v = np.array([C_KMS * math.log(lam / float(lam0)) for lam, _ in comps])
    return float(np.sum(w * v) / np.sum(w))


def f_lambda_ratio(feature: dict, key) -> float | None:
    """sum(f_i lambda_i) of the SBI components / (f lambda0) of our registry: the factor by which an AOD column of
    the SBI tau computed with our registry f differs from the true column (Mg II 2796: 0.965 = -0.016 dex)."""
    comps = _components(feature)
    if not comps:
        return None
    r = I.get(key)
    return float(sum(lam * f for lam, f in comps) / (float(r["f"]) * float(r["lam0_A"])))


def _component_rates(feature: dict) -> list:
    """[(lambda_A, f, Gamma_s)] of the rendered profile components (Gamma = upper + lower level rates of the
    component's `gamma` block, else a plain rate field; None when absent)."""
    import ast
    pc = feature.get("profile_components")
    if isinstance(pc, str):
        try:
            pc = ast.literal_eval(pc)
        except (ValueError, SyntaxError):
            return []
    out = []
    for c in pc or []:
        lam, f = c.get("wavelength_A"), c.get("oscillator_strength")
        if lam is None or f is None:
            continue
        gm, rate = c.get("gamma"), None
        if isinstance(gm, dict) and gm.get("upper_rate_s_1") is not None:
            rate = float(gm["upper_rate_s_1"]) + float(gm.get("lower_rate_s_1") or 0.0)
        elif isinstance(gm, (int, float)):
            rate = float(gm)
        else:
            for k in ("gamma_s_1", "rate_s_1", "damping_s_1"):
                if c.get(k) is not None:
                    rate = float(c[k])
                    break
        out.append((float(lam), float(f), rate))
    return out


def fit_atomic(features: dict) -> dict:
    """{key: {"lam0", "f", "gamma"}}: the single-line atomic data that reproduce the SBI-rendered tau on our grid,
    for vpfit on imported spectra (review2_physics P1). lam0 stays our registry rest wavelength (the import puts
    the f*lambda-weighted line centre at u = 0); f = sum(f_i lambda_i) / lam0 keeps the integrated strength (so AOD
    and fitted columns carry no f*lambda bias: Mg II -0.016, Si IV +0.013, O VII +0.011 dex before); gamma = the
    f_i lambda_i-weighted mean component Gamma (H I Lya 6.2649e8 s^-1 vs Trident's 4.69e8, which biased damped H I
    fits +0.126 dex; C II 2.902e8 vs 2.41e8). Lines whose feature has no components keep the registry values."""
    out = {}
    for k, feat in (features or {}).items():
        reg = I.get(k)
        comps = _component_rates(feat)
        if not comps:
            continue
        lam0 = float(reg["lam0_A"])
        w = np.array([lam * f for lam, f, _ in comps])
        f_eq = float(w.sum() / lam0)
        rates = [(wi, g) for wi, (_l, _f, g) in zip(w, comps) if g is not None]
        gamma = (float(sum(wi * g for wi, g in rates) / sum(wi for wi, _ in rates)) if rates
                 else float(reg["gamma_s"]))
        out[k] = {"lam0": lam0, "f": float(f"{f_eq:.9g}"), "gamma": float(f"{gamma:.6g}")}
    return out


def read_features(gdir: Path, keys=None) -> dict:
    """{key: feature_json} of the first tau chunk (attributes only; every chunk carries the same features)."""
    import h5py
    keys = list(keys or LINE_MAP)
    _lo, _hi, p = chunk_files(gdir, "tau")[0]
    with h5py.File(p, "r") as h:
        return {k: json.loads(h[LINE_MAP[k]].attrs["feature_json"]) for k in keys}


def vlos_range(gdir: Path, rows) -> dict:
    """{row: (min, max)} of the CSR cell v_los = v.d (km/s, NOT host-subtracted) over the cells of each selected ray
    (global rows); reads only cell_offsets and velocity_los_kms. (nan, nan) for a ray without cells."""
    import h5py
    rows = np.sort(np.asarray(rows, int))
    out = {}
    for lo, hi, p in chunk_files(gdir, "csr"):
        sel = rows[(rows >= lo) & (rows < hi)]
        if not sel.size:
            continue
        local = sel - lo
        with h5py.File(p, "r") as h:
            off = h["cell_offsets"][...]
            lo_c, hi_c = int(off[local.min()]), int(off[local.max() + 1])
            vl = h["velocity_los_kms"][lo_c:hi_c]
            for r, l in zip(sel, local):
                a, b = int(off[l]) - lo_c, int(off[l + 1]) - lo_c
                out[int(r)] = ((float(vl[a:b].min()), float(vl[a:b].max())) if b > a else (math.nan, math.nan))
    return out


def window_excess_kms(vrange, bulk, direction) -> float:
    """max |u| of the ray's cells in our spectrum frame (u = -(v - V_bulk).d), from vlos_range's (min, max) of v.d;
    > W_SBI means gas outside the +-1500 km/s window. nan when unknown."""
    lo, hi = vrange
    if not (math.isfinite(lo) and math.isfinite(hi)):
        return math.nan
    vb = float(np.dot(np.asarray(bulk, float), np.asarray(direction, float)))
    return float(max(abs(lo - vb), abs(hi - vb)))


def native_grid_sbi(key, W=W_SBI, du=DU_SBI) -> tuple:
    """(lam0, dlam, n): our linear-lambda grid u_j = -W + j du (j = 0..n-1) for line `key` (our rest wavelength).
    dlam is shortened by 1e-9 relative so that the decoded du never exceeds 0.5 (vpfit.fit_stride -> 2)."""
    rest = float(I.get(key)["lam0_A"])
    n = int(round(2 * W / du)) + 1
    dlam = rest * du / C_KMS * (1 - 1e-9)
    lam0 = rest * (1 - W / C_KMS)
    return lam0, dlam, n


def resample_tau(tau_sbi, v_log, key, W=W_SBI, du=DU_SBI, offset_kms=0.0) -> tuple:
    """SBI tau (on velocity_log = c ln(lambda/lambda0_sbi)) -> our grid by velocity: u_j -> c ln(1 + u_j/c) + offset
    (offset = line_offset_kms: the rendered line's position on the SBI grid, so gas at rest lands on u = 0).
    Returns (tau float32, lam0, dlam). Edge samples outside the SBI grid repeat its edge value."""
    lam0, dlam, n = native_grid_sbi(key, W, du)
    rest = float(I.get(key)["lam0_A"])
    u = C_KMS * ((lam0 + np.arange(n) * dlam) / rest - 1.0)
    vl = C_KMS * np.log1p(u / C_KMS) + float(offset_kms)
    t = np.interp(vl, np.asarray(v_log, float), np.asarray(tau_sbi, float))
    return np.maximum(t, 0.0).astype(np.float32), lam0, dlam


def _read_rows(ds, rows, block):
    """Rows of a 2-D chunked dataset through h5py, reading whole chunk-row blocks once (rows sorted)."""
    out = np.empty((len(rows), ds.shape[1]), ds.dtype)
    rows = np.asarray(rows)
    blocks = rows // block
    for bk in np.unique(blocks):
        m = blocks == bk
        a = int(bk) * block
        data = ds[a:min(a + block, ds.shape[0])]
        out[m] = data[rows[m] - a]
    return out


IO_THREADS = int(os.environ.get("TNG_SBI_IO_THREADS") or 24)


def _raw_chunk_plan(ds, rows):
    """[(block_index, byte_offset, nbytes)] for the full-width, unfiltered chunks holding `rows`, or None when the
    dataset is not a plain row-block chunked layout (then h5py reads it)."""
    import h5py
    if ds.chunks is None or ds.chunks[1] != ds.shape[1] or ds.compression is not None:
        return None
    blk = ds.chunks[0]
    nb = blk * ds.shape[1] * ds.dtype.itemsize
    index = {}
    if hasattr(ds.id, "chunk_iter"):          # whole chunk index in one B-tree walk (HDF5 >= 1.14)
        ds.id.chunk_iter(lambda ci: index.__setitem__(int(ci.chunk_offset[0]) // blk, ci))
    plan = []
    for bk in np.unique(np.asarray(rows) // blk):
        ci = index.get(int(bk)) or ds.id.get_chunk_info_by_coord((int(bk) * blk, 0))
        if ci.filter_mask != 0 or ci.byte_offset is None or ci.size != nb:
            return None
        plan.append((int(bk), int(ci.byte_offset), int(ci.size)))
    if not ds.dtype.isnative:
        return None
    _ = h5py
    return plan


def _read_rows_parallel(path, items, threads=None):
    """Parallel raw reads (os.pread in threads; BeeGFS serves concurrent requests far faster than one stream).
    items = [(key, ds_shape, dtype, block, rows, plan)]; returns {key: (len(rows), width) array}."""
    from concurrent.futures import ThreadPoolExecutor
    jobs = [(k, bk, off, nb) for k, _sh, _dt, _blk, _rows, plan in items for bk, off, nb in plan]
    fd = os.open(path, os.O_RDONLY)
    try:
        with ThreadPoolExecutor(max(1, int(threads or IO_THREADS))) as ex:
            raw = list(ex.map(lambda j: os.pread(fd, j[3], j[2]), jobs))
    finally:
        os.close(fd)
    got = {(k, bk): r for (k, bk, _o, nb), r in zip(jobs, raw)}
    out = {}
    for k, sh, dt, blk, rows, plan in items:
        rows = np.asarray(rows)
        a = np.empty((rows.size, sh[1]), dt)
        for bk, _o, nb in plan:
            buf = got[(k, bk)]
            if len(buf) != nb:
                raise IOError(f"{path}: short read for {k} block {bk}")
            chunk = np.frombuffer(buf, dtype=dt).reshape(blk, sh[1])
            m = rows // blk == bk
            a[m] = chunk[rows[m] - bk * blk]
        out[k] = a
    return out


def read_rays(gdir: Path, rows, keys=None) -> dict:
    """Read the selected rays (global row indices into the 53,248) from the tau and csr chunks.
    Returns {"ray_id": (m,), "v_log": {key: grid}, "tau": {key: (m, 6000)}, "feature": {key: meta},
    "logN": {key: (m,)}, "vlos_w": {key: (m,)} (column-weighted CSR v_los = v.d), "vlos_range": (m, 2) min/max
    cell v_los = v.d, "frame": render frame dict,
    "length_unit_cm"}."""
    import h5py
    keys = list(keys or LINE_MAP)
    rows = np.sort(np.asarray(rows, int))
    m = rows.size
    out = {"rows": rows, "ray_id": np.zeros(m, np.uint64), "v_log": {}, "tau": {k: None for k in keys},
           "feature": {}, "logN": {k: np.full(m, -np.inf) for k in keys}, "vlos_w": {k: np.full(m, np.nan)
                                                                                  for k in keys},
           "vlos_range": np.full((m, 2), np.nan)}
    frames = []
    for lo, hi, p in chunk_files(gdir, "tau"):
        sel = np.flatnonzero((rows >= lo) & (rows < hi))
        if not sel.size:
            continue
        local = rows[sel] - lo
        with h5py.File(p, "r") as h:
            rid = h["ray_id"][...]
            out["ray_id"][sel] = rid[local]
            frames.append(json.loads(h.attrs["render_velocity_frame_json"]))
            items = []
            for k in keys:
                g = h[LINE_MAP[k]]
                ds = g["tau"]
                if k not in out["v_log"]:
                    out["v_log"][k] = g["velocity_log_kms"][...]
                    out["feature"][k] = json.loads(g.attrs["feature_json"])
                    out["tau"][k] = np.zeros((m, ds.shape[1]), np.float64)
                elif not np.array_equal(out["v_log"][k], g["velocity_log_kms"][...]):
                    raise RuntimeError(f"{p}: {k} velocity grid differs between chunks")
                plan = _raw_chunk_plan(ds, local) if IO_THREADS > 1 else None
                if plan is None:
                    out["tau"][k][sel] = _read_rows(ds, local, (ds.chunks or (16,))[0])
                else:
                    items.append((k, ds.shape, ds.dtype, ds.chunks[0], local, plan))
        if items:
            for k, arr in _read_rows_parallel(p, items).items():
                out["tau"][k][sel] = arr
    for lo, hi, p in chunk_files(gdir, "csr"):
        sel = np.flatnonzero((rows >= lo) & (rows < hi))
        if not sel.size:
            continue
        local = rows[sel] - lo
        with h5py.File(p, "r") as h:
            if not np.array_equal(h["ray_id"][...][local], out["ray_id"][sel]):
                raise RuntimeError(f"{p}: csr ray ids differ from the tau chunk")
            Lu = float(h.attrs["length_unit_cm"])
            out["length_unit_cm"] = Lu
            off = h["cell_offsets"][...]
            # whole datasets once per file (small lzf chunks: one sequential read beats per-ray slicing on BeeGFS)
            lo_c, hi_c = int(off[local.min()]), int(off[local.max() + 1])
            dl_all = h["dl"][lo_c:hi_c] * Lu
            vl_all = h["velocity_los_kms"][lo_c:hi_c]
            segs = [(j, int(off[r]) - lo_c, int(off[r + 1]) - lo_c) for j, r in zip(sel, local)]
            for j, a, b in segs:
                if b > a:
                    out["vlos_range"][j] = (float(vl_all[a:b].min()), float(vl_all[a:b].max()))
            for k in keys:
                col_all = h[f"cloudydensity_{k}"][lo_c:hi_c] * dl_all
                for j, a, b in segs:
                    if b <= a:
                        continue
                    col = col_all[a:b]
                    s = float(col.sum())
                    if s > 0:
                        out["logN"][k][j] = math.log10(s)
                        out["vlos_w"][k][j] = float((col * vl_all[a:b]).sum() / s)
    kinds = {json.dumps(f, sort_keys=True) for f in frames}
    if len(kinds) != 1:
        raise RuntimeError(f"{gdir}: render velocity frame differs between chunks")
    out["frame"] = frames[0]
    return out


def bulk_velocity(frame: dict) -> np.ndarray:
    """The velocity subtracted when the tau was rendered (zero for a raw peculiar frame)."""
    if frame.get("kind") == "galaxy_rest_peculiar" and frame.get("bulk_velocity_original_xyz_kms") is not None:
        return np.asarray(frame["bulk_velocity_original_xyz_kms"], float)
    return np.zeros(3)


def frame_samples(data: dict, direction, key="OVI", logn_min=12.5, edge_kms=1200.0) -> tuple:
    """(y, d) per optically thin ray (tau_max < 3, logN >= logn_min, centroid inside +-edge_kms): y = tau-weighted
    centroid + column-weighted CSR v.d, which equals B.d for the velocity B subtracted at render time."""
    tau, v = data["tau"][key], data["v_log"][key] - line_offset_kms(data["feature"][key])
    lN, vw = data["logN"][key], data["vlos_w"][key]
    s = tau.sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        c = (tau * v[None, :]).sum(axis=1) / s
    ok = np.isfinite(c) & np.isfinite(vw) & (lN >= logn_min) & (np.abs(c) < edge_kms) & (tau.max(axis=1) < 3.0)
    return c[ok] + vw[ok], np.asarray(direction, float)[ok]


FRAME_OUTLIER_FLOOR_KMS = 0.1   # the residual MAD is ~0.001 km/s on clean data; without a floor the 5 MAD cut
                                # (~0.005 km/s) counted most rays as outliers (validate2_3: 499704, 507 of 586)


def frame_fit(y, d, expected, key="OVI", tol_kms=2.0) -> dict:
    """Robust least-squares B from y = B.d (one refit after dropping |residual| > max(5 x 1.4826 MAD,
    FRAME_OUTLIER_FLOOR_KMS): rays whose thin-line
    centroid is pulled by blends or the window edge); pass when |B - expected| < tol and the median absolute
    residual < tol (km/s). The rms and the dropped fraction are reported."""
    y, d = np.asarray(y, float), np.asarray(d, float).reshape(-1, 3)
    exp = np.asarray(expected, float)
    out = {"line": key, "n_rays": int(y.size), "expected_bulk_kms": [round(float(x), 4) for x in exp]}
    if y.size < 8:
        out.update({"pass": None, "reason": "fewer than 8 optically thin rays"})
        return out
    B, *_ = np.linalg.lstsq(d, y, rcond=None)
    res = y - d @ B
    mad = 1.4826 * float(np.median(np.abs(res - np.median(res))))
    keep = np.abs(res) <= max(5 * mad, FRAME_OUTLIER_FLOOR_KMS)
    if keep.sum() >= 8 and not keep.all():
        B, *_ = np.linalg.lstsq(d[keep], y[keep], rcond=None)
        res = y - d @ B
    out.update(recovered_bulk_kms=[round(float(x), 3) for x in B],
               max_abs_dev_kms=round(float(np.max(np.abs(B - exp))), 3),
               median_abs_residual_kms=round(float(np.median(np.abs(res))), 3),
               rms_residual_kms=round(float(np.sqrt(np.mean(res[keep] ** 2))), 3),
               n_outliers=int((~keep).sum()))
    out["pass"] = bool(out["max_abs_dev_kms"] < tol_kms and out["median_abs_residual_kms"] < tol_kms)
    return out


def verify_frame(data: dict, direction, key="OVI") -> dict:
    """frame_fit of one read batch against the frame metadata's bulk velocity (module doc)."""
    y, d = frame_samples(data, direction, key)
    return frame_fit(y, d, bulk_velocity(data["frame"]), key)


def effective_f(data: dict, key, logn_min=13.0) -> float | None:
    """f of the tau from AOD vs ray column (median over rays with logN >= logn_min, tau_max < 3):
    f_eff = (1e5/(sigma0 1e-8)) int(tau dv) / (N lambda0_sbi). Used where the SBI feature has no f (O VII)."""
    tau, v = data["tau"][key], data["v_log"][key]
    lN = data["logN"][key]
    ok = (lN >= logn_min) & np.isfinite(lN) & (tau.max(axis=1) < 3.0)
    if ok.sum() < 3:
        return None
    lam0 = float(data["feature"][key].get("lambda0_A") or I.get(key)["lam0_A"])
    aod = 1e5 / (I.SIGMA0 * 1e-8) * np.trapz(tau[ok], v, axis=1)
    return float(np.median(aod / (10 ** lN[ok] * lam0)))


def payload(data: dict, j: int, ours: dict, row: int, rec: dict, gen: dict, sbi_extra: dict | None = None) -> dict:
    """npz v2 payload (library.save_npz input) of the j-th read ray (global row `row`); sbi_extra joins geom.sbi."""
    keys = list(data["tau"])
    d = ours["n_los"][row]
    vb = bulk_velocity(data["frame"])
    v_sys = float(np.dot(np.asarray(rec["SubhaloVel_kms"], float) - vb, d)) * VSYS_SIGN
    c = np.asarray(rec["center_kpc"], float)
    H = float(rec["TNG_H"])
    st, en, an = c + ours["start_rel"][row], c + ours["end_rel"][row], c + ours["anchor_rel"][row]
    geom = dict(orientation=str(ours["orientation"][row]), b_kpc=round(float(ours["b_kpc"][row]), 3),
                azimuth_deg=round(float(ours["azimuth_deg"][row]), 3),
                inclination_deg=round(float(ours["inclination_deg"][row]), 3),
                n_los=d.tolist(), v_sys_kms=v_sys, half_kpc=float(ours["half_kpc"][row]),
                anchor_kpc=an.tolist(), start_kpc=st.tolist(), end_kpc=en.tolist(),
                start_ckpch=(st * H).tolist(), end_ckpch=(en * H).tolist(),
                source="sbi_cgm",
                v_frame="SBI tau is galaxy-rest (V_bulk subtracted); v_sys = (SubhaloVel - V_bulk).n_los",
                sbi={"ray_id": int(data["ray_id"][j]), "row": int(row), **(sbi_extra or {}),
                     "bulk_velocity_kms": [round(float(x), 4) for x in vb]})
    p = {"geom": geom, "v_sys": v_sys, "lines": keys, "generation": gen,
         "logN": {}, "tau": {}, "lam0": {}, "dlam": {}, "rest": {}, "W": {}}
    for k in keys:
        t, lam0, dlam = resample_tau(data["tau"][k][j], data["v_log"][k], k,
                                     offset_kms=line_offset_kms(data["feature"][k]))
        lN = float(data["logN"][k][j])
        p["logN"][k] = lN if math.isfinite(lN) else -np.inf
        p["tau"][k], p["lam0"][k], p["dlam"][k] = t, lam0, dlam
        p["rest"][k] = float(I.get(k)["lam0_A"])
        p["W"][k] = W_SBI
    return p


def generation_record(gdir: Path, run: str, features: dict | None = None) -> dict:
    """npz/catalogue generation block of an imported ray; `features` ({key: feature_json}) adds the per-line grid
    offsets removed on import and the SBI/registry f*lambda ratios (AOD bias of a fit with our f)."""
    out = {"source": "sbi_cgm", "sbi_run": run, "dv_kms": DU_SBI, "dv_sbi_native_kms": DU_SBI,
           "v_window_kms": W_SBI, "ion_table": "CLOUDY c17.03 FG11 + Rahmati13 self-shielding (THOR tables)",
           "voigt": "GPU CuPy fp64 (SBI profile components)", "min_tau": 0.0,
           "grid": "SBI log-lambda resampled by velocity to linear lambda, line offset removed",
           "registry_tag": I.registry_tag()}
    if features:
        out["line_offset_kms"] = {k: round(line_offset_kms(features[k]), 4) for k in features}
        out["f_lambda_ratio"] = {k: (None if f_lambda_ratio(features[k], k) is None
                                     else round(f_lambda_ratio(features[k], k), 6)) for k in features}
    return out


def read_provenance(gdir: Path) -> dict:
    """Small, public provenance facts of the SBI run (no paths)."""
    out = {}
    for sub in ("gpu", "native"):
        p = Path(gdir) / sub / "PROVENANCE.json"
        if p.is_file():
            try:
                d = json.loads(p.read_text())
            except ValueError:
                continue
            for k in ("schema", "git_commit", "code_sha256", "recipe_sha256", "created_utc", "scientific_scope"):
                if k in d and isinstance(d[k], (str, int, float)):
                    out[f"{sub}_{k}"] = d[k]
    rc = Path(gdir) / "gpu" / "recipe_config.yaml"
    if rc.is_file():
        out["recipe_config_sha256"] = hashlib.sha256(rc.read_bytes()).hexdigest()
    return out
