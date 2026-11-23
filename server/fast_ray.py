"""Fast compiled C++17/OpenMP + AVX2 SIMD sightline ray-caster, 12-ion Faddeeva Voigt
optical-depth engine, and Voigt component fitter for live server requests.

Compiles `server/_fast_server_ray.cpp` -> `server/_fast_server_ray.so` with:
    g++ -O3 -march=native -fopenmp -shared -fPIC -std=c++17

Provides:
- `FastCutoutIndex`: Flat bounding-sphere BVH over `PartType0` gas cells + 12-ion
  CLOUDY (HM12 / FG11) lookup tables + FP64 Faddeeva Voigt spectrum synthesis +
  OpenMP 12-ion Voigt component fitting.
- `FastRayGenerator`: Drop-in replacement for `tngsight.generate.Generator` that is
  150x-300x faster than spawning `yt + Trident`.
"""
from __future__ import annotations

import ctypes
import math
import os
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import h5py
import numpy as np

from tngsight import components as C
from tngsight import config as CFG
from tngsight import degrade as D
from tngsight import generate as GEN
from tngsight import geometry as G
from tngsight import ions as I
from tngsight import library as L
from tngsight import vpfit as V

_HERE = Path(__file__).resolve().parent
CPP_PATH = _HERE / "_fast_server_ray.cpp"
SO_PATH = _HERE / "_fast_server_ray.so"

# Exact physical constants matching yt + Trident
PRIMORDIAL_H_MASS_FRAC = 0.76
GAMMA_IDEAL = 5.0 / 3.0
M_P_YT_CGS = 1.673735223805187e-24
K_B_YT_CGS = 1.3806488e-16
Z_SOLAR_YT = 0.01295
Z_SOLAR_FG11 = 0.0127

# Trident solar number abundances (n_X / n_H at Z = Z_solar)
SOLAR_ABUND_TRIDENT = {
    "H": 1.00e00,
    "C": 2.45e-04,
    "N": 8.51e-05,
    "O": 4.90e-04,
    "Ne": 1.00e-04,
    "Mg": 3.47e-05,
    "Si": 3.47e-05,
}

# Trident atomic masses [amu]
ELEMENT_MASS_AMU = {
    "H": 1.00794,
    "C": 12.0107,
    "N": 14.0067,
    "O": 15.9994,
    "Ne": 20.1797,
    "Mg": 24.3050,
    "Si": 28.0855,
}

# Mapping from the 12 explorer ion keys to (element, 0-based ionization stage, fg11_dataset_name)
ION_TABLE_SPECS = {
    "HI":     ("H",  0, "H_I"),
    "MgII":   ("Mg", 1, "Mg_II"),
    "SiII":   ("Si", 1, "Si_II"),
    "CII":    ("C",  1, "C_II"),
    "SiIII":  ("Si", 2, "Si_III"),
    "CIII":   ("C",  2, "C_III"),
    "SiIV":   ("Si", 3, "Si_IV"),
    "CIV":    ("C",  3, "C_IV"),
    "NV":     ("N",  4, "N_V"),
    "OVI":    ("O",  5, "O_VI"),
    "NeVIII": ("Ne", 7, "Ne_VIII"),
    "OVII":   ("O",  6, "O_VII"),
}

_LIB_LOCK = threading.Lock()
_LIB: ctypes.CDLL | None = None

_INDEX_CACHE_LOCK = threading.Lock()
_INDEX_CACHE: OrderedDict[tuple, "FastCutoutIndex"] = OrderedDict()
_INDEX_CACHE_MAX = 8


def ensure_compiled(force: bool = False) -> Path:
    """Compile `server/_fast_server_ray.cpp` -> `server/_fast_server_ray.so` if needed."""
    if not force and SO_PATH.is_file() and CPP_PATH.is_file():
        if SO_PATH.stat().st_mtime >= CPP_PATH.stat().st_mtime:
            return SO_PATH
    if not CPP_PATH.is_file():
        raise FileNotFoundError(f"C++ source not found: {CPP_PATH}")

    with tempfile.NamedTemporaryFile(
        prefix="_fast_server_ray_", suffix=".so", dir=str(_HERE), delete=False
    ) as tmp:
        tmp_path = Path(tmp.name)

    cmd = [
        os.environ.get("CXX", "g++"),
        "-O3",
        "-march=native",
        "-fopenmp",
        "-shared",
        "-fPIC",
        "-std=c++17",
        str(CPP_PATH),
        "-o",
        str(tmp_path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        os.replace(tmp_path, SO_PATH)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise
    return SO_PATH


def _get_lib() -> ctypes.CDLL:
    global _LIB
    if _LIB is not None:
        return _LIB
    with _LIB_LOCK:
        if _LIB is not None:
            return _LIB
        so_path = ensure_compiled()
        lib = ctypes.CDLL(str(so_path))

        c_double_p = ctypes.POINTER(ctypes.c_double)
        c_float_p = ctypes.POINTER(ctypes.c_float)
        c_int_p = ctypes.POINTER(ctypes.c_int)

        lib.fast_index_create.argtypes = [
            ctypes.c_int64,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            ctypes.c_double,
            ctypes.c_double,
            ctypes.c_double,
            ctypes.c_double,
        ]
        lib.fast_index_create.restype = ctypes.c_void_p

        lib.fast_index_destroy.argtypes = [ctypes.c_void_p]
        lib.fast_index_destroy.restype = None

        lib.fast_index_set_hm12_tables.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            c_double_p,
            ctypes.c_int,
            c_double_p,
            c_double_p,
            c_double_p,
            ctypes.c_double,
            c_int_p,
        ]
        lib.fast_index_set_hm12_tables.restype = ctypes.c_int

        lib.fast_index_set_cloudy_3d_tables.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            c_double_p,
            ctypes.c_int,
            c_double_p,
            ctypes.c_int,
            c_double_p,
            c_double_p,
            c_double_p,
            ctypes.c_double,
            c_int_p,
        ]
        lib.fast_index_set_cloudy_3d_tables.restype = ctypes.c_int

        lib.fast_trace_only.argtypes = [
            ctypes.c_void_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_int_p,
            c_double_p,
        ]
        lib.fast_trace_only.restype = ctypes.c_int

        lib.fast_trace_and_spectra.argtypes = [
            ctypes.c_void_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_int_p,
            c_int_p,
            ctypes.c_int,
            c_float_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_int_p,
            c_double_p,
            c_double_p,
        ]
        lib.fast_trace_and_spectra.restype = ctypes.c_int

        lib.fast_fit_components_12.argtypes = [
            ctypes.c_int,
            c_double_p,
            c_float_p,
            c_int_p,
            c_int_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_double_p,
            c_int_p,
            ctypes.c_int,
            c_int_p,
            c_double_p,
            c_int_p,
            c_double_p,
            c_int_p,
            c_double_p,
            c_double_p,
        ]
        lib.fast_fit_components_12.restype = ctypes.c_int

        _LIB = lib
        return _LIB


