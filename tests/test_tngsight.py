"""Tests for the tngsight package (design.md §7; Phase-3 data v2: 12 registry lines, npz v2, TNGS v2, degrade_v).
Real-library tests read the raw v1 npz set and skip if it is absent: TNG_RAW_SIGHTLINES (cgm_sid488530_<id>.npz), else
the v1 library under the work root, $TNG_WORK/data/library/sightlines (<id>.npz, byte copies of the raw files made by
deploy/data/build_library.py). The Generator integration tests are @slow and run only with TNG_RUN_SLOW=1 (yt/trident + the slim
cutout). Temp files go to $TNG_TEST_TMP when set (else pytest's tmp_path)."""
import io
import json
import math
import os
import struct
import uuid
import zipfile
from pathlib import Path
import numpy as np
import pytest

from tngsight import config, geometry as G, ions as I, library as L

def work_root() -> Path:
    """tngsight.config.work_root() (the TNG_WORK contract), or the same rule while config lacks it."""
    f = getattr(config, "work_root", None)
    return Path(f()) if callable(f) else Path(os.environ.get("TNG_WORK") or "/Volumes/cgm_work")


LIB_V1 = work_root() / "data" / "library"          # the v1 library (3-line npz, TNGS v1 web)
RAW_ENV = os.environ.get("TNG_RAW_SIGHTLINES")
RAW = Path(RAW_ENV) if RAW_ENV else LIB_V1 / "sightlines"
GRID_INDEX = Path(__file__).resolve().parent.parent / "tng50" / "data" / "grid_index.csv"
need_raw = pytest.mark.skipif(not RAW.is_dir(), reason=f"raw sightline library not at {RAW}")


def raw(id):
    """The raw v1 npz of `id`: the raw set's cgm_sid488530_<id>.npz, or its byte copy <id>.npz in the v1 library."""
    return RAW / (L.npz_name(id) if RAW_ENV else f"{id}.npz")


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


# ------------------------------------------------------------------------------- library v2: grids
C_KMS = 299792.458


def test_native_grid_matches_trident_rule():
    """design §2.1: lam_field = linspace(round(lmin/dl)dl, round(lmax/dl)dl, n), dl = λ0·0.25/c; u_0 = −1499.958,
    n = 12001 at W = 1500; the damped H I windows give 20001 / 60001 / 80001 px."""
    for k in I.KEYS:
        rest = I.get(k)["lam0_A"]
        lam0, dlam, n = L.native_grid(k)
        assert n == 12001, k
        dl = rest * 0.25 / C_KMS
        lo = np.round(rest * (1 - 1500 / C_KMS) / dl) * dl; hi = np.round(rest * (1 + 1500 / C_KMS) / dl) * dl
        lam = np.linspace(lo, hi, int(np.round((hi - lo) / dl + 1)))
        assert lam.size == n and lam0 == lam[0] and abs(dlam - dl) <= 1e-12 * dl
        u = L.native_u(k)
        assert abs(u[0] - (0.25 * round((C_KMS - 1500) / 0.25) - C_KMS)) < 1e-6 and abs(u[0] + 1499.958) < 1e-3
        assert np.max(np.abs(np.diff(u) - 0.25)) < 1e-9 * C_KMS * 1e-3
        assert np.max(np.abs(lam0 + np.arange(n) * dlam - lam)) <= 1e-9 * rest
    assert [L.native_grid("HI", W)[2] for W in (2500, 7500, 10000)] == [20001, 60001, 80001]


def v1_payload_like():
    """A v1 (3-line, dλ = 0.002 Å) payload dict as the old library wrote it, for the v1 readers."""
    rng = np.random.default_rng(5)
    g = G.make_sightline("edge-on", 100.0, 90.0)
    lam = {k: L.wavelength_grid(k) for k in L.V1_KEYS}
    tau = {k: (rng.random(lam[k].size) * 2).astype(np.float32) for k in L.V1_KEYS}
    rest = {k: config.GALAXY["lines"][k]["rest_A"] for k in L.V1_KEYS}
    return g, lam, tau, rest


def write_v1_npz(path, g, lam, tau, rest):
    """The exact v1 member order: geom, v_sys, logN_{OVI,HILyb,CIII}, then <k>_lambda/_tau/_rest per line."""
    m = dict(geom=json.dumps(g), v_sys=float(g["v_sys_kms"]), logN_OVI=14.0, logN_HILyb=15.5, logN_CIII=-np.inf)
    for k in L.V1_KEYS:
        m[f"{k}_lambda"] = lam[k]; m[f"{k}_tau"] = tau[k]; m[f"{k}_rest"] = float(rest[k])
    np.savez_compressed(path, **m)


def synth_payload(seed=0, lines=None, hi_logN=19.486):
    """A v2 payload on the true native grids: random τ (+ one saturated H I stretch); H I is damped (W 2500)."""
    rng = np.random.default_rng(seed)
    g = G.make_sightline("edge-on", 100.0, 90.0)
    lines = list(I.KEYS) if lines is None else lines
    p = {"geom": g, "lines": lines, "generation": L.generation_record(), "logN": {}, "tau": {}, "lam0": {},
         "dlam": {}, "rest": {}, "W": {}}
    for k in lines:
        logN = hi_logN if k == "HI" else 14.0 - 0.1 * I.get(k)["order"]
        W = I.gen_window(k, logN)
        lam0, dlam, n = L.native_grid(k, W)
        t = (rng.random(n) * 0.2).astype(np.float32)
        if k == "HI":
            t[:50] = 7e5
        p["logN"][k] = logN; p["tau"][k] = t; p["lam0"][k] = lam0; p["dlam"][k] = dlam
        p["rest"][k] = I.get(k)["lam0_A"]; p["W"][k] = W
    buf = io.BytesIO(); L.save_npz(buf, p); buf.seek(0)
    return L.load_npz(buf, id="edge_b100_a090")


