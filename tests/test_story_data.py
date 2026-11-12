"""Story data for the Learn page "How a spectrum is made" (PLAN_final section 6).

Reads only the shipped files in docs/tng50/learn/how-a-spectrum-is-made/data (no cutout, no library needed), plus
the stored library sightline when it is on disk (skipped otherwise). Every story listed in data/index.json is checked,
so a story exported for another galaxy is held to the same rules as the reference one (488530, rand_b062_a062).
"""
import gzip
import json
import math
import os
import re
import sys
from pathlib import Path

import numpy as np
import pytest

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / "docs" / "tng50" / "learn" / "how-a-spectrum-is-made"
DATA = ROOT / "data"
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO))

GZ_BUDGET = 80 * 1024
DF_MAX = {"HI": 2e-3, "OVI": 3e-4}
KB, AMU = 1.380649e-16, 1.66053906660e-24


def _index():
    p = DATA / "index.json"
    if not p.exists():
        pytest.skip("story data not exported yet (scripts/export_story_data.py)")
    return json.loads(p.read_text())


def _stories():
    p = DATA / "index.json"
    if not p.exists():
        return []
    return [(e["galaxy"], e["ray"]) for e in json.loads(p.read_text())["stories"]]


STORIES = _stories() or [(488530, "rand_b062_a062")]


def _load(gid, ray):
    p = DATA / f"story_{gid}_{ray}.json"
    if not p.exists():
        pytest.skip(f"{p.name} missing")
    return json.loads(p.read_text(encoding="utf-8")), p


def _fits(gid, ray):
    p = DATA / f"page_fits_{gid}_{ray}.json"
    if not p.exists():
        pytest.skip(f"{p.name} missing (node scripts/story_fits.mjs)")
    return json.loads(p.read_text())


def _voigt(a, x):
    from scipy.special import wofz
    return wofz(x + 1j * np.asarray(a)).real


def _cellsum(d, key, v):
    ion = d["ions"][key]; c = ion["cells"]
    k = ion["atom"]["k_tau"]
    tau = np.zeros_like(v)
    for lN, Vi, b, a in zip(c["logN"], c["V"], c["b"], c["a"]):
        if lN is None or not b:
            continue
        tau += k * 10 ** lN * _voigt(a, (v - Vi) / b) / b
    return tau


def _grid(d):
    g = d["meta"]["grid"]
    return np.arange(g["V0"], g["V1"] + 1e-9, g["dV"])


def test_index_default():
    ix = _index()
    assert ix["schema"] == "story-index/1"
    assert ix["default"] == {"galaxy": 488530, "ray": "rand_b062_a062"}
    assert (DATA / ix["fion"]).exists()
    assert any((e["galaxy"], e["ray"]) == (488530, "rand_b062_a062") for e in ix["stories"])


@pytest.mark.parametrize("gid,ray", STORIES)
def test_schema_and_size(gid, ray):
    d, p = _load(gid, ray)
    assert d["meta"]["schema"] == "story-data/1"
    assert d["meta"]["galaxy"] == gid and d["meta"]["ray"] == ray
    gz = len(gzip.compress(p.read_bytes(), 9))
    assert gz <= GZ_BUDGET, f"{p.name}: {gz} B gz"
    n = d["meta"]["n_cells"]
    for key in ("HI", "OVI"):
        ion = d["ions"][key]
        for k in ("l_kpc", "dl_kpc", "nH", "T", "Z", "V", "f_ion", "logN", "b", "tau0", "a"):
            assert len(ion["cells"][k]) == n, (key, k)
        assert set(ion["totals"]) >= {"logN", "ew_mA", "peak_tau", "n_vis", "n_half"}
        assert set(ion["library"]) >= {"keys", "comps", "aod"}
        assert len(ion["F_intrinsic"]) == _grid(d).size
        assert all(0 <= f <= 1 for f in ion["F_intrinsic"])


