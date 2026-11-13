"""Galaxy-sample coordinator tests (server/galaxies.py + the galaxy-aware routes, queue and workers): ids and
records, geometry in another galaxy's frame, the LRU cutout cache (cap, pins, single flight, disk guard), the
"preparing" job state, per-galaxy storage and dedupe, remote workers with a galaxy directory, HFSync prefixes.
Network-free: a FakeFetcher stands in for the private HF dataset and server.testing.FakeGenerator for yt."""
import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
pytest.importorskip("sse_starlette")
from fastapi.testclient import TestClient  # noqa: E402

from server import galaxies as GX  # noqa: E402
from server.app import create_app  # noqa: E402
from server.jobs import DONE, ERROR, PREPARING, QUEUED, JobQueue, can_run, job_key  # noqa: E402
from server.settings import Settings  # noqa: E402
from server.storage import DOWNLOAD_IGNORE, HFSync, LibraryStore, npz_like  # noqa: E402
from server.testing import FakeGenerator  # noqa: E402
from server.workers import GalaxyGenerators, RemoteWorker  # noqa: E402
from tngsight import config as C  # noqa: E402
from tngsight import library as L  # noqa: E402
from tngsight.geometry import canonicalize, make_sightline  # noqa: E402

TOKEN = "s3cret-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
ROOT = Path(__file__).resolve().parents[1]
GID = "123456"
GID2 = "222222"
SCRATCH = Path(os.environ["TNG_TEST_TMP"]) if os.environ.get("TNG_TEST_TMP") else None
CUSTOM = {"p0_kpc": [5.0, -30.0, 10.0], "p1_kpc": [5.0, 30.0, 10.0]}
MB = 1024 * 1024


def fake_record(gid=GID, shift=(1000.0, -2000.0, 500.0)):
    """A valid record in another frame: centre moved, disk axes permuted (still orthonormal)."""
    g = C.GALAXY
    return {"sim": "TNG50-1", "snapshot": 99, "redshift": 0.0, "subhalo_id": int(gid), "central": True,
            "TNG_H": g["TNG_H"], "center_kpc": (np.asarray(g["center_kpc"]) + shift).tolist(),
            "R200c_kpc": 180.0, "M200c_Msun": 1e12, "Mstar_Msun": 5e10, "SFR_Msun_yr": 1.5,
            "SubhaloVel_kms": [10.0, 20.0, -30.0], "Lhat": g["xhat"], "xhat": g["yhat"], "yhat": g["Lhat"],
            "disk_frame_source": "test"}


@pytest.fixture
def root(tmp_path):
    d = (SCRATCH / uuid.uuid4().hex[:8]) if SCRATCH is not None else tmp_path / "r"
    d.mkdir(parents=True)
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def src(root):
    """The fake private dataset: gal/<id>/{galaxy.json, cutout_slim_R400.hdf5} for two galaxies."""
    s = root / "src"
    for gid, n in ((GID, 1), (GID2, 2)):
        d = s / "gal" / gid
        d.mkdir(parents=True)
        (d / GX.META_NAME).write_text(json.dumps(fake_record(gid)))
        (d / GX.CUTOUT_NAME).write_bytes(b"\0" * (n * MB))
    return s


class FakeFetcher:
    """HFFetcher interface over a local directory; `gate` holds cutout fetches, `fail` names failing files."""

    def __init__(self, src, gate=None, fail=()):
        self.src, self.gate, self.fail = Path(src), gate, set(fail)
        self.calls = []

    def size(self, gid, name):
        p = self.src / "gal" / gid / name
        return p.stat().st_size if p.is_file() else None

    def fetch(self, gid, name, dest):
        self.calls.append((gid, name))
        if name in self.fail:
            raise ConnectionError("fake network down")
        if name == GX.CUTOUT_NAME and self.gate is not None:
            assert self.gate.wait(30), "fetch gate never opened"
        p = self.src / "gal" / gid / name
        if not p.is_file():
            raise FileNotFoundError(name)
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, dest)


class RecordingGen(FakeGenerator):
    made = []

    def __init__(self, **kw):
        RecordingGen.made.append(dict(kw))
        super().__init__(**kw)


@pytest.fixture
def libdir(root):
    d = root / "lib"
    (d / "sightlines").mkdir(parents=True)
    gen, cat = FakeGenerator(), L.Catalog(d / "catalog.json")
    c = canonicalize("face-on", 50, 90)
    p = gen.generate(c)
    L.save_npz(d / "sightlines" / L.npz_name(c["id"]), npz_like(p))
    cat.upsert(L.catalog_entry(p, {"rank": 1, "showcase_score": 1.0, "ovi_showcase": True}, "library"))
    cat.save()
    return d


def settings(libdir, **over):
    kw = dict(library_dir=libdir, local_executor="thread", generator=FakeGenerator, worker_token=TOKEN,
              reap_every_s=0.05, lease_poll_s=2.0, heartbeat_s=1.0, node_name="test",
              cutout_cache_bytes=10 * MB, cutout_min_free_bytes=0)
    kw.update(over)
    return Settings(**kw)