# ------------------------------------------------------------------------------- npz v2 / v1
def test_npz_v2_round_trip_exact(scratch):
    p = synth_payload()
    assert p["format"] == 2 and p["lines"] == list(I.KEYS) and p["W"]["HI"] == 2500 and p["tau"]["HI"].size == 20001
    out = scratch / "edge_b100_a090.npz"
    L.save_npz(out, p)
    q = L.load_npz(out)
    assert q["id"] == "edge_b100_a090" and q["geom"] == p["geom"] and q["v_sys"] == p["v_sys"]
    assert q["generation"] == p["generation"] and q["generation"]["registry_tag"] == I.registry_tag()
    assert q["generation"]["min_tau"] == 1e-8 and q["generation"]["dv_kms"] == 0.25
    for k in I.KEYS:
        assert q["tau"][k].dtype == np.float32 and np.array_equal(q["tau"][k], p["tau"][k])   # bitwise
        assert q["lam0"][k] == p["lam0"][k] and q["dlam"][k] == p["dlam"][k] and q["W"][k] == p["W"][k]
        assert q["logN"][k] == p["logN"][k] and q["rest"][k] == I.get(k)["lam0_A"]
        assert abs(q["du"][k] - 0.25) < 1e-9 and q["u"][k].dtype == np.float64
        assert np.array_equal(q["lam"][k], q["lam0"][k] + np.arange(q["tau"][k].size) * q["dlam"][k])
    with zipfile.ZipFile(out) as z:
        assert [n[:-4] for n in z.namelist()] == L.npz_members(I.KEYS)                     # exact member order
        assert not [n for n in z.namelist() if n.endswith("_lambda.npy")]
    with np.load(out, allow_pickle=False) as d:
        assert str(d["format"]) == "tngsight-npz/2" and d["geom"].dtype.kind == "U" and d["v_sys"].dtype == np.float64
        assert d["OVI_tau"].dtype == np.float32 and d["OVI_lam0"].dtype == np.float64 and d["OVI_W"].shape == ()
    assert not list(scratch.glob(".*tmp*"))                                                 # atomic write
    sub = synth_payload(lines=["OVI", "OVII"])                                              # any subset
    assert sub["lines"] == ["OVI", "OVII"] and set(sub["tau"]) == {"OVI", "OVII"}
    with pytest.raises(ValueError, match="unknown line keys"):
        L.save_npz(io.BytesIO(), {**p, "lines": ["HILyb"]})
    buf = io.BytesIO()
    np.savez_compressed(buf, format="tngsight-npz/2", geom=json.dumps(p["geom"]), v_sys=1.0, lines='["OVI"]',
                        generation="{}", logN_OVI=1.0)
    buf.seek(0)
    with pytest.raises(ValueError, match="npz missing keys"):
        L.load_npz(buf)


def test_npz_v1_read(scratch):
    g, lam, tau, rest = v1_payload_like()
    f = scratch / "cgm_sid488530_edge_b100_a090.npz"
    write_v1_npz(f, g, lam, tau, rest)
    p = L.load_npz(f)
    assert p["format"] == 1 and p["id"] == "edge_b100_a090" and p["lines"] == ["CIII", "OVI"]
    assert p["dropped"] == ["HILyb"] and "HILyb" not in p["tau"] and p["generation"]["min_tau"] == 1e-3
    for k in ("OVI", "CIII"):
        assert np.array_equal(p["tau"][k], tau[k]) and np.array_equal(p["lam"][k], lam[k])
        assert p["W"][k] == 1500 and p["du"][k] == pytest.approx(C_KMS * 0.002 / rest[k], rel=1e-12)
        assert np.allclose(p["u"][k], C_KMS * (lam[k].astype(float) / rest[k] - 1))
    buf = io.BytesIO(); np.savez_compressed(buf, geom=json.dumps(g), v_sys=1.0, logN_OVI=1.0); buf.seek(0)
    with pytest.raises(ValueError, match="npz missing keys"):
        L.load_npz(buf)


@pytest.mark.skipif(not (LIB_V1 / "sightlines").is_dir(), reason=f"v1 library not at {LIB_V1}")
@pytest.mark.parametrize("id", ["edge_b100_a090", "face_b050_a090", "rand_b005_a134_s479980658"])
def test_npz_v1_load_existing_library(id):
    """design §8 U_ions 3: v1 load of existing library npz gives OVI and CIII with the identical τ."""
    p = L.load_npz(LIB_V1 / "sightlines" / f"{id}.npz")
    with np.load(LIB_V1 / "sightlines" / f"{id}.npz", allow_pickle=False) as d:
        for k in ("OVI", "CIII"):
            assert np.array_equal(p["tau"][k], d[f"{k}_tau"]) and p["logN"][k] == float(d[f"logN_{k}"])
    assert p["id"] == id and p["format"] == 1 and p["lines"] == ["CIII", "OVI"] and p["dropped"] == ["HILyb"]


# ------------------------------------------------------------------------------- web grid + TNGS v2
def test_web_flux_box_average_conserves_ew():
    p = synth_payload(1)
    for k in ("HI", "OVI", "OVII"):
        u, Fw = L.web_flux(p, k)
        W = int(p["W"][k])
        assert u.size == 2 * W + 1 and u[0] == -W and np.all(np.diff(u) == 1.0)
        un, F = p["u"][k], np.exp(-p["tau"][k].astype(float))
        # Σ F_web·(e+ − e−) = ∫F du over the native range (the box average conserves EW exactly)
        lo = np.clip(u - 0.5, un[0], un[-1]); hi = np.clip(u + 0.5, un[0], un[-1])
        assert np.sum(Fw * (hi - lo)) == pytest.approx(np.trapz(F, un), rel=1e-12)
        j = W + 7                 # an interior bin, design §2.2: (I(e+) − I(e−))/(e+ − e−), I linearly interpolated
        a, b = u[j] - 0.5, u[j] + 0.5
        I_ = lambda x: np.trapz(F[un <= x], un[un <= x])                       # noqa: E731 cumulative at samples
        ia, ib = int(np.searchsorted(un, a)) - 1, int(np.searchsorted(un, b)) - 1
        Ia = I_(un[ia]) + (I_(un[ia + 1]) - I_(un[ia])) * (a - un[ia]) / (un[ia + 1] - un[ia])
        Ib = I_(un[ib]) + (I_(un[ib + 1]) - I_(un[ib])) * (b - un[ib]) / (un[ib + 1] - un[ib])
        assert Fw[j] == pytest.approx(Ib - Ia, abs=1e-9)
        assert F[(un > a) & (un < b)].min() - 1e-12 <= Fw[j] <= F[(un > a - 0.25) & (un < b + 0.25)].max() + 1e-12


def legacy_decode_v1(blob):
    """Today's (Phase-2) decoder of a TNGS v1 blob, verbatim in behaviour: {key: (lam, flux)}."""
    _, ver, nl, _ = struct.unpack_from("<4sBBH", blob, 0)
    off, out = 8, {}
    for k in ("OVI", "HILyb", "CIII")[:nl]:
        n, lam0, dg, rest, dl = struct.unpack_from("<Idddd", blob, off); off += 36
        q = np.frombuffer(blob, "<u2", n, off); off += 2 * n
        out[k] = (lam0 + np.arange(n) * dg, q / 65535.0, rest)
    return out


