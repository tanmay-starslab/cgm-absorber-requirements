# CLAUDE.md — cgm-absorber-requirements

Guidance for Claude Code (and other agents) working in this repository.

## What this project is

Computes the S/N and spectral resolving power R needed to

1. **detect** a single absorption component (minimum detectable log N at 3σ), and
2. **resolve** two velocity components separated by Δv (smallest Δv resolvable at 3σ),

for twelve CGM transitions: H I 1216, Mg II 2796, Si II 1260, S II 1260, C II 1335, Si III 1206,
Si IV 1403, C IV 1548, N V 1239, O VI 1032, Ne VIII 770, O VII 21.6.

Owner: Tanmay Singh (ASU SESE). Public, MIT. It supports a NASA proposal (instrument-requirement
figures), so **figures must be publication quality and LaTeX-rendered** (`absreq/style.py`).

- Repo: https://github.com/tanmay-starslab/cgm-absorber-requirements
- Explainer (GitHub Pages, `main` → `/docs`): https://tanmay-starslab.github.io/cgm-absorber-requirements/

Do not change physics, grids or published numbers without being asked; results feed the note and the proposal.

## Physics and statistics (as implemented)

- **Profiles** (`profiles.py`, `lines.py`): Doppler cores only, τ0 = 1.4975e-15 · N f λ[Å] / b[km/s].
  Damping wings neglected.
- **LSF**: Gaussian, FWHM = c/R (σ_LSF = FWHM/2.3548). Convolution by FFT.
- **Noise**: constant continuum noise; **S/N is per resolution element** (integrals are divided by FWHM_LSF).
- **Detection** (`detection.py`): matched filter, S_det = (S/N)·K, K(logN, b, R) = sqrt(∫D² dv / FWHM),
  D = 1 − F_obs. Computed via Parseval on a fixed grid (2¹⁴ points, 0.25 km/s).
- **Separation** (`separation.py`): expected Δχ² of the best single-component fit (free N, b, v) to a
  two-equal-component truth, Δχ² = (S/N)²·G(logN, Δv, R). Resolved when S_res = (S/N)·√G ≥ 3.
  Two fit starts (one broad component; one member of the pair) avoid the wrong minimum. Both
  components have b = b_fid; the G cube has no b axis.
- Both statistics are **linear in S/N**, so each problem is one precomputed 3-D cube in `grids/<key>.npz`
  (K over logN×b×R; G over logN×Δv×R at b_fid).
- **Thin-line theory** (`theory.py`): σ_eff² = b²/2 + σ_LSF²; FWHM_eff² = (c/R)² + (1.665 b)²;
  Sparrow Δv_S = 2σ_eff = 0.849 FWHM_eff; R_k = c/(1.665 b).
  - Equal pair: ρ = S_res/S_det ≈ (√6/384)(Δv/σ_eff)⁴ ⇒ Δv_min ≈ 1.98 FWHM_eff S_det^(−1/4).
  - Unequal pair (EW fraction q): ρ ≈ q(1−q)|1−2q|(Δv/σ_eff)³/(4√3) ⇒ Δv_min ∝ S_det^(−1/3).
  - Large Δv: ρ → min(q, 1−q), i.e. the weaker component must itself be detected.
  - S_det here is the significance of the **whole blend**.
- **Fiducial b** per ion: b_fid = sqrt(b_th(T)² + (5 km/s)²), T per ion in `CGM_IONS` (`lines.py`).

## Data provenance

- `absreq/data/trident_lines.txt`: Trident line list (BSD-3; `absreq/data/TRIDENT_LICENSE.txt`).
- `absreq/data/supplement_lines.txt`: Mg II 2796/2803, Si IV 1393, O VII 21.6 (not in Trident),
  attributed to Morton (2003) and Verner et al. (1996). **These values were entered from memory and
  have NOT been checked against the papers** (to-do 6).

## Repo map

