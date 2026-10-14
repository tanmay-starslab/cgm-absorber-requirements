"""Sightline library I/O: npz (exact generation schema), web binary, JSON catalog.

npz `cgm_sid488530_<id>.npz` members, in order: geom (JSON str), v_sys, logN_{OVI,HILyb,CIII},
then per line <key>_lambda (f4), <key>_tau (f4), <key>_rest (f8). Payload dict (load_npz) =
{"id","geom","v_sys","logN":{k},"lam":{k},"tau":{k},"rest":{k}}.
"""
from __future__ import annotations
import json
import math
import os
import re
import struct
import tempfile
import threading
from pathlib import Path
import numpy as np
from .config import C_KMS, DLAMBDA, VWIN_GEN_KMS, LINE_KEYS, LINES, GALAXY, NPZ_PREFIX
from .geometry import geom_id, custom_id, CENTER_KPC, H as TNG_H

WEB_MAGIC = b"TNGS"
WEB_VERSION = 1
_HDR = struct.Struct("<4sBBH")
_LINE = struct.Struct("<Idddd")
_SEED_RE = re.compile(r"_s(\d+)$")


def _grid(key):
    """(lo, hi, n) of the generation grid: Trident's lambda_field for rest(1 ∓ 1500/c), dλ=0.002."""
    rest = LINES[key]["rest_A"]
    lam_min = rest * (1 - VWIN_GEN_KMS / C_KMS); lam_max = rest * (1 + VWIN_GEN_KMS / C_KMS)
    lo = round(lam_min / DLAMBDA) * DLAMBDA; hi = round(lam_max / DLAMBDA) * DLAMBDA
    return lo, hi, int(round((hi - lo) / DLAMBDA + 1))


def wavelength_grid(key) -> np.ndarray:
    lo, hi, n = _grid(key)
    return np.linspace(lo, hi, n).astype(np.float32)


def npz_name(id) -> str:
    return f"{NPZ_PREFIX}{id}.npz"


def save_npz(path, geom: dict, logN: dict, taus: dict) -> None:
    """Write with np.savez_compressed in the exact generation key order. `path` may be a file object;
    a filesystem path is written atomically (tmp + os.replace)."""
    payload = dict(geom=json.dumps(geom), v_sys=float(geom["v_sys_kms"]),
                   **{f"logN_{k}": float(logN[k]) for k in LINE_KEYS})
    for k in LINE_KEYS:
        lam = wavelength_grid(k); tau = np.asarray(taus[k], np.float32)
        if tau.shape != lam.shape:
            raise ValueError(f"{k}: tau shape {tau.shape} != grid {lam.shape}")
        payload[f"{k}_lambda"] = lam; payload[f"{k}_tau"] = tau; payload[f"{k}_rest"] = float(LINES[k]["rest_A"])
    if hasattr(path, "write"):
        np.savez_compressed(path, **payload); return
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}.", suffix=".tmp.npz")
    try:
        with os.fdopen(fd, "wb") as fh:
            np.savez_compressed(fh, **payload)
        os.chmod(tmp, 0o644)              # mkstemp is 0600; library files are served/shared
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def load_npz(path, id=None) -> dict:
    """Read an npz (path or file object) into the payload dict. id: explicit, else from the file
    name, else geom_id(geom) for face/edge (random ids need the seed, which geom does not store)."""
    with np.load(path) as d:
        missing = [k for k in ["geom", "v_sys"] + [f"logN_{k}" for k in LINE_KEYS]
                   + [f"{k}_{s}" for k in LINE_KEYS for s in ("lambda", "tau", "rest")] if k not in d.files]
        if missing:
            raise ValueError(f"npz missing keys: {missing}")
        geom = json.loads(str(d["geom"]))
        out = {"id": id, "geom": geom, "v_sys": float(d["v_sys"]),
               "logN": {k: float(d[f"logN_{k}"]) for k in LINE_KEYS},
               "lam": {k: d[f"{k}_lambda"] for k in LINE_KEYS},
               "tau": {k: d[f"{k}_tau"] for k in LINE_KEYS},
               "rest": {k: float(d[f"{k}_rest"]) for k in LINE_KEYS}}
    if out["id"] is None and isinstance(path, (str, os.PathLike)):
        stem = Path(path).stem
        out["id"] = stem[len(NPZ_PREFIX):] if stem.startswith(NPZ_PREFIX) else stem
    if out["id"] is None and geom.get("kind") == "endpoints":
        out["id"] = custom_id(geom["p0_kpc"], geom["p1_kpc"])
    if out["id"] is None and not str(geom.get("orientation", "")).lower().startswith("rand") \
            and geom.get("kind") != "endpoints":
        out["id"] = geom_id(geom["orientation"], geom["b_kpc"], geom["azimuth_deg"],
                            inclination_deg=geom.get("inclination_deg"))
    return out