TNGS_CASES = Path(__file__).resolve().parent / "js" / "fixtures" / "fit_tngs_cases.json"
_TNGS = json.loads(TNGS_CASES.read_text())["cases"] if TNGS_CASES.is_file() else []


@pytest.mark.skipif(not _TNGS, reason=f"crafted TNGS fixture missing: {TNGS_CASES}")
@pytest.mark.parametrize("case", _TNGS, ids=[c["name"] for c in _TNGS])
def test_decode_web_crafted_v2(case):
    """Phase-3 Code 4: decode_web accepts or refuses each crafted TNGS v2 blob as docs/tng50/js/fit.js decodeTNGS does
    (tests/js/fit_decode.mjs runs the same blobs; make_fit_fixture.py writes the expected outcomes out by hand)."""
    import base64
    blob = base64.b64decode(case["blob"])
    if not case["expect"]["ok"]:
        with pytest.raises(ValueError):
            L.decode_web(blob)
        return
    d = L.decode_web(blob)
    assert list(d["lines"]) == case["expect"]["lines"] and d["skipped"] == case["expect"]["skipped"]
    for ln in d["lines"].values():
        assert ln["n"] == ln["flux"].size == ln["u"].size and np.all(np.isfinite(ln["u"])) and ln["du"] > 0


def test_tngs_v2_round_trip():
    p = synth_payload(2)
    blob = L.encode_web(p)
    assert blob[:4] == b"TNGS" and blob[4] == 2 and blob[5] == 12 and blob[6:8] == b"\0\0"
    assert struct.unpack_from("<d", blob, 8)[0] == p["v_sys"]
    assert len(blob) == 16 + sum(40 + 2 * (2 * int(p["W"][k]) + 1) for k in I.KEYS)
    assert blob[16:24] == b"HI\0\0\0\0\0\0"
    d = L.decode_web(blob)
    assert d["version"] == 2 and d["vSys"] == p["v_sys"] and d["skipped"] == [] and list(d["lines"]) == list(I.KEYS)
    for k in I.KEYS:
        ln = d["lines"][k]; u, Fw = L.web_flux(p, k)
        assert ln["n"] == u.size and ln["u0"] == -p["W"][k] and ln["du"] == 1.0 and ln["rest"] == I.get(k)["lam0_A"]
        assert np.max(np.abs(ln["flux"] - np.clip(Fw, 0, 1))) <= 7.7e-6                 # design §8 U_ions 3
        assert np.array_equal(ln["u"], u)
    assert len(L.encode_web(synth_payload(lines=["NeVIII"]))) == 16 + 40 + 2 * 3001
    assert L.decode_web(L.encode_web(synth_payload(lines=["NeVIII"])))["lines"]["NeVIII"]["n"] == 3001
    with pytest.raises(ValueError, match="trailing bytes"):
        L.decode_web(blob + b"\0")
    with pytest.raises(ValueError, match="truncated"):
        L.decode_web(blob[:-1])
    # forward compatibility: an unknown key is skipped and reported; a repeated key is an error
    rec = 40 + 2 * 3001
    one = L.encode_web(synth_payload(lines=["NeVIII"]))
    two = bytearray(one[:5] + bytes([2]) + one[6:]) + one[16:16 + rec]
    two[16 + rec:16 + rec + 8] = b"FeXVII\0\0"
    d2 = L.decode_web(bytes(two))
    assert d2["skipped"] == ["FeXVII"] and list(d2["lines"]) == ["NeVIII"]
    dup = bytes(one[:5] + bytes([2]) + one[6:]) + one[16:16 + rec]
    with pytest.raises(ValueError, match="duplicate"):
        L.decode_web(dup)


def test_tngs_v1_decode_and_v1_payload_encode(scratch):
    """decode_web(v1 bin) = today's decoder for OVI and CIII (HILyb skipped, vSys None); a v1 payload encodes to
    TNGS v2 with its 2 lines."""
    g, lam, tau, rest = v1_payload_like()
    blob = L.encode_web({"tau": tau, "rest": rest})          # the raw legacy dict: v1 bytes (make_reference.py)
    assert blob[4] == 1 and blob[5] == 3
    old = legacy_decode_v1(blob)
    d = L.decode_web(blob)
    assert d["version"] == 1 and d["vSys"] is None and d["skipped"] == ["HILyb"] and set(d["lines"]) == {"OVI", "CIII"}
    for k in ("OVI", "CIII"):
        lam_o, flux_o, rest_o = old[k]
        ln = d["lines"][k]
        assert np.array_equal(ln["flux"], flux_o)
        assert ln["u0"] == pytest.approx(C_KMS * (lam_o[0] / rest_o - 1), abs=1e-9)
        assert np.allclose(ln["u"], C_KMS * (lam_o / rest_o - 1), atol=1e-6)
    f = scratch / "edge_b100_a090.npz"; write_v1_npz(f, g, lam, tau, rest)
    v2 = L.decode_web(L.encode_web(L.load_npz(f)))
    assert v2["version"] == 2 and list(v2["lines"]) == ["CIII", "OVI"] and v2["vSys"] == g["v_sys_kms"]
    lib_bin = LIB_V1 / "web" / "edge_b100_a090.bin"
    if lib_bin.is_file():                                     # a real v1 library binary
        b = lib_bin.read_bytes(); od = legacy_decode_v1(b); nd = L.decode_web(b)
        assert nd["version"] == 1 and all(np.array_equal(nd["lines"][k]["flux"], od[k][1]) for k in ("OVI", "CIII"))


def test_web_model_parity_bound():
    """A degrade_v model from the u16 web binary is within 1/65535 of the same model from the exact web flux."""
    from tngsight.degrade import degrade_v
    p = synth_payload(3)
    d = L.decode_web(L.encode_web(p))
    for k in ("HI", "CIV", "OVII"):
        u, Fw = L.web_flux(p, k)
        R = I.band(k)["R"]["default"]
        _, _, m_x = degrade_v(u, Fw, R, None, p["v_sys"], 1.0, vwin=400)
        _, _, m_q = degrade_v(d["lines"][k]["u"], d["lines"][k]["flux"], R, None, p["v_sys"], 1.0, vwin=400)
        assert np.max(np.abs(m_x - m_q)) <= 1 / 65535


