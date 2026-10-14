"""Tests for the tngsight package (design.md §7). Real-library tests read the raw npz set
(TNG_RAW_SIGHTLINES, default the read-only LaCie copy) and skip if it is absent. The Generator
integration test is @slow and runs only with TNG_RUN_SLOW=1 (it loads yt/trident + the slim cutout).
Temp files go to $TNG_TEST_TMP when set (else pytest's tmp_path)."""
import io
import json
import math
import os
import uuid
import zipfile
from pathlib import Path
import numpy as np
import pytest

from tngsight import config, geometry as G, library as L

RAW = Path(os.environ.get("TNG_RAW_SIGHTLINES", "/Volumes/LaCie/cgm_qso_488530/data/sightlines"))
GRID_INDEX = Path(__file__).resolve().parent.parent / "tng50" / "data" / "grid_index.csv"
need_raw = pytest.mark.skipif(not RAW.is_dir(), reason=f"raw sightline library not at {RAW}")


def raw(id):
    return RAW / L.npz_name(id)


@pytest.fixture
def scratch(tmp_path):
    base = os.environ.get("TNG_TEST_TMP")
    if not base:
        return tmp_path
    d = Path(base) / f"t_{uuid.uuid4().hex[:8]}"
    d.mkdir(parents=True)
    return d


def legacy_rand():
    """The 40 seedless legacy random sightlines of full_grid(): {id: (b, az, seed)}."""
    rng = np.random.default_rng(488530); out = {}
    for _ in range(40):
        b = float(rng.uniform(50, 150)); az = float(rng.uniform(0, 360))
        b, az, seed = round(b, 1), round(az, 1), int(rng.integers(1e9))
        out[G.geom_id("random", b, az)] = (b, az, seed)
    return out


def assert_geom_close(new, old):
    assert list(new) == list(old)
    for k in old:
        if isinstance(old[k], str) or old[k] is None:
            assert new[k] == old[k], k
        else:
            np.testing.assert_allclose(new[k], old[k], rtol=1e-9, atol=1e-9, err_msg=k)


# ------------------------------------------------------------------------------- geometry
@need_raw
@pytest.mark.parametrize("id", ["face_b050_a090", "edge_b100_a090", "edge_b050_a000", "face_b150_a330",
                                "rand_b005_a134_s479980658", "LEGACY0", "LEGACY1"])
def test_geometry_reproduces_stored(id):
    if id.startswith("LEGACY"):
        lg = legacy_rand(); ids = sorted(k for k in lg if raw(k).exists())
        id = ids[int(id[-1])]
        b, az, seed = lg[id]
        o = "random"
    else:
        old = L.load_npz(raw(id))["geom"]
        o, b, az = old["orientation"], old["b_kpc"], old["azimuth_deg"]
        seed = int(id.rsplit("_s", 1)[1]) if "_s" in id else None
    p = L.load_npz(raw(id))
    assert p["id"] == id
    new = G.make_sightline(o, b, az, seed=seed)
    assert_geom_close(new, p["geom"])
    assert G.geom_id(o, b, az, seed=seed if "_s" in id else None) == id
    assert math.isclose(p["v_sys"], new["v_sys_kms"], rel_tol=1e-12)


def test_geom_id_signature_and_rounding():
    assert G.geom_id("face-on", 12.5, 90) == "face_b012_a090"         # banker's rounding
    assert G.geom_id("random", 5.1, 134.3, seed=7) == "rand_b005_a134_s7"
    assert G.geom_id("random", 5.1, 134.3, 7) == "rand_b005_a134_s7"  # seed is the 4th positional
    assert G.geom_id("edge-on", 5, 3, inclination_deg=30) == "edge_b005_a003_i030"


def test_canonicalize_edge_cases():
    c = G.canonicalize("FACE", 100.4, 360)
    assert c == {"orientation": "face-on", "b_kpc": 100.0, "azimuth_deg": 0.0, "seed": None,
                 "id": "face_b100_a000"}
    assert G.canonicalize("edge-on", 12.5, 359.6)["id"] == "edge_b012_a000"      # 12.5->12, 360->0
    assert G.canonicalize("edge", 13.5, 0.5)["b_kpc"] == 14.0                      # 13.5->14, 0.5->0
    assert G.canonicalize("edge", 13.5, 0.5)["azimuth_deg"] == 0.0
    assert G.canonicalize("Random", 50, -30, seed=5)["id"] == "rand_b050_a330_s5"
    assert G.canonicalize("rand", 0, 0, seed=2**32 - 1)["seed"] == 2**32 - 1
    assert G.canonicalize("face-on", 300, 10, seed=99)["seed"] is None             # forced None
    for bad in [dict(orientation="random", b_kpc=50, azimuth_deg=0),                # seed required
                dict(orientation="random", b_kpc=50, azimuth_deg=0, seed=-1),
                dict(orientation="random", b_kpc=50, azimuth_deg=0, seed=2**32),
                dict(orientation="random", b_kpc=50, azimuth_deg=0, seed=1.5),
                dict(orientation="random", b_kpc=50, azimuth_deg=0, seed="1"),
                dict(orientation="inclined", b_kpc=50, azimuth_deg=0),
                dict(orientation="face", b_kpc=300.6, azimuth_deg=0),
                dict(orientation="face", b_kpc=-0.6, azimuth_deg=0),
                dict(orientation="face", b_kpc=float("nan"), azimuth_deg=0),
                dict(orientation="face", b_kpc=10, azimuth_deg=float("inf")),
                dict(orientation="face", b_kpc=True, azimuth_deg=0)]:
        with pytest.raises(ValueError):
            G.canonicalize(**bad)
    c = G.canonicalize("edge", 100, 90)
    g = G.make_sightline(c["orientation"], c["b_kpc"], c["azimuth_deg"], seed=c["seed"])
    assert G.geom_id(g["orientation"], g["b_kpc"], g["azimuth_deg"]) == c["id"]


