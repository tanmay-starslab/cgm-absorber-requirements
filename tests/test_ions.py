"""The ion registry (tngsight/ions.json + tngsight/ions.py, Phase-3 design §1): file validation, atomic data equal
to Trident's lines.txt and the repo's supplement list to the last digit, derived constants, damped window, and every
Python consumer deriving its ion set from the registry."""
import importlib.util
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from tngsight import ions as I

ROOT = Path(__file__).resolve().parent.parent
BRIEF_ORDER = ["H I 1216", "Mg II 2796", "Si II 1260", "C II 1335", "Si III 1206", "C III 977", "Si IV 1403",
               "C IV 1548", "N V 1239", "O VI 1032", "Ne VIII 770", "O VII 21.6"]


def trident_lines_txt():
    spec = importlib.util.find_spec("trident")            # never import trident (it reads ./config.tri)
    if spec is None or spec.origin is None:
        return None
    p = Path(spec.origin).parent / "data" / "line_lists" / "lines.txt"
    return p if p.is_file() else None


def parse_line_list(path):
    out = []
    for line in Path(path).read_text().splitlines():
        t = line.split()
        if line.startswith("#") or len(t) < 5:
            continue
        out.append((t[0], t[1], t[2], t[3], t[4]))       # element, state, wavelength, gamma, f (text)
    return out


