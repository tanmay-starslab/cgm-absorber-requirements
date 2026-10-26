"""Tests for tngsight.search (phase-2 design §6; Phase-3: the 12 registry ions): validation, exact semantics on
hand-checked cases, the committed fixture/golden files (which the JS mirror docs/tng50/js/search.js is tested
against), and speed."""
import json
import math
import time
from pathlib import Path

import pytest

from tngsight import ions as I, search as S

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / "data" / "search_fixture.json"
GOLDEN = ROOT / "search_golden.json"


def fx():
    return S.load_fixture(FIXTURE)


def test_fixture_is_reproducible():
    assert json.loads(FIXTURE.read_text()) == json.loads(json.dumps(S.make_fixture()))
    f = fx()
    assert len(f["entries"]) == 40


def test_golden_is_current():
    g = json.loads(GOLDEN.read_text())
    assert g == json.loads(json.dumps(S.golden(), ensure_ascii=False))
    assert len(g["cases"]) == len(S.CASES) == 28 and g["query_schema"] == S.QUERY_SCHEMA
    assert len(g["annotate_cases"]) == len(S.ANNOTATE_CASES) == 5
    assert all(c["ids"] for c in g["cases"])                       # every case selects something


@pytest.mark.parametrize("q,msg", S.INVALID_CASES)
def test_invalid_queries(q, msg):
    with pytest.raises(ValueError) as e:
        S.validate_query(q)
    assert str(e.value) == msg


def test_registry_ions_and_per_ion_logN_bound():
    assert S.ION_KEYS == I.KEYS and S.QUERY_SCHEMA["properties"]["ion"]["enum"] == list(I.KEYS)
    assert S.ION_SHORT == {k: I.get(k)["ion"] for k in I.KEYS}
    assert S.QUERY_SCHEMA["properties"]["logN_max"]["maximum"] == 22.5 == S.QUERY_SCHEMA["properties"]["logN_min"]["maximum"]
    assert S.validate_query({"ion": "HI", "logN_max": 22.5})["logN_max"] == 22.5
    assert S.validate_query({"ion": "OVII", "logN_max": 19})["logN_max"] == 19.0
    for q, msg in (({"ion": "OVI", "logN_max": 19.01}, "logN_max: must be <= 19 for OVI"),
                   ({"ion": "NeVIII", "logN_min": 20, "logN_max": 21}, "logN_min: must be <= 19 for NeVIII"),
                   ({"ion": "HILyb"}, "ion: must be one of HI, MgII, SiII, CII, SiIII, CIII, SiIV, CIV, NV, OVI, "
                                      "NeVIII, OVII")):
        with pytest.raises(ValueError) as e:
            S.validate_query(q)
        assert str(e.value) == msg


def test_v1_entries_are_never_matched_on_new_ions():
    """A catalogue row fitted only for O VI and C III (v1) is 'not fitted' for the other ions."""
    f = fx()
    v1 = [sid for sid, c in f["components"].items() if set(c) == {"OVI", "CIII"}]
    assert v1
    for k in ("HI", "MgII", "CIV", "OVII"):
        got = {r["id"] for r in S.run_query({"ion": k, "n_min": 0}, f["entries"], f["components"], limit=200)}
        assert not got & set(v1), k
    assert set(v1) & {r["id"] for r in S.run_query({"ion": "OVI", "n_min": 0}, f["entries"], f["components"],
                                                   limit=200)}


def test_validate_defaults_and_integral_floats():
    q = S.validate_query({"ion": "OVI", "n_max": 3.0, "sep_kms": [30, 80.5]})
    assert q == {"ion": "OVI", "n_max": 3, "sep_kms": [30.0, 80.5], "n_min": 1, "sort": "score", "limit": 50}
    assert isinstance(q["n_max"], int)


def test_hand_checked_pair_case():
    f = fx()
    res = S.search({"ion": "OVI", "sep_kms": [30, 30]}, f["entries"], f["components"])
    assert res["n_total"] == 1
    r = res["results"][0]
    assert r["id"] == "face_b010_a000" and r["n"] == 5 and r["b_kpc"] == 100.0     # 4 hand-made + 1 NOERR limit
    # |(-127.99) - (-157.99)| = 30.000000000000014 in IEEE doubles: only matches after the 1e-6 rounding
    assert abs(-127.99 - -157.99) != 30.0
    assert r["pairs"] == [[0, 1, 30.0], [0, 2, 30.0]]
    assert [c["idx"] for c in r["components"]] == [0, 1, 2]
    # 1.375 + 1.375 (the SAT one, a lower limit at its fitted 13.5) + 1.0625 − 0.5 (one SAT) + 0.25·2 pairs
    assert r["score"] == pytest.approx(3.8125, abs=1e-12)
    assert r["reason"] == "5 O VI components, logN 12.3–13.5 (1 lower limit), b 13–20 km/s, Δv 30 km/s, 100 kpc"


