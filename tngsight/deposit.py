"""Conservative SPH-kernel scatter of particles/cells onto nested 256³ cubes (Phase-2b design §3.1, D1).

Pure numpy (+ scipy for `cube_column`); no yt, no numba. One core serves gas cells and star particles.

Kernel. Cubic spline with compact support h (yt/Trident convention):

    w(q) = 1 − 6q² + 6q³ (0 ≤ q ≤ ½);  2(1 − q)³ (½ < q < 1);  0 (q ≥ 1)
    W(r, h) = 8/(π h³) · w(r/h)          (∫ W d³x = 1)

Scatter (`scatter`, exact algorithm of §3.1; `scatter_reference` is the brute-force twin used by the tests):

1. Δ = 2·half/n, h_eff = max(h, H_MIN_VOX·Δ); keep elements with max_a |p_a| < half + h_eff.
2. Level m = 0 if k0 = ceil(h_eff/Δ) ≤ k_max, else min(M_MAX, ceil(log2(k0/k_max))), M_MAX = log2(n) − 1.
   Level m is the lattice Δ_m = 2^m Δ, n_m = n/2^m covering the same box.
3. g = (p + half)/Δ_m − 0.5, c = rint(g), k = ceil(h_eff/Δ_m); lattice points j = c + o, o ∈ [−k, k]³ with
   |o| ≤ k + 1 (the corners beyond have w = 0); w_j = w(|j − g|·Δ_m / h_eff) normalised by S = Σ_j w_j over the
   UNBOUNDED lattice, so an element fully inside the box deposits exactly q.
4. q·w_j/S goes to cell j when it is inside the box, otherwise it is lost; f = Σ_{j in box} w_j / S.
5. Coarse levels come back by conservative minmod-linear prolongation, acc[m−1] += prolong2(acc[m]), m = M_MAX..1.
6. Elements are processed stably sorted by (m, k, original index), in chunks of ≤ pair_budget pairs, with one
   np.bincount per chunk, level and quantity. workers > 1 cuts that order into equal-pair slices run by spawn
   processes; partial grids are summed in slice order. Same inputs + workers + pair_budget → identical bytes.

Positions are disk-frame kpc relative to the galaxy centre (`to_disk`). Quantities are extensive per element
(count, mass, luminosity, mass·T, …); every grid holds per-voxel TOTALS (divide by the voxel volume for a density).
"""
from __future__ import annotations

import math
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
import multiprocessing as mp

import numpy as np

from .config import GALAXY

DEPOSIT_VERSION = 1
GENERATOR = "tngsight.deposit/1"
K_MAX = 16                 # max stencil half-width (in voxels of the level used)
H_MIN_VOX = 1.0            # h_eff = max(h, H_MIN_VOX * Δ)
PAIR_BUDGET = 1 << 23      # particle-voxel pairs per chunk
_BLOCK_PAIRS = 1 << 18     # internal: weights are computed in blocks of ≤ this many pairs
STRADDLE_EPS = 1e-12       # an element with in-box fraction f < 1 − STRADDLE_EPS straddles the box

_KNORM = 8.0 / math.pi


# --------------------------------------------------------------------------------------------- kernel / frame
def kernel_shape(q: np.ndarray) -> np.ndarray:
    """Dimensionless cubic-spline shape w(q); W(r, h) = 8/(π h³)·w(r/h)."""
    q = np.asarray(q, dtype=np.float64)
    t = np.clip(1.0 - q, 0.0, None)
    outer = 2.0 * t * t * t
    inner = 1.0 - 6.0 * q * q + 6.0 * q * q * q
    return np.where(q <= 0.5, inner, outer)


def _w_scalar(q: float) -> float:
    if q <= 0.5:
        return 1.0 - 6.0 * q * q + 6.0 * q * q * q
    if q < 1.0:
        t = 1.0 - q
        return 2.0 * t * t * t
    return 0.0


def disk_frame() -> np.ndarray:
    """R (3,3) float64 with rows xhat, yhat, Lhat (design §2.1)."""
    return np.array([GALAXY["xhat"], GALAXY["yhat"], GALAXY["Lhat"]], dtype=np.float64)


def to_disk(x_abs_kpc: np.ndarray) -> np.ndarray:
    """Absolute physical box-axis kpc (N,3) → disk-frame kpc relative to center_kpc: (x − c) @ Rᵀ."""
    x = np.asarray(x_abs_kpc, dtype=np.float64)
    return (x - np.asarray(GALAXY["center_kpc"], dtype=np.float64)) @ disk_frame().T


