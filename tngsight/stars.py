"""Deposited RGB stellar cubes for the 3D viewer (Phase-2b design §4.4–§4.6, D4, D6, D10).

Pipeline (one level = one ``deposit.scatter`` call with three quantities):

1. ``read_pt4``: ONE sequential read of PartType4 from the raw cutout (read-only, under the heavy-I/O lock),
   cached as ``<cache>/pt4_<field>.npy`` in snapshot units; later runs never touch the raw file again.
2. ``star_arrays``: drop wind particles (GFM_StellarFormationTime <= 0); disk-frame positions (§2.1),
   h = StellarHsml/TNG_H [kpc] and the band luminosities l_b = 10^(-0.4 M_b) [L_AB0] for b = i, r, g from the
   GFM_StellarPhotometrics columns 6, 5, 4.
3. ``build_level``: conservative kernel scatter onto the 256³ level box (S0 ±400, S1 ±100, S2 ±25 kpc) →
   luminosity densities [L_AB0 kpc^-3]; on S0 the voxels with centre r > 400 kpc are emptied (R_MASK_KPC).
4. ``encode_level`` / ``write_level``: the §2.3 star range rule (one [vmin, vmax] per level, shared by the three
   channels), log10-u8, RGBA raw (R = q_i, G = q_r, B = q_g, A = 255 if any > 0), WebP RGB atlases + gzip fallback,
   content-hashed names ``stars/<S>/gri.<id12>.*`` and a CUBE entry for ``stars/manifest_stars.json``.

The composite is the Lupton et al. (2004) asinh stretch (§4.5) as implemented by ``vizpack.lupton_rgb``.

Shared encoding code lives in ``tngsight.vizpack`` (CORE, D13). While that module is not present, this file uses a
private stand-in (``_LocalVizpack``) that implements the same pinned §2.2–§2.6 / §3.3 / §4.5 rules; it is used
ONLY when ``tngsight.vizpack`` cannot be imported, and the test suite checks the two agree when both exist.
"""
from __future__ import annotations

import contextlib
import fcntl
import gzip
import hashlib
import io
import json
import math
import os
import time
from pathlib import Path

import numpy as np

from . import deposit as D
from .config import GALAXY

STARS_VERSION = 1
GENERATOR = "tngsight.stars/1"

DEFAULT_CUTOUT = Path("/Volumes/LaCie/out_sub_488530/cutout_ALLFIELDS_sphere_2p1Rvir_sub488530.hdf5")
PT4_FIELDS = ("Coordinates", "Masses", "StellarHsml", "GFM_StellarPhotometrics", "GFM_StellarFormationTime")
CHANNELS = ("i", "r", "g")             # cube channel order R, G, B
QUANTITY = {b: f"l_{b}" for b in CHANNELS}
TNG_H = float(GALAXY["TNG_H"])


