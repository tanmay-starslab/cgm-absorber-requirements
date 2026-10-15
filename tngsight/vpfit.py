"""Clean-room Voigt-profile fitter for the noiseless TNG50 spectra (phase-2 design §5.1).

Written from the physics below only (no third-party fitter code consulted). Model, in the fixed velocity
frame V = c(λ/λ0 − 1) + v_sys (km/s):

    tau_c(v) = N SIGMA0 f λ0[cm] H(a, u) / (sqrt(pi) b[cm/s]),   u = (v − v_c)/b,   a = Γ λ0[cm] / (4 pi b[cm/s])
    H(a, u)  = Re wofz(u + i a)                                   F(v) = exp(−Σ_c tau_c(v))   (intrinsic, no LSF)

Data are the native-grid npz spectra decimated to 1 km/s pixels (v2: every 4th pixel of the 0.25 km/s grid; v1:
the dλ = 0.002 Å grid as is) with a constant pseudo-noise sigma = 0.01 per pixel; it only sets the stopping rule
and the scale of the (formal) errors. AOD columns integrate the full native τ. Everything is deterministic: no
random numbers are drawn anywhere and the per-ion work cap counts function evaluations (never wall time), so
repeated fits give identical output. Atomic data and bounds come from the ion registry (tngsight.ions).

Damped H I (fix-backend amendment to §5.1): logN of the damped ion (registry "damped": H I Lyα) may reach its
registry logN_max = 22.5 (other ions keep 19). A region whose core is black (F < damped_core_flux) over at least
damped_min_core_kms is seeded with ONE component whose column comes from the Lorentzian wings,
τ(Δv) ≈ k_tau N a0 / (√π Δv²) (independent of b); when that seed's column is ≥ damped_logN − damped_seed_margin
the region is grown from it (and from the ordinary empty start, keeping the better χ²_ν). Components with
logN ≥ damped_logN carry flag DAMPED (64); their logN is constrained by the wings and keeps its formal error.

Shallow and broad absorption (C1, Phase-3 owner decision 3): regions are also seeded by a matched filter, a box of
each width in mf_scales_kms whose mean depth reaches detect_nsigma·σ/√n (find_regions), so absorption that never
reaches 3σ in one pixel gets a region. Inside a region the growth stops only when, besides the per-pixel criteria,
no box of the residual Fm − F reaches detect_nsigma (mf_resid); the next component is then seeded at that box with
b from its width. Damped regions skip the residual box test (their wings fix N). Both rules are deterministic.

Saturated components (flag SAT, not DAMPED): logN and b are degenerate in both directions (a black core is
the same for τ0 = 60 or 2e4), so the fitted logN is neither a measurement nor a lower limit; dlogN and db are
reported as null with flag NOERR. The region's apparent optical depth column (aod_logN, exact on noiseless
data) is the number to use for such regions.
"""
from __future__ import annotations
import math
import numpy as np
from scipy.optimize import least_squares
from scipy.special import wofz

from .config import C_KMS
from .degrade import velocity_axis
from . import ions as I

SIGMA0 = I.SIGMA0              # pi e^2 / (m_e c) [cm^2 s^-1]
SQRT_PI = math.sqrt(math.pi)
LN10 = math.log(10.0)

# Registry values = Trident lines.txt (+ the O VII supplement): the data the spectra were made with.
ATOMIC = {k: I.atomic(k) for k in I.KEYS}

PARAMS = dict(sigma=0.01, detect_nsigma=3.0, edge_nsigma=1.0, pad_kms=15.0, merge_gap_kms=10.0, min_width_kms=3.0,
              chisq_lim=1.0, max_comp_region=8, max_comp_ion=30, logN_bounds=(10.0, 19.0), b_max=150.0,
              b_init=20.0, dchisq_min_frac=0.01, min_logN_keep=10.05, ftol=1e-10, xtol=1e-10, gtol=1e-10,
              max_nfev_per_param=500, sat_tau0=5.0, sat_flux=0.05, fallback_trials=True,
              resid_lim=0.03, logN_hi_ion={"HI": 22.5}, damped_logN=19.0, damped_core_flux=0.01,
              damped_min_core_kms=100.0, damped_seed_margin=0.5, damped_wing_iqr=0.3, damped_b_init=30.0,
              sat_errors=False, fit_dv_kms=1.0, max_nfev_ion=60000,
              mf_scales_kms=(3.0, 7.0, 15.0, 31.0, 63.0, 127.0), mf_extend=True, mf_resid=True,
              maxcomp_mf=False)

