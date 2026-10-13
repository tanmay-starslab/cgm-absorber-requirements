r"""Optically thin, Gaussian-LSF limit: universal statistical resolution curve.

Units: sigma_eff = 1 with sigma_eff^2 = b^2/2 + sigma_LSF^2.  rho(delta, q) = S_res / S_det, where
S_det is the matched-filter significance of the whole blend and q the equivalent-width fraction
of component 1.  Small-separation limits (derived from the first cumulant the single Gaussian
cannot absorb, then projected orthogonally to the fit's tangent space):

    q = 1/2 : rho ~ (sqrt(6)/384) delta^4          (kappa_3 = 0, kappa_4 = -delta^4/8)
    q != 1/2: rho ~ q(1-q)|1-2q| delta^3 / (4 sqrt 3)
"""
import numpy as np
from scipy.optimize import least_squares

C4 = np.sqrt(6.0) / 384.0
FWHM_PER_SIGMA = 2.3548200450309493


def C3(q):
    return q * (1 - q) * abs(1 - 2 * q) / (4 * np.sqrt(3.0))


_X = np.linspace(-40, 40, 32001)
_DX = _X[1] - _X[0]


def _g(x, s=1.0):
    return np.exp(-0.5 * (x / s) ** 2) / (np.sqrt(2 * np.pi) * s)


_NORM = np.sum(_g(_X) ** 2) * _DX


def rho(delta, q=0.5):
    x1, x2 = -(1 - q) * delta, q * delta
    D2 = q * _g(_X - x1) + (1 - q) * _g(_X - x2)
    res = lambda p: (D2 - p[0] * _g(_X - p[1], np.exp(p[2]))) * np.sqrt(_DX)
    best = np.inf
    for p0 in ([1.0, 0.0, 0.5 * np.log(1 + q * (1 - q) * delta**2)], [max(q, 1 - q), x2 if q < 0.5 else x1, 0.0]):
        r = least_squares(res, p0, method="lm", xtol=1e-15, ftol=1e-15, gtol=1e-15, max_nfev=2000)
        best = min(best, 2 * r.cost)
    return float(np.sqrt(best / _NORM))


def dvmin_over_fwhm(S_det, q=0.5, delta=None):
    """Smallest separation (units of FWHM_eff) resolved at 3 sigma, for blend significance S_det."""
    delta = np.logspace(np.log10(0.15), np.log10(8), 70) if delta is None else delta
    r = np.maximum.accumulate([rho(d, q) for d in delta])
    S = np.atleast_1d(S_det).astype(float)
    out = np.where(3 / S <= r[-1], np.interp(3 / S, r, delta), np.nan)
    return out / FWHM_PER_SIGMA
