"""Tests for tngsight.volume (Phase-2 design §3.4). Fast tests use synthetic cubes in tmp; the committed
docs/tng50/data/vol/ manifest is checked when present. The deposition test is @slow (TNG_RUN_SLOW=1): it loads
yt/trident + the slim cutout under the heavy-I/O lock."""
import contextlib
import gzip
import json
import math
import os
from pathlib import Path
import numpy as np
import pytest

from tngsight import volume as V

ROOT = Path(__file__).resolve().parent.parent
VOL_DIR = ROOT / "docs" / "tng50" / "data" / "vol"
LOCK = Path(os.environ["TNG_HEAVY_LOCK"]) if os.environ.get("TNG_HEAVY_LOCK") else None   # opt-in heavy-I/O lock


def tol(lo, hi):
    return (hi - lo) / 508 + 1e-12


# ------------------------------------------------------------------------------- 1. round trip
def test_encode_decode_round_trip():
    rng = np.random.default_rng(1)
    n, lo, hi = 16, -8.0, 2.0
    lv = rng.uniform(lo, hi, (n, n, n))
    v = 10.0 ** lv
    v[0, 0, 0] = np.nan; v[1, 0, 0] = 0.0; v[2, 0, 0] = -3.0; v[3, 0, 0] = np.inf
    mask = np.ones((n, n, n), bool); mask[4, 0, 0] = False
    buf = V.encode_u8(v, mask, lo, hi)
    assert isinstance(buf, bytes) and len(buf) == n ** 3
    q = np.frombuffer(buf, np.uint8).reshape(n, n, n).transpose(2, 1, 0)
    for i in range(5):
        assert q[i, 0, 0] == 0
    dec = V.decode_u8(buf, n, lo, hi)
    assert np.isnan(dec[:5, 0, 0]).all()
    good = ~np.isnan(dec)
    assert good.sum() == n ** 3 - 5
    assert np.max(np.abs(dec[good] - lv[good])) <= tol(lo, hi)
    assert q[good].min() >= 1
    # out-of-range values clip to 1 / 255, never 0
    q2 = V.quantize(np.array([1e-30, 1e30]).reshape(2, 1, 1), None, lo, hi)
    assert q2.ravel().tolist() == [1, 255]


# ------------------------------------------------------------------------------- 2. layout
def test_layout_x_fastest():
    n, lo, hi = 8, 0.0, 3.0
    i, j, k = np.meshgrid(np.arange(n), np.arange(n), np.arange(n), indexing="ij")
    f = (i + 7 * j + 49 * k).astype(float) + 1.0          # +1: keep log10 finite
    lf = np.log10(f)
    buf = V.encode_u8(f, None, lo, hi)
    for (a, b, c) in [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), (7, 3, 5), (2, 6, 7)]:
        q = buf[a + n * (b + n * c)]
        assert abs(lo + (q - 1) * (hi - lo) / 254 - lf[a, b, c]) <= tol(lo, hi)
    np.testing.assert_allclose(V.decode_u8(buf, n, lo, hi), lf, atol=tol(lo, hi))
    with pytest.raises(ValueError):
        V.decode_u8(buf[:-1], n, lo, hi)


# ------------------------------------------------------------------------------- 3. geometry
def test_radial_mask_and_centers():
    n, half = 16, V.HALF_KPC
    c = V.voxel_centers(n)
    vox = 2 * half / n
    assert c[0] == pytest.approx(-half + vox / 2) and c[-1] == pytest.approx(half - vox / 2)
    np.testing.assert_allclose(c, -c[::-1], atol=1e-12)
    m = V.radial_mask(n)
    cnt = sum(1 for a in c for b in c for d in c if a * a + b * b + d * d <= V.R_MASK_KPC ** 2)
    assert m.shape == (n, n, n) and m.sum() == cnt
    np.testing.assert_array_equal(m, m.transpose(1, 0, 2))
    e = V.grid_edges(256)
    assert e["voxel_kpc"] == 3.125 and e["dims"] == [256] * 3
    np.testing.assert_allclose(e["left_code"], (V.CENTER_KPC - 400) * V.H, rtol=1e-15)
    np.testing.assert_allclose(e["right_code"], (V.CENTER_KPC + 400) * V.H, rtol=1e-15)


