"""Tests for the clean-room Voigt fitter (tngsight.vpfit) and the components catalogue v2 (tngsight.components),
phase-2 design §5.6 and Phase-3 design §2.6/§3.5. Synthetic spectra live on the real v2 native grids
(library.native_grid: 0.25 km/s, fitted at stride 4 = 1 km/s) with float32 τ like the npz files. Real-data tests
read the work-volume library (TNG_LIBRARY_DIR; v1 npz are fitted at stride 1) and skip when it is absent."""
import json
import math
import statistics
import time
from pathlib import Path

import numpy as np
import pytest

from tngsight import components as C, config, ions as I, library as L, vpfit as V
from tngsight.degrade import velocity_axis

ROOT = Path(__file__).resolve().parent.parent
LIB = config.library_dir()
COMMITTED = ROOT / "docs" / "tng50" / "data" / "components.json"
STATIC_CATALOG = ROOT / "docs" / "tng50" / "data" / "catalog.json"
REAL_IDS = ["rand_b031_a334_s175141482", "face_b050_a090", "edge_b100_a090", "edge_b050_a000", "face_b150_a330"]
need_lib = pytest.mark.skipif(not (LIB / "sightlines").is_dir(), reason=f"library not at {LIB}")


def synth(key, comps, v_sys=0.0, W=None):
    """(λ f8, τ f4, rest) on the native v2 grid of `key` (half-window W; damped H I: from the largest column)."""
    if W is None:
        W = I.gen_window(key, max([c[1] for c in comps] or [0.0]))
    lam0, dlam, n = L.native_grid(key, W)
    rest = I.get(key)["lam0_A"]
    lam = lam0 + np.arange(n) * dlam
    v = velocity_axis(lam, rest, v_sys)
    tau = V.tau_components(v, comps, key).astype(np.float32)
    return lam, tau, rest


def payload_of(lines: dict, v_sys=0.0):
    """A v2 payload (load_npz layout) from {key: comps}."""
    p = {"geom": {"v_sys_kms": v_sys}, "lines": [k for k in I.KEYS if k in lines], "v_sys": v_sys, "logN": {},
         "lam": {}, "tau": {}, "rest": {}, "u": {}, "W": {}}
    for k, cs in lines.items():
        lam, tau, rest = synth(k, cs, v_sys)
        p["lam"][k], p["tau"][k], p["rest"][k] = lam, tau, rest
        p["u"][k] = 299792.458 * (lam / rest - 1); p["W"][k] = I.gen_window(k, max([c[1] for c in cs] or [0.0]))
        p["logN"][k] = math.log10(sum(10 ** c[1] for c in cs)) if cs else -math.inf
    return p


def fit(key, comps, v_sys=0.0, info=None):
    lam, tau, rest = synth(key, comps, v_sys)
    return V.fit_line(lam, tau, rest, v_sys, key, info=info)


def logsum(cs):
    return math.log10(sum(10.0 ** c["logN"] for c in cs))


# ------------------------------------------------------------------------------- model
def test_tau0_check_value():
    assert V.tau0(14.0, 20.0, "OVI") == pytest.approx(1.03, abs=0.005)
    v = np.array([0.0])
    a0 = V._consts("OVI")[1] / 20.0
    from scipy.special import wofz
    assert V.tau_components(v, [[0.0, 14.0, 20.0]], "OVI")[0] == pytest.approx(
        V.tau0(14.0, 20.0, "OVI") * wofz(1j * a0).real, rel=1e-12)


def test_atomic_matches_registry():
    assert list(V.ATOMIC) == list(I.KEYS)
    for k in I.KEYS:
        assert V.ATOMIC[k] == I.atomic(k)
        assert V._consts(k) == pytest.approx((I.k_tau(k), I.a0(k)), rel=1e-14)
    for k in ("OVI", "CIII"):                                   # the v1 values are unchanged
        assert V.ATOMIC[k]["lam0"] == config.GALAXY["lines"][k]["rest_A"]
        assert V.ATOMIC[k]["f"] == pytest.approx(config.GALAXY["lines"][k]["f"], rel=1e-12)


