"""tngsight.vizpack (design-2b §3.2, §3.3, §3.6 vizpack items 1–7)."""
import gzip
import hashlib
import json
import math

import numpy as np
import pytest

from tngsight import deposit as D
from tngsight import vizpack as VP


def test_constants():
    assert VP.SCHEMA == "tng50-viz/2" and VP.GENERATOR == "tngsight.vizpack/1" and VP.N == 256
    assert VP.GAS_LEVELS == {"L0": 400.0, "L1": 100.0, "L2": 25.0}
    assert VP.STAR_LEVELS == {"S0": 400.0, "S1": 100.0, "S2": 25.0}
    assert VP.R_MASK_KPC == {"L0": 400.0, "S0": 400.0}
    assert VP.VOL_KEYS == ("nH", "T", "Z", "OVI", "HI", "CIII")
    assert abs(VP.MU_ZERO - 36.57212566588) < 1e-10 and VP.BANDS == {"g": 4, "r": 5, "i": 6}


def test_quantize_roundtrip_and_empties():
    rng = np.random.default_rng(1)
    vmin, vmax = -6.0, 0.5
    v = 10 ** rng.uniform(vmin, vmax, (16, 16, 16))
    v[0, 0, 0], v[0, 0, 1], v[0, 0, 2], v[0, 0, 3] = np.nan, 0.0, -1.0, np.inf
    mask = np.ones(v.shape, bool)
    mask[1, 1, 1] = False
    q = VP.quantize(v, mask, vmin, vmax)
    assert q[0, 0, 0] == q[0, 0, 1] == q[0, 0, 2] == q[0, 0, 3] == q[1, 1, 1] == 0
    ok = q > 0
    assert ok.sum() == v.size - 5 and q[ok].min() >= 1
    dec = VP.dequantize(q, vmin, vmax)
    assert np.all(np.isnan(dec[~ok]))
    assert np.max(np.abs(dec[ok] - np.log10(v[ok]))) <= (vmax - vmin) / 508 + 1e-12
    assert VP.quantize(np.array([1e-9, 1e3]), None, vmin, vmax).tolist() == [1, 255]     # clamp both ends
    assert VP.snap_down(-2.0000000001) == -2.0 and VP.snap_up(0.30000000004) == 0.3 and VP.snap_up(0.31) == 0.4


def test_ranges_and_mask():
    m = VP.radial_mask(8, 400.0, 400.0)
    c = VP.voxel_centers(8, 400.0)
    r = np.sqrt(c[:, None, None] ** 2 + c[None, :, None] ** 2 + c[None, None, :] ** 2)
    assert np.array_equal(m, r <= 400.0) and m.any() and (~m).any()
    rng = np.random.default_rng(2)
    a = 10 ** rng.uniform(-5, 0, (8, 8, 8))
    b = 10 ** rng.uniform(-3, 2, (8, 8, 8))
    a_m = a.copy()
    a_m[~m] = 1e-30                                   # masked voxels must not move the range
    lo = min(np.percentile(np.log10(a[m]), 0.5), np.percentile(np.log10(b), 0.5))
    hi = max(np.log10(a[m]).max(), np.log10(b).max())
    assert VP.gas_range([a_m, b], [m, None]) == (VP.snap_down(lo), VP.snap_up(hi))
    assert VP.star_range([a, b], None) == VP.gas_range([a, b], [None, None])


def test_layout_probe():
    n = 8
    i, j, k = np.meshgrid(np.arange(n), np.arange(n), np.arange(n), indexing="ij")
    f = (i + 7 * j + 49 * k) % 256
    q = f.astype(np.uint8)
    raw = VP.raw_gas(q)
    for (a, b, c) in [(1, 2, 3), (7, 0, 5), (0, 7, 1)]:
        assert raw[a + n * (b + n * c)] == (a + 7 * b + 49 * c) % 256
    q2 = ((f + 1) % 256).astype(np.uint8)
    q3 = np.zeros_like(q)
    rs = VP.raw_stars(q, q2, q3)
    assert len(rs) == 4 * n ** 3
    for (a, b, c) in [(1, 2, 3), (7, 0, 5)]:
        o = 4 * (a + n * (b + n * c))
        assert rs[o] == q[a, b, c] and rs[o + 1] == q2[a, b, c] and rs[o + 2] == 0
        assert rs[o + 3] == (255 if (q[a, b, c] or q2[a, b, c]) else 0)
    assert rs[3] == (255 if q2[0, 0, 0] else 0)


