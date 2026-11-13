"""Galaxies on the coordinator: every API route takes `?g=<subhalo id>` (default: Settings.default_galaxy,
488530). The default galaxy keeps the single-galaxy layout (library_dir, settings.cutout, the frame in
tngsight.config.GALAXY). Any other galaxy lives under `<galaxy_dir>/<id>/`:

    galaxy.json              its record (centre, R200c, SubhaloVel, disk frame Lhat/xhat/yhat), from the
                             galaxy pipeline (`tngsight.galpipe record`); fetched from the private HF
                             dataset on first use when absent
    vm/                      its LibraryStore: catalog.json, generated/ (mirrored to `gal/<id>/generated/` of
                             the dataset), web/; a subdirectory so a pipeline data root can serve as galaxy_dir
    cutout_slim_R400.hdf5    the slim cutout custom rays need, fetched lazily into an LRU disk cache with a
    cutout.ewah              byte cap (CutoutCache); jobs wait in the "preparing" state while it downloads

Geometry. tngsight.geometry keeps the frame of one galaxy in module globals. frame_call() passes
`galaxy=<record>` to a tngsight function that accepts it, and otherwise runs it with those globals swapped
to the galaxy's frame under one process-wide lock (galaxy_frame()); every coordinator-side geometry call
goes through it, the default galaxy's too, so a concurrent swap can never leak into another request. Jobs
of non-default galaxies carry the fully resolved geometry (start/end, n_los, v_sys), so a worker casts the
right ray whatever its tngsight version, as long as it opens that galaxy's cutout.
"""
from __future__ import annotations
import contextlib
import inspect
import json
import logging
import math
import os
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path

import numpy as np

log = logging.getLogger("tngsight.server")
GAL_ID_RE = re.compile(r"^[0-9]{1,9}$")
CUTOUT_NAME = "cutout_slim_R400.hdf5"
INDEX_NAME = "cutout.ewah"
META_NAME = "galaxy.json"
STORE_SUBDIR = "vm"                   # <galaxy_dir>/<id>/vm/: the coordinator's store of that galaxy
CUTOUT_EPOCH = 1700000000             # fixed cutout mtime: yt's index hash includes it (as deploy/hf_space/start.sh)
TNG_H_DEFAULT = 0.6774
FRAME_VECTORS = ("center_kpc", "Lhat", "xhat", "yhat", "SubhaloVel_kms")
NEGATIVE_TTL_S = 600.0                # an id the data source does not know is not asked again for this long


class UnknownGalaxy(LookupError):
    """No record for this galaxy id on this node (HTTP 404)."""


class GalaxyUnavailable(RuntimeError):
    """The galaxy is known but its data cannot be prepared (no source, no disk space, fetch failed)."""


def check_galaxy(g) -> str:
    g = str(g).strip()
    if not GAL_ID_RE.fullmatch(g):
        raise ValueError(f"invalid galaxy id {g[:20]!r} (a subhalo id: 1-9 digits)")
    return str(int(g))                 # canonical: no leading zeros


def public_label(what, e) -> str:
    """Public error text: a category plus the exception class (messages can name local paths)."""
    return f"{what} ({e.__class__.__name__})"


# ------------------------------------------------------------------------------ records
def _vec(rec, key, n=3):
    v = rec.get(key)
    try:
        a = np.asarray(v, dtype=float)
    except (TypeError, ValueError):
        raise ValueError(f"{key} is not numeric")
    if a.shape != (n,) or not np.all(np.isfinite(a)):
        raise ValueError(f"{key} must be {n} finite numbers")
    return a


