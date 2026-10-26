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

from server.app import FIG_LAYOUTS, FIG_V_MAX, create_app  # noqa: E402
from server.jobs import JobQueue  # noqa: E402
from server.ratelimit import RateLimiter, TokenBucket, client_ip  # noqa: E402
from server.settings import Settings  # noqa: E402
from server.storage import HFSync, LibraryStore, npz_like  # noqa: E402
from server.testing import FakeGenerator  # noqa: E402
from server.workers import RemoteWorker, payload_to_npz_bytes  # noqa: E402
from tngsight import ions as I  # noqa: E402
from tngsight import library as L  # noqa: E402
from tngsight.geometry import canonicalize  # noqa: E402

TOKEN = "s3cret-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
LIB_IDS = ("edge_b100_a330", "face_b050_a090")
PNG = b"\x89PNG\r\n\x1a\n"
SCRATCH = Path(os.environ["TNG_TEST_TMP"]) if os.environ.get("TNG_TEST_TMP") else None


@pytest.fixture
def libdir(tmp_path):
    """Small seeded library (2 fake 'library' sightlines) under $TNG_TEST_TMP when set, else pytest's
    tmp_path (point --basetemp at the work volume: the internal disk of the dev Mac is full)."""
    if SCRATCH is not None:
        d = SCRATCH / uuid.uuid4().hex[:8]
    else:
        d = tmp_path / "lib"
    (d / "sightlines").mkdir(parents=True)
    gen, cat = FakeGenerator(), L.Catalog(d / "catalog.json")
    for i, sid in enumerate(LIB_IDS):
        o, b, a = sid.split("_")
        c = canonicalize(o, int(b[1:]), int(a[1:]))
        p = gen.generate(c)
        L.save_npz(d / "sightlines" / L.npz_name(sid), npz_like(p))
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


def write_v1_npz(path, sid):
    """A Phase-1/2 (npz v1) library file: OVI, HILyb, CIII on the 0.002 A grid (design.md §2.3 v1 members)."""
    o, b, a = sid.split("_")[:3]
    from tngsight.geometry import make_sightline
    g = make_sightline(canonicalize(o, int(b[1:]), int(a[1:]))["orientation"], int(b[1:]), int(a[1:]))
    out = {"geom": np.array(json.dumps(g, default=lambda x: x.tolist())), "v_sys": np.float64(g["v_sys_kms"])}
    for k, rest in (("OVI", 1031.912), ("HILyb", 1025.7223), ("CIII", 977.02)):
        lo = round(rest * (1 - 1500 / 299792.458) / 0.002) * 0.002
        hi = round(rest * (1 + 1500 / 299792.458) / 0.002) * 0.002
        lam = np.linspace(lo, hi, int(round((hi - lo) / 0.002 + 1))).astype(np.float32)
        v = 299792.458 * (lam.astype(float) / rest - 1)
        out[f"logN_{k}"] = np.float64(14.0)
        out[f"{k}_lambda"], out[f"{k}_rest"] = lam, np.float64(rest)
        out[f"{k}_tau"] = (1.5 * np.exp(-0.5 * ((v - 20) / 15) ** 2)).astype(np.float32)
    with open(path, "wb") as fh:
        np.savez_compressed(fh, **out)


def wait_for(fn, timeout=20.0, every=0.02):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        v = fn()
        if v:
            return v
        time.sleep(every)
    raise AssertionError("condition not met in time")


# HFSync waits: every wait polls its condition, so a pass returns as soon as the upload thread is done; the long
# ceiling only matters on a loaded machine (at load 9+ the earlier 10 s ceilings ran out). TNG_TEST_HF_WAIT overrides.
HF_WAIT = float(os.environ.get("TNG_TEST_HF_WAIT") or 120)


def hf_wait(fn):
    return wait_for(fn, timeout=HF_WAIT, every=0.05)


def hf_stop(hf):
    """Stop an HFSync and wait for its thread to end, so the next HFSync on the same manifest starts alone."""
    hf.stop()
    t = getattr(hf, "_t", None)
    if t is not None:
        t.join(HF_WAIT)
        assert not t.is_alive(), "hfsync thread did not stop"


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
        assert set(h) >= {"version", "warm", "workers", "queue", "registry_tag", "data_version", "ions"}
        assert h["registry_tag"] == I.registry_tag() and h["data_version"] == 2 and h["ions"] == list(I.KEYS)


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
        assert doc["version"] == 2 and {"galaxy", "ions", "registry_tag"} <= set(doc)
        assert all(e["data_version"] == 2 and e["lines"] == list(I.KEYS) for e in doc["entries"])
        assert [e["id"] for e in doc["entries"]] == list(LIB_IDS)
        assert all(e["source"] == "library" for e in doc["entries"])
        r2 = c.get("/api/catalog", headers={"If-None-Match": etag})
        assert r2.status_code == 304 and r2.headers["etag"] == etag


def test_sightline_bin_npz_and_ids(libdir):
    with client_for(libdir, local_worker=False) as c:
        r = c.get(f"/api/sightline/{LIB_IDS[0]}.bin")
        assert r.status_code == 200 and r.headers["content-type"] == "application/octet-stream"
        d = L.decode_web(r.content)
        assert d["version"] == 2 and list(d["lines"]) == list(I.KEYS) and d["lines"]["OVI"]["n"] == 3001
        r = c.get(f"/api/sightline/{LIB_IDS[1]}.npz")
        assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
        p = L.load_npz(io.BytesIO(r.content), id=LIB_IDS[1])
        assert p["format"] == 2 and p["tau"]["CIII"].shape == (12001,)
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
        assert L1["registry_tag"] == I.registry_tag()
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
        bad = dict(payload, tau=dict(payload["tau"], OVI=np.full(12001, np.nan, np.float32)))
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
        for k in I.KEYS:
            np.testing.assert_array_equal(stored["tau"][k], payload["tau"][k])
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
    with client_for(libdir, local_worker=False, renderer=renderer, rl_figure=(60, 6)) as c:
        pairs = {b: d["R"]["pair"] for b, d in I.BANDS.items()}
        body = {"id": LIB_IDS[0], "ions": ["OVII", "HI", "CIV"], "R": {"uv": [15000, 50000], "xray": [300, 3000]},
                "sn": [20, 5], "vhw": 300, "vc": -25.5, "intrinsic": False, "seed": 3, "fmt": "png"}
        r = c.post("/api/figure", json=body)
        assert r.status_code == 200 and r.content.startswith(PNG) and r.headers["content-type"] == "image/png"
        assert r.headers["content-disposition"].startswith("attachment;") and LIB_IDS[0] in r.headers["content-disposition"]
        assert calls[0][2] == {"ions": ["HI", "CIV", "OVII"], "R": {**pairs, "uv": [15000, 50000], "xray": [300, 3000]},
                               "sn": [20, 5], "vhw": 300, "vc": -25.5, "intrinsic": False, "seed": 3, "dpi": 240}
        assert c.post("/api/figure", json=body).content == r.content and len(calls) == 1      # LRU hit
        r = c.post("/api/figure", json=dict(body, fmt="pdf"))
        assert r.headers["content-type"] == "application/pdf" and len(calls) == 2
        # defaults from the registry; the v2 fields map onto the uv band, S/N and vhw (one release)
        c.post("/api/figure", json={"id": LIB_IDS[0]})
        assert calls[-1][2] == {"ions": list(I.DEFAULTS["ions"]), "R": pairs, "sn": list(I.SNR["pair"]),
                                "vhw": I.DEFAULTS["vhw_kms"], "vc": 0.0, "intrinsic": False, "dpi": 240}
        c.post("/api/figure", json={"id": LIB_IDS[0], "R_lo": 20000, "R_hi": 40000, "sn_hi": 8, "sn_lo": 5, "vwin": 300})
        assert calls[-1][2]["R"]["uv"] == [20000, 40000] and calls[-1][2]["sn"] == [8, 5] and calls[-1][2]["vhw"] == 300
        assert len(calls) == 4
        assert c.post("/api/figure", json=dict(body, id="edge_b111_a000")).status_code == 404
        assert c.post("/api/figure", json=dict(body, id="../../x")).status_code == 422
        assert c.post("/api/figure", json=dict(body, fmt="svg")).status_code == 422
        for bad in ({"ions": []}, {"ions": ["HILyb"]}, {"ions": ["HI", "HI"]}, {"ions": list(I.KEYS)[:7]},
                    {"R": {"uv": [4000, 50000]}}, {"R": {"xray": [300, 6000]}}, {"R": {"radio": [300, 600]}},
                    {"R": {"uv": [15000]}}, {"sn": [101, 5]}, {"sn": [20]}, {"sn": [1, 5]}, {"vhw": 5},
                    {"vhw": FIG_V_MAX + 1}, {"vc": FIG_V_MAX + 1}, {"seed": 100000}, {"R_lo": 200000}, {"sn_hi": 101},
                    {"vwin": 9}, {"layout": "3"}, {"layout": 4}, {"layout": "2x2"}):
            assert c.post("/api/figure", json=dict(body, **bad)).status_code == 422, bad
        r = c.post("/api/figure", json=body)                 # 6 charged requests (cache hits count): burst spent
        assert r.status_code == 429 and "retry-after" in r.headers


