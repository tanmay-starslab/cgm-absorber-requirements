"""Voigt-component catalogue v2: fit a sightline payload with tngsight.vpfit and (de)serialise/validate the per-ion
component lists (Phase-3 design §2.6; v1 catalogues are read and converted).

Component (dict form) = {"v","dv","logN","dlogN","b","db","region","flag","EW"} in the fixed frame V = u + v_sys
(km/s, log10 cm^-2, km/s, mÅ rest frame); dv/dlogN/db are formal 1σ errors for the pseudo-noise (or null).
logN ≤ the registry logN_max (19; 22.5 for the damped H I, whose damped components carry DAMPED = 64); SAT
components (not DAMPED) carry null dlogN/db and NOERR: their logN is unconstrained both ways, not a lower limit.
Rows form (components.json v2) = the same values positional in COMP_KEYS order.

AOD record per sightline (v2, compact): {ion: [logN_aod_total | null, [[region, v_lo, v_hi, logN_aod | null], ...]]}
— the apparent-optical-depth column of the stored τ over the whole window and over each fitted region (exact on
noiseless data: the number to compare a fit with, and the column to quote for saturated regions). The regions'
v_lo/v_hi (systemic frame, 1 dp) are the fit regions the browser fitter uses.
"""
from __future__ import annotations
import hashlib
import json
import math
from pathlib import Path

from . import ions as I
from . import vpfit

FITTER_TAG = "tngsight.vpfit/2"
CATALOGUE_VERSION = 2
COMP_KEYS = tuple(vpfit.COMP_KEYS)
LEGACY_DROPPED = ("HILyb",)                    # v1 H I Lyβ: not a registry line
_ERR_KEYS = ("dv", "dlogN", "db")
V_ABS_MAX = 11000.0                            # damped H I window ±10000 km/s plus |v_sys|
B_RANGE = (1.0, 150.0)


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
    p["mf_scales_kms"] = list(p.get("mf_scales_kms") or ())
    p.update({"atomic": {k: dict(v) for k, v in vpfit.ATOMIC.items()}, "frame": "V=u+v_sys",
              "grid": "native du=0.25 km/s; fit stride 4 (1 km/s)",
              "note": "errors are formal (pseudo-noise sigma=0.01 per 1 km/s pixel on noiseless spectra)",
              "flags": dict(vpfit.FLAGS)})
    return p


def _r(x, d):
    return None if x is None else vpfit.fmt_round(x, d)


# ------------------------------------------------------------------------------- rows <-> dicts
def rows_to_dicts(rows) -> list:
    out = []
    for i, r in enumerate(rows):
        if not isinstance(r, (list, tuple)) or len(r) != len(COMP_KEYS):
            raise ValueError(f"row {i}: expected {len(COMP_KEYS)} values ({', '.join(COMP_KEYS)})")
        out.append(dict(zip(COMP_KEYS, r)))
    return out


def dicts_to_rows(comps) -> list:
    return [[c[k] for k in COMP_KEYS] for c in comps]


def aod_to_compact(rec: dict) -> dict:
    """v1 AOD record {ion: {"logN_aod", "regions": [{region, v_lo, v_hi, logN_aod}]}} -> v2 compact form."""
    out = {}
    for k, a in rec.items():
        if isinstance(a, dict):
            out[k] = [a.get("logN_aod"), [[r["region"], r["v_lo"], r["v_hi"], r["logN_aod"]] for r in a["regions"]]]
        else:
            out[k] = a
    return out


# ------------------------------------------------------------------------------- fitting
def fit_payload(payload, progress=None, params=None, aod=None) -> dict:
    """{ion: [components (dict form)]} over payload["lines"] (tngsight.library.load_npz layout).
    progress(stage="fit", frac, msg) is called before each ion and once at the end. `aod`: a dict filled with the
    sightline's AOD record (v2 compact form, module doc)."""
    params = vpfit.PARAMS if params is None else params
    keys = [k for k in payload["lines"] if k in I.KEYS]
    out = {}
    for i, k in enumerate(keys):
        if progress is not None:
            progress("fit", i / len(keys), f"fitting {k}")
        info = {} if aod is not None else None
        lam = payload["lam"][k]
        out[k] = vpfit.fit_line(lam, payload["tau"][k], payload["rest"][k], payload["v_sys"], k, params, info)
        if aod is not None:
            aod[k] = [_r(info["logN_aod"], 3),
                      [[int(r["region"]), _r(r["v_lo"], 1), _r(r["v_hi"], 1), _r(r["logN_aod"], 3)]
                       for r in info["regions"]]]
    if progress is not None:
        progress("fit", 1.0, "fitted " + ", ".join(f"{k} {len(out[k])}" for k in keys))
    return out