def test_fit_stride():
    assert V.fit_stride(0.25) == 4 and V.fit_stride(0.5) == 2 and V.fit_stride(0.58) == 1 and V.fit_stride(1.0) == 1
    info = {}
    lam, tau, rest = synth("OVI", [[30.0, 13.5, 25.0]])
    r = V.fit_line(lam, tau, rest, 0.0, "OVI", info=info)
    assert info["stride"] == 4 and len(r) == 1
    v = velocity_axis(lam, rest, 0.0)
    reg = info["regions"][0]
    assert reg["v_lo"] in v and reg["v_hi"] in v and reg["v_lo"] < 30 < reg["v_hi"]
    # AOD integrates the full native τ, over the region mapped back to native pixels
    nlo = int(np.argmin(np.abs(v - reg["v_lo"]))); nhi = int(np.argmin(np.abs(v - reg["v_hi"]))) + 1
    assert reg["logN_aod"] == V.aod_logN(v, tau, "OVI", nlo, nhi)
    assert info["logN_aod"] == V.aod_logN(v, tau, "OVI") and abs(info["logN_aod"] - 13.5) < 0.002


@pytest.mark.parametrize("key", I.KEYS)
def test_analytic_jacobian(key):
    v = np.linspace(-150, 150, 401); p = np.array([10.0, 13.5, 15.0, -25.0, 14.2, 31.0])
    _, J = V._tau_and_jac(v, p, key, True)
    Jn = np.empty_like(J)
    for i in range(p.size):
        h = 1e-6 * max(1.0, abs(p[i])); hi, lo = p.copy(), p.copy(); hi[i] += h; lo[i] -= h
        Jn[:, i] = (V._tau_and_jac(v, hi, key, False)[0] - V._tau_and_jac(v, lo, key, False)[0]) / (2 * h)
    assert np.abs(J - Jn).max() <= 1e-7 * np.abs(J).max()


def test_fmt_round_half_away():
    assert V.fmt_round(2.5, 0) == 3.0 and V.fmt_round(-2.5, 0) == -3.0
    assert V.fmt_round(0.125, 2) == 0.13 and V.fmt_round(-0.001, 2) == 0.0
    assert math.copysign(1, V.fmt_round(-0.001, 2)) == 1.0


# ------------------------------------------------------------------------------- synthetic recovery
def test_single_ovi():
    r = fit("OVI", [[30.0, 13.5, 25.0]])
    assert len(r) == 1
    c = r[0]
    assert abs(c["v"] - 30) < 0.5 and abs(c["logN"] - 13.5) < 0.02 and abs(c["b"] - 25) / 25 < 0.03
    assert c["flag"] == 0 and c["region"] == 0
    assert all(c[k] is not None and c[k] >= 0 for k in ("dv", "dlogN", "db"))
    # EW of a single unsaturated component vs the optically thin limit W = (π e²/m_e c²) f λ0² N
    assert c["EW"] > 0


def test_two_separated():
    r = fit("OVI", [[-30.0, 13.8, 15.0], [30.0, 13.2, 30.0]])
    assert len(r) == 2
    for c, (v, lN, b) in zip(r, [(-30, 13.8, 15), (30, 13.2, 30)]):
        assert abs(c["v"] - v) < 2 and abs(c["logN"] - lN) < 0.05 and abs(c["b"] - b) < 2


@pytest.mark.parametrize("dv", [30.0, 45.0, 60.0, 80.0])
def test_blended_pairs_30_80(dv):
    truth = [[-dv / 2, 13.6, 18.0], [dv / 2, 13.3, 25.0]]
    r = fit("OVI", truth)
    assert len(r) == 2
    for c, (v, lN, b) in zip(r, truth):
        assert abs(c["v"] - v) < 2 and abs(c["logN"] - lN) < 0.05 and abs(c["b"] - b) < 2


def test_blended_close():
    truth = [[0.0, 13.5, 10.0], [20.0, 13.3, 10.0]]
    r = fit("OVI", truth)
    assert len(r) == 2
    assert abs(logsum(r) - math.log10(10 ** 13.5 + 10 ** 13.3)) < 0.03


def test_hi_single_and_bmin():
    r = fit("HI", [[-40.0, 13.6, 30.0]])
    assert len(r) == 1 and abs(r[0]["logN"] - 13.6) < 0.05
    narrow = fit("HI", [[10.0, 13.0, 9.0], [80.0, 12.8, 12.0]])
    for c in r + narrow:
        assert c["b"] >= 8.0


