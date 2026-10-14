"""Tests for tngsight.deposit (Phase-2b design §3.1, §3.6 "Deposit" items 1–8).

Fast tests are synthetic. The real-data conservation test is @slow (TNG_RUN_SLOW=1): it reads the per-cell arrays
from `<library>/viz_cache/gas/cells_*.npy` when U_gas has cached them, else the slim cutout under the heavy-I/O lock."""
import contextlib
import json
import math
import os
import time
from pathlib import Path

import numpy as np
import pytest

from tngsight import deposit as D

LOCK = Path(os.environ.get("TNG_HEAVY_LOCK", "/Volumes/cgm_work/scratch/p2/heavy.lock"))


def rel_max(a, b):
    return float(np.max(np.abs(a - b)) / max(np.max(np.abs(b)), 1e-300))


# ------------------------------------------------------------------------------- API surface
def test_api_constants_and_grid():
    assert D.DEPOSIT_VERSION == 1 and D.GENERATOR == "tngsight.deposit/1"
    assert D.K_MAX == 16 and D.H_MIN_VOX == 1.0 and D.PAIR_BUDGET == 1 << 23
    g = D.Grid(25.0, 256)
    assert g.dx == 0.1953125 and g.m_max == 7
    c = g.centers()
    assert c.shape == (256,) and c[0] == -25.0 + 0.5 * g.dx and abs(c[-1] - (25.0 - 0.5 * g.dx)) < 1e-12
    m = g.contains(np.array([[25.05, 0, 0], [25.3, 0, 0], [0, -25.2, 0]]), np.array([0.0, 0.0, 0.5]))
    assert m.tolist() == [True, False, True]          # h_eff = max(h, Δ) = 0.195 for the first two
    with pytest.raises(ValueError):
        D.Grid(1.0, 48)
    R = D.disk_frame()
    assert R.shape == (3, 3) and np.allclose(R @ R.T, np.eye(3), atol=1e-12) and np.linalg.det(R) > 0
    from tngsight.config import GALAXY
    x = np.array(GALAXY["center_kpc"]) + 5.0 * np.array(GALAXY["Lhat"])
    assert np.allclose(D.to_disk(x[None]), [[0, 0, 5.0]], atol=1e-9)


# ------------------------------------------------------------------------------- 1. kernel normalisation
def test_kernel_normalisation():
    xg, wg = np.polynomial.legendre.leggauss(16)
    tot = 0.0
    for a, b in ((0.0, 0.5), (0.5, 1.0)):           # exact for the polynomial pieces
        q = 0.5 * (a + b) + 0.5 * (b - a) * xg
        tot += 0.5 * (b - a) * np.sum(wg * 4 * np.pi * q * q * (8 / np.pi) * D.kernel_shape(q))
    assert abs(tot - 1.0) < 1e-10
    w = D.kernel_shape(np.array([0.0, 0.5, 0.75, 1.0, 2.0]))
    assert np.allclose(w, [1.0, 0.25, 2 * 0.25 ** 3, 0.0, 0.0], atol=1e-15)


# ------------------------------------------------------------------------------- 2. single-element conservation
@pytest.mark.parametrize("h_vox", [0.3, 0.9, 1.0, 1.7, 5, 17, 40, 300])
def test_single_element_conservation(h_vox):
    g = D.Grid(1.0, 32)
    rng = np.random.default_rng(int(h_vox * 10))
    pos = rng.uniform(-1.0, 1.0, (200, 3)) * 0.999
    h = np.full(200, h_vox * g.dx)
    q = rng.uniform(0.5, 2.0, 200)
    ref = D.scatter_reference(pos, h, {"q": q}, g)            # one brute-force call, per-element f in meta
    assert ref.meta["index"] == list(range(200))
    f_ref = np.array(ref.meta["f"])
    levels = set()
    n_inside = 0
    for e in range(200):
        r = D.scatter(pos[e:e + 1], h[e:e + 1], {"q": q[e:e + 1]}, g)
        assert r.n_elements == 1
        levels.add(int(np.argmax(r.level_counts)))
        tot = float(r.grids["q"].sum())
        assert (r.grids["q"] >= 0).all()
        if r.n_straddling == 0:
            n_inside += 1
            assert abs(tot - q[e]) <= 1e-12 * q[e]
            assert abs(f_ref[e] - 1.0) <= 1e-12
        else:
            assert abs(tot - q[e] * f_ref[e]) <= 1e-12 * q[e]
            assert abs(r.q_lost["q"] - q[e] * (1 - f_ref[e])) <= 1e-12 * q[e]
    m_max = g.m_max
    expect = {0.3: 0, 0.9: 0, 1.0: 0, 1.7: 0, 5: 0, 17: 1, 40: 2, 300: m_max}[h_vox]
    assert levels == {expect}
    if h_vox <= 1.0:
        assert n_inside > 150                          # the sub-voxel clamp h_eff = Δ keeps most supports inside