# BUDGET (128) is set only by the browser fitter (docs/tng50/js/fit.js), never here.
FLAGS = {"SAT": 1, "BOUND": 2, "MAXCOMP": 4, "POORFIT": 8, "EDGE": 16, "NOERR": 32, "DAMPED": 64, "BUDGET": 128}
AOD_K = 1e5 / (SIGMA0 * 1e-8)  # N [cm^-2] = AOD_K / (f λ0[Å]) ∫τ dv[km/s]
COMP_KEYS = ("v", "dv", "logN", "dlogN", "b", "db", "region", "flag", "EW")
_BOUND_TOL = 1e-3


def fmt_round(x, d):
    """§2 rounding: half away from zero, sign(x)·floor(|x|·10^d + 0.5)/10^d (−0 normalised to 0)."""
    s = 10.0 ** d
    r = math.copysign(math.floor(abs(x) * s + 0.5) / s, x)
    return r + 0.0


def _consts(key):
    a = ATOMIC[key]
    lam_cm = a["lam0"] * 1e-8
    k_tau = SIGMA0 * a["f"] * lam_cm / (SQRT_PI * 1e5)        # tau = k_tau * N * H / b[km/s]
    a0 = a["gamma"] * lam_cm / (4.0 * math.pi * 1e5)          # a = a0 / b[km/s]
    return k_tau, a0


def tau0(logN, b, key):
    """Line-centre optical depth with H(a, 0) ≈ 1."""
    k_tau, _ = _consts(key)
    return k_tau * 10.0 ** logN / b


def logN_from_tau0(t0, b, key):
    k_tau, _ = _consts(key)
    return math.log10(t0 * b / k_tau)


def logN_bounds(key, params=PARAMS):
    """(lo, hi) logN bounds of ion `key`: lo = logN_bounds[0]; hi = the registry logN_max (22.5 for the damped H I,
    19 otherwise), unless params["logN_hi_ion"] names the ion."""
    lo, _ = params["logN_bounds"]
    return float(lo), float((params.get("logN_hi_ion") or {}).get(key, ATOMIC[key]["logN_max"]))


def aod_logN(v, tau, key, lo=None, hi=None):
    """Apparent-optical-depth column log10 N = log10(AOD_K/(f λ0) ∫τ dv) over pixels [lo, hi) (default: all);
    None when ∫τ dv ≤ 0. Exact for the stored (noiseless, unclipped) τ, whatever the saturation."""
    v = np.asarray(v, float)[lo:hi]; t = np.asarray(tau, float)[lo:hi]
    if v.size < 2:
        return None
    a = ATOMIC[key]
    n = AOD_K / (a["f"] * a["lam0"]) * float(np.trapz(t, v))
    return math.log10(n) if n > 0 and math.isfinite(n) else None