def find_ion_table_path(preferred: str | Path | None = None, table_type: str = "auto") -> tuple[Path | None, str]:
    """Locate the HM12 (`hm2012_ss_hr.h5`) or CLOUDY FG11 (`grid_ions.hdf5`) table."""
    if preferred is not None:
        p = Path(preferred).expanduser()
        if p.is_file():
            kind = "fg11" if "grid_ions" in p.name or table_type == "fg11" else "hm12"
            return p, kind

    env_table = os.environ.get("TNG_ION_TABLE")
    if env_table:
        p = Path(env_table).expanduser()
        if p.is_file():
            kind = "fg11" if "grid_ions" in p.name or table_type == "fg11" else "hm12"
            return p, kind

    hm12_candidates = [
        Path.home() / ".trident" / "hm2012_ss_hr.h5",
        Path("/home/tsingh65/.trident/hm2012_ss_hr.h5"),
        Path("/scratch/tsingh65/cgm_work/data/hm2012_ss_hr.h5"),
    ]
    fg11_candidates = [
        Path("/home/tsingh65/SBI_CGM/data/cloudy_grids/fg11/grid_ions.hdf5"),
        Path("/scratch/tsingh65/SBI_CGM/data/cloudy_grids/fg11/grid_ions.hdf5"),
    ]

    if table_type == "fg11":
        for p in fg11_candidates:
            if p.is_file():
                return p, "fg11"
    for p in hm12_candidates:
        if p.is_file():
            return p, "hm12"
    for p in fg11_candidates:
        if p.is_file():
            return p, "fg11"
    return None, "analytic"


