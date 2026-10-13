"""Server tests: FastAPI TestClient + a yt-free FakeGenerator (server.testing). Covers every endpoint,
the job queue (dedupe, positions, SSE), the worker lease protocol (auth, expiry requeue, result
validation), rate limits, CORS/PNA, body limits, the figure endpoint and HFSync."""
import io
import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

import numpy as np
import pytest

# The explorer server needs requirements-tng.txt; with only requirements.txt (README "Reproduce")
# this module is skipped instead of aborting the whole collection.
pytest.importorskip("fastapi")
pytest.importorskip("httpx")
pytest.importorskip("sse_starlette")
from fastapi.testclient import TestClient  # noqa: E402

from server.app import create_app  # noqa: E402
from server.jobs import JobQueue  # noqa: E402
from server.ratelimit import RateLimiter, TokenBucket, client_ip  # noqa: E402
from server.settings import Settings  # noqa: E402
from server.storage import HFSync, LibraryStore  # noqa: E402
from server.testing import FakeGenerator  # noqa: E402
from server.workers import RemoteWorker, payload_to_npz_bytes  # noqa: E402
from tngsight import library as L  # noqa: E402
from tngsight.geometry import canonicalize  # noqa: E402

TOKEN = "s3cret-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
LIB_IDS = ("edge_b100_a330", "face_b050_a090")
PNG = b"\x89PNG\r\n\x1a\n"
SCRATCH = Path("/Volumes/cgm_work/scratch/C_server/pytest")


@pytest.fixture
def libdir(tmp_path):
    """Small seeded library (2 fake 'library' sightlines). Uses the work volume when present
    (the internal disk of the dev Mac is full), else pytest's tmp_path."""
    if SCRATCH.parent.is_dir():
        d = SCRATCH / uuid.uuid4().hex[:8]
    else:
        d = tmp_path / "lib"
    (d / "sightlines").mkdir(parents=True)
    gen, cat = FakeGenerator(), L.Catalog(d / "catalog.json")
    for i, sid in enumerate(LIB_IDS):
        o, b, a = sid.split("_")
        c = canonicalize(o, int(b[1:]), int(a[1:]))
        p = gen.generate(c)
        L.save_npz(d / "sightlines" / L.npz_name(sid), p["geom"], p["logN"], p["tau"])
        cat.upsert(L.catalog_entry(p, {"rank": i + 1, "showcase_score": 2.0 - i, "ovi_showcase": True}, "library"))
    cat.save()
    yield d
    shutil.rmtree(d, ignore_errors=True)


GATE = threading.Event()


class GatedGenerator(FakeGenerator):
    """Blocks in generate() until GATE is set (to observe queued/running states)."""

    def generate(self, geom, progress=None):
        progress and progress("ray", 0.1, "waiting at gate")
        assert GATE.wait(30), "test gate never opened"
        return super().generate(geom, progress)


class FailingGenerator(FakeGenerator):
    def generate(self, geom, progress=None):
        raise RuntimeError("boom")


def settings(libdir, **over):
    kw = dict(library_dir=libdir, local_executor="thread", generator=FakeGenerator, worker_token=TOKEN,
              reap_every_s=0.05, lease_poll_s=2.0, heartbeat_s=1.0, node_name="test")
    kw.update(over)
    return Settings(**kw)


def client_for(libdir, **over):
    gen, renderer = over.pop("gen", None), over.pop("renderer", None)
    s = settings(libdir, **over)
    return TestClient(create_app(s, generator=gen or s.generator, figure_renderer=renderer))


def wait_for(fn, timeout=20.0, every=0.02):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        v = fn()
        if v:
            return v
        time.sleep(every)
    raise AssertionError("condition not met in time")


def wait_job(c, job_id, statuses=("done", "error"), timeout=120.0):
    """Generous timeout: the first scoring call imports scipy, minutes on a cold USB disk."""
    last = {}

    def check():
        last.update(c.get(f"/api/jobs/{job_id}").json())
        return dict(last) if last["status"] in statuses else None
    try:
        return wait_for(check, timeout)
    except AssertionError:
        raise AssertionError(f"job never reached {statuses}: {last}")


def warm(c):
    wait_for(lambda: c.get("/api/health").json()["warm"])


def register(c, name="w"):
    """An idle lease poll: a remote worker is now 'seen', so new jobs are accepted."""
    assert c.post("/api/worker/lease?wait=0", json={"name": name}, headers=AUTH).status_code == 204


# ------------------------------------------------------------------------------ public endpoints
def test_health_and_warm(libdir):
    with client_for(libdir) as c:
        warm(c)
        h = c.get("/api/health").json()
        assert h["status"] == "ok" and h["node"] == "test" and h["workers"]["local"]["state"] == "warm"
        assert h["library_size"] == 2 and h["generated_size"] == 0 and h["queue"] == {"queued": 0, "running": 0}
        assert set(h) >= {"version", "warm", "workers", "queue"}


def test_health_local_disabled_and_broken_load(libdir):
    from server.testing import BrokenLoadGenerator
    with client_for(libdir, local_worker=False) as c:
        h = c.get("/api/health").json()
        assert h["workers"]["local"]["state"] == "disabled" and h["warm"] is False
    with client_for(libdir, gen=BrokenLoadGenerator) as c:
        h = wait_for(lambda: (lambda h: h if h["workers"]["local"]["state"] == "error" else None)(
            c.get("/api/health").json()))
        err = h["workers"]["local"]["error"]
        assert err == "dataset unavailable (RuntimeError)" and h["warm"] is False   # no raw exception text


def test_catalog_etag_and_cache(libdir):
    with client_for(libdir, local_worker=False) as c:
        r = c.get("/api/catalog")
        assert r.status_code == 200 and r.headers["cache-control"] == "max-age=60"
        doc, etag = r.json(), r.headers["etag"]
        assert doc["version"] == 1 and {"galaxy", "lines"} <= set(doc)
        assert [e["id"] for e in doc["entries"]] == list(LIB_IDS)
        assert all(e["source"] == "library" for e in doc["entries"])
        r2 = c.get("/api/catalog", headers={"If-None-Match": etag})
        assert r2.status_code == 304 and r2.headers["etag"] == etag