# --------------------------------------------------------------------------------------------- data classes
@dataclass(frozen=True)
class Grid:
    half_kpc: float
    n: int

    def __post_init__(self):
        n = int(self.n)
        if n < 2 or n & (n - 1):
            raise ValueError(f"Grid.n must be a power of two ≥ 2, got {self.n}")
        if not (self.half_kpc > 0):
            raise ValueError("Grid.half_kpc must be > 0")

    @property
    def dx(self) -> float:
        return 2.0 * float(self.half_kpc) / int(self.n)

    @property
    def m_max(self) -> int:
        return int(self.n).bit_length() - 2          # log2(n) − 1

    def centers(self) -> np.ndarray:
        return -float(self.half_kpc) + (np.arange(int(self.n)) + 0.5) * self.dx

    def h_eff(self, h) -> np.ndarray:
        return np.maximum(np.asarray(h, dtype=np.float64), H_MIN_VOX * self.dx)

    def contains(self, pos, h) -> np.ndarray:
        """Mask of elements whose support (radius h_eff) overlaps the box: max_a |p_a| < half + h_eff."""
        pos = np.asarray(pos, dtype=np.float64).reshape(-1, 3)
        return np.max(np.abs(pos), axis=1) < float(self.half_kpc) + self.h_eff(h)


@dataclass
class DepositResult:
    grids: dict                    # name -> float64 (n,n,n) [i,j,k]: per-voxel TOTAL of the extensive quantity
    n_elements: int                # elements whose support (h_eff) overlaps the box
    n_straddling: int              # of those, elements with in-box fraction f < 1 − 1e-12
    q_in: dict                     # Σ q·f over the elements (equals Σ grid to rounding)
    q_full_inside: dict            # Σ q over elements whose whole support is inside the box (f = 1)
    q_lost: dict                   # Σ q·(1 − f) over the straddlers
    level_counts: list             # elements per lattice level m = 0..M_MAX
    seconds: float
    meta: dict = field(default_factory=dict)   # extra diagnostics (pairs, chunks, workers, generator)


# --------------------------------------------------------------------------------------------- shared set-up
def _prepare(pos_kpc, h_kpc, quantities, grid: Grid, k_max: int):
    pos = np.ascontiguousarray(np.asarray(pos_kpc, dtype=np.float64).reshape(-1, 3))
    h = np.asarray(h_kpc, dtype=np.float64).reshape(-1)
    if h.shape[0] != pos.shape[0]:
        raise ValueError("pos_kpc and h_kpc lengths differ")
    if not quantities:
        raise ValueError("quantities is empty")
    names = list(quantities)
    qs = {}
    for k in names:
        q = np.asarray(quantities[k], dtype=np.float64).reshape(-1)
        if q.shape[0] != pos.shape[0]:
            raise ValueError(f"quantity {k!r} has the wrong length")
        qs[k] = q
    if not np.all(np.isfinite(pos)) or not np.all(np.isfinite(h)) or np.any(h < 0):
        raise ValueError("positions and smoothing lengths must be finite and h ≥ 0")
    k_max = int(k_max)
    if k_max < 1:
        raise ValueError("k_max must be ≥ 1")

    n, half, dx = int(grid.n), float(grid.half_kpc), grid.dx
    heff_all = grid.h_eff(h)
    sel = np.flatnonzero(np.max(np.abs(pos), axis=1) < half + heff_all)
    heff = heff_all[sel]
    k0 = np.ceil(heff / dx).astype(np.int64)
    m = np.zeros(sel.size, dtype=np.int64)
    big = k0 > k_max
    if np.any(big):
        # smallest m with k_max·2^m ≥ k0  (= ceil(log2(k0/k_max)) without float rounding), capped at M_MAX
        kb = k0[big]
        mb = np.maximum(np.ceil(np.log2(kb / k_max)).astype(np.int64), 1)
        mb = np.where((mb > 1) & ((k_max << (mb - 1)) >= kb), mb - 1, mb)     # float log2 one too high
        mb = np.where((k_max << mb) < kb, mb + 1, mb)                         # float log2 one too low
        m[big] = np.minimum(grid.m_max, mb)
    dxm = dx * (2.0 ** m)
    k = np.ceil(heff / dxm).astype(np.int64)
    return pos, h, qs, names, sel, heff, m, k, dxm


