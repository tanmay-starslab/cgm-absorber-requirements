"""Compute workers. Both take jobs from the coordinator's JobQueue through leases:

LocalWorker   in-process coordinator side: one spawn ProcessPoolExecutor(max_workers=1) whose
              initializer builds a Generator and load()s the dataset once (warm). Progress travels
              child -> Manager().Queue() -> relay thread -> JobQueue -> SSE.
RemoteWorker  client for another machine (`python -m server.remote_worker`): long-polls
              /api/worker/lease over HTTPS, runs a Generator locally, posts progress/result.

Capabilities: both workers announce CAPS = ("endpoints", "fit"): they run custom-ray (endpoints)
jobs and ship fitted components (npz member `components_json`). A Phase-1 remote worker sends no
caps and is never leased an endpoints job.
"""
from __future__ import annotations
import asyncio
import importlib
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
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import numpy as np

from .jobs import CAPS

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


def generator_kwargs(settings) -> dict:
    kw = {"cutout": settings.cutout, "ion_table_dir": settings.ion_table_dir,
          "index_filename": settings.index_file}
    return {k: (str(v) if v is not None else None) for k, v in kw.items() if v is not None}


# ---------------------------------------------------------------------- child side (spawned process)
_STATE: dict = {}


def _child_init(key, spec, kwargs, pq):
    """Build + warm the Generator. Errors are kept (not raised) so the parent gets the real message
    from _child_ping instead of an opaque BrokenProcessPool."""
    st = _STATE[key] = {"gen": None, "pq": pq, "error": None}
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


def _child_run(key, job_id, geom):
    st = _STATE[key]
    if st["error"]:
        raise RuntimeError(st["error"])
    pq = st["pq"]

    def cb(stage, frac, msg=""):
        pq.put((job_id, str(stage), float(frac), str(msg)))
    return st["gen"].generate(dict(geom), progress=cb)


# ---------------------------------------------------------------------- LocalWorker
class LocalWorker:
    NAME = "local"

    def __init__(self, jobq, store, spec, gen_kwargs=None, executor="process", job_timeout_s=900.0):
        self.q, self.store, self.spec = jobq, store, spec
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
                                         initargs=(self.key, self.spec, self.kwargs, self.pq))
        else:
            ctx = mp.get_context("spawn")
            if self._mgr is None:
                self._mgr = ctx.Manager()
                self.pq = self._mgr.Queue()
            self.ex = ProcessPoolExecutor(max_workers=1, mp_context=ctx, initializer=_child_init,
                                          initargs=(self.key, self.spec, self.kwargs, self.pq))
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
            job = await self.q.lease_wait(self.NAME, timeout=5.0, lease_s=self.job_timeout_s + 60, caps=CAPS)
            if job is None:
                continue
            self.state, self.current = "busy", job.job_id
            own = dict(worker=self.NAME, token=job.lease_token)
            try:
                fut = self.ex.submit(_child_run, self.key, job.job_id, job.geom)
                payload = await asyncio.wait_for(asyncio.wrap_future(fut), self.job_timeout_s)
                if payload.get("id") not in (None, job.id):
                    raise ValueError(f"generator returned id {payload.get('id')} for {job.id}")
                payload["id"] = job.id
                if not self.q.claim(job.job_id):          # already finished elsewhere: don't persist
                    continue
                try:
                    entry = await asyncio.to_thread(self.store.add_generated, payload)
                except BaseException:
                    self.q.unclaim(job.job_id)
                    raise
                self.q.complete(job.job_id, entry, components=_stored_components(self.store, job.id))
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
            except Exception as e:
                log.exception("local job %s failed", job.job_id)
                self.q.fail(job.job_id, public_error(f"{e.__class__.__name__}: {e}"), **own)
            finally:
                self.current = None
                if self.state == "busy":
                    self.state = "warm"

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
                 gen_kwargs=None, result_timeout_s=600.0):
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
        self.caps = tuple(CAPS)
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

    def ensure_generator(self):
        if self.gen is None:
            self.gen = resolve_factory(self.gen_spec)(**self.gen_kwargs)
        log.info("loading dataset ...")
        self.gen.load(progress=lambda s, f, m="": log.info("load %s %.0f%% %s", s, 100 * f, m))

    def lease(self):
        body = {"name": self.name, **({"caps": list(self.caps)} if self.caps else {})}
        r = self._post(f"/api/worker/lease?wait={self.poll_s:g}", tries=1, json=body)
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
            payload = self.gen.generate(dict(geom), progress=send)
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
    """Exact-schema npz bytes via tngsight.library.save_npz (through a temp file), plus (with_components)
    one extra member `components_json` (0-d unicode, compact JSON) when payload["components"] exists, or
    JSON null when the fit was attempted and failed (payload["components_skipped"]). with_components=False
    gives the exact Phase-1 key set (a coordinator that did not accept the "fit" cap)."""
    from tngsight.library import save_npz
    fd, tmp = tempfile.mkstemp(suffix=".npz", dir=workdir)
    os.close(fd)
    try:
        save_npz(tmp, payload["geom"], payload["logN"], payload["tau"])
        comps = payload.get("components")
        if with_components and (comps is not None or payload.get("components_skipped")):
            buf = io.BytesIO()
            text = json.dumps(comps, separators=(",", ":"), allow_nan=False, default=_json_num)
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