@pytest.mark.parametrize("gid,ray", STORIES)
def test_total_column_matches_library(gid, ray):
    d, _ = _load(gid, ray)
    for key in ("HI", "OVI"):
        t = d["ions"][key]["totals"]
        assert abs(t["logN"] - t["logN_library"]) < 1e-4            # rounded to 4 decimals in the file
        assert d["meta"]["checks"][key]["dlogN"] < 1e-6             # full precision, at export
        lN = np.array([x for x in d["ions"][key]["cells"]["logN"] if x is not None])
        assert abs(math.log10(np.sum(10 ** lN)) - t["logN"]) < 2e-4  # the page's own sum of the rounded cells


@pytest.mark.parametrize("gid,ray", STORIES)
def test_cell_sum_reproduces_spectrum(gid, ray):
    """The rounded per-cell columns, summed as the page will (Voigt per cell), give the stored spectrum."""
    d, _ = _load(gid, ray)
    v = _grid(d)
    for key in ("HI", "OVI"):
        chk = d["meta"]["checks"][key]
        assert chk["max_abs_dF_cellsum_vs_stored"] < DF_MAX[key]   # native grid, at export
        assert chk["EW_rel"] < 1e-3
        F = np.array(d["ions"][key]["F_intrinsic"])
        Fc = np.exp(-_cellsum(d, key, v))
        assert np.max(np.abs(Fc - F)) < DF_MAX[key] + 1e-5, key  # + the 5-decimal rounding of F_intrinsic
        lam0 = d["ions"][key]["atom"]["lam0_A"]
        ew = lambda f: np.sum(1 - f) * (v[1] - v[0]) * lam0 / 299792.458 * 1e3
        assert abs(ew(Fc) / ew(F) - 1) < 1e-3


@pytest.mark.parametrize("gid,ray", STORIES)
def test_ion_density_identities(gid, ray):
    d, _ = _load(gid, ray)
    assert d["meta"]["checks"]["HI"]["nHI_over_xHI_nH_minus1"] < 1e-12
    hi = d["ions"]["HI"]; c = hi["cells"]
    KPC = 3.0856775814913673e21
    for i in range(0, d["meta"]["n_cells"], 7):
        if c["logN"][i] is None or not c["f_ion"][i]:
            continue
        n_from_cols = c["f_ion"][i] * c["nH"][i] * c["dl_kpc"][i] * KPC
        assert abs(10 ** c["logN"][i] / n_from_cols - 1) < 2e-3      # 4 significant figures each


@pytest.mark.parametrize("gid,ray", STORIES)
def test_tau0_and_b_columns(gid, ray):
    d, _ = _load(gid, ray)
    for key, m in (("HI", 1.00794), ("OVI", 15.9994)):
        ion = d["ions"][key]; c = ion["cells"]
        assert ion["atom"]["mass_amu"] == m
        b = np.sqrt(2 * KB * np.array(c["T"]) / (m * AMU)) / 1e5
        assert np.allclose(c["b"], b, rtol=1e-3)
        lN, bb, a = np.array(c["logN"], float), np.array(c["b"]), np.array(c["a"])
        t0 = 1.4975e-15 * 10 ** lN * ion["atom"]["f"] * ion["atom"]["lam0_A"] / bb * _voigt(a, 0.0)
        assert np.allclose(c["tau0"], t0, rtol=2e-3)


@pytest.mark.parametrize("gid,ray", STORIES)
def test_selections(gid, ray):
    d, _ = _load(gid, ray)
    s, c = d["select"], d["ions"]["OVI"]["cells"]
    hiN = np.array(d["ions"]["HI"]["cells"]["logN"], float); ovN = np.array(c["logN"], float)
    assert s["S4a_cell"] == int(np.nanargmax(hiN)) and s["S4b_cell"] == s["S5_cell"] == int(np.nanargmax(ovN))
    if s["S6_pair"]:
        i, j = s["S6_pair"]["cells"]
        b = c["b"]
        assert abs(c["V"][i] - c["V"][j]) < min(b[i], b[j])          # "same speed, same dip"
        assert abs(c["l_kpc"][j] - c["l_kpc"][i]) >= 50
    f = s["S10_feature"]
    if f:
        v = _grid(d)
        F = np.array(d["ions"]["OVI"]["F_intrinsic"])
        k = int(np.argmin(np.abs(v - f["V_kms"])))
        assert -math.log(F[k]) > 0.05                                # the highlighted feature is in the truth


