# CGM Mock-QSO Spectra — TNG50-1 subhalo 488530

Mock quasar absorption-line spectroscopy through the circumgalactic medium (CGM) of TNG50-1
subhalo **488530** (a central, MW-mass galaxy: M₂₀₀c ≈ 1.6×10¹² M⊙, R₂₀₀c = 246 kpc, SFR ≈ 7 M⊙/yr).
Sightlines run from −R₂₀₀c to +R₂₀₀c through the CGM at a chosen orientation, impact parameter,
and azimuth; **Trident** casts the ray and produces absorption spectra for three UV lines:

| ion       | line        | rest λ (Å) |
|-----------|-------------|------------|
| **O VI**  | O VI 1032   | 1031.912   |
| **H I**   | Ly β        | 1025.722   |
| **C III** | C III 977   | 977.020    |

Two deliverables:

1. **Publication 3×4 figure** — 3 rows (the three ions) × 4 instrument setups, x-axis
   `V_LOS − V_sys`. Setups: `(R, S/N) = (20000,8) (40000,8) (20000,5) (40000,5)`.
2. **Interactive Panel + Bokeh GUI** — live sliders for the two S/N and two R values,
   orientation / impact / azimuth controls, a scrollable gallery of pre-generated sightlines,
   on-demand ray generation, and one-click 240-dpi PDF/PNG export.

![GUI](figures/gui_screenshot2.png)

## Key design: R and S/N are post-processing

Ray-casting (Trident) is the only expensive step. Each sightline is generated **once** as a
high-resolution, **noiseless** optical-depth spectrum per ion. Spectral resolution and noise are
then applied instantly as arithmetic on the cached arrays (`scripts/degrade.py`):

- **Resolution R** → Gaussian LSF with FWHM = λ₀/R (⇒ velocity FWHM = c/R: R=20000→15 km/s,
  R=40000→7.5 km/s), sampled at **5 pixels per resolution element**. The kernel width in pixels
  uses the generation step **dλ = 0.002 Å** exactly (see "Corrections" below).
- **S/N** → Gaussian noise defined **per resolution element**: per-pixel σ = √5 / (S/N).
- x-axis velocity: `V = c(λ/λ₀ − 1) + v_sys`, with `v_sys = SubhaloVel · n_los` (galaxy systemic
  at V = 0; see "Corrections" below for the sign).

So the GUI's R/S/N sliders and the four figure columns are all instant; only a *new geometry*
casts a fresh ray.

## Geometry

Built in the galaxy's **cold-gas disk frame** (`Lhat, xhat, yhat` from the OVI_CGM_compare
orientation cache). Azimuth convention: **Φ=0 = projected major axis** (disk plane),
**Φ=90 = projected minor axis** (polar). `face-on` looks down `Lhat`; `edge-on` looks along
`xhat`; `random` draws a seeded random line of sight. See `scripts/cgm_geometry.py`.

## Validation

Synthetic O VI columns (∫ n_OVI dl along each ray) match the **independent** OVI_CGM_compare
azimuthally-averaged radial profile for the same subhalo to **0.04–0.14 dex** at every impact
parameter (`figures/validate_ovi_columns.png`), with physical azimuthal scatter (minor-axis
outflow enhancement: at b=50, logN spans 13.9 major → 14.8 polar). The residual is consistent
with the known ~0.07 dex oxygen-metallicity systematic. `scripts/validate_ovi.py`.

## Layout

