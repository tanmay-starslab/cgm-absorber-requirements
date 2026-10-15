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
NPZ_FORMAT = "tngsight-npz/2"
COMPONENTS_MEMBER = "components_json"          # optional extra npz member of a worker result
COMPONENTS_SUFFIX = ".components.json"
COMPONENTS_DOC_VERSION = 2
DOWNLOAD_IGNORE = ("vol/*", "components/*")   # dataset backups of Phase-2 builds the server never reads
# a generated row lacking one of these is rebuilt by reconcile() (Phase-1 rows; pre-v2 rows)
_ROW_KEYS = ("p0", "p1", "has_components", "logN_aod", "data_version", "lines")
MAX_UNZIPPED = 50 * 1024 * 1024
MAX_COMPONENTS_JSON = 1024 * 1024
COMP_KEYS = ("v", "dv", "logN", "dlogN", "b", "db", "region", "flag", "EW")
_COMP_NULLABLE = ("dv", "dlogN", "db")
_FLAG_MAX = 255                                # vpfit FLAGS + BUDGET 128 (design.md §2.6)
_LEGACY_DROPPED = ("HILyb",)                  # v1 H I Lyβ: not a registry line, dropped (as tngsight.components)
_V1_HINT = ("OVI_lambda.npy", "HILyb_tau.npy", "CIII_rest.npy")


def _ions():
    from tngsight import ions
    return ions


def KEYS() -> tuple:
    """The registry line keys, in order (tngsight.ions.KEYS)."""
    return tuple(_ions().KEYS)


def NPZ_KEYS(lines) -> list:
    """npz v2 members, in order, for a list of line keys (design.md §2.3)."""
    out = ["format", "geom", "v_sys", "lines", "generation"]
    for k in lines:
        out += [f"logN_{k}", f"{k}_tau", f"{k}_lam0", f"{k}_dlam", f"{k}_rest", f"{k}_W"]
    return out


def registry_tag() -> str:
    return _ions().registry_tag()


def check_id(sid: str) -> str:
    if not isinstance(sid, str) or not ID_RE.fullmatch(sid):
        raise ValueError(f"invalid sightline id {sid!r}")
    return sid


def _lib():
    from tngsight import library
    return library


def _components_mod():
    """tngsight.components, or None when it is not importable."""
    try:
        from tngsight import components
        return components
    except ImportError:
        return None


def _components_v2():
    """tngsight.components when it implements catalogue v2 (rows, any subset of KEYS), else None."""
    mod = _components_mod()
    return mod if mod is not None and getattr(mod, "CATALOGUE_VERSION", 1) >= 2 else None


# ------------------------------------------------------------------------------ components (v2)
def _logn_max(k) -> float:
    return float(_ions().atomic(k)["logN_max"])


def rows_to_dicts(rows) -> list:
    return [c if isinstance(c, dict) else dict(zip(COMP_KEYS, c)) for c in rows]


def dicts_to_rows(comps) -> list:
    """Rows (COMP_KEYS order); a malformed dict keeps its gaps as None so the receiver rejects it."""
    return [list(c) if not isinstance(c, dict) else [c.get(k) for k in COMP_KEYS] for c in comps]