@pytest.mark.parametrize("gid,ray", STORIES)
def test_worked_numbers_recompute(gid, ray):
    d, _ = _load(gid, ray)
    w = d["worked"]["S5"]
    ion = d["ions"]["OVI"]
    a = ion["atom"]["a0_kms"] / w["b"]
    t0 = 1.4975e-15 * 10 ** w["logN"] * w["f"] * w["lam0_A"] / w["b"] * _voigt(a, 0.0)
    assert abs(t0 / w["tau0"] - 1) < 5e-3
    assert abs(math.exp(-w["tau0"]) - w["centre_light"]) < 5e-3
    assert d["worked"]["S8"]["peak_tau"] == d["ions"]["HI"]["totals"]["peak_tau"]


def test_reference_story_numbers():
    """The storyboard numbers of PLAN_final section 3 (488530, rand_b062_a062)."""
    d, _ = _load(488530, "rand_b062_a062")
    k, s, w = d["keys"], d["select"], d["worked"]
    assert d["meta"]["n_cells"] == 672
    assert (s["S4a_cell"], s["S4b_cell"]) == (492, 263)
    assert s["S6_pair"]["cells"] == [296, 438] and k["s6_dl_kpc"] == "84"
    assert (k["ovi_n_half"], k["hi_n_half"], k["ovi_n_visible"]) == ("4", "3", "49")
    assert (k["s5_logN"], k["s5_b"], k["s5_tau0"], k["s5_centre_pct"]) == ("14.16", "17.3", "1.73", "18")
    assert (k["ovi_logN"], k["hi_logN"], k["ovi_EW"], k["ovi_peak_tau"]) == ("14.77", "18.04", "435", "3.06")
    assert k["hi_peak_tau"] == "22 723" and k["s5_bH"] == "69" and k["R200c_kpc"] == "246"
    assert (k["s4a_T"], k["s4a_xHI"], k["s4b_fOVI"]) == ("13 160", "0.29", "0.23")
    assert k["b_ly"] == "202 000" and k["length_kpc"] == "493"
    assert (k["fwhm_150000"], k["fwhm_30000"], k["fwhm_15000"], k["fwhm_5000"]) == ("2.0", "10.0", "20.0", "60.0")
    assert (k["s10_sigma"], k["s10_dvpix"]) == ("0.22", "2.0")
    assert (k["ovi_aod_lo"], k["ovi_aod_hi"]) == ("-199", "190")
    assert w["S10"]["feature"] is not None


def test_reference_fits():
    f = _fits(488530, "rand_b062_a062")
    k = f["facts"]
    assert f["schema"] == "story-fits/1" and f["params"]["capMs"] >= 1e9
    assert f["keys"][:3] == ["v", "dv", "logN"]
    d, _ = _load(488530, "rand_b062_a062")
    assert all(d["keys"][x] == v for x, v in k.items())          # the facts are merged into the story keys
    assert (k["s11_total_logN"], k["s11_v"], k["s11_b"], k["s11_noise_seed"]) == ("14.72", "-62, +10, +79", "30, 17, 34", "986299851")
    assert (k["broad_b"], k["broad_R"], k["broad_sn"]) == ("141", "15000", "5")
    assert (k["invented_b"], k["invented_T"], k["invented_total_logN"]) == ("3.1", "9400", "14.95")