@pytest.mark.parametrize("key", I.KEYS)
def test_single_component_every_ion(key):
    """One unsaturated component (peak τ ≈ 0.5, b well above b_min) is recovered for each of the 12 lines."""
    b = 60.0 if key == "OVII" else 20.0
    lN = V.logN_from_tau0(0.5, b, key)
    r = fit(key, [[25.0, lN, b]])
    assert len(r) == 1, (key, r)
    c = r[0]
    assert abs(c["v"] - 25) < 0.5 and abs(c["logN"] - lN) < 0.02 and abs(c["b"] - b) / b < 0.03, (key, c)
    assert c["flag"] == 0 and c["b"] >= I.atomic(key)["b_min"]


def test_saturated_ciii():
    r = fit("CIII", [[0.0, 15.5, 10.0]])
    assert r and all(c["flag"] & V.FLAGS["SAT"] for c in r if abs(c["v"]) < 10)
    assert logsum(r) >= 14.5
    # SAT logN is unconstrained both ways (not a lower limit): no formal dlogN/db, flag NOERR
    for c in r:
        if c["flag"] & V.FLAGS["SAT"]:
            assert c["dlogN"] is None and c["db"] is None and c["flag"] & V.FLAGS["NOERR"] and c["dv"] is not None


def test_saturated_region_aod_is_exact():
    """The AOD column of the stored τ recovers a saturated column that the fit cannot."""
    aod = {}
    inj = {"OVI": [[0.0, 13.6, 25.0]], "HI": [[-20.0, 17.2, 25.0]], "CIII": [[0.0, 15.5, 10.0]],
           "OVII": [[40.0, 16.4, 60.0]]}
    p = payload_of(inj)
    C.fit_payload(p, aod=aod)
    assert C.validate_aod(aod) == aod and list(aod) == p["lines"]
    for k, cs in inj.items():
        tot, regs = aod[k]
        assert abs(tot - cs[0][1]) < 0.01, (k, aod[k])
        assert len(regs) == 1 and abs(regs[0][3] - cs[0][1]) < 0.01
        assert regs[0][1] < cs[0][0] < regs[0][2] and regs[0][0] == 0


@pytest.mark.parametrize("logN,v0", [(20.5, 0.0), (21.3, 120.0)])
def test_damped_hi_single(logN, v0):
    """A damped Lyα line (on its widened window, design §2.1) comes back as ONE component (wing-seeded), within
    0.1 dex, flagged DAMPED with a formal error (the wings constrain N)."""
    lam, tau, rest = synth("HI", [[v0, logN, 30.0]])
    assert abs(velocity_axis(lam, rest, 0.0)[0]) == pytest.approx(I.hi_window(logN), abs=0.3)
    r = V.fit_line(lam, tau, rest, 0.0, "HI")
    assert len(r) == 1, r
    c = r[0]
    assert abs(c["logN"] - logN) < 0.1 and abs(c["v"] - v0) < 2.0
    assert c["flag"] & V.FLAGS["DAMPED"] and c["flag"] & V.FLAGS["SAT"]
    assert c["dlogN"] is not None and not c["flag"] & V.FLAGS["NOERR"]
    assert C.validate_components({"OVI": [], "HI": r, "CIII": []})["HI"] == r


def test_damped_seed_ignores_ordinary_lines():
    lam, tau, rest = synth("HI", [[0.0, 17.0, 30.0]])
    v = velocity_axis(lam, rest, 0.0)
    assert V.damped_seed(v, np.exp(-tau.astype(float)), "HI") is None
    lam, tau, rest = synth("OVI", [[0.0, 18.5, 40.0]])
    assert V.damped_seed(velocity_axis(lam, rest, 0.0), np.exp(-tau.astype(float)), "OVI") is None
    assert V.logN_bounds("OVI") == (10.0, 19.0) and V.logN_bounds("HI") == (10.0, 22.5)
    assert V.logN_bounds("OVII") == (10.0, 19.0)


def test_empty_and_weak():
    lam, _, rest = synth("OVI", [])
    assert V.fit_line(lam, np.zeros(lam.size, np.float32), rest, 0.0, "OVI") == []
    # peak depth 0.002 (0.2 sigma per pixel; matched-filter significance < 3): nothing is fitted
    lN = V.logN_from_tau0(-math.log(0.998), 20.0, "OVI")
    lam, tau, rest = synth("OVI", [[0.0, lN, 20.0]])
    v = velocity_axis(lam, rest, 0.0)[::4]
    assert V.mf_significance(v, np.exp(-tau[::4].astype(float))) < 3.0
    assert fit("OVI", [[0.0, lN, 20.0]]) == []


