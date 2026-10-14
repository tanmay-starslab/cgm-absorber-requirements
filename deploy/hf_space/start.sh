#!/usr/bin/env bash
# Space entrypoint: fetch the private dataset, pin the cutout mtime, write config.tri, exec uvicorn.
# Secrets (Space settings): HF_TOKEN (read access to HF_DATASET; write access enables HFSync of
# generated sightlines), WORKER_TOKEN (enables /api/worker/* for the laptop pull-worker).
# TNG_START_DRYRUN=1 prints the final command instead of exec'ing it (used by deploy/tests).
set -euo pipefail

APP_DIR=${APP_DIR:-$(cd "$(dirname "$0")" && pwd)}
if [[ -z "${DATA_DIR:-}" ]]; then
  if [[ -d /data && -w /data ]]; then DATA_DIR=/data; else DATA_DIR=$HOME/data; fi   # /data = persistent storage
fi
export DATA_DIR; mkdir -p "$DATA_DIR"
CUTOUT_NAME=cutout_slim_R400_sub488530.hdf5
CUTOUT_EPOCH=${CUTOUT_EPOCH:-1700000000}     # fixed mtime: yt's index hash includes it (critic.md §1.4)

export HF_DATASET=${HF_DATASET:-tanmay-starslab/tng50-sub488530-cgm}
export TNG_LIBRARY_DIR=$DATA_DIR             # dataset root == library root (server HFSync layout)
export TNG_CUTOUT=$DATA_DIR/$CUTOUT_NAME
export TNG_ION_TABLE_DIR=$DATA_DIR/trident
export TNG_INDEX_FILE=${TNG_INDEX_FILE:-$DATA_DIR/cutout.ewah}
export TNG_WORKDIR=${TNG_WORKDIR:-$HOME/tmp}
export TNG_FIGDIR=${TNG_FIGDIR:-$HOME/tmp/figures}
# the Space's proxy appends the real client to X-Forwarded-For: use the rightmost TRUSTED_HOPS-th entry
export TRUST_PROXY=${TRUST_PROXY:-1} TRUSTED_HOPS=${TRUSTED_HOPS:-1} NODE_NAME=${NODE_NAME:-hf-space} PORT=${PORT:-7860}
export HDF5_USE_FILE_LOCKING=FALSE PYTHONDONTWRITEBYTECODE=1 MPLBACKEND=Agg
mkdir -p "$TNG_WORKDIR" "$TNG_FIGDIR"

if [[ -n "${HF_TOKEN:-}" && "${SKIP_DOWNLOAD:-0}" != 1 ]]; then
  # exit 0 = synced (the app then skips its own startup snapshot), 3 = token/repo problem (not
  # retried: retrying cannot fix it), 1 = network/5xx retries exhausted (the app tries again).
  rc=0
  python - <<'PY' || rc=$?
import os, sys, time
from huggingface_hub import snapshot_download
repo, d = os.environ["HF_DATASET"], os.environ["DATA_DIR"]
FATAL = ("RepositoryNotFoundError", "GatedRepoError", "RevisionNotFoundError", "LocalTokenNotFoundError")
for i in range(6):
    try:
        t = time.time()
        snapshot_download(repo_id=repo, repo_type="dataset", local_dir=d, token=os.environ["HF_TOKEN"],
                          max_workers=8)
        print(f"[start] dataset {repo} -> {d} in {time.time() - t:.0f}s", flush=True); sys.exit(0)
    except Exception as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        if e.__class__.__name__ in FATAL or code in (401, 403, 404):
            print(f"[start] dataset {repo} not readable with HF_TOKEN ({e.__class__.__name__}, HTTP {code}): "
                  "check the HF_TOKEN secret and HF_DATASET; not retrying", flush=True)
            sys.exit(3)
        print(f"[start] snapshot_download failed ({i + 1}/6): {e.__class__.__name__}", flush=True)
        time.sleep(min(5 * 2 ** i, 120))
sys.exit(1)
PY
  if [[ $rc == 0 || $rc == 3 ]]; then export HF_STARTUP_DOWNLOAD=${HF_STARTUP_DOWNLOAD:-0}; fi
else
  echo "[start] HF_TOKEN unset or SKIP_DOWNLOAD=1: using whatever is already in $DATA_DIR"
fi

if [[ -f "$TNG_CUTOUT" && -f "$TNG_ION_TABLE_DIR/hm2012_ss_hr.h5" ]]; then
  python -c "import os,sys; os.utime(sys.argv[1], (int(sys.argv[2]),) * 2)" "$TNG_CUTOUT" "$CUTOUT_EPOCH"
  export LOCAL_WORKER=${LOCAL_WORKER:-1}
else
  echo "[start] cutout or ion table missing in $DATA_DIR: library-only mode (LOCAL_WORKER=0)"
  export LOCAL_WORKER=0
fi

# trident reads ./config.tri from the cwd at import; never let it fall back to input() prompts.
cd "$APP_DIR"
printf '[Trident]\nion_table_dir = %s\nion_table_file = hm2012_ss_hr.h5\n' "$TNG_ION_TABLE_DIR" > config.tri

CMD=(python -m uvicorn server.app:app --host 0.0.0.0 --port "$PORT" --workers 1)
if [[ "${TNG_START_DRYRUN:-0}" == 1 ]]; then
  echo "[start] DRYRUN cwd=$PWD LOCAL_WORKER=$LOCAL_WORKER TNG_LIBRARY_DIR=$TNG_LIBRARY_DIR ${CMD[*]}"
  exit 0
fi
exec "${CMD[@]}"
