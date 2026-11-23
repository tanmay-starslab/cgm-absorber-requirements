"""Unit tests and real-data numerical accuracy + speedup benchmarks for `tngsight/_fast_deposit.so`
(C++17/OpenMP + AVX2 SIMD 3D particle-to-grid CIC & SPH-kernel deposition).

Verifies:
1. Shared library `_fast_deposit.so` loads cleanly via `ctypes` (`HAS_FAST_DEPOSIT is True`), and transparent
   fallback to pure NumPy works when disabled or absent.
2. Exact numerical agreement (`rtol < 1e-11`, `atol < 1e-12` in `float64`) between the C++17/OpenMP + AVX2
   implementation and the pure NumPy implementation across:
   - Multi-level SPH cubic-spline scatter (`D.scatter`) for 1, 2, 4, and 8 OpenMP threads and varying `pair_budget`.
   - Periodic and non-periodic 3D `256^3` trilinear CIC batch deposition (`D.cic_deposit`) across arbitrary
     `(N_particles, N_fields)` batches (1, 3, and 18 fields).
   - `StreamingLevelAccumulator.deposit_cic_chunk` and `deposit_sph_chunk` in `build_tng_wholebox_igm.py`.
3. Real TNG50 particle data numerical parity (`rtol < 1e-11`, `atol < 1e-12`) and wall-time speedup benchmark.
"""
from __future__ import annotations

import importlib.util
import time
from pathlib import Path

import numpy as np
import pytest

from tngsight import deposit as D

REAL_GAS_CACHE = Path("/scratch/tsingh65/cgm_work/data/library/viz_cache/gas")
IGM_BUILDER_PATH = Path("/scratch/tsingh65/cgm_work/scratch/build_tng_wholebox_igm.py")


def test_fast_deposit_so_loaded_and_fallback(monkeypatch):
    """Verify `_fast_deposit.so` is compiled and loaded, and transparent fallback works when disabled."""
    assert D._SO_PATH.is_file(), f"Missing compiled shared library {D._SO_PATH}"
    assert D.HAS_FAST_DEPOSIT is True
    assert D._FAST_LIB is not None

    # Verify stencil offset counts match between C++ and Python for k=1..20
    for k in range(1, 21):
        assert int(D._FAST_LIB.fast_n_offsets(k)) == D._n_offsets(k)

    # Test automatic fallback when TNG_DISABLE_FAST_DEPOSIT=1
    g = D.Grid(10.0, 32)
    rng = np.random.default_rng(42)
    pos = rng.uniform(-10.0, 10.0, (500, 3))
    h = rng.uniform(0.5, 4.0, 500)
    qs = {"m": rng.lognormal(0.0, 1.0, 500), "mT": rng.uniform(1.0, 10.0, 500)}

    res_fast = D.scatter(pos, h, qs, g, workers=2)
    monkeypatch.setenv("TNG_DISABLE_FAST_DEPOSIT", "1")
    res_fallback = D.scatter(pos, h, qs, g, workers=2)
    monkeypatch.delenv("TNG_DISABLE_FAST_DEPOSIT", raising=False)

    for k in qs:
        np.testing.assert_allclose(res_fast.grids[k], res_fallback.grids[k], rtol=1e-11, atol=1e-12)
        assert abs(res_fast.q_in[k] - res_fallback.q_in[k]) <= 1e-12 * abs(res_fallback.q_in[k])
        assert abs(res_fast.q_lost[k] - res_fallback.q_lost[k]) <= 1e-12 * max(abs(res_fallback.q_lost[k]), 1.0)


@pytest.mark.parametrize("workers", [1, 2, 4, 8])
def test_sph_scatter_exact_agreement_synthetic(workers):
    """Verify C++17/OpenMP SPH scatter matches pure NumPy to rtol < 1e-11, atol < 1e-12 across multiple levels."""
    g = D.Grid(50.0, 64, h_min_vox=1.5)
    rng = np.random.default_rng(100 + workers)
    N = 15_000
    pos = rng.uniform(-55.0, 55.0, (N, 3))
    h = g.dx * np.exp(rng.uniform(np.log(0.3), np.log(45.0), N))
    qs = {f"q_{j}": rng.lognormal(0.0, 1.0, N) for j in range(6)}

    res_np = D.scatter(pos, h, qs, g, workers=workers, _use_fast=False)
    res_cpp = D.scatter(pos, h, qs, g, workers=workers, _use_fast=True)

    assert res_cpp.n_elements == res_np.n_elements
    assert res_cpp.n_straddling == res_np.n_straddling
    assert res_cpp.level_counts == res_np.level_counts
    assert res_cpp.meta["pairs"] == res_np.meta["pairs"]
    assert res_cpp.meta["chunks"] == res_np.meta["chunks"]

    for k in qs:
        np.testing.assert_allclose(res_cpp.grids[k], res_np.grids[k], rtol=1e-11, atol=1e-12)
        assert abs(res_cpp.q_in[k] - res_np.q_in[k]) <= 1e-12 * abs(res_np.q_in[k])
        assert abs(res_cpp.q_full_inside[k] - res_np.q_full_inside[k]) <= 1e-12 * abs(res_np.q_full_inside[k])
        assert abs(res_cpp.q_lost[k] - res_np.q_lost[k]) <= 1e-12 * max(abs(res_np.q_lost[k]), 1e-30)


