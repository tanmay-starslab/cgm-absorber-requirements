# server/: on-demand sightline API

This is a FastAPI coordinator for the TNG50 sightline explorer. It serves the sightline library (catalog, web binaries, raw npz files) and generates new geometries on demand through a job queue. Progress reaches the browser over SSE. Remote machines can do the compute through a pull-based lease protocol.

The same code runs in two places:

- on the Hugging Face Space, as **coordinator + fallback compute**;
- on a laptop, for local use, or as a **remote worker** that pulls jobs from the Space.

## Run locally

```bash
export MPLCONFIGDIR=/Volumes/cgm_work/cache/mpl XDG_CACHE_HOME=/Volumes/cgm_work/cache/xdg \
       HDF5_USE_FILE_LOCKING=FALSE PYTHONDONTWRITEBYTECODE=1
cd /Volumes/cgm_work/run            # contains config.tri (trident reads ./config.tri at import)
PYTHONPATH=/path/to/cgm-absorber-requirements \
TNG_LIBRARY_DIR=/Volumes/cgm_work/data/library TNG_WORKDIR=/Volumes/cgm_work/scratch/server \
  /Volumes/cgm_work/envs/trident/bin/python -m uvicorn server.app:app --host 127.0.0.1 --port 8787 --workers 1
```

`server.app:app` is built from the environment the first time it is accessed. Code that needs different settings calls `server.app.create_app(settings, generator=..., figure_renderer=..., hf=...)`.

Frontend development without yt uses the fake generator. Its spectra are synthetic Gaussians, so never deploy it:
`TNG_GENERATOR=server.testing:FakeGenerator`.

### Why exactly one process (`--workers 1`)

- yt is not thread-safe, and loading the dataset is expensive: importing trident, `yt.load` with the index, and `add_ion_fields` take minutes on a cold disk. The server keeps **one** warm dataset in **one** child process (spawn `ProcessPoolExecutor(max_workers=1)`). Every uvicorn worker would load its own copy, multiplying memory and warm-up time, and the copies would race on the `.ewah` index file.
- The job queue, dedupe map, leases, SSE subscribers, rate-limit buckets and figure LRU all live in this process's memory. With several processes, a job submitted to one would be invisible to SSE or `/api/jobs` requests answered by another.

The event loop stays responsive while a ray is being cast, because the cast runs in the child process. Figures render in a thread under a lock, since matplotlib is not thread-safe.

## Environment variables

| var | default | meaning |
|---|---|---|
| `TNG_LIBRARY_DIR` | `/Volumes/cgm_work/data/library` | library root (`catalog.json`, `sightlines/`, `web/`, `generated/`) |
| `TNG_CUTOUT` | tngsight default | slim cutout HDF5 |
| `TNG_ION_TABLE_DIR` | tngsight default | directory with `hm2012_ss_hr.h5` |
| `TNG_INDEX_FILE` | `<library>/cutout.ewah` | writable yt index file |
| `TNG_WORKDIR` | system temp | scratch for ray `.h5` files (read by `tngsight.generate.Generator`) |
| `TNG_GENERATOR` | `tngsight.generate:Generator` | `module:attr` Generator factory |
| `LOCAL_WORKER` | `1` | `0` disables in-process compute (e.g. when the cutout is missing) |
| `WORKER_TOKEN` | unset | Bearer token for `/api/worker/*`; unset = remote workers disabled (404) |
| `HF_TOKEN`, `HF_DATASET` | unset | enable HFSync: `snapshot_download` at startup, upload `generated/*` (pending uploads persist in `<library>/.hfsync_pending.json`; a read-only token disables uploading) |
| `HF_STARTUP_DOWNLOAD` | `1` | `0` skips the app's startup snapshot (the Space's `start.sh` sets it after its own successful sync) |
| `CORS_ORIGINS` | `https://tanmay-starslab.github.io,http://localhost:8000,http://127.0.0.1:8000` | comma list |
| `TRUST_PROXY` | `0` | `1` = client IP from `X-Forwarded-For` (HF Space proxy). Only the hop the trusted proxy appended is used, never the client-supplied left part |
| `TRUSTED_HOPS` | `1` | number of trusted proxies appending to `X-Forwarded-For`; the client is the `TRUSTED_HOPS`-th entry from the right |
| `NODE_NAME` | `local` | shown in `/api/health` and the page's status pill |
| `PORT` | `8787` | read by the deploy scripts (uvicorn takes `--port`) |

