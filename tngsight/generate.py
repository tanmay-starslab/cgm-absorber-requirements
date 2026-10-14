"""On-demand sightline generation from the slim cutout (port of tng50/scripts/gen_cgm_sightlines.py).

Recipe (generation.md §1.4–1.8, §6): yt.load(cutout, index_filename=<writable>) → add O VI/H I/C III
ion fields → trident.make_simple_ray between the ±R200c endpoints (ckpc/h) → ion columns from the ray
HDF5 → per line SpectrumGenerator(rest(1∓1500/c), dλ=0.002).make_spectrum(use_peculiar_velocity=True,
use_doppler_redshift_only=True [trident fork], ly_continuum=False) → float32. yt/trident import lazily.
Geometry: a canonicalize() dict (orientation/b/azimuth), a canonicalize_endpoints() dict (custom ray
p0 -> p1, kind "endpoints") or a full stored geom. Optional "fit" stage (Voigt components) after the
spectra, guarded so a computed sightline is never lost over the fit.
"""
from __future__ import annotations
import io
import logging
import os
import sys
import tempfile
import threading
from pathlib import Path
import h5py
import numpy as np
from . import config
from .config import C_KMS, DLAMBDA, VWIN_GEN_KMS, LINE_KEYS, LINES
from .geometry import make_sightline, make_endpoints, custom_id, geom_id, _ALIASES
from .library import wavelength_grid, save_npz, load_npz

ION_TABLE_FILE = "hm2012_ss_hr.h5"
RAY_FIELDS = [("gas", "density"), ("gas", "temperature"), ("gas", "metallicity"),
              ("gas", "H_number_density")] + [("gas", LINES[k]["field"]) for k in LINE_KEYS]
GEOM_KEYS = ("orientation", "b_kpc", "azimuth_deg", "inclination_deg", "n_los", "v_sys_kms", "half_kpc",
             "b_perp_check_kpc", "anchor_kpc", "start_kpc", "end_kpc", "start_ckpch", "end_ckpch")
STAGES = ("load", "ray") + tuple(f"spectrum:{k}" for k in LINE_KEYS) + ("fit", "save")
_IMPORT_LOCK = threading.Lock()
log = logging.getLogger("tngsight.generate")


def _noop(stage, frac, msg):
    pass


def import_trident(workdir, ion_table_dir):
    """Import trident with <workdir>/config.tri as ./config.tri (trident parses the cwd config at
    import; a missing config or table would call input() and hang). Restores the cwd. -> (yt, trident)"""
    with _IMPORT_LOCK:
        if "trident" not in sys.modules:
            table = Path(ion_table_dir) / ION_TABLE_FILE
            if not table.exists():
                raise FileNotFoundError(f"ion table not found: {table}")
            workdir = Path(workdir); workdir.mkdir(parents=True, exist_ok=True)
            (workdir / "config.tri").write_text(
                f"[Trident]\nion_table_dir = {Path(ion_table_dir).resolve()}\nion_table_file = {ION_TABLE_FILE}\n")
            old = os.getcwd()
            os.chdir(workdir)
            try:
                import trident  # noqa: F401
            finally:
                os.chdir(old)
        import yt
        import trident
        yt.set_log_level(50)
        return yt, trident


def cast_ray(trident, ds, geom, tmp):
    p0 = ds.arr(np.array(geom["start_ckpch"], float), "code_length")
    p1 = ds.arr(np.array(geom["end_ckpch"], float), "code_length")
    ds.domain_left_edge = ds.domain_left_edge.copy()     # LightRay mutates the edges in place
    ds.domain_right_edge = ds.domain_right_edge.copy()
    if os.path.exists(tmp):
        os.remove(tmp)
    return trident.make_simple_ray(ds, start_position=p0, end_position=p1,
                                   fields=RAY_FIELDS, ftype="gas", data_filename=tmp)


def ray_columns(tmp) -> dict:
    """log10 N = log10 Σ n_ion dl [cm^-2] from the ray HDF5 (-inf if zero)."""
    out = {}
    with h5py.File(tmp, "r") as h:
        grid = h["grid"]
        dl = grid["dl"][()]
        for key in LINE_KEYS:
            fld = LINES[key]["field"]
            n = grid[fld][()] if fld in grid else np.zeros_like(dl)
            N = float(np.sum(n * dl))
            out[key] = np.log10(N) if N > 0 else -np.inf
    return out


