"""Story data for the Learn page "How a spectrum is made" (PLAN_final section 6).

Reads only the shipped files in docs/tng50/learn/how-a-spectrum-is-made/data (no cutout, no library needed), plus
the stored library sightline when it is on disk (skipped otherwise). Every story listed in data/index.json is checked,
so a story exported for another galaxy is held to the same rules as the reference one (488530, rand_b062_a062).
"""
import copy
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

GZ_BUDGET = 140 * 1024          # story-data/2: kernel geometry + kernel CDF table
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
    assert d["meta"]["schema"] == "story-data/2"
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
        empty = np.isnan(lN)                                         # no ion in the cell (logN null): tau0 = 0
        assert np.all(np.array(c["tau0"], float)[empty] == 0)
        assert np.allclose(np.array(c["tau0"], float)[~empty], t0[~empty], rtol=2e-3)


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
    checked = 0
    for gid in hosts:
        P = E.galaxy_paths(gid)
        gal = json.loads(P["galaxy_json"].read_text())
        for ray in ("rand_b062_a062", "face_b050_a090", "edge_b100_a090"):
            if not (P["library"] / "sightlines" / f"{ray}.npz").exists():   # host libraries since renamed (_s<seed>)
                continue
            checked += 1
            got = E.transfer_geometry(E.reference_geom(ray), gal)
            want = load_npz(str(P["library"] / "sightlines" / f"{ray}.npz"), id=ray)["geom"]
            for k in ("n_los", "anchor_kpc", "start_ckpch", "end_ckpch"):
                assert np.allclose(got[k], want[k], rtol=0, atol=1e-9), (gid, ray, k)
            assert abs(got["v_sys_kms"] - want["v_sys_kms"]) < 1e-9 and abs(got["half_kpc"] - want["half_kpc"]) < 1e-9
    if not checked:
        pytest.skip("no host library holds the reference ray ids")


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


# ================================================================================================ story-data/2 (v2)
# DESIGN_final section 5.1 acceptance: kernel geometry, stateless tau, clouds rebuilt on the story ray, tube, keys.
CLOUD_PTS_B, TUBE_B = 11, 14


def _geo(d):
    g = d["geometry"]
    c = g["cells"]
    return {k: np.asarray(c[k], float) for k in ("h", "d", "lc", "s_in", "s_out")}, np.asarray(g["kernel_cdf"]["table"])


def _kcdf(tab, q, u):
    nq, nu = tab.shape
    q = np.clip(q, 0, 1) * (nq - 1); u = (np.clip(u, -1, 1) + 1) * 0.5 * (nu - 1)
    i = np.minimum(np.floor(q).astype(int), nq - 2); j = np.minimum(np.floor(u).astype(int), nu - 2)
    tq, tu = q - i, u - j
    return ((1 - tq) * (1 - tu) * tab[i, j] + tq * (1 - tu) * tab[i + 1, j] + (1 - tq) * tu * tab[i, j + 1]
            + tq * tu * tab[i + 1, j + 1])


def _W(d, s):
    g, tab = _geo(d)
    c = np.sqrt(g["h"] ** 2 - g["d"] ** 2)
    return _kcdf(tab, g["d"] / g["h"], (s - g["lc"]) / c)


def _taumat(d, key, v):
    ion = d["ions"][key]; c = ion["cells"]
    N = np.array([10 ** x if x is not None else 0.0 for x in c["logN"]])
    b = np.array(c["b"], float); a = np.array(c["a"], float); V = np.array(c["V"], float)
    k = ion["atom"]["k_tau"]
    return np.array([k * Ni * _voigt(ai, (v - Vi) / bi) / bi if Ni > 0 and bi > 0 else np.zeros_like(v)
                     for Ni, Vi, bi, ai in zip(N, V, b, a)]), N


def _clouds(d):
    p = DATA / d["clouds"]["path"]
    if not p.exists():
        pytest.skip(f"{p} missing (scripts/build_story_clouds.py)")
    return json.loads(p.read_text()), p.parent