# ------------------------------------------------------------------------------- library
@need_raw
@pytest.mark.parametrize("id", ["face_b050_a090", "rand_b005_a134_s479980658"])
def test_wavelength_grid_equals_stored(id):
    p = L.load_npz(raw(id))
    for k in config.LINE_KEYS:
        g = L.wavelength_grid(k)
        assert g.dtype == np.float32 and np.array_equal(g, p["lam"][k]), k
    assert [L.wavelength_grid(k).size for k in config.LINE_KEYS] == [5165, 5133, 4889]


@need_raw
def test_npz_round_trip_exact(scratch):
    src = raw("edge_b100_a090")
    p = L.load_npz(src)
    out = scratch / L.npz_name("edge_b100_a090")
    L.save_npz(out, p["geom"], p["logN"], p["tau"])
    q = L.load_npz(out)
    assert q["id"] == p["id"] and q["geom"] == p["geom"] and q["v_sys"] == p["v_sys"]
    assert q["logN"] == p["logN"] and q["rest"] == p["rest"]
    for k in config.LINE_KEYS:
        assert q["tau"][k].dtype == np.float32 and np.array_equal(q["tau"][k], p["tau"][k])
    with zipfile.ZipFile(src) as a, zipfile.ZipFile(out) as b:
        assert a.namelist() == b.namelist()          # exact member order
        for n in a.namelist():
            assert a.read(n) == b.read(n), n         # identical npy bytes (dtypes, headers)
    with np.load(out) as d:
        assert d["geom"].dtype.kind == "U" and d["geom"].shape == () and d["v_sys"].dtype == np.float64
    assert not list(scratch.glob(".*tmp*"))          # atomic write left no temp file
    buf = io.BytesIO(); L.save_npz(buf, p["geom"], p["logN"], p["tau"]); buf.seek(0)
    assert L.load_npz(buf, id="x")["geom"] == p["geom"]
    with pytest.raises(ValueError):
        L.save_npz(io.BytesIO(), p["geom"], p["logN"], {**p["tau"], "OVI": p["tau"]["OVI"][:-1]})


def synth_payload(seed=0):
    rng = np.random.default_rng(seed)
    g = G.make_sightline("edge-on", 100.0, 90.0)
    taus = {k: (rng.random(L.wavelength_grid(k).size) * 3).astype(np.float32) for k in config.LINE_KEYS}
    taus["HILyb"][:50] = 7e5                                       # saturated
    return {"id": "edge_b100_a090", "geom": g, "v_sys": g["v_sys_kms"], "logN": dict(OVI=14.0, HILyb=15.0, CIII=-np.inf),
            "lam": {k: L.wavelength_grid(k) for k in config.LINE_KEYS}, "tau": taus,
            "rest": {k: config.LINES[k]["rest_A"] for k in config.LINE_KEYS}}


def test_aod_columns():
    """logN_aod = log10(AOD_K/(f λ0) ∫τ dv) reproduces an injected Gaussian column exactly, saturated or not,
    and is None for τ ≡ 0; catalog rows carry it next to the ray logN."""
    from tngsight import vpfit
    p = synth_payload()
    for k, (lN, b) in {"OVI": (13.4, 25.0), "HILyb": (19.0, 30.0), "CIII": (11.0, 15.0)}.items():
        lam = L.wavelength_grid(k); rest = config.LINES[k]["rest_A"]
        v = config.C_KMS * (lam.astype(float) / rest - 1)
        p["tau"][k] = vpfit.tau_components(v, [[0.0, lN, b]], k).astype(np.float32) if k != "HILyb" else \
            (vpfit.tau0(lN, b, k) * np.exp(-(v / b) ** 2)).astype(np.float32)      # pure Gaussian, τ0 ~ 4e4
    a = L.aod_columns(p)
    assert abs(a["OVI"] - 13.4) < 0.005 and abs(a["HILyb"] - 19.0) < 0.005 and abs(a["CIII"] - 11.0) < 0.005
    p["tau"]["CIII"] = np.zeros_like(p["tau"]["CIII"])
    assert L.aod_columns(p)["CIII"] is None
    assert L.catalog_entry(p, None, "generated")["logN_aod"] == L.aod_columns(p)


def test_web_round_trip():
    p = synth_payload()
    blob = L.encode_web(p)
    assert blob[:4] == L.WEB_MAGIC and blob[4] == 1 and blob[5] == 3
    n = [L.wavelength_grid(k).size for k in config.LINE_KEYS]
    assert len(blob) == 8 + sum(36 + 2 * m for m in n)
    d = L.decode_web(blob)
    for k in config.LINE_KEYS:
        ln = d["lines"][k]
        assert ln["n"] == p["tau"][k].size and ln["dlam_lsf"] == config.DLAMBDA and ln["rest"] == p["rest"][k]
        assert np.max(np.abs(ln["flux"] - np.exp(-p["tau"][k].astype(float)))) <= 0.5 / 65535 + 1e-12
        assert np.array_equal(ln["lam"].astype(np.float32), L.wavelength_grid(k))
    with pytest.raises(ValueError):
        L.decode_web(blob + b"\0")