```
absreq/   lines.py (atomic data, CGM_IONS, b_fid) · profiles.py (τ, LSF, FFT convolution)
          detection.py (K cube, logN_min) · separation.py (G, dv_min, sparrow)
          theory.py (thin-limit ρ, dvmin_over_fwhm) · style.py (matplotlib usetex; AAS widths 3.35/7.1 in)
scripts/  build_grids.py → grids/          make_figures.py → figures/, figures/ions/
          make_tables.py → paper/requirements_table.tex
          export_web_data.py → docs/index.html (template docs/_template.html; data replace /*__DATA__*/null)
figures/  lsf_resolution, requirements_matrix, ions/<key>_{instrument,absorber}_plane (PDF + PNG)
paper/    detectability_note.tex/.pdf (\graphicspath → ../figures); requirements_table.tex is generated
docs/     interactive explainer: in-browser FFT convolution + Nelder–Mead fit, reads embedded grids
tests/    test_physics.py: weak-line K limit, thin-limit coefficients, numerical-vs-theory agreement
```

Ion keys: `Line.key` = ion without spaces + label wavelength with `.`→`p` (e.g. `OVI1032`, `OVII21p6`).

`style.py` preamble order matters: `amsmath` before `\usepackage[T1]{fontenc}` before `txfonts`.

## Environment

- Python venv at `.venv/` (self-ignoring): `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`.
- LaTeX for figures: `latex`, `dvipng`, `txfonts`, `type1cm`, `cm-super`
  (MacTeX, or BasicTeX + `sudo tlmgr install txfonts dvipng type1cm cm-super`).
- Ask before installing anything system-wide.

## Commands

```bash
.venv/bin/python -m pytest tests                          # ~15 s
.venv/bin/python scripts/build_grids.py                   # all ions, ~1–2 min/ion on 2 cores
.venv/bin/python scripts/build_grids.py "O VI"            # one ion
.venv/bin/python scripts/make_figures.py                  # lsf + matrix + all ions
.venv/bin/python scripts/make_figures.py matrix lsf       # summary figures only
.venv/bin/python scripts/make_figures.py ions "O VI"      # one ion (~20 s)
.venv/bin/python scripts/make_tables.py                   # paper/requirements_table.tex
(cd paper && pdflatex detectability_note.tex)             # run twice for references
.venv/bin/python scripts/export_web_data.py               # docs/index.html
```

Dependency chain: lines/physics → grids → (figures, table, web data) → paper PDF.

**Regenerated binaries:** figure PDFs embed a CreationDate, and the PNG text rasterisation depends on
the local TeX/dvipng/Ghostscript versions, so a rerun changes bytes even when content does not. Before
committing regenerated figures, confirm the content actually changed (e.g. a pixel diff against
`git show HEAD:<file>`); otherwise `git checkout -- figures/`.

## Git conventions

- Small, descriptive commits, authored as Tanmay Singh.
- Feature work on branches (`grids/…`, `figures/…`, `explainer/…`, `paper/…`, `docs/…`), merged by
  pull request with a **merge commit — never squash**.
- Don't merge a PR until the owner says so.

## Open to-do list (recorded; not started)

1. **Tabulated HST/COS LSF** (non-Gaussian wings) for COS-like configurations — most important realism upgrade.
2. **Doublet partners** (O VI 1037, Mg II 2803, C IV 1550, Si IV 1393, N V 1242) used jointly to recover
   resolution and column density for saturated components.
3. **Unequal components** (N ratio, different b) in the full numerical grids; currently thin-limit theory only.
4. **'Proposed instrument' marker** (R, S/N) on the figures once the instrument concept is fixed.
5. **O VII** is shown on the UV R grid (10³–10⁵); real X-ray gratings have R ≲ 10³ at 21.6 Å.
6. **Verify supplement oscillator strengths** (and γ, λ) against Morton (2003) / Verner et al. (1996).

Smaller items noticed during the local setup (2026-10-13):

- The note claims theory and numerics agree to better than 0.5% (measured: ≤0.36% at the tested points), but
  the tests only enforce 1% (coefficients) and 2% (numerical vs theory); no test covers the unequal-pair
  numerics or the large-Δv limit.
- Figure output is not byte-reproducible (PDF CreationDate); consider `metadata={"CreationDate": None}`.
