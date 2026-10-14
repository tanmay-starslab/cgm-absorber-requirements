"""Tests for the legacy tng50/ scripts running on tngsight (shims, paths, frame/dλ fixes, bundle).

Run:  python -m pytest tng50/scripts/test_legacy.py   (needs the 3-ion library: TNG_SIGHTLINES_DIR,
<library>/sightlines or the read-only LaCie original; those tests skip without it).
"""
from __future__ import annotations
import json, os, subprocess, sys
from pathlib import Path
import numpy as np
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cgm_paths as P            # noqa: E402
import cgm_geometry as G         # noqa: E402
import degrade as D              # noqa: E402
from tngsight import config as TC, degrade as TD, library as TL   # noqa: E402

GIDS = ["edge_b100_a090", "face_b050_a090", "rand_b005_a134_s479980658", "edge_b100_a330"]


def _have(gid):
    try:
        return P.find_sightline(gid)
    except FileNotFoundError:
        return None


need_lib = pytest.mark.skipif(_have(GIDS[0]) is None, reason="3-ion npz library not reachable")


def _toy():
    lam = TL.wavelength_grid("OVI").astype(float); rest = TC.LINES["OVI"]["rest_A"]
    v = TC.C_KMS * (lam / rest - 1)
    tau = 1.5 * np.exp(-0.5 * ((v + 40) / 12) ** 2) + 0.6 * np.exp(-0.5 * ((v - 35) / 8) ** 2)
    return lam, tau, rest


def test_degrade_shim_matches_tngsight_and_legacy_positional_order():
    lam, tau, rest = _toy()
    for R, snr in ((20000, 8), (40000, None)):
        a = D.degrade(lam, tau, rest, R, snr, -37.5, 5, 3, 300.0)        # legacy: pix, seed, vwin
        b = TD.degrade(lam, tau, rest, R, snr, -37.5, dlam=TC.DLAMBDA, pix_per_resel=5, seed=3, vwin=300.0)
        for x, y in zip(a, b):
            np.testing.assert_array_equal(x, y)


def test_shim_uses_dlambda_not_median_spacing():
    lam, tau, rest = _toy()
    _, _, m_def = D.degrade(lam, tau, rest, 20000, None, 0.0, vwin=300.0)
    _, _, m_med = D.degrade(lam, tau, rest, 20000, None, 0.0, vwin=300.0, dlam=float(np.median(np.diff(lam))))
    _, _, m_002 = D.degrade(lam, tau, rest, 20000, None, 0.0, vwin=300.0, dlam=0.002)
    np.testing.assert_array_equal(m_def, m_002)
    assert np.abs(m_def - m_med).max() > 1e-5          # OVI median step is 0.001953 Å, so this differs


def test_velocity_frame_plus_vsys():
    lam, tau, rest = _toy()
    assert TC.VSYS_SIGN == +1
    np.testing.assert_allclose(D.velocity_axis(lam, rest, 50.0), TC.C_KMS * (lam / rest - 1) + 50.0)
    # an absorber at c*z = -v_sys (gas moving with the galaxy) lands at V = 0
    vs = 80.0
    v_hi = TC.C_KMS * (lam / rest - 1)
    t = 2.0 * np.exp(-0.5 * ((v_hi + vs) / 10) ** 2)
    v, _, m = D.degrade(lam, t, rest, 40000, None, vs, vwin=300.0)
    assert abs(v[np.argmin(m)]) < 2.0


def test_geom_id_legacy_order_and_canonicalize():
    assert G.geom_id("random", 12.5, 34.4, None, 99) == "rand_b012_a034_s99"
    assert G.geom_id("face-on", 50, 90, 30.0) == "face_b050_a090_i030"
    assert G.geom_id("edge-on", 100, 330) == "edge_b100_a330"
    c = G.canonicalize("edge", 100.4, 360, None)
    assert c["id"] == "edge_b100_a000" and c["seed"] is None
    with pytest.raises(ValueError):
        G.canonicalize("random", 100, 30, None)
    assert G.R200C == TC.GALAXY["R200c_kpc"] and G.SUBVEL.shape == (3,)


@need_lib
def test_make_sightline_reproduces_stored_geom():
    for gid in GIDS:
        p = _have(gid)
        if p is None:
            continue
        g = json.loads(str(np.load(p)["geom"]))
        seed = int(gid.rsplit("_s", 1)[1]) if "_s" in gid else None
        s = G.make_sightline(g["orientation"], g["b_kpc"], g["azimuth_deg"], seed=seed)
        for k in ("n_los", "start_ckpch", "end_ckpch", "anchor_kpc"):
            np.testing.assert_allclose(s[k], g[k], rtol=1e-9)
        assert s["v_sys_kms"] == pytest.approx(g["v_sys_kms"], rel=1e-9)


