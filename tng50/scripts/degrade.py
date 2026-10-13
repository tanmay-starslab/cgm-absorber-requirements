#!/usr/bin/env python3
"""Post-process a high-res noiseless spectrum to a chosen spectral resolution R and S/N.
Compatibility shim over `tngsight.degrade` (the single implementation shared with the server).

R  -> Gaussian LSF with FWHM = lambda0/R, applied to the transmission. The kernel width in pixels
      uses the generation step dlam = 0.002 A (tngsight.config.DLAMBDA), not median(diff(lam)):
      the float32 grid has quantised steps, which made the realised FWHM -0.7..+2.4 % off nominal.
S/N-> Gaussian noise PER RESOLUTION ELEMENT: per-pixel sigma = sqrt(PIX_PER_RESEL)/SNR.
Output is sampled at PIX_PER_RESEL pixels per element on V = c(lambda/lambda0 - 1) + v_sys
(galaxy systemic at V=0). The original used "- v_sys", which put the galaxy near -2 v_sys,
because Trident's line of sight is start-end = -n_los while the stored v_sys = SubhaloVel . n_los.
Legacy signature kept: degrade(lam, tau, rest, R, snr, v_sys, pix_per_resel, seed, vwin[, dlam]).
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np

try:
    import tngsight  # noqa: F401
except ImportError:                                   # plain script run: add the repo root
    sys.path.insert(1, str(Path(__file__).resolve().parents[2]))
from tngsight import degrade as _D  # noqa: E402
from tngsight.config import C_KMS, PIX_PER_RESEL, FWHM_TO_SIGMA, DLAMBDA, VSYS_SIGN  # noqa: E402,F401
from tngsight.degrade import velocity_axis  # noqa: E402,F401


def degrade(lam, tau, rest, R, snr, v_sys, pix_per_resel=PIX_PER_RESEL, seed=None,
            vwin=None, dlam=DLAMBDA):
    """Return (v, flux_noisy, flux_model) at resolution R and S/N snr (see tngsight.degrade)."""
    return _D.degrade(lam, tau, rest, R, snr, v_sys, dlam=dlam, pix_per_resel=pix_per_resel,
                      seed=seed, vwin=vwin)


def resolution_element_kms(R):
    return C_KMS / R if (R and R > 0) else np.nan
