"""Tier A planner and case rules (DESIGN_tierA §3 case/1, §4.2 letters/2): unit tests on synthetic inputs, no story data
needed (the data-level checks on the built stories are in tests/test_story_data.py)."""
import math
import sys
from pathlib import Path

import numpy as np
import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO))

S = pytest.importorskip("select_cases")
SP = pytest.importorskip("story_plan")

HALF = 246.0
RAY = {"p0": [-HALF, 30.0, 0.0], "n": [1.0, 0.0, 0.0]}


def enc(i, l0, l1, lead="HI", share=None, tau=1.0, V=0.0, r90=4.0, mg=0.0, logN=None):
    share = share or {"HI": 0.5, "OVI": 0.2}
    sp = {k: {"V_min": V, "tau_peak": tau if k == lead else 0.01} for k in ("HI", "OVI", "MgII")}
    sp["MgII"]["tau_peak"] = mg
    return {"id": f"e{i}", "l0": l0, "l1": l1, "lc": 0.5 * (l0 + l1), "n_cells": 3, "r90": r90, "share": share,
            "logN": logN or {"HI": 14.0, "OVI": 13.0}, "tau0_sum": {}, "lead": lead, "V": sp, "clouds": [f"c{i}"],
            "h_peak": 1.0, "idx": np.arange(3), "letterable": tau >= S.LETTER_TAU0}


def plan(case, encs, s5_l=0.0, pair=None, mp=None, rc=None):
    lc = np.linspace(-HALF, HALF, 493)
    S5 = int(np.argmin(np.abs(lc - s5_l)))
    h = np.full(lc.size, 1.0)
    tau0 = {"HI": np.full(lc.size, 0.02), "OVI": np.full(lc.size, 0.02)}
    rc = rc or {"HI": {"r_contrast": 0.0, "F15_min": 0.0, "F50_min": 0.0},
                "OVI": {"r_contrast": 0.2, "F15_min": 0.5, "F50_min": 0.3}}
    return SP.build_plan(case, encs, ["HI", "OVI"], S5, lc, h, tau0, HALF, RAY, pair, mp, rc, np.zeros(lc.size))


def check_cover(p):
    sl = list(p["slots"].values())
    assert list(p["slots"]) == ["F0", "A", "FAB", "B", "FBC", "C", "FCD", "D", "Fend"]
    assert sl[0]["l0"] == pytest.approx(-HALF, abs=1e-3) and sl[-1]["l1"] == pytest.approx(HALF, abs=1e-3)
    for a, b in zip(sl, sl[1:]):
        assert a["l1"] == pytest.approx(b["l0"], abs=1e-3), (a, b)        # no holes, no overlaps
        assert a["l0"] <= a["l1"] + 1e-9
    for s in sl:
        if not s["on"]:
            assert s["l1"] - s["l0"] == pytest.approx(0, abs=1e-6) or s["kind"] in ("flight", "gap")
    bw = p["beat_l"]
    assert list(bw) == list(SP.E.BEAT_L)
    assert bw["B3"][0] == pytest.approx(-HALF, abs=1e-3) and bw["B11"][1] == pytest.approx(HALF, abs=1e-3)


def test_plan_anchor_and_fill():
    E = [enc(0, -150, -130), enc(1, -10, 10, lead="OVI"), enc(2, 60, 80), enc(3, 120, 140)]
    p = plan("clean", E, s5_l=0.0)
    check_cover(p)
    let = {e["letter"]: e["id"] for e in p["encounters"] if e["letter"]}
    assert let == {"A": "e0", "B": "e1", "C": "e2", "D": "e3"}
    assert p["slots"]["B"]["kind"] == "stop" and p["slots"]["B"]["lead"] == "OVI"
    # window = l-range +- max(5, 0.5 r90)
    assert p["slots"]["A"]["l0"] == pytest.approx(-155) and p["slots"]["A"]["l1"] == pytest.approx(-125)
    assert p["cut_l"] == [pytest.approx(-140), pytest.approx(0.0, abs=1.0), pytest.approx(130)]
    assert p["flags"]["has_gap_AB"] and p["flags"]["has_gap_BC"]
    assert p["resolve"]["ion"] == "OVI" and p["resolve"]["mode"] == "resolve"