def test_figure_wide_window_and_layout(libdir):
    """C2 code 3: a damped H I window (the page allows vhw up to the line's vmax, 10000 km/s) no longer gets a 422,
    the page layout reaches the renderer (and the cache key), and /api/health announces both caps."""
    from tngsight import figure as F
    assert FIG_V_MAX == I.GRID["damped_v_max_kms"] and set(FIG_LAYOUTS) == set(F.LAYOUTS)
    calls = []

    def renderer(payload, fmt, **kw):
        calls.append(kw)
        return PNG + b"fake"
    with client_for(libdir, local_worker=False, renderer=renderer, rl_figure=(60, 20)) as c:
        h = c.get("/api/health").json()
        assert h["figure"] == {"layouts": list(FIG_LAYOUTS), "v_max_kms": FIG_V_MAX}
        body = {"id": LIB_IDS[0], "ions": ["HI", "OVI"], "sn": [20, 5], "vhw": 6500, "vc": -1200, "seed": 1, "fmt": "png"}
        r = c.post("/api/figure", json=body)
        assert r.status_code == 200, r.text
        assert calls[-1]["vhw"] == 6500 and calls[-1]["vc"] == -1200.0 and "layout" not in calls[-1]
        for lay in FIG_LAYOUTS:
            assert c.post("/api/figure", json=dict(body, layout=lay)).status_code == 200
            assert calls[-1]["layout"] == lay
        assert len(calls) == 1 + len(FIG_LAYOUTS)                       # each layout is its own cache entry
        assert c.post("/api/figure", json=dict(body, vhw=FIG_V_MAX, vc=FIG_V_MAX)).status_code == 200


def test_figure_real_png_wide_window(libdir):
    """The real renderer clamps a window wider than the lines' data to their coverage instead of failing, for every
    page layout (the 422 of a damped H I view is gone)."""
    pytest.importorskip("tngsight.figure")
    with client_for(libdir, local_worker=False, rl_figure=(60, 20)) as c:
        for lay in FIG_LAYOUTS:
            r = c.post("/api/figure", json={"id": LIB_IDS[0], "ions": ["HI", "OVI"], "vhw": 8000, "vc": 3000,
                                            "layout": lay, "seed": 1, "fmt": "png"})
            assert r.status_code == 200 and r.content.startswith(PNG), (lay, r.text)


def test_figure_real_png(libdir):
    pytest.importorskip("tngsight.figure")
    with client_for(libdir, local_worker=False) as c:
        r = c.post("/api/figure", json={"id": LIB_IDS[0], "seed": 1, "fmt": "png"})
        assert r.status_code == 200 and r.content.startswith(PNG) and len(r.content) > 10000
        r = c.post("/api/figure", json={"id": LIB_IDS[0], "ions": ["MgII", "NeVIII", "OVII"], "R": {"euv": [5000, 150000]},
                                        "sn": [100, 2], "vhw": 10, "seed": 2, "fmt": "png"})
        assert r.status_code == 200 and r.content.startswith(PNG)


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
    """create_commit/list_repo_files stand-in. `fail` = exceptions raised by the next calls, in order. `gate`
    (a threading.Event): every create_commit waits for it first, so a test decides when the upload thread may
    proceed instead of racing it."""

    def __init__(self, fail=(), remote=(), gate=None):
        self.commits, self.fail, self.remote, self.gate = [], list(fail), set(remote), gate

    def create_commit(self, **kw):
        if self.gate is not None:
            assert self.gate.wait(HF_WAIT), "test never opened the commit gate"
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
    # The first commit attempt fails (transient). The gate holds that attempt until add_generated has queued all three
    # files, so the retry, the one commit that succeeds, batches them however slowly a loaded machine runs.
    gate = threading.Event()
    api = FakeHfApi(fail=[ConnectionError("transient /Volumes/x")], gate=gate)
    hf = HFSync("tok", "user/ds", libdir, api=api, snapshot=lambda **kw: str(libdir), base_delay=0.01, batch_s=0.05)
    store = LibraryStore(libdir, hf=hf)
    p = FakeGenerator().generate(canonicalize("edge", 60, 61))
    e = store.add_generated(p)
    assert e["source"] == "generated" and hf.pending() == 3
    gate.set()
    hf_wait(lambda: api.commits and hf.pending() == 0)
    assert len(api.commits) == 1                              # npz + bin + components in ONE commit
    assert {o.path_in_repo for o in api.commits[0]["operations"]} == {
        "generated/edge_b060_a061.npz", "generated/edge_b060_a061.bin",
        "generated/edge_b060_a061.components.json"}
    assert api.commits[0]["repo_type"] == "dataset" and api.commits[0]["repo_id"] == "user/ds"
    st = hf.status()
    assert st["uploaded"] == 3 and st["last_error"] is None and st["disabled"] is False   # cleared on success
    hf_stop(hf)
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
    hf_wait(lambda: len(down.fail) < 990)                                # well past max_tries
    assert hf.pending() == 1 and hf.status()["last_error"] == "upload: ConnectionError"
    hf_stop(hf)
    # restart: the manifest still lists it, and it is uploaded once HF is back
    up = FakeHfApi()
    hf2 = HFSync("tok", "user/ds", libdir, api=up, base_delay=0.01, batch_s=0)
    assert hf2.pending() == 1
    hf2.start()
    hf_wait(lambda: hf2.pending() == 0 and up.commits)
    hf_stop(hf2)
    # read-only token: one 403 disables uploading (no retry loop); the item stays pending
    ro = FakeHfApi(fail=[_HTTPErr(403)])
    hf3 = HFSync("tok", "user/ds", libdir, api=ro, base_delay=0.01, batch_s=0)
    hf3.upload(f, "generated/face_b001_a001.npz")
    hf_wait(lambda: hf3.status()["disabled"])
    assert hf3.pending() == 1 and "secret" not in hf3.status()["last_error"] and not ro.commits
    hf_stop(hf3)
    # hf_xet reports the same 403 as a bare RuntimeError carrying only a message
    xet = FakeHfApi(fail=[RuntimeError("Network error: HTTP status client error (403 Forbidden), "
                                       "domain: https://huggingface.co/api/datasets/user/ds/xet-write-token/main")])
    hf4 = HFSync("tok", "user/ds", libdir, api=xet, base_delay=0.01, batch_s=0)
    hf4.upload(f, "generated/face_b001_a001.npz")
    hf_wait(lambda: hf4.status()["disabled"])
    assert hf4.pending() == 1 and not xet.commits
    hf_stop(hf4)


def test_hfsync_sync_missing(libdir):
    gen = libdir / "generated"
    gen.mkdir(exist_ok=True)
    for n in ("face_b002_a002.npz", "face_b002_a002.bin", "face_b003_a003.npz", "junk.npz"):
        (gen / n).write_bytes(b"x")
    api = FakeHfApi(remote={"generated/face_b003_a003.npz"})
    hf = HFSync("tok", "user/ds", libdir, api=api, base_delay=0.01, batch_s=0)
    assert hf.sync_missing(gen) == 2
    hf_wait(lambda: hf.pending() == 0)
    assert {o.path_in_repo for c in api.commits for o in c["operations"]} == {
        "generated/face_b002_a002.npz", "generated/face_b002_a002.bin"}
    assert hf.sync_missing(gen) == 0
    hf_stop(hf)


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
        assert seen[0]["ignore_patterns"] == ["vol/*", "components/*"]
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
        assert seen & {f"spectrum:{k}" for k in I.KEYS}, seen                  # relayed from the child


