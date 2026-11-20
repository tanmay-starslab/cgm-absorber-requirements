r"""Line-spread-function kernels: the Gaussian used for every published grid, and the tabulated HST/COS LSF.

    gaussian(R)                        FWHM = c/R; delegates to profiles.py, so that path is unchanged.
    cos(grating, cenwave, lp, lam)     STScI optical-model LSF (data/cos_lsf/) at observed wavelength lam [A].

Every kernel has
    fwhm          km/s; the resolution element.  S/N is quoted per FWHM of the LSF, and K and G divide by it.
                  For COS this is the FWHM of the tabulated core (R = c/fwhm), not the 6-pixel resel; to convert,
                  S/N_6pix = S/N_fwhm * sqrt(6 dv_pix / fwhm).
    grid(span, b) (v, step, transfer) for profiles.observed_flux, like profiles.velocity_grid.
    power(n, step) |FT|^2 of the unit-area kernel on np.fft.fftfreq(n, step) (for the K cube).

COS tables give the LSF per detector pixel at wavelengths 5 A apart (FUV, 321 pixels) or 100 A apart (NUV, 101
pixels).  The kernel at lam is the linear interpolation of the two bracketing columns, put on velocity with
dv_pix = c * dispersion / lam (dispersion from the DISPTAB reference file), PCHIP-interpolated onto the fine
velocity grid and renormalised to unit area.  The convolution is continuous (no pixel binning), as for the Gaussian.
"""
from functools import lru_cache
from pathlib import Path
import numpy as np
from scipy.interpolate import PchipInterpolator
from .profiles import C_KMS, FW2SIG, velocity_grid

DATA = Path(__file__).parent / "data" / "cos_lsf"

# (grating, cenwave, LP) -> table, column spacing [A], segments (lam_lo, lam_hi, dispersion [A/pix]).
# FUV segments: DISPTAB 97h1820cl_disp.fits, PSA, pixel 0-16384.  NUV: 63p1559jl_disp.fits, PSA, the one stripe
# (pixel 0-1024) that holds Mg II 2796 at z = 0.  Coverage also requires both bracketing table columns to exist.
COS_SETTINGS = {
    ("G130M", 1055, 2): ("aa_LSFTable_G130M_1055_LP2_cn.dat.gz", 5,
                         [(892.48, 1055.10, 0.009925), (1045.03, 1208.17, 0.009958)]),
    ("G130M", 1096, 2): ("aa_LSFTable_G130M_1096_LP2_cn.dat.gz", 5,
                         [(932.66, 1095.27, 0.009925), (1085.30, 1248.35, 0.009951)]),
    ("G130M", 1291, 4): ("aa_LSFTable_G130M_1291_LP4_cn.dat.gz", 5,
                         [(1124.16, 1287.47, 0.009968), (1277.42, 1440.74, 0.009968)]),
    ("G130M", 1291, 5): ("aa_LSFTable_G130M_1291_LP5_cn.dat.gz", 5,
                         [(1124.16, 1287.47, 0.009968), (1277.42, 1440.74, 0.009968)]),
    ("G160M", 1533, 6): ("aa_LSFTable_G160M_1533_LP6_cn.dat.gz", 5,
                         [(1330.01, 1530.35, 0.012228), (1518.03, 1718.55, 0.012239)]),
    ("G160M", 1577, 4): ("aa_LSFTable_G160M_1577_LP4_cn.dat.gz", 5,
                         [(1374.56, 1575.06, 0.012238), (1562.71, 1763.37, 0.012247)]),
    ("G285M", 2676, None): ("nuv_model_lsf.dat.gz", 100, [(2774.74, 2815.90, 0.040196)]),
}


def setting_name(grating, cenwave, lp):
    return f"{grating}-{cenwave}" + (f"-LP{lp}" if lp else "")


@lru_cache(maxsize=None)
def _table(fname):
    a = np.loadtxt(DATA / fname)
    return a[0], a[1:]


class Gaussian:
    def __init__(self, R):
        self.R, self.fwhm, self.name = R, C_KMS / R, f"Gaussian R={R:.0f}"

    def grid(self, span, b):
        return velocity_grid(span, b, self.R)

    def power(self, n, step):
        # same expression and order as detection.k_cube, so the K cube is bit-for-bit the same
        return np.exp(-4 * np.pi**2 * (np.fft.fftfreq(n, step) ** 2 * (self.fwhm * FW2SIG) ** 2))


class COS:
    def __init__(self, grating, cenwave, lp, lam):
        fname, dw, segs = COS_SETTINGS[(grating, cenwave, lp)]
        self.name, self.lam = setting_name(grating, cenwave, lp), lam
        wave, tab = _table(fname)
        disp = [d for lo, hi, d in segs if lo <= lam <= hi]
        j = int(np.searchsorted(wave, lam))
        if not disp or j == 0 or j == wave.size or wave[j] - wave[j - 1] > 1.01 * dw:
            raise ValueError(f"{self.name} does not cover {lam:.2f} A")
        w = (lam - wave[j - 1]) / (wave[j] - wave[j - 1])
        col = (1 - w) * tab[:, j - 1] + w * tab[:, j]
        self.dv_pix = C_KMS * disp[0] / lam
        self.v_pix = (np.arange(col.size) - col.size // 2) * self.dv_pix
        self.pix = col / col.sum()
        self._f = PchipInterpolator(self.v_pix, self.pix / self.dv_pix, extrapolate=False)
        self.half_width = self.v_pix[-1]
        self.fwhm = self._measure_fwhm()
        self.R = C_KMS / self.fwhm

    def profile(self, v):
        """Kernel density [1/(km/s)], ~unit area; zero beyond the tabulated pixels."""
        return np.nan_to_num(self._f(v))

    def _measure_fwhm(self):
        v = np.arange(-self.half_width, self.half_width, 0.01)
        k = self.profile(v)
        above = np.flatnonzero(k >= k.max() / 2)
        i, j = above[0], above[-1]
        h = k.max() / 2
        lo = v[i - 1] + (h - k[i - 1]) / (k[i] - k[i - 1]) * 0.01
        hi = v[j] + (k[j] - h) / (k[j] - k[j + 1]) * 0.01
        return float(hi - lo)

    def _transfer(self, n, step, fft):
        v = (np.arange(n) - n // 2) * step
        k = self.profile(v)
        return fft(np.fft.ifftshift(k / k.sum()))

    def grid(self, span, b):
        step = min(b / 5.0, self.fwhm * FW2SIG / 3.0, 1.0)
        half = span / 2 + 6 * b + self.half_width + 15
        n = int(2 ** np.ceil(np.log2(2 * half / step)))
        v = (np.arange(n) - n // 2) * step
        return v, step, self._transfer(n, step, np.fft.rfft)

    def power(self, n, step):
        return np.abs(self._transfer(n, step, np.fft.fft)) ** 2


def gaussian(R):
    return Gaussian(R)


def cos(grating, cenwave, lp, lam):
    return COS(grating, cenwave, lp, lam)


def cos_settings_for(lam):
    """Keys (grating, cenwave, lp) of the stored COS settings that cover observed wavelength lam [A]."""
    out = []
    for s in COS_SETTINGS:
        try:
            COS(*s, lam)
            out.append(s)
        except ValueError:
            pass
    return out
