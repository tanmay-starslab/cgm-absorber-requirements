"""Voigt-component catalogue: fit a sightline payload with tngsight.vpfit and (de)serialise/validate the
per-ion component lists (phase-2 design §5.2–5.3).

Component = {"v","dv","logN","dlogN","b","db","region","flag","EW"} in the fixed frame V = c(λ/λ0−1)+v_sys
(km/s, log10 cm^-2, km/s, mÅ rest frame); dv/dlogN/db are formal 1σ errors for the pseudo-noise (or null).
logN ≤ 19 except H I Lyβ (≤ 22.5, damped components flagged DAMPED = 64); SAT components (not DAMPED) carry
null dlogN/db and NOERR: their logN is unconstrained in both directions, not a lower limit.

AOD record per sightline (catalogue key "aod", next to "entries"): {ion: {"logN_aod": total | null,
"regions": [{"region", "v_lo", "v_hi", "logN_aod"}]}} — the apparent-optical-depth column of the stored τ over
the whole window and over each fitted region (exact on noiseless data, so the number to compare a fit with,
and the column to quote for saturated regions). "logN" in catalog.json is the ray column (Σ n dl), which
exceeds the spectrum's column for weak, diffuse absorbers (Trident's min_tau deposition cut-off).
"""
from __future__ import annotations
import hashlib
import json
import math
from pathlib import Path

from .config import LINE_KEYS
from . import vpfit

FITTER_TAG = "tngsight.vpfit/1"
CATALOGUE_VERSION = 1
_ERR_KEYS = ("dv", "dlogN", "db")


def _canon(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False)


def params_tag(params=None) -> str:
    """sha1[:12] of the canonical JSON {"atomic": ATOMIC, "params": PARAMS} (tuples serialise as lists)."""
    p = vpfit.PARAMS if params is None else params
    return hashlib.sha1(_canon({"atomic": vpfit.ATOMIC, "params": p}).encode()).hexdigest()[:12]


def params_record(params=None) -> dict:
    """The verbatim parameter block stored in components.json."""
    p = dict(vpfit.PARAMS if params is None else params)
    p["logN_bounds"] = list(p["logN_bounds"])
    p.update({"atomic": {k: dict(v) for k, v in vpfit.ATOMIC.items()}, "frame": "V=c(lam/lam0-1)+v_sys",
              "grid": "native dlam=0.002 A",
              "note": "errors are formal (pseudo-noise sigma=0.01 on noiseless spectra)",
              "flags": dict(vpfit.FLAGS)})
    return p


def _r(x, d):
    return None if x is None else vpfit.fmt_round(x, d)


def fit_payload(payload, progress=None, params=None, aod=None) -> dict:
    """{ion: [components]} for LINE_KEYS of a payload dict (tngsight.library.load_npz layout).
    progress(stage="fit", frac, msg) is called before each ion and once at the end. `aod`: a dict that is
    filled with the sightline's AOD record (module doc)."""
    params = vpfit.PARAMS if params is None else params
    out = {}
    for i, k in enumerate(LINE_KEYS):
        if progress is not None:
            progress("fit", i / len(LINE_KEYS), f"fitting {k}")
        info = {} if aod is not None else None
        out[k] = vpfit.fit_line(payload["lam"][k], payload["tau"][k], payload["rest"][k], payload["v_sys"], k,
                                params, info)
        if aod is not None:
            aod[k] = {"logN_aod": _r(info["logN_aod"], 3),
                      "regions": [{"region": int(r["region"]), "v_lo": _r(r["v_lo"], 1), "v_hi": _r(r["v_hi"], 1),
                                   "logN_aod": _r(r["logN_aod"], 3)} for r in info["regions"]]}
    if progress is not None:
        progress("fit", 1.0, "fitted " + ", ".join(f"{k} {len(out[k])}" for k in LINE_KEYS))
    return out


def fit_sightline(payload_or_npz, progress=None, params=None, aod=None) -> dict:
    """fit_payload for a payload dict or an npz path / file object."""
    if isinstance(payload_or_npz, dict):
        return fit_payload(payload_or_npz, progress, params, aod)
    from .library import load_npz
    return fit_payload(load_npz(payload_or_npz), progress, params, aod)


def _num(x, name, nullable=False):
    if x is None and nullable:
        return None
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        raise ValueError(f"{name}: expected a finite number, got {x!r}")
    return float(x)


