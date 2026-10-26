# server/: on-demand sightline API

This is a FastAPI coordinator for the TNG50 sightline explorer. It serves the sightline library (catalog, web binaries, raw npz files) and generates new geometries on demand through a job queue. Progress reaches the browser over SSE. Remote machines can do the compute through a pull-based lease protocol.

The same code runs in two places:

- on the backend (the `deploy/hf_space` image, on an Oracle Cloud VM or as a Hugging Face Space), as **coordinator + fallback compute**;
- on a laptop or a cluster node, for local use, or as a **remote worker** that pulls jobs from the backend.

## Run locally

```bash
# $TNG_WORK: the work root (env, data, caches, scratch); $PY: its python with the patched trident
# (docs/TNG50_OPERATIONS.md, sections 1 and 6)
export MPLCONFIGDIR=$TNG_WORK/cache/mpl XDG_CACHE_HOME=$TNG_WORK/cache/xdg \
       HDF5_USE_FILE_LOCKING=FALSE PYTHONDONTWRITEBYTECODE=1
cd $TNG_WORK/run                    # contains config.tri (trident reads ./config.tri at import)
PYTHONPATH=/path/to/cgm-absorber-requirements \
TNG_LIBRARY_DIR=$TNG_WORK/data/library_v3 TNG_WORKDIR=$TNG_WORK/scratch/server \
  $PY -m uvicorn server.app:app --host 127.0.0.1 --port 8787 --workers 1
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
| `TNG_WORK` | the owner's work volume | work root; every default path below derives from it (`tngsight.config.work_root()`) |
| `TNG_LIBRARY_DIR` | `$TNG_WORK/data/library` | library root (`catalog.json`, `sightlines/`, `web/`, `generated/`) |
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
| `ANTHROPIC_API_KEY` | unset | enables the Claude chat proxy `POST /api/chat` (server/chat.py); never logged |
| `CHAT_CLAUDE` | `1` | `0` disables the proxy while the key stays set |
| `CHAT_DAILY_BUDGET` | `500` | upstream chat requests per UTC day, all clients together |
| `CHAT_CLIENT_DAILY_BUDGET` | `50` | upstream chat requests per UTC day for one client (IPv4 address / IPv6 /64) |
| `CHAT_DAILY_TOKENS` | `4000000` | upstream input + output tokens per UTC day, all clients (`0` = no token budget) |
| `TNG_SPEC_MIN_TAU` | `1e-8` | Trident `min_tau` for new spectra; tests only (the v1 library was made with 1e-3, which drops part of the column of weak, diffuse absorbers) |

## Endpoints (prefix `/api`)

| method | path | result |
|---|---|---|
| GET | `/health` | status, version, `warm`, local/remote workers, queue counts, library/generated sizes, node, `registry_tag`, `data_version` (2), `ions` (the registry keys) |
| GET | `/catalog` | catalog.json (library + generated), `ETag`, `Cache-Control: max-age=60`, 304 on `If-None-Match` |
| GET | `/sightline/{id}.bin` | TNGS v2 web binary (octet-stream; a v1 npz gives its 2 lines, a cached v1 `.bin` is re-encoded once); `{id}.npz` = raw npz download (v1 or v2); 404 if unknown, 422 for a malformed id |
| GET | `/components` | `{version: 2, fitter, params_tag, comp_keys, entries: {id: {ion: rows}}, aod: {id: {ion: [logN, regions]}}}` of the generated sightlines, `ETag` |
| GET | `/components/{id}.json` | the per-sightline v2 doc `{version, id, fitter, params_tag, comp_keys, components, aod}`; 404 when none is stored |
| POST | `/geometry` | `{orientation,b_kpc,azimuth_deg,seed}` → canonical values + `make_sightline` geometry + `exists` |
| POST | `/sightlines` | same body → `200 {id,status:"ready",entry}` or `202 {id,job_id,status:"queued",position}` |
| GET | `/jobs/{job_id}` | `{job_id,id,status,stage,frac,msg,position,error,entry,attempts}` |
| GET | `/jobs/{job_id}/events` | SSE: `queued`, `progress`, `done`, `error`; `: ping` comment every 15 s; closes after done/error |
| POST | `/figure` | `{id,ions,R,sn,vhw,vc,intrinsic,seed,layout,fmt}` → PNG/PDF attachment (LRU cache of 64). `ions`: 1–6 registry keys present in the sightline (default: the registry defaults it has); `R`: `{band: [lo, hi]}` inside each band's range (default the band `pair`); `sn`: `[hi, lo]`, integers 2–100; `vhw` 10–10000 km/s and `vc` ±10000 km/s (the damped H I window, registry `grid.damped_v_max_kms`; the renderer clamps the window to the shown lines' coverage); `layout`: `1`, `2R`, `2SN` or `4` (default the 2×2 grid); `seed` 0–99999. `/health` announces the caps under `figure`. The v2 fields `R_lo`, `R_hi` (uv band), `sn_hi`, `sn_lo` and `vwin` (= `vhw`) are still accepted for one release |
| POST | `/worker/lease` | Bearer; `{name, caps}`; long-poll ≤25 s (`?wait=` lowers it) → `200 {job_id,geom,lease_s,attempt,lease,registry_tag}` / `204`; a worker with another registry fails the job before computing |
| POST | `/worker/progress/{job_id}?lease=` | Bearer; `{stage,frac,msg}`; extends the lease; 409 if the job is not running under that lease token |
| POST | `/worker/result/{job_id}` | Bearer; raw npz v2 bytes (≤5 MB; all 12 registry lines on their native grids, window W = `ions.gen_window`, finite τ ≥ 0, `generation.registry_tag` = the server's, optional `components_json` = `{ion: rows, "aod": ...}`); validated, claimed, then persisted → `200 {ok,id,entry}`. 422 `worker result is npz v1; update the worker` and `registry mismatch (worker <tag>, server <tag>)` name the two version errors |
| POST | `/worker/fail/{job_id}?lease=` | Bearer; `{message}` → requeued (attempts < 2) or error; 409 for a stale lease token. The message is logged; the public job error is only `generation failed (<ExceptionClass>)` |

Status codes: 422 means invalid input (pydantic bounds, `canonicalize` errors, malformed ids). 413 means a body over 8 KB (over 5 MB for worker results). 429 with `Retry-After` means a rate limit was hit: POST /sightlines allows 12/hour with a burst of 4, POST /figure 60/hour with a burst of 10. 503 with `Retry-After` means the queue cap (30) was reached, no worker can run jobs on this node (local worker not starting/warm and no remote worker seen for 60 s), or the figure renderer already has 3 renders pending. Figures also share a global budget of 600/hour (burst 30). Event streams are capped at 16 per job and 20 per client (429). Public error fields never carry exception text (it can name server paths): they say e.g. `dataset unavailable (FileNotFoundError)`; the full text is in the server log. Only requests that create a *new* job are rate-limited; cache hits and in-flight dedupes are free.

Ids must match `^((face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?|cust_[0-9a-f]{10})$` before any filesystem access. Paths are always built from validated ids, never from raw user strings.

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
                                        │  validate (no pickle, npz v2 members, registry tag, native grids, W, finite τ, geom == job)
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
cd $TNG_WORK/run && PYTHONPATH=/path/to/repo WORKER_TOKEN=... \
  $PY -m server.remote_worker --coordinator <backend URL> --name laptop
```

The worker loads the dataset once, then loops: lease, generate, upload. Transport errors and 5xx responses are retried with exponential backoff (capped at 60 s). A 401, a redirect, or a 400/403/404/405/422 from `/api/worker/lease` stops the worker (wrong token, wrong `--coordinator` URL, or an invalid `--name`; names must match `^[A-Za-z0-9._-]{1,64}$`). The result upload has its own 600 s timeout; a 409 on it counts as success when the job is in fact done with this sightline.

## Tests

```bash
$PY -m pytest tests/test_server.py
```

The tests use `server.testing.FakeGenerator` (no yt) and the thread executor. `test_local_worker_spawn_process` exercises the real spawn + Manager-queue path. The HFSync tests poll their conditions with a 120 s ceiling (`TNG_TEST_HF_WAIT`) and gate the fake commits where the order matters, so a loaded machine slows them down instead of failing them.

## Registry-derived chat files

`server/chat_tools.json`, `server/chat_system_prompt.txt` and the marked blocks of `docs/tng50/js/chat.js`
(`/*__GEN:TOOLS__*/`, `/*__GEN:PROMPT__*/`, `/*__GEN:IONS__*/`) and `docs/tng50/js/search.js`
(`/*__GEN:QUERY__*/`) are generated from `tngsight/ions.json` and `tngsight.search.QUERY_SCHEMA`:

```bash
$PY -m server.make_chat_tools           # rewrite after a registry edit
$PY -m server.make_chat_tools --check   # exit 1 when stale
PYTHON=$PY node tests/js/chat_tools_sync.mjs
```