_OFFSETS: dict = {}


def _offsets(k: int) -> np.ndarray:
    """Stencil offsets o ∈ [−k, k]³ with |o|² ≤ (k + 1)², lexicographic (ox, oy, oz) order; int64 (S,3)."""
    o = _OFFSETS.get(k)
    if o is None:
        r = np.arange(-k, k + 1, dtype=np.int64)
        ox, oy, oz = np.meshgrid(r, r, r, indexing="ij")
        o = np.stack([ox.ravel(), oy.ravel(), oz.ravel()], axis=1)
        o = o[(o * o).sum(1) <= (k + 1) * (k + 1)]
        o.setflags(write=False)
        _OFFSETS[k] = o
    return o


def _n_offsets(k: int) -> int:
    return int(_offsets(int(k)).shape[0])


# --------------------------------------------------------------------------------------------- vectorised core
def _run_weights(pos, heff, dxm, k, n_m, half):
    """Weights of P elements sharing (m, k). Returns flat cell index, normalised weight, element row, f."""
    off = _offsets(int(k))
    g = (pos + half) / dxm - 0.5                       # (P,3)
    c = np.rint(g).astype(np.int64)
    ix = c[:, 0:1] + off[None, :, 0]
    iy = c[:, 1:2] + off[None, :, 1]
    iz = c[:, 2:3] + off[None, :, 2]
    ddx = (ix - g[:, 0:1]) * dxm
    r2 = ddx * ddx
    ddx = (iy - g[:, 1:2]) * dxm
    r2 += ddx * ddx
    ddx = (iz - g[:, 2:3]) * dxm
    r2 += ddx * ddx
    del ddx
    w = kernel_shape(np.sqrt(r2) / heff[:, None])
    del r2
    S = w.sum(axis=1)
    w /= S[:, None]
    inb = (ix >= 0) & (ix < n_m) & (iy >= 0) & (iy < n_m) & (iz >= 0) & (iz < n_m)
    f = np.where(inb, w, 0.0).sum(axis=1)
    keep = inb & (w > 0)
    rows, cols = np.nonzero(keep)
    flat = (ix[rows, cols] * n_m + iy[rows, cols]) * n_m + iz[rows, cols]
    return flat, w[rows, cols], rows, f


def _level_sizes(n, m_max):
    return [(n >> mm) ** 3 for mm in range(m_max + 1)]


def _level_views(buf: np.ndarray, n, m_max, nq):
    """Split one flat float64 buffer into per-level (nq, n_m³) C-contiguous accumulators."""
    views, o = [], 0
    for sz in _level_sizes(n, m_max):
        views.append(buf[o:o + nq * sz].reshape(nq, sz))
        o += nq * sz
    return views