# ============================================================================== vizpack (CORE) or stand-in
class _LocalVizpack:
    """Stand-in for the pinned parts of ``tngsight.vizpack`` that the star build needs (§2.2–§2.7, §3.3, §4.5).

    Used only when ``tngsight.vizpack`` is not importable. Same names, same signatures, same rules."""
    SCHEMA = "tng50-viz/2"
    GENERATOR = "tngsight.vizpack/1"
    N = 256
    STAR_LEVELS = {"S0": 400.0, "S1": 100.0, "S2": 25.0}
    ALL_STAR_LEVELS = {"S0": 400.0, "S1": 100.0, "S2": 25.0, "S3": 6.25, "S4": 1.5}
    R_MASK_KPC = {"L0": 400.0, "S0": 400.0}
    MU_ZERO = 5 * math.log10(100 * 206264.80624709636)
    BANDS = {"g": 4, "r": 5, "i": 6}

    @staticmethod
    def voxel_centers(n, half):
        dx = 2.0 * float(half) / int(n)
        return -float(half) + (np.arange(int(n)) + 0.5) * dx

    @classmethod
    def radial_mask(cls, n, half, r_kpc):
        c = cls.voxel_centers(n, half)
        r2 = c[:, None, None] ** 2 + c[None, :, None] ** 2 + c[None, None, :] ** 2
        return r2 > float(r_kpc) ** 2

    @staticmethod
    def snap_down(x):
        return math.floor(round(10.0 * float(x), 6)) / 10.0

    @staticmethod
    def snap_up(x):
        return math.ceil(round(10.0 * float(x), 6)) / 10.0

    @staticmethod
    def _valid(v, mask):
        ok = np.isfinite(v) & (v > 0)
        if mask is not None:
            ok &= ~np.asarray(mask, dtype=bool)
        return ok

    @classmethod
    def star_range(cls, channels, mask):
        lo, hi = [], []
        for v in channels:
            ok = cls._valid(v, mask)
            lv = np.log10(v[ok])
            lo.append(np.percentile(lv, 0.5))
            hi.append(lv.max())
        return cls.snap_down(min(lo)), cls.snap_up(max(hi))

    @classmethod
    def quantize(cls, values, mask, vmin, vmax):
        v = np.asarray(values, dtype=np.float64)
        ok = cls._valid(v, mask)
        q = np.zeros(v.shape, dtype=np.uint8)
        lv = np.log10(v[ok])
        q[ok] = np.clip(1.0 + np.rint((lv - vmin) / (vmax - vmin) * 254.0), 1, 255).astype(np.uint8)
        return q

    @staticmethod
    def dequantize(q, vmin, vmax):
        q = np.asarray(q)
        out = vmin + (q.astype(np.float64) - 1.0) * (vmax - vmin) / 254.0
        out[q == 0] = np.nan
        return out

    @staticmethod
    def raw_stars(q_i, q_r, q_g, q_dust=None):
        if q_dust is None:
            a = np.where((q_i > 0) | (q_r > 0) | (q_g > 0), 255, 0).astype(np.uint8)
        else:
            a = np.asarray(q_dust, dtype=np.uint8)
        return np.stack([q_i, q_r, q_g, a], axis=-1).transpose(2, 1, 0, 3).tobytes()

    @staticmethod
    def atlas_parts(q):
        q = np.asarray(q, dtype=np.uint8)
        n = q.shape[0]
        parts = []
        for p in range(4):
            img = np.zeros((4 * n, 16 * n) + q.shape[3:], dtype=np.uint8)
            for s in range(64):
                k = 64 * p + s
                if k >= n:
                    break
                c, r = s % 16, s // 16
                img[r * n:(r + 1) * n, c * n:(c + 1) * n] = np.swapaxes(q[:, :, k], 0, 1)
            parts.append(img)
        return parts

    @staticmethod
    def atlas_to_raw(parts, n, channels):
        a0 = np.asarray(parts[0])
        has_alpha = (channels == 4) or (channels == 3 and a0.ndim == 3 and a0.shape[2] == 4)
        ch = 1 if channels == 1 else (4 if has_alpha else 3)
        q = np.zeros((n, n, n) if ch == 1 else (n, n, n, ch), dtype=np.uint8)
        for k in range(n):
            p, s = divmod(k, 64)
            c, r = s % 16, s // 16
            a = np.asarray(parts[p])
            if ch == 1 and a.ndim == 3:
                a = a[..., 0]
            elif ch == 3 and a.ndim == 3 and a.shape[2] > 3:
                a = a[..., :3]
            q[:, :, k] = np.swapaxes(a[r * n:(r + 1) * n, c * n:(c + 1) * n], 0, 1)
        if ch == 1:
            return q.transpose(2, 1, 0).tobytes()
        if ch == 4:
            return _LocalVizpack.raw_stars(q[..., 0], q[..., 1], q[..., 2], q_dust=q[..., 3])
        return _LocalVizpack.raw_stars(q[..., 0], q[..., 1], q[..., 2])

    @staticmethod
    def encode_webp(img):
        from PIL import Image
        mode = "L" if img.ndim == 2 else ("RGBA" if img.shape[2] == 4 else "RGB")
        buf = io.BytesIO()
        Image.fromarray(np.ascontiguousarray(img), mode).save(buf, "WEBP", lossless=True, quality=100, method=6,
                                                              exact=True)
        return buf.getvalue()

    @staticmethod
    def decode_webp(b):
        from PIL import Image
        im = Image.open(io.BytesIO(b))
        im.load()
        return np.asarray(im)

    @staticmethod
    def gzip_bytes(raw):
        buf = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=buf, mtime=0) as g:
            g.write(raw)
        return buf.getvalue()

    @classmethod
    def write_cube(cls, out_root, rel_dir, stem, raw, parts, *, kind, vmin, vmax, stats, deposit, webp=None):
        sha = hashlib.sha256(raw).hexdigest()
        id12 = sha[:12]
        d = Path(out_root) / rel_dir
        d.mkdir(parents=True, exist_ok=True)
        blobs = webp if webp is not None else [cls.encode_webp(p) for p in parts]
        wpaths, wbytes, wsha = [], [], []
        for p, b in enumerate(blobs):
            rel = f"{rel_dir}/{stem}.{id12}.p{p}.webp"
            _atomic_write(Path(out_root) / rel, b)
            wpaths.append(rel)
            wbytes.append(len(b))
            wsha.append(hashlib.sha256(b).hexdigest())
        gz = cls.gzip_bytes(raw)
        ext = "rgba.gz" if kind == "stars" else "u8.gz"
        grel = f"{rel_dir}/{stem}.{id12}.{ext}"
        _atomic_write(Path(out_root) / grel, gz)
        return {"vmin": float(vmin), "vmax": float(vmax), "raw_bytes": len(raw), "raw_sha256": sha,
                "webp": {"paths": wpaths, "bytes": wbytes, "sha256": wsha},
                "gz": {"path": grel, "bytes": len(gz), "sha256": hashlib.sha256(gz).hexdigest()},
                "stats": dict(stats), "deposit": dict(deposit)}

    @classmethod
    def lupton_rgb(cls, S_i, S_r, S_g, Q=8.0, mu0=21.5, balance=(1.0, 1.0, 1.0)):
        s0 = 10.0 ** (0.4 * (cls.MU_ZERO - mu0))
        R = balance[0] * np.asarray(S_i, dtype=np.float64) / s0
        G = balance[1] * np.asarray(S_r, dtype=np.float64) / s0
        B = balance[2] * np.asarray(S_g, dtype=np.float64) / s0
        I = (R + G + B) / 3.0
        QI = Q * I
        with np.errstate(divide="ignore", invalid="ignore"):
            F = np.where(I > 0, np.arcsinh(QI) / np.where(QI > 0, QI, 1.0), 0.0)
        rgb = np.stack([R * F, G * F, B * F], axis=-1)
        m = rgb.max(axis=-1, keepdims=True)
        rgb = np.where(m > 1.0, rgb / np.where(m > 0, m, 1.0), rgb)
        return np.floor(255.0 * np.clip(rgb, 0.0, 1.0) + 0.5).astype(np.uint8)


