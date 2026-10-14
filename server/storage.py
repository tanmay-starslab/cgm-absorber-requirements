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
ID_RE = re.compile(r"^((face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?|cust_[0-9a-f]{10})$")
LINE_KEYS = ("OVI", "HILyb", "CIII")
NPZ_KEYS = ["geom", "v_sys"] + [f"logN_{k}" for k in LINE_KEYS] + \
    [f"{k}_{s}" for k in LINE_KEYS for s in ("lambda", "tau", "rest")]
COMPONENTS_MEMBER = "components_json"          # optional extra npz member of a worker result
COMPONENTS_SUFFIX = ".components.json"
DOWNLOAD_IGNORE = ("vol/*", "components/*")   # dataset backups of Phase-2 builds the server never reads
_ROW_KEYS = ("p0", "p1", "has_components", "logN_aod")   # a generated row lacking one is rebuilt by reconcile()
MAX_UNZIPPED = 50 * 1024 * 1024
MAX_COMPONENTS_JSON = 512 * 1024
_COMP_KEYS = ("v", "dv", "logN", "dlogN", "b", "db", "region", "flag", "EW")
_COMP_NULLABLE = ("dv", "dlogN", "db")


def check_id(sid: str) -> str:
    if not isinstance(sid, str) or not ID_RE.fullmatch(sid):
        raise ValueError(f"invalid sightline id {sid!r}")
    return sid


def _lib():
    from tngsight import library
    return library


def _components_mod():
    """tngsight.components (U_fit) or None when it is not installed yet."""
    try:
        from tngsight import components
        return components
    except ImportError:
        return None


_LOGN_HI = {"HILyb": 22.5}       # damped H I (tngsight.vpfit PARAMS logN_hi_ion); other ions ≤ 19


def _basic_validate_components(obj) -> dict:
    """Fallback for tngsight.components.validate_components (same §5.3 rules) when that module is absent."""
    if not isinstance(obj, dict) or sorted(obj) != sorted(LINE_KEYS):
        raise ValueError(f"components must have exactly the keys {list(LINE_KEYS)}")
    out = {}
    for ion in LINE_KEYS:
        comps = obj[ion]
        if not isinstance(comps, list) or len(comps) > 30:
            raise ValueError(f"components[{ion}] must be a list of at most 30 components")
        for i, c in enumerate(comps):
            where = f"components[{ion}][{i}]"
            if not isinstance(c, dict) or set(c) != set(_COMP_KEYS):
                raise ValueError(f"{where}: keys must be {list(_COMP_KEYS)}")
            for k in _COMP_KEYS:
                x = c[k]
                if x is None and k in _COMP_NULLABLE:
                    continue
                if isinstance(x, bool) or not isinstance(x, (int, float)) or not np.isfinite(x):
                    raise ValueError(f"{where}.{k}: not a finite number")
            n_hi = _LOGN_HI.get(ion, 19)
            if not 10 <= c["logN"] <= n_hi or not 1 <= c["b"] <= 150 or abs(c["v"]) > 2000:
                raise ValueError(f"{where}: logN/b/v out of range")
            if isinstance(c["flag"], bool) or not isinstance(c["flag"], int) or not 0 <= c["flag"] <= 127:
                raise ValueError(f"{where}.flag: must be an int in 0..127")
            if not isinstance(c["region"], int) or c["region"] < 0:
                raise ValueError(f"{where}.region: must be a non-negative int")
        out[ion] = comps
    return out


def validate_components(obj) -> dict:
    """tngsight.components.validate_components when available, else the same rules locally."""
    mod = _components_mod()
    if mod is not None and hasattr(mod, "validate_components"):
        return mod.validate_components(obj)
    return _basic_validate_components(obj)


