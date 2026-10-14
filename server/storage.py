"""LibraryStore (local library dir over tngsight.library.Catalog) and optional HFSync
(huggingface_hub dataset mirror). Callers must validate ids with ID_RE before passing them here;
every path is still re-checked so no user string can reach the filesystem unvalidated."""
from __future__ import annotations
import hashlib
import io
import json
import logging
import os
import re
import threading
import time
import zipfile
from pathlib import Path

import numpy as np

log = logging.getLogger("tngsight.server")
ID_RE = re.compile(r"^(face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?$")
LINE_KEYS = ("OVI", "HILyb", "CIII")
NPZ_KEYS = ["geom", "v_sys"] + [f"logN_{k}" for k in LINE_KEYS] + \
    [f"{k}_{s}" for k in LINE_KEYS for s in ("lambda", "tau", "rest")]
MAX_UNZIPPED = 50 * 1024 * 1024


def check_id(sid: str) -> str:
    if not isinstance(sid, str) or not ID_RE.match(sid):
        raise ValueError(f"invalid sightline id {sid!r}")
    return sid


def _lib():
    from tngsight import library
    return library


class LibraryStore:
    """<root>/catalog.json, <root>/sightlines/*.npz (library), <root>/generated/<id>.npz|.bin,
    <root>/web/<id>.bin. Generated sightlines are persisted here and mirrored by `hf` if set."""

    def __init__(self, root, hf=None):
        self.root = Path(root)
        self.gen_dir, self.web_dir, self.lib_dir = (self.root / d for d in ("generated", "web", "sightlines"))
        for d in (self.root, self.gen_dir, self.web_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.hf = hf
        self._lock = threading.RLock()
        self._doc = None
        self.reload()

    # ------------------------------------------------------------------ catalog
    def reload(self):
        """(Re)read catalog.json (e.g. after an HF snapshot download)."""
        with self._lock:
            self.catalog = _lib().Catalog(self.root / "catalog.json")
            self._doc = None

    def entries(self) -> list:
        return self.catalog.entries()

    def entry(self, sid) -> dict | None:
        return self.catalog.get(check_id(sid))

    def has(self, sid) -> bool:
        return self.entry(sid) is not None

    def sizes(self) -> tuple[int, int]:
        es = self.entries()
        gen = sum(1 for e in es if e.get("source") == "generated")
        return len(es) - gen, gen

    def catalog_doc(self) -> tuple[bytes, str]:
        """Serialized catalog (library + generated) and a strong ETag; cached until the next upsert."""
        with self._lock:
            if self._doc is None:
                doc = {k: v for k, v in self.catalog.data.items() if k != "entries"}
                doc["entries"] = self.entries()
                body = json.dumps(doc, separators=(",", ":"), allow_nan=False).encode()
                self._doc = (body, '"' + hashlib.sha1(body).hexdigest()[:20] + '"')
            return self._doc

    # ------------------------------------------------------------------ files
    def npz_path(self, sid) -> Path | None:
        check_id(sid)
        for p in (self.gen_dir / f"{sid}.npz", self.lib_dir / f"{sid}.npz",
                  self.lib_dir / f"cgm_sid488530_{sid}.npz"):
            if p.is_file():
                return p
        return None

    def load_payload(self, sid) -> dict | None:
        p = self.npz_path(sid)
        return None if p is None else _lib().load_npz(p)

    def bin_bytes(self, sid) -> bytes | None:
        """Web binary; built from the npz (and cached under web/) when no .bin exists yet."""
        check_id(sid)
        for p in (self.web_dir / f"{sid}.bin", self.gen_dir / f"{sid}.bin"):
            if p.is_file():
                return p.read_bytes()
        payload = self.load_payload(sid)
        if payload is None:
            return None
        blob = _lib().encode_web(payload)
        _atomic_write(self.web_dir / f"{sid}.bin", blob)
        return blob

    # ------------------------------------------------------------------ generated
    def add_generated(self, payload: dict, scores=None) -> dict:
        """Persist a generated payload: npz + web bin + catalog upsert (+ HF upload)."""
        lib = _lib()
        sid = check_id(payload["id"])
        if scores is None:
            try:
                from tngsight.scoring import score_payload
                scores = score_payload(payload)
            except Exception as e:      # scoring is cosmetic; never lose a computed sightline over it
                log.warning("scoring %s failed: %s", sid, e)
                scores = None
        npz = self.gen_dir / f"{sid}.npz"
        lib.save_npz(npz, payload["geom"], payload["logN"], payload["tau"])     # atomic (tmp + replace)
        blob = lib.encode_web(payload)
        _atomic_write(self.gen_dir / f"{sid}.bin", blob)
        entry = lib.catalog_entry(payload, scores, "generated")
        with self._lock:
            self.catalog.upsert(entry)
            self.catalog.save()
            self._doc = None
        if self.hf is not None:
            self.hf.upload(npz, f"generated/{sid}.npz")
            self.hf.upload(self.gen_dir / f"{sid}.bin", f"generated/{sid}.bin")
        return entry

    def reconcile(self) -> int:
        """Re-register generated/*.npz missing from the catalog (after a restart + HF download)."""
        n = 0
        for p in sorted(self.gen_dir.glob("*.npz")):
            sid = p.stem
            if not ID_RE.match(sid) or self.catalog.get(sid) is not None:
                continue
            try:
                payload = _lib().load_npz(p)
                from tngsight.scoring import score_payload
                entry = _lib().catalog_entry(payload, score_payload(payload), "generated")
                with self._lock:
                    self.catalog.upsert(entry)
                    self._doc = None
                n += 1
            except Exception as e:
                log.warning("reconcile %s failed: %s", p.name, e)
        if n:
            with self._lock:
                self.catalog.save()
        return n

    # ------------------------------------------------------------------ worker results
    def validate_result(self, blob: bytes, geom: dict, max_bytes: int) -> dict:
        """Check an uploaded npz without unpickling anything, then return load_npz() of it.
        Raises ValueError with a message suitable for the HTTP 422 body."""
        if len(blob) > max_bytes:
            raise ValueError(f"result too large ({len(blob)} > {max_bytes} bytes)")
        try:
            zf = zipfile.ZipFile(io.BytesIO(blob))
            names = [i.filename for i in zf.infolist()]
            if sum(i.file_size for i in zf.infolist()) > MAX_UNZIPPED:
                raise ValueError("result decompresses too large")
        except zipfile.BadZipFile:
            raise ValueError("result is not an npz archive")
        if sorted(names) != sorted(k + ".npy" for k in NPZ_KEYS):
            raise ValueError(f"npz keys {sorted(n[:-4] for n in names)} != expected")
        try:
            with np.load(io.BytesIO(blob), allow_pickle=False) as z:
                a = {k: z[k] for k in NPZ_KEYS}
        except Exception as e:
            raise ValueError(f"unreadable npz ({e.__class__.__name__}: {e})")
        lib = _lib()
        for k in LINE_KEYS:
            lam, tau = a[f"{k}_lambda"], a[f"{k}_tau"]
            ref = lib.wavelength_grid(k)
            if lam.shape != ref.shape or tau.shape != ref.shape:
                raise ValueError(f"{k}: shape {lam.shape}/{tau.shape} != {ref.shape}")
            if not np.allclose(lam.astype(np.float64), ref.astype(np.float64), rtol=1e-6, atol=0):
                raise ValueError(f"{k}: wavelength grid mismatch")
            if not np.all(np.isfinite(tau)) or tau.min() < -1e-6:
                raise ValueError(f"{k}: tau not finite/non-negative")
            if a[f"logN_{k}"].shape != () or not np.isfinite(a[f"logN_{k}"]):
                raise ValueError(f"logN_{k} not a finite scalar")
        if a["geom"].dtype.kind != "U" or a["geom"].shape != ():
            raise ValueError("geom must be a 0-d unicode string")
        try:
            g = json.loads(str(a["geom"]))
        except Exception:
            raise ValueError("geom is not JSON")
        from tngsight.geometry import make_sightline
        want = make_sightline(geom["orientation"], float(geom["b_kpc"]), float(geom["azimuth_deg"]),
                              seed=geom.get("seed"))
        for key in ("n_los", "start_kpc", "end_kpc"):
            if not np.allclose(np.asarray(g.get(key, np.nan), float), np.asarray(want[key], float),
                               rtol=1e-9, atol=1e-9):
                raise ValueError(f"geom {key} does not match job {geom['id']}")
        payload = lib.load_npz(io.BytesIO(blob), id=geom["id"])
        payload["id"] = geom["id"]
        return payload


def _atomic_write(path: Path, data: bytes):
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _http_status(e):
    return getattr(getattr(e, "response", None), "status_code", None)


def _err_label(what, e) -> str:
    """Public error label: exception class (+ HTTP status), never the message (it can name paths)."""
    code = _http_status(e)
    return f"{what}: {e.__class__.__name__}" + (f" (HTTP {code})" if code else "")


_FATAL_CLASSES = ("RepositoryNotFoundError", "GatedRepoError", "RevisionNotFoundError")


def _add_op(path_in_repo, path):
    try:
        from huggingface_hub import CommitOperationAdd
    except ImportError:                     # injected test api without huggingface_hub installed
        from types import SimpleNamespace
        return SimpleNamespace(path_in_repo=path_in_repo, path_or_fileobj=path)
    return CommitOperationAdd(path_in_repo=path_in_repo, path_or_fileobj=path)


class HFSync:
    """Mirror generated files to a (private) HF dataset from a background thread.

    Pending uploads live in a manifest (<local_dir>/.hfsync_pending.json) until a commit containing
    them succeeds, so nothing is dropped after N failures or by a restart; retries back off up to
    `max_delay` and go on indefinitely. Pending files are batched into one commit (a sightline's
    npz + bin = one commit). A 401/403 (read-only token) disables uploading instead of retrying;
    the manifest is kept for a restart with a write token. `sync_missing()` (startup) queues any
    generated/* file the dataset lacks. `download()` pulls the whole dataset at startup."""

    MANIFEST = ".hfsync_pending.json"

    def __init__(self, token, repo_id, local_dir, api=None, snapshot=None, max_tries=8, base_delay=2.0,
                 max_delay=300.0, batch_s=1.0, batch_max=50):
        self.token, self.repo_id, self.local_dir = token, repo_id, Path(local_dir)
        self.max_tries, self.base_delay, self.max_delay = max_tries, base_delay, max_delay
        self.batch_s, self.batch_max = batch_s, batch_max
        if api is None:
            from huggingface_hub import HfApi
            api = HfApi(token=token)
        self.api, self._snapshot = api, snapshot
        self.last_error, self.uploaded, self.disabled = None, 0, None
        self._lock = threading.Lock()
        self._stop, self._wake = threading.Event(), threading.Event()
        self._t = None
        self._pending: dict = self._load_manifest()           # path_in_repo -> local path (str)

    # ------------------------------------------------------------------ manifest
    def _load_manifest(self) -> dict:
        try:
            d = json.loads((self.local_dir / self.MANIFEST).read_text())
            return {str(k): str(v) for k, v in d.items()} if isinstance(d, dict) else {}
        except FileNotFoundError:
            return {}
        except Exception as e:
            log.warning("HF pending manifest unreadable (%s); starting empty", e)
            return {}

    def _save_manifest(self):                               # caller holds self._lock
        try:
            self.local_dir.mkdir(parents=True, exist_ok=True)
            _atomic_write(self.local_dir / self.MANIFEST,
                          json.dumps(self._pending, indent=0, sort_keys=True).encode())
        except Exception as e:
            log.warning("HF pending manifest not saved: %s", e)

    # ------------------------------------------------------------------ download
    def download(self):
        snap = self._snapshot
        if snap is None:
            from huggingface_hub import snapshot_download as snap
        delay = self.base_delay
        for i in range(self.max_tries):
            try:
                return snap(repo_id=self.repo_id, repo_type="dataset", local_dir=str(self.local_dir),
                            token=self.token)
            except Exception as e:
                self.last_error = _err_label("download", e)
                log.warning("HF snapshot_download failed (try %d): %s", i + 1, e)
                if e.__class__.__name__ in _FATAL_CLASSES or _http_status(e) in (401, 403, 404):
                    log.error("HF dataset %s not readable with this token; not retrying", self.repo_id)
                    return None
                if self._stop.wait(delay):
                    return None
                delay = min(delay * 2, self.max_delay)
        return None

    # ------------------------------------------------------------------ upload
    def upload(self, path, path_in_repo):
        with self._lock:
            self._pending[str(path_in_repo)] = str(path)
            self._save_manifest()
        self._wake.set()
        self.start()

    def sync_missing(self, gen_dir) -> int:
        """Queue generated/<id>.npz|.bin files present locally but absent from the dataset."""
        if self.disabled:
            return 0
        try:
            remote = set(self.api.list_repo_files(repo_id=self.repo_id, repo_type="dataset", token=self.token))
        except Exception as e:
            self.last_error = _err_label("list", e)
            log.warning("HF list_repo_files failed: %s", e)
            remote = None
        n = 0
        if remote is not None:
            with self._lock:
                for p in sorted(Path(gen_dir).glob("*")):
                    dest = f"generated/{p.name}"
                    if p.suffix in (".npz", ".bin") and ID_RE.match(p.stem) and dest not in remote \
                            and dest not in self._pending:
                        self._pending[dest] = str(p)
                        n += 1
                if n:
                    self._save_manifest()
            if n:
                log.info("HF: %d generated file(s) missing from %s queued for upload", n, self.repo_id)
        if self._pending:
            self._wake.set()
            self.start()
        return n

    def start(self):
        if self._t is not None and self._t.is_alive():
            return
        self._t = threading.Thread(target=self._run, name="hfsync", daemon=True)
        self._t.start()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def pending(self) -> int:
        with self._lock:
            return len(self._pending)

    def _commit(self, items):
        self.api.create_commit(repo_id=self.repo_id, repo_type="dataset", token=self.token,
                               operations=[_add_op(d, p) for d, p in items],
                               commit_message=f"add {len(items)} generated file(s)")

    def _run(self):
        delay = self.base_delay
        while not self._stop.is_set():
            with self._lock:
                empty = not self._pending
            if empty or self.disabled:
                self._wake.wait(1.0)
                self._wake.clear()
                continue
            if self.batch_s and self._stop.wait(self.batch_s):      # let a sightline's npz + bin pair up
                return
            with self._lock:
                items = list(self._pending.items())[: self.batch_max]
                gone = [d for d, p in items if not Path(p).is_file()]
                for d in gone:
                    log.warning("HF upload %s skipped: local file is gone", d)
                    del self._pending[d]
                if gone:
                    self._save_manifest()
            items = [(d, p) for d, p in items if d not in gone]
            if not items:
                continue
            try:
                self._commit(items)
            except Exception as e:
                self.last_error = _err_label("upload", e)
                log.warning("HF commit of %d file(s) failed: %s", len(items), e)
                if _http_status(e) in (401, 403):
                    self.disabled = "HF_TOKEN cannot write to the dataset; uploads disabled"
                    log.error("HF %s: %s (%d file(s) stay pending)", self.repo_id, self.disabled, len(items))
                    continue
                if self._stop.wait(delay):
                    return
                delay = min(delay * 2, self.max_delay)
                continue
            with self._lock:
                for d, p in items:
                    if self._pending.get(d) == p:
                        del self._pending[d]
                self._save_manifest()
            self.uploaded += len(items)
            self.last_error, delay = None, self.base_delay

    def status(self) -> dict:
        return {"repo": self.repo_id, "pending": self.pending(), "uploaded": self.uploaded,
                "last_error": self.last_error, "disabled": bool(self.disabled)}
