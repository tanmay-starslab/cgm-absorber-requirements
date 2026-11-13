"""Compute workers. Both take jobs from the coordinator's JobQueue through leases:

LocalWorker   in-process coordinator side: one spawn ProcessPoolExecutor(max_workers=1) whose
              initializer builds a Generator and load()s the dataset once (warm). Progress travels
              child -> Manager().Queue() -> relay thread -> JobQueue -> SSE.
RemoteWorker  client for another machine (`python -m server.remote_worker`): long-polls
              /api/worker/lease over HTTPS, runs a Generator locally, posts progress/result.

Capabilities: both workers announce "endpoints" and "fit": they run custom-ray (endpoints) jobs and
ship fitted components (npz member `components_json`). A Phase-1 remote worker sends no caps and is
never leased an endpoints job. "galaxies" (jobs of non-default galaxies, geom["galaxy"]): the local
worker has it when the coordinator gives it a GalaxyHub, a remote worker when started with a galaxy
directory (<dir>/<id>/cutout_slim_R400.hdf5, the pipeline's data root layout). Either keeps at most
`max_warm` non-default datasets loaded besides the default one (least recently used dropped first).
"""
from __future__ import annotations
import asyncio
import contextlib
import gc
import importlib
import inspect
import io
import json
import logging
import multiprocessing as mp
import os
import queue as _queue
import re
import tempfile
import threading
import time
import uuid
import zipfile
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import numpy as np

from .galaxies import GalaxyUnavailable
from .jobs import CAPS, GALAXIES

log = logging.getLogger("tngsight.server")
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")     # same pattern the coordinator's LeaseReq enforces
_CLS_RE = re.compile(r"^\s*([A-Za-z_][\w.]{0,80}):")


def public_error(message, what="generation failed") -> str:
    """Public (API/SSE) form of an exception message: a fixed category plus the exception class.
    The full text (which often names local paths) only goes to the server log."""
    m = _CLS_RE.match(str(message))
    return f"{what} ({m.group(1).rsplit('.', 1)[-1]})" if m else what


class FatalLeaseError(RuntimeError):
    """The coordinator answered the lease request with a status retrying cannot fix."""


def resolve_factory(spec):
    """'module:attr' -> callable (strings stay picklable for the spawn child); callables pass through."""
    if callable(spec):
        return spec
    mod, _, attr = str(spec).partition(":")
    return getattr(importlib.import_module(mod), attr or "Generator")


def _takes_galaxy(factory) -> bool:
    """The factory accepts galaxy=<record> (a named parameter, or **kwargs as subclass wrappers have)."""
    try:
        ps = inspect.signature(factory).parameters
    except (TypeError, ValueError):
        return False
    return "galaxy" in ps or any(p.kind is inspect.Parameter.VAR_KEYWORD for p in ps.values())


@contextlib.contextmanager
def selected_galaxy(record):
    """tngsight.config.GALAXY = the job galaxy's record while a Generator that predates the galaxy= argument
    loads its dataset: tngsight.generate.yt_load_kwargs reads the yt bounding box of unwrapped (box-boundary) slim
    cutouts from config.GALAXY, which in a VM worker is the default galaxy (review2 F1: 372754, 372755, 438148,
    525533, 526478, 535050, 546114, 559386, 580250). No-op without a record."""
    if not record:
        yield
        return
    from tngsight import config
    old = config.GALAXY
    config.GALAXY = {**old, **record} if isinstance(old, dict) else dict(record)
    if not record.get("yt_bounding_box_ckpch"):
        config.GALAXY.pop("yt_bounding_box_ckpch", None)
    try:
        yield
    finally:
        config.GALAXY = old


def run_geom(geom: dict) -> dict:
    """The dict a Generator gets: the job geom minus the coordinator's "galaxy" routing key."""
    return {k: v for k, v in geom.items() if k != "galaxy"}


