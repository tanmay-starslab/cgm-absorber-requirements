---
title: TNG50 Sightline Explorer
emoji: 🔭
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: On-demand TNG50 CGM sightlines in 12 UV and X-ray ions
---

# TNG50 sightline explorer: API backend

Coordinator and fallback compute for the TNG50 sightline explorer
(https://tanmay-starslab.github.io/cgm-absorber-requirements/tng50/). It serves the precomputed
library of quasar sightlines through TNG50-1 subhalo 488530 (z = 0) and generates new geometries on
demand with yt + Trident in the 12 lines of the ion registry (`tngsight/ions.json`): H I 1216, Mg II 2796,
Si II 1260, C II 1335, Si III 1206, C III 977, Si IV 1403, C IV 1548, N V 1239, O VI 1032, Ne VIII 770 and
O VII 21.6, each on its own constant-velocity grid (0.25 km/s over ±1500 km/s, wider for damped H I), stored
as npz v2 and served to the page as the 1 km/s TNGS v2 binary. Library files written before Phase 3
(npz v1: O VI and C III) are still served, as TNGS v2 with those two lines.

The API is documented at `/docs` (FastAPI). `GET /api/health` shows whether the dataset is warm,
which workers are attached (this Space and any laptop pull-worker), the queue length, and the ion
registry (`ions`, `registry_tag`, `data_version`). A pull-worker whose registry differs from the Space's
is refused (HTTP 422 "registry mismatch"), so update both together.

## Configuration (Space settings → Variables and secrets)

| name | kind | value |
|---|---|---|
| `HF_TOKEN` | secret | token with read access to the private dataset; write access also mirrors generated sightlines (with a read-only token the first upload's 401/403 disables mirroring; `/api/health` shows `hf.disabled`). A token or repo error at startup is not retried |
| `HF_DATASET` | variable | `tanmay-starslab/tng50-sub488530-cgm` (default) |
| `WORKER_TOKEN` | secret | long random string; enables `/api/worker/*` for `deploy/laptop/worker.sh` |
| `CORS_ORIGINS` | variable | optional; default allows `https://tanmay-starslab.github.io` and localhost:8000 |
| `ANTHROPIC_API_KEY` | secret | optional; enables the Claude backend of the page's Ask panel (`POST /api/chat`) |
| `CHAT_CLAUDE` | variable | optional; `0` turns the Claude backend off while the key stays set |
| `CHAT_DAILY_BUDGET` | variable | optional; upstream chat requests per UTC day, all clients (default 500) |
| `CHAT_CLIENT_DAILY_BUDGET` | variable | optional; upstream chat requests per UTC day per client (default 50) |
| `CHAT_DAILY_TOKENS` | variable | optional; upstream chat tokens per UTC day, all clients (default 4000000; 0 = off) |

`start.sh` downloads the dataset into `/data` (persistent storage) or `$HOME/data`, sets the cutout's
mtime to a fixed epoch so yt's index hash stays stable, writes `config.tri`, and starts one uvicorn
worker on port 7860. Without the cutout it runs in library-only mode.

Data in the dataset: the slim cutout and the slim ion table `trident/hm2012_ss_hr.h5`, which must hold
the elements of all 12 registry ions (H, C, N, O, Ne, Mg, Si; 185.7 MB, built by
`deploy/data/slim_iontable.py`). The Phase 1/2 table (H, C, O) cannot deposit the new ions. The registry
`tngsight/ions.json` ships in the image with the `tngsight/` package.

## Credits

IllustrisTNG / TNG50-1 (Nelson et al. 2019; Pillepich et al. 2019), Trident (Hummels et al. 2017),
yt (Turk et al. 2011). Code: MIT, https://github.com/tanmay-starslab/cgm-absorber-requirements.
