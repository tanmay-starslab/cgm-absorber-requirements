"""absreq/data/instruments.json: every number has a source, the proposed entry stays hidden until filled."""
import copy
import pytest
from absreq import instruments as instr
from absreq.lines import cgm_lines

D = instr.load()


def test_validates_and_every_number_has_a_source():
    instr.validate(D)
    for ins in D["instruments"]:
        for m in ins["modes"]:
            for k in instr.FIELDS:
                if m.get(k) is not None:
                    assert m["sources"][k] in D["references"], (ins["name"], k)
    for ref in D["references"].values():
        assert ref["cite"] and ref["url"].startswith("https://")


def test_proposed_is_hidden_while_null():
    (p,) = [i for i in D["instruments"] if i.get("proposed")]
    assert "fill R, S/N, name to show" in p["comment"]
    if p["name"] is None or any(m["R"] is None for m in p["modes"]):
        assert p["show"] is False
    bad = copy.deepcopy(D)
    next(i for i in bad["instruments"] if i.get("proposed"))["show"] = True
    with pytest.raises(ValueError):
        instr.validate(bad)


def test_unsourced_number_is_rejected():
    bad = copy.deepcopy(D)
    bad["instruments"][0]["modes"][0]["sources"]["R"] = None
    with pytest.raises(ValueError):
        instr.validate(bad)


def test_coverage_at_z0():
    got = {L.key: {m["label"] for m in instr.markers(L.lam)} for L in cgm_lines()}
    assert got["OVI1032"] == {"COS G130M", "FUSE"}
    assert got["CIV1548"] == {"COS G160M", "STIS E140M", "STIS E140H"}
    assert got["MgII2796"] == {"STIS E230M", "STIS E230H"}
    assert got["NeVIII770"] == got["OVII21p6"] == set()
    assert all("LUMOS" not in s for s in got.values())       # concept entry is hidden


def test_filled_proposed_entry_appears():
    d = copy.deepcopy(D)
    p = next(i for i in d["instruments"] if i.get("proposed"))
    p.update(name="Test", label="Test", show=True)
    p["modes"][0].update(setting="FUV", lam=[1000, 2000], R=30000, snr=20,
                         sources=dict(lam="cos_ihb", R="cos_ihb", snr="cos_ihb"))
    (m,) = [m for m in instr.markers(1548.2, d) if m["proposed"]]
    assert (m["R_lo"], m["R_hi"], m["snr"]) == (30000, 30000, 20)