def _accumulate(acc, pos, heff, m, k, dxm, qarr, n, half, pair_budget, progress=None, pair_offset=0,
                pair_total=0):
    """Process sorted elements in chunks of ≤ pair_budget pairs, adding into acc; returns (f, n_chunks).

    acc[m] is a float64 (nq, n_m³) array of per-cell totals for level m (cell index (i·n_m + j)·n_m + k);
    f is the in-box fraction per element."""
    N = pos.shape[0]
    nq = qarr.shape[1]
    f = np.zeros(N, dtype=np.float64)
    if N == 0:
        return f, 0
    pairs = np.fromiter((_n_offsets(kk) for kk in k), dtype=np.int64, count=N)
    cum = np.cumsum(pairs)
    s = 0
    n_chunks = 0
    while s < N:
        base = cum[s - 1] if s else 0
        e = int(np.searchsorted(cum, base + pair_budget, side="right"))
        e = max(e, s + 1)
        by_level: dict = {}
        a = s
        while a < e:                                     # runs of identical (m, k) inside the chunk
            b = a + 1
            while b < e and m[b] == m[a] and k[b] == k[a]:
                b += 1
            mm = int(m[a])
            step = max(1, _BLOCK_PAIRS // _n_offsets(int(k[a])))   # weights in blocks: bounded temporaries
            for c0 in range(a, b, step):
                c1 = min(b, c0 + step)
                flat, w, rows, fr = _run_weights(pos[c0:c1], heff[c0:c1], float(dxm[a]), int(k[a]), n >> mm, half)
                f[c0:c1] = fr
                rows += c0
                by_level.setdefault(mm, []).append((flat, w, rows))
            a = b
        for mm, parts in sorted(by_level.items()):       # one np.bincount per level, quantity and chunk
            flat = np.concatenate([p[0] for p in parts]) if len(parts) > 1 else parts[0][0]
            if flat.size == 0:
                continue
            w = np.concatenate([p[1] for p in parts]) if len(parts) > 1 else parts[0][1]
            rows = np.concatenate([p[2] for p in parts]) if len(parts) > 1 else parts[0][2]
            del parts
            lo = int(flat.min())
            hi = int(flat.max()) + 1
            rel = flat - lo if lo else flat
            for j in range(nq):
                acc[mm][j, lo:hi] += np.bincount(rel, weights=w * qarr[rows, j], minlength=hi - lo)
        n_chunks += 1
        if progress is not None:
            progress(int(pair_offset + cum[e - 1]), int(pair_total or cum[-1]))
        s = e
    return f, n_chunks


def _slice_worker(args):
    shm_name, size, pos, heff, m, k, dxm, qarr, n, half, m_max, pair_budget = args
    from multiprocessing import shared_memory
    t = time.perf_counter()
    priv = np.zeros(size, dtype=np.float64)          # private accumulation: shared pages are slow to scatter into
    f, nc = _accumulate(_level_views(priv, n, m_max, qarr.shape[1]), pos, heff, m, k, dxm, qarr, n, half,
                        pair_budget)
    shm = shared_memory.SharedMemory(name=shm_name)
    try:
        buf = np.ndarray((size,), dtype=np.float64, buffer=shm.buf)
        buf[:] = priv                                 # one sequential copy back to the parent
        del buf
    finally:
        shm.close()
    return f, nc, time.perf_counter() - t


def scatter(pos_kpc, h_kpc, quantities: dict, grid: Grid, *, k_max=K_MAX, pair_budget=PAIR_BUDGET, workers=1,
            progress=None) -> DepositResult:
    """Conservative normalised-kernel scatter (§3.1). Deterministic for fixed inputs, workers and pair_budget.

    workers > 1: the sorted order is cut into `workers` contiguous slices of equal pair count, each slice is
    accumulated by a spawn-context process into its own shared-memory buffer, and the partial grids are summed in
    slice order (numpy only)."""
    t0 = time.perf_counter()
    pos, h, qs, names, sel, heff, m, k, dxm = _prepare(pos_kpc, h_kpc, quantities, grid, k_max)
    n, half, m_max = int(grid.n), float(grid.half_kpc), grid.m_max
    nq = len(names)
    pair_budget = max(1, int(pair_budget))
    order = np.lexsort((sel, k, m))                      # stable by (m, k, original index)
    sel, heff, m, k, dxm = sel[order], heff[order], m[order], k[order], dxm[order]
    P = pos[sel]
    qarr = np.stack([qs[nm][sel] for nm in names], axis=1)
    N = sel.size
    pairs = np.fromiter((_n_offsets(kk) for kk in k), dtype=np.int64, count=N)
    total_pairs = int(pairs.sum())
    workers = max(1, int(workers))
    size = nq * sum(_level_sizes(n, m_max))
    buf = np.zeros(size, dtype=np.float64)
    acc = _level_views(buf, n, m_max, nq)

    if workers == 1 or N < 2:
        f, n_chunks = _accumulate(acc, P, heff, m, k, dxm, qarr, n, half, pair_budget, progress, 0, total_pairs)
        bounds = [0, N]
        timing = {}
    else:
        from multiprocessing import shared_memory
        cum = np.cumsum(pairs)
        bounds = [0]
        for w_ in range(1, workers):
            bounds.append(int(np.searchsorted(cum, total_pairs * w_ / workers, side="left")))
        bounds.append(N)
        for i in range(1, len(bounds)):
            bounds[i] = min(max(bounds[i], bounds[i - 1]), N)
        shms = [shared_memory.SharedMemory(create=True, size=size * 8) for _ in range(workers)]
        try:
            for sh in shms:                       # new segments are zero-filled; make sure regardless
                part = np.ndarray((size,), dtype=np.float64, buffer=sh.buf)
                if part[:1024].any() or part[-1024:].any():
                    part[:] = 0.0
                del part
            t_pool = time.perf_counter()
            jobs = [(sh.name, size, P[a:b], heff[a:b], m[a:b], k[a:b], dxm[a:b], qarr[a:b], n, half, m_max,
                     pair_budget) for sh, a, b in zip(shms, bounds[:-1], bounds[1:])]
            ctx = mp.get_context("spawn")
            with ProcessPoolExecutor(max_workers=workers, mp_context=ctx) as ex:
                results = list(ex.map(_slice_worker, jobs))
            t_pool = time.perf_counter() - t_pool
            t_merge = time.perf_counter()
            f = np.zeros(N, dtype=np.float64)
            n_chunks = 0
            done = 0
            worker_s = []
            for sh, a, b, (f_w, nc, tw) in zip(shms, bounds[:-1], bounds[1:], results):     # slice order
                worker_s.append(round(tw, 3))
                part = np.ndarray((size,), dtype=np.float64, buffer=sh.buf)
                buf += part
                del part
                f[a:b] = f_w
                n_chunks += nc
                done += int(pairs[a:b].sum())
                if progress is not None:
                    progress(done, total_pairs)
            timing = {"pool_s": round(t_pool, 3), "merge_s": round(time.perf_counter() - t_merge, 3),
                      "worker_compute_s": worker_s}
        finally:
            for sh in shms:
                sh.close()
                sh.unlink()

    lv = [a.reshape(nq, n >> mm, n >> mm, n >> mm) for mm, a in enumerate(acc)]
    for mm in range(m_max, 0, -1):
        for j in range(nq):
            if np.any(lv[mm][j]):
                lv[mm - 1][j] += prolong2(lv[mm][j])
    grids = {nm: lv[0][j].copy() for j, nm in enumerate(names)}
    del lv, acc, buf
    return _result(grids, names, qarr, f, m, m_max, time.perf_counter() - t0,
                   meta={"generator": GENERATOR, "pairs": total_pairs, "chunks": n_chunks, "workers": workers,
                         "pair_budget": pair_budget, "k_max": int(k_max), "slices": len(bounds) - 1, **timing})


def _result(grids, names, qarr, f, m, m_max, seconds, meta) -> DepositResult:
    strad = f < 1.0 - STRADDLE_EPS
    q_in, q_full, q_lost = {}, {}, {}
    for j, nm in enumerate(names):
        q = qarr[:, j]
        q_in[nm] = float(np.sum(q * f))
        q_full[nm] = float(np.sum(q[~strad]))
        q_lost[nm] = float(np.sum(q[strad] * (1.0 - f[strad])))
    counts = np.bincount(m, minlength=m_max + 1)[: m_max + 1] if m.size else np.zeros(m_max + 1, np.int64)
    return DepositResult(grids=grids, n_elements=int(f.size), n_straddling=int(strad.sum()), q_in=q_in,
                         q_full_inside=q_full, q_lost=q_lost, level_counts=[int(c) for c in counts],
                         seconds=float(seconds), meta=meta)


# --------------------------------------------------------------------------------------------- prolongation
def _minmod_slope(u: np.ndarray, axis: int) -> np.ndarray:
    up = np.zeros_like(u)
    dn = np.zeros_like(u)
    sl_hi = [slice(None)] * 3
    sl_lo = [slice(None)] * 3
    sl_hi[axis] = slice(1, None)
    sl_lo[axis] = slice(None, -1)
    d = np.diff(u, axis=axis)                     # u[i+1] − u[i]
    up[tuple(sl_lo)] = d                          # forward difference (0 at the upper face)
    dn[tuple(sl_hi)] = d                          # backward difference (0 at the lower face)
    return np.where(up * dn > 0, np.sign(up) * np.minimum(np.abs(up), np.abs(dn)), 0.0)


def prolong2(u: np.ndarray) -> np.ndarray:
    """(m,m,m) per-cell totals → (2m,2m,2m): child σ ∈ {±1}³ gets (u + σ·s/4)/8, s = minmod slopes.

    Conservative (Σ children = u exactly in exact arithmetic) and positive (child ≥ u/32 when u > 0)."""
    u = np.asarray(u, dtype=np.float64)
    if u.ndim != 3 or len(set(u.shape)) != 1:
        raise ValueError("prolong2 expects a cubic (m,m,m) array")
    sx, sy, sz = (_minmod_slope(u, a) for a in range(3))
    mdim = u.shape[0]
    out = np.empty((2 * mdim,) * 3, dtype=np.float64)
    for a, ax in enumerate((-1.0, 1.0)):
        for b, by in enumerate((-1.0, 1.0)):
            for c, cz in enumerate((-1.0, 1.0)):
                out[a::2, b::2, c::2] = (u + (ax * sx + by * sy + cz * sz) / 4.0) / 8.0
    return out


# --------------------------------------------------------------------------------------------- brute force
def _prolong2_reference(u: np.ndarray) -> np.ndarray:
    mdim = u.shape[0]
    out = np.zeros((2 * mdim,) * 3)

    def mm(a, b):
        return math.copysign(min(abs(a), abs(b)), a) if a * b > 0 else 0.0

    for i in range(mdim):
        for j in range(mdim):
            for l in range(mdim):
                v = float(u[i, j, l])
                s = []
                for ax, idx in ((0, i), (1, j), (2, l)):
                    if idx == 0 or idx == mdim - 1:
                        s.append(0.0)
                        continue
                    p = [i, j, l]; p[ax] = idx + 1; vp = float(u[tuple(p)])
                    p[ax] = idx - 1; vm = float(u[tuple(p)])
                    s.append(mm(vp - v, v - vm))
                for a, sa in ((0, -1), (1, 1)):
                    for b, sb in ((0, -1), (1, 1)):
                        for c, sc in ((0, -1), (1, 1)):
                            out[2 * i + a, 2 * j + b, 2 * l + c] = (v + (sa * s[0] + sb * s[1] + sc * s[2]) / 4.0) / 8.0
    return out


def scatter_reference(pos_kpc, h_kpc, quantities: dict, grid: Grid, *, k_max=K_MAX) -> DepositResult:
    """Brute-force twin of `scatter`: plain Python loops per element and per lattice point (tests, n ≤ 32)."""
    t0 = time.perf_counter()
    n, half, dx, m_max = int(grid.n), float(grid.half_kpc), grid.dx, grid.m_max
    pos = np.asarray(pos_kpc, dtype=np.float64).reshape(-1, 3)
    h = np.asarray(h_kpc, dtype=np.float64).reshape(-1)
    names = list(quantities)
    qcols = [np.asarray(quantities[nm], dtype=np.float64).reshape(-1) for nm in names]
    acc = [np.zeros((n >> mm, n >> mm, n >> mm, len(names))) for mm in range(m_max + 1)]
    fs, ms, qrows, kept = [], [], [], []
    for e in range(pos.shape[0]):
        he = max(float(h[e]), H_MIN_VOX * dx)
        p = [float(pos[e, a]) for a in range(3)]
        if not max(abs(p[0]), abs(p[1]), abs(p[2])) < half + he:
            continue
        k0 = math.ceil(he / dx)
        if k0 <= k_max:
            m = 0
        else:
            m = 1
            while k_max * 2 ** m < k0:
                m += 1
            m = min(m_max, m)
        dxm = dx * 2.0 ** m
        nm_ = n >> m
        kk = math.ceil(he / dxm)
        g = [(p[a] + half) / dxm - 0.5 for a in range(3)]
        c = [int(np.rint(g[a])) for a in range(3)]
        pts = []
        S = 0.0
        lim = (kk + 1) * (kk + 1)
        for ox in range(-kk, kk + 1):
            jx = c[0] + ox
            dx2 = ((jx - g[0]) * dxm) ** 2
            for oy in range(-kk, kk + 1):
                jy = c[1] + oy
                dy2 = ((jy - g[1]) * dxm) ** 2
                for oz in range(-kk, kk + 1):
                    if ox * ox + oy * oy + oz * oz > lim:
                        continue
                    jz = c[2] + oz
                    r = math.sqrt(dx2 + dy2 + ((jz - g[2]) * dxm) ** 2)
                    w = _w_scalar(r / he)
                    if w <= 0.0:
                        continue
                    S += w
                    if 0 <= jx < nm_ and 0 <= jy < nm_ and 0 <= jz < nm_:
                        pts.append((jx, jy, jz, w))
        fin = 0.0
        qe = [qc[e] for qc in qcols]
        for jx, jy, jz, w in pts:
            wn = w / S
            fin += wn
            for j, qv in enumerate(qe):
                acc[m][jx, jy, jz, j] += qv * wn
        fs.append(fin); ms.append(m); qrows.append(qe); kept.append(e)
    for mm in range(m_max, 0, -1):
        for j in range(len(names)):
            acc[mm - 1][..., j] += _prolong2_reference(acc[mm][..., j])
    grids = {nm: acc[0][..., j].copy() for j, nm in enumerate(names)}
    qarr = np.array(qrows, dtype=np.float64).reshape(-1, len(names))
    return _result(grids, names, qarr, np.array(fs, dtype=np.float64), np.array(ms, dtype=np.int64), m_max,
                   time.perf_counter() - t0,
                   meta={"generator": GENERATOR + "+reference", "index": kept, "f": [float(x) for x in fs]})


# --------------------------------------------------------------------------------------------- column checks
def line_integral(pos_kpc, h_kpc, q, p0, p1, n_gauss=32) -> float:
    """Σ_i q_i ∫_{chord ∩ [p0,p1]} W(|x(s) − x_i|, h_i) ds   [q·kpc⁻²].

    Exact chord limits; each chord is split at the kernel kink (r = h/2) and at closest approach, and every
    piece uses n_gauss-point Gauss–Legendre (exact for the polynomial pieces of a central chord)."""
    pos = np.asarray(pos_kpc, dtype=np.float64).reshape(-1, 3)
    h = np.asarray(h_kpc, dtype=np.float64).reshape(-1)
    q = np.asarray(q, dtype=np.float64).reshape(-1)
    p0 = np.asarray(p0, dtype=np.float64)
    p1 = np.asarray(p1, dtype=np.float64)
    L = float(np.linalg.norm(p1 - p0))
    if L == 0.0 or pos.shape[0] == 0:
        return 0.0
    u = (p1 - p0) / L
    xg, wg = np.polynomial.legendre.leggauss(int(n_gauss))
    total = 0.0
    CH = 1 << 15
    for s in range(0, pos.shape[0], CH):
        d = pos[s:s + CH] - p0
        hh = h[s:s + CH]
        qq = q[s:s + CH]
        tc = d @ u
        b2 = np.maximum(np.einsum("ij,ij->i", d, d) - tc * tc, 0.0)
        hit = (b2 < hh * hh) & (hh > 0) & (qq != 0)
        if not np.any(hit):
            continue
        tc, b2, hh, qq = tc[hit], b2[hit], hh[hit], qq[hit]
        a = np.sqrt(hh * hh - b2)
        ah = np.sqrt(np.maximum(0.25 * hh * hh - b2, 0.0))
        br = np.stack([tc - a, tc - ah, tc, tc + ah, tc + a], axis=1)
        br = np.clip(br, 0.0, L)
        lo, hi = br[:, :-1], br[:, 1:]                       # (P,4) pieces
        mid, hw = 0.5 * (lo + hi), 0.5 * (hi - lo)
        t = mid[..., None] + hw[..., None] * xg              # (P,4,G)
        r = np.sqrt(b2[:, None, None] + (t - tc[:, None, None]) ** 2)
        wv = kernel_shape(r / hh[:, None, None])
        integ = (wv * wg).sum(-1) * hw                       # ∫ w ds per piece
        total += float(np.sum(qq * _KNORM / hh ** 3 * integ.sum(-1)))
    return total


def cube_column(density, half_kpc, p0, p1, samples_per_voxel=4.0) -> float:
    """∫ density dl [density·kpc] along [p0, p1] with linear trilinear sampling, midpoint rule.

    Samples use scipy map_coordinates(order=1); a sample outside the box [−half, half]³ contributes 0 (cval);
    inside the box, positions in the outer half-voxel shell are clamped to the edge voxel centres (the same
    clamp-to-edge rule as the viewer, so a constant field integrates exactly)."""
    from scipy.ndimage import map_coordinates
    rho = np.asarray(density, dtype=np.float64)
    n = rho.shape[0]
    half = float(half_kpc)
    dx = 2.0 * half / n
    p0 = np.asarray(p0, dtype=np.float64)
    p1 = np.asarray(p1, dtype=np.float64)
    L = float(np.linalg.norm(p1 - p0))
    if L == 0.0:
        return 0.0
    ns = max(1, int(math.ceil(L / dx * float(samples_per_voxel))))
    dt = L / ns
    t = (np.arange(ns) + 0.5) * dt
    pts = p0[None, :] + t[:, None] * ((p1 - p0) / L)[None, :]
    inside = np.all(np.abs(pts) <= half, axis=1)
    if not np.any(inside):
        return 0.0
    g = np.clip((pts[inside] + half) / dx - 0.5, 0.0, n - 1.0)
    vals = map_coordinates(rho, g.T, order=1, mode="nearest")
    return float(vals.sum() * dt)