def _basic_validate_components(obj) -> dict:
    """Registry-driven fallback for tngsight.components.validate_components (v2), same rules: a rows object
    {k: [[v, dv, logN, dlogN, b, db, region, flag, EW], ...]} or dict-of-dicts {k: [{...}]}, keys a
    non-empty subset of the registry KEYS (legacy HILyb dropped), logN <= logN_max, b in [1, 150],
    |v| <= 11000, flag 0..255. Returns the normalised dict form."""
    keys = KEYS()
    if isinstance(obj, dict):
        obj = {k: v for k, v in obj.items() if k not in _LEGACY_DROPPED}
    if not isinstance(obj, dict) or not obj or not set(obj) <= set(keys):
        raise ValueError(f"components must have a non-empty subset of the keys {list(keys)}")
    out = {}
    for ion in [k for k in keys if k in obj]:
        comps = obj[ion]
        if not isinstance(comps, list) or len(comps) > 30:
            raise ValueError(f"components[{ion}] must be a list of at most 30 components")
        res = []
        for i, c in enumerate(comps):
            where = f"components[{ion}][{i}]"
            if isinstance(c, list):
                if len(c) != len(COMP_KEYS):
                    raise ValueError(f"{where}: a row must have {len(COMP_KEYS)} values {list(COMP_KEYS)}")
                c = dict(zip(COMP_KEYS, c))
            if not isinstance(c, dict) or set(c) != set(COMP_KEYS):
                raise ValueError(f"{where}: keys must be {list(COMP_KEYS)}")
            for k in COMP_KEYS:
                x = c[k]
                if x is None and k in _COMP_NULLABLE:
                    continue
                if isinstance(x, bool) or not isinstance(x, (int, float)) or not np.isfinite(x):
                    raise ValueError(f"{where}.{k}: not a finite number")
            if not 10 <= c["logN"] <= _logn_max(ion) or not 1 <= c["b"] <= 150 or abs(c["v"]) > 11000:
                raise ValueError(f"{where}: logN/b/v out of range")
            if isinstance(c["flag"], bool) or not isinstance(c["flag"], int) or not 0 <= c["flag"] <= _FLAG_MAX:
                raise ValueError(f"{where}.flag: must be an int in 0..{_FLAG_MAX}")
            if isinstance(c["region"], bool) or not isinstance(c["region"], int) or c["region"] < 0:
                raise ValueError(f"{where}.region: must be a non-negative int")
            res.append({k: c[k] for k in COMP_KEYS})
        out[ion] = res
    return out


def validate_components(obj) -> dict:
    """tngsight.components.validate_components (v2) when available, else the same rules locally.
    Accepts the rows object or dict-of-dicts; returns the dict form {k: [{...}]}."""
    mod = _components_v2()
    if mod is not None and hasattr(mod, "validate_components"):
        return mod.validate_components(obj)
    return _basic_validate_components(obj)


def _opt_num(x, where):
    if x is None:
        return None
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not np.isfinite(x):
        raise ValueError(f"{where}: not a finite number")
    return x


def normalize_aod(obj, keys=None) -> dict:
    """AOD record -> v2 form {k: [logN_aod_total|null, [[region, v_lo, v_hi, logN_aod|null], ...]]}.
    Accepts the v2 form and the v1 dict form {k: {"logN_aod", "regions": [{region, v_lo, v_hi, logN_aod}]}}."""
    if not isinstance(obj, dict):
        raise ValueError("aod must be an object")
    allowed = set(KEYS()) if keys is None else set(keys)
    out = {}
    for k, a in obj.items():
        if k not in allowed:
            raise ValueError(f"aod: unknown line {str(k)[:12]!r}")
        if isinstance(a, dict):
            if set(a) != {"logN_aod", "regions"}:
                raise ValueError(f"aod.{k}: expected [logN_aod, regions]")
            a = [a["logN_aod"], [[r.get("region"), r.get("v_lo"), r.get("v_hi"), r.get("logN_aod")]
                                 if isinstance(r, dict) else r for r in a["regions"]]]
        if not isinstance(a, list) or len(a) != 2 or not isinstance(a[1], list) or len(a[1]) > 200:
            raise ValueError(f"aod.{k}: expected [logN_aod, regions]")
        regions = []
        for i, r in enumerate(a[1]):
            w = f"aod.{k}[{i}]"
            if not isinstance(r, list) or len(r) != 4:
                raise ValueError(f"{w}: expected [region, v_lo, v_hi, logN_aod]")
            if isinstance(r[0], bool) or not isinstance(r[0], int) or r[0] < 0:
                raise ValueError(f"{w}.region: must be a non-negative int")
            if _opt_num(r[1], f"{w}.v_lo") is None or _opt_num(r[2], f"{w}.v_hi") is None:
                raise ValueError(f"{w}: v_lo/v_hi required")
            regions.append([r[0], r[1], r[2], _opt_num(r[3], f"{w}.logN_aod")])
        out[k] = [_opt_num(a[0], f"aod.{k}.logN_aod"), regions]
    return out


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