@need_raw
def test_web_model_parity_bound():
    """design §0/§4 (fixed-by-spec): a degrade model built from the u16 web binary is within 1/65535 of the
    same model built from the exact npz τ (the JS page runs on the binary, /api/figure on the npz)."""
    from tngsight.degrade import degrade
    p = L.load_npz(raw("rand_b005_a134_s479980658"))
    d = L.decode_web(L.encode_web(p))
    for k in config.LINE_KEYS:
        with np.errstate(divide="ignore"):
            tau_q = -np.log(d["lines"][k]["flux"])
        for R in (20000, 40000):
            _, _, m_npz = degrade(p["lam"][k], p["tau"][k], p["rest"][k], R, None, p["v_sys"], vwin=400)
            _, _, m_bin = degrade(p["lam"][k], tau_q, p["rest"][k], R, None, p["v_sys"], vwin=400)
            assert np.max(np.abs(m_npz - m_bin)) <= 1 / 65535


def test_catalog_and_entry(scratch):
    import pandas as pd
    p = synth_payload()
    row = pd.read_csv(GRID_INDEX).set_index("geom_id").loc["edge_b100_a090"].to_dict()
    e = L.catalog_entry(p, row, "library")
    assert e["rank"] == int(row["rank"]) and e["score"] == pytest.approx(row["showcase_score"])
    assert e["star"] == bool(row["ovi_showcase"]) and e["seed"] is None and e["logN"]["CIII"] is None
    assert e["ions"]["OVI"]["n_comp"] == int(row["OVI_n_comp"]) and e["source"] == "library"
    g = L.catalog_entry({**p, "id": "rand_b005_a134_s479980658"}, None, "generated")
    assert g["seed"] == 479980658 and g["rank"] is None and g["star"] is False
    json.dumps(e, allow_nan=False); json.dumps(g, allow_nan=False)
    path = scratch / "catalog.json"
    c = L.Catalog(path)
    c.upsert(e); c.upsert(g); c.upsert({**e, "score": 9.0}); c.save()
    c2 = L.Catalog(path)
    assert [x["id"] for x in c2.entries()] == [e["id"], g["id"]]
    assert c2.get(e["id"])["score"] == 9.0 and c2.get("nope") is None
    raw_json = json.loads(path.read_text())
    assert raw_json["version"] == 1 and set(raw_json["lines"]) == set(config.LINE_KEYS)
    assert "cutout_hdf5" not in raw_json["galaxy"] and "ion_table" not in json.dumps(raw_json)


def test_package_json_scrubbed():
    s = (Path(config.__file__).parent / "galaxy_488530.json").read_text()
    for bad in ("/data/sborthak", "/home/tsingh65", "/scratch/tsingh65", "cutout_hdf5", "ion_table"):
        assert bad not in s
    orig = json.loads((GRID_INDEX.parent.parent / "galaxy_488530.json").read_text())
    for k, v in config.GALAXY.items():
        assert orig[k] == v


# ------------------------------------------------------------------------------- degrade
def reference_model(lam, tau, rest, R, v_sys, dlam, vwin, pix=5):
    """Independent noiseless model: explicit Gaussian taps + edge padding + np.convolve + np.interp."""
    c = 299792.458
    f = np.exp(-np.asarray(tau, float)); lam = np.asarray(lam, float)
    sig = (rest / R) / 2.35482 / dlam
    n = int(np.ceil(8 * sig)); n += (n % 2 == 0)
    h = (n - 1) // 2; j = np.arange(-h, h + 1)
    k = np.exp(-0.5 * (j / sig) ** 2); k /= k.sum()
    fl = np.convolve(np.pad(f, h, mode="edge"), k, mode="valid")
    vh = c * (lam / rest - 1) + v_sys
    dv = c / R / pix
    v = np.arange(-vwin, vwin + dv, dv)
    return v, np.interp(v, vh, fl, left=1.0, right=1.0)


@pytest.mark.parametrize("key,R", [("OVI", 20000), ("HILyb", 40000), ("CIII", 100000)])
def test_degrade_matches_independent_numpy(key, R):
    from tngsight.degrade import degrade
    p = synth_payload(1)
    lam, rest = p["lam"][key], p["rest"][key]
    tau = np.exp(-0.5 * ((lam - rest) / 0.02) ** 2) * 2.0 + p["tau"][key] * 0.05
    v, noisy, model = degrade(lam, tau, rest, R, None, -77.8, vwin=400)
    vr, mr = reference_model(lam, tau, rest, R, -77.8, 0.002, 400)
    assert np.array_equal(v, vr) and np.array_equal(noisy, model)
    assert np.max(np.abs(model - mr)) < 1e-12
    # the explicit dlam matters: median(diff(float32 λ)) would give a different kernel
    _, _, m_med = degrade(lam, tau, rest, R, None, -77.8, dlam=float(np.median(np.diff(lam.astype(float)))), vwin=400)
    assert np.max(np.abs(m_med - model)) > 1e-6
    v2, n2, m2 = degrade(lam, tau, rest, R, 8, -77.8, seed=3, vwin=400)
    _, n3, _ = degrade(lam, tau, rest, R, 8, -77.8, seed=3, vwin=400)
    assert np.array_equal(n2, n3) and n2.min() >= 0 and np.array_equal(m2, model)
    assert np.std(n2 - m2) == pytest.approx(np.sqrt(5) / 8, rel=0.15)


def test_degrade_no_lsf_modes():
    from tngsight.degrade import degrade, resolution_element_kms
    p = synth_payload(2)
    lam, tau, rest = p["lam"]["OVI"], p["tau"]["OVI"], p["rest"]["OVI"]
    for R in (None, 0, float("inf")):
        v, _, m = degrade(lam, tau, rest, R, None, 10.0, vwin=300)
        vh = 299792.458 * (lam.astype(float) / rest - 1) + 10.0
        assert np.allclose(m, np.interp(v, vh, np.exp(-tau.astype(float))))
        assert np.isnan(resolution_element_kms(R))