@pytest.mark.parametrize("n", [16, 64])
def test_atlas_webp_roundtrip(n):
    rng = np.random.default_rng(n)
    q = rng.integers(0, 256, (n, n, n), dtype=np.uint8)
    q[q < 40] = 0
    parts = VP.atlas_parts(q)
    assert len(parts) == 4 and parts[0].shape == (4 * n, 16 * n)
    dec = [VP.decode_webp(VP.encode_webp(p)) for p in parts]
    assert VP.atlas_to_raw(dec, n, 1) == VP.raw_gas(q)
    qs = rng.integers(0, 256, (n, n, n, 3), dtype=np.uint8)
    sp = VP.atlas_parts(qs)
    assert sp[0].shape == (4 * n, 16 * n, 3)
    sdec = [VP.decode_webp(VP.encode_webp(p)) for p in sp]
    assert VP.atlas_to_raw(sdec, n, 3) == VP.raw_stars(qs[..., 0], qs[..., 1], qs[..., 2])
    if n >= 38:                                         # slice k = 37 → part 0, tile column 5, row 2
        x, y = 5 * n + 3, 2 * n + 4
        assert parts[0][y, x] == q[3, 4, 37]


def test_gzip_deterministic():
    raw = bytes(range(256)) * 64
    a, b = VP.gzip_bytes(raw), VP.gzip_bytes(raw)
    assert a == b and gzip.decompress(a) == raw and a[4:8] == b"\0\0\0\0"


def test_column_from_u8():
    n, half = 16, 8.0
    vmin, vmax = -2.0 - 1e-9, -2.0 + 1e-9
    q = VP.quantize(np.full((n, n, n), 1e-2), None, vmin, vmax)
    p0, p1 = np.array([-half, 0.3, -0.7]), np.array([half, 0.3, -0.7])
    exact = math.log10(1e-2 * 2 * half * VP.CM_PER_KPC)
    assert abs(VP.column_from_u8(q, vmin, vmax, half, p0, p1, spv=1.0) - exact) < 1e-6
    c = VP.voxel_centers(n, half)
    X, Y, Z = np.meshgrid(c, c, c, indexing="ij")
    dens = 10 ** (-2.0 + 0.02 * X - 0.01 * Y + 0.01 * Z)
    lo, hi = float(np.log10(dens).min()), float(np.log10(dens).max())
    q = VP.quantize(dens, None, lo, hi)
    a, b = np.array([-7.3, -3.1, 2.2]), np.array([6.9, 4.0, -1.5])
    ref = math.log10(D.cube_column(dens, half, a, b, samples_per_voxel=8.0) * VP.CM_PER_KPC)
    assert abs(VP.column_from_u8(q, lo, hi, half, a, b, spv=8.0) - ref) < 0.002


def _lupton_ref(si, sr, sg, Q=8.0, mu0=21.5):
    s0 = 10 ** (0.4 * (VP.MU_ZERO - mu0))
    R, G, B = si / s0, sr / s0, sg / s0
    I = (R + G + B) / 3
    F = math.asinh(Q * I) / (Q * I) if I > 0 else 0.0
    out = [R * F, G * F, B * F]
    m = max(out)
    if m > 1:
        out = [x / m for x in out]
    return tuple(math.floor(255 * min(max(x, 0.0), 1.0) + 0.5) for x in out)


def test_lupton_rgb():
    s0 = 10 ** (0.4 * (VP.MU_ZERO - 21.5))
    flat = VP.lupton_rgb(np.array([s0]), np.array([s0]), np.array([s0]))[0]
    assert flat[0] == flat[1] == flat[2] > 0
    assert tuple(VP.lupton_rgb(0.0, 0.0, 0.0)) == (0, 0, 0)
    big = VP.lupton_rgb(1e6 * s0, 0.5e6 * s0, 0.25e6 * s0)
    assert big.max() == 255 and abs(int(big[1]) - 128) <= 1 and abs(int(big[2]) - 64) <= 1
    golden = [(s0, s0, s0), (0.2 * s0, 0.1 * s0, 0.05 * s0), (3 * s0, 5 * s0, 9 * s0), (1e-3 * s0, 0, 0),
              (40 * s0, 25 * s0, 12 * s0)]
    for g in golden:
        assert tuple(int(x) for x in VP.lupton_rgb(*g)) == _lupton_ref(*g)


# ------------------------------------------------------------------------------- write_cube + merge + validate
def _dep():
    return {"n_elements": 10, "n_straddling": 1, "lost_fraction": 0.01, "seconds": 0.1, "workers": 1}


def _stats():
    return {"frac_empty": 0.1, "p01": -3.0, "p50": -2.0, "p99": -1.0, "max": -0.5}