def damped_seed(v, flux, key, params=PARAMS):
    """[v_c, logN, b] of one damped component for a region (v, flux), or None. The core is the longest run
    of F < damped_core_flux (must span ≥ damped_min_core_kms); logN is the median over the wing pixels
    (0.05 < F < 0.9, |Δv| beyond the core half-width) of log10(τ √π Δv² / (k_tau a0)), whose interquartile
    range must be ≤ damped_wing_iqr (a Lorentzian wing gives the same N at every Δv)."""
    v = np.asarray(v, float); flux = np.asarray(flux, float)
    if not I.get(key)["damped"]:
        return None
    m = flux < params["damped_core_flux"]
    if not m.any():
        return None
    idx = np.flatnonzero(np.diff(np.concatenate(([0], m.astype(np.int8), [0]))))
    runs = list(zip(idx[0::2], idx[1::2]))
    s, e = max(runs, key=lambda r: (v[r[1] - 1] - v[r[0]], -r[0]))
    width = float(v[e - 1] - v[s])
    if width < params["damped_min_core_kms"]:
        return None
    vc = 0.5 * float(v[s] + v[e - 1])
    dv = np.abs(v - vc)
    w = (flux > 0.05) & (flux < 0.9) & (dv > 0.5 * width + 5.0)
    if w.sum() < 5:
        return None
    k_tau, a0 = _consts(key)
    est = np.log10(-np.log(flux[w]) * SQRT_PI * dv[w] ** 2 / (k_tau * a0))
    q25, lN, q75 = (float(x) for x in np.percentile(est, [25, 50, 75]))
    if q75 - q25 > params["damped_wing_iqr"]:                 # not a Lorentzian (∝ Δv⁻²) wing: a Gaussian edge
        return None
    lo, hi = logN_bounds(key, params)
    if lN < params["damped_logN"] - params["damped_seed_margin"]:
        return None
    return [vc, float(np.clip(lN, lo, hi)), float(params["damped_b_init"])]


def _tau_and_jac(v, p, key, want_jac):
    """tau (m,) of all components and, optionally, dtau/dp (m, 3n) for p = [v_c, logN, b] * n."""
    k_tau, a0 = _consts(key)
    p = np.asarray(p, float).reshape(-1, 3)
    vc, logN, b = p[:, 0:1], p[:, 1:2], p[:, 2:3]
    u = (v[None, :] - vc) / b
    a = a0 / b
    w = wofz(u + 1j * a)
    H = w.real
    A = k_tau * 10.0 ** logN                                  # (n,1)
    tau_c = A * H / b                                         # (n,m)
    tau = tau_c.sum(axis=0)
    if not want_jac:
        return tau, None
    dw = -2.0 * (u + 1j * a) * w + 2j / SQRT_PI               # dw/dz
    Hu, Ha = dw.real, -dw.imag                                # dH/du, dH/da
    jac = np.empty((v.size, p.size))
    jac[:, 0::3] = (-A * Hu / b ** 2).T
    jac[:, 1::3] = (tau_c * LN10).T
    jac[:, 2::3] = (-(A / b ** 2) * (H + u * Hu + a * Ha)).T
    return tau, jac


def tau_components(v, comps, key) -> np.ndarray:
    """Optical depth on velocity grid `v` of components `comps` ((n,3) array of [v_c, logN, b])."""
    v = np.asarray(v, float)
    comps = np.asarray(comps, float).reshape(-1, 3)
    if comps.size == 0:
        return np.zeros_like(v)
    return _tau_and_jac(v, comps, key, False)[0]


def _runs(m):
    """[(s, e)] half-open runs of True in boolean array m."""
    idx = np.flatnonzero(np.diff(np.concatenate(([0], np.asarray(m).astype(np.int8), [0]))))
    return list(zip(idx[0::2].tolist(), idx[1::2].tolist()))


def mf_scales(v, params=PARAMS) -> list:
    """Box widths (odd pixel counts > 1) of the matched-filter detection on the uniform grid v: mf_scales_kms / du."""
    if v.size < 3:
        return []
    du = abs(float(v[1] - v[0]))
    out = []
    for w in params.get("mf_scales_kms") or ():
        n = int(round(float(w) / du)) | 1
        if 1 < n <= v.size and n not in out:
            out.append(n)
    return out


