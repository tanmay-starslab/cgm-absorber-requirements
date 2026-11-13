"""Tests for the galaxy-sample pipeline (tngsight.galpipe, tngsight.galaxy, config galaxy selection).

Fast tests need no data. Tests marked slow read the published MW/M31 cutouts ($TNG_MWM31_ROOT, else
<work root>/data/mwm31) and the shipped 488530 library ($TNG_WORK/data/library_v3r); they run only with
TNG_RUN_SLOW=1 and skip when the data are absent. Temp files go to $TNG_TEST_TMP when set (else tmp_path)."""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from tngsight import config, galaxy as GX, galpipe as GP, geometry as G

ROOT = Path(__file__).resolve().parents[1]
PACKAGED = json.loads((ROOT / "tngsight" / "galaxy_488530.json").read_text())
LIB_V3R = config.work_root() / "data" / "library_v3r"
slow = pytest.mark.skipif(os.environ.get("TNG_RUN_SLOW") != "1", reason="set TNG_RUN_SLOW=1 for real-data tests")
need_src = pytest.mark.skipif(not GX.source_cutout(488530).is_file(), reason="MW/M31 cutouts not available")
need_lib = pytest.mark.skipif(not (LIB_V3R / "catalog.json").is_file(), reason="library_v3r not available")


def _tmp(tmp_path):
    t = os.environ.get("TNG_TEST_TMP")
    if t:
        p = Path(t) / f"galpipe_{os.getpid()}"
        p.mkdir(parents=True, exist_ok=True)
        return p
    return tmp_path


def fake_record(gid=111, **over):
    r = {k: PACKAGED[k] for k in ("sim", "snapshot", "redshift", "central", "TNG_H", "box_ckpch", "C_KMS",
                                  "CM_PER_KPC", "disk_frame_source")}
    lh = np.array([0.0, 0.0, 1.0]); xh = np.array([1.0, 0.0, 0.0])
    r.update(subhalo_id=gid, center_ckpch=[1000.0, 2000.0, 3000.0],
             center_kpc=(np.array([1000.0, 2000.0, 3000.0]) / PACKAGED["TNG_H"]).tolist(), R200c_kpc=300.0,
             M200c_Msun=2e12, Mstar_Msun=6e10, SFR_Msun_yr=2.0, SubhaloVel_kms=[10.0, -20.0, 30.0],
             Lhat=lh.tolist(), xhat=xh.tolist(), yhat=np.cross(lh, xh).tolist(), label=f"Subhalo {gid}")
    r.update(over)
    return r


# ------------------------------------------------------------------------------------------ config: 488530 default
def test_default_galaxy_is_the_packaged_record():
    if os.environ.get("TNG_GALAXY_JSON") or os.environ.get("TNG_GALAXY"):
        pytest.skip("a galaxy is selected in the environment")
    assert config.GALAXY == PACKAGED
    assert config.NPZ_PREFIX == "cgm_sid488530_"
    assert np.array_equal(G.CENTER_KPC, np.array(PACKAGED["center_kpc"]))
    assert G.R200C == PACKAGED["R200c_kpc"]


def test_default_cutout_path_unchanged(monkeypatch):
    monkeypatch.delenv("TNG_CUTOUT", raising=False)
    monkeypatch.setenv("TNG_WORK", "/w")
    assert config.cutout_path() == Path("/w/data/cutout_slim_R400_sub488530.hdf5")


def test_record_paths(monkeypatch):
    monkeypatch.delenv("TNG_GALAXY_JSON", raising=False)
    monkeypatch.delenv("TNG_GALAXY", raising=False)
    monkeypatch.setenv("TNG_GAL_ROOT", "/g")
    assert config.galaxy_record_path() == config.PACKAGED_GALAXY
    assert config.galaxy_record_path(488530) == config.PACKAGED_GALAXY
    assert config.galaxy_record_path(12345) == Path("/g/12345/galaxy.json")
    monkeypatch.setenv("TNG_GALAXY", "12345")
    assert config.galaxy_record_path() == Path("/g/12345/galaxy.json")
    with pytest.raises(FileNotFoundError):
        config.load_galaxy(999999999)


