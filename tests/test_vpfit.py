"""Tests for the clean-room Voigt fitter (tngsight.vpfit) and the components catalogue (tngsight.components),
phase-2 design §5.6. Synthetic spectra live on the real native grids (library.wavelength_grid) with float32 τ like
the npz files. Real-data tests read the work-volume library (TNG_LIBRARY_DIR) and skip when it is absent."""
import json
import math
import statistics
import time
from pathlib import Path

import numpy as np
import pytest

from tngsight import components as C, config, library as L, vpfit as V
from tngsight.degrade import velocity_axis

ROOT = Path(__file__).resolve().parent.parent
LIB = config.library_dir()
COMMITTED = ROOT / "docs" / "tng50" / "data" / "components.json"
STATIC_CATALOG = ROOT / "docs" / "tng50" / "data" / "catalog.json"
REAL_IDS = ["rand_b031_a334_s175141482", "face_b050_a090", "edge_b100_a090", "edge_b050_a000", "face_b150_a330"]
need_lib = pytest.mark.skipif(not (LIB / "sightlines").is_dir(), reason=f"library not at {LIB}")


def synth(key, comps, v_sys=0.0):
    lam = L.wavelength_grid(key); rest = config.LINES[key]["rest_A"]
    v = velocity_axis(lam, rest, v_sys)
    tau = V.tau_components(v, comps, key).astype(np.float32)
    return lam, tau, rest


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


def test_atomic_matches_line_table():
    for k in config.LINE_KEYS:
        assert V.ATOMIC[k]["lam0"] == config.LINES[k]["rest_A"]
        assert V.ATOMIC[k]["f"] == pytest.approx(config.LINES[k]["f"], rel=1e-12)


@pytest.mark.parametrize("key", config.LINE_KEYS)
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


def test_hi_lyb_single_and_bmin():
    r = fit("HILyb", [[-40.0, 15.0, 30.0]])
    assert len(r) == 1 and abs(r[0]["logN"] - 15.0) < 0.05
    narrow = fit("HILyb", [[10.0, 14.5, 9.0], [60.0, 14.0, 12.0]])
    for c in r + narrow:
        assert c["b"] >= 8.0


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
    p = {"lam": {}, "tau": {}, "rest": {}, "v_sys": 0.0}
    inj = {"OVI": [[0.0, 13.6, 25.0]], "HILyb": [[-20.0, 17.2, 25.0]], "CIII": [[0.0, 15.5, 10.0]]}
    for k in config.LINE_KEYS:
        p["lam"][k], p["tau"][k], p["rest"][k] = synth(k, inj[k])
    C.fit_payload(p, aod=aod)
    C.validate_aod(aod)
    for k, cs in inj.items():
        assert abs(aod[k]["logN_aod"] - cs[0][1]) < 0.01, (k, aod[k])
        assert len(aod[k]["regions"]) == 1 and abs(aod[k]["regions"][0]["logN_aod"] - cs[0][1]) < 0.01
        assert aod[k]["regions"][0]["v_lo"] < cs[0][0] < aod[k]["regions"][0]["v_hi"]


@pytest.mark.parametrize("logN,v0", [(20.5, 0.0), (21.3, 120.0)])
def test_damped_hi_lyb_single(logN, v0):
    """A damped Lyβ line comes back as ONE component (wing-seeded), within 0.1 dex, flagged DAMPED with a
    formal error (the wings constrain N)."""
    r = fit("HILyb", [[v0, logN, 30.0]])
    assert len(r) == 1, r
    c = r[0]
    assert abs(c["logN"] - logN) < 0.1 and abs(c["v"] - v0) < 2.0
    assert c["flag"] & V.FLAGS["DAMPED"] and c["flag"] & V.FLAGS["SAT"]
    assert c["dlogN"] is not None and not c["flag"] & V.FLAGS["NOERR"]
    assert C.validate_components({"OVI": [], "HILyb": r, "CIII": []})["HILyb"] == r


def test_damped_seed_ignores_ordinary_lines():
    lam, tau, rest = synth("HILyb", [[0.0, 17.0, 30.0]])
    v = velocity_axis(lam, rest, 0.0)
    assert V.damped_seed(v, np.exp(-tau.astype(float)), "HILyb") is None
    lam, tau, rest = synth("OVI", [[0.0, 18.5, 40.0]])
    assert V.damped_seed(velocity_axis(lam, rest, 0.0), np.exp(-tau.astype(float)), "OVI") is None
    assert V.logN_bounds("OVI") == (10.0, 19.0) and V.logN_bounds("HILyb") == (10.0, 22.5)


def test_empty_and_weak():
    lam = L.wavelength_grid("OVI"); rest = config.LINES["OVI"]["rest_A"]
    assert V.fit_line(lam, np.zeros(lam.size, np.float32), rest, 0.0, "OVI") == []
    # peak depth 0.02 (< 3 sigma): tau0 = -ln(0.98)
    lN = V.logN_from_tau0(-math.log(0.98), 20.0, "OVI")
    assert fit("OVI", [[0.0, lN, 20.0]]) == []


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


