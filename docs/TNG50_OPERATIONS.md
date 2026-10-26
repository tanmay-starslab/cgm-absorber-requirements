# TNG50 sightline explorer: operations

Commands to rebuild the data, run the explorer locally, test it, and deploy it (Phase 3: 12 ions, data v2). Every
default path derives from one work root, `$TNG_WORK` (`tngsight.config.work_root()`; unset, it is the owner's Mac
work volume): env, slim data, libraries, caches and scratch live under it. The specific variables
(`TNG_LIBRARY_DIR`, `TNG_CUTOUT`, `TNG_ION_TABLE_DIR`, `TNG_INDEX_FILE`, `TNG_HEAVY_LOCK`, `HF_HOME`, `SPACE_BUILD`,
`PY`, ...) still override their own path. The simulation originals sit on a separate read-only disk; never write to
them. Never ship `yt.toml` (it holds an API key), `config.tri`, tokens, or paths from any machine.

```bash
export TNG_WORK=<work root>
export MPLCONFIGDIR=$TNG_WORK/cache/mpl XDG_CACHE_HOME=$TNG_WORK/cache/xdg \
       HDF5_USE_FILE_LOCKING=FALSE PYTHONDONTWRITEBYTECODE=1 PIP_CACHE_DIR=$TNG_WORK/cache/pip
PY=$TNG_WORK/envs/trident/bin/python     # the env with the patched trident (Linux: section 6)
LIB=$TNG_WORK/data/library_v3            # the Phase 3 library (data v2); $TNG_WORK/data/library is v1
cd "$(git rev-parse --show-toplevel)"
```

Dependency chain: ion registry (`tngsight/ions.json`) → slim ion table → library (npz v2, TNGS v2, components) → 3D
ion cubes → page export → uploads and deploy. After a registry edit also run `$PY -m server.make_chat_tools` (the
chat tool files and the generated blocks of `chat.js` and `search.js`; `--check` exits 1 when they are stale).

## 1. Data products

| product | command | output | size |
|---|---|---|---|
| slim cutout | built once (r − hsml < 400 kpc, 2,028,706 gas cells) | `$TNG_WORK/data/cutout_slim_R400_sub488530.hdf5` | 203 MB |
| slim ion table (H, C, N, O, Ne, Mg, Si) | `$PY deploy/data/slim_iontable.py` | `$TNG_WORK/data/trident_slim_v3/hm2012_ss_hr.h5` | 185.7 MB (full table 1.41 GB) |
| library, data v2 | `$PY deploy/data/regen_library.py --out $LIB -j 3` | `sightlines/`, `web/`, `generated/`, `components/`, `catalog.json`, `components.json`, `gate_report.json` | 683 ids; npz 0.30 GB, web 52.4 MB |
| components refit into a candidate dir | `$PY deploy/data/build_components.py --library $LIB --rows --include-generated --cache <dir>/components --out <dir>/components.json --jobs 3` | per-id fits and the merged catalogue | 38,751 components, 2.26 MB |
| 3D gas cubes | section 1b | `$LIB/viz/gas/`, cache `$LIB/viz_cache/gas/` | 15 fields × 3 levels |
| static page | `$PY scripts/export_tng50_web.py --library $LIB --prune --chat --space-url <backend URL>` | `docs/tng50/` | 672 TNGS v2 binaries, 52.4 MB |

- **Slim ion table.** `slim_iontable.py` copies, verbatim, the element datasets of all 12 registry ions and their
  `Parameter1/Parameter2/Temperature` attributes from the full table (`$TNG_WORK/data/trident/hm2012_ss_hr.h5`),
  checks every value, then loads each element with trident through a `config.tri` that points at the slim file. The
  Phase 1/2 table (H, C, O, 51.4 MB) cannot make the new ions. `deploy/tests/test_slim_iontable.py` (slow) checks
  that a ray through the slim table gives the full table's τ for Mg II, Si II, N V and Ne VIII.