def _load_hm12_2d_tables(h5_path: Path, redshift: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Load the 12 explorer ions from `hm2012_ss_hr.h5` sliced at `redshift`."""
    with h5py.File(h5_path, "r") as f:
        log_nh = np.asarray(f["H"].attrs["Parameter1"], dtype=np.float64)
        z_grid = np.asarray(f["H"].attrs["Parameter2"], dtype=np.float64)
        log_t = np.asarray(f["H"].attrs["Temperature"], dtype=np.float64)

        z_clamped = float(np.clip(redshift, z_grid[0], z_grid[-1]))
        iz = int(np.searchsorted(z_grid, z_clamped, side="right")) - 1
        iz = max(0, min(iz, len(z_grid) - 2))
        fz = (z_clamped - z_grid[iz]) / (z_grid[iz + 1] - z_grid[iz]) if z_grid[iz + 1] > z_grid[iz] else 0.0

        tables_12 = np.empty((len(I.KEYS), len(log_nh), len(log_t)), dtype=np.float64)
        for idx_k, key in enumerate(I.KEYS):
            el, stage, _ = ION_TABLE_SPECS[key]
            raw = np.asarray(f[el][stage], dtype=np.float64)
            # Exact Trident IonBalanceTable rule: replace values < log10(zero_threshold=-9) with -30 before interp
            raw[raw < -9.0] = -30.0
            tables_12[idx_k] = (1.0 - fz) * raw[:, iz, :] + fz * raw[:, iz + 1, :]

    return (
        np.ascontiguousarray(log_nh, dtype=np.float64),
        np.ascontiguousarray(log_t, dtype=np.float64),
        np.ascontiguousarray(tables_12, dtype=np.float64),
    )


def _load_cloudy_fg11_3d_tables(h5_path: Path, redshift: float = 0.0) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Load the 12 explorer ions from CLOUDY FG11 `grid_ions.hdf5` sliced at `redshift`."""
    with h5py.File(h5_path, "r") as f:
        z_grid = np.asarray(f["axes/redshift"][:], dtype=np.float64)
        log_nh = np.asarray(f["axes/log_nH"][:], dtype=np.float64)
        log_z = np.asarray(f["axes/log_Z_Zsun"][:], dtype=np.float64)
        log_t = np.asarray(f["axes/log_T"][:], dtype=np.float64)

        z_clamped = float(np.clip(redshift, z_grid[0], z_grid[-1]))
        iz = int(np.searchsorted(z_grid, z_clamped, side="right")) - 1
        iz = max(0, min(iz, len(z_grid) - 2))
        fz = (z_clamped - z_grid[iz]) / (z_grid[iz + 1] - z_grid[iz]) if z_grid[iz + 1] > z_grid[iz] else 0.0

        tables_12 = np.empty((len(I.KEYS), len(log_nh), len(log_z), len(log_t)), dtype=np.float64)
        for idx_k, key in enumerate(I.KEYS):
            _, _, fg11_name = ION_TABLE_SPECS[key]
            if "ions" in f and fg11_name in f["ions"]:
                ds = f["ions"][fg11_name]
                s0 = np.asarray(ds[iz], dtype=np.float64)
                s1 = np.asarray(ds[iz + 1], dtype=np.float64) if fz > 0.0 else s0
                slice_3d = (1.0 - fz) * s0 + fz * s1
                slice_3d = np.where(np.isfinite(slice_3d) & (slice_3d >= -9.0), slice_3d, -30.0)
                tables_12[idx_k] = slice_3d
            else:
                tables_12[idx_k] = -30.0

    return (
        np.ascontiguousarray(log_nh, dtype=np.float64),
        np.ascontiguousarray(log_z, dtype=np.float64),
        np.ascontiguousarray(log_t, dtype=np.float64),
        np.ascontiguousarray(tables_12, dtype=np.float64),
    )


def _build_analytic_fallback_2d_tables() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Fallback smooth 2D CIE+photoionization tables if neither HDF5 table is on disk (e.g. isolated CI)."""
    log_nh = np.linspace(-9.0, 2.0, 89, dtype=np.float64)
    log_t = np.linspace(1.0, 9.0, 321, dtype=np.float64)
    # Peak logT for each of the 12 explorer ions
    peaks = {
        "HI": (4.0, 0.45, -0.05),
        "MgII": (4.1, 0.35, -0.35),
        "SiII": (4.15, 0.35, -0.25),
        "CII": (4.25, 0.40, -0.20),
        "SiIII": (4.45, 0.35, -0.20),
        "CIII": (4.75, 0.40, -0.15),
        "SiIV": (4.80, 0.30, -0.40),
        "CIV": (5.00, 0.30, -0.35),
        "NV": (5.25, 0.28, -0.45),
        "OVI": (5.48, 0.28, -0.50),
        "NeVIII": (5.80, 0.30, -0.45),
        "OVII": (5.95, 0.45, -0.15),
    }
    tables_12 = np.empty((len(I.KEYS), len(log_nh), len(log_t)), dtype=np.float64)
    for idx_k, key in enumerate(I.KEYS):
        t_pk, sig_t, max_lf = peaks[key]
        prof_t = max_lf - 0.5 * ((log_t[None, :] - t_pk) / sig_t) ** 2
        tables_12[idx_k] = np.clip(prof_t, -30.0, 0.0)
    return log_nh, log_t, np.ascontiguousarray(tables_12, dtype=np.float64)


# Pre-extracted atomic arrays for the 12 explorer ions in I.KEYS order
_KEYS_12 = tuple(I.KEYS)
_ATOMIC_12 = {k: I.atomic(k) for k in _KEYS_12}
_LAM0_12 = np.array([_ATOMIC_12[k]["lam0"] for k in _KEYS_12], dtype=np.float64)
_DLAM_12 = np.array([L.native_grid(k, 1500.0)[1] for k in _KEYS_12], dtype=np.float64)
_F_OSC_12 = np.array([_ATOMIC_12[k]["f"] for k in _KEYS_12], dtype=np.float64)
_GAMMA_12 = np.array([_ATOMIC_12[k]["gamma"] for k in _KEYS_12], dtype=np.float64)
_B_MIN_12 = np.array([_ATOMIC_12[k]["b_min"] for k in _KEYS_12], dtype=np.float64)
_LOGN_MAX_12 = np.array([_ATOMIC_12[k]["logN_max"] for k in _KEYS_12], dtype=np.float64)
_DAMPED_12 = np.array([1 if I.get(k).get("damped") else 0 for k in _KEYS_12], dtype=np.int32)
_MASS_AMU_12 = np.array([ELEMENT_MASS_AMU[ION_TABLE_SPECS[k][0]] for k in _KEYS_12], dtype=np.float64)
_SOLAR_ABUND_12 = np.array([SOLAR_ABUND_TRIDENT[ION_TABLE_SPECS[k][0]] for k in _KEYS_12], dtype=np.float64)


class FastCutoutIndex:
    """In-memory C++17 BVH spatial index + 12-ion lookup table over a cutout's `PartType0` gas cells."""

    def __init__(
        self,
        *,
        coords_ckpch: np.ndarray,
        masses_code: np.ndarray,
        density_code: np.ndarray,
        vel_code: np.ndarray,
        temp_K: np.ndarray,
        metallicity: np.ndarray,
        h_mass_frac: np.ndarray,
        nhi_abundance: np.ndarray | None = None,
        hubble_param: float = 0.6774,
        redshift: float = 0.0,
        unit_length_cm: float = 3.085678e21,
        unit_mass_g: float = 1.989e43,
        unit_vel_cm_s: float = 1.0e5,
        ion_table_path: str | Path | None = None,
        table_type: str = "auto",
        cutout_path: Path | None = None,
        build_ms: float = 0.0,
    ):
        t0 = time.perf_counter()
        self._lib = _get_lib()
        self._handle: ctypes.c_void_p | None = None
        self.cutout_path = cutout_path
        self.hubble_param = float(hubble_param)
        self.redshift = float(redshift)
        self.unit_length_cm = float(unit_length_cm)
        self.unit_mass_g = float(unit_mass_g)
        self.unit_vel_cm_s = float(unit_vel_cm_s)

        n_cells = int(coords_ckpch.shape[0])
        self.n_cells = n_cells

        coords_c = np.ascontiguousarray(coords_ckpch, dtype=np.float64)
        masses_c = np.ascontiguousarray(masses_code, dtype=np.float64)
        density_c = np.ascontiguousarray(density_code, dtype=np.float64)
        vel_c = np.ascontiguousarray(vel_code, dtype=np.float64)
        temp_c = np.ascontiguousarray(temp_K, dtype=np.float64)
        met_c = np.ascontiguousarray(metallicity, dtype=np.float64)
        hfrac_c = np.ascontiguousarray(h_mass_frac, dtype=np.float64)
        nhi_c = np.ascontiguousarray(nhi_abundance, dtype=np.float64) if nhi_abundance is not None else None

        c_double_p = ctypes.POINTER(ctypes.c_double)
        nhi_ptr = nhi_c.ctypes.data_as(c_double_p) if nhi_c is not None else ctypes.cast(0, c_double_p)

        handle = self._lib.fast_index_create(
            ctypes.c_int64(n_cells),
            coords_c.ctypes.data_as(c_double_p),
            masses_c.ctypes.data_as(c_double_p),
            density_c.ctypes.data_as(c_double_p),
            vel_c.ctypes.data_as(c_double_p),
            temp_c.ctypes.data_as(c_double_p),
            met_c.ctypes.data_as(c_double_p),
            hfrac_c.ctypes.data_as(c_double_p),
            nhi_ptr,
            ctypes.c_double(self.hubble_param),
            ctypes.c_double(self.unit_length_cm),
            ctypes.c_double(self.unit_mass_g),
            ctypes.c_double(self.unit_vel_cm_s),
        )
        if not handle:
            raise RuntimeError("fast_index_create returned NULL")
        self._handle = ctypes.c_void_p(handle)

        # Configure the 12-ion CLOUDY lookup table (HM12 or FG11)
        resolved_path, kind = find_ion_table_path(ion_table_path, table_type=table_type)
        self.ion_table_path = resolved_path
        self.table_kind = kind

        use_part_nhi = np.zeros(12, dtype=np.int32)
        if nhi_c is not None and kind != "fg11_no_part_nhi":
            use_part_nhi[0] = 1  # HI uses PartType0/NeutralHydrogenAbundance directly

        c_int_p = ctypes.POINTER(ctypes.c_int)
        if kind == "fg11" and resolved_path is not None:
            log_nh, log_z, log_t, tables_12 = _load_cloudy_fg11_3d_tables(resolved_path, self.redshift)
            self._lib.fast_index_set_cloudy_3d_tables(
                self._handle,
                ctypes.c_int(len(log_nh)),
                log_nh.ctypes.data_as(c_double_p),
                ctypes.c_int(len(log_z)),
                log_z.ctypes.data_as(c_double_p),
                ctypes.c_int(len(log_t)),
                log_t.ctypes.data_as(c_double_p),
                tables_12.ctypes.data_as(c_double_p),
                _SOLAR_ABUND_12.ctypes.data_as(c_double_p),
                ctypes.c_double(Z_SOLAR_FG11),
                use_part_nhi.ctypes.data_as(c_int_p),
            )
        elif kind == "hm12" and resolved_path is not None:
            log_nh, log_t, tables_12 = _load_hm12_2d_tables(resolved_path, self.redshift)
            self._lib.fast_index_set_hm12_tables(
                self._handle,
                ctypes.c_int(len(log_nh)),
                log_nh.ctypes.data_as(c_double_p),
                ctypes.c_int(len(log_t)),
                log_t.ctypes.data_as(c_double_p),
                tables_12.ctypes.data_as(c_double_p),
                _SOLAR_ABUND_12.ctypes.data_as(c_double_p),
                ctypes.c_double(Z_SOLAR_YT),
                use_part_nhi.ctypes.data_as(c_int_p),
            )
        else:
            log_nh, log_t, tables_12 = _build_analytic_fallback_2d_tables()
            self._lib.fast_index_set_hm12_tables(
                self._handle,
                ctypes.c_int(len(log_nh)),
                log_nh.ctypes.data_as(c_double_p),
                ctypes.c_int(len(log_t)),
                log_t.ctypes.data_as(c_double_p),
                tables_12.ctypes.data_as(c_double_p),
                _SOLAR_ABUND_12.ctypes.data_as(c_double_p),
                ctypes.c_double(Z_SOLAR_YT),
                use_part_nhi.ctypes.data_as(c_int_p),
            )

        self.build_ms = float(build_ms) + (time.perf_counter() - t0) * 1000.0

    def close(self) -> None:
        if getattr(self, "_handle", None) is not None and self._lib is not None:
            self._lib.fast_index_destroy(self._handle)
            self._handle = None

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    @classmethod
    def from_hdf5(
        cls,
        cutout_path: str | Path,
        *,
        ion_table_path: str | Path | None = None,
        table_type: str = "auto",
    ) -> "FastCutoutIndex":
        """Load `PartType0` gas cells from an Arepo/GIZMO/Gadget HDF5 cutout and build the BVH."""
        t0 = time.perf_counter()
        path = Path(cutout_path).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"Cutout HDF5 not found: {path}")

        with h5py.File(path, "r") as f:
            hdr = f["Header"].attrs if "Header" in f else {}
            default_h = float(CFG.GALAXY.get("TNG_H", 0.6774))
            h = float(hdr.get("HubbleParam", default_h))
            if h <= 0.0:
                h = default_h
            redshift = float(hdr.get("Redshift", 0.0))
            u_len = float(hdr.get("UnitLength_in_cm", 3.085678e21))
            u_mass = float(hdr.get("UnitMass_in_g", 1.989e43))
            u_vel = float(hdr.get("UnitVelocity_in_cm_per_s", 1.0e5))

            p0 = f["PartType0"]
            coords = np.asarray(p0["Coordinates"][:], dtype=np.float64)
            masses = np.asarray(p0["Masses"][:], dtype=np.float64)
            density = np.asarray(p0["Density"][:], dtype=np.float64)
            velocities = np.asarray(p0["Velocities"][:], dtype=np.float64)

            if "Temperature" in p0:
                temp_K = np.asarray(p0["Temperature"][:], dtype=np.float64)
            elif "InternalEnergy" in p0:
                u_int = np.asarray(p0["InternalEnergy"][:], dtype=np.float64)
                if "ElectronAbundance" in p0:
                    xe = np.asarray(p0["ElectronAbundance"][:], dtype=np.float64)
                else:
                    xe = np.ones_like(u_int)
                mu = 4.0 / (3.0 * PRIMORDIAL_H_MASS_FRAC + 1.0 + 4.0 * PRIMORDIAL_H_MASS_FRAC * xe)
                temp_K = u_int * (u_vel ** 2) * (GAMMA_IDEAL - 1.0) * mu * M_P_YT_CGS / K_B_YT_CGS
            else:
                temp_K = np.full(coords.shape[0], 1.0e4, dtype=np.float64)

            if "GFM_Metallicity" in p0:
                metallicity = np.asarray(p0["GFM_Metallicity"][:], dtype=np.float64)
            elif "Metallicity" in p0:
                met_raw = np.asarray(p0["Metallicity"][:], dtype=np.float64)
                metallicity = met_raw[:, 0] if met_raw.ndim == 2 else met_raw
            else:
                metallicity = np.full(coords.shape[0], Z_SOLAR_YT, dtype=np.float64)

            if "GFM_Metals" in p0:
                h_mass_frac = np.asarray(p0["GFM_Metals"][:, 0], dtype=np.float64)
            else:
                h_mass_frac = np.full(coords.shape[0], PRIMORDIAL_H_MASS_FRAC, dtype=np.float64)

            nhi = (
                np.asarray(p0["NeutralHydrogenAbundance"][:], dtype=np.float64)
                if "NeutralHydrogenAbundance" in p0
                else None
            )

        io_ms = (time.perf_counter() - t0) * 1000.0
        return cls(
            coords_ckpch=coords,
            masses_code=masses,
            density_code=density,
            vel_code=velocities,
            temp_K=temp_K,
            metallicity=metallicity,
            h_mass_frac=h_mass_frac,
            nhi_abundance=nhi,
            hubble_param=h,
            redshift=redshift,
            unit_length_cm=u_len,
            unit_mass_g=u_mass,
            unit_vel_cm_s=u_vel,
            ion_table_path=ion_table_path,
            table_type=table_type,
            cutout_path=path,
            build_ms=io_ms,
        )

    def kpc_to_ckpch(self, pt_kpc: Any) -> np.ndarray:
        """Convert physical kpc coordinates to code length ckpc/h."""
        arr = np.asarray(pt_kpc, dtype=np.float64)
        return arr * self.hubble_param * (1.0 + self.redshift)

    def trace_ray(
        self,
        start_ckpch: Any,
        end_ckpch: Any,
        *,
        coords_in_kpc: bool = False,
    ) -> dict[str, Any]:
        """Trace a sightline segment through the BVH and evaluate the 12 ion column densities in < 2 ms."""
        if self._handle is None:
            raise RuntimeError("FastCutoutIndex is closed")
        p0 = np.ascontiguousarray(start_ckpch, dtype=np.float64).reshape(3)
        p1 = np.ascontiguousarray(end_ckpch, dtype=np.float64).reshape(3)
        if coords_in_kpc:
            p0 = self.kpc_to_ckpch(p0)
            p1 = self.kpc_to_ckpch(p1)

        logN_arr = np.zeros(12, dtype=np.float64)
        n_hits = ctypes.c_int(0)
        trace_ms = ctypes.c_double(0.0)
        c_double_p = ctypes.POINTER(ctypes.c_double)

        rc = self._lib.fast_trace_only(
            self._handle,
            p0.ctypes.data_as(c_double_p),
            p1.ctypes.data_as(c_double_p),
            logN_arr.ctypes.data_as(c_double_p),
            ctypes.byref(n_hits),
            ctypes.byref(trace_ms),
        )
        if rc != 0:
            raise RuntimeError(f"fast_trace_only failed with status {rc}")

        return {
            "logN": {k: float(logN_arr[i]) for i, k in enumerate(_KEYS_12)},
            "logN_array": logN_arr,
            "n_hits": int(n_hits.value),
            "trace_ms": float(trace_ms.value),
        }

    def render_sightline(
        self,
        start_ckpch: Any,
        end_ckpch: Any,
        *,
        coords_in_kpc: bool = False,
        velocity_half_kms: float | None = None,
        allow_damped_widening: bool = True,
        exact_trident_window: bool = False,
    ) -> dict[str, Any]:
        """Trace sightline and synthesize exact 12-ion FP64 Faddeeva Voigt optical depth profiles `tau(v)`,
        equivalent widths `W_lambda` [mÅ], column densities `logN`, and AOD columns `logN_aod`."""
        if self._handle is None:
            raise RuntimeError("FastCutoutIndex is closed")

        p0 = np.ascontiguousarray(start_ckpch, dtype=np.float64).reshape(3)
        p1 = np.ascontiguousarray(end_ckpch, dtype=np.float64).reshape(3)
        if coords_in_kpc:
            p0 = self.kpc_to_ckpch(p0)
            p1 = self.kpc_to_ckpch(p1)

        lam_min_12 = np.empty(12, dtype=np.float64)
        dlam_12 = _DLAM_12.copy()
        n_bins_12 = np.empty(12, dtype=np.int32)
        W_win_dict: dict[str, float] = {}

        for idx_k, key in enumerate(_KEYS_12):
            w_kms = float(velocity_half_kms) if velocity_half_kms is not None else float(I.gen_window(key, None))
            W_win_dict[key] = w_kms
            lmin, dl, nb = L.native_grid(key, w_kms)
            lam_min_12[idx_k] = lmin
            dlam_12[idx_k] = dl
            n_bins_12[idx_k] = nb

        bin_offsets_12 = np.zeros(12, dtype=np.int32)
        bin_offsets_12[1:] = np.cumsum(n_bins_12[:-1])
        total_bins = int(np.sum(n_bins_12))

        tau_flat = np.empty(total_bins, dtype=np.float32)
        logN_arr = np.zeros(12, dtype=np.float64)
        W_mA_arr = np.zeros(12, dtype=np.float64)
        logN_aod_arr = np.zeros(12, dtype=np.float64)
        n_hits = ctypes.c_int(0)
        trace_ms = ctypes.c_double(0.0)
        voigt_ms = ctypes.c_double(0.0)

        c_double_p = ctypes.POINTER(ctypes.c_double)
        c_float_p = ctypes.POINTER(ctypes.c_float)
        c_int_p = ctypes.POINTER(ctypes.c_int)

        rc = self._lib.fast_trace_and_spectra(
            self._handle,
            p0.ctypes.data_as(c_double_p),
            p1.ctypes.data_as(c_double_p),
            _LAM0_12.ctypes.data_as(c_double_p),
            _F_OSC_12.ctypes.data_as(c_double_p),
            _GAMMA_12.ctypes.data_as(c_double_p),
            _MASS_AMU_12.ctypes.data_as(c_double_p),
            lam_min_12.ctypes.data_as(c_double_p),
            dlam_12.ctypes.data_as(c_double_p),
            n_bins_12.ctypes.data_as(c_int_p),
            bin_offsets_12.ctypes.data_as(c_int_p),
            ctypes.c_int(1 if exact_trident_window else 0),
            tau_flat.ctypes.data_as(c_float_p),
            ctypes.cast(0, c_double_p),
            logN_arr.ctypes.data_as(c_double_p),
            W_mA_arr.ctypes.data_as(c_double_p),
            logN_aod_arr.ctypes.data_as(c_double_p),
            ctypes.byref(n_hits),
            ctypes.byref(trace_ms),
            ctypes.byref(voigt_ms),
        )
        if rc != 0:
            raise RuntimeError(f"fast_trace_and_spectra failed with status {rc}")

        tau_dict: dict[str, np.ndarray] = {}
        lam0_dict: dict[str, float] = {}
        dlam_dict: dict[str, float] = {}
        lam_dict: dict[str, np.ndarray] = {}
        u_dict: dict[str, np.ndarray] = {}
        du_dict: dict[str, float] = {}

        for idx_k, key in enumerate(_KEYS_12):
            off = int(bin_offsets_12[idx_k])
            nb = int(n_bins_12[idx_k])
            tau_dict[key] = tau_flat[off : off + nb].copy()
            lam0_dict[key] = float(lam_min_12[idx_k])
            dlam_dict[key] = float(dlam_12[idx_k])

        # Check damped HI window widening rule from tngsight.ions.gen_window("HI", logN["HI"])
        if allow_damped_widening and velocity_half_kms is None:
            w_hi = float(I.gen_window("HI", float(logN_arr[0])))
            if w_hi > W_win_dict["HI"]:
                t_w0 = time.perf_counter()
                W_win_dict["HI"] = w_hi
                lmin_w, dl_w, nb_w = L.native_grid("HI", w_hi)
                lam_min_w = lam_min_12.copy()
                dlam_w = dlam_12.copy()
                n_bins_w = np.ones(12, dtype=np.int32)
                lam_min_w[0] = lmin_w
                dlam_w[0] = dl_w
                n_bins_w[0] = nb_w
                offsets_w = np.zeros(12, dtype=np.int32)
                offsets_w[1:] = np.cumsum(n_bins_w[:-1])
                tau_w_flat = np.empty(int(np.sum(n_bins_w)), dtype=np.float32)
                logN_w = np.zeros(12, dtype=np.float64)
                W_w = np.zeros(12, dtype=np.float64)
                aod_w = np.zeros(12, dtype=np.float64)

                self._lib.fast_trace_and_spectra(
                    self._handle,
                    p0.ctypes.data_as(c_double_p),
                    p1.ctypes.data_as(c_double_p),
                    _LAM0_12.ctypes.data_as(c_double_p),
                    _F_OSC_12.ctypes.data_as(c_double_p),
                    _GAMMA_12.ctypes.data_as(c_double_p),
                    _MASS_AMU_12.ctypes.data_as(c_double_p),
                    lam_min_w.ctypes.data_as(c_double_p),
                    dlam_w.ctypes.data_as(c_double_p),
                    n_bins_w.ctypes.data_as(c_int_p),
                    offsets_w.ctypes.data_as(c_int_p),
                    ctypes.c_int(1 if exact_trident_window else 0),
                    tau_w_flat.ctypes.data_as(c_float_p),
                    ctypes.cast(0, c_double_p),
                    logN_w.ctypes.data_as(c_double_p),
                    W_w.ctypes.data_as(c_double_p),
                    aod_w.ctypes.data_as(c_double_p),
                    ctypes.byref(n_hits),
                    ctypes.cast(0, c_double_p),
                    ctypes.cast(0, c_double_p),
                )
                tau_dict["HI"] = tau_w_flat[:nb_w].copy()
                lam0_dict["HI"] = float(lmin_w)
                dlam_dict["HI"] = float(dl_w)
                W_mA_arr[0] = W_w[0]
                logN_aod_arr[0] = aod_w[0]
                voigt_ms.value += (time.perf_counter() - t_w0) * 1000.0

        rest_dict: dict[str, float] = {}
        for idx_k, key in enumerate(_KEYS_12):
            rest = float(_LAM0_12[idx_k])
            rest_dict[key] = rest
            nb = len(tau_dict[key])
            l0 = lam0_dict[key]
            dl = dlam_dict[key]
            lam_arr = l0 + np.arange(nb, dtype=np.float64) * dl
            lam_dict[key] = lam_arr
            u_dict[key] = CFG.C_KMS * (lam_arr / rest - 1.0)
            du_dict[key] = CFG.C_KMS * dl / rest

        logN_dict = {
            k: (float(logN_arr[i]) if logN_arr[i] > -29.9 else -math.inf)
            for i, k in enumerate(_KEYS_12)
        }
        W_lambda_dict = {k: float(W_mA_arr[i]) for i, k in enumerate(_KEYS_12)}
        aod_dict = {
            k: (float(logN_aod_arr[i]) if logN_aod_arr[i] > -90.0 else None)
            for i, k in enumerate(_KEYS_12)
        }

        return {
            "lines": list(_KEYS_12),
            "logN": logN_dict,
            "W": W_win_dict,
            "W_lambda": W_lambda_dict,
            "ew_mA": dict(W_lambda_dict),
            "logN_aod": aod_dict,
            "tau": tau_dict,
            "lam0": lam0_dict,
            "dlam": dlam_dict,
            "rest": rest_dict,
            "lam": lam_dict,
            "u": u_dict,
            "du": du_dict,
            "n_hits": int(n_hits.value),
            "trace_ms": float(trace_ms.value),
            "voigt_ms": float(voigt_ms.value),
        }


