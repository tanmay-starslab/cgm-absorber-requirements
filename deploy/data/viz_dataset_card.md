---
license: other
license_name: illustristng-data-terms
license_link: https://www.tng-project.org/data/docs/background/#citation
pretty_name: TNG50-1 subhalo 488530 - 3D visualisation cubes (gas + stars)
tags:
- astronomy
- simulation
- illustristng
- tng50
- volume-rendering
size_categories:
- n<1K
---

# TNG50-1 subhalo 488530: 3D visualisation cubes

These are the gas and stellar cubes behind the 3D tab of the **TNG50 sightline explorer**:
https://tanmay-starslab.github.io/cgm-absorber-requirements/tng50/

They are **derived visualisation products** of one galaxy, subhalo 488530 of TNG50-1 at snapshot 99 (z = 0),
from the public IllustrisTNG data release. Every raw resolution element was deposited onto nested 256³ grids:
all gas cells, and all star particles except wind particles. This dataset holds no raw simulation data. The raw
cutout and the sightline library live elsewhere.

{{STATUS}}

## Contents

| path | what |
|---|---|
| `manifest_v2.json` | schema `tng50-viz/2`. It lists every cube with its value range, sizes, SHA-256 hashes, deposition statistics and the frame, encoding and format definitions. **Start here.** |
| `luts/luts.json` | the colour maps the page uses (256 RGB entries each) |
| `gas/<L>/<field>.<id12>.p<0-3>.webp` | gas cube as 4 lossless WebP z-slice atlases (the primary format) |
| `gas/<L>/<field>.<id12>.u8.gz` | the same cube as raw uint8 bytes, gzip-compressed (the fallback format) |
| `stars/<S>/gri.<id12>.p<0-3>.webp` | stellar cube (i, r, g in R, G, B) as 4 lossless WebP atlases |
| `stars/<S>/gri.<id12>.rgba.gz` | the same cube as raw RGBA bytes, gzip-compressed |
| `previews/*.png` | optional screenshots |

`<id12>` is the first 12 hex digits of the SHA-256 of the cube's raw bytes. File names are immutable: a rebuilt
cube gets a new name, and old names stay so that older page versions keep working.

{{SIZES}}

## Frame and levels

- **Frame.** The cubes are axis-aligned with the galaxy's **disk frame**: d = R (x_box − c). Here x_box is in
  physical kpc and c = `galaxy.center_kpc`. The rows of R are the unit vectors (x̂, ŷ, L̂), and L̂ is the stellar
  angular-momentum axis. Cube axes (i, j, k) = (x_d, y_d, z_d), so a face-on view looks down k. The exact vectors
  are in `manifest_v2.json` (`frame`, `galaxy`).
- **Byte order.** x is fastest: index = i + n (j + n k). The voxel centre is −half + (i + 0.5) Δ.
- **Levels** (all 256³):

| level | box | voxel Δ | notes |
|---|---|---|---|
| L0 / S0 | ±400 kpc | 3.125 kpc | voxels with centre r > 400 kpc are empty |
| L1 / S1 | ±100 kpc | 0.78125 kpc | |
| L2 / S2 | ±25 kpc | 0.1953125 kpc | about the size of TNG50's disk gas cells |

## Fields

| key | quantity | units | kind |
|---|---|---|---|
| `nH` | hydrogen nuclei number density | cm⁻³ | density (deposited count ÷ voxel volume) |
| `OVI` | O VI number density | cm⁻³ | density |
| `HI` | H I number density | cm⁻³ | density |
| `CIII` | C III number density | cm⁻³ | density |
| `T` | temperature | K | mass-weighted per voxel |
| `Z` | metallicity | Z☉ (Z☉ = 0.0127) | mass-weighted per voxel |
| stars `gri` | i, r, g band luminosity density | L_AB0 kpc⁻³ | density; L_AB0 = luminosity of a source with M_AB = 0 |

The ion densities come from yt and Trident (HM2012 UV background, the same ion fractions used for the explorer's
spectra).

## Encoding

Each voxel is one byte, a log10 value quantised to uint8:

```
q = 0                       empty (v <= 0, non-finite or masked)
log10 v = vmin + (q - 1) * (vmax - vmin) / 254      for q >= 1   (q = 1 also stands for "<= vmin")
```

`vmin` and `vmax` are listed per cube in the manifest, snapped to 0.1 dex. The range is the full range of the
data: vmin is the 0.5th percentile of the valid voxels, vmax is the maximum, and there is no high clip. One gas
field shares a single range across L0-L2. One star level shares a single range across its three bands.

**WebP atlas:** 4 parts per cube, 64 z-slices per part, 16 × 4 tiles of n × n pixels (4096 × 1024 px for n = 256).
Slice k = 64 p + s sits in part p at pixel (x = (s mod 16) n + i, y = floor(s / 16) n + j). Gas parts are 8-bit grey.
Star parts are RGB with R = q_i, G = q_r, B = q_g. The parts are lossless: decoded, they reproduce the raw bytes
exactly (check the SHA-256 against `raw_sha256`). **gz:** gzip level 9 of the raw bytes. That is n³ bytes for gas,
and 4 n³ bytes RGBA for stars, with A = 255 where any band is non-empty.

## How the cubes were made