# Trident's per-cell deposition window starts at 2 coarse bins and only widens while τ at its edge is ≥ min_tau,
# so a cell whose peak τ is already < min_tau is deposited over ~1.2 km/s only (a few % of its column). With the
# Trident default 1e-3 (which the 672-sightline library was made with) weak, diffuse absorbers carry up to ~2 dex
# less column in τ than the ray holds (catalog logN vs logN_aod). 1e-8 deposits them in full but makes new
# spectra inconsistent with the library until it is regenerated (owner decision), so the default stays 1e-3.
SPEC_MIN_TAU = float(os.environ.get("TNG_SPEC_MIN_TAU") or 1e-3)


def make_line_spectrum(trident, ray, key, min_tau=None):
    L = LINES[key]; rest = L["rest_A"]
    lam_min = rest * (1 - VWIN_GEN_KMS / C_KMS); lam_max = rest * (1 + VWIN_GEN_KMS / C_KMS)
    sg = trident.SpectrumGenerator(lambda_min=lam_min, lambda_max=lam_max, dlambda=DLAMBDA)
    sg.make_spectrum(ray, lines=[L["trident_line"]], use_peculiar_velocity=True,
                     use_doppler_redshift_only=True, ly_continuum=False, njobs=1,
                     min_tau=SPEC_MIN_TAU if min_tau is None else float(min_tau))
    lam = np.array(sg.lambda_field); tau = np.array(sg.tau_field)
    return lam.astype(np.float32), tau.astype(np.float32)


def resolve_geometry(geom: dict):
    """(geometry dict, id) from a canonicalize() dict, a canonicalize_endpoints() dict (kind "endpoints",
    id defaults to custom_id) or a full stored geom (+ optional "id"; endpoint geoms keep every key)."""
    if geom.get("kind") == "endpoints":
        if "start_ckpch" in geom:
            sl = {k: v for k, v in geom.items() if k != "id"}
        else:
            sl = make_endpoints(geom["p0_kpc"], geom["p1_kpc"])
        return sl, geom.get("id") or custom_id(sl["p0_kpc"], sl["p1_kpc"])
    if "start_ckpch" in geom:
        sl = {k: geom[k] for k in GEOM_KEYS}
        gid = geom.get("id")
        if gid is None:
            if str(sl["orientation"]).lower().startswith("rand"):
                raise ValueError("a random-orientation geom needs an explicit 'id' (its seed is not stored)")
            gid = geom_id(sl["orientation"], sl["b_kpc"], sl["azimuth_deg"], inclination_deg=sl["inclination_deg"])
        return sl, gid
    o = str(geom["orientation"])
    o = _ALIASES.get("".join(ch for ch in o.lower() if ch not in "-_ "), o)
    seed = geom.get("seed")
    if o == "random" and seed is None:
        raise ValueError("seed is required for random orientation")
    sl = make_sightline(o, float(geom["b_kpc"]), float(geom["azimuth_deg"]), seed=seed)
    return sl, geom.get("id") or geom_id(o, geom["b_kpc"], geom["azimuth_deg"], seed=seed)


# ------------------------------------------------------------------------------- fit stage (hook)
def fit_stage(payload: dict, progress=None) -> dict:
    """INTEGRATION HOOK — Voigt-component "fit" stage (design §4.2). Sets payload["components"] =
    tngsight.components.fit_payload(payload, progress) (U_fit's module). If that module is not
    importable or the fit raises, logs a warning, reports progress("fit", 1.0, "skipped") and leaves
    the payload without "components"; a fit that raised also sets payload["components_skipped"] = True so
    LibraryStore.add_generated does not repeat the (deterministic) fit while the job finishes. Returns the
    payload."""
    progress = progress or _noop
    progress("fit", 0.0, "fitting Voigt components")
    try:
        from . import components as _components          # built by U_fit; absent before integration
        comps = _components.fit_payload(payload, progress)
    except ImportError as e:
        log.warning("fit stage skipped: tngsight.components unavailable (%s)", e)
        progress("fit", 1.0, "skipped")
        return payload
    except Exception as e:                                  # never lose a computed sightline over the fit
        log.warning("fit stage skipped for %s: %s: %s", payload.get("id"), e.__class__.__name__, e)
        progress("fit", 1.0, "skipped")
        payload.pop("components", None)
        payload["components_skipped"] = True                # attempted and failed: the coordinator won't redo it
        return payload
    payload["components"] = comps
    progress("fit", 1.0, "components fitted")
    return payload