def test_env_selects_galaxy_in_a_fresh_process(tmp_path):
    d = _tmp(tmp_path)
    rec = fake_record(4242)
    p = d / "galaxy.json"
    p.write_text(json.dumps(rec))
    code = ("import json; from tngsight import config, geometry as G; "
            "print(json.dumps([config.GALAXY['subhalo_id'], config.NPZ_PREFIX, G.CENTER_KPC.tolist(), G.R200C, "
            "str(config.cutout_path())]))")
    env = {**os.environ, "TNG_GALAXY_JSON": str(p), "TNG_GAL_ROOT": str(d)}
    env.pop("TNG_CUTOUT", None)
    out = json.loads(subprocess.check_output([sys.executable, "-c", code], env=env, cwd=str(ROOT)).decode())
    assert out[0] == 4242 and out[1] == "cgm_sid4242_"
    assert np.allclose(out[2], rec["center_kpc"]) and out[3] == 300.0
    assert out[4] == str(d / "4242" / "cutout_slim_R400.hdf5")


def test_use_galaxy_switches_in_place_and_back():
    from tngsight import library as Lb
    centre_ref = G.CENTER_KPC                      # library holds this very object
    try:
        config.use_galaxy(fake_record(77))
        assert config.GALAXY["subhalo_id"] == 77 and config.NPZ_PREFIX == "cgm_sid77_"
        assert Lb.CENTER_KPC is centre_ref and np.allclose(Lb.CENTER_KPC, fake_record(77)["center_kpc"])
        assert G.R200C == 300.0
        sl = G.make_sightline("face-on", 50.0, 0.0)
        assert np.allclose(sl["n_los"], [0, 0, 1]) and sl["half_kpc"] == 300.0
        assert math.isclose(sl["v_sys_kms"], 30.0)
    finally:
        config.use_galaxy(PACKAGED)
    assert config.GALAXY == PACKAGED and config.NPZ_PREFIX == "cgm_sid488530_"
    assert np.array_equal(G.CENTER_KPC, np.array(PACKAGED["center_kpc"])) and G.R200C == PACKAGED["R200c_kpc"]


# ------------------------------------------------------------------------------------------ rays
def test_ray_list_and_ids():
    rays = GP.ray_list()
    assert len(rays) == 683 and len({r["id"] for r in rays}) == 683
    for r in rays:
        assert G.geom_id(r["orientation"], r["b_kpc"], r["azimuth_deg"], seed=r["seed"]) == r["id"]
        assert (r["los_seed"] is not None) == (r["orientation"] == "random")
        assert r["seed"] is None or r["seed"] == r["los_seed"]
    assert sum(r["orientation"] == "random" and r["seed"] is None for r in rays) == 40


def test_ray_half_length():
    for r in GP.ray_list():                       # 488530: every ray keeps ±R200c (byte-compatible geometry)
        assert GP.ray_half_kpc(r["b_kpc"], PACKAGED["R200c_kpc"]) == PACKAGED["R200c_kpc"]
    for b in (0.0, 50.0, 250.0):                  # a big halo: endpoints stay inside the complete slim sphere
        h = GP.ray_half_kpc(b, 420.0)
        assert h <= 420.0 and math.hypot(b, h) <= GP.R_RAY_MAX_KPC + 1e-9


def test_shards_partition_the_rays():
    ids = [r["id"] for r in GP.ray_list()]
    parts = []
    for i in range(7):
        a, n = GP.parse_shard(f"{i}/7")
        parts += ids[a::n]
    assert sorted(parts) == sorted(ids)
    with pytest.raises(ValueError):
        GP.parse_shard("7/7")
    assert GP.parse_shard(None) == (0, 1)


@need_lib
def test_ray_geometry_reproduces_the_library():
    """In the packaged 488530 frame the pipeline's geometry equals the stored geom of the shipped npz."""
    import random
    rays = GP.ray_list()
    seedless = [r for r in rays if r["orientation"] == "random" and r["seed"] is None][:4]
    for r in random.Random(1).sample(rays, 12) + seedless:
        sub = "generated" if r["source"] == "generated" else "sightlines"
        with np.load(LIB_V3R / sub / f"{r['id']}.npz", allow_pickle=False) as d:
            ref = json.loads(str(d["geom"]))
        geo = GP.ray_geometry(r, PACKAGED["R200c_kpc"])
        for k in ("start_ckpch", "end_ckpch", "n_los"):
            assert np.allclose(geo[k], ref[k], rtol=0, atol=1e-9), (r["id"], k)
        assert abs(geo["v_sys_kms"] - ref["v_sys_kms"]) < 1e-9


