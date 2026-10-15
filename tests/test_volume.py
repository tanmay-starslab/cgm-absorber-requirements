"""Tests for tngsight.volume v2 (Phase-2b design §4.1, §4.3). Fast tests are synthetic; the real-data column test is
@slow (TNG_RUN_SLOW=1): it uses the cached per-cell arrays (viz_cache/gas/cells_*.npy) or loads the slim cutout."""
import contextlib
import json
import math
import os
from pathlib import Path

import numpy as np
import pytest

from tngsight import deposit as D
from tngsight import volume as V

ROOT = Path(__file__).resolve().parent.parent
CM = V.CM_PER_KPC
LOCK = Path(os.environ.get("TNG_HEAVY_LOCK", "/Volumes/cgm_work/scratch/p2/heavy.lock"))


# ------------------------------------------------------------------------------- 1. constants and FIELDS
def test_fields_mapping():
    from tngsight import ions as I
    assert V.VOL_KEYS == ("nH", "T", "Z") + I.KEYS
    assert V.VOL_VERSION == 2 and V.GENERATOR == "tngsight.volume/2"
    assert V.GAS_LEVELS == {"L0": 400.0, "L1": 100.0, "L2": 25.0} and V.N == 256
    assert V.Z_SUN == 0.0127
    exp = {"nH": (("gas", "H_nuclei_density"), "density", "tng_dusk"),
           "OVI": (("gas", "O_p5_number_density"), "density", "magma"),
           "HI": (("gas", "H_p0_number_density"), "density", "tng_ice"),
           "CIII": (("gas", "C_p2_number_density"), "density", "viridis"),
           "T": (("gas", "temperature"), "mass_weighted", "inferno"),
           "Z": (("gas", "metallicity"), "mass_weighted", "cividis")}
    for k, (f, kind, cmap) in exp.items():
        e = V.FIELDS[k]
        assert set(e) >= {"label", "units", "kind", "cmap", "yt_field"}
        assert (e["yt_field"], e["kind"], e["cmap"]) == (f, kind, cmap)
    assert V.FIELDS["T"]["units"] == "K" and V.FIELDS["Z"]["units"] == "Zsun"
    assert all(V.FIELDS[k]["units"] == "cm^-3" for k in ("nH",) + I.KEYS)
    assert V.QUANTITIES == ("N_nH",) + tuple(f"N_{k}" for k in I.KEYS) + ("m", "mT", "mZ")
    # design §3.5: new ions from the registry, cool -> tng_ice, intermediate -> viridis, hot -> magma
    cm = {k: V.FIELDS[k]["cmap"] for k in I.KEYS}
    assert [k for k in I.KEYS if cm[k] == "tng_ice"] == ["HI", "MgII", "SiII", "CII", "SiIII"]
    assert [k for k in I.KEYS if cm[k] == "viridis"] == ["CIII", "SiIV", "CIV", "NV"]
    assert [k for k in I.KEYS if cm[k] == "magma"] == ["OVI", "NeVIII", "OVII"]
    for k in I.KEYS:
        assert V.FIELDS[k]["yt_field"] == ("gas", I.get(k)["field"]) and V.FIELDS[k]["label"] == f"n({I.get(k)['ion']})"
        assert V.SOURCES[k] == f"('gas','{I.get(k)['field']}') * V_cell" and V.PRIMARY[k] == f"N_{k}"
    assert set(V.EXPECTED_RANGE) == {"nH", "OVI", "HI", "CIII"}
    assert V.quantities_for(["OVII"]) == ("N_nH", "N_OVII", "m") and V.quantities_for(["T"]) == ("N_nH", "m", "mT")


def _cells(pos, h, V_cm3, m, T, Z, nH=None):
    n = len(m)
    nH = np.full(n, 1e-3) if nH is None else np.asarray(nH, float)
    return {"pos_disk": np.asarray(pos, float), "h": np.asarray(h, float), "V_cm3": np.asarray(V_cm3, float),
            "m": np.asarray(m, float), "nH": nH, "T": np.asarray(T, float), "Z": np.asarray(Z, float),
            **{k: nH * 10.0 ** (-3 - i / 3) for i, k in enumerate(V.ION_KEYS)}}