@pytest.mark.parametrize("gid,ray", STORIES)
def test_fits_file(gid, ray):
    f = _fits(gid, ray)
    assert f["galaxy"] == gid and f["ray"] == ray
    assert len(gzip.compress(json.dumps(f).encode())) <= 12 * 1024
    for x in f["cases"]:
        h = x["handoff"]
        assert h["layout"] in ("1", "2R", "2SN", "4") and h["id"] == ray and len(h["sn"]) == 2
        assert x["status"] == "ok" and (x["comps"] or gid != 488530)
    assert len(f["select"]["s11a"]) == 3


def test_template_keys_resolve():
    """Every {{key}} in steps.json (U4) resolves from the story and fits data; keys are non-empty strings."""
    keys = {}
    for gid, ray in STORIES:
        d, _ = _load(gid, ray)
        ks = dict(d["keys"])
        p = DATA / f"page_fits_{gid}_{ray}.json"
        if p.exists():
            ks.update(json.loads(p.read_text())["facts"])
        assert all(isinstance(v, str) and v for v in ks.values())
        if gid == 488530:
            keys = ks
    steps = ROOT / "steps.json"
    if not steps.exists():
        pytest.skip("steps.json not written yet")
    st = json.loads(steps.read_text(encoding="utf-8"))
    body = json.dumps(st.get("steps", st), ensure_ascii=False)               # meta notes may quote "{{key}}" itself
    used = set(re.findall(r"\{\{\s*([A-Za-z0-9_.]+)\s*\}\}", body))
    missing = sorted(used - set(keys))
    assert not missing, f"unresolved {{{{key}}}} in steps.json: {missing}"


def test_fion_slice():
    p = DATA / "fion_OVI_slice.json"
    if not p.exists():
        pytest.skip("fion slice missing")
    f = json.loads(p.read_text())
    assert len(gzip.compress(p.read_bytes(), 9)) <= 8 * 1024
    assert len(f["f_slices"]) == 5 and all(len(r) == len(f["logT"]) for r in f["f_slices"])
    assert all(0 <= x <= 1 for r in f["f_slices"] for x in r)
    for x, t, r in zip(f["logNH_slices"], f["logT_peak_per_slice"], f["f_slices"]):
        if x >= -4.5:
            assert 5.2 <= t <= 5.7, (x, t)                                  # the collisional O VI peak
        i6 = f["logT"].index(6.3)
        assert r[i6] < 0.1 * max(r), x                                      # "too hot and it loses more electrons"
    # the sliders' grid reproduces the cell's own fraction (cell 263: f_OVI = 0.23 at n_H 1.9e-4, T 2.87e5 K)
    d, _ = _load(488530, "rand_b062_a062")
    i = d["select"]["S4b_cell"]
    g = f["grid"]
    from scipy.interpolate import RegularGridInterpolator
    it = RegularGridInterpolator((g["logNH"], g["logT"]), np.array(g["log10_f"]))
    c = d["ions"]["OVI"]["cells"]
    lf = float(it([[math.log10(c["nH"][i]), math.log10(c["T"][i])]])[0])
    assert abs(lf - math.log10(c["f_ion"][i])) < 0.05


def test_private_index_guard(tmp_path, monkeypatch):
    import export_story_data as E
    paths = E.galaxy_paths(488530, library=tmp_path / "lib", cutout=tmp_path / "c.hdf5")
    work = tmp_path / "work"
    monkeypatch.delenv("TNG_INDEX_FILE", raising=False)
    with pytest.raises(SystemExit):
        E.check_private_index(work, paths)
    monkeypatch.setenv("TNG_INDEX_FILE", str(tmp_path / "c.hdf5.ewah"))      # the cutout's shared sibling index
    with pytest.raises(SystemExit):
        E.check_private_index(work, paths)
    monkeypatch.setenv("TNG_INDEX_FILE", str(tmp_path / "elsewhere" / "x.ewah"))
    with pytest.raises(SystemExit):
        E.check_private_index(work, paths)
    monkeypatch.setenv("TNG_INDEX_FILE", str(work / "job_1" / "cutout.ewah"))
    assert E.check_private_index(work, paths).name == "cutout.ewah"