def test_zero_separation_and_n_zero():
    f = fx()
    r = S.run_query({"ion": "OVI", "sep_kms": [0, 0]}, f["entries"], f["components"])
    assert r[0]["pairs"] == [[1, 2, 0.0]] and r[0]["reason"].endswith("Δv 0 km/s, 100 kpc")
    z = S.run_query({"ion": "CIII", "n_min": 0, "n_max": 0}, f["entries"], f["components"])
    assert z and all(x["n"] == 0 and x["components"] == [] and x["score"] == 0.0 for x in z)
    assert all(x["reason"].startswith("0 C III components") and "logN" not in x["reason"] for x in z)


def test_results_satisfy_filters_and_order():
    f = fx()
    comps = f["components"]
    ent = {e["id"]: e for e in f["entries"]}
    for case in S.CASES:
        q = S.validate_query(case["query"])
        res = S.search(case["query"], f["entries"], f["components"])
        assert len(res["results"]) == min(q["limit"], res["n_total"])
        for r in res["results"]:
            e = ent[r["id"]]
            assert q["ion"] in comps[r["id"]]
            if "orientation" in q:
                assert e["orientation"] == q["orientation"]
            if "b_kpc" in q:
                assert q["b_kpc"][0] <= e["b_kpc"] <= q["b_kpc"][1]
            assert q["n_min"] <= r["n"] <= q.get("n_max", math.inf)
            for c in r["components"]:
                assert c == dict(comps[r["id"]][q["ion"]][c["idx"]], idx=c["idx"])
                assert q.get("logN_min", -1) <= c["logN"] <= q.get("logN_max", 99)
            assert [c["v"] for c in r["components"]] == sorted(c["v"] for c in r["components"])
            assert len(r["pairs"]) <= 10 and (("sep_kms" in q) == bool(r["pairs"]))
        if q["sort"] == "score":
            keys = [(-r["score"], r["id"]) for r in res["results"]]
            assert keys == sorted(keys)


def test_duplicates_later_wins_and_limit_override():
    f = fx()
    e = dict(f["entries"][0], orientation="edge-on")
    r = S.run_query({"ion": "OVI", "orientation": "edge-on"}, f["entries"] + [e], f["components"], limit=200)
    assert e["id"] in [x["id"] for x in r]
    assert len(S.run_query({"ion": "OVI"}, f["entries"], f["components"], limit=2)) == 2


def test_round_half_away():
    assert S.fmt(12.25, 1) == "12.3" and S.fmt(12.5, 0) == "13" and S.fmt(-0.04, 1) == "0.0"
    assert S.fmt(2.675, 2) == "2.68" or S.fmt(2.675, 2) == "2.67"   # binary value 2.67499..: either is IEEE-faithful
    assert S.r6(30.000000000000014) == 30.0


def test_schema_cli(tmp_path):
    out = tmp_path / "schema.json"
    assert S.main(["--schema", str(out)]) == 0
    assert json.loads(out.read_text()) == S.QUERY_SCHEMA


def test_speed_700_entries():
    f = fx()
    entries, comps = [], {}
    for k in range(18):
        for e in f["entries"]:
            sid = f"{e['id']}_{k}"
            entries.append(dict(e, id=sid))
            if e["id"] in f["components"]:
                comps[sid] = f["components"][e["id"]]
    entries = entries[:700]
    S.run_query({"ion": "OVI", "sep_kms": [30, 80]}, entries, comps)
    t0 = time.perf_counter()
    for _ in range(5):
        S.run_query({"ion": "OVI", "sep_kms": [30, 80]}, entries, comps)
    assert (time.perf_counter() - t0) / 5 <= 0.05


# ------------------------------------------------------------------------------- lower limits (owner decision 2)
def _c(v, logN, flag=0, lo=None, region=0):
    c = {"v": v, "dv": 0.1, "logN": logN, "dlogN": None if flag & 32 else 0.01, "b": 20.0, "db": 0.2,
         "region": region, "flag": flag, "EW": 10.0}
    if lo is not None:
        c["logN_lo"] = lo
    return c