# ------------------------------------------------------------------------------ Phase 2: custom rays
from server.storage import ID_RE, validate_components  # noqa: E402
from server.testing import fake_components  # noqa: E402
from tngsight.geometry import canonicalize_endpoints, make_endpoints  # noqa: E402

CUSTOM = {"p0_kpc": [-100, 0, 0], "p1_kpc": [100, 0, 0]}         # golden id cust_35277e0469
CAPS_ALL = ["endpoints", "fit"]


def register_caps(c, name="w2", caps=CAPS_ALL):
    assert c.post("/api/worker/lease?wait=0", json={"name": name, "caps": caps}, headers=AUTH).status_code == 204


def _custom(x, length=60.0):
    """A valid custom body; x shifts it (distinct ids)."""
    return {"p0_kpc": [x, -length / 2, 10.0], "p1_kpc": [x, length / 2, 10.0]}


def _sse(c, job_id):
    with c.stream("GET", f"/api/jobs/{job_id}/events") as r:
        lines = list(r.iter_lines())
    evs, cur = [], None
    for ln in lines:
        if ln.startswith("event:"):
            cur = ln.split(":", 1)[1].strip()
        elif ln.startswith("data:") and cur:
            evs.append((cur, json.loads(ln[5:])))
    return evs


def test_custom_id_regex():
    for good in ("cust_35277e0469", "cust_0123456789", "face_b050_a090", "rand_b005_a134_s1"):
        assert ID_RE.fullmatch(good)
    for bad in ("cust_ABCDEF0123", "cust_123", "cust_0123456789a", "cust_", "cust_0123456789\n", "cust_zz23456789"):
        assert not ID_RE.fullmatch(bad), bad
    assert not ID_RE.match("cust_ABCDEF0123") and not ID_RE.match("cust_123")


def test_custom_geometry_endpoint(libdir):
    with client_for(libdir, local_worker=False) as c:
        r = c.post("/api/geometry/custom", json={"p0_kpc": [12.34, -56.78, 90.05], "p1_kpc": [-200.0, 150.25, -0.04]})
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["id"] == "cust_b7fe2279d7" and j["exists"] is False
        assert j["canonical"] == {"p0_kpc": [12.3, -56.8, 90.0], "p1_kpc": [-200.0, 150.2, 0.0]}
        g = make_endpoints(j["canonical"]["p0_kpc"], j["canonical"]["p1_kpc"])
        assert j["geom"]["orientation"] == "custom" and j["geom"]["kind"] == "endpoints"
        np.testing.assert_allclose(j["geom"]["start_ckpch"], g["start_ckpch"], rtol=1e-15)
        assert c.post("/api/geometry/custom", json={"p0_kpc": [0, 0, 0], "p1_kpc": [5, 0, 0]}).status_code == 422


def test_custom_submit_sse_ready_and_dedupe(libdir):
    GATE.clear()
    with client_for(libdir, gen=GatedGenerator) as c:
        warm(c)
        a = c.post("/api/sightlines/custom", json=CUSTOM)
        assert a.status_code == 202, a.text
        a = a.json()
        assert a["id"] == "cust_35277e0469" and a["status"] in ("queued", "running")
        assert a["canonical"] == {"p0_kpc": [-100.0, 0.0, 0.0], "p1_kpc": [100.0, 0.0, 0.0]}
        # same canonical endpoints (after 0.1 kpc quantisation) while in flight -> the same job
        b = c.post("/api/sightlines/custom", json={"p0_kpc": [-100.04, 0.01, 0], "p1_kpc": [100, -0.02, 0.0]})
        assert b.status_code == 202 and b.json()["job_id"] == a["job_id"]
        # the reversed ray is a different sightline
        rv = c.post("/api/sightlines/custom", json={"p0_kpc": CUSTOM["p1_kpc"], "p1_kpc": CUSTOM["p0_kpc"]}).json()
        assert rv["id"] != a["id"] and rv["job_id"] != a["job_id"]
        wait_job(c, a["job_id"], ("running",))
        assert c.get(f"/api/jobs/{a['job_id']}").json()["kind"] == "endpoints"
        evs, err = [], []

        def read():
            try:
                evs.extend(_sse(c, a["job_id"]))
            except Exception as e:  # pragma: no cover
                err.append(e)
        t = threading.Thread(target=read)
        t.start()
        wait_for(lambda: a["job_id"] in c.app.state.jobs._subs)
        GATE.set()
        t.join(60)
        assert not err and not t.is_alive()
        stages = [d["stage"] for e, d in evs if e == "progress"]
        assert "fit" in stages and stages.index("fit") > stages.index(f"spectrum:{I.KEYS[-1]}")
        assert stages.index("fit") < stages.index("save")
        ev, done = evs[-1]
        assert ev == "done" and done["id"] == a["id"]
        e = done["entry"]
        assert e["orientation"] == "custom" and e["kind"] == "endpoints" and e["seed"] is None
        assert e["p0"] == [-100.0, 0.0, 0.0] and e["p1"] == [100.0, 0.0, 0.0]
        assert e["has_components"] is True and set(e["n_fit"]) == set(I.KEYS)
        assert e["length_kpc"] == 200.0 and e["b_segment_kpc"] == e["b_kpc"] == 0.0
        assert set(done["components"]) == set(I.KEYS)                      # v2 rows {k: [[...], ...]}
        validate_components(done["components"])
        snap = c.get(f"/api/jobs/{a['job_id']}").json()
        assert snap["components"] == done["components"]
        assert (libdir / "generated" / "cust_35277e0469.npz").is_file()
        assert (libdir / "generated" / "cust_35277e0469.components.json").is_file()
        stored = L.load_npz(libdir / "generated" / "cust_35277e0469.npz")
        assert stored["id"] == "cust_35277e0469" and stored["geom"]["kind"] == "endpoints"
        r = c.post("/api/sightlines/custom", json=CUSTOM)
        assert r.status_code == 200 and r.json()["status"] == "ready" and r.json()["entry"]["id"] == a["id"]
        assert r.json()["canonical"] == a["canonical"]
        assert c.get("/api/sightline/cust_35277e0469.bin").status_code == 200
        assert c.get("/api/sightline/cust_35277e0469.npz").status_code == 200
        assert "cust_35277e0469" in [x["id"] for x in c.get("/api/catalog").json()["entries"]]
        assert wait_job(c, rv["job_id"])["status"] == "done"
        # replayed terminal event of a finished job carries the components too
        ev, d = _sse(c, a["job_id"])[-1]
        assert ev == "done" and d["components"] == done["components"]
        assert c.post("/api/geometry/custom", json=CUSTOM).json()["exists"] is True
    GATE.set()


BAD_CUSTOM = [
    ({"p0_kpc": [0, 0, 0]}, "p1_kpc"),                                         # missing key
    ({"p0_kpc": [0, 0], "p1_kpc": [50, 0, 0]}, "p0_kpc"),                      # length 2
    ({"p0_kpc": [0, "1", 0], "p1_kpc": [50, 0, 0]}, "p0_kpc"),                 # string item
    ('{"p0_kpc": [NaN, 0, 0], "p1_kpc": [50, 0, 0]}', "p0_kpc"),               # NaN literal
    ('{"p0_kpc": [0, 0, 0], "p1_kpc": [Infinity, 0, 0]}', "p1_kpc"),           # inf literal
    ({"p0_kpc": [395.1, 0, 0], "p1_kpc": [0, 0, 0]}, "exceeds 395"),           # |p| > 395
    ({"p0_kpc": [0, 0, 0], "p1_kpc": [0, 19.9, 0]}, "length 19.9"),            # too short
    ({"p0_kpc": [-300, -260, 0], "p1_kpc": [300, 250, 1]}, "p0_kpc: |p| = 397.0 kpc exceeds 395 kpc"),
    ({"p0_kpc": [0, 0, 0], "p1_kpc": [50, 0, 0], "id": "cust_0000000000"}, "id"),   # extra field
    ({"p0_kpc": [True, 0, 0], "p1_kpc": [50, 0, 0]}, "p0_kpc"),                # bool item
    ({"p0_kpc": [1e5, 0, 0], "p1_kpc": [50, 0, 0]}, "p0_kpc"),                 # pre-check |x| <= 1e4
]