try:                                            # CORE's shared implementation wins whenever it exists
    from . import vizpack as VP                 # type: ignore[attr-defined]
    VIZPACK_SOURCE = "tngsight.vizpack"
except ImportError:                             # pragma: no cover - depends on the CORE unit's progress
    VP = _LocalVizpack
    VIZPACK_SOURCE = "tngsight.stars._LocalVizpack"

STAR_LEVELS = dict(VP.STAR_LEVELS)
ALL_STAR_LEVELS = dict(getattr(VP, "ALL_STAR_LEVELS",
                               {"S0": 400.0, "S1": 100.0, "S2": 25.0, "S3": 6.25, "S4": 1.5}))
N = int(VP.N)
BANDS = dict(VP.BANDS)
MU_ZERO = float(VP.MU_ZERO)
DISPLAY = {"Q": 8.0, "mu0": 21.5, "mu_zero": round(MU_ZERO, 11), "balance": [1.0, 1.0, 1.0],
           "formula": "lupton2004"}
# 3D V-band dust optical depth per kpc (kappa_V [kpc^-1]) packed into the 4th RGBA byte (.a) when --dust is enabled.
# Supports selectable wavelength extinction laws in the WebGL2 ray-marcher (viewer3d.js):
#   - 'temet': Cardelli, Clayton & Mathis (1989) Milky Way (R_V = 3.1) extinction curve + Calzetti et al. (1994)
#              internal scattering albedo f_scat(lambda), following temet/cosmo/stellarPop.py (Nelson et al. 2018)
#   - 'calzetti': Calzetti et al. (2000) starburst attenuation law (R'_V = 4.05)
#   - 'cardelli': Cardelli, Clayton & Mathis (1989) Milky Way screen extinction (R_V = 3.1)
#   - 'pei': FIRE Studio / Pei (1992) SMC/MW extinction curve (firestudio/utils/stellar_utils/cross_section.py)
# Quantized as log10(kappa_V [kpc^-1]) in [-4.5, 1.5] -> uint8 1..254 (0 = no dust / empty; 255 = legacy unattenuated).
DUST_VMIN = -4.5
DUST_VMAX = 1.5
DUST_T_MAX = 1.0e5
DUST_Z_REF = 0.02
DUST_KAPPA_COEFF = 2.41


def _half_kpc(level) -> float:
    return float(STAR_LEVELS.get(level, ALL_STAR_LEVELS.get(level)))


def _ordered_star_levels() -> list:
    return list(dict.fromkeys(list(STAR_LEVELS) + list(ALL_STAR_LEVELS)))


def _atomic_write(path: Path, data: bytes):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


@contextlib.contextmanager
def heavy_lock(path):
    """Exclusive fcntl lock on `path` (None → no lock); serialises heavy I/O with other jobs."""
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


# ============================================================================== 1. raw read (once)
def pt4_cache_paths(cache) -> dict:
    return {f: Path(cache) / f"pt4_{f}.npy" for f in PT4_FIELDS}