def test_velocity_frame_sign():
    """Gas at the subhalo velocity appears at z_dopp ≈ -v_sys/c (ray los = -n_los): it must land at V=0."""
    from tngsight.degrade import degrade, velocity_axis
    assert config.VSYS_SIGN == +1
    rest, vs = config.LINES["OVI"]["rest_A"], -77.8
    lam_c = rest * (1 - vs / config.C_KMS)
    assert abs(velocity_axis(lam_c, rest, vs)) < 1e-9
    lam = L.wavelength_grid("OVI")
    tau = 3 * np.exp(-0.5 * ((lam.astype(float) - lam_c) / 0.03) ** 2)
    v, _, m = degrade(lam, tau, rest, 40000, None, vs, vwin=400)
    assert abs(v[np.argmin(m)]) < 2.0


@need_raw
def test_velocity_frame_on_library():
    """τ-weighted H I Lyβ centroids sit closer to V=0 in the +v_sys frame than in the legacy −v_sys one."""
    from tngsight.degrade import velocity_axis
    files = sorted(RAW.glob("cgm_sid488530_edge_b*.npz"))[:40]
    new, old = [], []
    for f in files:
        p = L.load_npz(f); lam, tau, rest = p["lam"]["HILyb"], p["tau"]["HILyb"].astype(float), p["rest"]["HILyb"]
        w = np.minimum(tau, 5.0)
        v = velocity_axis(lam, rest, p["v_sys"]); m = np.abs(v) < 600
        if w[m].sum() <= 0:
            continue
        vc = np.sum(v[m] * w[m]) / w[m].sum()
        new.append(abs(vc)); old.append(abs(vc - 2 * p["v_sys"]))
    assert len(new) >= 20 and np.mean(new) < np.mean(old)


# ------------------------------------------------------------------------------- scoring
@need_raw
@pytest.mark.parametrize("id", ["face_b050_a045", "rand_b005_a134_s479980658", "edge_b100_a090"])
def test_scoring_port_matches_grid_index_in_legacy_frame(id):
    """With the legacy conventions (−v_sys, median dλ) ion_metrics reproduces tng50/data/grid_index.csv."""
    import pandas as pd
    from tngsight.scoring import ion_metrics, score_payload
    row = pd.read_csv(GRID_INDEX).set_index("geom_id").loc[id]
    p = L.load_npz(raw(id))
    for k in config.LINE_KEYS:
        lam = p["lam"][k].astype(float)
        m = ion_metrics(lam, p["tau"][k], p["rest"][k], -p["v_sys"], dlam=float(np.median(np.diff(lam))))
        assert m["n_comp"] == row[f"{k}_n_comp"] and m["showcase"] == bool(row[f"{k}_showcase"])
        assert m["min_flux"] == pytest.approx(row[f"{k}_min_flux"], rel=1e-9, abs=1e-12)
    s = score_payload(p)
    assert s["rank"] is None and isinstance(s["showcase_score"], float) and s["n_showcase_ions"] in (0, 1, 2, 3)
    e = L.catalog_entry(p, s, "generated")
    assert e["ions"]["OVI"]["n_comp"] == s["OVI_n_comp"]


def test_assign_ranks():
    from tngsight.scoring import assign_ranks
    es = [{"id": "b", "score": 1.0}, {"id": "a", "score": 1.0}, {"id": "c", "score": 3.0}, {"id": "d", "score": None}]
    assign_ranks(es)
    assert [e.get("rank") for e in es] == [3, 2, 1, None]


@need_raw
def test_build_library_scores_in_fixed_frame(scratch):
    """Default build_library scores with score_payload (+v_sys, dλ=0.002), ranks by score, tags the catalog,
    and rescoring a legacy-scored catalog leaves the npz copy and web bin untouched."""
    import shutil, sys
    from tngsight.scoring import SCORING_TAG, score_payload
    sys.path.insert(1, str(Path(__file__).resolve().parent.parent / "deploy" / "data"))
    import build_library as bl
    ids = ["face_b150_a270", "edge_b100_a090"]
    src = scratch / "src"; src.mkdir()
    for i in ids:
        shutil.copy2(raw(i), src)
    out = scratch / "lib"
    assert bl.main(["--src", str(src), "--out", str(out), "--legacy-index", str(GRID_INDEX), "-j", "1"]) == 0
    snap = {q: q.stat().st_mtime_ns for q in out.rglob("*") if q.is_file() and q.suffix in (".npz", ".bin")}
    assert bl.main(["--src", str(src), "--out", str(out), "-j", "1"]) == 0
    assert snap == {q: q.stat().st_mtime_ns for q in snap}
    doc = json.loads((out / "catalog.json").read_text())
    assert doc["scoring"] == SCORING_TAG
    es = {e["id"]: e for e in doc["entries"]}
    for i in ids:
        sc = score_payload(L.load_npz(out / "sightlines" / f"{i}.npz"))
        assert es[i]["score"] == pytest.approx(sc["showcase_score"]) and es[i]["star"] == sc["ovi_showcase"]
        assert es[i]["ions"]["OVI"]["n_comp"] == sc["OVI_n_comp"]
    assert sorted(e["rank"] for e in es.values()) == [1, 2]
    assert es[max(ids, key=lambda i: es[i]["score"])]["rank"] == 1


