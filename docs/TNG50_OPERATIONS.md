# TNG50 sightline explorer: operations

Commands to rebuild the data, run the explorer locally, and deploy it. Paths assume the Mac setup:
the work volume `$WORK` (env, slim data, scratch; here `WORK=/Volumes/cgm_work`) and the read-only
originals on an external disk. Never write to the originals. Never ship `yt.toml` (it holds an API
key) or paths from other machines.

```bash
export WORK=/Volumes/cgm_work
export MPLCONFIGDIR=$WORK/cache/mpl XDG_CACHE_HOME=$WORK/cache/xdg \
       HDF5_USE_FILE_LOCKING=FALSE PYTHONDONTWRITEBYTECODE=1 PIP_CACHE_DIR=$WORK/cache/pip
PY=$WORK/envs/trident/bin/python
cd "$(git rev-parse --show-toplevel)"   # repo root, branch explorer/tng50
```

## 1. Data products (once, or after the originals change)

| product | command | output | size |
|---|---|---|---|
| slim cutout | (already built; r − hsml < 400 kpc, 2,028,706 gas cells) | `$WORK/data/cutout_slim_R400_sub488530.hdf5` | 203 MB |
| slim ion table (H, C, O) | `$PY deploy/data/slim_iontable.py` | `$WORK/data/trident_slim/hm2012_ss_hr.h5` | 51.4 MB (full: 1.41 GB) |
| library | `$PY deploy/data/build_library.py` | `$WORK/data/library/{sightlines/*.npz, web/*.bin, catalog.json}` | 672 + 672 files; 24.5 MB + 20.5 MB + 345 kB |
| Voigt components (Phase 2) | `$PY deploy/data/build_components.py` | `$WORK/data/library/components.json` + per-sightline cache `components/<id>.json` | ~0.8–1 MB (budget ≤ 1.5 MB) |
| 3D gas + star cubes (Phase 2b) | see §1b | `$WORK/data/library/viz/` (+ caches `viz_cache/`) | gas 18 cubes WebP ≈ 3.2–6.9 MB each (95 MB), gz ≤ 200 MB; stars WebP ≈ 3.8 / 6.2 / 9.2 MB, gz 7.2 / 10.7 / 16.7 MB (S0/S1/S2); exact table in the dataset card (`## Sizes`, rendered by the uploader) |
| static page | `$PY scripts/export_tng50_web.py --prune --chat --space-url https://<user>-<space>.hf.space` | `docs/tng50/` (copies `components.json` and `viz/manifest_v2.json` into `docs/tng50/data/`) | |

- `slim_iontable.py` copies each element dataset and its `Parameter1/Parameter2/Temperature`
  attributes verbatim. It checks the copy value by value, then loads every element with trident
  through a `config.tri` that points at the slim file. Takes about 6 min on the USB disk, most of it
  the cold `import trident`.
- `build_library.py` byte-copies the 672 npz (mtime kept), encodes `web/<id>.bin`, and writes catalog
  entries with `source: "library"`. Ranks and scores come from `tng50/data/grid_index.csv`.
  Re-running it is idempotent: ids that are already up to date are not read. `--verify` compares the
  sha256 of every copy with its source. `--force` rebuilds everything. Entries with
  `source: "generated"` are kept. Takes about 70 s with `-j 4`.
- `build_components.py` fits every library sightline with `tngsight.vpfit` (`--jobs 4` by default) and
  caches each fit in `components/<id>.json` keyed by the fitter's `params_tag`, so an interrupted run
  resumes and a parameter change refits everything (`--force` refits regardless; `--ids a,b` refits a few
  and merges them). It also stores each sightline's apparent-optical-depth columns under `"aod"`. About
  6 min for the 672 sightlines on this Mac (acceptance ≤ 60 min). `--include-generated` adds the
  generated rows; `--copy-to docs/tng50/data/components.json` byte-copies the result (the exporter
  also copies it, from `--components`, default `<library>/components.json`).
- **Heavy-I/O lock.** Both builds (and the slow tests) take an exclusive `fcntl` lock on
  `$WORK/scratch/p2/heavy.lock` for their whole run (macOS has no `flock(1)`), so two heavy jobs never
  read the USB disk at once; `--lock ''` disables it.