def client(libdir, fetcher=None, gen=None, **over):
    s = settings(libdir, **over)
    return TestClient(create_app(s, generator=gen or s.generator, figure_renderer=lambda p, f, **k: b"\x89PNGfake",
                                 galaxy_fetcher=fetcher))


def wait_for(fn, timeout=30.0, every=0.02):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        v = fn()
        if v:
            return v
        time.sleep(every)
    raise AssertionError("condition not met in time")


def wait_job(c, jid, statuses=(DONE, ERROR), timeout=120.0):
    return wait_for(lambda: (lambda s: s if s["status"] in statuses else None)(c.get(f"/api/jobs/{jid}").json()),
                    timeout)


def warm(c):
    wait_for(lambda: c.get("/api/health").json()["warm"])


def sse(c, jid):
    with c.stream("GET", f"/api/jobs/{jid}/events") as r:
        lines = list(r.iter_lines())
    evs, cur = [], None
    for ln in lines:
        if ln.startswith("event:"):
            cur = ln.split(":", 1)[1].strip()
        elif ln.startswith("data:") and cur:
            evs.append((cur, json.loads(ln[5:])))
    return evs


# ------------------------------------------------------------------------------ ids, records, frame
def test_check_galaxy_and_validate_record():
    assert GX.check_galaxy("488530") == "488530" and GX.check_galaxy(" 0123 ") == "123"
    for bad in ("", "abc", "1" * 10, "12.5", "-3", "../x"):
        with pytest.raises(ValueError):
            GX.check_galaxy(bad)
    r = GX.validate_record(fake_record(), GID)
    assert r["id"] == GID and r["R200c_kpc"] == 180.0 and len(r["center_kpc"]) == 3
    rec = fake_record()
    rec.pop("center_kpc")
    rec["center_ckpch"] = (np.asarray(fake_record()["center_kpc"]) * rec["TNG_H"]).tolist()
    assert np.allclose(GX.validate_record(rec, GID)["center_kpc"], fake_record()["center_kpc"])
    for mut, needle in ((lambda d: d.update(subhalo_id=1), "not"), (lambda d: d.update(Lhat=[1, 1, 0]), "unit"),
                        (lambda d: d.update(yhat=d["xhat"]), "orthogonal"), (lambda d: d.update(R200c_kpc=-1), "R200c"),
                        (lambda d: d.update(center_kpc=[1, 2]), "center_kpc"),
                        (lambda d: d.update(SubhaloVel_kms=[1, float("nan"), 2]), "SubhaloVel")):
        d = fake_record()
        mut(d)
        with pytest.raises(ValueError, match=needle):
            GX.validate_record(d, GID)
    assert GX.public_record(r)["subhalo_id"] == int(GID) and "Lhat" not in GX.public_record(r)


def test_geometry_in_another_frame_and_restore():
    rec = GX.validate_record(fake_record(), GID)
    c = canonicalize("face-on", 50, 90)
    base = make_sightline("face-on", 50, 90)
    g = GX.make_geometry(rec, c)
    ctr = np.asarray(rec["center_kpc"])
    assert np.allclose(g["n_los"], rec["Lhat"])                              # face-on = the galaxy's Lhat
    assert np.isclose(np.linalg.norm(np.asarray(g["anchor_kpc"]) - ctr), 50)  # b from its centre
    assert np.isclose(np.dot(np.asarray(g["anchor_kpc"]) - ctr, rec["Lhat"]), 0)
    assert np.isclose(g["half_kpc"], 180.0) and np.isclose(g["v_sys_kms"], np.dot(rec["SubhaloVel_kms"], rec["Lhat"]))
    assert np.allclose(g["start_ckpch"], np.asarray(g["start_kpc"]) * rec["TNG_H"])
    after = make_sightline("face-on", 50, 90)                                 # module frame restored
    assert np.allclose(after["start_kpc"], base["start_kpc"]) and np.allclose(GX.make_geometry(None, c)["start_kpc"],
                                                                              base["start_kpc"])
    e = GX.make_geometry(rec, {"kind": "endpoints", **CUSTOM})
    assert np.allclose(np.asarray(e["start_kpc"]) - ctr, CUSTOM["p0_kpc"])
    j = GX.job_geometry(rec, c, GID)
    assert j["galaxy"] == GID and j["id"] == c["id"] and j["orientation"] == "face-on" and "start_ckpch" in j


def test_frame_swaps_never_leak_across_threads():
    rec = GX.validate_record(fake_record(), GID)
    c = canonicalize("edge-on", 30, 45)
    want = {None: GX.make_geometry(None, c)["start_kpc"], GID: GX.make_geometry(rec, c)["start_kpc"]}
    bad = []

    def run(r, key):
        for _ in range(150):
            if not np.allclose(GX.make_geometry(r, c)["start_kpc"], want[key]):
                bad.append(key)
    ts = [threading.Thread(target=run, args=a) for a in ((None, None), (rec, GID), (None, None), (rec, GID))]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not bad