# ------------------------------------------------------------------------------- figure
def test_figure_layout_and_bytes():
    from tngsight.figure import build_figure, render_bytes, as_payload
    p = synth_payload(3)
    fig = build_figure(p, intrinsic=True, vwin=300)
    axes = fig.get_axes()
    assert len(axes) == 12 and tuple(fig.get_size_inches()) == (19, 10.6)
    assert axes[0].get_xlim() == (-300, 300) and axes[0].get_ylim() == (-0.08, 1.32)
    assert "20,000" in axes[0].get_title() and "S/N = 8" in axes[0].get_title()
    assert "40,000" in axes[3].get_title() and "S/N = 5" in axes[3].get_title()
    png = render_bytes(p, fmt="png", dpi=30)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    pdf = render_bytes(p, fmt="pdf", dpi=30, seed=1)
    assert pdf[:5] == b"%PDF-" and pdf == render_bytes(p, fmt="pdf", dpi=30, seed=1)
    raw_map = {"geom": json.dumps(p["geom"]), "v_sys": p["v_sys"],
               **{f"logN_{k}": 1.0 for k in config.LINE_KEYS},
               **{f"{k}_{s}": p[{"lambda": "lam", "tau": "tau", "rest": "rest"}[s]][k]
                  for k in config.LINE_KEYS for s in ("lambda", "tau", "rest")}}
    assert as_payload(raw_map)["geom"] == p["geom"]
    with pytest.raises(ValueError):
        render_bytes(p, fmt="svg")


def test_figure_vwin_clamped_to_data():
    """vwin beyond the +v_sys-shifted ±1500 km/s grid is clamped: no padded fake continuum is drawn."""
    from tngsight.figure import build_figure, max_vwin
    p = synth_payload(3)
    lim = max_vwin(p, 20000)
    assert 1500 - abs(p["v_sys"]) - 40 < lim < 1500 - abs(p["v_sys"])
    for vs in (-128.0, 128.0):
        q = {**p, "v_sys": vs}
        fig = build_figure(q, vwin=1500)
        lo, hi = fig.get_axes()[0].get_xlim()
        assert hi == -lo == pytest.approx(max_vwin(q, 20000)) and hi < 1500 - 128
    assert build_figure(p, vwin=300).get_axes()[0].get_xlim() == (-300, 300)
    with pytest.raises(ValueError):
        build_figure(p, vwin=float("nan"))


# ------------------------------------------------------------------------------- generator
def test_generator_resolve_geometry_offline():
    from tngsight.generate import resolve_geometry
    sl, gid = resolve_geometry(G.canonicalize("face", 50, 90))
    assert gid == "face_b050_a090" and sl["orientation"] == "face-on"
    sl2, gid2 = resolve_geometry({**sl, "id": "face_b050_a090"})
    assert sl2 == sl and gid2 == gid
    with pytest.raises(ValueError):
        resolve_geometry({"orientation": "random", "b_kpc": 5, "azimuth_deg": 3})


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("TNG_RUN_SLOW") != "1", reason="set TNG_RUN_SLOW=1 (loads yt+trident+cutout)")
@need_raw
def test_generator_reproduces_stored_face_b050_a090():
    from tngsight.generate import Generator
    if not config.cutout_path().exists():
        pytest.skip(f"no cutout at {config.cutout_path()}")
    idx = os.environ.get("TNG_INDEX_FILE") or (str(config.cutout_path()) + ".ewah")
    stages = []
    gen = Generator(index_filename=idx, workdir=os.environ.get("TNG_WORKDIR"))
    p = gen.generate(G.canonicalize("face-on", 50, 90), progress=lambda s, f, m: stages.append(s))
    ref = L.load_npz(raw("face_b050_a090"))
    assert p["id"] == "face_b050_a090"
    assert_geom_close(p["geom"], ref["geom"])
    for st in ("load", "ray", "spectrum:OVI", "spectrum:HILyb", "spectrum:CIII", "save"):
        assert st in stages
    assert not list(gen.workdir.glob("_cgmray_*"))
    for k in config.LINE_KEYS:
        assert np.array_equal(p["lam"][k], ref["lam"][k])
        assert abs(p["logN"][k] - ref["logN"][k]) < 1e-6, (k, p["logN"][k], ref["logN"][k])
        t, r = p["tau"][k].astype(float), ref["tau"][k].astype(float)
        np.testing.assert_allclose(t, r, rtol=1e-5, atol=1e-5 * max(1.0, r.max()) * 1e-3, err_msg=k)


# ------------------------------------------------------------------------------- Phase 2: custom rays
LIB = config.library_dir() / "sightlines"
need_lib = pytest.mark.skipif(not LIB.is_dir(), reason=f"sightline library not at {LIB}")
CUSTOM_LIB_IDS = ["face_b050_a090", "edge_b100_a090", "face_b150_a330", "edge_b050_a000",
                  "rand_b005_a134_s479980658", "rand_b050_a215"]          # rand_b050_a215: legacy, seedless


def lib_npz(id):
    p = LIB / f"{id}.npz"
    return p if p.exists() else raw(id)


