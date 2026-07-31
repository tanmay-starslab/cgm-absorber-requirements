#!/usr/bin/env python3
"""CGM sightline geometry for TNG50-1 sub-488530.

Build a QSO sightline through the CGM from (orientation, impact parameter b, azimuthal angle Φ)
in the galaxy's cold-gas disk frame. The sightline is a line of length ±R200c through an anchor
at perpendicular distance b from the centre, along a line-of-sight n_los set by the orientation.

Azimuth convention (standard CGM): Φ=0 = projected MAJOR axis (disk plane); Φ=90 = projected
MINOR axis (polar). Endpoints are returned in physical kpc AND in ckpc/h (= kpc*TNG_H, the
Trident/yt code_length, box-absolute). v_sys = SubhaloVel · n_los.
"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np

GAL = json.loads((Path(__file__).resolve().parent.parent / "galaxy_488530.json").read_text())
H = GAL["TNG_H"]
CENTER_KPC = np.array(GAL["center_kpc"])
R200C = GAL["R200c_kpc"]
LHAT = np.array(GAL["Lhat"]); XHAT = np.array(GAL["xhat"]); YHAT = np.array(GAL["yhat"])
SUBVEL = np.array(GAL["SubhaloVel_kms"])


def _unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def los_from_orientation(orientation, seed=None, inclination_deg=None):
    """Return the line-of-sight unit vector n_los for a named orientation.
    face-on: n_los ∥ Lhat (look down the disk axis). edge-on: n_los ⟂ Lhat (in disk plane).
    random: a random direction (seeded). inclination_deg: explicit angle between Lhat and n_los
    (0=face-on, 90=edge-on), rotated in the Lhat–xhat plane."""
    if inclination_deg is not None:
        i = np.radians(float(inclination_deg))
        return _unit(np.cos(i) * LHAT + np.sin(i) * XHAT)
    o = str(orientation).lower()
    if o.startswith("face"):
        return LHAT.copy()
    if o.startswith("edge"):
        return XHAT.copy()
    # random: uniform on the sphere
    rng = np.random.default_rng(seed)
    v = rng.normal(size=3)
    return _unit(v)


def sky_axes(n_los):
    """Projected minor (polar) and major (disk-plane) unit axes in the sky plane ⟂ n_los."""
    e_minor = Lhat_perp = LHAT - np.dot(LHAT, n_los) * n_los
    if np.linalg.norm(e_minor) < 1e-6:          # face-on: circular projection, Φ degenerate
        e_major = _unit(XHAT - np.dot(XHAT, n_los) * n_los)
        e_minor = _unit(np.cross(n_los, e_major))
        return e_major, e_minor
    e_minor = _unit(e_minor)
    e_major = _unit(np.cross(n_los, e_minor))
    return e_major, e_minor


def make_sightline(orientation, b_kpc, azimuth_deg, seed=None, inclination_deg=None,
                   half_kpc=None):
    """Full geometry for one sightline. Returns endpoints (kpc + ckpc/h), n_los, v_sys, etc."""
    half = R200C if half_kpc is None else float(half_kpc)
    n_los = los_from_orientation(orientation, seed=seed, inclination_deg=inclination_deg)
    e_major, e_minor = sky_axes(n_los)
    phi = np.radians(float(azimuth_deg))
    rho_hat = np.cos(phi) * e_major + np.sin(phi) * e_minor        # ⟂ n_los, |.|=1
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


def geom_id(orientation, b_kpc, azimuth_deg, inclination_deg=None):
    o = {"face-on": "face", "edge-on": "edge", "random": "rand"}.get(str(orientation).lower(),
                                                                     str(orientation)[:4])
    inc = "" if inclination_deg is None else f"_i{int(round(inclination_deg)):03d}"
    return f"{o}_b{int(round(b_kpc)):03d}_a{int(round(azimuth_deg)):03d}{inc}"


if __name__ == "__main__":
    for o in ("face-on", "edge-on", "random"):
        s = make_sightline(o, 100.0, 90.0, seed=1)
        print(f"{o:8s} b_check={s['b_perp_check_kpc']:.2f} v_sys={s['v_sys_kms']:+.1f} "
              f"n_los={np.round(s['n_los'],3)} start_ckpch={np.round(s['start_ckpch'],0)}")