@pytest.mark.parametrize("gid,ray", STORIES)
def test_v2_geometry_columns(gid, ray):
    d, _ = _load(gid, ray)
    g, tab = _geo(d)
    n = d["meta"]["n_cells"]
    assert d["geometry"]["n_kernels"] == n == len(g["lc"]) and d["geometry"]["cells"]["idx"] == list(range(n))
    assert len(d["geometry"]["cells"]["centre"]) == 3 * n
    assert np.all(np.diff(g["lc"]) >= 0), "cells sorted by l"
    assert np.all(g["d"] < g["h"]) and np.all(g["s_in"] < g["lc"]) and np.all(g["lc"] < g["s_out"])
    c = np.sqrt(g["h"] ** 2 - g["d"] ** 2)
    # h and d are stored to 4 decimals; for a grazing kernel (d -> h) the chord 2c = 2 sqrt(h^2 - d^2) amplifies that
    # rounding by (h + d) / c, so the tolerance carries the propagated rounding error
    tol = 2e-3 + 2 * 5e-5 * (g["h"] + g["d"]) / np.maximum(c, 1e-6)
    assert np.all(np.abs(g["s_out"] - g["s_in"] - 2 * c) <= tol)
    ch = d["geometry"]["checks"]
    assert ch["dl_kernel_vs_yt_max_rel"] < 2e-3 and ch["l_proj_vs_yt_max_kpc"] < 0.02 and ch["sorted_by_l"]
    # the beads are kernels; the crossed cells are a computed subset (n_crossed is not typed)
    cr = d["geometry"]["crossed"]
    nc, out = d["geometry"]["n_crossed"], d["geometry"].get("n_crossed_outside_kernels", 0)
    assert nc == d["facts2"]["n_crossed"] and set(cr) <= set(range(n))
    assert len(cr) == nc - out and 0 <= out <= 0.01 * nc
    assert abs(d["geometry"]["checks"]["n_crossed_in_kernel_set_frac"] - len(cr) / nc) < 1e-12
    if (gid, ray) == (488530, "rand_b062_a062"):
        assert out == 0
    # ray: p0 + L n = p1, l = 0 at the midpoint
    r = d["geometry"]["ray"]
    assert np.allclose(np.array(r["p0"]) + r["L"] * np.array(r["n"]), r["p1"], atol=2e-3)
    assert abs(r["half"] - d["meta"]["half_kpc"]) < 2e-3


def test_v2_kernel_table_exact():
    import export_story_data as E
    d, _ = _load(488530, "rand_b062_a062")
    tab = np.asarray(d["geometry"]["kernel_cdf"]["table"])
    assert np.all(tab[:, 0] == 0) and np.all(tab[:, -1] == 1) and np.all(np.diff(tab, axis=1) >= -1e-12)
    rng = np.random.default_rng(3)
    err = max(float(np.abs(_kcdf(tab, np.full(30, q), u) - E.kernel_chord_cdf(q, u)).max())
              for q, u in ((q, rng.uniform(-1, 1, 30)) for q in rng.uniform(0, 0.999, 30)))
    assert err < 5e-4, err
    # the table is the yt kernel: its full chord column reproduces yt's interpolation table
    from yt.utilities.lib.pixelization_routines import SPHKernelInterpolationTable
    q = np.linspace(0, 0.99, 12)
    col = [2 * float(np.sum(np.polynomial.legendre.leggauss(400)[1] * E.yt_cubic(np.sqrt(x * x + (np.sqrt(1 - x * x) * (
        np.polynomial.legendre.leggauss(400)[0] + 1) / 2) ** 2))) * np.sqrt(1 - x * x) / 2) for x in q]
    yt = SPHKernelInterpolationTable("cubic").interpolate_array(q * q)
    assert np.allclose(col, yt, rtol=2e-3)