@need_lib
@pytest.mark.parametrize("id", CUSTOM_LIB_IDS)
def test_make_endpoints_reproduces_library(id):
    g = L.load_npz(lib_npz(id))["geom"]
    C = G.CENTER_KPC
    n = G.make_endpoints(np.array(g["start_kpc"]) - C, np.array(g["end_kpc"]) - C)
    for k in ("start_ckpch", "end_ckpch"):
        a, b = np.array(n[k]), np.array(g[k])
        assert np.max(np.abs(a - b) / np.abs(b)) <= 1e-12, k
    assert np.max(np.abs(np.array(n["n_los"]) - g["n_los"])) <= 1e-12
    assert np.max(np.abs(np.array(n["anchor_kpc"]) - g["anchor_kpc"])) <= 1e-9
    assert abs(n["half_kpc"] - g["half_kpc"]) <= 1e-9
    assert abs(n["v_sys_kms"] - g["v_sys_kms"]) <= 1e-9
    assert abs(n["b_kpc"] - g["b_kpc"]) <= 1e-9
    assert abs((n["azimuth_deg"] - g["azimuth_deg"] + 180) % 360 - 180) <= 1e-7
    assert n["b_segment_kpc"] == n["b_kpc"] and abs(n["length_kpc"] - 2 * g["half_kpc"]) <= 1e-9
    # catalog p0/p1 helpers: start/end_kpc - CENTER_KPC to 0.01 kpc, from the geom alone
    p0, p1 = L.npz_endpoints(lib_npz(id))
    np.testing.assert_allclose(p0, np.array(g["start_kpc"]) - C, atol=0.005 + 1e-9)
    np.testing.assert_allclose(p1, np.array(g["end_kpc"]) - C, atol=0.005 + 1e-9)
    assert L.geom_endpoints({k: g[k] for k in ("start_ckpch", "end_ckpch")}) == (p0, p1)


def test_make_endpoints_math_and_keys():
    from tngsight.generate import GEOM_KEYS
    g = G.make_endpoints([-100, 0, 0], [100, 0, 0])
    assert list(g)[: len(GEOM_KEYS)] == list(GEOM_KEYS)
    assert list(g)[len(GEOM_KEYS):] == ["kind", "p0_kpc", "p1_kpc", "length_kpc", "angle_to_normal_deg",
                                        "b_segment_kpc"]
    assert g["orientation"] == "custom" and g["inclination_deg"] is None and g["kind"] == "endpoints"
    assert g["n_los"] == [1.0, 0.0, 0.0] and g["length_kpc"] == 200.0 and g["half_kpc"] == 100.0
    assert g["b_kpc"] == 0.0 and g["azimuth_deg"] == 0.0 and g["b_perp_check_kpc"] == g["b_kpc"]
    np.testing.assert_allclose(g["anchor_kpc"], G.CENTER_KPC, atol=1e-12)
    assert math.isclose(g["v_sys_kms"], G.SUBVEL[0], rel_tol=1e-15)
    np.testing.assert_allclose(g["start_ckpch"], (G.CENTER_KPC + [-100, 0, 0]) * G.H, rtol=1e-15)
    assert math.isclose(g["angle_to_normal_deg"], math.degrees(math.acos(abs(G.LHAT[0]))), abs_tol=1e-9)
    json.dumps(g, allow_nan=False)
    # segment that misses its closest approach: b_segment = nearer endpoint distance
    h = G.make_endpoints([50, 30, 0], [150, 30, 0])
    assert math.isclose(h["b_kpc"], 30.0, abs_tol=1e-9)
    assert math.isclose(h["b_segment_kpc"], math.hypot(50, 30), rel_tol=1e-12)
    # along the disk normal -> angle 0; in the plane (xhat) -> 90
    a = G.make_endpoints(list(-100 * G.LHAT), list(100 * G.LHAT))
    assert a["angle_to_normal_deg"] < 1e-6 and a["b_kpc"] < 1e-9 and a["azimuth_deg"] == 0.0
    e = G.make_endpoints(list(-100 * G.XHAT + 20 * G.LHAT), list(100 * G.XHAT + 20 * G.LHAT))
    assert abs(e["angle_to_normal_deg"] - 90) < 1e-6 and abs(e["b_kpc"] - 20) < 1e-9
    assert abs(e["azimuth_deg"] - 90) < 1e-6                     # displaced along the minor (polar) axis
    with pytest.raises(ValueError):
        G.make_endpoints([1, 2, 3], [1, 2, 3])


def test_canonicalize_endpoints_golden_and_rounding():
    c = G.canonicalize_endpoints((-100, 0, 0), (100, 0, 0))
    assert c == {"kind": "endpoints", "p0_kpc": [-100.0, 0.0, 0.0], "p1_kpc": [100.0, 0.0, 0.0],
                 "id": "cust_35277e0469"}
    c = G.canonicalize_endpoints([12.34, -56.78, 90.05], [-200.0, 150.25, -0.04])
    assert c["id"] == "cust_b7fe2279d7"
    assert c["p0_kpc"] == [12.3, -56.8, 90.0] and c["p1_kpc"] == [-200.0, 150.2, 0.0]
    assert json.dumps(c["p1_kpc"]) == "[-200.0, 150.2, 0.0]"     # -0.04 -> 0, never -0
    # x.x5 cases follow Python round() of 10*x (half-to-even on the binary value)
    c = G.canonicalize_endpoints([0.25, 0.35, -0.05], [100.45, 1.15, -2.25])
    assert c["p0_kpc"] == [round(2.5) / 10, round(3.5) / 10, 0.0] == [0.2, 0.4, 0.0]
    assert c["p1_kpc"] == [round(1004.5) / 10, round(11.5) / 10, round(-22.5) / 10]
    assert str(c["p0_kpc"][2]) == "0.0"
    assert G.custom_id(c["p0_kpc"], c["p1_kpc"]) == c["id"]
    assert G.canonicalize_endpoints(c["p0_kpc"], c["p1_kpc"]) == c         # idempotent
    assert G.canonicalize_endpoints(np.array([-100.0, 0, 0]), (100, 0, 0))["id"] == "cust_35277e0469"
    assert G.canonicalize_endpoints((395.0, 0, 0), (0, 0, 0))["p0_kpc"] == [395.0, 0.0, 0.0]
    assert G.canonicalize_endpoints((0, 0, 0), (0, 20.0, 0))["p1_kpc"] == [0.0, 20.0, 0.0]
    assert G.canonicalize_endpoints((-395, 0, 0), (395, 0, 0))["p1_kpc"] == [395.0, 0.0, 0.0]   # 790 kpc
    assert G.canonicalize_endpoints((395.04, 0, 0), (0, 0, 0))["p0_kpc"] == [395.0, 0.0, 0.0]  # quantised first