def test_plan_synthetic_b_and_missing_letters():
    p = plan("hot", [enc(0, 100, 110)], s5_l=-50.0)
    check_cover(p)
    syn = [e for e in p["encounters"] if e.get("synthetic")]
    assert len(syn) == 1 and syn[0]["letter"] == "B"
    assert p["slots"]["B"]["l1"] - p["slots"]["B"]["l0"] == pytest.approx(10.0)    # +- max(5 kpc, 3 h = 3)
    assert not p["slots"]["A"]["on"] and p["slots"]["C"]["on"]
    assert p["cut_l"][0] == pytest.approx(-0.5 * HALF) and p["cut_l"][2] == pytest.approx(0.5 * HALF)


def test_plan_windows_clipped_ordered():
    E = [enc(0, -30, -12, r90=30), enc(1, -10, 10), enc(2, 12, 30, r90=30)]
    p = plan("clean", E)
    check_cover(p)
    assert p["slots"]["A"]["l1"] == pytest.approx(-11.0) and p["slots"]["B"]["l0"] == pytest.approx(-11.0)


def test_plan_empty_case():
    p = plan("empty", [enc(0, -50, -40)], s5_l=20.0)
    check_cover(p)
    assert [k for k in "ABCD" if p["slots"][k]["on"]] == ["B"]
    assert p["flags"]["B12n"] and not p["flags"]["B10w"] and not p["flags"]["B7p"]
    assert p["bounds"]["l"] == [pytest.approx(-HALF), pytest.approx(HALF)]


def test_plan_damped_pin_letters_largest_hi_encounter():
    E = [enc(0, -10, 10, lead="OVI", share={"HI": 0.05, "OVI": 0.6}),
         enc(1, 60, 70, share={"HI": 0.1, "OVI": 0.1}), enc(2, 150, 170, share={"HI": 0.85, "OVI": 0.0})]
    p = plan("damped", E)
    check_cover(p)
    let = {e["id"]: e["letter"] for e in p["encounters"]}
    assert let["e2"] == "D" and p["damped_target"] == "e2" and p["flags"]["B10w"]


def test_plan_multiphase_pin_both_members():
    E = [enc(0, -200, -180, share={"HI": 0.9, "OVI": 0.05}), enc(1, -10, 10, lead="OVI"),
         enc(2, 40, 50, share={"HI": 0.6, "OVI": 0.1}), enc(3, 150, 160, lead="OVI", share={"HI": 0.01, "OVI": 0.5})]
    mp = {"cool": "e0", "warm": "e3"}
    p = plan("multiphase", E, mp=mp)
    check_cover(p)
    let = {e["id"]: e["letter"] for e in p["encounters"]}
    assert let["e0"] and let["e3"] and p["flags"]["B7p"]


def test_plan_resolve_saturated():
    rc = {"HI": {"r_contrast": 0.0, "F15_min": 0.0, "F50_min": 0.0}, "OVI": {"r_contrast": 0.03, "F15_min": 0.1, "F50_min": 0.07}}
    p = plan("damped", [enc(0, -10, 10)], rc=rc)
    assert p["resolve"]["mode"] == "resolve_saturated" and p["resolve"]["ion"] == "OVI"


# ---------------------------------------------------------------------------------------------- case/1 classifier
def ion(logN, tau, F15=None, S=0.0, bw=0.0, wing=None):
    return {"logN": logN, "peak_tau": tau, "F15_min": math.exp(-tau) if F15 is None else F15, "F50_min": 0.0,
            "r_contrast": 0.0, "S_det": S, "detected_3sig": S >= 3, "black15_width_kms": bw, "black15_range": [0, bw],
            "V_peak": 0.0, "wing_frac": wing}


