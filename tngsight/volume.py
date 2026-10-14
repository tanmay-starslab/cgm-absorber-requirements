"""256³ gas volumes around sub-488530 for the 3D viewer (Phase-2 design §3).

Box-axis-aligned cube ±HALF_KPC physical kpc around GALAXY["center_kpc"], SPH-deposited from the slim cutout
with yt `arbitrary_grid` on the dataset of `tngsight.generate.Generator.load()` (same metallicity override and
`trident.add_ion_fields` table as the rays). Values are stored as log10 → uint8:

    q = clip(1 + round((log10 v − lo)/(hi − lo)·254), 1, 255);  q = 0 = empty (r > R_MASK_KPC, v ≤ 0, NaN)
    log10 v = lo + (q − 1)(hi − lo)/254                         (max decode error (hi − lo)/508 dex)

Arrays are indexed [i,j,k] = (x,y,z); the byte stream is x-fastest (index i + n(j + n k)), the layout
`THREE.Data3DTexture(data, n, n, n)` expects. Files: `<key>.u8.gz` (n³) and `<key>.<n/2>.u8.gz` (2× downsample),
gzip level 9 with mtime 0 and no file name (deterministic), plus `manifest.json`. yt is imported only by callers
of `deposit` (it takes a loaded dataset).
"""
from __future__ import annotations
import gzip
import hashlib
import io
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
from .config import GALAXY

VOL_VERSION = 1
GENERATOR = f"tngsight.volume/{VOL_VERSION}"
HALF_KPC = 400.0
R_MASK_KPC = 400.0
Z_SUN = 0.0127                 # TNG convention (Asplund+09 bulk)
VOL_KEYS = ("nH", "T", "Z", "OVI", "HI", "CIII")
CMAPS = ("viridis", "magma", "inferno", "cividis", "grey")
CM_PER_KPC = GALAXY["CM_PER_KPC"]
H = GALAXY["TNG_H"]
CENTER_KPC = np.array(GALAXY["center_kpc"], float)

FIELDS: dict = {
    "nH": {"field": ("gas", "H_nuclei_density"), "fallback": ("gas", "H_number_density"), "units": "cm**-3",
           "unit_label": "cm^-3", "label": "n_H", "scale": 1.0, "cmap": "viridis", "normalize": False},
    "T": {"field": ("gas", "temperature"), "units": "K", "unit_label": "K", "label": "T", "scale": 1.0,
          "cmap": "inferno", "normalize": True},
    "Z": {"field": ("gas", "metallicity"), "units": "", "unit_label": "Zsun", "label": "Z", "scale": 1.0 / Z_SUN,
          "cmap": "cividis", "normalize": True},
    "OVI": {"field": ("gas", "O_p5_number_density"), "units": "cm**-3", "unit_label": "cm^-3", "label": "n(O VI)",
            "scale": 1.0, "cmap": "magma", "normalize": False},
    "HI": {"field": ("gas", "H_p0_number_density"), "units": "cm**-3", "unit_label": "cm^-3", "label": "n(H I)",
           "scale": 1.0, "cmap": "viridis", "normalize": False},
    "CIII": {"field": ("gas", "C_p2_number_density"), "units": "cm**-3", "unit_label": "cm^-3",
             "label": "n(C III)", "scale": 1.0, "cmap": "magma", "normalize": False},
}

ORDER = "x-fastest: index = i + n*(j + n*k); voxel centre = -half_kpc + (i + 0.5) * voxel_kpc"
FRAME = "box axes; physical kpc relative to galaxy.center_kpc"
ENCODING = {"type": "log10-u8", "empty": 0, "q_min": 1, "q_max": 255,
            "decode": "log10(v) = lo + (q - 1) * (hi - lo) / 254"}
_GAL_KEYS = ("subhalo_id", "TNG_H", "center_kpc", "R200c_kpc", "Lhat", "xhat", "yhat", "SubhaloVel_kms")
_FIELD_KEYS = ("label", "units", "source", "lo", "hi", "cmap", "default_window", "files", "bytes", "raw_bytes",
               "sha256", "stats")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