# ------------------------------------------------------------------------------- AOD + catalog
def test_aod_columns():
    """logN_aod = log10(AOD_K/(f λ0) ∫τ du) reproduces injected columns exactly (saturated or not, O VII included)
    and is None for τ ≡ 0; catalog rows carry it next to the ray logN for every registry key."""
    from tngsight import vpfit
    p = synth_payload()
    inj = {"OVI": (13.4, 25.0), "OVII": (16.2, 60.0), "MgII": (12.1, 4.0), "CIII": (11.0, 15.0)}
    for k, (lN, b) in inj.items():
        p["tau"][k] = vpfit.tau_components(p["u"][k], [[0.0, lN, b]], k).astype(np.float32)
    p["tau"]["HI"] = (vpfit.tau0(19.0, 30.0, "HI") * np.exp(-(p["u"]["HI"] / 30.0) ** 2)).astype(np.float32)
    a = L.aod_columns(p)
    assert set(a) == set(I.KEYS)
    for k, (lN, _) in inj.items():
        assert abs(a[k] - lN) < 0.005, k
    assert abs(a["HI"] - 19.0) < 0.005
    p["tau"]["CIII"] = np.zeros_like(p["tau"]["CIII"])
    assert L.aod_columns(p)["CIII"] is None
    assert L.catalog_entry(p, None, "generated")["logN_aod"] == L.aod_columns(p)


ROW_KEYS = {"id", "orientation", "b_kpc", "azimuth_deg", "seed", "v_sys", "source", "data_version", "lines", "W_kms",
            "logN", "logN_aod", "ions", "has_components", "rank", "score", "n_showcase_ions", "star", "p0", "p1"}


def test_catalog_and_entry(scratch):
    import pandas as pd
    p = synth_payload()
    p["logN"]["CIII"] = -np.inf
    row = pd.read_csv(GRID_INDEX).set_index("geom_id").loc["edge_b100_a090"].to_dict()
    e = L.catalog_entry(p, row, "library")
    assert set(e) == ROW_KEYS
    assert e["data_version"] == 2 and e["lines"] == list(I.KEYS) and e["W_kms"] == {"HI": 2500.0}
    assert set(e["logN"]) == set(e["logN_aod"]) == set(e["ions"]) == set(I.KEYS)
    assert e["logN"]["CIII"] is None and e["logN"]["OVI"] == round(p["logN"]["OVI"], 3)
    assert e["rank"] == int(row["rank"]) and e["score"] == pytest.approx(row["showcase_score"], abs=5e-5)
    assert e["star"] == bool(row["ovi_showcase"]) and e["seed"] is None
    assert e["ions"]["OVI"]["n_comp"] == int(row["OVI_n_comp"]) and e["ions"]["MgII"]["n_comp"] is None
    assert e["ions"]["OVI"]["min_flux"] == round(float(row["OVI_min_flux"]), 4) and e["source"] == "library"
    g = L.catalog_entry({**p, "id": "rand_b005_a134_s479980658"}, None, "generated")
    assert g["seed"] == 479980658 and g["rank"] is None and g["star"] is False and "n_fit" not in g
    v1 = L.catalog_entry({**p, "format": 1, "lines": ["CIII", "OVI"]}, None, "library")
    assert v1["data_version"] == 1 and v1["lines"] == ["CIII", "OVI"] and v1["logN"]["HI"] is None
    json.dumps(e, allow_nan=False); json.dumps(g, allow_nan=False)
    path = scratch / "catalog.json"
    c = L.Catalog(path)
    c.upsert(e); c.upsert(g); c.upsert({**e, "score": 9.0}); c.save()
    c2 = L.Catalog(path)
    assert [x["id"] for x in c2.entries()] == [e["id"], g["id"]]
    assert c2.get(e["id"])["score"] == 9.0 and c2.get("nope") is None
    raw_json = json.loads(path.read_text())
    assert raw_json["version"] == 2 and raw_json["ions"] == list(I.KEYS) and raw_json["registry_tag"] == I.registry_tag()
    assert set(raw_json) == {"version", "registry_tag", "scoring", "generation", "galaxy", "ions", "entries"}
    assert raw_json["generation"] == {"min_tau": 1e-8, "dv_native_kms": 0.25, "dv_web_kms": 1.0, "v_gen_kms": 1500.0,
                                      "trident": "1.4.2"}
    assert "cutout_hdf5" not in raw_json["galaxy"] and "ion_table" not in json.dumps(raw_json)


def test_package_json_scrubbed():
    s = (Path(config.__file__).parent / "galaxy_488530.json").read_text()
    for bad in ("/data/sborthak", "/home/tsingh65", "/scratch/tsingh65", "cutout_hdf5", "ion_table"):
        assert bad not in s
    orig = json.loads((GRID_INDEX.parent.parent / "galaxy_488530.json").read_text())
    for k, v in config.GALAXY.items():
        assert orig[k] == v
    reg = (Path(config.__file__).parent / "ions.json").read_text()
    for bad in ("/Users/", "/Volumes/", "/home/"):
        assert bad not in reg


# ------------------------------------------------------------------------------- degrade (v1, unchanged)
def legacy_lam(key):
    return L.wavelength_grid(key)


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
def test_degrade_v1_matches_independent_numpy(key, R):
    """degrade() (the v1 operator) is unchanged: same independent reference and noise behaviour as Phase 2."""
    from tngsight.degrade import degrade
    lam, rest = legacy_lam(key), config.GALAXY["lines"][key]["rest_A"]
    rng = np.random.default_rng(1)
    tau = np.exp(-0.5 * ((lam - rest) / 0.02) ** 2) * 2.0 + rng.random(lam.size) * 0.15
    v, noisy, model = degrade(lam, tau, rest, R, None, -77.8, vwin=400)
    vr, mr = reference_model(lam, tau, rest, R, -77.8, 0.002, 400)
    assert np.array_equal(v, vr) and np.array_equal(noisy, model)
    assert np.max(np.abs(model - mr)) < 1e-12
    _, _, m_med = degrade(lam, tau, rest, R, None, -77.8, dlam=float(np.median(np.diff(lam.astype(float)))), vwin=400)
    assert np.max(np.abs(m_med - model)) > 1e-6
    v2, n2, m2 = degrade(lam, tau, rest, R, 8, -77.8, seed=3, vwin=400)
    _, n3, _ = degrade(lam, tau, rest, R, 8, -77.8, seed=3, vwin=400)
    assert np.array_equal(n2, n3) and n2.min() >= 0 and np.array_equal(m2, model)
    assert np.std(n2 - m2) == pytest.approx(np.sqrt(5) / 8, rel=0.15)


# The v1 degrade() output on a fixed input, from tngsight.degrade.degrade at commit 21d46e1 (the function is unchanged
# since): tests/data/degrade_v1_golden.json. It replaces a sha256 pin, which only held on the machine that made it: the
# owner's Mac (arm64) and Linux x86_64 give the same arrays to about 1e-14 but not the same last bits (np.arange,
# astropy's convolution and np.interp round differently there; same numpy 1.26.4 and astropy 7.2.0).
DEGRADE_V1_GOLDEN = Path(__file__).resolve().parent / "data" / "degrade_v1_golden.json"