def fit_sightline(payload_or_npz, progress=None, params=None, aod=None) -> dict:
    """fit_payload for a payload dict or an npz path / file object."""
    if isinstance(payload_or_npz, dict):
        return fit_payload(payload_or_npz, progress, params, aod)
    from .library import load_npz
    return fit_payload(load_npz(payload_or_npz), progress, params, aod)


# ------------------------------------------------------------------------------- validation
def _num(x, name, nullable=False):
    if x is None and nullable:
        return None
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        raise ValueError(f"{name}: expected a finite number, got {x!r}")
    return float(x)


def _parse(obj):
    if isinstance(obj, (bytes, bytearray)):
        obj = obj.decode()
    if isinstance(obj, str):
        try:
            obj = json.loads(obj)
        except json.JSONDecodeError as e:
            raise ValueError(f"components: invalid JSON ({e.msg})") from None
    return obj


def validate_components(obj) -> dict:
    """Validate {ion: [component]} — dict form or v2 rows form, or its JSON text — and return the normalised dict
    form. Keys must be a non-empty subset of the registry keys (a legacy "HILyb" key is dropped). Raises ValueError."""
    obj = _parse(obj)
    if not isinstance(obj, dict):
        raise ValueError("components: expected an object")
    obj = {k: v for k, v in obj.items() if k not in LEGACY_DROPPED}
    bad = sorted(k for k in obj if k not in I.KEYS)
    if bad or not obj:
        raise ValueError(f"components: keys must be a non-empty subset of {list(I.KEYS)}, got {sorted(obj)}")
    cap = vpfit.PARAMS["max_comp_ion"]
    flag_max = sum(vpfit.FLAGS.values())
    out = {}
    for k in [x for x in I.KEYS if x in obj]:
        n_hi = vpfit.logN_bounds(k)[1]
        lst = obj[k]
        if not isinstance(lst, list):
            raise ValueError(f"{k}: expected a list")
        if len(lst) > cap:
            raise ValueError(f"{k}: {len(lst)} components exceeds {cap}")
        res = []
        for i, c in enumerate(lst):
            w = f"{k}[{i}]"
            if isinstance(c, (list, tuple)):
                if len(c) != len(COMP_KEYS):
                    raise ValueError(f"{w}: a row must have {len(COMP_KEYS)} values ({', '.join(COMP_KEYS)})")
                c = dict(zip(COMP_KEYS, c))
            if not isinstance(c, dict) or set(c) != set(COMP_KEYS):
                raise ValueError(f"{w}: keys must be exactly {list(COMP_KEYS)}")
            d = {key: _num(c[key], f"{w}.{key}", nullable=key in _ERR_KEYS) for key in ("v", "dv", "logN", "dlogN",
                                                                                   "b", "db", "EW")}
            if not 10.0 <= d["logN"] <= n_hi:
                raise ValueError(f"{w}.logN: {d['logN']} outside [10, {n_hi:g}]")
            if not B_RANGE[0] <= d["b"] <= B_RANGE[1]:
                raise ValueError(f"{w}.b: {d['b']} outside [{B_RANGE[0]:g}, {B_RANGE[1]:g}]")
            if abs(d["v"]) > V_ABS_MAX:
                raise ValueError(f"{w}.v: |v| = {abs(d['v'])} exceeds {V_ABS_MAX:g}")
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
            res.append({key: d[key] for key in COMP_KEYS})
        out[k] = res
    return out


def summary(comps) -> dict:
    """{ion: number of components} over the ions present."""
    return {k: len(comps.get(k) or []) for k in I.KEYS if k in comps}


