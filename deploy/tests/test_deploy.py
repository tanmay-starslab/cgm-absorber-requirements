"""Tests for deploy/: library build, ion-table slimming, dataset upload plan, Space/laptop scripts.

    python -m pytest deploy/tests -q            (from the repo root, env vars as in design.md §1)
Real-data tests read (never write) the npz library and are skipped when the volumes are absent.
"""
from __future__ import annotations
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from importlib import metadata
from pathlib import Path

import h5py
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy"
SRC = Path("/Volumes/LaCie/cgm_qso_488530/data/sightlines")
FORK = Path("/Volumes/cgm_work/src/trident_env_bundle/sources/trident")
SAMPLE = ["face_b050_a090", "edge_b100_a330", "rand_b005_a134_s479980658"]
sys.path.insert(1, str(ROOT))


sys.path.insert(1, str(DEPLOY / "data"))     # plain imports: process-pool children must re-import them
import build_library as bl  # noqa: E402
import slim_iontable as sl  # noqa: E402
import upload_hf_dataset as up  # noqa: E402
need_src = pytest.mark.skipif(not SRC.is_dir(), reason="npz library volume not mounted")


# ----------------------------------------------------------------------------- build_library
@pytest.fixture
def mini_src(tmp_path):
    """3 real npz copied (read-only source) + a 3-row grid_index subset; one id lacks a row."""
    if not SRC.is_dir():
        pytest.skip("npz library volume not mounted")
    src = tmp_path / "src"; src.mkdir()
    for s in SAMPLE:
        shutil.copy2(SRC / f"cgm_sid488530_{s}.npz", src)
    with open(ROOT / "tng50/data/grid_index.csv", newline="") as fh:
        rows = list(csv.DictReader(fh))
    keep = [r for r in rows if r["geom_id"] in SAMPLE[:2]]
    idx = tmp_path / "grid_index.csv"
    with open(idx, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0])); w.writeheader(); w.writerows(keep)
    return src, idx, {r["geom_id"]: r for r in keep}


def test_build_library_outputs_and_idempotent(mini_src, tmp_path, capsys):
    from tngsight import library as L
    src, idx, rows = mini_src
    out = tmp_path / "lib"
    cat = L.Catalog(out / "catalog.json"); cat.upsert({"id": "face_b077_a012", "source": "generated"}); cat.save()
    assert bl.main(["--src", str(src), "--index", str(idx), "--out", str(out), "-j", "2"]) == 0
    for s in SAMPLE:
        a, b = src / f"cgm_sid488530_{s}.npz", out / "sightlines" / f"{s}.npz"
        assert a.read_bytes() == b.read_bytes() and int(a.stat().st_mtime) == int(b.stat().st_mtime)
        p = L.load_npz(b); w = L.decode_web((out / "web" / f"{s}.bin").read_bytes())
        for k in L.LINE_KEYS:
            assert np.max(np.abs(w["lines"][k]["flux"] - np.exp(-p["tau"][k].astype(float)))) <= 0.5 / 65535 + 1e-12
            assert np.allclose(w["lines"][k]["lam"], p["lam"][k], rtol=0, atol=2e-4)
    doc = json.loads((out / "catalog.json").read_text())
    es = {e["id"]: e for e in doc["entries"]}
    assert set(es) == set(SAMPLE) | {"face_b077_a012"} and es["face_b077_a012"]["source"] == "generated"
    for s, r in rows.items():
        assert es[s]["source"] == "library" and es[s]["rank"] == int(r["rank"])
        assert es[s]["score"] == pytest.approx(float(r["showcase_score"]))
        assert es[s]["star"] == (r["ovi_showcase"] == "True")
    assert es[SAMPLE[2]]["rank"] is None and es[SAMPLE[2]]["seed"] == 479980658
    assert "WARNING: 1 npz without a grid_index row" in capsys.readouterr().out
    # second run: nothing read or rewritten
    snap = {p: p.stat().st_mtime_ns for p in out.rglob("*") if p.is_file()}
    assert bl.main(["--src", str(src), "--index", str(idx), "--out", str(out)]) == 0
    assert "0 to (re)build" in capsys.readouterr().out
    assert snap == {p: p.stat().st_mtime_ns for p in out.rglob("*") if p.is_file()}
    # a removed web bin is rebuilt, and only that id is touched
    (out / "web" / f"{SAMPLE[0]}.bin").unlink()
    assert bl.main(["--src", str(src), "--index", str(idx), "--out", str(out), "--verify"]) == 0
    assert (out / "web" / f"{SAMPLE[0]}.bin").is_file()