def test_sightline_bin_npz_and_ids(libdir):
    with client_for(libdir, local_worker=False) as c:
        r = c.get(f"/api/sightline/{LIB_IDS[0]}.bin")
        assert r.status_code == 200 and r.headers["content-type"] == "application/octet-stream"
        d = L.decode_web(r.content)
        assert set(d["lines"]) == {"OVI", "HILyb", "CIII"} and d["lines"]["OVI"]["n"] == 5165
        r = c.get(f"/api/sightline/{LIB_IDS[1]}.npz")
        assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
        p = L.load_npz(io.BytesIO(r.content), id=LIB_IDS[1])
        assert p["tau"]["CIII"].shape == (4889,)
        assert c.get("/api/sightline/edge_b123_a045.bin").status_code == 404      # valid id, unknown
        assert c.get("/api/sightline/rand_b010_a010_s5.npz").status_code == 404
        for bad in ("face_b1_a000.bin", "edge_b100_a330.txt", "..%2Fcatalog.json", "x.bin",
                    "edge_b100_a330", "EDGE_b100_a330.bin", "edge_b100_a330_s1x.bin"):
            assert c.get(f"/api/sightline/{bad}").status_code in (404, 422), bad
        assert c.get("/api/sightline/face_b1_a000.bin").status_code == 422


def test_geometry_canonicalize(libdir):
    with client_for(libdir, local_worker=False) as c:
        r = c.post("/api/geometry", json={"orientation": "Edge", "b_kpc": 100.4, "azimuth_deg": 360})
        assert r.status_code == 200
        j = r.json()
        assert j["id"] == "edge_b100_a000" and j["orientation"] == "edge-on" and j["seed"] is None
        assert len(j["geom"]["n_los"]) == 3 and j["exists"] is False
        assert c.post("/api/geometry", json={"orientation": "edge", "b_kpc": 100, "azimuth_deg": 330}).json()["exists"]
        r = c.post("/api/geometry", json={"orientation": "random", "b_kpc": 12.5, "azimuth_deg": 34, "seed": 7})
        assert r.json()["id"] == "rand_b012_a034_s7"
        for bad in ({"orientation": "sideways", "b_kpc": 10, "azimuth_deg": 0},
                    {"orientation": "face", "b_kpc": 301, "azimuth_deg": 0},
                    {"orientation": "face", "b_kpc": -1, "azimuth_deg": 0},
                    {"orientation": "random", "b_kpc": 10, "azimuth_deg": 0},
                    {"orientation": "random", "b_kpc": 10, "azimuth_deg": 0, "seed": -1},
                    {"orientation": "random", "b_kpc": 10, "azimuth_deg": 0, "seed": 2**32},
                    {"orientation": "face", "b_kpc": 10, "azimuth_deg": 0, "path": "/etc"},
                    {"orientation": "face", "b_kpc": "ten", "azimuth_deg": 0},
                    {"orientation": "face", "azimuth_deg": 0}):
            assert c.post("/api/geometry", json=bad).status_code == 422, bad


# ------------------------------------------------------------------------------ jobs (local worker)
def test_submit_ready_generate_and_persist(libdir):
    with client_for(libdir) as c:
        r = c.post("/api/sightlines", json={"orientation": "edge-on", "b_kpc": 100, "azimuth_deg": 330})
        assert r.status_code == 200 and r.json()["status"] == "ready" and r.json()["entry"]["rank"] == 1
        r = c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 77.4, "azimuth_deg": 12})
        assert r.status_code == 202
        j = r.json()
        assert j["id"] == "face_b077_a012" and j["status"] == "queued" and j["position"] == 1
        done = wait_job(c, j["job_id"], timeout=600)
        assert done["status"] == "done" and done["entry"]["source"] == "generated"
        assert done["entry"]["id"] == "face_b077_a012" and done["entry"]["rank"] is None
        assert (libdir / "generated" / "face_b077_a012.npz").is_file()
        assert (libdir / "generated" / "face_b077_a012.bin").is_file()
        assert "face_b077_a012" in [e["id"] for e in c.get("/api/catalog").json()["entries"]]
        assert c.get("/api/sightline/face_b077_a012.bin").status_code == 200
        r = c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 77, "azimuth_deg": 12})
        assert r.status_code == 200 and r.json()["status"] == "ready"
        assert c.get("/api/health").json()["generated_size"] == 1
        on_disk = json.loads((libdir / "catalog.json").read_text())
        assert any(e["id"] == "face_b077_a012" for e in on_disk["entries"])


def test_dedupe_positions_and_sse(libdir):
    GATE.clear()
    with client_for(libdir, gen=GatedGenerator) as c:
        warm(c)
        body = {"orientation": "random", "b_kpc": 20, "azimuth_deg": 5, "seed": 11}
        a = c.post("/api/sightlines", json=body).json()
        b = c.post("/api/sightlines", json=dict(body, b_kpc=20.3)).json()      # same canonical id
        assert a["job_id"] == b["job_id"]
        wait_job(c, a["job_id"], ("running",))
        q2 = c.post("/api/sightlines", json=dict(body, seed=12)).json()
        q3 = c.post("/api/sightlines", json=dict(body, seed=13)).json()
        assert (q2["position"], q3["position"]) == (1, 2)
        assert c.get(f"/api/jobs/{q3['job_id']}").json()["position"] == 2
        assert c.get("/api/health").json()["queue"] == {"queued": 2, "running": 1}
        jobq = c.app.state.jobs
        lines, err = [], []

        def read():
            try:
                with c.stream("GET", f"/api/jobs/{a['job_id']}/events") as r:
                    assert r.headers["content-type"].startswith("text/event-stream")
                    lines.extend(r.iter_lines())
            except Exception as e:  # pragma: no cover
                err.append(e)
        t = threading.Thread(target=read)
        t.start()
        wait_for(lambda: a["job_id"] in jobq._subs)
        time.sleep(1.3)                                      # > heartbeat_s: expect a ping comment
        GATE.set()
        t.join(30)
        assert not err and not t.is_alive()
        events = [ln.split(":", 1)[1].strip() for ln in lines if ln.startswith("event:")]
        assert events[0] == "progress" and events[-1] == "done" and events.count("done") == 1
        stages = [json.loads(ln[5:])["stage"] for ln in lines if ln.startswith("data:") and '"stage"' in ln]
        assert "spectrum:OVI" in stages and "save" in stages
        assert any(ln.startswith(":") for ln in lines), "no heartbeat comment"
        for jid in (q2["job_id"], q3["job_id"]):
            assert wait_job(c, jid)["status"] == "done"
        # a finished job's stream replays the terminal event and closes
        with c.stream("GET", f"/api/jobs/{q3['job_id']}/events") as r:
            ls = list(r.iter_lines())
        assert "event: done" in ls
    GATE.set()


