"""Shared encoding, atlas, manifest and shader-emulation code for the Phase-2b 3D cubes (design-2b §2, §3.2, D13).

One implementation for the gas build (`tngsight.volume`), the star build (`tngsight.stars`), the JS fixtures, the
exporter and the uploader:

- `log10-u8` encoding (§2.3): q = 0 empty, q = 1 + rint((log10 v − vmin)/(vmax − vmin)·254) clipped to [1, 255];
  vmin/vmax snapped to 0.1 dex; gas range shared by L0–L2, star range shared by the 3 channels of a level.
- byte layout (§2.2): x-fastest, index = i + n·(j + n·k); stars RGBA with A = 255 where any of R, G, B > 0.
- WebP lossless z-slice atlases (§2.4): 4 parts of 16n × 4n px, slice k in part k // 64, tile (s % 16, s // 16).
- deterministic gzip fallback (§2.5) and content-hashed names (§2.6).
- `manifest_v2.json` (§3.3): `merge` combines the gas and star fragments; `validate_manifest_v2` checks every key
  and type and, with `base_dir`, every file's size and SHA-256.
- `column_from_u8` emulates the viewer's exact integral path (§5.5); `lupton_rgb` is the §4.5 star composite.

Mask convention: every `mask` argument and `radial_mask` use **True = the voxel may hold data** (kept); voxels where
the mask is False are encoded as q = 0. `None` means unmasked.

numpy, scipy-free, PIL only for WebP; no yt.

CLI:  python -m tngsight.vizpack merge <viz_dir>   |   python -m tngsight.vizpack validate <viz_dir>
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import math
import os
import re
import sys
import time
from pathlib import Path

import numpy as np

from .config import GALAXY

SCHEMA = "tng50-viz/2"
VIZPACK_VERSION = 1
GENERATOR = "tngsight.vizpack/1"
N = 256
GAS_LEVELS = {"L0": 400.0, "L1": 100.0, "L2": 25.0}
STAR_LEVELS = {"S0": 400.0, "S1": 100.0, "S2": 25.0}
R_MASK_KPC = {"L0": 400.0, "S0": 400.0}
VOL_KEYS = ("nH", "T", "Z", "OVI", "HI", "CIII")
Z_SUN = 0.0127
M_P_G = 1.67262192369e-24
CM_PER_KPC = GALAXY["CM_PER_KPC"]
MU_ZERO = 5 * math.log10(100 * 206264.80624709636)        # 36.57212566588 mag arcsec^-2 of 1 L_AB0 / kpc^2
BANDS = {"g": 4, "r": 5, "i": 6}
LUT_NAMES = ("tng_dusk", "tng_ice", "magma", "inferno", "viridis", "cividis", "grey")
PARTS, SLICES_PER_PART, COLS, ROWS = 4, 64, 16, 4


# ============================================================================== geometry
def voxel_centers(n, half) -> np.ndarray:
    dx = 2.0 * float(half) / int(n)
    return -float(half) + (np.arange(int(n)) + 0.5) * dx


def radial_mask(n, half, r_kpc) -> np.ndarray:
    """bool (n,n,n) [i,j,k]: True where the voxel centre lies at r ≤ r_kpc (the voxel may hold data)."""
    c = voxel_centers(n, half)
    r2 = c[:, None, None] ** 2 + c[None, :, None] ** 2 + c[None, None, :] ** 2
    return r2 <= float(r_kpc) ** 2


# ============================================================================== §2.3 encoding
def snap_down(x) -> float:
    return math.floor(round(10.0 * float(x), 6)) / 10.0


def snap_up(x) -> float:
    return math.ceil(round(10.0 * float(x), 6)) / 10.0


def _valid(values, mask) -> np.ndarray:
    v = np.asarray(values, dtype=np.float64)
    with np.errstate(invalid="ignore"):
        ok = np.isfinite(v) & (v > 0)
    if mask is not None:
        ok &= np.asarray(mask, dtype=bool)
    return ok


def _range(arrays, masks) -> tuple:
    lo, hi = [], []
    for v, m in zip(arrays, masks):
        ok = _valid(v, m)
        if not ok.any():
            continue
        lv = np.log10(np.asarray(v, dtype=np.float64)[ok])
        lo.append(float(np.percentile(lv, 0.5)))
        hi.append(float(lv.max()))
    if not lo:
        raise ValueError("no valid voxel")
    vmin, vmax = snap_down(min(lo)), snap_up(max(hi))
    if vmax <= vmin:
        vmax = round(vmin + 0.1, 1)
    return vmin, vmax


def gas_range(level_values, level_masks) -> tuple:
    """§2.3 gas rule: vmin = snap_down(min over levels of p0.5 of log v), vmax = snap_up(max of log v), valid only."""
    masks = list(level_masks) if level_masks is not None else [None] * len(level_values)
    return _range(list(level_values), masks)


def star_range(channels, mask) -> tuple:
    """§2.3 star rule: the gas formulas over the three channels of one level (shared mask)."""
    return _range(list(channels), [mask] * len(channels))


def quantize(values, mask, vmin, vmax) -> np.ndarray:
    v = np.asarray(values, dtype=np.float64)
    ok = _valid(v, mask)
    q = np.zeros(v.shape, dtype=np.uint8)
    s = (np.log10(v[ok]) - vmin) / (vmax - vmin) * 254.0
    q[ok] = np.clip(1.0 + np.rint(s), 1, 255).astype(np.uint8)
    return q


def dequantize(q, vmin, vmax) -> np.ndarray:
    q = np.asarray(q)
    out = vmin + (q.astype(np.float64) - 1.0) * (vmax - vmin) / 254.0
    out[q == 0] = np.nan
    return out


# ============================================================================== §2.2 raw bytes
def raw_gas(q3) -> bytes:
    return np.ascontiguousarray(np.asarray(q3, dtype=np.uint8).transpose(2, 1, 0)).tobytes()


def raw_stars(q_i, q_r, q_g) -> bytes:
    q_i, q_r, q_g = (np.asarray(x, dtype=np.uint8) for x in (q_i, q_r, q_g))
    a = np.where((q_i > 0) | (q_r > 0) | (q_g > 0), 255, 0).astype(np.uint8)
    return np.ascontiguousarray(np.stack([q_i, q_r, q_g, a], axis=-1).transpose(2, 1, 0, 3)).tobytes()


# ============================================================================== §2.4 atlases
def atlas_parts(q) -> list:
    """(n,n,n) uint8 [i,j,k] → 4 arrays (4n, 16n); (n,n,n,3) → 4 arrays (4n, 16n, 3). Pixel (x = c·n + i,
    y = r·n + j) of part p holds voxel (i, j, k) with k = 64p + s, c = s % 16, r = s // 16."""
    q = np.asarray(q, dtype=np.uint8)
    n = q.shape[0]
    parts = []
    for p in range(PARTS):
        img = np.zeros((ROWS * n, COLS * n) + q.shape[3:], dtype=np.uint8)
        for s in range(SLICES_PER_PART):
            k = SLICES_PER_PART * p + s
            if k >= n:
                break
            c, r = s % COLS, s // COLS
            img[r * n:(r + 1) * n, c * n:(c + 1) * n] = np.swapaxes(q[:, :, k], 0, 1)
        parts.append(img)
    return parts


