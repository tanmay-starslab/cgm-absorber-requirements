"""Galaxy registry (galaxies/*.json, tests/schemas/galaxy.schema.json) and physics definitions (tngsight/definitions.json).

Runs without SOL data: the committed records, the definitions file and a small synthetic cutout built here.
"""
import copy
import json
import math
from pathlib import Path

import numpy as np
import pytest

from tngsight import definitions as D
from tngsight import registry as R

ROOT = Path(__file__).resolve().parents[1]
GAL = ROOT / "galaxies"
RECS = sorted(GAL.glob("*.json"))
PACKAGED = json.loads((ROOT / "tngsight" / "galaxy_488530.json").read_text())
SATELLITE, GAS_POOR = 372755, 613192           # a FoF satellite (host 372754) and the gas-free S0


def rec(sid):
    return json.loads((GAL / f"tng50-1-099-{sid}.json").read_text())


# ------------------------------------------------------------------------------------------- definitions
def test_definitions_load_and_consistent():
    d = D.load()
    assert D.validate(d) == []
    assert d["bins"]["logT_edges"] == [4.5, 5.0, 5.5, 6.0]
    assert d["bins"]["r_edges_R200c"] == [0.1, 0.15, 0.3, 1.0, 2.0]
    assert d["citations"]["ps20"]["arxiv"] == "2006.14322"
    assert d["virial"]["T200"]["mu"] == 0.59
    three = {c["id"]: c for c in d["phases"]["schemes"]["three"]["classes"]}
    assert three["cool"]["logT_max"] == 4.5 and three["hot"]["logT_min"] == 5.5
    assert d["regions"]["cgm"]["r_min_R200c"] == 0.15 and d["regions"]["cgm"]["r_max_R200c"] == 1.0


@pytest.mark.parametrize("breakit, msg", [
    (lambda d: d["bins"]["logT_edges"].reverse(), "strictly increasing"),
    (lambda d: d["bins"]["r_edges_R200c"].remove(0.3), "lacks 0.3"),
    (lambda d: d["toggles"][0].update(default="nope"), "not in options"),
    (lambda d: d["phases"]["schemes"]["three"]["classes"][0].update(logT_max=4.4), "not a bin edge"),
    (lambda d: d["citations"]["ps20"].update(arxiv="1909.05603"), "2006.14322"),
    (lambda d: d["texts"].update(x="a · b"), "owner style"),
])
def test_definitions_validate_catches(breakit, msg):
    d = copy.deepcopy(json.loads(D.PATH.read_text()))
    breakit(d)
    assert any(msg in e for e in D.validate(d))


# ---------------------------------------------------------------------------------------------- records
def test_all_records_present_and_valid():
    assert len(RECS) == 221, "galaxies/ must hold the 221 records (198 TNG50-1 + 23 FIRE-2)"
    tng_recs = [p for p in RECS if p.name.startswith("tng50-1-099-")]
    fire2_recs = [p for p in RECS if p.name.startswith("fire2-600-")]
    assert len(tng_recs) == 198 and len(fire2_recs) == 23
    sch = R.load_schema()
    bad = {p.name: e for p in RECS if (e := R.schema_errors(sch, json.loads(p.read_text())))}
    assert not bad, list(bad.items())[:3]
    total = sum(p.stat().st_size for p in RECS)
    assert max(p.stat().st_size for p in RECS) < 8000 and total < 2_500_000


def test_fire2_records_present_and_complete():
    fire2_recs = {p.stem.split("-", 2)[-1]: json.loads(p.read_text()) for p in RECS if p.name.startswith("fire2-600-")}
    assert set(fire2_recs) == set(R.FIRE2_IDS)
    for hid, r in fire2_recs.items():
        assert r["schema"] == "galaxy/1"
        assert r["slug"] == f"fire2-600-{hid}"
        assert r["sim"] == "FIRE-2" and r["snap"] == 600
        assert r["subhalo_id"] == hid and r["central"] is True and r["host_subhalo_id"] == hid
        assert r["sat_gas_frac"] == 0.0
        assert r["provenance"]["citations"] == ["hopkins18", "wetzel23"]
        cgm = r["masses_Msun"]["cgm"]
        assert cgm["total"] == pytest.approx(cgm["cool"] + cgm["warm"] + cgm["hot"], rel=1e-5)
        assert R.load(hid)["slug"] == r["slug"]
        assert R.load(r["slug"])["subhalo_id"] == hid