- **Library regeneration.** `regen_library.py` reads only the ids and the stored `geom` of the v1 library (`--src`,
  default `$TNG_WORK/data/library`), so the rays are bit-identical. The parent builds the yt index once
  (`<out>/cutout.ewah`); at most 4 spawn workers each keep a warm generator and make one id at a time: 12 lines on
  their native grids, npz v2, TNGS v2, then the vpfit components. Writes are atomic and `regen_state.jsonl` records
  each finished id, so a killed run resumes, and an id whose fit is stale (another `params_tag`) is refitted only.
  `--force` redoes everything, `--gate-only` rebuilds the merged outputs and the gate from the files on disk, and
  `--ids`/`--limit` serve tests. Phase 3 took 5 h 30 min at `-j 3`, limited by disk I/O (40,000 CPU seconds).
- **Regression gate** (`gate_report.json`, exit 2 on failure). Hard: ray column |Δ| ≤ 0.02 dex against v1 for O VI,
  C III and H I (v1 Lyβ, the same ion column), and AOD completeness ≤ 0.01 dex for every line with log N ≥ 12.
  Reported only: AOD v3 − v1 (the v1 `min_tau` 1e-3 deficit; O VI median +0.025 dex) and the pixel-level section
  `pixel_v1_v3`. The gate tests geometry and completeness, not the spectra (section 7).
- **Components and the Phase 3 refit (C1).** `tngsight/vpfit.py` seeds fit regions per pixel and with a matched
  filter (box widths 3, 7, 15, 31, 63 and 127 km/s; a box at ≥ 3σ makes a region) and adds components while any
  residual box reaches 3σ (damped H I exempt). This finds the shallow, broad O VI, N V and Ne VIII that per-pixel
  seeding missed: no O VI or N V sightline with ray log N ≥ 12.7 is left without components. Fits are cached per id
  by the fitter's `params_tag` (now `989b81428c70`). After a fitter change, `regen_library.py --out $LIB` refits
  the stale ids in place; to keep the served library untouched while checking, refit into a candidate directory with
  `build_components.py --rows` (the regen cache layout; the full refit took 36 min at 3 workers) and swap the files
  in with a backup. Then rebuild the browser fit fixture (`tests/js/make_fit_fixture.py`) and re-export the page.
- **Switch-over.** Point tools at a library with `--library` or `TNG_LIBRARY_DIR` (or swap the files in place with
  a backup), never by editing code.
- **Heavy-I/O lock.** With `TNG_HEAVY_LOCK` set, the builds hold an exclusive `fcntl` lock on that file during their
  heavy reads, so two heavy jobs never read the same slow disk at once; the slow tests default to
  `$TNG_WORK/scratch/p2/heavy.lock` when that directory exists.

## 1b. 3D cubes: build, check, merge, upload

```bash
# 1. deposit from a directory holding config.tri (ion fields); batches of 3 ions cap the memory
cd $TNG_WORK/run && $PY $OLDPWD/deploy/data/build_volumes.py --library $LIB --fields MgII,SiII,CII --workers 2 && cd -
$PY deploy/data/build_stars.py --workers 4                      # stars S0/S1/S2 (unchanged in Phase 3)
# 2. column checks alone, from the cache: writes only the report, so the cache and viz may be read-only
$PY deploy/data/build_volumes.py --check --library $LIB --report $TNG_WORK/scratch/cube_check.json
# 3. LUTs first, then merge the fragments and validate every file's size and sha256
mkdir -p $LIB/viz/luts && cp docs/tng50/data/luts/luts.json $LIB/viz/luts/
$PY -m tngsight.vizpack merge    $LIB/viz
$PY -m tngsight.vizpack validate $LIB/viz
# 4. local preview with every cube next to a scratch page (refused for docs/tng50)
$PY scripts/export_tng50_web.py --library $LIB --out $TNG_WORK/scratch/site --viz-local --chat
# 5. publish to the PUBLIC dataset, then check CORS, sha256 and Range anonymously
$PY deploy/data/upload_viz_dataset.py --viz $LIB/viz --dry-run           # plan and bytes; no token
$PY deploy/data/upload_viz_dataset.py --viz $LIB/viz --dry-run --prune   # also list stale remote files
$PY deploy/data/upload_viz_dataset.py --viz $LIB/viz                     # token from $HF_TOKEN or $HF_HOME/token
$PY deploy/data/upload_viz_dataset.py --verify-only
```

- **Fields and levels.** n_H, T, Z and the 12 ion densities (cool ions `tng_ice`, intermediate `viridis`, hot
  `magma`) on L0 ±400 kpc (3.125 kpc voxels), L1 ±100 kpc (0.78 kpc) and L2 ±25 kpc (0.195 kpc), each 256³. A level
  whose cubes for `--fields` are cached is reused, so new ions are added to an existing cache. Phase 3: 15 fields,
  240 cube files, 619.5 MB.