def test_build_library_refuses_out_inside_src(tmp_path):
    (tmp_path / "s").mkdir()
    with pytest.raises(SystemExit):
        bl.main(["--src", str(tmp_path / "s"), "--out", str(tmp_path / "s" / "lib")])


@need_src
def test_real_library_complete():
    """The built library (if present) is complete and byte-identical in size to the source."""
    from tngsight.config import library_dir
    lib = Path(os.environ.get("TNG_LIBRARY_DIR", library_dir()))
    if not (lib / "catalog.json").is_file():
        pytest.skip("library not built")
    es = json.loads((lib / "catalog.json").read_text())["entries"]
    libs = [e for e in es if e["source"] == "library"]
    assert len(libs) == 672 and len({e["id"] for e in libs}) == 672
    assert sorted(e["rank"] for e in libs) == list(range(1, 673))
    for e in libs[:20]:
        assert (lib / "sightlines" / f"{e['id']}.npz").stat().st_size == \
            (SRC / f"cgm_sid488530_{e['id']}.npz").stat().st_size
        assert (lib / "web" / f"{e['id']}.bin").is_file()


# ----------------------------------------------------------------------------- slim_iontable
def _fake_table(path):
    rng = np.random.default_rng(1)
    with h5py.File(path, "w") as f:
        f.attrs["note"] = "fake"
        for el, n in (("H", 2), ("He", 3), ("C", 7), ("O", 9)):
            d = f.create_dataset(el, data=rng.normal(size=(n, 4, 3, 5)).astype(">f4"))
            d.attrs["Parameter1"] = np.linspace(-9, 2, 4).astype(">f4")
            d.attrs["Parameter2"] = np.linspace(0, 14.849, 3).astype(">f4")
            d.attrs["Temperature"] = np.linspace(1, 9, 5).astype(">f4")


def test_slim_copies_verbatim(tmp_path):
    src, out = tmp_path / "full.h5", tmp_path / "slim" / "hm2012_ss_hr.h5"
    _fake_table(src)
    sl.slim(src, out); sl.check(src, out)
    with h5py.File(out) as f:
        assert sorted(f) == ["C", "H", "O"] and f["O"].dtype == np.dtype(">f4") and f.attrs["note"] == "fake"
        assert f["C"].attrs["Temperature"].dtype == np.dtype(">f4")
    with h5py.File(out, "r+") as f:
        f["O"][0, 0, 0, 0] += 1
    with pytest.raises(AssertionError):
        sl.check(src, out)


def test_real_slim_table():
    full, slim = sl.SRC, sl.OUT
    if not (full.is_file() and slim.is_file()):
        pytest.skip("ion tables not present")
    sl.check(full, slim)
    assert slim.stat().st_size < 60e6


# ----------------------------------------------------------------------------- upload plan
def _fake_lib(tmp_path):
    lib = tmp_path / "lib"
    for d in ("sightlines", "web", "generated", ".cache/huggingface"):
        (lib / d).mkdir(parents=True)
    for rel in ("catalog.json", "sightlines/face_b050_a090.npz", "web/face_b050_a090.bin",
                "generated/edge_b120_a015.npz", "generated/edge_b120_a015.bin", "yt.toml", "config.tri",
                "cutout.ewah", "sightlines/notes.txt", ".cache/huggingface/x.lock", "web/../catalog.json.bak"):
        (lib / rel).write_bytes(b"x")
    cut, tab = tmp_path / "cutout_slim_R400_sub488530.hdf5", tmp_path / "hm2012_ss_hr.h5"
    cut.write_bytes(b"c"); tab.write_bytes(b"t")
    return lib, cut, tab