def test_frame_call_prefers_a_galaxy_argument():
    seen = {}

    def fn(x, galaxy=None):
        seen["g"] = galaxy
        return x
    assert GX.frame_call({"id": "1"}, fn, 3) == 3 and seen["g"] == {"id": "1"}


# ------------------------------------------------------------------------------ cutout cache
def test_cutout_cache_lru_cap_pins_and_external(root, src):
    pins = set()
    cc = GX.CutoutCache(root / "cache", cap_bytes=int(2.5 * MB), fetcher=FakeFetcher(src), pinned=lambda: pins)
    (root / "cache" / "999").mkdir(parents=True)
    (root / "cache" / "999" / GX.CUTOUT_NAME).write_bytes(b"\0" * 3 * MB)    # pipeline data: never evicted
    assert cc.ensure(GID, 10) == cc.path(GID) and cc.managed(GID) and cc.used_bytes() == MB
    assert os.stat(cc.path(GID)).st_mtime == GX.CUTOUT_EPOCH                  # yt index hash stays stable
    cc.index_path(GID).write_bytes(b"\0" * 100)                              # its yt index counts too
    pins.add(GID)
    cc.ensure(GID2, 10)                                                       # 1 + 2 MB > 2.5 MB, GID pinned
    assert cc.has(GID) and cc.has(GID2) and cc.status()["over_cap"]
    pins.clear()
    cc.touch(GID2)
    assert cc.evict() == [GID] and not cc.has(GID) and not cc.index_path(GID).exists()
    assert cc.has("999") and not cc.managed("999")
    ents = {e["id"]: e for e in cc.entries()}
    assert set(ents) == {GID2, "999"} and ents[GID2]["managed"] and not ents["999"]["managed"]
    cc2 = GX.CutoutCache(root / "cache", cap_bytes=int(2.5 * MB), fetcher=FakeFetcher(src))
    assert cc2.managed(GID2) and not cc2.managed(GID)                         # LRU index persisted


def test_cutout_cache_single_flight_and_errors(root, src):
    gate = threading.Event()
    f = FakeFetcher(src, gate=gate)
    cc = GX.CutoutCache(root / "c", cap_bytes=100 * MB, fetcher=f)
    got = []
    assert cc.prepare(GID, lambda ok, err: got.append((ok, err))) == "preparing"
    assert cc.prepare(GID, lambda ok, err: got.append((ok, err))) == "preparing"
    assert cc.preparing() == [GID] and cc.evict() == []
    gate.set()
    wait_for(lambda: len(got) == 2)
    assert got == [(True, None)] * 2 and f.calls.count((GID, GX.CUTOUT_NAME)) == 1
    assert cc.prepare(GID, lambda ok, err: got.append(("now", ok))) == "cached" and got[-1] == ("now", True)
    bad = GX.CutoutCache(root / "c2", cap_bytes=100 * MB, fetcher=FakeFetcher(src, fail={GX.CUTOUT_NAME}))
    with pytest.raises(GX.GalaxyUnavailable, match="could not fetch"):
        bad.ensure(GID, 10)
    assert GID in bad.errors and not bad.has(GID) and not list((root / "c2" / GID).glob(".*part"))
    none = GX.CutoutCache(root / "c3", cap_bytes=MB)
    assert none.prepare(GID, lambda ok, err: got.append((ok, err))) == "error" and got[-1][0] is False


def test_cutout_cache_keeps_free_disk(root, src, monkeypatch):
    cc = GX.CutoutCache(root / "c", cap_bytes=100 * MB, min_free_bytes=10 * MB, fetcher=FakeFetcher(src))
    monkeypatch.setattr(cc, "_free", lambda: 5 * MB)
    with pytest.raises(GX.GalaxyUnavailable, match="disk space"):
        cc.ensure(GID, 10)
    assert not cc.has(GID)


# ------------------------------------------------------------------------------ job queue
def test_jobqueue_preparing_state():
    q = JobQueue(prepare_ttl_s=5.0, clock=lambda: now[0])
    now = [100.0]
    g = {**canonicalize("face-on", 50, 90), "galaxy": GID}
    j, created = q.submit(g, preparing=True)
    assert created and j.status == PREPARING and j.galaxy == GID and job_key(g) == f"{GID}:face_b050_a090"
    assert q.submit(dict(g))[0] is j                                          # dedupe within the galaxy
    d, _ = q.submit(canonicalize("face-on", 50, 90))                          # same id, default galaxy: new job
    assert d is not j and d.galaxy is None and q.counts() == {"queued": 1, "running": 0, "preparing": 1}
    assert q.lease("w", caps=("endpoints", "fit", "galaxies")).job_id == d.job_id   # preparing is not leasable
    assert q.lease("w", caps=("endpoints", "fit", "galaxies")) is None and q.active_galaxies() == {GID}
    assert q.prepared(GID) == [j.job_id] and j.status == QUEUED
    assert q.lease("old", caps=("endpoints", "fit")) is None                  # needs the galaxies cap
    assert q.lease("w", caps=("galaxies",)).job_id == j.job_id
    k, _ = q.submit({**canonicalize("edge-on", 20, 0), "galaxy": GID2}, preparing=True)
    assert q.prepare_failed(GID2, "no data") == [k.job_id] and k.status == ERROR and k.error == "no data"
    m, _ = q.submit({**canonicalize("edge-on", 30, 0), "galaxy": GID2}, preparing=True)
    now[0] += 10
    q.reap()
    assert m.status == ERROR and "too long" in m.error and job_key(m.geom) not in q.inflight
    assert can_run("orientation", (), None) and not can_run("orientation", ("endpoints",), GID)
    assert not can_run("endpoints", ("galaxies",), GID) and can_run("endpoints", ("galaxies", "endpoints"), GID)


