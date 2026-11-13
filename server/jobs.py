"""In-memory job queue: dedupe by sightline id, FIFO positions, worker leases with expiry/requeue,
and SSE fan-out. Jobs of non-default galaxies carry geom["galaxy"]; they may wait in PREPARING while
the coordinator fetches that galaxy's cutout, and only workers with the "galaxies" cap lease them.
State is guarded by a threading.Lock (the LocalWorker progress relay runs in a thread); subscribers
are asyncio queues fed with loop.call_soon_threadsafe."""
from __future__ import annotations
import asyncio
import threading
import time
import uuid
from dataclasses import dataclass, field

QUEUED, RUNNING, DONE, ERROR = "queued", "running", "done", "error"
PREPARING = "preparing"                              # waiting for its galaxy's data (cutout fetch), not leasable
JOB_ID_RE = r"^[0-9a-f]{32}$"
ORIENTATION, ENDPOINTS = "orientation", "endpoints"   # job kinds
GALAXIES = "galaxies"                                # cap: runs jobs of non-default galaxies (geom["galaxy"])
CAPS = ("endpoints", "fit", GALAXIES)                # worker capabilities (Phase-1 workers send none)


def job_kind(geom: dict) -> str:
    return ENDPOINTS if geom.get("kind") == ENDPOINTS else ORIENTATION


def job_galaxy(geom: dict):
    """The job's galaxy id, None for the default galaxy (the coordinator only sets geom["galaxy"] for others)."""
    g = geom.get("galaxy")
    return str(g) if g not in (None, "") else None


def job_key(geom: dict) -> str:
    """Dedupe key: the sightline id for the default galaxy (unchanged), "<galaxy>:<id>" for any other."""
    g = job_galaxy(geom)
    return geom["id"] if g is None else f"{g}:{geom['id']}"


def can_run(kind: str, caps, galaxy=None) -> bool:
    """A worker without the "endpoints" capability only runs orientation jobs; one without "galaxies"
    only runs jobs of the default galaxy (galaxy None)."""
    caps = caps or ()
    return (kind != ENDPOINTS or ENDPOINTS in caps) and (galaxy is None or GALAXIES in caps)


class QueueFull(Exception):
    pass


class TooManySubscribers(Exception):
    pass


@dataclass
class Job:
    id: str                       # sightline id (canonical geom_id or cust_ id)
    geom: dict                    # canonicalize() / canonicalize_endpoints() output
    kind: str = ORIENTATION       # "orientation" | "endpoints"
    galaxy: str | None = None     # None = the default galaxy
    job_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    status: str = QUEUED
    stage: str = "queued"
    frac: float = 0.0
    msg: str = ""
    error: str | None = None
    entry: dict | None = None
    components: dict | None = None
    attempts: int = 0
    worker: str | None = None
    lease_token: str | None = None # per-lease secret; progress/fail must present the current one
    finishing: bool = False        # claimed by a result upload that is being persisted
    lease_until: float = 0.0
    started: float = 0.0
    created: float = field(default_factory=time.time)
    finished: float = 0.0
    prepare_since: float = 0.0

    def public(self, position=None) -> dict:
        return {"job_id": self.job_id, "id": self.id, "kind": self.kind, "galaxy": self.galaxy, "status": self.status,
                "stage": self.stage, "frac": round(float(self.frac), 4), "msg": self.msg, "position": position,
                "error": self.error, "entry": self.entry, "components": self.components,
                "attempts": self.attempts}