def test_registry_file_validates_and_cli():
    I.validate(json.loads((ROOT / "tngsight" / "ions.json").read_text()))
    r = subprocess.run([sys.executable, "-m", "tngsight.ions", "--check", "--print"], cwd=ROOT,
                       capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, r.stderr
    assert f"registry_tag {I.registry_tag()}" in r.stdout and " ".join(I.KEYS) in r.stdout


def test_registry_shape_and_order():
    assert I.KEYS == ("HI", "MgII", "SiII", "CII", "SiIII", "CIII", "SiIV", "CIV", "NV", "OVI", "NeVIII", "OVII")
    assert [I.get(k)["label"] for k in I.KEYS] == BRIEF_ORDER
    assert [I.get(k)["order"] for k in I.KEYS] == list(range(12))
    assert [k for k in I.KEYS if I.get(k)["damped"]] == ["HI"] == [I.DAMPED_KEY]
    assert {I.get(k)["band"] for k in I.KEYS} == {"uv", "euv", "xray"}
    assert I.get("NeVIII")["band"] == "euv" and I.get("OVII")["band"] == "xray"
    assert I.BANDS["uv"]["R"] == {"min": 5000, "max": 150000, "default": 30000, "pair": [15000, 50000]}
    assert I.BANDS["xray"]["R"] == {"min": 100, "max": 5000, "default": 1000, "pair": [300, 3000]}
    assert I.SNR["max"] == 100 and I.SNR["pair"] == [20, 5]
    assert I.DEFAULTS == {"ions": ["HI", "MgII", "CIV", "OVI", "OVII"], "layout": "4", "vhw_kms": 400}
    for k in I.KEYS:
        i = I.get(k)
        assert I.KEY_RE.match(k) and i["ion"].replace(" ", "") == k
        assert "·" not in i["label"] and "•" not in i["label"]
        assert i["label_tex"].startswith(i["element"] + r"\,") and r"\lambda" in i["label_tex"]
    # cool -> hot by creation IP except the brief's O VII / Ne VIII order (design §0.2 item 3)
    ip = [I.get(k)["ip_eV"][0] for k in I.KEYS]
    assert ip[:11] == sorted(ip[:11]) and ip[11] < ip[10]


def test_atomic_data_equal_trident_lines_txt():
    p = trident_lines_txt()
    if p is None:
        pytest.skip("trident not installed")
    rows = parse_line_list(p)
    n = 0
    for k in I.KEYS:
        i = I.get(k)
        if i["source"] != "trident":
            assert not [r for r in rows if r[0] == i["element"] and r[1] == i["ion_state"]
                        and abs(float(r[2]) - i["lam0_A"]) < 0.01], f"{k} is in lines.txt now"
            continue
        hit = [r for r in rows if r[0] == i["element"] and r[1] == i["ion_state"]
               and abs(float(r[2]) - i["lam0_A"]) < 0.01]
        assert len(hit) == 1, k
        _, _, lam, gam, f = hit[0]
        assert float(lam) == i["lam0_A"] and float(gam) == i["gamma_s"] and float(f) == i["f"], (k, hit[0])
        # Trident's name for the line resolves to this transition (identifier, else "El State round(λ)")
        assert i["trident_line"] in (f"{i['element']} {i['ion_state']} {round(float(lam))}",) or k == "HI"
        n += 1
    assert n == 11


def test_supplement_equal_repo_list():
    rows = parse_line_list(ROOT / "absreq" / "data" / "supplement_lines.txt")
    sup = [k for k in I.KEYS if I.get(k)["source"] == "supplement"]
    assert sup == ["OVII"]
    i = I.get("OVII")
    hit = [r for r in rows if r[0] == "O" and r[1] == "VII"]
    assert len(hit) == 1
    _, _, lam, gam, f = hit[0]
    assert (float(lam), float(gam), float(f)) == (i["lam0_A"], i["gamma_s"], i["f"]) == (21.6019, 3.32e12, 0.696)
    assert i["field"] == "O_p6_number_density" and i["trident_line"] == "O VII 22"


def test_add_supplement_lines_idempotent():
    class DB:
        def __init__(self):
            self.lines_all = []

        def add_line(self, element, ion_state, wavelength, gamma, f_value, field=None, identifier=None):
            self.lines_all.append(type("L", (), dict(identifier=identifier, element=element, ion_state=ion_state,
                                                     wavelength=wavelength, gamma=gamma, f_value=f_value,
                                                     field=field))())
    db = DB()
    assert I.add_supplement_lines(db) == ["O VII 22"]
    assert I.add_supplement_lines(db) == []
    ln = db.lines_all[0]
    assert (ln.element, ln.ion_state, ln.wavelength, ln.gamma, ln.f_value, ln.field) == \
        ("O", "VII", 21.6019, 3.32e12, 0.696, "O_p6_number_density")


def test_derived_constants():
    for k in I.KEYS:
        i = I.get(k)
        lam_cm = i["lam0_A"] * 1e-8
        assert I.k_tau(k) == pytest.approx(0.02654008 * i["f"] * lam_cm / (math.sqrt(math.pi) * 1e5), rel=1e-14)
        assert I.a0(k) == pytest.approx(i["gamma_s"] * lam_cm / (4 * math.pi * 1e5), rel=1e-14)
        a = I.atomic(k)
        assert a == {"lam0": i["lam0_A"], "f": i["f"], "gamma": i["gamma_s"], "mass_amu": i["mass_amu"],
                     "b_min": i["fit"]["b_min"], "logN_max": i["fit"]["logN_max"]}
    # the Lorentzian wing constant of Lyα (design §2.1)
    assert I.k_tau("HI") * I.a0("HI") / math.sqrt(math.pi) == pytest.approx(1.938e-15, rel=1e-3)
    assert I.atomic("HI")["logN_max"] == 22.5 and I.atomic("OVI")["logN_max"] == 19.0
    with pytest.raises(KeyError, match="unknown ion key 'HILyb'; known: HI, MgII"):
        I.get("HILyb")


def test_oVII_tau0_analytic():
    """O VII line-centre τ from the registry constants vs the textbook formula τ0 = (√π e²/m_e c) N f λ0 H(a,0)/(√π b)
    with H(a,0) = erfcx(a) (cgs constants written out here), for b of 1e6 K oxygen."""
    from scipy.special import erfcx, wofz
    e, me, c, kB, amu = 4.80320471e-10, 9.1093837e-28, 2.99792458e10, 1.380649e-16, 1.66053907e-24
    i = I.get("OVII")
    T = 1e6
    b_cms = math.sqrt(2 * kB * T / (i["mass_amu"] * amu))
    b = b_cms / 1e5
    N = 10 ** 16.0
    a = i["gamma_s"] * i["lam0_A"] * 1e-8 / (4 * math.pi * b_cms)
    tau_text = (math.pi * e ** 2 / (me * c)) * N * i["f"] * i["lam0_A"] * 1e-8 / (math.sqrt(math.pi) * b_cms) * erfcx(a)
    tau_reg = I.k_tau("OVII") * N * float(wofz(1j * (I.a0("OVII") / b)).real) / b
    assert a == pytest.approx(I.a0("OVII") / b, rel=1e-12) and 0.01 < a < 0.03
    assert 0.2 < I.a0("OVII") / I.atomic("OVII")["b_min"] < 0.25      # at b_min O VII reaches a ≈ 0.2 (design §0.1)
    assert tau_reg == pytest.approx(tau_text, rel=2e-6)


def test_hi_window():
    assert I.hi_window(19.0) == 1500 and I.hi_window(float("nan")) == 1500 and I.hi_window(-math.inf) == 1500
    assert I.hi_window(None) == 1500
    assert [I.hi_window(x) for x in (19.486, 20.405, 21.471)] == [2500, 7500, 10000]     # design §0.1 measured
    assert I.hi_window(30) == I.GRID["damped_v_max_kms"]
    for lg in np.linspace(19.01, 21.0, 40):
        W = I.hi_window(lg)
        assert W % 500 == 0 and 1500 <= W <= 10000
        if W < 10000:                                             # wing τ at the edge ≤ τ_edge (design §2.1)
            assert I.k_tau("HI") * I.a0("HI") / math.sqrt(math.pi) * 10 ** lg / W ** 2 <= 0.01 * (1 + 1e-12)
    assert I.gen_window("OVI", 21.0) == 1500 and I.gen_window("HI", 20.405) == 7500


def test_registry_tag_stable():
    t = I.registry_tag()
    assert len(t) == 12 and int(t, 16) >= 0 and t == I.registry_tag()
    reg = json.loads(json.dumps(I.REGISTRY))
    assert I.registry_tag(reg) == t
    reg["ions"][9]["fit"]["b_min"] = 2.4
    assert I.registry_tag(reg) != t
    # stability across processes: test_registry_file_validates_and_cli compares the CLI's tag with this one


@pytest.mark.parametrize("mutate,msg", [
    (lambda r: r["ions"].pop(), "exactly 12"),
    (lambda r: r["ions"][1].update(key="HI"), "unique"),
    (lambda r: r["ions"][2].update(order=5), "order"),
    (lambda r: r["ions"][3].update(band="ir"), "unknown band"),
    (lambda r: r["ions"][0].update(damped=False), "exactly one damped"),
    (lambda r: r["ions"][4].update(label="Si III · 1206"), "separators"),
    (lambda r: r["bands"]["uv"]["R"].update(default=1), "min < default < max"),
    (lambda r: r["bands"]["xray"]["R"].update(pair=[50, 300]), "pair"),
    (lambda r: r["ions"][11].update(lam0_A=21.7), "supplement"),
    (lambda r: r["ions"][7].update(extra=1), "fields must be exactly"),
])
def test_registry_validation_rejects(mutate, msg):
    reg = json.loads(json.dumps(I.REGISTRY))
    mutate(reg)
    with pytest.raises(ValueError, match=msg):
        I.validate(reg)


def test_page_ions_and_consumers_derive_from_registry():
    from tngsight import vpfit, components, search, scoring, style, volume, vizpack, generate, library, config
    p = I.page_ions()
    assert [x["key"] for x in p] == list(I.KEYS)
    assert set(p[0]) == {"key", "order", "ion", "label", "lam0_A", "f", "gamma_s", "mass_amu", "band", "color",
                         "color_dark", "damped", "fit"}
    assert list(vpfit.ATOMIC) == list(I.KEYS) and vpfit.ATOMIC["OVII"] == I.atomic("OVII")
    assert vpfit.PARAMS["logN_hi_ion"] == {"HI": 22.5}
    assert search.ION_KEYS == I.KEYS and search.QUERY_SCHEMA["properties"]["ion"]["enum"] == list(I.KEYS)
    assert search.ION_SHORT["NeVIII"] == "Ne VIII"
    assert set(scoring.ION_W) == set(I.KEYS) and scoring.ION_W["OVI"] == 1.5
    assert style.ION_ORDER == list(I.KEYS) and style.ION["CIV"]["color"] == I.get("CIV")["color"]
    assert volume.VOL_KEYS == ("nH", "T", "Z") + I.KEYS == vizpack.VOL_KEYS
    assert generate.STAGES == ("load", "ray", *(f"spectrum:{k}" for k in I.KEYS), "fit", "save")
    assert [f for _, f in generate.RAY_FIELDS[4:]] == [I.get(k)["field"] for k in I.KEYS]
    assert config.DV_NATIVE == I.GRID["dv_native_kms"] and config.DV_WEB == I.GRID["dv_web_kms"]
    assert config.VWIN_GEN_KMS == I.GRID["v_gen_kms"] and not hasattr(config, "LINE_KEYS")
    assert components.FITTER_TAG == "tngsight.vpfit/2" and components.CATALOGUE_VERSION == 2
    assert library.catalog_skeleton()["ions"] == list(I.KEYS)
    assert I.label_wavelength("OVII") == "21.6" and I.label_wavelength("HI") == "1216"
