"""Phase-3 D1: the web-path LSF matches the native 0.25 km/s path.

Native path: the exact Gaussian LSF (FWHM = c/R) of the native 0.25 km/s point samples exp(-tau), evaluated at the
output pixels (written out below, independent of tngsight.degrade).
Web path: what the page and the browser fitter see: tngsight.library.web_flux (the 1 km/s box average), the TNGS v2
u16 round trip (encode_web, decode_web), then tngsight.degrade.degrade_v (docs/tng50/js/fit.js degradeV is the same
operator; tests/js/fit_degrade.mjs runs it on the same lines against the same native reference).
Stored data: tests/js/fixtures/fit_native_edge_b100_a090.json, a trimmed copy of the native optical depth of 8 lines
of one library npz (tests/js/make_fit_fixture.py write_native). Each line is zero-padded so the LSF never meets an edge.

The LSF width is measured with moments: the degraded depth D = 1 - F is the intrinsic depth convolved with the
effective LSF, so sigma_eff^2 = m2(D_out) - m2(D_intrinsic) for any line strength (m2: second central moment).
"""
from __future__ import annotations
import base64
import json
import math
from pathlib import Path

import numpy as np
import pytest

from tngsight import library as L
from tngsight.degrade import degrade_v, lsf_kernel, convolve_extend, lsf_width

C_KMS = 299792.458
FWHM_TO_SIGMA = 1 / 2.35482
FIX = Path(__file__).resolve().parent / "js" / "fixtures" / "fit_native_edge_b100_a090.json"
UV_R = (150000, 100000, 50000, 20000)
XRAY_R = (5000, 1000, 300)
NARROW = ("MgII", "SiII", "CII", "SiIV")          # the lines with the narrowest components (b about 3 km/s)
need_fix = pytest.mark.skipif(not FIX.is_file(), reason=f"native fixture missing: {FIX}")


def stored():
    doc = json.loads(FIX.read_text())
    out = {}
    for k, ln in doc["lines"].items():
        tau = np.frombuffer(base64.b64decode(ln["tau"]), "<f4").astype(np.float64)
        out[k] = (ln["u0"], ln["du"], tau, ln["rest"])
    return doc["v_sys"], out


def padded(line, pad):
    u0, du, tau, _rest = line
    m = int(math.ceil(pad / du))
    t = np.concatenate((np.zeros(m), tau, np.zeros(m)))
    return u0 - m * du + du * np.arange(t.size), t


def native_model(u, tau, R, v, v_sys):
    """sum_i G(v - V_i) F_i / sum_i G(v - V_i) over the 0.25 km/s point samples, G Gaussian of sigma_LSF, +-6 sigma."""
    sig = (C_KMS / R) * FWHM_TO_SIGMA
    du = (u[-1] - u[0]) / (u.size - 1)
    F, out = np.exp(-tau), np.empty(v.size)
    K = int(math.ceil(6 * sig / du))
    for a in range(0, v.size, 256):
        vv = v[a:a + 256]
        j = np.clip(np.rint((vv - u[0] - v_sys) / du).astype(int)[:, None] + np.arange(-K, K + 1)[None, :], 0, u.size - 1)
        e2 = ((vv[:, None] - u[j] - v_sys) / sig) ** 2
        w = np.exp(-0.5 * (e2 - e2.min(axis=1, keepdims=True)))   # beyond the data: the edge sample (continuum)
        out[a:a + 256] = (w * F[j]).sum(1) / w.sum(1)
    return out


def m2(v, D):
    s0 = D.sum()
    mu = (v * D).sum() / s0
    return float(((v - mu) ** 2 * D).sum() / s0)


def web_payload(k, u, tau, v_sys, rest):
    W = int(math.ceil(max(abs(u[0]), abs(u[-1])))) + 1
    return {"lines": [k], "v_sys": v_sys, "u": {k: u}, "tau": {k: tau.astype(np.float32)}, "W": {k: W}, "rest": {k: rest}}


def web_model(u_web, F_web, R, v_sys, op):
    """The web path from the 1 km/s samples; op "old" is the pre-D1 operator (pixel-integrated taps on the 1 km/s grid,
    then linear interpolation onto the output pixels)."""
    v, _, M = degrade_v(u_web, F_web, R, None, v_sys, 1.0)
    if op == "old":
        M = np.interp(v, u_web + v_sys, convolve_extend(F_web, lsf_kernel(R, 1.0)), left=1.0, right=1.0)
    return v, M


