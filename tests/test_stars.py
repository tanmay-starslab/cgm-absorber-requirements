"""Tests for tngsight.stars (Phase-2b design §4.4–§4.6, acceptance item 1). All synthetic and fast.

Covered: wind exclusion, mag → ℓ = 10^(−0.4 M), band columns (g, r, i = 4, 5, 6), the RGBA raw rule (A),
`project` on a synthetic cube, plus the read-once cache, the §2.3 star range/encoding, conservation of a small
real `build_level`, the S0 mask, the CUBE/fragment shape and the §4.5 composite. When CORE's `tngsight.vizpack`
exists, the private stand-in is checked against it."""
import gzip
import hashlib
import importlib
import json
import math

import numpy as np
import pytest

from tngsight import deposit as D
from tngsight import stars as S

TNG_H = S.TNG_H


def fake_pt4(n=40, seed=1, wind_every=7):
    rng = np.random.default_rng(seed)
    c = np.asarray(S.GALAXY["center_kpc"])
    pos_kpc = c + rng.normal(0.0, 3.0, (n, 3))
    phot = rng.uniform(-12.0, -3.0, (n, 8)).astype(np.float32)
    sft = rng.uniform(0.1, 1.0, n).astype(np.float32)
    if wind_every:
        sft[::wind_every] = -0.5                  # winds
        sft[1] = 0.0                              # exactly 0 is a wind too
    return {"Coordinates": pos_kpc * TNG_H, "Masses": np.full(n, 1e-5, np.float32),
            "StellarHsml": rng.uniform(0.2, 2.0, n).astype(np.float32) * TNG_H,
            "GFM_StellarPhotometrics": phot, "GFM_StellarFormationTime": sft}


# ------------------------------------------------------------------------------- API / constants
def test_constants():
    assert S.STARS_VERSION == 1 and S.GENERATOR == "tngsight.stars/1"
    assert S.STAR_LEVELS == {"S0": 400.0, "S1": 100.0, "S2": 25.0}
    assert S.BANDS == {"g": 4, "r": 5, "i": 6}
    assert S.CHANNELS == ("i", "r", "g")
    assert abs(S.MU_ZERO - 36.57212566588) < 1e-9
    assert S.DISPLAY["Q"] == 8.0 and S.DISPLAY["mu0"] == 21.5 and S.DISPLAY["balance"] == [1.0, 1.0, 1.0]
    assert S.PT4_FIELDS == ("Coordinates", "Masses", "StellarHsml", "GFM_StellarPhotometrics",
                            "GFM_StellarFormationTime")


# ------------------------------------------------------------------------------- star_arrays
def test_wind_exclusion():
    p = fake_pt4()
    a = S.star_arrays(p)
    keep = p["GFM_StellarFormationTime"] > 0
    assert a["n_total"] == 40 and a["n_wind"] == int((~keep).sum()) and a["n_wind"] >= 7
    assert a["h_kpc"].size == keep.sum() == a["pos_disk"].shape[0] == a["l_r"].size
    np.testing.assert_allclose(a["h_kpc"], p["StellarHsml"][keep].astype(np.float64) / TNG_H)


def test_mag_to_lum():
    np.testing.assert_allclose(S.magnitudes_to_lum([0.0, -2.5, 5.0, -10.0]), [1.0, 10.0, 0.01, 1e4], rtol=1e-14)


def test_band_columns():
    p = fake_pt4(n=12, wind_every=None)           # no winds at all here
    ph = np.zeros((12, 8), np.float32)
    for col in range(8):
        ph[:, col] = -float(col)                  # column c holds M = −c → ℓ = 10^(0.4 c)
    p["GFM_StellarPhotometrics"] = ph
    a = S.star_arrays(p)
    for band, col in (("g", 4), ("r", 5), ("i", 6)):
        np.testing.assert_allclose(a[f"l_{band}"], 10 ** (0.4 * col), rtol=1e-12)