def test_degrade_v1_matches_golden_reference():
    """degrade() is unchanged since 21d46e1: v, model and noisy flux equal the committed reference to rounding
    (rtol 1e-12), the clipped pixels are the same, and the noise is the same draw (default_rng(7), σ = √5/10, in
    pixel order). Any real change of the kernel, grid, frame, clipping or noise moves these by far more than 1e-12."""
    import base64
    from tngsight.degrade import degrade
    ref = json.loads(DEGRADE_V1_GOLDEN.read_text())
    A = {k: np.frombuffer(base64.b64decode(ref[k]), "<f8") for k in ("v", "model", "noisy", "noise")}
    lam = legacy_lam("OVI"); rest = 1031.912
    tau = 3.0 * np.exp(-0.5 * ((lam.astype(float) - rest) / 0.05) ** 2)
    v, noisy, m = degrade(lam, tau, rest, 30000, 10, 12.5, seed=7, vwin=300)
    assert v.shape == m.shape == noisy.shape == (ref["n"],)
    np.testing.assert_allclose(v, A["v"], rtol=1e-12, atol=1e-12)
    np.testing.assert_allclose(m, A["model"], rtol=1e-12, atol=1e-12)
    np.testing.assert_allclose(noisy, A["noisy"], rtol=1e-12, atol=1e-12)
    clip = A["noisy"] == 0
    assert 0 < clip.sum() < clip.size and np.array_equal(noisy == 0, clip)
    np.testing.assert_allclose(np.random.default_rng(7).normal(0.0, math.sqrt(5) / 10, v.size), A["noise"], rtol=1e-12, atol=0)
    np.testing.assert_allclose((noisy - m)[~clip], A["noise"][~clip], rtol=0, atol=1e-12)


# ------------------------------------------------------------------------------- degrade_v (v2)
def reference_degrade_v(u, flux, R, v_sys, du, vwin, vcenter=0.0, pix=5, box=None):
    """Independent port of design §3.4 as amended by Phase-3 D1, one output pixel at a time: the Gaussian of
    s² = σ_LSF² − box²/12 (box = du for box-averaged samples) at the true offsets of the samples jc−h..jc+h around the
    nearest one, normalised, indices clamped to the grid (edge extend); continuum outside the sampled range."""
    from math import exp, sqrt, ceil, floor
    box = du if box is None else box
    s = sqrt(max(((C_KMS / R) / 2.35482) ** 2 - box * box / 12, (0.3 * du) ** 2))
    h = max(1, ceil(4 * s / du))
    flux = np.asarray(flux, float); n = flux.size
    V = lambda j: (u[0] + j * du) + v_sys  # noqa: E731
    dv = C_KMS / R / pix
    v = np.arange(vcenter - vwin, vcenter + vwin + dv, dv)
    out = np.ones(v.size)
    for m, x in enumerate(v):
        if not V(0) <= x <= V(n - 1):
            continue
        jc = floor((x - V(0)) / du + 0.5)
        w = [exp(-0.5 * ((x - V(j)) / s) ** 2) for j in range(jc - h, jc + h + 1)]
        out[m] = sum(wi * flux[min(max(j, 0), n - 1)] for wi, j in zip(w, range(jc - h, jc + h + 1))) / sum(w)
    return v, out


@pytest.mark.parametrize("key,R,vc", [("OVI", 15000, 0.0), ("MgII", 150000, -60.0), ("OVII", 300, 250.0),
                                      ("HI", 5000, 0.0)])
def test_degrade_v_matches_independent_numpy(key, R, vc):
    from tngsight.degrade import degrade_v
    p = synth_payload(4)
    u, Fw = L.web_flux(p, key)
    v, noisy, model = degrade_v(u, Fw, R, None, p["v_sys"], 1.0, vwin=400, vcenter=vc)
    vr, mr = reference_degrade_v(u, Fw, R, p["v_sys"], 1.0, 400, vc)
    assert np.array_equal(v, vr) and np.array_equal(noisy, model)
    assert np.max(np.abs(model - mr)) < 1e-12
    v2, n2, m2 = degrade_v(u, Fw, R, 20, p["v_sys"], 1.0, seed=3, vwin=400, vcenter=vc)
    _, n3, _ = degrade_v(u, Fw, R, 20, p["v_sys"], 1.0, seed=3, vwin=400, vcenter=vc)
    assert np.array_equal(n2, n3) and n2.min() >= 0 and np.array_equal(m2, model)
    if v2.size >= 50:                                                      # enough pixels to measure the noise
        assert np.std(n2 - m2) == pytest.approx(np.sqrt(5) / 20, rel=0.2)
    vf, _, mf = degrade_v(u, Fw, R, None, p["v_sys"], 1.0)                 # full range without vwin
    assert vf[0] == u[0] + p["v_sys"] and vf[-1] >= u[-1] + p["v_sys"] - 1e-9


def test_degrade_v_fft_branch_equals_direct():
    from tngsight.degrade import convolve_extend, lsf_kernel
    rng = np.random.default_rng(0)
    f = np.clip(1 - rng.random(3001) * 0.3, 0, 1)
    k = lsf_kernel(100, 1.0)                                               # 10187 taps (R = 100 on 1 km/s)
    h = (k.size - 1) // 2
    direct = np.convolve(np.pad(f, h, mode="edge"), k, mode="valid")
    assert np.max(np.abs(convolve_extend(f, k) - direct)) < 1e-12


@pytest.mark.parametrize("R,sig_line,band", [(5000, 5.0, "uv"), (30000, 5.0, "uv"), (150000, 5.0, "uv"),
                                             (150000, 1.5, "uv"), (50000, 1.5, "uv"),
                                             (100, 100.0, "xray"), (1000, 100.0, "xray"), (5000, 100.0, "xray")])