def test_records_self_consistent():
    for p in RECS:
        r = json.loads(p.read_text())
        assert p.stem == r["slug"] == R.slug(r["sim"], r["snap"], r["subhalo_id"])
        Rm = np.array(r["frame"]["R"])
        assert np.allclose(Rm @ Rm.T, np.eye(3), atol=1e-5) and np.linalg.det(Rm) > 0.9999
        so = r["so"]
        assert so["R200c"]["R_kpc"] < so["Rvir_BN"]["R_kpc"] < so["R200m"]["R_kpc"]
        assert math.isclose(r["T200_K"], R.t200(so["R200c"]["M_Msun"], so["R200c"]["R_kpc"]), rel_tol=1e-5)
        assert r["central"] == r["catalogue"]["FlagCentral"] == (r["host_subhalo_id"] == r["subhalo_id"])
        assert r["misalignment_deg"]["tng_cutout"] == pytest.approx(R.fold(r["misalignment_deg"]["tng_cutout_raw"]), abs=1e-4)


def test_centrals_match_catalogue():
    """R200c about the galaxy reproduces the catalogue for centrals within 0.1 %; M*, SFR from the bound particles."""
    for p in RECS:
        r = json.loads(p.read_text())
        c = r["catalogue"]
        if r["central"]:
            assert abs(r["so"]["R200c"]["R_kpc"] / c["R200c_kpc"] - 1) < 1e-3, r["slug"]
        assert abs(r["Mstar_Msun"] / c["Mstar_all_Msun"] - 1) < 0.01, r["slug"]
        assert abs(r["Mstar_30kpc_Msun"] / c["Mstar_30kpc_Msun"] - 1) < 0.01, r["slug"]
        assert abs(r["SFR_Msun_yr"] - c["SFR_inst_Msun_yr"]) <= 0.01 * c["SFR_inst_Msun_yr"] + 1e-6, r["slug"]


def test_satellites_recomputed_about_galaxy():
    """The catalogue R200c of the 8 FoF satellites is the host group's. Ours is about the galaxy (smaller); where the
    FoF central is in the sample (host_of: same group M200c, R200c) its own record reproduces the catalogue value."""
    recs = {r["subhalo_id"]: r for r in (json.loads(p.read_text()) for p in RECS)}
    sats = [r for r in recs.values() if not r["central"]]
    assert len(sats) == 8
    known = 0
    for r in sats:
        assert r["flags"]["fof_satellite"] and r["host_subhalo_id"] != r["subhalo_id"]
        assert r["so"]["R200c"]["R_kpc"] < r["catalogue"]["R200c_kpc"]
        assert r["flags"]["host_unknown"] == (r["host_subhalo_id"] is None)
        if r["host_subhalo_id"] is not None:
            known += 1
            h = recs[r["host_subhalo_id"]]
            assert h["central"] and abs(h["so"]["R200c"]["R_kpc"] / r["catalogue"]["R200c_kpc"] - 1) < 1e-3
    assert known == 4


# --------------------------------------------------------------------------------- hand-checked galaxies
# Numbers checked by hand against the catalogue and the formula T200 = mu m_p G M / (2 k R), mu = 0.59.
HAND = {
    488530: {"R200c": (246.387, 2e-4), "M200c": 1.5953e12},
    SATELLITE: {"R200c": None, "host": 372754},
    GAS_POOR: {"R200c": None},
}


@pytest.mark.parametrize("sid", sorted(HAND))
def test_hand_checked(sid):
    r = rec(sid)
    h = HAND[sid]
    R2, M2 = r["so"]["R200c"]["R_kpc"], r["so"]["R200c"]["M_Msun"]
    # M200c = 200 rho_c 4/3 pi R^3, rho_c = 3 H0^2 / 8 pi G = 277.5 h^2 Msun/kpc^3 ... (h = 0.6774)
    rho_c = 277.5366 * 0.6774 ** 2
    assert M2 == pytest.approx(200 * rho_c * 4 / 3 * math.pi * R2 ** 3, rel=1e-3)
    # T200 by hand: 0.59 * 1.6726e-24 * 6.674e-8 * M[g] / (2 * 1.3806e-16 * R[cm])
    assert r["T200_K"] == pytest.approx(0.59 * 1.6726e-24 * 6.674e-8 * M2 * 1.989e33 / (2 * 1.3806e-16 * R2 * 3.0857e21), rel=2e-3)
    if h.get("R200c"):
        assert R2 == pytest.approx(h["R200c"][0], rel=h["R200c"][1])
        assert M2 == pytest.approx(h["M200c"], rel=1e-3)
    if h.get("host"):
        assert r["host_subhalo_id"] == h["host"] and not r["central"]
    # the frame is right-handed and z is the stellar spin: R maps the spin to +z (stars counter-clockwise from +z)
    Rm = np.array(r["frame"]["R"])
    assert np.allclose(np.cross(Rm[0], Rm[1]), Rm[2], atol=1e-5)