# ------------------------------------------------------------------------------- geometry
def grid_edges(n=256, half_kpc=HALF_KPC) -> dict:
    """Cube edges in box-absolute code_length (ckpc/h at z=0 = kpc·TNG_H) and the voxel size in kpc."""
    return {"left_code": ((CENTER_KPC - half_kpc) * H).tolist(), "right_code": ((CENTER_KPC + half_kpc) * H).tolist(),
            "voxel_kpc": 2.0 * half_kpc / n, "dims": [int(n)] * 3}


def voxel_centers(n, half_kpc=HALF_KPC) -> np.ndarray:
    """1-D voxel centres (kpc, relative to the centre): x_i = −half + (i + 0.5)·voxel."""
    vox = 2.0 * half_kpc / n
    return -half_kpc + (np.arange(n) + 0.5) * vox


def radial_mask(n, half_kpc=HALF_KPC, r_kpc=R_MASK_KPC) -> np.ndarray:
    """bool (n,n,n) indexed [i,j,k] = (x,y,z): True where the voxel centre lies at r ≤ r_kpc."""
    c = voxel_centers(n, half_kpc)
    r2 = c[:, None, None] ** 2 + c[None, :, None] ** 2 + c[None, None, :] ** 2
    return r2 <= r_kpc * r_kpc


# ------------------------------------------------------------------------------- deposition (yt)
def field_source(ds, key) -> tuple:
    """The yt field deposited for `key` (nH falls back to H_number_density when H_nuclei_density is absent)."""
    f = FIELDS[key]
    if "fallback" in f and f["field"] not in ds.derived_field_list:
        return f["fallback"]
    return f["field"]


def deposit_field(ds, field, units, n=256, half_kpc=HALF_KPC, normalize=False) -> np.ndarray:
    """SPH-deposit any yt field on the n³ arbitrary grid; float64 (n,n,n) [i,j,k] = (x,y,z) in `units`.

    normalize: yt's use_sph_normalization (divide by the kernel sum Σ m_j/ρ_j W_ij). It is right for intensive
    fields (T, Z), but for extensive densities it point-samples a renormalised interpolant that misses sub-voxel
    gas: at 256³ it biased H I columns by −0.24…−0.31 dex and Σρ dV by −8…−14 % (fix-backend amendment to §3.1;
    raw: H I −0.09…−0.21 dex, mass +0.7…+3 %). Extensive fields therefore use normalize=False (FIELDS)."""
    e = grid_edges(n, half_kpc)
    ds.use_sph_normalization = bool(normalize)
    ag = ds.arbitrary_grid(ds.arr(e["left_code"], "code_length"), ds.arr(e["right_code"], "code_length"),
                           dims=(n, n, n))
    v = ag[tuple(field)]
    v = v.to(units) if units else v.to("dimensionless")
    return np.asarray(v.d, dtype=np.float64).reshape(n, n, n)


def deposit(ds, key, n=256, half_kpc=HALF_KPC) -> np.ndarray:
    """Deposit volume field `key` (FIELDS units, times its scale) -> float64 (n,n,n) [i,j,k] = (x,y,z)."""
    f = FIELDS[key]
    return deposit_field(ds, field_source(ds, key), f["units"], n, half_kpc, normalize=f["normalize"]) * f["scale"]


# ------------------------------------------------------------------------------- encoding
def _valid(values, mask):
    v = np.asarray(values, dtype=np.float64)
    with np.errstate(invalid="ignore"):
        ok = np.isfinite(v) & (v > 0)
    return ok if mask is None else ok & np.asarray(mask, bool)


def _snap(x, fn):
    return round(fn(round(x * 10.0, 6)) / 10.0, 1)        # round(·,6) guards 0.1-dex values against fp jitter


