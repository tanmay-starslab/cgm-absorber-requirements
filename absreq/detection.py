r"""Single-component detectability.

Matched-filter significance with constant continuum noise and S/N quoted per resolution element:

    S_det = (S/N) * K,   K(log N, b, R) = sqrt( Int D(v)^2 dv / FWHM_LSF ),   D = 1 - F_obs.

S_det is linear in S/N, so the 4-D problem is the 3-D cube K times S/N.
"""
import numpy as np
from .profiles import C_KMS, FW2SIG

NSIG = 3.0
N_V, DV = 2**14, 0.25


def k_cube(line, logN, b, R):
    """K[logN, b, R] via Parseval: Int D_conv^2 = (dv/n) sum |FFT(D)|^2 |T|^2."""
    v = (np.arange(N_V) - N_V // 2) * DV
    freq = np.fft.fftfreq(N_V, DV)
    fwhm = C_KMS / R
    T2 = np.exp(-4 * np.pi**2 * np.outer(freq**2, (fwhm * FW2SIG) ** 2))
    K = np.empty((logN.size, b.size, R.size))
    for j, bj in enumerate(b):
        tau = line.tau0(logN, bj)[:, None] * np.exp(-(v / bj) ** 2)[None, :]
        P = np.abs(np.fft.fft(1.0 - np.exp(-tau), axis=1)) ** 2
        K[:, j, :] = np.sqrt((DV / N_V) * P @ T2 / fwhm)
    return K


def logN_min(logN, K_along_N, snr, nsig=NSIG):
    """Minimum detectable log N for one (b, R) column of K; +inf if above the grid, -inf if below."""
    t = nsig / snr
    if t < K_along_N[0]:
        return -np.inf
    if t > K_along_N[-1]:
        return np.inf
    return float(np.interp(np.log(t), np.log(K_along_N), logN))
