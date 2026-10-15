"""Nested raw-resolution gas cubes for the 3D viewer (Phase-2b design §4.1, decisions D1–D7).

Every gas cell of the slim cutout (original Arepo resolution) is scattered with its own cubic-spline kernel onto
three nested 256³ disk-frame cubes by the conservative `tngsight.deposit.scatter`:

    L0 ±400 kpc (Δ 3.125 kpc)   L1 ±100 kpc (Δ 0.78125 kpc)   L2 ±25 kpc (Δ 0.1953125 kpc)

Per cell (slim-cutout order, `cell_arrays`): disk-frame position d = (x − center_kpc) @ Rᵀ, smoothing length
h = 2.0·(3V/4π)^{1/3} with V = Masses/Density (yt's Arepo `smoothing_length`, the kernel of every Trident ray), the
yt/Trident fields n_H, the 12 registry ion densities n(ion) (tngsight.ions), T and Z/Z_sun of
`tngsight.generate.Generator`. One scatter per level deposits the extensive quantities (`extensive`) N_nH,
N_<ion> = n·V, m, m·T and m·Z (only those the requested fields need, `quantities_for`), so

    density = Σ N / V_vox           (cm⁻³; conserves every atom/ion in the box, sub-voxel cells included)
    T, Z    = Σ m·X / Σ m           (mass-weighted; 0 = empty where Σ m = 0)

and L0 voxels whose centre lies at r > 400 kpc are empty (`R_MASK_KPC`). The cubes are shipped as log10 → uint8
with the FULL value range (no percentile clip), shared by L0–L2 per field (design §2.3), as WebP z-slice atlases plus
a gzip raw fallback with content-hashed names (§2.4–2.6), described by `gas/manifest_gas.json` (§3.3).

The shared encoding/atlas/manifest helpers live in `tngsight.vizpack` (CORE, D13). When that module is not
importable, the private `_Compat` twin below — written to the same pinned formulas — is used instead, and the
fragment's generator block says so (`VIZPACK_IMPL`).
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import math
import os
import re
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from . import deposit as D
from . import ions as _ions
from .config import GALAXY

VOL_VERSION = 2
GENERATOR = "tngsight.volume/2"
Z_SUN = 0.0127                                   # TNG convention (design §2.7)
CM_PER_KPC = GALAXY["CM_PER_KPC"]
TNG_H = GALAXY["TNG_H"]
N = 256
GAS_LEVELS = {"L0": 400.0, "L1": 100.0, "L2": 25.0}
R_MASK_KPC = {"L0": 400.0}                       # gas part of design §2.7 R_MASK_KPC
ION_KEYS = tuple(_ions.KEYS)
VOL_KEYS = ("nH", "T", "Z") + ION_KEYS
# design §3.5: unchanged maps for HI/OVI/CIII; cool ions ice, intermediate viridis, hot magma
ION_CMAP = {"HI": "tng_ice", "MgII": "tng_ice", "SiII": "tng_ice", "CII": "tng_ice", "SiIII": "tng_ice",
            "CIII": "viridis", "SiIV": "viridis", "CIV": "viridis", "NV": "viridis",
            "OVI": "magma", "NeVIII": "magma", "OVII": "magma"}

FIELDS: dict = {
    "nH": {"label": "n_H", "units": "cm^-3", "kind": "density", "cmap": "tng_dusk",
           "yt_field": ("gas", "H_nuclei_density")},
    "T": {"label": "T", "units": "K", "kind": "mass_weighted", "cmap": "inferno",
          "yt_field": ("gas", "temperature")},
    "Z": {"label": "Z", "units": "Zsun", "kind": "mass_weighted", "cmap": "cividis",
          "yt_field": ("gas", "metallicity")},
}
for _k in ION_KEYS:
    FIELDS[_k] = {"label": f"n({_ions.get(_k)['ion']})", "units": "cm^-3", "kind": "density",
                  "cmap": ION_CMAP[_k], "yt_field": ("gas", _ions.get(_k)["field"]),
                  "color": _ions.get(_k)["color"]}
_YT_UNITS = {"nH": "cm**-3", "T": "K", "Z": "", **{k: "cm**-3" for k in ION_KEYS}}
SOURCES = {
    "nH": "('gas','H_nuclei_density') * V_cell",
    **{k: f"('gas','{_ions.get(k)['field']}') * V_cell" for k in ION_KEYS},
    "T": "mass-weighted ('gas','temperature')",
    "Z": "mass-weighted ('gas','metallicity') / Z_SUN",
}
# Visual-tuning floor (tune round 1; see docs/TNG50_OPERATIONS.md §1b): every gas cell is deposited with at
# least h = GAS_H_MIN_VOX·Δ of the level (the deposit core's own floor is 1 Δ). With a 1 Δ floor a sub-voxel cell
# lands in a 2×2×2 stamp, which the trilinear ray march draws as a square tile (cold H I / C III / O VI clumps in the
# outer CGM); a 2 Δ floor gives round, overlapping footprints. Columns and conservation are unchanged by the floor.
GAS_H_MIN_VOX = 2.0
DENSITY_KEYS = ("nH",) + ION_KEYS
QUANTITIES = ("N_nH",) + tuple(f"N_{k}" for k in ION_KEYS) + ("m", "mT", "mZ")
PRIMARY = {"nH": "N_nH", **{k: f"N_{k}" for k in ION_KEYS}, "T": "m", "Z": "m"}
CELL_NAMES = ("pos_disk", "h", "V_cm3", "m", "nH") + ION_KEYS + ("T", "Z")
# expected encoding ranges (design §3.4 as amended at integration: nH and HI vmin are the masked p0.5 of the
# r <= 400 kpc data, measured -6.00 and -12.29): field -> ((vmin, tol), (vmax, tol)); T/Z are measured
EXPECTED_RANGE = {"nH": ((-6.0, 0.3), (0.5, 0.2)), "OVI": ((-16.2, 0.4), (-5.6, 0.2)),
                  "HI": ((-12.3, 0.4), (-0.6, 0.2)), "CIII": ((-20.5, 0.5), (-2.8, 0.2))}


# ============================================================================== vizpack (CORE) or its twin
class _Compat:
    """Private implementation of the vizpack functions U_gas needs, following design §2.2–2.6 and §3.2 verbatim.
    Used only when `tngsight.vizpack` is not importable."""
    GENERATOR = "tngsight.volume/2:vizpack-compat"
    SLICES_PER_PART, PARTS, COLS, ROWS = 64, 4, 16, 4

    @staticmethod
    def voxel_centers(n, half):
        dx = 2.0 * float(half) / int(n)
        return -float(half) + (np.arange(int(n)) + 0.5) * dx

    @staticmethod
    def radial_mask(n, half, r_kpc):
        c = _Compat.voxel_centers(n, half)
        r2 = c[:, None, None] ** 2 + c[None, :, None] ** 2 + c[None, None, :] ** 2
        return r2 <= float(r_kpc) ** 2

    @staticmethod
    def snap_down(x):
        return math.floor(round(10.0 * float(x), 6)) / 10.0

    @staticmethod
    def snap_up(x):
        return math.ceil(round(10.0 * float(x), 6)) / 10.0

    @staticmethod
    def _valid(values, mask):
        v = np.asarray(values, dtype=np.float64)
        with np.errstate(invalid="ignore"):
            ok = np.isfinite(v) & (v > 0)
        return ok if mask is None else ok & np.asarray(mask, dtype=bool)

    @staticmethod
    def gas_range(level_values, level_masks):
        lo, hi = [], []
        for v, msk in zip(level_values, level_masks):
            ok = _Compat._valid(v, msk)
            if not ok.any():
                continue
            lv = np.log10(np.asarray(v, dtype=np.float64)[ok])
            lo.append(float(np.percentile(lv, 0.5)))
            hi.append(float(lv.max()))
        if not lo:
            raise ValueError("gas_range: no valid voxel on any level")
        vmin, vmax = _Compat.snap_down(min(lo)), _Compat.snap_up(max(hi))
        if vmax <= vmin:
            vmax = round(vmin + 0.1, 1)
        return vmin, vmax

    @staticmethod
    def quantize(values, mask, vmin, vmax):
        v = np.asarray(values, dtype=np.float64)
        ok = _Compat._valid(v, mask)
        q = np.zeros(v.shape, dtype=np.uint8)
        s = (np.log10(v[ok]) - vmin) / (vmax - vmin) * 254.0
        q[ok] = np.clip(1.0 + np.rint(s), 1, 255).astype(np.uint8)
        return q

    @staticmethod
    def dequantize(q, vmin, vmax):
        q = np.asarray(q)
        out = vmin + (q.astype(np.float64) - 1.0) * (vmax - vmin) / 254.0
        out[q == 0] = np.nan
        return out

    @staticmethod
    def raw_gas(q3):
        return np.ascontiguousarray(np.asarray(q3, dtype=np.uint8).transpose(2, 1, 0)).tobytes()

    @staticmethod
    def atlas_parts(q3):
        q = np.asarray(q3, dtype=np.uint8)
        n = q.shape[0]
        S, C, Rw = _Compat.SLICES_PER_PART, _Compat.COLS, _Compat.ROWS
        parts = []
        for p in range(_Compat.PARTS):
            blk = np.zeros((n, n, S), dtype=np.uint8)              # [i, j, s]
            ks = np.arange(p * S, min((p + 1) * S, q.shape[2]))
            if ks.size:
                blk[:, :, :ks.size] = q[:, :, ks]
            t = blk.transpose(2, 1, 0).reshape(Rw, C, n, n)         # [r, c, j, i]
            parts.append(np.ascontiguousarray(t.transpose(0, 2, 1, 3).reshape(Rw * n, C * n)))
        return parts

    @staticmethod
    def atlas_to_raw(parts, n, channels=1):
        S, C, Rw = _Compat.SLICES_PER_PART, _Compat.COLS, _Compat.ROWS
        q = np.zeros((n, n, n), dtype=np.uint8)
        for p, img in enumerate(parts):
            a = np.asarray(img)
            if a.ndim == 3:
                a = a[..., 0]
            t = a.reshape(Rw, n, C, n).transpose(0, 2, 1, 3).reshape(S, n, n)    # [s, j, i]
            for s in range(S):
                k = p * S + s
                if k < n:
                    q[:, :, k] = t[s].T
        return _Compat.raw_gas(q)

    @staticmethod
    def encode_webp(img):
        from PIL import Image
        a = np.ascontiguousarray(img)
        im = Image.fromarray(a)
        if im.mode not in ("L", "RGB"):
            raise ValueError(f"encode_webp: unexpected mode {im.mode}")
        buf = io.BytesIO()
        im.save(buf, "WEBP", lossless=True, quality=100, method=6, exact=True)
        return buf.getvalue()

    @staticmethod
    def decode_webp(b):
        from PIL import Image
        with Image.open(io.BytesIO(b)) as im:
            im.load()
            return np.asarray(im.convert("RGB"))

    @staticmethod
    def gzip_bytes(raw):
        buf = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=buf, mtime=0) as g:
            g.write(raw)
        return buf.getvalue()

    @staticmethod
    def write_cube(out_root, rel_dir, stem, raw, parts, *, kind, vmin, vmax, stats, deposit):
        if kind != "gas":
            raise ValueError("compat write_cube supports kind='gas' only")
        raw_sha = _sha(raw)
        id12 = raw_sha[:12]
        root = Path(out_root)
        (root / rel_dir).mkdir(parents=True, exist_ok=True)
        webp = {"paths": [], "bytes": [], "sha256": []}
        for p, img in enumerate(parts):
            b = img if isinstance(img, (bytes, bytearray)) else _Compat.encode_webp(img)
            rel = f"{rel_dir}/{stem}.{id12}.p{p}.webp"
            _atomic(root / rel, b)
            webp["paths"].append(rel); webp["bytes"].append(len(b)); webp["sha256"].append(_sha(b))
        gz = _Compat.gzip_bytes(raw)
        rel = f"{rel_dir}/{stem}.{id12}.u8.gz"
        _atomic(root / rel, gz)
        return {"vmin": float(vmin), "vmax": float(vmax), "raw_bytes": len(raw), "raw_sha256": raw_sha,
                "webp": webp, "gz": {"path": rel, "bytes": len(gz), "sha256": _sha(gz)},
                "stats": dict(stats), "deposit": dict(deposit)}

    @staticmethod
    def column_from_u8(q3, vmin, vmax, half, p0, p1, spv=1.0, jitter=0.5):
        """Viewer exact-path emulation (§5.5) on one level: step Δ/spv from p0, first sample at jitter·dt,
        linear-space trilinear interpolation of 10^decode over 8 clamp-to-edge neighbours, q = 0 → 0."""
        q = np.asarray(q3)
        n = q.shape[0]
        half = float(half)
        dx = 2.0 * half / n
        p0 = np.asarray(p0, dtype=np.float64); p1 = np.asarray(p1, dtype=np.float64)
        L = float(np.linalg.norm(p1 - p0))
        if L == 0:
            return -np.inf
        dt = dx / float(spv)
        t = (np.arange(int(math.ceil(L / dt)) + 1) + float(jitter)) * dt
        t = t[t < L]
        pts = p0 + t[:, None] * ((p1 - p0) / L)
        pts = pts[np.all(np.abs(pts) < half, axis=1)]
        lin = np.where(q > 0, 10.0 ** (vmin + (q.astype(np.float64) - 1.0) * (vmax - vmin) / 254.0), 0.0)
        g = (pts / (2.0 * half) + 0.5) * n - 0.5
        i0 = np.floor(g).astype(np.int64)
        fr = g - i0
        tot = np.zeros(len(pts))
        for dxo in (0, 1):
            for dyo in (0, 1):
                for dzo in (0, 1):
                    ii = np.clip(i0 + np.array([dxo, dyo, dzo]), 0, n - 1)
                    w = ((fr[:, 0] if dxo else 1 - fr[:, 0]) * (fr[:, 1] if dyo else 1 - fr[:, 1])
                         * (fr[:, 2] if dzo else 1 - fr[:, 2]))
                    tot += w * lin[ii[:, 0], ii[:, 1], ii[:, 2]]
        s = float(tot.sum() * dt * CM_PER_KPC)
        return math.log10(s) if s > 0 else -np.inf


try:                                                            # CORE's shared implementation (D13)
    from . import vizpack as _vizpack_mod                       # type: ignore[attr-defined]
    VP = _vizpack_mod
    VIZPACK_IMPL = getattr(_vizpack_mod, "GENERATOR", "tngsight.vizpack/1")
except ImportError:                                             # not written yet: the pinned-formula twin
    VP = _Compat
    VIZPACK_IMPL = _Compat.GENERATOR


# ============================================================================== small helpers
def _sha(b) -> str:
    return hashlib.sha256(b).hexdigest()


def _atomic(path: Path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".part{os.getpid()}")
    tmp.write_bytes(data)
    tmp.replace(path)


def grid(level, n=N) -> D.Grid:
    return D.Grid(GAS_LEVELS[level], int(n))


def level_mask(level, n=N):
    """bool (n,n,n): True where the voxel may hold data (L0: centre r ≤ 400 kpc); None when unmasked."""
    r = R_MASK_KPC.get(level)
    return None if r is None else VP.radial_mask(int(n), GAS_LEVELS[level], r)


# ============================================================================== per-cell arrays
def cell_arrays(ds) -> dict:
    """Per-cell float64 arrays in slim-cutout order from a loaded `Generator` dataset (design §4.1)."""
    ad = ds.all_data()
    x_kpc = ad["PartType0", "Coordinates"].to("code_length").d.astype(np.float64) / TNG_H
    m_g = ad["PartType0", "Masses"].to("g").d.astype(np.float64)
    rho = ad["PartType0", "Density"].to("g/cm**3").d.astype(np.float64)
    V_cm3 = m_g / rho
    out = {"pos_disk": D.to_disk(x_kpc),
           "h": 2.0 * (3.0 * V_cm3 / (4.0 * math.pi)) ** (1.0 / 3.0) / CM_PER_KPC,
           "V_cm3": V_cm3,
           "m": ad["PartType0", "Masses"].to("Msun").d.astype(np.float64)}
    for k in DENSITY_KEYS + ("T", "Z"):
        f = FIELDS[k]["yt_field"]
        if k == "nH" and f not in ds.derived_field_list:          # older yt: no H_nuclei_density
            f = ("gas", "H_number_density")
        v = ad[f]
        v = v.to(_YT_UNITS[k]) if _YT_UNITS[k] else v.to("dimensionless")
        out[k] = np.asarray(v.d, dtype=np.float64) / (Z_SUN if k == "Z" else 1.0)
    return out


def check_order(cells_pos_disk, cutout) -> float:
    """max |Δpos| (kpc) between the yt order and the h5py PartType0/Coordinates order of the cutout file."""
    import h5py
    with h5py.File(cutout, "r") as f:
        x = f["PartType0"]["Coordinates"][:].astype(np.float64) / TNG_H
    return float(np.max(np.abs(D.to_disk(x) - np.asarray(cells_pos_disk))))


def save_cells(cells: dict, cache) -> None:
    cache = Path(cache); cache.mkdir(parents=True, exist_ok=True)
    for k in CELL_NAMES:
        p = cache / f"cells_{k}.npy"
        tmp = p.with_name(p.name + ".part.npy")
        np.save(tmp, np.asarray(cells[k], dtype=np.float64)); tmp.replace(p)


def load_cells(cache, names=CELL_NAMES):
    """Cached per-cell arrays, or None when any is missing."""
    cache = Path(cache)
    paths = {k: cache / f"cells_{k}.npy" for k in names}
    if not all(p.is_file() for p in paths.values()):
        return None
    return {k: np.load(p) for k, p in paths.items()}


def quantities_for(keys) -> tuple:
    """The extensive quantities a set of fields needs, in QUANTITIES order. N_nH and m are always included (the
    conservation checks use them)."""
    need = {"N_nH", "m"}
    for k in keys:
        if k in ("T", "Z"):
            need |= {"m", f"m{k}"}
        else:
            need.add(PRIMARY[k])
    return tuple(q for q in QUANTITIES if q in need)


def extensive(cells, quantities=QUANTITIES) -> dict:
    """The extensive per-cell quantities deposited by one scatter (design §4.1): N_x = n_x·V, m, m·T, m·Z."""
    V = np.asarray(cells["V_cm3"], dtype=np.float64)
    m = np.asarray(cells["m"], dtype=np.float64)
    out = {}
    for q in quantities:
        if q == "m":
            out[q] = m
        elif q in ("mT", "mZ"):
            out[q] = m * cells[q[1:]]
        else:
            out[q] = cells[q[2:]] * V
    return out


# ============================================================================== deposition
def level_cubes(dep, level) -> dict:
    """Deposited totals -> the shipped fields present (float64 [i,j,k]): densities N/V_vox [cm⁻³], T = mT/m,
    Z = mZ/m (0 where Σ m = 0); L0 voxel centres at r > 400 kpc → 0."""
    g = dep.grids
    n = g["m"].shape[0]
    dx = 2.0 * GAS_LEVELS[level] / n
    vvox = (dx * CM_PER_KPC) ** 3
    out = {}
    for k in DENSITY_KEYS:
        if f"N_{k}" in g:
            out[k] = g[f"N_{k}"] / vvox
    m = g["m"]
    pos = m > 0
    for k, q in (("T", "mT"), ("Z", "mZ")):
        if q not in g:
            continue
        a = np.zeros_like(m)
        np.divide(g[q], m, out=a, where=pos)
        out[k] = a
    msk = level_mask(level, n)
    if msk is not None:
        for k in out:
            out[k] = np.where(msk, out[k], 0.0)
    return {k: out[k] for k in VOL_KEYS if k in out}


def deposit_numbers(dep) -> dict:
    """JSON-ready DepositResult numbers + conservation per quantity."""
    cons = {}
    for k, gq in dep.grids.items():
        s = float(gq.sum())
        cons[k] = abs(s - dep.q_in[k]) / max(abs(dep.q_in[k]), 1e-300)
    lost = {k: dep.q_lost[k] / max(dep.q_in[k] + dep.q_lost[k], 1e-300) for k in dep.q_in}
    return {"n_elements": dep.n_elements, "n_straddling": dep.n_straddling, "q_in": dep.q_in,
            "q_full_inside": dep.q_full_inside, "q_lost": dep.q_lost, "lost_fraction": lost,
            "conservation_rel": cons, "level_counts": dep.level_counts, "seconds": round(dep.seconds, 2),
            "pairs": dep.meta.get("pairs"), "workers": dep.meta.get("workers"),
            "deposit_generator": dep.meta.get("generator", D.GENERATOR)}


def build_level(cells, level, workers=1, n=N, progress=None, keys=VOL_KEYS):
    """ONE scatter of the extensive quantities the fields `keys` need on level `level` -> (cubes, DepositResult)."""
    qn = quantities_for(keys)
    q = extensive(cells, qn)
    g = grid(level, n)
    h = np.maximum(np.asarray(cells["h"], dtype=np.float64), GAS_H_MIN_VOX * g.dx)
    dep = D.scatter(cells["pos_disk"], h, {k: q[k] for k in qn}, g,
                    workers=int(workers), progress=progress)
    return level_cubes(dep, level), dep


# ============================================================================== ranges and windows (§2.3, §3.5)
def field_range(cubes_by_level: dict, key) -> tuple:
    """Shared (vmin, vmax) of `key` over the given levels (§2.3 gas rule; L0 masked)."""
    levels = [L for L in GAS_LEVELS if L in cubes_by_level]
    vals = [cubes_by_level[L][key] for L in levels]
    masks = [level_mask(L, vals[i].shape[0]) for i, L in enumerate(levels)]
    return tuple(float(x) for x in VP.gas_range(vals, masks))


def column_maps(density, level) -> dict:
    """log10 column maps [cm⁻²] of a density cube: face-on (sum over k) and edge-on (sum over i); NaN where 0."""
    n = density.shape[0]
    dcm = 2.0 * GAS_LEVELS[level] / n * CM_PER_KPC
    out = {}
    for name, ax in (("face", 2), ("edge", 0)):
        s = np.asarray(density, dtype=np.float64).sum(axis=ax) * dcm
        with np.errstate(divide="ignore"):
            out[name] = np.where(s > 0, np.log10(np.where(s > 0, s, 1.0)), np.nan)
    return out


def weighted_maps(X, nH) -> dict:
    """log10 of the nH-weighted mean of X along k (face) and i (edge); NaN where Σ nH = 0 or the mean ≤ 0."""
    out = {}
    for name, ax in (("face", 2), ("edge", 0)):
        num = (np.asarray(nH, np.float64) * X).sum(axis=ax)
        den = np.asarray(nH, np.float64).sum(axis=ax)
        ok = (den > 0) & (num > 0)
        r = np.full(den.shape, np.nan)
        r[ok] = np.log10(num[ok] / den[ok])
        out[name] = r
    return out


def _finite(a):
    a = np.asarray(a, dtype=np.float64)
    return a[np.isfinite(a)]


def proj_window(cubes_by_level: dict, key, r200=None) -> dict:
    """`proj` block of field `key` (§3.5). Column fields need L0 (vmin) and any levels (vmax); T/Z use the
    union of the L0 and L1 maps (whichever are given)."""
    r200 = float(GALAXY["R200c_kpc"] if r200 is None else r200)
    levels = [L for L in GAS_LEVELS if L in cubes_by_level]
    if FIELDS[key]["kind"] == "density":
        maps = {L: column_maps(cubes_by_level[L][key], L) for L in levels}
        p999 = [float(np.percentile(_finite(mp[v]), 99.9)) for mp in maps.values() for v in ("face", "edge")
                if _finite(mp[v]).size]
        base = "L0" if "L0" in maps else levels[0]
        face = maps[base]["face"]
        n = face.shape[0]
        c = VP.voxel_centers(n, GAS_LEVELS[base])
        rr = np.hypot(c[:, None], c[None, :])
        sel = _finite(face[rr < r200])
        p2, p50 = float(np.percentile(sel, 2)), float(np.percentile(sel, 50))
        return {"kind": "column", "units": "cm^-2", "vmin": VP.snap_down(max(p2, p50 - 3.0)),
                "vmax": VP.snap_up(max(p999))}
    pool = []
    for L in [L for L in ("L0", "L1") if L in cubes_by_level] or levels[:1]:
        mp = weighted_maps(cubes_by_level[L][key], cubes_by_level[L]["nH"])
        pool += [_finite(mp["face"]), _finite(mp["edge"])]
    u = np.concatenate(pool)
    return {"kind": "weighted_mean", "weight": "nH", "units": FIELDS[key]["units"],
            "vmin": VP.snap_down(float(np.percentile(u, 2))), "vmax": VP.snap_up(float(np.percentile(u, 99.9)))}


def vol_window(cubes_by_level: dict, key, vmax) -> list:
    """[snap_down(p50 of the L1 valid voxels), vmax] (§3.5); falls back to the finest level given."""
    L = "L1" if "L1" in cubes_by_level else [x for x in GAS_LEVELS if x in cubes_by_level][-1]
    v = np.asarray(cubes_by_level[L][key], dtype=np.float64)
    msk = level_mask(L, v.shape[0])
    ok = np.isfinite(v) & (v > 0) & (True if msk is None else msk)
    lo = VP.snap_down(float(np.percentile(np.log10(v[ok]), 50)))
    return [lo, float(vmax)] if lo < vmax else [round(vmax - 0.1, 1), float(vmax)]


def cube_stats(values, q) -> dict:
    v = np.asarray(values, dtype=np.float64)
    ok = np.asarray(q) > 0
    lv = np.log10(v[ok]) if ok.any() else np.array([np.nan])
    return {"frac_empty": round(float(1.0 - ok.mean()), 6),
            "p01": round(float(np.percentile(lv, 1)), 4), "p50": round(float(np.percentile(lv, 50)), 4),
            "p99": round(float(np.percentile(lv, 99)), 4), "max": round(float(np.max(lv)), 4)}


def check_expected_range(key, vmin, vmax) -> list:
    """Problems with (vmin, vmax) against design §3.4 (empty list = inside the bounds)."""
    if key not in EXPECTED_RANGE:
        return []
    (e0, t0), (e1, t1) = EXPECTED_RANGE[key]
    bad = []
    if abs(vmin - e0) > t0 + 1e-9:
        bad.append(f"{key}: vmin {vmin} outside {e0} ± {t0}")
    if abs(vmax - e1) > t1 + 1e-9:
        bad.append(f"{key}: vmax {vmax} outside {e1} ± {t1}")
    return bad


# ============================================================================== cube files + manifest fragment
def encode_cube_job(args) -> dict:
    """Process-pool job: (out_root, level, key, q uint8 (n,n,n), vmin, vmax, stats, deposit) -> CUBE entry."""
    out_root, level, key, q, vmin, vmax, stats, dep = args
    raw = VP.raw_gas(q)
    parts = [VP.encode_webp(a) for a in VP.atlas_parts(q)]
    cube = VP.write_cube(out_root, f"gas/{level}", key, raw, parts, kind="gas", vmin=vmin, vmax=vmax,
                         stats=stats, deposit=dep)
    # decode check: the written WebP parts must reproduce the raw bytes exactly (§2.4)
    dec =[VP.decode_webp((Path(out_root) / p).read_bytes()) for p in cube["webp"]["paths"]]
    if _sha(VP.atlas_to_raw(dec, q.shape[0], 1)) != cube["raw_sha256"]:
        raise RuntimeError(f"{level}/{key}: decoded WebP does not reproduce the raw bytes")
    return cube


def cube_files_ok(out_root, cube) -> bool:
    """True when every file of a CUBE entry exists with the recorded size and sha256."""
    root = Path(out_root)
    try:
        items = list(zip(cube["webp"]["paths"], cube["webp"]["bytes"], cube["webp"]["sha256"]))
        items.append((cube["gz"]["path"], cube["gz"]["bytes"], cube["gz"]["sha256"]))
        for rel, nb, sh in items:
            p = root / rel
            if not p.is_file() or p.stat().st_size != nb or _sha(p.read_bytes()) != sh:
                return False
        return True
    except (KeyError, TypeError):
        return False


def levels_block(levels=tuple(GAS_LEVELS), n=N) -> dict:
    return {L: {"half_kpc": GAS_LEVELS[L], "n": int(n), "voxel_kpc": 2.0 * GAS_LEVELS[L] / n,
                "r_mask_kpc": R_MASK_KPC.get(L)} for L in levels}


def generator_block() -> dict:
    import PIL
    import PIL.features
    return {"deposit": D.GENERATOR, "vizpack": VIZPACK_IMPL, "gas": GENERATOR, "pillow": PIL.__version__,
            "libwebp": PIL.features.version("webp"), "numpy": np.__version__}


def field_entry(key, vmin, vmax, proj, vwin, cubes: dict) -> dict:
    f = FIELDS[key]
    return {"label": f["label"], "units": f["units"], "kind": f["kind"], "source": SOURCES[key],
            "vmin": float(vmin), "vmax": float(vmax), "cmap": f["cmap"], "proj": dict(proj),
            "vol_window": [float(vwin[0]), float(vwin[1])], "cubes": dict(cubes)}


def gas_fragment(fields: dict, levels=tuple(GAS_LEVELS), n=N) -> dict:
    """`gas/manifest_gas.json` = {"schema", "generator", "levels" (L*), "gas"} (design §3.3)."""
    order = [k for k in VOL_KEYS if k in fields]
    return {"schema": "tng50-viz/2", "generator": generator_block(), "levels": levels_block(levels, n),
            "gas": {"levels": list(levels), "fields": {k: fields[k] for k in order}}}


_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def validate_gas_fragment(frag, base_dir=None) -> None:
    """U_gas's own structural check of the gas fragment (§3.3 keys/types, CUBE rules, file names §2.6);
    with base_dir, every file's size + sha256. Raises ValueError."""
    def need(c, msg):
        if not c:
            raise ValueError(f"manifest_gas: {msg}")
    need(isinstance(frag, dict) and frag.get("schema") == "tng50-viz/2", "schema")
    for k in ("generator", "levels", "gas"):
        need(k in frag, f"missing {k!r}")
    gas = frag["gas"]
    need(set(gas["levels"]) <= set(GAS_LEVELS) and gas["levels"], "gas.levels")
    for L in gas["levels"]:
        lv = frag["levels"].get(L)
        need(isinstance(lv, dict) and lv.get("half_kpc") == GAS_LEVELS[L], f"levels.{L}")
        need(abs(lv["voxel_kpc"] - 2 * lv["half_kpc"] / lv["n"]) < 1e-12, f"levels.{L}.voxel_kpc")
        need(lv["r_mask_kpc"] == R_MASK_KPC.get(L), f"levels.{L}.r_mask_kpc")
    need(isinstance(gas["fields"], dict) and gas["fields"], "gas.fields empty")
    for key, e in gas["fields"].items():
        need(key in VOL_KEYS, f"unknown field {key!r}")
        for k in ("label", "units", "kind", "source", "vmin", "vmax", "cmap", "proj", "vol_window", "cubes"):
            need(k in e, f"{key}: missing {k!r}")
        need(all(isinstance(e[k], (int, float)) and math.isfinite(e[k]) for k in ("vmin", "vmax"))
             and e["vmin"] < e["vmax"], f"{key}: vmin/vmax")
        pr = e["proj"]
        need(pr.get("kind") == ("column" if e["kind"] == "density" else "weighted_mean"), f"{key}: proj.kind")
        need(pr["vmin"] < pr["vmax"], f"{key}: proj window")
        w = e["vol_window"]
        need(len(w) == 2 and w[0] < w[1] and w[1] == e["vmax"], f"{key}: vol_window")
        need(set(e["cubes"]) == set(gas["levels"]), f"{key}: cubes {sorted(e['cubes'])}")
        for L, c in e["cubes"].items():
            n = frag["levels"][L]["n"]
            need(c["vmin"] == e["vmin"] and c["vmax"] == e["vmax"], f"{key}/{L}: cube range != field range")
            need(c["raw_bytes"] == n ** 3 and bool(_HEX64.match(c["raw_sha256"])), f"{key}/{L}: raw")
            id12 = c["raw_sha256"][:12]
            need(c["webp"]["paths"] == [f"gas/{L}/{key}.{id12}.p{p}.webp" for p in range(4)],
                 f"{key}/{L}: webp paths")
            need(c["gz"]["path"] == f"gas/{L}/{key}.{id12}.u8.gz", f"{key}/{L}: gz path")
            need(len(c["webp"]["bytes"]) == 4 and len(c["webp"]["sha256"]) == 4, f"{key}/{L}: webp lists")
            need(all(k in c["stats"] for k in ("frac_empty", "p01", "p50", "p99", "max")), f"{key}/{L}: stats")
            need(all(k in c["deposit"] for k in ("n_elements", "n_straddling", "lost_fraction", "seconds",
                                                 "workers")), f"{key}/{L}: deposit")
            if base_dir is not None:
                need(cube_files_ok(base_dir, c), f"{key}/{L}: file size/sha256 mismatch or missing")


def write_fragment(viz_dir, frag) -> Path:
    p = Path(viz_dir) / "gas" / "manifest_gas.json"
    _atomic(p, (json.dumps(frag, indent=1) + "\n").encode())
    return p


def merged_for_validation(frag) -> dict:
    """A temporary full manifest_v2 object around the gas fragment (only for vizpack.validate_manifest_v2 with
    sections=("gas",); the real viz/manifest_v2.json is written by `vizpack merge` at integration)."""
    man = {"schema": "tng50-viz/2", "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "generator": frag["generator"], "levels": frag["levels"], "gas": frag["gas"]}
    if hasattr(VP, "constant_blocks"):
        man.update(VP.constant_blocks())
    return man