def choose_range(values, mask) -> tuple:
    """(lo, hi) in log10: floor/ceil to 0.1 dex of the 0.5 / 99.99 percentiles of log v over valid voxels."""
    ok = _valid(values, mask)
    if not ok.any():
        return (0.0, 1.0)
    lv = np.log10(np.asarray(values, np.float64)[ok])
    lo = _snap(float(np.percentile(lv, 0.5)), math.floor)
    hi = _snap(float(np.percentile(lv, 99.99)), math.ceil)
    if hi <= lo:
        hi = round(lo + 0.1, 1)
    return (lo, hi)


def quantize(values, mask, lo, hi) -> np.ndarray:
    """uint8 (n,n,n) [i,j,k]: 0 = empty, else clip(1 + round((log v − lo)/(hi − lo)·254), 1, 255)."""
    v = np.asarray(values, np.float64)
    ok = _valid(v, mask)
    q = np.zeros(v.shape, np.uint8)
    s = (np.log10(v[ok]) - lo) / (hi - lo) * 254.0
    q[ok] = np.clip(1.0 + np.rint(s), 1, 255).astype(np.uint8)
    return q


def encode_u8(values, mask, lo, hi) -> bytes:
    """x-fastest flattened uint8 bytes, length n³ (byte i + n(j + n k) = voxel [i,j,k])."""
    return quantize(values, mask, lo, hi).transpose(2, 1, 0).tobytes()


def decode_u8(buf, n, lo, hi) -> np.ndarray:
    """log10 values (n,n,n) [i,j,k] from x-fastest bytes; NaN where q == 0."""
    q = np.frombuffer(bytes(buf), np.uint8)
    if q.size != n ** 3:
        raise ValueError(f"expected {n ** 3} bytes, got {q.size}")
    q = q.reshape(n, n, n).transpose(2, 1, 0)
    out = lo + (q.astype(np.float64) - 1.0) * (hi - lo) / 254.0
    out[q == 0] = np.nan
    return out


def downsample2(values, mask) -> tuple:
    """2× downsample: mean of the valid (masked-in, finite) children of each 2³ block; mask = any valid child.
    Blocks without a valid child are NaN. -> (values (n/2)³, mask (n/2)³)."""
    v = np.asarray(values, np.float64)
    n = v.shape[0]
    if v.shape != (n, n, n) or n % 2:
        raise ValueError(f"need an even cube, got {v.shape}")
    ok = np.isfinite(v) & (True if mask is None else np.asarray(mask, bool))
    m = n // 2
    w = ok.reshape(m, 2, m, 2, m, 2).sum(axis=(1, 3, 5))
    s = np.where(ok, v, 0.0).reshape(m, 2, m, 2, m, 2).sum(axis=(1, 3, 5))
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(w > 0, s / np.maximum(w, 1), np.nan)
    return mean, w > 0


def gzip_bytes(raw: bytes) -> bytes:
    """gzip level 9, mtime 0, no file name -> byte-identical for identical input."""
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=buf, mtime=0) as g:
        g.write(raw)
    return buf.getvalue()


# ------------------------------------------------------------------------------- column sampling (validation)
def integrate_column(values, p0_kpc, p1_kpc, half_kpc=HALF_KPC, step_vox=0.5) -> float:
    """log10 ∫ n dl [cm^-2] along the straight segment p0 → p1 (kpc relative to the centre), trilinear sampling
    of the linear (n,n,n) grid at step_vox·voxel steps (midpoint rule). NaN samples count as 0; -inf if zero."""
    from scipy.ndimage import map_coordinates
    v = np.nan_to_num(np.asarray(values, np.float64), nan=0.0)
    n = v.shape[0]
    vox = 2.0 * half_kpc / n
    p0, p1 = np.asarray(p0_kpc, float), np.asarray(p1_kpc, float)
    L = float(np.linalg.norm(p1 - p0))
    m = max(1, int(math.ceil(L / (step_vox * vox))))
    t = (np.arange(m) + 0.5) / m
    pts = p0[None, :] + t[:, None] * (p1 - p0)[None, :]
    idx = (pts + half_kpc) / vox - 0.5
    s = map_coordinates(v, idx.T, order=1, mode="nearest")
    N = float(s.sum() * (L / m) * CM_PER_KPC)
    return math.log10(N) if N > 0 else -math.inf