# ------------------------------------------------------------------------------- 2. extensive -> densities, T/Z
def test_extensive_and_level_cubes_four_elements():
    """4 synthetic cells (two sub-voxel, two wider) inside the L1 box on an 8³ lattice (Δ = 25 kpc)."""
    pos = [[0, 0, 0], [3, -2, 1], [-40, 30, 10], [20, 20, -60]]
    h = [2.0, 5.0, 30.0, 45.0]
    vol = [1e66, 2e66, 5e67, 8e67]
    m = [1e6, 3e6, 2e7, 5e7]
    T = [1e4, 1e5, 1e6, 3e6]
    Z = [1.0, 0.5, 0.1, 0.02]
    nH = [1e-1, 3e-2, 1e-4, 2e-5]
    cells = _cells(pos, h, vol, m, T, Z, nH)
    q = V.extensive(cells)
    assert set(q) == set(V.QUANTITIES)
    np.testing.assert_allclose(q["N_nH"], np.array(nH) * vol)
    np.testing.assert_allclose(q["mT"], np.array(m) * T)
    np.testing.assert_allclose(q["mZ"], np.array(m) * Z)
    cubes, dep = V.build_level(cells, "L1", workers=1, n=8)
    assert set(cubes) == set(V.VOL_KEYS)
    vvox = (25.0 * CM) ** 3
    # every element is fully inside ±100 kpc -> exact totals (density · V_vox sums back to Σ n_i V_i)
    assert dep.n_straddling == 0
    for k in ("nH",) + V.ION_KEYS:
        tot = float(cubes[k].sum() * vvox)
        assert abs(tot / float(q[f"N_{k}"].sum()) - 1) < 1e-12, k
    sub, dsub = V.build_level(cells, "L1", workers=1, n=8, keys=("nH", "MgII", "T"))   # only what the fields need
    assert set(sub) == {"nH", "MgII", "T"} and set(dsub.grids) == {"N_nH", "N_MgII", "m", "mT"}
    assert np.array_equal(sub["MgII"], cubes["MgII"]) and np.array_equal(sub["T"], cubes["T"])
    mv = dep.grids["m"]
    # mass-weighted T/Z: Σ_vox T·m_vox = Σ_i m_i T_i, and T = mT/m per voxel
    assert abs(float((cubes["T"] * mv).sum()) / float(np.sum(np.array(m) * T)) - 1) < 1e-12
    assert abs(float((cubes["Z"] * mv).sum()) / float(np.sum(np.array(m) * Z)) - 1) < 1e-12
    pos_m = mv > 0
    np.testing.assert_allclose(cubes["T"][pos_m], dep.grids["mT"][pos_m] / mv[pos_m], rtol=1e-14)
    assert np.all(cubes["T"][~pos_m] == 0)
    assert cubes["T"][pos_m].min() >= min(T) * (1 - 1e-12) and cubes["T"].max() <= max(T) * (1 + 1e-12)


def test_gas_h_floor_two_voxels():
    """tune1: gas cells are deposited with h ≥ GAS_H_MIN_VOX·Δ, so a sub-voxel cell spreads over a round footprint of
    radius 2Δ (not a 2×2×2 stamp), and its total is still conserved."""
    assert V.GAS_H_MIN_VOX == 2.0
    cells = _cells([[0.3, -0.2, 0.1]], [0.5], [1e66], [1e6], [1e4], [1.0], [1e-1])
    cubes, dep = V.build_level(cells, "L1", workers=1, n=16)          # Δ = 12.5 kpc, h = 0.5 kpc ≪ Δ
    dx = 200.0 / 16
    tot = float(cubes["nH"].sum() * (dx * CM) ** 3)
    assert abs(tot / (1e-1 * 1e66) - 1) < 1e-12
    occupied = int((dep.grids["N_nH"] > 0).sum())
    assert occupied > 8                                               # the 1 Δ floor would give at most 8 voxels
    c = np.array(np.nonzero(dep.grids["N_nH"])).T * dx - 100.0 + dx / 2
    assert np.max(np.linalg.norm(c - [0.3, -0.2, 0.1], axis=1)) < V.GAS_H_MIN_VOX * dx + 1e-9