# ------------------------------------------------------------------------------ routes
def test_routes_take_a_galaxy(libdir, src):
    with client(libdir, FakeFetcher(src)) as c:
        warm(c)
        h = c.get("/api/health").json()
        assert h["galaxies"]["default"] == "488530" and h["galaxies"]["open"] == ["488530"]
        assert h["galaxies"]["cache"]["cap_bytes"] == 10 * MB and h["galaxies"]["cached"] == []
        d = c.get("/api/catalog").json()
        assert c.get("/api/catalog?g=488530").json() == d and len(d["entries"]) == 1
        x = c.get(f"/api/catalog?g={GID}").json()
        assert x["galaxy"]["subhalo_id"] == int(GID) and x["galaxy"]["R200c_kpc"] == 180.0 and x["entries"] == []
        assert c.get(f"/api/catalog?g=0{GID}").json() == x                    # canonical id
        assert c.get("/api/catalog?g=777").status_code == 404                 # not in the dataset
        assert c.get("/api/catalog?g=abc").status_code == 422
        assert c.get("/api/sightline/face_b050_a090.bin").status_code == 200
        assert c.get(f"/api/sightline/face_b050_a090.bin?g={GID}").status_code == 404   # per-galaxy store
        assert c.get(f"/api/components?g={GID}").json()["entries"] == {}
        body = {"orientation": "face-on", "b_kpc": 50, "azimuth_deg": 90}
        g0 = c.post("/api/geometry", json=body).json()
        g1 = c.post(f"/api/geometry?g={GID}", json=body).json()
        assert g0["exists"] and not g1["exists"] and g1["galaxy"] == GID and "galaxy" not in g0
        assert np.allclose(g1["geom"]["n_los"], fake_record()["Lhat"]) and g0["geom"]["n_los"] != g1["geom"]["n_los"]
        assert c.post("/api/geometry", json={**body, "galaxy": GID}).json()["geom"] == g1["geom"]
        r = c.post(f"/api/geometry?g={GID2}", json={**body, "galaxy": GID})
        assert r.status_code == 422 and "differs" in r.json()["detail"]
        assert c.post("/api/geometry", json={**body, "galaxy": "x1"}).status_code == 422
        gc_ = c.post(f"/api/geometry/custom?g={GID}", json=CUSTOM).json()
        assert np.allclose(np.asarray(gc_["geom"]["start_kpc"]) - fake_record()["center_kpc"], CUSTOM["p0_kpc"])
        h = c.get("/api/health").json()["galaxies"]
        assert h["open"] == ["488530", GID] and h["cached"] == []             # records only: no cutout fetched