# ------------------------------------------------------------------------------------------ record helpers
def test_cold_gas_frame_recovers_a_rotating_disk():
    rng = np.random.default_rng(3)
    n = 5000
    L_true = np.array([0.3, -0.5, 0.81]); L_true /= np.linalg.norm(L_true)
    e1 = np.cross(L_true, [1.0, 0, 0]); e1 /= np.linalg.norm(e1); e2 = np.cross(L_true, e1)
    R = rng.uniform(1, 15, n); phi = rng.uniform(0, 2 * np.pi, n)
    pos = (R * np.cos(phi))[:, None] * e1 * 1.6 + (R * np.sin(phi))[:, None] * e2 + rng.normal(0, 0.2, (n, 1)) * L_true
    vel = 200 * (-np.sin(phi)[:, None] * e1 + np.cos(phi)[:, None] * e2) + np.array([50.0, -10, 5])
    m = np.ones(n); rho = np.full(n, 1e-23); T = np.full(n, 1e4); xH = np.full(n, 0.76)
    fr = GP.cold_gas_frame(pos, vel, m, rho, T, xH, r200c=250.0)
    assert fr["tracer"] == "cold_gas" and fr["aperture_kpc"] == 25.0
    L = np.array(fr["Lhat"]); x = np.array(fr["xhat"]); y = np.array(fr["yhat"])
    assert np.degrees(np.arccos(L @ L_true)) < 0.5
    assert abs(L @ x) < 1e-12 and abs(L @ y) < 1e-12 and abs(abs(x @ e1) - 1) < 1e-3   # major axis = e1 (1.6x)
    assert np.allclose(np.cross(L, x), y)
    assert GP.v_phi(pos, vel - fr["vcenter_kms"], m, L) > 150


def test_adopt_reference():
    rec = fake_record(GP_ID := 488530, Lhat=PACKAGED["Lhat"], xhat=PACKAGED["xhat"], yhat=PACKAGED["yhat"])
    rec["center_kpc"] = (np.array(PACKAGED["center_kpc"]) + [0.03, 0, 0]).tolist()
    GP.adopt_reference(rec)
    assert rec["subhalo_id"] == GP_ID
    for k in GP.ADOPT_KEYS:
        assert rec[k] == PACKAGED[k]
    assert abs(rec["recomputed"]["deviation_from_shipped"]["center_kpc"] - 0.03) < 1e-6
    other = fake_record(5)
    assert GP.adopt_reference(dict(other)) == other


def test_public_record_has_no_private_fields():
    rec = fake_record(9, source={"relpath": "x", "sha256": "0" * 64}, checks={"a": 1}, catalogue={"SFR_50Myr": 1.0})
    pub = GP.public_record(rec)
    assert "source" not in pub and "checks" not in pub and pub["catalogue"] == {"SFR_50Myr": 1.0}
    assert pub["subhalo_id"] == 9 and pub["Lhat"] == rec["Lhat"]


def test_mw_m31_split():
    assert GX.mw_m31_flags({"StellarMass_30kpc": 10 ** 10.7}) == (True, False)
    assert GX.mw_m31_flags({"StellarMass_30kpc": 10 ** 11.0}) == (False, True)


def test_stage_skips_when_done(tmp_path):
    root = _tmp(tmp_path)
    g = GP.Galaxy(321, root)
    g.dir.mkdir(parents=True, exist_ok=True)
    g.done("web").write_text("{}")
    assert GP.main(["web", "--galaxy", "321", "--root", str(root)]) == 0      # skipped: no record needed


_SMALL = config.gal_root() / "517899"          # 22 MB slim cutout, < 64^3 gas cells: one yt chunk


@pytest.mark.skipif(not (_SMALL / GP.SLIM_NAME).is_file(), reason="small-galaxy slim cutout not available")
def test_single_chunk_slim_index(tmp_path):
    """yt keeps the Morton index of a single-chunk dataset in memory and writes no .ewah (run2: 517899, 571454,
    576516 failed slim); build_index writes a marker instead and the later stages accept it."""
    import shutil
    g = GP.Galaxy(517899, tmp_path)
    g.dir.mkdir(parents=True)
    shutil.copyfile(_SMALL / "galaxy.json", g.record)
    os.symlink(_SMALL / GP.SLIM_NAME, g.slim)
    GP.build_index(g)
    assert not g.index.exists() and g.index_none.is_file() and g.index_ready()
    assert json.loads(g.index_none.read_text())["data_files"] == 1