def test_job_errors_and_unknown_jobs(libdir):
    with client_for(libdir, gen=FailingGenerator) as c:
        warm(c)
        j = c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 3, "azimuth_deg": 4}).json()
        e = wait_job(c, j["job_id"])
        assert e["status"] == "error" and e["error"] == "generation failed (RuntimeError)" and e["attempts"] == 2
        assert "boom" not in json.dumps(e)                     # exception text is logged, not published
        with c.stream("GET", f"/api/jobs/{j['job_id']}/events") as r:
            ls = list(r.iter_lines())
        assert "event: error" in ls
        assert c.get(f"/api/jobs/{uuid.uuid4().hex}").status_code == 404
        assert c.get(f"/api/jobs/{uuid.uuid4().hex}/events").status_code == 404
        assert c.get("/api/jobs/not-a-job").status_code == 422
        assert c.get("/api/jobs/../../etc/events").status_code in (404, 422)


def test_queue_cap_and_no_workers(libdir):
    with client_for(libdir, local_worker=False, queue_cap=2) as c:
        r = c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 9, "azimuth_deg": 1})
        assert r.status_code == 503 and "no worker" in r.json()["detail"]       # nobody to run it
        register(c)
        for az in (1, 2):
            assert c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 9, "azimuth_deg": az}).status_code == 202
        r = c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 9, "azimuth_deg": 3})
        assert r.status_code == 503 and r.headers["retry-after"] == "60"
        # dedupe still answers while full
        assert c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 9, "azimuth_deg": 1}).status_code == 202
    with client_for(libdir, local_worker=False, worker_token=None) as c:
        r = c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 9, "azimuth_deg": 3})
        assert r.status_code == 503


# ------------------------------------------------------------------------------ worker protocol
def _submit(c, az, b=40):
    r = c.post("/api/sightlines", json={"orientation": "edge", "b_kpc": b, "azimuth_deg": az})
    assert r.status_code == 202, r.text
    return r.json()


def test_worker_auth(libdir):
    with client_for(libdir, local_worker=False) as c:
        assert c.post("/api/worker/lease?wait=0", json={"name": "w"}).status_code == 401
        assert c.post("/api/worker/lease?wait=0", json={"name": "w"},
                      headers={"Authorization": "Bearer nope"}).status_code == 401
        assert c.post("/api/worker/lease?wait=0", json={"name": "w"},
                      headers={"Authorization": TOKEN}).status_code == 401
        assert c.post("/api/worker/lease?wait=0", json={"name": "w"}, headers=AUTH).status_code == 204
        assert c.post("/api/worker/lease?wait=0", json={"name": "bad name!"}, headers=AUTH).status_code == 422
        jid = uuid.uuid4().hex
        for path in (f"/api/worker/progress/{jid}", f"/api/worker/fail/{jid}", f"/api/worker/result/{jid}"):
            assert c.post(path, json={}).status_code == 401
    with client_for(libdir, local_worker=False, worker_token=None) as c:
        assert c.post("/api/worker/lease?wait=0", json={"name": "w"}, headers=AUTH).status_code == 404


