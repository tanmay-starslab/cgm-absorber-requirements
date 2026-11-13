#!/usr/bin/env python3
"""Progress table and failure recovery for the galaxy-sample SLURM run started by deploy/hpc/launch.py.

    python deploy/hpc/monitor.py --root DATA_ROOT [--no-resubmit] [--watch SECONDS] [--usage] [--details]
           [--max-retries 2] [--dry-run]

Each pass: reads <root>/_hpc/state.json (job records), squeue (active array tasks), sacct (finished tasks) and the
DONE markers, then prints one row per stage: galaxies done / running / queued / failed / flagged.

Recovery: a galaxy with pending stages and no active task is stalled. Its newest failed tasks (FAILED, TIMEOUT,
OUT_OF_MEMORY, NODE_FAIL, PREEMPTED, ...) each count one retry of that (galaxy, stage[, shard]); downstream tasks that
SLURM cancelled because of the failed dependency do not count. Stalled galaxies whose every count is <= --max-retries
are resubmitted together (their remaining chain re-planned from the DONE markers; OUT_OF_MEMORY raises the memory
x1.5 and TIMEOUT doubles the wall time of that stage); the others are flagged in the state file with the failing
stage, state and log path, and left alone (clear with --unflag ID after fixing).

--usage prints sacct use per stage (median and max elapsed, MaxRSS, CPU efficiency) against the request, to size
resources after the one-galaxy benchmark. --details lists the failed, flagged and stalled galaxies.
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hpclib as H  # noqa: E402


def task_index(state: dict) -> dict:
    """{(jobid, task): (gid, stage, shard, record)} for every array task of every job record."""
    idx = {}
    for rec in state.get("jobs", []):
        for t, gid in enumerate(rec["galaxies"]):
            idx[(str(rec["job"]), t)] = (int(gid), rec["stage"], rec.get("shard"), rec)
    return idx


def collect(root: Path, state: dict, squeue=H.squeue_tasks, sacct=H.sacct_tasks):
    """Per galaxy: active task keys, newest attempt per task key (sacct), pending stages."""
    jobids = [str(r["job"]) for r in state.get("jobs", [])]
    idx = task_index(state)
    q = squeue(jobids)
    acct = sacct(jobids)
    active: dict = {}
    for (jid, t), st in q.items():
        if (jid, t) in idx and st in H.ACTIVE_STATES:
            gid, stage, shard, _ = idx[(jid, t)]
            active.setdefault(gid, {})[H.task_key(gid, stage, shard)] = st
    newest: dict = {}                 # task key -> (submitted, state, jobid, task, record)
    for (jid, t), info in acct.items():
        if (jid, t) not in idx:
            continue
        gid, stage, shard, rec = idx[(jid, t)]
        k = H.task_key(gid, stage, shard)
        cur = newest.get(k)
        if cur is None or rec["submitted"] >= cur[0]:
            newest[k] = (rec["submitted"], info["state"], jid, t, rec)
    return idx, active, newest, acct


def classify(root, state, active, newest):
    nshards = state.get("nshards", H.DEFAULT_SHARDS)
    submitted = {int(g) for r in state.get("jobs", []) for g in r["galaxies"]}
    out = {}
    for gid in state.get("galaxies", []):
        gid = int(gid)
        pend = H.pending_stages(root, gid, nshards, spectra=state.get("spectra", "auto"))
        failed = {}
        for k, (_, st, jid, t, rec) in newest.items():
            if k.split(":")[0] == str(gid) and st in H.FAIL_STATES:
                stage = k.split(":")[1]
                still = stage in pend and (stage != "rays_shard" or int(k.split(":")[2]) in pend[stage])
                if still:
                    failed[k] = (st, jid, t, rec)
        if not pend:
            status = "done"
        elif str(gid) in state.get("flagged", {}):
            status = "flagged"
        elif gid in active:
            status = "active"
        elif gid not in submitted:
            status = "unsubmitted"
        else:
            status = "stalled"
        out[gid] = {"status": status, "pending": pend, "failed": failed}
    return out


def stage_table(root, state, cls, active) -> str:
    nshards = state.get("nshards", H.DEFAULT_SHARDS)
    rows = []
    hdr = f"{'stage':<12} {'done':>6} {'running':>8} {'queued':>7} {'failed':>7} {'flagged':>8} {'todo':>6}"
    rows.append(hdr)
    rows.append("-" * len(hdr))
    gids = [int(g) for g in state.get("galaxies", [])]
    src = {gid: H.spectra_source(root, gid, state.get("spectra", "auto")) for gid in gids}
    for st in H.ORDER:
        done = run = queued = failed = flagged = 0
        na = 0                                   # galaxies this stage does not apply to (spectra source)
        for gid in gids:
            c = cls[gid]
            act = active.get(gid, {})
            if not H.applicable(st, src[gid]):
                na += 1
                continue
            if st == "rays_shard":
                units = [(H.task_key(gid, st, i), i) for i in range(nshards)]
                is_done = [st not in c["pending"] or i not in c["pending"][st] for _, i in units]
            else:
                units = [(H.task_key(gid, st), None)]
                is_done = [st not in c["pending"]]
            for (k, _), d in zip(units, is_done):
                if d:
                    done += 1
                elif c["status"] == "flagged":
                    flagged += 1
                elif act.get(k) == "RUNNING":
                    run += 1
                elif k in act:
                    queued += 1
                elif k in c["failed"]:
                    failed += 1
        total = (len(gids) - na) * (nshards if st == "rays_shard" else 1)
        todo = total - done - run - queued - failed - flagged
        label = f"rays s/{nshards}" if st == "rays_shard" else st
        rows.append(f"{label:<12} {done:>6} {run:>8} {queued:>7} {failed:>7} {flagged:>8} {todo:>6}")
    counts = {}
    for c in cls.values():
        counts[c["status"]] = counts.get(c["status"], 0) + 1
    rows.append("galaxies: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) + f" (of {len(gids)})")
    return "\n".join(rows)


def log_path(root, gid, stage, shard, nshards) -> Path:
    label = stage + (f".s{shard}of{nshards}" if shard is not None else "")
    return H.gal_dir(root, gid) / "logs" / f"{label}.log"


def recover(root, state, cls, sub: H.Submitter, max_retries: int, resubmit: bool) -> list[str]:
    """Resubmit stalled galaxies (bumping resources after OOM/timeout) or flag them. Returns report lines."""
    nshards = state.get("nshards", H.DEFAULT_SHARDS)
    lines, bumps, retry = [], {}, []
    retries = state.setdefault("retries", {})
    flagged = state.setdefault("flagged", {})
    for gid, c in sorted(cls.items()):
        if c["status"] != "stalled":
            continue
        keys = dict(c["failed"])
        if not keys:     # nothing failed on its own: cancelled or lost; charge the first pending stage
            st0 = next(iter(c["pending"]))
            sh0 = c["pending"][st0][0] if st0 == "rays_shard" else None
            keys = {H.task_key(gid, st0, sh0): ("LOST", None, None, None)}
        over = []
        for k, (st, *_rest) in keys.items():
            n = retries.get(k, 0) + 1
            if n > max_retries:
                over.append((k, st))
        if over:
            k, st = over[0]
            parts = k.split(":")
            shard = int(parts[2]) if len(parts) > 2 else None
            flagged[str(gid)] = {"stage": parts[1], "shard": shard, "state": st, "retries": retries.get(k, 0),
                                 "log": str(log_path(root, gid, parts[1], shard, nshards)),
                                 "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
            lines.append(f"FLAG {gid}: {k} {st} after {retries.get(k, 0)} retries; log {flagged[str(gid)]['log']}")
            continue
        if not resubmit:
            lines.append(f"stalled {gid}: " + ", ".join(f"{k} {v[0]}" for k, v in keys.items()) + " (not resubmitted)")
            continue
        for k, (st, *_rest) in keys.items():
            retries[k] = retries.get(k, 0) + 1
            if st in ("OUT_OF_MEMORY", "TIMEOUT", "DEADLINE"):
                bumps.setdefault(gid, {})[k.split(":")[1]] = st
        retry.append(gid)
        lines.append(f"retry {gid}: " + ", ".join(f"{k} {v[0]} (retry {retries[k]})" for k, v in keys.items()))
    if retry:
        res = H.load_resources(state.get("config", {}).get("resources") or None)
        # carry earlier bumps forward: use the largest resources this galaxy's stage was ever given
        for rec in state.get("jobs", []):
            for gid in retry:
                if gid in rec["galaxies"] and rec["stage"] in res:
                    r = res[rec["stage"]]
                    r["mem"] = H.fmt_mem(max(H.parse_mem_mb(r["mem"]), H.parse_mem_mb(rec["res"]["mem"])))
                    r["time"] = H.fmt_time(max(H.parse_time_s(r["time"]), H.parse_time_s(rec["res"]["time"])))
        groups = H.plan(root, retry, nshards, resources=res, bumps=bumps, spectra=state.get("spectra", "auto"))
        recs = [r for g in groups for r in sub.submit_group(g, nshards)]
        for r in recs:
            r["retry"] = True
        if not sub.dry_run:
            state["jobs"] = state.get("jobs", []) + recs
        lines.append(f"resubmitted {len(retry)} galaxies as {len(recs)} arrays: "
                     + ", ".join(f"{r['stage']}{'' if r['shard'] is None else '-s' + str(r['shard'])}={r['job']}"
                                 for r in recs))
    return lines


def usage_table(state, acct) -> str:
    idx = task_index(state)
    per: dict = {}
    for key, info in acct.items():
        if key not in idx or info["state"] != "COMPLETED":
            continue
        _, stage, _, rec = idx[key]
        el = H.parse_time_s(info["elapsed"]) if info["elapsed"] else 0
        cpu = H.parse_time_s(info["totalcpu"].split(".")[0]) if info["totalcpu"] else 0
        ncpu = int(info["cpus"] or rec["res"]["cpus"])
        per.setdefault(stage, []).append((el, info["maxrss_mb"], cpu / max(1, el * ncpu), rec["res"]))
    out = [f"{'stage':<12} {'n':>4} {'elapsed med/max':>17} {'limit':>9} {'MaxRSS max':>10} {'mem':>6} {'cpu eff':>8}"
           f"  suggestion"]
    for st in H.ORDER:
        v = per.get(st)
        if not v:
            continue
        els = [x[0] for x in v]
        rss = max(x[1] for x in v)
        eff = statistics.median(x[2] for x in v)
        r = v[-1][3]
        sug_mem = H.fmt_mem(max(1024, int((rss * 1.5 + 1023) // 1024) * 1024))
        sug_t = H.fmt_time(max(900, int(max(els) * 2)))
        out.append(f"{st:<12} {len(v):>4} {H.fmt_time(statistics.median(els)):>8}/{H.fmt_time(max(els)):>8} "
                   f"{r['time']:>9} {rss / 1024:>9.1f}G {r['mem']:>6} {eff:>8.2f}  mem {sug_mem}, time {sug_t}")
    return "\n".join(out)


def one_pass(a, sub) -> int:
    root = a.root
    with H.state_lock(root):
        state = H.load_state(root)
        if not state.get("jobs"):
            print(f"[monitor] no jobs recorded in {H.state_path(root)}")
            return 0
        for gid in a.unflag:
            state.get("flagged", {}).pop(str(gid), None)
            state["retries"] = {k: v for k, v in state.get("retries", {}).items() if not k.startswith(f"{gid}:")}
        idx, active, newest, acct = collect(root, state)
        cls = classify(root, state, active, newest)
        lines = recover(root, state, cls, sub, a.max_retries, not a.no_resubmit)
        if not sub.dry_run:
            H.save_state(root, state)
    print(time.strftime("[monitor] %Y-%m-%d %H:%M:%S ") + str(root))
    print(stage_table(root, state, cls, active))
    for ln in lines:
        print("  " + ln)
    if state.get("flagged"):
        print(f"  flagged: {', '.join(sorted(state['flagged']))} (see state.json 'flagged'; --unflag ID to retry)")
    if a.details:
        for gid, c in sorted(cls.items()):
            if c["status"] in ("stalled", "flagged") or c["failed"]:
                print(f"  {gid}: {c['status']}; pending {list(c['pending'])}; failed "
                      + ", ".join(f"{k} {v[0]} job {v[1]}_{v[2]}" for k, v in c["failed"].items()))
    if a.usage:
        print(usage_table(state, acct))
    return sum(1 for c in cls.values() if c["status"] not in ("done", "flagged"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=os.environ.get("TNG_GAL_ROOT"))
    ap.add_argument("--no-resubmit", action="store_true", help="report only")
    ap.add_argument("--max-retries", type=int, default=H.MAX_RETRIES)
    ap.add_argument("--watch", type=float, default=0, help="repeat every N seconds until nothing is left to do")
    ap.add_argument("--usage", action="store_true", help="sacct use per stage vs request")
    ap.add_argument("--details", action="store_true")
    ap.add_argument("--unflag", type=int, action="append", default=[], help="clear a flagged galaxy's retries")
    ap.add_argument("--dry-run", action="store_true", help="show what would be resubmitted; change nothing")
    a = ap.parse_args(argv)
    if not a.root:
        ap.error("--root (or TNG_GAL_ROOT) is required")
    a.root = a.root.resolve()
    cfg = H.load_state(a.root).get("config", {})
    sub = H.Submitter(root=a.root, env_script=cfg.get("env_script", ""), python=cfg.get("python", "python"),
                      dry_run=a.dry_run, tag=cfg.get("tag", ""), extra=list(cfg.get("extra", [])),
                      partition=cfg.get("partition", "public"), qos=cfg.get("qos", "public"))
    while True:
        left = one_pass(a, sub)
        if not a.watch or left == 0:
            return 0
        time.sleep(a.watch)


if __name__ == "__main__":
    sys.exit(main())
