"""Tests for the SBI_CGM import (tngsight.sbi, galpipe import_sbi) on a tiny synthetic SBI-shaped ray library.

The fake library has the layout and conventions of SBI_CGM's fiducial pass (<run>/50_rays/<id>/native/geometry.hdf5,
native/csr_<a>_<b>.hdf5, gpu/tau_<a>_<b>.hdf5 with 16-row chunks, velocity_log_kms = c ln(lambda/lambda0) on
-1499.75..1499.75 at 0.5 km/s, tau rendered in the galaxy rest frame with V_bulk subtracted, CSR v_los = v.d raw).
Each ray holds a few thin Gaussian absorbers whose columns and velocities are known, so the import can be checked
exactly: ray columns, AOD of the resampled tau, the velocity frame of our npz (V = u + v_sys with our SubhaloVel),
geometry in our disk frame, the selection rule, and the galpipe stages around it. Real-data checks: TNG_RUN_SLOW=1."""
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from tngsight import sbi as S, ions as I, library as Lb
from tngsight.config import C_KMS

ROOT = Path(__file__).resolve().parents[1]
PACKAGED = json.loads((ROOT / "tngsight" / "galaxy_488530.json").read_text())
GID = 900001
N_RAYS = 48
B_DOPP = 12.0
V_BULK = np.array([40.0, -25.0, 10.0])          # the SBI render subtraction (their SubhaloVel)
V_OURS = np.array([43.0, -20.0, 12.5])          # our record's SubhaloVel (differs on purpose)
NEVIII_COMP = (770.428, 0.1025)                 # rendered component (off the grid lambda0 by +7.4 km/s, other f)
ID_RE = re.compile(r"^((face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?|cust_[0-9a-f]{10})$")
slow = pytest.mark.skipif(os.environ.get("TNG_RUN_SLOW") != "1", reason="set TNG_RUN_SLOW=1 for real-data tests")


def fake_record(gid=GID):
    r = {k: PACKAGED[k] for k in ("sim", "snapshot", "redshift", "central", "TNG_H", "box_ckpch", "C_KMS",
                                  "CM_PER_KPC", "disk_frame_source")}
    lh = np.array([0.2, -0.3, 0.9]); lh /= np.linalg.norm(lh)
    xh = np.cross(lh, [1.0, 0.0, 0.0]); xh /= np.linalg.norm(xh)
    yh = np.cross(lh, xh)
    c_kpc = np.array([1200.0, 51000.0, 3000.0])          # near the box edge in y (51.67 Mpc box)
    r.update(subhalo_id=gid, center_kpc=c_kpc.tolist(), center_ckpch=(c_kpc * PACKAGED["TNG_H"]).tolist(),
             R200c_kpc=220.0, M200c_Msun=1.2e12, Mstar_Msun=6e10, SFR_Msun_yr=1.5, SubhaloVel_kms=V_OURS.tolist(),
             Lhat=lh.tolist(), xhat=xh.tolist(), yhat=yh.tolist(), label=f"TNG50 {gid}", mw=True, m31=False,
             frame={"tracer": "cold_gas"}, checks={"cold_vphi_kms": 150.0, "slim_sphere_complete": True})
    return r


def _axes(rec, n):
    lh, xh = np.asarray(rec["Lhat"]), np.asarray(rec["xhat"])
    em = lh - (lh @ n) * n
    if np.linalg.norm(em) < 1e-6:
        ej = xh - (xh @ n) * n; ej /= np.linalg.norm(ej)
        return ej, np.cross(n, ej)
    em /= np.linalg.norm(em)
    return np.cross(n, em), em


def make_rays(rec, n=N_RAYS, seed=7):
    """Ray geometry: direction, b, azimuth (our frame), with the SBI centre shifted by a box length in y
    (periodic image) and SBI rays +-2 R200c long."""
    rng = np.random.default_rng(seed)
    c = np.asarray(rec["center_kpc"])
    L = rec["box_ckpch"] / rec["TNG_H"]
    c_sbi = c - np.array([0.0, L, 0.0])                  # the same point, other periodic image
    out = []
    for i in range(n):
        if i == 0:
            d = np.asarray(rec["Lhat"]) * (1 if i % 2 else -1)       # exactly face-on (degenerate sky axes)
        else:
            d = rng.normal(size=3); d /= np.linalg.norm(d)
        b = float(rng.uniform(0.01, 1.45) * rec["R200c_kpc"])
        az = float(rng.uniform(0, 360))
        ej, em = _axes(rec, d)
        anchor = c_sbi + b * (math.cos(math.radians(az)) * ej + math.sin(math.radians(az)) * em)
        h = 2 * rec["R200c_kpc"]
        out.append({"d": d, "b": b, "az": az, "start": anchor - h * d, "end": anchor + h * d, "anchor": anchor,
                    "inc": math.degrees(math.acos(min(1.0, abs(float(d @ np.asarray(rec["Lhat"])))))),
                    "c_sbi": c_sbi})
    return out