def atlas_to_raw(parts, n, channels) -> bytes:
    """Inverse of `atlas_parts` → raw bytes (§2.2). channels = 1 (gas; a decoded RGB/RGBA image uses channel 0) or 3
    (stars; A rebuilt by the §2.2 rule). Mirrors the JS decoder."""
    n = int(n)
    q = np.zeros((n, n, n) if channels == 1 else (n, n, n, 3), dtype=np.uint8)
    for k in range(n):
        p, s = divmod(k, SLICES_PER_PART)
        c, r = s % COLS, s // COLS
        a = np.asarray(parts[p])
        if channels == 1 and a.ndim == 3:
            a = a[..., 0]
        elif channels == 3 and a.ndim == 3 and a.shape[2] > 3:
            a = a[..., :3]
        q[:, :, k] = np.swapaxes(a[r * n:(r + 1) * n, c * n:(c + 1) * n], 0, 1)
    if channels == 1:
        return raw_gas(q)
    return raw_stars(q[..., 0], q[..., 1], q[..., 2])


def encode_webp(img) -> bytes:
    from PIL import Image
    a = np.ascontiguousarray(img, dtype=np.uint8)
    mode = "L" if a.ndim == 2 else "RGB"
    buf = io.BytesIO()
    Image.fromarray(a, mode).save(buf, "WEBP", lossless=True, quality=100, method=6, exact=True)
    return buf.getvalue()