def test_positions_disk_frame():
    p = fake_pt4(n=10, wind_every=None)
    a = S.star_arrays(p)
    R = np.array([S.GALAXY["xhat"], S.GALAXY["yhat"], S.GALAXY["Lhat"]])
    want = (p["Coordinates"] / TNG_H - np.asarray(S.GALAXY["center_kpc"])) @ R.T
    np.testing.assert_allclose(a["pos_disk"], want, atol=1e-9)
    # a star displaced along Lhat lands on the cube's k axis
    p2 = dict(p)
    p2["Coordinates"] = (np.asarray(S.GALAXY["center_kpc"]) + 5.0 * np.asarray(S.GALAXY["Lhat"]))[None] * TNG_H
    for k in ("Masses", "StellarHsml", "GFM_StellarPhotometrics", "GFM_StellarFormationTime"):
        p2[k] = p[k][:1]
    np.testing.assert_allclose(S.star_arrays(p2)["pos_disk"][0], [0, 0, 5.0], atol=1e-9)


# ------------------------------------------------------------------------------- read once
def test_read_pt4_caches_and_never_reopens(tmp_path):
    h5py = pytest.importorskip("h5py")
    p = fake_pt4()
    f = tmp_path / "cut.hdf5"
    with h5py.File(f, "w") as fh:
        g = fh.create_group("PartType4")
        for k, v in p.items():
            g[k] = v
        g["GFM_Metallicity"] = np.zeros(40, np.float32)    # extra fields are not read
    cache = tmp_path / "cache"
    a = S.read_pt4(f, cache, log=None)
    assert sorted(a) == sorted(S.PT4_FIELDS)
    for k in S.PT4_FIELDS:
        assert (cache / f"pt4_{k}.npy").is_file()
        np.testing.assert_array_equal(a[k], p[k])
    f.unlink()                                    # the second call must not need the cutout
    b = S.read_pt4(f, cache, log=None)
    for k in S.PT4_FIELDS:
        np.testing.assert_array_equal(b[k], p[k])


# ------------------------------------------------------------------------------- RGBA raw rule
def test_rgba_raw_rule_and_layout():
    n = 8
    i, j, k = np.meshgrid(np.arange(n), np.arange(n), np.arange(n), indexing="ij")
    f = (i + 7 * j + 49 * k) % 256
    q = {"i": f.astype(np.uint8), "r": ((f + 1) % 256).astype(np.uint8), "g": ((f + 2) % 256).astype(np.uint8)}
    q["i"][0, 0, 0] = q["r"][0, 0, 0] = q["g"][0, 0, 0] = 0          # empty voxel → A = 0
    q["i"][1, 0, 0], q["r"][1, 0, 0], q["g"][1, 0, 0] = 0, 0, 9        # only B set → A = 255
    raw = np.frombuffer(S.rgba_raw(q), np.uint8)
    assert raw.size == 4 * n ** 3
    for (ii, jj, kk) in [(0, 0, 0), (1, 0, 0), (3, 2, 1), (7, 7, 7), (5, 0, 6)]:
        o = 4 * (ii + n * (jj + n * kk))
        assert raw[o] == q["i"][ii, jj, kk] and raw[o + 1] == q["r"][ii, jj, kk] and raw[o + 2] == q["g"][ii, jj, kk]
        want_a = 255 if (q["i"][ii, jj, kk] or q["r"][ii, jj, kk] or q["g"][ii, jj, kk]) else 0
        assert raw[o + 3] == want_a
    assert raw[3] == 0 and raw[4 + 3] == 255


# ------------------------------------------------------------------------------- project
def test_project_synthetic():
    n, half = 8, 4.0
    dx = 2 * half / n
    c = np.zeros((n, n, n))
    c[2, 3, :] = 1.5                              # a column along k
    c[5, 1, 4] = 7.0
    cube = {"i": c, "r": 2 * c, "g": np.where(c > 0, np.nan, 0.0)}      # NaN counts as 0
    pk = S.project(cube, 2, half)
    assert pk["i"].shape == (n, n)
    assert pk["i"][2, 3] == pytest.approx(1.5 * n * dx) and pk["i"][5, 1] == pytest.approx(7 * dx)
    assert pk["r"][2, 3] == pytest.approx(2 * 1.5 * n * dx) and np.all(pk["g"] == 0)
    p0 = S.project(cube, 0, half)                 # edge-on: remaining axes (j, k)
    assert p0["i"][3, 0] == pytest.approx(1.5 * dx) and p0["i"][1, 4] == pytest.approx(7 * dx)
    for ax in (0, 1, 2):                          # total light is axis independent
        assert S.project(cube, ax, half)["i"].sum() * dx ** 2 == pytest.approx(c.sum() * dx ** 3)


