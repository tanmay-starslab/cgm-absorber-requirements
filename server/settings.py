"""Server settings: a plain dataclass filled from environment variables (no pydantic, no I/O)."""
from __future__ import annotations
import os
from dataclasses import dataclass, field
from pathlib import Path

CHAT_MODELS = ("claude-haiku-5-5", "claude-sonnet-5-5")   # the only models /api/chat may be configured with
DEFAULT_CORS = ("https://galaxies.tanmaysingh.uk", "https://tanmay-starslab.github.io", "http://localhost:8000", "http://127.0.0.1:8000")
VERSION = "1.0.0"


def _flag(v, default=False):
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _gb(v, default: int) -> int:
    """GB (float, env string) -> bytes; empty -> default."""
    return int(float(v) * 1024**3) if v not in (None, "") else int(default)


def _work_root(env=None) -> Path:
    """The TNG_WORK work root (tngsight.config.work_root's rule, repeated so settings import without tngsight)."""
    return Path((os.environ if env is None else env).get("TNG_WORK") or "/Volumes/cgm_work")


def _default_dir(fn, env, fallback):
    """tngsight.config path helpers when importable (no yt there), else the documented default."""
    if os.environ.get(env):
        return Path(os.environ[env])
    try:
        from tngsight import config
        return Path(getattr(config, fn)())
    except Exception:
        return Path(fallback() if callable(fallback) else fallback)


def check_chat_model(m: str) -> str:
    """`m` when it is "auto" or one of CHAT_MODELS, else ValueError (a misconfigured chat model fails at start, never per
    request). "auto" routes each question by complexity (server/chat.py pick_model)."""
    if m != "auto" and m not in CHAT_MODELS:
        raise ValueError(f"CHAT_MODEL must be auto or one of {', '.join(CHAT_MODELS)} (got {str(m)[:60]!r})")
    return m


