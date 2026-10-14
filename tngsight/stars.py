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
    def raw_stars(q_i, q_r, q_g):
        a = np.where((q_i > 0) | (q_r > 0) | (q_g > 0), 255, 0).astype(np.uint8)
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
        if channels == 1:
            q = np.zeros((n, n, n), dtype=np.uint8)
        else:
            q = np.zeros((n, n, n, 3), dtype=np.uint8)
        for k in range(n):
            p, s = divmod(k, 64)
            c, r = s % 16, s // 16
            q[:, :, k] = np.swapaxes(parts[p][r * n:(r + 1) * n, c * n:(c + 1) * n], 0, 1)
        if channels == 1:
            return q.transpose(2, 1, 0).tobytes()
        return _LocalVizpack.raw_stars(q[..., 0], q[..., 1], q[..., 2])

    @staticmethod
    def encode_webp(img):
        from PIL import Image
        mode = "L" if img.ndim == 2 else "RGB"
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
N = int(VP.N)
BANDS = dict(VP.BANDS)
MU_ZERO = float(VP.MU_ZERO)
DISPLAY = {"Q": 8.0, "mu0": 21.5, "mu_zero": round(MU_ZERO, 11), "balance": [1.0, 1.0, 1.0],
           "formula": "lupton2004"}


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
    phot = np.asarray(pt4["GFM_StellarPhotometrics"])[keep]
    out = {"pos_disk": D.to_disk(x_kpc),
           "h_kpc": np.asarray(pt4["StellarHsml"], dtype=np.float64)[keep] / TNG_H,
           "m": np.asarray(pt4["Masses"], dtype=np.float64)[keep] * 1e10 / TNG_H,
           "n_total": int(sft.size), "n_wind": int((~keep).sum())}
    for b in CHANNELS:
        out[f"l_{b}"] = magnitudes_to_lum(phot[:, BANDS[b]])
    return out


# ============================================================================== 3. deposit
def level_grid(level, n=None) -> D.Grid:
    return D.Grid(float(STAR_LEVELS[level]), int(n or N))


def level_mask(level, n=None):
    """Voxels emptied on this level (S0: centre r > 400 kpc) or None."""
    r = VP.R_MASK_KPC.get(level)
    if r is None:
        return None
    m = VP.radial_mask(int(n or N), float(STAR_LEVELS[level]), float(r))
    # tngsight.vizpack's radial_mask is True where a voxel is KEPT (r <= R); the stand-in's is True where emptied
    return m if VP is _LocalVizpack else ~m


def _keep(mask):
    """The emptied-voxel mask in the convention VP.quantize / VP.star_range expect."""
    if mask is None or VP is _LocalVizpack:
        return mask
    return ~mask


def build_level(arr, level, workers=1, n=None, progress=None):
    """One scatter of the three band luminosities onto `level` → ({band: L_AB0 kpc^-3 (n,n,n) float64}, result).

    The DepositResult grids are the unmasked per-voxel totals (used for the conservation check); the returned
    densities have the level mask applied (S0: r > 400 kpc → 0)."""
    grid = level_grid(level, n)
    qs = {QUANTITY[b]: arr[f"l_{b}"] for b in CHANNELS}
    dep = D.scatter(arr["pos_disk"], arr["h_kpc"], qs, grid, workers=workers, progress=progress)
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
def encode_level(cubes, level, n=None):
    """§2.3 star rule → (vmin, vmax, {band: q uint8}); masked voxels q = 0."""
    n = int(n or N)
    mask = level_mask(level, n)
    keep = _keep(mask)
    vmin, vmax = VP.star_range([cubes[b] for b in CHANNELS], keep)
    q = {b: VP.quantize(cubes[b], keep, vmin, vmax) for b in CHANNELS}
    return vmin, vmax, q


def rgba_raw(q) -> bytes:
    """§2.2 star raw: 4n³ bytes, RGBA per voxel, x-fastest: R = q_i, G = q_r, B = q_g, A = 255 if any > 0."""
    return VP.raw_stars(q["i"], q["r"], q["g"])


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


def write_level(viz_dir, level, cubes, dep, *, workers=1, n=None, pool=None, log=print) -> dict:
    """Encode one level and write ``stars/<S>/gri.<id12>.p0-3.webp`` + ``.rgba.gz`` → CUBE entry (§3.3)."""
    n = int(n or N)
    t = time.time()
    vmin, vmax, q = encode_level(cubes, level, n)
    raw = rgba_raw(q)
    parts = VP.atlas_parts(np.stack([q["i"], q["r"], q["g"]], axis=-1))
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
    if hashlib.sha256(VP.atlas_to_raw(dec, n, 3)).hexdigest() != cube["raw_sha256"]:
        raise RuntimeError(f"{level}: WebP round trip does not reproduce the raw bytes")
    decode_cube_gz(viz_dir, cube)
    if log:
        wb = sum(cube["webp"]["bytes"])
        log(f"[{level}] range [{vmin}, {vmax}]  webp {wb / 1e6:.2f} MB  gz {cube['gz']['bytes'] / 1e6:.2f} MB  "
            f"encode {time.time() - t:.1f}s")
    return cube


def level_entry(level, n=None) -> dict:
    n = int(n or N)
    half = float(STAR_LEVELS[level])
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
    order = [s for s in STAR_LEVELS if s in cubes]
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