def test_custom_ray_prepares_galaxy_then_runs(libdir, src):
    gate = threading.Event()
    f = FakeFetcher(src, gate=gate)
    RecordingGen.made.clear()
    with client(libdir, f, gen=RecordingGen) as c:
        warm(c)
        r = c.post(f"/api/sightlines/custom?g={GID}", json=CUSTOM)
        assert r.status_code == 202, r.text
        j = r.json()
        assert j["status"] == "preparing" and j["galaxy"] == GID and j["position"] is None
        s = c.get(f"/api/jobs/{j['job_id']}").json()
        assert s["status"] == "preparing" and s["galaxy"] == GID and "preparing galaxy" in s["msg"]
        assert c.get("/api/health").json()["queue"]["preparing"] == 1
        assert c.get("/api/health").json()["galaxies"]["cache"]["preparing"] == [GID]
        r2 = c.post("/api/sightlines/custom", json={**CUSTOM, "galaxy": GID}).json()   # dedupe across forms
        assert r2["job_id"] == j["job_id"]
        d = c.post("/api/sightlines/custom", json=CUSTOM).json()             # default galaxy: its own job
        assert d["job_id"] != j["job_id"] and "galaxy" not in d
        gate.set()
        evs = sse(c, j["job_id"])
        names = [e for e, _ in evs]
        assert names[-1] == "done" and evs[-1][1]["entry"]["id"] == j["id"]
        done = wait_job(c, j["job_id"])
        assert done["status"] == "done" and done["components"] is not None
        made = [k for k in RecordingGen.made if k.get("galaxy")]
        assert made and made[-1]["cutout"].endswith(f"/gal/{GID}/{GX.CUTOUT_NAME}")
        assert made[-1]["galaxy"]["id"] == GID and made[-1]["index_filename"].endswith(f"/gal/{GID}/cutout.ewah")
        x = c.get(f"/api/catalog?g={GID}").json()
        e = next(e for e in x["entries"] if e["id"] == j["id"])
        assert np.allclose(e["p0"], CUSTOM["p0_kpc"], atol=0.01) and np.allclose(e["p1"], CUSTOM["p1_kpc"], atol=0.01)
        assert all(e["id"] != j["id"] for e in c.get("/api/catalog").json()["entries"]) or \
            wait_job(c, d["job_id"])["status"] == "done"
        npz = c.get(f"/api/sightline/{j['id']}.npz?g={GID}")
        assert npz.status_code == 200 and f"cgm_sid{GID}_{j['id']}.npz" in npz.headers["content-disposition"]
        p = L.load_npz(__import__("io").BytesIO(npz.content), id=j["id"])
        assert np.allclose(np.asarray(p["geom"]["start_kpc"]) - fake_record()["center_kpc"], CUSTOM["p0_kpc"])
        assert c.get(f"/api/sightline/{j['id']}.bin?g={GID}").status_code == 200
        assert c.get(f"/api/components/{j['id']}.json?g={GID}").status_code == 200
        fig = c.post(f"/api/figure?g={GID}", json={"id": j["id"]})
        assert fig.status_code == 200 and f"sub{GID}_" in fig.headers["content-disposition"]
        assert c.post("/api/figure", json={"id": j["id"]}).status_code in (200, 404)   # default store: its own
        assert (libdir / "gal" / GID / "vm" / "generated" / f"{j['id']}.npz").is_file()
        h = c.get("/api/health").json()
        cached = {e["id"]: e for e in h["galaxies"]["cached"]}
        assert cached[GID]["managed"] and cached[GID]["bytes"] == MB
        assert h["workers"]["local"]["galaxies"]["warm"] == [GID]
        assert cached[GID]["pinned"]                                         # warm in the worker: kept
        # a second ray in the cached galaxy is queued at once (no preparing)
        r3 = c.post(f"/api/sightlines?g={GID}", json={"orientation": "edge-on", "b_kpc": 40, "azimuth_deg": 0}).json()
        assert r3["status"] in ("queued", "running", "done") and wait_job(c, r3["job_id"])["status"] == "done"
        assert f.calls.count((GID, GX.CUTOUT_NAME)) == 1


def test_prepare_failure_errors_the_job(libdir, src):
    with client(libdir, FakeFetcher(src, fail={GX.CUTOUT_NAME})) as c:
        warm(c)
        j = c.post(f"/api/sightlines?g={GID}", json={"orientation": "face-on", "b_kpc": 20, "azimuth_deg": 0}).json()
        s = wait_job(c, j["job_id"])
        assert s["status"] == "error" and "could not fetch" in s["error"] and "/" not in s["error"]
        assert GID in c.get("/api/health").json()["galaxies"]["errors"]
        assert sse(c, j["job_id"])[-1][0] == "error"


def test_galaxy_without_worker_or_source_is_refused(libdir, src):
    body = {"orientation": "face-on", "b_kpc": 20, "azimuth_deg": 0}
    with client(libdir, FakeFetcher(src), local_worker=False) as c:
        c.post("/api/worker/lease?wait=0", json={"name": "old", "caps": ["endpoints", "fit"]}, headers=AUTH)
        assert c.post("/api/sightlines", json=body).status_code == 202          # default galaxy: fine
        r = c.post(f"/api/sightlines?g={GID}", json=body)
        assert r.status_code == 503 and "galaxy" in r.json()["detail"]
    # local worker, record known locally, but no data source for the cutout: refused up front
    d = libdir / "gal" / GID2
    d.mkdir(parents=True)
    (d / GX.META_NAME).write_text(json.dumps(fake_record(GID2)))
    with client(libdir, None) as c:
        warm(c)
        assert c.get(f"/api/catalog?g={GID2}").status_code == 200
        assert c.post(f"/api/sightlines?g={GID2}", json=body).status_code == 503
        assert c.get("/api/catalog?g=777").status_code == 404                 # no record, no source


def test_galaxies_index_limits_ids(libdir, src, root):
    idx = root / "galaxies.json"
    idx.write_text(json.dumps({"galaxies": [{"id": int(GID), "label": "x"}, {"id": 488530}]}))
    with client(libdir, FakeFetcher(src), galaxies_index=idx) as c:
        assert c.get(f"/api/catalog?g={GID}").status_code == 200
        assert c.get(f"/api/catalog?g={GID2}").status_code == 404              # in the dataset, not served
        assert c.get("/api/health").json()["galaxies"]["index"] == 2