def test_upload_plan_allowlist(tmp_path):
    lib, cut, tab = _fake_lib(tmp_path)
    rels = [r for _, r in up.plan(cut, tab, lib)]
    assert rels == ["cutout_slim_R400_sub488530.hdf5", "trident/hm2012_ss_hr.h5", "catalog.json",
                    "sightlines/face_b050_a090.npz", "web/face_b050_a090.bin"]
    rels_g = [r for _, r in up.plan(cut, tab, lib, generated=True)]
    assert "generated/edge_b120_a015.npz" in rels_g and not any("yt.toml" in r or "ewah" in r for r in rels_g)
    bad = tmp_path / "yt.toml"; bad.write_bytes(b"k")
    with pytest.raises(ValueError):
        up.plan(bad, tab, lib)


class FakeApi:
    def __init__(self, private=False):
        self.calls, self._private = [], private

    def __getattr__(self, name):
        def f(*a, **k):
            self.calls.append((name, a, k))
            if name == "repo_info":
                return type("I", (), {"private": self._private})()
        return f


def test_upload_forces_private_and_exact_ops(tmp_path):
    lib, cut, tab = _fake_lib(tmp_path)
    api = FakeApi(private=False)
    up.upload("me/ds", up.plan(cut, tab, lib), "tok", "msg", api=api, chunk=2)
    names = [c[0] for c in api.calls]
    assert names[:3] == ["create_repo", "repo_info", "update_repo_settings"]
    assert api.calls[0][2]["private"] is True and api.calls[2][2]["private"] is True
    assert names.count("upload_file") == 2 and names.count("create_commit") == 2
    ops = [o.path_in_repo for c in api.calls if c[0] == "create_commit" for o in c[1][1]]
    assert ops == ["catalog.json", "sightlines/face_b050_a090.npz", "web/face_b050_a090.bin"]


def test_upload_dry_run_needs_no_token(tmp_path, monkeypatch, capsys):
    lib, cut, tab = _fake_lib(tmp_path)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    assert up.main(["--dry-run", "--library", str(lib), "--cutout", str(cut), "--ion-table", str(tab)]) == 0
    assert "(private): 5 files" in capsys.readouterr().out


# ----------------------------------------------------------------------------- shell scripts
def _run(script, env, cwd=None):
    e = {k: v for k, v in os.environ.items() if k not in ("HF_TOKEN", "LOCAL_WORKER", "WORKER_TOKEN")}
    e.update(env)
    return subprocess.run(["bash", str(script)], env=e, cwd=cwd, capture_output=True, text=True, timeout=120)


def test_start_sh_dryrun(tmp_path):
    app = tmp_path / "app"; app.mkdir(); shutil.copy(DEPLOY / "hf_space/start.sh", app)
    data = tmp_path / "data"; (data / "trident").mkdir(parents=True)
    r = _run(app / "start.sh", {"DATA_DIR": str(data), "TNG_START_DRYRUN": "1", "HOME": str(tmp_path)})
    assert r.returncode == 0, r.stderr
    assert "LOCAL_WORKER=0" in r.stdout and "--port 7860 --workers 1" in r.stdout and "0.0.0.0" in r.stdout
    (data / "cutout_slim_R400_sub488530.hdf5").write_bytes(b"x"); (data / "trident/hm2012_ss_hr.h5").write_bytes(b"x")
    r = _run(app / "start.sh", {"DATA_DIR": str(data), "TNG_START_DRYRUN": "1", "HOME": str(tmp_path),
                                "PATH": f"{Path(sys.executable).parent}:{os.environ['PATH']}"})
    assert r.returncode == 0, r.stderr
    assert "LOCAL_WORKER=1" in r.stdout and f"TNG_LIBRARY_DIR={data}" in r.stdout
    assert int((data / "cutout_slim_R400_sub488530.hdf5").stat().st_mtime) == 1700000000
    assert (app / "config.tri").read_text() == \
        f"[Trident]\nion_table_dir = {data}/trident\nion_table_file = hm2012_ss_hr.h5\n"


