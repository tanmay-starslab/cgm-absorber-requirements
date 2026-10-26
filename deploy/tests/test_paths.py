"""The TNG_WORK contract in the deploy/data scripts and a scan for hard-coded machine paths (no data needed).

Each script computes its path defaults at import, so every case loads a fresh copy of the module under a controlled
environment. The work root is $TNG_WORK, default /Volumes/cgm_work (the Mac defaults are unchanged)."""
from __future__ import annotations
import importlib.util
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "deploy" / "data"
sys.path.insert(1, str(ROOT))
VARS = ("TNG_WORK", "TNG_LIBRARY_DIR", "TNG_CUTOUT", "TNG_ION_TABLE_DIR", "TNG_RAW_SIGHTLINES", "HF_HOME", "TNG_HEAVY_LOCK")
MAC = Path("/Volumes/cgm_work")


@pytest.fixture
def load(monkeypatch):
    """load(name, **env) -> a fresh import of deploy/data/<name>.py with only `env` among VARS set."""
    n = [0]

    def f(name, **env):
        for v in VARS:
            monkeypatch.delenv(v, raising=False)
        for k, v in env.items():
            monkeypatch.setenv(k, str(v))
        n[0] += 1
        spec = importlib.util.spec_from_file_location(f"_paths_{name}_{n[0]}", DATA / f"{name}.py")
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m
    return f


def test_mac_defaults_unchanged(load):
    sl = load("slim_iontable")
    assert sl.SRC == MAC / "data/trident/hm2012_ss_hr.h5" and sl.OUT == MAC / "data/trident_slim_v3/hm2012_ss_hr.h5"
    assert load("regen_library").SRC_DEFAULT == MAC / "data/library"
    uv = load("upload_viz_dataset")
    assert uv.HF_HOME == str(MAC / "cache/hf") and uv.DEFAULT_TOKEN_FILE == MAC / "cache/hf/token"
    assert uv.DEFAULT_VIZ == MAC / "data/library/viz"
    assert load("build_library").SRC == Path("/Volumes/LaCie/cgm_qso_488530/data/sightlines")   # the read-only originals
    # the upload default is the 7-element table slim_iontable.py writes (the dataset holds it since the Phase 3 release)
    assert load("upload_hf_dataset").ION_TABLE == MAC / "data/trident_slim_v3/hm2012_ss_hr.h5" == sl.OUT


def test_defaults_follow_tng_work(load, tmp_path):
    w = tmp_path / "work"
    sl = load("slim_iontable", TNG_WORK=w)
    assert sl.SRC == w / "data/trident/hm2012_ss_hr.h5" and sl.OUT == w / "data/trident_slim_v3/hm2012_ss_hr.h5"
    assert load("upload_hf_dataset", TNG_WORK=w).ION_TABLE == w / "data/trident_slim_v3/hm2012_ss_hr.h5"
    assert load("regen_library", TNG_WORK=w).SRC_DEFAULT == w / "data/library"
    uv = load("upload_viz_dataset", TNG_WORK=w)
    assert uv.HF_HOME == str(w / "cache/hf") and uv.DEFAULT_VIZ == w / "data/library/viz"
    bc = load("build_components", TNG_WORK=w)
    assert bc.library_dir() == w / "data/library" and bc.LOCK == ""      # its heavy lock stays opt-in


def test_specific_variables_override(load, tmp_path):
    uv = load("upload_viz_dataset", TNG_WORK=tmp_path / "w", HF_HOME=tmp_path / "hf", TNG_LIBRARY_DIR=tmp_path / "lib")
    assert uv.HF_HOME == str(tmp_path / "hf") and uv.DEFAULT_TOKEN_FILE == tmp_path / "hf/token"
    assert uv.DEFAULT_VIZ == tmp_path / "lib/viz"
    assert load("build_library", TNG_RAW_SIGHTLINES=tmp_path / "raw").SRC == tmp_path / "raw"
    up = load("upload_hf_dataset", TNG_WORK=tmp_path / "w", TNG_CUTOUT=tmp_path / "c.hdf5", TNG_LIBRARY_DIR=tmp_path / "lib")
    assert up.cutout_path() == tmp_path / "c.hdf5" and up.library_dir() == tmp_path / "lib"


# --------------------------------------------------------------------------------------------- hard-coded paths
# the files the port made portable (tests that assert the Mac defaults on purpose are not scanned)
SCANNED = ["tngsight/config.py", "server/settings.py", "scripts/export_tng50_web.py", "deploy/oci/push_oci.sh",
           "deploy/hf_space/push_space.sh", "deploy/laptop/serve.sh", "deploy/laptop/worker.sh",
           "deploy/data/slim_iontable.py", "deploy/data/upload_hf_dataset.py", "deploy/data/upload_viz_dataset.py",
           "deploy/data/regen_library.py", "deploy/data/build_library.py", "deploy/data/build_components.py",
           "deploy/tests/test_deploy.py", "deploy/tests/test_slim_iontable.py", "tests/test_deposit.py",
           "tests/js/lib/browser.mjs", "tests/js/make_viz_fixture.py"]
# allowed /Volumes tokens: the bare work-root default (paths under it are always built from work_root() or $WORK),
# the Mac's read-only originals (a default and a never-write guard) and the macOS mount check of the laptop scripts
ALLOWED = {"/Volumes/cgm_work": None, "/Volumes/LaCie/cgm_qso_488530/data/sightlines": {"deploy/data/build_library.py"},
           "/Volumes/LaCie": {"deploy/data/regen_library.py"}, "/Volumes/*": {"deploy/laptop/serve.sh", "deploy/laptop/worker.sh"}}
PRIVATE = re.compile(r"/scratch/tsingh65|/home/tsingh65|/data/sborthak|/Users/")


def test_no_hard_coded_machine_paths():
    bad = []
    for rel in SCANNED:
        for i, line in enumerate((ROOT / rel).read_text(encoding="utf-8").splitlines(), 1):
            for tok in re.findall(r"/Volumes/[^\s\"'`)}\]]*", line):
                tok = tok.rstrip(",.;:")
                ok = tok in ALLOWED and (ALLOWED[tok] is None or rel in ALLOWED[tok])
                if not ok:
                    bad.append(f"{rel}:{i}: {tok}")
            if PRIVATE.search(line) and not (rel == "deploy/hf_space/push_space.sh" and "grep -rIlE" in line):
                bad.append(f"{rel}:{i}: private path")              # push_space.sh's deny-list scan names them
    assert not bad, "\n".join(bad)