def read_pt4(cutout, cache, lock=None, log=print) -> dict:
    """PartType4 arrays in snapshot units. Reads the raw cutout ONCE (sequentially, read-only, under `lock`) and
    caches each field as ``<cache>/pt4_<field>.npy``; when every cache file exists the cutout is never opened."""
    paths = pt4_cache_paths(cache)
    if all(p.is_file() for p in paths.values()):
        return {f: np.load(p, mmap_mode=None) for f, p in paths.items()}
    import h5py
    Path(cache).mkdir(parents=True, exist_ok=True)
    out = {}
    with heavy_lock(lock):
        t0 = time.time()
        with h5py.File(str(cutout), "r") as fh:
            g = fh["PartType4"]
            for f in PT4_FIELDS:                     # one field after the other: a sequential read
                out[f] = g[f][()]
                if log:
                    log(f"[pt4] {f} {out[f].shape} {out[f].dtype} {time.time() - t0:.1f}s")
    for f, a in out.items():
        tmp = paths[f].with_name(paths[f].name + ".tmp.npy")
        np.save(tmp, a)
        os.replace(tmp, paths[f])
    return out


# ============================================================================== 2. per-star arrays
def magnitudes_to_lum(mag) -> np.ndarray:
    """Absolute AB magnitude → luminosity in L_AB0 (the luminosity of an M_AB = 0 source)."""
    return 10.0 ** (-0.4 * np.asarray(mag, dtype=np.float64))


def star_arrays(pt4) -> dict:
    """Non-wind stars (GFM_StellarFormationTime > 0): pos_disk [kpc], h_kpc, l_i, l_r, l_g [L_AB0], m [Msun]."""
    sft = np.asarray(pt4["GFM_StellarFormationTime"])
    keep = sft > 0
    x_kpc = np.asarray(pt4["Coordinates"], dtype=np.float64)[keep] / TNG_H
    box = GALAXY.get("box_ckpch")
    if box:                                       # periodic box: stars across the boundary move next to the centre
        box_kpc = float(box) / TNG_H              # (shift is exactly 0 elsewhere, so x_kpc is unchanged bit for bit)
        x_kpc = x_kpc - box_kpc * np.round((x_kpc - np.asarray(GALAXY["center_kpc"], dtype=np.float64)) / box_kpc)
    phot = np.asarray(pt4["GFM_StellarPhotometrics"])[keep]
    out = {"pos_disk": D.to_disk(x_kpc),
           "h_kpc": np.asarray(pt4["StellarHsml"], dtype=np.float64)[keep] / TNG_H,
           "m": np.asarray(pt4["Masses"], dtype=np.float64)[keep] * 1e10 / TNG_H,
           "n_total": int(sft.size), "n_wind": int((~keep).sum())}
    for b in CHANNELS:
        out[f"l_{b}"] = magnitudes_to_lum(phot[:, BANDS[b]])
    return out


def load_stars(cutout, cache=None, lock=None, log=None) -> dict:
    """Load PartType4 from `cutout` (using `cache` when provided) and return `star_arrays(pt4)`."""
    cut_path = Path(cutout)
    for rname in ("galaxy.json", "record.json"):
        rp = cut_path.parent / rname
        if rp.is_file():
            rec = json.loads(rp.read_text())
            if rec.get("subhalo_id") != GALAXY.get("subhalo_id"):
                GALAXY.clear()
                GALAXY.update(rec)
            break
    if cache is not None:
        pt4 = read_pt4(cutout, cache, lock=lock, log=log)
    else:
        import h5py
        with heavy_lock(lock):
            with h5py.File(str(cutout), "r") as fh:
                g = fh["PartType4"]
                pt4 = {f: g[f][()] for f in PT4_FIELDS}
    return star_arrays(pt4)


# ============================================================================== 3. deposit
# Tightened minimum star kernel radius in voxels: 0.85 Δ on disk/ISM levels (S2, S3, S4) so star particles deposit into
# crisp, resolved star-forming knots and spiral arms rather than smearing across 3x3x3 voxels; 1.2 Δ on halo levels
# (S0, S1) to keep outer halo streams smooth.
H_MIN_VOX = 0.85
STAR_H_MIN_VOX = {"S0": 1.2, "S1": 1.2, "S2": H_MIN_VOX, "S3": H_MIN_VOX, "S4": H_MIN_VOX}


def star_h_min_vox(level) -> float:
    return float(STAR_H_MIN_VOX.get(level, H_MIN_VOX))


def level_grid(level, n=None) -> D.Grid:
    return D.Grid(_half_kpc(level), int(n or N), h_min_vox=star_h_min_vox(level))