def test_gas_poor_galaxy():
    r = rec(GAS_POOR)
    assert r["flags"]["few_sf_cells"] and r["misalignment_deg"]["sf_gas"] is None
    assert r["SFR_Msun_yr"] < 0.05


def test_488530_reproduces_explorer():
    """The registry agrees with the shipped galaxy_488530.json where the definitions agree."""
    r = rec(488530)
    P = PACKAGED
    assert np.linalg.norm(np.subtract(r["pos_kpc"], P["center_kpc"])) < 0.1          # recomputed centre, 0.07 kpc
    assert np.linalg.norm(np.subtract(r["vel_kms"], P["SubhaloVel_kms"])) < 0.5
    assert r["so"]["R200c"]["R_kpc"] == pytest.approx(P["R200c_kpc"], rel=1e-4)
    assert r["so"]["R200c"]["M_Msun"] == pytest.approx(P["M200c_Msun"], rel=1e-4)
    assert r["Mstar_Msun"] == pytest.approx(P["Mstar_Msun"], rel=1e-3)
    assert r["SFR_Msun_yr"] == pytest.approx(P["SFR_Msun_yr"], rel=1e-3)
    # frame: the stellar spin is 4.7 deg from the shipped cold-gas spin (D8: 4.6), and the angle is stored
    z = np.array(r["frame"]["R"])[2]
    a = math.degrees(math.acos(float(np.dot(z, P["Lhat"]))))
    assert 3.5 < a < 6.0
    assert r["misalignment_deg"]["cold_gas"] == pytest.approx(a, abs=0.5)
    assert r["misalignment_deg"]["tng_cutout_raw"] > 170                                 # D8: cutout +z is 177 deg away


# ------------------------------------------------------------------------------------------- unit pieces
def test_stellar_frame_sign():
    """A disk spinning counter-clockwise about an arbitrary axis n: z = +n, and Lz > 0 in the frame."""
    rng = np.random.default_rng(1)
    n = R.unit([0.3, -0.5, 0.8])
    e1 = R.unit(np.cross(n, [1, 0, 0])); e2 = np.cross(n, e1)
    phi = rng.uniform(0, 2 * np.pi, 4000); rad = rng.uniform(1, 10, 4000)
    a, b = 3.0, 1.0                                     # elongated along e1: x = +-e1
    pos = (a * rad * np.cos(phi))[:, None] * e1 + (b * rad * np.sin(phi))[:, None] * e2
    vel = 200 * (-np.sin(phi)[:, None] * e1 + np.cos(phi)[:, None] * e2)   # counter-clockwise about n
    fr = R.stellar_frame(pos, vel + 50, np.ones(4000), np.array([50.0, 50, 50]))
    Rm = fr["R"]
    assert np.dot(Rm[2], n) > 0.9999
    assert abs(np.dot(Rm[0], e1)) > 0.999
    d, v = pos @ Rm.T, vel @ Rm.T
    assert np.mean(d[:, 0] * v[:, 1] - d[:, 1] * v[:, 0]) > 0


def test_so_radius_isothermal():
    """Uniform-mass shells with M(<r) = r: R where M/(4/3 pi R^3) = rho, i.e. R = sqrt(3 / (4 pi rho))."""
    r = (np.arange(200000) + 0.5) / 200000 * 100.0
    m = np.full(r.size, 100.0 / r.size)
    rho = 3e-3
    Rso, M, ex = R.so_radius(r, m, rho)
    assert not ex and Rso == pytest.approx(math.sqrt(3 / (4 * math.pi * rho)), rel=1e-4)
    # beyond the complete sphere: the power law M ~ r is extrapolated exactly
    Rx, _, ex = R.so_radius(r, m, rho, r_complete=6.0)
    assert ex and Rx == pytest.approx(Rso, rel=1e-3)


def test_delta_bn():
    assert R.delta_bn(1.0) == pytest.approx(18 * math.pi ** 2)
    assert R.delta_bn(0.3089) == pytest.approx(102.0, abs=0.5)


def test_schema_errors_twin():
    sch = R.load_schema()
    r = rec(488530)
    assert R.schema_errors(sch, r) == []
    bad = copy.deepcopy(r)
    bad["frame"]["R"] = bad["frame"]["R"][:2]
    bad["extra"] = 1
    del bad["T200_K"]
    e = R.schema_errors(sch, bad)
    assert any("fewer than 3" in x for x in e) and any("unknown key extra" in x for x in e) and any("missing T200_K" in x for x in e)