# ------------------------------------------------------------------------------- 4. gzip
def test_gzip_deterministic():
    raw = np.random.default_rng(2).integers(0, 256, 5000, dtype=np.uint8).tobytes()
    a, b = V.gzip_bytes(raw), V.gzip_bytes(raw)
    assert a == b and a[:2] == b"\x1f\x8b"
    assert gzip.decompress(a) == raw
    assert a[4:8] == b"\0\0\0\0"                           # mtime 0
    assert a[3] & 0x08 == 0                                # no FNAME


# ------------------------------------------------------------------------------- 5. downsample
def test_downsample2():
    v = np.full((8, 8, 8), 3.5)
    d, m = V.downsample2(v, np.ones_like(v, bool))
    assert d.shape == (4, 4, 4) and m.all() and np.allclose(d, 3.5)
    v = np.arange(512, dtype=float).reshape(8, 8, 8)
    mask = np.ones_like(v, bool)
    mask[0, 0, 0] = False; mask[1, 1, 1] = False                       # block (0,0,0): 6 valid children
    mask[2:4, 2:4, 2:4] = False                                        # block (1,1,1): none valid
    d, m = V.downsample2(v, mask)
    kids = v[0:2, 0:2, 0:2][mask[0:2, 0:2, 0:2]]
    assert d[0, 0, 0] == pytest.approx(kids.mean()) and m[0, 0, 0]
    assert not m[1, 1, 1] and np.isnan(d[1, 1, 1])
    assert d[1, 0, 0] == pytest.approx(v[2:4, 0:2, 0:2].mean())


# ------------------------------------------------------------------------------- 6. files + manifest
def test_write_field_and_manifest(tmp_path):
    n = 16
    rng = np.random.default_rng(3)
    mask = V.radial_mask(n)
    entries = {}
    for key in V.VOL_KEYS:
        v = 10.0 ** rng.normal(-4, 1, (n, n, n))
        entries[key] = V.write_field(tmp_path, key, v, mask)
        e = entries[key]
        lo, hi = V.choose_range(v, mask)
        assert (e["lo"], e["hi"]) == (lo, hi)
        assert round(lo * 10) == pytest.approx(lo * 10) and round(hi * 10) == pytest.approx(hi * 10)
        assert e["files"] == {"16": f"{key}.u8.gz", "8": f"{key}.8.u8.gz"}
        assert e["raw_bytes"] == {"16": 4096, "8": 512}
        assert e["stats"]["frac_empty"] == pytest.approx(1 - mask.mean(), abs=1e-4)
        assert lo <= e["default_window"][0] < e["default_window"][1] <= hi
        raw = gzip.decompress((tmp_path / e["files"]["16"]).read_bytes())
        assert raw == V.encode_u8(v, mask, lo, hi)
    m = V.write_manifest(tmp_path, entries, {"n": n})
    V.validate_manifest(m, base_dir=tmp_path)
    assert V.load_manifest(tmp_path) == m
    assert list(m["fields"]) == list(V.VOL_KEYS)
    assert m["grids"] == {"16": {"n": 16, "voxel_kpc": 50.0}, "8": {"n": 8, "voxel_kpc": 100.0}}
    assert m["encoding"]["decode"] == "log10(v) = lo + (q - 1) * (hi - lo) / 254"
    bad = json.loads(json.dumps(m)); bad["fields"]["nH"]["sha256"]["16"] = "0" * 64
    with pytest.raises(ValueError):
        V.validate_manifest(bad, base_dir=tmp_path)
    bad = json.loads(json.dumps(m)); bad["fields"]["T"]["lo"] = 99.0
    with pytest.raises(ValueError):
        V.validate_manifest(bad)


def test_integrate_column_constant():
    n, half = 32, V.HALF_KPC
    v = np.full((n, n, n), 1e-3)
    p0, p1 = np.array([-100.0, 20.0, 5.0]), np.array([150.0, -40.0, 30.0])
    L = np.linalg.norm(p1 - p0)
    assert V.integrate_column(v, p0, p1, half) == pytest.approx(math.log10(1e-3 * L * V.CM_PER_KPC), abs=1e-9)