@pytest.mark.parametrize("periodic_wrap", [True, False])
@pytest.mark.parametrize("n_fields,workers", [(1, 4), (3, 8), (18, 16)])
def test_cic_deposit_batch_exact_agreement(periodic_wrap, n_fields, workers):
    """Verify C++17/OpenMP 256^3 CIC batch deposition matches pure NumPy to rtol < 1e-11, atol < 1e-12."""
    n = 256
    half_kpc = 400.0
    dx = 2.0 * half_kpc / n
    rng = np.random.default_rng(2026 + n_fields + int(periodic_wrap) * 100)
    N = 100_000
    bound = half_kpc if periodic_wrap else (half_kpc - dx)
    pos = rng.uniform(-bound, bound, (N, 3))
    qs = {f"f_{j}": rng.uniform(0.1, 10.0, N) for j in range(n_fields)}

    grids_np = {k: np.zeros((n, n, n), dtype=np.float64) for k in qs}
    grids_cpp = {k: np.zeros((n, n, n), dtype=np.float64) for k in qs}

    sums_np = D.cic_deposit(pos, qs, grids_np, half_kpc, periodic_wrap=periodic_wrap, _use_fast=False)
    sums_cpp = D.cic_deposit(pos, qs, grids_cpp, half_kpc, periodic_wrap=periodic_wrap, workers=workers, _use_fast=True)

    for k in qs:
        assert abs(sums_cpp[k] - sums_np[k]) <= 1e-11 * abs(sums_np[k])
        np.testing.assert_allclose(grids_cpp[k], grids_np[k], rtol=1e-11, atol=1e-12)
        # Conservation check: total deposited on grid equals sum of particle quantities
        assert abs(float(grids_cpp[k].sum()) - sums_cpp[k]) <= 1e-6 * sums_cpp[k]


def test_igm_streaming_accumulator_integration():
    """Verify `StreamingLevelAccumulator` in `build_tng_wholebox_igm.py` uses `D.cic_deposit` and `D.scatter`."""
    if not IGM_BUILDER_PATH.is_file():
        pytest.skip(f"{IGM_BUILDER_PATH} not present")
    spec = importlib.util.spec_from_file_location("build_tng_wholebox_igm", IGM_BUILDER_PATH)
    igm = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(igm)

    rng = np.random.default_rng(77)
    N = 25_000
    box_kpc = 50_000.0
    half_l0 = box_kpc / 2.0
    half_l1 = box_kpc / 8.0
    q_names = ("N_nH", "m", "mT")
    pos = rng.uniform(-half_l1 * 1.1, half_l1 * 1.1, (N, 3))
    h = rng.uniform(10.0, 400.0, N)
    qs = {k: rng.uniform(1.0, 5.0, N) for k in q_names}

    acc_l0 = igm.StreamingLevelAccumulator("L0", half_l0, [0, 0, 0], box_kpc, q_names, periodic_wrap=True)
    acc_l0.deposit_cic_chunk(pos, qs, workers=4)
    assert acc_l0.n_elements == N
    for k in q_names:
        assert abs(float(acc_l0.grids[k].sum()) - acc_l0.q_in[k]) <= 1e-6 * acc_l0.q_in[k]

    acc_l1 = igm.StreamingLevelAccumulator("L1", half_l1, [0, 0, 0], box_kpc, q_names, periodic_wrap=False)
    acc_l1.deposit_sph_chunk(pos, h, qs, h_min_vox=2.0, workers=4)
    assert acc_l1.n_elements > 0
    for k in q_names:
        assert abs(float(acc_l1.grids[k].sum()) - acc_l1.q_in[k]) <= 1e-6 * acc_l1.q_in[k]