class JobQueue:
    def __init__(self, lease_s=120.0, max_attempts=2, cap=30, job_timeout_s=900.0, ttl_s=3600.0,
                 clock=time.time, queue_ttl_s=None, max_subs=16, prepare_ttl_s=None):
        self.lease_s, self.max_attempts, self.cap = lease_s, max_attempts, cap
        self.job_timeout_s, self.ttl_s, self.clock = job_timeout_s, ttl_s, clock
        self.queue_ttl_s, self.max_subs = queue_ttl_s, max_subs   # queue_ttl_s None: queued jobs never expire
        self.prepare_ttl_s = prepare_ttl_s                         # None: preparing jobs never expire
        self.jobs: dict[str, Job] = {}
        self.inflight: dict[str, str] = {}     # job_key (id, or "<galaxy>:<id>") -> job_id (preparing/queued/running)
        self.order: list[str] = []             # queued job_ids, FIFO
        self.workers: dict[str, tuple] = {}    # remote worker name -> (last_seen epoch, caps tuple)
        self._subs: dict[str, list] = {}       # job_id -> [(loop, asyncio.Queue)]
        self._waiters: list = []               # (loop, asyncio.Event) of lease long-polls
        self._lock = threading.RLock()

    # ---------------------------------------------------------------- submit / query
    def submit(self, geom: dict, preparing: bool = False) -> tuple[Job, bool]:
        """Enqueue a canonical geometry. Returns (job, created); same (galaxy, id) in flight -> same job.
        preparing=True parks a new job in PREPARING (not leasable) until prepared(galaxy) queues it or
        prepare_failed(galaxy, msg) errs it; a job joined by dedupe keeps its state."""
        key = job_key(geom)
        with self._lock:
            jid = self.inflight.get(key)
            if jid:
                return self.jobs[jid], False
            if len(self.inflight) >= self.cap:
                raise QueueFull(f"queue full ({self.cap} jobs)")
            job = Job(id=geom["id"], geom=dict(geom), kind=job_kind(geom), galaxy=job_galaxy(geom),
                      created=self.clock())
            self.jobs[job.job_id] = job
            self.inflight[key] = job.job_id
            if preparing:
                job.status, job.stage, job.msg = PREPARING, "preparing", f"preparing galaxy {job.galaxy}"
                job.prepare_since = job.created
            else:
                self.order.append(job.job_id)
                pos = len(self.order)
        if preparing:
            self._emit(job.job_id, "preparing", {"galaxy": job.galaxy, "msg": job.msg})
            return job, True
        self._emit(job.job_id, "queued", {"position": pos})
        self._wake()
        return job, True

    def _key(self, j) -> str:
        return j.id if j.galaxy is None else f"{j.galaxy}:{j.id}"

    def prepared(self, galaxy) -> list:
        """The galaxy's data is ready: queue its PREPARING jobs (submission order). Returns their job ids."""
        with self._lock:
            ids = [k for k, j in self.jobs.items() if j.status == PREPARING and j.galaxy == galaxy]
            ids.sort(key=lambda k: self.jobs[k].created)
            for k in ids:
                j = self.jobs[k]
                j.status, j.stage, j.msg = QUEUED, "queued", ""
                self.order.append(k)
            rest = list(self.order)
        if ids:
            self._emit_positions(rest)
            self._wake()
        return ids

    def prepare_failed(self, galaxy, message) -> list:
        """The galaxy's data could not be prepared: err its PREPARING jobs."""
        now = self.clock()
        with self._lock:
            ids = [k for k, j in self.jobs.items() if j.status == PREPARING and j.galaxy == galaxy]
            for k in ids:
                self._err(self.jobs[k], message, now)
        for k in ids:
            self._emit(k, "error", {"message": self.jobs[k].error})
        return ids

    def preparing_progress(self, galaxy, msg) -> None:
        """Relay a fetch status line to the galaxy's PREPARING jobs (SSE "preparing")."""
        with self._lock:
            ids = [k for k, j in self.jobs.items() if j.status == PREPARING and j.galaxy == galaxy]
            for k in ids:
                self.jobs[k].msg = str(msg)[:200]
        for k in ids:
            self._emit(k, "preparing", {"galaxy": galaxy, "msg": str(msg)[:200]})

    def active_galaxies(self) -> set:
        """Non-default galaxies with a job preparing, queued or running (their cutouts must stay cached)."""
        with self._lock:
            return {j.galaxy for j in self.jobs.values()
                    if j.galaxy is not None and j.status in (PREPARING, QUEUED, RUNNING)}

    def _err(self, j, message, now):                   # caller holds the lock
        j.status, j.error, j.stage, j.finished = ERROR, str(message)[:500], "error", now
        self.inflight.pop(self._key(j), None)

    def get(self, job_id) -> Job | None:
        with self._lock:
            return self.jobs.get(job_id)

    def position(self, job_id):
        with self._lock:
            try:
                return self.order.index(job_id) + 1
            except ValueError:
                return None

    def snapshot(self, job_id) -> dict | None:
        with self._lock:
            j = self.jobs.get(job_id)
            return None if j is None else j.public(self.position(job_id))

    def counts(self) -> dict:
        with self._lock:
            run = sum(1 for j in self.jobs.values() if j.status == RUNNING)
            prep = sum(1 for j in self.jobs.values() if j.status == PREPARING)
            return {"queued": len(self.order), "running": run, "preparing": prep}

    # ---------------------------------------------------------------- leases
    def lease(self, worker: str, lease_s=None, caps=()) -> Job | None:
        """Pop the oldest queued job `worker` can run with its `caps` (non-blocking)."""
        with self._lock:
            jid = next((k for k in self.order if can_run(self.jobs[k].kind, caps, self.jobs[k].galaxy)), None)
            if jid is None:
                return None
            self.order.remove(jid)
            j = self.jobs[jid]
            now = self.clock()
            j.status, j.worker, j.attempts = RUNNING, worker, j.attempts + 1
            j.lease_token = uuid.uuid4().hex
            j.stage, j.frac, j.msg = "leased", 0.0, f"assigned to {worker}"
            j.started, j.lease_until = now, now + (lease_s or self.lease_s)
            rest = list(self.order)
        self._emit(jid, "progress", {"stage": j.stage, "frac": 0.0, "msg": j.msg})
        self._emit_positions(rest)                        # everyone behind moves up one
        return j

    async def lease_wait(self, worker: str, timeout: float, lease_s=None, caps=()) -> Job | None:
        """Long-poll: lease a job, waiting up to `timeout` s for one to be submitted."""
        end = time.monotonic() + max(0.0, timeout)
        loop = asyncio.get_running_loop()
        ev = asyncio.Event()
        item = (loop, ev)
        with self._lock:
            self._waiters.append(item)
        try:
            while True:
                j = self.lease(worker, lease_s, caps)
                left = end - time.monotonic()
                if j is not None or left <= 0:
                    return j
                ev.clear()
                try:
                    await asyncio.wait_for(ev.wait(), timeout=min(left, 1.0))
                except asyncio.TimeoutError:
                    pass
        finally:
            with self._lock:
                if item in self._waiters:
                    self._waiters.remove(item)

    def touch_worker(self, name, caps=None):
        """Mark a remote worker seen; `caps` None keeps the capabilities it last announced."""
        with self._lock:
            old = self.workers.get(name, (0.0, ()))[1]
            self.workers[name] = (self.clock(), tuple(old if caps is None else caps))

    def worker_caps(self, name) -> tuple:
        with self._lock:
            return self.workers.get(name, (0.0, ()))[1]

    def live_workers(self, seen_s, now=None) -> dict:
        """{name: caps} of remote workers seen within `seen_s` seconds."""
        now = self.clock() if now is None else now
        with self._lock:
            return {n: c for n, (t, c) in self.workers.items() if now - t < seen_s}

    def _owns(self, j, worker, token) -> bool:
        return (worker is None or j.worker == worker) and (token is None or j.lease_token == token)

    def progress(self, job_id, stage, frac, msg="", worker=None, token=None) -> bool:
        """Record progress (also extends the lease). False if the job is not running, or not under
        this `worker` / lease `token` (a stale worker must not extend or overwrite a newer lease)."""
        with self._lock:
            j = self.jobs.get(job_id)
            if j is None or j.status != RUNNING or not self._owns(j, worker, token):
                return False
            j.stage, j.frac, j.msg = str(stage)[:40], float(min(max(frac, 0.0), 1.0)), str(msg)[:200]
            j.lease_until = max(j.lease_until, self.clock() + self.lease_s)
        self._emit(job_id, "progress", {"stage": j.stage, "frac": j.frac, "msg": j.msg})
        return True

    def claim(self, job_id) -> bool:
        """Reserve a job for a result that is about to be persisted, so no other result, failure or
        reaper expiry can finish it meanwhile. A queued job (late result after a requeue) leaves the
        queue. False if the job is unknown, finished or already claimed. Follow with complete()
        or, if persisting fails, unclaim()."""
        with self._lock:
            j = self.jobs.get(job_id)
            if j is None or j.status in (DONE, ERROR) or j.finishing:
                return False
            j.finishing = True
            moved = job_id in self.order
            if moved:
                self.order.remove(job_id)
            rest = list(self.order)
        if moved:
            self._emit_positions(rest)
        return True

    def unclaim(self, job_id):
        """Undo claim(): a queued job goes back to the front of the queue."""
        with self._lock:
            j = self.jobs.get(job_id)
            if j is None or not j.finishing:
                return
            j.finishing = False
            if j.status == QUEUED and job_id not in self.order:
                self.order.insert(0, job_id)
            rest = list(self.order) if j.status == QUEUED else None
        if rest is not None:
            self._emit_positions(rest)
            self._wake()

    def complete(self, job_id, entry: dict, components: dict | None = None) -> bool:
        """Mark done (first valid result wins, even from a worker whose lease was reassigned)."""
        with self._lock:
            j = self.jobs.get(job_id)
            if j is None or j.status in (DONE, ERROR):
                return False
            moved = job_id in self.order
            if moved:
                self.order.remove(job_id)
            j.status, j.stage, j.frac, j.msg, j.entry = DONE, "done", 1.0, "ready", entry
            j.components = components
            j.finished, j.finishing, j.lease_token = self.clock(), False, None
            self.inflight.pop(self._key(j), None)
            rest = list(self.order)
        self._emit(job_id, "done", {"id": j.id, "entry": entry, "components": components})
        if moved:
            self._emit_positions(rest)
        return True

    def fail(self, job_id, message, worker=None, retry=True, token=None) -> str | None:
        """Worker-reported failure or expiry. Requeues (front) while attempts < max, else error.
        Returns the new status, or None if the job was not running (by `worker` / lease `token`)
        or a result for it is being persisted."""
        with self._lock:
            j = self.jobs.get(job_id)
            if j is None or j.status != RUNNING or j.finishing or not self._owns(j, worker, token):
                return None
            j.lease_token = None
            if retry and j.attempts < self.max_attempts:
                j.status, j.worker, j.stage, j.frac = QUEUED, None, "queued", 0.0
                j.msg = f"retrying after: {message}"[:200]
                self.order.insert(0, j.job_id)
                new, rest = QUEUED, list(self.order)
            else:
                j.status, j.error, j.stage = ERROR, str(message)[:500], "error"
                j.finished = self.clock()
                self.inflight.pop(self._key(j), None)
                new = ERROR
        if new == QUEUED:
            self._emit_positions(rest)                    # the requeued job is 1, everyone else moves down
            self._wake()
        else:
            self._emit(job_id, "error", {"message": j.error})
        return new

    def expire_queued(self, message, older_than=0.0, now=None, kind=None, galaxies=False) -> list:
        """Error every queued job that has waited more than `older_than` s (e.g. no worker left);
        `kind` (e.g. ENDPOINTS) limits it to jobs of that kind (no worker with the cap left), galaxies=True
        to jobs of non-default galaxies (no worker with the "galaxies" cap left)."""
        now = self.clock() if now is None else now
        with self._lock:
            gone = [jid for jid in self.order if not self.jobs[jid].finishing
                    and (kind is None or self.jobs[jid].kind == kind)
                    and (not galaxies or self.jobs[jid].galaxy is not None)
                    and now - self.jobs[jid].created > older_than]
            for jid in gone:
                j = self.jobs[jid]
                self.order.remove(jid)
                self._err(j, message, now)
            rest = list(self.order)
        for jid in gone:
            self._emit(jid, "error", {"message": self.jobs[jid].error})
        if gone:
            self._emit_positions(rest)
        return gone

    def reap(self, now=None):
        """Requeue/err running jobs whose lease expired or that exceeded the job timeout; err queued
        jobs older than queue_ttl_s; forget finished jobs older than ttl."""
        now = self.clock() if now is None else now
        if self.queue_ttl_s is not None:
            self.expire_queued("waited too long in the queue; please resubmit", self.queue_ttl_s, now)
        if self.prepare_ttl_s is not None:
            with self._lock:
                stale = [j for j in self.jobs.values() if j.status == PREPARING
                         and now - j.prepare_since > self.prepare_ttl_s]
                for j in stale:
                    self._err(j, "preparing the galaxy took too long; please try again later", now)
            for j in stale:
                self._emit(j.job_id, "error", {"message": j.error})
        with self._lock:
            expired = [j.job_id for j in self.jobs.values() if j.status == RUNNING and not j.finishing
                       and (j.lease_until < now or now - j.started > self.job_timeout_s)]
            old = [k for k, j in self.jobs.items() if j.status in (DONE, ERROR)
                   and now - j.finished > self.ttl_s]
            for k in old:
                del self.jobs[k]
                self._subs.pop(k, None)
        for jid in expired:
            j = self.jobs[jid]
            timed_out = now - j.started > self.job_timeout_s
            self.fail(jid, "job timeout" if timed_out else f"lease expired (worker {j.worker})")
        return expired

    # ---------------------------------------------------------------- SSE fan-out
    def subscribe(self, job_id) -> asyncio.Queue:
        """Raises TooManySubscribers past `max_subs` streams on one job."""
        q = asyncio.Queue()
        with self._lock:
            subs = self._subs.setdefault(job_id, [])
            if self.max_subs is not None and len(subs) >= self.max_subs:
                raise TooManySubscribers(f"too many event streams for this job ({self.max_subs})")
            subs.append((asyncio.get_running_loop(), q))
        return q

    def subscribers(self, job_id) -> int:
        with self._lock:
            return len(self._subs.get(job_id, ()))

    def unsubscribe(self, job_id, q):
        with self._lock:
            subs = self._subs.get(job_id, [])
            self._subs[job_id] = [s for s in subs if s[1] is not q]
            if not self._subs[job_id]:
                self._subs.pop(job_id, None)

    def _emit_positions(self, order):
        """Send every queued job its current 1-based position (after any change to the order)."""
        for i, jid in enumerate(order):
            self._emit(jid, "queued", {"position": i + 1})

    def _emit(self, job_id, event, data):
        with self._lock:
            subs = list(self._subs.get(job_id, []))
        for loop, q in subs:
            try:
                loop.call_soon_threadsafe(q.put_nowait, (event, data))
            except RuntimeError:          # loop closed
                pass

    def _wake(self):
        with self._lock:
            ws = list(self._waiters)
        for loop, ev in ws:
            try:
                loop.call_soon_threadsafe(ev.set)
            except RuntimeError:
                pass