@pytest.mark.parametrize("p0,p1,msg", [
    ((395.1, 0, 0), (0, 0, 0), "p0_kpc: |p| = 395.1 kpc exceeds 395 kpc"),
    ((0, 0, 0), (0, -401.2, 0), "p1_kpc: |p| = 401.2 kpc exceeds 395 kpc"),
    ((0, 0, 0), (0, 0, 19.9), "length 19.9 kpc outside [20, 800] kpc"),
    ((0, 0, 0), (12.3, 0, 0), "length 12.3 kpc outside [20, 800] kpc"),
    ((1, 2, float("nan")), (0, 0, 0), "p0_kpc[2] must be finite"),
    ((1, 2, 3), (float("inf"), 0, 0), "p1_kpc[0] must be finite"),
    ((True, 0, 0), (50, 0, 0), "p0_kpc[0] must be a number"),
    ((0, 0), (50, 0, 0), "p0_kpc must have 3 components"),
    ((0, 0, 0, 0), (50, 0, 0), "p0_kpc must have 3 components"),
    ((0, "1", 0), (50, 0, 0), "p0_kpc[1] must be a number"),
    ("abc", (50, 0, 0), "p0_kpc must be a list of 3 numbers"),
    (None, (50, 0, 0), "p0_kpc must be a list of 3 numbers"),
])
def test_canonicalize_endpoints_rejects(p0, p1, msg):
    with pytest.raises(ValueError) as e:
        G.canonicalize_endpoints(p0, p1)
    assert msg in str(e.value)


def test_canonicalize_endpoints_length_upper_bound(monkeypatch):
    """With |p| <= 395 the longest ray is 790 kpc, so the 800 kpc bound is checked with R relaxed."""
    monkeypatch.setattr(G, "R_CUSTOM_MAX_KPC", 500.0)
    assert G.canonicalize_endpoints((-400, 0, 0), (400, 0, 0))["p1_kpc"] == [400.0, 0.0, 0.0]
    with pytest.raises(ValueError, match=r"length 800\.1 kpc outside \[20, 800\] kpc"):
        G.canonicalize_endpoints((-400, 0, 0), (400.1, 0, 0))


def test_endpoints_reversal():
    a = G.canonicalize_endpoints((-50, 20, 5), (120, -30, 40))
    b = G.canonicalize_endpoints(a["p1_kpc"], a["p0_kpc"])
    ga, gb = G.make_endpoints(a["p0_kpc"], a["p1_kpc"]), G.make_endpoints(b["p0_kpc"], b["p1_kpc"])
    np.testing.assert_allclose(ga["n_los"], -np.array(gb["n_los"]), atol=1e-15)
    assert math.isclose(ga["v_sys_kms"], -gb["v_sys_kms"], rel_tol=1e-12)
    assert math.isclose(ga["b_kpc"], gb["b_kpc"], rel_tol=1e-12)
    assert math.isclose(ga["angle_to_normal_deg"], gb["angle_to_normal_deg"], abs_tol=1e-9)
    assert a["id"] != b["id"]


def test_resolve_geometry_endpoints_and_custom_catalog_entry():
    from tngsight.generate import resolve_geometry
    c = G.canonicalize_endpoints((-100, 0, 0), (100, 0, 0))
    sl, gid = resolve_geometry(c)
    assert gid == "cust_35277e0469" and sl == G.make_endpoints(c["p0_kpc"], c["p1_kpc"])
    sl2, gid2 = resolve_geometry({k: v for k, v in c.items() if k != "id"})
    assert gid2 == gid and sl2 == sl
    sl3, gid3 = resolve_geometry({"kind": "endpoints", "p0_kpc": [-100.004, 0, 0], "p1_kpc": [100, 0, 0],
                                  "id": "cust_test"})
    assert gid3 == "cust_test" and sl3["p0_kpc"] == [-100.004, 0.0, 0.0]          # exact, unrounded
    full = {**sl, "id": gid, "extra_key": 1}                                       # a stored full geom
    sl4, gid4 = resolve_geometry(full)
    assert gid4 == gid and sl4["extra_key"] == 1 and "id" not in sl4
    # npz round trip + id + catalog row of a custom payload
    p = synth_payload()
    p.update(id=None, geom=sl, v_sys=sl["v_sys_kms"])
    buf = io.BytesIO()
    L.save_npz(buf, sl, p["logN"], p["tau"]); buf.seek(0)
    q = L.load_npz(buf)
    assert q["id"] == "cust_35277e0469" and q["geom"] == json.loads(json.dumps(sl))
    comps = {"OVI": [{"v": 1.0, "dv": 0.1, "logN": 13.0, "dlogN": 0.01, "b": 20.0, "db": 0.2, "region": 0,
                      "flag": 0, "EW": 10.0}], "HILyb": [], "CIII": []}
    e = L.catalog_entry(q, None, "generated", components=comps)
    assert e["orientation"] == "custom" and e["kind"] == "endpoints" and e["seed"] is None
    assert e["p0"] == [-100.0, 0.0, 0.0] and e["p1"] == [100.0, 0.0, 0.0]
    assert e["b_kpc"] == 0.0 and e["azimuth_deg"] == 0.0 and e["length_kpc"] == 200.0
    assert e["has_components"] is True and e["n_fit"] == {"OVI": 1, "HILyb": 0, "CIII": 0}
    assert e["angle_to_normal_deg"] == round(sl["angle_to_normal_deg"], 1) and e["b_segment_kpc"] == 0.0
    json.dumps(e, allow_nan=False)
    e2 = L.catalog_entry({**q, "id": "cust_5000000012"}, None, "generated")     # "_s\d+" never read as a seed
    assert e2["seed"] is None and e2["has_components"] is False and "n_fit" not in e2
    lib = L.catalog_entry({**synth_payload(), "id": "face_b050_a090"}, None, "library")
    assert "kind" not in lib and lib["has_components"] is False and len(lib["p0"]) == 3