def test_surface_brightness_mag():
    mu = S.surface_brightness_mag([1.0, 100.0, 0.0])
    assert mu[0] == pytest.approx(S.MU_ZERO) and mu[1] == pytest.approx(S.MU_ZERO - 5) and np.isinf(mu[2])


# ------------------------------------------------------------------------------- deposit + encode
def _synthetic_stars(n=3000, seed=3, spread=1.5):
    rng = np.random.default_rng(seed)
    pos = rng.normal(0.0, spread, (n, 3))
    pos[:, 2] *= 0.2
    h = np.exp(rng.uniform(np.log(0.05), np.log(4.0), n))
    m = rng.uniform(-11, -4, (n, 3))
    return {"pos_disk": pos, "h_kpc": h, "l_i": 10 ** (-0.4 * m[:, 0]), "l_r": 10 ** (-0.4 * m[:, 1]),
            "l_g": 10 ** (-0.4 * m[:, 2])}


def test_build_level_conservation_small(monkeypatch):
    monkeypatch.setitem(S.STAR_LEVELS, "S2", 4.0)  # a ±4 kpc test box with straddling stars
    arr = _synthetic_stars()
    cubes, dep = S.build_level(arr, "S2", n=32)
    cons = S.conservation(dep)
    dx = 8.0 / 32
    for b in S.CHANNELS:
        assert cons[b]["cons_rel"] <= 1e-6
        assert cubes[b].sum() * dx ** 3 == pytest.approx(dep.q_in[S.QUANTITY[b]], rel=1e-10)
        assert 0 < cons[b]["lost_fraction"] < 0.5
    assert dep.n_straddling > 0


def test_s0_mask(monkeypatch):
    monkeypatch.setitem(S.STAR_LEVELS, "S0", 8.0)
    monkeypatch.setitem(S.VP.R_MASK_KPC, "S0", 8.0)
    arr = _synthetic_stars(spread=6.0, n=2000)
    cubes, dep = S.build_level(arr, "S0", n=16)
    c = S.VP.voxel_centers(16, 8.0)
    r = np.sqrt(c[:, None, None] ** 2 + c[None, :, None] ** 2 + c[None, None, :] ** 2)
    assert np.all(cubes["r"][r > 8.0] == 0) and np.any(cubes["r"][r <= 8.0] > 0)
    vmin, vmax, q = S.encode_level(cubes, "S0", n=16)
    assert np.all(q["g"][r > 8.0] == 0)
    assert S.level_mask("S1") is None and S.level_mask("S2") is None


def test_encode_star_range_rule():
    rng = np.random.default_rng(5)
    n = 16
    cubes = {b: 10 ** rng.uniform(-3, 5 + j, (n, n, n)) for j, b in enumerate(S.CHANNELS)}
    cubes["r"][0, 0, :4] = 0.0                     # empties
    vmin, vmax, q = S.encode_level(cubes, "S1", n=n)
    lo = min(np.percentile(np.log10(c[c > 0]), 0.5) for c in cubes.values())
    hi = max(np.log10(c[c > 0]).max() for c in cubes.values())
    assert vmin == math.floor(round(10 * lo, 6)) / 10 and vmax == math.ceil(round(10 * hi, 6)) / 10
    assert np.all(q["r"][0, 0, :4] == 0) and q["r"].min() == 0 and q["i"].min() >= 1
    lv = S.VP.dequantize(q["g"], vmin, vmax)
    ok = np.log10(cubes["g"]) >= vmin
    assert np.nanmax(np.abs(lv[ok] - np.log10(cubes["g"][ok]))) <= (vmax - vmin) / 508 + 1e-12


