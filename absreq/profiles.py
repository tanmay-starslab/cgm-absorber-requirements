"""Doppler-core optical-depth profiles convolved with a Gaussian line-spread function."""
import numpy as np

C_KMS = 299792.458
FW2SIG = 1.0 / (2.0 * np.sqrt(2.0 * np.log(2.0)))


def sigma_lsf(R):
    return C_KMS / R * FW2SIG


def velocity_grid(span, b, R):
    """Grid that resolves both b and the LSF and is wide enough for FFT convolution without wrap-around."""
    sig = sigma_lsf(R)
    step = min(b / 5.0, sig / 3.0, 1.0)
    half = span / 2 + 6 * b + 7 * sig + 15
    n = int(2 ** np.ceil(np.log2(2 * half / step)))
    v = (np.arange(n) - n // 2) * step
    transfer = np.exp(-2 * np.pi**2 * sig**2 * np.fft.rfftfreq(n, step) ** 2)
    return v, step, transfer


def optical_depth(v, line, comps):
    """comps: iterable of (logN, b, v_centre)."""
    tau = np.zeros_like(v)
    for logN, b, vc in comps:
        tau += line.tau0(logN, b) * np.exp(-((v - vc) / b) ** 2)
    return tau


def observed_flux(v, transfer, line, comps):
    D = 1.0 - np.exp(-optical_depth(v, line, comps))
    return 1.0 - np.fft.irfft(np.fft.rfft(D) * transfer, n=v.size)