class GalaxyGenerators:
    """Generators of non-default galaxies, at most `max_warm` kept loaded (LRU; 0 = drop after each job).
    spec = {"id", "record", "cutout", "index_filename"}; the factory gets cutout/index_filename (and
    galaxy=<record> when it takes that argument) on top of the default kwargs."""

    def __init__(self, factory_spec, kwargs, max_warm=1):
        self.spec, self.kwargs, self.max_warm = factory_spec, dict(kwargs or {}), int(max_warm)
        self.gens: OrderedDict = OrderedDict()           # gid -> (cutout path, generator)

    def get(self, gal: dict, progress=None):
        gid = gal["id"]
        hit = self.gens.get(gid)
        if hit is not None and hit[0] == gal["cutout"]:
            self.gens.move_to_end(gid)
            return hit[1]
        self.gens.pop(gid, None)
        while self.gens and len(self.gens) >= max(1, self.max_warm):
            self.gens.popitem(last=False)
            gc.collect()
        fac = resolve_factory(self.spec)
        kw = {**self.kwargs, "cutout": gal["cutout"]}
        if gal.get("index_filename"):
            kw["index_filename"] = gal["index_filename"]
        takes = _takes_galaxy(fac)
        if takes:
            kw["galaxy"] = gal.get("record")
        gen = fac(**kw)
        cb = progress or (lambda *a: None)
        with contextlib.nullcontext() if takes else selected_galaxy(gal.get("record")):
            gen.load(progress=lambda stage, frac, msg="": cb("load", float(frac), f"galaxy {gid}: {msg}"[:200]))
        self.gens[gid] = (gal["cutout"], gen)
        return gen

    def done(self):
        if self.max_warm < 1 and self.gens:
            self.gens.clear()
            gc.collect()

    def warm(self) -> list:
        return list(self.gens)


def generator_kwargs(settings) -> dict:
    kw = {"cutout": settings.cutout, "ion_table_dir": settings.ion_table_dir,
          "index_filename": settings.index_file}
    return {k: (str(v) if v is not None else None) for k, v in kw.items() if v is not None}


# ---------------------------------------------------------------------- child side (spawned process)
_STATE: dict = {}


def _child_init(key, spec, kwargs, pq, max_warm=1):
    """Build + warm the Generator. Errors are kept (not raised) so the parent gets the real message
    from _child_ping instead of an opaque BrokenProcessPool."""
    st = _STATE[key] = {"gen": None, "pq": pq, "error": None,
                        "gals": GalaxyGenerators(spec, kwargs, max_warm)}
    try:
        st["gen"] = resolve_factory(spec)(**kwargs)
        st["gen"].load(progress=lambda stage, frac, msg="": pq.put((None, stage, float(frac), str(msg))))
    except BaseException as e:
        st["error"] = f"{e.__class__.__name__}: {e}"


def _child_ping(key):
    st = _STATE.get(key)
    if st is None or st["error"]:
        raise RuntimeError(st["error"] if st else "worker not initialised")
    return os.getpid()


def _child_run(key, job_id, geom, gal=None):
    """Run one job; returns (payload, warm non-default galaxy ids)."""
    st = _STATE[key]
    if st["error"]:
        raise RuntimeError(st["error"])
    pq = st["pq"]

    def cb(stage, frac, msg=""):
        pq.put((job_id, str(stage), float(frac), str(msg)))
    gals = st["gals"]
    try:
        gen = st["gen"] if gal is None else gals.get(gal, cb)
        payload = gen.generate(run_geom(geom), progress=cb)
    finally:
        gals.done()
    return payload, gals.warm()