def test_regions():
    v = np.arange(-500, 500, 0.5); F = np.ones_like(v)
    F[(v > -10) & (v < 10)] = 0.9                  # strong
    F[(v > 20) & (v < 30)] = 0.95                  # separate run, merged after padding
    F[(v > 200) & (v < 201)] = 0.9                 # narrower than min_width -> dropped
    F[(v > 300) & (v < 320)] = 0.985               # never above 3 sigma -> dropped
    F[(v > 490)] = 0.9                             # touches the edge
    reg = V.find_regions(v, F)
    assert len(reg) == 2
    lo, hi = reg[0]
    assert v[lo] == pytest.approx(-10 + 0.5 - 15, abs=0.6) and v[hi - 1] == pytest.approx(30 - 0.5 + 15, abs=0.6)
    assert reg[1][1] == v.size


# ------------------------------------------------------------------------------- components module
def test_validate_components():
    good = {"OVI": fit("OVI", [[30.0, 13.5, 25.0]]), "HILyb": [], "CIII": []}
    assert C.validate_components(good) == good
    assert C.validate_components(json.dumps(good)) == good
    bad = [dict(good, OVI=[dict(good["OVI"][0], logN=19.5)]),
           dict(good, OVI=[dict(good["OVI"][0], b=0.5)]),
           dict(good, OVI=[dict(good["OVI"][0], v=2500.0)]),
           dict(good, OVI=[dict(good["OVI"][0], flag=128)]),
           dict(good, HILyb=[dict(good["OVI"][0], logN=22.6)]),
           dict(good, OVI=[dict(good["OVI"][0], flag=True)]),
           dict(good, OVI=[dict(good["OVI"][0], logN=float("nan"))]),
           dict(good, OVI=[dict(good["OVI"][0], extra=1)]),
           dict(good, OVI=[good["OVI"][0]] * 31),
           {"OVI": [], "HILyb": []}]
    for b in bad:
        with pytest.raises(ValueError):
            C.validate_components(b)
    assert C.validate_components(dict(good, HILyb=[dict(good["OVI"][0], logN=21.0, flag=81)]))["HILyb"][0]["logN"] == 21.0
    nul = dict(good, OVI=[dict(good["OVI"][0], dv=None, dlogN=None, db=None)])
    assert C.validate_components(nul)["OVI"][0]["dv"] is None
    with pytest.raises(ValueError):
        C.validate_components(dict(good, OVI=[dict(good["OVI"][0], v=None)]))


def test_params_tag_and_dump():
    t = C.params_tag()
    assert len(t) == 12 and t == C.params_tag(dict(V.PARAMS))
    assert C.params_tag(dict(V.PARAMS, sigma=0.02)) != t
    cat = C.make_catalogue({"b": {"OVI": [], "HILyb": [], "CIII": []}, "a": {"OVI": [], "HILyb": [], "CIII": []}})
    blob = C.dump_catalogue(cat)
    assert blob == C.dump_catalogue(json.loads(blob)) and b", " not in blob and b": " not in blob
    assert list(json.loads(blob)["entries"]) == ["a", "b"]
    assert cat["params"]["flags"] == V.FLAGS and cat["params"]["sigma"] == 0.01
    C.validate_catalogue(json.loads(blob))


def test_fit_payload_progress():
    p = {"lam": {}, "tau": {}, "rest": {}, "v_sys": 0.0}
    for k in config.LINE_KEYS:
        lam, tau, rest = synth(k, [[0.0, 13.5, 20.0]])
        p["lam"][k], p["tau"][k], p["rest"][k] = lam, tau, rest
    calls = []
    out = C.fit_payload(p, lambda s, f, m: calls.append((s, f)))
    assert list(out) == list(config.LINE_KEYS) and C.summary(out) == {"OVI": 1, "HILyb": 1, "CIII": 1}
    assert all(s == "fit" for s, _ in calls) and calls[-1][1] == 1.0 and calls[0][1] == 0.0


# ------------------------------------------------------------------------------- real data
@need_lib
def test_real_library_sightlines():
    good, total, worst, times = 0, 0, 0.0, []
    for sid in REAL_IDS:
        p = L.load_npz(LIB / "sightlines" / f"{sid}.npz")
        t0 = time.perf_counter()
        comps = {}
        for k in config.LINE_KEYS:
            info = {}
            comps[k] = V.fit_line(p["lam"][k], p["tau"][k], p["rest"][k], p["v_sys"], k, info=info)
            v = velocity_axis(p["lam"][k], p["rest"][k], p["v_sys"])
            F = np.exp(-p["tau"][k].astype(float))
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
    cat = C.load_catalogue(COMMITTED)
    assert cat["params_tag"] == C.params_tag() and cat["fitter"] == C.FITTER_TAG
    assert COMMITTED.stat().st_size <= 1_500_000
    assert C.dump_catalogue(cat) == COMMITTED.read_bytes()
    if STATIC_CATALOG.is_file():
        ids = {e["id"] for e in json.loads(STATIC_CATALOG.read_text())["entries"]}
        assert ids <= set(cat["entries"])
