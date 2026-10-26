"""The TNG_WORK portability contract: tngsight.config.work_root() and the path defaults that derive from it, in
tngsight.config and server.settings. The work root is $TNG_WORK, default /Volumes/cgm_work (the owner's Mac, so the
Mac defaults are unchanged); TNG_LIBRARY_DIR, TNG_CUTOUT, TNG_ION_TABLE_DIR, TNG_INDEX_FILE, TNG_FIGDIR,
TNG_HEAVY_LOCK and HF_HOME still override their own path, and an empty variable counts as unset. No data needed."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import tngsight  # noqa: E402
from tngsight import config  # noqa: E402

VARS = ("TNG_WORK", "TNG_LIBRARY_DIR", "TNG_CUTOUT", "TNG_ION_TABLE_DIR", "TNG_INDEX_FILE", "TNG_FIGDIR",
        "TNG_HEAVY_LOCK", "HF_HOME")
# helper -> path under the work root
UNDER = {"cutout_path": "data/cutout_slim_R400_sub488530.hdf5", "ion_table_dir": "data/trident",
         "library_dir": "data/library", "index_path": "data/library/cutout.ewah", "figdir": "data/library/figures",
         "heavy_lock_path": "scratch/p2/heavy.lock", "hf_home": "cache/hf"}
OWN = {"cutout_path": "TNG_CUTOUT", "ion_table_dir": "TNG_ION_TABLE_DIR", "library_dir": "TNG_LIBRARY_DIR",
       "index_path": "TNG_INDEX_FILE", "figdir": "TNG_FIGDIR", "heavy_lock_path": "TNG_HEAVY_LOCK", "hf_home": "HF_HOME"}


@pytest.fixture
def clean(monkeypatch):
    for v in VARS:
        monkeypatch.delenv(v, raising=False)
    return monkeypatch


def test_mac_defaults_unchanged(clean):
    """No variable set: the exact paths the repo hard-coded before the port."""
    assert config.work_root() == Path("/Volumes/cgm_work") == Path(config.WORK_DEFAULT)
    assert config.cutout_path() == Path("/Volumes/cgm_work/data/cutout_slim_R400_sub488530.hdf5")
    assert config.ion_table_dir() == Path("/Volumes/cgm_work/data/trident")
    assert config.library_dir() == Path("/Volumes/cgm_work/data/library")
    assert config.index_path() == Path("/Volumes/cgm_work/data/library/cutout.ewah")
    assert config.heavy_lock_path() == Path("/Volumes/cgm_work/scratch/p2/heavy.lock")
    assert config.hf_home() == Path("/Volumes/cgm_work/cache/hf")
    clean.setenv("TNG_WORK", "")
    assert config.work_root() == Path("/Volumes/cgm_work")


def test_every_default_derives_from_tng_work(clean, tmp_path):
    clean.setenv("TNG_WORK", str(tmp_path))
    assert config.work_root() == tmp_path
    for fn, rel in UNDER.items():
        assert getattr(config, fn)() == tmp_path / rel, fn


def test_specific_variables_still_override(clean, tmp_path):
    clean.setenv("TNG_WORK", str(tmp_path / "work"))
    for fn, var in OWN.items():
        clean.setenv(var, str(tmp_path / var))
        assert getattr(config, fn)() == tmp_path / var, fn
        clean.setenv(var, "")                                     # empty = unset
        assert getattr(config, fn)() == tmp_path / "work" / UNDER[fn], fn
        clean.delenv(var)
    clean.setenv("TNG_LIBRARY_DIR", str(tmp_path / "lib"))       # index and figures follow the library
    assert config.index_path() == tmp_path / "lib" / "cutout.ewah" and config.figdir() == tmp_path / "lib" / "figures"


def test_server_settings_library_default(clean, tmp_path):
    from server.settings import Settings
    assert Settings().library_dir == Path("/Volumes/cgm_work/data/library")
    assert Settings.from_env({}).library_dir == Path("/Volumes/cgm_work/data/library")
    clean.setenv("TNG_WORK", str(tmp_path))
    assert Settings().library_dir == tmp_path / "data" / "library"
    assert Settings.from_env({}).library_dir == tmp_path / "data" / "library"
    assert Settings.from_env().library_dir == tmp_path / "data" / "library"
    assert Settings.from_env({"TNG_WORK": str(tmp_path / "w")}).library_dir == tmp_path / "w" / "data" / "library"
    assert Settings.from_env({"TNG_WORK": str(tmp_path / "w"), "TNG_LIBRARY_DIR": str(tmp_path / "l")}).library_dir \
        == tmp_path / "l"
    clean.setenv("TNG_LIBRARY_DIR", str(tmp_path / "envlib"))
    assert Settings.from_env({}).library_dir == tmp_path / "envlib"      # as before: the process env is the fallback
    s = Settings.from_env({"TNG_CUTOUT": str(tmp_path / "c.hdf5")})
    assert s.cutout == tmp_path / "c.hdf5" and s.ion_table_dir is None   # None -> tngsight.config at use


def test_server_settings_without_tngsight(clean, tmp_path, monkeypatch):
    """server.settings falls back to the same rule when tngsight.config cannot be imported."""
    from server.settings import Settings
    monkeypatch.delattr(tngsight, "config")
    monkeypatch.setitem(sys.modules, "tngsight.config", None)
    with pytest.raises(ImportError):
        from tngsight import config as _  # noqa: F401
    assert Settings.from_env({}).library_dir == Path("/Volumes/cgm_work/data/library")
    clean.setenv("TNG_WORK", str(tmp_path))
    assert Settings.from_env({}).library_dir == tmp_path / "data" / "library"