def test_lease_progress_result_cycle(libdir):
    with client_for(libdir, local_worker=False) as c:
        t0 = time.monotonic()
        assert c.post("/api/worker/lease?wait=0.3", json={"name": "lap"}, headers=AUTH).status_code == 204
        assert time.monotonic() - t0 >= 0.25                      # it long-polled
        j = _submit(c, 7)
        got = {}

        def lease():                                              # long-poll wakes on submit
            got["r"] = c.post("/api/worker/lease?wait=5", json={"name": "lap"}, headers=AUTH)
        j2 = None
        t = threading.Thread(target=lease)
        r = c.post("/api/worker/lease?wait=1", json={"name": "lap"}, headers=AUTH)
        assert r.status_code == 200
        L1 = r.json()
        assert L1["job_id"] == j["job_id"] and L1["geom"]["id"] == "edge_b040_a007" and L1["lease_s"] == 120
        P1 = f"?lease={L1['lease']}"
        t.start()
        time.sleep(0.2)
        j2 = _submit(c, 8)
        t.join(10)
        assert got["r"].status_code == 200 and got["r"].json()["job_id"] == j2["job_id"]
        h = c.get("/api/health").json()
        assert [w["name"] for w in h["workers"]["remote"]] == ["lap"] and h["warm"] is True
        assert c.get(f"/api/jobs/{j['job_id']}").json()["status"] == "running"
        r = c.post(f"/api/worker/progress/{j['job_id']}", json={"stage": "ray", "frac": 0.3, "msg": "casting"},
                   headers=AUTH)
        assert r.status_code == 422                                   # the lease token is required
        r = c.post(f"/api/worker/progress/{j['job_id']}?lease={uuid.uuid4().hex}",
                   json={"stage": "ray", "frac": 0.3}, headers=AUTH)
        assert r.status_code == 409                                   # someone else's / a stale lease
        r = c.post(f"/api/worker/progress/{j['job_id']}{P1}", json={"stage": "ray", "frac": 0.3, "msg": "casting"},
                   headers=AUTH)
        assert r.status_code == 200
        s = c.get(f"/api/jobs/{j['job_id']}").json()
        assert (s["stage"], s["frac"], s["msg"]) == ("ray", 0.3, "casting")
        assert c.post(f"/api/worker/progress/{j['job_id']}{P1}", json={"stage": "ray", "frac": 2}, headers=AUTH).status_code == 422
        payload = FakeGenerator().generate(L1["geom"])
        blob = payload_to_npz_bytes(payload)
        # invalid results are rejected and the job stays running
        assert c.post(f"/api/worker/result/{j['job_id']}", content=b"not a zip", headers=AUTH).status_code == 422
        other = FakeGenerator().generate(canonicalize("edge", 41, 7))
        r = c.post(f"/api/worker/result/{j['job_id']}", content=payload_to_npz_bytes(other), headers=AUTH)
        assert r.status_code == 422 and "geom" in r.json()["detail"]
        bad = dict(payload, tau=dict(payload["tau"], OVI=np.full(5165, np.nan, np.float32)))
        assert c.post(f"/api/worker/result/{j['job_id']}", content=payload_to_npz_bytes(bad),
                      headers=AUTH).status_code == 422
        buf = io.BytesIO()
        np.savez_compressed(buf, geom=np.array(["x"], dtype=object))
        r = c.post(f"/api/worker/result/{j['job_id']}", content=buf.getvalue(), headers=AUTH)
        assert r.status_code == 422                                   # object arrays never unpickled
        assert c.get(f"/api/jobs/{j['job_id']}").json()["status"] == "running"
        r = c.post(f"/api/worker/result/{j['job_id']}", content=blob, headers=AUTH)
        assert r.status_code == 200 and r.json()["entry"]["source"] == "generated"
        assert c.get(f"/api/jobs/{j['job_id']}").json()["status"] == "done"
        assert c.post(f"/api/worker/result/{j['job_id']}", content=blob, headers=AUTH).status_code == 409
        assert c.post(f"/api/worker/progress/{j['job_id']}{P1}", json={"stage": "x", "frac": 0}, headers=AUTH).status_code == 409
        stored = L.load_npz(libdir / "generated" / "edge_b040_a007.npz")
        np.testing.assert_array_equal(stored["tau"]["HILyb"], payload["tau"]["HILyb"])
        # explicit failure: requeue once, then error
        P2 = f"?lease={got['r'].json()['lease']}"
        assert c.post(f"/api/worker/fail/{j2['job_id']}", json={"message": "oom"}, headers=AUTH).status_code == 422
        assert c.post(f"/api/worker/fail/{j2['job_id']}{P2}", json={"message": "oom"}, headers=AUTH).json()["status"] == "queued"
        L3 = c.post("/api/worker/lease?wait=1", json={"name": "lap"}, headers=AUTH).json()
        assert L3["attempt"] == 2 and L3["lease"] != got["r"].json()["lease"]
        assert c.post(f"/api/worker/fail/{j2['job_id']}{P2}", json={"message": "x"}, headers=AUTH).status_code == 409
        msg = "OSError: [Errno 28] No space left on device: '/Volumes/secret/path'"
        assert c.post(f"/api/worker/fail/{j2['job_id']}?lease={L3['lease']}", json={"message": msg},
                      headers=AUTH).json()["status"] == "error"
        assert c.get(f"/api/jobs/{j2['job_id']}").json()["error"] == "generation failed (OSError)"
        assert c.post(f"/api/worker/fail/{j2['job_id']}?lease={L3['lease']}", json={"message": "x"},
                      headers=AUTH).status_code == 409
        assert c.post(f"/api/worker/fail/{uuid.uuid4().hex}{P2}", json={"message": "x"}, headers=AUTH).status_code == 404


def test_result_size_limit(libdir):
    with client_for(libdir, local_worker=False, max_result=1000) as c:
        register(c)
        j = _submit(c, 9)
        c.post("/api/worker/lease?wait=1", json={"name": "w"}, headers=AUTH)
        r = c.post(f"/api/worker/result/{j['job_id']}", content=b"0" * 2000, headers=AUTH)
        assert r.status_code == 413


def test_lease_expiry_requeue_then_error(libdir):
    with client_for(libdir, local_worker=False, lease_s=0.3) as c:
        register(c)
        j = _submit(c, 10)
        a = c.post("/api/worker/lease?wait=1", json={"name": "w1"}, headers=AUTH).json()
        assert a["job_id"] == j["job_id"] and a["attempt"] == 1
        wait_job(c, j["job_id"], ("queued",), timeout=5)               # reaper requeued it
        assert "lease expired" in c.get(f"/api/jobs/{j['job_id']}").json()["msg"]
        b = c.post("/api/worker/lease?wait=1", json={"name": "w2"}, headers=AUTH).json()
        assert b["job_id"] == j["job_id"] and b["attempt"] == 2
        e = wait_job(c, j["job_id"], ("error",), timeout=5)
        assert "lease expired" in e["error"]
        # progress keeps a lease alive
    with client_for(libdir, local_worker=False, lease_s=0.4) as c:
        register(c)
        j = _submit(c, 11)
        tok = c.post("/api/worker/lease?wait=1", json={"name": "w1"}, headers=AUTH).json()["lease"]
        for _ in range(8):
            time.sleep(0.15)
            assert c.post(f"/api/worker/progress/{j['job_id']}?lease={tok}", json={"stage": "ray", "frac": 0.5},
                          headers=AUTH).status_code == 200
        assert c.get(f"/api/jobs/{j['job_id']}").json()["status"] == "running"


def test_late_result_after_requeue_is_accepted(libdir):
    with client_for(libdir, local_worker=False, lease_s=0.2, max_attempts=3) as c:
        register(c)
        j = _submit(c, 12)
        a = c.post("/api/worker/lease?wait=1", json={"name": "slow"}, headers=AUTH).json()
        wait_job(c, j["job_id"], ("queued",), timeout=5)
        blob = payload_to_npz_bytes(FakeGenerator().generate(a["geom"]))
        assert c.post(f"/api/worker/result/{j['job_id']}", content=blob, headers=AUTH).status_code == 200
        assert c.get(f"/api/jobs/{j['job_id']}").json()["status"] == "done"
        assert c.get("/api/health").json()["queue"]["queued"] == 0