@pytest.mark.parametrize("gid,ray", STORIES)
def test_v2_stateless_tau(gid, ray):
    """sum W_i(inf) = 1 per cell; W at s_in = 0 and at s_out = 1 (partial tau at s_out = full tau); end-of-flight
    tau equals the stored spectrum; nothing before the first kernel; collected column monotone in s."""
    d, _ = _load(gid, ray)
    g, _t = _geo(d)
    n = len(g["lc"])
    assert np.allclose(_W(d, g["s_out"].max() + 1), 1.0) and np.allclose(_W(d, g["s_in"].min() - 1), 0.0)
    w_in = np.array([_W(d, s)[i] for i, s in enumerate(g["s_in"])])
    w_out = np.array([_W(d, s)[i] for i, s in enumerate(g["s_out"])])
    # 4-decimal kpc rounding of s_in, s_out, lc, h, d plus the bilinear (q, u) table near q -> 1: a grazing kernel
    # (chord < 0.25 kpc) misses by up to 1.6e-5 (rand_b050_a215, chord 0.12 kpc); every other kernel within 1e-6
    tol = np.where(g["s_out"] - g["s_in"] < 0.25, 1e-4, 1e-6)
    assert np.all(np.abs(w_in) <= tol) and np.all(np.abs(w_out - 1) <= tol)
    v = _grid(d)
    for key in ("HI", "OVI"):
        tm, N = _taumat(d, key, v)
        F = np.array(d["ions"][key]["F_intrinsic"])
        Fend = np.exp(-(_W(d, 1e9) @ tm))
        lim = d["meta"]["checks"][key]["dF_limit"]                   # = DF_MAX on the hero; film beams: exporter's
        if (gid, ray) == (488530, "rand_b062_a062"):
            assert lim == DF_MAX[key]
        assert np.max(np.abs(Fend - F)) < lim + 1e-5, key
        assert d["facts2"]["end_of_flight_max_dF"][key] < lim + 1e-5
        ss = np.linspace(g["s_in"].min(), g["s_out"].max(), 400)
        col = np.array([_W(d, s) @ N for s in ss])
        assert np.all(np.diff(col) >= -1e-6 * N.sum())
    assert n == d["facts2"]["n_kernels"]


@pytest.mark.parametrize("gid,ray", STORIES)
def test_v2_beat_claims_G13(gid, ray):
    """each beat's new-dip key is the argmax of the optical depth gained over its l range, recomputed from the file"""
    d, _ = _load(gid, ray)
    f = d["facts2"]; v = _grid(d)
    tms = {k: _taumat(d, k, v)[0] for k in ("HI", "OVI")}
    for b, (l0, l1) in f["beat_windows"].items():
        for key in ("HI", "OVI"):
            dt = (_W(d, l1) - _W(d, l0)) @ tms[key]
            k = int(np.argmax(dt))
            assert v[k] == f["new_dips"][b][key]["V_argmax"], (b, key)
            assert abs(dt[k] - f["new_dips"][b][key]["dtau_max"]) <= 1e-4 * max(1.0, dt[k]), (b, key)   # rounded columns
    assert f["b9_new_dips"] == f["new_dips"]["B9"]["OVI"]["dips"]
    assert f["b8_new_dips"] == f["new_dips"]["B8"]["OVI"]["dips"]
    dt5 = (_W(d, f["beat_windows"]["B5"][1]) - _W(d, f["beat_windows"]["B5"][0])) @ tms["OVI"]
    assert abs(1 - math.exp(-dt5.max()) - f["b5_ovi_depth"]) < 1e-5
    # positions shown as dips come from spectral minima (H2)
    F = np.array(d["ions"]["OVI"]["F_intrinsic"])
    for V, depth in f["ovi_minima"]:
        k = int(np.argmin(np.abs(v - V)))
        assert abs(1 - F[k] - depth) < 1e-4 and F[k] == F[max(k - 3, 0):k + 4].min()