def test_degrade_v_gaussian_lsf_variance(R, sig_line, band):
    """design §8 U_ions 4 as amended by Phase-3 D1: a weak Gaussian absorber's degraded profile has variance
    σ_line² + σ_LSF² (σ_LSF = (c/R)/2.35482) within 0.3 %, from point samples on 1 km/s (box=0) and from the 1 km/s
    box-averaged web flux (library.web_flux) of a 0.25 km/s native grid, whose cumulative-trapezoid box average
    adds 0.25²/6 km²/s² on a grid aligned with the box edges. The pre-D1 operator added du²/12 + interpolation."""
    from tngsight.degrade import degrade_v
    du = 1.0
    sig_lsf = C_KMS / R / 2.35482
    half = math.ceil(10 * math.hypot(sig_line, sig_lsf) / 100) * 100 + 200

    def var_of(v, m):
        D = 1.0 - m
        mu = np.sum(v * D) / np.sum(D)
        return mu, np.sum((v - mu) ** 2 * D) / np.sum(D)
    u = np.arange(-half, half + du, du)
    mu, var = var_of(*degrade_v(u, np.exp(-1e-4 * np.exp(-0.5 * (u / sig_line) ** 2)), R, None, 0.0, du, box=0.0)[::2])
    expect = sig_line ** 2 + sig_lsf ** 2
    assert abs(mu) < 0.01 * math.sqrt(expect)
    assert var == pytest.approx(expect, rel=0.003), (R, var, expect)
    un = -half + 0.25 * np.arange(8 * half + 1)
    uj, Fw = L.web_flux({"u": {"X": un}, "tau": {"X": 1e-4 * np.exp(-0.5 * (un / sig_line) ** 2)}, "W": {"X": half}}, "X")
    mu2, var2 = var_of(*degrade_v(uj, Fw, R, None, 0.0, du)[::2])
    assert abs(mu2) < 0.01 * math.sqrt(expect)
    assert var2 == pytest.approx(expect + 0.25 ** 2 / 6, rel=0.003), (R, var2, expect)


def test_degrade_v_no_lsf_and_frame():
    from tngsight.degrade import degrade_v, resolution_element_kms
    p = synth_payload(2)
    u, F = L.web_flux(p, "OVI")
    for R in (None, 0, float("inf")):
        v, _, m = degrade_v(u, F, R, None, 10.0, 1.0, vwin=300)
        assert np.allclose(np.diff(v), 5.0) and np.allclose(m, np.interp(v, u + 10.0, F))
        assert np.isnan(resolution_element_kms(R))
    # gas at the subhalo velocity sits at rest-frame u = −v_sys: it lands at V = 0
    vs = -77.8
    uu = np.arange(-1500.0, 1501.0)
    v, _, m = degrade_v(uu, np.exp(-3 * np.exp(-0.5 * ((uu + vs) / 8.0) ** 2)), 40000, None, vs, 1.0, vwin=400)
    assert abs(v[np.argmin(m)]) < 2.0


@need_raw
def test_velocity_frame_on_library():
    """τ-weighted H I Lyβ centroids sit closer to V=0 in the +v_sys frame than in the legacy −v_sys one."""
    from tngsight.degrade import velocity_axis
    files = sorted(RAW.glob(("cgm_sid488530_" if RAW_ENV else "") + "edge_b*.npz"))[:40]
    new, old = [], []
    for f in files:
        with np.load(f) as d:
            lam, tau, rest, vs = d["HILyb_lambda"], d["HILyb_tau"].astype(float), float(d["HILyb_rest"]), float(d["v_sys"])
        w = np.minimum(tau, 5.0)
        v = velocity_axis(lam, rest, vs); m = np.abs(v) < 600
        if w[m].sum() <= 0:
            continue
        vc = np.sum(v[m] * w[m]) / w[m].sum()
        new.append(abs(vc)); old.append(abs(vc - 2 * vs))
    assert len(new) >= 20 and np.mean(new) < np.mean(old)


# ------------------------------------------------------------------------------- scoring
@need_raw
@pytest.mark.parametrize("id", ["face_b050_a045", "rand_b005_a134_s479980658", "edge_b100_a090"])
def test_scoring_v1_port_matches_grid_index_in_legacy_frame(id):
    """With the legacy conventions (−v_sys, median dλ) ion_metrics_v1 reproduces tng50/data/grid_index.csv."""
    import pandas as pd
    from tngsight.scoring import ion_metrics_v1
    row = pd.read_csv(GRID_INDEX).set_index("geom_id").loc[id]
    with np.load(raw(id)) as d:
        for k in L.V1_KEYS:
            lam = d[f"{k}_lambda"].astype(float)
            m = ion_metrics_v1(lam, d[f"{k}_tau"], float(d[f"{k}_rest"]), -float(d["v_sys"]),
                               dlam=float(np.median(np.diff(lam))))
            assert m["n_comp"] == row[f"{k}_n_comp"] and m["showcase"] == bool(row[f"{k}_showcase"])
            assert m["min_flux"] == pytest.approx(row[f"{k}_min_flux"], rel=1e-9, abs=1e-12)


def test_score_payload_v2():
    from tngsight.scoring import score_payload, ion_metrics, ION_W, SCORING_TAG
    from tngsight.degrade import degrade_v
    from tngsight import vpfit
    p = synth_payload(6)
    for k in I.KEYS:                                       # two resolved components per line, unsaturated
        b = 12.0 if I.get(k)["band"] != "xray" else 120.0
        sep = 60.0 if I.get(k)["band"] != "xray" else 900.0
        lN = vpfit.logN_from_tau0(1.0, b, k)                                 # peak τ ≈ 1 per component
        p["tau"][k] = vpfit.tau_components(p["u"][k], [[-sep / 2 - p["v_sys"], lN, b],
                                                       [sep / 2 - p["v_sys"], lN, b]], k).astype(np.float32)
    s = score_payload(p)
    assert s["rank"] is None and s["n_showcase_ions"] == sum(s[f"{k}_showcase"] for k in I.KEYS)
    assert s["showcase_score"] == pytest.approx(sum(ION_W[k] * s[f"{k}_score"] for k in I.KEYS))
    assert s["ovi_showcase"] == s["OVI_showcase"] and s["OVI_n_comp"] == 2
    u, F = L.web_flux(p, "OVII")
    _, _, mx = degrade_v(u, F, I.band("OVII")["R_eval"], None, p["v_sys"], 1.0, vwin=400)
    assert s["OVII_min_flux"] == pytest.approx(float(mx.min()), abs=1e-15)
    assert ion_metrics(u, F, p["v_sys"], 1000)["min_flux"] == s["OVII_min_flux"]
    assert SCORING_TAG.startswith("tngsight-score/2")
    sub = score_payload({**p, "lines": ["CIII", "OVI"]})                    # a v1-like line set
    assert "HI_score" not in sub and sub["showcase_score"] == pytest.approx(
        ION_W["OVI"] * s["OVI_score"] + ION_W["CIII"] * s["CIII_score"])


def test_assign_ranks():
    from tngsight.scoring import assign_ranks
    es = [{"id": "b", "score": 1.0}, {"id": "a", "score": 1.0}, {"id": "c", "score": 3.0}, {"id": "d", "score": None}]
    assign_ranks(es)
    assert [e.get("rank") for e in es] == [3, 2, 1, None]