@pytest.mark.parametrize("body,needle", BAD_CUSTOM)
def test_custom_submit_422(libdir, body, needle):
    with client_for(libdir, local_worker=False) as c:
        register_caps(c)
        if isinstance(body, str):
            r = c.post("/api/sightlines/custom", content=body, headers={"Content-Type": "application/json"})
        else:
            r = c.post("/api/sightlines/custom", json=body)
        assert r.status_code == 422, r.text
        assert needle in json.dumps(r.json()["detail"]), r.json()
        assert c.get("/api/health").json()["queue"]["queued"] == 0


def test_custom_too_long_rejected(libdir, monkeypatch):
    """L_CUSTOM_MAX_KPC = 800 cannot bind while |p| <= 395 (the longest legal ray is 790 kpc):
    relax R to reach it and check the length bound itself through the API."""
    from tngsight import geometry as G
    monkeypatch.setattr(G, "R_CUSTOM_MAX_KPC", 500.0)
    with client_for(libdir, local_worker=False) as c:
        register_caps(c)
        r = c.post("/api/sightlines/custom", json={"p0_kpc": [-400, 0, 0], "p1_kpc": [400.1, 0, 0]})
        assert r.status_code == 422 and "length 800.1" in r.json()["detail"]
        assert c.post("/api/sightlines/custom", json={"p0_kpc": [-400, 0, 0], "p1_kpc": [400, 0, 0]}).status_code == 202


def test_custom_rate_limit_shared_with_sightlines(libdir):
    with client_for(libdir, local_worker=False, rl_sightlines=(12, 4)) as c:
        register_caps(c)
        for az in range(2):
            assert _submit(c, az)
        for x in (1, 2):
            assert c.post("/api/sightlines/custom", json=_custom(x)).status_code == 202
        r = c.post("/api/sightlines/custom", json=_custom(3))
        assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
        assert c.post("/api/sightlines", json={"orientation": "edge", "b_kpc": 40, "azimuth_deg": 3}).status_code == 429
        assert c.post("/api/sightlines/custom", json=_custom(1)).status_code == 202     # dedupe: not charged


def test_custom_503_without_capable_worker(libdir):
    with client_for(libdir, local_worker=False) as c:
        r = c.post("/api/sightlines/custom", json=CUSTOM)
        assert r.status_code == 503 and r.headers["retry-after"] == "60"
        register(c, "old")                                     # Phase-1 worker: no caps
        r = c.post("/api/sightlines/custom", json=CUSTOM)
        assert r.status_code == 503 and r.json()["detail"] == "no worker that supports custom rays is available"
        assert r.headers["retry-after"] == "60"
        h = c.get("/api/health").json()
        assert [(w["name"], w["caps"]) for w in h["workers"]["remote"]] == [("old", [])]
        register_caps(c, "new")
        assert c.post("/api/sightlines/custom", json=CUSTOM).status_code == 202
        h = c.get("/api/health").json()
        assert {w["name"]: w["caps"] for w in h["workers"]["remote"]} == {"old": [], "new": CAPS_ALL}
        assert _submit(c, 5)                                   # orientation rays accepted as before
        assert c.post("/api/worker/lease?wait=0", json={"name": "x", "caps": ["warp"]}, headers=AUTH).status_code == 422
    with client_for(libdir, local_worker=False, worker_token=None) as c:
        r = c.post("/api/sightlines/custom", json=CUSTOM)
        assert r.status_code == 503 and "retry-after" in r.headers
    with client_for(libdir) as c:                              # the local worker runs custom rays
        warm(c)
        assert c.post("/api/sightlines/custom", json=CUSTOM).status_code == 202


def test_capless_lease_never_gets_endpoints_job(libdir):
    with client_for(libdir, local_worker=False) as c:
        register_caps(c, "new")
        jc = c.post("/api/sightlines/custom", json=CUSTOM).json()      # oldest job: endpoints
        jo = _submit(c, 20)
        r = c.post("/api/worker/lease?wait=0.2", json={"name": "old"}, headers=AUTH)
        assert r.status_code == 200 and r.json()["job_id"] == jo["job_id"]          # skips the custom job
        assert c.post("/api/worker/lease?wait=0.2", json={"name": "old"}, headers=AUTH).status_code == 204
        assert c.get(f"/api/jobs/{jc['job_id']}").json()["position"] == 1
        r = c.post("/api/worker/lease?wait=0.2", json={"name": "new", "caps": CAPS_ALL}, headers=AUTH)
        assert r.status_code == 200 and r.json()["job_id"] == jc["job_id"]
        g = r.json()["geom"]
        assert g == {"kind": "endpoints", "p0_kpc": [-100.0, 0.0, 0.0], "p1_kpc": [100.0, 0.0, 0.0],
                     "id": "cust_35277e0469"}


def test_jobqueue_caps_order():
    q = JobQueue(cap=10)
    a = q.submit(canonicalize_endpoints([0, 0, 0], [50, 0, 0]))[0]
    b = q.submit({"id": "face_b001_a000"})[0]
    assert a.kind == "endpoints" and b.kind == "orientation"
    assert q.lease("old").job_id == b.job_id and q.lease("old") is None
    assert q.lease("new", caps=("endpoints",)).job_id == a.job_id
    q.touch_worker("w", caps=("endpoints", "fit"))
    q.touch_worker("w")                                        # a progress touch keeps the caps
    assert q.worker_caps("w") == ("endpoints", "fit") and q.live_workers(60) == {"w": ("endpoints", "fit")}


def test_validate_result_components_and_endpoint_geom(libdir):
    with client_for(libdir, local_worker=False) as c:
        register_caps(c)
        j = c.post("/api/sightlines/custom", json=CUSTOM).json()
        L1 = c.post("/api/worker/lease?wait=1", json={"name": "w2", "caps": CAPS_ALL}, headers=AUTH).json()
        payload = FakeGenerator(components="fake").generate(L1["geom"])
        assert "components" in payload
        url = f"/api/worker/result/{j['job_id']}"
        # endpoint geometry mismatch: a different custom ray
        other = FakeGenerator().generate(canonicalize_endpoints([-100, 0, 0], [100, 0.1, 0]))
        r = c.post(url, content=payload_to_npz_bytes(other), headers=AUTH)
        assert r.status_code == 422 and "geom" in r.json()["detail"]
        # an orientation result for an endpoints job
        r = c.post(url, content=payload_to_npz_bytes(FakeGenerator().generate(canonicalize("face", 0, 0))), headers=AUTH)
        assert r.status_code == 422 and "geom" in r.json()["detail"]
        # malformed components
        for bad in ({"HILyb": []}, {"OVI": [], "NaI": []}, {},
                    dict(payload["components"], OVI=[{"v": 0}]),
                    dict(payload["components"], OVI=[[0, 1]]),
                    dict(payload["components"], OVI=[dict(payload["components"]["OVI"][0], logN=25.0)]),
                    dict(payload["components"], OVI=[dict(payload["components"]["OVI"][0], flag=256)])):
            r = c.post(url, content=payload_to_npz_bytes(dict(payload, components=bad)), headers=AUTH)
            assert r.status_code == 422 and "components" in r.json()["detail"], r.text
        blob = payload_to_npz_bytes(payload)
        names = zipfile_names(blob)
        assert "components_json.npy" in names and len(names) == 5 + 6 * len(I.KEYS) + 1
        # a non-finite number inside components_json
        txt = json.dumps(payload["components"]).replace('"dv": 0.1', '"dv": NaN', 1)
        assert "NaN" in txt
        r = c.post(url, content=_with_member(payload, txt), headers=AUTH)
        assert r.status_code == 422
        assert c.get(f"/api/jobs/{j['job_id']}").json()["status"] == "running"
        r = c.post(url, content=blob, headers=AUTH)
        assert r.status_code == 200, r.text
        e = r.json()["entry"]
        assert e["has_components"] is True and e["orientation"] == "custom"
        snap = c.get(f"/api/jobs/{j['job_id']}").json()
        assert snap["status"] == "done" and validate_components(snap["components"]) == payload["components"]
        doc = c.get(f"/api/components/{j['id']}.json").json()
        assert doc["aod"] == payload["components_aod"]                        # transported with the rows
        # without components_json a result is still accepted (Phase-1 schema)
        j2 = _submit(c, 30)
        L2 = c.post("/api/worker/lease?wait=1", json={"name": "w2", "caps": CAPS_ALL}, headers=AUTH).json()
        p2 = FakeGenerator(components=None).generate(L2["geom"])
        assert "components" not in p2 and len(zipfile_names(payload_to_npz_bytes(p2))) == 5 + 6 * len(I.KEYS)
        assert c.post(f"/api/worker/result/{j2['job_id']}", content=payload_to_npz_bytes(p2), headers=AUTH).status_code == 200


