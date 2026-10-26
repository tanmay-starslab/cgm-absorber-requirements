"""Sightline library I/O (Phase-3 design §2): npz v2 (v1 read), TNGS v2 web binary (v1 read), catalog v2 rows.

npz v2 `cgm_sid488530_<id>.npz` / `<id>.npz` (np.savez_compressed, no pickles), members in this order:
    format ("tngsight-npz/2"), geom (JSON), v_sys, lines (JSON key list, registry order), generation (JSON),
    then per key k in lines: logN_<k>, <k>_tau (f4, native grid), <k>_lam0, <k>_dlam, <k>_rest, <k>_W.
The native grid of line k with half-window W is Trident's wavelength grid for λ0(1 ∓ W/c) at dλ = λ0·du/c,
du = 0.25 km/s (`native_grid`): uniform in λ, hence in the rest-frame velocity u = c(λ/λ0 − 1).

Payload (load_npz) = {"id", "geom", "v_sys", "format": 1|2, "lines": [keys], "generation", "logN": {k}, "tau": {k},
"rest": {k}, "W": {k}, "lam0": {k}, "dlam": {k}, "lam": {k: f8 array}, "u": {k: f8 array}, "du": {k}} (+ "dropped"
for a v1 file, whose H I Lyβ line is not a registry line).

TNGS v2 (little-endian): 16-byte header "TNGS", u8 2, u8 nlines, u16 0, f64 v_sys; per line char[8] key (NUL
padded), u32 n, u32 0, f64 u0, f64 du, f64 rest, u16[n] round(clip(F_web, 0, 1)·65535). F_web is the box average of
the native flux over [u_j − ½, u_j + ½] at the integer velocities u_j = −W..W (`web_flux`), which conserves EW.
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
from . import ions as I
from .config import C_KMS, DLAMBDA, VWIN_GEN_KMS, DV_NATIVE, DV_WEB, SPEC_MIN_TAU, GALAXY, NPZ_PREFIX
from .geometry import geom_id, custom_id, CENTER_KPC, H as TNG_H

WEB_MAGIC = b"TNGS"
WEB_VERSION = 2
NPZ_FORMAT = "tngsight-npz/2"
TRIDENT_VERSION = "1.4.2"
ION_TABLE = "hm2012_ss_hr.h5"
_HDR1 = struct.Struct("<4sBBH")              # v1 file header (8 B)
_LINE1 = struct.Struct("<Idddd")             # v1 line header (36 B)
_HDR2 = struct.Struct("<4sBBHd")             # v2 file header (16 B)
_LINE2 = struct.Struct("<8sIIddd")           # v2 line header (40 B)
V1_KEYS = ("OVI", "HILyb", "CIII")           # the v1 line set (position order of v1 npz / bins)
V1_DROPPED = ("HILyb",)                      # not a registry line (H I Lyβ); dropped on read
MAX_WEB_N = 20001
_SEED_RE = re.compile(r"_s(\d+)$")


# ------------------------------------------------------------------------------- grids
def native_grid(key, W=None, du=DV_NATIVE) -> tuple:
    """(lam0, dlam, n) of Trident's wavelength grid for line `key` over the half-window W (km/s; default the
    registry v_gen_kms): lam_field = linspace(round(lmin/dl)·dl, round(lmax/dl)·dl, n), dl = λ0·du/c,
    n = round((hi − lo)/dl + 1). dlam = (lam[-1] − lam[0])/(n − 1)."""
    rest = float(I.get(key)["lam0_A"])
    W = float(I.get(key)["v_gen_kms"] if W is None else W)
    dl = rest * float(du) / C_KMS
    lo = np.round(rest * (1 - W / C_KMS) / dl) * dl
    hi = np.round(rest * (1 + W / C_KMS) / dl) * dl
    n = int(np.round((hi - lo) / dl + 1))
    lam = np.linspace(lo, hi, n)
    return float(lam[0]), float((lam[-1] - lam[0]) / (n - 1)), n


def native_u(key, W=None) -> np.ndarray:
    """Rest-frame velocities (km/s) of the native grid of `key`."""
    lam0, dlam, n = native_grid(key, W)
    rest = float(I.get(key)["lam0_A"])
    return C_KMS * ((lam0 + np.arange(n) * dlam) / rest - 1.0)


def _v1_grid(key):
    """(lo, hi, n) of the v1 (legacy) generation grid of a v1 key: Trident's lambda_field for rest(1 ∓ 1500/c),
    dλ = 0.002 Å."""
    rest = GALAXY["lines"][key]["rest_A"]
    lam_min = rest * (1 - VWIN_GEN_KMS / C_KMS); lam_max = rest * (1 + VWIN_GEN_KMS / C_KMS)
    lo = round(lam_min / DLAMBDA) * DLAMBDA; hi = round(lam_max / DLAMBDA) * DLAMBDA
    return lo, hi, int(round((hi - lo) / DLAMBDA + 1))


def wavelength_grid(key) -> np.ndarray:
    """v1 LEGACY ONLY (keys OVI, HILyb, CIII): the float32 λ grid of the v1 npz files. Kept for
    tests/js/make_reference.py and degrade_parity.mjs until part B retires them; v2 code uses native_grid."""
    if key not in V1_KEYS:
        raise KeyError(f"wavelength_grid is the v1 legacy grid of {V1_KEYS}; use native_grid for {key!r}")
    lo, hi, n = _v1_grid(key)
    return np.linspace(lo, hi, n).astype(np.float32)


def _encode_web_v1_legacy(payload) -> bytes:
    """The v1 TNGS bytes of a raw legacy 3-line dict (no "lines" key: {"tau", "rest"} keyed OVI/HILyb/CIII).
    Only for tests/js/make_reference.py (degrade_parity.mjs) until part B retires it."""
    parts = [_HDR1.pack(WEB_MAGIC, 1, len(V1_KEYS), 0)]
    for k in V1_KEYS:
        tau = np.asarray(payload["tau"][k], float)
        lo, hi, n = _v1_grid(k)
        if tau.size != n:
            raise ValueError(f"{k}: tau has {tau.size} samples, v1 grid has {n}")
        q = np.round(np.clip(np.exp(-tau), 0.0, 1.0) * 65535).astype("<u2")
        parts += [_LINE1.pack(n, lo, (hi - lo) / (n - 1), float(payload["rest"][k]), DLAMBDA), q.tobytes()]
    return b"".join(parts)


def npz_name(id) -> str:
    return f"{NPZ_PREFIX}{id}.npz"


def generation_record(min_tau=None) -> dict:
    return {"min_tau": float(SPEC_MIN_TAU if min_tau is None else min_tau), "dv_kms": DV_NATIVE,
            "trident": TRIDENT_VERSION, "ion_table": ION_TABLE, "registry_tag": I.registry_tag()}


def npz_members(lines) -> list:
    """The exact v2 member names, in file order, for a list of line keys (design §2.3)."""
    out = ["format", "geom", "v_sys", "lines", "generation"]
    for k in lines:
        out += [f"logN_{k}", f"{k}_tau", f"{k}_lam0", f"{k}_dlam", f"{k}_rest", f"{k}_W"]
    return out


def _ordered_lines(keys) -> list:
    keys = list(keys)
    bad = [k for k in keys if k not in I.KEYS]
    if bad:
        raise ValueError(f"unknown line keys {bad}; known: {', '.join(I.KEYS)}")
    if not keys or len(set(keys)) != len(keys):
        raise ValueError("lines must be a non-empty list of unique registry keys")
    return [k for k in I.KEYS if k in keys]


# ------------------------------------------------------------------------------- npz v2
def save_npz(path, payload_like: dict) -> None:
    """Write npz v2 (only) from {"geom", "logN", "tau", "lam0", "dlam", "rest", "W", "lines", "generation"}
    (+ optional "v_sys"; default geom["v_sys_kms"]). `path` may be a file object; a path is written atomically
    (tmp + os.replace, mode 0644)."""
    p = payload_like
    lines = _ordered_lines(p.get("lines") or list(p["tau"]))
    geom = p["geom"]
    v_sys = float(p["v_sys"]) if p.get("v_sys") is not None else float(geom["v_sys_kms"])
    gen = dict(p.get("generation") or generation_record())
    out = {"format": np.array(NPZ_FORMAT), "geom": np.array(json.dumps(geom)), "v_sys": np.float64(v_sys),
           "lines": np.array(json.dumps(lines)), "generation": np.array(json.dumps(gen, sort_keys=True))}
    for k in lines:
        tau = np.asarray(p["tau"][k], np.float32)
        if tau.ndim != 1 or tau.size < 2:
            raise ValueError(f"{k}: tau must be a 1-D array with >= 2 samples, got shape {tau.shape}")
        out[f"logN_{k}"] = np.float64(p["logN"][k])
        out[f"{k}_tau"] = tau
        out[f"{k}_lam0"] = np.float64(p["lam0"][k])
        out[f"{k}_dlam"] = np.float64(p["dlam"][k])
        out[f"{k}_rest"] = np.float64(p["rest"][k])
        out[f"{k}_W"] = np.float64(p["W"][k])
    if hasattr(path, "write"):
        np.savez_compressed(path, **out)
        return
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}.", suffix=".tmp.npz")
    try:
        with os.fdopen(fd, "wb") as fh:
            np.savez_compressed(fh, **out)
        os.chmod(tmp, 0o644)              # mkstemp is 0600; library files are served/shared
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _with_id(out, path, geom):
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


def _load_v2(d) -> dict:
    lines = json.loads(str(d["lines"]))
    lines = _ordered_lines(lines)
    missing = [m for m in npz_members(lines) if m not in d.files]
    if missing:
        raise ValueError(f"npz missing keys: {missing}")
    out = {"format": 2, "geom": json.loads(str(d["geom"])), "v_sys": float(d["v_sys"]), "lines": lines,
           "generation": json.loads(str(d["generation"])), "logN": {}, "tau": {}, "rest": {}, "W": {}, "lam0": {},
           "dlam": {}, "lam": {}, "u": {}, "du": {}}
    for k in lines:
        tau = d[f"{k}_tau"]
        lam0, dlam, rest = float(d[f"{k}_lam0"]), float(d[f"{k}_dlam"]), float(d[f"{k}_rest"])
        lam = lam0 + np.arange(tau.size) * dlam
        out["logN"][k] = float(d[f"logN_{k}"]); out["tau"][k] = tau; out["rest"][k] = rest
        out["W"][k] = float(d[f"{k}_W"]); out["lam0"][k] = lam0; out["dlam"][k] = dlam
        out["lam"][k] = lam; out["u"][k] = C_KMS * (lam / rest - 1.0); out["du"][k] = C_KMS * dlam / rest
    return out


def _load_v1(d) -> dict:
    need = ["geom", "v_sys"] + [f"logN_{k}" for k in V1_KEYS] + [f"{k}_{s}" for k in V1_KEYS
                                                                  for s in ("lambda", "tau", "rest")]
    missing = [m for m in need if m not in d.files]
    if missing:
        raise ValueError(f"npz missing keys: {missing}")
    lines = [k for k in I.KEYS if k in V1_KEYS]                     # OVI, CIII in registry order
    out = {"format": 1, "geom": json.loads(str(d["geom"])), "v_sys": float(d["v_sys"]), "lines": lines,
           "generation": {"min_tau": 1e-3, "dv_kms": None}, "dropped": list(V1_DROPPED),
           "logN": {}, "tau": {}, "rest": {}, "W": {}, "lam0": {}, "dlam": {}, "lam": {}, "u": {}, "du": {}}
    for k in lines:
        lam = d[f"{k}_lambda"]; rest = float(d[f"{k}_rest"])
        lam_f = lam.astype(np.float64)
        out["logN"][k] = float(d[f"logN_{k}"]); out["tau"][k] = d[f"{k}_tau"]; out["rest"][k] = rest
        out["W"][k] = VWIN_GEN_KMS; out["lam0"][k] = float(lam_f[0]); out["dlam"][k] = DLAMBDA
        out["lam"][k] = lam; out["u"][k] = C_KMS * (lam_f / rest - 1.0); out["du"][k] = C_KMS * DLAMBDA / rest
    return out


def load_npz(path, id=None) -> dict:
    """Read an npz v2 or v1 (path or file object) into the payload dict (module doc). id: explicit, else from the
    file name, else from the geom (custom: custom_id; face/edge: geom_id; random ids need the seed)."""
    with np.load(path, allow_pickle=False) as d:
        if "format" in d.files:
            fmt = str(d["format"])
            if fmt != NPZ_FORMAT:
                raise ValueError(f"unsupported npz format {fmt!r}")
            out = _load_v2(d)
        elif "OVI_lambda" in d.files or "logN_OVI" in d.files:
            out = _load_v1(d)
        else:
            raise ValueError(f"npz missing keys: ['format'] (members: {sorted(d.files)[:8]})")
    out = {"id": id, **out}
    return _with_id(out, path, out["geom"])


# ------------------------------------------------------------------------------- web grid + TNGS v2
def web_flux(payload, key) -> tuple:
    """(u_web, F_web) of one line: box average of F = exp(−τ) over [u_j − ½, u_j + ½] at u_j = −W..W (step 1).
    I = cumulative trapezoid integral of F on the payload grid; e± = clip(u_j ± ½, u_0, u_{n−1})."""
    u = np.asarray(payload["u"][key], np.float64)
    F = np.exp(-np.asarray(payload["tau"][key], np.float64))
    W = int(round(float(payload["W"][key])))
    cum = np.concatenate(([0.0], np.cumsum(0.5 * (F[1:] + F[:-1]) * np.diff(u))))
    uj = np.arange(-W, W + 1, dtype=np.float64) * DV_WEB
    lo = np.clip(uj - 0.5 * DV_WEB, u[0], u[-1]); hi = np.clip(uj + 0.5 * DV_WEB, u[0], u[-1])
    with np.errstate(invalid="ignore", divide="ignore"):
        Fw = (np.interp(hi, u, cum) - np.interp(lo, u, cum)) / (hi - lo)
    Fw = np.where(hi > lo, Fw, np.interp(uj, u, F))
    return uj, Fw


def encode_web(payload) -> bytes:
    """TNGS v2 bytes of a payload (v1 payloads give the 2 lines they have). A raw legacy 3-line dict without
    "lines" (tests/js/make_reference.py) still gets the v1 bytes, for one release."""
    if "lines" not in payload and set(V1_KEYS) <= set(payload.get("tau", {})):
        return _encode_web_v1_legacy(payload)
    lines = _ordered_lines(payload["lines"])
    parts = [_HDR2.pack(WEB_MAGIC, WEB_VERSION, len(lines), 0, float(payload["v_sys"]))]
    for k in lines:
        u, Fw = web_flux(payload, k)
        if u.size > MAX_WEB_N:
            raise ValueError(f"{k}: {u.size} web samples exceed {MAX_WEB_N}")
        q = np.round(np.clip(Fw, 0.0, 1.0) * 65535).astype("<u2")
        parts += [_LINE2.pack(k.encode("ascii").ljust(8, b"\0"), u.size, 0, float(u[0]), DV_WEB,
                              float(payload["rest"][k])), q.tobytes()]
    return b"".join(parts)


def _decode_v1(blob) -> dict:
    magic, ver, nlines, _ = _HDR1.unpack_from(blob, 0)
    off, lines, skipped = _HDR1.size, {}, []
    for i in range(nlines):
        if off + _LINE1.size > len(blob):
            raise ValueError("truncated")
        n, lam0, dg, rest, dl = _LINE1.unpack_from(blob, off); off += _LINE1.size
        if off + 2 * n > len(blob):
            raise ValueError("truncated")
        key = V1_KEYS[i] if i < len(V1_KEYS) else f"line{i}"
        if key in I.KEYS:
            q = np.frombuffer(blob, "<u2", n, off)
            u0, du = C_KMS * (lam0 / rest - 1.0), C_KMS * dg / rest
            lines[key] = dict(n=n, u0=u0, du=du, rest=rest, q=q, flux=q / 65535.0, u=u0 + np.arange(n) * du,
                              lam0=lam0, dlam_grid=dg, dlam_lsf=dl)
        else:
            skipped.append(key)
        off += 2 * n
    if off != len(blob):
        raise ValueError(f"trailing bytes: {len(blob) - off}")
    return {"version": 1, "vSys": None, "skipped": skipped, "lines": lines}


def decode_web(blob) -> dict:
    """{version: 1|2, vSys: float|None, skipped: [keys], lines: {key: {n, u0, du, rest, q, flux, u}}} (design §2.4).
    Only registry keys become lines; any other v2 key is skipped and listed (forward compatibility); v1 line 1 (HILyb)
    is skipped. v2 checks, identical to docs/tng50/js/fit.js decodeTNGS (Phase-3 Code 4): 1 ≤ nlines ≤ len(registry);
    v_sys finite; per line the key is its 8 bytes without the trailing NULs (a byte ≥ 128 reads as U+FFFD, an embedded
    NUL stays, so neither can match a registry key), a key seen twice is refused, 1 ≤ n ≤ MAX_WEB_N, u0, du and rest
    finite and du > 0 (for skipped lines too), and the length is exact."""
    blob = bytes(blob)
    if len(blob) < 8 or blob[:4] != WEB_MAGIC:
        raise ValueError("not a TNGS blob")
    ver = blob[4]
    if ver == 1:
        return _decode_v1(blob)
    if ver != 2:
        raise ValueError(f"unsupported TNGS version {ver}")
    if len(blob) < _HDR2.size:
        raise ValueError("truncated")
    _, _, nlines, _, v_sys = _HDR2.unpack_from(blob, 0)
    registry = frozenset(I.KEYS)
    if not 1 <= nlines <= len(registry):
        raise ValueError(f"TNGS v2: nlines {nlines} outside 1..{len(registry)}")
    if not math.isfinite(v_sys):
        raise ValueError("TNGS v2: v_sys not finite")
    off, lines, skipped, seen = _HDR2.size, {}, [], set()
    for _ in range(nlines):
        if off + _LINE2.size > len(blob):
            raise ValueError("truncated")
        kb, n, _r, u0, du, rest = _LINE2.unpack_from(blob, off); off += _LINE2.size
        key = kb.rstrip(b"\0").decode("ascii", "replace")
        if key in seen:
            raise ValueError(f"duplicate line key {key!r}")
        seen.add(key)
        if not 1 <= n <= MAX_WEB_N:
            raise ValueError(f"TNGS v2: line {key!r} has n {n} outside 1..{MAX_WEB_N}")
        if not (math.isfinite(u0) and math.isfinite(du) and math.isfinite(rest)):
            raise ValueError(f"TNGS v2: line {key!r} has a non-finite u0, du or rest")
        if not du > 0:
            raise ValueError(f"TNGS v2: line {key!r} has du {du} <= 0")
        if off + 2 * n > len(blob):
            raise ValueError("truncated")
        if key in registry:
            q = np.frombuffer(blob, "<u2", n, off)
            lines[key] = dict(n=n, u0=u0, du=du, rest=rest, q=q, flux=q / 65535.0, u=u0 + np.arange(n) * du)
        else:
            skipped.append(key)
        off += 2 * n
    if off != len(blob):
        raise ValueError(f"trailing bytes: {len(blob) - off}")
    return {"version": 2, "vSys": float(v_sys), "skipped": skipped, "lines": lines}


# ------------------------------------------------------------------------------- catalog
_GAL_PUBLIC = ("sim", "snapshot", "redshift", "subhalo_id", "central", "TNG_H", "R200c_kpc",
               "M200c_Msun", "Mstar_Msun", "SFR_Msun_yr", "SubhaloVel_kms", "disk_frame_source")


def catalog_skeleton() -> dict:
    from .scoring import SCORING_TAG                      # scoring imports this module
    return {"version": 2, "registry_tag": I.registry_tag(), "scoring": SCORING_TAG,
            "generation": {"min_tau": float(SPEC_MIN_TAU), "dv_native_kms": DV_NATIVE, "dv_web_kms": DV_WEB,
                           "v_gen_kms": VWIN_GEN_KMS, "trident": TRIDENT_VERSION},
            "galaxy": {k: GALAXY[k] for k in _GAL_PUBLIC if k in GALAXY}, "ions": list(I.KEYS), "entries": []}


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


def _rf(x, nd):
    x = _f(x)
    return None if x is None else _r(x, nd)


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


AOD_K = 1e5 / (I.SIGMA0 * 1e-8)   # N [cm^-2] = AOD_K / (f λ0[Å]) ∫τ dv[km/s]


def aod_columns(payload, nd=3) -> dict:
    """{line: apparent-optical-depth log10 N of the stored τ over the whole window (None when ∫τ = 0)}, over
    payload["lines"], with the registry f. Exact for the noiseless, unclipped τ: the column the spectrum holds
    (payload["logN"] is the ray column Σ n dl)."""
    out = {}
    for k in payload["lines"]:
        rest = float(payload["rest"][k])
        u = np.asarray(payload["u"][k], float)
        n = AOD_K / (I.get(k)["f"] * rest) * float(np.trapz(np.asarray(payload["tau"][k], float), u))
        out[k] = _r(math.log10(n), nd) if n > 0 and math.isfinite(n) else None
    return out


def _n_fit(components) -> dict:
    return {k: len(v or []) for k, v in components.items() if k in I.KEYS}


def catalog_entry(payload, scores: dict | None, source: str, components: dict | None = None) -> dict:
    """Catalog v2 row (design §2.5). `scores` is flat like scoring.score_payload(): rank, showcase_score,
    n_showcase_ions, ovi_showcase, <ion>_{n_comp,min_flux,showcase}. `components` ({ion: [comp]}, default
    payload["components"]) sets has_components / n_fit. logN is the ray column, logN_aod the spectrum's
    (aod_columns), both for every registry key (null = line absent or zero column). Rounding: logN 3 dp, min_flux,
    score and v_sys 4 dp (the exact v_sys is in the npz and the TNGS v2 header)."""
    g, id, s = payload["geom"], payload["id"], scores or {}
    if components is None:
        components = payload.get("components")
    lines = list(payload["lines"])
    custom = g.get("kind") == "endpoints"
    m = _SEED_RE.search(id or "")
    seed = int(m.group(1)) if (m and not custom and str(id).startswith("rand")) else None
    star = _b(s.get("ovi_showcase"))
    p0, p1 = geom_endpoints(g)
    aod = aod_columns(payload) if "tau" in payload else {}
    e = {"id": id, "orientation": "custom" if custom else g["orientation"],
         "b_kpc": _r(g["b_kpc"], 1) if custom else float(g["b_kpc"]),
         "azimuth_deg": _r(g["azimuth_deg"], 1) if custom else float(g["azimuth_deg"]),
         "seed": seed, "v_sys": _r(payload["v_sys"], 4), "source": source,
         "data_version": int(payload.get("format", 2)), "lines": lines,
         "W_kms": {k: _r(payload["W"][k], 1) for k in lines if abs(float(payload["W"][k]) - VWIN_GEN_KMS) > 1e-9},
         "logN": {k: (_rf(payload["logN"][k], 3) if k in lines else None) for k in I.KEYS},
         "logN_aod": {k: aod.get(k) for k in I.KEYS},
         "ions": {k: {"n_comp": _i(s.get(f"{k}_n_comp")), "min_flux": _rf(s.get(f"{k}_min_flux"), 4),
                      "showcase": _b(s.get(f"{k}_showcase"))} for k in I.KEYS},
         "has_components": components is not None,
         "rank": _i(s.get("rank")), "score": _rf(s.get("showcase_score"), 4),
         "n_showcase_ions": _i(s.get("n_showcase_ions")), "star": bool(star) if star is not None else False,
         "p0": p0, "p1": p1}
    if components is not None:
        e["n_fit"] = _n_fit(components)
    if custom:
        e.update(kind="endpoints", length_kpc=_r(g["length_kpc"], 1),
                 angle_to_normal_deg=_r(g["angle_to_normal_deg"], 1), b_segment_kpc=_r(g["b_segment_kpc"], 1))
    return e