def test_v2_reference_keys():
    d, _ = _load(488530, "rand_b062_a062")
    f, k = d["facts2"], d["keys"]
    c = d["ions"]["OVI"]["cells"]
    assert (f["n_kernels"], f["n_crossed"]) == (672, 190)
    assert f["cloudA_core_cell"] == 125 and f["S5_cell"] == f["hot_cell"] == 263
    assert (k["cloudA_core_T"], k["cloudA_core_bH"], k["cloudA_core_bO"], k["cloudA_bH_bO"]) == ("1.15×10⁴", "13.8", "3.45", "3.98")
    assert abs(f["cloudA_core_bH"] / f["cloudA_core_bO"] - math.sqrt(15.9994 / 1.00794)) < 1e-9     # E2, M1
    assert f["cloudA_xHI"] == d["ions"]["HI"]["cells"]["f_ion"][125] and f["hot_xHI"] == d["ions"]["HI"]["cells"]["f_ion"][263]
    assert abs(f["xHI_ratio"] - f["cloudA_xHI"] / f["hot_xHI"]) < 1e-6 * f["xHI_ratio"]                  # computed, not typed
    # E4 (M2): V = c(lambda/lambda0 - 1) - v_gal, v_gal = -v_sys; cell 263 -> -51.6 km/s
    assert abs(f["v_gal"] + d["meta"]["v_sys_kms"]) < 1e-3 and k["v_gal"] == "+69.3"
    lam = d["ions"]["OVI"]["atom"]["lam0_A"] * (1 + (c["V"][263] - d["meta"]["v_sys_kms"]) / 299792.458)
    assert abs(299792.458 * (lam / d["ions"]["OVI"]["atom"]["lam0_A"] - 1) - f["v_gal"] - (-51.6)) < 0.05
    assert (k["ovi_frac_half"], k["hi_frac_half"]) == ("69.5", "66.7")
    assert k["b4_first_depth"] == "5.6" and f["b4_first_cell"] == 43
    assert (k["b5_ovi_depth"], k["b5_ovi_V"]) == ("37", "-96")
    assert f["new_dips"]["B7e"]["HI"]["V_argmax"] == 37.0                       # cold knot, H I near +35 (cell 303)
    assert [x[0] for x in f["ovi_minima"]][:2] == [-55.0, 12.0]
    assert f["new_dips"]["B9"]["OVI"]["V_argmax"] == 61.0
    T = f["ovi_T_fade"]
    assert T["slices"] == [-4.0, -3.5] and T["logT_cool_fade"] < T["logT_peak"] < T["logT_hot_fade"]
    # thread facts (S6): 84 kpc apart, dV 4.33 < min b 15.37; clearest of n_pairs
    s6 = d["select"]["S6_pair"]
    assert (s6["cells"], s6["dl_kpc"], s6["dV_kms"], s6["min_b_kms"]) == ([296, 438], 84.0, 4.33, 15.37)
    assert f["n_pairs"] >= 1 and k["n_pairs"] == str(f["n_pairs"])
    assert "ncross" in k                                                        # v1 alias stays in the data ...
    assert k["n_kernels"] == "672" and k["n_crossed"] == "190"                  # ... display copy uses these (M8)


@pytest.mark.parametrize("gid,ray", STORIES)
def test_v2_clouds_on_story_ray(gid, ray):
    d, _ = _load(gid, ray)
    cw, cdir = _clouds(d)
    g, _t = _geo(d)
    n = d["meta"]["n_cells"]
    assert cw["schema"] == "clouds3d/3" and cw["galaxy"] == gid and cw["ray_id"] == ray
    assert np.allclose(cw["ray"]["p0"], d["geometry"]["ray"]["p0"], atol=1e-3)
    for key, ion in cw["ions"].items():
        N = np.array([10 ** x if x is not None else 0.0 for x in d["ions"][key]["cells"]["logN"]]) if key in d["ions"] else None
        for cl in ion["clouds"]:
            m = np.asarray(cl["members"], int)
            assert m.size and set(m.tolist()) <= set(range(n))                     # on-ray members are story cells
            assert abs(cl["l_in"] - g["s_in"][m].min()) < 0.05 and abs(cl["l_out"] - g["s_out"][m].max()) < 0.05
            if N is not None:
                assert abs(cl["logN_ray"] - math.log10(N[m].sum())) < 2e-3
            for kind, f in cl["files"].items():
                raw = gzip.decompress((cdir / f["file"]).read_bytes())
                assert len(raw) == f["raw"]
                if kind == "pts":
                    assert len(raw) == CLOUD_PTS_B * cl["pts"]["n"]                  # 11 B records (DESIGN 1.2 item 2)
                    on = np.frombuffer(raw, np.uint8).reshape(-1, CLOUD_PTS_B)[:, 10]
                    assert int(on.sum()) <= cl["n_members"] and on.max() <= 1
                if kind == "cube":
                    assert len(raw) == int(np.prod(cl["cube"]["shape"]))
                if kind == "mesh":
                    nv, nf = cl["mesh"]["nv"], cl["mesh"]["nf"]
                    assert len(raw) == 3 * nv + 3 * nf * (2 if nv < 65536 else 4)
        # sum over clouds + the unclouded remainder = CREST column of every component
        M = np.array(ion["M"], float) if ion["M"] else np.zeros((0, len(ion["comps"])))
        for ci, comp in enumerate(ion["comps"]):
            if comp["logN_crest"] is None:
                continue
            Nc = 10 ** comp["logN_crest"]
            assert abs((M[:, ci].sum() if len(M) else 0.0) / Nc + comp["unclouded"] - 1) < 2e-3, (key, ci)
        assert ion["iso_steps"][-1][2] <= cw["params"]["perc_frac"] and ion["iso_steps"][-1][3] <= cw["params"]["perc_kpc"]
        lad = ion["ladder"]["levels"]
        assert [x["step"] for x in lad] == list(range(-cw["params"]["ladder_n"], cw["params"]["ladder_n"] + 1))
        assert abs(lad[cw["params"]["ladder_n"]]["log_n_iso"] - ion["n_iso_log"]) < 1e-3
        if ion["ladder"]["file"]:
            blob = gzip.decompress((cdir / ion["ladder"]["file"]["file"]).read_bytes())
            for lv in lad:
                for c in lv["clouds"]:
                    if isinstance(c.get("mesh"), dict):
                        m = c["mesh"]
                        assert m["offset"] + m["nbytes"] <= len(blob)
                        assert m["nbytes"] == 3 * m["nv"] + 3 * m["nf"] * (2 if m["nv"] < 65536 else 4)