@pytest.mark.skipif(not os.path.ismount("/Volumes/cgm_work"), reason="work volume not mounted")
def test_laptop_scripts_dryrun():
    r = _run(DEPLOY / "laptop/serve.sh", {"TNG_START_DRYRUN": "1"})
    assert r.returncode == 0, r.stdout + r.stderr
    assert "cwd=/Volumes/cgm_work/run" in r.stdout and "--host 127.0.0.1 --port 8787 --workers 1" in r.stdout
    r = _run(DEPLOY / "laptop/worker.sh", {"TNG_START_DRYRUN": "1", "WORKER_TOKEN": "secret-tok"})
    assert r.returncode == 0, r.stdout + r.stderr
    assert "server.remote_worker --coordinator https://" in r.stdout and "secret-tok" not in r.stdout


def test_push_space_assemble_only(tmp_path):
    if not (ROOT / "tngsight").is_dir() or not (ROOT / "server").is_dir():
        pytest.skip("tngsight/ or server/ not present yet")
    b = tmp_path / "space_build"
    r = subprocess.run(["bash", str(DEPLOY / "hf_space/push_space.sh"), "--assemble-only"],
                       env={**os.environ, "SPACE_BUILD": str(b)}, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
    top = sorted(p.name for p in b.iterdir())
    assert top == sorted(["Dockerfile", "README.md", "requirements-tng.txt", "start.sh",
                          "trident_doppler_only.patch", "THIRD_PARTY_LICENSES", "tngsight", "server"])
    assert not list(b.rglob("__pycache__")) and (b / "tngsight/galaxy_488530.json").is_file()


# ----------------------------------------------------------------------------- static checks
def test_dockerfile_and_card():
    d = (DEPLOY / "hf_space/Dockerfile").read_text()
    assert d.startswith("#") and "FROM python:3.11-slim" in d and "useradd -m -u 1000 user" in d
    assert "3f69ad7e1927aae8101caa587869d3d68a31c544" in d and "yt.toml" not in d
    card = (DEPLOY / "hf_space/README.md").read_text().split("---")[1]
    meta = dict(line.split(": ", 1) for line in card.strip().splitlines())
    assert meta["sdk"] == "docker" and meta["app_port"] == "7860" and len(meta["short_description"]) <= 60
    assert {"title", "emoji"} <= set(meta)


def test_patch_matches_fork():
    """Patch has no tests/ hunk, and the Dockerfile's sha256 pins equal the laptop fork's files."""
    p = (DEPLOY / "hf_space/trident_doppler_only.patch").read_text()
    files = re.findall(r"^diff --git a/(\S+)", p, re.M)
    assert files == ["trident/absorption_spectrum/absorption_spectrum.py", "trident/data/line_lists/lines.txt",
                     "trident/spectrum_generator.py"]
    pins = dict((f, h) for h, f in re.findall(r"([0-9a-f]{64}) (trident/\S+)", (DEPLOY / "hf_space/Dockerfile").read_text()))
    assert set(pins) == set(files)
    if not FORK.is_dir():
        pytest.skip("fork sources not present")
    for f, h in pins.items():
        assert hashlib.sha256((FORK / f).read_bytes()).hexdigest() == h, f


def test_requirements_match_env():
    req = [l.split("==") for l in (ROOT / "requirements-tng.txt").read_text().splitlines()
           if l and not l.startswith("#")]
    assert {n for n, _ in req} >= {"numpy", "yt", "h5py", "astropy", "fastapi", "uvicorn", "huggingface_hub"}
    assert dict(req)["numpy"] == "1.26.4" and dict(req)["yt"] == "4.4.1"
    bad = []
    for n, v in req:
        try:
            if metadata.version(n) != v:
                bad.append((n, v, metadata.version(n)))
        except metadata.PackageNotFoundError:
            bad.append((n, v, None))
    assert not bad, bad