def fit_components_cpp(
    payload: dict[str, Any],
    *,
    max_lm_iter: int = 35,
    aod: dict[str, Any] | None = None,
) -> tuple[dict[str, list[dict[str, Any]]], float]:
    """Fit 12-ion Voigt components in parallel using the compiled C++17 OpenMP fitter."""
    lib = _get_lib()
    keys = [k for k in payload["lines"] if k in I.KEYS]
    n_ions = len(keys)
    if n_ions == 0:
        return {}, 0.0

    v_sys = float(payload.get("v_sys", 0.0))
    v_arrays = []
    tau_arrays = []
    n_bins_arr = np.empty(n_ions, dtype=np.int32)
    lam0_arr = np.empty(n_ions, dtype=np.float64)
    f_arr = np.empty(n_ions, dtype=np.float64)
    gamma_arr = np.empty(n_ions, dtype=np.float64)
    b_min_arr = np.empty(n_ions, dtype=np.float64)
    logN_max_arr = np.empty(n_ions, dtype=np.float64)
    damped_arr = np.empty(n_ions, dtype=np.int32)

    for i, k in enumerate(keys):
        spec = _ATOMIC_12[k]
        lam = np.asarray(payload["lam"][k], dtype=np.float64)
        rest = float(payload["rest"][k])
        v = D.velocity_axis(lam, rest, v_sys)
        t = np.ascontiguousarray(payload["tau"][k], dtype=np.float32)
        v_arrays.append(np.ascontiguousarray(v, dtype=np.float64))
        tau_arrays.append(t)
        n_bins_arr[i] = len(t)
        lam0_arr[i] = float(spec["lam0"])
        f_arr[i] = float(spec["f"])
        gamma_arr[i] = float(spec["gamma"])
        b_min_arr[i] = float(spec["b_min"])
        logN_max_arr[i] = float(spec["logN_max"])
        damped_arr[i] = 1 if I.get(k).get("damped") else 0

    bin_offsets = np.zeros(n_ions, dtype=np.int32)
    bin_offsets[1:] = np.cumsum(n_bins_arr[:-1])
    v_flat = np.ascontiguousarray(np.concatenate(v_arrays), dtype=np.float64)
    tau_flat = np.ascontiguousarray(np.concatenate(tau_arrays), dtype=np.float32)

    n_comps_out = np.zeros(n_ions, dtype=np.int32)
    comp_num_out = np.zeros((n_ions, 30, 7), dtype=np.float64)
    comp_int_out = np.zeros((n_ions, 30, 2), dtype=np.int32)
    logN_aod_total_out = np.full(n_ions, -99.0, dtype=np.float64)
    n_regions_out = np.zeros(n_ions, dtype=np.int32)
    region_aod_out = np.zeros((n_ions, 64, 4), dtype=np.float64)
    fit_ms = ctypes.c_double(0.0)

    c_double_p = ctypes.POINTER(ctypes.c_double)
    c_float_p = ctypes.POINTER(ctypes.c_float)
    c_int_p = ctypes.POINTER(ctypes.c_int)

    rc = lib.fast_fit_components_12(
        ctypes.c_int(n_ions),
        v_flat.ctypes.data_as(c_double_p),
        tau_flat.ctypes.data_as(c_float_p),
        n_bins_arr.ctypes.data_as(c_int_p),
        bin_offsets.ctypes.data_as(c_int_p),
        lam0_arr.ctypes.data_as(c_double_p),
        f_arr.ctypes.data_as(c_double_p),
        gamma_arr.ctypes.data_as(c_double_p),
        b_min_arr.ctypes.data_as(c_double_p),
        logN_max_arr.ctypes.data_as(c_double_p),
        damped_arr.ctypes.data_as(c_int_p),
        ctypes.c_int(int(max_lm_iter)),
        n_comps_out.ctypes.data_as(c_int_p),
        comp_num_out.ctypes.data_as(c_double_p),
        comp_int_out.ctypes.data_as(c_int_p),
        logN_aod_total_out.ctypes.data_as(c_double_p),
        n_regions_out.ctypes.data_as(c_int_p),
        region_aod_out.ctypes.data_as(c_double_p),
        ctypes.byref(fit_ms),
    )
    if rc != 0:
        raise RuntimeError(f"fast_fit_components_12 failed with status {rc}")

    comps_out: dict[str, list[dict[str, Any]]] = {}
    for i, k in enumerate(keys):
        nc = int(n_comps_out[i])
        ion_comps = []
        for c in range(nc):
            cnum = comp_num_out[i, c]
            cint = comp_int_out[i, c]
            dv = None if cnum[1] < 0.0 else float(cnum[1])
            dlogN = None if cnum[3] < 0.0 else float(cnum[3])
            db = None if cnum[5] < 0.0 else float(cnum[5])
            ion_comps.append(
                {
                    "v": float(cnum[0]),
                    "dv": dv,
                    "logN": float(cnum[2]),
                    "dlogN": dlogN,
                    "b": float(cnum[4]),
                    "db": db,
                    "region": int(cint[0]),
                    "flag": int(cint[1]),
                    "EW": float(cnum[6]),
                }
            )
        comps_out[k] = ion_comps

        if aod is not None:
            tot = None if logN_aod_total_out[i] < -90.0 else float(logN_aod_total_out[i])
            nr = int(n_regions_out[i])
            regs = []
            for r in range(nr):
                rarr = region_aod_out[i, r]
                raod = None if rarr[3] < -90.0 else float(rarr[3])
                regs.append([int(round(rarr[0])), float(rarr[1]), float(rarr[2]), raod])
            aod[k] = [tot, regs]

    return comps_out, float(fit_ms.value)