def zipfile_names(blob):
    import zipfile
    return zipfile.ZipFile(io.BytesIO(blob)).namelist()


def _with_member(payload, text):
    import zipfile
    blob = payload_to_npz_bytes(dict(payload, components=None))
    out = io.BytesIO(blob)
    m = io.BytesIO()
    np.lib.format.write_array(m, np.array(text), allow_pickle=False)
    with zipfile.ZipFile(out, "a") as zf:
        zf.writestr("components_json.npy", m.getvalue())
    return out.getvalue()


def test_components_api(libdir):
    with client_for(libdir, local_worker=False) as c:
        r = c.get("/api/components")
        assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["entries"] == {}
        store = c.app.state.store
        p = FakeGenerator(components="fake").generate(canonicalize_endpoints(**CUSTOM))
        e = store.add_generated(p)
        assert e["has_components"] is True and e["n_fit"] == {k: len(v) for k, v in p["components"].items()}
        r = c.get("/api/components")
        doc = r.json()
        assert set(doc) == {"version", "fitter", "params_tag", "comp_keys", "entries", "aod"}
        assert doc["comp_keys"] == ["v", "dv", "logN", "dlogN", "b", "db", "region", "flag", "EW"]
        assert validate_components(doc["entries"]["cust_35277e0469"]) == p["components"]
        assert all(isinstance(r_, list) for v in doc["entries"]["cust_35277e0469"].values() for r_ in v)
        assert doc["aod"] == {"cust_35277e0469": p["components_aod"]}
        etag = r.headers["etag"]
        assert c.get("/api/components", headers={"If-None-Match": etag}).status_code == 304
        assert r.headers["cache-control"] == "max-age=60"
        r = c.get("/api/components/cust_35277e0469.json")
        assert r.status_code == 200 and r.json()["id"] == "cust_35277e0469"
        assert validate_components(r.json()["components"]) == p["components"]
        assert set(r.json()) == {"version", "id", "fitter", "params_tag", "comp_keys", "components", "aod"}
        assert r.json()["version"] == 2
        assert c.get("/api/components/cust_0000000000.json").status_code == 404
        assert c.get(f"/api/components/{LIB_IDS[0]}.json").status_code == 404     # library entry, none stored
        assert c.get("/api/components/cust_ZZ.json").status_code == 422
        assert c.get("/api/components/cust_35277e0469").status_code == 422
        # a second sightline invalidates the ETag; one without components is not listed
        from server.storage import _components_mod
        store.add_generated(FakeGenerator(components=None).generate(canonicalize("face", 9, 9)))
        if _components_mod() is None:                     # no fitter installed: nothing to back-fill
            assert c.get("/api/components").headers["etag"] == etag
        store.add_generated(FakeGenerator(components="fake").generate(canonicalize("face", 9, 10)))
        assert c.get("/api/components").headers["etag"] != etag


def test_store_components_persist_reconcile_and_hf(libdir, monkeypatch):
    api = FakeHfApi()
    hf = HFSync("tok", "user/ds", libdir, api=api, base_delay=0.01, batch_s=0.05)
    store = LibraryStore(libdir, hf=hf)
    p = FakeGenerator(components="fake").generate(canonicalize_endpoints(**CUSTOM))
    comps = p.pop("components")
    p.pop("components_aod")
    e = store.add_generated(p, components=comps)               # explicit argument
    assert e["has_components"] is True
    hf_wait(lambda: hf.pending() == 0 and api.commits)
    # (union over commits: on a loaded machine the 50 ms batch window can split npz + bin from the components file)
    assert "generated/cust_35277e0469.components.json" in {o.path_in_repo for c_ in api.commits for o in c_["operations"]}
    doc = json.loads((libdir / "generated" / "cust_35277e0469.components.json").read_text())
    assert doc["id"] == "cust_35277e0469" and doc["version"] == 2 and validate_components(doc["components"]) == comps
    hf.stop()
    # sync_missing re-queues component files the dataset lacks
    api2 = FakeHfApi(remote=["generated/cust_35277e0469.npz", "generated/cust_35277e0469.bin"])
    hf2 = HFSync("tok", "user/ds", libdir, api=api2, base_delay=0.01, batch_s=0.05)
    assert hf2.sync_missing(libdir / "generated") == 1
    hf_wait(lambda: hf2.pending() == 0)
    hf_stop(hf2)
    # restart without the catalog row: reconcile restores it with has_components from the stored file
    cat = json.loads((libdir / "catalog.json").read_text())
    cat["entries"] = [x for x in cat["entries"] if x["id"] != "cust_35277e0469"]
    (libdir / "catalog.json").write_text(json.dumps(cat))
    s2 = LibraryStore(libdir)
    assert s2.reconcile(backfill=False) == 1
    e2 = s2.entry("cust_35277e0469")
    assert e2["has_components"] is True and e2["orientation"] == "custom" and e2["p0"] == [-100.0, 0.0, 0.0]
    # a corrupt component file is ignored, not served
    (libdir / "generated" / "cust_35277e0469.components.json").write_text('{"id": "x", "components": {"OVI": 1}}')
    assert LibraryStore(libdir).components("cust_35277e0469") is None
    # add_generated without components: (a) no fitter installed -> persisted without components
    import server.storage as storage_mod
    p3 = FakeGenerator(components=None).generate(canonicalize("edge", 3, 3))
    with monkeypatch.context() as m:
        m.setattr(storage_mod, "_components_mod", lambda: None)
        e3 = s2.add_generated(p3)
    assert e3["has_components"] is False and "n_fit" not in e3
    assert not s2.components_path(p3["id"]).exists() and (libdir / "generated" / f"{p3['id']}.npz").is_file()
    # (b) a fitter (stub) -> best-effort fit in the calling thread, stored and flagged
    import tngsight.components as comp_mod
    p4 = FakeGenerator(components=None).generate(canonicalize("edge", 3, 4))
    stub = fake_components({"OVI": [(1.0, 10.0, 20.0)], "HI": [], "CIII": []})
    calls = []
    monkeypatch.setattr(comp_mod, "fit_payload", lambda payload, *a, **k: calls.append(payload["id"]) or stub)
    e4 = s2.add_generated(p4)
    assert calls == [p4["id"]] and e4["has_components"] is True and e4["n_fit"] == {"HI": 0, "CIII": 0, "OVI": 1}
    assert validate_components(s2.components(p4["id"])["components"]) == validate_components(stub)
    # (c) the worker's fit was attempted and failed (components_skipped): not repeated while finishing
    p5 = FakeGenerator(components=None).generate(canonicalize("edge", 3, 5))
    p5["components_skipped"] = True
    e5 = s2.add_generated(p5)
    assert calls == [p4["id"]] and e5["has_components"] is False


def _raise_fit(*a, **k):
    raise RuntimeError("fit exploded")