def validate_record(rec, gid: str) -> dict:
    """A galaxy.json as the coordinator needs it: centre (center_kpc, else center_ckpch / TNG_H), R200c_kpc,
    SubhaloVel_kms and a disk frame (Lhat, xhat, yhat unit and mutually orthogonal to 1e-3). subhalo_id,
    when present, must equal the id. Returns a cleaned copy (plain floats, "id" added). Raises ValueError."""
    if not isinstance(rec, dict):
        raise ValueError("galaxy record is not a JSON object")
    sid = rec.get("subhalo_id")
    if sid is not None and str(sid) != gid:
        raise ValueError(f"galaxy record is for subhalo {sid}, not {gid}")
    out = dict(rec)
    h = float(rec.get("TNG_H", TNG_H_DEFAULT))
    if not (math.isfinite(h) and 0.1 < h < 2):
        raise ValueError("TNG_H out of range")
    out["TNG_H"] = h
    if "center_kpc" not in rec and "center_ckpch" in rec:
        out["center_kpc"] = (_vec(rec, "center_ckpch") / h).tolist()
    for k in FRAME_VECTORS:
        out[k] = _vec(out, k).tolist()
    r200 = float(rec.get("R200c_kpc", float("nan")))
    if not (math.isfinite(r200) and r200 > 0):
        raise ValueError("R200c_kpc must be a positive number")
    out["R200c_kpc"] = r200
    L, x, y = (np.asarray(out[k]) for k in ("Lhat", "xhat", "yhat"))
    for k, v in (("Lhat", L), ("xhat", x), ("yhat", y)):
        if abs(np.linalg.norm(v) - 1) > 1e-3:
            raise ValueError(f"{k} is not a unit vector")
    if max(abs(L @ x), abs(L @ y), abs(x @ y)) > 1e-3:
        raise ValueError("Lhat, xhat, yhat are not orthogonal")
    out["id"] = gid
    out.setdefault("subhalo_id", int(gid))
    return out


def public_record(rec) -> dict:
    """The catalog header fields (tngsight.library._GAL_PUBLIC) of a record."""
    try:
        from tngsight.library import _GAL_PUBLIC as keys
    except Exception:
        keys = ("sim", "snapshot", "redshift", "subhalo_id", "central", "TNG_H", "R200c_kpc", "M200c_Msun",
                "Mstar_Msun", "SFR_Msun_yr", "SubhaloVel_kms", "disk_frame_source")
    return {k: rec[k] for k in keys if k in rec}


# ------------------------------------------------------------------------------ frame
_FRAME_LOCK = threading.RLock()
_ATTRS = (("H", "TNG_H", float), ("CENTER_KPC", "center_kpc", np.array), ("R200C", "R200c_kpc", float),
          ("LHAT", "Lhat", np.array), ("XHAT", "xhat", np.array), ("YHAT", "yhat", np.array),
          ("SUBVEL", "SubhaloVel_kms", np.array))


@contextlib.contextmanager
def galaxy_frame(rec):
    """tngsight.geometry's module frame set to `rec` (None: unchanged, the default galaxy) for the body,
    under the process-wide frame lock."""
    from tngsight import geometry as G
    with _FRAME_LOCK:
        if rec is None:
            yield
            return
        old = {a: getattr(G, a) for a, _, _ in _ATTRS}
        try:
            for a, k, conv in _ATTRS:
                setattr(G, a, conv(rec[k]))
            yield
        finally:
            for a, v in old.items():
                setattr(G, a, v)


def _accepts_galaxy(fn) -> bool:
    try:
        return "galaxy" in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def frame_call(rec, fn, *a, **kw):
    """fn(*a, **kw) in galaxy `rec`'s frame (None = default galaxy): `galaxy=rec` when fn takes it, else
    under galaxy_frame(rec). Always holds the frame lock, so no other thread's swap is visible."""
    if rec is not None and _accepts_galaxy(fn):
        return fn(*a, galaxy=rec, **kw)
    with galaxy_frame(rec):
        return fn(*a, **kw)


def _jsonable(g) -> dict:
    return json.loads(json.dumps(g, default=lambda x: x.tolist() if hasattr(x, "tolist") else str(x)))