- **Deposition** (our own conservative scatter, `tngsight/deposit.py` in the code repository):
  - Each element is spread over the voxel-centre lattice with its own cubic-spline kernel,
    w(q) = 1 − 6q² + 6q³ (q ≤ ½), 2(1 − q)³ (½ < q < 1), q = r / h_eff.
  - The weights are normalised to sum to 1 over the unbounded lattice, so the deposit conserves mass, counts and
    light exactly. The only losses are the kernel shares that fall outside the box.
  - Sub-voxel elements use a floor on the kernel size: gas h_eff = max(h, 2Δ), stars h_eff = max(h, Δ), with Δ
    the voxel size of the level (`manifest_v2.json` → `kernel.h_min_voxels_gas` = 2, `kernel.h_min_voxels` = 1).
    The 2Δ gas floor gives round footprints instead of 2×2×2 tiles; it does not change columns or totals.
  - Elements wider than 16 voxels are deposited on a coarser lattice (2^m Δ). They are brought back by a
    conservative, positivity-preserving minmod-linear prolongation.
- **Smoothing lengths:**
  - gas h = 2.0 (3 V / 4π)^(1/3), with V = m / ρ: yt's Arepo smoothing length, the kernel Trident used for the
    spectra;
  - stars h = StellarHsml.
- **Stars:**
  - GFM_StellarPhotometrics g, r, i (columns 4, 5, 6; SDSS AB magnitudes from the Bruzual & Charlot 2003 models,
    as documented by TNG) are converted to linear luminosity ℓ = 10^(−0.4 M);
  - wind particles (GFM_StellarFormationTime ≤ 0) are excluded;
  - there is no dust.
- **Star colour composite** (the reference composite recorded in `manifest_v2.json` → `stars.display`; Lupton et
  al. 2004 asinh stretch, Q = 8, μ0 = 21.5 mag arcsec⁻²; the colour validation below uses exactly this):
  ```
  Σ0 = 10^(0.4 (36.5721 − μ0));  R, G, B = Σ_i, Σ_r, Σ_g / Σ0;  I = (R + G + B) / 3
  F  = asinh(Q I) / (Q I);  (R, G, B) *= F;  if max > 1: divide by max   (hue-preserving)
  ```
  Σ_b are surface brightnesses in L_AB0 kpc⁻², and 36.5721 is the μ of 1 L_AB0 kpc⁻².
  The explorer page may apply further display-only adjustments on top of this (for example a different μ0 or
  a highlight roll-off); they change only what is drawn, never the cubes.

## Validation, and limits of use

These cubes are made for **visualisation**. Do not use them quantitatively beyond the validation below; use the
original TNG50 data for science.

- **Conservation.** The deposited totals equal Σ q f to ≤ 1e-6 relative (measured ~1e-15). Here f is each
  element's in-box kernel fraction. The kernel tails that leave the box carry 0.08 % (L0), 2.9 % (L1) and 3.8 % (L2)
  of the mass of the elements touching each box.
- **Columns.** Columns through the float cubes agree with an exact kernel line integral over the cells within
  0.10 dex (O VI, C III) and 0.15 dex (H I) on the in-box segments of the check sightlines at L1 and L2. They agree
  within 0.15 dex with the explorer's Trident logN on full rays at L0.
  - Disk-grazing rays at L1 are resolution-limited (C III up to +0.31 dex). L2 resolves them.
  - The uint8 encoding, sampled the way the viewer samples it, adds ≤ 0.02 dex.
- **Stars.** The cube projections are checked against independent 2D kernel projections (our own, and one made
  offline with `temet.util.sphMap` from temet 0.9.2, MIT): total flux within 1 %, colours within 0.03 mag.

## Citation and terms

The cubes are derived from IllustrisTNG data. They are shared under the IllustrisTNG data terms and citation
request (https://www.tng-project.org/data/docs/background/#citation), not under an open-data licence. If you use
them, please cite:

- Nelson et al. 2019, *Computational Astrophysics and Cosmology* 6, 2: the IllustrisTNG public data release
  (arXiv:1812.05609);
- Nelson et al. 2019, *MNRAS* 490, 3234: TNG50, outflows (arXiv:1902.05554);
- Pillepich et al. 2019, *MNRAS* 490, 3196: TNG50, structure and kinematics (arXiv:1902.05553).

The cubes also rely on:

- Trident (Hummels, Smith & Silvia 2017, *ApJ* 847, 59) for the ion fractions;
- yt (Turk et al. 2011, *ApJS* 192, 9);
- the HM2012 UV background (Haardt & Madau 2012, *ApJ* 746, 125);
- the stellar photometry of GFM_StellarPhotometrics (Bruzual & Charlot 2003, *MNRAS* 344, 1000; see the TNG data
  specifications);
- the asinh colour composite (Lupton et al. 2004, *PASP* 116, 133).

Please refer to the project as "IllustrisTNG" and to the simulation as "TNG50". The code that builds these cubes is
MIT-licensed: https://github.com/tanmay-starslab/cgm-absorber-requirements

`luts/luts.json` holds colour tables sampled from matplotlib 3.9.4: viridis, magma and inferno (CC0) and cividis
(Nuñez, Anderton & Renslow 2018), the latter under the matplotlib licence, "Copyright (c) 2012- Matplotlib
Development Team; All Rights Reserved"; the only change is resampling to 256 entries. The licence text is
reproduced in `THIRD_PARTY_LICENSES` of the code repository. tng_dusk, tng_ice and grey are our own (MIT).