def test_v2_reference_clouds():
    """H5: the H I clouds rebuilt on the story ray keep the prototype's columns (17.68/17.41/17.56; their sum is
    10^18.04, the prototype's "18.03" was an arithmetic slip); O VI ladder end logged"""
    d, _ = _load(488530, "rand_b062_a062")
    cw, _p = _clouds(d)
    hi = [c["logN_ray"] for c in cw["ions"]["HI"]["clouds"]]
    assert len(hi) == 3 and all(abs(a - b) <= 0.01 for a, b in zip(hi, (17.68, 17.41, 17.56))), hi
    assert abs(math.log10(sum(10 ** x for x in hi)) - 18.04) <= 0.01
    assert abs(cw["ions"]["OVI"]["iso_steps"][-1][0] - (-9.61)) <= 0.01
    names = d["cloud_names"]
    assert [e["id"] for e in names["letters"]["A"]["HI"]] == ["HI_s0"]
    assert [e["id"] for e in names["letters"]["D"]["HI"]] == ["HI_s2"]
    assert "OVI" in names["letters"]["A"]                                        # the O VI skin of cloud A (L6)
    ids = {c["id"] for ion in cw["ions"].values() for c in ion["clouds"]}
    listed = [e["id"] for L in names["letters"].values() for lst in L.values() for e in lst]
    listed += [e["id"] for lst in names["unnamed"].values() for e in lst]
    assert sorted(listed) == sorted(ids)                                         # every cloud named exactly once


@pytest.mark.parametrize("gid,ray", STORIES)
def test_v2_tube(gid, ray):
    d, _ = _load(gid, ray)
    if not d.get("tube"):
        pytest.skip("no tube (scripts/build_story_tube.py)")
    t = json.loads((DATA / "tube" / f"{gid}_{ray}.json").read_text())
    raw = gzip.decompress((DATA / t["path"]).read_bytes())
    assert len(raw) == TUBE_B * t["n"] == t["bytes"]
    q = np.frombuffer(raw, np.uint8).reshape(-1, TUBE_B)[:, :2].copy().view("<u2").ravel()
    l = t["lo"][0] + q / 65535 * t["span"][0]
    assert np.all(np.diff(l) >= -t["span"][0] / 65535)                          # sorted by l
    li = t["l_index"]
    assert li[-1] == t["n"] and all(a <= b for a, b in zip(li, li[1:]))
    k = len(li) // 2
    assert np.all(l[li[k]:li[k + 1]] >= t["l_index_l0"] + k - 1e-3)
    assert t["radius_kpc"] >= 20


def test_v2_yt_partial_cuts():
    """M10: three yt partial rays (export_story_data.py cuts). yt keeps lc - h < l_cut with full dl; Trident's partial
    spectrum is the full-column sum over those cells; the story's kernel-weighted sum lies between the bounds."""
    d, _ = _load(488530, "rand_b062_a062")
    yc = d["facts2"].get("yt_partial_cuts")
    if not yc:
        pytest.skip("no yt partial cuts recorded (CUTS=1 scripts/story_data.sbatch)")
    assert len(yc["cuts"]) == 3
    for c in yc["cuts"]:
        assert c["missing"] == [] and c["extra"] == [] and c["dl_rel_max"] < 1e-6, c["l"]
        for key, r in c["ions"].items():
            assert r["max_dF_trident_vs_fullcolumn_sum"] < DF_MAX[key], (c["l"], key)
            assert r["weighted_between_bounds"] and r["logN_left"] <= r["logN_weighted"] <= r["logN_yt"] + 1e-9