# ------------------------------------------------------------------------------------------ real data (slow)
@slow
@need_src
def test_record_reproduces_the_488530_frame(tmp_path):
    root = _tmp(tmp_path)
    assert GP.main(["record", "--galaxy", "488530", "--root", str(root), "--force"]) == 0
    rec = json.loads((root / "488530" / "galaxy.json").read_text())
    dev = rec["recomputed"]["deviation_from_shipped"]
    assert max(dev["Lhat_deg"], dev["xhat_deg"], dev["yhat_deg"]) < 1.0
    assert dev["center_kpc"] < 0.1
    assert dev["SubhaloVel_kms"] < 1.0
    for k in GP.ADOPT_KEYS:                       # the default galaxy keeps the shipped geometry
        assert rec[k] == PACKAGED[k]
    assert rec["checks"]["cold_vphi_kms"] > 0 and rec["checks"]["slim_sphere_complete"]
    assert rec["source"]["sha256"] and "/" not in rec["source"]["relpath"][:1]


# ------------------------------------------------------------------------------------------ fix3
def _disk(n=5000, vphi=200.0, voff=(0.0, 0.0, 0.0), seed=3, L=(0.3, -0.5, 0.81)):
    rng = np.random.default_rng(seed)
    L_true = np.asarray(L, float); L_true /= np.linalg.norm(L_true)
    e1 = np.cross(L_true, [1.0, 0, 0]); e1 /= np.linalg.norm(e1); e2 = np.cross(L_true, e1)
    R = rng.uniform(1, 15, n); phi = rng.uniform(0, 2 * np.pi, n)
    pos = (R * np.cos(phi))[:, None] * e1 * 1.6 + (R * np.sin(phi))[:, None] * e2 + rng.normal(0, 0.2, (n, 1)) * L_true
    vel = vphi * (-np.sin(phi)[:, None] * e1 + np.cos(phi)[:, None] * e2) + np.asarray(voff, float)
    return pos, vel, L_true


def _gas(pos, vel):
    n = len(pos)
    return pos, vel, np.ones(n), np.full(n, 1e-23), np.full(n, 1e4), np.full(n, 0.76)


def test_cold_frame_falls_back_to_stars_when_unreliable():
    """validate2_1 / fix3 (c): the stellar frame replaces the cold-gas frame when the cold gas is sparse (511920: 717
    cells), offset from SubhaloVel (541218: 132 km/s) or barely rotating (546114: 46 km/s); a massive disk with an
    offset (487742: 125522 cells) and a clean disk keep the cold-gas frame; the label names the recipe used."""
    spos, svel, L_star = _disk(4000, vphi=180.0, seed=9, L=(0.0, 0.0, 1.0))
    stars = {"pos_kpc": spos, "vel_kms": svel, "mass_msun": np.ones(len(spos))}
    vref = np.zeros(3)
    ok = GP.cold_gas_frame(*_gas(*_disk(5000)[:2]), r200c=250.0, stars=stars, v_ref=vref)
    assert ok["tracer"] == "cold_gas" and not ok["fallback_reasons"] and ok["n_cold"] == 5000
    assert GP.disk_frame_label(ok).startswith("cold-gas angular momentum")
    cases = {"few": _disk(700)[:2], "offset": _disk(5000, voff=(150.0, 0, 0))[:2], "slow": _disk(5000, vphi=30.0)[:2]}
    for name, (p, v) in cases.items():
        fr = GP.cold_gas_frame(*_gas(p, v), r200c=250.0, stars=stars, v_ref=vref)
        assert fr["tracer"] == "stars" and fr["fallback_reasons"], name
        assert np.degrees(np.arccos(abs(np.dot(fr["Lhat"], L_star)))) < 1.0, name
        lab = GP.disk_frame_label(fr)
        assert lab.startswith("stellar angular momentum") and "cold-gas frame unreliable" in lab, name
    big = GP.cold_gas_frame(*_gas(*_disk(25000, voff=(150.0, 0, 0))[:2]), r200c=250.0, stars=stars, v_ref=vref)
    assert big["tracer"] == "cold_gas" and big["cold_dv_kms"] > 100
    # without stars the cold frame is kept, with its warnings recorded
    nost = GP.cold_gas_frame(*_gas(*cases["offset"]), r200c=250.0, v_ref=vref)
    assert nost["tracer"] == "cold_gas" and nost["cold_frame_warnings"]
    assert GP.cold_frame_reliability(208978, 33.0, 239.0) == []                     # 488530