- **Backups.** `upload_hf_dataset.py` (§3) also uploads `components.json` and `components/` when they
  exist (`--no-phase2` skips them). The Space and the server skip `components/` when they download the
  dataset. The 3D cubes are not in the private dataset; they have their own public one (§1b).

## 1b. 3D cubes (Phase 2b): build, merge, upload, export

```bash
# 1. deposit (both take the heavy-I/O lock; run from a directory holding config.tri for the ion fields)
cd $WORK/run && $PY $OLDPWD/deploy/data/build_volumes.py --workers 4 && cd -   # gas L0/L1/L2 × 6 fields  (≤ 35 min)
$PY deploy/data/build_stars.py --workers 4                                       # stars S0/S1/S2 (≤ 10 min + one LaCie read)
# 2. put the LUTs in place FIRST (merge records luts.json in the manifest only if it already exists), then merge the
#    fragment manifests and validate every file's size and sha256
mkdir -p $WORK/data/library/viz/luts && cp docs/tng50/data/luts/luts.json $WORK/data/library/viz/luts/
$PY -m tngsight.vizpack merge    $WORK/data/library/viz
$PY -m tngsight.vizpack validate $WORK/data/library/viz
# 3. local preview: copy every cube next to a scratch page (refused for docs/tng50)
$PY scripts/export_tng50_web.py --out $WORK/scratch/site --viz-local --chat
# 4. publish the cubes to the PUBLIC dataset, then check CORS / sha256 / Range anonymously
$PY deploy/data/upload_viz_dataset.py --dry-run          # plan + total bytes; no token, uploads nothing
$PY deploy/data/upload_viz_dataset.py --dry-run --prune  # also list stale remote cube files (anonymous; deletes nothing)
$PY deploy/data/upload_viz_dataset.py                    # token from $HF_TOKEN or $HF_HOME/token; never printed
$PY deploy/data/upload_viz_dataset.py --verify-only
# 5. the page itself: only manifest_v2.json goes into git
$PY scripts/export_tng50_web.py --prune --chat --space-url https://<user>-<space>.hf.space
```

- **Range gate.** `build_volumes.py` stops if a field's encoding range leaves the design §3.4 bounds
  (`tngsight/volume.py` `EXPECTED_RANGE`; nH vmin −6.0 ± 0.3 and HI vmin −12.3 ± 0.4 are the masked p0.5 of the
  r ≤ 400 kpc data, as amended at integration). A plain rebuild passes it; `--allow-range FIELD,...` overrides it
  for a field you have checked by hand, and also disables that field's regression check.
- **Kernel floors.** Gas cells are deposited with h_eff = max(h, 2Δ) (`GAS_H_MIN_VOX` in `tngsight/volume.py`, a
  visual-tuning choice: a 1Δ floor draws sub-voxel cells as square 2×2×2 tiles), stars with max(h, Δ). Both are
  recorded in the manifest (`kernel.h_min_voxels_gas`, `kernel.h_min_voxels`) and stated in the dataset card.
- **Colour maps.** `$PY docs/tng50/data/luts/make_luts.py --js docs/tng50/js/colormaps.js` regenerates
  `docs/tng50/data/luts/luts.json` and the STOPS block of `docs/tng50/js/colormaps.js` together
  (`tests/js/colormaps.mjs` requires them to agree within ±1). Then re-copy `luts.json` into the viz dir, re-run
  `vizpack merge`, and upload.
- **Outputs.**
  - `viz/gas/<L>/<field>.<id12>.p0-3.webp` and `.u8.gz`;
  - `viz/stars/<S>/gri.<id12>.p0-3.webp` and `.rgba.gz`;
  - the fragments `viz/gas/manifest_gas.json` and `viz/stars/manifest_stars.json`;
  - `viz/manifest_v2.json`, written only by `vizpack merge`.

  `<id12>` is the start of the raw cube's sha256, so file names are immutable. A rebuilt cube gets a new name, and
  the old files keep working for older page versions.