- **Column checks** (stage 4; `--check` runs it alone). Gas is deposited with h_eff = max(h, 2Δ) (`GAS_H_MIN_VOX`,
  a visual floor), so each cube column is checked against that smoothed field: the h_eff SPH line integral averaged
  over a 3 × 3 bundle of rays offset by ±Δ/2 across the beam (`volume.smoothed_columns`), within 0.05 dex
  (`volume.SMOOTH_TOL`), on 3 or 4 sightlines per level and every ion cube. Also hard: the u8 cube column against
  the float cube within 0.02 dex, and the cell-h line integral against the npz ray column within 0.02 dex on full
  rays. The thin-ray difference is reported only. Phase 3 cubes: 120 of 120 pass (worst +0.046 dex, L0 N V); the
  thin ray differs by up to 0.64 dex on clumpy Si IV, C IV and N V at L0 and L1, which is the smoothing, not the
  deposit.
- **Range gate.** The build stops when a field's encoding range leaves its expected bounds (`EXPECTED_RANGE` in
  `tngsight/volume.py`); `--allow-range FIELD,...` overrides it for a field checked by hand.
- **Outputs.** `viz/gas/<L>/<field>.<id12>.p0-3.webp` and `.u8.gz`, `viz/stars/<S>/gri.<id12>.p0-3.webp` and
  `.rgba.gz`, the fragments `manifest_gas.json` and `manifest_stars.json`, and `viz/manifest_v2.json`, written only
  by `vizpack merge`. `<id12>` starts the raw cube's sha256, so names are immutable and older pages keep working.
- **Hosting.** Public dataset `tanmay-starslab/tng50-sub488530-viz`, card `deploy/data/viz_dataset_card.md` (the
  uploader fills in the sizes). The uploader sends only the allow-list (card, manifest, LUTs, referenced cubes,
  previews ≤ 1 MB), skips files whose remote sha256 matches, commits cubes before the manifest, and deletes stale
  files only with `--prune --yes`. The CDN sends no `Cache-Control`, so the page caches cubes in CacheStorage.
- **Page config.** `CFG.viz.manifest_url` is the committed `data/viz/manifest_v2.json`; `base` is the dataset's
  `resolve/main/` (`--viz-base` or `?viz=<base>` override it); `fallback_base` is set only for `--viz-local`. If
  huggingface.co is unreachable, only the 3D stage says so.
- **Colour maps.** `$PY docs/tng50/data/luts/make_luts.py --js docs/tng50/js/colormaps.js` regenerates `luts.json`
  and the STOPS block of `colormaps.js` together (`tests/js/colormaps.mjs` checks they agree); then re-copy
  `luts.json`, re-merge and upload.

## 2. Local use

```bash
deploy/laptop/serve.sh                                  # http://127.0.0.1:8787, library + generation
(cd docs && python3 -m http.server 8000) &             # web root docs/, so the companion link works
open "http://127.0.0.1:8000/tng50/?api=http://127.0.0.1:8787"
curl -s http://127.0.0.1:8787/api/health               # ions, registry_tag, data_version 2
```

## 3. Upload and deploy

Ship from a clean git worktree at the commit you mean to deploy, never from a checkout that is being edited
(`push_space.sh` and `push_oci.sh` copy `tngsight/` and `server/` from the tree they run in):

```bash
SHA=$(git rev-parse <branch or tag>)
git worktree add --detach $TNG_WORK/scratch/deploy_$SHA $SHA && cd $TNG_WORK/scratch/deploy_$SHA
```