def make_geometry(rec, c: dict) -> dict:
    """Full geometry dict (tngsight.geometry.make_sightline / make_endpoints) of a canonical request in
    galaxy `rec`'s frame (None = default)."""
    from tngsight.geometry import make_endpoints, make_sightline
    if c.get("kind") == "endpoints":
        g = frame_call(rec, make_endpoints, c["p0_kpc"], c["p1_kpc"])
    else:
        g = frame_call(rec, make_sightline, c["orientation"], float(c["b_kpc"]), float(c["azimuth_deg"]),
                       seed=c.get("seed"))
    return _jsonable(g)


def job_geometry(rec, c: dict, gid: str) -> dict:
    """The job geom of a non-default galaxy: the resolved geometry (tngsight.generate.resolve_geometry takes a
    dict with start_ckpch as is), the canonical request keys and "galaxy"."""
    return {**make_geometry(rec, c), **c, "galaxy": gid}


# ------------------------------------------------------------------------------ data source
def _http_status(e):
    return getattr(getattr(e, "response", None), "status_code", None)


class HFFetcher:
    """Files of a galaxy from a (private) HF dataset: repo path = pattern.format(id=<id>, name=<file>)."""

    def __init__(self, token, repo_id, pattern="gal/{id}/{name}", api=None, downloader=None):
        self.token, self.repo_id, self.pattern = token, repo_id, pattern
        self._api, self._dl = api, downloader

    def repo_path(self, gid, name) -> str:
        return self.pattern.format(id=gid, name=name)

    def size(self, gid, name):
        """Remote file size in bytes, or None when unknown."""
        try:
            api = self._api
            if api is None:
                from huggingface_hub import HfApi
                api = self._api = HfApi(token=self.token)
            info = api.get_paths_info(self.repo_id, [self.repo_path(gid, name)], repo_type="dataset")
            return int(info[0].size) if info and getattr(info[0], "size", None) is not None else None
        except Exception as e:
            log.info("HF size of galaxy %s %s unknown: %s", gid, name, e.__class__.__name__)
            return None

    def fetch(self, gid, name, dest: Path) -> None:
        """Download to `dest` (via a temp dir next to it, then os.replace). A missing file raises
        FileNotFoundError."""
        dl = self._dl
        if dl is None:
            from huggingface_hub import hf_hub_download as dl
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=dest.parent, prefix=".fetch_") as t:
            try:
                p = dl(repo_id=self.repo_id, filename=self.repo_path(gid, name), repo_type="dataset",
                       token=self.token, local_dir=t)
            except Exception as e:
                if e.__class__.__name__ in ("EntryNotFoundError", "RemoteEntryNotFoundError") or \
                        _http_status(e) == 404:
                    raise FileNotFoundError(f"{name} of galaxy {gid} is not in the dataset") from e
                raise
            os.replace(p, dest)


