#!/usr/bin/env python3
"""Submit the galaxy-sample pipeline (tngsight.galpipe) to SLURM as dependent job arrays.

    python deploy/hpc/launch.py --root DATA_ROOT (--catalog HOSTCAT.hdf5 | --galaxies 488530,...)
           [--cutouts DIR] [--exclude IDS] [--limit N] [--shards 8] [--stages record,...,check]
           [--redo STAGE,...] [--resources FILE.json] [--throttle-scale X] [--env-script FILE]
           [--python EXE] [--partition public|auto] [--tag NAME] [--sbatch-arg ARG ...] [--dry-run]

Builds the galaxy list (host catalogue SubfindID, minus --exclude, only galaxies with a cutout under --cutouts,
largest cutout first), reads each galaxy's DONE.<stage> markers under <root>/<id>/, groups galaxies by their pending
stages and submits one array per (group, stage[, shard]) with `%K` throttles and `--dependency=aftercorr` chains:

    record -> slim -> rays shard 0..n-1 -> rays (merge) -> fits -+-> web -> check
                  \\-> cubes ----------------------------------- +

Stages already DONE are skipped (no array); --redo STAGE re-runs that stage and everything downstream with --force.
--stages limits submission to a prefix-closed subset (e.g. --stages record,slim to benchmark the cheap stages).
Job records go to <root>/_hpc/state.json for deploy/hpc/monitor.py; SLURM stdout to <root>/_hpc/slurm/, each task's
galpipe log to <root>/<id>/logs/<stage>[.s<i>of<n>].log. --dry-run prints the sbatch commands and writes nothing.

Defaults from the environment: TNG_GAL_ROOT (--root), TNG_MWM31_CATALOG (--catalog), TNG_MWM31_CUTOUTS (--cutouts),
TNG_ENV_SCRIPT (--env-script), PYTHON (--python).
"""
from __future__ import annotations

import argparse
import os
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hpclib as H  # noqa: E402


def core_hours(groups, nshards) -> dict:
    """Upper-bound core-hours requested per stage (cpus x time limit x tasks)."""
    out = {}
    for g in groups:
        for st, sh in g.pending.items():
            ntask = len(g.galaxies) * (len(sh) if st == "rays_shard" else 1)
            c = g.res[st]
            out[st] = out.get(st, 0.0) + ntask * int(c["cpus"]) * H.parse_time_s(c["time"]) / 3600
    return out