1. **Private dataset** (slim cutout, slim ion table, library at the repo root, which is the server's library dir):
   ```bash
   env -u HF_TOKEN $PY deploy/data/upload_hf_dataset.py --library $LIB --generated --dry-run
   HF_TOKEN=... $PY deploy/data/upload_hf_dataset.py --library $LIB --generated
   ```
   The ion table defaults to `$TNG_WORK/data/trident_slim_v3/hm2012_ss_hr.h5` (`--ion-table` overrides it).
2. **Public viz dataset**: section 1b step 5. Upload the cubes before the page that references them.
3. **Backend.** The image of `deploy/hf_space` runs on an Oracle Cloud A1 VM (`deploy/oci/README.md`):
   `deploy/oci/push_oci.sh <public-ip>`, then `curl -s https://<ip-dashes>.sslip.io/api/health` and check `ions`
   and `registry_tag`. The same image runs as an HF Docker Space (`deploy/hf_space/push_space.sh <space-id>`).
   `--assemble-only` on either script builds the context without a token or a VM. A worker whose registry differs
   from the server's gets 422 "registry mismatch", so update the backend and any laptop worker together.
4. **Page.** `$PY scripts/export_tng50_web.py --library $LIB --prune --chat --space-url <backend URL>`, commit
   `docs/tng50/` (of the viz dir only `data/viz/manifest_v2.json` is tracked) and merge to `main` for GitHub Pages.
   Always pass `--chat`: without it the page hides the Ask button.

Space or VM secrets: `HF_TOKEN` (read access to the dataset; write access also mirrors generated sightlines to
`generated/`; a read-only token disables mirroring after its first 401/403), `WORKER_TOKEN` (for example
`openssl rand -hex 32`) and the optional chat settings:

| name | kind | value |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | Anthropic API key; never commit or print it |
| `CHAT_CLAUDE` | variable | `0` hides the Claude backend while keeping the key (default on) |
| `CHAT_DAILY_BUDGET` | variable | upstream requests per UTC day, all clients (default 500) |
| `CHAT_CLIENT_DAILY_BUDGET` | variable | upstream requests per UTC day for one client (default 50) |
| `CHAT_DAILY_TOKENS` | variable | upstream tokens per UTC day, all clients (default 4000000; 0 = off) |

Fixed chat limits (`server/settings.py`): 60 requests per hour with a burst of 12 per client (an IPv6 client counts
as its /64), 4 upstream calls in flight, at most 40 messages and 48 KiB per request, `max_tokens` ≤ 1024.

The image (`deploy/hf_space/Dockerfile`): `python:3.11-slim-bookworm`, uid 1000, `requirements-tng.txt` plus
`yt_astro_analysis==1.1.4`, upstream Trident at `3f69ad7e` plus `trident_doppler_only.patch` (the patched files are
sha256-pinned), and `tngsight/` with its registry. `start.sh` downloads the dataset, pins the cutout mtime (yt's
index hash includes it), writes `config.tri` and runs one uvicorn worker on port 7860.

## 4. Laptop as a remote worker

```bash
security add-generic-password -a "$USER" -s tng50-worker-token -w '<WORKER_TOKEN>' -U   # once (macOS keychain)
deploy/laptop/worker.sh <backend URL>
```

The worker pulls jobs over HTTPS (no open port, no tunnel) and must run the same registry as the backend.

## 5. Tests

```bash
$PY -m pytest -m "not slow" tests deploy/tests -q -p no:cacheprovider --basetemp=$TNG_WORK/scratch/pytest
TNG_RUN_SLOW=1 $PY -m pytest tests/test_deposit.py tests/test_volume.py deploy/tests/test_slim_iontable.py -q
PYTHON=$PY node tests/js/run_all.mjs        # JS: page, fitter, decoders, 3D data, LUTs, picker, search, chat
```

- The HFSync server tests poll their conditions with a 120 s ceiling (`TNG_TEST_HF_WAIT`), so a loaded machine slows
  them down instead of failing them.
- The browser tests drive an exported page (`export_tng50_web.py --out <dir>`) in a headless Chromium browser through
  `tests/js/lib/browser.mjs`: `TNG_EDGE` names the binary (default: Edge or Chrome on macOS, the first Chromium on
  PATH on Linux), each run gets a fresh temp profile (`--profile` or `TNG_EDGE_PROFILE` set its parent, never inside
  the viz dir) and `--remote-debugging-port=0`, the static server takes an OS-chosen port (`TNG_TEST_PORT` fixes
  one; 8787 and 8000 are refused), and the laptop server and hosted backends are blocked. Without `TNG_BROWSER=1`
  they run only their static checks.

```bash
SITE=$TNG_WORK/scratch/site; VIZ=$LIB/viz
TNG_BROWSER=1 node tests/js/page_smoke.mjs $SITE --viz $VIZ
TNG_BROWSER=1 node tests/js/ui_budget.mjs  $SITE --viz $VIZ [--shots DIR]   # words, separators, shares, square 3D
TNG_BROWSER=1 node tests/js/ui_static.mjs  $SITE
TNG_BROWSER=1 node tests/js/viewer_browser.mjs --viz $VIZ --docs $SITE [--shots DIR]
```

`tests/test_export_web.py` covers the exporter and `tests/test_upload_viz.py` the uploader (allow-list, refusals,
skip-if-identical, ordering, prune, the token never printed; a fake `HfApi`, no network).

## 6. Running on a Linux cluster

- **Work root.** `export TNG_WORK=<project dir on the cluster file system>` and put the slim cutout, the full and
  slim ion tables and the libraries under `$TNG_WORK/data/` in the layout above. Keep `config.tri` in
  `$TNG_WORK/run/` and start trident jobs from there. Set `HDF5_USE_FILE_LOCKING=FALSE` on shared file systems.
- **Environment.** The image recipe without Docker: a CPython 3.11 venv,
  `pip install -r requirements-tng.txt yt_astro_analysis==1.1.4 pytest==9.1.1`, then trident from the upstream
  tarball at `3f69ad7e1927aae8101caa587869d3d68a31c544` with `deploy/hf_space/trident_doppler_only.patch` applied,
  the three patched files checked against the sha256 pins in `deploy/hf_space/Dockerfile`, and
  `pip install --no-deps .`. The pinned wheels need glibc ≥ 2.28. Point `PY` (or `PYTHON`) at the venv's python.
- **Browser tests.** No Edge is needed: any Chromium works, for example `chrome-headless-shell` with
  `TNG_EDGE=<binary>`. Without a GPU, WebGL is rendered in software and the 3D thumbnail's continuous turn
  saturates the browser's GPU process, so set `TNG_REDUCED_MOTION=1` for page_smoke, ui_budget and ui_static (the
  page then stops the turn). viewer_browser ignores it, because it checks the turn. Allow long timeouts (software
  WebGL is several times slower), run one browser at a time, and keep `TNG_EDGE_PROFILE` on scratch space.
