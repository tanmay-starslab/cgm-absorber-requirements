r"""Two-component resolvability.

Truth: two components (log N, b) at -Dv/2 and +Dv/2.  Alternative: the best single component
(N1, b1, v1).  Both convolved with a Gaussian LSF.  The expected chi^2 penalty is

    Dchi2 = (S/N)^2 G,   G = min Int (F_2 - F_1)^2 dv / FWHM_LSF,

so S_res = (S/N) sqrt(G) and the pair is resolved at 3 sigma when S_res >= 3.
"""
import numpy as np
from scipy.optimize import least_squares
from .profiles import C_KMS, velocity_grid, observed_flux

NSIG = 3.0


def separation_G(line, logN, b, dv_sep, R):
    v, step, T = velocity_grid(dv_sep, b, R)
    w = np.sqrt(step / (C_KMS / R))
    Ft = observed_flux(v, T, line, [(logN, b, -dv_sep / 2), (logN, b, dv_sep / 2)])

    def resid(x):
        return (Ft - observed_flux(v, T, line, [(x[0], np.exp(np.clip(x[1], -3.0, 8.0)), x[2])])) * w

    best = np.inf
    for x0 in ([logN + np.log10(2), np.log(np.sqrt(b**2 + dv_sep**2 / 2)), 0.0],   # one broad component
               [logN, np.log(b), dv_sep / 2]):                                    # one member of the pair
        r = least_squares(resid, x0, method="lm", xtol=1e-12, ftol=1e-12, gtol=1e-12, max_nfev=600)
        best = min(best, 2 * r.cost)
    return best


def sparrow(R, b):
    """Classical Sparrow separation for two equal thin components: 2 sigma_eff."""
    return 2 * np.sqrt(b**2 / 2 + (C_KMS / R / 2.3548200450309493) ** 2)


def dv_min(dv, G_along_dv, snr, nsig=NSIG):
    """Smallest separation resolved at nsig (log-log interpolation); +inf if none in the grid."""
    target = (nsig / snr) ** 2
    ok = G_along_dv >= target
    if not ok.any():
        return np.inf
    j = int(np.argmax(ok))
    if j == 0:
        return float(dv[0])
    x0, x1 = np.log(dv[j - 1]), np.log(dv[j])
    y0, y1 = np.log(max(G_along_dv[j - 1], 1e-300)), np.log(G_along_dv[j])
    return float(np.exp(x0 + (np.log(target) - y0) * (x1 - x0) / (y1 - y0)))