def test_failing_fit_keeps_sightline_local_worker(libdir, monkeypatch):
    """A fit that raises: progress "fit"/"skipped", job DONE, sightline persisted without components, and
    the coordinator does not re-run the fit."""
    import tngsight.components as comp_mod
    calls = []
    monkeypatch.setattr(comp_mod, "fit_payload", lambda *a, **k: calls.append(1) or _raise_fit())
    seen = []
    p = FakeGenerator().generate(canonicalize("edge", 7, 7), progress=lambda s, f, m="": seen.append((s, m)))
    assert ("fit", "skipped") in seen and p.get("components_skipped") is True and "components" not in p
    calls.clear()
    with client_for(libdir) as c:
        warm(c)
        j = _submit(c, 71)
        s = wait_job(c, j["job_id"])
        assert s["status"] == "done", s
        sid = s["entry"]["id"]
        assert s["entry"]["has_components"] is False and s.get("components") is None
        store = c.app.state.store
        assert store.entry(sid)["has_components"] is False and store.components(sid) is None
        assert (libdir / "generated" / f"{sid}.npz").is_file() and (libdir / "generated" / f"{sid}.bin").is_file()
        assert c.get(f"/api/sightline/{sid}.bin").status_code == 200
        assert calls == [1]                                    # the worker's attempt only


def test_failing_fit_keeps_sightline_remote_worker(libdir, monkeypatch):
    import tngsight.components as comp_mod
    calls = []
    monkeypatch.setattr(comp_mod, "fit_payload", lambda *a, **k: calls.append(1) or _raise_fit())
    with client_for(libdir, local_worker=False) as c:
        register_caps(c, name="laptop")
        j = _submit(c, 72)
        w = RemoteWorker("", TOKEN, name="laptop", generator=FakeGenerator(), client=c, poll_s=1.0, heartbeat_s=0.2)
        assert w.run(max_jobs=1) == 1 and w.done == 1
        s = c.get(f"/api/jobs/{j['job_id']}").json()
        assert s["status"] == "done" and s["entry"]["has_components"] is False and s.get("components") is None
        sid = s["entry"]["id"]
        assert c.app.state.store.components(sid) is None
        assert (libdir / "generated" / f"{sid}.npz").is_file() and (libdir / "generated" / f"{sid}.bin").is_file()
        assert calls == [1]


def test_skipped_fit_transport_member():
    p = FakeGenerator(components=None).generate(canonicalize("face", 50, 90))
    p["components_skipped"] = True
    import zipfile
    names = lambda blob: sorted(zipfile.ZipFile(io.BytesIO(blob)).namelist())  # noqa: E731
    assert "components_json.npy" in names(payload_to_npz_bytes(p))
    with np.load(io.BytesIO(payload_to_npz_bytes(p))) as z:
        assert str(z["components_json"]) == "null"
    assert "components_json.npy" not in names(payload_to_npz_bytes(p, with_components=False))


def test_custom_figure_png(libdir):
    pytest.importorskip("tngsight.figure")
    with client_for(libdir, local_worker=False) as c:
        c.app.state.store.add_generated(FakeGenerator().generate(canonicalize_endpoints(**CUSTOM)))
        r = c.post("/api/figure", json={"id": "cust_35277e0469", "seed": 1, "fmt": "png"})
        assert r.status_code == 200 and r.content.startswith(PNG) and len(r.content) > 10000
        assert "cust_35277e0469" in r.headers["content-disposition"]
        assert c.post("/api/figure", json={"id": "cust_ABCDEF0123", "fmt": "png"}).status_code == 422


def test_remote_worker_runs_custom_job(libdir):
    with client_for(libdir, local_worker=False) as c:
        register_caps(c)
        j = c.post("/api/sightlines/custom", json=CUSTOM).json()
        w = RemoteWorker("", TOKEN, name="laptop", generator=FakeGenerator(), client=c, poll_s=1.0, heartbeat_s=0.2)
        assert w.caps == ("endpoints", "fit")
        assert w.run(max_jobs=1) == 1 and w.done == 1
        s = c.get(f"/api/jobs/{j['job_id']}").json()
        assert s["status"] == "done" and s["entry"]["orientation"] == "custom" and s["components"] is not None
        assert {x["name"]: x["caps"] for x in c.get("/api/health").json()["workers"]["remote"]}["laptop"] == CAPS_ALL


def test_remote_worker_falls_back_without_caps():
    """A Phase-1 coordinator answers the caps field with 422: the worker leases without it."""
    class Resp:
        def __init__(self, code):
            self.status_code, self.headers, self.text = code, {}, ""

    class Client:
        def __init__(self):
            self.bodies = []

        def post(self, url, headers=None, json=None, **kw):
            self.bodies.append(json)
            return Resp(422 if "caps" in json else 204)
    cl = Client()
    w = RemoteWorker("http://x", TOKEN, name="w", generator=FakeGenerator(), client=cl)
    assert w.lease() is None and w.caps == ()
    assert cl.bodies == [{"name": "w", "caps": CAPS_ALL}, {"name": "w"}]
    assert w.lease() is None and cl.bodies[-1] == {"name": "w"}


def test_remote_worker_phase1_coordinator_gets_exact_npz():
    """After the caps fallback, the result upload has exactly the npz v2 member set, without the
    components member a capless coordinator does not accept."""
    import zipfile
    from server.storage import NPZ_KEYS as _NK
    NPZ_KEYS = _NK(I.KEYS)
    geom = dict(canonicalize("face", 50, 90))

    class Resp:
        def __init__(self, code, body=None):
            self.status_code, self.headers, self.text, self._b = code, {}, "", body

        def json(self):
            return self._b

    class Phase1:
        def __init__(self):
            self.results, self.leases = [], 0

        def post(self, url, headers=None, json=None, content=None, **kw):
            if "/api/worker/lease" in url:
                if "caps" in (json or {}):
                    return Resp(422)
                self.leases += 1
                return Resp(200, {"job_id": "j1", "geom": geom, "lease": "t1"}) if self.leases == 1 else Resp(204)
            if "/api/worker/result/" in url:
                got = sorted(zipfile.ZipFile(io.BytesIO(content)).namelist())
                self.results.append(got)
                return Resp(200 if got == sorted(k + ".npy" for k in NPZ_KEYS) else 422)
            return Resp(200, {})
    cl = Phase1()
    gen = FakeGenerator(components="fake")
    w = RemoteWorker("http://x", TOKEN, name="w", generator=gen, client=cl, heartbeat_s=30)
    assert w.run(max_jobs=1, max_idle_polls=1) == 1
    assert w.caps == () and w.done == 1 and w.failed == 0
    assert cl.results == [sorted(k + ".npy" for k in NPZ_KEYS)]


def test_reconcile_rebuilds_old_generated_rows(libdir):
    """Phase-1 generated rows (no p0/p1, has_components, logN_aod) are rebuilt from their npz once."""
    store = LibraryStore(libdir)
    p = FakeGenerator(components="fake").generate(canonicalize("edge", 13, 211))
    sid = store.add_generated(p)["id"]
    cat = json.loads((libdir / "catalog.json").read_text())
    for e in cat["entries"]:
        if e["id"] == sid:
            for k in ("p0", "p1", "has_components", "n_fit", "logN_aod", "data_version", "lines"):
                e.pop(k, None)
            e["legacy_note"] = "kept"
    (libdir / "catalog.json").write_text(json.dumps(cat))
    s2 = LibraryStore(libdir)
    assert "p0" not in s2.entry(sid)
    assert s2.reconcile(backfill=False) == 1
    e = s2.entry(sid)
    assert len(e["p0"]) == 3 and len(e["p1"]) == 3 and e["has_components"] is True and e["legacy_note"] == "kept"
    assert set(e["logN_aod"]) == set(I.KEYS) and e["data_version"] == 2 and e["lines"] == list(I.KEYS)
    assert LibraryStore(libdir).reconcile(backfill=False) == 0          # idempotent
    lib_row = next(x for x in json.loads((libdir / "catalog.json").read_text())["entries"] if x["id"] == LIB_IDS[0])
    assert lib_row["source"] == "library"                                # library rows untouched


def test_reload_drops_components_caches(libdir):
    store = LibraryStore(libdir)
    body0, etag0 = store.components_index()
    assert json.loads(body0)["entries"] == {}
    # an HF snapshot download lands a components file behind the store's back
    p = FakeGenerator(components="fake").generate(canonicalize_endpoints(**CUSTOM))
    other = LibraryStore(libdir)
    other.add_generated(p)
    assert store.components_index()[1] == etag0                          # stale until reload
    store.reload()
    body1, etag1 = store.components_index()
    assert etag1 != etag0 and "cust_35277e0469" in json.loads(body1)["entries"]