# ------------------------------------------------------------------------------ cutout cache
class CutoutCache:
    """LRU disk cache of slim cutouts at <root>/<id>/cutout_slim_R400.hdf5 (+ its yt index cutout.ewah).

    Only files this cache downloaded are managed (counted against `cap_bytes` and evictable); a cutout
    that was already there (e.g. the pipeline's own data root) is used but never deleted. Eviction is
    least-recently-used first and skips `pinned()` galaxies (jobs preparing/queued/running, datasets warm in
    a worker) and fetches in flight; when everything is pinned the cap is exceeded rather than a cutout in
    use being deleted. A download also keeps `min_free_bytes` free on the volume. prepare() is single-flight
    per galaxy and calls every waiter's callback(ok, error) when the fetch ends."""

    LRU_FILE = ".cutout_cache.json"

    def __init__(self, root, cap_bytes, min_free_bytes=0, fetcher=None, pinned=None, clock=time.time,
                 epoch=CUTOUT_EPOCH):
        self.root = Path(root)
        self.cap, self.min_free = int(cap_bytes), int(min_free_bytes)
        self.fetcher, self.pinned, self.clock, self.epoch = fetcher, pinned or (lambda: set()), clock, epoch
        self._lock = threading.RLock()
        self._inflight: dict = {}                # gid -> [callback]
        self.errors: dict = {}                   # gid -> (time, public message) of the last failed fetch
        self.evicted = 0
        self._lru = self._load()

    # -- index
    def _load(self) -> dict:
        try:
            d = json.loads((self.root / self.LRU_FILE).read_text())
            return {str(k): dict(v) for k, v in d.items() if GAL_ID_RE.fullmatch(str(k)) and isinstance(v, dict)}
        except FileNotFoundError:
            return {}
        except Exception as e:
            log.warning("cutout cache index unreadable (%s); starting empty", e)
            return {}

    def _save(self):                              # caller holds the lock
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            tmp = self.root / f".{self.LRU_FILE}.{os.getpid()}.part"
            tmp.write_text(json.dumps(self._lru, sort_keys=True))
            os.replace(tmp, self.root / self.LRU_FILE)
        except Exception as e:
            log.warning("cutout cache index not saved: %s", e)

    # -- queries
    def path(self, gid) -> Path:
        return self.root / gid / CUTOUT_NAME

    def index_path(self, gid) -> Path:
        return self.root / gid / INDEX_NAME

    def has(self, gid) -> bool:
        return self.path(gid).is_file()

    def managed(self, gid) -> bool:
        with self._lock:
            return gid in self._lru

    def preparing(self) -> list:
        with self._lock:
            return sorted(self._inflight)

    def _size(self, gid) -> int:
        n = 0
        for p in (self.path(gid), self.index_path(gid)):
            try:
                n += p.stat().st_size
            except FileNotFoundError:
                pass
        return n

    def used_bytes(self) -> int:
        with self._lock:
            return sum(self._size(g) for g in self._lru)

    def touch(self, gid):
        with self._lock:
            if gid in self._lru:
                self._lru[gid]["last_used"] = round(self.clock(), 1)
                self._save()

    def entries(self) -> list:
        """Every cutout on disk: [{id, bytes, last_used, managed, pinned}], most recently used first."""
        pins = set(self.pinned())
        with self._lock:
            ids = {p.parent.name for p in self.root.glob(f"*/{CUTOUT_NAME}") if GAL_ID_RE.fullmatch(p.parent.name)}
            out = [{"id": g, "bytes": self._size(g), "last_used": self._lru.get(g, {}).get("last_used"),
                    "managed": g in self._lru, "pinned": g in pins} for g in ids]
        return sorted(out, key=lambda e: -(e["last_used"] or 0))

    def status(self) -> dict:
        used = self.used_bytes()
        try:
            free = shutil.disk_usage(self.root if self.root.exists() else self.root.parent).free
        except OSError:
            free = None
        return {"cap_bytes": self.cap, "used_bytes": used, "over_cap": used > self.cap,
                "min_free_bytes": self.min_free, "free_bytes": free, "evicted": self.evicted,
                "source": self.fetcher is not None, "preparing": self.preparing()}

    # -- eviction
    def evict(self, need=0, keep=()) -> list:
        """Delete least-recently-used managed cutouts (and their indexes) until used + need <= cap."""
        pins = set(self.pinned()) | set(keep)
        out = []
        with self._lock:
            pins |= set(self._inflight)
            used = self.used_bytes()
            for gid in sorted((g for g in self._lru if g not in pins), key=lambda g: self._lru[g].get("last_used", 0)):
                if used + need <= self.cap:
                    break
                sz = self._size(gid)
                for p in (self.path(gid), self.index_path(gid)):
                    with contextlib.suppress(FileNotFoundError):
                        p.unlink()
                del self._lru[gid]
                used -= sz
                out.append(gid)
            if out:
                self._save()
                self.evicted += len(out)
        if out:
            log.info("cutout cache: evicted %s (now %.2f GB of %.2f GB)", ",".join(out), used / 1024**3,
                     self.cap / 1024**3)
        elif used + need > self.cap:
            log.warning("cutout cache over its cap (%.2f + %.2f GB > %.2f GB): every cutout is in use",
                        used / 1024**3, need / 1024**3, self.cap / 1024**3)
        return out

    # -- fetching
    def prepare(self, gid, done=None, progress=None) -> str:
        """Make the cutout available: "cached" (done(True, None) called now), "preparing" (a background fetch
        runs or was already running; done is called when it ends) or "error" (no data source; done(False,
        msg) called now)."""
        call = None
        with self._lock:
            if gid not in self._inflight and self.has(gid):
                state, call = "cached", (True, None)
            elif gid in self._inflight:
                self._inflight[gid].append(done)
                state = "preparing"
            elif self.fetcher is None:
                state, call = "error", (False, "no data source for this galaxy's cutout on this node")
            else:
                self._inflight[gid] = [done]
                state = "preparing"
                threading.Thread(target=self._run, args=(gid, progress), name=f"fetch-{gid}", daemon=True).start()
        if state == "cached":
            self.touch(gid)
        if call is not None and done is not None:
            done(*call)
        return state

    def ensure(self, gid, timeout=None, progress=None) -> Path:
        """Blocking prepare(): the cutout path, or GalaxyUnavailable."""
        ev, res = threading.Event(), {}

        def done(ok, err):
            res.update(ok=ok, err=err)
            ev.set()
        self.prepare(gid, done, progress)
        if not ev.wait(timeout):
            raise GalaxyUnavailable("timed out preparing the galaxy")
        if not res["ok"]:
            raise GalaxyUnavailable(res["err"])
        return self.path(gid)

    def _run(self, gid, progress):
        ok, err = True, None
        try:
            self._download(gid, progress)
        except GalaxyUnavailable as e:
            ok, err = False, str(e)
            log.warning("galaxy %s cutout: %s", gid, e)
        except Exception as e:
            ok, err = False, public_label("could not fetch the galaxy's cutout", e)
            log.warning("galaxy %s cutout fetch failed: %s: %s", gid, e.__class__.__name__, e)
        with self._lock:
            cbs = self._inflight.pop(gid, [])
            if ok:
                self.errors.pop(gid, None)
            else:
                self.errors[gid] = (round(self.clock(), 1), err)
        for cb in cbs:
            if cb is not None:
                try:
                    cb(ok, err)
                except Exception:
                    log.exception("cutout callback for galaxy %s", gid)

    def _free(self) -> int:
        return shutil.disk_usage(self.root).free

    def _download(self, gid, progress):
        say = progress or (lambda msg: None)
        d = self.root / gid
        d.mkdir(parents=True, exist_ok=True)
        size = self.fetcher.size(gid, CUTOUT_NAME) if hasattr(self.fetcher, "size") else None
        self.evict(need=size or 0, keep={gid})
        if size and self._free() - size < self.min_free:
            raise GalaxyUnavailable("not enough disk space on this node for the galaxy's cutout")
        say(f"fetching the galaxy's cutout ({size / 1e6:.0f} MB)" if size else "fetching the galaxy's cutout")
        tmp = d / f".{CUTOUT_NAME}.part"
        try:
            self.fetcher.fetch(gid, CUTOUT_NAME, tmp)
            n = tmp.stat().st_size
            if self._free() < self.min_free:
                raise GalaxyUnavailable("not enough disk space on this node for the galaxy's cutout")
            os.utime(tmp, (self.epoch, self.epoch))
            with contextlib.suppress(FileNotFoundError):
                self.index_path(gid).unlink()            # a yt index of an older file is stale
            os.replace(tmp, self.path(gid))
        finally:
            with contextlib.suppress(FileNotFoundError):
                tmp.unlink()
        with self._lock:
            self._lru[gid] = {"last_used": round(self.clock(), 1), "bytes": n}
            self._save()
        say("cutout ready")
        log.info("galaxy %s cutout fetched (%.0f MB)", gid, n / 1e6)
        self.evict(keep={gid})