def test_remote_worker_with_galaxy_dir(libdir, src):
    with client(libdir, None, local_worker=False) as c:
        old = RemoteWorker("", TOKEN, name="laptop", generator=FakeGenerator(), client=c, poll_s=0.2)
        assert "galaxies" not in old.caps
        w = RemoteWorker("", TOKEN, name="sol", generator=FakeGenerator(), client=c, poll_s=0.5, heartbeat_s=0.2,
                         galaxy_dir=str(src / "gal"), gen_spec=RecordingGen)
        assert w.caps == ("endpoints", "fit", "galaxies")
        assert w.lease() is None and old.lease() is None
        # the coordinator has no cutout source, but a galaxies worker is live: accepted, no preparing;
        # its record comes from the coordinator's galaxy dir
        d = libdir / "gal" / GID
        d.mkdir(parents=True)
        (d / GX.META_NAME).write_text(json.dumps(fake_record(GID)))
        j = c.post(f"/api/sightlines/custom?g={GID}", json=CUSTOM).json()
        assert j["status"] == "queued", j
        assert old.lease() is None                                            # never leased to a capless worker
        assert w.run(max_jobs=1) == 1 and w.done == 1
        s = wait_job(c, j["job_id"])
        assert s["status"] == "done" and s["galaxy"] == GID
        assert RecordingGen.made[-1]["cutout"] == str(src / "gal" / GID / GX.CUTOUT_NAME)
        e = next(e for e in c.get(f"/api/catalog?g={GID}").json()["entries"] if e["id"] == j["id"])
        assert np.allclose(e["p0"], CUSTOM["p0_kpc"], atol=0.01)
        h = {x["name"]: x["caps"] for x in c.get("/api/health").json()["workers"]["remote"]}
        assert h["sol"] == ["endpoints", "fit", "galaxies"]


def test_remote_result_with_wrong_frame_is_rejected(libdir, src):
    """A worker that ignores the resolved geometry (e.g. casts in the default frame) is refused."""
    class DefaultFrame(FakeGenerator):
        def __init__(self, **kw):
            kw.pop("galaxy", None)
            super().__init__(**kw)

        def generate(self, geom, progress=None):
            g = {k: geom[k] for k in ("id", "kind", "p0_kpc", "p1_kpc")}
            return super().generate(g, progress)
    d = libdir / "gal" / GID
    d.mkdir(parents=True)
    (d / GX.META_NAME).write_text(json.dumps(fake_record(GID)))
    with client(libdir, None, local_worker=False) as c:
        w = RemoteWorker("", TOKEN, name="sol", generator=FakeGenerator(), client=c, poll_s=0.5, heartbeat_s=0.2,
                         galaxy_dir=str(src / "gal"), gen_spec=DefaultFrame)
        w.lease()
        j = c.post(f"/api/sightlines/custom?g={GID}", json=CUSTOM).json()
        w.run(max_jobs=1)
        assert w.failed == 1
        assert c.get(f"/api/jobs/{j['job_id']}").json()["status"] in ("queued", "running", "error")


def test_remote_worker_drops_galaxies_cap_for_old_coordinator():
    class Resp:
        def __init__(self, code):
            self.status_code, self.headers, self.text = code, {}, ""

    class Client:
        def __init__(self):
            self.bodies = []

        def post(self, url, headers=None, json=None, **kw):
            self.bodies.append(json)
            return Resp(422 if "galaxies" in (json.get("caps") or []) else 204)
    cl = Client()
    w = RemoteWorker("http://x", TOKEN, name="w", generator=FakeGenerator(), client=cl, galaxy_dir="/nowhere")
    assert w.lease() is None and w.caps == ("endpoints", "fit")
    assert cl.bodies[-1] == {"name": "w", "caps": ["endpoints", "fit"]}


def test_galaxy_generators_lru():
    RecordingGen.made.clear()
    gg = GalaxyGenerators(RecordingGen, {"ion_table_dir": "/t"}, max_warm=1)
    spec = lambda g: {"id": g, "record": {"id": g}, "cutout": f"/c/{g}.h5", "index_filename": f"/c/{g}.ewah"}  # noqa
    a = gg.get(spec("1"))
    assert gg.get(spec("1")) is a and gg.warm() == ["1"] and len(RecordingGen.made) == 1
    gg.get(spec("2"))
    assert gg.warm() == ["2"] and RecordingGen.made[-1] == {"ion_table_dir": "/t", "cutout": "/c/2.h5",
                                                            "index_filename": "/c/2.ewah", "galaxy": {"id": "2"}}
    z = GalaxyGenerators(RecordingGen, {}, max_warm=0)
    z.get(spec("3"))
    z.done()
    assert z.warm() == []


