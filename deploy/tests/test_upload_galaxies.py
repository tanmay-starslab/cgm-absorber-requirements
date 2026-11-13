"""deploy/data/upload_galaxies.py: privacy check and cube lookup against the pipeline's real layout (integrate3)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(1, str(ROOT / "deploy" / "data"))
sys.path.insert(1, str(ROOT))

import upload_galaxies as U  # noqa: E402


def test_pathlike_keys_flag_paths_not_prose():
    assert U.private_leaks({"spectra_source": {"path": "+-2 R200c (half_kpc per sightline)"}}) == []
    assert U.private_leaks({"a": {"path": "data/cutout.hdf5"}}) == [".a.path"]
    assert U.private_leaks({"source_path": "/scratch/x/snap_99.hdf5"}) == [".source_path"]
    assert U.private_leaks({"file": "snap_99.hdf5"}) == [".file"]
    assert U.private_leaks({"note": "/home/someone/x"}) == [".note"]
    assert U.strip_private({"path": "prose words here", "file": "a.npz"}) == {"path": "prose words here"}


def test_locate_finds_cubes_beside_the_web_manifest(tmp_path):
    g = tmp_path / "123"
    (g / "web" / "viz").mkdir(parents=True)
    (g / "viz" / "gas" / "L0").mkdir(parents=True)
    (g / "web" / "viz" / "manifest_v2.json").write_text("{}")
    (g / "viz" / "gas" / "L0" / "nH.abc.u8.gz").write_bytes(b"x")
    loc = U.locate(g)
    assert loc["viz"] == g / "web" / "viz"
    assert loc["viz_dirs"] == [g / "web" / "viz", g / "viz"]
    rel = "gas/L0/nH.abc.u8.gz"
    hit = next(d / rel for d in loc["viz_dirs"] if (d / rel).is_file())
    assert hit == g / "viz" / rel and json.loads((loc["viz"] / "manifest_v2.json").read_text()) == {}
