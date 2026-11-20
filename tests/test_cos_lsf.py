"""Tabulated HST/COS LSF (absreq/lsf.py): kernel sanity, STScI resolution, and the Gaussian path left untouched."""
from pathlib import Path
import sys
import numpy as np
import pytest
from absreq import lsf
from absreq.lines import cgm_lines, get_line
from absreq.detection import k_cube, k_cube_lsf, DV, N_V
from absreq.separation import separation_G, separation_G_lsf
from absreq.profiles import C_KMS

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_grids import axes, R_DET, R_SEP  # noqa: E402

LINES = {L.key: L for L in cgm_lines()}
PAIRS = [(L, s) for L in LINES.values() for s in lsf.cos_settings_for(L.lam)]


def test_gaussian_kernel_path_is_bit_identical():
    """lsf.gaussian(R) through the new kernel path reproduces k_cube / separation_G exactly."""
    L = LINES["CIV1548"]
    lN, b, lNs, dv = axes(L)
    assert np.array_equal(k_cube_lsf(L, lN, b, [lsf.gaussian(R) for R in R_DET]), k_cube(L, lN, b, R_DET))
    for i, j, k in [(0, 0, 0), (5, 10, 8), (13, 23, 16)]:
        assert separation_G_lsf(L, lNs[i], L.b_fid, dv[j], lsf.gaussian(R_SEP[k])) == \
            separation_G(L, lNs[i], L.b_fid, dv[j], R_SEP[k])


def test_published_gaussian_grid_reproduces():
    """The stored O VI grid is recomputed by the (unchanged) Gaussian code.  Not bit-for-bit across machines:
    numpy/BLAS/libm differences give ~1e-15 in K and up to ~1e-8 in G (optimiser tolerance), also on origin/main."""
    L = LINES["OVI1032"]
    g = np.load(ROOT / "grids" / f"{L.key}.npz")
    lN, b, lNs, dv = axes(L)
    np.testing.assert_allclose(k_cube(L, lN, b, R_DET), g["K"], rtol=1e-12, atol=0)
    for i, j, k in [(0, 0, 0), (5, 10, 8), (13, 23, 16)]:
        assert separation_G(L, lNs[i], L.b_fid, dv[j], R_SEP[k]) == pytest.approx(g["G"][i, j, k], rel=1e-6)


@pytest.mark.parametrize("L,s", PAIRS, ids=[f"{L.key}-{lsf.setting_name(*s)}" for L, s in PAIRS])
def test_cos_kernel_unit_area(L, s):
    k = lsf.cos(*s, L.lam)
    v = np.arange(-k.half_width, k.half_width, 0.01)
    assert abs(k.profile(v).sum() * 0.01 - 1) < 2e-4
    T = k.grid(50.0, L.b_fid)[2]
    assert abs(T[0] - 1) < 1e-12 and abs(k.power(N_V, DV)[0] - 1) < 1e-12


@pytest.mark.parametrize("key,s", [("CIV1548", ("G160M", 1577, 4)), ("SiIV1403", ("G130M", 1291, 4)),
                                   ("MgII2796", ("G285M", 2676, None))])
def test_narrow_line_limit(key, s):
    """Weak unresolved line: D_obs -> W_v * LSF, so K -> W_v sqrt(Int LSF^2 dv / FWHM), for any LSF shape."""
    L, k = LINES[key], lsf.cos(*s, LINES[key].lam)
    logN = L.logN_tau1(b=0.5) - 3                      # tau0 = 1e-3, b = 0.5 km/s << FWHM
    K = k_cube_lsf(L, np.array([logN]), np.array([0.5]), [k])[0, 0, 0]
    W_v = 8.85e-13 * 10**logN * L.f * (L.lam * 1e-8) ** 2 * 1e8 / L.lam * C_KMS
    v = np.arange(-k.half_width, k.half_width, 0.01)
    assert abs(K / (W_v * np.sqrt((k.profile(v) ** 2).sum() * 0.01 / k.fwhm)) - 1) < 0.01


# R = lambda/FWHM ranges from COS IHB Table 5.1 (PSA): G130M/1291 12,000-17,000; G160M 13,000-20,000 (at LP1, slightly
# lower at later LPs); G130M blue modes (1055/1096) "up to ~13,000".
@pytest.mark.parametrize("key,s,lo,hi", [
    ("HI1216", ("G130M", 1291, 4), 12000, 17000), ("SiII1260", ("G130M", 1291, 4), 12000, 17000),
    ("CII1335", ("G130M", 1291, 5), 12000, 17000), ("SiIV1403", ("G130M", 1291, 5), 12000, 17500),
    ("CIV1548", ("G160M", 1577, 4), 13000, 20000), ("CIV1548", ("G160M", 1533, 6), 12500, 20000),
    ("OVI1032", ("G130M", 1096, 2), 5000, 13000)])
def test_cos_fwhm_matches_stsci_resolution(key, s, lo, hi):
    assert lo <= lsf.cos(*s, LINES[key].lam).R <= hi


def test_nuv_model_lsf_width():
    """The STScI NUV optical-model LSF has a ~2-pixel FWHM (R ~ 35,000 for G285M at 2796 A), narrower than the
    empirical IHB value (20,000-24,000).  Recorded here so a change in the table or its reading is noticed."""
    k = lsf.cos("G285M", 2676, None, LINES["MgII2796"].lam)
    assert 1.9 < k.fwhm / k.dv_pix < 2.2


def test_coverage():
    assert lsf.cos_settings_for(LINES["MgII2796"].lam) == [("G285M", 2676, None)]
    assert ("G130M", 1291, 4) not in lsf.cos_settings_for(LINES["OVI1032"].lam)
    assert {("G130M", 1055, 2), ("G130M", 1096, 2)} <= set(lsf.cos_settings_for(LINES["OVI1032"].lam))
    with pytest.raises(ValueError):
        lsf.cos("G130M", 1291, 4, 1280.0)      # FUV detector gap
    assert not lsf.cos_settings_for(get_line("Ne VIII", 770.4).lam)