- **Hosting.** The public dataset is `tanmay-starslab/tng50-sub488530-viz`. Its card is
  `deploy/data/viz_dataset_card.md`; the uploader fills in the sizes and uploads it as `README.md`.
  - **What gets uploaded.** `upload_viz_dataset.py` uploads only the allow-listed paths: the card, the manifest,
    the LUTs, the cubes and `previews/*.png` of ≤ 1 MB. It reports every other file under `viz/` as "not uploaded",
    with the reason: "off the allow-list" (fragment manifests, caches, …), "not referenced by manifest_v2.json"
    (older builds of a cube still on disk) or "preview over 1 MB".
  - **Skipping and ordering.** Files whose remote LFS sha256 already matches are skipped. Cubes are committed before
    the manifest, in commits of ≤ 100 files.
  - **Deleting.** `--dry-run --prune` only lists the remote cube files the manifest no longer references (an
    anonymous read; nothing is uploaded or deleted). Without `--dry-run`, `--prune` runs after the upload (and
    before the verify) and lists them, and `--prune --yes` deletes them.
  - **`--verify-only`.** It fetches anonymously, with `Origin: https://tanmay-starslab.github.io`, the manifest, one
    WebP part and one gz per kind. Each must give: status 200 after the redirect; `access-control-allow-origin`
    on both the 302 and the CDN 200; no `Content-Encoding`; the manifest's sha256; and 206 for `Range: bytes=0-99`.
- **Serving headers** (measured on HF, 2026-10-14):
  - `resolve/main/<LFS file>` answers 302 with `cache-control: no-store` and the Origin echoed. It redirects to
    `us.aws.cdn.hf.co`, which answers 200 or 206 with `access-control-allow-origin: *`, `accept-ranges: bytes`
    and an ETag, but **no `Cache-Control`**.
  - Small git files answer 307 and then 200, with the Origin echoed.
  - The page therefore caches cubes itself, in CacheStorage (`tng50-viz-v2`, keyed by the immutable URL).
- **Page config** (`CFG.viz`):
  - `manifest_url` = `data/viz/manifest_v2.json`, the committed, pinned version;
  - `base` = `https://huggingface.co/datasets/tanmay-starslab/tng50-sub488530-viz/resolve/main/` (`--viz-base`
    overrides it; `?viz=<base>` in the page URL does too, for dev);
  - `fallback_base` = `data/viz/` only for a `--viz-local` export (the cubes are then next to the page);
    otherwise `null`, because the Pages site never has cubes under `data/viz/` (git ignores `data/viz/*/`).

  A missing or invalid manifest exports `viz: null`, and the 3D tab then says the data is not published.
- **If huggingface.co is unreachable,** the 3D stage shows "The 3D data host (huggingface.co) is unreachable…"
  (a `--viz-local` build first retries `data/viz/`), and the spectra, ray picking and Find keep working.
- **Phase-2 volumes removed.** `docs/tng50/data/vol/` (the six 256³ and 128³ `.u8.gz` volumes and their
  `manifest.json`, 48 MB) is deleted, and git ignores it, together with `docs/tng50/data/viz/*/`. An export with
  `--prune` also deletes a leftover `<out>/data/vol/`. The page config keys `vol` and `vol_url` are gone.

## 2. Local use

```bash
deploy/laptop/serve.sh                                  # http://127.0.0.1:8787, library + generation
(cd docs && python3 -m http.server 8000) &             # web root is docs/, so the ../ companion link works
open "http://127.0.0.1:8000/tng50/?api=http://127.0.0.1:8787"
curl -s http://127.0.0.1:8787/api/health
```

## 3. Hugging Face deployment (needs the owner's token)

Two repos: a **private dataset** (data) and a **public Docker Space** (code). The Space downloads
the dataset with its `HF_TOKEN` secret.

```bash
# dataset: slim cutout + slim ion table + library at the repo root (= the server's library dir)
env -u HF_TOKEN $PY deploy/data/upload_hf_dataset.py --dry-run                 # plan: ~2030 files, ~350 MB (with Phase-2 files)
HF_TOKEN=hf_xxx $PY deploy/data/upload_hf_dataset.py [--repo tanmay-starslab/tng50-sub488530-cgm]

# Space: assemble the build context in $WORK/scratch/space_build and push it
deploy/hf_space/push_space.sh --assemble-only                                  # inspect, no token
HF_TOKEN=hf_xxx deploy/hf_space/push_space.sh tanmay-starslab/tng50-sightlines
```