def _component_doc(sid, comps_dicts, aod, info) -> dict:
    """The per-sightline v2 document (design.md §4.1), components as rows."""
    return {"version": COMPONENTS_DOC_VERSION, "id": sid, "fitter": info.get("fitter"),
            "params_tag": info.get("params_tag"), "comp_keys": list(COMP_KEYS),
            "components": {k: dicts_to_rows(v) for k, v in comps_dicts.items()},
            "aod": aod or {}}


def _read_component_doc(sid, doc) -> dict:
    """A stored doc (v1 {"id","fitter","params_tag","components": {ion: [dict]}} or v2) -> v2 doc;
    v1 HILyb (Lyβ, not a registry line) is dropped. Raises ValueError when unusable."""
    if not isinstance(doc, dict) or not isinstance(doc.get("components"), dict):
        raise ValueError("not a components document")
    comps = {k: v for k, v in doc["components"].items() if k in KEYS()}
    dicts = validate_components({k: rows_to_dicts(v) if isinstance(v, list) else v for k, v in comps.items()})
    aod = doc.get("aod") if doc.get("version") == COMPONENTS_DOC_VERSION else None
    aod = normalize_aod({k: v for k, v in (aod or {}).items() if k in dicts})
    return _component_doc(sid, dicts, aod, {"fitter": doc.get("fitter"), "params_tag": doc.get("params_tag")})


def n_fit(doc_or_components) -> dict:
    comps = doc_or_components.get("components", doc_or_components) if isinstance(doc_or_components, dict) else {}
    return {k: len(v or []) for k, v in comps.items()}


def npz_like(payload) -> dict:
    """The save_npz(path, payload_like) dict (design.md §2.3) of a load_npz-style v2 payload: lam0/dlam
    from the payload when present, else from its wavelength arrays."""
    lines = list(payload["lines"])
    lam0, dlam = dict(payload.get("lam0") or {}), dict(payload.get("dlam") or {})
    for k in lines:
        if k not in lam0 or k not in dlam:
            lam = np.asarray(payload["lam"][k], np.float64)
            lam0[k] = float(lam[0])
            dlam[k] = float((lam[-1] - lam[0]) / (lam.size - 1))
    gen = dict(payload.get("generation") or {})
    return {"geom": payload["geom"], "v_sys": float(payload["v_sys"]), "lines": lines, "generation": gen,
            "logN": {k: float(payload["logN"][k]) for k in lines}, "tau": {k: payload["tau"][k] for k in lines},
            "lam0": lam0, "dlam": dlam, "rest": {k: float(payload["rest"][k]) for k in lines},
            "W": {k: float(payload["W"][k]) for k in lines}}


def _bin_version(blob: bytes):
    return blob[4] if len(blob) >= 16 and blob[:4] == b"TNGS" else None