# ---------------------------------------------------------------------- LocalWorker
class LocalWorker:
    NAME = "local"

    def __init__(self, jobq, store, spec, gen_kwargs=None, executor="process", job_timeout_s=900.0,
                 galaxies=None, max_warm=1, prepare_timeout_s=3600.0):
        self.q, self.store, self.spec = jobq, store, spec
        self.hub, self.max_warm, self.prepare_timeout_s = galaxies, int(max_warm), float(prepare_timeout_s)
        self.caps = tuple(CAPS) if galaxies is not None else tuple(c for c in CAPS if c != GALAXIES)
        self.warm_galaxies: list = []          # non-default galaxies loaded in the child (cutouts pinned)
        self.current_galaxy = None
        self.kwargs, self.mode, self.job_timeout_s = dict(gen_kwargs or {}), executor, job_timeout_s
        self.key = uuid.uuid4().hex
        self.state, self.error, self.current, self.pid, self.load_msg = "starting", None, None, None, ""
        self.ex = self.pq = self._mgr = None
        self._task = self._relay = None
        self._stop = threading.Event()

    # -- lifecycle
    def _make_executor(self):
        self.state, self.error = "starting", None
        if self.mode == "thread":
            self.pq = _queue.Queue()
            self.ex = ThreadPoolExecutor(1, initializer=_child_init,
                                         initargs=(self.key, self.spec, self.kwargs, self.pq, self.max_warm))
        else:
            ctx = mp.get_context("spawn")
            if self._mgr is None:
                self._mgr = ctx.Manager()
                self.pq = self._mgr.Queue()
            self.ex = ProcessPoolExecutor(max_workers=1, mp_context=ctx, initializer=_child_init,
                                          initargs=(self.key, self.spec, self.kwargs, self.pq, self.max_warm))
        self.warm_galaxies = []
        return self.ex.submit(_child_ping, self.key)   # completes once the initializer (load) ran

    def start(self):
        warm = self._make_executor()
        self._relay = threading.Thread(target=self._relay_loop, name="progress-relay", daemon=True)
        self._relay.start()
        self._task = asyncio.get_running_loop().create_task(self._loop(warm))

    async def stop(self):
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._kill()
        if self._mgr is not None:
            try:
                self._mgr.shutdown()
            except Exception:
                pass

    def _kill(self):
        ex, self.ex = self.ex, None
        if ex is None:
            return
        for p in list((getattr(ex, "_processes", None) or {}).values()):
            try:
                p.terminate()
            except Exception:
                pass
        ex.shutdown(wait=False, cancel_futures=True)

    async def _warm(self, fut) -> bool:
        try:
            self.pid = await asyncio.wrap_future(fut)
            self.state = "warm"
            return True
        except Exception as e:
            full = str(e) if isinstance(e, RuntimeError) else f"{e.__class__.__name__}: {e}"
            self.state, self.error = "error", public_error(full, "dataset unavailable")
            log.error("local worker failed to warm: %s", full)
            return False

    # -- main loop
    async def _loop(self, warm_fut):
        ok = await self._warm(warm_fut)
        while not self._stop.is_set():
            if not ok:                       # broken init: retry warming every 60 s
                await asyncio.sleep(60)
                self._kill()
                ok = await self._warm(self._make_executor())
                continue
            job = await self.q.lease_wait(self.NAME, timeout=5.0, lease_s=self.job_timeout_s + 60, caps=self.caps)
            if job is None:
                continue
            self.state, self.current, self.current_galaxy = "busy", job.job_id, job.galaxy
            own = dict(worker=self.NAME, token=job.lease_token)
            try:
                gal = await self._galaxy(job)
                fut = self.ex.submit(_child_run, self.key, job.job_id, job.geom, gal)
                payload, self.warm_galaxies = await asyncio.wait_for(asyncio.wrap_future(fut), self.job_timeout_s)
                if payload.get("id") not in (None, job.id):
                    raise ValueError(f"generator returned id {payload.get('id')} for {job.id}")
                payload["id"] = job.id
                if not self.q.claim(job.job_id):          # already finished elsewhere: don't persist
                    continue
                st = self.store if job.galaxy is None else self.hub.store(job.galaxy)
                try:
                    entry = await asyncio.to_thread(st.add_generated, payload)
                except BaseException:
                    self.q.unclaim(job.job_id)
                    raise
                self.q.complete(job.job_id, entry, components=_stored_components(st, job.id))
            except asyncio.TimeoutError:
                self.q.fail(job.job_id, f"local job timeout ({self.job_timeout_s:.0f} s)", retry=False, **own)
                self._kill()
                ok = await self._warm(self._make_executor())
            except BrokenProcessPool as e:
                log.error("local worker crashed on job %s: %s", job.job_id, e)
                self.q.fail(job.job_id, "local worker crashed", **own)
                self._kill()
                ok = await self._warm(self._make_executor())
            except asyncio.CancelledError:
                self.q.fail(job.job_id, "server shutting down", **own)
                raise
            except GalaxyUnavailable as e:             # its data cannot be had now: retrying will not help
                log.warning("local job %s: galaxy %s unavailable: %s", job.job_id, job.galaxy, e)
                self.q.fail(job.job_id, str(e), retry=False, **own)
            except Exception as e:
                log.exception("local job %s failed", job.job_id)
                self.q.fail(job.job_id, public_error(f"{e.__class__.__name__}: {e}"), **own)
            finally:
                self.current = self.current_galaxy = None
                if self.state == "busy":
                    self.state = "warm"
                if self.hub is not None and job.galaxy is not None:
                    try:                       # a dataset the child just dropped may unpin an over-cap cutout
                        await asyncio.to_thread(self.hub.cache.evict)
                    except Exception:
                        log.exception("cutout cache eviction")

    async def _galaxy(self, job):
        """The worker spec of a non-default galaxy's job (None for the default galaxy). The coordinator
        prepared the cutout before queueing; if it was evicted meanwhile it is fetched again here."""
        if job.galaxy is None:
            return None
        if self.hub is None:
            raise RuntimeError("this worker serves the default galaxy only")
        if not self.hub.has_cutout(job.galaxy):
            self.q.progress(job.job_id, "preparing", 0.0, f"preparing galaxy {job.galaxy}", worker=self.NAME)
            await asyncio.to_thread(self.hub.cache.ensure, job.galaxy, self.prepare_timeout_s)
        return await asyncio.to_thread(self.hub.worker_spec, job.galaxy)

    def pinned(self) -> set:
        """Galaxies whose cutouts this worker has open or is about to open."""
        return set(self.warm_galaxies) | ({self.current_galaxy} if self.current_galaxy else set())

    def _relay_loop(self):
        while not self._stop.is_set():
            try:
                item = self.pq.get(timeout=0.5) if self.pq is not None else None
            except _queue.Empty:
                continue
            except (EOFError, OSError, BrokenPipeError):
                time.sleep(0.5)
                continue
            if item is None:
                time.sleep(0.2)
                continue
            job_id, stage, frac, msg = item
            if job_id is None:              # warm-up (load) progress
                self.load_msg = f"{stage} {100 * frac:.0f}% {msg}".strip()
                continue
            self.q.progress(job_id, stage, frac, msg, worker=self.NAME)

    def status(self) -> dict:
        d = {"state": self.state, "job": self.current}
        if self.hub is not None:
            d["galaxies"] = {"warm": list(self.warm_galaxies), "max_warm": self.max_warm}
        if self.state == "starting" and self.load_msg:
            d["msg"] = self.load_msg
        if self.error:
            d["error"] = self.error
        return d