def level_mask(level, n=None):
    """Voxels emptied on this level (S0: centre r > 400 kpc) or None."""
    r = VP.R_MASK_KPC.get(level)
    if r is None:
        return None
    m = VP.radial_mask(int(n or N), _half_kpc(level), float(r))
    # tngsight.vizpack's radial_mask is True where a voxel is KEPT (r <= R); the stand-in's is True where emptied
    return m if VP is _LocalVizpack else ~m


def _keep(mask):
    """The emptied-voxel mask in the convention VP.quantize / VP.star_range expect."""
    if mask is None or VP is _LocalVizpack:
        return mask
    return ~mask


def kappa_v_from_gas(n_H, T, Z_massfrac, gamma: float = 1.0, mode: str = "default") -> np.ndarray:
    """V-band dust optical depth per kpc kappa_V [kpc^-1] = 2.41 * n_H [cm^-3] * (Z / 0.02)^gamma.
    - mode='default' / 'pei': cold/warm gas T < 1e5 K (FIRE_studio / Pei 1992).
    - mode='skirt': SKIRT cold or star-forming ISM phase cut (T < 8000 K or n_H > 0.13 cm^-3; Camps+16, Trcka+22,
      Baes+24 TNG50-SKIRT Atlas with THEMIS f_dust = 0.2)."""
    nH = np.asarray(n_H, dtype=np.float64)
    temp = np.asarray(T, dtype=np.float64)
    Z = np.asarray(Z_massfrac, dtype=np.float64)
    if mode == "skirt":
        phase_ok = (temp < 8000.0) | (nH > 0.13)
    else:
        phase_ok = temp < DUST_T_MAX
    ok = np.isfinite(nH) & np.isfinite(temp) & np.isfinite(Z) & (nH > 0) & (Z > 0) & phase_ok
    out = np.zeros(nH.shape, dtype=np.float64)
    out[ok] = DUST_KAPPA_COEFF * nH[ok] * ((Z[ok] / DUST_Z_REF) ** float(gamma))
    return out


def quantize_dust(kappa_v, mask=None, vmin=DUST_VMIN, vmax=DUST_VMAX) -> np.ndarray:
    """Quantize kappa_V [kpc^-1] to uint8 0..254 for log10(kappa_V) in [vmin, vmax] (0 = empty/masked or <= 0)."""
    kv = np.asarray(kappa_v, dtype=np.float64)
    with np.errstate(invalid="ignore"):
        ok = np.isfinite(kv) & (kv > 0)
    if mask is not None:
        m = np.asarray(mask, dtype=bool)
        ok &= (~m if VP is _LocalVizpack else m)
    q = np.zeros(kv.shape, dtype=np.uint8)
    if np.any(ok):
        s = (np.log10(kv[ok]) - float(vmin)) / (float(vmax) - float(vmin)) * 253.0
        q[ok] = np.clip(1.0 + np.rint(s), 1, 254).astype(np.uint8)
    return q


def dequantize_dust(q_dust, vmin=DUST_VMIN, vmax=DUST_VMAX) -> np.ndarray:
    """Inverse of quantize_dust: uint8 0..254 -> log10(kappa_V [kpc^-1]); NaN where q_dust == 0 or 255."""
    q = np.asarray(q_dust)
    out = float(vmin) + (q.astype(np.float64) - 1.0) * (float(vmax) - float(vmin)) / 253.0
    out[(q == 0) | (q >= 255)] = np.nan
    return out


_DUST_CELL_CACHE: dict = {}


