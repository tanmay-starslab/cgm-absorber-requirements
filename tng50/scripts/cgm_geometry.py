#!/usr/bin/env python3
"""CGM sightline geometry for TNG50-1 sub-488530 — compatibility shim over `tngsight.geometry`.

The math now lives in tngsight/geometry.py (identical to the original of this file). Build a QSO
sightline from (orientation, impact parameter b, azimuth Φ) in the galaxy's cold-gas disk frame:
a line of length ±R200c through an anchor at perpendicular distance b, along n_los.
Φ=0 = projected MAJOR axis, Φ=90 = projected MINOR (polar) axis. Endpoints in physical kpc and
ckpc/h (= kpc*TNG_H, yt code_length, box-absolute). v_sys = SubhaloVel · n_los.
Old call sites keep working: the module constants and the legacy positional order of
geom_id(orientation, b, az, inclination_deg, seed) are preserved here.
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cgm_paths  # noqa: E402,F401  (puts the repo root on sys.path)
from tngsight import config as TC  # noqa: E402
from tngsight import geometry as _G  # noqa: E402
from tngsight.geometry import los_from_orientation, sky_axes, make_sightline, canonicalize  # noqa: E402,F401

GAL = TC.GALAXY
H = GAL["TNG_H"]
CENTER_KPC = np.array(GAL["center_kpc"])
R200C = GAL["R200c_kpc"]
LHAT = np.array(GAL["Lhat"]); XHAT = np.array(GAL["xhat"]); YHAT = np.array(GAL["yhat"])
SUBVEL = np.array(GAL["SubhaloVel_kms"])


def geom_id(orientation, b_kpc, azimuth_deg, inclination_deg=None, seed=None):
    """Legacy argument order (inclination before seed); tngsight.geometry.geom_id takes seed first."""
    return _G.geom_id(orientation, b_kpc, azimuth_deg, seed=seed, inclination_deg=inclination_deg)


if __name__ == "__main__":
    for o in ("face-on", "edge-on", "random"):
        s = make_sightline(o, 100.0, 90.0, seed=1)
        print(f"{o:8s} b_check={s['b_perp_check_kpc']:.2f} v_sys={s['v_sys_kms']:+.1f} "
              f"n_los={np.round(s['n_los'],3)} start_ckpch={np.round(s['start_ckpch'],0)}")
