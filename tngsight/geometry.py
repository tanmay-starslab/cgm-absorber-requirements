"""CGM sightline geometry for TNG50-1 sub-488530 (port of tng50/scripts/cgm_geometry.py, same math).

Sightline = line of length ±R200c through an anchor at perpendicular distance b from the centre,
along n_los set by the orientation. Φ=0 = projected MAJOR axis, Φ=90 = projected MINOR (polar)
axis. Endpoints in physical kpc and ckpc/h (= kpc*TNG_H, yt code_length, box-absolute).
v_sys = SubhaloVel · n_los (stored convention; the spectrum frame uses +v_sys, see config.VSYS_SIGN).
"""
from __future__ import annotations
import math
import numbers
import numpy as np
from .config import GALAXY as GAL, B_MAX_KPC

H = GAL["TNG_H"]
CENTER_KPC = np.array(GAL["center_kpc"])
R200C = GAL["R200c_kpc"]
LHAT = np.array(GAL["Lhat"]); XHAT = np.array(GAL["xhat"]); YHAT = np.array(GAL["yhat"])
SUBVEL = np.array(GAL["SubhaloVel_kms"])
SEED_MAX = 2**32 - 1


def _unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def los_from_orientation(orientation, seed=None, inclination_deg=None) -> np.ndarray:
    """Line-of-sight unit vector: face-on ∥ Lhat, edge-on = xhat, random = seeded normal draw;
    inclination_deg (0=face-on, 90=edge-on) rotates in the Lhat–xhat plane."""
    if inclination_deg is not None:
        i = np.radians(float(inclination_deg))
        return _unit(np.cos(i) * LHAT + np.sin(i) * XHAT)
    o = str(orientation).lower()
    if o.startswith("face"):
        return LHAT.copy()
    if o.startswith("edge"):
        return XHAT.copy()
    rng = np.random.default_rng(seed)
    v = rng.normal(size=3)
    return _unit(v)


def sky_axes(n_los) -> tuple:
    """(e_major, e_minor): projected disk-plane and polar unit axes in the sky plane ⟂ n_los."""
    e_minor = LHAT - np.dot(LHAT, n_los) * n_los
    if np.linalg.norm(e_minor) < 1e-6:          # face-on: Φ measured from xhat
        e_major = _unit(XHAT - np.dot(XHAT, n_los) * n_los)
        e_minor = _unit(np.cross(n_los, e_major))
        return e_major, e_minor
    e_minor = _unit(e_minor)
    e_major = _unit(np.cross(n_los, e_minor))
    return e_major, e_minor


def make_sightline(orientation, b_kpc, azimuth_deg, seed=None, inclination_deg=None,
                   half_kpc=None) -> dict:
    """Full geometry dict (key order = stored npz `geom` JSON)."""
    half = R200C if half_kpc is None else float(half_kpc)
    n_los = los_from_orientation(orientation, seed=seed, inclination_deg=inclination_deg)
    e_major, e_minor = sky_axes(n_los)
    phi = np.radians(float(azimuth_deg))
    rho_hat = np.cos(phi) * e_major + np.sin(phi) * e_minor
    anchor_kpc = CENTER_KPC + b_kpc * rho_hat
    start_kpc = anchor_kpc - half * n_los
    end_kpc = anchor_kpc + half * n_los
    v_sys = float(np.dot(SUBVEL, n_los))
    b_check = float(np.linalg.norm((anchor_kpc - CENTER_KPC)
                                   - np.dot(anchor_kpc - CENTER_KPC, n_los) * n_los))
    return dict(
        orientation=str(orientation), b_kpc=float(b_kpc), azimuth_deg=float(azimuth_deg),
        inclination_deg=(None if inclination_deg is None else float(inclination_deg)),
        n_los=n_los.tolist(), v_sys_kms=v_sys, half_kpc=half, b_perp_check_kpc=b_check,
        anchor_kpc=anchor_kpc.tolist(),
        start_kpc=start_kpc.tolist(), end_kpc=end_kpc.tolist(),
        start_ckpch=(start_kpc * H).tolist(), end_ckpch=(end_kpc * H).tolist())


def geom_id(orientation, b_kpc, azimuth_deg, seed=None, inclination_deg=None) -> str:
    """`<face|edge|rand>_bBBB_aAAA[_iIII][_sSEED]` (Python round, so 12.5 -> 12).
    NOTE: argument order is (…, seed, inclination_deg); the original had inclination first."""
    o = {"face-on": "face", "edge-on": "edge", "random": "rand"}.get(str(orientation).lower(),
                                                                     str(orientation)[:4])
    inc = "" if inclination_deg is None else f"_i{int(round(inclination_deg)):03d}"
    sd = f"_s{int(seed)}" if (o == "rand" and seed is not None) else ""
    return f"{o}_b{int(round(b_kpc)):03d}_a{int(round(azimuth_deg)):03d}{inc}{sd}"


_ALIASES = {"face": "face-on", "faceon": "face-on", "edge": "edge-on", "edgeon": "edge-on",
            "rand": "random", "random": "random"}


def _number(x, name):
    if isinstance(x, bool) or not isinstance(x, numbers.Real):
        raise ValueError(f"{name} must be a number, got {x!r}")
    x = float(x)
    if not math.isfinite(x):
        raise ValueError(f"{name} must be finite, got {x!r}")
    return x


def canonicalize(orientation, b_kpc, azimuth_deg, seed=None) -> dict:
    """Validate + quantise a request: integer b (Python round) in [0, B_MAX_KPC], az = round % 360,
    seed required int in [0, 2**32-1] for random (forced None otherwise). Raises ValueError."""
    key = "".join(ch for ch in str(orientation).strip().lower() if ch not in "-_ ")
    if key not in _ALIASES:
        raise ValueError(f"orientation must be face-on, edge-on or random, got {orientation!r}")
    o = _ALIASES[key]
    b = int(round(_number(b_kpc, "b_kpc")))
    if not 0 <= b <= B_MAX_KPC:
        raise ValueError(f"b_kpc must be in [0, {B_MAX_KPC:g}] kpc after rounding, got {b_kpc!r}")
    az = int(round(_number(azimuth_deg, "azimuth_deg"))) % 360
    if o == "random":
        if seed is None:
            raise ValueError("seed is required for random orientation")
        s = _number(seed, "seed")
        if not s.is_integer() or not 0 <= s <= SEED_MAX:
            raise ValueError(f"seed must be an integer in [0, {SEED_MAX}], got {seed!r}")
        seed = int(s)
    else:
        seed = None
    return {"orientation": o, "b_kpc": float(b), "azimuth_deg": float(az), "seed": seed,
            "id": geom_id(o, b, az, seed=seed)}