def test_eviction_never_touches_galaxies_in_use(libdir, src):
    gate = threading.Event()
    with client(libdir, FakeFetcher(src, gate=gate), cutout_cache_bytes=int(1.5 * MB)) as c:
        warm(c)
        hub = c.app.state.galaxies
        j = c.post(f"/api/sightlines?g={GID}", json={"orientation": "face-on", "b_kpc": 20, "azimuth_deg": 0}).json()
        assert hub.cache.pinned() >= {GID}                                    # preparing: pinned
        gate.set()
        assert wait_job(c, j["job_id"])["status"] == "done"
        k = c.post(f"/api/sightlines?g={GID2}", json={"orientation": "face-on", "b_kpc": 20, "azimuth_deg": 0}).json()
        assert wait_job(c, k["job_id"])["status"] == "done"
        # GID2 (2 MB) alone exceeds the 1.5 MB cap; GID was evicted when GID2 arrived (GID not warm: max_warm 1)
        assert not hub.cache.has(GID) and hub.cache.has(GID2)
        assert c.get("/api/health").json()["galaxies"]["cache"]["evicted"] >= 1
        # evicted galaxy: a new ray prepares it again
        r = c.post(f"/api/sightlines?g={GID}", json={"orientation": "edge-on", "b_kpc": 25, "azimuth_deg": 0}).json()
        assert r["status"] in ("preparing", "queued", "running")
        assert wait_job(c, r["job_id"])["status"] == "done"


# ------------------------------------------------------------------------------ storage / HF / settings
class FakeApi:
    def __init__(self, files=()):
        self.files, self.commits = set(files), []

    def list_repo_files(self, **kw):
        return sorted(self.files)

    def create_commit(self, operations=(), **kw):
        self.commits.append([o.path_in_repo for o in operations])
        self.files |= {o.path_in_repo for o in operations}


def test_hfsync_prefix_upload_sync_and_download(root):
    d = root / "gal" / GID
    (d / "generated").mkdir(parents=True)
    (d / "generated" / "face_b050_a090.npz").write_bytes(b"x")
    (d / "generated" / "face_b050_a090.bin").write_bytes(b"y")
    api = FakeApi({f"gal/{GID}/generated/face_b050_a090.bin"})

    def snap(repo_id, repo_type, local_dir, token, allow_patterns=None, ignore_patterns=None):
        assert allow_patterns == [f"gal/{GID}/generated/*"]
        p = Path(local_dir) / "gal" / GID / "generated"
        p.mkdir(parents=True)
        (p / "edge_b010_a000.npz").write_bytes(b"remote")
        (p / "face_b050_a090.npz").write_bytes(b"older")
        return local_dir
    hf = HFSync("t", "me/ds", d, api=api, snapshot=snap, batch_s=0, prefix=f"gal/{GID}/")
    assert hf.download() == str(d)
    assert (d / "generated" / "edge_b010_a000.npz").read_bytes() == b"remote"
    assert (d / "generated" / "face_b050_a090.npz").read_bytes() == b"x"         # local copy kept
    assert not list(d.glob(".hfdl_*"))
    assert hf.sync_missing(d / "generated") == 2                                  # .npz x2 (local edge + face)
    wait_for(lambda: hf.pending() == 0)
    hf.stop()
    assert set(sum(api.commits, [])) == {f"gal/{GID}/generated/face_b050_a090.npz",
                                         f"gal/{GID}/generated/edge_b010_a000.npz"}
    assert hf.status()["prefix"] == f"gal/{GID}/" and "gal/*" in DOWNLOAD_IGNORE


def test_store_of_another_galaxy(root):
    rec = GX.validate_record(fake_record(), GID)
    st = LibraryStore(root / "s", galaxy=rec)
    assert json.loads(st.catalog_doc()[0])["galaxy"]["subhalo_id"] == int(GID)
    c = {**canonicalize("face-on", 50, 90)}
    p = FakeGenerator(galaxy=rec).generate(c)
    e = st.add_generated(p, scores={"rank": 1})
    assert np.allclose(np.asarray(e["p0"]), np.asarray(p["geom"]["start_kpc"]) - rec["center_kpc"], atol=0.01)
    assert json.loads(st.catalog_doc()[0])["galaxy"]["subhalo_id"] == int(GID)
    st2 = LibraryStore(root / "s", galaxy=rec)
    assert st2.has(c["id"]) and st2.reconcile(backfill=False) == 0


def test_settings_galaxy_env(tmp_path):
    s = Settings.from_env({"TNG_LIBRARY_DIR": str(tmp_path), "CUTOUT_CACHE_GB": "2.5", "CUTOUT_MIN_FREE_GB": "1",
                           "GALAXY_MAX_WARM": "2", "TNG_DEFAULT_GALAXY": "123", "GAL_HF_DATASET": "me/gal",
                           "TNG_GALAXY_ROOT": str(tmp_path / "g"), "PREPARE_TIMEOUT_S": "60"})
    assert s.cutout_cache_bytes == int(2.5 * 1024**3) and s.cutout_min_free_bytes == 1024**3
    assert s.galaxy_max_warm == 2 and s.default_galaxy == "123" and s.gal_hf_dataset == "me/gal"
    assert s.galaxy_dir == tmp_path / "g" and s.prepare_timeout_s == 60.0
    d = Settings.from_env({"TNG_LIBRARY_DIR": str(tmp_path)})
    assert d.galaxy_dir == tmp_path / "gal" and d.cutout_cache_bytes == 10 * 1024**3 and d.default_galaxy == "488530"
    a = Settings.from_env({"TNG_LIBRARY_DIR": str(tmp_path), "TNG_GAL_ROOT": str(tmp_path / "pipe")})
    assert a.galaxy_dir == tmp_path / "pipe"                                  # the pipeline's data root works too