# ------------------------------------------------------------------------------- 3. reference parity, determinism
@pytest.fixture(scope="module")
def many():
    g = D.Grid(1.0, 32)
    rng = np.random.default_rng(3)
    N = 2000
    pos = rng.uniform(-1.15, 1.15, (N, 3))
    h = g.dx * np.exp(rng.uniform(np.log(0.2), np.log(60.0), N))
    qs = {"n": rng.uniform(1, 2, N), "m": rng.lognormal(0, 1, N), "mT": rng.uniform(0, 5, N)}
    return g, pos, h, qs


def test_reference_parity(many):
    g, pos, h, qs = many
    r = D.scatter(pos, h, qs, g)
    ref = D.scatter_reference(pos, h, qs, g)
    assert r.n_elements == ref.n_elements and r.n_straddling == ref.n_straddling
    assert r.level_counts == ref.level_counts and len(r.level_counts) == g.m_max + 1
    assert all(c > 0 for c in r.level_counts[:3])
    for k in qs:
        assert rel_max(r.grids[k], ref.grids[k]) <= 1e-10, k
        assert abs(r.grids[k].sum() - r.q_in[k]) <= 1e-12 * r.q_in[k]
        assert abs(r.q_in[k] - ref.q_in[k]) <= 1e-12 * ref.q_in[k]
        assert abs(r.q_full_inside[k] - ref.q_full_inside[k]) <= 1e-12 * ref.q_full_inside[k]
        assert abs(r.q_lost[k] - ref.q_lost[k]) <= 1e-12 * max(ref.q_lost[k], 1e-300)
        assert (r.grids[k] >= 0).all()


def test_budget_workers_determinism(many):
    g, pos, h, qs = many
    base = D.scatter(pos, h, qs, g)
    small = D.scatter(pos, h, qs, g, pair_budget=64)
    two = D.scatter(pos, h, qs, g, workers=2)
    two_small = D.scatter(pos, h, qs, g, workers=2, pair_budget=64)
    assert small.meta["chunks"] > base.meta["chunks"] and two.meta["slices"] == 2
    for k in qs:
        for other in (small, two, two_small):
            assert rel_max(other.grids[k], base.grids[k]) <= 1e-12, k
    again = D.scatter(pos, h, qs, g)
    again2 = D.scatter(pos, h, qs, g, workers=2)
    for k in qs:
        assert again.grids[k].tobytes() == base.grids[k].tobytes()
        assert again2.grids[k].tobytes() == two.grids[k].tobytes()


def test_progress_callback(many):
    g, pos, h, qs = many
    seen = []
    D.scatter(pos, h, qs, g, pair_budget=4096, progress=lambda d, t: seen.append((d, t)))
    assert len(seen) > 1 and seen[-1][0] == seen[-1][1] and all(a <= b for (a, _), (b, _) in zip(seen, seen[1:]))


