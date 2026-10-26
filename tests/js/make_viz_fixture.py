#!/usr/bin/env python3
"""Fixtures for the Phase-2b viewer tests (design §5.11).

    python tests/js/make_viz_fixture.py --out DIR              # 16^3 test fixture (viz_decode.mjs, lupton_parity.mjs)
    python tests/js/make_viz_fixture.py --full DIR [--n 256]   # synthetic galaxy viz dir for the browser test / screenshots

--out writes a viz dir with one 16^3 gas cube (L1/nH) and one 16^3 star cube (S1), each as 4 WebP atlas parts and a
.gz, the fragment manifests gas/manifest_gas.json and stars/manifest_stars.json, a merged manifest_v2.json, the RGBA
image data of every WebP part as decoded by PIL (<part>.rgba, because node cannot decode WebP) and expect.json
(raw bytes, dequantized values, layout probes, 200 Lupton golden values).

--full writes a complete manifest_v2 viz dir (L0-L2 x 6 fields, S0-S2) of an analytic galaxy: a thin exponential
gas disk with spiral arms inside a cored halo with clumps, and a red bulge + bluer star-forming stellar disk. It is
a stand-in until the real <library>/viz (default $TNG_WORK/data/library/viz) exists; it is not simulation data.

Uses tngsight.vizpack (CORE) for quantize / dequantize / raw layout / atlas / WebP / gzip / Lupton when it is
importable; otherwise the §2.3-§2.5 and §4.5 formulas written out below ("spec-fallback").
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, features
import PIL

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
try:
    from tngsight import vizpack as VP  # noqa: E402
except Exception:  # noqa: BLE001 - CORE's vizpack may not exist yet
    VP = None

MU_ZERO = 36.57212566588
CM_PER_KPC = 3.0856775814913673e21
GAS_LEVELS = {"L0": 400.0, "L1": 100.0, "L2": 25.0}
STAR_LEVELS = {"S0": 400.0, "S1": 100.0, "S2": 25.0}
VOL_KEYS = ("nH", "T", "Z", "OVI", "HI", "CIII")
FIELD_META = {
    "nH": ("n_H", "cm^-3", "density", "tng_dusk"), "T": ("T", "K", "mass_weighted", "inferno"),
    "Z": ("Z", "Zsun", "mass_weighted", "cividis"), "OVI": ("O VI", "cm^-3", "density", "magma"),
    "HI": ("H I", "cm^-3", "density", "tng_ice"), "CIII": ("C III", "cm^-3", "density", "viridis")}


# ---------------------------------------------------------------- §2.3-§2.5, §4.5 (vizpack when available)
def snap_down(x):
    return math.floor(round(10 * x, 6)) / 10


def snap_up(x):
    return math.ceil(round(10 * x, 6)) / 10


def quantize(v, mask, vmin, vmax):
    if VP is not None:
        return VP.quantize(v, mask, vmin, vmax)
    with np.errstate(divide="ignore", invalid="ignore"):
        lg = np.log10(v)
    q = np.clip(1 + np.rint((lg - vmin) / (vmax - vmin) * 254), 1, 255)
    bad = ~np.isfinite(lg) | ~(v > 0)
    if mask is not None:
        bad |= ~mask
    q[bad] = 0
    return q.astype(np.uint8)


def dequantize(q, vmin, vmax):
    if VP is not None:
        return VP.dequantize(q, vmin, vmax)
    out = vmin + (q.astype(np.float64) - 1) * (vmax - vmin) / 254
    out[q == 0] = np.nan
    return out


def raw_gas(q3):
    return VP.raw_gas(q3) if VP is not None else np.ascontiguousarray(q3).transpose(2, 1, 0).tobytes()


def raw_stars(qi, qr, qg):
    if VP is not None:
        return VP.raw_stars(qi, qr, qg)
    a = np.stack([qi, qr, qg, np.where((qi | qr | qg) > 0, 255, 0).astype(np.uint8)], axis=-1)
    return a.transpose(2, 1, 0, 3).tobytes()


def atlas_parts(q):
    """q: (n,n,n) [i,j,k] uint8 or (n,n,n,3). -> 4 arrays (4n, 16n[, 3]) per §2.4."""
    if VP is not None:
        return VP.atlas_parts(q)
    n = q.shape[0]
    parts = [np.zeros((4 * n, 16 * n) + q.shape[3:], np.uint8) for _ in range(4)]
    for k in range(n):
        p, s = divmod(k, 64)
        c, r = s % 16, s // 16
        parts[p][r * n:(r + 1) * n, c * n:(c + 1) * n] = q[:, :, k].swapaxes(0, 1)   # row y = j, column x = i
    return parts


def encode_webp(img, method=6):
    if VP is not None and method == 6:
        return VP.encode_webp(img)
    buf = io.BytesIO()
    Image.fromarray(img, "L" if img.ndim == 2 else "RGB").save(buf, "WEBP", lossless=True, quality=100, method=method, exact=True)
    return buf.getvalue()


def gzip_bytes(raw):
    if VP is not None:
        return VP.gzip_bytes(raw)
    bio = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=bio, mtime=0) as f:
        f.write(raw)
    return bio.getvalue()


def lupton_rgb(Si, Sr, Sg, Q=8.0, mu0=21.5, balance=(1.0, 1.0, 1.0)):
    if VP is not None:
        return VP.lupton_rgb(Si, Sr, Sg, Q=Q, mu0=mu0, balance=balance)
    S0 = 10 ** (0.4 * (MU_ZERO - mu0))
    R, G, B = (np.asarray(x, np.float64) * b / S0 for x, b in zip((Si, Sr, Sg), balance))
    I = (R + G + B) / 3
    with np.errstate(divide="ignore", invalid="ignore"):
        F = np.where(I > 0, np.arcsinh(Q * I) / (Q * I), 0.0)
    rgb = np.stack([R * F, G * F, B * F], axis=-1)
    m = rgb.max(axis=-1, keepdims=True)
    rgb = np.where(m > 1, rgb / np.where(m > 1, m, 1), rgb)
    return np.floor(255 * rgb + 0.5).astype(np.uint8)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def write_cube(root: Path, rel: str, stem: str, raw: bytes, parts, kind, vmin, vmax, stats, method=6):
    id12 = sha(raw)[:12]
    d = root / rel
    d.mkdir(parents=True, exist_ok=True)
    paths, sizes, hashes = [], [], []
    for p, img in enumerate(parts):
        b = encode_webp(img, method)
        name = f"{stem}.{id12}.p{p}.webp"
        (d / name).write_bytes(b)
        paths.append(f"{rel}/{name}"), sizes.append(len(b)), hashes.append(sha(b))
    gz = gzip_bytes(raw)
    gname = f"{stem}.{id12}.{'rgba' if kind == 'stars' else 'u8'}.gz"
    (d / gname).write_bytes(gz)
    return {"vmin": vmin, "vmax": vmax, "raw_bytes": len(raw), "raw_sha256": sha(raw),
            "webp": {"paths": paths, "bytes": sizes, "sha256": hashes},
            "gz": {"path": f"{rel}/{gname}", "bytes": len(gz), "sha256": sha(gz)},
            "stats": stats, "deposit": {"n_elements": 0, "n_straddling": 0, "lost_fraction": 0.0, "seconds": 0.0, "workers": 1}}


def stats_of(q, vmin, vmax):
    v = dequantize(q, vmin, vmax)
    v = v[np.isfinite(v)]
    if v.size == 0:
        return {"frac_empty": 1.0, "p01": vmin, "p50": vmin, "p99": vmin, "max": vmin}
    return {"frac_empty": float(1 - v.size / q.size), "p01": float(np.percentile(v, 1)), "p50": float(np.percentile(v, 50)),
            "p99": float(np.percentile(v, 99)), "max": float(v.max())}


GALAXY = json.loads((Path(__file__).resolve().parents[2] / "tngsight" / "galaxy_488530.json").read_text())


def merged(levels, gas, stars):
    g = GALAXY
    gal = {"sim": "TNG50-1", "snapshot": 99, "redshift": 0.0, "subhalo_id": int(g.get("subhalo_id", 488530)),
           "TNG_H": 0.6774, "center_kpc": list(g["center_kpc"]), "R200c_kpc": float(g["R200c_kpc"]),
           "Lhat": list(g["Lhat"]), "xhat": list(g["xhat"]), "yhat": list(g["yhat"]),
           "SubhaloVel_kms": list(g.get("SubhaloVel_kms", [0.0, 0.0, 0.0]))}
    return {"schema": "tng50-viz/2", "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "generator": {"fixture": "tests/js/make_viz_fixture.py", "vizpack": "tngsight.vizpack/1" if VP else "spec-fallback",
                          "pillow": PIL.__version__, "libwebp": str(features.version("webp")), "numpy": np.__version__},
            "galaxy": gal,
            "frame": {"name": "disk", "origin": "galaxy.center_kpc", "units": "physical kpc", "rows": [gal["xhat"], gal["yhat"], gal["Lhat"]],
                      "definition": "d = R (x_box_kpc - center_kpc); cube axes (i,j,k) = (x_d, y_d, z_d), z_d along Lhat"},
            "order": "x-fastest: index = i + n*(j + n*k); voxel centre = -half_kpc + (i + 0.5) * voxel_kpc",
            "kernel": {"name": "cubic_spline", "support": "h", "h_gas": "2.0*(3*m/(4*pi*rho))**(1/3)", "h_stars": "StellarHsml/TNG_H",
                       "h_min_voxels": 1.0, "k_max": 16, "prolongation": "conservative minmod-linear"},
            "encoding": {"type": "log10-u8", "empty": 0, "q_min": 1, "q_max": 255,
                         "decode": "log10(v) = vmin + (q - 1) * (vmax - vmin) / 254", "clamp_low": "q = 1 also encodes v < 10^vmin"},
            "formats": {"webp": {"parts": 4, "slices_per_part": 64, "cols": 16, "rows": 4, "part_px": [4096, 1024],
                                 "map": "part p, slice k = 64p + s; pixel (x = (s % 16)*n + i, y = floor(s / 16)*n + j)",
                                 "gas_channels": "R=G=B=q", "star_channels": "R=q_i G=q_r B=q_g", "lossless": True},
                        "gz": {"gzip": "level 9, mtime 0, no name", "gas_raw": "n^3 bytes", "star_raw": "4 n^3 bytes RGBA, A = 255 if R|G|B else 0"}},
            "levels": levels, "gas": gas, "stars": stars}


def level_entry(half, n, mask):
    return {"half_kpc": half, "n": n, "voxel_kpc": 2 * half / n, "r_mask_kpc": mask}


def star_display():
    return {"Q": 8.0, "mu0": 21.5, "mu_zero": MU_ZERO, "balance": [1.0, 1.0, 1.0], "formula": "lupton2004"}


# ---------------------------------------------------------------- 16^3 test fixture
def small(out: Path) -> int:
    n = 16
    out.mkdir(parents=True, exist_ok=True)
    i, j, k = np.meshgrid(np.arange(n), np.arange(n), np.arange(n), indexing="ij")
    vmin, vmax = -6.0, 1.0
    vals = 10.0 ** (vmin + (vmax - vmin) * ((i + 3 * j + 7 * k) % 97) / 96.0)
    vals[0, 0, 0] = np.nan; vals[1, 0, 0] = 0.0; vals[2, 0, 0] = -1.0
    qg = quantize(vals, None, vmin, vmax)
    rawg = raw_gas(qg)
    gas_cube = write_cube(out, "gas/L1", "nH", rawg, atlas_parts(qg), "gas", vmin, vmax, stats_of(qg, vmin, vmax))
    probe = i + 7 * j + 49 * k                                         # layout probe (§3.6 vizpack 2)
    si, sr, sg = (10.0 ** (1 + 5 * ((probe + o) % 50) / 49.0) for o in (0, 11, 23))
    si[3, 0, 0] = sr[3, 0, 0] = sg[3, 0, 0] = 0.0                     # one empty star voxel -> A = 0
    svmin, svmax = 0.9, 6.1
    qi, qr, qgg = (quantize(x, None, svmin, svmax) for x in (si, sr, sg))
    raws = raw_stars(qi, qr, qgg)
    star_cube = write_cube(out, "stars/S1", "gri", raws, atlas_parts(np.stack([qi, qr, qgg], -1)), "stars", svmin, svmax,
                           stats_of(qr, svmin, svmax))
    for c in (gas_cube, star_cube):                                    # PIL-decoded RGBA image data of every part
        for p in c["webp"]["paths"]:
            im = Image.open(out / p).convert("RGBA")
            (out / (p + ".rgba")).write_bytes(np.asarray(im, np.uint8).tobytes())
    with open(out / "gas/L1/nH.bad.u8.gz", "wb") as f:
        f.write(gzip_bytes(rawg[:-5]))
    levels = {"L1": level_entry(100.0, n, None), "S1": level_entry(100.0, n, None)}
    field = {"label": "n_H", "units": "cm^-3", "kind": "density", "source": "fixture", "vmin": vmin, "vmax": vmax, "cmap": "tng_dusk",
             "proj": {"kind": "column", "units": "cm^-2", "vmin": 19.3, "vmax": 22.5}, "vol_window": [-4.3, 0.5], "cubes": {"L1": gas_cube}}
    gas = {"levels": ["L1"], "fields": {"nH": field}}
    stars = {"levels": ["S1"], "bands": ["i", "r", "g"], "units": "L_AB0 kpc^-3", "photometry": "fixture", "exclude": "fixture",
             "display": star_display(), "cubes": {"S1": star_cube}}
    (out / "gas" / "manifest_gas.json").write_text(json.dumps({"schema": "tng50-viz/2", "generator": {}, "levels": {"L1": levels["L1"]}, "gas": gas}))
    (out / "stars" / "manifest_stars.json").write_text(json.dumps({"schema": "tng50-viz/2", "generator": {}, "levels": {"S1": levels["S1"]}, "stars": stars}))
    man = merged(levels, gas, stars)
    (out / "manifest_v2.json").write_text(json.dumps(man, indent=1))
    rng = np.random.default_rng(7)                                     # 200 Lupton golden inputs (+ edge cases)
    S0 = 10 ** (0.4 * (MU_ZERO - 21.5))
    L = 10 ** rng.uniform(-3, 3.5, (200, 1)) * S0
    col = 10 ** rng.uniform(-0.4, 0.4, (200, 3))
    inp = L * col
    inp[0] = 0.0; inp[1] = [S0, S0, S0]; inp[2] = [1e4 * S0, 1e4 * S0, 1e4 * S0]; inp[3] = [1e5 * S0, 3e4 * S0, 1e4 * S0]
    lup = lupton_rgb(inp[:, 0], inp[:, 1], inp[:, 2])
    deq_g = dequantize(qg, vmin, vmax).transpose(2, 1, 0).ravel()
    (out / "expect.json").write_text(json.dumps({
        "impl": "tngsight.vizpack" if VP else "spec-fallback", "n": n,
        "gas": {"vmin": vmin, "vmax": vmax, "raw_sha256": sha(rawg), "q": list(rawg),
                "decoded": [None if not np.isfinite(x) else float(x) for x in deq_g]},
        "stars": {"vmin": svmin, "vmax": svmax, "raw_sha256": sha(raws)},
        "probe": {"i": 5, "j": 3, "k": 9, "gas_value_log10": float(np.log10(vals[5, 3, 9])),
                  "star_q": [int(qi[5, 3, 9]), int(qr[5, 3, 9]), int(qgg[5, 3, 9])]},
        "lupton": {"Q": 8.0, "mu0": 21.5, "inputs": inp.tolist(), "rgb8": lup.tolist()}}))
    print(f"wrote 16^3 viz fixture ({'tngsight.vizpack' if VP else 'spec-fallback'}) to {out}")
    return 0


# ---------------------------------------------------------------- synthetic galaxy (--full)
def _zavg_sech2(z, dz, zd):
    """Mean of sech^2(z/zd) over [z - dz/2, z + dz/2] (thin disks stay conservative on coarse voxels)."""
    return zd * (np.tanh((z + dz / 2) / zd) - np.tanh((z - dz / 2) / zd)) / dz


def galaxy_gas(half, n, mask_r):
    dx = 2 * half / n
    c = -half + (np.arange(n) + 0.5) * dx
    x, y, z = np.meshgrid(c, c, c, indexing="ij", sparse=True)
    R = np.sqrt(x * x + y * y) + 1e-6
    r = np.sqrt(x * x + y * y + z * z)
    phi = np.arctan2(y, x)
    arms = 1 + 0.7 * np.cos(2 * (phi - np.log(R / 2.0) / math.tan(math.radians(18))))
    zd = 0.25 + 0.03 * R                                                 # flaring disk
    disk = 1.5 * np.exp(-R / 4.5) * arms * _zavg_sech2(z, dx, zd) * (R < 40)
    rng = np.random.default_rng(3)
    halo = 3e-3 * (1 + (r / 12.0) ** 2) ** -1.1
    for _ in range(40):                                                  # CGM clumps / streams
        p = rng.normal(0, 90, 3)
        s = rng.uniform(4, 18)
        halo = halo + 2e-3 * rng.uniform(0.2, 1) * np.exp(-((x - p[0]) ** 2 + (y - p[1]) ** 2 + (z - p[2]) ** 2) / (2 * s * s))
    nH = disk + halo
    Th = 10 ** (5.2 + 0.6 * np.exp(-r / 150.0)) * (1 + 0 * x)
    T = (disk * 8e3 + halo * Th) / nH
    Z = (disk * 1.2 * np.exp(-R / 12) + halo * 0.25 * np.exp(-r / 200)) / nH
    lT = np.log10(T)
    OVI = nH * 4.9e-4 * Z * 0.2 * np.exp(-0.5 * ((lT - 5.45) / 0.22) ** 2) + 1e-17
    HI = nH * (disk / nH * 0.6 + (halo / nH) * 2e-6 * (1 + 10 * np.exp(-r / 30)))
    CIII = nH * 2.7e-4 * Z * (0.25 * np.exp(-0.5 * ((lT - 4.8) / 0.3) ** 2) + 1e-4)
    out = {"nH": nH, "T": T, "Z": Z, "OVI": OVI, "HI": HI, "CIII": CIII}
    m = (r <= mask_r) if mask_r else None
    return out, m


def galaxy_stars(half, n, mask_r):
    dx = 2 * half / n
    c = -half + (np.arange(n) + 0.5) * dx
    x, y, z = np.meshgrid(c, c, c, indexing="ij", sparse=True)
    R = np.sqrt(x * x + y * y) + 1e-6
    r = np.sqrt(x * x + y * y + z * z)
    phi = np.arctan2(y, x)
    arms = 1 + 0.9 * np.cos(2 * (phi - np.log(R / 2.0) / math.tan(math.radians(18)))) ** 3
    disk = 3e7 * np.exp(-R / 3.2) * _zavg_sech2(z, dx, 0.3) / 1.0
    young = 1.5e7 * np.exp(-R / 5.0) * np.clip(arms - 1, 0, None) * _zavg_sech2(z, dx, 0.12) * (R > 2.5)
    bulge = 2.0e8 * (1 + (r / 0.7) ** 2) ** -2.2
    halo = 2e3 * (1 + (r / 8) ** 2) ** -1.5
    lr = disk + young + bulge + halo
    lg = disk * 0.72 + young * 1.15 + bulge * 0.50 + halo * 0.6
    li = disk * 1.15 + young * 0.85 + bulge * 1.38 + halo * 1.3
    m = (r <= mask_r) if mask_r else None
    return {"i": li, "r": lr, "g": lg}, m


def full(out: Path, n: int, method: int) -> int:
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    levels, fields = {}, {k: {} for k in VOL_KEYS}
    data, masks = {}, {}
    for L, half in GAS_LEVELS.items():
        mask_r = 400.0 if L == "L0" else None
        levels[L] = level_entry(half, n, mask_r)
        d, m = galaxy_gas(half, n, mask_r)
        data[L], masks[L] = {k: v.astype(np.float32) for k, v in d.items()}, m
    rng = {}
    for k in VOL_KEYS:                                                    # §2.3 gas range rule, shared by L0-L2
        p05, mx = [], []
        for L in GAS_LEVELS:
            v = data[L][k]
            ok = (v > 0) & np.isfinite(v) & (masks[L] if masks[L] is not None else True)
            lv = np.log10(v[ok].astype(np.float64))
            p05.append(np.percentile(lv, 0.5)), mx.append(lv.max())
        rng[k] = (snap_down(min(p05)), snap_up(max(mx)))
    # §3.5 windows from the float cubes
    def colmap(v, axis, dx):
        return np.log10(np.maximum(v.sum(axis=axis) * dx * CM_PER_KPC, 1e-300))
    for k in VOL_KEYS:
        meta = FIELD_META[k]
        vmin, vmax = rng[k]
        if meta[2] == "density":
            p999 = []
            for L, half in GAS_LEVELS.items():
                dx = 2 * half / n
                for ax in (2, 0):
                    p999.append(np.percentile(colmap(data[L][k].astype(np.float64), ax, dx), 99.9))
            dx0 = 2 * 400.0 / n
            fo = colmap(data["L0"][k].astype(np.float64), 2, dx0)
            c0 = -400 + (np.arange(n) + 0.5) * dx0
            rr = np.hypot(*np.meshgrid(c0, c0, indexing="ij"))
            sel = fo[rr < GALAXY["R200c_kpc"]]
            proj = {"kind": "column", "units": "cm^-2", "vmin": snap_down(max(np.percentile(sel, 2), np.percentile(sel, 50) - 3.0)),
                    "vmax": snap_up(max(p999))}
        else:
            vals = []
            for L in ("L0", "L1"):
                w, X = data[L]["nH"].astype(np.float64), data[L][k].astype(np.float64)
                for ax in (2, 0):
                    vals.append(np.log10((w * X).sum(axis=ax) / np.maximum(w.sum(axis=ax), 1e-300)).ravel())
            u = np.concatenate(vals)
            u = u[np.isfinite(u)]
            proj = {"kind": "weighted_mean", "weight": "nH", "units": meta[1], "vmin": snap_down(np.percentile(u, 2)),
                    "vmax": snap_up(np.percentile(u, 99.9))}
        v1 = data["L1"][k]
        p50 = np.percentile(np.log10(v1[v1 > 0].astype(np.float64)), 50)
        fields[k] = {"label": meta[0], "units": meta[1], "kind": meta[2], "source": "synthetic fixture (not simulation data)",
                     "vmin": vmin, "vmax": vmax, "cmap": meta[3], "proj": proj, "vol_window": [snap_down(p50), vmax], "cubes": {}}
        for L in GAS_LEVELS:
            q = quantize(data[L][k].astype(np.float64), masks[L], vmin, vmax)
            fields[k]["cubes"][L] = write_cube(out, f"gas/{L}", k, raw_gas(q), atlas_parts(q), "gas", vmin, vmax, stats_of(q, vmin, vmax), method)
        print(f"  gas {k}: range [{vmin}, {vmax}], proj [{proj['vmin']}, {proj['vmax']}], vol_window {fields[k]['vol_window']}  ({time.time() - t0:.0f} s)")
    del data
    scubes = {}
    for S, half in STAR_LEVELS.items():
        mask_r = 400.0 if S == "S0" else None
        levels[S] = level_entry(half, n, mask_r)
        d, m = galaxy_stars(half, n, mask_r)
        lv = []
        for b in ("i", "r", "g"):
            v = d[b]
            ok = (v > 0) & (m if m is not None else True)
            lv.append(np.log10(v[ok]))
        vmin, vmax = snap_down(min(np.percentile(x, 0.5) for x in lv)), snap_up(max(x.max() for x in lv))
        qi, qr, qg = (quantize(d[b], m, vmin, vmax) for b in ("i", "r", "g"))
        scubes[S] = write_cube(out, f"stars/{S}", "gri", raw_stars(qi, qr, qg), atlas_parts(np.stack([qi, qr, qg], -1)), "stars",
                               vmin, vmax, stats_of(qr, vmin, vmax), method)
        print(f"  stars {S}: range [{vmin}, {vmax}]  ({time.time() - t0:.0f} s)")
    gas = {"levels": list(GAS_LEVELS), "fields": fields}
    stars = {"levels": list(STAR_LEVELS), "bands": ["i", "r", "g"], "units": "L_AB0 kpc^-3 (L_AB0 = luminosity of an M_AB = 0 source)",
             "photometry": "synthetic fixture", "exclude": "GFM_StellarFormationTime <= 0", "display": star_display(), "cubes": scubes}
    (out / "manifest_v2.json").write_text(json.dumps(merged(levels, gas, stars), indent=1))
    tot = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"wrote synthetic viz dir n={n} to {out}: {tot / 1e6:.1f} MB in {time.time() - t0:.0f} s")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--out", type=Path)
    g.add_argument("--full", type=Path)
    ap.add_argument("--n", type=int, default=256)
    ap.add_argument("--webp-method", type=int, default=1, help="libwebp effort for --full (lossless either way)")
    a = ap.parse_args(argv)
    return small(a.out) if a.out else full(a.full, a.n, a.webp_method)


if __name__ == "__main__":
    raise SystemExit(main())