def test_coincident_cells_give_exact_mass_weighted_mean():
    cells = _cells([[1, 1, 1]] * 4, [3.0] * 4, [1e66] * 4, [1.0, 2.0, 3.0, 4.0], [10, 20, 30, 40],
                   [0.1, 0.2, 0.3, 0.4])
    cubes, dep = V.build_level(cells, "L2", n=8)
    ok = dep.grids["m"] > 0
    assert ok.sum() > 1
    np.testing.assert_allclose(cubes["T"][ok], 30.0, rtol=1e-12)       # (10 + 40 + 90 + 160)/10
    np.testing.assert_allclose(cubes["Z"][ok], 0.3, rtol=1e-12)


# ------------------------------------------------------------------------------- 3. L0 mask
def test_l0_mask():
    cells = _cells([[0, 0, 0]], [3000.0], [1e70], [1e10], [1e6], [0.1])   # h ≫ box: fills every voxel
    cubes, dep = V.build_level(cells, "L0", n=8)
    c = V.VP.voxel_centers(8, 400.0)
    r = np.sqrt(c[:, None, None] ** 2 + c[None, :, None] ** 2 + c[None, None, :] ** 2)
    out = r > 400.0
    assert out.any() and (~out).any()
    for k in V.VOL_KEYS:
        assert np.all(cubes[k][out] == 0), k
        assert np.all(cubes[k][~out] > 0), k
    assert V.level_mask("L1") is None and V.level_mask("L2") is None
    m0 = V.level_mask("L0", 8)
    assert m0.dtype == bool and np.array_equal(m0, ~out)
    # L1/L2 are not masked
    cubes1, _ = V.build_level(_cells([[0, 0, 0]], [800.0], [1e70], [1e10], [1e6], [0.1]), "L1", n=8)
    assert np.all(cubes1["nH"] > 0)


# ------------------------------------------------------------------------------- 4. ranges (§2.3 gas rule)
def test_gas_range_rule():
    rng = np.random.default_rng(3)
    n = 8
    a = 10.0 ** rng.uniform(-6.03, -1.0, (n, n, n))
    b = 10.0 ** rng.uniform(-4.0, 0.33, (n, n, n))
    c = 10.0 ** rng.uniform(-3.0, -0.5, (n, n, n))
    a[0, 0, 0] = 1e-30                       # an L0 corner voxel (r > 400) is masked out of the range
    b[1, 1, 1] = 0.0; b[2, 2, 2] = np.nan    # invalid voxels are ignored
    cubes = {"L0": {"nH": a}, "L1": {"nH": b}, "L2": {"nH": c}}
    vmin, vmax = V.field_range(cubes, "nH")
    m0 = V.level_mask("L0", n)
    assert not m0[0, 0, 0]
    lo = min(np.percentile(np.log10(a[m0]), 0.5), np.percentile(np.log10(b[np.isfinite(b) & (b > 0)]), 0.5),
             np.percentile(np.log10(c), 0.5))
    hi = max(np.log10(a[m0]).max(), np.nanmax(np.log10(np.where(b > 0, b, np.nan))), np.log10(c).max())
    assert vmin == math.floor(round(lo * 10, 6)) / 10 and vmax == math.ceil(round(hi * 10, 6)) / 10
    assert vmax == 0.4                         # FULL range: the max is kept, no p99.99 clip
    assert V.VP.snap_down(-2.0000000001) == -2.0 and V.VP.snap_up(0.30000000004) == 0.3
    assert V.check_expected_range("nH", -6.0, 0.5) == []           # the amended (masked p0.5) bound
    assert V.check_expected_range("HI", -12.29, -0.6) == []
    assert V.check_expected_range("nH", -8.6, 0.5)                  # an unmasked p0.5 is a regression
    assert V.check_expected_range("nH", -7.0, 0.5) and V.check_expected_range("T", 0.0, 99.0) == []