# ------------------------------------------------------------------------------- 7. committed volumes
@pytest.mark.skipif(not (VOL_DIR / "manifest.json").is_file(), reason="docs/tng50/data/vol not built")
def test_committed_manifest():
    m = V.load_manifest(VOL_DIR)
    V.validate_manifest(m, base_dir=VOL_DIR)
    assert set(m["fields"]) == set(V.VOL_KEYS)
    assert set(m["grids"]) == {"256", "128"}
    total = 0
    for key, e in m["fields"].items():
        assert e["bytes"]["256"] <= 10_000_000, key
        assert e["bytes"]["128"] <= 1_500_000, key
        total += sum(e["bytes"].values())
    assert total <= 60_000_000
    assert m["galaxy"]["subhalo_id"] == 488530 and m["half_kpc"] == 400.0 and m["z_sun"] == V.Z_SUN


# ------------------------------------------------------------------------------- 8. real deposition (slow)
@contextlib.contextmanager
def heavy_lock():
    if LOCK is None or not LOCK.parent.is_dir():
        yield; return
    import fcntl
    with open(LOCK, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("TNG_RUN_SLOW") != "1", reason="set TNG_RUN_SLOW=1 (loads yt+trident+cutout)")
def test_deposit_columns_and_mass(tmp_path):
    from tngsight import config, library as L
    from tngsight.generate import Generator
    npz = config.library_dir() / "sightlines" / "face_b050_a090.npz"
    if not npz.is_file() or not config.cutout_path().is_file():
        pytest.skip("library npz or slim cutout absent")
    n = 64
    idx = Path(os.environ.get("TNG_INDEX_FILE", config.index_path()))
    with heavy_lock():
        g = Generator(index_filename=idx, workdir=tmp_path / "work")
        g.load()
        ds = g.ds
        cols = {k: V.deposit(ds, k, n) for k in ("OVI", "HI")}
        # mass check at 64³ as design §3.4 item 8 specifies, with the raw (unnormalised) SPH sum used for every
        # extensive field: Σρ dV / Σ m (r < 200 kpc) = 0.942 at 64³ (normalised: 0.790, which forced the
        # earlier 256³ workaround of §12 amendment 3, now reverted)
        n_mass = n
        rho = V.deposit_field(ds, ("gas", "density"), "Msun/kpc**3", n_mass, normalize=False)
        ad = ds.all_data()
        pos = ad["PartType0", "Coordinates"].to("code_length").d / V.H - V.CENTER_KPC
        mass = ad["PartType0", "Masses"].to("Msun").d
    pay = L.load_npz(npz)
    p0 = np.array(pay["geom"]["start_kpc"]) - V.CENTER_KPC
    p1 = np.array(pay["geom"]["end_kpc"]) - V.CENTER_KPC
    for vk, lk in (("OVI", "OVI"), ("HI", "HILyb")):
        d = V.integrate_column(cols[vk], p0, p1) - pay["logN"][lk]
        assert abs(d) <= 0.3, (vk, d)
    c = V.voxel_centers(n_mass)
    r = np.sqrt(c[:, None, None] ** 2 + c[None, :, None] ** 2 + c[None, None, :] ** 2)
    vox = 2 * V.HALF_KPC / n_mass
    m_grid = float(rho[r < 200].sum() * vox ** 3)
    m_part = float(mass[np.linalg.norm(pos, axis=1) < 200].sum())
    assert abs(m_grid / m_part - 1) <= 0.15, (m_grid, m_part)


def test_sph_normalisation_per_field():
    """Extensive densities use the raw SPH sum, intensive T/Z the normalised one (physics-3 fix)."""
    assert {k: V.FIELDS[k]["normalize"] for k in V.VOL_KEYS} == {
        "nH": False, "T": True, "Z": True, "OVI": False, "HI": False, "CIII": False}

    class Arr:
        def __init__(self, n):
            self.d = np.ones(n ** 3)

        def to(self, units):
            return self

    class DS:
        derived_field_list = [("gas", "H_nuclei_density")]
        use_sph_normalization = None
        seen = []

        def arr(self, v, u):
            return v

        def arbitrary_grid(self, lo, hi, dims):
            ds = self

            class AG:
                def __getitem__(self, f):
                    ds.seen.append((f, ds.use_sph_normalization))
                    return Arr(dims[0])
            return AG()
    ds = DS()
    for k in ("HI", "T"):
        V.deposit(ds, k, n=4)
    assert ds.seen == [(("gas", "H_p0_number_density"), False), (("gas", "temperature"), True)]