# ----------------------------------------------------------------------------------------------- copy flags + contract
COPY_FLAGS = ("has_first_ovi", "hi_black", "has_ovi_skin", "has_hot_stretch", "ovi_strong", "has_cold_knot", "has_pair",
              "has_invented", "lite", "richest_not_closest")


@pytest.mark.parametrize("gid,ray", STORIES)
def test_v2_flags_recompute(gid, ray):
    """every copy.json flag is exported as a boolean and equals the rule evaluated on the file itself"""
    import export_story_data as X
    d, _ = _load(gid, ray)
    pf = DATA / f"page_fits_{gid}_{ray}.json"
    pf = json.loads(pf.read_text()) if pf.exists() else None
    copy_flags = {k for k in json.loads((ROOT / "copy.json").read_text(encoding="utf-8"))["flags"] if k != "about"}
    assert set(COPY_FLAGS) <= copy_flags | {"has_b9_new_dips"}, "copy.json flags changed: update story_flags"
    assert copy_flags <= set(COPY_FLAGS) | {"has_b9_new_dips"}, "copy.json flags changed: update story_flags"
    assert copy_flags <= set(d["flags"]) and all(isinstance(v, bool) for v in d["flags"].values())
    assert d["flags"] == X.story_flags(d, pf)
    assert d["flags"]["lite"] is False


def test_v2_reference_flags_and_contract_keys():
    """488530: the hero story shows every branch; keys the copy contract asks for are bound, not typed"""
    d, _ = _load(488530, "rand_b062_a062")
    f, k = d["facts2"], d["keys"]
    assert all(d["flags"][x] for x in COPY_FLAGS if x != "lite")
    assert f["cold_knot"]["HI"] == "HI_s1" and k["b7e_hi_v"] == "+37"            # cold knot H I minimum (B7e)
    assert k["b7e_ovi_v"] == "−55 and +14"                                   # O VI clouds beside it
    assert f["richest_ovi"]["id"] == "OVI_s2" and not f["richest_ovi"]["contains_l0"]
    assert f["hi_black_cloud"]["id"] == "HI_s0" and f["hi_black_cloud"]["letter"] == "A"
    assert f["ovi_skin"]["host"] == "HI_s0" and len(f["ovi_skin"]["cells"]) >= 1
    hs = f["hot_stretch"]
    assert hs["span_kpc"] >= 40 and hs["median_T"] > 1e6 and -124 <= hs["l"][0] < hs["l"][1] <= -40   # inside B6
    assert (k["s10_feature_v"], k["pix_per_resel"], k["c263_ovi_share"]) == ("+96", "5", "24.7")
    inv = f["invented"]
    assert inv["fit"] == 2 and inv["comp"] == 1 and inv["beta"] < 0.25 and 0.05 < inv["col_share"] < 0.08


@pytest.mark.parametrize("gid,ray", STORIES)
def test_v2_copy_check_clean(gid, ray):
    """per-galaxy rules (R_content section 10): an eligible story shows no '–', no unresolved key and no claim that
    a recomputation on the file contradicts, in any copy.json text visible under its flags"""
    import export_story_data as X
    d, _ = _load(gid, ray)
    if not d["story"]["eligible"]:
        pytest.skip(f"{gid} {ray} not eligible (story-lite)")
    pf = DATA / f"page_fits_{gid}_{ray}.json"
    pf = json.loads(pf.read_text()) if pf.exists() else None
    probs = X.check_story(d, pf, json.loads((ROOT / "copy.json").read_text(encoding="utf-8")))
    assert not probs, probs[:10]


def test_v2_copy_check_catches_seeded_defects():
    import export_story_data as X
    d, _ = _load(488530, "rand_b062_a062")
    pf = _fits(488530, "rand_b062_a062")
    cd = json.loads((ROOT / "copy.json").read_text(encoding="utf-8"))
    w = copy.deepcopy(d); w["keys"]["b4_first_depth"] = X.NA                     # '–' on screen (B4 visible)
    assert any("b4_first_depth" in p and "shows" in p for p in X.check_story(w, pf, cd))
    w = copy.deepcopy(d); w["flags"]["hi_black"] = False                         # flag contradicts the data
    assert any(p.startswith("flags differ") for p in X.check_story(w, pf, cd))
    w = copy.deepcopy(d); w["keys"]["hi_lls"] = "below the 17.2 of a Lyman-limit system"   # wrong wording
    assert any(p.startswith("key hi_lls") for p in X.check_story(w, pf, cd))
    w = copy.deepcopy(d); del w["keys"]["b7e_hi_v"]; w["facts2"]["cold_knot"] = None
    w["flags"]["has_cold_knot"] = True                                           # visible line, key missing
    assert any("b7e_hi_v" in p for p in X.check_story(w, pf, cd))
    w = copy.deepcopy(d); w["flags"] = {k: False for k in w["flags"]}           # hidden lines are not checked ...
    w["keys"]["b4_first_depth"] = X.NA
    assert not any("b4_first_depth" in p and "shows" in p for p in X.check_story(w, pf, cd))   # ... B4 shows else


