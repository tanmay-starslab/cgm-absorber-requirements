"""Server settings: a plain dataclass filled from environment variables (no pydantic, no I/O)."""
from __future__ import annotations
import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_CORS = ("https://tanmay-starslab.github.io", "http://localhost:8000", "http://127.0.0.1:8000")
VERSION = "1.0.0"


def _flag(v, default=False):
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _default_dir(fn, env, fallback):
    """tngsight.config path helpers when importable (no yt there), else the documented default."""
    if os.environ.get(env):
        return Path(os.environ[env])
    try:
        from tngsight import config
        return Path(getattr(config, fn)())
    except Exception:
        return Path(fallback)


@dataclass
class Settings:
    library_dir: Path = Path("/Volumes/cgm_work/data/library")
    cutout: Path | None = None              # None -> tngsight.config.cutout_path()
    ion_table_dir: Path | None = None
    index_file: Path | None = None
    local_worker: bool = True
    worker_token: str | None = None         # unset -> worker protocol disabled (404)
    hf_token: str | None = None
    hf_dataset: str | None = None
    cors_origins: tuple = DEFAULT_CORS
    trust_proxy: bool = False
    trusted_hops: int = 1                   # proxies that append to X-Forwarded-For (HF Space: 1)
    node_name: str = "local"
    port: int = 8787
    generator: str = "tngsight.generate:Generator"   # "module:attr" factory (picklable for spawn)
    local_executor: str = "process"         # "process" (spawn, production) | "thread" (tests/dev)
    # protocol tunables (seconds unless noted)
    lease_s: float = 120.0
    lease_poll_s: float = 25.0
    max_attempts: int = 2
    job_timeout_s: float = 900.0
    job_ttl_s: float = 3600.0
    queue_ttl_s: float = 7200.0             # a queued job older than this errors (never waits forever)
    no_worker_grace_s: float = 90.0         # no live worker this long -> queued jobs error, submits 503
    worker_seen_s: float = 60.0             # a remote worker polled/reported within this -> live
    reap_every_s: float = 1.0
    heartbeat_s: float = 15.0
    queue_cap: int = 30
    max_body: int = 8 * 1024
    max_result: int = 5 * 1024 * 1024
    rl_sightlines: tuple = (12, 4)          # (per hour, burst)
    rl_figure: tuple = (60, 10)
    rl_figure_global: tuple = (600, 30)     # all clients together (renders are CPU-bound)
    figure_max_pending: int = 3             # renders running or waiting for the lock; more -> 503
    max_subs_per_job: int = 16              # concurrent SSE streams per job
    max_sse_per_client: int = 20            # concurrent SSE streams per client IP
    figure_cache: int = 64
    figure_dpi: int = 240
    hf_startup_download: bool = True
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls, env=None, **over):
        e = os.environ if env is None else env
        g = e.get
        opt = lambda k: Path(g(k)) if g(k) else None  # noqa: E731
        lib = Path(g("TNG_LIBRARY_DIR")) if g("TNG_LIBRARY_DIR") else _default_dir(
            "library_dir", "TNG_LIBRARY_DIR", "/Volumes/cgm_work/data/library")
        cors = tuple(o.strip() for o in g("CORS_ORIGINS", "").split(",") if o.strip()) or DEFAULT_CORS
        s = cls(library_dir=lib, cutout=opt("TNG_CUTOUT"), ion_table_dir=opt("TNG_ION_TABLE_DIR"),
                index_file=opt("TNG_INDEX_FILE"), local_worker=_flag(g("LOCAL_WORKER"), True),
                worker_token=g("WORKER_TOKEN") or None, hf_token=g("HF_TOKEN") or None,
                hf_dataset=g("HF_DATASET") or None, cors_origins=cors, trust_proxy=_flag(g("TRUST_PROXY")),
                trusted_hops=max(1, int(g("TRUSTED_HOPS") or 1)),
                hf_startup_download=_flag(g("HF_STARTUP_DOWNLOAD"), True),
                node_name=g("NODE_NAME") or "local", port=int(g("PORT") or 8787),
                generator=g("TNG_GENERATOR") or cls.generator)
        for k, v in over.items():
            setattr(s, k, v)
        return s

    @property
    def generation_possible(self) -> bool:
        return self.local_worker or bool(self.worker_token)