def validate_aod(obj) -> dict:
    """Validate one sightline's AOD record (v2 compact, or v1 dict form) over any non-empty subset of the registry
    keys (legacy HILyb dropped); returns the v2 compact form. Raises ValueError."""
    obj = _parse(obj)
    if not isinstance(obj, dict):
        raise ValueError("aod: expected an object")
    obj = aod_to_compact({k: v for k, v in obj.items() if k not in LEGACY_DROPPED})
    bad = sorted(k for k in obj if k not in I.KEYS)
    if bad or not obj:
        raise ValueError(f"aod: keys must be a non-empty subset of {list(I.KEYS)}, got {sorted(obj)}")
    out = {}
    for k in [x for x in I.KEYS if x in obj]:
        a = obj[k]
        if not isinstance(a, list) or len(a) != 2 or not isinstance(a[1], list):
            raise ValueError(f"aod.{k}: expected [logN_aod, regions]")
        tot = _num(a[0], f"aod.{k}.logN_aod", nullable=True)
        regs = []
        for i, r in enumerate(a[1]):
            if not isinstance(r, list) or len(r) != 4:
                raise ValueError(f"aod.{k}.regions[{i}]: expected [region, v_lo, v_hi, logN_aod]")
            if isinstance(r[0], bool) or not isinstance(r[0], int) or r[0] < 0:
                raise ValueError(f"aod.{k}.regions[{i}].region: expected a non-negative integer")
            lo = _num(r[1], f"aod.{k}.regions[{i}].v_lo"); hi = _num(r[2], f"aod.{k}.regions[{i}].v_hi")
            if lo > hi:
                raise ValueError(f"aod.{k}.regions[{i}]: v_lo > v_hi")
            regs.append([int(r[0]), lo, hi, _num(r[3], f"aod.{k}.regions[{i}].logN_aod", nullable=True)])
        out[k] = [tot, regs]
    return out


# ------------------------------------------------------------------------------- catalogue
def make_catalogue(entries: dict, aod=None, params=None) -> dict:
    """components.json v2 object from {id: {ion: [comps (dict or rows)]}} (+ optional {id: AOD record})."""
    cat = {"version": CATALOGUE_VERSION, "fitter": FITTER_TAG, "params_tag": params_tag(params),
           "registry_tag": I.registry_tag(), "params": params_record(params), "comp_keys": list(COMP_KEYS),
           "entries": {sid: {k: dicts_to_rows(v) for k, v in validate_components(entries[sid]).items()}
                       for sid in sorted(entries)}}
    if aod is not None:
        cat["aod"] = {sid: validate_aod(aod[sid]) for sid in sorted(aod)}
    return cat


def validate_catalogue(obj) -> dict:
    if not isinstance(obj, dict) or obj.get("version") != CATALOGUE_VERSION:
        raise ValueError(f"components catalogue: version must be {CATALOGUE_VERSION}")
    for k in ("fitter", "params_tag", "params", "comp_keys", "entries"):
        if k not in obj:
            raise ValueError(f"components catalogue: missing {k}")
    if list(obj["comp_keys"]) != list(COMP_KEYS):
        raise ValueError(f"components catalogue: comp_keys must be {list(COMP_KEYS)}")
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


def upgrade_catalogue(obj) -> dict:
    """A v1 catalogue object (dict-form entries, dict-form AOD, HILyb present) as a v2 object (OVI, CIII only)."""
    if obj.get("version") == CATALOGUE_VERSION:
        return obj
    if obj.get("version") != 1:
        raise ValueError("components catalogue: version must be 1 or 2")
    ents = {}
    for sid, c in (obj.get("entries") or {}).items():
        c = {k: v for k, v in c.items() if k not in LEGACY_DROPPED}
        if c:
            ents[sid] = {k: dicts_to_rows(v) for k, v in validate_components(c).items()}
    aod = {}
    for sid, a in (obj.get("aod") or {}).items():
        a = {k: v for k, v in a.items() if k not in LEGACY_DROPPED}
        if a:
            aod[sid] = validate_aod(a)
    out = {"version": CATALOGUE_VERSION, "fitter": obj.get("fitter"), "params_tag": obj.get("params_tag"),
           "registry_tag": None, "params": obj.get("params"), "comp_keys": list(COMP_KEYS), "entries": ents,
           "converted_from": 1}
    if "aod" in obj:
        out["aod"] = aod
    return out


def load_catalogue(path) -> dict:
    """Read a components catalogue (v1 or v2) and return it as v2 (validated)."""
    return validate_catalogue(upgrade_catalogue(json.loads(Path(path).read_text())))


def dump_catalogue(obj) -> bytes:
    """Compact, key-sorted, NaN-free JSON bytes (deterministic)."""
    return _canon(obj).encode()