```
tng50/                          (imported with history from the original cgm_qso_488530 app)
  galaxy_488530.json            center, R200c, SubhaloVel, Lhat/xhat/yhat, lines (no data paths)
  scripts/
    cgm_paths.py                where scripts read/write (from tngsight.config; env-overridable)
    cgm_geometry.py             shim over tngsight.geometry: (orientation, b, Φ) -> endpoints + v_sys
    gen_cgm_sightlines.py       CLI over tngsight.generate.Generator: cast rays, noiseless spectra
    degrade.py                  shim over tngsight.degrade: LSF(R) + noise(S/N per res-element)
    make_publication_figure.py  the 3x4 figure (matplotlib, publication style, no title)
    validate_ovi.py             O VI column sanity-check vs OVI_CGM_compare radial profile
    score_sightlines.py         rank sightlines by multi-component + unsaturated ("showcase")
    demo_resolution_snr.py      pedagogical R / S-N / pixels-per-resolution-element explainer
    demo_resolving_power.py     narrow C III vs broad O VI at several R (noiseless)
    analyze_line_widths.py      intrinsic component widths in τ space -> data/line_widths.csv
    gen_multiion_sightline.py   many-ion spectra along one stored sightline (-> data/multiion/, ignored)
    plot_multiion_resolution.py rows = transitions, columns = R, for the multi-ion sightline
    export_web_data_wasm.py     τ arrays for the standalone Pyodide explorer (see below)
    build_delivery_wasm.py      builds delivery/CGM_Explorer.html
    cgm_style.py                self-contained publication style + per-ion colours/labels
    test_legacy.py              pytest for the scripts on tngsight (shims, paths, frame/dλ fixes)
  data/
    (sightlines/ is not in this repo: the 672 npz live in the library, see "Running locally")
    grid_index.csv                            catalog: geom_id, orientation, b, azimuth, logN, + showcase scores
    showcase_ranking.csv                      sightlines ranked by showcase score (best demonstrators first)
    line_widths.csv                           per-component intrinsic widths (analyze_line_widths.py)
  app/
    cgm_app.py                  Panel + Bokeh interactive GUI
  delivery/                     template + README.txt for the standalone HTML explorer
  figures/                      exported 240-dpi PDF/PNG + GUI screenshots
```

## Usage

Set up the environment as in "Running locally" below; the commands assume `$REPO` is the
repository root and the shell is in the run directory that holds `config.tri`.

**Generate sightlines** (loads the cutout once; new files go to `$TNG_LIBRARY_DIR/generated/`):
```bash
python $REPO/tng50/scripts/gen_cgm_sightlines.py validate     # ~30 sightlines (O VI sanity grid)
python $REPO/tng50/scripts/gen_cgm_sightlines.py full          # full grid (b×orient×azimuth + randoms)
python $REPO/tng50/scripts/gen_cgm_sightlines.py more          # +300 random LOS, b 65-195 kpc
python $REPO/tng50/scripts/gen_cgm_sightlines.py inner         # +200 random LOS, b < 50 kpc
python $REPO/tng50/scripts/gen_cgm_sightlines.py one edge-on 100 90        # one sightline
python $REPO/tng50/scripts/gen_cgm_sightlines.py one random 120 45 12345   # random needs a seed
```

The dataset currently holds **672 sightlines** (incl. 200 inner-CGM random LOS at b < 50 kpc). To
find the best demonstrators — sightlines with
**multiple resolved, unsaturated velocity components** (where the effect of R and S/N is clearest;
saturated black cores look identical at every R and S/N) — rank them:
```bash
python $REPO/tng50/scripts/score_sightlines.py --render 6   # -> $TNG_LEGACY_OUT/{showcase_ranking,grid_index}.csv + top-6 figures
```
The committed `data/*.csv` are the historical scores and are only read. This scores each ion (component count + how far the cores are from saturation) on the R=40,000
model, weights O VI most, and merges the scores into `grid_index.csv`. Good all-ion example:
`edge_b100_a330` (O VI/H I/C III all detectable and unsaturated).

**Publication figure** (one sightline):
```bash
python $REPO/tng50/scripts/make_publication_figure.py edge_b100_a090   # -> $TNG_FIGDIR/spectra_edge_b100_a090.{pdf,png}
python $REPO/tng50/scripts/make_publication_figure.py face_b050_a090 20000 40000 8 5   # explicit R_lo R_hi SN_hi SN_lo
python $REPO/tng50/scripts/make_publication_figure.py face_b050_a090 intrinsic   # also overlay the intrinsic spectrum
```