def encode_web(payload) -> bytes:
    """Little-endian web binary: header, then per line u32 n, f64 lam0, dlam_grid, rest, dlam_lsf,
    n × u16 round(exp(-tau)*65535). Full ±1500 km/s grid, no trimming."""
    parts = [_HDR.pack(WEB_MAGIC, WEB_VERSION, len(LINE_KEYS), 0)]
    for k in LINE_KEYS:
        tau = np.asarray(payload["tau"][k], float)
        lo, hi, n = _grid(k)
        if tau.size != n:
            raise ValueError(f"{k}: tau has {tau.size} samples, generation grid has {n}")
        q = np.round(np.clip(np.exp(-tau), 0.0, 1.0) * 65535).astype("<u2")
        parts += [_LINE.pack(n, lo, (hi - lo) / (n - 1), float(payload["rest"][k]), DLAMBDA), q.tobytes()]
    return b"".join(parts)


def decode_web(blob) -> dict:
    magic, ver, nlines, _ = _HDR.unpack_from(blob, 0)
    if magic != WEB_MAGIC or ver != WEB_VERSION:
        raise ValueError("not a TNGS v1 blob")
    off, lines = _HDR.size, {}
    for k in LINE_KEYS[:nlines]:
        n, lam0, dg, rest, dl = _LINE.unpack_from(blob, off); off += _LINE.size
        q = np.frombuffer(blob, "<u2", n, off); off += 2 * n
        lines[k] = dict(n=n, lam0=lam0, dlam_grid=dg, rest=rest, dlam_lsf=dl, q=q,
                        lam=lam0 + np.arange(n) * dg, flux=q / 65535.0)
    if off != len(blob):
        raise ValueError(f"trailing bytes: {len(blob) - off}")
    return {"version": ver, "lines": lines}


# ------------------------------------------------------------------------------- catalog
_GAL_PUBLIC = ("sim", "snapshot", "redshift", "subhalo_id", "central", "TNG_H", "R200c_kpc",
               "M200c_Msun", "Mstar_Msun", "SFR_Msun_yr", "SubhaloVel_kms", "disk_frame_source")


def catalog_skeleton() -> dict:
    lines = {k: dict(LINES[k], dlam_lsf=DLAMBDA) for k in LINE_KEYS}
    return {"version": 1, "galaxy": {k: GALAXY[k] for k in _GAL_PUBLIC if k in GALAXY},
            "lines": lines, "entries": []}


class Catalog:
    """catalog.json with atomic writes (tmp + os.replace) guarded by a threading.Lock."""

    def __init__(self, path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self.data = json.loads(self.path.read_text()) if self.path.exists() else catalog_skeleton()
        self._index = {e["id"]: i for i, e in enumerate(self.data["entries"])}

    def entries(self) -> list:
        with self._lock:
            return [dict(e) for e in self.data["entries"]]

    def get(self, id):
        with self._lock:
            i = self._index.get(id)
            return None if i is None else dict(self.data["entries"][i])

    def upsert(self, entry: dict) -> None:
        with self._lock:
            i = self._index.get(entry["id"])
            if i is None:
                self._index[entry["id"]] = len(self.data["entries"]); self.data["entries"].append(dict(entry))
            else:
                self.data["entries"][i] = dict(entry)

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=f".{self.path.name}.", suffix=".tmp")
            try:
                with os.fdopen(fd, "w") as fh:
                    json.dump(self.data, fh, allow_nan=False, separators=(",", ":"))
                os.chmod(tmp, 0o644)
                os.replace(tmp, self.path)
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)