def test_shallow_below_pixel_threshold_is_found():
    """Owner decision 3 (C1): peak depth 0.02 (2 sigma per pixel, never a per-pixel 3 sigma seed) but matched-filter
    significance ~9: one component, logN within 0.05 dex. Without the matched filter (mf_scales_kms = ()) the old
    per-pixel rule finds nothing."""
    lN = V.logN_from_tau0(-math.log(0.98), 20.0, "OVI")
    r = fit("OVI", [[0.0, lN, 20.0]])
    assert len(r) == 1 and abs(r[0]["logN"] - lN) < 0.05 and abs(r[0]["v"]) < 2
    lam, tau, rest = synth("OVI", [[0.0, lN, 20.0]])
    old = dict(V.PARAMS, mf_scales_kms=(), mf_resid=False)
    assert V.fit_line(lam, tau, rest, 0.0, "OVI", params=old) == []


@pytest.mark.parametrize("key,b", [("OVI", 60.0), ("NV", 45.0), ("NeVIII", 70.0)])
def test_broad_shallow_component(key, b):
    """Broad absorption with peak depth ~0.6 % (D < 1 sigma in every pixel) at logN 11.9-12.3: detected by the matched
    filter and fitted as one component with the right column (D4: shallow broad lines that had no component)."""
    lN = V.logN_from_tau0(0.006, b, key)
    assert 11.8 < lN < 13.3
    info = {}
    r = fit(key, [[-40.0, lN, b]], info=info)
    assert len(info["regions"]) == 1 and len(r) == 1, (r, info["regions"])
    assert abs(r[0]["logN"] - lN) < 0.05 and abs(r[0]["b"] - b) / b < 0.2


def test_shallow_wing_under_strong_core():
    """A strong narrow component on a broad shallow one: the matched-filter residual test adds the broad one, so the
    summed column is recovered (the per-pixel criteria alone stop after the narrow core)."""
    truth = [[0.0, 13.6, 12.0], [10.0, 12.8, 100.0]]
    tot = math.log10(10 ** 13.6 + 10 ** 12.8)
    r = fit("OVI", truth)
    assert abs(logsum(r) - tot) < 0.01, r
    lam, tau, rest = synth("OVI", truth)
    old = V.fit_line(lam, tau, rest, 0.0, "OVI", params=dict(V.PARAMS, mf_resid=False))
    assert logsum(old) < tot - 0.03 and len(old) < len(r)


def test_maxcomp_only_for_pixel_incompleteness():
    """At the region cap, a fit that meets the per-pixel criteria and leaves only a matched-filter residual is not
    flagged MAXCOMP (default maxcomp_mf False); with maxcomp_mf True it is."""
    lam, tau, rest = synth("OVI", [[0.0, 13.6, 12.0], [10.0, 12.8, 100.0]])
    P = dict(V.PARAMS, max_comp_region=1)
    r = V.fit_line(lam, tau, rest, 0.0, "OVI", params=P)
    assert len(r) == 1 and not r[0]["flag"] & V.FLAGS["MAXCOMP"]
    r = V.fit_line(lam, tau, rest, 0.0, "OVI", params=dict(P, maxcomp_mf=True))
    assert len(r) == 1 and r[0]["flag"] & V.FLAGS["MAXCOMP"]
    lam, tau, rest = synth("OVI", [[-30.0, 13.8, 15.0], [30.0, 13.6, 15.0]])   # per-pixel incomplete at the cap
    r = V.fit_line(lam, tau, rest, 0.0, "OVI", params=dict(P, merge_gap_kms=200.0, pad_kms=60.0))
    assert len(r) == 1 and r[0]["flag"] & V.FLAGS["MAXCOMP"]


def test_box_significance():
    x = np.zeros(101); x[40:61] = 0.01                         # 21 px of depth 1 sigma
    S = V.box_significance(x, 21, 0.01)
    assert S[50] == pytest.approx(math.sqrt(21)) and S.argmax() == 50
    assert V.box_significance(np.ones(5), 3, 1.0)[0] == pytest.approx(2 / math.sqrt(2))   # clipped window
    assert V.mf_scales(np.arange(0.0, 400.0, 1.0)) == [3, 7, 15, 31, 63, 127]
    assert V.mf_scales(np.arange(0.0, 400.0, 0.5)) == [7, 15, 31, 63, 127, 255]