# ------------------------------------------------------------------------------- 4. prolongation
def test_prolong2():
    rng = np.random.default_rng(4)
    for m in (2, 3, 8):
        u = rng.lognormal(0, 2, (m, m, m))
        c = D.prolong2(u)
        assert c.shape == (2 * m,) * 3
        assert abs(c.sum() - u.sum()) <= 1e-12 * u.sum()
        assert (c > 0).all()
        assert (c >= u.repeat(2, 0).repeat(2, 1).repeat(2, 2) / 32 * (1 - 1e-12)).all()
        blocks = c.reshape(m, 2, m, 2, m, 2).sum(axis=(1, 3, 5))
        assert np.allclose(blocks, u, rtol=1e-12, atol=0)
        assert np.allclose(c, D._prolong2_reference(u), rtol=1e-13, atol=0)
    assert np.allclose(D.prolong2(np.full((4, 4, 4), 3.0)), 3.0 / 8, rtol=0, atol=1e-15)
    m = 6
    i = np.arange(m, dtype=float)
    a, b, cc, d = 10.0, 0.7, -0.4, 1.3
    u = a + b * i[:, None, None] + cc * i[None, :, None] + d * i[None, None, :]
    p = D.prolong2(u)
    x = (np.arange(2 * m) + 0.5) / 2 - 0.5                  # fine-cell centres in coarse index units
    exp = (a + b * x[:, None, None] + cc * x[None, :, None] + d * x[None, None, :]) / 8
    s = slice(2, 2 * m - 2)                                  # interior: children of coarse cells 1..m−2
    assert np.allclose(p[s, s, s], exp[s, s, s], rtol=1e-14, atol=1e-14)


# ------------------------------------------------------------------------------- 5. line integral
def test_line_integral_central_chord():
    for h in (0.37, 1.0, 4.2):
        q = 2.5
        exact = 6.0 / (np.pi * h * h) * q
        pos = np.array([[0.3, -0.2, 0.1]])
        p0 = pos[0] + np.array([-2 * h, 0, 0])
        p1 = pos[0] + np.array([+1.5 * h, 0, 0])
        v = D.line_integral(pos, [h], [q], p0, p1)
        assert abs(v - exact) <= 1e-9 * exact
        half = D.line_integral(pos, [h], [q], p0, pos[0])
        assert abs(half - exact / 2) <= 1e-9 * exact
        # oblique chord with impact parameter b: compare with dense quadrature
        b = 0.3 * h
        p0 = pos[0] + np.array([-2 * h, b, 0]); p1 = pos[0] + np.array([2 * h, b, 0])
        s = np.linspace(-h, h, 400001)
        r = np.sqrt(s * s + b * b)
        dense = np.trapz(8 / (np.pi * h ** 3) * D.kernel_shape(r / h), s) * q
        assert abs(D.line_integral(pos, [h], [q], p0, p1) - dense) <= 1e-7 * dense
    assert D.line_integral(np.array([[5.0, 5.0, 5.0]]), [1.0], [1.0], [0, 0, 0], [1, 0, 0]) == 0.0


# ------------------------------------------------------------------------------- 6. cube column
def test_cube_column_constant():
    n, half, c = 32, 10.0, 3.7
    rho = np.full((n, n, n), c)
    dx = 2 * half / n
    for axis in range(3):
        for off in (0.0, 0.5 * dx, 3.3):
            p0 = np.array([off, -off, off]); p1 = p0.copy()
            p0[axis] = -half; p1[axis] = half
            assert abs(D.cube_column(rho, half, p0, p1) - c * 2 * half) <= 1e-12 * c * 2 * half
    # a chord extending beyond the box only collects the in-box part
    v = D.cube_column(rho, half, [-3 * half, 0, 0], [3 * half, 0, 0], samples_per_voxel=8)
    assert abs(v - c * 2 * half) <= c * 2 * half * 1e-3
    # a linear field integrates exactly in the interior
    i = np.arange(n)
    lin = np.broadcast_to((1.0 + 0.1 * i)[:, None, None], (n, n, n)).copy()
    x0 = -half + 3.5 * dx; x1 = -half + 20.5 * dx
    val = D.cube_column(lin, half, [x0, 0.1, 0.2], [x1, 0.1, 0.2])
    exact = (x1 - x0) * (1.0 + 0.1 * ((0.5 * (x0 + x1) + half) / dx - 0.5))
    assert abs(val - exact) <= 1e-12 * exact


