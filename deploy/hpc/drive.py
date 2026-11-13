#!/usr/bin/env python3
"""Dependency-free driver for the galaxy-sample pipeline: submits a stage only when its inputs exist.

    python deploy/hpc/drive.py --root DATA_ROOT --state FILE.json [--galaxies IDS] [--resources FILE.json]
           [--tag run3] [--env-script FILE] [--interval 120] [--once] [--dry-run]
           [--redo-force GID:stage,...] [--max-retries 2] [--clean-cache]

Why: run2's `--dependency=aftercorr` chains (launch.py) silently dropped every downstream task whose upstream task
timed out (SOL kill_invalid_depend), and nothing resubmitted them once the monitor stopped. This driver uses no SLURM
dependencies at all. Each tick it

1. reads the galaxies' DONE.<stage> markers and the queue (jobs named gp-<stage>-<tag>);
2. grades finished attempts from sacct: a task that left the queue without writing DONE.<stage> is a failure
   (TIMEOUT -> next attempt with 2x time, OUT_OF_MEMORY -> 1.5x memory); after --max-retries resubmissions the
   (galaxy, stage) is flagged and its descendants wait;
3. submits, per stage, one array of the galaxies whose prerequisite DONE markers all exist, the stage is not DONE,
   not queued and not flagged, capped at `throttle - (tasks of that stage already queued or running)`, so the
   throttle is global across arrays;
4. optionally (--clean-cache) deletes the float viz_cache .npy files of galaxies whose check.json passes every gate
   (the cube gates are snapshotted in logs/cube_gates.json by the check stage);
5. writes a progress table into the state file and stdout.

It exits when every galaxy is DONE through `check` or flagged. task.sh re-checks the prerequisites (GP_REQUIRE), so
a task can never run on missing inputs even if a marker vanished after submission.

The stage graph is the SBI chain of hpclib (record -> import_sbi -> rays -> fits; record -> slim -> cubes (after
rays); fits + cubes -> web -> check). Trident galaxies with pending rays shards are reported and left to launch.py.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hpclib as H  # noqa: E402

SBI_AFTER = {"record": (), "slim": ("record",), "import_sbi": ("record",), "rays": ("import_sbi",),
             "fits": ("rays",), "cubes": ("slim", "rays"), "web": ("fits", "cubes"), "check": ("web",)}
TRIDENT_AFTER = {"record": (), "slim": ("record",), "rays": ("slim",), "fits": ("rays",),
                 "cubes": ("slim", "rays"), "web": ("fits", "cubes"), "check": ("web",)}
ORDER = ("record", "slim", "import_sbi", "rays", "fits", "cubes", "web", "check")
CUBE_GATES = ("cube_conservation", "column_checks", "HI_le_nH", "viz_manifest")


def log(msg: str) -> None:
    print(f"[drive {time.strftime('%m-%d %H:%M:%S')}] {msg}", flush=True)


def load(path: Path) -> dict:
    if path.is_file():
        return json.loads(path.read_text())
    return {"attempts": {}, "force": {}, "flagged": {}, "cleaned": {}, "started": time.time()}


def save(path: Path, st: dict) -> None:
    H.atomic_write(path, json.dumps(st, indent=1, sort_keys=True))


def graph(root: Path, gid: int) -> dict:
    return SBI_AFTER if H.spectra_source(root, gid) == "sbi" else TRIDENT_AFTER


def queue(tag: str) -> dict:
    """{(jobid, task): (state, reason)} of our gp-*-<tag> array tasks."""
    out = subprocess.run(["squeue", "-h", "-r", "-u", os.environ.get("USER", ""), "-o", "%i|%j|%T|%r"],
                         capture_output=True, text=True, check=True).stdout
    res = {}
    for line in out.splitlines():
        p = line.strip().split("|")
        if len(p) < 4 or not p[1].startswith("gp-") or not p[1].endswith("-" + tag) or "_" not in p[0]:
            continue
        base, t = p[0].split("_", 1)
        for ti in H._expand_tasks(t):
            res[(base, ti)] = (p[2], p[3])
    return res


def check_pass(d: Path) -> bool:
    try:
        ck = json.loads((d / "check.json").read_text())
    except (OSError, ValueError):
        return False
    g = ck.get("gates", {})
    return bool(ck.get("pass")) and all((g.get(k) or {}).get("pass") for k in CUBE_GATES)


def clean_cache(root: Path, gid: int, st: dict, dry: bool) -> int:
    d = H.gal_dir(root, gid)
    if not (d / "DONE.check").is_file() or not check_pass(d):
        return 0
    if not (d / "logs" / "cube_gates.json").is_file():
        return 0                                   # keep the floats until the gates are snapshotted
    files = list((d / "viz_cache").rglob("*.npy"))
    if not files:
        return 0
    b = sum(f.stat().st_size for f in files)
    if not dry:
        for f in files:
            f.unlink()
        st["cleaned"][str(gid)] = {"files": len(files), "bytes": b, "t": time.strftime("%Y-%m-%dT%H:%M:%S")}
    log(f"viz_cache {gid}: {len(files)} npy, {b / 1e9:.1f} GB {'(dry)' if dry else 'deleted'}")
    return b


def submit(stage: str, gids: list, cfg: dict, force: bool, a, root: Path, st: dict) -> str | None:
    if not gids:
        return None
    lst_dir = root / "_hpc" / "lists"
    lst = lst_dir / f"{a.tag}_{stage}_{time.strftime('%Y%m%dT%H%M%S')}_{len(gids)}{'_f' if force else ''}.txt"
    after = SBI_AFTER[stage] if stage in SBI_AFTER else ()
    env = {"GP_STAGE": stage, "GP_LIST": str(lst), "GP_ROOT": str(root), "GP_REPO": str(H.REPO),
           "GP_PYTHON": a.python, "GP_ENV": a.env_script or "", "GP_SHARD": "", "GP_POST": "",
           "GP_WORKERS": str(H.workers_for(cfg) or ""), "GP_FORCE": "1" if force else "",
           "GP_SPECTRA": "sbi", "GP_LABEL": stage, "GP_REQUIRE": ":".join(after)}
    argv = ["-p", "public", "-q", "public", "-J", f"gp-{stage}-{a.tag}", "-c", str(cfg["cpus"]),
            "--mem", str(cfg["mem"]), "-t", str(cfg["time"]), f"--array=0-{len(gids) - 1}%{len(gids)}",
            "-o", str(root / "_hpc" / "slurm" / "%x_%A_%a.out"),
            "--export=ALL," + ",".join(f"{k}={v}" for k, v in env.items()),
            str(H.SBATCH_DIR / f"{stage}.sbatch")]
    if a.dry_run:
        log(f"DRY sbatch {stage} x{len(gids)} force={force} {cfg['cpus']}c {cfg['mem']} {cfg['time']}: {gids[:8]}")
        return None
    lst_dir.mkdir(parents=True, exist_ok=True)
    (root / "_hpc" / "slurm").mkdir(parents=True, exist_ok=True)
    H.atomic_write(lst, "".join(f"{g}\n" for g in gids))
    for g in gids:
        (H.gal_dir(root, g) / "logs").mkdir(parents=True, exist_ok=True)
    out = subprocess.run(["sbatch", "--parsable", *argv], capture_output=True, text=True)
    if out.returncode != 0:
        log(f"sbatch {stage} failed: {out.stderr.strip()}")
        return None
    jid = out.stdout.strip().split(";")[0]
    for i, g in enumerate(gids):
        st["attempts"].setdefault(f"{g}:{stage}", []).append(
            {"job": jid, "task": i, "res": {k: cfg[k] for k in ("cpus", "mem", "time")}, "force": force,
             "submitted": time.time(), "result": None})
    log(f"submitted {stage} job {jid}: {len(gids)} tasks, {cfg['cpus']}c {cfg['mem']} {cfg['time']}"
        f"{' --force' if force else ''}")
    return jid


def tick(a, root: Path, gids: list, res: dict, st: dict) -> bool:
    q = queue(a.tag)
    by_task = {}
    for key, atts in st["attempts"].items():
        for at in atts:
            by_task[(at["job"], at["task"])] = (key, at)
    # held tasks (e.g. "user env retrieval failed requeued held") never run by themselves: cancel, count a failure
    for (jid, ti), (state, reason) in list(q.items()):
        if "held" in reason.lower() or state in ("REQUEUE_HOLD", "SPECIAL_EXIT"):
            if (jid, ti) in by_task and not a.dry_run:
                subprocess.run(["scancel", f"{jid}_{ti}"], capture_output=True)
                by_task[(jid, ti)][1]["result"] = "HELD"
                log(f"cancelled held task {jid}_{ti} ({by_task[(jid, ti)][0]}): {reason}")
            q.pop((jid, ti))
    active = {by_task[k][0] for k in q if k in by_task}
    # grade attempts that left the queue
    unknown = sorted({at["job"] for key, atts in st["attempts"].items() for at in atts
                      if at["result"] is None and (at["job"], at["task"]) not in q})
    acct = H.sacct_tasks(unknown) if unknown else {}
    for key, atts in st["attempts"].items():
        gid, stage = key.split(":")
        for at in atts:
            if at["result"] is not None or (at["job"], at["task"]) in q:
                continue
            s = acct.get((at["job"], at["task"]))
            if s is None or not s["state"] or s["state"] in H.ACTIVE_STATES:
                if time.time() - at["submitted"] < 900:
                    continue                      # sacct lag right after submission
                s = s or {"state": "LOST"}
            done = H.stage_done(root, gid, stage)
            at["result"] = "DONE" if done else (s["state"] if s["state"] != "COMPLETED" else "NO_MARKER")
            at.update({k: s.get(k) for k in ("elapsed", "totalcpu", "maxrss_mb", "cpus") if k in s})
            if not done:
                log(f"{key}: attempt {at['job']}_{at['task']} ended {at['result']} ({s.get('elapsed', '')})")
    # plan
    want = {}                                     # (stage, force, cfg json) -> [gid]
    counts = {s: {"done": 0, "active": 0, "ready": 0, "waiting": 0, "flagged": 0} for s in ORDER}
    running = {s: 0 for s in ORDER}
    for key in active:
        running[key.split(":")[1]] += 1
    finished = True
    for gid in gids:
        gr = graph(root, gid)
        if gr is TRIDENT_AFTER and not H.stage_done(root, gid, "rays"):
            counts["rays"]["flagged"] += 1
            st["flagged"].setdefault(f"{gid}:rays", "trident rays pending: use launch.py")
            continue
        for stage in ORDER:
            if stage not in gr:
                continue
            key = f"{gid}:{stage}"
            c = counts[stage]
            if H.stage_done(root, gid, stage):
                c["done"] += 1
                continue
            finished = False
            if key in active:
                c["active"] += 1
                continue
            if key in st["flagged"]:
                c["flagged"] += 1
                continue
            if not all(H.stage_done(root, gid, p) for p in gr[stage]):
                c["waiting"] += 1
                continue
            atts = st["attempts"].get(key, [])
            fails = [x for x in atts if x["result"] not in (None, "DONE")]
            if len(fails) > a.max_retries:
                st["flagged"][key] = f"{len(fails)} failed attempts: " + ",".join(x["result"] for x in fails)
                log(f"FLAG {key}: {st['flagged'][key]}")
                c["flagged"] += 1
                continue
            cfg = dict(res[stage])
            for x in fails:                       # cumulative bumps over the earlier failures
                cfg = H.bump(cfg, x["result"])
            force = stage in st["force"].get(str(gid), [])
            c["ready"] += 1
            want.setdefault((stage, force, json.dumps({k: cfg[k] for k in ("cpus", "mem", "time")},
                                                      sort_keys=True)), []).append(gid)
    for (stage, force, cj), lst in sorted(want.items(), key=lambda kv: ORDER.index(kv[0][0])):
        cap = int(res[stage]["throttle"]) - running[stage]
        if cap <= 0:
            continue
        take = lst[:cap]
        cfg = dict(res[stage], **json.loads(cj))
        if submit(stage, take, cfg, force, a, root, st):
            running[stage] += len(take)
    if a.clean_cache:
        freed = sum(clean_cache(root, g, st, a.dry_run) for g in gids)
        if freed:
            log(f"freed {freed / 1e9:.1f} GB of viz_cache")
    # force flags are consumed once the stage succeeded
    for g, stages in list(st["force"].items()):
        st["force"][g] = [s for s in stages if not H.stage_done(root, g, s)]
    st["progress"] = {"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "counts": counts}
    hdr = f"{'stage':<11}{'done':>6}{'active':>8}{'ready':>7}{'wait':>6}{'flag':>6}"
    log("progress\n" + hdr + "\n" + "\n".join(
        f"{s:<11}{c['done']:>6}{c['active']:>8}{c['ready']:>7}{c['waiting']:>6}{c['flagged']:>6}"
        for s, c in counts.items()))
    stuck = finished or all(c["active"] == 0 and c["ready"] == 0 for c in counts.values())
    return stuck


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--state", type=Path, required=True)
    ap.add_argument("--galaxies", default="", help="comma list (default every numeric directory under --root)")
    ap.add_argument("--resources", type=Path, default=None)
    ap.add_argument("--tag", default="run3")
    ap.add_argument("--env-script", default=os.environ.get("TNG_ENV_SCRIPT", ""))
    ap.add_argument("--python", default="python")
    ap.add_argument("--interval", type=int, default=120)
    ap.add_argument("--max-retries", type=int, default=H.MAX_RETRIES)
    ap.add_argument("--redo-force", default="", help="GID:stage,... run once with --force (consumed on success)")
    ap.add_argument("--clean-cache", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    root = a.root.resolve()
    gids = H.parse_ids(a.galaxies) or sorted(int(p.name) for p in root.iterdir() if p.name.isdigit())
    res = H.load_resources(a.resources)
    st = load(a.state)
    for item in filter(None, (x.strip() for x in a.redo_force.split(","))):
        g, s = item.split(":")
        st["force"].setdefault(g, [])
        if s not in st["force"][g]:
            st["force"][g].append(s)
    log(f"{len(gids)} galaxies, tag {a.tag}, resources {a.resources}")
    while True:
        done = tick(a, root, gids, res, st)
        if not a.dry_run:
            save(a.state, st)
        if a.once or a.dry_run:
            return 0
        if done:
            log("nothing active or ready: every galaxy is DONE or flagged; exiting")
            return 0
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
