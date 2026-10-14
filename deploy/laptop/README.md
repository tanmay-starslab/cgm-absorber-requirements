# deploy/laptop: local backend and pull-worker

Both scripts run from `/Volumes/cgm_work/run`, because trident reads `./config.tri` at import.
They use the env at `/Volumes/cgm_work/envs/trident` and refuse to start if `/Volumes/cgm_work` is
not mounted. Every path can be overridden with the variables listed in `server/README.md`.

| script | what it does |
|---|---|
| `serve.sh` | `uvicorn server.app:app` on **127.0.0.1:8787**, one process. It serves the library at `/Volumes/cgm_work/data/library` and generates new sightlines from the slim cutout. `LOCAL_WORKER=0` gives a library-only server. |
| `worker.sh [space-url]` | `python -m server.remote_worker`. It leases jobs from the HF Space over HTTPS, computes them here and uploads the npz. No inbound port is opened. |

```bash
deploy/laptop/serve.sh
open "https://tanmay-starslab.github.io/cgm-absorber-requirements/tng50/?api=http://127.0.0.1:8787"

# one-time: store the Space's WORKER_TOKEN in the login keychain
security add-generic-password -a "$USER" -s tng50-worker-token -w '<token>' -U
deploy/laptop/worker.sh https://tanmay-starslab-tng50-sightlines.hf.space
```

Notes
- A browser lets an HTTPS page call `http://127.0.0.1:8787` only on this same machine. The server
  sends `Access-Control-Allow-Private-Network: true` for that. Other people reach the laptop's
  compute only through `worker.sh`.
- The first request after a start is slow. Cold USB imports and the yt index for the slim cutout
  (`<library>/cutout.ewah`) take minutes. `/api/health` reports `warm` once the dataset is loaded.
- `TNG_START_DRYRUN=1` prints the command a script would run without starting anything.