def test_galaxy_paths_any_host(monkeypatch, tmp_path):
    import export_story_data as E
    monkeypatch.setenv("TNG_WORK", str(tmp_path))
    monkeypatch.delenv("TNG_MWM31_ROOT", raising=False)
    p = E.galaxy_paths(411449)                     # no slim cutout yet: the raw cutout every one of the 198 hosts has
    assert p["cutout"] == tmp_path / "data/mwm31/10_raw/snap_099/subhalo_411449/snap_99.hdf5"
    slim = tmp_path / "data/gal/411449/cutout_slim_R400.hdf5"
    slim.parent.mkdir(parents=True); slim.write_bytes(b"")
    p = E.galaxy_paths(411449)
    assert p["cutout"] == slim
    assert p["library"] == tmp_path / "data/gal/411449/library"
    assert p["galaxy_json"] == tmp_path / "data/gal/411449/galaxy.json"
    assert E.galaxy_paths(488530)["galaxy_json"].name == "galaxy_488530.json"


def test_against_stored_library():
    """Totals and the AOD record against the library files themselves, when they are on disk."""
    work = Path(os.environ.get("TNG_WORK") or "/Volumes/cgm_work")
    lib = Path(os.environ.get("TNG_STORY_LIBRARY") or work / "data" / "library_v3r")
    npz = lib / "sightlines" / "rand_b062_a062.npz"
    if not npz.exists():
        pytest.skip("library_v3r not on disk")
    from tngsight.library import load_npz
    p = load_npz(str(npz), id="rand_b062_a062")
    comp = json.loads((lib / "components" / "rand_b062_a062.json").read_text())
    d, _ = _load(488530, "rand_b062_a062")
    for key in ("HI", "OVI"):
        assert abs(d["meta"]["checks"][key]["logN_library"] - float(p["logN"][key])) < 1e-12
        assert d["ions"][key]["library"]["aod"]["logN"] == comp["aod"][key][0]
    assert abs(d["meta"]["v_sys_kms"] - float(p["v_sys"])) < 1e-3


def test_transfer_geometry_reproduces_pipeline():
    """A host without a library gets the ray the galaxy pipeline would cast (checked on the hosts that have one)."""
    import export_story_data as E
    from tngsight.library import load_npz
    hosts = [g for g in (411449, 505100) if (E.galaxy_paths(g)["library"] / "sightlines").exists()]
    if not hosts or not (E.galaxy_paths(488530)["library"] / "sightlines").exists():
        pytest.skip("galaxy libraries not on disk")
    for gid in hosts:
        P = E.galaxy_paths(gid)
        gal = json.loads(P["galaxy_json"].read_text())
        for ray in ("rand_b062_a062", "face_b050_a090", "edge_b100_a090"):
            got = E.transfer_geometry(E.reference_geom(ray), gal)
            want = load_npz(str(P["library"] / "sightlines" / f"{ray}.npz"), id=ray)["geom"]
            for k in ("n_los", "anchor_kpc", "start_ckpch", "end_ckpch"):
                assert np.allclose(got[k], want[k], rtol=0, atol=1e-9), (gid, ray, k)
            assert abs(got["v_sys_kms"] - want["v_sys_kms"]) < 1e-9 and abs(got["half_kpc"] - want["half_kpc"]) < 1e-9


def test_n_galaxies_key():
    d, _ = _load(488530, "rand_b062_a062")
    assert d["keys"]["ngal"] == str(d["meta"]["n_galaxies"]) == "198"


# ----------------------------------------------------------------------------------------------- review H1 / F9
NA = "–"