def build_dust_level(level, *, gas_cache=None, cutout=None, workers=1, n=None, lock=None, mode: str = "skirt") -> np.ndarray:
    """Compute 3D dust opacity cube kappa_V [kpc^-1] (n,n,n) float64 for star level S0..S4.
    Uses pre-deposited L0..L4 gas cubes (nH, T, Z) from gas_cache when available, else scatters cold/warm gas cells
    from gas_cache/cells_*.npy or PartType0 of cutout."""
    n = int(n or N)
    glevel = "L" + str(level)[1:]
    mask = level_mask(level, n)
    if gas_cache is not None:
        gc = Path(gas_cache)
        p_nh, p_t, p_z = gc / f"{glevel}_nH.npy", gc / f"{glevel}_T.npy", gc / f"{glevel}_Z.npy"
        if p_nh.is_file() and p_t.is_file() and p_z.is_file():
            nH = np.load(p_nh).astype(np.float64)
            T = np.load(p_t).astype(np.float64)
            Z = np.load(p_z).astype(np.float64) * getattr(VP, "Z_SUN", 0.0127)
            if nH.shape == (n, n, n):
                kv = kappa_v_from_gas(nH, T, Z, mode=mode)
                if mask is not None:
                    kv = np.where(mask, 0.0, kv)
                return kv
        c_paths = {k: gc / f"cells_{k}.npy" for k in ("pos_disk", "h", "V_cm3", "nH", "T", "Z")}
        if all(p.is_file() for p in c_paths.values()):
            pos_disk = np.load(c_paths["pos_disk"])
            h_kpc = np.load(c_paths["h"])
            v_kpc3 = np.load(c_paths["V_cm3"]) / (float(GALAXY["CM_PER_KPC"]) ** 3)
            kv_cell = kappa_v_from_gas(np.load(c_paths["nH"]), np.load(c_paths["T"]),
                                       np.load(c_paths["Z"]) * getattr(VP, "Z_SUN", 0.0127), mode=mode)
            nz = kv_cell > 0
            grid = level_grid(level, n)
            if np.any(nz):
                heff = np.maximum(h_kpc[nz], 1.25 * grid.dx)
                dep = D.scatter(pos_disk[nz], heff, {"tau_v": kv_cell[nz] * v_kpc3[nz]}, grid, workers=workers)
                kv = dep.grids["tau_v"] / (grid.dx ** 3)
            else:
                kv = np.zeros((n, n, n), dtype=np.float64)
            if mask is not None:
                kv = np.where(mask, 0.0, kv)
            return kv
    if cutout is not None and Path(cutout).is_file():
        ckey = (str(Path(cutout).resolve()), mode)
        if ckey not in _DUST_CELL_CACHE:
            import h5py
            with heavy_lock(lock):
                with h5py.File(str(cutout), "r") as fh:
                    if "PartType0" in fh:
                        g0 = fh["PartType0"]
                        h_hub = float(GALAXY["TNG_H"])
                        x_kpc = g0["Coordinates"][()].astype(np.float64) / h_hub
                        m_msun = g0["Masses"][()].astype(np.float64) * 1e10 / h_hub
                        rho_code = g0["Density"][()].astype(np.float64)
                        v_kpc3 = m_msun / (rho_code * 1e10 * h_hub * h_hub)
                        rho_cgs = rho_code * (1e10 * 1.98847e33 / h_hub) / (3.0856775814913673e21 / h_hub) ** 3
                        xH = (g0["GFM_Metals"][:, 0].astype(np.float64) if "GFM_Metals" in g0 else np.full(m_msun.size, 0.75))
                        nH = rho_cgs * np.clip(xH, 0.5, 0.76) / 1.6735575e-24
                        u = g0["InternalEnergy"][()].astype(np.float64) * 1e10
                        xe = g0["ElectronAbundance"][()].astype(np.float64) if "ElectronAbundance" in g0 else np.ones_like(u)
                        mu = 4.0 / (1.0 + 3.0 * np.clip(xH, 0.5, 0.76) + 4.0 * np.clip(xH, 0.5, 0.76) * xe)
                        T = (5.0 / 3.0 - 1.0) * u * mu * 1.6735575e-24 / 1.380649e-16
                        Z = (g0["GFM_Metallicity"][()].astype(np.float64) if "GFM_Metallicity" in g0
                             else g0["Metallicity"][:, 0].astype(np.float64))
                        h_kpc = 2.0 * (3.0 * v_kpc3 / (4.0 * math.pi)) ** (1.0 / 3.0)
                        kv_cell = kappa_v_from_gas(nH, T, Z, mode=mode)
                        nz = kv_cell > 0
                        _DUST_CELL_CACHE[ckey] = (D.to_disk(x_kpc[nz]), h_kpc[nz], (kv_cell[nz] * v_kpc3[nz]))
                    else:
                        _DUST_CELL_CACHE[ckey] = None
        cached = _DUST_CELL_CACHE.get(ckey)
        if cached is not None and cached[0].shape[0] > 0:
            p_nz, h_nz, tau_nz = cached
            grid = level_grid(level, n)
            heff = np.maximum(h_nz, 1.25 * grid.dx)
            dep = D.scatter(p_nz, heff, {"tau_v": tau_nz}, grid, workers=workers)
            kv = dep.grids["tau_v"] / (grid.dx ** 3)
            if mask is not None:
                kv = np.where(mask, 0.0, kv)
            return kv
    return np.zeros((n, n, n), dtype=np.float64)