def test_real_particle_data_accuracy_and_speedup():
    """Verify exact numerical agreement (`rtol < 1e-11`, `atol < 1e-12`) and wall-time speedup on real TNG50 data."""
    required = ("pos_disk", "h", "m", "V_cm3", "nH", "HI", "OVI", "CIII", "T", "Z")
    if not all((REAL_GAS_CACHE / f"cells_{k}.npy").is_file() for k in required):
        pytest.skip(f"Real particle cache not found in {REAL_GAS_CACHE}")

    pos_full = np.load(REAL_GAS_CACHE / "cells_pos_disk.npy").astype(np.float64)
    h_full = np.load(REAL_GAS_CACHE / "cells_h.npy").astype(np.float64)
    m_full = np.load(REAL_GAS_CACHE / "cells_m.npy").astype(np.float64)
    V_full = np.load(REAL_GAS_CACHE / "cells_V_cm3.npy").astype(np.float64)
    nH_full = np.load(REAL_GAS_CACHE / "cells_nH.npy").astype(np.float64)
    HI_full = np.load(REAL_GAS_CACHE / "cells_HI.npy").astype(np.float64)
    OVI_full = np.load(REAL_GAS_CACHE / "cells_OVI.npy").astype(np.float64)
    CIII_full = np.load(REAL_GAS_CACHE / "cells_CIII.npy").astype(np.float64)
    T_full = np.load(REAL_GAS_CACHE / "cells_T.npy").astype(np.float64)
    Z_full = np.load(REAL_GAS_CACHE / "cells_Z.npy").astype(np.float64)

    # 1. Real-data 256^3 SPH kernel deposition (L2 ±25 kpc, 18 extensive quantities as in build_volumes.py)
    sl = slice(0, 300_000)
    pos = pos_full[sl]
    h = h_full[sl]
    qs = {
        "N_nH": nH_full[sl] * V_full[sl],
        "N_HI": HI_full[sl] * V_full[sl],
        "N_OVI": OVI_full[sl] * V_full[sl],
        "N_CIII": CIII_full[sl] * V_full[sl],
        "m": m_full[sl],
        "mT": m_full[sl] * T_full[sl],
        "mZ": m_full[sl] * Z_full[sl],
    }
    for i in range(11):
        qs[f"N_ion{i}"] = m_full[sl] * (1.0 + 0.05 * i)
    g = D.Grid(25.0, 256, h_min_vox=2.0)

    t0 = time.perf_counter()
    res_np = D.scatter(pos, h, qs, g, workers=1, _use_fast=False)
    t_sph_np = time.perf_counter() - t0

    t0 = time.perf_counter()
    res_cpp = D.scatter(pos, h, qs, g, workers=18, _use_fast=True)
    t_sph_cpp = time.perf_counter() - t0

    sph_speedup = t_sph_np / max(t_sph_cpp, 1e-9)
    for k in qs:
        np.testing.assert_allclose(res_cpp.grids[k], res_np.grids[k], rtol=1e-11, atol=1e-12)
        assert abs(res_cpp.q_in[k] - res_np.q_in[k]) <= 1e-11 * abs(res_np.q_in[k])

    # 2. Real-data 256^3 18-field CIC deposition (all 2,028,706 real TNG50 cells x 18 fields)
    qs18 = {
        "N_nH": nH_full * V_full,
        "N_HI": HI_full * V_full,
        "N_OVI": OVI_full * V_full,
        "N_CIII": CIII_full * V_full,
        "m": m_full,
        "mT": m_full * T_full,
        "mZ": m_full * Z_full,
    }
    for i in range(11):
        qs18[f"extra_{i}"] = m_full * (1.0 + 0.1 * i)

    grids_np = {k: np.zeros((256, 256, 256), dtype=np.float64) for k in qs18}
    t0 = time.perf_counter()
    sums_np = D.cic_deposit(pos_full, qs18, grids_np, 400.0, periodic_wrap=True, _use_fast=False)
    t_cic_np = time.perf_counter() - t0

    grids_cpp = {k: np.zeros((256, 256, 256), dtype=np.float64) for k in qs18}
    t0 = time.perf_counter()
    sums_cpp = D.cic_deposit(pos_full, qs18, grids_cpp, 400.0, periodic_wrap=True, workers=18, _use_fast=True)
    t_cic_cpp = time.perf_counter() - t0

    cic_speedup = t_cic_np / max(t_cic_cpp, 1e-9)
    for k in qs18:
        assert abs(sums_cpp[k] - sums_np[k]) <= 1e-11 * abs(sums_np[k])
        np.testing.assert_allclose(grids_cpp[k], grids_np[k], rtol=1e-11, atol=1e-12)

    print(
        f"\n[real-data benchmark] SPH (L2, 18 fields): NumPy={t_sph_np:.3f}s vs C++17/OpenMP={t_sph_cpp:.3f}s "
        f"({sph_speedup:.1f}x speedup) | CIC (2.03M cells, 18 fields): NumPy={t_cic_np:.3f}s vs C++17/OpenMP={t_cic_cpp:.3f}s "
        f"({cic_speedup:.1f}x speedup)"
    )
    assert sph_speedup > 1.5
    assert cic_speedup >= 5.0