def test_remote_worker_client(libdir):
    with client_for(libdir, local_worker=False) as c:
        register(c)
        j = _submit(c, 13)
        w = RemoteWorker("", TOKEN, name="pytest-worker", generator=FakeGenerator(), client=c, poll_s=1.0,
                         heartbeat_s=0.2)
        assert w.run(max_jobs=1) == 1 and w.done == 1
        s = c.get(f"/api/jobs/{j['job_id']}").json()
        assert s["status"] == "done" and s["entry"]["id"] == "edge_b040_a013"
        assert w.run(max_idle_polls=1) == 0                             # idle poll returns 204
        j2 = _submit(c, 14)
        wf = RemoteWorker("", TOKEN, name="bad", generator=FailingGenerator(), client=c, poll_s=1.0)
        wf.run(max_jobs=2)
        assert c.get(f"/api/jobs/{j2['job_id']}").json()["status"] == "error" and wf.failed == 2
        with pytest.raises(PermissionError):
            RemoteWorker("", "wrong", generator=FakeGenerator(), client=c, poll_s=0.1).run(max_jobs=1)


def test_remote_worker_cli_help():
    from server import remote_worker
    with pytest.raises(SystemExit) as e:
        remote_worker.main(["--help"])
    assert e.value.code == 0


# ------------------------------------------------------------------------------ limits / CORS
def test_rate_limit_and_proxy(libdir):
    with client_for(libdir, local_worker=False, rl_sightlines=(12, 4)) as c:
        register(c)
        for az in range(4):
            assert c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 5, "azimuth_deg": az}).status_code == 202
        r = c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 5, "azimuth_deg": 99})
        assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
        # cache hits and in-flight dedupes are not charged
        assert c.post("/api/sightlines", json={"orientation": "edge", "b_kpc": 100, "azimuth_deg": 330}).status_code == 200
        assert c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 5, "azimuth_deg": 0}).status_code == 202
        # X-Forwarded-For is ignored unless TRUST_PROXY
        r = c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 5, "azimuth_deg": 98},
                   headers={"X-Forwarded-For": "9.9.9.9"})
        assert r.status_code == 429
    with client_for(libdir, local_worker=False, rl_sightlines=(12, 1), trust_proxy=True) as c:
        register(c)
        # the proxy appends the real client (rightmost); the left part is whatever the client sent
        h1, h2 = {"X-Forwarded-For": "1.1.1.1, 10.0.0.1"}, {"X-Forwarded-For": "2.2.2.2"}
        spoof = {"X-Forwarded-For": "9.9.9.9, 10.0.0.1"}
        assert c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 6, "azimuth_deg": 1}, headers=h1).status_code == 202
        assert c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 6, "azimuth_deg": 2}, headers=h1).status_code == 429
        assert c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 6, "azimuth_deg": 4}, headers=spoof).status_code == 429
        assert c.post("/api/sightlines", json={"orientation": "face", "b_kpc": 6, "azimuth_deg": 3}, headers=h2).status_code == 202
    with client_for(libdir, local_worker=False, rl_sightlines=(12, 1), queue_cap=1) as c:
        register(c)
        assert _submit(c, 50)
        assert c.post("/api/sightlines", json={"orientation": "edge", "b_kpc": 40, "azimuth_deg": 51}).status_code == 429
        c.app.state.limiter.refund("sightlines", "testclient")
        r = c.post("/api/sightlines", json={"orientation": "edge", "b_kpc": 40, "azimuth_deg": 51})
        assert r.status_code == 503                                     # queue full ...
        r = c.post("/api/sightlines", json={"orientation": "edge", "b_kpc": 40, "azimuth_deg": 52})
        assert r.status_code == 503                                     # ... and the 503 cost no token


class _Req:
    def __init__(self, xff=None, peer="5.5.5.5"):
        self.headers = {"x-forwarded-for": xff} if xff is not None else {}
        self.client = type("C", (), {"host": peer})()


def test_client_ip_rightmost_hops():
    assert client_ip(_Req("6.6.6.6, 1.2.3.4"), False) == "5.5.5.5"           # proxy not trusted
    assert client_ip(_Req("6.6.6.6, 1.2.3.4"), True) == "1.2.3.4"            # appended by the proxy
    assert client_ip(_Req("6.6.6.6, 1.2.3.4, 10.0.0.2"), True, 2) == "1.2.3.4"
    assert client_ip(_Req("1.2.3.4"), True, 3) == "1.2.3.4"                  # fewer hops than configured
    assert client_ip(_Req(""), True) == "5.5.5.5" and client_ip(_Req(" , "), True) == "5.5.5.5"


def test_rate_limiter_lru_cap():
    rl = RateLimiter({"s": (12, 1)}, max_clients=100)
    t0 = time.monotonic()
    for i in range(5000):
        rl.check("s", f"c{i}")
    assert len(rl) == 100 and time.monotonic() - t0 < 2.0
    assert rl.check("s", "c4999") > 0                                # recent bucket kept (still empty)
    assert rl.check("s", "c0") == 0                                  # oldest evicted


def test_token_bucket_refill():
    t = [0.0]
    b = TokenBucket(3600, 2, clock=lambda: t[0])           # 1 token / s
    assert b.take() == 0 and b.take() == 0 and b.take() == pytest.approx(1.0)
    t[0] = 0.5
    assert b.take() == pytest.approx(0.5)
    t[0] = 1.0
    assert b.take() == 0