def test_reaper_expires_custom_jobs_without_capable_worker(libdir):
    """Only a capless (Phase-1) worker stays live: queued custom-ray jobs error after no_worker_grace_s,
    not after queue_ttl_s; ordinary jobs stay queued for the capless worker."""
    with client_for(libdir, local_worker=False, worker_seen_s=0.5, no_worker_grace_s=0.3) as c:
        register_caps(c, name="laptop")
        j = c.post("/api/sightlines/custom", json=_custom(5.0))
        assert j.status_code == 202, j.text
        jid = j.json()["job_id"]

        def poll():
            register(c, name="old")                                    # the capless worker keeps polling
            s = c.get(f"/api/jobs/{jid}").json()
            return s if s["status"] == "error" else None
        s = wait_for(poll, timeout=15, every=0.1)
        assert "custom rays" in s["error"]
    q = JobQueue()
    a = q.submit(canonicalize_endpoints([0, 0, 0], [50, 0, 0]))[0]
    o = q.submit(dict(canonicalize("edge", 40, 74)))[0]
    assert q.expire_queued("gone", kind="endpoints") == [a.job_id]
    assert q.jobs[o.job_id].status == "queued" and q.jobs[a.job_id].status == "error"


def test_fake_components_valid():
    p = FakeGenerator(components="fake").generate(canonicalize("rand", 50, 10, seed=3))
    validate_components(p["components"])
    json.dumps(p["components"], allow_nan=False)
    for k, comps in p["components"].items():
        assert [x["v"] for x in comps] == sorted(x["v"] for x in comps)
    stages = []
    FakeGenerator(components=None).generate(canonicalize("face", 1, 1), progress=lambda s, f, m: stages.append(s))
    assert "fit" not in stages
    stages = []
    FakeGenerator(components="fake").generate(canonicalize("face", 1, 1), progress=lambda s, f, m: stages.append(s))
    assert stages.index("fit") < stages.index("save")


def test_fallback_component_validator_matches_rules():
    """storage's local validator (used while tngsight.components is not v2) applies the v2 rules: any non-empty
    subset of the registry keys, rows or dicts, logN <= atomic(k)["logN_max"], flags 0..255."""
    from server.storage import _basic_validate_components, dicts_to_rows
    good = fake_components({"OVI": [(1.0, 10.0, 20.0)], "HI": [], "CIII": [(0.5, -40.0, 12.0)]})
    assert _basic_validate_components(good) == good
    assert _basic_validate_components({k: dicts_to_rows(v) for k, v in good.items()}) == good
    assert validate_components({k: dicts_to_rows(v) for k, v in good.items()}) == good
    validate_components(good)
    c0 = good["OVI"][0]
    assert _basic_validate_components({"OVI": [], "HILyb": []}) == {"OVI": []} == validate_components({"OVI": [], "HILyb": []})
    bads = [{}, {"HILyb": []}, {"OVI": [], "NaI": []}, dict(good, OVI="x"), dict(good, OVI=[{**c0, "logN": 9.9}]),
            dict(good, OVI=[{**c0, "b": 0.5}]), dict(good, OVI=[{**c0, "v": 11000.5}]), dict(good, OVI=[{**c0, "b": 150.5}]),
            dict(good, OVI=[{**c0, "flag": 256}]), dict(good, OVI=[{**c0, "dv": float("nan")}]),
            dict(good, OVI=[{**c0, "logN": 19.5}]), dict(good, HI=[{**c0, "logN": 22.6}]),
            dict(good, OVI=[{**c0, "v": None}]), dict(good, OVI=[{k: v for k, v in c0.items() if k != "EW"}]),
            dict(good, OVI=[c0] * 31), dict(good, OVI=[[1, 2, 3]]), dict(good, OVI=[{**c0, "region": True}])]
    for bad in bads:
        with pytest.raises(ValueError):
            _basic_validate_components(bad)
        with pytest.raises(ValueError):
            validate_components(bad)
    assert _basic_validate_components(dict(good, OVI=[{**c0, "dv": None, "dlogN": None, "db": None}]))
    damped = dict(good, HI=[{**c0, "logN": 21.1, "flag": 81}])          # DAMPED|EDGE|SAT
    assert _basic_validate_components(damped) == validate_components(damped)
    assert _basic_validate_components({"MgII": [{**c0, "flag": 128}]})   # BUDGET (browser fitter)


# ----------------------------------------------------------------------------- Phase 3: data v2
def _npz_bytes(like):
    buf = io.BytesIO()
    L.save_npz(buf, like)
    return buf.getvalue()


def test_validate_result_v2_rules(libdir):
    """design.md §4.1: npz v2 with all 12 lines on the native grids, the registry window, finite tau and the
    server's registry tag; exact 422 messages for v1, a missing line, a wrong grid, a wrong H I W, non-finite tau
    and a registry mismatch."""
    store = LibraryStore(libdir)
    geom = dict(canonicalize("edge", 40, 7))
    p = FakeGenerator(components=None).generate(geom)
    ok = store.validate_result(_npz_bytes(npz_like(p)), geom, 5 << 20)
    assert ok["format"] == 2 and ok["lines"] == list(I.KEYS) and ok["generation"]["registry_tag"] == I.registry_tag()
    np.testing.assert_array_equal(ok["tau"]["OVII"], p["tau"]["OVII"])

    def err(like=None, blob=None):
        with pytest.raises(ValueError) as e:
            store.validate_result(blob if blob is not None else _npz_bytes(like), geom, 5 << 20)
        return str(e.value)
    v1 = libdir / "v1.npz"
    write_v1_npz(v1, "edge_b040_a007")
    assert err(blob=v1.read_bytes()) == "worker result is npz v1; update the worker"
    like = npz_like(p)
    sub = dict(like, lines=[k for k in I.KEYS if k != "OVII"])
    assert err(sub) == "lines must be all 12 registry keys in order; missing OVII"
    rest = I.get("CIV")["lam0_A"]
    assert err(dict(like, lam0=dict(like["lam0"], CIV=like["lam0"]["CIV"] + 2e-9 * rest))) == \
        "CIV: wavelength grid mismatch"
    assert err(dict(like, dlam=dict(like["dlam"], CIV=like["dlam"]["CIV"] * (1 + 1e-6)))) == "CIV: wavelength grid mismatch"
    wd = I.gen_window("HI", 20.40)
    assert wd > 1500
    assert err(dict(like, logN=dict(like["logN"], HI=20.40))) == f"HI: window W 1500 != {wd:g} km/s for logN 20.400"
    assert err(dict(like, tau=dict(like["tau"], NV=like["tau"]["NV"][:-1]))) == "NV: tau shape (12000,) != native grid (12001,)"
    bad = like["tau"]["MgII"].copy(); bad[10] = np.inf
    assert err(dict(like, tau=dict(like["tau"], MgII=bad))) == "MgII: tau not finite/non-negative"
    bad = like["tau"]["MgII"].copy(); bad[10] = -0.01
    assert err(dict(like, tau=dict(like["tau"], MgII=bad))) == "MgII: tau not finite/non-negative"
    gen = dict(like["generation"], registry_tag="deadbeef0000")
    assert err(dict(like, generation=gen)) == f"registry mismatch (worker deadbeef0000, server {I.registry_tag()})"
    assert err(dict(like, rest=dict(like["rest"], SiIV=1393.76))).startswith("SiIV: rest wavelength")
    assert err(dict(like, logN=dict(like["logN"], CII=float("nan")))).startswith("logN_CII not a finite scalar")
    # a zero column (-inf) is legal; a damped H I on its widened window is accepted
    zero = store.validate_result(_npz_bytes(dict(like, logN=dict(like["logN"], NeVIII=float("-inf")))), geom, 5 << 20)
    assert zero["logN"]["NeVIII"] == float("-inf")
    pd = FakeGenerator(components=None, logN={"HI": 20.40}).generate(geom)
    assert pd["W"]["HI"] == wd and pd["tau"]["HI"].size == int(round(2 * wd / 0.25)) + 1
    assert store.validate_result(_npz_bytes(npz_like(pd)), geom, 5 << 20)["W"]["HI"] == wd
    assert err(blob=b"PK\x05\x06" + b"\0" * 18) == "npz has no format member (not an npz v2 result)"