In the Space settings, add the secrets `HF_TOKEN` (read access to the dataset; write access also
mirrors generated sightlines to `generated/`) and `WORKER_TOKEN` (a long random string, e.g.
`openssl rand -hex 32`). The Space URL is then `https://tanmay-starslab-tng50-sightlines.hf.space`.
Rebuild the page with it: `$PY scripts/export_tng50_web.py --prune --chat --space-url <that URL>`.
Always pass `--chat`: it is off by default, and an export without it publishes the page with the
Ask button hidden (`chat.enabled = false`).

### Chat (Claude backend, optional)

The page's Ask panel always offers the in-browser model. The Claude backend (`POST /api/chat`) appears
only when the server has an Anthropic key. In the Space settings add:

| name | kind | value |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | Anthropic API key; never commit or print it |
| `CHAT_CLAUDE` | variable | optional, `0` hides the Claude backend while keeping the key (default on) |
| `CHAT_DAILY_BUDGET` | variable | upstream requests per UTC day, all clients together (default 500) |
| `CHAT_CLIENT_DAILY_BUDGET` | variable | upstream requests per UTC day for one client (default 50) |
| `CHAT_DAILY_TOKENS` | variable | upstream input + output tokens per UTC day, all clients (default 4000000; 0 = off) |

Fixed limits (server/settings.py): 60 requests/h with a burst of 12 per client (an IPv6 client counts as
its /64), 4 upstream calls in flight, at most 40 messages and 48 KiB per request, `max_tokens` ≤ 1024.
Check with `curl -s <URL>/api/health`: `chat.claude` is `true` when the backend is on.

What the image does (`deploy/hf_space/Dockerfile`):
- Base `python:3.11-slim`, runs as uid 1000, pip-installs `requirements-tng.txt` plus
  `yt_astro_analysis==1.1.4`.
- Trident is upstream at the fork's base commit `3f69ad7e` plus `trident_doppler_only.patch`. The
  patch is the fork's diff without the `tests/` hunk; it keeps the harmless Mg II `lines.txt` hunk.
  The patched files are checked against sha256 pins of the laptop fork. This is preferred over
  `pip install git+<fork>`, because the fork is not public (it exists only in the owner's private env bundle).
- The matplotlib font cache is baked in, and the trident import is smoke-tested.
- `start.sh` runs `snapshot_download` of the dataset into `/data` (if persistent storage is enabled)
  or `$HOME/data`. It sets the cutout mtime to the fixed epoch 1700000000, because yt's index hash
  includes the mtime. It writes `config.tri`, then runs
  `exec uvicorn server.app:app --host 0.0.0.0 --port 7860 --workers 1`.

## 4. Laptop as a remote worker for the Space

```bash
security add-generic-password -a "$USER" -s tng50-worker-token -w '<WORKER_TOKEN>' -U   # once
deploy/laptop/worker.sh https://tanmay-starslab-tng50-sightlines.hf.space
```

The worker pulls jobs over HTTPS. It needs no open port and no tunnel. Whichever worker is free first
(Space CPU or laptop) takes the next job.

## 5. Tests

```bash
$PY -m pytest deploy/tests -q -p no:cacheprovider --basetemp=$WORK/scratch/pytest
$PY -m pytest tests -q
PYTHON=$PY node tests/js/run_all.mjs           # JS: page smoke, 3D data decode, Lupton parity, LOD, LUTs, picker, search, chat
TNG_RUN_SLOW=1 $PY -m pytest tests/test_deposit.py tests/test_volume.py -q   # adds the slow, real-data tests
# headless-browser viewer test (fullscreen, mobile layout, byte-exact WebP decode); Microsoft Edge, never ports 8787/8000
$PY tests/js/make_viz_fixture.py --full $WORK/scratch/viz_fixture             # synthetic galaxy viz dir (or use the real one)
TNG_BROWSER=1 node tests/js/viewer_browser.mjs --viz $WORK/data/library/viz --port 8871
```

`tests/test_stars.py` is synthetic and fast, so it runs in the plain `pytest tests` line. Under `run_all.mjs`,
`viewer_browser.mjs` only prints "skipped"; it runs only with `TNG_BROWSER=1` and `--viz DIR`.

`tests/test_export_web.py` covers the exporter: the manifest-only copy, `CFG.viz`, `viz: null` for a missing or
invalid manifest, and `--viz-local` refused for `docs/tng50`. `tests/test_upload_viz.py` covers the uploader: the
allow-list, the refusals, skip-if-identical, ordering, prune, and that the token is never printed. It uses a fake
`HfApi` and does no network I/O.
