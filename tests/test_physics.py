import numpy as np
from absreq.lines import cgm_lines, get_line
from absreq.detection import k_cube
from absreq.separation import separation_G
from absreq import theory
from absreq.profiles import C_KMS


def test_all_twelve_lines_resolve():
    L = cgm_lines()
    assert len(L) == 12
    assert {l.source for l in L if l.ion in ("Mg II", "O VII")} == {"Morton2003", "Verner1996"}


def test_weak_unresolved_limit():
    """K -> 0.815 W_v / FWHM for a weak, unresolved line."""
    line = get_line("O VI", 1031.9)
    logN, b, R = np.array([11.5]), np.array([10.0]), np.array([1000.0])
    K = k_cube(line, logN, b, R)[0, 0, 0]
    W_v = 8.85e-13 * 10**11.5 * line.f * (line.lam * 1e-8) ** 2 * 1e8 / line.lam * C_KMS
    assert abs(K / (0.8152 * W_v / (C_KMS / 1000)) - 1) < 0.01


def test_small_separation_coefficients():
    for d in (0.15, 0.2):
        assert abs(theory.rho(d, 0.5) / (theory.C4 * d**4) - 1) < 0.01
        assert abs(theory.rho(d, 1 / 3) / (theory.C3(1 / 3) * d**3) - 1) < 0.01


def test_numerical_model_matches_thin_theory():
    line = get_line("C IV", 1548.2)
    b, R, lN = 12.0, 18000.0, 11.5
    se = np.sqrt(b**2 / 2 + (C_KMS / R / 2.35482) ** 2)
    K = k_cube(line, np.array([lN + np.log10(2)]), np.array([b]), np.array([R]))[0, 0, 0]
    for x in (1.5, 2.5):
        r_num = np.sqrt(separation_G(line, lN, b, x * se, R)) / K
        assert abs(r_num / theory.rho(x) - 1) < 0.02
