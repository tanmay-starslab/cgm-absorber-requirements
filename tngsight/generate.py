"""On-demand sightline generation from the slim cutout (port of tng50/scripts/gen_cgm_sightlines.py).

Recipe (generation.md §1.4–1.8, §6; Phase-3 design §2.1): yt.load(cutout, index_filename=<writable>) → add the
ion fields of the 12 registry ions (tngsight.ions) → trident.make_simple_ray between the ±R200c endpoints (ckpc/h) →
ion columns from the ray HDF5 → per line, with W = ions.gen_window(key, logN) (1500 km/s; wider for damped H I),
SpectrumGenerator(λ0(1∓W/c), dλ = λ0·0.25/c, line_database = lines.txt + the O VII supplement)
.make_spectrum(use_peculiar_velocity=True, use_doppler_redshift_only=True [trident fork], ly_continuum=False,
min_tau=SPEC_MIN_TAU) → float32 τ on the native grid (library.native_grid, checked). yt/trident import lazily.
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
import time
from pathlib import Path
import h5py
import numpy as np
from . import config
from . import ions as I
from .config import C_KMS, SPEC_MIN_TAU
from .geometry import make_sightline, make_endpoints, custom_id, geom_id, _ALIASES
from .library import native_grid, save_npz, load_npz, generation_record

ION_TABLE_FILE = "hm2012_ss_hr.h5"
RAY_FIELDS = [("gas", "density"), ("gas", "temperature"), ("gas", "metallicity"),
              ("gas", "H_number_density")] + [("gas", I.get(k)["field"]) for k in I.KEYS]
GEOM_KEYS = ("orientation", "b_kpc", "azimuth_deg", "inclination_deg", "n_los", "v_sys_kms", "half_kpc",
             "b_perp_check_kpc", "anchor_kpc", "start_kpc", "end_kpc", "start_ckpch", "end_ckpch")
STAGES = ("load", "ray") + tuple(f"spectrum:{k}" for k in I.KEYS) + ("fit", "save")
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
        for key in I.KEYS:
            fld = I.get(key)["field"]
            n = grid[fld][()] if fld in grid else np.zeros_like(dl)
            N = float(np.sum(n * dl))
            out[key] = np.log10(N) if N > 0 else -np.inf
    return out


# Trident's per-cell deposition window starts at 2 coarse bins and only widens while τ at its edge is ≥ min_tau,
# so a cell whose peak τ is already < min_tau is deposited over ~1 bin only (a few % of its column). The v1 library
# was made with Trident's default 1e-3 (deficits up to ~0.2 dex for weak, diffuse absorbers); v2 uses
# config.SPEC_MIN_TAU = 1e-8 (≤ 0.0005 dex), recorded in every npz (generation.min_tau).
GRID_RTOL = 1e-9


def line_database(trident):
    """Trident's lines.txt plus the registry's supplement lines (O VII)."""
    ld = trident.LineDatabase("lines.txt")
    I.add_supplement_lines(ld)
    return ld


def make_line_spectrum(trident, ray, key, W, line_db, min_tau=None):
    """(lam0, dlam, tau f4) of one line on its native grid (design §2.1). Raises RuntimeError when Trident's grid
    differs from library.native_grid(key, W) (no silent resampling)."""
    rest = float(I.get(key)["lam0_A"])
    lam0, dlam, n = native_grid(key, W)
    sg = trident.SpectrumGenerator(lambda_min=rest * (1 - W / C_KMS), lambda_max=rest * (1 + W / C_KMS),
                                   dlambda=rest * config.DV_NATIVE / C_KMS, bin_space="wavelength",
                                   line_database=line_db)
    sg.make_spectrum(ray, lines=[I.get(key)["trident_line"]], use_peculiar_velocity=True,
                     use_doppler_redshift_only=True, ly_continuum=False, njobs=1,
                     min_tau=SPEC_MIN_TAU if min_tau is None else float(min_tau))
    lam = np.asarray(sg.lambda_field, np.float64); tau = np.asarray(sg.tau_field)
    if lam.size != n or tau.size != n:
        raise RuntimeError(f"{key}: Trident grid has {lam.size} samples, native_grid {n}")
    dev = float(np.max(np.abs(lam - (lam0 + np.arange(n) * dlam))))
    if dev > GRID_RTOL * rest:
        raise RuntimeError(f"{key}: Trident wavelength grid differs from native_grid by {dev:.3g} Å")
    return lam0, dlam, tau.astype(np.float32)


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
        aod = {}
        comps = _components.fit_payload(payload, progress, aod=aod)
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
    payload["components_aod"] = aod                         # fit regions: the browser fitter's windows (§5.3)
    progress("fit", 1.0, "components fitted")
    return payload


class Generator:
    """Warm generator: one cached yt dataset; ray casts serialised by a lock (yt is not thread-safe)."""

    def __init__(self, cutout=None, ion_table_dir=None, index_filename=None, workdir=None,
                 fit_components=True, min_tau=None):
        self.min_tau = float(SPEC_MIN_TAU if min_tau is None else min_tau)
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
            trident.add_ion_fields(ds, ions=[I.get(k)["ion"] for k in I.KEYS], ftype="gas",
                                   ionization_table=str(self.ion_table_dir / ION_TABLE_FILE))
            self._ld = line_database(trident)
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
            ray = None
            pl = {"geom": sl, "lines": list(I.KEYS), "generation": generation_record(self.min_tau),
                  "logN": {}, "tau": {}, "lam0": {}, "dlam": {}, "rest": {}, "W": {}}
            self.timings = {}
            try:
                t0 = time.perf_counter()
                ray = cast_ray(tr, self.ds, sl, tmp)
                cols = ray_columns(tmp)
                self.timings["ray"] = time.perf_counter() - t0
                progress("ray", 1.0, "ray done")
                t0 = time.perf_counter()
                for key in I.KEYS:
                    W = I.gen_window(key, cols[key])
                    progress(f"spectrum:{key}", 0.0, f"depositing {I.get(key)['trident_line']} (±{W:.0f} km/s)")
                    lam0, dlam, tau = make_line_spectrum(tr, ray, key, W, self._ld, self.min_tau)
                    pl["logN"][key] = cols[key]; pl["tau"][key] = tau; pl["lam0"][key] = lam0
                    pl["dlam"][key] = dlam; pl["rest"][key] = float(I.get(key)["lam0_A"]); pl["W"][key] = W
                    progress(f"spectrum:{key}", 1.0, "done")
                self.timings["spectra"] = time.perf_counter() - t0
            finally:
                del ray
                if os.path.exists(tmp):
                    os.remove(tmp)
        buf = io.BytesIO()                      # round trip through the npz writer (exact stored dtypes)
        save_npz(buf, pl)
        buf.seek(0)
        payload = load_npz(buf, id=gid)
        if self.fit_components:
            t0 = time.perf_counter()
            fit_stage(payload, progress)
            self.timings["fit"] = time.perf_counter() - t0        # stage "fit" (skipped cleanly without tngsight.components)
        progress("save", 0.0, "packing npz")
        progress("save", 1.0, "done")
        return payload