def test_write_level_fragment_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setitem(S.STAR_LEVELS, "S1", 4.0)
    arr = _synthetic_stars(n=1500)
    cubes, dep = S.build_level(arr, "S1", n=16)
    cube = S.write_level(tmp_path, "S1", cubes, dep, n=16, log=None)
    assert set(cube) >= {"vmin", "vmax", "raw_bytes", "raw_sha256", "webp", "gz", "stats", "deposit"}
    assert cube["raw_bytes"] == 4 * 16 ** 3
    id12 = cube["raw_sha256"][:12]
    assert cube["webp"]["paths"] == [f"stars/S1/gri.{id12}.p{p}.webp" for p in range(4)]
    assert cube["gz"]["path"] == f"stars/S1/gri.{id12}.rgba.gz"
    for rel, nb, sh in zip(cube["webp"]["paths"], cube["webp"]["bytes"], cube["webp"]["sha256"]):
        b = (tmp_path / rel).read_bytes()
        assert len(b) == nb and hashlib.sha256(b).hexdigest() == sh
    gz = (tmp_path / cube["gz"]["path"]).read_bytes()
    assert gz == S.VP.gzip_bytes(gzip.decompress(gz))          # deterministic gzip (mtime 0, no name)
    assert hashlib.sha256(gzip.decompress(gz)).hexdigest() == cube["raw_sha256"]
    assert set(cube["deposit"]) == {"n_elements", "n_straddling", "lost_fraction", "seconds", "workers"}
    assert set(cube["stats"]) == {"frac_empty", "p01", "p50", "p99", "max"}
    q = S.decode_cube_gz(tmp_path, cube)
    v = S.decoded_density(q["r"], cube["vmin"], cube["vmax"])
    assert v.sum() == pytest.approx(cubes["r"].sum(), rel=0.02)
    frag = S.fragment({"S1": cube}, n=16)
    assert set(frag) == {"schema", "generator", "levels", "stars"} and frag["schema"] == "tng50-viz/2"
    assert set(frag["generator"]) >= {"deposit", "vizpack", "stars", "pillow", "libwebp", "numpy"}
    st = frag["stars"]
    assert st["bands"] == ["i", "r", "g"] and st["levels"] == ["S1"]
    assert st["photometry"] == "GFM_StellarPhotometrics columns i=6 r=5 g=4"
    assert st["exclude"] == "GFM_StellarFormationTime <= 0" and st["display"]["formula"] == "lupton2004"
    assert frag["levels"]["S1"] == {"half_kpc": 4.0, "n": 16, "voxel_kpc": 0.5, "r_mask_kpc": None}
    json.dumps(frag)


# ------------------------------------------------------------------------------- composite (§4.5)
def test_lupton_formula():
    s0 = 10 ** (0.4 * (S.MU_ZERO - 21.5))
    rgb = S.VP.lupton_rgb(np.array([s0]), np.array([s0]), np.array([s0]))[0]
    assert rgb[0] == rgb[1] == rgb[2]
    x = math.asinh(8.0) / 8.0                     # I = 1 → F = asinh(Q)/Q
    assert rgb[0] == math.floor(255 * x + 0.5)
    assert tuple(S.VP.lupton_rgb(0.0, 0.0, 0.0)) == (0, 0, 0)
    big = S.VP.lupton_rgb(1e6 * s0, 0.5e6 * s0, 0.25e6 * s0)
    assert big.max() == 255 and abs(int(big[1]) - 128) <= 1 and abs(int(big[2]) - 64) <= 1


def test_local_standin_matches_vizpack_when_present():
    try:
        vp = importlib.import_module("tngsight.vizpack")
    except ImportError:
        pytest.skip("tngsight.vizpack (CORE) not present yet; the stand-in is in use")
    L = S._LocalVizpack
    rng = np.random.default_rng(9)
    v = 10 ** rng.uniform(-4, 6, (8, 8, 8))
    v[0, 0, 0] = 0
    assert vp.star_range([v, v * 2, v / 3], None) == L.star_range([v, v * 2, v / 3], None)
    np.testing.assert_array_equal(vp.quantize(v, None, -4.0, 6.5), L.quantize(v, None, -4.0, 6.5))
    q = L.quantize(v, None, -4.0, 6.5)
    assert vp.raw_stars(q, q, q) == L.raw_stars(q, q, q)
    for a, b in zip(vp.atlas_parts(np.stack([q, q, q], -1)), L.atlas_parts(np.stack([q, q, q], -1))):
        np.testing.assert_array_equal(a, b)
    S_ = 10 ** rng.uniform(3, 9, (50, 3))
    np.testing.assert_array_equal(vp.lupton_rgb(S_[:, 0], S_[:, 1], S_[:, 2]),
                                  L.lupton_rgb(S_[:, 0], S_[:, 1], S_[:, 2]))
