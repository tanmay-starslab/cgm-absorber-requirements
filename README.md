# cgm-absorber-requirements

What S/N and spectral resolving power does it take to **detect** a circumgalactic absorber, and to
**resolve** it into its velocity components? This repository answers both questions for twelve strong
CGM transitions, with publication figures, a technical note and an interactive explainer.

**Interactive explainer:** https://tanmay-starslab.github.io/cgm-absorber-requirements/ (source: `docs/index.html`)
· **TNG50 sightline explorer:** https://tanmay-starslab.github.io/cgm-absorber-requirements/tng50/ (see [below](#tng50-sightline-explorer))

![Requirement matrix](figures/requirements_matrix.png)

## Transitions

| Ion | λ [Å] | f | b_fid [km/s] | log N(τ₀=1) | Source |
|---|---|---|---|---|---|
| H I | 1215.67 | 0.416 | 13.8 | 13.26 | Trident |
| Mg II | 2796.35 | 0.6155 | 5.6 | 12.34 | Morton (2003) |
| Si II | 1260.42 | 1.18 | 5.6 | 12.40 | Trident |
| S II | 1259.52 | 0.0182 | 5.5 | 14.20 | Trident |
| C II | 1334.53 | 0.129 | 6.2 | 13.38 | Trident |
| Si III | 1206.50 | 1.63 | 6.5 | 12.35 | Trident |
| Si IV | 1402.77 | 0.255 | 7.8 | 13.16 | Trident |
| C IV | 1548.19 | 0.190 | 12.8 | 13.46 | Trident |
| N V | 1238.82 | 0.156 | 16.2 | 13.75 | Trident |
| O VI | 1031.91 | 0.133 | 18.4 | 13.95 | Trident |
| Ne VIII | 770.41 | 0.102 | 22.8 | 14.29 | Trident |
| O VII | 21.602 | 0.696 | 32.6 | 15.16 | Verner et al. (1996) |