Each panel shows the **noisy mock observation** (thin faint step) and the **noiseless model at
that column's resolution R** (thick colored curve). Adding `intrinsic` (or ticking the box in the
GUI) overlays the **intrinsic, unconvolved** spectrum (faint grey) — the R-independent "truth" that
sits behind all four columns, so you can see how much each R blurs away.

**Validation figure:**
```bash
TNG_OVI_REF=<path>/tng_sanity.json python $REPO/tng50/scripts/validate_ovi.py   # external reference profile
```

**Interactive GUI:** see "Running locally" for the `panel serve` command (bound to 127.0.0.1).
Open `http://127.0.0.1:8050/cgm_app`. The R/S/N sliders,
velocity window, **show intrinsic (unconvolved) spectrum** checkbox, and gallery selection
re-render instantly. The gallery is **sorted by showcase score** and **★-marks** the best
demonstrators (★ = O VI multi-component & unsaturated); the **★ showcase only** checkbox filters
to just those. **Submit** loads an on-grid geometry from cache or casts a fresh Trident ray
(the first one also loads the cutout) and saves it to `$TNG_LIBRARY_DIR/generated/<id>.npz`, where
it is scored and becomes scrollable (marked "• new"). Inputs are canonicalised as on the server:
b ∈ [0, 300] kpc, Φ wraps at 360°, b/Φ round to integers, random needs a seed (0 … 2³²−1).
**Download PDF/PNG** exports the exact publication figure at 240 dpi.

## Standalone explorer (for sharing — one double-clickable file)

`delivery/` builds a **single self-contained `CGM_Explorer.html`** that reproduces the whole viewer
in a web browser — **pixel-identical to the live app**, because it runs the *actual* Python modules
(`cgm_style`, `degrade`, `make_publication_figure`, plus the `tngsight` modules they delegate to)
in-browser via **Pyodide/WebAssembly**. All 672 spectra (their τ arrays) are embedded, and the R / S/N
/ intrinsic controls re-run the real `build_figure()`. Ideal for handing to a collaborator who just
double-clicks it on macOS/Windows. Superseded for the web by `docs/tng50/` (native JS + server).
```bash
python $REPO/tng50/scripts/export_web_data_wasm.py   # -> $TNG_LEGACY_OUT/delivery/_webdata_wasm.json (τ, float16)
python $REPO/tng50/scripts/build_delivery_wasm.py    # -> $TNG_LEGACY_OUT/delivery/CGM_Explorer.html (~18 MB)
```
Needs internet the *first* time it is opened (it downloads the Pyodide runtime + numpy/matplotlib/
astropy from a CDN, ~10 s); after that it runs locally, ~1 s per redraw. `delivery/README.txt` is
the short non-technical guide bundled for the recipient (zip it with the HTML to send).

## Trident details

`trident.make_simple_ray` with endpoints in `code_length` (= ckpc/h); a custom
`SpectrumGenerator(lambda_min, lambda_max, dlambda=0.002 Å)` per line; and
`make_spectrum(..., use_peculiar_velocity=True, use_doppler_redshift_only=True, ly_continuum=False)`
— i.e. **Doppler-only** line-of-sight velocities (peculiar velocity, no cosmological/Hubble
redshift across the ray), as requested. Requires the Trident fork (v1.4.2, `my-trident-v1.4.2`)
which provides the `use_doppler_redshift_only` flag; upstream Trident raises `TypeError` on it.

## Corrections (2026-10): velocity frame and dλ

Both fixes live in `tngsight` (shared with the server and the web page) and reach these scripts
through the `degrade.py` / `cgm_geometry.py` shims. Stored npz data are unchanged.

