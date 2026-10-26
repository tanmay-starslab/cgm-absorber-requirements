"""The 7-element slim ion table (deploy/data/slim_iontable.py, design.md §4.4) and the Space image.

    python -m pytest deploy/tests/test_slim_iontable.py -q                 (fast checks)
    python -m pytest deploy/tests/test_slim_iontable.py -q -m slow         (one real sightline, ~4 min)

The real-table tests read sl.SRC and sl.OUT (under the work root, TNG_WORK) and skip when they are absent.

The slow test generates edge_b100_a090 twice with tngsight.generate.Generator, once against the full
hm2012_ss_hr.h5 and once against the slim table (each in its own process: trident reads config.tri at import),
and requires bitwise-equal tau for Mg II, Si II, N V and Ne VIII (the elements the slim table gained).
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy"
sys.path.insert(1, str(DEPLOY / "data"))
sys.path.insert(1, str(ROOT))
import slim_iontable as sl  # noqa: E402
from tngsight import config  # noqa: E402

CUTOUT = config.cutout_path()        # TNG_CUTOUT, else <TNG_WORK>/data/cutout_slim_R400_sub488530.hdf5
NEW_IONS = ("MgII", "SiII", "NV", "NeVIII")


def test_elements_cover_the_registry():
    """ELEMENTS = the elements of the 12 registry ions, H first (trident loads H for every ion field)."""
    from tngsight import ions
    need = {ions.get(k)["element"] for k in ions.KEYS}
    assert set(sl.ELEMENTS) == need and sl.ELEMENTS[0] == "H"
    assert sl.ELEMENTS == ("H", "C", "N", "O", "Ne", "Mg", "Si") and sl.MAX_BYTES <= 190e6


def test_real_slim_v3_table():
    if not (sl.SRC.is_file() and sl.OUT.is_file()):
        pytest.skip("ion tables not present")
    sl.check(sl.SRC, sl.OUT)
    assert sl.OUT.stat().st_size <= sl.MAX_BYTES


def test_space_image_ships_the_registry():
    """tngsight/ions.json is package data: the Dockerfile copies all of tngsight/ and push_space.sh rsyncs the
    directory (only __pycache__, *.pyc and dot files are excluded), so the registry reaches the image."""
    d = (DEPLOY / "hf_space/Dockerfile").read_text()
    assert "COPY --chown=user tngsight ./tngsight" in d
    push = (DEPLOY / "hf_space/push_space.sh").read_text()
    assert "for d in tngsight server; do" in push
    assert "--exclude '*.json'" not in push and (ROOT / "tngsight/ions.json").is_file()


def test_push_space_context_has_registry(tmp_path):
    b = tmp_path / "space_build"
    r = subprocess.run(["bash", str(DEPLOY / "hf_space/push_space.sh"), "--assemble-only"],
                       env={**os.environ, "SPACE_BUILD": str(b)}, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (b / "tngsight/ions.json").read_bytes() == (ROOT / "tngsight/ions.json").read_bytes()
    assert (b / "server/chat_system_prompt.txt").is_file() and (b / "server/chat_tools.json").is_file()


GEN = r"""
import json, os, sys
import numpy as np
sys.path.insert(0, sys.argv[1])
from tngsight.generate import Generator
from tngsight.geometry import canonicalize
table_dir, out, work, index = sys.argv[2:6]
g = Generator(cutout=sys.argv[6], ion_table_dir=table_dir, index_filename=index, workdir=work, fit_components=False)
p = g.generate(dict(canonicalize("edge", 100, 90)))
np.savez(out, **{k: p["tau"][k] for k in json.loads(sys.argv[7])}, **{"logN_" + k: p["logN"][k] for k in json.loads(sys.argv[7])})
print("ok")
"""


@pytest.mark.slow
def test_slim_table_tau_bitwise_equal_full(tmp_path):
    if not (sl.SRC.is_file() and sl.OUT.is_file() and CUTOUT.is_file()):
        pytest.skip("cutout or ion tables not present")
    work = Path(os.environ.get("TNG_WORKDIR") or tmp_path) / "slim_tau_test"
    py = os.environ.get("TNG_PYTHON", sys.executable)
    env = {**os.environ, "HDF5_USE_FILE_LOCKING": "FALSE", "PYTHONDONTWRITEBYTECODE": "1"}
    res = {}
    for name, table in (("full", sl.SRC.parent), ("slim", sl.OUT.parent)):
        wd = work / name
        wd.mkdir(parents=True, exist_ok=True)
        out = tmp_path / f"{name}.npz"
        r = subprocess.run([py, "-c", GEN, str(ROOT), str(table), str(out), str(wd), str(work / "cutout.ewah"),
                            str(CUTOUT), json.dumps(list(NEW_IONS))],
                           capture_output=True, text=True, env=env, timeout=1800, stdin=subprocess.DEVNULL)
        assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-4000:]
        with np.load(out) as z:
            res[name] = {k: z[k] for k in z.files}
    for k in NEW_IONS:
        a, b = res["full"][k], res["slim"][k]
        assert a.dtype == b.dtype and a.shape == b.shape and np.array_equal(a, b), k
        assert res["full"]["logN_" + k] == res["slim"]["logN_" + k], k
        assert float(np.max(a)) > 0, f"{k}: no absorption on the test sightline"