class LibraryStore:
    """<root>/catalog.json, <root>/sightlines/*.npz (library), <root>/generated/<id>.npz|.bin,
    <root>/web/<id>.bin. Generated sightlines are persisted here and mirrored by `hf` if set.
    npz files may be v1 or v2 (tngsight.library.load_npz reads both); web binaries are always served as
    TNGS v2 (a cached v1 .bin is re-encoded from its npz on first read and replaced)."""

    def __init__(self, root, hf=None):
        self.root = Path(root)
        self.gen_dir, self.web_dir, self.lib_dir = (self.root / d for d in ("generated", "web", "sightlines"))
        for d in (self.root, self.gen_dir, self.web_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.hf = hf
        self._lock = threading.RLock()
        self._doc = None
        self._comp_cache: dict = {}            # sid -> components doc v2 (validated)
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
        if p is None:
            return None
        payload = _lib().load_npz(p, id=sid)
        payload["id"] = sid
        return payload

    def bin_bytes(self, sid) -> bytes | None:
        """TNGS v2 web binary. A cached .bin (web/ or generated/) is served as is when it is v2; a v1 one is
        re-encoded from the npz (v1 npz -> 2 lines) and the v2 bytes replace it. Without any .bin, the
        binary is built from the npz and cached under web/."""
        check_id(sid)
        for p in (self.web_dir / f"{sid}.bin", self.gen_dir / f"{sid}.bin"):
            if p.is_file():
                blob = p.read_bytes()
                if _bin_version(blob) == 2:
                    return blob
                payload = self.load_payload(sid)
                if payload is None:
                    log.warning("%s: cached web binary is v%s and no npz exists to re-encode it",
                                p.name, _bin_version(blob))
                    return blob
                new = _lib().encode_web(payload)
                _atomic_write(p, new)
                if self.hf is not None and p.parent == self.gen_dir:
                    self.hf.upload(p, f"generated/{p.name}")
                return new
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
        """Stored per-sightline v2 doc {"version": 2, "id", "fitter", "params_tag", "comp_keys",
        "components": {k: rows}, "aod": {k: ...}} of a generated sightline (validated, cached; a v1 file is
        read and converted)."""
        check_id(sid)
        with self._lock:
            if sid in self._comp_cache:
                return self._comp_cache[sid]
        p = self.components_path(sid)
        if not p.is_file():
            return None
        try:
            doc = _read_component_doc(sid, json.loads(p.read_text()))
        except Exception as e:
            log.warning("components file %s unusable: %s", p.name, e)
            return None
        with self._lock:
            self._comp_cache[sid] = doc
        return doc

    def components_index(self) -> tuple[bytes, str]:
        """GET /api/components body {"version": 2, "fitter", "params_tag", "comp_keys", "entries": {id: {k: rows}},
        "aod": {id: {k: ...}}} + ETag."""
        with self._lock:
            if self._comp_doc is None:
                entries, aod, info = {}, {}, fitter_info()
                for p in sorted(self.gen_dir.glob(f"*{COMPONENTS_SUFFIX}")):
                    sid = p.name[: -len(COMPONENTS_SUFFIX)]
                    if not ID_RE.fullmatch(sid):
                        continue
                    d = self.components(sid)
                    if d is not None:
                        entries[sid] = d["components"]
                        aod[sid] = d["aod"]
                        if info["fitter"] is None:
                            info = {"fitter": d.get("fitter"), "params_tag": d.get("params_tag")}
                doc = {"version": COMPONENTS_DOC_VERSION, **info, "comp_keys": list(COMP_KEYS),
                       "entries": entries, "aod": aod}
                body = json.dumps(doc, separators=(",", ":"), allow_nan=False, sort_keys=True).encode()
                self._comp_doc = (body, '"' + hashlib.sha1(body).hexdigest()[:20] + '"')
            return self._comp_doc

    def _fit(self, payload) -> tuple | None:
        """(components dicts, aod v2) from the installed fitter, or None."""
        mod = _components_mod()
        if mod is None:
            return None
        try:
            aod: dict = {}
            comps = mod.fit_payload(payload, aod=aod)
            return comps, (normalize_aod(aod) if aod else {})
        except Exception as e:          # components are optional; never lose a sightline over them
            log.warning("fit %s failed: %s", payload.get("id"), e)
            return None

    def _write_components(self, sid, comps, aod=None, upload=True) -> bool:
        """Validate + persist <gen>/<id>.components.json (v2 doc, atomic) and queue its HF upload."""
        try:
            dicts = validate_components(comps)
            aod = normalize_aod({k: v for k, v in (aod or {}).items() if k in dicts})
            doc = _component_doc(sid, dicts, aod, fitter_info())
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
        """Persist a generated v2 payload: npz v2 + TNGS v2 bin (+ components json) + catalog upsert
        (+ HF upload). components: argument, else payload["components"] (with payload["components_aod"]),
        else a best-effort fit in this thread, but only when the generator never attempted one:
        payload["components_skipped"] marks a fit that was attempted and failed, which is deterministic, so
        it is left to the background backfill instead of being repeated while the job is finishing."""
        lib = _lib()
        sid = check_id(payload["id"])
        aod = payload.get("components_aod")
        if components is None:
            components = payload.get("components")
        if components is None and not payload.get("components_skipped"):
            fitted = self._fit(payload)
            if fitted is not None:
                components, aod = fitted
        if components is not None and not self._write_components(sid, components, aod, upload=False):
            components = None
        if scores is None:
            try:
                from tngsight.scoring import score_payload
                scores = score_payload(payload)
            except Exception as e:      # scoring is cosmetic; never lose a computed sightline over it
                log.warning("scoring %s failed: %s", sid, e)
                scores = None
        npz = self.gen_dir / f"{sid}.npz"
        lib.save_npz(npz, npz_like(payload))         # atomic (tmp + replace), npz v2
        blob = lib.encode_web(payload)
        _atomic_write(self.gen_dir / f"{sid}.bin", blob)
        stored = self.components(sid) if components is not None else None
        entry = lib.catalog_entry(payload, scores, "generated",
                                  components=validate_components(stored["components"]) if stored else None)
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
        generated rows written before the current row schema (no p0/p1, has_components, logN_aod,
        data_version or lines: Phase-1 and pre-v2 rows; a v1 npz gives a data_version 1 row), then
        (background thread, best effort) fit components for generated sightlines that lack them. Returns
        the number of rows added or rebuilt."""
        n = 0
        for p in sorted(self.gen_dir.glob("*.npz")):
            sid = p.stem
            if not ID_RE.fullmatch(sid):
                continue
            old = self.catalog.get(sid)
            if old is not None and all(k in old for k in _ROW_KEYS):
                continue
            try:
                payload = _lib().load_npz(p, id=sid)
                payload["id"] = sid
                try:
                    from tngsight.scoring import score_payload
                    scores = score_payload(payload)
                except Exception as e:
                    log.warning("reconcile scoring %s failed: %s", sid, e)
                    scores = None
                d = self.components(sid)
                entry = _lib().catalog_entry(payload, scores, "generated",
                                             components=validate_components(d["components"]) if d else None)
                if old is not None:          # keep anything the old row had that the new schema lacks
                    entry = {**{k: v for k, v in old.items() if k not in ("logN", "ions", "n_fit")}, **entry}
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
                payload = _lib().load_npz(self.gen_dir / f"{sid}.npz", id=sid)
                payload["id"] = sid
                fitted = self._fit(payload)
                if fitted is None or not self._write_components(sid, *fitted):
                    continue
                with self._lock:
                    e = self.catalog.get(sid)
                    if e is not None:
                        e.update(has_components=True, n_fit=n_fit(self.components(sid)))
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
        """Check an uploaded npz v2 without unpickling anything, then return load_npz() of it.
        Raises ValueError with a message suitable for the HTTP 422 body (design.md §4.1)."""
        if len(blob) > max_bytes:
            raise ValueError(f"result too large ({len(blob)} > {max_bytes} bytes)")
        try:
            zf = zipfile.ZipFile(io.BytesIO(blob))
            names = [i.filename for i in zf.infolist()]
            if sum(i.file_size for i in zf.infolist()) > MAX_UNZIPPED:
                raise ValueError("result decompresses too large")
        except zipfile.BadZipFile:
            raise ValueError("result is not an npz archive")
        if "format.npy" not in names:
            if any(n in names for n in _V1_HINT) or any(n.endswith("_lambda.npy") for n in names):
                raise ValueError("worker result is npz v1; update the worker")
            raise ValueError("npz has no format member (not an npz v2 result)")

        def member(z, k, kind):
            a = z[k]
            if a.shape != () or a.dtype.kind != kind:
                raise ValueError(f"{k} must be a 0-d {'unicode string' if kind == 'U' else 'number'}")
            return a
        try:
            with np.load(io.BytesIO(blob), allow_pickle=False) as z:
                head = {k: member(z, k, "U") for k in ("format", "lines", "generation") if k + ".npy" in names}
        except ValueError:
            raise
        except Exception as e:
            raise ValueError(f"unreadable npz ({e.__class__.__name__}: {e})")
        if str(head.get("format")) != NPZ_FORMAT:
            raise ValueError(f"npz format {str(head.get('format'))[:40]!r} != {NPZ_FORMAT!r}")
        try:
            gen = json.loads(str(head["generation"]))
            lines = json.loads(str(head["lines"]))
        except (KeyError, ValueError):
            raise ValueError("npz lines/generation must be JSON")
        if not isinstance(gen, dict):
            raise ValueError("generation is not a JSON object")
        mine = registry_tag()
        if gen.get("registry_tag") != mine:
            raise ValueError(f"registry mismatch (worker {str(gen.get('registry_tag'))[:16]}, server {mine})")
        keys = list(KEYS())
        if lines != keys:
            missing = [k for k in keys if not isinstance(lines, list) or k not in lines]
            raise ValueError(f"lines must be all {len(keys)} registry keys in order" +
                             (f"; missing {', '.join(missing)}" if missing else f"; got {str(lines)[:200]}"))
        base = sorted(k + ".npy" for k in NPZ_KEYS(keys))
        has_comp = sorted(names) == sorted(base + [COMPONENTS_MEMBER + ".npy"])
        if sorted(names) != base and not has_comp:
            extra = sorted(set(n[:-4] for n in names) - set(NPZ_KEYS(keys)) - {COMPONENTS_MEMBER})
            miss = sorted(set(NPZ_KEYS(keys)) - set(n[:-4] for n in names))
            raise ValueError(f"npz members differ from npz v2 (missing {miss[:6]}, unexpected {extra[:6]})")
        try:
            with np.load(io.BytesIO(blob), allow_pickle=False) as z:
                a = {k: z[k] for k in NPZ_KEYS(keys) + ([COMPONENTS_MEMBER] if has_comp else [])}
        except Exception as e:
            raise ValueError(f"unreadable npz ({e.__class__.__name__}: {e})")
        components, aod, skipped = None, None, False
        if has_comp:
            c = a[COMPONENTS_MEMBER]
            if c.dtype.kind != "U" or c.shape != () or len(str(c)) > MAX_COMPONENTS_JSON:
                raise ValueError(f"{COMPONENTS_MEMBER} must be a 0-d unicode string ≤ {MAX_COMPONENTS_JSON} chars")
            try:
                obj = json.loads(str(c), parse_constant=_no_constant)
                skipped = obj is None               # JSON null: the worker's fit was attempted and failed
                if not skipped:
                    if not isinstance(obj, dict):
                        raise ValueError("components must be an object")
                    obj = dict(obj)
                    aod_obj = obj.pop("aod", None)
                    components = validate_components(obj)
                    aod = normalize_aod(aod_obj, keys=components) if aod_obj is not None else None
            except ValueError as e:
                raise ValueError(f"invalid components: {e}")
            except Exception as e:
                raise ValueError(f"invalid components ({e.__class__.__name__})")
        lib, ions = _lib(), _ions()
        for k in keys:
            lg = a[f"logN_{k}"]
            if lg.shape != () or lg.dtype.kind != "f" or np.isnan(lg) or lg == np.inf:
                raise ValueError(f"logN_{k} not a finite scalar (or -inf for a zero column)")
            W = a[f"{k}_W"]
            if W.shape != () or W.dtype.kind != "f" or not np.isfinite(W):
                raise ValueError(f"{k}_W not a finite scalar")
            want_W = float(ions.gen_window(k, float(lg)))
            if abs(float(W) - want_W) > 1e-9 * want_W:
                raise ValueError(f"{k}: window W {float(W):g} != {want_W:g} km/s for logN {float(lg):.3f}")
            lam0, dlam, n = lib.native_grid(k, want_W)
            tau = a[f"{k}_tau"]
            for m in (f"{k}_lam0", f"{k}_dlam", f"{k}_rest"):
                if a[m].shape != () or a[m].dtype.kind != "f" or not np.isfinite(a[m]):
                    raise ValueError(f"{m} not a finite scalar")
            rest = float(ions.get(k)["lam0_A"])
            if abs(float(a[f"{k}_rest"]) - rest) > 1e-9 * rest:
                raise ValueError(f"{k}: rest wavelength {float(a[f'{k}_rest'])} != registry {rest}")
            if tau.ndim != 1 or tau.size != n or tau.dtype.kind != "f":
                raise ValueError(f"{k}: tau shape {tau.shape} != native grid ({n},)")
            if abs(float(a[f"{k}_lam0"]) - lam0) > 1e-9 * rest or \
                    (n - 1) * abs(float(a[f"{k}_dlam"]) - dlam) > 1e-9 * rest:
                raise ValueError(f"{k}: wavelength grid mismatch")
            if not np.all(np.isfinite(tau)) or (tau.size and tau.min() < -1e-6):
                raise ValueError(f"{k}: tau not finite/non-negative")
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
            if aod:
                payload["components_aod"] = aod
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