# ------------------------------------------------------------------------------ hub
def _load_index(path):
    """Optional list of the galaxy ids this node serves: a JSON list of ids, of {"id": ...} rows, or
    {"galaxies": [...]} (the page's CFG.galaxies shape)."""
    if not path:
        return None
    try:
        d = json.loads(Path(path).read_text())
    except Exception as e:
        log.warning("galaxy index %s unreadable: %s", path, e)
        return None
    rows = d.get("galaxies", []) if isinstance(d, dict) else d
    out = set()
    for r in rows if isinstance(rows, list) else []:
        v = r.get("id", r.get("subhalo_id")) if isinstance(r, dict) else r
        try:
            out.add(check_galaxy(v))
        except (ValueError, TypeError):
            continue
    return out


class GalaxyHub:
    """Per-galaxy records, stores and cutouts for the coordinator. `default_store` is the existing
    single-galaxy LibraryStore; `hf_factory(gid, local_dir) -> HFSync | None` mirrors a galaxy's generated
    files; `fetcher` (default HFFetcher on gal_hf_dataset/hf_dataset with HF_TOKEN) provides galaxy.json
    and the cutout; `pinned() -> set` names galaxies whose cutout is in use."""

    def __init__(self, settings, default_store, hf_factory=None, fetcher=None, pinned=None, clock=time.time):
        S = self.S = settings
        self.default = check_galaxy(S.default_galaxy)
        self.root = Path(S.galaxy_dir)
        self.clock = clock
        repo = S.gal_hf_dataset or S.hf_dataset
        if fetcher is None and S.hf_token and repo:
            fetcher = HFFetcher(S.hf_token, repo, S.gal_hf_pattern)
        self.fetcher, self.hf_factory = fetcher, hf_factory
        self.index = _load_index(S.galaxies_index)
        self.cache = CutoutCache(self.root, S.cutout_cache_bytes, S.cutout_min_free_bytes, fetcher, pinned,
                                 clock=clock)
        self._lock = threading.RLock()
        self._stores = {self.default: default_store}
        self._records: dict = {}
        self._missing: dict = {}              # gid -> time the data source said "no such galaxy"
        self._restores: dict = {}
        try:
            from tngsight.config import GALAXY
            cfg = str(GALAXY.get("subhalo_id"))
            if cfg != self.default:
                log.warning("default galaxy %s differs from tngsight's selected galaxy %s (TNG_GALAXY?): "
                            "default-galaxy geometry uses tngsight's frame", self.default, cfg)
        except Exception:
            pass

    # -- ids and records
    def resolve(self, g=None) -> str:
        """Canonical galaxy id of a request value (None/"" = default). ValueError on a malformed id."""
        return self.default if g in (None, "") else check_galaxy(g)

    def is_default(self, gid) -> bool:
        return gid == self.default

    def record(self, gid):
        """The validated record of a non-default galaxy (None for the default one: tngsight's own frame).
        Raises UnknownGalaxy."""
        if gid == self.default:
            return None
        with self._lock:
            if gid in self._records:
                return self._records[gid]
            t = self._missing.get(gid)
            if t is not None and self.clock() - t < NEGATIVE_TTL_S:
                raise UnknownGalaxy(gid)
        if self.index is not None and gid not in self.index:
            raise UnknownGalaxy(gid)
        p = self.root / gid / META_NAME
        if not p.is_file() and self.fetcher is not None:
            self.root.mkdir(parents=True, exist_ok=True)
            tmp = self.root / f".{gid}.{META_NAME}.{threading.get_ident()}.part"
            try:
                self.fetcher.fetch(gid, META_NAME, tmp)
                p.parent.mkdir(parents=True, exist_ok=True)
                os.replace(tmp, p)
            except FileNotFoundError:
                pass
            except Exception as e:                 # transient: do not cache the miss
                log.warning("galaxy %s record fetch failed: %s: %s", gid, e.__class__.__name__, e)
                raise GalaxyUnavailable(public_label("could not fetch the galaxy record", e))
            finally:
                with contextlib.suppress(FileNotFoundError):
                    tmp.unlink()
        if not p.is_file():
            with self._lock:
                if len(self._missing) >= 4096:     # bounded: a scan of random ids cannot grow it forever
                    self._missing.clear()
                self._missing[gid] = self.clock()
            raise UnknownGalaxy(gid)
        try:
            rec = validate_record(json.loads(p.read_text()), gid)
        except Exception as e:
            log.error("galaxy %s record %s invalid: %s", gid, p, e)
            raise GalaxyUnavailable("the galaxy record is invalid")
        with self._lock:
            self._records[gid] = rec
        return rec

    # -- stores
    def store(self, gid):
        """The LibraryStore of a galaxy (opened on first use; its HF mirror restored in the background)."""
        with self._lock:
            st = self._stores.get(gid)
        if st is not None:
            return st
        rec = self.record(gid)                    # raises before any directory is created
        from .storage import LibraryStore
        with self._lock:
            st = self._stores.get(gid)
            if st is not None:
                return st
            d = self.store_dir(gid)
            hf = self.hf_factory(gid, d) if self.hf_factory else None
            st = self._stores[gid] = LibraryStore(d, hf=hf, galaxy=rec)
        t = threading.Thread(target=self._restore, args=(gid, st), name=f"restore-{gid}", daemon=True)
        self._restores[gid] = t
        t.start()
        return st

    def store_dir(self, gid) -> Path:
        return self.root / gid / STORE_SUBDIR

    def _restore(self, gid, st):
        try:
            if st.hf is not None and st.hf.download() is not None:
                st.reload()
            st.reconcile()
            if st.hf is not None:
                st.hf.sync_missing(st.gen_dir)
        except Exception:
            log.exception("galaxy %s store restore", gid)

    def open_ids(self) -> list:
        with self._lock:
            return sorted(self._stores, key=lambda g: (g != self.default, int(g)))

    # -- cutouts
    def has_cutout(self, gid) -> bool:
        return gid == self.default or self.cache.has(gid)

    def can_prepare(self, gid) -> bool:
        return self.has_cutout(gid) or self.fetcher is not None

    def prepare(self, gid, jobq) -> str:
        """Fetch a galaxy's cutout for its PREPARING jobs: queued when it is ready, errored when it fails."""
        def done(ok, err):
            if ok:
                jobq.prepared(gid)
            else:
                jobq.prepare_failed(gid, err or "galaxy data unavailable")
        return self.cache.prepare(gid, done, progress=lambda msg: jobq.preparing_progress(
            gid, f"preparing galaxy {gid}: {msg}"))

    def worker_spec(self, gid) -> dict | None:
        """What a local worker needs to open a non-default galaxy: id, record, cutout, yt index path."""
        if gid is None or gid == self.default:
            return None
        rec = self.record(gid)
        self.cache.touch(gid)
        return {"id": gid, "record": rec, "cutout": str(self.cache.path(gid)),
                "index_filename": str(self.cache.index_path(gid))}

    def status(self) -> dict:
        errs = {g: m for g, (t, m) in self.cache.errors.items()}
        return {"default": self.default, "open": self.open_ids(), "cached": self.cache.entries(),
                "cache": self.cache.status(), "errors": errs,
                "index": None if self.index is None else len(self.index)}

    def stop(self):
        with self._lock:
            stores = [s for g, s in self._stores.items() if g != self.default]
        for s in stores:
            if s.hf is not None:
                s.hf.stop()