def test_gas_poor_flag():
    assert GX.gas_poor({"frame": {"tracer": "cold_gas", "n_cold": 208978}}) is False
    assert GX.gas_poor({"frame": {"tracer": "stars", "n_cold": 224}}) is True
    assert GX.gas_poor({"frame": {"tracer": "stars"}}) is True                        # old record: stars = < 200 cold
    assert GX.gas_poor({"frame": {"tracer": "cold_gas"}}) is False and GX.gas_poor({}) is None


def test_spectra_source_survives_a_deleted_library(tmp_path):
    """review2 M3: an SBI galaxy whose library/ was deleted for a reselect stays SBI (galpipe and the launcher)."""
    sys.path.insert(0, str(ROOT / "deploy" / "hpc"))
    import hpclib as H
    g = GP.Galaxy(111, tmp_path)
    g.dir.mkdir(parents=True)
    (g.dir / "galaxy.json").write_text(json.dumps(fake_record(111)))
    g.mark("rays", 0.0, info={"source": "sbi_cgm", "n_rays": 700})
    assert GP.spectra_source(g) == "sbi" and H.spectra_source(tmp_path, 111) == "sbi"
    g.mark("rays", 0.0, info={"n_rays": 683})                                        # a Trident galaxy's marker
    assert GP.spectra_source(g) == "trident" and H.spectra_source(tmp_path, 111) == "trident"
    g.mark("import_sbi", 0.0)
    assert GP.spectra_source(g) == "sbi" and H.spectra_source(tmp_path, 111) == "sbi"
    GP.mark_spectra(g, "trident")
    assert GP.spectra_source(g) == "trident" and H.spectra_source(tmp_path, 111) == "trident"
    assert H.pending_stages(tmp_path, 111, 4, redo=["import_sbi"]).get("rays_shard") is not None
    GP.mark_spectra(g, "sbi")
    p = H.pending_stages(tmp_path, 111, 4, redo=["import_sbi"])
    assert "import_sbi" in p and "rays_shard" not in p                                # no Trident trace planned
    # a forced import that would silently do nothing is an error
    r = subprocess.run([sys.executable, "-m", "tngsight.galpipe", "import_sbi", "--galaxy", "111", "--root", str(tmp_path),
                        "--force", "--spectra", "trident"], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode != 0 and "silent no-op" in (r.stdout + r.stderr)


def test_clean_stale_tmp(tmp_path):
    g = GP.Galaxy(111, tmp_path)
    (g.lib / "sightlines").mkdir(parents=True)
    old = g.lib / "sightlines" / ".face_b000_a001_s1.ab12.tmp.npz"
    new = g.lib / "sightlines" / ".face_b000_a002_s2.cd34.tmp.npz"
    keep = g.lib / "sightlines" / "face_b000_a001_s1.npz"
    for f in (old, new, keep):
        f.write_bytes(b"x")
    os.utime(old, (1e9, 1e9))
    assert GP.clean_stale_tmp(g) == 1 and not old.exists() and new.exists() and keep.exists()
    assert GP.clean_stale_tmp(g, min_age_s=0) == 1 and not new.exists() and keep.exists()


def _row(level, sid, ion, ref, cube, tol=0.05):
    return {"level": level, "sid": sid, "ion": ion, "ref": ref, "cube4": cube, "d": None, "tol": tol}


def test_grade_column_checks_floor_and_l0_edge():
    """fix3 (a): 571454 (an L2 segment of empty gas: cube 10^10.74 vs smoothed 10^2.4) and 372754 (L0 at the cold-disk
    edge, +0.5..+1.15 dex, finer levels agree) pass; a real misplacement still fails."""
    base = [_row("L1", "a", "OVI", 14.0, 14.01), _row("L2", "a", "OVI", 14.2, 14.2)]
    g = GP.grade_column_checks({"rows": base + [_row("L2", "b", "CIII", 2.385, 10.74)]})
    assert g["hard_pass"] and g["n_below_diff_floor"] == 1
    edge = [_row("L1", "e", "HI", 12.619, 12.619), _row("L1", "e", "CII", None, None),
            _row("L0", "e", "HI", 13.515, 14.669), _row("L0", "e", "CII", 10.383, 11.356)]
    g = GP.grade_column_checks({"rows": base + edge})
    assert g["hard_pass"] and g["n_l0_edge"] == 2, g
    # L0 gross without a consistent finer level, or beyond 1.5 dex, or a gross finer level: fail
    assert not GP.grade_column_checks({"rows": base + [_row("L0", "z", "HI", 13.0, 14.0)]})["hard_pass"]
    assert not GP.grade_column_checks({"rows": base + [_row("L1", "e", "HI", 12.6, 12.6),
                                                       _row("L0", "e", "HI", 13.0, 14.8)]})["hard_pass"]
    assert not GP.grade_column_checks({"rows": base + [_row("L1", "m", "CIV", 13.5, 14.5)]})["hard_pass"]
    assert not GP.grade_column_checks({"rows": base + [_row("L2", "m", "OVI", 14.0, None)]})["hard_pass"]   # empty cube
    assert not GP.grade_column_checks({"rows": []})["hard_pass"]


def test_cube_gate_snapshot(tmp_path):
    """review2_robust L3: after the float viz_cache is deleted a check regrades from logs/cube_gates.json (same
    manifest), or bootstraps from the previous check.json when the cubes were not rebuilt since."""
    g = GP.Galaxy(111, tmp_path)
    g.viz.mkdir(parents=True); g.logs.mkdir(parents=True)
    (g.viz / "manifest_v2.json").write_text("{}")
    assert GP.cube_gate_snapshot(g) is None
    g.mark("cubes", 0.0)
    os.utime(g.done("cubes"), (1e9, 1e9))
    (g.dir / "check.json").write_text(json.dumps({"gates": {"cube_conservation": {"pass": True},
                                                            "HI_le_nH": {"pass": True, "max_ratio": {"L0": 0.99}}}}))
    snap = GP.cube_gate_snapshot(g)
    assert snap["from"] == "check.json" and snap["gates"]["HI_le_nH"]["max_ratio"] == {"L0": 0.99}
    GP.dump_json(g.logs / "cube_gates.json", {"manifest_sha256": GP._manifest_sha(g), "gates": {"HI_le_nH": {"max_ratio": {"L0": 0.5}}}})
    assert GP.cube_gate_snapshot(g)["gates"]["HI_le_nH"]["max_ratio"] == {"L0": 0.5}
    (g.viz / "manifest_v2.json").write_text('{"changed": 1}')                       # cubes rebuilt: no reuse
    assert GP.cube_gate_snapshot(g) is None


def test_pool_run_children_start_single_threaded(monkeypatch):
    """run3: spawned fit workers import numpy before the pool initializer runs, so they must inherit
    OPENBLAS/OMP_NUM_THREADS=1 from the parent at spawn time (16 x 16 threads per task drained 40 nodes);
    the parent's own setting is restored afterwards."""
    import functools
    monkeypatch.setenv("OPENBLAS_NUM_THREADS", "16")
    monkeypatch.setenv("OMP_NUM_THREADS", "16")
    out = []
    GP._pool_run(functools.partial(os.getenv, "OPENBLAS_NUM_THREADS"), [0, 1], 2, os.getpid, (), out.append)
    assert out == ["1", "1"]
    assert os.environ["OPENBLAS_NUM_THREADS"] == "16" and os.environ["OMP_NUM_THREADS"] == "16"


def test_archive_unselected_moves_previous_selection(tmp_path):
    """validate3 F1: a forced reselection (re-recorded frame) must not leave old-frame rays in library/."""
    root = _tmp(tmp_path)
    g = GP.Galaxy(654, root)
    for sub, ext in GP.LIB_RAY_FILES:
        (g.lib / sub).mkdir(parents=True, exist_ok=True)
        for sid in ("new_a", "new_b", "old_c"):
            (g.lib / sub / f"{sid}{ext}").write_text("x")
        (g.lib / sub / f".tmp_partial{ext}").write_text("x")       # temp files are left to clean_stale_tmp
    assert GP.archive_unselected(g, {"new_a", "new_b"}) == 3
    for sub, ext in GP.LIB_RAY_FILES:
        assert sorted(p.name for p in (g.lib / sub).iterdir()) == sorted([f".tmp_partial{ext}", f"new_a{ext}",
                                                                          f"new_b{ext}"])
        assert (g.logs / "unselected" / sub / f"old_c{ext}").is_file()
    assert GP.archive_unselected(g, {"new_a", "new_b"}) == 0