def fitter_info() -> dict:
    """{"fitter", "params_tag"} of the installed fitter (None, None without tngsight.components)."""
    mod = _components_mod()
    if mod is None:
        return {"fitter": None, "params_tag": None}
    try:
        return {"fitter": getattr(mod, "FITTER_TAG", None), "params_tag": mod.params_tag()}
    except Exception as e:
        log.warning("components params_tag failed: %s", e)
        return {"fitter": getattr(mod, "FITTER_TAG", None), "params_tag": None}


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
        self._comp_cache: dict = {}            # sid -> components doc (validated)
        self._comp_doc = None                  # cached GET /api/components body + ETag
        self._backfill = None
        self.reload()

    # ------------------------------------------------------------------ catalog
    def reload(self):
        """(Re)read catalog.json (e.g. after an HF snapshot download). Also drops the cached components
        documents and /api/components index: the download may have brought or replaced
        generated/*.components.json files."""
        with self._lock:
            self.catalog = _lib().Catalog(self.root / "catalog.json")
            self._doc = None
            self._comp_doc = None
            self._comp_cache.clear()

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

    # ------------------------------------------------------------------ components
    def components_path(self, sid) -> Path:
        return self.gen_dir / f"{check_id(sid)}{COMPONENTS_SUFFIX}"

    def components(self, sid) -> dict | None:
        """Stored {"id","fitter","params_tag","components"} of a generated sightline (validated, cached)."""
        check_id(sid)
        with self._lock:
            if sid in self._comp_cache:
                return self._comp_cache[sid]
        p = self.components_path(sid)
        if not p.is_file():
            return None
        try:
            doc = json.loads(p.read_text())
            doc["components"] = validate_components(doc["components"])
        except Exception as e:
            log.warning("components file %s unusable: %s", p.name, e)
            return None
        with self._lock:
            self._comp_cache[sid] = doc
        return doc

    def components_index(self) -> tuple[bytes, str]:
        """GET /api/components body {"version":1,"fitter","params_tag","entries":{id:{ion:[...]}}} + ETag."""
        with self._lock:
            if self._comp_doc is None:
                entries, info = {}, fitter_info()
                for p in sorted(self.gen_dir.glob(f"*{COMPONENTS_SUFFIX}")):
                    sid = p.name[: -len(COMPONENTS_SUFFIX)]
                    if not ID_RE.fullmatch(sid):
                        continue
                    d = self.components(sid)
                    if d is not None:
                        entries[sid] = d["components"]
                        if info["fitter"] is None:
                            info = {"fitter": d.get("fitter"), "params_tag": d.get("params_tag")}
                doc = {"version": 1, **info, "entries": entries}
                body = json.dumps(doc, separators=(",", ":"), allow_nan=False, sort_keys=True).encode()
                self._comp_doc = (body, '"' + hashlib.sha1(body).hexdigest()[:20] + '"')
            return self._comp_doc

    def _fit(self, payload) -> dict | None:
        mod = _components_mod()
        if mod is None:
            return None
        try:
            return mod.fit_payload(payload)
        except Exception as e:          # components are optional; never lose a sightline over them
            log.warning("fit %s failed: %s", payload.get("id"), e)
            return None

    def _write_components(self, sid, comps, upload=True) -> bool:
        """Validate + persist <gen>/<id>.components.json (atomic) and queue its HF upload."""
        try:
            comps = validate_components(comps)
            info = fitter_info()
            doc = {"id": sid, "fitter": info["fitter"], "params_tag": info["params_tag"], "components": comps}
            _atomic_write(self.components_path(sid),
                          json.dumps(doc, separators=(",", ":"), allow_nan=False, sort_keys=True).encode())
        except Exception as e:
            log.warning("components of %s not stored: %s", sid, e)
            return False
        with self._lock:
            self._comp_cache[sid] = doc
            self._comp_doc = None
        if upload and self.hf is not None:
            self.hf.upload(self.components_path(sid), f"generated/{sid}{COMPONENTS_SUFFIX}")
        return True

    # ------------------------------------------------------------------ generated
    def add_generated(self, payload: dict, scores=None, components=None) -> dict:
        """Persist a generated payload: npz + web bin (+ components json) + catalog upsert (+ HF upload).
        components: argument, else payload["components"], else a best-effort fit in this thread — but only
        when the generator never attempted one (a Phase-1 worker): payload["components_skipped"] marks a fit
        that was attempted and failed, which is deterministic, so it is left to the background backfill
        instead of being repeated while the job is finishing."""
        lib = _lib()
        sid = check_id(payload["id"])
        if components is None:
            components = payload.get("components")
        if components is None and not payload.get("components_skipped"):
            components = self._fit(payload)
        if components is not None and not self._write_components(sid, components, upload=False):
            components = None
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
        stored = self.components(sid) if components is not None else None
        entry = lib.catalog_entry(payload, scores, "generated",
                                  components=stored["components"] if stored else None)
        with self._lock:
            self.catalog.upsert(entry)
            self.catalog.save()
            self._doc = None
        if self.hf is not None:
            self.hf.upload(npz, f"generated/{sid}.npz")
            self.hf.upload(self.gen_dir / f"{sid}.bin", f"generated/{sid}.bin")
            if stored is not None:
                self.hf.upload(self.components_path(sid), f"generated/{sid}{COMPONENTS_SUFFIX}")
        return entry

    def reconcile(self, backfill=True) -> int:
        """Re-register generated/*.npz missing from the catalog (after a restart + HF download), rebuild
        generated rows written before the current row schema (no p0/p1, has_components or logN_aod — e.g.
        Phase-1 rows), then (background thread, best effort) fit components for generated sightlines that
        lack them. Returns the number of rows added or rebuilt."""
        n = 0
        for p in sorted(self.gen_dir.glob("*.npz")):
            sid = p.stem
            if not ID_RE.fullmatch(sid):
                continue
            old = self.catalog.get(sid)
            if old is not None and all(k in old for k in _ROW_KEYS):
                continue
            try:
                payload = _lib().load_npz(p)
                from tngsight.scoring import score_payload
                d = self.components(sid)
                entry = _lib().catalog_entry(payload, score_payload(payload), "generated",
                                             components=d["components"] if d else None)
                if old is not None:          # keep anything the old row had that the new schema lacks
                    entry = {**old, **entry}
                with self._lock:
                    self.catalog.upsert(entry)
                    self._doc = None
                n += 1
            except Exception as e:
                log.warning("reconcile %s failed: %s", p.name, e)
        if n:
            with self._lock:
                self.catalog.save()
            log.info("reconcile: %d generated catalog row(s) added or rebuilt", n)
        if backfill:
            self.start_backfill()
        return n

    def missing_components(self) -> list:
        return [p.stem for p in sorted(self.gen_dir.glob("*.npz"))
                if ID_RE.fullmatch(p.stem) and not self.components_path(p.stem).is_file()]

    def backfill_components(self) -> int:
        """Fit + persist components of generated sightlines lacking them; update their catalog rows."""
        if _components_mod() is None:
            return 0
        n = 0
        for sid in self.missing_components():
            try:
                payload = _lib().load_npz(self.gen_dir / f"{sid}.npz")
                payload["id"] = sid
                comps = self._fit(payload)
                if comps is None or not self._write_components(sid, comps):
                    continue
                with self._lock:
                    e = self.catalog.get(sid)
                    if e is not None:
                        e.update(has_components=True, n_fit=_lib()._n_fit(self.components(sid)["components"]))
                        self.catalog.upsert(e)
                        self.catalog.save()
                        self._doc = None
                n += 1
            except Exception as e:
                log.warning("components backfill %s failed: %s", sid, e)
        if n:
            log.info("components back-filled for %d generated sightline(s)", n)
        return n

    def start_backfill(self):
        if _components_mod() is None or not self.missing_components():
            return None
        if self._backfill is not None and self._backfill.is_alive():
            return self._backfill
        self._backfill = threading.Thread(target=self.backfill_components, name="components-backfill",
                                          daemon=True)
        self._backfill.start()
        return self._backfill

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
        base = sorted(k + ".npy" for k in NPZ_KEYS)
        has_comp = sorted(names) == sorted(base + [COMPONENTS_MEMBER + ".npy"])
        if sorted(names) != base and not has_comp:
            raise ValueError(f"npz keys {sorted(n[:-4] for n in names)} != expected")
        keys = NPZ_KEYS + ([COMPONENTS_MEMBER] if has_comp else [])
        try:
            with np.load(io.BytesIO(blob), allow_pickle=False) as z:
                a = {k: z[k] for k in keys}
        except Exception as e:
            raise ValueError(f"unreadable npz ({e.__class__.__name__}: {e})")
        components = None
        skipped = False
        if has_comp:
            c = a[COMPONENTS_MEMBER]
            if c.dtype.kind != "U" or c.shape != () or len(str(c)) > MAX_COMPONENTS_JSON:
                raise ValueError(f"{COMPONENTS_MEMBER} must be a 0-d unicode string ≤ {MAX_COMPONENTS_JSON} chars")
            try:
                obj = json.loads(str(c), parse_constant=_no_constant)
                skipped = obj is None               # JSON null: the worker's fit was attempted and failed
                components = None if skipped else validate_components(obj)
            except ValueError as e:
                raise ValueError(f"invalid components: {e}")
            except Exception as e:
                raise ValueError(f"invalid components ({e.__class__.__name__})")
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
        from tngsight.geometry import make_endpoints, make_sightline
        if geom.get("kind") == "endpoints":
            want = make_endpoints(geom["p0_kpc"], geom["p1_kpc"])
        else:
            want = make_sightline(geom["orientation"], float(geom["b_kpc"]), float(geom["azimuth_deg"]),
                                  seed=geom.get("seed"))
        if not isinstance(g, dict):
            raise ValueError("geom is not a JSON object")
        for key in ("n_los", "start_kpc", "end_kpc"):
            try:
                ok = np.allclose(np.asarray(g.get(key, np.nan), float), np.asarray(want[key], float),
                                 rtol=1e-9, atol=1e-9)
            except (TypeError, ValueError):
                ok = False
            if not ok:
                raise ValueError(f"geom {key} does not match job {geom['id']}")
        payload = lib.load_npz(io.BytesIO(blob), id=geom["id"])
        payload["id"] = geom["id"]
        if components is not None:
            payload["components"] = components
        elif skipped:
            payload["components_skipped"] = True
        return payload


def _no_constant(name):
    raise ValueError(f"non-finite number {name} in components")


def _atomic_write(path: Path, data: bytes):
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _http_status(e):
    code = getattr(getattr(e, "response", None), "status_code", None)
    if code is None:
        # hf_xet raises a bare RuntimeError: "... HTTP status client error (403 Forbidden) ..."
        m = re.search(r"\b(401|403) (?:Unauthorized|Forbidden)\b", str(e))
        code = int(m.group(1)) if m else None
    return code


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
                            token=self.token, ignore_patterns=list(DOWNLOAD_IGNORE))
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
        """Queue generated/<id>.npz|.bin|.components.json files present locally but absent from the dataset."""
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
                    sid = p.name[: -len(COMPONENTS_SUFFIX)] if p.name.endswith(COMPONENTS_SUFFIX) else (
                        p.stem if p.suffix in (".npz", ".bin") else None)
                    if sid and ID_RE.fullmatch(sid) and dest not in remote and dest not in self._pending:
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