def validate_components(obj) -> dict:
    """Validate {ion: [component]} (dict, or its JSON text) and return a normalised copy. Raises ValueError."""
    if isinstance(obj, (bytes, bytearray)):
        obj = obj.decode()
    if isinstance(obj, str):
        try:
            obj = json.loads(obj)
        except json.JSONDecodeError as e:
            raise ValueError(f"components: invalid JSON ({e.msg})") from None
    if not isinstance(obj, dict):
        raise ValueError("components: expected an object")
    if sorted(obj) != sorted(LINE_KEYS):
        raise ValueError(f"components: keys must be exactly {list(LINE_KEYS)}, got {sorted(obj)}")
    cap = vpfit.PARAMS["max_comp_ion"]
    flag_max = sum(vpfit.FLAGS.values())
    out = {}
    for k in LINE_KEYS:
        n_hi = vpfit.logN_bounds(k)[1]
        lst = obj[k]
        if not isinstance(lst, list):
            raise ValueError(f"{k}: expected a list")
        if len(lst) > cap:
            raise ValueError(f"{k}: {len(lst)} components exceeds {cap}")
        res = []
        for i, c in enumerate(lst):
            w = f"{k}[{i}]"
            if not isinstance(c, dict) or set(c) != set(vpfit.COMP_KEYS):
                raise ValueError(f"{w}: keys must be exactly {list(vpfit.COMP_KEYS)}")
            d = {key: _num(c[key], f"{w}.{key}", nullable=key in _ERR_KEYS) for key in ("v", "dv", "logN", "dlogN",
                                                                                   "b", "db", "EW")}
            if not 10.0 <= d["logN"] <= n_hi:
                raise ValueError(f"{w}.logN: {d['logN']} outside [10, {n_hi:g}]")
            if not 1.0 <= d["b"] <= 150.0:
                raise ValueError(f"{w}.b: {d['b']} outside [1, 150]")
            if abs(d["v"]) > 2000.0:
                raise ValueError(f"{w}.v: |v| = {abs(d['v'])} exceeds 2000")
            for e in _ERR_KEYS:
                if d[e] is not None and d[e] < 0:
                    raise ValueError(f"{w}.{e}: negative error")
            if d["EW"] < 0:
                raise ValueError(f"{w}.EW: negative")
            for key, hi in (("flag", flag_max), ("region", 10 ** 6)):
                x = c[key]
                if isinstance(x, bool) or not isinstance(x, int) or not 0 <= x <= hi:
                    raise ValueError(f"{w}.{key}: expected an integer in [0, {hi}], got {x!r}")
                d[key] = int(x)
            res.append({key: d[key] for key in vpfit.COMP_KEYS})
        out[k] = res
    return out


def summary(comps) -> dict:
    """{ion: number of components}."""
    return {k: len(comps.get(k) or []) for k in LINE_KEYS}


def validate_aod(obj) -> dict:
    """Validate one sightline's AOD record (module doc); returns it. Raises ValueError."""
    if not isinstance(obj, dict) or sorted(obj) != sorted(LINE_KEYS):
        raise ValueError(f"aod: keys must be exactly {list(LINE_KEYS)}")
    for k in LINE_KEYS:
        a = obj[k]
        if not isinstance(a, dict) or set(a) != {"logN_aod", "regions"} or not isinstance(a["regions"], list):
            raise ValueError(f"aod.{k}: expected {{logN_aod, regions}}")
        _num(a["logN_aod"], f"aod.{k}.logN_aod", nullable=True)
        for i, r in enumerate(a["regions"]):
            if not isinstance(r, dict) or set(r) != {"region", "v_lo", "v_hi", "logN_aod"}:
                raise ValueError(f"aod.{k}.regions[{i}]: keys must be region, v_lo, v_hi, logN_aod")
            if isinstance(r["region"], bool) or not isinstance(r["region"], int) or r["region"] < 0:
                raise ValueError(f"aod.{k}.regions[{i}].region: expected a non-negative integer")
            for f in ("v_lo", "v_hi"):
                _num(r[f], f"aod.{k}.regions[{i}].{f}")
            _num(r["logN_aod"], f"aod.{k}.regions[{i}].logN_aod", nullable=True)
    return obj


def make_catalogue(entries: dict, params=None, aod=None) -> dict:
    """components.json object from {id: {ion: [comps]}} (+ optional {id: AOD record})."""
    cat = {"version": CATALOGUE_VERSION, "fitter": FITTER_TAG, "params_tag": params_tag(params),
           "params": params_record(params), "entries": {k: entries[k] for k in sorted(entries)}}
    if aod is not None:
        cat["aod"] = {k: aod[k] for k in sorted(aod)}
    return cat


def validate_catalogue(obj) -> dict:
    if not isinstance(obj, dict) or obj.get("version") != CATALOGUE_VERSION:
        raise ValueError("components catalogue: version must be 1")
    for k in ("fitter", "params_tag", "params", "entries"):
        if k not in obj:
            raise ValueError(f"components catalogue: missing {k}")
    for sid, c in obj["entries"].items():
        try:
            validate_components(c)
        except ValueError as e:
            raise ValueError(f"{sid}: {e}") from None
    for sid, a in (obj.get("aod") or {}).items():
        try:
            validate_aod(a)
        except ValueError as e:
            raise ValueError(f"{sid}: {e}") from None
    return obj


def load_catalogue(path) -> dict:
    return validate_catalogue(json.loads(Path(path).read_text()))


def dump_catalogue(obj) -> bytes:
    """Compact, key-sorted, NaN-free JSON bytes (deterministic)."""
    return _canon(obj).encode()
