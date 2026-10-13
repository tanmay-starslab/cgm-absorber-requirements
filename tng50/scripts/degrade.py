#!/usr/bin/env python3
"""Post-process a high-res noiseless spectrum to a chosen spectral resolution R and S/N.

R  -> Gaussian LSF with FWHM = lambda0/R (standard resolving power), applied to the transmission.
S/N-> Gaussian noise defined PER RESOLUTION ELEMENT (PIX_PER_RESEL pixels/element):
      per-pixel sigma = sqrt(PIX_PER_RESEL)/SNR, so averaging one element gives S/N = SNR.
The output is sampled at PIX_PER_RESEL pixels per resolution element and on the velocity axis
V = c(lambda/lambda0 - 1) - v_sys  (galaxy-systemic LOS velocity; +ve = redshifted vs systemic).
Everything is instant (arithmetic on cached arrays), so it drives both the figure and the GUI.
"""
from __future__ import annotations
import numpy as np
from astropy.convolution import Gaussian1DKernel, convolve

C_KMS = 299792.458
PIX_PER_RESEL = 5
FWHM_TO_SIGMA = 1.0 / 2.35482


def degrade(lam, tau, rest, R, snr, v_sys, pix_per_resel=PIX_PER_RESEL, seed=None,
            vwin=None):
    """Return (v, flux) at resolution R and S/N snr. lam,tau = high-res noiseless arrays."""
    lam = np.asarray(lam, float); tau = np.asarray(tau, float)
    flux_hi = np.exp(-tau)
    dlam = float(np.median(np.diff(lam)))
    # LSF convolution (FWHM = lambda0/R)
    sigma_pix = (rest / R) * FWHM_TO_SIGMA / dlam
    flux_lsf = convolve(flux_hi, Gaussian1DKernel(max(sigma_pix, 1e-3)),
                        boundary="extend", normalize_kernel=True) if R and R > 0 else flux_hi
    # resample to pix_per_resel pixels per resolution element
    dv_resel = (C_KMS / R) if (R and R > 0) else float(np.median(np.abs(np.diff(
        C_KMS * (lam / rest - 1)))) * pix_per_resel)
    dv_pix = dv_resel / pix_per_resel
    v_hi = C_KMS * (lam / rest - 1.0) - v_sys
    vlo, vhi = (v_hi.min(), v_hi.max()) if vwin is None else (-vwin, vwin)
    v = np.arange(vlo, vhi + dv_pix, dv_pix)
    flux_model = np.interp(v, v_hi, flux_lsf, left=1.0, right=1.0)   # noiseless, resampled
    # noise per resolution element: per-pixel sigma = sqrt(pix/element)/SNR
    if snr and snr > 0:
        rng = np.random.default_rng(seed)
        sigma_pixel = np.sqrt(pix_per_resel) / float(snr)
        flux_noisy = np.clip(flux_model + rng.normal(0.0, sigma_pixel, size=flux_model.shape), 0.0, None)
    else:
        flux_noisy = flux_model.copy()
    return v, flux_noisy, np.clip(flux_model, 0.0, None)


def resolution_element_kms(R):
    return C_KMS / R if (R and R > 0) else np.nan