def M_of(**ions):
    base = {k: ion(9.0, 0.0) for k in ("HI", "MgII", "SiII", "CII", "SiIII", "CIV", "OVI", "NeVIII")}
    base.update(ions)
    return {"ions": base, "n_letterable": 0, "clean_minima": {}}


def test_rule_damped_branches():
    assert S.rule_damped(M_of(HI=ion(20.57, 1e7)))["ok"]
    v = S.rule_damped(M_of(HI=ion(18.9, 1e5)))
    assert not v["ok"] and v["score"] == pytest.approx(-0.1)


def test_rule_empty_branches():
    v = S.rule_empty(M_of(HI=ion(11.8, 0.001, S=0.06), OVI=ion(11.5, 0.0005, S=0.01)))
    assert v["ok"] and v["margin_ok"]
    assert "no exported ion with 3 sigma detection" in S.rule_empty(M_of(HI=ion(12.5, 0.2, S=3.5), OVI=ion(11, 0)))["fails"]
    m = M_of(HI=ion(11.8, 0.001), OVI=ion(11.5, 0.0)); m["n_letterable"] = 1
    assert S.rule_empty(m)["fails"] == ["no lettered encounter"]
    assert "logN(OVI) < 13.3" in S.rule_empty(M_of(HI=ion(11.8, 0.001), OVI=ion(13.4, 0.05)))["fails"]


def test_rule_hot_branches():
    good = dict(HI=ion(13.8, 0.38), OVI=ion(14.56, 1.98), NeVIII=ion(14.2, 0.2))
    v = S.rule_hot(M_of(**good))
    assert v["ok"] and v["weakest"] == "HI peak tau < 1"
    assert "HI peak tau < 1" in S.rule_hot(M_of(**dict(good, HI=ion(14.0, 1.03))))["fails"]
    assert "MgII, SiII, CII peak tau < 0.05" in S.rule_hot(M_of(**dict(good, CII=ion(13, 1.4))))["fails"]
    m = M_of(**good); del m["ions"]["NeVIII"]
    assert "NeVIII exported" in S.rule_hot(m)["fails"]


def test_rule_multiphase_branches():
    m = M_of()
    m["mp_pair"] = {"cool_why": "x", "warm_logN_OVI": 13.625, "dv": 152.0, "dv_thr": 40.0, "dl": 106.0, "dl_thr": 11.4}
    v = S.rule_multiphase(m)
    assert v["ok"] and v["score"] == pytest.approx(0.125)
    m2 = M_of(); m2["mp_why"] = "no cool encounter"
    assert not S.rule_multiphase(m2)["ok"]
    m["mp_pair"]["dv"] = 30.0
    assert "minima differ >= max(40, 2 b_OVI)" in S.rule_multiphase(m)["fails"]


def test_rule_clean_branches():
    m = M_of(HI=ion(15.45, 98), OVI=ion(13.7, 0.302), CIV=ion(13.1, 0.39))
    m["clean_enc"] = {"share": {"OVI": 0.76, "CIV": 0.997}}
    m["clean_minima"] = {"HI": (5.0, 15.0), "OVI": (3.0, 18.0)}
    v = S.rule_clean(m)
    assert v["ok"] and not v["margin_ok"]                    # 0.004 dex < 0.1: passes the rule, fails the margin
    m["clean_enc"]["share"]["OVI"] = 0.35
    assert "one encounter >= 70 % of OVI column" in S.rule_clean(m)["fails"]
    m3 = M_of(); assert not S.rule_clean(m3)["ok"]          # no encounter at all