def decode_webp(b) -> np.ndarray:
    """WebP bytes → uint8 array in the file's own mode (2-D for grey, (h,w,3) for RGB)."""
    from PIL import Image
    with Image.open(io.BytesIO(b)) as im:
        im.load()
        return np.asarray(im)


# ============================================================================== §2.5 gzip, §2.6 files
def gzip_bytes(raw) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=buf, mtime=0) as g:
        g.write(raw)
    return buf.getvalue()


def _sha(b) -> str:
    return hashlib.sha256(b).hexdigest()


def _atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def write_cube(out_root, rel_dir, stem, raw: bytes, parts, *, kind, vmin, vmax, stats: dict, deposit: dict,
               webp=None) -> dict:
    """Write the 4 WebP parts and the gzip raw of one cube under out_root/rel_dir with §2.6 names → CUBE (§3.3).

    `parts` are atlas arrays (encoded here) or already-encoded WebP bytes; `webp` (optional) overrides them with
    pre-encoded bytes (e.g. from a process pool)."""
    if kind not in ("gas", "stars"):
        raise ValueError(f"write_cube: kind must be 'gas' or 'stars', not {kind!r}")
    raw_sha = _sha(raw)
    id12 = raw_sha[:12]
    root = Path(out_root)
    blobs = list(webp) if webp is not None else [
        bytes(p) if isinstance(p, (bytes, bytearray)) else encode_webp(p) for p in parts]
    if len(blobs) != PARTS:
        raise ValueError(f"write_cube: expected {PARTS} parts, got {len(blobs)}")
    w = {"paths": [], "bytes": [], "sha256": []}
    for p, b in enumerate(blobs):
        rel = f"{rel_dir}/{stem}.{id12}.p{p}.webp"
        _atomic(root / rel, b)
        w["paths"].append(rel)
        w["bytes"].append(len(b))
        w["sha256"].append(_sha(b))
    gz = gzip_bytes(raw)
    grel = f"{rel_dir}/{stem}.{id12}.{'rgba' if kind == 'stars' else 'u8'}.gz"
    _atomic(root / grel, gz)
    return {"vmin": float(vmin), "vmax": float(vmax), "raw_bytes": len(raw), "raw_sha256": raw_sha, "webp": w,
            "gz": {"path": grel, "bytes": len(gz), "sha256": _sha(gz)}, "stats": dict(stats),
            "deposit": dict(deposit)}


# ============================================================================== shader emulation, composite
def column_from_u8(q3, vmin, vmax, half, p0, p1, spv=1.0, jitter=0.5) -> float:
    """Viewer exact-path emulation (§5.5): step Δ/spv from p0, first sample at jitter·dt, linear-space trilinear
    interpolation of 10^decode over 8 clamp-to-edge neighbours, q = 0 → 0; samples outside the box add 0.
    Returns log10 Σ v·dt·CM_PER_KPC (−inf when empty)."""
    q = np.asarray(q3)
    n = q.shape[0]
    half = float(half)
    dx = 2.0 * half / n
    p0 = np.asarray(p0, dtype=np.float64)
    p1 = np.asarray(p1, dtype=np.float64)
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
    for ox in (0, 1):
        for oy in (0, 1):
            for oz in (0, 1):
                ii = np.clip(i0 + np.array([ox, oy, oz]), 0, n - 1)
                w = ((fr[:, 0] if ox else 1 - fr[:, 0]) * (fr[:, 1] if oy else 1 - fr[:, 1])
                     * (fr[:, 2] if oz else 1 - fr[:, 2]))
                tot += w * lin[ii[:, 0], ii[:, 1], ii[:, 2]]
    s = float(tot.sum() * dt * CM_PER_KPC)
    return math.log10(s) if s > 0 else -np.inf


def lupton_rgb(S_i, S_r, S_g, Q=8.0, mu0=21.5, balance=(1.0, 1.0, 1.0)) -> np.ndarray:
    """§4.5 composite of surface brightnesses [L_AB0 kpc^-2] → uint8 (..., 3) sRGB-encoded (no extra gamma)."""
    s0 = 10.0 ** (0.4 * (MU_ZERO - mu0))
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


