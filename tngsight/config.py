"""Constants and env-driven paths for the TNG50 sightline explorer (default galaxy: subhalo 488530).

No I/O at import except reading the galaxy record: the packaged galaxy_488530.json (cluster paths removed) unless
TNG_GALAXY_JSON (a galaxy.json path) or TNG_GALAXY (a subhalo id, read from <gal_root()>/<id>/galaxy.json; 488530
means the packaged record) selects another galaxy of the sample (tngsight.galpipe writes those records). Unset, the
module is byte-for-byte the 488530 configuration it always was. use_galaxy() switches the galaxy in-process. The lines live in
the ion registry, tngsight.ions (tngsight/ions.json); GALAXY["lines"] is the v1 (3-line) record, kept for history.

Paths: every default derives from one work root, work_root() = $TNG_WORK (default /Volumes/cgm_work, the owner's
Mac work volume; on a Linux cluster export TNG_WORK=<dir>). The specific variables TNG_CUTOUT, TNG_ION_TABLE_DIR,
TNG_LIBRARY_DIR, TNG_INDEX_FILE, TNG_FIGDIR, TNG_HEAVY_LOCK and HF_HOME still override their own path; an empty
variable counts as unset. The helpers read the environment at call time.
"""
from __future__ import annotations
import json
import os
from pathlib import Path

C_KMS = 299792.458
DLAMBDA = 0.002                 # Å: the v1 (legacy) generation grid step; used only by v1 readers and degrade()
VWIN_GEN_KMS = 1500.0           # ± velocity window of the generated high-res spectra (non-damped lines)
DV_NATIVE = 0.25                # km/s: v2 native generation grid (constant velocity step per line)
DV_WEB = 1.0                    # km/s: v2 web binary grid (box average of the native flux)
# Trident min_tau of the deposition (design §2.1): 1e-8 deposits weak, diffuse absorbers in full. The env override
# TNG_SPEC_MIN_TAU exists for tests only.
SPEC_MIN_TAU = float(os.environ.get("TNG_SPEC_MIN_TAU") or 1e-8)
PIX_PER_RESEL = 5
FWHM_TO_SIGMA = 1 / 2.35482     # literal, as in the original degrade.py
VSYS_SIGN = +1                  # V = c(λ/λ0−1) + VSYS_SIGN*v_sys puts the galaxy at V=0 (ray los = −n_los)

DEFAULT_GALAXY_ID = 488530
PACKAGED_GALAXY = Path(__file__).resolve().parent / "galaxy_488530.json"


def gal_root() -> Path:
    """Root of the per-galaxy pipeline data, <root>/<id>/galaxy.json etc.: $TNG_GAL_ROOT, else <work root>/data/gal."""
    v = os.environ.get("TNG_GAL_ROOT")
    return Path(v).expanduser() if v else work_root() / "data" / "gal"


def galaxy_record_path(galaxy_id=None) -> Path:
    """The galaxy.json of a subhalo id (None: the env selection, else the packaged 488530 record)."""
    if galaxy_id is None:
        v = os.environ.get("TNG_GALAXY_JSON")
        if v:
            return Path(v).expanduser()
        galaxy_id = os.environ.get("TNG_GALAXY") or DEFAULT_GALAXY_ID
    gid = int(galaxy_id)
    if gid == DEFAULT_GALAXY_ID:
        return PACKAGED_GALAXY
    return gal_root() / str(gid) / "galaxy.json"


def load_galaxy(galaxy_id=None) -> dict:
    """A galaxy record by subhalo id (None = the env selection; 488530 = the packaged record). Raises
    FileNotFoundError when the record stage has not run for that galaxy."""
    p = galaxy_record_path(galaxy_id)
    if not p.is_file():
        raise FileNotFoundError(f"no galaxy record {p} (run: python -m tngsight.galpipe record --galaxy {galaxy_id})")
    return json.loads(p.read_text())


