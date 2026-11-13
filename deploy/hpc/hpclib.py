"""Shared logic of the galaxy-sample SLURM launcher and monitor (deploy/hpc/launch.py, deploy/hpc/monitor.py).

The pipeline is `python -m tngsight.galpipe <stage> --galaxy <id> [--root DIR] [--shard i/n] [--workers k] [--force]`,
one galaxy per call, idempotent: each stage writes `<root>/<id>/DONE.<stage>` and skips when it exists.

Job layout (one SLURM array per stage and group of galaxies; array index = line of the group's galaxy list):

    record -> slim -> rays shard 0..n-1 (one array per shard) -> rays (merge) -> fits --+
                  \\-> cubes ---------------------------------------------------------+-> web -> check

Spectra source per galaxy (galaxy-sample spec, revision 2026-11-12): every galaxy except 488530 takes its spectra
from the SBI_CGM ray library, so its chain is

    record -> import_sbi -> rays (no-op completeness check, writes DONE.rays) -> fits --+
          \\-> slim -> cubes (after rays) -----------------------------------------------+-> web -> check

and the Trident `rays_shard` arrays are not applicable to it (488530, or any galaxy whose Trident rays are already
DONE, keeps the Trident chain; `import_sbi` is not applicable there). See `spectra_source`.

Arrays are chained with `--dependency=aftercorr:<job>[:<job>...]`, so task i of a stage starts when task i of each
upstream array has succeeded. Galaxies are grouped by their set of pending stages (DONE markers), so every array of a
group covers the same galaxy list and aftercorr pairs the right tasks. With SOL's `kill_invalid_depend`, a failed task
cancels its downstream tasks; the monitor then resubmits that galaxy's remaining chain (at most MAX_RETRIES times per
stage, bumping memory after OUT_OF_MEMORY and time after TIMEOUT) and flags it after that.

Nothing here imports tngsight: the launcher and monitor run on a login node with any Python 3.8+ (h5py only to read
the host catalogue).
"""
from __future__ import annotations

import contextlib
import copy
import fcntl
import json
import math
import os
import re
import shlex
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

HPC_DIR = Path(__file__).resolve().parent
REPO = HPC_DIR.parents[1]
SBATCH_DIR = HPC_DIR / "sbatch"
MAX_RETRIES = 2
DEFAULT_SHARDS = 8
DEFAULT_GALAXY = 488530