def test_cube_column_matches_line_integral():
    """End to end: deposit a few smooth elements and compare the cube column with the exact chord integral."""
    g = D.Grid(10.0, 64)
    rng = np.random.default_rng(6)
    N = 300
    pos = rng.normal(0, 2.0, (N, 3))
    h = rng.uniform(2.0, 4.0, N)
    q = rng.uniform(1, 2, N)
    r = D.scatter(pos, h, {"q": q}, g)
    dens = r.grids["q"] / g.dx ** 3
    p0, p1 = np.array([-10.0, 0.3, -0.2]), np.array([10.0, 0.3, -0.2])
    col = D.cube_column(dens, g.half_kpc, p0, p1)
    ref = D.line_integral(pos, h, q, p0, p1)
    assert abs(math.log10(col / ref)) < 0.01


# ------------------------------------------------------------------------------- 7. speed
def test_speed():
    g = D.Grid(1.0, 64)
    rng = np.random.default_rng(7)
    N = 200_000
    pos = rng.uniform(-1, 1, (N, 3))
    h = np.full(N, 2 * g.dx)
    t = time.perf_counter()
    r = D.scatter(pos, h, {"m": np.ones(N)}, g)
    dt = time.perf_counter() - t
    print(f"\nspeed: {N} elements, {r.meta['pairs']} pairs, {dt:.2f} s, {r.meta['pairs'] / dt / 1e6:.1f} Mpairs/s")
    assert dt < 5.0
    assert abs(r.grids["m"].sum() - r.q_in["m"]) <= 1e-12 * N


# ------------------------------------------------------------------------------- 8. real data (slow)
@contextlib.contextmanager
def heavy_lock():
    if not LOCK.parent.is_dir():
        yield; return
    import fcntl
    with open(LOCK, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _gas_cells():
    from tngsight import config
    cache = config.library_dir() / "viz_cache" / "gas"
    names = {k: cache / f"cells_{k}.npy" for k in ("pos_disk", "h", "m")}
    if all(p.is_file() for p in names.values()):
        return {k: np.load(p).astype(np.float64) for k, p in names.items()}, str(cache)
    cut = config.cutout_path()
    if not cut.is_file():
        pytest.skip("slim cutout absent")
    import h5py
    H = config.GALAXY["TNG_H"]
    with heavy_lock(), h5py.File(cut, "r") as f:
        g = f["PartType0"]
        x = g["Coordinates"][:].astype(np.float64) / H
        mc = g["Masses"][:].astype(np.float64)
        rho = g["Density"][:].astype(np.float64)
    V = mc / rho / H ** 3                                # physical kpc³
    return {"pos_disk": D.to_disk(x), "h": 2.0 * (3 * V / (4 * np.pi)) ** (1 / 3), "m": mc * 1e10 / H}, str(cut)


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("TNG_RUN_SLOW") != "1", reason="set TNG_RUN_SLOW=1 (real slim-cutout gas)")
def test_real_gas_mass_L1():
    cells, src = _gas_cells()
    g = D.Grid(100.0, 256)
    workers = int(os.environ.get("TNG_DEPOSIT_WORKERS", "4"))
    touch = g.contains(cells["pos_disk"], cells["h"])
    m_touch = float(cells["m"][touch].sum())
    r = D.scatter(cells["pos_disk"], cells["h"], {"m": cells["m"]}, g, workers=workers)
    assert r.n_elements == int(touch.sum())
    strad_in = (m_touch - r.q_full_inside["m"]) - r.q_lost["m"]      # Σ q·f over the straddlers
    G = float(r.grids["m"].sum())
    rel = abs(G - (r.q_full_inside["m"] + strad_in)) / G
    lost = r.q_lost["m"] / m_touch
    print("\n" + json.dumps({"source": src, "n_elements": r.n_elements, "n_straddling": r.n_straddling,
                             "level_counts": r.level_counts, "seconds": round(r.seconds, 1), "workers": workers,
                             "conservation_rel": rel, "lost_fraction": lost, "pairs": r.meta["pairs"]}))
    assert rel <= 1e-6
    assert abs(lost - 0.029) <= 0.005
