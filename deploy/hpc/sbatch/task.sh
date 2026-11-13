#!/bin/bash
# Body shared by the per-stage sbatch templates: one array task = one galaxy (line SLURM_ARRAY_TASK_ID of GP_LIST)
# and one galpipe stage (and shard). Sourced by <stage>.sbatch; deploy/hpc/launch.py sets the GP_* variables:
#   GP_STAGE   galpipe stage (record|slim|rays|fits|cubes|web|check)
#   GP_LIST    galaxy list file, one id per line; line i+1 is array task i
#   GP_ROOT    data root (<root>/<id>/ per galaxy)          GP_REPO   repository checkout to run from
#   GP_SHARD   "i/n" for a rays shard, else empty           GP_WORKERS  --workers value, or empty
#   GP_FORCE   1 to pass --force                            GP_LABEL  log name (stage[.s<i>of<n>])
#   GP_ENV     optional script to source first (venv, paths) GP_PYTHON  python executable (default python)
#   GP_SPECTRA sbi|trident: the spectra source the launcher planned this galaxy for (passed as --spectra)
#   GP_POST    optional second galpipe stage run afterwards with the same arguments (rays shards: fits), non-fatal
set -uo pipefail

: "${GP_STAGE:?}" "${GP_LIST:?}" "${GP_ROOT:?}" "${GP_REPO:?}"
TASK=${SLURM_ARRAY_TASK_ID:?not an array task}
GAL=$(sed -n "$((TASK + 1))p" "$GP_LIST" | tr -d '[:space:]')
if [ -z "$GAL" ]; then
    echo "no galaxy on line $((TASK + 1)) of $GP_LIST" >&2
    exit 3
fi

# GP_REQUIRE: colon list of stages whose DONE markers must exist (deploy/hpc/drive.py); a task never runs on
# missing inputs, it exits 7 and the driver grades it as a failed attempt
if [ -n "${GP_REQUIRE:-}" ]; then
    IFS=: read -r -a REQ <<< "$GP_REQUIRE"
    for r in "${REQ[@]}"; do
        if [ ! -f "$GP_ROOT/$GAL/DONE.$r" ]; then
            mkdir -p "$GP_ROOT/$GAL/logs"
            echo "=== $(date -Is) skip ${GP_LABEL:-$GP_STAGE}: prerequisite DONE.$r missing" >> "$GP_ROOT/$GAL/logs/${GP_LABEL:-$GP_STAGE}.log"
            echo "galaxy $GAL stage ${GP_LABEL:-$GP_STAGE} skipped: DONE.$r missing" >&2
            exit 7
        fi
    done
fi

if [ -n "${GP_ENV:-}" ]; then
    set +u                       # env scripts may read unset variables
    # shellcheck disable=SC1090
    source "$GP_ENV" || { echo "sourcing $GP_ENV failed" >&2; exit 5; }
    set -u
fi
# Single-galaxy defaults of an interactive env must not leak into a per-galaxy task (galpipe derives every path
# from --galaxy/--root), and a shared heavy-I/O lock would serialise all array tasks across nodes.
unset TNG_CUTOUT TNG_LIBRARY_DIR TNG_VIZ TNG_INDEX_FILE TNG_HEAVY_LOCK
NCPU=${SLURM_CPUS_PER_TASK:-1}
export OMP_NUM_THREADS=$NCPU OPENBLAS_NUM_THREADS=$NCPU MKL_NUM_THREADS=$NCPU NUMEXPR_MAX_THREADS=$NCPU
export HDF5_USE_FILE_LOCKING=FALSE PYTHONDONTWRITEBYTECODE=1
# node-local temp for yt/matplotlib scratch when the node has it
if [ -n "${SLURM_TMPDIR:-}" ] && [ -d "${SLURM_TMPDIR}" ]; then export TMPDIR=$SLURM_TMPDIR; fi

LOGDIR="$GP_ROOT/$GAL/logs"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/${GP_LABEL:-$GP_STAGE}.log"

ARGS=("$GP_STAGE" --galaxy "$GAL" --root "$GP_ROOT")
[ -n "${GP_SHARD:-}" ] && ARGS+=(--shard "$GP_SHARD")
[ -n "${GP_WORKERS:-}" ] && ARGS+=(--workers "$GP_WORKERS")
[ "${GP_FORCE:-}" = "1" ] && ARGS+=(--force)
[ -n "${GP_SPECTRA:-}" ] && ARGS+=(--spectra "$GP_SPECTRA")

cd "$GP_REPO" || exit 4
{
    echo "=== $(date -Is) job ${SLURM_ARRAY_JOB_ID:-?}_${TASK} host $(hostname) cpus $NCPU mem ${SLURM_MEM_PER_NODE:-?}M"
    echo "=== ${GP_PYTHON:-python} -m tngsight.galpipe ${ARGS[*]}"
} >> "$LOG"
T0=$(date +%s)
"${GP_PYTHON:-python}" -m tngsight.galpipe "${ARGS[@]}" >> "$LOG" 2>&1
RC=$?
echo "=== $(date -Is) exit $RC after $(( $(date +%s) - T0 )) s" >> "$LOG"
# optional post step on the same shard (rays shards: `fits --shard i/n`); non-fatal, because the stage it belongs to
# (fits) refits whatever is left, so a failed post step must not kill the downstream dependency chain
if [ "$RC" = "0" ] && [ -n "${GP_POST:-}" ]; then
    PARGS=("$GP_POST" "${ARGS[@]:1}")
    echo "=== post: ${GP_PYTHON:-python} -m tngsight.galpipe ${PARGS[*]}" >> "$LOG"
    T1=$(date +%s)
    "${GP_PYTHON:-python}" -m tngsight.galpipe "${PARGS[@]}" >> "$LOG" 2>&1
    PRC=$?
    echo "=== $(date -Is) post $GP_POST exit $PRC after $(( $(date +%s) - T1 )) s (non-fatal)" >> "$LOG"
fi
echo "galaxy $GAL stage ${GP_LABEL:-$GP_STAGE} exit $RC log $LOG"
exit $RC
