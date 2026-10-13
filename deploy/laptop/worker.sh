#!/usr/bin/env bash
# Pull-worker: lease jobs from the HF Space over HTTPS, compute them here, upload the npz.
# No inbound port or tunnel. Token from $WORKER_TOKEN, else the macOS keychain item
# "tng50-worker-token" (store it once with:
#   security add-generic-password -a "$USER" -s tng50-worker-token -w '<token>' -U).
#   deploy/laptop/worker.sh [https://<user>-<space>.hf.space] [extra remote_worker args...]
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
WORK=${CGM_WORK:-/Volumes/cgm_work}
PY=${PY:-$WORK/envs/trident/bin/python}
RUN=${TNG_RUN_DIR:-$WORK/run}
COORD=${1:-${TNG_SPACE_URL:-https://tanmay-starslab-tng50-sightlines.hf.space}}
[[ $# -gt 0 ]] && shift

if ! mount | grep -q " on $WORK "; then echo "$WORK is not mounted"; exit 1; fi
if [[ -z "${WORKER_TOKEN:-}" ]]; then
  WORKER_TOKEN=$(security find-generic-password -s tng50-worker-token -w 2>/dev/null || true)
fi
[[ -n "$WORKER_TOKEN" ]] || { echo "no WORKER_TOKEN (env or keychain item tng50-worker-token)"; exit 1; }
export WORKER_TOKEN

export MPLCONFIGDIR=$WORK/cache/mpl XDG_CACHE_HOME=$WORK/cache/xdg HDF5_USE_FILE_LOCKING=FALSE \
       PYTHONDONTWRITEBYTECODE=1 MPLBACKEND=Agg
export TNG_CUTOUT=${TNG_CUTOUT:-$WORK/data/cutout_slim_R400_sub488530.hdf5}
export TNG_ION_TABLE_DIR=${TNG_ION_TABLE_DIR:-$WORK/data/trident}
export TNG_INDEX_FILE=${TNG_INDEX_FILE:-$WORK/data/library/cutout.ewah}
export TNG_WORKDIR=${TNG_WORKDIR:-$WORK/scratch/worker}
export NODE_NAME=${NODE_NAME:-laptop-$(hostname -s)}
export PYTHONPATH=$REPO${PYTHONPATH:+:$PYTHONPATH}
mkdir -p "$TNG_WORKDIR"
[[ -f "$TNG_CUTOUT" ]] || { echo "missing $TNG_CUTOUT"; exit 1; }

cd "$RUN"            # trident reads ./config.tri at import
CMD=("$PY" -m server.remote_worker --coordinator "$COORD" --name "$NODE_NAME" "$@")
if [[ "${TNG_START_DRYRUN:-0}" == 1 ]]; then echo "DRYRUN cwd=$PWD ${CMD[*]}"; exit 0; fi
exec "${CMD[@]}"           # token travels via $WORKER_TOKEN, never on the command line (ps-visible)