# ---------------------------------------------------------------------- RemoteWorker client
class RemoteWorker:
    """Pull jobs from a coordinator. `client` may be any httpx.Client (tests pass a TestClient)."""

    def __init__(self, coordinator, token, name=None, generator=None, client=None, poll_s=25.0,
                 heartbeat_s=30.0, max_backoff=60.0, workdir=None, gen_spec="tngsight.generate:Generator",
                 gen_kwargs=None, result_timeout_s=600.0, galaxy_dir=None, max_warm=1):
        import httpx
        self.base = coordinator.rstrip("/")
        self.name = name or f"{os.uname().nodename.split('.')[0]}-{os.getpid()}"
        if not NAME_RE.match(self.name):
            raise ValueError(f"worker name {self.name!r} must match {NAME_RE.pattern}")
        self.headers = {"Authorization": f"Bearer {token}"}
        self.client = client or httpx.Client(timeout=httpx.Timeout(poll_s + 15, connect=10))
        # the coordinator scores + saves the result before answering: allow far longer than a long-poll
        self.result_timeout = httpx.Timeout(result_timeout_s, connect=10)
        self.poll_s, self.heartbeat_s, self.max_backoff = poll_s, heartbeat_s, max_backoff
        self.gen, self.gen_spec, self.gen_kwargs = generator, gen_spec, dict(gen_kwargs or {})
        self.workdir = workdir
        self.galaxy_dir = galaxy_dir
        self.gals = GalaxyGenerators(gen_spec, self.gen_kwargs, max_warm)
        self.caps = tuple(CAPS) if galaxy_dir else tuple(c for c in CAPS if c != GALAXIES)
        self.done = self.failed = 0
        self._stop = threading.Event()

    def _url(self, path):
        return f"{self.base}{path}"

    def _post(self, path, tries=5, **kw):
        """POST with retry/backoff on transport errors and 5xx. Returns the response (any status)."""
        delay, r = 1.0, None
        headers = {**self.headers, **kw.pop("headers", {})}
        for i in range(tries):
            try:
                r = self.client.post(self._url(path), headers=headers, **kw)
                if r.status_code < 500:
                    return r
            except Exception as e:
                log.warning("POST %s failed (try %d): %s", path, i + 1, e)
            if i < tries - 1 and self._stop.wait(delay):
                break
            delay = min(delay * 2, self.max_backoff)
        if r is None:
            raise ConnectionError(f"POST {path}: no response after {tries} tries")
        return r

    def galaxy_generator(self, gid, lease_galaxy=None, progress=None):
        """The (LRU-warm) generator of a non-default galaxy from <galaxy_dir>/<id>/."""
        from .galaxies import CUTOUT_NAME, INDEX_NAME, META_NAME, check_galaxy, validate_record
        if not self.galaxy_dir:
            raise RuntimeError("this worker serves the default galaxy only (no galaxy directory)")
        gid = check_galaxy(gid)
        d = os.path.join(self.galaxy_dir, gid)
        cutout = os.path.join(d, CUTOUT_NAME)
        if not os.path.isfile(cutout):
            raise FileNotFoundError(f"no cutout for galaxy {gid} in the galaxy directory")
        rec = (lease_galaxy or {}).get("record")
        if rec is None and os.path.isfile(os.path.join(d, META_NAME)):
            with open(os.path.join(d, META_NAME)) as f:
                rec = json.load(f)
        rec = validate_record(rec, gid) if rec is not None else None
        return self.gals.get({"id": gid, "record": rec, "cutout": cutout,
                              "index_filename": os.path.join(d, INDEX_NAME)}, progress)

    def ensure_generator(self):
        if self.gen is None:
            self.gen = resolve_factory(self.gen_spec)(**self.gen_kwargs)
        log.info("loading dataset ...")
        self.gen.load(progress=lambda s, f, m="": log.info("load %s %.0f%% %s", s, 100 * f, m))

    def lease(self):
        body = {"name": self.name, **({"caps": list(self.caps)} if self.caps else {})}
        r = self._post(f"/api/worker/lease?wait={self.poll_s:g}", tries=1, json=body)
        if r.status_code == 422 and GALAXIES in self.caps:
            # a single-galaxy coordinator does not know the "galaxies" cap: lease without it
            log.warning("coordinator rejected the galaxies cap (HTTP 422); serving its default galaxy only")
            self.caps = tuple(c for c in self.caps if c != GALAXIES)
            r = self._post(f"/api/worker/lease?wait={self.poll_s:g}", tries=1,
                           json={"name": self.name, "caps": list(self.caps)})
        if r.status_code == 422 and self.caps:
            # a Phase-1 coordinator forbids the "caps" field: lease as a capability-less worker instead
            log.warning("coordinator rejected worker caps (HTTP 422); continuing without custom-ray support")
            self.caps = ()
            r = self._post(f"/api/worker/lease?wait={self.poll_s:g}", tries=1, json={"name": self.name})
        if r.status_code == 204:
            return None
        if r.status_code == 401:
            raise PermissionError("coordinator rejected WORKER_TOKEN (401)")
        if 300 <= r.status_code < 400 or r.status_code in (400, 403, 404, 405, 422):
            loc = r.headers.get("location", "")
            raise FatalLeaseError(f"lease: HTTP {r.status_code} {loc or r.text[:200]} "
                                  "(check --coordinator: the Space's *.hf.space URL, and --name)")
        if r.status_code != 200:
            raise ConnectionError(f"lease: HTTP {r.status_code} {r.text[:200]}")
        return r.json()

    def run_job(self, job) -> bool:
        jid, geom = job["job_id"], job["geom"]
        q = f"?lease={job['lease']}" if job.get("lease") else ""
        last = {"stage": "leased", "frac": 0.0, "msg": "", "t": 0.0}
        lock = threading.Lock()

        def send(stage, frac, msg=""):
            with lock:
                now = time.monotonic()
                changed = stage != last["stage"]
                last.update(stage=str(stage), frac=float(frac), msg=str(msg))
                if not changed and now - last["t"] < 0.5:
                    return
                last["t"] = now
            try:
                self._post(f"/api/worker/progress/{jid}{q}", tries=2,
                           json={"stage": last["stage"], "frac": last["frac"], "msg": last["msg"][:200]})
            except Exception as e:
                log.warning("progress post failed: %s", e)

        stop_hb = threading.Event()

        def heartbeat():                   # keeps the lease alive through long ray casts
            while not stop_hb.wait(self.heartbeat_s):
                with lock:
                    last["t"] = 0.0
                send(last["stage"], last["frac"], last["msg"])
        hb = threading.Thread(target=heartbeat, daemon=True)
        hb.start()
        try:
            want = job.get("registry_tag")
            if want:                          # a coordinator with another ion registry would reject the npz
                from tngsight.ions import registry_tag
                if registry_tag() != want:
                    raise RuntimeError(f"registry mismatch (worker {registry_tag()}, server {want})")
            gid = geom.get("galaxy")
            if gid in (None, ""):
                payload = self.gen.generate(run_geom(geom), progress=send)
            else:
                payload = self.galaxy_generator(str(gid), job.get("galaxy"), send).generate(run_geom(geom),
                                                                                           progress=send)
            # a Phase-1 coordinator (caps refused, see lease()) accepts only the exact npz key set
            blob = payload_to_npz_bytes(payload, self.workdir, with_components="fit" in self.caps)
        except Exception as e:
            stop_hb.set()
            log.exception("job %s failed", jid)
            self._post(f"/api/worker/fail/{jid}{q}", json={"message": f"{e.__class__.__name__}: {e}"[:500]})
            self.failed += 1
            return False
        finally:
            stop_hb.set()
            self.gals.done()
        r = self._post(f"/api/worker/result/{jid}{q}", content=blob, timeout=self.result_timeout,
                       headers={"Content-Type": "application/octet-stream"})
        ok = r.status_code == 200
        if r.status_code == 409:              # e.g. our first attempt landed but its reply timed out
            try:
                s = self.client.get(self._url(f"/api/jobs/{jid}"), headers=self.headers).json()
                ok = s.get("status") == "done" and (s.get("entry") or {}).get("id") == geom.get("id")
            except Exception as e:
                log.warning("job %s status check failed: %s", jid, e)
        log.info("job %s (%s) -> HTTP %d %s", jid, geom.get("id"), r.status_code, "" if ok else r.text[:200])
        self.done += ok
        self.failed += not ok
        return ok

    def run(self, max_jobs=None, max_idle_polls=None):
        self.ensure_generator()
        delay, idle, n = 1.0, 0, 0
        while not self._stop.is_set() and (max_jobs is None or n < max_jobs):
            try:
                job = self.lease()
                delay = 1.0
            except (PermissionError, FatalLeaseError):
                raise
            except Exception as e:
                log.warning("lease failed: %s (retry in %.0f s)", e, delay)
                if self._stop.wait(delay):
                    break
                delay = min(delay * 2, self.max_backoff)
                continue
            if job is None:
                idle += 1
                if max_idle_polls is not None and idle >= max_idle_polls:
                    break
                continue
            idle = 0
            self.run_job(job)
            n += 1
        return n

    def stop(self):
        self._stop.set()