def measure(k, R, v_sys, line, op="web"):
    """(sigma_eff/sigma_LSF of the web path, of the native path, max |F_web - F_native| with the page's u16 web data,
    relative EW difference). The widths use the exact box-averaged web flux (library.web_flux): the u16 rounding
    (1.5e-5 in F) is noise on the second moment of a wide complex, not LSF width."""
    sig = (C_KMS / R) * FWHM_TO_SIGMA
    u, tau = padded(line, 8 * sig + 50)
    p = web_payload(k, u, tau, v_sys, line[3])
    v, web = web_model(*L.web_flux(p, k), R, v_sys, op)
    ln = L.decode_web(L.encode_web(p))["lines"][k]
    v16, web16 = web_model(ln["u"], ln["flux"], R, v_sys, op)
    nat = native_model(u, tau, R, v, v_sys)
    assert np.array_equal(v, v16)
    m_int = m2(u + v_sys, -np.expm1(-tau))
    s_web = math.sqrt(m2(v, 1 - web) - m_int) / sig
    s_nat = math.sqrt(m2(v, 1 - nat) - m_int) / sig
    ew_w, ew_n = float((1 - web16).sum()), float((1 - nat).sum())
    return s_web, s_nat, float(np.abs(web16 - nat).max()), abs(ew_w / ew_n - 1)


CASES = [(k, R) for k in ("HI", "MgII", "SiII", "CII", "SiIV", "CIV", "OVI") for R in UV_R] + \
        [("OVII", R) for R in UV_R[::3] + XRAY_R]


@need_fix
@pytest.mark.parametrize("k,R", CASES)
def test_web_path_matches_native_on_stored_npz(k, R):
    """sigma_eff/sigma_LSF of the web path within 3 % of the native path (UV and X-ray band), the native path itself
    nominal, the profiles close and the equivalent width conserved."""
    v_sys, lines = stored()
    s_web, s_nat, dF, dew = measure(k, R, v_sys, lines[k])
    assert abs(s_nat - 1) <= 0.005, (k, R, s_nat)
    assert abs(s_web / s_nat - 1) <= 0.03, (k, R, s_web, s_nat)
    assert dF <= 2e-3, (k, R, dF)
    assert dew <= 1e-3, (k, R, dew)


@need_fix
@pytest.mark.parametrize("k", NARROW)
def test_old_web_operator_fails_the_same_check(k):
    """The comparison has teeth: the pre-D1 operator is more than 10 % too wide on the narrow lines at R = 150k."""
    v_sys, lines = stored()
    s_old, s_nat, _, _ = measure(k, 150000, v_sys, lines[k], op="old")
    s_new, _, _, _ = measure(k, 150000, v_sys, lines[k])
    assert s_old / s_nat > 1.10 and abs(s_new / s_nat - 1) < 0.03, (k, s_old, s_new, s_nat)


def delta_line_sigma(R, path, x0s=np.linspace(0, 1, 16, endpoint=False) + 0.013):
    """sigma_eff/sigma_LSF of a delta-like weak line (sigma 0.05 km/s): the second moment of the degraded depth about the
    true line centre, averaged over sub-pixel positions x0 (one 1 km/s cell cannot place a narrower line better).
    path "native": the old operator on the 0.25 km/s grid (the checker's native path); "web": web_flux then degrade_v."""
    sg = (C_KMS / R) * FWHM_TO_SIGMA
    W = int(max(150, 14 * sg))
    du = 0.25
    u = -W + du * np.arange(int(2 * W / du) + 1)
    half, st = 9 * sg + 3, sg / 15
    out = []
    for x0 in x0s:
        tau = 1e-3 * np.exp(-0.5 * ((u - x0) / 0.05) ** 2)
        if path == "native":
            v = np.arange(-half, half, st)
            M = np.interp(v, u, convolve_extend(np.exp(-tau), lsf_kernel(R, du)))
        else:
            uj, Fw = L.web_flux({"u": {"X": u}, "tau": {"X": tau}, "W": {"X": W}}, "X")
            v, _, M = degrade_v(uj, Fw, R, None, 0.0, 1.0, pix_per_resel=(C_KMS / R) / st, vwin=half)
        D = 1 - M
        out.append(float(np.sum(D * (v - x0) ** 2) / np.sum(D)) - 0.05 ** 2)
    return math.sqrt(np.mean(out)) / sg


@pytest.mark.parametrize("R", UV_R + XRAY_R)
def test_delta_line_width_within_3pc_of_native(R):
    """The checker's narrow-line measurement (C_checks D1), averaged over the line's sub-pixel position."""
    nat, web = delta_line_sigma(R, "native"), delta_line_sigma(R, "web")
    assert abs(web / nat - 1) <= 0.03, (R, nat, web)


@pytest.mark.parametrize("R", [150000, 20000, 5000, 1000, 300, 100])
def test_lsf_width_closed_form(R):
    """s^2 + du^2/12 = sigma_LSF^2 for box-averaged samples; s = sigma_LSF for point samples (box 0)."""
    sg = (C_KMS / R) * FWHM_TO_SIGMA
    s, h = lsf_width(R, 1.0)
    assert s * s + 1 / 12 == pytest.approx(sg * sg, rel=1e-12) and h == max(1, math.ceil(4 * s))
    s0, h0 = lsf_width(R, 0.25, box=0.0)
    assert s0 == pytest.approx(sg, rel=1e-12) and h0 == max(1, math.ceil(4 * sg / 0.25))
