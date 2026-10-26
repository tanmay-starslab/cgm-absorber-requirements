#!/usr/bin/env bash
# Build the app context (same as the HF Space), copy it to the VM and (re)start the stack.
#   deploy/oci/push_oci.sh <public-ip> [ssh-key]          (key default ~/.ssh/tng50_oci)
#   deploy/oci/push_oci.sh --assemble-only                (build the context only: no ssh, no VM, no token read)
# Paths: TNG_WORK is the work root (default /Volumes/cgm_work); the context goes to $SPACE_BUILD, else
# $TNG_WORK/scratch/oci_build, and the token files are read from $HFDIR, else $TNG_WORK/cache/hf.
# The VM's ~/tng50/.env is written once, from the local token files (never printed); later edits are
# made on the VM. HOST=<ip-dashes>.sslip.io is (re)written into it on every run.
set -euo pipefail
ASSEMBLE_ONLY=0
if [[ "${1:-}" == --assemble-only ]]; then ASSEMBLE_ONLY=1; shift; fi
if [[ $ASSEMBLE_ONLY == 0 ]]; then IP=${1:?public ip}; KEY=${2:-$HOME/.ssh/tng50_oci}; fi
REPO=$(cd "$(dirname "$0")/../.." && pwd)
WORK=${TNG_WORK:-/Volumes/cgm_work}
BUILD=${SPACE_BUILD:-$WORK/scratch/oci_build}
HFDIR=${HFDIR:-$WORK/cache/hf}

SPACE_BUILD=$BUILD "$REPO/deploy/hf_space/push_space.sh" --assemble-only
cp "$REPO/deploy/oci/docker-compose.yml" "$REPO/deploy/oci/Caddyfile" "$BUILD/"
printf '.env\n' > "$BUILD/.dockerignore"       # keep the secrets out of the BuildKit build context
if [[ $ASSEMBLE_ONLY == 1 ]]; then echo "assembled $BUILD (no VM contacted)"; exit 0; fi

HOST="${IP//./-}.sslip.io"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new)
SSH=(ssh "${SSH_OPTS[@]}" ubuntu@"$IP")
"${SSH[@]}" 'bash -s' < "$REPO/deploy/oci/vm_setup.sh"
rsync -az --delete --exclude .env -e "ssh -i '$KEY' -o StrictHostKeyChecking=accept-new" \
  "$BUILD/" ubuntu@"$IP":tng50/
if ! "${SSH[@]}" test -f tng50/.env; then
  { printf 'HF_TOKEN=%s\n' "$(cat "$HFDIR/token")"; printf 'WORKER_TOKEN=%s\n' "$(cat "$HFDIR/worker_token")"
    printf 'HF_DATASET=tanmay-starslab/tng50-sub488530-cgm\n'
    printf 'CORS_ORIGINS=https://tanmay-starslab.github.io,http://127.0.0.1:8000,http://localhost:8000\n'; } \
    | "${SSH[@]}" 'umask 077; cat > tng50/.env'
fi
# HOST lives in .env so every later `docker compose ...` on the VM interpolates it (sed -i keeps mode 600)
"${SSH[@]}" "sed -i '/^HOST=/d' tng50/.env && echo 'HOST=$HOST' >> tng50/.env"
# sg: the docker group from vm_setup's usermod may not be active in a multiplexed ssh session
"${SSH[@]}" "cd tng50 && sg docker -c 'docker compose up -d --build'"
echo "deployed -> https://$HOST/api/health  (first start downloads the dataset; allow a few minutes)"