def _resolve(text, keys, spec):
    def one(m):
        k = m.group(1)
        if k in keys:
            return keys[k]
        sp = spec.get(k) or {}
        return str(sp.get("fallback", "{{" + k + "}}"))
    return re.sub(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}", one, text)


def _texts(step):
    out = [step.get(f) for f in ("text", "sub", "aria", "caption", "title")]
    out.append((step.get("physics") or {}).get("line"))
    return [t for t in out if isinstance(t, str)]


def test_every_step_reads_true_for_every_listed_story():
    """Each eligible story in data/index.json: every step's text resolves with no '–' and no unresolved key, and the
    wording that depends on the galaxy (Lyman-limit clause, saturation phrase, Milky Way comparison) agrees with the
    numbers; the shipped eligibility flag equals export_story_data.story_facts on the file itself."""
    import export_story_data as X
    idx = _index()
    st = json.loads((ROOT / "steps.json").read_text(encoding="utf-8"))
    spec = st.get("keys", {})
    for e in idx["stories"]:
        d, _ = _load(e["galaxy"], e["ray"])
        pf = DATA / e["page_fits"] if e.get("page_fits") else None
        pf = json.loads(pf.read_text()) if pf and pf.exists() else None
        _, verdict = X.story_facts(d, pf)
        assert d.get("story", {}).get("eligible") == verdict["eligible"] == e.get("eligible", verdict["eligible"]), \
            f"{e['galaxy']}: shipped eligibility differs from story_facts ({verdict['fails']})"
        if not verdict["eligible"]:
            continue                                     # never shown as its own story (page and engine fall back)
        keys = dict(d["keys"])
        if pf:
            keys.update(pf.get("facts", {}))
        hi, ov = d["ions"]["HI"]["totals"], d["ions"]["OVI"]["totals"]
        for s in st["steps"]:
            for t in _texts(s):
                r = _resolve(t, keys, spec)
                assert "{{" not in r, f"{e['galaxy']} {s['id']}: unresolved key in {r!r}"
                assert NA not in r, f"{e['galaxy']} {s['id']}: '–' on screen in {r!r}"
                if "a Lyman-limit system" in r and "below" not in r:
                    assert hi["logN"] >= X.LLS_LOGN, f"{e['galaxy']} {s['id']}: LLS claim at log N {hi['logN']}"
                if "mostly unsaturated" in r:
                    assert ov["peak_tau"] < 5, f"{e['galaxy']} {s['id']}: 'mostly unsaturated' at peak tau {ov['peak_tau']}"
                if "Milky Way" in r and "Milky-Way" not in r:
                    assert X.mw_compare(d["meta"]["M200c_Msun"]) in r or "Milky Way" not in keys.get("mw_compare", "")


def test_eligibility_rejects_weak_sightlines():
    """story_facts marks a weak sightline (no strong O VI, no black H I, no pair, no fits) ineligible, and keeps the
    reference story eligible; the galaxy-dependent phrases follow the numbers."""
    import copy
    import export_story_data as X
    d, _ = _load(488530, "rand_b062_a062")
    pf = _fits(488530, "rand_b062_a062")
    k, v = X.story_facts(d, pf)
    assert v["eligible"], v["fails"]
    assert k["s5_cell"] == str(d["select"]["S5_cell"]) and k["hi_lls"].startswith("above")
    w = copy.deepcopy(d)
    w["ions"]["OVI"]["totals"].update(peak_tau=0.04, b_visible=None)
    w["ions"]["HI"]["totals"].update(peak_tau=0.03, logN=13.07)
    w["select"]["S6_pair"] = None
    w["meta"]["M200c_Msun"] = 3.9e12
    k, v = X.story_facts(w, None)
    assert not v["eligible"] and len(v["fails"]) >= 4
    assert k["hi_lls"].startswith("below") and k["mw_compare"] != "somewhat bigger than the Milky Way"
    assert k["ovi_sat"] == "is mostly unsaturated" and k["s6_cell_a"] == NA