def build_level(arr, level, workers=1, n=None, progress=None):
    """One scatter of the three band luminosities onto `level` → ({band: L_AB0 kpc^-3 (n,n,n) float64}, result).

    The DepositResult grids are the unmasked per-voxel totals (used for the conservation check); the returned
    densities have the level mask applied (S0: r > 400 kpc → 0)."""
    grid = level_grid(level, n)
    h_eff = np.maximum(np.asarray(arr["h_kpc"], dtype=np.float64), star_h_min_vox(level) * grid.dx)
    qs = {QUANTITY[b]: arr[f"l_{b}"] for b in CHANNELS}
    dep = D.scatter(arr["pos_disk"], h_eff, qs, grid, workers=workers, progress=progress)
    vol = grid.dx ** 3
    mask = level_mask(level, grid.n)
    cubes = {}
    for b in CHANNELS:
        c = dep.grids[QUANTITY[b]] / vol
        if mask is not None:
            c = np.where(mask, 0.0, c)
        cubes[b] = c
    return cubes, dep


def conservation(dep) -> dict:
    """|Σ grid − Σ ℓ·f| / Σ ℓ·f per band, plus the lost fraction q_lost/(q_in + q_lost)."""
    out = {}
    for b in CHANNELS:
        k = QUANTITY[b]
        s = float(np.sum(dep.grids[k]))
        qi = float(dep.q_in[k])
        out[b] = {"sum_grid": s, "q_in": qi, "cons_rel": abs(s - qi) / qi if qi > 0 else 0.0,
                  "lost_fraction": float(dep.q_lost[k] / (dep.q_in[k] + dep.q_lost[k]))
                  if dep.q_in[k] + dep.q_lost[k] > 0 else 0.0}
    return out


def project(cube_by_band, axis, half) -> dict:
    """Surface brightness maps Σ_b = Σ_k ρ_b·Δ [L_AB0 kpc^-2] summed along cube axis `axis` (0 = i, 1 = j, 2 = k).

    NaN voxels (decoded empties) count as 0. The remaining axes keep their order: axis 2 → [i, j], axis 0 → [j, k]."""
    out = {}
    for b, c in cube_by_band.items():
        c = np.asarray(c, dtype=np.float64)
        n = c.shape[axis]
        out[b] = np.nansum(c, axis=axis) * (2.0 * float(half) / n)
    return out


def surface_brightness_mag(S) -> np.ndarray:
    """μ [mag arcsec^-2] of Σ [L_AB0 kpc^-2] (inf where Σ ≤ 0)."""
    S = np.asarray(S, dtype=np.float64)
    with np.errstate(divide="ignore"):
        return np.where(S > 0, MU_ZERO - 2.5 * np.log10(np.where(S > 0, S, 1.0)), np.inf)


# ============================================================================== 4. encode + write
def encode_level(cubes, level, n=None, dust=None):
    """§2.3 star rule → (vmin, vmax, {band: q uint8}); masked voxels q = 0. Optional `dust` (kappa_V [kpc^-1] cube)
    or `cubes['dust']` is quantized into `q['dust']` (uint8 0..254)."""
    n = int(n or N)
    mask = level_mask(level, n)
    keep = _keep(mask)
    vmin, vmax = VP.star_range([cubes[b] for b in CHANNELS], keep)
    q = {b: VP.quantize(cubes[b], keep, vmin, vmax) for b in CHANNELS}
    dust_arr = dust if dust is not None else cubes.get("dust")
    if dust_arr is not None:
        q["dust"] = quantize_dust(dust_arr, keep)
    return vmin, vmax, q


def rgba_raw(q, q_dust=None) -> bytes:
    """§2.2 star raw: 4n³ bytes, RGBA per voxel, x-fastest: R = q_i, G = q_r, B = q_g, A = 255 if any > 0 (or q_dust
    uint8 0..254 when dust opacity is packed into .a)."""
    qd = q.get("dust") if q_dust is None and isinstance(q, dict) else q_dust
    if qd is None:
        return VP.raw_stars(q["i"], q["r"], q["g"])
    return VP.raw_stars(q["i"], q["r"], q["g"], q_dust=qd)


def cube_stats(cube_r, q_r) -> dict:
    """CUBE.stats (log10 L_AB0 kpc^-3 over the valid voxels of the r channel; p01 = 1st percentile)."""
    ok = q_r > 0
    lv = np.log10(np.asarray(cube_r, dtype=np.float64)[ok])
    if lv.size == 0:
        return {"frac_empty": 1.0, "p01": 0.0, "p50": 0.0, "p99": 0.0, "max": 0.0}
    p01, p50, p99 = np.percentile(lv, [1.0, 50.0, 99.0])
    return {"frac_empty": float(1.0 - ok.mean()), "p01": round(float(p01), 4), "p50": round(float(p50), 4),
            "p99": round(float(p99), 4), "max": round(float(lv.max()), 4)}


def _encode_part(img):
    return VP.encode_webp(img)