# ============================================================================== §3.3 manifest
_HEX64 = re.compile(r"[0-9a-f]{64}")


def _galaxy_block() -> dict:
    return {k: GALAXY[k] for k in ("sim", "snapshot", "redshift", "subhalo_id", "TNG_H", "center_kpc", "R200c_kpc",
                                   "Lhat", "xhat", "yhat", "SubhaloVel_kms")}


def constant_blocks() -> dict:
    """The manifest blocks `merge` fills from constants (§3.3)."""
    rows = [list(GALAXY["xhat"]), list(GALAXY["yhat"]), list(GALAXY["Lhat"])]
    return {
        "galaxy": _galaxy_block(),
        "frame": {"name": "disk", "origin": "galaxy.center_kpc", "units": "physical kpc", "rows": rows,
                  "definition": "d = R (x_box_kpc - center_kpc); cube axes (i,j,k) = (x_d, y_d, z_d), z_d along Lhat"},
        "order": "x-fastest: index = i + n*(j + n*k); voxel centre = -half_kpc + (i + 0.5) * voxel_kpc",
        "kernel": {"name": "cubic_spline", "support": "h", "h_gas": "2.0*(3*m/(4*pi*rho))**(1/3)",
                   "h_stars": "StellarHsml/TNG_H", "h_min_voxels": 1.0, "h_min_voxels_gas": 2.0, "k_max": 16,
                   "prolongation": "conservative minmod-linear"},
        "encoding": {"type": "log10-u8", "empty": 0, "q_min": 1, "q_max": 255,
                     "decode": "log10(v) = vmin + (q - 1) * (vmax - vmin) / 254",
                     "clamp_low": "q = 1 also encodes v < 10^vmin"},
        "formats": {
            "webp": {"parts": 4, "slices_per_part": 64, "cols": 16, "rows": 4, "part_px": [4096, 1024],
                     "map": "part p, slice k = 64p + s; pixel (x = (s % 16)*n + i, y = floor(s / 16)*n + j)",
                     "gas_channels": "R=G=B=q", "star_channels": "R=q_i G=q_r B=q_g", "lossless": True},
            "gz": {"gzip": "level 9, mtime 0, no name", "gas_raw": "n^3 bytes",
                   "star_raw": "4 n^3 bytes RGBA, A = 255 if R|G|B else 0"}},
    }


def _num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _vec(x, n) -> bool:
    return isinstance(x, list) and len(x) == n and all(_num(v) for v in x)


def _file_ok(base: Path, rel: str, size: int, sha: str) -> str | None:
    p = base / rel
    if not p.is_file():
        return f"{rel}: missing"
    if p.stat().st_size != size:
        return f"{rel}: size {p.stat().st_size} != {size}"
    if _sha(p.read_bytes()) != sha:
        return f"{rel}: sha256 mismatch"
    return None