Atomic data are read from the [Trident](https://github.com/trident-project/trident) line list
(`absreq/data/trident_lines.txt`, BSD-3). Mg II λ2796/2803, Si IV λ1393 and O VII λ21.6 are not in that
list and come from `absreq/data/supplement_lines.txt`, which records the source of each value.
The fiducial b is the thermal width at a representative temperature plus 5 km/s turbulence.

## Method in one paragraph

Doppler-core profiles are convolved with a Gaussian line-spread function of FWHM c/R. Detection uses the
matched-filter significance S_det = (S/N)·[∫D² dv / FWHM]^½. Separation uses the expected Δχ² of the best
single-component fit to a two-component truth, S_res = (S/N)·√G. Both are linear in S/N, so each
four-parameter problem is one precomputed 3-D cube. In the optically thin limit the resolution problem
is universal: Δv_min ≈ 1.98 FWHM_eff S_det^(−1/4) for equal pairs, with FWHM_eff² = (c/R)² + (1.665 b)².
See `paper/detectability_note.pdf`.

## Layout

```
absreq/        lines.py · profiles.py · detection.py · separation.py · theory.py · style.py
scripts/       build_grids.py → grids/   make_figures.py → figures/   make_tables.py → paper/   export_web_data.py → docs/
figures/       lsf_resolution, requirements_matrix, ions/<ion>_{instrument,absorber}_plane  (PDF + PNG)
paper/         detectability_note.tex/.pdf
docs/          interactive explainer (GitHub Pages); docs/tng50/ TNG50 sightline explorer
tngsight/ server/ deploy/ tng50/   TNG50 explorer: library, API server, deployment, original app
tests/         analytic limits and thin-line agreement
```

## Reproduce

```bash
pip install -r requirements.txt          # LaTeX with txfonts + dvipng needed for the figures
python -m pytest tests
PYTHON=$(which python) node tests/js/run_all.mjs   # JS tests (explorer page, 3D data decode, LUTs, LOD, picker, search, chat)
python scripts/build_grids.py            # ~1-2 min per ion on 2 cores
python scripts/make_figures.py
python scripts/make_tables.py && (cd paper && pdflatex detectability_note.tex)
python scripts/export_web_data.py
```

## TNG50 sightline explorer

A second page applies the same instrument question to simulated absorbers: 672 quasar sightlines through the CGM of
TNG50-1 subhalo 488530 at z = 0, plus any geometry you request (face-on, edge-on or random; impact parameter
b ≤ 300 kpc; azimuth Φ; or a ray picked in 3D), cast on demand with yt + Trident.

- **Lines (Phase 3).** Twelve ions ordered by ionisation potential, from cool to hot: H I 1216 (Lyα), Mg II 2796,
  Si II 1260, C II 1335, Si III 1206, C III 977, Si IV 1403, C IV 1548, N V 1239, O VI 1032, Ne VIII 770 and
  O VII 21.6. One registry, `tngsight/ions.json`, holds the atomic data (Trident's values; O VII from
  `absreq/data/supplement_lines.txt`), colours, bands, R ranges and fitter limits; Python, the server, the page and
  the chat tools all derive from it.
- **Data v2.** Each line has its own constant-velocity grid, 0.25 km/s over ±1500 km/s (up to ±10,000 km/s for
  damped H I), stored as npz v2; the page reads the TNGS v2 binary (1 km/s, u16 transmission, lines keyed by registry
  key). The velocity axis is V = c(λ/λ₀ − 1) + v_sys, so the galaxy sits at V = 0. The library was regenerated from
  the slim cutout with the same rays (`deploy/data/regen_library.py`), with a slim ion table that now holds H, C, N,
  O, Ne, Mg and Si.
- **Degrading.** In the browser, with a Gaussian LSF of FWHM = c/R in velocity. R is a slider per band (UV and EUV
  5,000 to 150,000, X-ray 100 to 5,000), S/N runs from 2 to 100, and the layout shows one case, two cases varying R
  or S/N, or the 2×2 grid.
- **In-browser fitter.** "Fitted components" fits the noisy, degraded spectrum of every displayed case in a Web
  Worker: Levenberg–Marquardt on (log N, b, v) through the LSF, seeded from the intrinsic components, with
  insignificant components pruned by ΔBIC and results cached per (sightline, ion, R, S/N, seed).
- **Intrinsic components.** `tngsight/vpfit.py` (clean-room; scipy `wofz` + `least_squares`) fits the noiseless
  native spectra with a pseudo-noise σ = 0.01, so its errors are formal. Fit regions are seeded per pixel and by a
  matched filter (box widths 3 to 127 km/s; the library was refitted with it), which also finds shallow, broad O VI,
  N V and Ne VIII. Flags: 1 SAT, 2 BOUND, 4 MAXCOMP, 8 POORFIT, 16 EDGE, 32 NOERR, 64 DAMPED, 128 BUDGET.
- **3D tab.** Every gas cell is deposited with its own kernel onto three nested 256³ cubes (L0 ±400, L1 ±100 and
  L2 ±25 kpc) of n_H, T, Z and all 12 ion densities, next to the stellar g, r, i light (a Lupton et al. 2004
  composite), and drawn as column maps or volumes in a square stage. The cubes live on the public dataset
  [`tanmay-starslab/tng50-sub488530-viz`](https://huggingface.co/datasets/tanmay-starslab/tng50-sub488530-viz);
  git keeps only the pinned `manifest_v2.json` and the LUTs. If huggingface.co is unreachable, everything except the
  3D stage keeps working.
- **Find and Ask.** A deterministic component search (identical JS and Python versions), and a chat panel whose
  model only emits tool calls that the page runs: by default a local model (WebLLM, Qwen2.5-1.5B, about 1 GB,
  downloaded only on request; needs WebGPU), or a Claude backend when the server has an Anthropic key. That backend
  sends the conversation to Anthropic through our stateless server, which logs no message content. Answers whose
  numbers do not come from a tool result get an "unverified" badge.

```
 GitHub Pages: docs/tng50/              backend (Docker): server.app             laptop
 static page + library (.bin)           coordinator + fallback compute          ────────────────────
 ───────────────────────────            ───────────────────────────────          serve.sh  127.0.0.1:8787
 degrades and fits in the browser       job queue, SSE progress, figures         (local page backend)
 POST /api/sightlines  ───────────────▶ canonicalize → library hit?  ◀─ lease ── worker.sh: pulls jobs
 SSE /api/jobs/{id}/events ◀─────────── progress / done                ── result ▶ over HTTPS, computes
 GET /api/sightline/{id}.bin ◀───────── npz → web binary                          on the slim cutout
                                        HFSync ⇄ private HF dataset (generated/)
```

- **Page:** https://tanmay-starslab.github.io/cgm-absorber-requirements/tng50/ (source: `docs/tng50/`)
- **API backend:** the `deploy/hf_space` image, on an Oracle Cloud VM (`deploy/oci/`) or as an HF Docker Space
- **Data:** private HF dataset `tanmay-starslab/tng50-sub488530-cgm` (slim cutout, slim ion table, library)

The page always loads the static library from its own `data/`, so it works with no backend. It probes
`http://127.0.0.1:8787` and then the configured backend, and uses the first healthy one for new sightlines and
publication figures. Run it locally, with every default path under the work root `$TNG_WORK`:

```bash
pip install -r requirements-tng.txt     # plus trident (patched) and yt_astro_analysis: see deploy/hf_space/Dockerfile
deploy/laptop/serve.sh                  # backend on 127.0.0.1:8787
(cd docs && python3 -m http.server 8000)        # then open http://127.0.0.1:8000/tng50/
```

[`docs/TNG50_OPERATIONS.md`](docs/TNG50_OPERATIONS.md) has the rebuild steps (slim ion table, library regeneration,
component refit, 3D cubes and their column checks), the upload and deploy steps from a clean worktree, the tests,
running on a Linux cluster, and the known limitations:

- H I Lyα uses Trident's Γ = 4.69e8 s⁻¹; the usual damping constant is 6.265e8 (Morton 2003), so damped log N here
  sits about 0.13 dex from VPFIT-style tools.
- Saturated components, including Lyα-only H I fits in the degenerate range, are shown, searched and reported as lower
  limits (log N ≥ x).
- The Phase 1/2 (v1) spectra carry a Trident bin-edge offset of up to 0.45 dλ for narrow lines; it conserves ∫τ dv.
- The 3D cubes are checked against their own smoothed, voxel-averaged field (≤ 0.05 dex), not against a thin ray.

The original app and its scripts are in `tng50/` (see
[`tng50/README.md`, "Corrections (2026-10)"](tng50/README.md#corrections-2026-10-velocity-frame-and-dλ) for its
velocity-frame and dλ fixes). Layout: `tngsight/` (registry, geometry, generator, npz and web formats, fitter, cubes),
`server/` (FastAPI), `deploy/` (data builds, HF Space, VM and laptop scripts).

Credits: IllustrisTNG / TNG50-1 (Nelson et al. 2019; Pillepich et al. 2019), Trident (Hummels et
al. 2017), yt (Turk et al. 2011). The star composite follows Lupton et al. (2004). The 3D viewer's approach
(deposited cubes and column-integral rendering) was inspired by Scott Lucchini's TNG viewer.

## Caveats

Gaussian LSF (the HST/COS LSF has broad wings, so COS-like numbers are optimistic); Doppler cores only;
equal components at the fiducial b; expected (median) significances; S/N per resolution element with
constant continuum noise. Nominal instrument resolving powers are indicative.

## Licence

Code: MIT, © 2026 Tanmay Singh ([`LICENSE`](LICENSE)). This covers all code here, including the
TNG50 explorer (`tngsight/`, `server/`, `deploy/`, `tng50/`, `docs/tng50/`).

Third-party terms ([`THIRD_PARTY_LICENSES`](THIRD_PARTY_LICENSES) has the full texts):

- **Trident** (BSD-3, © Trident Development Team): the line list `absreq/data/trident_lines.txt` is
  redistributed under its licence, and `deploy/hf_space/trident_doppler_only.patch` is derived from
  Trident source and is BSD-3, not MIT.
- **yt** (BSD-3, © yt Development Team): a dependency, not vendored.
- **three.js** (MIT), **WebLLM** (Apache-2.0) and the **Qwen2.5-1.5B-Instruct** weights (Apache-2.0)
  are loaded from their CDNs by the browser and are not vendored. pygad (GPL-2+) was only run
  out-of-tree to validate the fitter. None of its code is in this repository.
- **TNG50 data.** The TNG50-derived spectra, library and 3D cubes (`docs/tng50/data/`, the npz library, the
  private HF dataset and the public viz dataset `tanmay-starslab/tng50-sub488530-viz`) are not MIT. They are redistributed under the
  [IllustrisTNG data policy](https://www.tng-project.org/data/), which asks you to cite
  Nelson et al. 2019 (ComAC 6, 2; MNRAS 490, 3234) and Pillepich et al. 2019 (MNRAS 490, 3196).
  Please also cite Trident (Hummels, Smith & Silvia 2017, ApJ 847, 59) and yt (Turk et al. 2011,
  ApJS 192, 9).
