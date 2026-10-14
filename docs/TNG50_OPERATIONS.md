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
| static page | `$PY scripts/export_tng50_web.py --space-url https://<user>-<space>.hf.space` | `docs/tng50/` | |

- `slim_iontable.py` copies each element dataset and its `Parameter1/Parameter2/Temperature`
  attributes verbatim. It checks the copy value by value, then loads every element with trident
  through a `config.tri` that points at the slim file. Takes about 6 min on the USB disk, most of it
  the cold `import trident`.
- `build_library.py` byte-copies the 672 npz (mtime kept), encodes `web/<id>.bin`, and writes catalog
  entries with `source: "library"`. Ranks and scores come from `tng50/data/grid_index.csv`.
  Re-running it is idempotent: ids that are already up to date are not read. `--verify` compares the
  sha256 of every copy with its source. `--force` rebuilds everything. Entries with
  `source: "generated"` are kept. Takes about 70 s with `-j 4`.

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
env -u HF_TOKEN $PY deploy/data/upload_hf_dataset.py --dry-run                 # plan: 1347 files, ~300 MB
HF_TOKEN=hf_xxx $PY deploy/data/upload_hf_dataset.py [--repo tanmay-starslab/tng50-sub488530-cgm]

# Space: assemble the build context in $WORK/scratch/space_build and push it
deploy/hf_space/push_space.sh --assemble-only                                  # inspect, no token
HF_TOKEN=hf_xxx deploy/hf_space/push_space.sh tanmay-starslab/tng50-sightlines
```

In the Space settings, add the secrets `HF_TOKEN` (read access to the dataset; write access also
mirrors generated sightlines to `generated/`) and `WORKER_TOKEN` (a long random string, e.g.
`openssl rand -hex 32`). The Space URL is then `https://tanmay-starslab-tng50-sightlines.hf.space`.
Rebuild the page with it: `$PY scripts/export_tng50_web.py --space-url <that URL>`.

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
