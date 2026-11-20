# HST/COS line-spread-function tables

STScI optical-model LSF tables for the Cosmic Origins Spectrograph, used by `absreq/lsf.py`.

- Source page: https://www.stsci.edu/hst/instrumentation/cos/performance/spectral-resolution
  (files under `https://www.stsci.edu/files/live/sites/www/files/home/hst/instrumentation/cos/performance/spectral-resolution/_documents/<name>.dat`)
- Retrieved: 2026-11-19. Stored gzipped (`gzip -9 -n`); `gunzip` gives the original bytes.
- Terms: STScI Content Use Policy (https://www.stsci.edu/copyright): material produced by STScI for NASA carries no
  copyright claim and may be used freely as public domain; acknowledgement of NASA and STScI is requested.
  See `THIRD_PARTY_LICENSES`.

| file | grating / cenwave | LP | sha256 of the `.dat` (first 16) |
|---|---|---|---|
| `aa_LSFTable_G130M_1055_LP2_cn.dat.gz` | G130M/1055 | 2 | 760dcbf3b3bd61fa |
| `aa_LSFTable_G130M_1096_LP2_cn.dat.gz` | G130M/1096 | 2 | db5e8e8f55ddd2da |
| `aa_LSFTable_G130M_1291_LP4_cn.dat.gz` | G130M/1291 | 4 | f9a3781859906e51 |
| `aa_LSFTable_G130M_1291_LP5_cn.dat.gz` | G130M/1291 | 5 | b4b7d06b696a8b44 |
| `aa_LSFTable_G160M_1533_LP6_cn.dat.gz` | G160M/1533 | 6 | 447a1ee836a09f30 |
| `aa_LSFTable_G160M_1577_LP4_cn.dat.gz` | G160M/1577 | 4 | 56df75a898619381 |
| `nuv_model_lsf.dat.gz` | NUV (all gratings) | - | d98820dad8a71c8e |

Format: first row = wavelengths [Å] of the tabulated profiles (FUV every 5 Å over both segments; NUV every 100 Å,
1700-3200 Å); each following row is one detector pixel (FUV 321 pixels, NUV 101 pixels, centre at the middle row).
Each column is normalised to unit sum.

LP choice: LP4 is the classic reference; LP5 (G130M/1291, from Oct 2021), LP6 (G160M, from Oct 2022) and LP2 (blue
modes 1055/1096) are the latest positions with published tables. Since Nov 2025 G130M/1055, 1096, 1222, 1291 run at
LP7 and G160M at LP10 (COS IHB §5.12); no LSF tables for those were on the page at retrieval.

Pixel scale (dispersion, Å/pixel; first-order DISPTAB coefficient, PSA): from the CRDS references
`97h1820cl_disp.fits` (FUV) and `63p1559jl_disp.fits` (NUV), both current in `hst-operational` on 2026-11-19
(https://hst-crds.stsci.edu/unchecked_get/references/hst/<file>). Values and segment ranges are in
`absreq/lsf.COS_SETTINGS`. The NUV table is used with G285M/2676 stripe C (0.040196 Å/pixel), which holds
Mg II 2796 at z = 0; G285M is Available-but-Unsupported.

Use: at observed wavelength λ the kernel is the linear interpolation of the two bracketing columns (interpolation
across the FUV segment gap is refused), placed on velocity with Δv_pix = c·dispersion/λ, PCHIP-interpolated onto the
model's fine velocity grid and renormalised to unit area. Its FWHM defines the resolution element (R_eff = c/FWHM).
