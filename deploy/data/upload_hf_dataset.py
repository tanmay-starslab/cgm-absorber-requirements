#!/usr/bin/env python3
"""Create/update the PRIVATE Hugging Face dataset that the Space downloads at start.

    HF_TOKEN=hf_... python deploy/data/upload_hf_dataset.py [--repo tanmay-starslab/tng50-sub488530-cgm] [--dry-run]

Dataset layout (repo root == the server's library dir, so the server's HFSync snapshot_download and
its `generated/<id>.npz` uploads land in the same tree):
  cutout_slim_R400_sub488530.hdf5   slim cutout (r - hsml < 400 kpc)
  trident/hm2012_ss_hr.h5           slim ion table (H, C, O)
  catalog.json                      library catalog
  sightlines/<id>.npz, web/<id>.bin library files
  generated/<id>.{npz,bin}          written by the Space (HFSync); only uploaded here with --generated
Never uploads yt.toml, config.tri, *.ewah indexes or anything outside the explicit list.
"""
from __future__ import annotations
import argparse
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))
from tngsight.config import cutout_path, library_dir  # noqa: E402

REPO = "tanmay-starslab/tng50-sub488530-cgm"
ION_TABLE = Path("/Volumes/cgm_work/data/trident_slim/hm2012_ss_hr.h5")
ID = r"(face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?"
LIB_RE = re.compile(rf"^(catalog\.json|sightlines/{ID}\.npz|web/{ID}\.bin)$")
GEN_RE = re.compile(rf"^generated/{ID}\.(npz|bin)$")
FORBIDDEN = re.compile(r"(^|/)(yt\.toml|config\.tri|\.env)$|\.ewah$|/\.|^\.")


def plan(cutout: Path, ion_table: Path, lib: Path, generated=False) -> list[tuple[Path, str]]:
    """[(local file, path_in_repo)] — an explicit allow-list, validated against FORBIDDEN."""
    items = [(cutout, cutout.name), (ion_table, f"trident/{ion_table.name}")]
    pats = [LIB_RE] + ([GEN_RE] if generated else [])
    for p in sorted(lib.rglob("*")):
        rel = p.relative_to(lib).as_posix()
        if p.is_file() and any(q.match(rel) for q in pats):
            items.append((p, rel))
    for p, rel in items:
        if FORBIDDEN.search(rel) or not p.is_file():
            raise ValueError(f"refusing to upload {rel} ({p})")
    return items


def upload(repo, items, token, message, api=None, chunk=500):
    """create_repo(private) → force private → the two data files, then the library in commits of
    `chunk` files (exact CommitOperationAdd list: nothing outside `items` can be swept in)."""
    from huggingface_hub import CommitOperationAdd
    if api is None:
        from huggingface_hub import HfApi
        api = HfApi(token=token)
    api.create_repo(repo, repo_type="dataset", private=True, exist_ok=True)
    if not getattr(api.repo_info(repo, repo_type="dataset"), "private", True):
        api.update_repo_settings(repo, private=True, repo_type="dataset")
    for p, r in items[:2]:
        print(f"upload {r} ({p.stat().st_size / 1e6:.1f} MB)", flush=True)
        api.upload_file(path_or_fileobj=str(p), path_in_repo=r, repo_id=repo, repo_type="dataset",
                        commit_message=f"{message}: {r}")
    rest = items[2:]
    for i in range(0, len(rest), chunk):
        ops = [CommitOperationAdd(path_in_repo=r, path_or_fileobj=str(p)) for p, r in rest[i:i + chunk]]
        print(f"commit library files {i + 1}-{i + len(ops)} of {len(rest)}", flush=True)
        api.create_commit(repo, ops, repo_type="dataset",
                          commit_message=f"{message}: library {i + 1}-{i + len(ops)}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", default=os.environ.get("HF_DATASET", REPO), help="dataset repo id")
    ap.add_argument("--cutout", type=Path, default=None, help="default tngsight cutout_path()")
    ap.add_argument("--ion-table", type=Path, default=ION_TABLE, help="SLIM table (slim_iontable.py)")
    ap.add_argument("--library", type=Path, default=None, help="default tngsight library_dir()")
    ap.add_argument("--generated", action="store_true", help="also upload <library>/generated/*")
    ap.add_argument("--allow-full-table", action="store_true", help="permit an ion table > 200 MB")
    ap.add_argument("--message", default="Update TNG50 sub-488530 data")
    ap.add_argument("--dry-run", action="store_true", help="print the plan; no token needed")
    a = ap.parse_args(argv)
    lib = a.library or library_dir()
    items = plan(a.cutout or cutout_path(), a.ion_table, lib, a.generated)
    if a.ion_table.stat().st_size > 200e6 and not a.allow_full_table:
        ap.error(f"{a.ion_table} is {a.ion_table.stat().st_size / 1e9:.2f} GB: pass the slim table")
    if not (lib / "catalog.json").is_file():
        ap.error(f"{lib}/catalog.json missing: run deploy/data/build_library.py first")
    n = {k: sum(1 for _, r in items if r.startswith(k)) for k in ("sightlines/", "web/", "generated/")}
    tot = sum(p.stat().st_size for p, _ in items)
    print(f"dataset {a.repo} (private): {len(items)} files, {tot / 1e6:.1f} MB "
          f"[{n['sightlines/']} npz, {n['web/']} bin, {n['generated/']} generated]")
    for p, r in items[:2] + [it for it in items if it[1] == "catalog.json"]:
        print(f"  {r:40s} <- {p} ({p.stat().st_size / 1e6:.2f} MB)")
    if a.dry_run:
        return 0
    token = os.environ.get("HF_TOKEN")
    if not token:
        ap.error("HF_TOKEN is not set (needs write access to the dataset)")
    upload(a.repo, items, token, a.message)
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