def _stored_components(store, sid):
    try:
        d = store.components(sid)
    except Exception as e:
        log.warning("components of %s unreadable: %s", sid, e)
        return None
    return None if d is None else d["components"]


def payload_to_npz_bytes(payload, workdir=None, with_components=True) -> bytes:
    """npz v2 bytes via tngsight.library.save_npz (through a temp file), plus (with_components) one extra
    member `components_json` (0-d unicode, compact JSON): the v2 rows object {k: rows} (+ "aod" when
    payload["components_aod"] exists) when payload["components"] exists, or JSON null when the fit was
    attempted and failed (payload["components_skipped"]). with_components=False gives the bare npz v2 member
    set (a coordinator that did not accept the "fit" cap)."""
    from tngsight.library import save_npz
    from .storage import dicts_to_rows, npz_like
    fd, tmp = tempfile.mkstemp(suffix=".npz", dir=workdir)
    os.close(fd)
    try:
        save_npz(tmp, npz_like(payload))
        comps = payload.get("components")
        if with_components and (comps is not None or payload.get("components_skipped")):
            obj = None
            if comps is not None:
                obj = {k: dicts_to_rows(v) for k, v in comps.items()}
                if payload.get("components_aod"):
                    obj["aod"] = payload["components_aod"]
            buf = io.BytesIO()
            text = json.dumps(obj, separators=(",", ":"), allow_nan=False, default=_json_num)
            np.lib.format.write_array(buf, np.array(text), allow_pickle=False)
            with zipfile.ZipFile(tmp, "a", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("components_json.npy", buf.getvalue())
        with open(tmp, "rb") as f:
            return f.read()
    finally:
        os.unlink(tmp)


def _json_num(x):
    """numpy scalars from a fitter -> plain JSON numbers."""
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, np.floating):
        return float(x)
    raise TypeError(f"not JSON serialisable: {type(x).__name__}")