def _reference_geom(id):
    """The library sightline's own generation request (rand ids carry their seed)."""
    o, b, a = id.split("_")[:3]
    seed = int(id.rsplit("_s", 1)[1]) if "_s" in id else None
    return G.canonicalize(o, int(b[1:]), int(a[1:]), seed=seed)


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("TNG_RUN_SLOW") != "1", reason="set TNG_RUN_SLOW=1 (loads yt+trident+cutout)")
@pytest.mark.parametrize("id", ["face_b050_a090", "rand_b075_a000_s12345"])
def test_custom_ray_reproduces_library_ray(id):
    """A custom ray through a library sightline's exact endpoints == that sightline (same process)."""
    import time
    from tngsight.generate import Generator
    if not config.cutout_path().exists():
        pytest.skip(f"no cutout at {config.cutout_path()}")
    idx = os.environ.get("TNG_INDEX_FILE") or str(config.index_path())
    gen = Generator(index_filename=idx, workdir=os.environ.get("TNG_WORKDIR"), fit_components=True)
    ref_geom = _reference_geom(id)
    stages_ref = []
    ref = gen.generate(ref_geom, progress=lambda s, f, m: stages_ref.append((s, m)))
    C = G.CENTER_KPC
    p0 = (np.array(ref["geom"]["start_kpc"]) - C).tolist()
    p1 = (np.array(ref["geom"]["end_kpc"]) - C).tolist()
    stages = []
    t0 = time.monotonic()
    cus = gen.generate({"kind": "endpoints", "p0_kpc": p0, "p1_kpc": p1, "id": "cust_test"},
                       progress=lambda s, f, m: stages.append((s, m)))
    dt = time.monotonic() - t0
    print(f"\n{id}: custom ray generated in {dt:.1f} s (incl. fit)")
    assert cus["id"] == "cust_test" and cus["geom"]["kind"] == "endpoints"
    names = [s for s, _ in stages]
    for st in ("ray", "spectrum:OVI", "spectrum:HILyb", "spectrum:CIII", "fit", "save"):
        assert st in names, st
    assert names.index("fit") > names.index("spectrum:CIII") and names.index("fit") < names.index("save")
    for k in config.LINE_KEYS:
        assert np.array_equal(cus["lam"][k], ref["lam"][k])
        dtau = float(np.max(np.abs(cus["tau"][k].astype(float) - ref["tau"][k].astype(float))))
        print(f"  {k}: max|dtau| = {dtau:.3g}, dlogN = {abs(cus['logN'][k] - ref['logN'][k]):.3g}")
        assert dtau <= 1e-6, (k, dtau)
        assert abs(cus["logN"][k] - ref["logN"][k]) <= 1e-9, k
    if "components" in ref:
        assert cus.get("components") == ref["components"]
    # and both equal the stored library npz where it exists
    stored = lib_npz(id) if lib_npz(id).exists() else config.library_dir() / "generated" / f"{id}.npz"
    if stored.exists():
        s = L.load_npz(stored)
        for k in config.LINE_KEYS:
            print(f"  {k}: vs stored npz max|dtau| = "
                  f"{float(np.max(np.abs(s['tau'][k].astype(float) - cus['tau'][k].astype(float)))):.3g}")


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("TNG_RUN_SLOW") != "1", reason="set TNG_RUN_SLOW=1 (loads yt+trident+cutout)")
def test_custom_ray_800kpc_timing():
    """Design §11: report the cast time of the longest legal custom ray (790 kpc through the centre)."""
    import time
    from tngsight.generate import Generator
    if not config.cutout_path().exists():
        pytest.skip(f"no cutout at {config.cutout_path()}")
    idx = os.environ.get("TNG_INDEX_FILE") or str(config.index_path())
    gen = Generator(index_filename=idx, workdir=os.environ.get("TNG_WORKDIR"), fit_components=True)
    gen.load()
    c = G.canonicalize_endpoints([-395.0, 0.0, 0.0], [395.0, 0.0, 0.0])    # box x axis: exact in tenths
    stages = []
    t0 = time.monotonic()
    p = gen.generate(c, progress=lambda s, f, m: stages.append((time.monotonic() - t0, s, m)))
    dt = time.monotonic() - t0
    print(f"\n{c['id']}: L = {p['geom']['length_kpc']:.1f} kpc in {dt:.1f} s; logN = {p['logN']}")
    for t, s, m in stages:
        print(f"  {t:7.1f} s  {s:16s} {m}")
    assert dt < 900                                            # the job timeout