# ------------------------------------------------------------------------------- files + manifest
def _sha(b):
    return hashlib.sha256(b).hexdigest()


def _atomic(path: Path, data: bytes):
    tmp = path.with_name(f".{path.name}.{os.getpid()}.part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def file_names(key, n) -> dict:
    return {str(n): f"{key}.u8.gz", str(n // 2): f"{key}.{n // 2}.u8.gz"}


def write_field(out_dir, key, values, mask, lo=None, hi=None, source=None) -> dict:
    """Write `<key>.u8.gz` (n³) and `<key>.<n/2>.u8.gz` (downsample2, same lo/hi) into out_dir; returns the
    manifest field entry. lo/hi default to choose_range over the full-resolution valid voxels."""
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    v = np.asarray(values, np.float64)
    n = v.shape[0]
    mask = np.ones(v.shape, bool) if mask is None else np.asarray(mask, bool)
    if lo is None or hi is None:
        lo, hi = choose_range(v, mask)
    lo, hi = float(lo), float(hi)
    f = FIELDS.get(key, {"label": key, "unit_label": "", "cmap": "grey", "field": ("gas", key)})
    names = file_names(key, n)
    ds_v, ds_m = downsample2(v, mask)
    entry = {"label": f["label"], "units": f["unit_label"], "source": source or str(tuple(f["field"])),
             "lo": lo, "hi": hi, "cmap": f["cmap"], "default_window": None,
             "files": names, "bytes": {}, "raw_bytes": {}, "sha256": {}, "stats": None}
    q_full = None
    for res, (vv, mm) in ((str(n), (v, mask)), (str(n // 2), (ds_v, ds_m))):
        q = quantize(vv, mm, lo, hi)
        if q_full is None:
            q_full = q
        raw = q.transpose(2, 1, 0).tobytes()
        gz = gzip_bytes(raw)
        _atomic(out / names[res], gz)
        entry["bytes"][res] = len(gz); entry["raw_bytes"][res] = len(raw); entry["sha256"][res] = _sha(gz)
    ok = _valid(v, mask)
    lv = np.log10(v[ok]) if ok.any() else np.array([lo])
    p01, p50, p99 = (float(np.percentile(lv, p)) for p in (1, 50, 99))
    entry["stats"] = {"p01": round(p01, 3), "p50": round(p50, 3), "p99": round(p99, 3),
                      "frac_empty": round(float((q_full == 0).mean()), 4)}
    w0 = min(max(round(p50 - 1.0, 1), lo), hi); w1 = min(max(round(p99, 1), lo), hi)
    if w1 <= w0:
        w0, w1 = lo, hi
    entry["default_window"] = [round(w0, 1), round(w1, 1)]
    return entry


def galaxy_meta() -> dict:
    return {k: GALAXY[k] for k in _GAL_KEYS}


def write_manifest(out_dir, fields: dict, meta: dict) -> dict:
    """Assemble + validate + write `<out_dir>/manifest.json`. `fields` = {key: write_field entry}; `meta` may
    override any top-level key (e.g. "created", "half_kpc", "nH_source") and must give "n" (full grid size)
    unless every field entry's files reveal it."""
    meta = dict(meta or {})
    n = int(meta.pop("n", 0)) or max(int(r) for e in fields.values() for r in e["files"])
    half = float(meta.pop("half_kpc", HALF_KPC))
    order = [k for k in VOL_KEYS if k in fields] + [k for k in fields if k not in VOL_KEYS]
    obj = {"version": VOL_VERSION, "generator": GENERATOR,
           "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "galaxy": galaxy_meta(), "frame": FRAME, "half_kpc": half,
           "r_mask_kpc": float(meta.pop("r_mask_kpc", R_MASK_KPC)), "z_sun": Z_SUN, "order": ORDER,
           "encoding": dict(ENCODING),
           "grids": {str(n): {"n": n, "voxel_kpc": 2 * half / n}, str(n // 2): {"n": n // 2, "voxel_kpc": 4 * half / n}},
           "fields": {k: fields[k] for k in order}}
    obj.update(meta)
    validate_manifest(obj)
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    _atomic(out / "manifest.json", (json.dumps(obj, indent=1) + "\n").encode())
    return obj


def load_manifest(path) -> dict:
    p = Path(path)
    if p.is_dir():
        p = p / "manifest.json"
    obj = json.loads(p.read_text())
    validate_manifest(obj)
    return obj


def validate_manifest(obj, base_dir=None) -> None:
    """Raise ValueError unless `obj` follows design §3.3; with base_dir also check every file's size + sha256."""
    def need(cond, msg):
        if not cond:
            raise ValueError(f"manifest: {msg}")
    need(isinstance(obj, dict), "not an object")
    for k in ("version", "generator", "created", "galaxy", "frame", "half_kpc", "r_mask_kpc", "z_sun", "order",
              "encoding", "grids", "fields"):
        need(k in obj, f"missing {k!r}")
    need(obj["version"] == VOL_VERSION, f"version {obj['version']!r}")
    need(obj["encoding"] == ENCODING, "encoding block differs")
    need(all(k in obj["galaxy"] for k in _GAL_KEYS), "galaxy block incomplete")
    for k in ("center_kpc", "Lhat", "xhat", "yhat", "SubhaloVel_kms"):
        need(len(obj["galaxy"][k]) == 3, f"galaxy.{k} not a 3-vector")
    grids = obj["grids"]
    need(isinstance(grids, dict) and grids, "grids empty")
    for r, g in grids.items():
        need(str(g.get("n")) == r and g["n"] > 0, f"grid {r!r} n mismatch")
        need(abs(g["voxel_kpc"] - 2 * obj["half_kpc"] / g["n"]) < 1e-9, f"grid {r!r} voxel_kpc")
    need(isinstance(obj["fields"], dict) and obj["fields"], "fields empty")
    for key, e in obj["fields"].items():
        for k in _FIELD_KEYS:
            need(k in e, f"{key}: missing {k!r}")
        lo, hi = e["lo"], e["hi"]
        need(all(isinstance(x, (int, float)) and math.isfinite(x) for x in (lo, hi)) and lo < hi, f"{key}: lo/hi")
        need(e["cmap"] in CMAPS, f"{key}: cmap {e['cmap']!r}")
        w = e["default_window"]
        need(len(w) == 2 and lo <= w[0] < w[1] <= hi, f"{key}: default_window {w!r}")
        for blk in ("files", "bytes", "raw_bytes", "sha256"):
            need(set(e[blk]) == set(grids), f"{key}: {blk} keys {sorted(e[blk])} != grids {sorted(grids)}")
        for r in grids:
            need(e["raw_bytes"][r] == grids[r]["n"] ** 3, f"{key}: raw_bytes[{r}]")
            need(isinstance(e["bytes"][r], int) and e["bytes"][r] > 0, f"{key}: bytes[{r}]")
            need(bool(_HEX64.match(e["sha256"][r])), f"{key}: sha256[{r}]")
            need("/" not in e["files"][r] and e["files"][r].endswith(".u8.gz"), f"{key}: file name")
        need(all(k in e["stats"] for k in ("p01", "p50", "p99", "frac_empty")), f"{key}: stats")
        if base_dir is not None:
            for r, name in e["files"].items():
                p = Path(base_dir) / name
                need(p.is_file(), f"{key}: {name} missing")
                b = p.read_bytes()
                need(len(b) == e["bytes"][r], f"{key}: {name} size {len(b)} != {e['bytes'][r]}")
                need(_sha(b) == e["sha256"][r], f"{key}: {name} sha256 mismatch")
