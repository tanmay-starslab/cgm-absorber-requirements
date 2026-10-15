"""FastAPI coordinator for the TNG50 sightline explorer: catalog/sightline/figure API, a job queue
with SSE progress, and a lease protocol for pull-based remote workers. Run with ONE process:
`uvicorn server.app:app --workers 1` (yt is not thread-safe and the warm dataset, the job queue and
the rate-limit buckets all live in this process's memory)."""
from __future__ import annotations
import asyncio
import hashlib
import hmac
import inspect
import json
import logging
import threading
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import Annotated, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sse_starlette.sse import EventSourceResponse

from .jobs import (CAPS, DONE, ENDPOINTS, ERROR, JOB_ID_RE, QUEUED, RUNNING, JobQueue, QueueFull,
                   TooManySubscribers)
from . import chat
from .ratelimit import RateLimiter, client_ip
from .settings import VERSION, Settings
from .storage import ID_RE, HFSync, LibraryStore
from .workers import LocalWorker, generator_kwargs, public_error

import re

log = logging.getLogger("tngsight.server")
_JOB_RE = re.compile(JOB_ID_RE)
_NAME_RE = r"^[A-Za-z0-9._-]{1,64}$"
SEED_MAX = 2**32 - 1
# /api/figure accepts only what the page can send (design.md §4.2): ions from the registry (1-6), R per band
# inside the band range, S/N 2-100, half-window 10-1500 km/s, centre +-1500 km/s, noise seed 0-99999.
FIG_SEED_MAX = 99999
FIG_MAX_IONS = 6
LEASE_RE = r"^[0-9a-f]{32}$"


# ------------------------------------------------------------------------------ request models
class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GeometryReq(_M):
    orientation: str = Field(min_length=1, max_length=16)
    b_kpc: float = Field(ge=-1e4, le=1e4, allow_inf_nan=False)
    azimuth_deg: float = Field(ge=-1e5, le=1e5, allow_inf_nan=False)
    seed: Optional[int] = Field(default=None, ge=0, le=SEED_MAX)


def _reg():
    from tngsight import ions
    return ions


class FigureReq(_M):
    """v3 body; the v2 fields R_lo, R_hi, sn_hi, sn_lo and vwin are accepted for one release and mapped onto
    the uv band, S/N and vhw (normalized(), which also fills the registry defaults)."""
    id: str = Field(pattern=ID_RE.pattern, max_length=40)
    ions: Optional[list[str]] = Field(default=None, min_length=1, max_length=FIG_MAX_IONS)
    R: Optional[dict[str, list[int]]] = None
    sn: Optional[list[int]] = Field(default=None, min_length=2, max_length=2)
    vhw: Optional[int] = Field(default=None, ge=10, le=1500)
    vc: Optional[float] = Field(default=None, ge=-1500, le=1500, allow_inf_nan=False)
    R_lo: Optional[int] = None                 # legacy (v2 page)
    R_hi: Optional[int] = None
    sn_hi: Optional[int] = None
    sn_lo: Optional[int] = None
    vwin: Optional[int] = None
    intrinsic: bool = False
    seed: Optional[int] = Field(default=None, ge=0, le=FIG_SEED_MAX)
    fmt: Literal["png", "pdf"] = "png"

    @field_validator("ions")
    @classmethod
    def _ions(cls, v):
        if v is None:
            return v
        keys = _reg().KEYS
        bad = [k for k in v if k not in keys]
        if bad:
            raise ValueError(f"unknown ion {bad[0][:12]!r}; known: {', '.join(keys)}")
        if len(set(v)) != len(v):
            raise ValueError("ions must be unique")
        return [k for k in keys if k in v]                    # registry order

    @field_validator("R")
    @classmethod
    def _R(cls, v):
        if v is None:
            return v
        bands = _reg().BANDS
        for b, pair in v.items():
            if b not in bands:
                raise ValueError(f"unknown band {b[:12]!r}; known: {', '.join(bands)}")
            lo, hi = bands[b]["R"]["min"], bands[b]["R"]["max"]
            if len(pair) != 2 or not all(lo <= r <= hi for r in pair):
                raise ValueError(f"R.{b} must be two integers in [{lo}, {hi}]")
        return v

    @field_validator("sn", "sn_hi", "sn_lo")
    @classmethod
    def _sn(cls, v):
        if v is None:
            return v
        s = _reg().SNR
        if not all(s["min"] <= x <= s["max"] for x in (v if isinstance(v, list) else [v])):
            raise ValueError(f"S/N must be in [{s['min']}, {s['max']}]")
        return v

    @field_validator("R_lo", "R_hi")
    @classmethod
    def _r_legacy(cls, v):
        if v is None:
            return v
        r = _reg().BANDS["uv"]["R"]
        if not r["min"] <= v <= r["max"]:
            raise ValueError(f"R must be in [{r['min']}, {r['max']}] (uv band)")
        return v

    @field_validator("vwin")
    @classmethod
    def _vwin(cls, v):
        if v is not None and not 10 <= v <= 1500:
            raise ValueError("vwin must be in [10, 1500]")
        return v

    def normalized(self) -> dict:
        """Canonical render parameters: ions, R {band: [lo, hi]} for every band, sn [hi, lo], vhw, vc,
        intrinsic, seed. Explicit v3 fields win over the legacy ones."""
        reg = _reg()
        R = {b: list(d["R"]["pair"]) for b, d in reg.BANDS.items()}
        if self.R_lo is not None or self.R_hi is not None:
            R["uv"] = [self.R_lo if self.R_lo is not None else R["uv"][0],
                       self.R_hi if self.R_hi is not None else R["uv"][1]]
        for b, pair in (self.R or {}).items():
            R[b] = list(pair)
        sn = list(reg.SNR["pair"])
        if self.sn_hi is not None:
            sn[0] = self.sn_hi
        if self.sn_lo is not None:
            sn[1] = self.sn_lo
        if self.sn is not None:
            sn = list(self.sn)
        vhw = self.vhw if self.vhw is not None else (self.vwin if self.vwin is not None
                                                      else int(reg.DEFAULTS["vhw_kms"]))
        return {"ions": list(self.ions) if self.ions else None, "R": R, "sn": sn, "vhw": int(vhw), "vc": float(self.vc or 0.0),
                "intrinsic": bool(self.intrinsic), "seed": self.seed}