def test_weak_detectable():
    # depth ~6% (6 sigma): recovered
    lN = V.logN_from_tau0(-math.log(0.94), 20.0, "OVI")
    r = fit("OVI", [[-100.0, lN, 20.0]])
    assert len(r) == 1 and abs(r[0]["logN"] - lN) < 0.05 and abs(r[0]["v"] + 100) < 1


def test_velocity_frame():
    r = fit("OVI", [[50.0, 13.6, 20.0]], v_sys=100.0)
    assert len(r) == 1 and abs(r[0]["v"] - 50.0) < 0.5
    lam, tau, rest = synth("OVI", [[50.0, 13.6, 20.0]], v_sys=100.0)
    r0 = V.fit_line(lam, tau, rest, 0.0, "OVI")              # same spectrum read with v_sys = 0
    assert abs(r0[0]["v"] - (50.0 - 100.0)) < 0.5


def test_injection_recovery_50():
    rng = np.random.default_rng(0)
    lN = rng.uniform(12.8, 14.5, 50); b = rng.uniform(8, 60, 50); v = rng.uniform(-300, 300, 50)
    ok = 0
    for i in range(50):
        r = fit("OVI", [[v[i], lN[i], b[i]]])
        if r:
            c = min(r, key=lambda c: abs(c["v"] - v[i]))
            ok += abs(c["logN"] - lN[i]) < 0.05 and abs(c["v"] - v[i]) < 1
    assert ok >= 48, ok


def test_determinism_and_order():
    truth = [[-60.0, 13.9, 14.0], [-20.0, 13.4, 22.0], [45.0, 14.1, 35.0]]
    a = fit("OVI", truth); b = fit("OVI", truth)
    assert a == b
    assert [c["v"] for c in a] == sorted(c["v"] for c in a)
    assert json.dumps(a) == json.dumps(b)


def test_nfev_cap_is_deterministic():
    """PARAMS["max_nfev_ion"] caps an ion's cumulative least_squares evaluations: no component is added after the
    cap (the capped region's comps carry MAXCOMP, later regions none); never wall-clock based."""
    truth = [[-400.0, 13.9, 14.0], [-380.0, 13.4, 22.0], [-330.0, 14.1, 35.0], [300.0, 14.3, 20.0], [330.0, 13.6, 15.0]]
    lam, tau, rest = synth("OVI", truth)
    full_info = {}
    full = V.fit_line(lam, tau, rest, 0.0, "OVI", info=full_info)
    used = [r["nfev"] for r in sorted(full_info["regions"], key=lambda r: -r["nfev"])]
    assert V.PARAMS["max_nfev_ion"] == 60000 and sum(used) < V.PARAMS["max_nfev_ion"]
    P = dict(V.PARAMS, max_nfev_ion=40)
    i1, i2 = {}, {}
    a = V.fit_line(lam, tau, rest, 0.0, "OVI", params=P, info=i1)
    b = V.fit_line(lam, tau, rest, 0.0, "OVI", params=P, info=i2)
    assert a == b and i1["regions"] == i2["regions"]
    assert len(a) < len(full) and all(c["flag"] & V.FLAGS["MAXCOMP"] for c in a)
    assert any(r["skipped"] for r in i1["regions"]) and sum(r["n"] for r in i1["regions"]) == len(a)


def test_regions():
    v = np.arange(-500, 500, 0.5); F = np.ones_like(v)
    F[(v > -10) & (v < 10)] = 0.9                  # strong
    F[(v > 20) & (v < 30)] = 0.95                  # separate run, merged after padding
    F[(v > 200) & (v < 201)] = 0.9                 # narrower than min_width -> dropped
    F[(v > 300) & (v < 320)] = 0.985               # never above 3 sigma per pixel; matched filter ~6 sigma -> kept
    F[(v > 380) & (v < 400)] = 0.998               # matched filter < 3 sigma -> dropped
    F[(v > 490)] = 0.9                             # touches the edge
    reg = V.find_regions(v, F)
    assert len(reg) == 3
    lo, hi = reg[0]
    assert v[lo] == pytest.approx(-10 + 0.5 - 15, abs=0.6) and v[hi - 1] == pytest.approx(30 - 0.5 + 15, abs=0.6)
    lo, hi = reg[1]
    assert v[lo] == pytest.approx(300 + 0.5 - 15, abs=0.6) and v[hi - 1] == pytest.approx(320 - 0.5 + 15, abs=0.6)
    assert reg[2][1] == v.size
    old = dict(V.PARAMS, mf_scales_kms=())         # the per-pixel rule alone (pre-C1): the 0.985 run is dropped
    assert [r for r in V.find_regions(v, F, old)] == [reg[0], reg[2]]