def test_cors_and_private_network(libdir):
    with client_for(libdir, local_worker=False) as c:
        pre = {"Origin": "https://tanmay-starslab.github.io", "Access-Control-Request-Method": "POST",
               "Access-Control-Request-Headers": "content-type", "Access-Control-Request-Private-Network": "true"}
        r = c.options("/api/sightlines", headers=pre)
        assert r.status_code == 200
        assert r.headers["access-control-allow-origin"] == "https://tanmay-starslab.github.io"
        assert r.headers["access-control-allow-private-network"] == "true"
        assert "POST" in r.headers["access-control-allow-methods"]
        r = c.get("/api/health", headers={"Origin": "http://127.0.0.1:8000"})
        assert r.headers["access-control-allow-origin"] == "http://127.0.0.1:8000"
        r = c.get("/api/health", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in r.headers
        r = c.options("/api/sightlines", headers=dict(pre, Origin="https://evil.example"))
        assert r.status_code == 400 and "access-control-allow-origin" not in r.headers
    with client_for(libdir, local_worker=False, cors_origins=("https://x.test",)) as c:
        r = c.get("/api/health", headers={"Origin": "https://x.test"})
        assert r.headers["access-control-allow-origin"] == "https://x.test"


def test_body_limit(libdir):
    with client_for(libdir, local_worker=False) as c:
        big = json.dumps({"orientation": "face", "b_kpc": 1, "azimuth_deg": 0, "pad": "x" * 9000})
        r = c.post("/api/geometry", content=big, headers={"Content-Type": "application/json"})
        assert r.status_code == 413


# ------------------------------------------------------------------------------ figure
def test_figure_endpoint_cache_and_errors(libdir):
    calls = []

    def renderer(payload, fmt, **kw):
        calls.append((payload["id"], fmt, kw))
        return PNG + b"fake" if fmt == "png" else b"%PDF-1.4 fake"
    with client_for(libdir, local_worker=False, renderer=renderer, rl_figure=(60, 4)) as c:
        body = {"id": LIB_IDS[0], "R_lo": 20000, "R_hi": 40000, "sn_hi": 8, "sn_lo": 5, "vwin": 300,
                "intrinsic": False, "seed": 3, "fmt": "png"}
        r = c.post("/api/figure", json=body)
        assert r.status_code == 200 and r.content.startswith(PNG) and r.headers["content-type"] == "image/png"
        assert r.headers["content-disposition"].startswith("attachment;") and LIB_IDS[0] in r.headers["content-disposition"]
        assert calls[0][2] == {"R_lo": 20000, "R_hi": 40000, "sn_hi": 8.0, "sn_lo": 5.0, "intrinsic": False,
                               "vwin": 300.0, "seed": 3, "dpi": 240}
        assert c.post("/api/figure", json=body).content == r.content and len(calls) == 1      # LRU hit
        r = c.post("/api/figure", json=dict(body, fmt="pdf"))
        assert r.headers["content-type"] == "application/pdf" and len(calls) == 2
        assert c.post("/api/figure", json=dict(body, id="edge_b111_a000")).status_code == 404
        assert c.post("/api/figure", json=dict(body, id="../../x")).status_code == 422
        assert c.post("/api/figure", json=dict(body, fmt="svg")).status_code == 422
        assert c.post("/api/figure", json=dict(body, R_lo=10)).status_code == 422
        for bad in ({"R_hi": 41000}, {"sn_hi": 25}, {"sn_lo": 7.5}, {"seed": 100000}, {"vwin": 310}, {"vwin": 900}):
            assert c.post("/api/figure", json=dict(body, **bad)).status_code == 422, bad
        r = c.post("/api/figure", json=body)
        assert r.status_code == 429 and "retry-after" in r.headers


def test_figure_real_png(libdir):
    pytest.importorskip("tngsight.figure")
    with client_for(libdir, local_worker=False) as c:
        r = c.post("/api/figure", json={"id": LIB_IDS[0], "seed": 1, "fmt": "png"})
        assert r.status_code == 200 and r.content.startswith(PNG) and len(r.content) > 10000


# ------------------------------------------------------------------------------ units: queue, storage, HF
def test_jobqueue_positions_and_lease_order():
    q = JobQueue(cap=10)
    jobs = [q.submit({"id": f"face_b00{i}_a000"})[0] for i in range(3)]
    assert [q.position(j.job_id) for j in jobs] == [1, 2, 3]
    assert q.submit({"id": "face_b000_a000"})[1] is False
    assert q.lease("w").job_id == jobs[0].job_id
    assert [q.position(j.job_id) for j in jobs] == [None, 1, 2]
    q.fail(jobs[0].job_id, "x")                         # requeued at the front
    assert q.position(jobs[0].job_id) == 1


class FakeHfApi:
    """create_commit/list_repo_files stand-in. `fail` = exceptions raised by the next calls, in order."""

    def __init__(self, fail=(), remote=()):
        self.commits, self.fail, self.remote = [], list(fail), set(remote)

    def create_commit(self, **kw):
        if self.fail:
            raise self.fail.pop(0)
        self.commits.append(kw)
        self.remote |= {op.path_in_repo for op in kw["operations"]}

    def list_repo_files(self, **kw):
        return sorted(self.remote)


class _HTTPErr(Exception):
    def __init__(self, code):
        super().__init__(f"HTTP {code} for /secret/path")
        self.response = type("R", (), {"status_code": code})()


def test_jobqueue_stale_lease_cannot_touch_new_holder():
    t = [0.0]
    q = JobQueue(lease_s=2, max_attempts=3, clock=lambda: t[0])
    j, _ = q.submit({"id": "face_b001_a000"})
    a = q.lease("wA").lease_token
    t[0] = 5.0
    q.reap()                                               # A's lease expired -> requeued
    b = q.lease("wB").lease_token
    assert a != b and j.worker == "wB"
    assert q.progress(j.job_id, "ray", 0.5, "A", token=a) is False      # stale A cannot extend B
    assert q.fail(j.job_id, "A gave up", token=a) is None               # ... nor fail B's job
    assert j.status == "running" and q.progress(j.job_id, "ray", 0.5, token=b)


def test_jobqueue_requeue_and_late_complete_reemit_positions():
    import asyncio
    q = JobQueue(cap=10)
    a, b, c = (q.submit({"id": f"face_b00{i}_a000"})[0] for i in range(3))

    async def go():
        q.lease("w")
        qb, qc = q.subscribe(b.job_id), q.subscribe(c.job_id)
        q.fail(a.job_id, "x")                              # a requeued at the front: b, c move down
        await asyncio.sleep(0)
        got = [qb.get_nowait(), qc.get_nowait()]
        assert got == [("queued", {"position": 2}), ("queued", {"position": 3})]
        q.complete(a.job_id, {"id": a.id})                 # late result of the queued a: b, c move up
        await asyncio.sleep(0)
        assert [qb.get_nowait(), qc.get_nowait()] == [("queued", {"position": 1}), ("queued", {"position": 2})]
    asyncio.run(go())


def test_jobqueue_claim_blocks_concurrent_finish():
    q = JobQueue(cap=10, max_attempts=1)
    j, _ = q.submit({"id": "face_b001_a000"})
    tok = q.lease("w").lease_token
    assert q.claim(j.job_id) and not q.claim(j.job_id)     # second uploader is refused before persisting
    assert q.fail(j.job_id, "late fail", token=tok) is None and q.reap(now=time.time() + 1e6) == []
    q.unclaim(j.job_id)                                    # persisting failed: job is open again
    assert q.claim(j.job_id) and q.complete(j.job_id, {"id": j.id}) and not q.claim(j.job_id)
    k, _ = q.submit({"id": "face_b002_a000"})              # claim of a queued job takes it off the queue
    assert q.claim(k.job_id) and q.position(k.job_id) is None and q.lease("w") is None
    q.unclaim(k.job_id)
    assert q.position(k.job_id) == 1


def test_jobqueue_queued_ttl_and_expire():
    t = [0.0]
    q = JobQueue(cap=10, queue_ttl_s=100, clock=lambda: t[0])
    old, _ = q.submit({"id": "face_b001_a000"})
    t[0] = 50.0
    new, _ = q.submit({"id": "face_b002_a000"})
    t[0] = 120.0
    q.reap()
    assert old.status == "error" and "resubmit" in old.error and new.status == "queued"
    assert q.position(new.job_id) == 1 and "face_b001_a000" not in q.inflight
    assert q.expire_queued("no worker") == [new.job_id] and new.error == "no worker" and q.counts()["queued"] == 0


def test_no_worker_expires_queue_and_rejects(libdir):
    with client_for(libdir, local_worker=False, worker_seen_s=0.5, no_worker_grace_s=0.3) as c:
        register(c)
        j = _submit(c, 60)
        e = wait_job(c, j["job_id"], ("error",), timeout=10)            # worker vanished: not forever
        assert "no worker" in e["error"]
        r = c.post("/api/sightlines", json={"orientation": "edge", "b_kpc": 40, "azimuth_deg": 61})
        assert r.status_code == 503 and r.headers["retry-after"] == "60"
    from server.testing import BrokenLoadGenerator
    with client_for(libdir, gen=BrokenLoadGenerator, worker_token=None) as c:
        wait_for(lambda: c.get("/api/health").json()["workers"]["local"]["state"] == "error")
        r = c.post("/api/sightlines", json={"orientation": "edge", "b_kpc": 40, "azimuth_deg": 62})
        assert r.status_code == 503


def test_sse_stream_caps(libdir):
    with client_for(libdir, local_worker=False, max_sse_per_client=0) as c:
        register(c)
        j = _submit(c, 70)
        r = c.get(f"/api/jobs/{j['job_id']}/events")
        assert r.status_code == 429 and "retry-after" in r.headers
    with client_for(libdir, local_worker=False, max_subs_per_job=0) as c:
        register(c)
        j = _submit(c, 71)
        assert c.get(f"/api/jobs/{j['job_id']}/events").status_code == 429


def test_remote_worker_fatal_lease_and_409_after_done(libdir):
    with pytest.raises(ValueError):
        RemoteWorker("http://x", TOKEN, name="Tanmay MacBook")
    with client_for(libdir, local_worker=False, worker_token=None) as c:
        w = RemoteWorker("", TOKEN, name="w", generator=FakeGenerator(), client=c, poll_s=0.1)
        from server.workers import FatalLeaseError
        with pytest.raises(FatalLeaseError):                             # 404: never retried forever
            w.run(max_jobs=1)
    with client_for(libdir, local_worker=False) as c:
        register(c)
        j = _submit(c, 72)
        L_ = c.post("/api/worker/lease?wait=1", json={"name": "w"}, headers=AUTH).json()
        blob = payload_to_npz_bytes(FakeGenerator().generate(L_["geom"]))
        assert c.post(f"/api/worker/result/{j['job_id']}", content=blob, headers=AUTH).status_code == 200
        w = RemoteWorker("", TOKEN, name="w", generator=FakeGenerator(), client=c, poll_s=0.1)
        assert w.run_job(L_) is True and w.done == 1 and w.failed == 0   # 409 'already done' = our result


def test_store_reconcile_and_hfsync(libdir):
    api = FakeHfApi(fail=[ConnectionError("transient /Volumes/x")])
    hf = HFSync("tok", "user/ds", libdir, api=api, snapshot=lambda **kw: str(libdir), base_delay=0.01, batch_s=0.05)
    store = LibraryStore(libdir, hf=hf)
    p = FakeGenerator().generate(canonicalize("edge", 60, 61))
    e = store.add_generated(p)
    assert e["source"] == "generated"
    wait_for(lambda: api.commits and hf.pending() == 0, timeout=10)
    assert len(api.commits) == 1                                        # npz + bin in ONE commit
    assert {o.path_in_repo for o in api.commits[0]["operations"]} == {
        "generated/edge_b060_a061.npz", "generated/edge_b060_a061.bin"}
    assert api.commits[0]["repo_type"] == "dataset" and api.commits[0]["repo_id"] == "user/ds"
    st = hf.status()
    assert st["uploaded"] == 2 and st["last_error"] is None and st["disabled"] is False   # cleared on success
    hf.stop()
    # restart without the catalog row (e.g. a fresh Space after snapshot_download): reconcile restores it
    cat = json.loads((libdir / "catalog.json").read_text())
    cat["entries"] = [x for x in cat["entries"] if x["id"] != "edge_b060_a061"]
    (libdir / "catalog.json").write_text(json.dumps(cat))
    s2 = LibraryStore(libdir)
    assert not s2.has("edge_b060_a061") and s2.reconcile() == 1 and s2.has("edge_b060_a061")
    with pytest.raises(ValueError):
        s2.npz_path("../../etc/passwd")


def test_hfsync_never_drops_and_resumes(libdir):
    f = libdir / "generated" / "face_b001_a001.npz"
    f.parent.mkdir(exist_ok=True)
    f.write_bytes(b"x")
    down = FakeHfApi(fail=[ConnectionError("down")] * 1000)
    hf = HFSync("tok", "user/ds", libdir, api=down, base_delay=0.01, max_delay=0.02, max_tries=2, batch_s=0)
    hf.upload(f, "generated/face_b001_a001.npz")
    wait_for(lambda: len(down.fail) < 990, timeout=10)                  # well past max_tries
    assert hf.pending() == 1 and hf.status()["last_error"] == "upload: ConnectionError"
    hf.stop()
    # restart: the manifest still lists it, and it is uploaded once HF is back
    up = FakeHfApi()
    hf2 = HFSync("tok", "user/ds", libdir, api=up, base_delay=0.01, batch_s=0)
    assert hf2.pending() == 1
    hf2.start()
    wait_for(lambda: hf2.pending() == 0 and up.commits, timeout=10)
    hf2.stop()
    # read-only token: one 403 disables uploading (no retry loop); the item stays pending
    ro = FakeHfApi(fail=[_HTTPErr(403)])
    hf3 = HFSync("tok", "user/ds", libdir, api=ro, base_delay=0.01, batch_s=0)
    hf3.upload(f, "generated/face_b001_a001.npz")
    wait_for(lambda: hf3.status()["disabled"], timeout=10)
    assert hf3.pending() == 1 and "secret" not in hf3.status()["last_error"] and not ro.commits
    hf3.stop()


def test_hfsync_sync_missing(libdir):
    gen = libdir / "generated"
    gen.mkdir(exist_ok=True)
    for n in ("face_b002_a002.npz", "face_b002_a002.bin", "face_b003_a003.npz", "junk.npz"):
        (gen / n).write_bytes(b"x")
    api = FakeHfApi(remote={"generated/face_b003_a003.npz"})
    hf = HFSync("tok", "user/ds", libdir, api=api, base_delay=0.01, batch_s=0)
    assert hf.sync_missing(gen) == 2
    wait_for(lambda: hf.pending() == 0, timeout=10)
    assert {o.path_in_repo for c in api.commits for o in c["operations"]} == {
        "generated/face_b002_a002.npz", "generated/face_b002_a002.bin"}
    assert hf.sync_missing(gen) == 0
    hf.stop()


def test_hfsync_download_fails_fast_on_auth():
    calls = []

    def snap(**kw):
        calls.append(kw)
        raise _HTTPErr(401)
    hf = HFSync("tok", "user/ds", "/nonexistent-dir", api=FakeHfApi(), snapshot=snap, base_delay=5)
    t0 = time.monotonic()
    assert hf.download() is None and len(calls) == 1 and time.monotonic() - t0 < 1
    assert hf.status()["last_error"] == "download: _HTTPErr (HTTP 401)"


def test_startup_hf_download(libdir):
    seen = []
    hf = HFSync("tok", "user/ds", libdir, api=FakeHfApi(), snapshot=lambda **kw: seen.append(kw) or str(libdir))
    s = settings(libdir, local_worker=False, hf_token="tok", hf_dataset="user/ds")
    with TestClient(create_app(s, hf=hf)) as c:
        wait_for(lambda: seen)
        assert seen[0]["repo_type"] == "dataset" and seen[0]["local_dir"] == str(libdir)
        assert c.get("/api/health").json()["hf"]["repo"] == "user/ds"
    seen.clear()
    s = settings(libdir, local_worker=False, hf_token="tok", hf_dataset="user/ds", hf_startup_download=False)
    with TestClient(create_app(s, hf=hf)) as c:
        time.sleep(0.3)
        assert not seen                                          # start.sh already synced


def test_settings_from_env(tmp_path):
    s = Settings.from_env({"TNG_LIBRARY_DIR": str(tmp_path), "LOCAL_WORKER": "0", "WORKER_TOKEN": "t",
                           "CORS_ORIGINS": "https://a.test, https://b.test", "TRUST_PROXY": "1",
                           "NODE_NAME": "space", "PORT": "7860"})
    assert s.library_dir == tmp_path and s.local_worker is False and s.worker_token == "t"
    assert s.cors_origins == ("https://a.test", "https://b.test") and s.trust_proxy and s.port == 7860
    assert s.trusted_hops == 1 and s.hf_startup_download is True
    s = Settings.from_env({"TRUSTED_HOPS": "2", "HF_STARTUP_DOWNLOAD": "0"})
    assert s.trusted_hops == 2 and s.hf_startup_download is False
    d = Settings.from_env({})
    assert d.local_worker is True and d.worker_token is None and "https://tanmay-starslab.github.io" in d.cors_origins


# ------------------------------------------------------------------------------ production path: spawn
def test_local_worker_spawn_process(libdir):
    """The real LocalWorker path: spawn ProcessPoolExecutor + Manager queue progress relay."""
    s = settings(libdir, local_executor="process", generator="server.testing:SlowFakeGenerator")
    with TestClient(create_app(s)) as c:
        wait_for(lambda: c.get("/api/health").json()["warm"], timeout=600, every=0.5)
        pid = c.app.state.local.pid
        assert pid and pid != os.getpid()
        j = c.post("/api/sightlines", json={"orientation": "edge", "b_kpc": 70, "azimuth_deg": 70}).json()
        seen = set()

        def poll():
            s_ = c.get(f"/api/jobs/{j['job_id']}").json()
            seen.add(s_["stage"])
            return s_ if s_["status"] in ("done", "error") else None
        done = wait_for(poll, timeout=300, every=0.05)
        assert done["status"] == "done", done
        assert seen & {"spectrum:OVI", "spectrum:HILyb", "spectrum:CIII"}, seen     # relayed from the child