def write_level(viz_dir, level, cubes, dep, *, dust=None, workers=1, n=None, pool=None, log=print) -> dict:
    """Encode one level and write ``stars/<S>/gri.<id12>.p0-3.webp`` + ``.rgba.gz`` → CUBE entry (§3.3)."""
    n = int(n or N)
    t = time.time()
    vmin, vmax, q = encode_level(cubes, level, n, dust=dust)
    raw = rgba_raw(q)
    has_dust = "dust" in q and q["dust"] is not None
    stack_ch = [q["i"], q["r"], q["g"], q["dust"]] if has_dust else [q["i"], q["r"], q["g"]]
    parts = VP.atlas_parts(np.stack(stack_ch, axis=-1))
    qi, ql = float(dep.q_in[QUANTITY["r"]]), float(dep.q_lost[QUANTITY["r"]])
    deposit = {"n_elements": int(dep.n_elements), "n_straddling": int(dep.n_straddling),
               "lost_fraction": ql / (qi + ql) if qi + ql > 0 else 0.0, "seconds": round(float(dep.seconds), 3),
               "workers": int(dep.meta.get("workers", workers))}
    kw = {}
    if pool is not None:                         # vizpack and the stand-in both accept pre-encoded parts
        kw["webp"] = list(pool.map(_encode_part, parts))
    cube = VP.write_cube(viz_dir, f"stars/{level}", "gri", raw, parts, kind="stars", vmin=vmin, vmax=vmax,
                         stats=cube_stats(cubes["r"], q["r"]), deposit=deposit, **kw)
    # the published WebP parts must decode back to the raw bytes exactly (§2.4), and so must the gz fallback
    dec = [VP.decode_webp((Path(viz_dir) / p).read_bytes()) for p in cube["webp"]["paths"]]
    if hashlib.sha256(VP.atlas_to_raw(dec, n, 4 if has_dust else 3)).hexdigest() != cube["raw_sha256"]:
        raise RuntimeError(f"{level}: WebP round trip does not reproduce the raw bytes")
    decode_cube_gz(viz_dir, cube)
    if log:
        wb = sum(cube["webp"]["bytes"])
        log(f"[{level}] range [{vmin}, {vmax}]  webp {wb / 1e6:.2f} MB  gz {cube['gz']['bytes'] / 1e6:.2f} MB  "
            f"encode {time.time() - t:.1f}s")
    return cube


def level_entry(level, n=None) -> dict:
    n = int(n or N)
    half = _half_kpc(level)
    r = VP.R_MASK_KPC.get(level)
    return {"half_kpc": half, "n": n, "voxel_kpc": 2.0 * half / n, "r_mask_kpc": None if r is None else float(r)}


def generator_block() -> dict:
    import numpy
    import PIL
    from PIL import features
    return {"deposit": D.GENERATOR, "vizpack": getattr(VP, "GENERATOR", "tngsight.vizpack/1"), "stars": GENERATOR,
            "pillow": PIL.__version__, "libwebp": str(features.version("webp")), "numpy": numpy.__version__}


def fragment(cubes: dict, n=None) -> dict:
    """``stars/manifest_stars.json`` = {"schema", "generator", "levels" (S*), "stars"} (§3.3)."""
    order = [s for s in _ordered_star_levels() if s in cubes]
    return {"schema": VP.SCHEMA, "generator": generator_block(),
            "levels": {s: level_entry(s, n) for s in order},
            "stars": {"levels": order, "bands": list(CHANNELS),
                      "units": "L_AB0 kpc^-3 (L_AB0 = luminosity of an M_AB = 0 source)",
                      "photometry": "GFM_StellarPhotometrics columns i=6 r=5 g=4",
                      "exclude": "GFM_StellarFormationTime <= 0",
                      "display": dict(DISPLAY),
                      "cubes": {s: cubes[s] for s in order}}}


def decode_cube_gz(viz_dir, cube) -> dict:
    """Read a written star cube back from its .rgba.gz (sha256-checked) → {band: q (n,n,n) uint8 [i,j,k]}."""
    raw = gzip.decompress((Path(viz_dir) / cube["gz"]["path"]).read_bytes())
    if hashlib.sha256(raw).hexdigest() != cube["raw_sha256"]:
        raise ValueError("raw sha256 mismatch")
    n = round((len(raw) // 4) ** (1 / 3))
    a = np.frombuffer(raw, dtype=np.uint8).reshape(n, n, n, 4).transpose(2, 1, 0, 3)
    return {"i": a[..., 0], "r": a[..., 1], "g": a[..., 2], "a": a[..., 3]}


def decoded_density(q, vmin, vmax) -> np.ndarray:
    """q → linear L_AB0 kpc^-3 (0 where q == 0)."""
    lv = VP.dequantize(q, vmin, vmax)
    return np.where(np.isnan(lv), 0.0, 10.0 ** np.nan_to_num(lv, nan=0.0))