# ------------------------------------------------------------------------------- components module
def test_validate_components():
    good = {"OVI": fit("OVI", [[30.0, 13.5, 25.0]]), "HI": [], "CIII": []}
    assert C.validate_components(good) == {k: good[k] for k in ("HI", "CIII", "OVI")}
    assert C.validate_components(json.dumps(good)) == good
    rows = {k: C.dicts_to_rows(v) for k, v in good.items()}
    assert rows["OVI"][0] == [good["OVI"][0][k] for k in C.COMP_KEYS]
    assert C.validate_components(rows) == good and C.rows_to_dicts(rows["OVI"]) == good["OVI"]
    assert C.validate_components({"OVII": []}) == {"OVII": []}                      # any non-empty subset
    assert C.validate_components({**good, "HILyb": []}) == good                     # legacy key dropped
    assert C.summary(good) == {"HI": 0, "CIII": 0, "OVI": 1}
    bad = [dict(good, OVI=[dict(good["OVI"][0], logN=19.5)]),
           dict(good, OVI=[dict(good["OVI"][0], b=0.5)]),
           dict(good, OVI=[dict(good["OVI"][0], v=11500.0)]),
           dict(good, OVI=[dict(good["OVI"][0], flag=256)]),
           dict(good, HI=[dict(good["OVI"][0], logN=22.6)]),
           dict(good, OVII=[dict(good["OVI"][0], logN=19.5)]),
           dict(good, OVI=[[1.0, 2.0]]),
           {"FeXVII": []}, {},
           dict(good, OVI=[dict(good["OVI"][0], flag=True)]),
           dict(good, OVI=[dict(good["OVI"][0], logN=float("nan"))]),
           dict(good, OVI=[dict(good["OVI"][0], extra=1)]),
           dict(good, OVI=[good["OVI"][0]] * 31),
           {"HILyb": []}]
    for b in bad:
        with pytest.raises(ValueError):
            C.validate_components(b)
    assert C.validate_components(dict(good, HI=[dict(good["OVI"][0], logN=21.0, flag=81)]))["HI"][0]["logN"] == 21.0
    nul = dict(good, OVI=[dict(good["OVI"][0], dv=None, dlogN=None, db=None)])
    assert C.validate_components(nul)["OVI"][0]["dv"] is None
    with pytest.raises(ValueError):
        C.validate_components(dict(good, OVI=[dict(good["OVI"][0], v=None)]))


def test_params_tag_and_dump():
    t = C.params_tag()
    assert len(t) == 12 and t == C.params_tag(dict(V.PARAMS))
    assert C.params_tag(dict(V.PARAMS, sigma=0.02)) != t
    one = fit("OVI", [[30.0, 13.5, 25.0]])
    cat = C.make_catalogue({"b": {"OVI": one, "HI": [], "CIII": []}, "a": {"OVII": []}},
                           aod={"b": {"OVI": [13.5, [[0, -10.0, 70.0, 13.5]]]},
                                "a": {"OVII": {"logN_aod": None, "regions": []}}})
    blob = C.dump_catalogue(cat)
    assert blob == C.dump_catalogue(json.loads(blob)) and b", " not in blob and b": " not in blob
    d = json.loads(blob)
    assert list(d["entries"]) == ["a", "b"] and d["version"] == 2 and d["fitter"] == "tngsight.vpfit/2"
    assert d["comp_keys"] == list(V.COMP_KEYS) and d["registry_tag"] == I.registry_tag()
    assert d["entries"]["b"]["OVI"] == C.dicts_to_rows(one) and d["aod"]["a"] == {"OVII": [None, []]}
    assert cat["params"]["flags"] == V.FLAGS and V.FLAGS["BUDGET"] == 128 and cat["params"]["sigma"] == 0.01
    assert cat["params"]["frame"] == "V=u+v_sys" and cat["params"]["atomic"]["OVII"] == I.atomic("OVII")
    assert cat["params"]["fit_dv_kms"] == 1.0 and cat["params"]["max_nfev_ion"] == 60000
    assert cat["params"]["mf_scales_kms"] == [3.0, 7.0, 15.0, 31.0, 63.0, 127.0] and cat["params"]["mf_resid"] is True
    assert cat["params"]["maxcomp_mf"] is False
    C.validate_catalogue(json.loads(blob))
    with pytest.raises(ValueError, match="version"):
        C.validate_catalogue({**d, "version": 1})