def make_viz(root, n=16):
    rng = np.random.default_rng(7)
    levels = {}
    fields = {}
    for key, kind in (("nH", "density"), ("T", "mass_weighted")):
        cubes = {}
        for L in ("L1",):
            q = rng.integers(0, 256, (n, n, n), dtype=np.uint8)
            cubes[L] = VP.write_cube(root, f"gas/{L}", key, VP.raw_gas(q), VP.atlas_parts(q), kind="gas",
                                     vmin=-6.0, vmax=0.5, stats=_stats(), deposit=_dep())
        proj = ({"kind": "column", "units": "cm^-2", "vmin": 19.3, "vmax": 22.5} if kind == "density" else
                {"kind": "weighted_mean", "weight": "nH", "units": "K", "vmin": 4.0, "vmax": 6.0})
        fields[key] = {"label": key, "units": "cm^-3" if kind == "density" else "K", "kind": kind,
                       "source": "synthetic", "vmin": -6.0, "vmax": 0.5,
                       "cmap": "tng_dusk" if kind == "density" else "inferno", "proj": proj,
                       "vol_window": [-4.0, 0.5], "cubes": cubes}
    levels["L1"] = {"half_kpc": 100.0, "n": n, "voxel_kpc": 200.0 / n, "r_mask_kpc": None}
    gen = {"deposit": "tngsight.deposit/1", "vizpack": VP.GENERATOR, "pillow": "x", "libwebp": "x", "numpy": "x"}
    (root / "gas").mkdir(parents=True, exist_ok=True)
    (root / "gas" / "manifest_gas.json").write_text(json.dumps(
        {"schema": VP.SCHEMA, "generator": {**gen, "gas": "tngsight.volume/2"}, "levels": levels,
         "gas": {"levels": ["L1"], "fields": fields}}))
    qs = rng.integers(0, 256, (n, n, n, 3), dtype=np.uint8)
    sc = VP.write_cube(root, "stars/S1", "gri", VP.raw_stars(qs[..., 0], qs[..., 1], qs[..., 2]),
                       VP.atlas_parts(qs), kind="stars", vmin=-3.7, vmax=7.7, stats=_stats(), deposit=_dep())
    (root / "stars" / "manifest_stars.json").write_text(json.dumps(
        {"schema": VP.SCHEMA, "generator": {**gen, "stars": "tngsight.stars/1"},
         "levels": {"S1": {"half_kpc": 100.0, "n": n, "voxel_kpc": 200.0 / n, "r_mask_kpc": None}},
         "stars": {"levels": ["S1"], "bands": ["i", "r", "g"], "units": "L_AB0 kpc^-3",
                   "photometry": "GFM_StellarPhotometrics columns i=6 r=5 g=4",
                   "exclude": "GFM_StellarFormationTime <= 0",
                   "display": {"Q": 8.0, "mu0": 21.5, "mu_zero": 36.57212566588, "balance": [1.0, 1.0, 1.0],
                               "formula": "lupton2004"}, "cubes": {"S1": sc}}}))
    (root / "luts").mkdir(exist_ok=True)
    (root / "luts" / "luts.json").write_text(json.dumps({"version": 1, "luts": {"grey": {"hex": "00" * 768}}}))
    return root


def test_write_merge_validate(tmp_path):
    viz = make_viz(tmp_path / "viz")
    man = VP.merge(viz)
    on_disk = json.loads((viz / "manifest_v2.json").read_text())
    assert on_disk == man and man["luts"]["names"] == ["grey"]
    assert man["generator"]["vizpack"] == VP.GENERATOR and man["generator"]["gas"] == "tngsight.volume/2"
    assert set(man["levels"]) == {"L1", "S1"}
    VP.validate_manifest_v2(man, base_dir=viz)
    c = man["gas"]["fields"]["nH"]["cubes"]["L1"]
    assert c["webp"]["paths"][0] == f"gas/L1/nH.{c['raw_sha256'][:12]}.p0.webp"
    assert man["stars"]["cubes"]["S1"]["gz"]["path"].endswith(".rgba.gz")
    raw = gzip.decompress((viz / c["gz"]["path"]).read_bytes())
    assert hashlib.sha256(raw).hexdigest() == c["raw_sha256"]
    # one corrupted byte → validation with base_dir fails, without base_dir passes
    p = viz / c["webp"]["paths"][2]
    b = bytearray(p.read_bytes())
    b[len(b) // 2] ^= 0xFF
    p.write_bytes(bytes(b))
    VP.validate_manifest_v2(man)
    with pytest.raises(ValueError, match="sha256"):
        VP.validate_manifest_v2(man, base_dir=viz)


@pytest.mark.parametrize("damage", ["schema", "range", "path", "rawbytes", "level", "stars_bands"])
def test_validate_rejects(tmp_path, damage):
    viz = make_viz(tmp_path / "viz")
    man = VP.merge(viz)
    c = man["gas"]["fields"]["nH"]["cubes"]["L1"]
    if damage == "schema":
        man["schema"] = "tng50-viz/1"
    elif damage == "range":
        c["vmin"] = -5.0
    elif damage == "path":
        c["webp"]["paths"][1] = "gas/L1/nH.000000000000.p1.webp"
    elif damage == "rawbytes":
        c["raw_bytes"] += 1
    elif damage == "level":
        man["levels"]["L1"]["half_kpc"] = 99.0
    elif damage == "stars_bands":
        man["stars"]["bands"] = ["g", "r", "i"]
    with pytest.raises(ValueError):
        VP.validate_manifest_v2(man)


def test_cli(tmp_path, capsys):
    viz = make_viz(tmp_path / "viz")
    assert VP.main(["merge", str(viz)]) == 0
    assert VP.main(["validate", str(viz)]) == 0
    assert "OK" in capsys.readouterr().out
    assert VP.main(["bogus"]) == 2