def test_v2_beat_windows_scale_with_half():
    import export_story_data as X
    w1, _ = X.beat_windows()
    w2, src = X.beat_windows(half=2 * X.REF_HALF)
    assert "scaled" in src and all(abs(w2[b][0] - 2 * w1[b][0]) < 1e-9 and abs(w2[b][1] - 2 * w1[b][1]) < 1e-9 for b in w1)
    w3, src3 = X.beat_windows(half=X.REF_HALF)
    assert w3 == w1 and "scaled" not in src3


def test_v2_curate_rule():
    """CURATE_RULE: deterministic, candidates pass the peak-tau gates, random orientation first, then |rho - rho_ref|"""
    import export_story_data as X
    gdir = X.work_root() / "data" / "gal" / "411449" / "library" / "sightlines"
    if not gdir.exists():
        pytest.skip("host library not on disk")
    a, b = X.curate_candidates(411449), X.curate_candidates(411449)
    assert a == b and a
    assert all(c["passes"] and c["peak_tau_sbi"]["OVI"] >= X.OVI_TAU_MIN and c["peak_tau_sbi"]["HI"] >= X.HI_TAU_MIN for c in a)
    key = [(c["orientation"] != "random", abs(c["rho"] - X.REF_RHO)) for c in a]
    assert key == sorted(key)


def test_v2_staged_rays():
    """STORY_STAGE=<dir> (staging tree with MANIFEST.json): every ready host passes the copy check; skipped otherwise"""
    import export_story_data as X
    st = os.environ.get("STORY_STAGE")
    if not st:
        pytest.skip("set STORY_STAGE to check a staging tree")
    res = X.check_dir(Path(st))
    man = json.loads((Path(st) / "MANIFEST.json").read_text())
    assert man["n_ready"] == len(man["ready"]) > 0
    for g in man["ready"]:
        ok = [k for k, v in res.items() if k.startswith(f"story_{g}_") and v["eligible"] and not v["problems"]]
        assert ok, g


# ------------------------------------------------------------------------------------- film contrast beams (Phase 1)
def _beams():
    p = DATA / "index.json"
    if not p.exists():
        return []
    return [(e["galaxy"], e["ray"]) for e in json.loads(p.read_text()).get("film_beams", [])]


BEAMS = _beams()


def test_v2_film_beams_index():
    """The ≤ 3 contrast beams of film.json ship as story-data/2, listed under index.film_beams (never in
    index.stories, which the picker reads), with the role U_film's rule gave them."""
    import export_story_data as X
    ix = _index()
    beams = {(e["galaxy"], e["ray"]): e for e in ix.get("film_beams", [])}
    assert set(beams) == set(X.FILM_BEAMS) and 1 <= len(beams) <= 3
    assert not set(beams) & {(e["galaxy"], e["ray"]) for e in ix["stories"]}
    film = json.loads((ROOT / "film.json").read_text())
    fb = {(X.REF_GALAXY, b["ray"]): b["role"] for b in film["cuts"]["beams"]["beams"]}
    assert fb == X.FILM_BEAMS
    for k, e in beams.items():
        assert e["role"] == X.FILM_BEAMS[k]
        assert (DATA / e["story"]).exists() and (DATA / e["page_fits"]).exists()
        st = f"{k[0]}_{k[1]}"
        assert (DATA / "clouds" / st / "clouds.json").exists()
        assert (DATA / "tube" / f"{st}.json").exists() and (DATA / "tube" / f"{st}.bin.gz").exists()