- **v_sys sign.** Trident's ray uses `line_of_sight = start − end = −n_los`, so gas moving with the
  subhalo appears at `c·z ≈ −SubhaloVel·n_los = −v_sys`. The original axis `V = c(λ/λ₀−1) − v_sys`
  therefore put the galaxy near **−2·v_sys** (up to ≈ 256 km/s off; on all 672 sightlines the
  τ-weighted H I Lyβ centroid correlates with v_sys at −0.70). The axis is now
  `V = c(λ/λ₀−1) + v_sys` (`tngsight.config.VSYS_SIGN = +1`); the stored `v_sys = SubhaloVel·n_los`
  keeps its meaning. Figures made before this change (`figures/`, the committed CSV scores) use the
  old frame; the showcase scores differ slightly because the ±400 km/s scoring window moved.
- **dλ for the LSF.** `degrade()` used `median(diff(λ))` of whatever grid it was given. The float32
  grid has quantised steps (0.001953 or 0.002014 Å), so the realised FWHM was −0.7 … +2.4 % off λ₀/R,
  and the Pyodide explorer's ±1000 km/s trim made H I Lyβ 3.1 % wider than the app. The kernel now
  uses the generation step `dλ = 0.002 Å` explicitly (`DLAMBDA`), so FWHM = λ₀/R exactly
  everywhere. Callers with other grids pass `dlam=` (e.g. the constant-velocity multi-ion grid).

## Running locally

On the Mac (arm64) everything runs from a work volume, written `$WORK` below (here
`WORK=/Volumes/cgm_work`); nothing is written to the repo or to the read-only originals.

| what | where (default) | override |
|---|---|---|
| Python env (py3.11, numpy 1.26, yt 4.4.1, trident fork, yt_astro_analysis, panel) | `$WORK/envs/trident/bin/python` | — |
| run dir with `config.tri` (`ion_table_dir = $WORK/data/trident`) | `$WORK/run` | — |
| slim cutout (r − hsml < 400 kpc, 2.03 M gas cells) | `$WORK/data/cutout_slim_R400_sub488530.hdf5` | `TNG_CUTOUT` |
| ion table dir (`hm2012_ss_hr.h5`) | `$WORK/data/trident` | `TNG_ION_TABLE_DIR` |
| library (`sightlines/`, `generated/`, `catalog.json`) | `$WORK/data/library` | `TNG_LIBRARY_DIR` |
| yt particle index (never next to the cutout) | `<library>/cutout.ewah` | `TNG_INDEX_FILE` |
| figures from the CLI scripts | `<library>/figures` | `TNG_FIGDIR` |
| CSV / delivery products of the CLI scripts | `<library>/legacy` | `TNG_LEGACY_OUT` |
| 3-ion npz read by the scripts | `<library>/sightlines`, else the original (read-only) | `TNG_SIGHTLINES_DIR` |

```bash
export REPO=$(git rev-parse --show-toplevel)   # run from inside the checkout
export WORK=/Volumes/cgm_work
export PY=$WORK/envs/trident/bin/python
export MPLCONFIGDIR=$WORK/cache/mpl XDG_CACHE_HOME=$WORK/cache/xdg \
       HDF5_USE_FILE_LOCKING=FALSE PYTHONDONTWRITEBYTECODE=1 MPLBACKEND=Agg
cd $WORK/run                        # trident reads ./config.tri at import; a missing one prompts (hangs)

$PY $REPO/tng50/scripts/make_publication_figure.py edge_b100_a330

$PY -m panel serve $REPO/tng50/app/cgm_app.py --address 127.0.0.1 --port 8050 \
    --allow-websocket-origin=127.0.0.1:8050 --show
```
The scripts put the repo root on `sys.path` themselves (for `tngsight`). The volume is a USB disk:
the first imports can take minutes, and the first Submit of an off-grid geometry also loads the
cutout and builds its yt index. Never copy `~/.config/yt/yt.toml` anywhere (it holds an API key).
