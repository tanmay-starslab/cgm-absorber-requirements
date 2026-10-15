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
    assert len(g["cases"]) == 23 and g["query_schema"] == S.QUERY_SCHEMA
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
    assert r["id"] == "face_b010_a000" and r["n"] == 4 and r["b_kpc"] == 100.0
    # |(-127.99) - (-157.99)| = 30.000000000000014 in IEEE doubles: only matches after the 1e-6 rounding
    assert abs(-127.99 - -157.99) != 30.0
    assert r["pairs"] == [[0, 1, 30.0], [0, 2, 30.0]]
    assert [c["idx"] for c in r["components"]] == [0, 1, 2]
    # 1.375 + 1.375 + 1.0625 − 0.5 (one SAT) + 0.25·2 pairs
    assert r["score"] == pytest.approx(3.8125, abs=1e-12)
    assert r["reason"] == "4 O VI components, logN 12.3–13.5, b 13–20 km/s, Δv 30 km/s, 100 kpc"


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
