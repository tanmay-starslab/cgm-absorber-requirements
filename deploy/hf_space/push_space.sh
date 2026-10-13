#!/usr/bin/env bash
# Assemble the Space build context and push it with huggingface_hub (upload_folder).
#   HF_TOKEN=hf_... deploy/hf_space/push_space.sh [space-id]     (default tanmay-starslab/tng50-sightlines)
#   deploy/hf_space/push_space.sh --assemble-only                 (build the context, no token, no push)
# Context: /Volumes/cgm_work/scratch/space_build (override with SPACE_BUILD). The context is scanned
# for secrets and cluster paths before anything is uploaded.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
PY=${PY:-/Volumes/cgm_work/envs/trident/bin/python}
BUILD=${SPACE_BUILD:-/Volumes/cgm_work/scratch/space_build}
ASSEMBLE_ONLY=0
if [[ "${1:-}" == --assemble-only ]]; then ASSEMBLE_ONLY=1; shift; fi
SPACE=${1:-${HF_SPACE:-tanmay-starslab/tng50-sightlines}}

rm -rf "$BUILD"; mkdir -p "$BUILD"
cp "$REPO/deploy/hf_space/Dockerfile" "$REPO/deploy/hf_space/README.md" "$REPO/deploy/hf_space/start.sh" \
   "$REPO/deploy/hf_space/trident_doppler_only.patch" "$REPO/requirements-tng.txt" "$REPO/THIRD_PARTY_LICENSES" "$BUILD/"
for d in tngsight server; do
  rsync -a --exclude '__pycache__' --exclude '*.pyc' --exclude '.*' "$REPO/$d/" "$BUILD/$d/"
done
chmod +x "$BUILD/start.sh"

# Refuse to ship secrets, cluster paths or data. (git-tracked? irrelevant: we copy explicit paths.)
bad=$(cd "$BUILD" && { find . \( -name 'yt.toml' -o -name '*.tri' -o -name '.env' -o -name '*.h5' -o -name '*.hdf5' \
        -o -name '*.npz' -o -name '*.ewah' \) -print; \
      grep -rIlE '/data/sborthak|/home/tsingh65|/scratch/tsingh65|hf_[A-Za-z0-9]{30,}|api_key' . || true; } )
if [[ -n "$bad" ]]; then echo "refusing to push; offending files:"; echo "$bad"; exit 1; fi
echo "context $BUILD: $(find "$BUILD" -type f | wc -l | tr -d ' ') files, $(du -sh "$BUILD" | cut -f1)"
[[ $ASSEMBLE_ONLY == 1 ]] && exit 0

: "${HF_TOKEN:?set HF_TOKEN (write access to the Space)}"
"$PY" - "$SPACE" "$BUILD" <<'PY'
import os, sys
from huggingface_hub import HfApi
space, build = sys.argv[1:3]
api = HfApi(token=os.environ["HF_TOKEN"])
api.create_repo(space, repo_type="space", space_sdk="docker", exist_ok=True)
api.upload_folder(folder_path=build, repo_id=space, repo_type="space", path_in_repo="",
                  delete_patterns=["tngsight/**", "server/**"], commit_message="Deploy TNG50 explorer backend")
print(f"pushed -> https://huggingface.co/spaces/{space}  (set HF_TOKEN and WORKER_TOKEN secrets there)")
PY