@need_raw
def test_build_library_scores_in_fixed_frame(scratch):
    """build_library (the v1 copy tool) scores with score_payload, ranks by score, tags the catalog, and rescoring a
    legacy-scored catalog leaves the npz copy and web bin untouched."""
    import shutil, sys
    from tngsight.scoring import SCORING_TAG, score_payload
    sys.path.insert(1, str(Path(__file__).resolve().parent.parent / "deploy" / "data"))
    import build_library as bl
    ids = ["face_b150_a270", "edge_b100_a090"]
    src = scratch / "src"; src.mkdir()
    for i in ids:
        shutil.copy2(raw(i), src / L.npz_name(i))
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
        assert es[i]["score"] == pytest.approx(sc["showcase_score"], abs=5e-5) and es[i]["star"] == sc["ovi_showcase"]
        assert es[i]["ions"]["OVI"]["n_comp"] == sc["OVI_n_comp"] and es[i]["data_version"] == 1
    assert sorted(e["rank"] for e in es.values()) == [1, 2]
    assert es[max(ids, key=lambda i: es[i]["score"])]["rank"] == 1


# ------------------------------------------------------------------------------- figure
def test_figure_layout_and_bytes():
    from tngsight.figure import build_figure, render, render_bytes, as_payload, cases_for
    p = synth_payload(3)
    fig = build_figure(p, intrinsic=True, vwin=300)
    axes = fig.get_axes()
    assert len(axes) == 5 * 4                                              # registry default ions x 2x2 cases
    assert axes[0].get_xlim() == (-300, 300) and axes[0].get_ylim() == (-0.08, 1.32)
    assert "S/N = 20" in axes[0].get_title() and "S/N = 5" in axes[3].get_title()
    txt = [t.get_text() for t in axes[0].texts]
    assert any("15,000" in t for t in txt)                                 # uv pair R0 = 15000
    xr = [t.get_text() for t in axes[4 * 4 + 1].texts]                     # O VII row, case (R1, s0)
    assert any("3,000" in t for t in xr)
    assert cases_for("2SN") == [{"R": {"uv": 15000, "euv": 15000, "xray": 300}, "snr": 20},
                                {"R": {"uv": 15000, "euv": 15000, "xray": 300}, "snr": 5}]
    f2 = render(p, ions=["NeVIII", "CII"], cases=cases_for("1", R={"uv": [40000], "euv": [20000]}, sn=[30]), vc=50,
                vhw=100)
    a2 = f2.get_axes()
    assert len(a2) == 2 and a2[0].get_xlim() == (-50, 150)
    assert "C" in a2[0].texts[-1].get_text() and any("40,000" in t.get_text() for t in a2[0].texts)  # rows in registry order
    legacy = build_figure(p, R_lo=20000, R_hi=40000, sn_hi=8, sn_lo=5, vwin=300)
    assert "S/N = 8" in legacy.get_axes()[0].get_title()
    png = render_bytes(p, fmt="png", dpi=30)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    pdf = render_bytes(p, fmt="pdf", dpi=30, seed=1)
    assert pdf[:5] == b"%PDF-" and pdf == render_bytes(p, fmt="pdf", dpi=30, seed=1)
    buf = io.BytesIO(); L.save_npz(buf, p); buf.seek(0)
    with np.load(buf) as d:
        assert as_payload(d)["geom"] == p["geom"]
    with pytest.raises(ValueError):
        render_bytes(p, fmt="svg")
    with pytest.raises(ValueError, match="not in this sightline"):
        render(synth_payload(lines=["OVI"]), ions=["HI"])
    with pytest.raises(ValueError):
        cases_for("3")


def test_figure_window_clamped_to_data():
    """A window beyond the +v_sys-shifted ±W grid is moved/shrunk: no padded fake continuum is drawn."""
    from tngsight.figure import build_figure, max_vwin
    p = synth_payload(3, lines=["CIV", "OVI"])
    lim = max_vwin(p, 15000)
    assert 1500 - abs(p["v_sys"]) - 40 < lim < 1500 - abs(p["v_sys"])
    for vs in (-128.0, 128.0):
        q = {**p, "v_sys": vs}
        lo, hi = build_figure(q, vwin=1500, ions=["CIV", "OVI"]).get_axes()[0].get_xlim()
        assert hi - lo <= 2 * (1500 - 4 * 299792.458 / 15000 / 2.35482) + 1e-6
        assert lo >= -1500 + vs - 1e-6 and hi <= 1500 + vs + 1e-6
    assert build_figure(p, vwin=300, ions=["OVI"]).get_axes()[0].get_xlim() == (-300, 300)
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


def test_make_line_spectrum_grid_check():
    """make_line_spectrum hands Trident the native window and refuses a grid that differs (no resampling)."""
    from tngsight import generate as GN

    class FakeSG:
        calls = []

        def __init__(self, lambda_min, lambda_max, dlambda, bin_space, line_database):
            FakeSG.calls.append((lambda_min, lambda_max, dlambda, bin_space))
            dl = dlambda
            lo, hi = np.round(lambda_min / dl) * dl, np.round(lambda_max / dl) * dl
            self.lambda_field = np.linspace(lo, hi, int(np.round((hi - lo) / dl + 1))) * (1 + FakeSG.skew)
            self.tau_field = np.zeros(self.lambda_field.size)

        def make_spectrum(self, ray, lines, **kw):
            assert lines == [I.get("OVII")["trident_line"]] and kw["min_tau"] == 1e-8
            assert kw["use_doppler_redshift_only"] and kw["use_peculiar_velocity"] and not kw["ly_continuum"]
    tr = type("T", (), {"SpectrumGenerator": FakeSG})
    FakeSG.skew = 0.0
    lam0, dlam, tau = GN.make_line_spectrum(tr, None, "OVII", 1500.0, None)
    assert (lam0, dlam, tau.size) == L.native_grid("OVII", 1500.0) and tau.dtype == np.float32
    lmin, lmax, dl, bs = FakeSG.calls[-1]
    assert bs == "wavelength" and dl == pytest.approx(21.6019 * 0.25 / C_KMS, rel=1e-15)
    FakeSG.skew = 1e-8
    with pytest.raises(RuntimeError, match="differs from native_grid"):
        GN.make_line_spectrum(tr, None, "OVII", 1500.0, None)


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
    buf = io.BytesIO()
    L.save_npz(buf, {**p, "geom": sl, "v_sys": None}); buf.seek(0)
    q = L.load_npz(buf)
    assert q["id"] == "cust_35277e0469" and q["geom"] == json.loads(json.dumps(sl))
    comps = {"OVI": [{"v": 1.0, "dv": 0.1, "logN": 13.0, "dlogN": 0.01, "b": 20.0, "db": 0.2, "region": 0,
                      "flag": 0, "EW": 10.0}], "HI": [], "CIII": []}
    e = L.catalog_entry(q, None, "generated", components=comps)
    assert e["orientation"] == "custom" and e["kind"] == "endpoints" and e["seed"] is None
    assert e["p0"] == [-100.0, 0.0, 0.0] and e["p1"] == [100.0, 0.0, 0.0]
    assert e["b_kpc"] == 0.0 and e["azimuth_deg"] == 0.0 and e["length_kpc"] == 200.0
    assert e["has_components"] is True and e["n_fit"] == {"OVI": 1, "HI": 0, "CIII": 0}
    assert q["v_sys"] == sl["v_sys_kms"] and e["v_sys"] == round(sl["v_sys_kms"], 4)
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