def validate_manifest_v2(obj, base_dir=None, *, sections=("gas", "stars")) -> None:
    """Raise ValueError unless `obj` is a §3.3 manifest. With base_dir, every listed file must exist there with
    its recorded size and SHA-256. `sections` = the cube sections required (the builds validate a one-section
    temporary manifest around their own fragment; the published manifest always needs both)."""
    def bad(where, what):
        raise ValueError(f"manifest_v2: {where}: {what}")

    def need(o, where, spec):
        if not isinstance(o, dict):
            bad(where, "missing or not an object")
        for k, t in spec:
            if k not in o:
                bad(f"{where}.{k}", "missing")
            if not t(o[k]):
                bad(f"{where}.{k}", f"wrong type or value {o[k]!r:.80}")

    isstr = lambda x: isinstance(x, str) and bool(x)          # noqa: E731
    isobj = lambda x: isinstance(x, dict)                      # noqa: E731
    if not isinstance(obj, dict):
        bad("root", "not an object")
    if obj.get("schema") != SCHEMA:
        bad("schema", f"expected {SCHEMA!r}, got {obj.get('schema')!r}")
    sections = tuple(sections)
    need(obj, "root", [("created", isstr), ("generator", isobj), ("galaxy", isobj), ("frame", isobj),
                       ("order", isstr), ("kernel", isobj), ("encoding", isobj), ("formats", isobj),
                       ("levels", isobj)] + [(k, isobj) for k in sections])
    need(obj["generator"], "generator", [(k, isstr) for k in ("deposit", "vizpack", "pillow", "libwebp", "numpy")
                                         + sections])
    need(obj["galaxy"], "galaxy", [("sim", isstr), ("snapshot", _int), ("redshift", _num), ("subhalo_id", _int),
                                   ("TNG_H", _num), ("center_kpc", lambda x: _vec(x, 3)), ("R200c_kpc", _num),
                                   ("Lhat", lambda x: _vec(x, 3)), ("xhat", lambda x: _vec(x, 3)),
                                   ("yhat", lambda x: _vec(x, 3)), ("SubhaloVel_kms", lambda x: _vec(x, 3))])
    need(obj["frame"], "frame", [("name", lambda x: x == "disk"), ("origin", isstr), ("units", isstr),
                                 ("rows", lambda x: isinstance(x, list) and len(x) == 3
                                  and all(_vec(r, 3) for r in x)), ("definition", isstr)])
    need(obj["kernel"], "kernel", [("name", lambda x: x == "cubic_spline"), ("h_min_voxels", _num),
                                   ("k_max", _int), ("prolongation", isstr)])
    need(obj["encoding"], "encoding", [("type", lambda x: x == "log10-u8"), ("empty", lambda x: x == 0),
                                       ("q_min", lambda x: x == 1), ("q_max", lambda x: x == 255), ("decode", isstr)])
    need(obj["formats"], "formats", [("webp", isobj), ("gz", isobj)])
    need(obj["formats"]["webp"], "formats.webp", [("parts", lambda x: x == 4), ("slices_per_part", lambda x: x == 64),
                                                  ("cols", lambda x: x == 16), ("rows", lambda x: x == 4),
                                                  ("lossless", lambda x: x is True)])
    levels = obj["levels"]
    for L, lv in levels.items():
        if L not in GAS_LEVELS and L not in STAR_LEVELS:
            bad(f"levels.{L}", "unknown level")
        need(lv, f"levels.{L}", [("half_kpc", _num), ("n", lambda x: _int(x) and x > 0), ("voxel_kpc", _num),
                                 ("r_mask_kpc", lambda x: x is None or _num(x))])
        exp_half = GAS_LEVELS.get(L, STAR_LEVELS.get(L))
        if lv["half_kpc"] != exp_half:
            bad(f"levels.{L}.half_kpc", f"{lv['half_kpc']} != {exp_half}")
        if abs(lv["voxel_kpc"] - 2.0 * lv["half_kpc"] / lv["n"]) > 1e-12 * lv["half_kpc"]:
            bad(f"levels.{L}.voxel_kpc", "!= 2*half_kpc/n")
        if lv["r_mask_kpc"] != R_MASK_KPC.get(L):
            bad(f"levels.{L}.r_mask_kpc", f"{lv['r_mask_kpc']} != {R_MASK_KPC.get(L)}")
    files = []

    def cube(c, where, kind, L, stem, fvmin=None, fvmax=None):
        need(c, where, [("vmin", _num), ("vmax", _num), ("raw_bytes", _int), ("raw_sha256",
                        lambda x: isinstance(x, str) and bool(_HEX64.fullmatch(x))), ("webp", isobj), ("gz", isobj),
                        ("stats", isobj), ("deposit", isobj)])
        if not c["vmax"] > c["vmin"]:
            bad(where, "vmax <= vmin")
        if fvmin is not None and (c["vmin"] != fvmin or c["vmax"] != fvmax):
            bad(where, "cube vmin/vmax differ from the field's")
        if L not in levels:
            bad(where, f"level {L} not in levels")
        n = levels[L]["n"]
        if c["raw_bytes"] != (4 if kind == "stars" else 1) * n ** 3:
            bad(f"{where}.raw_bytes", f"{c['raw_bytes']} != {'4·' if kind == 'stars' else ''}{n}^3")
        w = c["webp"]
        need(w, f"{where}.webp", [("paths", lambda x: isinstance(x, list) and len(x) == 4),
                                  ("bytes", lambda x: isinstance(x, list) and len(x) == 4 and all(map(_int, x))),
                                  ("sha256", lambda x: isinstance(x, list) and len(x) == 4
                                   and all(isinstance(s, str) and _HEX64.fullmatch(s) for s in x))])
        need(c["gz"], f"{where}.gz", [("path", isstr), ("bytes", _int),
                                      ("sha256", lambda x: isinstance(x, str) and bool(_HEX64.fullmatch(x)))])
        id12 = c["raw_sha256"][:12]
        for p in range(4):
            if w["paths"][p] != f"{stem}.{id12}.p{p}.webp":
                bad(f"{where}.webp.paths[{p}]", f"expected {stem}.{id12}.p{p}.webp")
        if c["gz"]["path"] != f"{stem}.{id12}.{'rgba' if kind == 'stars' else 'u8'}.gz":
            bad(f"{where}.gz.path", "does not follow the §2.6 naming")
        need(c["stats"], f"{where}.stats", [(k, _num) for k in ("frac_empty", "p01", "p50", "p99", "max")])
        need(c["deposit"], f"{where}.deposit", [("n_elements", _int), ("n_straddling", _int),
                                                ("lost_fraction", _num), ("seconds", _num), ("workers", _int)])
        files.extend(zip(w["paths"], w["bytes"], w["sha256"]))
        files.append((c["gz"]["path"], c["gz"]["bytes"], c["gz"]["sha256"]))

    if "gas" in sections or "gas" in obj:
        _validate_gas(obj["gas"], need, bad, cube, isstr, isobj)
    if "stars" in sections or "stars" in obj:
        _validate_stars(obj["stars"], need, bad, cube, isstr, isobj)
    if "luts" in obj:
        need(obj["luts"], "luts", [("path", lambda x: x == "luts/luts.json"),
                                   ("sha256", lambda x: isinstance(x, str) and bool(_HEX64.fullmatch(x))),
                                   ("names", lambda x: isinstance(x, list) and all(isinstance(s, str) for s in x))])
    if base_dir is not None:
        base = Path(base_dir)
        errs = [e for e in (_file_ok(base, *f) for f in files) if e]
        if "luts" in obj:
            p = base / obj["luts"]["path"]
            if not p.is_file() or _sha(p.read_bytes()) != obj["luts"]["sha256"]:
                errs.append(f"{obj['luts']['path']}: missing or sha256 mismatch")
        if errs:
            bad("files", "; ".join(errs[:5]) + (f" (+{len(errs) - 5} more)" if len(errs) > 5 else ""))