## Endpoints (prefix `/api`)

| method | path | result |
|---|---|---|
| GET | `/health` | status, version, `warm`, local/remote workers, queue counts, library/generated sizes, node |
| GET | `/catalog` | catalog.json (library + generated), `ETag`, `Cache-Control: max-age=60`, 304 on `If-None-Match` |
| GET | `/sightline/{id}.bin` | web binary (octet-stream); `{id}.npz` = raw npz download; 404 if unknown, 422 for a malformed id |
| POST | `/geometry` | `{orientation,b_kpc,azimuth_deg,seed}` → canonical values + `make_sightline` geometry + `exists` |
| POST | `/sightlines` | same body → `200 {id,status:"ready",entry}` or `202 {id,job_id,status:"queued",position}` |
| GET | `/jobs/{job_id}` | `{job_id,id,status,stage,frac,msg,position,error,entry,attempts}` |
| GET | `/jobs/{job_id}/events` | SSE: `queued`, `progress`, `done`, `error`; `: ping` comment every 15 s; closes after done/error |
| POST | `/figure` | `{id,R_lo,R_hi,sn_hi,sn_lo,vwin,intrinsic,seed,fmt}` → PNG/PDF attachment (LRU cache of 64). Only the page's values are accepted: R in {20k,30k,40k,60k,80k,100k}, integer S/N 2–20, `vwin` 150–800 in steps of 50, `seed` 0–99999 |
| POST | `/worker/lease` | Bearer; `{name}`; long-poll ≤25 s (`?wait=` lowers it) → `200 {job_id,geom,lease_s,attempt,lease}` / `204` |
| POST | `/worker/progress/{job_id}?lease=` | Bearer; `{stage,frac,msg}`; extends the lease; 409 if the job is not running under that lease token |
| POST | `/worker/result/{job_id}` | Bearer; raw npz bytes (≤5 MB); validated, claimed, then persisted → `200 {ok,id,entry}` |
| POST | `/worker/fail/{job_id}?lease=` | Bearer; `{message}` → requeued (attempts < 2) or error; 409 for a stale lease token. The message is logged; the public job error is only `generation failed (<ExceptionClass>)` |

Status codes: 422 means invalid input (pydantic bounds, `canonicalize` errors, malformed ids). 413 means a body over 8 KB (over 5 MB for worker results). 429 with `Retry-After` means a rate limit was hit: POST /sightlines allows 12/hour with a burst of 4, POST /figure 60/hour with a burst of 10. 503 with `Retry-After` means the queue cap (30) was reached, no worker can run jobs on this node (local worker not starting/warm and no remote worker seen for 60 s), or the figure renderer already has 3 renders pending. Figures also share a global budget of 600/hour (burst 30). Event streams are capped at 16 per job and 20 per client (429). Public error fields never carry exception text (it can name server paths): they say e.g. `dataset unavailable (FileNotFoundError)`; the full text is in the server log. Only requests that create a *new* job are rate-limited; cache hits and in-flight dedupes are free.

Ids must match `^(face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?$` before any filesystem access. Paths are always built from validated ids, never from raw user strings.

## Protocol