def _generator(**kw):
    from tngsight.generate import Generator
    if not config.cutout_path().exists():
        pytest.skip(f"no cutout at {config.cutout_path()}")
    idx = os.environ.get("TNG_INDEX_FILE") or str(config.index_path())
    return Generator(index_filename=idx, workdir=os.environ.get("TNG_WORKDIR"), **kw)


SLOW = [pytest.mark.slow,
        pytest.mark.skipif(os.environ.get("TNG_RUN_SLOW") != "1", reason="set TNG_RUN_SLOW=1 (loads yt+trident+cutout)")]


def slow(f):
    for m in reversed(SLOW):
        f = m(f)
    return f


@slow
def test_generator_v2_twelve_lines_edge_b100_a090():
    """design §8 U_ions 2: 12 lines, n = 12001 (non-damped), u_0 = −1499.958, O VII deposits, |AOD − ray| ≤ 0.005 dex
    for every line with logN ≥ 12, the ray matches the v1 library ray (same endpoints), and the O VII deposition of
    the single strongest cell equals k_tau·N·H(a, 0)/b within 1 % (b from the cell T)."""
    from tngsight import generate as GN
    gen = _generator(fit_components=False)
    stages = []
    p = gen.generate(_reference_geom("edge_b100_a090"), progress=lambda s, f, m: stages.append(s))
    assert p["id"] == "edge_b100_a090" and p["format"] == 2 and p["lines"] == list(I.KEYS)
    for st in ("load", "ray", *(f"spectrum:{k}" for k in I.KEYS), "save"):
        assert st in stages
    a = L.aod_columns(p, nd=6)
    for k in I.KEYS:
        n = p["tau"][k].size
        if not I.get(k)["damped"] or p["W"][k] == 1500:
            assert n == 12001 and abs(p["u"][k][0] + 1499.958) < 1e-6, k
        if math.isfinite(p["logN"][k]) and p["logN"][k] >= 12:
            assert abs(a[k] - p["logN"][k]) <= 0.005, (k, a[k], p["logN"][k])
    assert a["OVII"] is not None and math.isfinite(a["OVII"])
    ref = L.load_npz(lib_npz("edge_b100_a090"))
    assert_geom_close(p["geom"], ref["geom"])
    for k in ("OVI", "CIII"):
        assert abs(p["logN"][k] - ref["logN"][k]) < 1e-6
    # single-cell O VII analytic check
    from scipy.special import wofz
    tr = gen._trident
    fd_tmp = Path(gen.workdir) / "_cgmray_ovii_check.h5"
    ray = GN.cast_ray(tr, gen.ds, p["geom"], str(fd_tmp))
    try:
        ad = ray.all_data()
        col = (ad[("gas", "O_p6_number_density")] * ad[("gas", "dl")]).in_units("cm**-2").d
        i = int(np.argmax(col))
        dl_i = float(ad[("gas", "dl")].d[i])
        one = ad.cut_region([f"obj[('gas', 'dl')].d == {dl_i!r}"])
        assert one[("gas", "dl")].size == 1
        lam0, dlam, tau = GN.make_line_spectrum(tr, one, "OVII", 1500.0, gen._ld)
        T = float(ad[("gas", "temperature")].d[i])
        b = math.sqrt(2 * 1.380649e-16 * T / (I.get("OVII")["mass_amu"] * 1.66053907e-24)) / 1e5
        expect = I.k_tau("OVII") * col[i] * float(wofz(1j * I.a0("OVII") / b).real) / b
        print(f"\nO VII single cell: N = {col[i]:.4g} cm^-2, T = {T:.4g} K, b = {b:.3f} km/s: Trident tau peak "
              f"{float(tau.max()):.6g} vs analytic {expect:.6g} (rel {float(tau.max()) / expect - 1:+.2e})")
        assert float(tau.max()) == pytest.approx(expect, rel=0.01), (float(tau.max()), expect, T, col[i])
    finally:
        del ray
        if fd_tmp.exists():
            fd_tmp.unlink()


@slow
@pytest.mark.parametrize("id", ["face_b050_a090", "rand_b075_a000_s12345"])
def test_custom_ray_reproduces_library_ray(id):
    """A custom ray through a library sightline's exact endpoints == that sightline (same process), 12 lines."""
    import time
    gen = _generator(fit_components=True)
    ref = gen.generate(_reference_geom(id))
    C = G.CENTER_KPC
    p0 = (np.array(ref["geom"]["start_kpc"]) - C).tolist()
    p1 = (np.array(ref["geom"]["end_kpc"]) - C).tolist()
    stages = []
    t0 = time.monotonic()
    cus = gen.generate({"kind": "endpoints", "p0_kpc": p0, "p1_kpc": p1, "id": "cust_test"},
                       progress=lambda s, f, m: stages.append((s, m)))
    print(f"\n{id}: custom ray generated in {time.monotonic() - t0:.1f} s (incl. fit)")
    assert cus["id"] == "cust_test" and cus["geom"]["kind"] == "endpoints"
    names = [s for s, _ in stages]
    for st in ("ray", *(f"spectrum:{k}" for k in I.KEYS), "fit", "save"):
        assert st in names, st
    assert names.index("fit") > names.index("spectrum:OVII") and names.index("fit") < names.index("save")
    for k in I.KEYS:
        assert cus["lam0"][k] == ref["lam0"][k] and cus["tau"][k].size == ref["tau"][k].size
        dtau = float(np.max(np.abs(cus["tau"][k].astype(float) - ref["tau"][k].astype(float))))
        assert dtau <= 1e-6, (k, dtau)
        assert abs(cus["logN"][k] - ref["logN"][k]) <= 1e-9, k
    if "components" in ref:
        assert cus.get("components") == ref["components"]


@slow
def test_custom_ray_800kpc_timing():
    """Design §11: report the cast time of the longest legal custom ray (790 kpc through the centre)."""
    import time
    gen = _generator(fit_components=True)
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