def test_find_sightline_both_namings(tmp_path, monkeypatch):
    lib = tmp_path / "lib"; (lib / "sightlines").mkdir(parents=True); (lib / "generated").mkdir()
    (lib / "sightlines" / "cgm_sid488530_edge_b100_a090.npz").write_bytes(b"x")
    (lib / "generated" / "rand_b010_a020_s7.npz").write_bytes(b"x")
    monkeypatch.setenv("TNG_LIBRARY_DIR", str(lib)); monkeypatch.delenv("TNG_SIGHTLINES_DIR", raising=False)
    assert P.sightlines_dir() == lib / "sightlines"
    assert P.find_sightline("edge_b100_a090").parent.name == "sightlines"
    assert P.find_sightline("cgm_sid488530_rand_b010_a020_s7.npz").parent.name == "generated"
    assert [P.gid_of(f) for f in P.library_files()] == ["edge_b100_a090", "rand_b010_a020_s7"]
    with pytest.raises(FileNotFoundError):
        P.find_sightline("face_b001_a001")
    monkeypatch.setenv("TNG_LEGACY_OUT", str(tmp_path / "out"))
    assert P.out_dir() == tmp_path / "out" and (tmp_path / "out").is_dir()


@need_lib
def test_publication_figure_and_intrinsic_frame(tmp_path):
    import make_publication_figure as MPF
    import cgm_style as CS
    d = MPF.load_sightline(GIDS[0])
    fig, geom = MPF.build_figure(d, show_intrinsic=True, vwin=300.0)
    assert len(fig.axes) == 12 and geom["orientation"] == "edge-on"
    # grey intrinsic curve = exp(-tau) on c(λ/λ0-1) + v_sys
    line = [l for l in fig.axes[0].lines if l.get_color() == "0.45"][0]
    lam = np.asarray(d["OVI_lambda"], float); rest = float(d["OVI_rest"]); vs = float(d["v_sys"])
    v = TC.C_KMS * (lam / rest - 1) + vs
    np.testing.assert_allclose(line.get_xdata(), v[(v >= -300) & (v <= 300)])
    CS.FIGDIR = tmp_path
    assert CS.save(fig, "t").is_file() and (tmp_path / "t.pdf").is_file()


@need_lib
def test_score_file_fields():
    import score_sightlines as S
    rec = S.score_file(str(_have(GIDS[3])))
    for k in ("showcase_score", "n_showcase_ions", "ovi_showcase", "OVI_n_comp", "CIII_min_flux"):
        assert k in rec
    assert rec["geom_id"] == GIDS[3]


class FakeGen:
    """Stands in for tngsight.generate.Generator: replays a stored npz as the payload."""
    def __init__(self, src):
        self.src, self.calls = src, []

    def generate(self, geom, progress=None):
        self.calls.append(geom)
        pl = TL.load_npz(self.src)
        pl["id"] = geom["id"]
        return pl


@need_lib
def test_gen_cli_writes_generated_dir(tmp_path, monkeypatch):
    import pandas as pd
    import gen_cgm_sightlines as GC
    monkeypatch.setenv("TNG_LIBRARY_DIR", str(tmp_path / "lib"))
    monkeypatch.setenv("TNG_SIGHTLINES_DIR", str(_have(GIDS[0]).parent))
    monkeypatch.setenv("TNG_LEGACY_OUT", str(tmp_path / "out"))
    gen = FakeGen(_have(GIDS[0]))
    grid = [dict(orientation="edge-on", b_kpc=100, azimuth_deg=90),          # exists -> skipped
            dict(orientation="random", b_kpc=101, azimuth_deg=7, seed=5)]
    rows = GC.generate(grid, gen=gen, skip_existing=True)
    assert [c["id"] for c in gen.calls] == ["rand_b101_a007_s5"]
    out = tmp_path / "lib" / "generated" / "rand_b101_a007_s5.npz"
    a, b = np.load(out), np.load(_have(GIDS[0]))
    assert a.files == b.files and all(np.array_equal(a[k], b[k]) for k in b.files)
    GC.append_index(rows)
    assert pd.read_csv(tmp_path / "out" / "grid_index.csv").geom_id.tolist() == ["rand_b101_a007_s5"]


def test_pyodide_bundle_recreates_tngsight(tmp_path):
    import build_delivery_wasm as B
    files = B.pyfiles()
    assert "_tngsight_bundle.py" in files and "tngsight/" not in "".join(files)   # flat names only
    for n, src in files.items():
        (tmp_path / n).write_text(src)
    code = ("import sys; sys.path.insert(0, '.'); import cgm_style, degrade, make_publication_figure; "
            "import tngsight, os; assert os.path.dirname(tngsight.__file__) == os.path.abspath('tngsight'); "
            "print(degrade.DLAMBDA, degrade.VSYS_SIGN)")
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    r = subprocess.run([sys.executable, "-I", "-c", code], cwd=tmp_path, env=env,
                       capture_output=True, text=True, timeout=900)
    assert r.returncode == 0, r.stderr[-2000:]
    assert r.stdout.split() == ["0.002", "1"]


def test_no_cluster_paths_in_tng50():
    bad = ("/data/sborthak", "/home/tsingh65", "/scratch/tsingh65")
    root = HERE.parent
    hits = [str(f) for f in root.rglob("*") if f.is_file() and f.suffix in (".py", ".md", ".json", ".txt", ".html")
            and any(b in f.read_text(errors="ignore") for b in bad)]
    me = str(Path(__file__))
    assert [h for h in hits if h != me] == []
    gal = json.loads((root / "galaxy_488530.json").read_text())
    assert "cutout_hdf5" not in gal and "ion_table" not in gal
