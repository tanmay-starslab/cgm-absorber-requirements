#!/usr/bin/env bash
# Local explorer backend on http://127.0.0.1:8787 (the page's first backend candidate).
#   deploy/laptop/serve.sh                     # library + on-demand generation (warm ~minutes on USB)
#   LOCAL_WORKER=0 deploy/laptop/serve.sh      # library only
#   WORKER_TOKEN=... deploy/laptop/serve.sh    # also accept remote pull-workers
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
WORK=${TNG_WORK:-${CGM_WORK:-/Volumes/cgm_work}}     # the work root (CGM_WORK: its older name)
PY=${PY:-${PYTHON:-$WORK/envs/trident/bin/python}}
RUN=${TNG_RUN_DIR:-$WORK/run}

# On the Mac the work volume is an APFS image on the LaCie: refuse to start (and write nowhere) if it is not
# mounted. Elsewhere (a Linux cluster) the work root is a plain directory that must exist.
if [[ $(uname -s) == Darwin && $WORK == /Volumes/* ]]; then
  if ! mount | grep -q " on $WORK "; then echo "$WORK is not mounted (attach the LaCie, open cgm_work.sparsebundle)"; exit 1; fi
elif [[ ! -d $WORK ]]; then echo "work root $WORK does not exist (set TNG_WORK)"; exit 1; fi
for f in "$PY" "$RUN/config.tri"; do [[ -e "$f" ]] || { echo "missing $f"; exit 1; }; done

export MPLCONFIGDIR=$WORK/cache/mpl XDG_CACHE_HOME=$WORK/cache/xdg HDF5_USE_FILE_LOCKING=FALSE \
       PYTHONDONTWRITEBYTECODE=1 PIP_CACHE_DIR=$WORK/cache/pip MPLBACKEND=Agg
export TNG_LIBRARY_DIR=${TNG_LIBRARY_DIR:-$WORK/data/library}
export TNG_CUTOUT=${TNG_CUTOUT:-$WORK/data/cutout_slim_R400_sub488530.hdf5}
export TNG_ION_TABLE_DIR=${TNG_ION_TABLE_DIR:-$WORK/data/trident}
export TNG_INDEX_FILE=${TNG_INDEX_FILE:-$TNG_LIBRARY_DIR/cutout.ewah}
export TNG_WORKDIR=${TNG_WORKDIR:-$WORK/scratch/server}
export TNG_FIGDIR=${TNG_FIGDIR:-$TNG_LIBRARY_DIR/figures}
export NODE_NAME=${NODE_NAME:-laptop} PORT=${PORT:-8787} TRUST_PROXY=${TRUST_PROXY:-0}
export PYTHONPATH=$REPO${PYTHONPATH:+:$PYTHONPATH}      # spawn children (LocalWorker) import tngsight/server
mkdir -p "$TNG_WORKDIR" "$MPLCONFIGDIR" "$XDG_CACHE_HOME"
[[ -f "$TNG_LIBRARY_DIR/catalog.json" ]] || echo "note: no catalog yet; run deploy/data/build_library.py"
if [[ ! -f "$TNG_CUTOUT" && -z "${LOCAL_WORKER:-}" ]]; then echo "cutout missing: LOCAL_WORKER=0"; export LOCAL_WORKER=0; fi

cd "$RUN"            # trident reads ./config.tri at import
CMD=("$PY" -m uvicorn server.app:app --app-dir "$REPO" --host 127.0.0.1 --port "$PORT" --workers 1)
if [[ "${TNG_START_DRYRUN:-0}" == 1 ]]; then
  echo "DRYRUN paths TNG_LIBRARY_DIR=$TNG_LIBRARY_DIR TNG_CUTOUT=$TNG_CUTOUT TNG_ION_TABLE_DIR=$TNG_ION_TABLE_DIR" \
       "TNG_INDEX_FILE=$TNG_INDEX_FILE TNG_WORKDIR=$TNG_WORKDIR TNG_FIGDIR=$TNG_FIGDIR"
  echo "DRYRUN cwd=$PWD ${CMD[*]}"; exit 0; fi
exec "${CMD[@]}"