def test_lower_limit_rule():
    assert S.is_lower_limit(_c(0, 15, 1)) and S.is_lower_limit(_c(0, 15, 33)) and S.is_lower_limit(_c(0, 15, 32))
    assert not S.is_lower_limit(_c(0, 20.3, 65)) and not S.is_lower_limit(_c(0, 13, 2 | 8 | 128))   # DAMPED; others
    assert S.is_lower_limit(_c(0, 20.3, 65 | 32))                                                  # NOERR always
    assert S.limit_logN(_c(0, 17.91, 33, 15.1)) == 15.1 and S.limit_logN(_c(0, 14.0, 1, 14.6)) == 14.0
    assert S.limit_logN(_c(0, 14.0, 1)) == 14.0 and S.column(_c(0, 13.0, 0, 12.0)) == 13.0       # a value ignores lo


def test_lower_limit_predicates_score_and_reason():
    es = [{"id": "edge_b010_a000", "orientation": "edge-on", "b_kpc": 10}]
    cs = {"edge_b010_a000": {"HI": [_c(-60, 17.91, 33, 15.1), _c(10, 20.3, 65), _c(80, 14.2)]}}
    r = S.run_query({"ion": "HI", "logN_min": 15}, es, cs)
    assert r[0]["n"] == 2 and r[0]["reason"] == "2 H I components, logN 15.1–20.3 (1 lower limit), b 20–20 km/s, 10 kpc"
    assert r[0]["score"] == pytest.approx(1.775 + 2.0 - 1.0, abs=1e-12)        # the limit scores at 15.1, not 17.91
    assert [c["v"] for c in S.run_query({"ion": "HI", "logN_min": 15.5}, es, cs)[0]["components"]] == [10]
    assert -60 not in [c["v"] for c in S.run_query({"ion": "HI", "logN_max": 21}, es, cs)[0]["components"]]
    assert S.run_query({"ion": "HI", "logN_max": 22.5}, es, cs)[0]["n"] == 3      # the ion ceiling = unbounded
    assert S.run_query({"ion": "HI", "logN_min": 15, "logN_max": 19}, es, cs) == []


def test_annotate_limits_share_rule():
    comps = {"HI": [_c(-60, 17.91, 33, region=0), _c(10, 13.0, 0, region=1)], "OVI": []}
    aod = {"HI": [15.3, [[0, -200, 0, 15.1], [1, 0, 100, 13.0]]]}
    out = S.annotate_limits(comps, aod)
    assert out["HI"][0]["logN_lo"] == 15.1 and "logN_lo" not in out["HI"][1] and out["OVI"] == []
    assert "logN_lo" not in comps["HI"][0]                                       # inputs untouched
    assert S.annotate_limits(comps, None)["HI"][0].get("logN_lo") is None
    # measured neighbours are subtracted; two limits share what is left in proportion to their fitted N
    m = S.annotate_limits({"MgII": [_c(0, 15.0, 1), _c(9, 14.5, 33), _c(30, 13.6, 0)]},
                          {"MgII": [14.2, [[0, -40, 40, 14.2]]]})["MgII"]
    left = 10 ** 14.2 - 10 ** 13.6
    assert math.log10(10 ** m[0]["logN_lo"] + 10 ** m[1]["logN_lo"]) == pytest.approx(math.log10(left), abs=2e-3)
    assert m[0]["logN_lo"] - m[1]["logN_lo"] == pytest.approx(0.5, abs=2e-3)
    # measured components above the region column: the region is shared over all of them by fitted N
    z = S.annotate_limits({"SiII": [_c(0, 14.0, 1), _c(30, 14.3, 0)]}, {"SiII": [14.2, [[0, -30, 60, 14.2]]]})["SiII"]
    assert z[0]["logN_lo"] == pytest.approx(14.2 + 14.0 - math.log10(10 ** 14.0 + 10 ** 14.3), abs=1e-3)


def test_golden_limit_cases():
    g = {c["name"]: c for c in json.loads(GOLDEN.read_text())["cases"]}
    for name in ("limits_meet_logN_min", "limits_never_meet_logN_max", "limits_at_ceiling", "hi_limit_below_floor",
                 "hi_degenerate_window"):
        q = g[name]["query"]
        for r in g[name]["results"]:
            for c in r["components"]:
                if S.is_lower_limit(c):
                    assert S.limit_logN(c) >= q.get("logN_min", -math.inf)
                    assert q.get("logN_max", S.LOGN_MAX[q["ion"]]) >= S.LOGN_MAX[q["ion"]]
                else:
                    assert q.get("logN_min", -math.inf) <= c["logN"] <= q.get("logN_max", math.inf)
    assert any(S.is_lower_limit(c) for r in g["limits_at_ceiling"]["results"] for c in r["components"])
    assert not any(S.is_lower_limit(c) for r in g["limits_never_meet_logN_max"]["results"] for c in r["components"])