@dataclass
class Settings:
    library_dir: Path = field(default_factory=lambda: _work_root() / "data" / "library")   # from_env: TNG_LIBRARY_DIR
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
    # galaxies (server/galaxies.py): every route takes ?g=<subhalo id>; the default galaxy keeps the
    # library_dir layout above, any other one lives under galaxy_root/<id>/ (generated sightlines, its
    # galaxy.json, and the lazily fetched slim cutout in an LRU disk cache capped at cutout_cache_bytes)
    default_galaxy: str = "488530"          # TNG_DEFAULT_GALAXY
    galaxy_root: Path | None = None         # TNG_GALAXY_ROOT, else TNG_GAL_ROOT; None -> library_dir/gal
    galaxies_index: Path | None = None      # TNG_GALAXIES: optional JSON list of the ids this node serves
    # GAL_HF_DATASET / GAL_HF_PATTERN: where the private per-galaxy files live (slim cutout + galaxy.json); the
    # defaults match the layout deploy/data/upload_galaxies.py publishes (CUTOUT_REPO, `<id>/<name>`; review2 F4).
    # Generated rays of non-default galaxies are mirrored under `<id>/generated/` of the same repo. HF_TOKEN needs
    # read (and, for the mirror, write) access to it. GAL_HF_DATASET="" falls back to HF_DATASET.
    gal_hf_dataset: str | None = "tanmay-starslab/tng50-mwm31-cutouts"
    gal_hf_pattern: str = "{id}/{name}"
    cutout_cache_bytes: int = 10 * 1024**3  # CUTOUT_CACHE_GB (A1 VM: 46.6 GB boot volume, see U_vm notes)
    cutout_min_free_bytes: int = 4 * 1024**3   # CUTOUT_MIN_FREE_GB: never fill the disk past this
    galaxy_max_warm: int = 1                # GALAXY_MAX_WARM: warm non-default datasets per worker (RAM)
    prepare_timeout_s: float = 3600.0       # a job "preparing" (cutout fetch) longer than this errors
    # chat (POST /api/chat, server/chat.py): Claude proxy, off unless a key is configured
    anthropic_api_key: str | None = field(default=None, repr=False)
    chat_claude: bool = True
    chat_model: str = "auto"        # CHAT_MODEL; one of CHAT_MODELS (anything else is rejected)
    chat_daily_budget: int = 500            # upstream requests per UTC day, all clients together
    chat_client_daily_budget: int = 50      # upstream requests per UTC day for one client (IPv6: its /64)
    chat_daily_tokens: int = 4_000_000      # upstream input+output tokens per UTC day, all clients (0: off)
    chat_large_daily_budget: int = 150      # CHAT_MODEL=auto: requests per UTC day that may use the larger model (then the small one)
    rl_chat: tuple = (60, 12)               # (per hour, burst) per client (IPv4 address / IPv6 /64)
    chat_max_tokens: int = 1024
    chat_timeout_s: float = 30.0
    chat_max_messages: int = 40
    chat_max_bytes: int = 49152             # serialised messages
    chat_max_concurrent: int = 4            # upstream calls in flight
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls, env=None, **over):
        e = os.environ if env is None else env
        g = e.get
        opt = lambda k: Path(g(k)) if g(k) else None  # noqa: E731
        if g("TNG_LIBRARY_DIR"):
            lib = Path(g("TNG_LIBRARY_DIR"))
        elif g("TNG_WORK"):                                  # the mapping's own work root wins over the process env
            lib = _work_root(e) / "data" / "library"
        else:
            lib = _default_dir("library_dir", "TNG_LIBRARY_DIR", lambda: _work_root() / "data" / "library")
        cors = tuple(o.strip() for o in g("CORS_ORIGINS", "").split(",") if o.strip()) or DEFAULT_CORS
        s = cls(library_dir=lib, cutout=opt("TNG_CUTOUT"), ion_table_dir=opt("TNG_ION_TABLE_DIR"),
                index_file=opt("TNG_INDEX_FILE"), local_worker=_flag(g("LOCAL_WORKER"), True),
                worker_token=g("WORKER_TOKEN") or None, hf_token=g("HF_TOKEN") or None,
                hf_dataset=g("HF_DATASET") or None, cors_origins=cors, trust_proxy=_flag(g("TRUST_PROXY")),
                trusted_hops=max(1, int(g("TRUSTED_HOPS") or 1)),
                hf_startup_download=_flag(g("HF_STARTUP_DOWNLOAD"), True),
                node_name=g("NODE_NAME") or "local", port=int(g("PORT") or 8787),
                generator=g("TNG_GENERATOR") or cls.generator,
                anthropic_api_key=g("ANTHROPIC_API_KEY") or None, chat_claude=_flag(g("CHAT_CLAUDE"), True),
                chat_model=check_chat_model((g("CHAT_MODEL") or "").strip() or cls.chat_model),
                chat_daily_budget=int(g("CHAT_DAILY_BUDGET") or cls.chat_daily_budget),
                chat_client_daily_budget=int(g("CHAT_CLIENT_DAILY_BUDGET") or cls.chat_client_daily_budget),
                chat_daily_tokens=int(g("CHAT_DAILY_TOKENS") or cls.chat_daily_tokens),
                chat_large_daily_budget=int(g("CHAT_LARGE_DAILY_BUDGET") or cls.chat_large_daily_budget),
                default_galaxy=(g("TNG_DEFAULT_GALAXY") or cls.default_galaxy).strip(),
                galaxy_root=opt("TNG_GALAXY_ROOT") or opt("TNG_GAL_ROOT"), galaxies_index=opt("TNG_GALAXIES"),
                gal_hf_dataset=(cls.gal_hf_dataset if g("GAL_HF_DATASET") is None else (g("GAL_HF_DATASET") or None)),
                gal_hf_pattern=g("GAL_HF_PATTERN") or cls.gal_hf_pattern,
                cutout_cache_bytes=_gb(g("CUTOUT_CACHE_GB"), cls.cutout_cache_bytes),
                cutout_min_free_bytes=_gb(g("CUTOUT_MIN_FREE_GB"), cls.cutout_min_free_bytes),
                galaxy_max_warm=max(0, int(g("GALAXY_MAX_WARM") or cls.galaxy_max_warm)),
                prepare_timeout_s=float(g("PREPARE_TIMEOUT_S") or cls.prepare_timeout_s))
        for k, v in over.items():
            setattr(s, k, v)
        return s

    @property
    def galaxy_dir(self) -> Path:
        """Root of the non-default galaxies (galaxy_root, else library_dir/gal)."""
        return Path(self.galaxy_root) if self.galaxy_root else Path(self.library_dir) / "gal"

    @property
    def generation_possible(self) -> bool:
        return self.local_worker or bool(self.worker_token)