```
 browser (GitHub Pages)                 coordinator (server.app, 1 process)               workers
 ──────────────────────                 ───────────────────────────────────               ───────
 POST /api/sightlines ───────────────▶  canonicalize → id
                                        ├─ id in catalog?  ──▶ 200 ready + entry
                                        └─ else JobQueue.submit (dedupe by id)
 ◀──────────── 202 {job_id, position}   │   FIFO queue  [job][job][job]
 GET /api/jobs/{id}/events (SSE) ────▶  │        │
 ◀── event: queued {position}           │        ├──── lease (internal) ─────────▶ LocalWorker (asyncio task)
                                        │        │                                  └─ spawn ProcessPool(1)
                                        │        │                                     child: Generator.load() once (warm)
 ◀── event: progress {stage,frac,msg}   │◀── progress relay thread ◀─ Manager().Queue() ◀─ generate(geom, progress)
                                        │        │
                                        │        └──── POST /api/worker/lease ◀──── RemoteWorker (laptop, HTTPS pull,
                                        │              (long-poll ≤25 s)  ────────▶  no inbound port)
                                        │              200 {job_id, geom, lease_s}   Generator.generate()
 ◀── event: progress                    │◀──────────── POST /api/worker/progress     (also renews the lease; a
                                        │                                             heartbeat thread re-posts every 30 s)
                                        │◀──────────── POST /api/worker/result       npz bytes (save_npz)
                                        │  validate (no pickle, keys, shapes, λ grid, finite τ/logN, geom == job)
                                        │  LibraryStore.add_generated: generated/<id>.npz + .bin + catalog upsert
                                        │  └─ HFSync thread: create_commit → HF dataset generated/ (backoff, persisted queue)
 ◀── event: done {id, entry}            │
 GET /api/sightline/{id}.bin ────────▶  web binary
```

Lease rules:

- Whichever worker asks first gets the oldest queued job. The local worker only asks once it is warm.
- A lease lasts `lease_s` (120 s) and is renewed by each progress post. The reaper runs every second. When a lease expires, the job is requeued at the front of the queue. On the second expiry (`max_attempts=2`) it becomes `error`.
- An explicit `/worker/fail` follows the same rule: retry once, then error.
- A job running longer than 15 minutes is failed.
- The first *valid* result wins, even from a worker whose lease has already been reassigned. The npz is deterministic for a given id, so a late result is still correct. Later results get 409.
- Each lease carries a token (`lease` in the lease reply). Progress and fail must present the current token, so a worker whose lease expired and was reassigned gets 409 instead of renewing or failing the new holder's lease.
- A result is claimed before it is persisted: while it is being saved, no other result, failure or expiry can finish the job, and a second result gets 409 without touching disk or the dataset.
- Queued jobs error after 2 hours, and immediately once no worker has been available for 90 s.
- Finished jobs are forgotten after 1 hour.

Persistence: the HF Space disk is ephemeral. With `HF_TOKEN` + `HF_DATASET` set, generated files are mirrored to the dataset, one commit per batch (a sightline's npz + bin go together). Failed uploads stay in a pending manifest and are retried indefinitely (backoff capped at 5 min); a 401/403 disables uploading and shows `hf.disabled` in `/api/health`. On startup, `snapshot_download` restores the library. `LibraryStore.reconcile()` then re-registers any `generated/*.npz` that `catalog.json` lacks, and `HFSync.sync_missing()` queues any local `generated/*` file the dataset lacks.

## Remote worker

```bash
cd /Volumes/cgm_work/run && PYTHONPATH=/path/to/repo WORKER_TOKEN=... \
  /Volumes/cgm_work/envs/trident/bin/python -m server.remote_worker \
  --coordinator https://<user>-<space>.hf.space --name laptop
```

The worker loads the dataset once, then loops: lease, generate, upload. Transport errors and 5xx responses are retried with exponential backoff (capped at 60 s). A 401, a redirect, or a 400/403/404/405/422 from `/api/worker/lease` stops the worker (wrong token, wrong `--coordinator` URL, or an invalid `--name`; names must match `^[A-Za-z0-9._-]{1,64}$`). The result upload has its own 600 s timeout; a 409 on it counts as success when the job is in fact done with this sightline.

## Tests

```bash
/Volumes/cgm_work/envs/trident/bin/python -m pytest tests/test_server.py
```

The tests use `server.testing.FakeGenerator` (no yt) and the thread executor. `test_local_worker_spawn_process` exercises the real spawn + Manager-queue path.