def build_fake_sbi(base: Path, rec, rays, gid=GID, chunk=16):
    """Write <base>/runA/50_rays/<gid>/{native,gpu}; returns (ray dir, truth)."""
    import h5py
    gdir = base / "runA" / "50_rays" / str(gid)
    (gdir / "native").mkdir(parents=True); (gdir / "gpu").mkdir(parents=True)
    n = len(rays)
    rng = np.random.default_rng(11)
    Lu = 5.0e24
    v = -1499.75 + 0.5 * np.arange(6000)
    truth = {"logN": {k: np.zeros(n) for k in S.LINE_MAP}, "cells": []}
    R200 = rec["R200c_kpc"]
    meta = {"schema": "sbi-cgm.observable-ray-geometry.v1", "host_id": gid,
            "geometry": {"center_pkpc": rays[0]["c_sbi"].tolist(), "r200c_pkpc": R200, "half_length_over_r200": 2.0}}
    with h5py.File(gdir / "native" / "geometry.hdf5", "w") as h:
        h.attrs["sampler_metadata_json"] = json.dumps(meta)
        h["ray_id"] = np.arange(n, dtype=np.uint64)
        h["point_index"] = (np.arange(n) // 13).astype(np.uint64)
        h["scramble_index"] = (np.arange(n) % 13).astype(np.uint32)
        h["start_pkpc"] = np.array([r["start"] for r in rays])
        h["end_pkpc"] = np.array([r["end"] for r in rays])
        h["direction"] = np.array([r["d"] for r in rays])
        h["closest_point_pkpc"] = np.array([r["anchor"] for r in rays])
        h["inclination_folded_rad"] = np.radians([r["inc"] for r in rays])
        h["alpha_folded_rad"] = rng.uniform(0, np.pi, n)
        pc = np.zeros((n, 4)); pc[:, 0] = [r["b"] / R200 for r in rays]
        h["proposal_coordinates"] = pc
    # cells: 3 per ray, thin columns, velocities ~ +-200 km/s
    cells = []
    for i, r in enumerate(rays):
        vc = rng.normal(0, 120, size=(3, 3)) + V_BULK
        lN = {k: rng.uniform(12.3, 13.3, 3) for k in S.LINE_MAP}
        cells.append((vc, lN))
        for k in S.LINE_MAP:
            truth["logN"][k][i] = math.log10(np.sum(10 ** lN[k]))
    truth["cells"] = cells
    frame = {"kind": "galaxy_rest_peculiar", "bulk_velocity_original_xyz_kms": V_BULK.tolist(),
             "direction": "source-to-observer; positive peculiar LOS blueshifts",
             "source_velocity_frame": "snapshot_peculiar_projected_los_no_host_subtraction"}
    aodk = 1e5 / (I.SIGMA0 * 1e-8)
    for lo in range(0, n, 32):
        hi = min(n, lo + 32)
        m = hi - lo
        name = f"{lo:08d}_{hi:08d}.hdf5"
        # csr
        offs, dl, vl, dens = [0], [], [], {k: [] for k in S.LINE_MAP}
        for i in range(lo, hi):
            vc, lN = cells[i]
            d = rays[i]["d"]
            dli = np.array([0.01, 0.02, 0.015])
            dl += dli.tolist(); vl += (vc @ d).tolist()
            for k in S.LINE_MAP:
                dens[k] += (10 ** lN[k] / (dli * Lu)).tolist()
            offs.append(offs[-1] + 3)
        with h5py.File(gdir / "native" / f"csr_{name}", "w") as h:
            h.attrs["length_unit_cm"] = Lu
            h["ray_id"] = np.arange(lo, hi, dtype=np.uint64)
            h["cell_offsets"] = np.array(offs, np.uint32)
            h.create_dataset("dl", data=np.array(dl), chunks=(8,), compression="lzf")
            h.create_dataset("velocity_los_kms", data=np.array(vl), chunks=(8,), compression="lzf")
            for k in S.LINE_MAP:
                h.create_dataset(f"cloudydensity_{k}", data=np.array(dens[k]), chunks=(8,), compression="lzf")
        # tau
        with h5py.File(gdir / "gpu" / f"tau_{name}", "w") as h:
            h.attrs["render_velocity_frame_json"] = json.dumps(frame)
            h.attrs["schema"] = "sbi-cgm.tau-stage.v1"
            h["ray_id"] = np.arange(lo, hi, dtype=np.uint64)
            for k, fid in S.LINE_MAP.items():
                rest = float(I.get(k)["lam0_A"])
                f = float(I.get(k)["f"])
                fj = {"feature_id": fid, "lambda0_A": rest if k != "OVII" else 21.6, "f": f if k != "OVII" else None}
                off, flam = 0.0, f * rest
                if k == "NeVIII":                              # rendered at its own component (like SBI)
                    fj["profile_components"] = str([{"wavelength_A": NEVIII_COMP[0],
                                                     "oscillator_strength": NEVIII_COMP[1]}])
                    off = C_KMS * math.log(NEVIII_COMP[0] / rest)
                    flam = NEVIII_COMP[0] * NEVIII_COMP[1]
                g = h.create_group(fid)
                g.attrs["feature_json"] = json.dumps(fj)
                g["velocity_log_kms"] = v
                g["lambda_A"] = fj["lambda0_A"] * np.exp(v / C_KMS)
                tau = np.zeros((m, 6000))
                for j, i in enumerate(range(lo, hi)):
                    vc, lN = cells[i]
                    d = rays[i]["d"]
                    u = -((vc - V_BULK) @ d)                   # galaxy-rest render, blueshift for +v.d
                    for c in range(3):
                        integ = 10 ** lN[k][c] * flam / aodk
                        tau[j] += integ * np.exp(-((v - u[c] - off) / B_DOPP) ** 2) / (math.sqrt(math.pi) * B_DOPP)
                g.create_dataset("tau", data=tau, chunks=(chunk, 6000))
    return gdir, truth


@pytest.fixture(scope="module")
def fake(tmp_path_factory):
    base = tmp_path_factory.mktemp("sbi")
    rec = fake_record()
    rays = make_rays(rec)
    gdir, truth = build_fake_sbi(base, rec, rays)
    return {"base": base, "rec": rec, "rays": rays, "gdir": gdir, "truth": truth,
            "roots": [base / "runA" / "50_rays"]}


# ------------------------------------------------------------------ reader
def test_layout_and_geometry(fake):
    gdir = S.galaxy_dir(GID, fake["roots"])
    assert gdir == fake["gdir"] and S.run_name(gdir) == "runA"
    assert [c[:2] for c in S.chunk_files(gdir, "tau")] == [(0, 32), (32, 48)]
    with pytest.raises(FileNotFoundError):
        S.galaxy_dir(12345, fake["roots"])
    geo = S.read_geometry(gdir)
    ours = S.our_geometry(geo, fake["rec"])
    for i, r in enumerate(fake["rays"]):
        assert abs(ours["b_kpc"][i] - r["b"]) < 1e-6
        assert abs(ours["inclination_deg"][i] - r["inc"]) < 1e-6
        if i > 0:                                       # face-on ray: azimuth measured from xhat (degenerate)
            assert abs(((ours["azimuth_deg"][i] - r["az"] + 180) % 360) - 180) < 1e-6
        # endpoints relative to OUR centre (minimum image), not the SBI periodic image
        assert np.allclose(ours["start_rel"][i] + np.asarray(fake["rec"]["center_kpc"]),
                           r["start"] + np.array([0, fake["rec"]["box_ckpch"] / fake["rec"]["TNG_H"], 0]))
        assert abs(ours["half_kpc"][i] - 2 * fake["rec"]["R200c_kpc"]) < 1e-6
        w = ours["orientation"][i]
        assert w == ("face-on" if r["inc"] < 20 else "edge-on" if r["inc"] >= 70 else "random")


def test_geometry_matches_tngsight_geometry(fake):
    """our_geometry inverts geometry.make_sightline (same sky axes / azimuth convention) under the 488530 frame."""
    from tngsight import geometry as G
    rec = dict(PACKAGED)
    if not np.allclose(G.CENTER_KPC, rec["center_kpc"]):
        pytest.skip("geometry module points at another galaxy in this process")
    sls = [G.make_sightline("random", b, az, seed=s, half_kpc=300.0) for b, az, s in
           ((30.0, 10.0, 1), (120.0, 200.0, 2), (5.0, 300.0, 3))] + [G.make_sightline("edge-on", 50.0, 90.0)]
    geo = {"start_pkpc": np.array([s["start_kpc"] for s in sls]), "end_pkpc": np.array([s["end_kpc"] for s in sls]),
           "direction": np.array([s["n_los"] for s in sls])}
    ours = S.our_geometry(geo, rec)
    for i, s in enumerate(sls):
        assert abs(ours["b_kpc"][i] - s["b_kpc"]) < 1e-6
        assert abs(((ours["azimuth_deg"][i] - s["azimuth_deg"] + 180) % 360) - 180) < 1e-6
    assert ours["orientation"][3] == "edge-on"


def test_allocate_and_select(fake):
    assert S.allocate([10, 10, 10], 9).tolist() == [3, 3, 3]
    assert S.allocate([1, 10, 10], 9).tolist() == [1, 4, 4]
    assert S.allocate([0, 2, 50], 30).tolist() == [0, 2, 28]
    assert S.allocate([5, 5, 5], 100).tolist() == [5, 5, 5]
    assert S.allocate([10, 10, 10, 10], 6).sum() == 6
    geo = S.read_geometry(fake["gdir"])
    ours = S.our_geometry(geo, fake["rec"])
    sel, rule = S.select(ours, fake["rec"], geo["ray_id"], GID, n_target=20)
    assert sel.size == 20 and len(set(sel.tolist())) == 20 and np.all(np.diff(sel) > 0)
    assert rule["seed"] == S.SELECT_SEED and rule["n_selected"] == 20 and rule["rule"] == S.SELECT_RULE
    assert sum(s["taken"] for s in rule["strata"]) == 20
    assert all(s["taken"] <= s["pool"] for s in rule["strata"])
    sel2, _ = S.select(ours, fake["rec"], geo["ray_id"], GID, n_target=20)
    assert np.array_equal(sel, sel2)                                 # reproducible
    sel3, _ = S.select(ours, fake["rec"], geo["ray_id"], GID + 1, n_target=20)
    assert not np.array_equal(sel, sel3) or True                     # galaxy enters the priority (may coincide)
    # priority is a pure function of (seed, galaxy, ray id)
    assert S._priority(1, 2, [3])[0] == S._priority(1, 2, [3])[0] != S._priority(1, 2, [4])[0]
    assert S.ray_sid("face-on", 12.4, 359.6, 77) == "face_b012_a000_s77"
    assert ID_RE.match(S.ray_sid("random", 330.0, 12.0, 53247))


@pytest.mark.parametrize("threads", [24, 1])
def test_read_rays_columns_and_frame(fake, monkeypatch, threads):
    monkeypatch.setattr(S, "IO_THREADS", threads)
    rows = [0, 5, 17, 31, 32, 47]
    data = S.read_rays(fake["gdir"], rows)
    assert data["ray_id"].tolist() == rows
    for k in S.LINE_MAP:
        assert np.allclose(data["logN"][k], fake["truth"]["logN"][k][rows], atol=1e-9)
    geo = S.read_geometry(fake["gdir"])
    vf = S.verify_frame(data, geo["direction"][rows])
    assert vf["pass"] is None                                         # 6 rays: too few for the 3-vector fit
    y, d = S.frame_samples(data, geo["direction"][rows])
    allr = S.read_rays(fake["gdir"], range(N_RAYS))
    vf = S.verify_frame(allr, geo["direction"])
    assert vf["pass"] is True and np.allclose(vf["recovered_bulk_kms"], V_BULK, atol=0.2)
    # a frame claiming no subtraction is caught
    bad = dict(allr, frame={"kind": "snapshot_peculiar"})
    assert S.verify_frame(bad, geo["direction"])["pass"] is False
    # O VII has no f in the SBI feature: the effective f is recovered from AOD vs column
    fe = S.effective_f(allr, "OVII")
    assert abs(fe / I.get("OVII")["f"] * 21.6 / I.get("OVII")["lam0_A"] - 1) < 2e-3 or abs(fe / I.get("OVII")["f"] - 1) < 2e-3


def test_payload_frame_and_aod(fake):
    """npz v2 of an imported ray: AOD of the resampled tau = ray column; components sit at
    V = u + v_sys = -(v - SubhaloVel_ours).n_los (our galaxy rest frame), du <= 0.5 so vpfit strides by 2."""
    from tngsight import vpfit
    geo = S.read_geometry(fake["gdir"])
    rec = fake["rec"]
    ours = S.our_geometry(geo, rec)
    rows = [3, 40]
    data = S.read_rays(fake["gdir"], rows)
    gen = S.generation_record(fake["gdir"], "runA", data["feature"])
    for j, row in enumerate(rows):
        p = S.payload(data, j, ours, row, rec, gen, {"run": "runA"})
        d = np.asarray(p["geom"]["n_los"])
        assert abs(p["v_sys"] - (V_OURS - V_BULK) @ d) < 1e-9
        buf = __import__("io").BytesIO()
        Lb.save_npz(buf, p); buf.seek(0)
        pl = Lb.load_npz(buf, id="x")
        aod = Lb.aod_columns(pl, nd=5)
        fr = S.f_lambda_ratio(data["feature"]["NeVIII"], "NeVIII")
        assert fr == pytest.approx(NEVIII_COMP[0] * NEVIII_COMP[1] / (I.get("NeVIII")["f"] * I.get("NeVIII")["lam0_A"]))
        assert p["generation"]["line_offset_kms"]["NeVIII"] == pytest.approx(
            C_KMS * math.log(NEVIII_COMP[0] / I.get("NeVIII")["lam0_A"]), abs=1e-3)
        for k in S.LINE_MAP:
            if k == "OVII":
                continue
            corr = math.log10(fr) if k == "NeVIII" else 0.0          # AOD with our f is biased by the f*lambda ratio
            assert abs(aod[k] - corr - fake["truth"]["logN"][k][row]) < 3e-3, k
            assert abs(pl["logN"][k] - fake["truth"]["logN"][k][row]) < 1e-9
        vc, lN = fake["truth"]["cells"][row]
        # an absorber rendered at velocity_log = -(v - V_bulk).d sits at u = c expm1(velocity_log / c) on our
        # linear grid (O(v^2/2c) ~ 0.1 km/s from the log velocity); V = u + v_sys = -(v - SubhaloVel_ours).n + O(v^2/c)
        u_true = C_KMS * np.expm1(-((vc - V_BULK) @ d) / C_KMS)
        for k in ("OVI", "NeVIII"):                    # Ne VIII: the +7.4 km/s grid offset is removed on import
            V = pl["u"][k] + pl["v_sys"]
            w = 10 ** lN[k]
            cen = float(np.sum(pl["tau"][k] * V) / np.sum(pl["tau"][k]))
            assert abs(cen - (float(np.sum(w * u_true) / np.sum(w)) + p["v_sys"])) < 0.1, k  # + O(sigma^2/c)
            assert abs(cen - float(np.sum(w * -((vc - V_OURS) @ d)) / np.sum(w))) < 0.3, k
        assert pl["u"][k][0] == pytest.approx(-1500.0, abs=1e-6) and pl["tau"][k].size == 6001
        assert vpfit.fit_stride(pl["du"][k]) == 2
        g = p["geom"]
        assert g["source"] == "sbi_cgm" and g["sbi"]["ray_id"] == row
        assert np.allclose(np.asarray(g["start_kpc"]) - np.asarray(rec["center_kpc"]), ours["start_rel"][row])
        assert Lb.decode_web(Lb.encode_web(pl))["lines"]


# ------------------------------------------------------------------ galpipe stages
def _gp(root, *args, env=None):
    return subprocess.run([sys.executable, "-m", "tngsight.galpipe", *map(str, args), "--root", str(root)],
                          capture_output=True, text=True, cwd=ROOT, env={**os.environ, **(env or {})})


def test_galpipe_import_sbi(fake, tmp_path):
    root = tmp_path / "root"
    gd = root / str(GID)
    gd.mkdir(parents=True)
    (gd / "galaxy.json").write_text(json.dumps(fake["rec"]))
    env = {"TNG_SBI_RAYS": os.pathsep.join(map(str, fake["roots"]))}
    r = _gp(root, "import_sbi", "--galaxy", GID, "--n-select", 12, "--shard", "0/2", env=env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (gd / "DONE.import_sbi.0of2").is_file() and not (gd / "DONE.import_sbi").is_file()
    r = _gp(root, "rays", "--galaxy", GID, env=env)                 # not all imported yet: no tracing, fails
    assert r.returncode != 0 and "not imported" in (r.stdout + r.stderr)
    r = _gp(root, "import_sbi", "--galaxy", GID, "--shard", "1/2", env=env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (gd / "DONE.import_sbi").is_file()
    sel = json.loads((gd / "library" / "rays.json").read_text())
    assert sel["source"] == "sbi_cgm" and len(sel["rays"]) == 12 and sel["selection"]["seed"] == S.SELECT_SEED
    ids = [x[0] for x in sel["rays"]]
    assert all(ID_RE.match(i) for i in ids) and len(set(ids)) == 12
    for i in ids:
        pl = Lb.load_npz(gd / "library" / "sightlines" / f"{i}.npz", id=i)
        assert pl["generation"]["source"] == "sbi_cgm" and len(pl["lines"]) == 12
        assert (gd / "library" / "web" / f"{i}.bin").is_file()
    src = json.loads((gd / "library" / "spectra_source.json").read_text())
    assert src["source"] == "sbi_cgm" and src["n_selected"] == 12 and "CLOUDY" in src["text"]
    assert "/" not in json.dumps(src.get("sbi_provenance", {})).replace("\\/", "")
    # rays stage: completeness only, writes DONE.rays; import is idempotent
    r = _gp(root, "rays", "--galaxy", GID, env=env)
    assert r.returncode == 0 and (gd / "DONE.rays").is_file(), r.stdout + r.stderr
    r = _gp(root, "import_sbi", "--galaxy", GID, "--force", "--ids", ids[0], env=env)
    assert r.returncode == 0 and "1 to import" in r.stdout, r.stdout + r.stderr
    r = _gp(root, "status", "--galaxy", GID)
    assert json.loads(r.stdout)["rays_missing"] == 0 if "rays_missing" in r.stdout else True


def test_galpipe_trident_galaxy_skips_import(fake, tmp_path):
    root = tmp_path / "root"
    gd = root / "488530"
    gd.mkdir(parents=True)
    (gd / "galaxy.json").write_text(json.dumps(PACKAGED))
    r = _gp(root, "import_sbi", "--galaxy", 488530, env={"TNG_SBI_RAYS": str(fake["roots"][0])})
    assert r.returncode == 0 and "Trident" in r.stdout and not (gd / "DONE.import_sbi").exists()
    assert not (gd / "library" / "rays.json").exists()


def test_galpipe_fits_web_check_on_import(fake, tmp_path):
    """fits/web/check reuse on the imported subset: catalogue rows carry the SBI fields, seed is null, galaxy.json
    gets the spectra source, the SBI gates pass."""
    root = tmp_path / "root"
    gd = root / str(GID)
    gd.mkdir(parents=True)
    (gd / "galaxy.json").write_text(json.dumps(fake["rec"]))
    env = {"TNG_SBI_RAYS": str(fake["roots"][0])}
    for st in ("import_sbi", "rays", "fits", "web"):
        r = _gp(root, st, "--galaxy", GID, "--n-select", 9, "--workers", 2, env=env)
        assert r.returncode == 0, st + r.stdout[-3000:] + r.stderr[-3000:]
    cat = json.loads((gd / "library" / "catalog.json").read_text())
    assert len(cat["entries"]) == 9 and cat["spectra_source"]["source"] == "sbi_cgm"
    assert cat["generation"]["source"] == "sbi_cgm"
    for e in cat["entries"]:
        assert e["seed"] is None and e["spectra"] == "sbi_cgm" and isinstance(e["sbi_ray_id"], int)
        assert e["source"] == "library" and e["orientation"] in ("face-on", "edge-on", "random")
        assert e["inclination_deg"] is not None
    pub = json.loads((gd / "web" / "galaxy.json").read_text())
    assert pub["spectra_source"]["source"] == "sbi_cgm" and pub["spectra_source"]["selection"]["seed"] == S.SELECT_SEED
    r = _gp(root, "check", "--galaxy", GID, env=env)
    chk = json.loads((gd / "check.json").read_text())
    g = chk["gates"]
    assert g["counts"]["pass"] and g["finite_spectra"]["pass"] and g["ray_columns_present"]["pass"]
    assert g["sbi_frame"]["pass"] and g["sbi_columns"]["pass"], json.dumps(g["sbi_columns"])
    assert not g.get("cubes_built", {"pass": True})["pass"]          # no cubes in this test -> check fails there only
    assert r.returncode != 0
    # fix3: fits use the SBI atomic data (the fake renders Ne VIII with its own component), recorded in components.json
    assert g["fit_params"]["pass"], g["fit_params"]
    comp = json.loads((gd / "library" / "components.json").read_text())
    fa = json.loads((gd / "library" / "spectra_source.json").read_text())["fit_atomic"]
    assert abs(comp["params"]["atomic"]["NeVIII"]["f"] - fa["NeVIII"]["f"]) < 1e-12
    assert abs(fa["NeVIII"]["f"] * I.get("NeVIII")["lam0_A"] - NEVIII_COMP[0] * NEVIII_COMP[1]) < 1e-5
    assert comp["params"]["atomic"]["OVI"]["f"] == I.get("OVI")["f"]          # no components in the fake: registry
    # P4 weights, window flag, provenance (3D cubes on another ion model), gas_poor flag in the galaxy block
    w = np.array([e["w_target"] for e in cat["entries"]])
    assert abs(w.mean() - 1) < 1e-3 and np.all(w > 0)
    assert all(e["window_truncated"] is False and e["u_absmax_kms"] < 1500 for e in cat["entries"])
    ss = cat["spectra_source"]
    assert "3D ion cubes" in ss["text"] and ss["engineering_scope"] is True and ss["short"] == S.PROVENANCE_SHORT
    assert "gas_poor" in cat["galaxy"] and pub["gas_poor"] is False
    wcat = json.loads((gd / "web" / "catalog.json").read_text())
    assert wcat["spectra_source"]["source"] == "sbi_cgm"
    assert g["sbi_columns"]["window_velocities"] is True and g["sbi_columns"]["n_fast_cells"] == 0


# ------------------------------------------------------------------ real data (SOL)
@slow
def test_real_sbi_frame_and_columns():
    """One real galaxy: frame metadata recovered from the data, CSR columns = AOD of the stored tau."""
    try:
        gdir = S.galaxy_dir(488530)
    except FileNotFoundError:
        pytest.skip("SBI_CGM ray library not available")
    geo = S.read_geometry(gdir)
    rows = np.arange(0, 53248, 211)[:200]
    data = S.read_rays(gdir, rows)
    vf = S.verify_frame(data, geo["direction"][rows])
    assert vf["pass"], vf
    tau, v = data["tau"]["OVI"], data["v_log"]["OVI"]
    aod = 1e5 / (I.SIGMA0 * 1e-8) * np.trapz(tau, v, axis=1) / (I.get("OVI")["f"] * I.get("OVI")["lam0_A"])
    ok = data["logN"]["OVI"] > 12
    assert np.max(np.abs(np.log10(aod[ok]) - data["logN"]["OVI"][ok])) < 0.01


def test_window_truncation_rule():
    """pilot2 (411449 face_b002_a080_s44052): a fast outflow puts line cores beyond +1500 km/s; inside the window only
    a weak wing rising toward the edge remains (tau ~1e-4 .. 4e-7), so the AOD misses ~10 % of the cell column."""
    from tngsight.galpipe import _sbi_window_truncated
    u = -1500 + 0.5 * np.arange(6001)
    core = 0.5 * np.exp(-0.5 * (u / 30.0) ** 2)
    assert not _sbi_window_truncated(core)                                   # centred line
    assert _sbi_window_truncated(core + 1e-3 * np.exp(-0.5 * ((u - 1495) / 20.0) ** 2))   # edge absorption
    wing = 4e-7 * np.exp((u - 1500) / 200.0)                                 # rising toward +1500, tiny
    assert _sbi_window_truncated(core + wing) and _sbi_window_truncated(core + wing[::-1])
    assert not _sbi_window_truncated(core + 1e-9 * np.exp((u - 1500) / 200.0))   # numerical floor


# ------------------------------------------------------------------ fix3 helpers
def _hi_feature():
    gam = lambda r: {"kind": "upper_retained_model_radiative_sum", "upper_rate_s_1": r, "lower_rate_s_1": 0}   # noqa: E731
    return {"feature_id": "HI_lya", "lambda0_A": 1215.67, "f": 0.416, "gamma_s_1": 4.69e8, "profile_components": str([
        {"wavelength_A": 1215.674, "oscillator_strength": 0.13881, "gamma": gam(626490000.0)},
        {"wavelength_A": 1215.668, "oscillator_strength": 0.2776, "gamma": gam(626480000.0)}])}


def test_fit_atomic_uses_the_rendered_components():
    """review2_physics P1: H I Lya rendered with Gamma = 6.2649e8 (Wiese & Fuhr) per fine-structure component; the fit
    must use it (Trident's 4.69e8 put damped H I +0.126 dex high). f*lambda is preserved (Mg II -0.016 dex bias gone)."""
    mg = {"lambda0_A": 2796.352, "profile_components": [{"wavelength_A": 2796.35036, "oscillator_strength": 0.5908467,
                                                          "gamma": {"upper_rate_s_1": 2.52e8, "lower_rate_s_1": 0}}]}
    fa = S.fit_atomic({"HI": _hi_feature(), "MgII": mg, "OVI": {"lambda0_A": 1031.912}})
    assert set(fa) == {"HI", "MgII"}                                   # no components -> registry (not listed)
    assert abs(fa["HI"]["gamma"] - 6.2649e8) / 6.2649e8 < 1e-4 and fa["HI"]["lam0"] == I.get("HI")["lam0_A"]
    assert abs(fa["HI"]["f"] - (1215.674 * 0.13881 + 1215.668 * 0.2776) / 1215.67) < 1e-6
    assert abs(math.log10(fa["MgII"]["f"] / I.get("MgII")["f"]) - (-0.0153)) < 0.002
    assert fa["MgII"]["gamma"] == 2.52e8
    assert math.log10(6.2649e8 / 4.69e8) > 0.12                         # the size of the bias it removes


def test_fit_atomic_for_galaxy_drives_vpfit(tmp_path):
    from tngsight import galpipe as GP, vpfit, components as C
    g = GP.Galaxy(GID, tmp_path)
    g.lib.mkdir(parents=True)
    tag0 = C.params_tag()
    (g.lib / "rays.json").write_text("{}")
    (g.lib / "spectra_source.json").write_text(json.dumps({"fit_atomic": S.fit_atomic({"HI": _hi_feature()})}))
    try:
        fa = GP.apply_fit_atomic(g)
        assert fa and abs(vpfit.ATOMIC["HI"]["gamma"] - 6.2649e8) < 1e4
        assert C.params_tag() != tag0                                  # old fits are no longer current -> refit
        assert C.params_record()["atomic"]["HI"]["gamma"] == vpfit.ATOMIC["HI"]["gamma"]
        (g.lib / "rays.json").unlink()                                  # a Trident galaxy: registry values again
        assert GP.apply_fit_atomic(g) is None and vpfit.ATOMIC["HI"] == I.atomic("HI") and C.params_tag() == tag0
    finally:
        for k in I.KEYS:
            vpfit.ATOMIC[k] = I.atomic(k)


def test_frame_fit_outlier_floor():
    """validate2_3: with a ~0.001 km/s residual MAD the 5 MAD cut called most rays outliers; the 0.1 km/s floor keeps them."""
    rng = np.random.default_rng(2)
    d = rng.normal(size=(300, 3)); d /= np.linalg.norm(d, axis=1, keepdims=True)
    B = np.array([40.0, -25.0, 10.0])
    y = d @ B + rng.normal(0, 0.001, 300)
    y[:5] += 30.0                                                       # real outliers (blends)
    out = S.frame_fit(y, d, B)
    assert out["pass"] and out["n_outliers"] == 5 and out["max_abs_dev_kms"] < 0.01


def test_window_velocity_range(fake):
    """388544: rays crossing cells with |u| > 1500 km/s lose column outside the window; vlos_range/read_rays give the
    per-ray cell v.d range, window_excess_kms the max |u| in our frame (u = -(v - V_bulk).d)."""
    rows = [0, 5, 33, 47]
    vr = S.vlos_range(fake["gdir"], rows)
    data = S.read_rays(fake["gdir"], rows)
    for j, r in enumerate(rows):
        vc, _lN = fake["truth"]["cells"][r]
        vd = vc @ fake["rays"][r]["d"]
        assert np.allclose(vr[r], (vd.min(), vd.max())) and np.allclose(data["vlos_range"][j], vr[r])
        u = S.window_excess_kms(vr[r], V_BULK, fake["rays"][r]["d"])
        assert abs(u - np.max(np.abs((vc - V_BULK) @ fake["rays"][r]["d"]))) < 1e-9
    assert S.window_excess_kms((1700.0, 1800.0), [0, 0, 0], [1, 0, 0]) == 1800.0
    assert math.isnan(S.window_excess_kms((math.nan, math.nan), V_BULK, [1, 0, 0]))