def print_plan(groups, sub: H.Submitter, nshards: int) -> None:
    print(f"[hpc] {sum(len(g.galaxies) for g in groups)} galaxies with pending stages in {len(groups)} group(s)")
    for i, g in enumerate(groups):
        stages = ", ".join(f"{s}[{','.join(map(str, v))}]" if s == "rays_shard" else s for s, v in g.pending.items())
        head = ", ".join(map(str, g.galaxies[:6])) + (" ..." if len(g.galaxies) > 6 else "")
        print(f"  group {i}: {len(g.galaxies)} galaxies ({head}); stages: {stages}"
              + (f"; --force: {sorted(g.force)}" if g.force else ""))
    print(f"{'job':>7}  {'stage':<14} {'tasks':>5}  {'cpus':>4} {'mem':>5} {'time':>9}  {'array':<12} deps")
    for argv, jid in sub.log:
        a = dict(zip(argv, argv[1:]))
        arr = next(x for x in argv if x.startswith("--array=")).split("=", 1)[1]
        dep = next((x.split(":", 1)[1] for x in argv if x.startswith("--dependency=")), "-")
        n = int(arr.split("%")[0].split("-")[1]) + 1
        print(f"{jid:>7}  {a['-J'][3:]:<14} {n:>5}  {a['-c']:>4} {a['--mem']:>5} {a['-t']:>9}  {arr:<12} {dep}")
    ch = core_hours(groups, nshards)
    print("[hpc] requested core-h (cpus x wall limit; actual use is lower): "
          + ", ".join(f"{k} {v:.0f}" for k, v in ch.items()) + f"; total {sum(ch.values()):.0f}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=os.environ.get("TNG_GAL_ROOT"),
                    help="data root, one directory per galaxy (env TNG_GAL_ROOT)")
    ap.add_argument("--catalog", type=Path, default=os.environ.get("TNG_MWM31_CATALOG"),
                    help="MW/M31 host catalogue hdf5 (env TNG_MWM31_CATALOG)")
    ap.add_argument("--cutouts", type=Path, default=os.environ.get("TNG_MWM31_CUTOUTS"),
                    help="directory with subhalo_<id>/snap_99.hdf5 (env TNG_MWM31_CUTOUTS); skips missing ones")
    ap.add_argument("--galaxies", default="", help="comma list of ids (instead of the catalogue)")
    ap.add_argument("--exclude", default="", help="comma list of ids to leave out")
    ap.add_argument("--limit", type=int, default=None, help="first N galaxies of the ordered list")
    ap.add_argument("--order", choices=("size", "id", "catalog"), default="size")
    ap.add_argument("--shards", type=int, default=None, help=f"rays shards per galaxy (default {H.DEFAULT_SHARDS}, "
                                                             "or the value recorded in the state file)")
    ap.add_argument("--stages", default="", help="submit only these launcher stages (default all)")
    ap.add_argument("--redo", default="", help="re-run these stages and their descendants with --force")
    ap.add_argument("--resources", type=Path, default=None, help="JSON overrides {stage: {cpus, mem, time, throttle}}")
    ap.add_argument("--throttle-scale", type=float, default=1.0, help="multiply every %%K throttle")
    ap.add_argument("--env-script", default=os.environ.get("TNG_ENV_SCRIPT", ""),
                    help="script each task sources first (env TNG_ENV_SCRIPT)")
    ap.add_argument("--python", default=os.environ.get("PYTHON", "python"))
    ap.add_argument("--partition", default="public",
                    help="public (default), or auto: htc for tasks within its 4 h limit, public otherwise")
    ap.add_argument("--qos", default="public")
    ap.add_argument("--tag", default="", help="suffix for job names")
    ap.add_argument("--sbatch-arg", action="append", default=[], help="extra sbatch argument (repeatable)")
    ap.add_argument("--spectra", choices=("auto",) + H.SOURCES, default="auto",
                    help="spectra source: auto (488530 Trident, every other galaxy the SBI_CGM import), or force one")
    ap.add_argument("--dry-run", action="store_true", help="print the jobs it would submit; write nothing")
    a = ap.parse_args(argv)
    if not a.root:
        ap.error("--root (or TNG_GAL_ROOT) is required")
    root = a.root.resolve()

    gids = H.build_galaxy_list(a.catalog, a.cutouts, H.parse_ids(a.galaxies), H.parse_ids(a.exclude), a.limit,
                               a.order)
    state = H.load_state(root)
    nshards = a.shards or state.get("nshards") or H.DEFAULT_SHARDS
    if state.get("jobs") and state.get("nshards") and nshards != state["nshards"]:
        print(f"[hpc] warning: shard count {nshards} differs from the state's {state['nshards']}; shard markers "
              "of the old split are ignored", file=sys.stderr)
    res = H.load_resources(a.resources)
    for st in res:
        res[st]["throttle"] = max(1, int(round(res[st]["throttle"] * a.throttle_scale)))
    redo = [s.strip() for s in a.redo.split(",") if s.strip()]
    for s in redo:
        if s not in H.STAGES:
            ap.error(f"unknown stage {s!r}; stages: {', '.join(H.ORDER)}")
    groups = H.plan(root, gids, nshards, redo=redo, resources=res, spectra=a.spectra)
    if a.stages:
        keep = {s.strip() for s in a.stages.split(",") if s.strip()}
        bad = keep - set(H.STAGES)
        if bad:
            ap.error(f"unknown stage(s) {sorted(bad)}")
        if "rays" in keep:
            keep.add("rays_shard")
        for g in groups:
            g.pending = {s: v for s, v in g.pending.items() if s in keep}
        groups = [g for g in groups if g.pending]
    if a.env_script and not Path(a.env_script).exists() and not a.dry_run:
        ap.error(f"--env-script {a.env_script} not found")

    sub = H.Submitter(root=root, env_script=a.env_script, python=a.python, dry_run=a.dry_run, tag=a.tag,
                      extra=list(a.sbatch_arg), partition=a.partition, qos=a.qos)
    if not groups:
        print(f"[hpc] nothing to submit: all {len(gids)} galaxies are DONE for the selected stages")
        return 0

    if a.dry_run:
        recs = [r for g in groups for r in sub.submit_group(g, nshards)]
        print_plan(groups, sub, nshards)
        print("[hpc] dry run: sbatch commands")
        for argv_, jid in sub.log:
            print(f"  {jid}: sbatch --parsable " + " ".join(shlex.quote(x) for x in argv_))
        return 0

    with H.state_lock(root):
        state = H.load_state(root)
        recs = []
        try:
            for g in groups:
                recs += sub.submit_group(g, nshards)
        finally:          # record whatever was submitted, even if a later sbatch failed
            state["galaxies"] = sorted(set(state.get("galaxies", [])) | set(gids))
            state["nshards"] = nshards
            state["spectra"] = a.spectra
            state["jobs"] = state.get("jobs", []) + recs
            state["config"] = {"env_script": a.env_script, "python": a.python, "tag": a.tag,
                               "resources": str(a.resources or ""), "throttle_scale": a.throttle_scale,
                               "extra": list(a.sbatch_arg), "repo": str(H.REPO),
                               "partition": a.partition, "qos": a.qos}
            H.save_state(root, state)
    print_plan(groups, sub, nshards)
    print(f"[hpc] submitted {len(recs)} arrays; state {H.state_path(root)}; follow with "
          f"python deploy/hpc/monitor.py --root {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