def npz_prefix(galaxy: dict | None = None) -> str:
    return f"cgm_sid{int((galaxy or GALAXY)['subhalo_id'])}_"


R_SLIM_KPC = 400.0
B_MAX_KPC = 300.0               # sqrt(400² − 246.35²) = 315 kpc → 300 is safe inside the slim cutout
GALAXY: dict = {}               # filled below (after work_root is defined): the selected galaxy record
NPZ_PREFIX = "cgm_sid488530_"


WORK_DEFAULT = "/Volumes/cgm_work"   # the work root when TNG_WORK is unset (the owner's Mac)


def work_root() -> Path:
    """The work root: $TNG_WORK, else /Volumes/cgm_work. Data, caches and scratch defaults all sit under it."""
    return Path(os.environ.get("TNG_WORK") or WORK_DEFAULT)


def _env_path(var, default) -> Path:
    v = os.environ.get(var)
    return Path(v).expanduser() if v else Path(default)


def cutout_path() -> Path:
    """$TNG_CUTOUT, else the 488530 slim cutout for the default galaxy and <gal_root>/<id>/cutout_slim_R400.hdf5 for
    another selected galaxy."""
    gid = int(GALAXY.get("subhalo_id", DEFAULT_GALAXY_ID))
    default = (work_root() / "data" / "cutout_slim_R400_sub488530.hdf5" if gid == DEFAULT_GALAXY_ID
               else gal_root() / str(gid) / "cutout_slim_R400.hdf5")
    return _env_path("TNG_CUTOUT", default)


def ion_table_dir() -> Path:
    return _env_path("TNG_ION_TABLE_DIR", work_root() / "data" / "trident")


def library_dir() -> Path:
    return _env_path("TNG_LIBRARY_DIR", work_root() / "data" / "library")


def use_galaxy(record) -> dict:
    """Switch the process to another galaxy: `record` is a galaxy dict, a galaxy.json path or a subhalo id. Updates
    GALAXY and NPZ_PREFIX here and the frame constants of tngsight.geometry IN PLACE (modules that imported GALAXY
    or geometry.CENTER_KPC see the new galaxy). Floats copied at import elsewhere (volume.TNG_H, ...) are simulation
    constants. Returns GALAXY. For a fresh process prefer TNG_GALAXY / TNG_GALAXY_JSON."""
    global NPZ_PREFIX
    if isinstance(record, dict):
        rec = dict(record)
    elif isinstance(record, (str, Path)) and not str(record).isdigit():
        rec = json.loads(Path(record).read_text())
    else:
        rec = load_galaxy(int(record))
    GALAXY.clear()
    GALAXY.update(rec)
    NPZ_PREFIX = npz_prefix(GALAXY)
    import sys as _sys
    pkg = __name__.rsplit(".", 1)[0]
    for name, mod in list(_sys.modules.items()):
        if name.startswith(pkg + ".") and mod is not None and isinstance(getattr(mod, "NPZ_PREFIX", None), str):
            mod.NPZ_PREFIX = NPZ_PREFIX
    geo = _sys.modules.get(pkg + ".geometry")
    if geo is not None:
        geo._refresh()
    return GALAXY


def heavy_lock_path() -> Path:
    """The heavy-I/O lock file the real-data tests take (TNG_HEAVY_LOCK, else <work root>/scratch/p2/heavy.lock)."""
    return _env_path("TNG_HEAVY_LOCK", work_root() / "scratch" / "p2" / "heavy.lock")


def hf_home() -> Path:
    """The Hugging Face home holding the token files (HF_HOME, else <work root>/cache/hf)."""
    return _env_path("HF_HOME", work_root() / "cache" / "hf")


def index_path() -> Path:
    return _env_path("TNG_INDEX_FILE", library_dir() / "cutout.ewah")


def figdir() -> Path:
    return _env_path("TNG_FIGDIR", library_dir() / "figures")


GALAXY.update(load_galaxy())
NPZ_PREFIX = npz_prefix(GALAXY)