class Generator:
    """Warm generator: one cached yt dataset; ray casts serialised by a lock (yt is not thread-safe)."""

    def __init__(self, cutout=None, ion_table_dir=None, index_filename=None, workdir=None,
                 fit_components=True):
        self.fit_components = bool(fit_components)
        self.cutout = Path(cutout) if cutout else config.cutout_path()
        self.ion_table_dir = Path(ion_table_dir) if ion_table_dir else config.ion_table_dir()
        self.index_filename = Path(index_filename) if index_filename else config.index_path()
        wd = workdir or os.environ.get("TNG_WORKDIR")
        self.workdir = Path(wd) if wd else Path(tempfile.mkdtemp(prefix="tngsight_"))
        self.ds = None
        self._lock = threading.RLock()

    @property
    def warm(self) -> bool:
        return self.ds is not None

    def load(self, progress=None) -> None:
        progress = progress or _noop
        with self._lock:
            if self.ds is not None:
                return
            if not self.cutout.exists():
                raise FileNotFoundError(f"cutout not found: {self.cutout}")
            progress("load", 0.0, "importing yt + trident")
            yt, trident = import_trident(self.workdir, self.ion_table_dir)
            progress("load", 0.3, "opening cutout")
            self.index_filename.parent.mkdir(parents=True, exist_ok=True)
            ds = yt.load(str(self.cutout), index_filename=str(self.index_filename))
            if ("gas", "metallicity") not in ds.derived_field_list:
                def _Z(field, data):
                    return data["PartType0", "GFM_Metallicity"]
                ds.add_field(("gas", "metallicity"), function=_Z, sampling_type="local",
                             units="", force_override=True)
            progress("load", 0.6, "adding ion fields")
            trident.add_ion_fields(ds, ions=[LINES[k]["ion"] for k in LINE_KEYS], ftype="gas",
                                   ionization_table=str(self.ion_table_dir / ION_TABLE_FILE))
            self.ds, self._trident = ds, trident
            progress("load", 1.0, "dataset ready")

    def generate(self, geom: dict, progress=None) -> dict:
        """Cast one sightline; returns the load_npz() payload (round-tripped through the npz writer)."""
        progress = progress or _noop
        sl, gid = resolve_geometry(geom)
        self.load(progress)
        tr = self._trident
        with self._lock:
            progress("ray", 0.0, f"casting ray {gid}")
            self.workdir.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self.workdir, prefix="_cgmray_", suffix=".h5"); os.close(fd)
            ray, taus = None, {}
            try:
                ray = cast_ray(tr, self.ds, sl, tmp)
                cols = ray_columns(tmp)
                progress("ray", 1.0, "ray done")
                for key in LINE_KEYS:
                    progress(f"spectrum:{key}", 0.0, f"depositing {LINES[key]['trident_line']}")
                    lam, tau = make_line_spectrum(tr, ray, key)
                    if not np.array_equal(lam, wavelength_grid(key)):
                        raise RuntimeError(f"{key}: Trident wavelength grid differs from library.wavelength_grid")
                    taus[key] = tau
                    progress(f"spectrum:{key}", 1.0, "done")
            finally:
                del ray
                if os.path.exists(tmp):
                    os.remove(tmp)
        buf = io.BytesIO()                      # round trip through the npz writer (exact stored dtypes)
        save_npz(buf, sl, cols, taus)
        buf.seek(0)
        payload = load_npz(buf, id=gid)
        if self.fit_components:
            fit_stage(payload, progress)        # stage "fit" (skipped cleanly without tngsight.components)
        progress("save", 0.0, "packing npz")
        progress("save", 1.0, "done")
        return payload