def _f(x):
    """finite float or None (JSON-safe; pandas NaN / -inf -> None)."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _i(x):
    x = _f(x)
    return None if x is None else int(x)


def _b(x):
    if isinstance(x, str):
        return {"true": True, "false": False}.get(x.strip().lower())
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else bool(x)


def _r(x, nd):
    """round to nd decimals, -0.0 -> 0.0 (JSON never shows -0)."""
    return round(float(x), nd) + 0.0


def geom_endpoints(geom: dict, nd=2) -> tuple[list, list]:
    """(p0, p1): ray start/end in physical kpc relative to CENTER_KPC (= galaxy center_kpc, box axes),
    rounded to `nd` decimals (0.01 kpc). Uses start/end_kpc, else start/end_ckpch / TNG_H (equal by
    construction). Never subtract center_ckpch/TNG_H (it differs from center_kpc; design-2 §2)."""
    if "start_kpc" in geom and "end_kpc" in geom:
        a, b = np.asarray(geom["start_kpc"], float), np.asarray(geom["end_kpc"], float)
    else:
        a = np.asarray(geom["start_ckpch"], float) / TNG_H
        b = np.asarray(geom["end_ckpch"], float) / TNG_H
    return [_r(x, nd) for x in a - CENTER_KPC], [_r(x, nd) for x in b - CENTER_KPC]


def npz_endpoints(path, nd=2) -> tuple[list, list]:
    """geom_endpoints() of a library npz, reading only its `geom` member (for the exporter)."""
    with np.load(path, allow_pickle=False) as d:
        return geom_endpoints(json.loads(str(d["geom"])), nd)


AOD_K = 1e5 / (0.02654008 * 1e-8)   # N [cm^-2] = AOD_K / (f λ0[Å]) ∫τ dv[km/s]  (πe²/(m_e c) = 0.02654 cm² s⁻¹)


def aod_columns(payload, nd=3) -> dict:
    """{ion: apparent-optical-depth log10 N of the stored τ over the whole ±1500 km/s window (None when ∫τ = 0)}.
    Exact for the noiseless, unclipped τ. It is the column the spectrum actually holds; payload["logN"] is the
    ray column Σ n dl, larger for weak, diffuse absorbers whose cells Trident deposits only partly (min_tau)."""
    out = {}
    for k in LINE_KEYS:
        lam = np.asarray(payload["lam"][k], float); rest = float(payload["rest"][k])
        n = AOD_K / (LINES[k]["f"] * rest) * float(np.trapz(np.asarray(payload["tau"][k], float),
                                                           C_KMS * (lam / rest - 1.0)))
        out[k] = _r(math.log10(n), nd) if n > 0 and math.isfinite(n) else None
    return out


def _n_fit(components) -> dict:
    return {k: len(components.get(k) or []) for k in LINE_KEYS}


def catalog_entry(payload, scores: dict | None, source: str, components: dict | None = None) -> dict:
    """Catalog row. `scores` is flat like a grid_index.csv row / scoring.score_payload():
    rank, showcase_score, n_showcase_ions, ovi_showcase, <ion>_{n_comp,min_flux,showcase}.
    `components` ({ion: [comp]}, default payload["components"]) sets has_components / n_fit.
    logN is the ray column, logN_aod the spectrum's (aod_columns); compare fits with logN_aod.
    Every row carries p0/p1 (geom_endpoints, 0.01 kpc); custom (kind "endpoints") rows also carry
    kind, length_kpc, angle_to_normal_deg, b_segment_kpc and closest-approach b/azimuth (0.1)."""
    g, id, s = payload["geom"], payload["id"], scores or {}
    if components is None:
        components = payload.get("components")
    custom = g.get("kind") == "endpoints"
    m = _SEED_RE.search(id or "")
    seed = int(m.group(1)) if (m and not custom and str(id).startswith("rand")) else None
    star = _b(s.get("ovi_showcase"))
    p0, p1 = geom_endpoints(g)
    e = {"id": id, "orientation": "custom" if custom else g["orientation"],
         "b_kpc": _r(g["b_kpc"], 1) if custom else float(g["b_kpc"]),
         "azimuth_deg": _r(g["azimuth_deg"], 1) if custom else float(g["azimuth_deg"]),
         "seed": seed, "v_sys": float(payload["v_sys"]),
         "logN": {k: _f(payload["logN"][k]) for k in LINE_KEYS},
         "logN_aod": aod_columns(payload) if "tau" in payload else None,
         "rank": _i(s.get("rank")), "score": _f(s.get("showcase_score")),
         "n_showcase_ions": _i(s.get("n_showcase_ions")), "star": bool(star) if star is not None else False,
         "ions": {k: {"n_comp": _i(s.get(f"{k}_n_comp")), "min_flux": _f(s.get(f"{k}_min_flux")),
                      "showcase": _b(s.get(f"{k}_showcase"))} for k in LINE_KEYS},
         "source": source, "p0": p0, "p1": p1, "has_components": components is not None}
    if components is not None:
        e["n_fit"] = _n_fit(components)
    if custom:
        e.update(kind="endpoints", length_kpc=_r(g["length_kpc"], 1),
                 angle_to_normal_deg=_r(g["angle_to_normal_deg"], 1), b_segment_kpc=_r(g["b_segment_kpc"], 1))
    return e
