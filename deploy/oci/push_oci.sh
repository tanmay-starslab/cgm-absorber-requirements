#!/usr/bin/env bash
# Build the app context (same as the HF Space), copy it to the VM and (re)start the stack.
#   deploy/oci/push_oci.sh <public-ip> [ssh-key]
# First run also needs the VM's ~/tng50/.env (written from the local token files, never printed).
set -euo pipefail
IP=${1:?public ip}; KEY=${2:-$HOME/.ssh/tng50_oci}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BUILD=${SPACE_BUILD:-/Volumes/cgm_work/scratch/oci_build}
HFDIR=${HFDIR:-/Volumes/cgm_work/cache/hf}
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new ubuntu@"$IP")
SPACE_BUILD=$BUILD "$REPO/deploy/hf_space/push_space.sh" --assemble-only
cp "$REPO/deploy/oci/docker-compose.yml" "$REPO/deploy/oci/Caddyfile" "$BUILD/"
"${SSH[@]}" 'bash -s' < "$REPO/deploy/oci/vm_setup.sh"
rsync -az --delete --exclude .env -e "ssh -i $KEY" "$BUILD/" ubuntu@"$IP":tng50/
if ! "${SSH[@]}" test -f tng50/.env; then
  { printf 'HF_TOKEN=%s\n' "$(cat "$HFDIR/token")"; printf 'WORKER_TOKEN=%s\n' "$(cat "$HFDIR/worker_token")"
    printf 'HF_DATASET=tanmay-starslab/tng50-sub488530-cgm\n'
    printf 'CORS_ORIGINS=https://tanmay-starslab.github.io,http://127.0.0.1:8000,http://localhost:8000\n'; } \
    | "${SSH[@]}" 'umask 077; cat > tng50/.env'
fi
HOST="${IP//./-}.sslip.io"
"${SSH[@]}" "cd tng50 && HOST=$HOST sg docker -c 'docker compose up -d --build'"
echo "deployed -> https://$HOST/api/health"