def box_significance(x, n, sig):
    """Matched-filter (box of n pixels, centred) significance Σ_window x / (sig √n_window) at every pixel; windows
    are clipped at the array ends (n_window = the pixels actually summed)."""
    x = np.asarray(x, float)
    c = np.concatenate(([0.0], np.cumsum(x)))
    j = np.arange(x.size)
    lo = np.clip(j - n // 2, 0, x.size); hi = np.clip(j + n // 2 + 1, 0, x.size)
    return (c[hi] - c[lo]) / (sig * np.sqrt(hi - lo))


def mf_significance(v, flux, params=PARAMS) -> float:
    """Largest matched-filter detection significance of the absorption D = 1 − F over the scales of find_regions
    (per pixel, D/σ, and every box of mf_scales_kms); 0 for an empty spectrum."""
    D = 1.0 - np.asarray(flux, float); sig = params["sigma"]
    s = float(D.max() / sig) if D.size else 0.0
    for n in mf_scales(np.asarray(v, float), params):
        s = max(s, float(box_significance(D, n, sig).max()))
    return max(s, 0.0)


def find_regions(v, flux, params=PARAMS) -> list:
    """Absorption regions as sorted [lo, hi) pixel ranges (design §5.1 step 1; C1: matched-filter seeding).

    Per pixel (as before): a run of D > edge_nsigma σ that contains a pixel with D > detect_nsigma σ and spans at
    least min_width_kms. Matched filter (Phase-3 owner decision 3): for each box width n of mf_scales_kms, the
    noise of the box mean is σ/√n, so a run of D > edge_nsigma σ/√n that holds a pixel whose centred box
    significance (box_significance) reaches detect_nsigma is a region too — shallow broad absorption that never
    reaches 3σ in one pixel. Runs are then padded by pad_kms and merged across gaps < merge_gap_kms."""
    v = np.asarray(v, float); D = 1.0 - np.asarray(flux, float)
    sig = params["sigma"]
    runs = []
    seed = D > params["detect_nsigma"] * sig
    for s, e in _runs(D > params["edge_nsigma"] * sig):
        if seed[s:e].any() and v[e - 1] - v[s] >= params["min_width_kms"]:
            runs.append((s, e))
    fine = list(runs)
    for n in mf_scales(v, params):
        S = box_significance(D, n, sig)
        seed_n = S >= params["detect_nsigma"]
        if not seed_n.any():
            continue
        for s, e in _runs(D > params["edge_nsigma"] * sig / math.sqrt(n)):
            if not (seed_n[s:e].any() and v[e - 1] - v[s] >= params["min_width_kms"]):
                continue
            if not params.get("mf_extend", True) and any(s < fe and fs < e for fs, fe in fine):
                continue                                      # mf_extend False: matched filter adds new regions only
            runs.append((s, e))
    if not runs:
        return []
    padded = []
    for s, e in sorted(set(runs)):
        lo = int(np.searchsorted(v, v[s] - params["pad_kms"], side="left"))
        hi = int(np.searchsorted(v, v[e - 1] + params["pad_kms"], side="right"))
        padded.append([max(lo, 0), min(hi, v.size)])
    merged = []
    for lo, hi in padded:                                     # sorted by start
        if merged and (lo < merged[-1][1] or v[lo] - v[merged[-1][1] - 1] < params["merge_gap_kms"]):
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return [(lo, hi) for lo, hi in merged]


def _chi2nu(res, ncomp):
    return float(np.dot(res, res)) / max(1, res.size - 3 * ncomp)


def fit_region(v, flux, lo, hi, key, params=PARAMS, edge=False, max_comp=None, nfev_cap=None) -> dict:
    """Iteratively add Voigt components to one region [lo, hi) (design §5.1 step 2). `nfev_cap`: no component is
    added once this many least_squares evaluations were spent in the region (the per-ion cap; MAXCOMP is set).
    Returns {"comps": [{"v","logN","b","dv","dlogN","db","flag"}], "chi2nu", "nfev"} (unrounded)."""
    v = np.asarray(v, float); flux = np.asarray(flux, float)
    vr, Fr = v[lo:hi], flux[lo:hi]
    sig = params["sigma"]
    b_min, b_max = ATOMIC[key]["b_min"], params["b_max"]
    nlo, nhi = logN_bounds(key, params)
    v_lo, v_hi = float(vr[0]), float(vr[-1])
    cap = params["max_comp_region"] if max_comp is None else min(params["max_comp_region"], int(max_comp))
    nfev = 0

    def over_cap():
        return nfev_cap is not None and nfev >= nfev_cap

    def resid(p):
        return (Fr - np.exp(-_tau_and_jac(vr, p, key, False)[0])) / sig

    def jac(p):
        tau, dt = _tau_and_jac(vr, p, key, True)
        return (np.exp(-tau) / sig)[:, None] * dt

    def solve(p0):
        nonlocal nfev
        n = len(p0) // 3
        lb = np.tile([v_lo, nlo, b_min], n); ub = np.tile([v_hi, nhi, b_max], n)
        x0 = np.clip(np.asarray(p0, float), lb, ub)
        r = least_squares(resid, x0, jac=jac, bounds=(lb, ub), method="trf", x_scale="jac",
                          ftol=params["ftol"], xtol=params["xtol"], gtol=params["gtol"],
                          max_nfev=params["max_nfev_per_param"] * 3 * n)
        nfev += int(r.nfev)
        return r

    res = (Fr - 1.0) / sig
    chi0 = _chi2nu(res, 0)
    if cap <= 0:
        return {"comps": [], "chi2nu": chi0, "nfev": 0}
    b0 = float(np.clip(params["b_init"], b_min, b_max))

    scales = mf_scales(vr, params) if params.get("mf_resid", False) else []
    du = abs(float(vr[1] - vr[0])) if vr.size > 1 else 1.0

    def px_ok(fun, c):
        return c < params["chisq_lim"] and (params.get("resid_lim") is None
                                            or sig * float(np.abs(fun).max()) <= params["resid_lim"])

    def mf_hit(fun):
        """(significance, pixel, box width) of the most significant unmodelled absorption in the residual
        Fm − F (matched filter, mf_scales_kms), or None when no box reaches detect_nsigma (C1, owner decision 3)."""
        a = -np.asarray(fun, float) * sig                    # Fm − F: positive where absorption is unmodelled
        best = None
        for n in scales:
            S = box_significance(a, n, sig)
            j = int(np.argmax(S))
            if S[j] >= params["detect_nsigma"] and (best is None or S[j] > best[0]):
                best = (float(S[j]), j, n)
        return best

    def converged(r, c):
        return px_ok(r.fun, c) and (not scales or mf_hit(r.fun) is None)

    def capped_ok(r, c):
        """At the component cap: MAXCOMP is set unless the fit is complete. With maxcomp_mf False (default) a fit that
        meets the per-pixel criteria and only leaves a matched-filter residual is not flagged (its pixels are fitted;
        the open residual is diffuse column below 3σ per pixel)."""
        return converged(r, c) or (not params.get("maxcomp_mf", False) and px_ok(r.fun, c))

    def new_comp(j, Fm):
        tpk = max(0.05, -math.log(float(np.clip(Fr[j] / Fm[j] if Fm[j] > 0 else 1.0, 1e-4, 1.0))))
        return [float(vr[j]), float(np.clip(logN_from_tau0(tpk, b0, key), nlo, nhi)), b0]

    def next_comp(rr, chi, Fm):
        """Seed of the next component: at the deepest residual pixel (§5.1 2a) unless the pixel criteria are already
        met, then at the matched-filter residual peak with b from the box width (FWHM ≈ n du) and τ0 from the
        box-mean residual depth."""
        fun = rr / sig
        hit = mf_hit(fun) if scales and px_ok(fun, chi) else None
        if hit is None:
            j = int(np.argmin(rr))
            return j, new_comp(j, Fm)
        _, j, n = hit
        lo_, hi_ = max(0, j - n // 2), min(rr.size, j + n // 2 + 1)
        depth = float(np.clip(-rr[lo_:hi_].mean(), 1e-6, 0.5))
        bb = float(np.clip(n * du / 1.665, b_min, b_max))
        lN = logN_from_tau0(max(-math.log1p(-depth), 1e-6), bb, key)
        return j, [float(vr[j]), float(np.clip(lN, nlo, nhi)), bb]

    def grow(p, chi, best):
        """§5.1 step 2 from the solution p (χ²_ν chi, least_squares result best; empty start: p = [])."""
        hit_cap = False
        if best is not None and (converged(best, chi) or p.size // 3 >= cap):
            return p, chi, best, p.size // 3 >= cap and not capped_ok(best, chi)
        while True:
            if over_cap():
                hit_cap = True
                break
            Fm = np.exp(-_tau_and_jac(vr, p, key, False)[0]) if p.size else np.ones_like(Fr)
            rr = Fr - Fm
            j, c_new = next_comp(rr, chi, Fm)
            target = chi * (1.0 - params["dchisq_min_frac"])
            r = solve(np.concatenate([p, c_new]))
            chi_new = _chi2nu(r.fun, p.size // 3 + 1)
            if not chi_new <= target and p.size and params.get("fallback_trials", False):
                # The design move (§5.1 2a) stalled — typically a saturated trough where the Jacobian vanishes.
                # Deterministic fallback trials (PARAMS["fallback_trials"]; the lowest χ²_ν wins and must still pass
                # the 2c test): new component at up to 3 next-deepest residual minima (≥ b_init apart); n+1
                # components re-seeded evenly over the absorbed span; split of the component dominating τ at an
                # over-predicted pixel into two on either side of it; split of each component into two at v ± b/2
                # (logN − 0.3, b/2).
                trials, used_v = [], [float(vr[j])]
                for jj in np.argsort(rr, kind="stable")[: max(1, rr.size)]:
                    if len(trials) >= 3 or rr[jj] > -params["detect_nsigma"] * sig:
                        break
                    if all(abs(float(vr[jj]) - u) >= params["b_init"] for u in used_v):
                        used_v.append(float(vr[jj])); trials.append(np.concatenate([p, new_comp(int(jj), Fm)]))
                P0 = p.reshape(-1, 3)
                # re-seed: n+1 components evenly spaced over the absorbed span (escapes saturated local minima)
                ab = np.flatnonzero(1.0 - Fr > params["detect_nsigma"] * sig)
                if ab.size >= 2:
                    n1 = P0.shape[0] + 1
                    a_, b_ = float(vr[ab[0]]), float(vr[ab[-1]])
                    bb = float(np.clip((b_ - a_) / n1 / 2.0, b_min, b_max))
                    seed = []
                    for c in a_ + (np.arange(n1) + 0.5) * (b_ - a_) / n1:
                        jj = int(np.argmin(np.abs(vr - c)))
                        tp = max(0.05, -math.log(float(np.clip(Fr[jj], 1e-4, 1.0))))
                        seed.append([float(c), float(np.clip(logN_from_tau0(tp, bb, key), nlo, nhi)), bb])
                    trials.append(np.ravel(seed))
                jp = int(np.argmax(rr))
                if rr[jp] > params["detect_nsigma"] * sig:
                    # over-predicted absorption (a transmission spike inside a model trough): split the component
                    # with the largest tau there into two on either side of the spike
                    tc = [tau_components(vr[jp:jp + 1], [c], key)[0] for c in P0]
                    i = int(np.argmax(tc)); vc, lN, b = P0[i]; bb = max(b / 2.0, b_min); vs = float(vr[jp])
                    pair = [[vs - b, lN - 0.3, bb], [vs + b, lN - 0.3, bb]]
                    trials.append(np.concatenate([np.delete(P0, i, axis=0).ravel(), np.ravel(pair)]))
                for i in np.argsort(-P0[:, 1], kind="stable"):
                    vc, lN, b = P0[i]
                    bb = max(b / 2.0, b_min)
                    pair = [[vc - b / 2.0, lN - 0.3, bb], [vc + b / 2.0, lN - 0.3, bb]]
                    trials.append(np.concatenate([np.delete(P0, i, axis=0).ravel(), np.ravel(pair)]))
                for x0 in trials:
                    if over_cap():
                        break
                    rt = solve(x0)
                    ct = _chi2nu(rt.fun, p.size // 3 + 1)
                    if ct < chi_new:
                        r, chi_new = rt, ct
            if not (chi_new <= target):
                break                                             # revert: keep previous solution
            p, chi, best = r.x.copy(), chi_new, r
            n = p.size // 3
            if converged(r, chi):
                break
            if n >= cap:
                hit_cap = not capped_ok(r, chi)
                break
        return p, chi, best, hit_cap

    p, chi, best, hit_cap = np.zeros(0), chi0, None, False
    seed = damped_seed(vr, Fr, key, params)
    if seed is not None:                                      # damped H I: grow from one wing-seeded component
        scales = []                                           # (no matched-filter residual test: wings fix N)
        rs = solve(np.asarray(seed, float))
        cs = _chi2nu(rs.fun, 1)
        if cs < chi0 and rs.x[1] >= params["damped_logN"] - params["damped_seed_margin"]:
            p, chi, best, hit_cap = grow(rs.x.copy(), cs, rs)
    if best is None or not converged(best, chi):              # ordinary empty start; must be strictly better
        pn, cn, bn, hn = grow(np.zeros(0), chi0, None)
        if bn is not None and (best is None or cn < chi):
            p, chi, best, hit_cap = pn, cn, bn, hn

    if best is None:
        return {"comps": [], "chi2nu": chi, "nfev": nfev}
    keep = p.reshape(-1, 3)[:, 1] >= params["min_logN_keep"]
    if not keep.all():
        p = p.reshape(-1, 3)[keep].ravel()
        if p.size == 0:
            return {"comps": [], "chi2nu": _chi2nu(res, 0), "nfev": nfev}
        best = solve(p); p = best.x.copy(); chi = _chi2nu(best.fun, p.size // 3)

    P = p.reshape(-1, 3)
    poor = chi >= params["chisq_lim"] or (params.get("resid_lim") is not None
                                          and sig * float(np.abs(best.fun).max()) > params["resid_lim"])
    err = None
    J = best.jac
    if J is not None and np.all(np.isfinite(J)):
        try:
            cov = np.linalg.pinv(J.T @ J)
            d = np.diag(cov)
            if np.all(np.isfinite(d)) and np.all(d >= 0) and np.linalg.matrix_rank(J) == J.shape[1]:
                err = np.sqrt(d).reshape(-1, 3)
        except np.linalg.LinAlgError:
            err = None
    comps = []
    damped_ion = bool(I.get(key)["damped"])
    for i, (vc, lN, b) in enumerate(P):
        flag = 0
        if damped_ion and lN >= params["damped_logN"]:
            flag |= FLAGS["DAMPED"]
        sel = (vr >= vc - b) & (vr <= vc + b)
        if (tau_components(np.array([vc]), [[vc, lN, b]], key)[0] >= params["sat_tau0"]
                or (sel.any() and float(Fr[sel].min()) < params["sat_flux"])):
            flag |= FLAGS["SAT"]
        if (min(vc - v_lo, v_hi - vc) < _BOUND_TOL or min(lN - nlo, nhi - lN) < _BOUND_TOL
                or min(b - b_min, b_max - b) < _BOUND_TOL):
            flag |= FLAGS["BOUND"]
        if hit_cap:
            flag |= FLAGS["MAXCOMP"]
        if poor:
            flag |= FLAGS["POORFIT"]
        if edge:
            flag |= FLAGS["EDGE"]
        # SAT (not DAMPED): logN–b degenerate both ways; the formal errors would hide it (see module doc)
        sat_noerr = flag & FLAGS["SAT"] and not flag & FLAGS["DAMPED"] and not params.get("sat_errors", False)
        if err is None or sat_noerr:
            flag |= FLAGS["NOERR"]
        comps.append({"v": float(vc), "logN": float(lN), "b": float(b),
                      "dv": None if err is None else float(err[i, 0]),
                      "dlogN": None if err is None or sat_noerr else float(err[i, 1]),
                      "db": None if err is None or sat_noerr else float(err[i, 2]), "flag": flag})
    return {"comps": comps, "chi2nu": chi, "nfev": nfev}


def equivalent_width_mA(v, comp, key):
    """Rest-frame EW [mÅ] of one component alone over the full grid: (λ0/c)∫(1 − e^{−τ}) dv."""
    t = tau_components(v, [[comp["v"], comp["logN"], comp["b"]]], key)
    return ATOMIC[key]["lam0"] / C_KMS * float(np.trapz(-np.expm1(-t), v)) * 1e3


def fit_flux(v, flux, key, params=PARAMS, info=None) -> list:
    """Fit a native-grid flux array on velocity axis `v`; returns the final rounded component list."""
    v = np.asarray(v, float); flux = np.asarray(flux, float)
    regions = find_regions(v, flux, params)
    # Spend the per-ion budget on the strongest regions first (deterministic order; ids stay by velocity).
    strength = [float(np.trapz(1.0 - flux[lo:hi], v[lo:hi])) if hi - lo > 1 else 0.0 for lo, hi in regions]
    order = sorted(range(len(regions)), key=lambda i: (-strength[i], i))
    used, out, stats, nfev_used = 0, [], [], 0
    nfev_ion = params.get("max_nfev_ion")
    for rid in order:
        lo, hi = regions[rid]
        left = params["max_comp_ion"] - used
        nfev_left = None if nfev_ion is None else nfev_ion - nfev_used
        if nfev_left is not None and nfev_left <= 0:
            left = 0                                          # per-ion evaluation cap spent: no further components
        res = fit_region(v, flux, lo, hi, key, params, edge=(lo == 0 or hi == v.size), max_comp=left,
                         nfev_cap=nfev_left)
        if left < params["max_comp_region"] and len(res["comps"]) >= left:
            for c in res["comps"]:
                c["flag"] |= FLAGS["MAXCOMP"]
        used += len(res["comps"])
        nfev_used += res["nfev"]
        stats.append({"region": rid, "lo": lo, "hi": hi, "chi2nu": res["chi2nu"], "nfev": res["nfev"],
                      "n": len(res["comps"]), "skipped": left <= 0})
        for c in res["comps"]:
            c["region"] = rid
            out.append(c)
    if nfev_ion is not None and nfev_used >= nfev_ion:          # the cap stopped this ion: its fit is incomplete
        for c in out:
            c["flag"] |= FLAGS["MAXCOMP"]
    final = []
    for c in out:
        r = lambda x, d: None if x is None else fmt_round(x, d)
        final.append({"v": r(c["v"], 2), "dv": r(c["dv"], 2), "logN": r(c["logN"], 3), "dlogN": r(c["dlogN"], 3),
                      "b": r(c["b"], 2), "db": r(c["db"], 2), "region": int(c["region"]), "flag": int(c["flag"]),
                      "EW": r(equivalent_width_mA(v, c, key), 2)})
    final.sort(key=lambda c: (c["v"], -c["logN"]))
    if info is not None:
        info["regions"] = sorted(stats, key=lambda s: s["region"])
    return final


def fit_stride(du, params=PARAMS) -> int:
    """Decimation of a native grid of step du (km/s) to the fit pixels: 1 for v1 grids (du > 0.5 km/s), else
    round(fit_dv_kms/du) (4 for the v2 0.25 km/s grid)."""
    du = float(du)
    if du > 0.5:
        return 1
    return max(1, int(round(float(params.get("fit_dv_kms", 1.0)) / du)))


def fit_line(lam, tau, rest, v_sys, key, params=PARAMS, info=None) -> list:
    """Components of one line from the npz arrays (λ, τ float32) in the fixed frame. The fit runs on every
    fit_stride(du)-th pixel; AOD columns (info) integrate the full native τ, with region pixel bounds mapped back."""
    v = velocity_axis(lam, rest, v_sys)
    tau = np.asarray(tau)
    du = abs(float(v[1] - v[0])) if v.size > 1 else 1.0
    st = fit_stride(du, params)
    vs = v[::st]
    flux = np.exp(-np.asarray(tau[::st], np.float64))
    out = fit_flux(vs, flux, key, params, info)
    if info is not None:                                      # exact AOD columns from the full stored τ
        info["stride"] = st
        info["logN_aod"] = aod_logN(v, tau, key)
        for r in info["regions"]:
            nlo, nhi = r["lo"] * st, (r["hi"] - 1) * st + 1
            r["v_lo"], r["v_hi"] = float(v[nlo]), float(v[nhi - 1])
            r["logN_aod"] = aod_logN(v, tau, key, nlo, nhi)
    return out