_Coord = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-1e4, le=1e4)]


class CustomReq(_M):
    """Custom ray p0 -> p1, physical kpc relative to the galaxy centre (box axes)."""
    p0_kpc: list[_Coord] = Field(min_length=3, max_length=3)
    p1_kpc: list[_Coord] = Field(min_length=3, max_length=3)


class LeaseReq(_M):
    name: str = Field(pattern=_NAME_RE)
    caps: list[Literal["endpoints", "fit"]] = Field(default_factory=list, max_length=len(CAPS))


class ProgressReq(_M):
    stage: str = Field(max_length=40)
    frac: float = Field(ge=0, le=1, allow_inf_nan=False)
    msg: str = Field(default="", max_length=200)


class FailReq(_M):
    message: str = Field(max_length=500)


# ------------------------------------------------------------------------------ ASGI middleware
class BodyLimit:
    """413 for request bodies over `limit`; `limits` maps a path prefix to its own limit (worker
    result uploads, /api/chat). The first matching prefix wins."""

    def __init__(self, app, limit, limits=None, big=None, big_prefix="/api/worker/result/"):
        self.app, self.limit = app, limit
        self.limits = dict(limits or {})
        if big is not None:                         # Phase-1 signature
            self.limits.setdefault(big_prefix, big)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        limit = next((v for k, v in self.limits.items() if scope["path"].startswith(k)), self.limit)
        cl = dict(scope.get("headers") or []).get(b"content-length")
        if cl is not None and (not cl.isdigit() or int(cl) > limit):
            return await _send_json(send, 413, {"detail": f"request body exceeds {limit} bytes"})
        seen, started = 0, False

        async def rcv():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > limit:
                    raise _TooLarge()
            return msg

        async def snd(msg):
            nonlocal started
            started = started or msg["type"] == "http.response.start"
            await send(msg)
        try:
            await self.app(scope, rcv, snd)
        except _TooLarge:
            if not started:
                await _send_json(send, 413, {"detail": f"request body exceeds {limit} bytes"})


class _TooLarge(Exception):
    pass


async def _send_json(send, status, obj):
    body = json.dumps(obj).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