def test_quantize_full_range_and_empty():
    v = np.array([np.nan, 0.0, -1.0, 1e-9, 1e-5, 1.0, 10.0]).reshape(7, 1, 1)
    q = V.VP.quantize(v, None, -5.0, 0.5)
    assert q.ravel().tolist()[:3] == [0, 0, 0]
    assert q.ravel()[3] == 1 and q.ravel()[4] == 1 and q.ravel()[6] == 255
    dec = V.VP.dequantize(q, -5.0, 0.5)
    assert np.isnan(dec.ravel()[:3]).all() and abs(dec.ravel()[5] - 0.0) <= 5.5 / 508 + 1e-12


# ------------------------------------------------------------------------------- 5. proj / vol windows (§3.5)
def test_proj_window_column_and_weighted():
    n = 16
    cubes = {}
    for L, half in V.GAS_LEVELS.items():
        cubes[L] = {"nH": np.full((n, n, n), 1e-3), "T": np.full((n, n, n), 1e5)}
    cubes["L0"]["nH"] = np.where(V.level_mask("L0", n), 1e-3, 0.0)
    cubes["L2"]["nH"][n // 2, n // 2, :] = 1.0                 # a dense column at L2 sets the p99.9 maximum
    maps = V.column_maps(np.full((n, n, n), 2e-3), "L1")
    np.testing.assert_allclose(10 ** maps["face"], 2e-3 * 200.0 * CM, rtol=1e-12)
    np.testing.assert_allclose(10 ** maps["edge"], 2e-3 * 200.0 * CM, rtol=1e-12)
    pr = V.proj_window(cubes, "nH")
    assert pr["kind"] == "column" and pr["units"] == "cm^-2"
    f0 = V.column_maps(cubes["L0"]["nH"], "L0")["face"]
    c = V.VP.voxel_centers(n, 400.0)
    rr = np.hypot(c[:, None], c[None, :])
    sel = f0[(rr < V.GALAXY["R200c_kpc"]) & np.isfinite(f0)]
    p2, p50 = np.percentile(sel, 2), np.percentile(sel, 50)
    assert pr["vmin"] == V.VP.snap_down(max(p2, p50 - 3.0))
    allp = [np.percentile(V._finite(V.column_maps(cubes[L]["nH"], L)[m]), 99.9)
            for L in V.GAS_LEVELS for m in ("face", "edge")]
    assert pr["vmax"] == V.VP.snap_up(max(allp))
    pt = V.proj_window(cubes, "T")
    assert pt == {"kind": "weighted_mean", "weight": "nH", "units": "K", "vmin": 5.0, "vmax": 5.0} or \
        (pt["kind"] == "weighted_mean" and pt["vmin"] == 5.0 and pt["vmax"] == 5.0)
    # a hotter disk in L1 only, weighted by nH
    T1 = np.full((n, n, n), 1e5); T1[:, :, n // 2] = 1e7
    nh1 = np.full((n, n, n), 1e-3); nh1[:, :, n // 2] = 9e-3
    wm = V.weighted_maps(T1, nh1)
    np.testing.assert_allclose(10 ** wm["face"], (15 * 1e-3 * 1e5 + 9e-3 * 1e7) / (15e-3 + 9e-3), rtol=1e-12)
    vw = V.vol_window(cubes, "nH", 0.5)
    assert vw == [V.VP.snap_down(-3.0), 0.5]


# ------------------------------------------------------------------------------- 6. cube files + fragment
def test_encode_cube_job_fragment_and_validation(tmp_path):
    n = 16
    rng = np.random.default_rng(5)
    v = 10.0 ** rng.uniform(-6, 0, (n, n, n))
    q = V.VP.quantize(v, None, -6.0, 0.0)
    stats = V.cube_stats(v, q)
    dep = {"n_elements": 10, "n_straddling": 1, "lost_fraction": 0.01, "seconds": 0.1, "workers": 1}
    cube = V.encode_cube_job((str(tmp_path), "L1", "nH", q, -6.0, 0.0, stats, dep))
    id12 = cube["raw_sha256"][:12]
    assert cube["webp"]["paths"] == [f"gas/L1/nH.{id12}.p{p}.webp" for p in range(4)]
    assert cube["gz"]["path"] == f"gas/L1/nH.{id12}.u8.gz"
    assert cube["raw_bytes"] == n ** 3 and cube["raw_sha256"] == V._sha(V.VP.raw_gas(q))
    import gzip
    raw = gzip.decompress((tmp_path / cube["gz"]["path"]).read_bytes())
    assert raw == V.VP.raw_gas(q) and raw[3 + n * (2 + n * 1)] == q[3, 2, 1]        # x-fastest
    dec = [V.VP.decode_webp((tmp_path / p).read_bytes()) for p in cube["webp"]["paths"]]
    assert V.VP.atlas_to_raw(dec, n, 1) == raw
    assert V.VP.gzip_bytes(raw) == V.VP.gzip_bytes(raw)
    e = V.field_entry("nH", -6.0, 0.0, {"kind": "column", "units": "cm^-2", "vmin": 19.3, "vmax": 22.5},
                      [-3.0, 0.0], {"L1": cube})
    frag = V.gas_fragment({"nH": e}, ("L1",), n=n)
    assert frag["schema"] == "tng50-viz/2" and frag["levels"]["L1"]["voxel_kpc"] == 200.0 / n
    assert set(frag["generator"]) >= {"deposit", "vizpack", "gas", "pillow", "libwebp", "numpy"}
    V.validate_gas_fragment(frag, base_dir=tmp_path)
    V.write_fragment(tmp_path, frag)
    assert json.loads((tmp_path / "gas" / "manifest_gas.json").read_text()) == json.loads(json.dumps(frag))
    p = tmp_path / cube["webp"]["paths"][2]
    b = bytearray(p.read_bytes()); b[-1] ^= 1; p.write_bytes(bytes(b))
    with pytest.raises(ValueError):
        V.validate_gas_fragment(frag, base_dir=tmp_path)
    bad = json.loads(json.dumps(frag)); bad["gas"]["fields"]["nH"]["cubes"]["L1"]["vmin"] = -5.0
    with pytest.raises(ValueError):
        V.validate_gas_fragment(bad)


def test_column_from_u8_constant_and_cube_column():
    n, half = 16, 25.0
    v = np.full((n, n, n), 1e-2)
    q = V.VP.quantize(v, None, -2.0 - 1e-9, -2.0 + 1e-9)
    p0, p1 = np.array([-half, 1.0, -2.0]), np.array([half, 1.0, -2.0])
    exact = math.log10(1e-2 * 2 * half * CM)
    assert abs(V.VP.column_from_u8(q, -2.0 - 1e-9, -2.0 + 1e-9, half, p0, p1, spv=1.0) - exact) < 1e-6
    assert abs(math.log10(D.cube_column(v, half, p0, p1, 4.0) * CM) - exact) < 1e-12


def test_cell_arrays_from_fake_dataset():
    class Arr:
        def __init__(self, d, scale=1.0):
            self.d0, self.scale = np.asarray(d, float), scale

        def to(self, units):
            f = {"g": 1.989e33, "g/cm**3": 6.77e-32, "Msun": 1.0}.get(units, 1.0)
            out = Arr(self.d0 * f); return out

        @property
        def d(self):
            return self.d0
    c = np.array(V.GALAXY["center_kpc"]) * V.TNG_H
    data = {("PartType0", "Coordinates"): Arr([c, c + 1.0]), ("PartType0", "Masses"): Arr([1e6, 2e6]),
            ("PartType0", "Density"): Arr([1.0, 4.0])}
    for k in ("nH", "T", "Z") + V.ION_KEYS:
        data[V.FIELDS[k]["yt_field"]] = Arr([2.0, 3.0])

    class DS:
        derived_field_list = [V.FIELDS["nH"]["yt_field"]]

        def all_data(self):
            return data
    cells = V.cell_arrays(DS())
    assert set(cells) == set(V.CELL_NAMES)
    np.testing.assert_allclose(cells["pos_disk"][0], 0.0, atol=1e-9)
    np.testing.assert_allclose(np.linalg.norm(cells["pos_disk"][1]), math.sqrt(3) / V.TNG_H, rtol=1e-12)
    Vc = np.array([1e6, 2e6]) * 1.989e33 / (np.array([1.0, 4.0]) * 6.77e-32)
    np.testing.assert_allclose(cells["V_cm3"], Vc)
    np.testing.assert_allclose(cells["h"], 2.0 * (3 * Vc / (4 * np.pi)) ** (1 / 3) / CM)
    np.testing.assert_allclose(cells["Z"], np.array([2.0, 3.0]) / V.Z_SUN)
    np.testing.assert_allclose(cells["T"], [2.0, 3.0])


def test_build_script_clip_box():
    import importlib.util
    spec = importlib.util.spec_from_file_location("bv", ROOT / "deploy" / "data" / "build_volumes.py")
    bv = importlib.util.module_from_spec(spec); spec.loader.exec_module(bv)
    a, b = bv.clip_box([-300, 0, 0], [300, 10, 0], 100.0)
    np.testing.assert_allclose(a[0], -100.0) and np.testing.assert_allclose(b[0], 100.0)
    assert bv.clip_box([-300, 200, 0], [300, 200, 0], 100.0) is None


# ------------------------------------------------------------------------------- 7. real data (slow)
@contextlib.contextmanager
def heavy_lock():
    if not LOCK.parent.is_dir():
        yield; return
    import fcntl
    with open(LOCK, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("TNG_RUN_SLOW") != "1", reason="set TNG_RUN_SLOW=1 (real slim-cutout gas)")
def test_l1_128_ovi_column_face_b050(tmp_path):
    """A 128³ L1 build of N_OVI on face_b050_a090 reproduces the reference segment column within 0.15 dex.
    (final: was 64³, whose 3.1 kpc voxels miss by −0.162 dex on this sightline; 128³ (1.6 kpc) gave −0.081 dex.
    The shipped cubes are 256³ and their columns are checked separately.)"""
    from tngsight import config, library as Lb
    npz = config.library_dir() / "sightlines" / "face_b050_a090.npz"
    if not npz.is_file():
        pytest.skip("library npz absent")
    cache = config.library_dir() / "viz_cache" / "gas"
    cells = V.load_cells(cache, ("pos_disk", "h", "V_cm3", "OVI"))
    if cells is None:
        from tngsight.generate import Generator
        with heavy_lock():
            g = Generator(index_filename=Path(os.environ.get("TNG_INDEX_FILE", config.index_path())),
                          workdir=tmp_path / "work")
            g.load()
            cells = V.cell_arrays(g.ds)
    N = cells["OVI"] * cells["V_cm3"]
    g = V.grid("L1", 128)
    dep = D.scatter(cells["pos_disk"], cells["h"], {"N_OVI": N}, g)
    dens = dep.grids["N_OVI"] / (g.dx * CM) ** 3
    pay = Lb.load_npz(npz)
    p0 = D.to_disk(np.array([pay["geom"]["start_kpc"]]))[0]
    p1 = D.to_disk(np.array([pay["geom"]["end_kpc"]]))[0]
    import importlib.util
    spec = importlib.util.spec_from_file_location("bv", ROOT / "deploy" / "data" / "build_volumes.py")
    bv = importlib.util.module_from_spec(spec); spec.loader.exec_module(bv)
    a, b = bv.clip_box(p0, p1, 100.0)
    ref = math.log10(D.line_integral(cells["pos_disk"], cells["h"], N, a, b) / CM ** 2)
    col = math.log10(D.cube_column(dens, 100.0, a, b, 4.0) * CM)
    print(json.dumps({"ref": ref, "cube128": col, "d": col - ref, "seg_kpc": float(np.linalg.norm(b - a))}))
    assert abs(col - ref) <= 0.15