def get_cached_cutout_index(
    cutout_path: str | Path,
    *,
    ion_table_path: str | Path | None = None,
    table_type: str = "auto",
) -> FastCutoutIndex:
    """Return a cached `FastCutoutIndex` for `cutout_path`, building it if not yet cached."""
    path = Path(cutout_path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Cutout file not found: {path}")
    mtime_ns = path.stat().st_mtime_ns
    key = (str(path), mtime_ns, str(ion_table_path or ""), table_type)

    with _INDEX_CACHE_LOCK:
        if key in _INDEX_CACHE:
            _INDEX_CACHE.move_to_end(key)
            return _INDEX_CACHE[key]

    idx = FastCutoutIndex.from_hdf5(path, ion_table_path=ion_table_path, table_type=table_type)

    with _INDEX_CACHE_LOCK:
        if key in _INDEX_CACHE:
            idx.close()
            _INDEX_CACHE.move_to_end(key)
            return _INDEX_CACHE[key]
        _INDEX_CACHE[key] = idx
        while len(_INDEX_CACHE) > _INDEX_CACHE_MAX:
            _, evicted = _INDEX_CACHE.popitem(last=False)
            evicted.close()
        return idx


class FastRayGenerator:
    """Fast compiled C++17/OpenMP + AVX2 sightline generator and 12-ion Voigt synthesizer.

    Drop-in replacement for `tngsight.generate.Generator` with identical `.load()`,
    `.generate()`, `.warm`, and `.timings` interface.
    """

    def __init__(
        self,
        cutout: str | Path | None = None,
        ion_table_dir: str | Path | None = None,
        index_filename: str | Path | None = None,
        galaxy: dict[str, Any] | None = None,
        *,
        cutout_path: str | Path | None = None,
        ion_table_path: str | Path | None = None,
        table_type: str = "auto",
        exact_trident_window: bool = False,
        fit_engine: str = "cpp",
        max_lm_iter: int = 35,
        velocity_half_kms: float | None = None,
    ):
        chosen_cutout = cutout if cutout is not None else cutout_path
        if chosen_cutout is None and galaxy is not None and galaxy.get("cutout_path"):
            chosen_cutout = galaxy["cutout_path"]
        self.cutout_path = Path(chosen_cutout) if chosen_cutout is not None else CFG.cutout_path()
        self.ion_table_dir = Path(ion_table_dir) if ion_table_dir is not None else None
        self.index_filename = Path(index_filename) if index_filename is not None else None
        self.galaxy = galaxy
        if ion_table_path is None and self.ion_table_dir is not None:
            cand = self.ion_table_dir / "hm2012_ss_hr.h5"
            if cand.is_file():
                ion_table_path = cand
        self.ion_table_path = ion_table_path
        self.table_type = table_type
        self.exact_trident_window = bool(exact_trident_window)
        self.fit_engine = fit_engine
        self.max_lm_iter = int(max_lm_iter)
        self.velocity_half_kms = velocity_half_kms
        self._index: FastCutoutIndex | None = None
        self.timings: dict[str, float] = {}

    @property
    def warm(self) -> bool:
        return self._index is not None

    def load(self, progress=None) -> "FastRayGenerator":
        if self._index is not None:
            return self
        t0 = time.perf_counter()
        if progress:
            progress("loading", 0.05, "building C++17 3D spatial BVH index")
        self._index = get_cached_cutout_index(
            self.cutout_path,
            ion_table_path=self.ion_table_path,
            table_type=self.table_type,
        )
        self.timings["load_s"] = round(time.perf_counter() - t0, 4)
        self.timings["build_ms"] = round(self._index.build_ms, 2)
        if progress:
            progress("loading", 0.15, f"BVH index ready ({self._index.n_cells} cells)")
        return self

    def _resolve_geometry(self, geom: dict[str, Any]) -> tuple[dict[str, Any], str, np.ndarray, np.ndarray]:
        assert self._index is not None
        from server.workers import selected_galaxy

        if ("start_ckpch" in geom and "end_ckpch" in geom) or ("orientation" in geom) or ("p0_kpc" in geom):
            with selected_galaxy(self.galaxy):
                sl, gid = GEN.resolve_geometry(geom)
            p0 = np.asarray(sl["start_ckpch"], dtype=np.float64)
            p1 = np.asarray(sl["end_ckpch"], dtype=np.float64)
            return sl, gid, p0, p1
        if "start_kpc" in geom and "end_kpc" in geom:
            with selected_galaxy(self.galaxy):
                sl = G.make_endpoints(geom["start_kpc"], geom["end_kpc"])
                gid = geom.get("id") or G.custom_id(sl["p0_kpc"], sl["p1_kpc"])
            p0 = np.asarray(sl["start_ckpch"], dtype=np.float64)
            p1 = np.asarray(sl["end_ckpch"], dtype=np.float64)
            return sl, gid, p0, p1
        raise KeyError("Geometry dict must contain orientation/b_kpc/azimuth_deg, p0_kpc/p1_kpc, start_ckpch/end_ckpch, or start_kpc/end_kpc")

    def generate(self, geom: dict[str, Any], progress=None) -> dict[str, Any]:
        """Trace sightline, compute 12-ion Faddeeva Voigt spectra, and fit Voigt components."""
        self.load(progress)
        assert self._index is not None
        t_all = time.perf_counter()

        sl, sid, p0, p1 = self._resolve_geometry(geom)
        if progress:
            progress("ray", 0.0, f"casting ray {sid}")

        spec_res = self._index.render_sightline(
            p0,
            p1,
            coords_in_kpc=False,
            velocity_half_kms=self.velocity_half_kms,
            allow_damped_widening=True,
            exact_trident_window=self.exact_trident_window,
        )

        if progress:
            progress("ray", 1.0, "ray done")
            for k in _KEYS_12:
                progress(f"spectrum:{k}", 1.0, "done")

        v_sys = float(sl.get("v_sys_kms", 0.0))

        out: dict[str, Any] = {
            "id": sid,
            "geom": dict(sl),
            "v_sys": float(v_sys),
            "format": 2,
            "lines": spec_res["lines"],
            "generation": L.generation_record(CFG.SPEC_MIN_TAU),
            "logN": spec_res["logN"],
            "tau": spec_res["tau"],
            "lam0": spec_res["lam0"],
            "dlam": spec_res["dlam"],
            "rest": spec_res["rest"],
            "W": spec_res["W"],
            "W_lambda": spec_res["W_lambda"],
            "ew_mA": spec_res["ew_mA"],
            "lam": spec_res["lam"],
            "u": spec_res["u"],
            "du": spec_res["du"],
        }

        aod: dict[str, Any] = {}
        if self.fit_engine == "python":
            t_fit0 = time.perf_counter()
            out["components"] = C.fit_payload(out, progress=progress, aod=aod)
            fit_ms = (time.perf_counter() - t_fit0) * 1000.0
        elif self.fit_engine in ("none", "skip", False):
            out["components"] = {k: [] for k in out["lines"]}
            aod = {k: [spec_res["logN_aod"].get(k), []] for k in out["lines"]}
            fit_ms = 0.0
        else:
            if progress:
                progress("fit", 0.0, "fitting 12-ion Voigt components in C++17/OpenMP")
            comps, fit_ms = fit_components_cpp(out, max_lm_iter=self.max_lm_iter, aod=aod)
            out["components"] = comps
            if progress:
                progress("fit", 1.0, "components fitted")

        out["components_aod"] = aod
        if progress:
            progress("save", 0.0, "packing npz")
            progress("save", 1.0, "done")

        total_ms = (time.perf_counter() - t_all) * 1000.0
        self.timings.update(
            {
                "trace_ms": round(spec_res["trace_ms"], 3),
                "voigt_ms": round(spec_res["voigt_ms"], 3),
                "trace_plus_voigt_ms": round(spec_res["trace_ms"] + spec_res["voigt_ms"], 3),
                "fit_ms": round(fit_ms, 3),
                "total_ms": round(total_ms, 3),
                "ray_s": round(spec_res["trace_ms"] / 1000.0, 5),
                "spectrum_s": round(spec_res["voigt_ms"] / 1000.0, 5),
                "fit_s": round(fit_ms / 1000.0, 5),
                "total_s": round(total_ms / 1000.0, 5),
                "n_hits": spec_res["n_hits"],
            }
        )
        out["timings"] = dict(self.timings)
        return out
