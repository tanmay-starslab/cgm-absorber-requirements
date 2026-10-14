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
| 3D gas volumes (Phase 2) | `cd $WORK/run && $PY $OLDPWD/deploy/data/build_volumes.py` | `$WORK/data/library/vol/{manifest.json, <key>.u8.gz, <key>.128.u8.gz}` (+ float32 cache `vol_cache/`) | ~50 MB (budget: 256³ file ≤ 10 MB, 128³ file ≤ 1.5 MB, total ≤ 60 MB) |
| static page | `$PY scripts/export_tng50_web.py --prune --chat --space-url https://<user>-<space>.hf.space` | `docs/tng50/` (copies `components.json` and `vol/` into `docs/tng50/data/`) | |

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
- `build_volumes.py` SPH-deposits nH, T, Z, O VI, H I and C III on a 256³ grid (±400 kpc) from the slim
  cutout and writes the log10-uint8 volumes plus a 128³ downsample and `manifest.json`. It must run from a
  directory holding `config.tri` (trident). Each field is cached in `vol_cache/<key>_256.npy`; a cached field
  is reused unless `--force` or its SPH normalisation changed. Expect ~25–60 min for all six fields.
  It prints a column check (grid vs npz `logN`) for three library rays. The exporter copies the
  volumes from `--vol-dir` (default `<library>/vol`).
- **Heavy-I/O lock.** Both builds (and the slow tests) take an exclusive `fcntl` lock on
  `$WORK/scratch/p2/heavy.lock` for their whole run (macOS has no `flock(1)`), so two heavy jobs never
  read the USB disk at once; `--lock ''` disables it.
- **Backups.** `upload_hf_dataset.py` (§3) also uploads `components.json`, `components/` and `vol/`
  when they exist (`--no-phase2` skips them). The Space and the server skip `components/` and `vol/`
  when they download the dataset.

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
```