def test_local_worker_spawn_process_galaxy_job(libdir, src):
    """The production LocalWorker path (spawn child) runs a non-default galaxy's job: the child builds that
    galaxy's generator from the cached cutout and returns (payload, warm ids) across the process boundary."""
    s = settings(libdir, local_executor="process", generator="server.testing:FakeGenerator")
    with TestClient(create_app(s, galaxy_fetcher=FakeFetcher(src))) as c:
        wait_for(lambda: c.get("/api/health").json()["warm"], timeout=600, every=0.5)
        j = c.post(f"/api/sightlines/custom?g={GID}", json=CUSTOM).json()
        assert j["status"] in ("preparing", "queued"), j
        done = wait_job(c, j["job_id"], timeout=300)
        assert done["status"] == "done", done
        assert c.app.state.local.warm_galaxies == [GID]
        e = next(e for e in c.get(f"/api/catalog?g={GID}").json()["entries"] if e["id"] == j["id"])
        assert np.allclose(e["p0"], CUSTOM["p0_kpc"], atol=0.01)


# ------------------------------------------------------------------------------------------ fix3 (review2 F1, F2, F4)
def test_real_generator_gets_the_job_galaxy_bbox(monkeypatch, tmp_path):
    """F1: tngsight.generate.Generator (no galaxy= argument) must open a boundary galaxy's unwrapped slim cutout with
    that galaxy's yt bounding box, not the process's default galaxy; config.GALAXY is restored afterwards."""
    import types
    from server import workers as W
    from tngsight import generate as GEN
    seen = []

    class _DS:
        derived_field_list = [("gas", "metallicity")]

    fake_yt = types.SimpleNamespace(load=lambda path, **kw: (seen.append(kw), _DS())[1])
    fake_tri = types.SimpleNamespace(add_ion_fields=lambda *a, **k: None)
    monkeypatch.setattr(GEN, "import_trident", lambda wd, td: (fake_yt, fake_tri))
    monkeypatch.setattr(GEN, "line_database", lambda tri: None)
    cut = tmp_path / "c.hdf5"; cut.write_bytes(b"x")
    bb = [[0.0, 1000.0], [34000.0, 36000.0], [10.0, 1010.0]]
    rec = {**fake_record(), "yt_bounding_box_ckpch": bb}
    before = C.GALAXY
    assert not W._takes_galaxy(GEN.Generator)                       # the case the context manager covers
    gg = GalaxyGenerators("tngsight.generate:Generator", {"ion_table_dir": str(tmp_path), "workdir": str(tmp_path)})
    gg.get({"id": GID, "record": rec, "cutout": str(cut), "index_filename": str(tmp_path / "i.ewah")})
    assert seen[-1].get("bounding_box") == bb and C.GALAXY is before
    gg.get({"id": "7", "record": fake_record("7"), "cutout": str(cut), "index_filename": str(tmp_path / "j.ewah")})
    assert "bounding_box" not in seen[-1]                            # a normal galaxy loads exactly as before


def test_generated_entries_carry_their_spectra_source(root):
    """F2 / ux P4: a ray cast on the server is Trident HM2012 whatever the galaxy's library is; its catalogue row says so."""
    rec = GX.validate_record(fake_record(), GID)
    st = LibraryStore(root / "s2", galaxy=rec)
    p = FakeGenerator(galaxy=rec).generate({**canonicalize("edge-on", 40, 0)})
    e = st.add_generated(p, scores={"rank": 1})
    assert e["spectra"] == "trident" and e["source"] == "generated"


def test_galaxy_files_default_to_the_published_cutout_repo(tmp_path):
    """F4: the VM's defaults point at the repo and paths deploy/data/upload_galaxies.py publishes."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("upload_galaxies", ROOT / "deploy" / "data" / "upload_galaxies.py")
    up = importlib.util.module_from_spec(spec); spec.loader.exec_module(up)
    s = Settings.from_env({"TNG_LIBRARY_DIR": str(tmp_path)})
    assert s.gal_hf_dataset == up.CUTOUT_REPO
    for name in (GX.CUTOUT_NAME, "galaxy.json"):
        assert up.CUTOUT_RE.match(s.gal_hf_pattern.format(id=GID, name=name)), name
    assert Settings.from_env({"TNG_LIBRARY_DIR": str(tmp_path), "GAL_HF_DATASET": ""}).gal_hf_dataset is None