def _synthetic_cutout(path, sid=7, host=None):
    """A tiny TNG-like cutout: isothermal DM (M(<r) linear), a rotating stellar disk about n, hot gas."""
    import h5py
    h = 0.6774
    rng = np.random.default_rng(2)
    c = np.array([1000.0, 2000.0, 3000.0])
    nd = 60000
    rdm = (np.arange(nd) + 0.5) / nd * 400 * h
    u = rng.normal(size=(nd, 3))
    u /= np.linalg.norm(u, axis=1)[:, None]
    n = R.unit([0.0, 0.6, -0.8]); e1 = R.unit(np.cross(n, [1, 0, 0])); e2 = np.cross(n, e1)
    ns = 6000
    phi = rng.uniform(0, 2 * np.pi, ns); rad = rng.exponential(3.0, ns) * h
    xs = (rad * np.cos(phi))[:, None] * e1 + (rad * np.sin(phi))[:, None] * e2 + rng.normal(0, 0.3, ns)[:, None] * n
    vs = 200 * (-np.sin(phi)[:, None] * e1 + np.cos(phi)[:, None] * e2)
    ng = 20000
    rg = rng.uniform(1, 380, ng) * h
    ug = rng.normal(size=(ng, 3)); ug /= np.linalg.norm(ug, axis=1)[:, None]
    with h5py.File(path, "w") as f:
        f.create_group("Header").attrs.update(dict(HubbleParam=h, BoxSize=35000.0, Omega0=0.3089, SubfindID_This_Snapshot=sid,
                                                    MassTable=np.array([0, 3e-3, 0, 0, 0, 0])))
        g1 = f.create_group("PartType1")
        g1["Coordinates"] = c + rdm[:, None] * u
        g1["Velocities"] = np.zeros((nd, 3), "f4")
        g1["SubfindID"] = np.full(nd, sid)
        g1["Potential"] = rdm.astype("f4")
        g4 = f.create_group("PartType4")
        g4["Coordinates"] = c + xs
        g4["RotatedCoordinates"] = xs @ np.array([e1, e2, -n]).T          # unsigned cutout frame (flipped)
        g4["Velocities"] = vs.astype("f4")
        g4["Masses"] = np.full(ns, 1e-3)
        g4["SubfindID"] = np.full(ns, sid)
        g4["GFM_StellarFormationTime"] = np.full(ns, 0.5)
        g4["Potential"] = (np.linalg.norm(xs, axis=1) + 0.01).astype("f4")
        g0 = f.create_group("PartType0")
        g0["Coordinates"] = c + rg[:, None] * ug
        g0["Velocities"] = np.zeros((ng, 3), "f4")
        g0["Masses"] = np.full(ng, 1e-4)
        g0["SubfindID"] = np.where(np.arange(ng) % 10 == 0, sid + 1, sid)        # 10 % satellite gas
        g0["StarFormationRate"] = np.zeros(ng, "f4")
        g0["GFM_Metals"] = np.tile([0.76] + [0.0] * 9, (ng, 1)).astype("f4")
        g0["InternalEnergy"] = np.full(ng, 2.0e5, "f4")                           # ~ 10^6.5 K
        g0["ElectronAbundance"] = np.full(ng, 1.16, "f4")
        g0["Density"] = np.full(ng, 1e-8, "f4")
        g0["Potential"] = rg.astype("f4")
    return n


def test_measure_synthetic(tmp_path):
    p = tmp_path / "snap_99.hdf5"
    n = _synthetic_cutout(p)
    row = dict(HaloVirialRadius_R200c=1.0, HaloMass_M200c=1.0, StellarMass_30kpc=1.0, StellarMass_all=1.0,
               StellarMass_2rh=1.0, SFR_inst=0.0, SFR_50Myr=0.0, FlagCentral=1)
    body = R.measure(p, 7, row)
    rec_ = R._round(R.record(body, p))
    assert R.schema_errors(R.load_schema(), rec_) == []
    Rm = np.array(body["frame"]["R"])
    assert np.dot(Rm[2], n) > 0.999                                  # signed spin, counter-clockwise from +z
    assert body["misalignment_deg"]["tng_cutout_raw"] > 179 and body["misalignment_deg"]["tng_cutout"] < 1
    assert body["tng_cutout_handedness"] == -1                       # rows e1, e2, -n: a reflection
    assert body["sat_gas_frac"] == pytest.approx(0.1, abs=0.01)
    assert body["masses_Msun"]["cgm"]["hot"] > 0 and body["masses_Msun"]["cgm"]["cool"] == 0
    assert body["flags"]["no_sf_gas"] and body["central"]
    assert body["T200_K"] == pytest.approx(R.t200(body["so"]["R200c"]["M_Msun"], body["so"]["R200c"]["R_kpc"]))