class PrivateNetwork:
    """Chrome Private Network Access: answer CORS preflights with Allow-Private-Network: true."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "OPTIONS":
            return await self.app(scope, receive, send)
        hdrs = dict(scope.get("headers") or [])
        if b"access-control-request-method" not in hdrs:
            return await self.app(scope, receive, send)

        async def snd(msg):
            if msg["type"] == "http.response.start" and not any(
                    k.lower() == b"access-control-allow-private-network" for k, _ in msg.get("headers", [])):
                msg = dict(msg, headers=list(msg.get("headers", [])) +
                           [(b"access-control-allow-private-network", b"true")])
            await send(msg)
        await self.app(scope, receive, snd)


# ------------------------------------------------------------------------------ helpers
def _sid(name: str, ext: str) -> str:
    if not name.endswith(ext) or not ID_RE.fullmatch(name[: -len(ext)]):
        raise HTTPException(422, f"invalid sightline id {name[:60]!r}")
    return name[: -len(ext)]


def _job_id(job_id: str) -> str:
    if not _JOB_RE.match(job_id):
        raise HTTPException(422, "invalid job id")
    return job_id


def _limited(retry_after: float, what: str):
    s = max(1, int(retry_after + 0.999))
    return JSONResponse({"detail": f"rate limit exceeded for {what}; retry in {s} s"}, 429,
                        headers={"Retry-After": str(s)})


async def _validation_error(request: Request, exc: RequestValidationError):
    """FastAPI's 422 body, minus echoed inputs that are not valid JSON (a NaN/Infinity literal in the
    request would otherwise make the error response itself unserialisable)."""
    errs = jsonable_encoder(exc.errors())
    try:
        body = json.dumps({"detail": errs}, allow_nan=False)
    except ValueError:
        errs = [{k: v for k, v in e.items() if k not in ("input", "ctx")} for e in errs]
        body = json.dumps({"detail": errs}, allow_nan=False, default=str)
    return Response(body, status_code=422, media_type="application/json")


def _default_renderer(payload, fmt, **kw):
    from tngsight.figure import render_bytes
    return render_bytes(payload, fmt=fmt, **kw)


# ------------------------------------------------------------------------------ factory
def create_app(settings: Settings | None = None, generator=None, figure_renderer=None, hf=None) -> FastAPI:
    """`generator`: 'module:attr' spec or callable building a Generator (default settings.generator);
    `figure_renderer(payload, fmt, **kw) -> bytes` (default tngsight.figure.render_bytes);
    `hf`: an HFSync-like object (default built from HF_TOKEN/HF_DATASET)."""
    S = settings or Settings.from_env()
    if hf is None and S.hf_token and S.hf_dataset:
        hf = HFSync(S.hf_token, S.hf_dataset, S.library_dir)
    store = LibraryStore(S.library_dir, hf=hf)
    jobq = JobQueue(lease_s=S.lease_s, max_attempts=S.max_attempts, cap=S.queue_cap,
                    job_timeout_s=S.job_timeout_s, ttl_s=S.job_ttl_s, queue_ttl_s=S.queue_ttl_s,
                    max_subs=S.max_subs_per_job)
    limiter = RateLimiter({"sightlines": S.rl_sightlines, "figure": S.rl_figure,
                           "figure_all": S.rl_figure_global})
    render = figure_renderer or _default_renderer
    fig_cache: OrderedDict = OrderedDict()
    fig_lock = threading.Lock()
    fig_pending = [0]                       # renders running or waiting on fig_lock
    sse_open: dict = {}                     # client ip -> open event streams
    sse_lock = threading.Lock()
    local = LocalWorker(jobq, store, generator or S.generator, generator_kwargs(S), executor=S.local_executor,
                        job_timeout_s=S.job_timeout_s) if S.local_worker else None

    @asynccontextmanager
    async def lifespan(app):
        tasks = []

        async def reaper():
            since = {None: None, ENDPOINTS: None}       # need -> first time no such worker was seen
            msgs = {None: "no worker available; please try again later",
                    ENDPOINTS: "no worker that can cast custom rays is available; please try again later"}
            while True:
                await asyncio.sleep(S.reap_every_s)
                try:
                    jobq.reap()
                    now = time.time()
                    for need in (None, ENDPOINTS):     # capless (Phase-1) workers never run custom rays
                        if workers_available(now, need=need):
                            since[need] = None
                        elif since[need] is None:
                            since[need] = now
                        elif now - since[need] > S.no_worker_grace_s:
                            jobq.expire_queued(msgs[need], kind=need)
                except Exception:
                    log.exception("reaper")
        tasks.append(asyncio.create_task(reaper()))

        def pull():
            if hf is not None and S.hf_startup_download and hf.download() is not None:
                store.reload()
            store.reconcile()
            if hf is not None:            # re-upload anything generated that never reached the dataset
                hf.sync_missing(store.gen_dir)
        tasks.append(asyncio.create_task(asyncio.to_thread(pull)))

        def preimport():                  # scipy (scoring) can take minutes to import from a cold disk;
            try:                          # pay it at startup, not on the first generated sightline
                import tngsight.scoring  # noqa: F401
            except Exception as e:
                log.warning("tngsight.scoring unavailable: %s", e)
        tasks.append(asyncio.create_task(asyncio.to_thread(preimport)))
        if local is not None:
            local.start()
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()
            if local is not None:
                await local.stop()
            if hf is not None:
                hf.stop()

    app = FastAPI(title="TNG50 sightline explorer", version=VERSION, lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.state.settings, app.state.store, app.state.jobs, app.state.local = S, store, jobq, local
    app.state.limiter, app.state.fig_cache = limiter, fig_cache
    app.add_middleware(BodyLimit, limit=S.max_body,
                       limits={"/api/worker/result/": S.max_result, "/api/chat": S.chat_max_bytes + 4096})
    cors = dict(allow_origins=list(S.cors_origins), allow_methods=["GET", "POST", "OPTIONS"],
                allow_headers=["Content-Type", "Authorization"], max_age=600,
                expose_headers=["ETag", "Retry-After", "Content-Disposition"])
    if "allow_private_network" in inspect.signature(CORSMiddleware.__init__).parameters:
        cors["allow_private_network"] = True       # starlette >= 0.4x: PNA-aware preflight
    app.add_middleware(CORSMiddleware, **cors)
    app.add_middleware(PrivateNetwork)

    def ip(request: Request) -> str:
        return client_ip(request, S.trust_proxy, S.trusted_hops)

    def workers_available(now=None, need=None) -> bool:
        """A worker can pick up new jobs: the local one is starting/warm/busy, or a remote worker
        polled or reported within worker_seen_s (the same test /api/health uses for 'warm').
        `need` = a capability (e.g. "endpoints") the worker must have announced; the local worker
        has them all."""
        now = time.time() if now is None else now
        if local is not None and local.state in ("starting", "warm", "busy"):
            return True
        live = jobq.live_workers(S.worker_seen_s, now)
        return any(need is None or need in caps for caps in live.values())

    def worker_auth(request: Request):
        if not S.worker_token:
            raise HTTPException(404, "worker protocol disabled (WORKER_TOKEN unset)")
        h = request.headers.get("authorization", "")
        tok = h[7:] if h[:7].lower() == "bearer " else ""
        if not hmac.compare_digest(tok.encode(), S.worker_token.encode()):
            raise HTTPException(401, "bad worker token", headers={"WWW-Authenticate": "Bearer"})

    # -------------------------------------------------------------------------- public API
    @app.get("/api/health")
    def health():
        now = time.time()
        remote = [{"name": n, "last_seen": round(t, 1), "caps": list(caps)}
                  for n, (t, caps) in sorted(jobq.workers.items()) if now - t < 3600]
        lib_n, gen_n = store.sizes()
        loc = local.status() if local is not None else {"state": "disabled"}
        warm = loc["state"] in ("warm", "busy") or any(now - w["last_seen"] < S.worker_seen_s for w in remote)
        d = {"status": "ok", "version": VERSION, "warm": warm, "workers": {"local": loc, "remote": remote},
             "queue": jobq.counts(), "library_size": lib_n, "generated_size": gen_n, "node": S.node_name}
        d["chat"] = chat.health_fragment(S)
        try:
            from tngsight import ions as _ions
            d.update(registry_tag=_ions.registry_tag(), data_version=2, ions=list(_ions.KEYS))
        except Exception as e:                    # never fail the health check over the registry
            log.warning("ion registry unavailable: %s", e)
            d.update(registry_tag=None, data_version=2, ions=[])
        if hf is not None:
            d["hf"] = hf.status()
        return d

    @app.get("/api/catalog")
    def catalog(request: Request):
        body, etag = store.catalog_doc()
        hdr = {"ETag": etag, "Cache-Control": "max-age=60"}
        if etag in [t.strip() for t in request.headers.get("if-none-match", "").split(",")]:
            return Response(status_code=304, headers=hdr)
        return Response(body, media_type="application/json", headers=hdr)

    @app.get("/api/sightline/{name}")
    def sightline(name: str):
        if name.endswith(".bin"):
            sid = _sid(name, ".bin")
            blob = store.bin_bytes(sid)
            if blob is None:
                raise HTTPException(404, f"unknown sightline {sid}")
            return Response(blob, media_type="application/octet-stream",
                            headers={"Cache-Control": "public, max-age=86400"})
        sid = _sid(name, ".npz")
        p = store.npz_path(sid)
        if p is None:
            raise HTTPException(404, f"unknown sightline {sid}")
        return Response(p.read_bytes(), media_type="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="cgm_sid488530_{sid}.npz"'})

    def _canon(req: GeometryReq) -> dict:
        from tngsight.geometry import canonicalize
        try:
            return canonicalize(req.orientation, req.b_kpc, req.azimuth_deg, req.seed)
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.post("/api/geometry")
    def geometry(req: GeometryReq):
        from tngsight.geometry import make_sightline
        c = _canon(req)
        g = make_sightline(c["orientation"], c["b_kpc"], c["azimuth_deg"], seed=c["seed"])
        return {**c, "geom": json.loads(json.dumps(g, default=lambda x: x.tolist())),
                "exists": store.has(c["id"])}

    def enqueue(c: dict, request: Request, extra: dict | None = None):
        """Ready (200) / queued-or-deduped (202) / refused (429, 503) for a canonical geometry.
        Orientation and custom rays share the queue, the dedupe and the "sightlines" rate bucket."""
        extra = extra or {}
        e = store.entry(c["id"])
        if e is not None:
            return {"id": c["id"], "status": "ready", "entry": e, **extra}
        jid = jobq.inflight.get(c["id"])
        if jid is None:                       # only new work is rate-limited / capped
            if not S.generation_possible:
                return JSONResponse({"detail": "generation disabled on this node (no local or remote workers)"},
                                    503, headers={"Retry-After": "60"})
            if c.get("kind") == ENDPOINTS:
                if not workers_available(need=ENDPOINTS):
                    return JSONResponse({"detail": "no worker that supports custom rays is available"}, 503,
                                        headers={"Retry-After": "60"})
            elif not workers_available():
                return JSONResponse({"detail": "no worker available right now"}, 503, headers={"Retry-After": "60"})
            wait = limiter.check("sightlines", ip(request))
            if wait:
                return _limited(wait, "new sightlines")
        try:
            job, created = jobq.submit(c)
        except QueueFull as e:
            if jid is None:
                limiter.refund("sightlines", ip(request))      # refused: don't charge the caller
            return JSONResponse({"detail": str(e)}, 503, headers={"Retry-After": "60"})
        if jid is None and not created:       # raced into an existing job: not new work after all
            limiter.refund("sightlines", ip(request))
        snap = jobq.snapshot(job.job_id)
        return JSONResponse({"id": c["id"], "job_id": job.job_id, "status": snap["status"],
                             "position": snap["position"], **extra}, 202)

    @app.post("/api/sightlines")
    def submit(req: GeometryReq, request: Request):
        return enqueue(_canon(req), request)

    def _canon_custom(req: CustomReq) -> dict:
        from tngsight.geometry import canonicalize_endpoints
        try:
            return canonicalize_endpoints(req.p0_kpc, req.p1_kpc)
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.post("/api/geometry/custom")
    def geometry_custom(req: CustomReq):
        from tngsight.geometry import make_endpoints
        c = _canon_custom(req)
        g = make_endpoints(c["p0_kpc"], c["p1_kpc"])
        return {"id": c["id"], "canonical": {"p0_kpc": c["p0_kpc"], "p1_kpc": c["p1_kpc"]},
                "geom": json.loads(json.dumps(g, default=lambda x: x.tolist())), "exists": store.has(c["id"])}

    @app.post("/api/sightlines/custom")
    def submit_custom(req: CustomReq, request: Request):
        c = _canon_custom(req)
        return enqueue(c, request, {"canonical": {"p0_kpc": c["p0_kpc"], "p1_kpc": c["p1_kpc"]}})

    @app.get("/api/components")
    def components_index(request: Request):
        body, etag = store.components_index()
        hdr = {"ETag": etag, "Cache-Control": "max-age=60"}
        if etag in [t.strip() for t in request.headers.get("if-none-match", "").split(",")]:
            return Response(status_code=304, headers=hdr)
        return Response(body, media_type="application/json", headers=hdr)

    @app.get("/api/components/{name}")
    def components_one(name: str):
        sid = _sid(name, ".json")
        d = store.components(sid)
        if d is None:
            raise HTTPException(404, f"no components for {sid}")
        return d                               # the per-sightline v2 doc (design.md §4.1)

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str):
        snap = jobq.snapshot(_job_id(job_id))
        if snap is None:
            raise HTTPException(404, "unknown job")
        return snap

    @app.get("/api/jobs/{job_id}/events")
    async def job_events(job_id: str, request: Request):
        _job_id(job_id)
        if jobq.get(job_id) is None:
            raise HTTPException(404, "unknown job")
        who = ip(request)
        if sse_open.get(who, 0) >= S.max_sse_per_client:
            return _limited(15, "event streams")
        if jobq.subscribers(job_id) >= S.max_subs_per_job:
            return _limited(15, "event streams on this job")

        async def stream():
            # count + subscribe inside the generator, so the finally below always undoes them
            with sse_lock:
                sse_open[who] = sse_open.get(who, 0) + 1
            q = None
            try:
                try:
                    q = jobq.subscribe(job_id)
                except TooManySubscribers:          # lost a race for the last slot: just close
                    return                          # (not an "error" event: the job itself is fine)
                s = jobq.snapshot(job_id)
                if s["status"] == DONE:
                    yield {"event": "done", "data": json.dumps({"id": s["id"], "entry": s["entry"],
                                                                "components": s["components"]})}
                    return
                if s["status"] == ERROR:
                    yield {"event": "error", "data": json.dumps({"message": s["error"]})}
                    return
                if s["status"] == QUEUED:
                    yield {"event": "queued", "data": json.dumps({"position": s["position"]})}
                elif s["status"] == RUNNING:
                    yield {"event": "progress", "data": json.dumps({k: s[k] for k in ("stage", "frac", "msg")})}
                while True:
                    ev, data = await q.get()
                    yield {"event": ev, "data": json.dumps(data)}
                    if ev in ("done", "error"):
                        return
            finally:
                if q is not None:
                    jobq.unsubscribe(job_id, q)
                release(who)
        return EventSourceResponse(stream(), ping=S.heartbeat_s,
                                   headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    def release(who):
        with sse_lock:
            n = sse_open.get(who, 0) - 1
            if n > 0:
                sse_open[who] = n
            else:
                sse_open.pop(who, None)

    @app.post("/api/figure")
    async def figure(req: FigureReq, request: Request):
        wait = limiter.check("figure", ip(request))
        if wait:
            return _limited(wait, "figures")
        params = {**req.normalized(), "id": req.id, "fmt": req.fmt}
        if store.npz_path(req.id) is None:
            raise HTTPException(404, f"unknown sightline {req.id}")
        lines = (store.entry(req.id) or {}).get("lines")
        if lines:                          # v1 sightlines hold OVI and CIII only
            if params["ions"] is None:
                from tngsight import ions as _ions
                params["ions"] = [k for k in _ions.DEFAULTS["ions"] if k in lines] or list(lines)[:FIG_MAX_IONS]
            missing = [k for k in params["ions"] if k not in lines]
            if missing:
                raise HTTPException(422, f"ion {missing[0]} is not in sightline {req.id} (lines: {', '.join(lines)})")
        key = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()
        blob = fig_cache.get(key)
        if blob is None:
            if fig_pending[0] >= S.figure_max_pending:      # renders are serialized: don't pile up
                return JSONResponse({"detail": "figure renderer busy; try again shortly"}, 503,
                                    headers={"Retry-After": "10"})
            wait = limiter.check("figure_all", "*")
            if wait:
                return _limited(wait, "figures (all users)")
            kw = {k: params[k] for k in ("ions", "R", "sn", "vhw", "vc", "intrinsic") if params[k] is not None}
            if params["seed"] is not None:
                kw["seed"] = params["seed"]

            def work():
                with fig_lock:                 # matplotlib is not thread-safe
                    return render(store.load_payload(req.id), req.fmt, dpi=S.figure_dpi, **kw)
            fig_pending[0] += 1
            try:
                blob = await asyncio.to_thread(work)
            except Exception as e:
                log.exception("figure %s failed", req.id)
                raise HTTPException(500, f"figure rendering failed: {e.__class__.__name__}")
            finally:
                fig_pending[0] -= 1
            fig_cache[key] = blob
            while len(fig_cache) > S.figure_cache:
                fig_cache.popitem(last=False)
        else:
            fig_cache.move_to_end(key)
        media = "image/png" if req.fmt == "png" else "application/pdf"
        fn = f"tng50_{req.id}_{'-'.join(params['ions'] or ['default'])}_sn{params['sn'][0]}-{params['sn'][1]}.{req.fmt}"
        return Response(blob, media_type=media, headers={"Content-Disposition": f'attachment; filename="{fn}"'})

    # -------------------------------------------------------------------------- worker protocol
    @app.post("/api/worker/lease", dependencies=[Depends(worker_auth)])
    async def lease(req: LeaseReq, wait: float | None = None):
        caps = tuple(sorted(set(req.caps)))
        jobq.touch_worker(req.name, caps=caps)
        t = S.lease_poll_s if wait is None else max(0.0, min(float(wait), S.lease_poll_s))
        j = await jobq.lease_wait(req.name, timeout=t, caps=caps)
        jobq.touch_worker(req.name)
        if j is None:
            return Response(status_code=204)
        # `lease`: this lease's token; progress/fail must present it (a stale worker whose lease was
        # reassigned gets 409 instead of extending or failing the new holder's lease).
        from tngsight.ions import registry_tag
        return {"job_id": j.job_id, "geom": j.geom, "lease_s": int(S.lease_s), "attempt": j.attempts,
                "lease": j.lease_token, "registry_tag": registry_tag()}

    @app.post("/api/worker/progress/{job_id}", dependencies=[Depends(worker_auth)])
    def worker_progress(job_id: str, req: ProgressReq, lease: str = Query(pattern=LEASE_RE)):
        j = jobq.get(_job_id(job_id))
        if j is None:
            raise HTTPException(404, "unknown job")
        if not jobq.progress(job_id, req.stage, req.frac, req.msg, token=lease):
            raise HTTPException(409, f"job is {j.status}, not running under this lease")
        if j.worker:
            jobq.touch_worker(j.worker)
        return {"ok": True, "lease_s": int(S.lease_s)}

    @app.post("/api/worker/result/{job_id}", dependencies=[Depends(worker_auth)])
    async def worker_result(job_id: str, request: Request):
        # No lease check: the first valid result wins, even from a worker whose lease was reassigned.
        j = jobq.get(_job_id(job_id))
        if j is None:
            raise HTTPException(404, "unknown job")
        if j.status in (DONE, ERROR):
            raise HTTPException(409, f"job already {j.status}")
        blob = await request.body()
        try:
            payload = await asyncio.to_thread(store.validate_result, blob, j.geom, S.max_result)
        except ValueError as e:
            raise HTTPException(422, f"invalid result: {e}")
        if not jobq.claim(job_id):            # finished/claimed meanwhile: persist nothing
            raise HTTPException(409, f"job already {j.status if j.status in (DONE, ERROR) else 'finishing'}")
        try:
            entry = await asyncio.to_thread(store.add_generated, payload)
        except BaseException:
            jobq.unclaim(job_id)
            raise
        if j.worker:
            jobq.touch_worker(j.worker)
        d = store.components(j.id)
        if not jobq.complete(job_id, entry, components=d["components"] if d else None):
            raise HTTPException(409, "job finished concurrently")
        return {"ok": True, "id": j.id, "entry": entry}

    @app.post("/api/worker/fail/{job_id}", dependencies=[Depends(worker_auth)])
    def worker_fail(job_id: str, req: FailReq, lease: str = Query(pattern=LEASE_RE)):
        j = jobq.get(_job_id(job_id))
        if j is None:
            raise HTTPException(404, "unknown job")
        worker = j.worker
        new = jobq.fail(job_id, public_error(req.message), token=lease)
        if new is None:
            raise HTTPException(409, f"job is {j.status}, not running under this lease")
        log.warning("worker %s failed job %s: %s", worker, job_id, req.message)   # full text: log only
        return {"ok": True, "status": new}

    app.include_router(chat.make_router(S))       # POST /api/chat (404 "chat disabled" without a key)
    return app


def __getattr__(name):
    """`uvicorn server.app:app` builds the app from env on first access (importing stays side-effect free)."""
    if name == "app":
        globals()["app"] = a = create_app()
        return a
    raise AttributeError(name)