def _validate_gas(gas, need, bad, cube, isstr, isobj):
    need(gas, "gas", [("levels", lambda x: isinstance(x, list) and len(x) > 0 and all(L in GAS_LEVELS for L in x)),
                      ("fields", lambda x: isinstance(x, dict) and len(x) > 0)])
    for k, f in gas["fields"].items():
        w = f"gas.fields.{k}"
        if k not in VOL_KEYS:
            bad(w, "unknown field")
        need(f, w, [("label", isstr), ("units", lambda x: isinstance(x, str)),
                    ("kind", lambda x: x in ("density", "mass_weighted")),
                    ("source", isstr), ("vmin", _num), ("vmax", _num), ("cmap", lambda x: x in LUT_NAMES),
                    ("proj", isobj), ("vol_window", lambda x: _vec(x, 2)), ("cubes", isobj)])
        if not f["vmax"] > f["vmin"]:
            bad(w, "vmax <= vmin")
        pr = f["proj"]
        need(pr, f"{w}.proj", [("kind", lambda x: x == ("column" if f["kind"] == "density" else "weighted_mean")),
                               ("units", isstr), ("vmin", _num), ("vmax", _num)])
        if not pr["vmax"] > pr["vmin"]:
            bad(f"{w}.proj", "vmax <= vmin")
        if pr["kind"] == "weighted_mean" and pr.get("weight") != "nH":
            bad(f"{w}.proj.weight", "must be 'nH'")
        vw = f["vol_window"]
        if not (vw[0] < vw[1] and vw[1] == f["vmax"]):
            bad(f"{w}.vol_window", f"{vw} (must be [lo, vmax], lo < vmax)")
        if set(f["cubes"]) != set(gas["levels"]):
            bad(f"{w}.cubes", f"{sorted(f['cubes'])} != gas.levels {gas['levels']}")
        for L in gas["levels"]:
            cube(f["cubes"][L], f"{w}.cubes.{L}", "gas", L, f"gas/{L}/{k}", f["vmin"], f["vmax"])


