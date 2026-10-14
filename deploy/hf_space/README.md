---
title: TNG50 Sightline Explorer
emoji: 🔭
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: On-demand TNG50 CGM sightlines (O VI, H I Lyb, C III)
---

# TNG50 sightline explorer: API backend

Coordinator and fallback compute for the TNG50 sightline explorer
(https://tanmay-starslab.github.io/cgm-absorber-requirements/tng50/). It serves the precomputed
library of 672 quasar sightlines through TNG50-1 subhalo 488530 (z = 0) and generates new
geometries on demand with yt + Trident: O VI 1032, H I Lyβ and C III 977, ±1500 km/s, dλ = 0.002 Å.

The API is documented at `/docs` (FastAPI). `GET /api/health` shows whether the dataset is warm,
which workers are attached (this Space and any laptop pull-worker), and the queue length.

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

## Credits

IllustrisTNG / TNG50-1 (Nelson et al. 2019; Pillepich et al. 2019), Trident (Hummels et al. 2017),
yt (Turk et al. 2011). Code: MIT, https://github.com/tanmay-starslab/cgm-absorber-requirements.