def test_classifier_priority_and_generic():
    """the classifier labels by priority (damped, empty, hot, multiphase, clean), generic when nothing passes"""
    M = {"ions": {k: ion(9.0, 0.0) for k in ("HI", "MgII", "SiII", "CII", "SiIII", "CIV", "OVI", "NeVIII")},
         "n_letterable": 1, "clean_minima": {}, "trident_npz": "-"}
    M["ions"]["HI"] = ion(14.5, 2.0); M["ions"]["OVI"] = ion(13.5, 0.4)
    S.measure_core(M, "clean", "CIV", None, None, {}, None, None)
    assert M["case"]["id"] == "generic"
    assert set(M["case"]["scores"]) == {"damped", "empty", "hot_only", "multiphase", "clean_single"}
    M2 = dict(M); M2["ions"] = dict(M["ions"]); M2["ions"]["HI"] = ion(20.5, 1e7)
    S.measure_core(M2, "damped", None, None, None, {}, None, None)
    assert M2["case"]["id"] == "damped" and M2["case"]["subcase"] == "dla"


# ---------------------------------------------------------------------------------------------- limits (absreq K)
def _significance(ionkey, logN, sn, R):
    """independent real-space matched filter: Doppler core, Gaussian LSF, S = (S/N) sqrt(Int D^2 dv / FWHM)"""
    f, lam = S.osc(ionkey)
    b = SP_limit(ionkey)["b"]
    v = np.arange(-600, 600, 0.05)
    tau = 1.4975e-15 * 10 ** logN * f * lam / b * np.exp(-(v / b) ** 2)
    F = S.lsf(np.exp(-tau), 0.05, R)
    return sn * math.sqrt(float(np.sum((1 - F) ** 2) * 0.05) / (S.C_KMS / R))


def SP_limit(ionkey, sn=10, R=15000):
    return S.limit_3sig(ionkey, sn=sn, R=R)


@pytest.mark.parametrize("ionkey,sn,R", [("HI", 10, 15000), ("OVI", 10, 15000), ("OVI", 20, 30000)])
def test_limits_match_absreq_k(ionkey, sn, R):
    if not (S.ABSREQ / "absreq" / "detection.py").exists():
        pytest.skip("absreq not on this machine (ABSREQ_PATH)")
    lim = SP_limit(ionkey, sn, R)
    assert lim["sn"] == sn and lim["R"] == R and lim["b"] > 0
    s = _significance(ionkey, lim["logN_3sig"], sn, R)
    assert s == pytest.approx(3.0, rel=0.05), (ionkey, lim, s)


def test_noise_rule_constants():
    """the empty-case noise search is pinned to the page defaults and the 2-3 sigma, one-excursion rule"""
    src = (REPO / "scripts" / "story_fits.mjs").read_text()
    assert "function noiseSearch(ions, R = 15000, snr = 10, vwin = [-300, 300])" in src
    assert "ex.length === 1 && ex[0].sigma < 3" in src and "S <= 999" in src


def test_page_fit_2comp_reads_the_drawn_ovi_seeds():
    """fix2 (review2 R2-B2/R3-S9): the claim follows the O VI draws B13 shows, not H I and O VI pooled"""
    f = lambda ion, sp, vs, R=30000: {"ion": ion, "R": R, "snr": 10, "ci": 0, "seedParam": sp, "comps": [[v, 13, 20] for v in vs]}
    pooled = {"cases": [f("HI", 0, [-50]), f("OVI", 0, [100]), f("OVI", 1, [-4, 98]), f("OVI", 2, [99])]}
    c = SP.page_fit_2comp(pooled)
    assert c["value"] == 1 and c["pass"] is False and c["detail"]["draws"] == [1, 2, 1]
    two = {"cases": [f("OVI", s, [-60, 100]) for s in (0, 1, 2)] + [f("OVI", 3, [0])]}
    assert SP.page_fit_2comp(two)["pass"] is True
    assert SP.page_fit_2comp({"cases": [f("OVI", 0, [-60, 100], R=15000)]})["pass"] is False