def _validate_stars(st, need, bad, cube, isstr, isobj):
    need(st, "stars", [("levels", lambda x: isinstance(x, list) and len(x) > 0 and all(L in STAR_LEVELS for L in x)),
                       ("bands", lambda x: x == ["i", "r", "g"]), ("units", isstr), ("photometry", isstr),
                       ("exclude", isstr), ("display", isobj), ("cubes", isobj)])
    need(st["display"], "stars.display", [("Q", _num), ("mu0", _num), ("mu_zero", _num),
                                          ("balance", lambda x: _vec(x, 3)), ("formula", isstr)])
    if set(st["cubes"]) != set(st["levels"]):
        bad("stars.cubes", f"{sorted(st['cubes'])} != stars.levels {st['levels']}")
    for L in st["levels"]:
        cube(st["cubes"][L], f"stars.cubes.{L}", "stars", L, f"stars/{L}/gri")


def merge(viz_dir) -> dict:
    """gas/manifest_gas.json + stars/manifest_stars.json (+ luts/luts.json if present) → viz_dir/manifest_v2.json
    (validated against the files in viz_dir), returned."""
    viz = Path(viz_dir)
    g = json.loads((viz / "gas" / "manifest_gas.json").read_text())
    s = json.loads((viz / "stars" / "manifest_stars.json").read_text())
    for name, fr, key in (("gas", g, "gas"), ("stars", s, "stars")):
        if fr.get("schema") != SCHEMA or key not in fr or "levels" not in fr:
            raise ValueError(f"merge: {name} fragment is not a {SCHEMA} fragment")
    gen = {}
    for fr in (g, s):
        gen.update(fr.get("generator", {}))
    gen["vizpack"] = GENERATOR
    for k, v in (("gas", g.get("generator", {}).get("gas")), ("stars", s.get("generator", {}).get("stars"))):
        if v:
            gen[k] = v
    gen = {k: str(gen[k]) for k in ("deposit", "vizpack", "gas", "stars", "pillow", "libwebp", "numpy") if k in gen}
    man = {"schema": SCHEMA, "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "generator": gen}
    man.update(constant_blocks())
    lv = {}
    for L in list(GAS_LEVELS) + list(STAR_LEVELS):
        src = g["levels"].get(L) if L in GAS_LEVELS else s["levels"].get(L)
        if src is not None:
            lv[L] = src
    man["levels"] = lv
    man["gas"] = g["gas"]
    man["stars"] = s["stars"]
    lp = viz / "luts" / "luts.json"
    if lp.is_file():
        d = json.loads(lp.read_text())
        man["luts"] = {"path": "luts/luts.json", "sha256": _sha(lp.read_bytes()), "names": list(d.get("luts", {}))}
    validate_manifest_v2(man, base_dir=viz)
    _atomic(viz / "manifest_v2.json", (json.dumps(man, indent=1) + "\n").encode())
    return man


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2 or argv[0] not in ("merge", "validate"):
        print("usage: python -m tngsight.vizpack merge|validate <viz_dir>", file=sys.stderr)
        return 2
    viz = Path(argv[1])
    try:
        if argv[0] == "merge":
            man = merge(viz)
        else:
            man = json.loads((viz / "manifest_v2.json").read_text())
            validate_manifest_v2(man, base_dir=viz)
    except (OSError, ValueError, KeyError) as exc:
        print(f"{argv[0]}: FAILED: {exc}", file=sys.stderr)
        return 1
    nfiles = 5 * sum(len(f["cubes"]) for f in man["gas"]["fields"].values()) + 5 * len(man["stars"]["cubes"])
    tot = sum(sum(c["webp"]["bytes"]) + c["gz"]["bytes"] for f in man["gas"]["fields"].values()
              for c in f["cubes"].values())
    tot += sum(sum(c["webp"]["bytes"]) + c["gz"]["bytes"] for c in man["stars"]["cubes"].values())
    print(f"{argv[0]}: OK  {viz / 'manifest_v2.json'}  {nfiles} cube files, {tot / 1e6:.1f} MB"
          f"{'  + luts' if 'luts' in man else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
