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


# ------------------------------------------------------------------------------- v2 (velocity grid)
def lsf_kernel(R, du):
    """Pixel-integrated Gaussian LSF taps (design §3.4 step 1): σ_pix = (c/R)·FWHM_TO_SIGMA/du,
    h = max(1, ceil(4σ_pix)), k_j = ½[erf((j+½)/(√2σ_pix)) − erf((j−½)/(√2σ_pix))], j = −h..h, Σk = 1.
    The pre-D1 v2 operator (kept for reference and tests); degrade_v now samples with lsf_weights."""
    from scipy.special import erf
    sig = (C_KMS / float(R)) * FWHM_TO_SIGMA / float(du)
    h = max(1, int(math.ceil(4.0 * sig)))
    j = np.arange(-h, h + 1, dtype=np.float64)
    s2 = math.sqrt(2.0) * sig
    k = 0.5 * (erf((j + 0.5) / s2) - erf((j - 0.5) / s2))
    return k / k.sum()


def convolve_extend(flux, k):
    """flux ⊛ k (odd, symmetric) with the edge value repeated beyond both ends ("extend"); same length."""
    flux = np.asarray(flux, np.float64)
    h = (k.size - 1) // 2
    padded = np.concatenate((np.full(h, flux[0]), flux, np.full(h, flux[-1])))
    if padded.size * k.size > 4e7:                       # big kernels (low R): FFT, identical to ~1e-15
        from scipy.signal import fftconvolve
        return fftconvolve(padded, k, mode="valid")
    return np.convolve(padded, k, mode="valid")


# Phase-3 D1. The web flux is already the box average of the native flux over each du cell (library.web_flux), so
# the old operator (pixel-integrated taps, a second box, then linear interpolation onto the output pixels) blurred
# the LSF by du²/12 + du²/12 + t(1−t)du² in variance: 16–30 % too wide in σ at R = 150k. The sampling operator below
# evaluates the Gaussian at the true offsets of the samples from each output pixel (no interpolation step) with
# σ_s² = σ_LSF² − box²/12, so samples that are box averages (box = du) get exactly σ_LSF² in total and point samples
# (box = 0: the native τ grid, or the browser fitter's model) get σ_s = σ_LSF.
LSF_FLOOR = 0.3          # σ_s ≥ LSF_FLOOR·du (reached only above R ≈ 3e5 on a 1 km/s grid, beyond the registry ranges)
LSF_HALF = 4.0           # taps j = jc − h..jc + h, h = max(1, ceil(LSF_HALF·σ_s/du))


def lsf_width(R, du, box=None):
    """(σ_s, h) of the sampling Gaussian: σ_s² = (c/R·FWHM_TO_SIGMA)² − box²/12 (box None -> du; 0 for point
    samples), floored at (LSF_FLOOR·du)²; h = max(1, ceil(LSF_HALF·σ_s/du)) taps each side."""
    du = float(du)
    box = du if box is None else float(box)
    sig = (C_KMS / float(R)) * FWHM_TO_SIGMA
    s = math.sqrt(max(sig * sig - box * box / 12.0, (LSF_FLOOR * du) ** 2))
    return s, max(1, int(math.ceil(LSF_HALF * s / du)))


def lsf_weights(v, u0, du, n, v_sys, R, box=None):
    """Sampling operator from samples f_j at V_j = (u0 + j·du) + v_sys (j = 0..n−1) to the output velocities v:
    out[m] = Σ_t w[m, t]·f[idx[m, t]] for the pixels with inside[m] (V_0 ≤ v_m ≤ V_{n−1}; the others are continuum).
    jc = floor((v_m − V_0)/du + ½) (nearest sample), taps j = jc − h..jc + h, w ∝ exp(−½((v_m − V_j)/σ_s)²)
    normalised to Σ_t w = 1, idx = clip(j, 0, n − 1) (edge extend). docs/tng50/js/fit.js makeSampler is the same.
    Returns (idx, w, inside)."""
    s, h = lsf_width(R, du, box)
    v = np.asarray(v, np.float64)
    du = float(du); u0 = float(u0); v_sys = float(v_sys)
    V0 = (u0 + 0 * du) + v_sys
    Vn = (u0 + (n - 1) * du) + v_sys
    jc = np.floor((v - V0) / du + 0.5).astype(np.int64)
    j = jc[:, None] + np.arange(-h, h + 1, dtype=np.int64)[None, :]
    e = (v[:, None] - ((u0 + j * du) + v_sys)) / s
    w = np.exp(-0.5 * e * e)
    w /= w.sum(axis=1, keepdims=True)
    return np.clip(j, 0, n - 1), w, (v >= V0) & (v <= Vn)


def lsf_sample(f, op, fill=1.0):
    """Apply an lsf_weights operator op = (idx, w, inside) to the samples f; pixels outside get `fill`."""
    idx, w, inside = op
    out = np.einsum("ij,ij->i", w, np.asarray(f, np.float64)[idx])
    return np.where(inside, out, float(fill))


def degrade_v(u, flux, R, snr, v_sys, du, pix_per_resel=PIX_PER_RESEL, seed=None, vwin=None, vcenter=0.0, box=None):
    """v2 degrade operator on a constant-velocity grid (design §3.4 as amended by Phase-3 D1; the page and the browser
    fitter use the same, docs/tng50/js/fit.js degradeV). u: rest-frame velocities (km/s, u = u[0] + du·arange(n));
    flux: transmission samples on u, by default box averages over each du cell (the web flux; box=0 for point samples
    such as the native τ grid). Returns (v, flux_noisy, flux_model) on v = arange(lo, hi + dv_pix, dv_pix),
    dv_pix = (c/R)/pix_per_resel, with [lo, hi] = vcenter ± vwin (or the full V = u + v_sys range). The model is the
    Gaussian LSF (FWHM = c/R) of the underlying flux at v (lsf_weights). R None/0/inf -> no LSF: linear
    interpolation of the samples and dv_pix = du·pix_per_resel."""
    u = np.asarray(u, np.float64); flux = np.asarray(flux, np.float64)
    V = u + VSYS_SIGN * float(v_sys)
    lsf = _has_lsf(R)
    dv_pix = (C_KMS / float(R)) / pix_per_resel if lsf else float(du) * pix_per_resel
    if vwin is None:
        lo, hi = float(V[0]), float(V[-1])
    else:
        lo, hi = float(vcenter) - float(vwin), float(vcenter) + float(vwin)
    v = np.arange(lo, hi + dv_pix, dv_pix)
    if lsf:
        model = lsf_sample(flux, lsf_weights(v, u[0], du, u.size, VSYS_SIGN * float(v_sys), R, box), 1.0)
    else:
        model = np.interp(v, V, flux, left=1.0, right=1.0)
    if snr and snr > 0:
        rng = np.random.default_rng(seed)
        sigma = math.sqrt(pix_per_resel) / float(snr)
        noisy = np.clip(model + rng.normal(0.0, sigma, size=model.shape), 0.0, None)
    else:
        noisy = model.copy()
    return v, noisy, model
