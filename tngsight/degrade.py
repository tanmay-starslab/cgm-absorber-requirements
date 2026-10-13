"""Post-process a high-res noiseless spectrum to resolving power R and S/N (port of
tng50/scripts/degrade.py).

R  -> Gaussian LSF with FWHM = λ0/R, applied to the transmission; the kernel width in pixels uses
      the EXPLICIT grid step `dlam` (0.002 Å for the 3-ion library), not median(diff(λ)).
S/N-> Gaussian noise per resolution element: per-pixel sigma = sqrt(PIX_PER_RESEL)/SNR.
Output sampled at PIX_PER_RESEL pixels per resolution element on the velocity axis
V = c(λ/λ0 − 1) + VSYS_SIGN*v_sys (galaxy systemic at V = 0; +ve = redshifted vs systemic).
"""
from __future__ import annotations
import math
import numpy as np
from astropy.convolution import Gaussian1DKernel, convolve
from .config import C_KMS, DLAMBDA, PIX_PER_RESEL, FWHM_TO_SIGMA, VSYS_SIGN


def velocity_axis(lam, rest, v_sys) -> np.ndarray:
    """Systemic-frame LOS velocity [km/s] of observed wavelengths `lam` for a line at `rest`."""
    return C_KMS * (np.asarray(lam, float) / rest - 1.0) + VSYS_SIGN * float(v_sys)


def _has_lsf(R):
    return R is not None and math.isfinite(R) and R > 0


def degrade(lam, tau, rest, R, snr, v_sys, dlam=DLAMBDA, pix_per_resel=PIX_PER_RESEL, seed=None,
            vwin=None):
    """Return (v, flux_noisy, flux_model) at resolution R and S/N snr (same order as the original).
    R None/0/inf -> no LSF, output step = native median velocity step * pix_per_resel."""
    lam = np.asarray(lam, float); tau = np.asarray(tau, float)
    flux_hi = np.exp(-tau)
    if _has_lsf(R):
        sigma_pix = (rest / R) * FWHM_TO_SIGMA / float(dlam)
        flux_lsf = convolve(flux_hi, Gaussian1DKernel(max(sigma_pix, 1e-3)),
                            boundary="extend", normalize_kernel=True)
        dv_resel = C_KMS / R
    else:
        flux_lsf = flux_hi
        dv_resel = float(np.median(np.abs(np.diff(C_KMS * (lam / rest - 1))))) * pix_per_resel
    dv_pix = dv_resel / pix_per_resel
    v_hi = velocity_axis(lam, rest, v_sys)
    vlo, vhi = (v_hi.min(), v_hi.max()) if vwin is None else (-vwin, vwin)
    v = np.arange(vlo, vhi + dv_pix, dv_pix)
    flux_model = np.interp(v, v_hi, flux_lsf, left=1.0, right=1.0)
    if snr and snr > 0:
        rng = np.random.default_rng(seed)
        sigma_pixel = np.sqrt(pix_per_resel) / float(snr)
        flux_noisy = np.clip(flux_model + rng.normal(0.0, sigma_pixel, size=flux_model.shape), 0.0, None)
    else:
        flux_noisy = flux_model.copy()
    return v, flux_noisy, np.clip(flux_model, 0.0, None)


def resolution_element_kms(R):
    return C_KMS / R if _has_lsf(R) else np.nan