@pytest.mark.parametrize("gid,ray", BEAMS)
def test_v2_film_beam_physics(gid, ray):
    """A film beam is held to the story physics (not to the eligibility rule): cell-sum parity within the limits the
    exporter recorded (hero limits, or rounding slack over the full-precision sum, under hard ceilings)."""
    import export_story_data as X
    d, p = _load(gid, ray)
    assert d["meta"]["schema"] == "story-data/2" and d["meta"]["galaxy"] == gid and d["meta"]["ray"] == ray
    assert len(gzip.compress(p.read_bytes(), 9)) <= GZ_BUDGET
    v = _grid(d)
    for key in ("HI", "OVI"):
        chk = d["meta"]["checks"][key]
        assert chk["dF_limit"] <= X.ROUND_SLACK * max(X.DF_MAX[key] / X.ROUND_SLACK, chk["max_abs_dF_fullprecision"]) + 1e-12
        assert chk["max_abs_dF_cellsum_vs_stored"] <= chk["dF_limit"]
        assert chk["max_abs_dF_fullprecision"] <= X.DF_CEIL[key]
        assert chk["EW_rel"] <= chk["EW_limit"] and chk["EW_rel_fullprecision"] <= X.EW_CEIL
        assert chk["dlogN"] < 1e-6
        F = np.array(d["ions"][key]["F_intrinsic"])
        Fc = np.exp(-_cellsum(d, key, v))
        assert np.max(np.abs(Fc - F)) < chk["dF_limit"] + 1e-5, key
    for t in (test_ion_density_identities, test_tau0_and_b_columns, test_v2_geometry_columns, test_v2_stateless_tau,
              test_v2_clouds_on_story_ray, test_v2_tube, test_v2_flags_recompute):
        t(gid, ray)


def test_v2_doppler_z_relativistic():
    """build_story_clouds.doppler_z is yt's full relativistic redshift_dopp (gamma of the 3D speed); the radial-only
    inverse misses beta_t^2 c / 2, which tripped the 0.5 km/s V check on a fast-crossing beam (0.65 km/s)."""
    import build_story_clouds as B
    C = B.C_KMS
    n = np.array([0.0, 0.0, 1.0])
    v = np.array([[0.0, 0.0, -200.0], [600.0, 300.0, -50.0], [-150.0, 700.0, 120.0]])
    z = B.doppler_z(v, n)
    vlos = -(v @ n)
    gam = 1 / np.sqrt(1 - np.sum(v ** 2, axis=1) / C ** 2)
    assert np.allclose(z, gam * (1 + vlos / C) - 1, rtol=0, atol=1e-15)
    radial = C * ((1 + z) ** 2 - 1) / ((1 + z) ** 2 + 1)           # exact only without transverse motion
    assert abs(radial[0] - vlos[0]) < 1e-9
    assert abs(radial[1] - vlos[1]) > 0.3                            # 670 km/s across the beam: ~0.75 km/s


def test_v2_minima_claims():
    """review2 science M1/M3: B9's 'new dips' are new spectral minima of the partial O VI spectrum (DESIGN_final H2), and
    B5's O VI line quotes the light removed over the beat at b5_ovi_V; both recomputed here from the shipped file alone"""
    d, _ = _load(488530, "rand_b062_a062")
    f, k = d["facts2"], d["keys"]
    v = _grid(d); tm = _taumat(d, "OVI", v)[0]
    F = lambda s: np.exp(-(_W(d, s) @ tm))
    l0, l1 = f["beat_windows"]["B9"]
    for V, depth in f["b9_new_minima"] + f["b9_deepened_minima"]:
        j = int(np.argmin(np.abs(v - V))); F1 = F(l1)
        assert abs(1 - F1[j] - depth) < 1e-4 and F1[j] == F1[max(j - 3, 0):j + 4].min(), V
    F0 = F(l0)
    for V, _depth in f["b9_new_minima"]:      # nothing >= 15 % deep within 10 km/s before the beat
        near = (np.abs(v - V) <= 10)
        assert (1 - F0[near]).max() < 0.15 or not any(abs(x[0] - V) <= 10 and x[1] >= 0.15 for x in f["b9_minima_start"]), V
    assert k["b9_new_minima"] == "+61, +98" and k["b9_deepened_minima"] == "+12"
    assert d["flags"]["has_b9_new_dips"] is True
    a, b = f["beat_windows"]["B5"]; j = int(np.argmin(np.abs(v - f["b5_ovi_V"])))
    assert abs((F(a)[j] - F(b)[j]) - f["b5_ovi_drop"]) < 1e-6 and abs(1 - F(b)[j] - f["b5_ovi_depth_after"]) < 1e-6
    assert (k["b5_ovi_drop"], k["b5_ovi_depth_after"]) == ("32", "44")
