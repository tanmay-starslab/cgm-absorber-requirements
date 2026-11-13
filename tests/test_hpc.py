"""deploy/hpc: launcher planning, sbatch templates, task wrapper and monitor recovery, against fake SLURM commands."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
HPC = REPO / "deploy" / "hpc"
sys.path.insert(0, str(HPC))
import hpclib as H  # noqa: E402

FAKE_SBATCH = r'''#!/usr/bin/env python3
import json, os, sys
d = os.environ["FAKE_DIR"]
c = os.path.join(d, "counter")
n = int(open(c).read()) if os.path.exists(c) else 1000
open(c, "w").write(str(n + 1))
with open(os.path.join(d, "sbatch.jsonl"), "a") as fh:
    fh.write(json.dumps({"id": str(n), "argv": sys.argv[1:]}) + "\n")
print(n)
'''
FAKE_CAT = r'''#!/bin/sh
f="$FAKE_DIR/$(basename "$0").txt"
[ -f "$f" ] && cat "$f"
exit 0
'''


@pytest.fixture
def fake(tmp_path, monkeypatch):
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "sbatch").write_text(FAKE_SBATCH)
    for name in ("squeue", "sacct", "scancel"):
        (bin_ / name).write_text(FAKE_CAT)
    for p in bin_.iterdir():
        p.chmod(0o755)
    fd = tmp_path / "fake"
    fd.mkdir()
    monkeypatch.setenv("PATH", f"{bin_}:{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_DIR", str(fd))
    for k in ("TNG_GAL_ROOT", "TNG_MWM31_CATALOG", "TNG_MWM31_CUTOUTS", "TNG_ENV_SCRIPT"):
        monkeypatch.delenv(k, raising=False)
    root = tmp_path / "root"
    root.mkdir()
    return {"dir": fd, "root": root, "tmp": tmp_path}


def submissions(fd: Path) -> list[dict]:
    p = fd / "sbatch.jsonl"
    if not p.exists():
        return []
    out = []
    for line in p.read_text().splitlines():
        r = json.loads(line)
        argv = r["argv"]
        a = dict(zip(argv, argv[1:]))
        exp = dict(kv.split("=", 1) for kv in next(x for x in argv if x.startswith("--export=")).split("=", 1)[1]
                   .split(",")[1:])
        dep = next((x.split(":")[1:] for x in argv if x.startswith("--dependency=")), [])
        out.append({"id": r["id"], "name": a["-J"], "mem": a["--mem"], "time": a["-t"], "cpus": a["-c"],
                    "array": next(x for x in argv if x.startswith("--array=")).split("=", 1)[1],
                    "dep": dep, "env": exp, "script": argv[-1], "argv": argv})
    return out


def run(script, *args, env=None):
    return subprocess.run([sys.executable, str(HPC / script), *map(str, args)], capture_output=True, text=True,
                          env={**os.environ, **(env or {})})


def mark(root, gid, *names):
    d = Path(root) / str(gid)
    d.mkdir(parents=True, exist_ok=True)
    for n in names:
        (d / n).touch()


ALL_DONE = [f"DONE.{s}" for s in H.PIPE_STAGES]


# ------------------------------------------------------------------------------------------ planning
def test_plan_skips_done_and_groups(tmp_path):
    root = tmp_path
    mark(root, 1, *ALL_DONE)
    mark(root, 2, "DONE.record", "DONE.slim", H.shard_marker(0, 4), H.shard_marker(2, 4))
    mark(root, 3, "DONE.record", "DONE.slim", H.shard_marker(0, 4), H.shard_marker(2, 4))
    groups = H.plan(root, [1, 2, 3, 4], 4, spectra="trident")
    assert len(groups) == 2
    g = next(g for g in groups if 2 in g.galaxies)
    assert g.galaxies == [2, 3]
    assert list(g.pending) == ["rays_shard", "rays", "fits", "cubes", "web", "check"]
    assert g.pending["rays_shard"] == (1, 3)
    g4 = next(g for g in groups if 4 in g.galaxies)
    assert list(g4.pending)[:2] == ["record", "slim"] and g4.pending["rays_shard"] == (0, 1, 2, 3)


def test_rays_done_skips_shards_and_redo_forces_descendants(tmp_path):
    mark(tmp_path, 5, "DONE.record", "DONE.slim", "DONE.rays")
    (g,) = H.plan(tmp_path, [5], 8, spectra="trident")
    assert "rays_shard" not in g.pending and "rays" not in g.pending and "fits" in g.pending
    mark(tmp_path, 6, *ALL_DONE)
    assert H.plan(tmp_path, [6], 8, spectra="trident") == []
    (g,) = H.plan(tmp_path, [6], 8, redo=["fits"], spectra="trident")
    assert list(g.pending) == ["fits", "web", "check"] and g.force == {"fits", "web", "check"}
    (g,) = H.plan(tmp_path, [6], 8, redo=["slim"], spectra="trident")
    assert set(g.pending) == set(H.ORDER) - {"record", "import_sbi"} and g.pending["rays_shard"] == tuple(range(8))


def test_upstream_walks_through_done_stages():
    pend = {"cubes": (), "web": (), "check": ()}
    assert H.upstream_pending("web", pend) == ["cubes"]
    assert H.upstream_pending("cubes", pend) == []
    assert H.upstream_pending("fits", {"rays_shard": (0,), "rays": (), "fits": ()}) == ["rays"]


def test_resource_helpers():
    assert H.parse_mem_mb("16G") == 16384 and H.parse_mem_mb("1500M") == 1500 and H.parse_mem_mb("2T") == 2 ** 21
    assert H.parse_time_s("1-02:03:04") == 93784 and H.parse_time_s("30:00") == 1800
    assert H.fmt_time(93784) == "1-02:03:04" and H.fmt_mem(24576) == "24G"
    assert H.bump({"mem": "16G", "time": "03:00:00"}, "OUT_OF_MEMORY")["mem"] == "24G"
    assert H.bump({"mem": "16G", "time": "03:00:00"}, "TIMEOUT")["time"] == "06:00:00"
    assert H.bump({"mem": "16G", "time": "5-00:00:00"}, "TIMEOUT")["time"] == "7-00:00:00"
    assert H.bump({"mem": "400G", "time": "1:00:00"}, "OUT_OF_MEMORY")["mem"] == "480G"


def test_galaxy_list_from_catalog(tmp_path):
    h5py = pytest.importorskip("h5py")
    cat = tmp_path / "cat.hdf5"
    with h5py.File(cat, "w") as f:
        f["SubfindID"] = [11, 22, 33, 44]
        f["FlagCentral"] = [1, 1, 0, 1]
    cut = tmp_path / "cut"
    for gid, size in ((11, 10), (22, 300), (44, 50)):          # 33 has no cutout
        d = cut / f"subhalo_{gid}"
        d.mkdir(parents=True)
        (d / "snap_99.hdf5").write_bytes(b"x" * size)
    assert H.build_galaxy_list(cat, cut) == [22, 44, 11]                  # largest first, 33 skipped
    assert H.build_galaxy_list(cat, cut, exclude=[44], order="id") == [11, 22]
    assert H.build_galaxy_list(cat, None, limit=2, order="catalog") == [11, 22]
    assert H.build_galaxy_list(None, None, ids=[3, 1, 3]) == [3, 1]


# ------------------------------------------------------------------------------------------ templates and task
def test_templates_match_stage_table_and_rules():
    for st in H.ORDER:
        txt = H.TEMPLATE[st].read_text()
        d = dict(re.findall(r"^#SBATCH\s+(-\S+?)(?:[ =](\S+))?$", txt, re.M))
        assert d["-p"] == "public" and d["-q"] == "public"
        assert d["-c"] == str(H.STAGES[st]["cpus"]) and d["--mem"] == H.STAGES[st]["mem"]
        assert d["-t"] == H.STAGES[st]["time"]
        for banned in ("-w", "--nodelist", "--exclusive", "-x", "--exclude"):
            assert banned not in d, (st, banned)
        assert "deploy/hpc/sbatch/task.sh" in txt
        assert "/scratch/" not in txt and "tsingh" not in txt
    for p in HPC.rglob("*"):
        if p.is_file() and p.suffix in (".py", ".sh", ".sbatch"):
            assert "/scratch/" not in p.read_text() and "tsingh" not in p.read_text(), p


def test_task_wrapper_builds_galpipe_call(tmp_path):
    root = tmp_path / "root"
    lst = tmp_path / "list.txt"
    lst.write_text("111\n222\n333\n")
    fakepy = tmp_path / "py"
    fakepy.write_text('#!/bin/sh\necho "ARGS $*"\necho "OMP=$OMP_NUM_THREADS CUT=${TNG_CUTOUT:-unset}"\n'
                      'echo "FROMENV=$FROMENV"\nexit 7\n')
    fakepy.chmod(0o755)
    envs = tmp_path / "env.sh"
    envs.write_text('export FROMENV=yes TNG_CUTOUT=/elsewhere/one_galaxy.hdf5\nX=$UNSET_VARIABLE\n')
    env = {**os.environ, "SLURM_ARRAY_TASK_ID": "1", "SLURM_ARRAY_JOB_ID": "77", "SLURM_CPUS_PER_TASK": "4",
           "GP_STAGE": "rays", "GP_LIST": str(lst), "GP_ROOT": str(root), "GP_REPO": str(REPO),
           "GP_PYTHON": str(fakepy), "GP_SHARD": "3/8", "GP_WORKERS": "3", "GP_FORCE": "1",
           "GP_LABEL": "rays_shard.s3of8", "GP_ENV": str(envs), "GP_SPECTRA": "trident"}
    r = subprocess.run(["bash", str(H.TEMPLATE["rays_shard"])], env=env, capture_output=True, text=True)
    assert r.returncode == 7, r.stderr
    log = (root / "222" / "logs" / "rays_shard.s3of8.log").read_text()
    assert "ARGS -m tngsight.galpipe rays --galaxy 222 --root " + str(root) + " --shard 3/8 --workers 3 --force --spectra trident" \
        in log
    assert "OMP=4 CUT=unset" in log and "FROMENV=yes" in log and "exit 7" in log
    env.update(SLURM_ARRAY_TASK_ID="9")
    r = subprocess.run(["bash", str(H.TEMPLATE["record"])], env=env, capture_output=True, text=True)
    assert r.returncode == 3 and "no galaxy on line 10" in r.stderr


# ------------------------------------------------------------------------------------------ launcher
def test_dry_run_submits_nothing(fake):
    r = run("launch.py", "--spectra", "trident", "--root", fake["root"], "--galaxies", "1,2,3", "--shards", "8", "--dry-run")
    assert r.returncode == 0, r.stderr
    assert submissions(fake["dir"]) == []
    assert not any(fake["root"].iterdir())
    assert "DRY15" in r.stdout and "rays_shard-s7" in r.stdout and "0-2%3" in r.stdout
    assert "--dependency=aftercorr:DRY3:DRY4:DRY5:DRY6:DRY7:DRY8:DRY9:DRY10" in r.stdout


def test_launch_chain_and_resume(fake):
    root = fake["root"]
    mark(root, 3, *ALL_DONE)
    r = run("launch.py", "--spectra", "trident", "--root", root, "--galaxies", "1,2,3", "--shards", "2", "--throttle-scale", "0.04",
            "--sbatch-arg=--account=grp")
    assert r.returncode == 0, r.stderr
    subs = submissions(fake["dir"])
    names = [s["name"] for s in subs]
    assert names == ["gp-record", "gp-slim", "gp-rays_shard-s0", "gp-rays_shard-s1", "gp-rays", "gp-fits",
                     "gp-cubes", "gp-web", "gp-check"]
    by = {s["name"]: s for s in subs}
    assert all(s["array"].startswith("0-1%") for s in subs)                  # galaxy 3 is DONE: 2 tasks
    assert by["gp-record"]["array"] == "0-1%2" and by["gp-rays_shard-s0"]["array"] == "0-1%1"
    assert by["gp-record"]["dep"] == []
    assert by["gp-rays_shard-s1"]["dep"] == [by["gp-slim"]["id"]]
    assert by["gp-rays"]["dep"] == [by["gp-rays_shard-s0"]["id"], by["gp-rays_shard-s1"]["id"]]
    assert by["gp-cubes"]["dep"] == [by["gp-slim"]["id"], by["gp-rays"]["id"]]
    assert by["gp-web"]["dep"] == [by["gp-fits"]["id"], by["gp-cubes"]["id"]]
    assert all("--account=grp" in s["argv"] and "--kill-on-invalid-dep=yes" in s["argv"] for s in subs[1:])
    s1 = by["gp-rays_shard-s1"]
    assert s1["env"]["GP_STAGE"] == "rays" and s1["env"]["GP_SHARD"] == "1/2" and s1["env"]["GP_WORKERS"] == "7"
    assert s1["env"]["GP_POST"] == "fits" and by["gp-fits"]["env"].get("GP_POST", "") == ""
    assert s1["script"].endswith("deploy/hpc/sbatch/rays_shard.sbatch")
    assert all(s["env"]["GP_SPECTRA"] == "trident" for s in subs)
    assert Path(s1["env"]["GP_LIST"]).read_text() == "1\n2\n"
    assert (root / "1" / "logs").is_dir()
    st = json.loads((root / "_hpc" / "state.json").read_text())
    assert len(st["jobs"]) == 9 and st["nshards"] == 2 and st["galaxies"] == [1, 2, 3]

    # resume: galaxy 1 finished record+slim+shard 0; nothing else changed
    mark(root, 1, "DONE.record", "DONE.slim", H.shard_marker(0, 2))
    mark(root, 2, "DONE.record", "DONE.slim", H.shard_marker(0, 2))
    r = run("launch.py", "--spectra", "trident", "--root", root, "--galaxies", "1,2,3", "--stages", "record,slim,rays")
    assert r.returncode == 0, r.stderr
    new = submissions(fake["dir"])[9:]
    assert [s["name"] for s in new] == ["gp-rays_shard-s1", "gp-rays"]       # shards from the state (n=2)
    assert new[0]["dep"] == [] and new[1]["dep"] == [new[0]["id"]]
    for g in (1, 2, 3):
        mark(root, g, *ALL_DONE)
    r = run("launch.py", "--spectra", "trident", "--root", root, "--galaxies", "1,2,3")
    assert "nothing to submit" in r.stdout and len(submissions(fake["dir"])) == 11


# ------------------------------------------------------------------------------------------ monitor
def sacct_line(jid, state, rss="1000K", elapsed="00:10:00"):
    return f"{jid}|{state}|0:0|{elapsed}||00:20:00|4\n{jid}.batch|{state}|0:0|{elapsed}|{rss}|00:20:00|4\n"


def test_monitor_retries_bumps_and_flags(fake):
    root, fd = fake["root"], fake["dir"]
    r = run("launch.py", "--spectra", "trident", "--root", root, "--galaxies", "1,2,3", "--shards", "2")
    assert r.returncode == 0, r.stderr
    by = {s["name"]: s["id"] for s in submissions(fd)}
    # galaxy 1 (task 0) finished; galaxy 2 (task 1): shard 1 ran out of memory, downstream cancelled by SLURM;
    # galaxy 3 (task 2) still running shard 0
    mark(root, 1, *ALL_DONE)
    mark(root, 2, "DONE.record", "DONE.slim", H.shard_marker(0, 2))
    mark(root, 3, "DONE.record", "DONE.slim")
    acct = sacct_line(f"{by['gp-rays_shard-s1']}_1", "OUT_OF_MEMORY", rss="17000000K")
    for n in ("gp-rays", "gp-fits", "gp-web", "gp-check"):
        acct += sacct_line(f"{by[n]}_1", "CANCELLED")
    acct += sacct_line(f"{by['gp-rays_shard-s0']}_1", "COMPLETED", rss="9000000K")
    (fd / "sacct.txt").write_text(acct)
    (fd / "squeue.txt").write_text(f"{by['gp-rays_shard-s0']}_2|RUNNING\n{by['gp-rays_shard-s1']}_2|PENDING\n")

    r = run("monitor.py", "--root", root, "--details", "--usage")
    assert r.returncode == 0, r.stderr
    assert "retry 2: 2:rays_shard:1 OUT_OF_MEMORY (retry 1)" in r.stdout
    assert re.search(r"rays s/2\s+3\s+1\s+1\s+1\s+0\s+0", r.stdout), r.stdout   # snapshot before the retry
    new = submissions(fd)[9:]
    assert [s["name"] for s in new] == ["gp-rays_shard-s1", "gp-rays", "gp-fits", "gp-cubes", "gp-web", "gp-check"]
    assert new[0]["mem"] == "24G" and new[0]["array"] == "0-0%1"
    assert Path(new[0]["env"]["GP_LIST"]).read_text() == "2\n"
    assert "rays_shard" in r.stdout.split("suggestion")[1]                   # usage table lists the stage
    st = json.loads((root / "_hpc" / "state.json").read_text())
    assert st["retries"] == {"2:rays_shard:1": 1}

    # the retry fails twice more -> flagged, no further submission; the memory keeps growing
    for attempt in (2, 3):
        last = submissions(fd)[-6]["id"]
        acct += sacct_line(f"{last}_0", "OUT_OF_MEMORY")
        (fd / "sacct.txt").write_text(acct)
        (fd / "squeue.txt").write_text(f"{by['gp-rays_shard-s0']}_2|RUNNING\n")
        r = run("monitor.py", "--root", root)
        assert r.returncode == 0, r.stderr
        if attempt == 2:
            assert "(retry 2)" in r.stdout and submissions(fd)[-6]["mem"] == "36G"
    assert "FLAG 2: 2:rays_shard:1 OUT_OF_MEMORY after 2 retries" in r.stdout
    assert len(submissions(fd)) == 9 + 6 + 6
    st = json.loads((root / "_hpc" / "state.json").read_text())
    assert st["flagged"]["2"]["stage"] == "rays_shard" and st["flagged"]["2"]["log"].endswith(
        "2/logs/rays_shard.s1of2.log")
    r = run("monitor.py", "--root", root)
    assert len(submissions(fd)) == 21 and re.search(r"rays s/2\s+3\s+1\s+0\s+0\s+1\s+1", r.stdout), r.stdout


def test_monitor_lost_and_report_only(fake):
    root, fd = fake["root"], fake["dir"]
    run("launch.py", "--spectra", "trident", "--root", root, "--galaxies", "7", "--shards", "2")
    # nothing in squeue or sacct (e.g. scancel'd): charged to the first pending stage
    r = run("monitor.py", "--root", root, "--no-resubmit")
    assert "stalled 7: 7:record LOST (not resubmitted)" in r.stdout and len(submissions(fd)) == 9
    r = run("monitor.py", "--root", root, "--dry-run")
    assert "retry 7: 7:record LOST" in r.stdout and len(submissions(fd)) == 9
    assert json.loads((root / "_hpc" / "state.json").read_text())["retries"] == {}
    r = run("monitor.py", "--root", root)
    assert len(submissions(fd)) == 18 and submissions(fd)[9]["name"] == "gp-record"
    mark(root, 7, *ALL_DONE)
    r = run("monitor.py", "--root", root, "--watch", "1")
    assert "done 1" in r.stdout and len(submissions(fd)) == 18


def test_squeue_sacct_parsing(fake):
    fd = fake["dir"]
    (fd / "squeue.txt").write_text("55_[3-5,8%2]|PENDING\n55_1|RUNNING\n99|RUNNING\n")
    q = H.squeue_tasks(["55"])
    assert q == {("55", 3): "PENDING", ("55", 4): "PENDING", ("55", 5): "PENDING", ("55", 8): "PENDING",
                 ("55", 1): "RUNNING"}
    (fd / "sacct.txt").write_text("55_1|CANCELLED by 123|0:15|00:01:00||00:00:01|2\n"
                                  "55_1.batch|CANCELLED|0:15|00:01:00|2048M|00:00:01|2\n55_[2-3]|PENDING|0:0|"
                                  "00:00:00||00:00:00|2\n")
    a = H.sacct_tasks(["55"])
    assert a[("55", 1)]["state"] == "CANCELLED" and a[("55", 1)]["maxrss_mb"] == 2048
    assert a[("55", 3)]["state"] == "PENDING"


def test_partition_auto(fake):
    assert H.choose_partition("auto", "04:00:00") == "htc" and H.choose_partition("auto", "04:00:01") == "public"
    assert H.choose_partition("public", "00:10:00") == "public"
    res = fake["tmp"] / "res.json"
    res.write_text(json.dumps({"cubes": {"time": "06:00:00"}}))
    r = run("launch.py", "--spectra", "trident", "--root", fake["root"], "--galaxies", "1", "--partition", "auto", "--resources", res)
    assert r.returncode == 0, r.stderr
    part = {s["name"]: s["argv"][s["argv"].index("-p") + 1] for s in submissions(fake["dir"])}
    assert part["gp-cubes"] == "public" and part["gp-rays_shard-s0"] == "htc" and part["gp-record"] == "htc"
    assert json.loads((fake["root"] / "_hpc" / "state.json").read_text())["config"]["partition"] == "auto"


def test_sbi_chain_and_mixed_sources(tmp_path):
    """auto spectra: 488530 keeps the Trident chain, other galaxies get record -> import_sbi -> rays -> fits with
    slim -> cubes (cubes waits for slim and rays), no rays shards; an imported galaxy stays sbi."""
    groups = H.plan(tmp_path, [488530, 11, 12], 4)
    tri = next(g for g in groups if 488530 in g.galaxies)
    sbi = next(g for g in groups if 11 in g.galaxies)
    assert tri.source == "trident" and "import_sbi" not in tri.pending and "rays_shard" in tri.pending
    assert sbi.source == "sbi" and sbi.galaxies == [11, 12] and "rays_shard" not in sbi.pending
    assert list(sbi.pending) == ["record", "slim", "import_sbi", "rays", "fits", "cubes", "web", "check"]
    skip = H.not_applicable("sbi")
    assert H.upstream_pending("rays", sbi.pending, skip) == ["import_sbi"]
    assert H.upstream_pending("import_sbi", sbi.pending, skip) == ["record"]
    assert set(H.upstream_pending("cubes", sbi.pending, skip)) == {"slim", "rays"}
    mark(tmp_path, 12, "DONE.record", "DONE.slim", "DONE.import_sbi")
    (tmp_path / "12" / "library").mkdir(parents=True)
    (tmp_path / "12" / "library" / "rays.json").write_text("{}")
    assert H.spectra_source(tmp_path, 12) == "sbi" and H.spectra_source(tmp_path, 488530) == "trident"
    p12 = H.pending_stages(tmp_path, 12, 4)
    assert list(p12) == ["rays", "fits", "cubes", "web", "check"]
    assert H.upstream_pending("cubes", p12, skip) == ["rays"]
    mark(tmp_path, 13, "DONE.record", "DONE.slim", "DONE.rays")          # Trident rays already done -> trident
    assert H.spectra_source(tmp_path, 13) == "trident" and "import_sbi" not in H.pending_stages(tmp_path, 13, 4)
    assert "import_sbi" in H.pending_stages(tmp_path, 488530, 4, spectra="sbi")



def test_launch_forwards_planned_spectra(fake):
    """--spectra sbi on 488530 (no rays.json yet): every task must get GP_SPECTRA=sbi, or galpipe would resolve auto ->
    Trident, import_sbi would no-op and the rays task would start Trident tracing (pilot2 bug)."""
    root = fake["root"]
    mark(root, 488530, "DONE.record", "DONE.slim", "DONE.cubes")
    r = run("launch.py", "--spectra", "sbi", "--root", root, "--galaxies", "488530")
    assert r.returncode == 0, r.stderr
    subs = submissions(fake["dir"])
    assert [s["name"] for s in subs] == ["gp-import_sbi", "gp-rays", "gp-fits", "gp-web", "gp-check"]
    assert all(s["env"]["GP_SPECTRA"] == "sbi" for s in subs)


def test_stage_sizing_for_contention():
    """fix3 (h): run2 timeouts (cubes 79 at 1h30 with %60, import_sbi 24 at 1h30, fits 1 at 4 h) -> pilot times with
    margin under BeeGFS contention and lower throttles; the sbatch defaults agree and import_sbi caps its preads."""
    import re as _re
    S = H.STAGES
    assert H.parse_time_s(S["cubes"]["time"]) >= 3 * 3600 and S["cubes"]["throttle"] <= 24
    assert H.parse_time_s(S["import_sbi"]["time"]) >= 3 * 3600 and S["import_sbi"]["throttle"] <= 16
    assert H.parse_time_s(S["fits"]["time"]) >= 6 * 3600
    for st in ("cubes", "import_sbi", "fits", "check"):
        txt = (H.SBATCH_DIR / f"{st}.sbatch").read_text()
        assert _re.search(r"#SBATCH -t (\S+)", txt).group(1) == S[st]["time"], st
    assert "TNG_SBI_IO_THREADS" in (H.SBATCH_DIR / "import_sbi.sbatch").read_text()
