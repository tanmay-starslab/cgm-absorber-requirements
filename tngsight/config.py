"""Constants and env-driven paths for the TNG50 sub-488530 sightline explorer.

No I/O at import except reading the packaged galaxy_488530.json (cluster paths removed).
"""
from __future__ import annotations
import json
import os
from pathlib import Path

C_KMS = 299792.458
DLAMBDA = 0.002                 # Å: generation grid step AND the LSF pixel scale (owner decision)
VWIN_GEN_KMS = 1500.0           # ± velocity window of the generated high-res spectra
PIX_PER_RESEL = 5
FWHM_TO_SIGMA = 1 / 2.35482     # literal, as in the original degrade.py
VSYS_SIGN = +1                  # V = c(λ/λ0−1) + VSYS_SIGN*v_sys puts the galaxy at V=0 (ray los = −n_los)

GALAXY: dict = json.loads((Path(__file__).resolve().parent / "galaxy_488530.json").read_text())
LINE_KEYS = ("OVI", "HILyb", "CIII")
LINES = GALAXY["lines"]
R_SLIM_KPC = 400.0
B_MAX_KPC = 300.0               # sqrt(400² − 246.35²) = 315 kpc → 300 is safe inside the slim cutout
NPZ_PREFIX = "cgm_sid488530_"


def _env_path(var, default) -> Path:
    v = os.environ.get(var)
    return Path(v).expanduser() if v else Path(default)


def cutout_path() -> Path:
    return _env_path("TNG_CUTOUT", "/Volumes/cgm_work/data/cutout_slim_R400_sub488530.hdf5")


def ion_table_dir() -> Path:
    return _env_path("TNG_ION_TABLE_DIR", "/Volumes/cgm_work/data/trident")


def library_dir() -> Path:
    return _env_path("TNG_LIBRARY_DIR", "/Volumes/cgm_work/data/library")


def index_path() -> Path:
    return _env_path("TNG_INDEX_FILE", library_dir() / "cutout.ewah")


def figdir() -> Path:
    return _env_path("TNG_FIGDIR", library_dir() / "figures")
