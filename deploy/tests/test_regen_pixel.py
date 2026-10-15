"""The reported pixel-level v1-vs-v3 comparison of deploy/data/regen_library.py (C1 / D3): a narrow line binned the
way Trident bins v1 (left-edge label, mean of 10 sub-bins over [λ_k, λ_k + dλ)) sits about dλ/2 blue of the same line
on a fine v3 grid, and the comparison measures that shift."""
import importlib.util
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("regen_library", ROOT / "deploy" / "data" / "regen_library.py")
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)
C = 299792.458


def _tau(u, b=4.0, t0=30.0):
    return t0 * np.exp(-(u / b) ** 2)


def test_pixel_compare_measures_the_left_edge_offset():
    rest = 977.02
    du1 = C * 0.002 / rest                                    # v1 bin (0.614 km/s at 977 Å)
    u1 = -60.0 + du1 * np.arange(int(120 / du1))              # left edges
    t1 = np.mean([_tau(u1 + j * du1 / 10) for j in range(10)], axis=0)
    u3 = np.arange(-80.0, 80.0001, 0.25)
    t3 = _tau(u3)
    v1 = {"u": {"CIII": u1}, "tau": {"CIII": t1}, "du": {"CIII": du1}}
    v3 = {"u": {"CIII": u3}, "tau": {"CIII": t3}, "du": {"CIII": 0.25}}
    r = R.pixel_compare(v1, v3, keys=("CIII", "OVI"))
    assert list(r) == ["CIII"]
    x = r["CIII"]
    assert x["half_dlam_kms"] == round(du1 / 2, 4)
    assert math.isclose(x["shift_kms"], 0.45 * du1, abs_tol=0.02)          # dλ/2 − dλ/20 for 10 sub-bins
    assert x["rel_p99_centre"] < x["rel_p99"] and x["rel_p99"] > 0.1


def test_pixel_compare_identical_grids():
    u = np.arange(-50.0, 50.0001, 0.5)
    p = {"u": {"OVI": u}, "tau": {"OVI": _tau(u, 10.0, 5.0)}, "du": {"OVI": 0.5}}
    x = R.pixel_compare(p, p, keys=("OVI",))["OVI"]
    assert x["rel_p99"] == 0.0 and x["shift_kms"] == 0.0
    weak = {"u": {"OVI": u}, "tau": {"OVI": _tau(u, 10.0, 0.5)}, "du": {"OVI": 0.5}}
    assert R.pixel_compare(weak, weak) == {}                # no pixel with τ > 1