def test_v1_catalogue_upgrade(tmp_path):
    """A v1 components.json (dict rows, dict AOD, HILyb) loads as v2 with OVI and CIII only."""
    c0 = fit("OVI", [[30.0, 13.5, 25.0]])[0]
    v1 = {"version": 1, "fitter": "tngsight.vpfit/1", "params_tag": "0123456789ab", "params": {"sigma": 0.01},
          "entries": {"x": {"OVI": [c0], "HILyb": [dict(c0, logN=21.0, flag=81)], "CIII": []},
                      "y": {"HILyb": []}},
          "aod": {"x": {k: {"logN_aod": 13.5, "regions": [{"region": 0, "v_lo": -10.0, "v_hi": 70.0,
                                                           "logN_aod": 13.5}]} for k in ("OVI", "HILyb", "CIII")}}}
    p = tmp_path / "c.json"; p.write_text(json.dumps(v1))
    cat = C.load_catalogue(p)
    assert cat["version"] == 2 and cat["converted_from"] == 1 and list(cat["entries"]) == ["x"]
    assert cat["entries"]["x"] == {"CIII": [], "OVI": [[c0[k] for k in C.COMP_KEYS]]}
    assert cat["aod"]["x"] == {"CIII": [13.5, [[0, -10.0, 70.0, 13.5]]], "OVI": [13.5, [[0, -10.0, 70.0, 13.5]]]}


def test_fit_payload_progress():
    p = payload_of({k: [[0.0, V.logN_from_tau0(0.4, 30.0, k), 30.0]] for k in I.KEYS})
    calls = []
    out = C.fit_payload(p, lambda s, f, m: calls.append((s, f)))
    assert list(out) == list(I.KEYS) and C.summary(out) == {k: 1 for k in I.KEYS}
    assert all(s == "fit" for s, _ in calls) and calls[-1][1] == 1.0 and calls[0][1] == 0.0
    sub = C.fit_payload({**p, "lines": ["CIII", "OVI"]})                       # a v1 line set
    assert list(sub) == ["CIII", "OVI"]


# ------------------------------------------------------------------------------- real data
@need_lib
def test_real_library_sightlines():
    good, total, worst, times = 0, 0, 0.0, []
    for sid in REAL_IDS:
        p = L.load_npz(LIB / "sightlines" / f"{sid}.npz")
        t0 = time.perf_counter()
        comps = {}
        for k in p["lines"]:
            info = {}
            comps[k] = V.fit_line(p["lam"][k], p["tau"][k], p["rest"][k], p["v_sys"], k, info=info)
            v = velocity_axis(p["lam"][k], p["rest"][k], p["v_sys"])[::info["stride"]]
            F = np.exp(-p["tau"][k][::info["stride"]].astype(float))
            M = np.exp(-V.tau_components(v, [[c["v"], c["logN"], c["b"]] for c in comps[k]], k))
            for reg in info["regions"]:
                total += 1
                good += np.abs(F - M)[reg["lo"]:reg["hi"]].max() <= 0.03
                worst = max(worst, reg["chi2nu"])
        times.append(time.perf_counter() - t0)
        C.validate_components(comps)
    assert good >= 0.9 * total, (good, total)
    assert worst <= 10.0
    assert statistics.median(times) <= 20.0


@pytest.mark.skipif(not COMMITTED.is_file(), reason="components.json not built")
def test_committed_catalogue():
    """The page's components.json: v1 until the Phase-3 switch-over (read through the v1 upgrade), then v2."""
    cat = C.load_catalogue(COMMITTED)
    assert COMMITTED.stat().st_size <= 4_000_000
    if cat.get("converted_from") == 1:
        assert all(set(e) <= {"OVI", "CIII"} for e in cat["entries"].values())
    else:
        assert cat["params_tag"] == C.params_tag() and cat["fitter"] == C.FITTER_TAG
        assert C.dump_catalogue(cat) == COMMITTED.read_bytes()
    if STATIC_CATALOG.is_file():
        ids = {e["id"] for e in json.loads(STATIC_CATALOG.read_text())["entries"]}
        assert ids <= set(cat["entries"])