- **Compute jobs.** Run Python, node and browsers inside a compute allocation, not on a login node, and size it to
  the step: the fast test suites, one browser test or a cube `--check` need 2 cores and 4 GB; a cube build about
  2.5 GB plus 0.6 GB per encoder; `regen_library.py` one core per worker (`-j` up to 4) plus one for the parent, with
  the memory measured on a short `--limit` run first. Set `OMP_NUM_THREADS` to the cores you asked for, and give
  each step its own share when several share one allocation. Request only cores, memory, partition and wall time
  (a GPU only if a step needs one), never a specific node, and no more than the step needs: none of these steps
  needs days of wall time or more than 32 GB.

## 7. Known limitations

- **H I damping.** Lyα uses Trident's Γ = 4.69e8 s⁻¹ (the NIST level-summed A); the standard damping constant is
  6.265e8 (Morton 2003), so damped log N fitted here sits about 0.13 dex from VPFIT-style tools. The other atomic
  data are Trident's too, for consistency with the spectra (the O VI and C IV rest wavelengths differ from Morton's
  by 3 to 4 km/s).
- **Saturated components.** SAT components, including Lyα-only H I fits in the degenerate range (log N 15 to 19,
  without Lyβ), are lower limits (log N ≥ x) in the page readout, the search and the chat tool outputs, never
  measurements.
- **v1 bin-edge offset.** Trident labels each spectral bin by its left edge while the bin's sub-bins start there, so
  a narrow line in the Phase 1/2 (v1) spectra sits up to 0.45 dλ blue of the truth (C III best shift +0.22 km/s
  median, up to +0.29). It moves τ in velocity but conserves ∫τ dv; on the v2 0.25 km/s grid the offset is at most
  0.11 km/s. Hence the regeneration gate tests geometry and completeness, not pixels.
- **Cube checks.** The cubes are tested against their own smoothed, voxel-averaged field (section 1b). That shows the
  deposit is right; it does not make a 3 kpc voxel resolve a sub-kpc clump. The reference models gas that fills the
  voxel footprint, as the CGM does; an isolated sub-voxel clump seen at the edge of its smoothed support can differ
  by more.
- **Formal errors.** Library fits use a pseudo-noise σ = 0.01 per pixel; the browser fitter's errors come from the
  noisy degraded spectrum of each displayed case.