def test_v1_library_npz_served_as_tngs_v2(libdir):
    """A v1 library npz (Phase 1/2) stays v1 on disk; its web binary is TNGS v2 with the 2 registry lines it has,
    and a cached v1 .bin is re-encoded on first read and replaced by the v2 bytes."""
    sid = "face_b020_a045"
    write_v1_npz(libdir / "sightlines" / L.npz_name(sid), sid)
    v1_bin = libdir / "web" / f"{sid}.bin"
    v1_bin.parent.mkdir(exist_ok=True)
    v1_bin.write_bytes(b"TNGS\x01\x03\x00\x00" + b"\0" * 32)
    store = LibraryStore(libdir)
    blob = store.bin_bytes(sid)
    d = L.decode_web(blob)
    assert d["version"] == 2 and list(d["lines"]) == ["CIII", "OVI"] and d["skipped"] == []
    assert v1_bin.read_bytes() == blob                                     # the v2 bytes replaced the v1 cache
    assert store.bin_bytes(sid) == blob
    v1_bin.unlink()
    assert store.bin_bytes(sid) == blob and v1_bin.read_bytes() == blob   # rebuilt from the npz
    payload = store.load_payload(sid)
    assert payload["format"] == 1 and payload["lines"] == ["CIII", "OVI"] and payload["id"] == sid
    store.catalog.upsert(L.catalog_entry(payload, None, "library"))
    store.catalog.save()
    assert store.entry(sid)["data_version"] == 1 and store.entry(sid)["lines"] == ["CIII", "OVI"]
    calls = []

    def renderer(payload, fmt, **kw):
        calls.append(kw)
        return PNG
    with client_for(libdir, local_worker=False, renderer=renderer) as c:
        r = c.get(f"/api/sightline/{sid}.bin")
        assert r.status_code == 200 and r.content == blob
        assert c.get(f"/api/sightline/{LIB_IDS[0]}.bin").content[4] == 2
        assert c.post("/api/figure", json={"id": sid}).status_code == 200 and calls[-1]["ions"] == ["OVI"]
        r = c.post("/api/figure", json={"id": sid, "ions": ["HI", "OVI"]})
        assert r.status_code == 422 and "HI is not in sightline" in r.json()["detail"]
        assert c.post("/api/figure", json={"id": sid, "ions": ["CIII", "OVI"]}).status_code == 200
        assert calls[-1]["ions"] == ["CIII", "OVI"]


def test_reconcile_v1_generated_row_and_v1_components_doc(libdir):
    """A generated v1 npz (Phase 2) gets a data_version 1 row with lines OVI and CIII; its v1 components file
    (OVI, HILyb, CIII dicts) is read and converted to the v2 doc (HILyb dropped)."""
    sid = "edge_b033_a033"
    (libdir / "generated").mkdir(exist_ok=True)
    write_v1_npz(libdir / "generated" / f"{sid}.npz", sid)
    c0 = {"v": 10.0, "dv": 0.1, "logN": 13.5, "dlogN": 0.01, "b": 20.0, "db": 0.2, "region": 0, "flag": 0, "EW": 50.0}
    (libdir / "generated" / f"{sid}.components.json").write_text(json.dumps(
        {"id": sid, "fitter": "tngsight.vpfit/1", "params_tag": "abc", "components": {"OVI": [c0], "HILyb": [c0],
                                                                                       "CIII": []}}))
    store = LibraryStore(libdir)
    assert store.reconcile(backfill=False) == 1
    e = store.entry(sid)
    assert e["data_version"] == 1 and e["lines"] == ["CIII", "OVI"] and e["has_components"] is True
    doc = store.components(sid)
    assert doc["version"] == 2 and set(doc["components"]) == {"OVI", "CIII"} and doc["fitter"] == "tngsight.vpfit/1"
    assert doc["components"]["OVI"] == [[10.0, 0.1, 13.5, 0.01, 20.0, 0.2, 0, 0, 50.0]] and doc["aod"] == {}
    assert LibraryStore(libdir).reconcile(backfill=False) == 0
    assert L.decode_web(store.bin_bytes(sid))["version"] == 2


def test_fake_generator_v2_payload():
    from server.testing import STAGES
    assert STAGES == ("load", "ray", *(f"spectrum:{k}" for k in I.KEYS), "fit", "save")
    try:
        from tngsight.generate import STAGES as GEN_STAGES
    except Exception:                                  # yt/trident absent: the registry-derived form is the contract
        GEN_STAGES = STAGES
    assert STAGES == tuple(GEN_STAGES)
    seen = []
    p = FakeGenerator(components="fake").generate(canonicalize("face", 50, 90), progress=lambda s, f, m="": seen.append(s))
    assert [s_ for s_ in seen if s_.startswith("spectrum:")] == [f"spectrum:{k}" for k in I.KEYS]
    for k in I.KEYS:
        lam0, dlam, n = L.native_grid(k, p["W"][k])
        assert p["tau"][k].dtype == np.float32 and p["tau"][k].size == n
        assert (p["lam0"][k], p["dlam"][k]) == (lam0, dlam)
    back = L.load_npz(io.BytesIO(_npz_bytes(npz_like(p))))
    assert back["lines"] == list(I.KEYS) and back["generation"]["registry_tag"] == I.registry_tag()
    assert set(p["components_aod"]) == set(I.KEYS)


# ----------------------------------------------------------------------------- integration: chat router
def test_chat_router_mounted_health_and_body_limits(libdir):
    """create_app mounts server/chat.py: /api/health carries chat.claude (False without a key), POST
    /api/chat answers 404 "chat disabled" and has its own body limit (chat_max_bytes + 4096) while
    other routes keep max_body."""
    with client_for(libdir, local_worker=False) as c:
        S = c.app.state.settings
        assert S.anthropic_api_key is None
        assert c.get("/api/health").json()["chat"] == {"claude": False}
        mid = json.dumps({"messages": [{"role": "user", "content": "x" * (S.max_body + 2000)}]})
        assert S.max_body < len(mid) < S.chat_max_bytes + 4096
        r = c.post("/api/chat", content=mid, headers={"content-type": "application/json"})
        assert r.status_code == 404 and r.json() == {"detail": "chat disabled"}
        r = c.post("/api/sightlines", content=mid, headers={"content-type": "application/json"})
        assert r.status_code == 413
        big = json.dumps({"messages": [{"role": "user", "content": "x" * (S.chat_max_bytes + 5000)}]})
        r = c.post("/api/chat", content=big, headers={"content-type": "application/json"})
        assert r.status_code == 413


# ----------------------------------------------------------------------------- deploy: HF dataset upload plan
def test_upload_plan_includes_phase2_files(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("upload_hf_dataset",
                                                  Path(__file__).resolve().parents[1] / "deploy/data/upload_hf_dataset.py")
    up = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(up)
    lib = tmp_path / "lib"
    files = ["catalog.json", "sightlines/face_b050_a090.npz", "web/face_b050_a090.bin", "components.json",
             "components/face_b050_a090.json", "vol/manifest.json", "vol/nH.u8.gz", "vol/HI.128.u8.gz",
             "generated/cust_35277e0469.npz", "generated/cust_35277e0469.components.json",
             "vol_cache/nH_256.npy", "cutout.ewah", "components/.tmp.json", "yt.toml"]
    for f in files:
        (lib / f).parent.mkdir(parents=True, exist_ok=True)
        (lib / f).write_bytes(b"x")
    cut, ion = tmp_path / "cut.hdf5", tmp_path / "ion.h5"
    cut.write_bytes(b"x"); ion.write_bytes(b"x")
    rel = lambda items: sorted(r for _, r in items[2:])  # noqa: E731
    # Phase 2b: the vol/ volumes are no longer uploaded (the deposited cubes live in the public viz dataset)
    assert rel(up.plan(cut, ion, lib)) == sorted(files[:5])
    assert rel(up.plan(cut, ion, lib, phase2=False)) == sorted(files[:3])
    assert rel(up.plan(cut, ion, lib, generated=True)) == sorted(files[:5] + files[8:10])