# Stage table. `after` lists the stages whose outputs a stage reads. Resources are per array task and provisional
# until the one-galaxy benchmark (see notes U_hpc.md): baseline 488530 (2.99 GB raw cutout, 2.03 M slim gas cells),
# rays 10.4 core-h + fits 0.8 core-h for 683 rays, cubes "minutes per field-level", the largest cutout is 2x 488530.
# workers: "cpus" -> --workers = cpus, "cpus-1" -> one core left for the parent process (regen_library pattern),
# None -> no --workers flag.
STAGES = {
    "record": dict(after=(), cpus=1, mem="8G", time="00:30:00", throttle=50, workers=None),
    "slim": dict(after=("record",), cpus=2, mem="16G", time="01:00:00", throttle=30, workers="cpus"),
    # SBI_CGM import (sbi galaxies only): ~700 rays read from 13 tau chunk files with parallel preads; I/O-bound,
    # pilot 2026-11-12: ~2 s per ray on a cold BeeGFS (U_sbi_adapter.md); throttled to spare the file system
    # run2 (2026-11-12): 24 of 195 imports timed out at 1h30 (pilot 6-8 min) while ~60 cube tasks loaded BeeGFS;
    # 3 h covers ~20x the pilot; throttle 16 with TNG_SBI_IO_THREADS=12 (import_sbi.sbatch) -> <= 192 preads at once
    "import_sbi": dict(after=("record",), cpus=2, mem="8G", time="03:00:00", throttle=16, workers=None,
                       sources=("sbi",)),
    # a shard task runs `galpipe rays --shard i/n` and then `galpipe fits --shard i/n` on the same rays (post step,
    # non-fatal: the fits stage refits whatever a shard left); pilot 2026-11-12 sizing, see notes U_pilot.md
    "rays_shard": dict(after=("slim",), cpus=8, mem="16G", time="03:00:00", throttle=25, workers="cpus-1",
                       post="fits", sources=("trident",)),
    # rays: Trident merge (after the shards), or for an SBI galaxy the completeness check of the import
    "rays": dict(after=("rays_shard", "import_sbi"), cpus=2, mem="8G", time="01:00:00", throttle=50,
                 workers="cpus"),
    # SBI pilot 2026-11-12: ~67 core-s per imported ray (700 rays ~1.6 h on 8 cores); 4 h stays inside htc's limit
    # pilot2: SBI 700 rays 10-25 core-h, 98 % CPU, RSS < 1 GB (0.6-1.6 h on 16 cores); run2 had 1 timeout at 4 h, so
    # 6 h (public partition; htc stops at 4 h)
    "fits": dict(after=("rays",), cpus=16, mem="8G", time="06:00:00", throttle=30, workers="cpus"),
    # cubes after rays: build_volumes' column checks read the library npz of the check sightlines
    # (+ slim explicitly: for an SBI galaxy rays follows import_sbi, not slim; cubes reads the slim cutout)
    # pilot 22-32 min per galaxy; run2: 79 timeouts at 1h30 with %60 on a 95 %-full /scratch -> 3 h and %24
    "cubes": dict(after=("slim", "rays"), cpus=8, mem="32G", time="03:00:00", throttle=24, workers="cpus"),
    "web": dict(after=("fits", "cubes"), cpus=1, mem="4G", time="00:30:00", throttle=50, workers=None),
    # check re-runs build_volumes --check when a build report has no rows (~1 h, run2: one timeout at 1 h) and reads
    # the SBI CSR velocities once per galaxy (~1 min)
    "check": dict(after=("web",), cpus=2, mem="16G", time="02:30:00", throttle=30, workers=None),
}
ORDER = ("record", "slim", "import_sbi", "rays_shard", "rays", "fits", "cubes", "web", "check")
PIPE_STAGES = ("record", "slim", "import_sbi", "rays", "fits", "cubes", "web", "check")   # galpipe stage names
SOURCES = ("sbi", "trident")
TEMPLATE = {s: SBATCH_DIR / f"{s}.sbatch" for s in ORDER}
FAIL_STATES = {"FAILED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "PREEMPTED", "BOOT_FAIL", "DEADLINE"}
ACTIVE_STATES = {"PENDING", "RUNNING", "CONFIGURING", "COMPLETING", "REQUEUED", "RESIZING", "SUSPENDED",
                 "REQUEUE_HOLD", "REQUEUE_FED", "SIGNALING", "STAGE_OUT", "STOPPED"}


def galpipe_stage(stage: str) -> str:
    """The galpipe stage a launcher stage runs (shards and the merge both call `rays`)."""
    return "rays" if stage == "rays_shard" else stage


# ------------------------------------------------------------------------------------------ markers
def gal_dir(root: Path, gid) -> Path:
    return Path(root) / str(gid)


def shard_marker(i: int, n: int) -> str:
    """Per-shard DONE marker name (galpipe contract: `DONE.rays.<i>of<n>`, 0-based i)."""
    return f"DONE.rays.{i}of{n}"


def stage_done(root: Path, gid, stage: str) -> bool:
    return (gal_dir(root, gid) / f"DONE.{stage}").exists()


def spectra_source(root: Path, gid, choice: str = "auto") -> str:
    """'sbi' or 'trident' (mirrors tngsight.galpipe.spectra_source without importing it): an SBI selection
    (<id>/library/rays.json) -> sbi; else the source recorded outside library/ (<id>/SPECTRA, DONE.import_sbi, or
    DONE.rays with info.source == "sbi_cgm"), so a galaxy whose library/ was deleted for a reselect stays SBI
    (review2 M3); Trident rays DONE -> trident; else 488530 -> trident, others -> sbi."""
    if choice in SOURCES:
        return choice
    d = gal_dir(root, gid)
    if (d / "library" / "rays.json").exists():
        return "sbi"
    mark = d / "SPECTRA"
    if mark.is_file():
        v = mark.read_text().strip()
        if v in SOURCES:
            return v
    if stage_done(root, gid, "import_sbi"):
        return "sbi"
    if stage_done(root, gid, "rays"):
        try:
            info = json.loads((d / "DONE.rays").read_text()).get("info") or {}
        except (OSError, ValueError):
            info = {}
        return "sbi" if info.get("source") == "sbi_cgm" else "trident"
    return "trident" if int(gid) == DEFAULT_GALAXY else "sbi"


def applicable(stage: str, source: str) -> bool:
    return source in STAGES[stage].get("sources", SOURCES)


def not_applicable(source: str) -> set:
    return {st for st in ORDER if not applicable(st, source)}


def pending_stages(root: Path, gid, nshards: int, redo=(), spectra: str = "auto") -> dict:
    """{stage: shards} for the stages a galaxy still needs; shards is a tuple of shard indices for rays_shard, else ().

    `redo` names launcher stages to redo (with --force); their descendants are redone too. Stages not applicable to
    the galaxy's spectra source (spectra_source) are never pending.
    """
    redo = descendants(set(redo))
    src = spectra_source(root, gid, spectra)
    out = {}
    for st in ORDER:
        if not applicable(st, src):
            continue
        if st == "rays_shard":
            if "rays_shard" in redo:
                out[st] = tuple(range(nshards))
            elif not stage_done(root, gid, "rays"):
                todo = tuple(i for i in range(nshards)
                             if not (gal_dir(root, gid) / shard_marker(i, nshards)).exists())
                if todo:
                    out[st] = todo
        elif st in redo or not stage_done(root, gid, st):
            out[st] = ()
    return out


def descendants(stages: set) -> set:
    out = set(stages)
    changed = True
    while changed:
        changed = False
        for st, cfg in STAGES.items():
            if st not in out and any(a in out for a in cfg["after"]):
                out.add(st)
                changed = True
    if "rays" in out:              # redoing rays means redoing its shards
        out.add("rays_shard")
    return out


# ------------------------------------------------------------------------------------------ galaxy list
def read_catalog(path: Path) -> list[dict]:
    """Rows of the MW/M31 host catalogue (SubfindID plus the columns the launcher reports)."""
    import h5py
    with h5py.File(path, "r") as f:
        ids = [int(x) for x in f["SubfindID"][()]]
        cols = {k: f[k][()] for k in ("FlagCentral", "StellarMass_30kpc", "HaloMass_M200c") if k in f}
    rows = []
    for j, gid in enumerate(ids):
        r = {"id": gid}
        for k, v in cols.items():
            r[k] = float(v[j])
        rows.append(r)
    return rows


def cutout_path(cutouts: Path, gid) -> Path:
    return Path(cutouts) / f"subhalo_{gid}" / "snap_99.hdf5"


def build_galaxy_list(catalog=None, cutouts=None, ids=None, exclude=(), limit=None, order="size") -> list[int]:
    """The galaxies to run: --galaxies (or the catalogue's SubfindID), minus --exclude, only those with a cutout when
    a cutout directory is known; ordered largest cutout first (the longest tasks start first), then by id."""
    if ids:
        gids = [int(x) for x in ids]
    elif catalog:
        gids = [r["id"] for r in read_catalog(catalog)]
    else:
        raise SystemExit("need --catalog (host catalogue) or --galaxies")
    ex = {int(x) for x in exclude}
    gids = [g for g in dict.fromkeys(gids) if g not in ex]
    sizes = {}
    if cutouts:
        missing = [g for g in gids if not cutout_path(cutouts, g).exists()]
        if missing:
            print(f"[hpc] {len(missing)} galaxies without a cutout skipped: {missing[:10]}"
                  f"{' ...' if len(missing) > 10 else ''}")
        gids = [g for g in gids if g not in missing]
        sizes = {g: cutout_path(cutouts, g).stat().st_size for g in gids}
    if order == "size" and sizes:
        gids.sort(key=lambda g: (-sizes[g], g))
    elif order == "id":
        gids.sort()
    if limit:
        gids = gids[:int(limit)]
    return gids


def parse_ids(text) -> list[int]:
    if not text:
        return []
    return [int(t) for t in re.split(r"[,\s]+", str(text).strip()) if t]


# ------------------------------------------------------------------------------------------ resources
def parse_mem_mb(mem: str) -> int:
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([KMGT]?)B?", str(mem).strip().upper())
    if not m:
        raise ValueError(f"bad memory {mem!r}")
    mult = {"K": 1 / 1024, "": 1, "M": 1, "G": 1024, "T": 1024 * 1024}[m.group(2)]
    return int(math.ceil(float(m.group(1)) * mult))


def fmt_mem(mb: int) -> str:
    return f"{mb // 1024}G" if mb % 1024 == 0 else f"{mb}M"


def parse_time_s(t: str) -> int:
    t = str(t)
    days = 0
    if "-" in t:
        d, t = t.split("-", 1)
        days = int(d)
    parts = [int(p) for p in t.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, s = parts
    return ((days * 24 + h) * 60 + m) * 60 + s


def fmt_time(sec: int) -> str:
    sec = int(sec)
    d, rem = divmod(sec, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    return f"{d}-{h:02d}:{m:02d}:{s:02d}" if d else f"{h:02d}:{m:02d}:{s:02d}"


MAX_WALL_S = 7 * 86400           # public partition MaxTime
HTC_WALL_S = 4 * 3600            # htc partition MaxTime (SOL); --partition auto uses htc up to this


def choose_partition(partition: str, time_limit: str) -> str:
    """'auto' -> htc when the task fits its 4 h limit (shorter queue on SOL), else public; otherwise as given."""
    if partition != "auto":
        return partition
    return "htc" if parse_time_s(time_limit) <= HTC_WALL_S else "public"
MAX_MEM_MB = 480 * 1024          # below a 512 GB public node


def load_resources(path=None) -> dict:
    """The stage table, optionally overridden by a JSON file {stage: {cpus, mem, time, throttle}}."""
    res = copy.deepcopy(STAGES)
    if path:
        over = json.loads(Path(path).read_text())
        for st, d in over.items():
            if st not in res:
                raise SystemExit(f"unknown stage {st!r} in {path}")
            res[st].update({k: v for k, v in d.items() if k in ("cpus", "mem", "time", "throttle")})
    return res


def bump(cfg: dict, reason: str) -> dict:
    """Resources for a retry: OUT_OF_MEMORY -> mem x1.5, TIMEOUT -> time x2 (capped at the partition limits)."""
    cfg = dict(cfg)
    if reason == "OUT_OF_MEMORY":
        cfg["mem"] = fmt_mem(min(MAX_MEM_MB, int(math.ceil(parse_mem_mb(cfg["mem"]) * 1.5 / 1024)) * 1024))
    elif reason in ("TIMEOUT", "DEADLINE"):
        cfg["time"] = fmt_time(min(MAX_WALL_S, parse_time_s(cfg["time"]) * 2))
    return cfg


def workers_for(cfg: dict):
    w = cfg.get("workers")
    if w == "cpus":
        return int(cfg["cpus"])
    if w == "cpus-1":
        return max(1, int(cfg["cpus"]) - 1)
    return None


# ------------------------------------------------------------------------------------------ planning
@dataclass
class Group:
    galaxies: list
    pending: dict                                      # stage -> shards tuple
    res: dict = field(default_factory=dict)            # stage -> resources (after bumps)
    force: set = field(default_factory=set)            # stages run with --force
    source: str = "trident"                            # spectra source shared by the group


def plan(root: Path, galaxies, nshards: int, redo=(), resources=None, bumps=None, spectra="auto") -> list[Group]:
    """Group the galaxies by their pending stages. `bumps` = {gid: {stage: reason}} raises that stage's resources
    for the whole group (a group shares one sbatch per stage)."""
    resources = resources or load_resources()
    bumps = bumps or {}
    force = descendants(set(redo)) if redo else set()
    groups: dict = {}
    for gid in galaxies:
        pend = pending_stages(root, gid, nshards, redo, spectra)
        if not pend:
            continue
        src = spectra_source(root, gid, spectra)
        key = (src,) + tuple(sorted((k, v) for k, v in pend.items()))
        g = groups.get(key)
        if g is None:
            g = groups[key] = Group([], pend, {s: dict(resources[s]) for s in pend}, force & set(pend), src)
        g.galaxies.append(gid)
        for st, reason in bumps.get(gid, {}).items():
            if st in g.res:
                b = bump(g.res[st], reason)
                g.res[st]["mem"] = fmt_mem(max(parse_mem_mb(g.res[st]["mem"]), parse_mem_mb(b["mem"])))
                g.res[st]["time"] = fmt_time(max(parse_time_s(g.res[st]["time"]), parse_time_s(b["time"])))
    return list(groups.values())


def upstream_pending(stage: str, pending: dict, skip=()) -> list[str]:
    """Nearest pending ancestors of a stage (walking through stages that are already DONE; `skip` = stages not
    applicable to the group, which are dead ends, not walked through)."""
    out, todo, seen = [], list(STAGES[stage]["after"]), set()
    while todo:
        a = todo.pop(0)
        if a in seen or a in skip:
            continue
        seen.add(a)
        if a in pending:
            out.append(a)
        else:
            todo.extend(STAGES[a]["after"])
    return out


# ------------------------------------------------------------------------------------------ submission
@dataclass
class Submitter:
    root: Path
    repo: Path = REPO
    env_script: str = ""
    python: str = "python"
    partition: str = "public"
    qos: str = "public"
    dry_run: bool = False
    tag: str = ""
    extra: list = field(default_factory=list)          # extra sbatch args (e.g. --account)
    log: list = field(default_factory=list)            # [(argv, jobid)]
    _dry: int = 0

    @property
    def hpc_root(self) -> Path:
        return Path(self.root) / "_hpc"

    def sbatch(self, argv: list) -> str:
        if self.dry_run:
            self._dry += 1
            jid = f"DRY{self._dry}"
        else:
            out = subprocess.run(["sbatch", "--parsable", *argv], check=True, capture_output=True, text=True).stdout
            jid = out.strip().split(";")[0].splitlines()[-1].strip()
            if not jid.isdigit():
                raise RuntimeError(f"sbatch returned {out!r}")
        self.log.append((argv, jid))
        return jid

    def write_list(self, galaxies) -> Path:
        d = self.hpc_root / "lists"
        name = f"{time.strftime('%Y%m%dT%H%M%S')}_{os.getpid()}_{len(self.log)}_{len(galaxies)}.txt"
        p = d / name
        if not self.dry_run:
            d.mkdir(parents=True, exist_ok=True)
            atomic_write(p, "".join(f"{g}\n" for g in galaxies))
        return p

    def submit_group(self, g: Group, nshards: int) -> list[dict]:
        """Submit the arrays of one group; returns job records for the state file."""
        n = len(g.galaxies)
        lst = self.write_list(g.galaxies)
        jobs: dict = {}                 # stage -> [jobid, ...]
        recs = []
        if not self.dry_run:
            (self.hpc_root / "slurm").mkdir(parents=True, exist_ok=True)
            for gid in g.galaxies:
                (gal_dir(self.root, gid) / "logs").mkdir(parents=True, exist_ok=True)
        for st in ORDER:
            if st not in g.pending:
                continue
            cfg = g.res[st]
            deps = [j for a in upstream_pending(st, g.pending, not_applicable(g.source)) for j in jobs.get(a, [])]
            shards = g.pending[st] if st == "rays_shard" else (None,)
            for sh in shards:
                name = f"gp-{st}" + (f"-s{sh}" if sh is not None else "") + (f"-{self.tag}" if self.tag else "")
                k = min(int(cfg["throttle"]), n)
                env = {"GP_STAGE": galpipe_stage(st), "GP_LIST": str(lst), "GP_ROOT": str(self.root),
                       "GP_REPO": str(self.repo), "GP_PYTHON": self.python, "GP_ENV": self.env_script or "",
                       "GP_SHARD": f"{sh}/{nshards}" if sh is not None else "",
                       "GP_POST": str(cfg.get("post") or ""),
                       "GP_WORKERS": str(workers_for(cfg) or ""),
                       "GP_FORCE": "1" if st in g.force else "",
                       # the group's resolved spectra source: galpipe must run the chain the plan was made for
                       # (an explicit --spectra sbi on a galaxy with no rays.json yet would otherwise fall back to auto)
                       "GP_SPECTRA": g.source or "",
                       "GP_LABEL": st + (f".s{sh}of{nshards}" if sh is not None else "")}
                argv = ["-p", choose_partition(self.partition, cfg["time"]), "-q", self.qos, "-J", name,
                        "-c", str(cfg["cpus"]), "--mem", str(cfg["mem"]), "-t", str(cfg["time"]),
                        f"--array=0-{n - 1}%{k}",
                        *(["--dependency=aftercorr:" + ":".join(deps), "--kill-on-invalid-dep=yes"]
                          if deps else []),
                        "-o", str(self.hpc_root / "slurm" / "%x_%A_%a.out"),
                        "--export=ALL," + ",".join(f"{a}={b}" for a, b in env.items()),
                        *self.extra]
                argv.append(str(self.repo / "deploy" / "hpc" / "sbatch" / f"{st}.sbatch"))
                jid = self.sbatch(argv)
                jobs.setdefault(st, []).append(jid)
                recs.append({"job": jid, "stage": st, "shard": sh, "nshards": nshards, "list": str(lst),
                             "galaxies": list(g.galaxies), "res": {k2: cfg[k2] for k2 in ("cpus", "mem", "time")},
                             "deps": deps, "force": st in g.force, "submitted": time.time()})
        return recs


# ------------------------------------------------------------------------------------------ state
def atomic_write(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.part")
    tmp.write_text(text)
    os.replace(tmp, path)


def state_path(root: Path) -> Path:
    return Path(root) / "_hpc" / "state.json"


def load_state(root: Path) -> dict:
    p = state_path(root)
    if p.exists():
        return json.loads(p.read_text())
    return {"version": 1, "galaxies": [], "nshards": DEFAULT_SHARDS, "jobs": [], "retries": {}, "flagged": {},
            "config": {}}


def save_state(root: Path, st: dict) -> None:
    atomic_write(state_path(root), json.dumps(st, indent=1, sort_keys=True))


@contextlib.contextmanager
def state_lock(root: Path):
    p = Path(root) / "_hpc" / "state.lock"
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def task_key(gid, stage, shard=None) -> str:
    return f"{gid}:{stage}" + (f":{shard}" if shard is not None else "")


# ------------------------------------------------------------------------------------------ queries
def _run(argv) -> str:
    try:
        return subprocess.run(argv, check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError) as e:
        raise RuntimeError(f"{' '.join(map(shlex.quote, argv))} failed: {e}") from e


def _expand_tasks(spec: str) -> list[int]:
    """'3' | '[0-4,7%25]' -> task ids."""
    spec = spec.strip("[]").split("%")[0]
    out = []
    for part in spec.split(","):
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return out


def squeue_tasks(jobids) -> dict:
    """{(jobid, task): state} of our queued/running array tasks."""
    if not jobids:
        return {}
    out = _run(["squeue", "-h", "-r", "-j", ",".join(jobids), "-o", "%i|%T"]) if jobids else ""
    res = {}
    for line in out.splitlines():
        if "|" not in line:
            continue
        jid, state = line.strip().split("|", 1)
        if "_" not in jid:
            continue
        base, t = jid.split("_", 1)
        for ti in _expand_tasks(t):
            res[(base, ti)] = state.strip()
    return res


def sacct_tasks(jobids) -> dict:
    """{(jobid, task): {state, exit, elapsed, maxrss_mb, totalcpu}} from sacct (array tasks, batch step RSS)."""
    if not jobids:
        return {}
    out = _run(["sacct", "-n", "-P", "-j", ",".join(jobids),
                "--format=JobID,State,ExitCode,Elapsed,MaxRSS,TotalCPU,AllocCPUS"])
    res = {}
    for line in out.splitlines():
        parts = line.split("|")
        if len(parts) < 7:
            continue
        jid, state, ex, el, rss, cpu, ncpu = parts[:7]
        step = None
        if "." in jid:
            jid, step = jid.split(".", 1)
        if "_" not in jid:
            continue
        base, t = jid.split("_", 1)
        for ti in _expand_tasks(t):
            r = res.setdefault((base, ti), {"state": "", "exit": "", "elapsed": "", "maxrss_mb": 0.0,
                                            "totalcpu": "", "cpus": ""})
            if step is None:
                r.update(state=state.split()[0] if state else "", exit=ex, elapsed=el, totalcpu=cpu, cpus=ncpu)
            if rss:
                r["maxrss_mb"] = max(r["maxrss_mb"], parse_mem_mb(rss) if rss[-1].isalpha() else int(rss) / 2**20)
    return res
