#!/usr/bin/env python3
"""Where the legacy tng50/ scripts and the Panel app read and write, resolved from tngsight.config.

Importing this module puts the repo root on sys.path so `import tngsight` works from a plain
`python tng50/scripts/<x>.py`. All locations are env-overridable; nothing points at a cluster.

  sightlines_dir()  read-only 3-ion npz library   TNG_SIGHTLINES_DIR, else <library>/sightlines,
                                                  else the original copy on the LaCie (read-only)
  generated_dir()   new sightlines (writable)     <library>/generated   (same place the server uses)
  out_dir()         CSV products of the CLIs      TNG_LEGACY_OUT, else <library>/legacy
  repo_data()       the committed tng50/data/ CSVs (grid_index.csv, showcase_ranking.csv), read-only
"""
from __future__ import annotations
import os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # tng50/
REPO = ROOT.parent                                      # repo root (holds tngsight/)
if str(REPO) not in sys.path:
    sys.path.insert(1, str(REPO))
from tngsight import config as TC                       # noqa: E402

PREFIX = "cgm_sid488530_"
LACIE_SIGHTLINES = Path("/Volumes/LaCie/cgm_qso_488530/data/sightlines")   # original, never written


def repo_data() -> Path:
    return ROOT / "data"


def sightlines_dir() -> Path:
    env = os.environ.get("TNG_SIGHTLINES_DIR")
    if env:
        return Path(env)
    lib = TC.library_dir() / "sightlines"
    return lib if lib.is_dir() or not LACIE_SIGHTLINES.is_dir() else LACIE_SIGHTLINES


def generated_dir(create=False) -> Path:
    p = TC.library_dir() / "generated"
    if create:
        p.mkdir(parents=True, exist_ok=True)
    return p


def out_dir(create=True) -> Path:
    p = Path(os.environ.get("TNG_LEGACY_OUT", TC.library_dir() / "legacy"))
    if create:
        p.mkdir(parents=True, exist_ok=True)
    return p


def library_files() -> list:
    """All npz sightlines: library first, then generated (either naming scheme)."""
    out = []
    for d in (sightlines_dir(), generated_dir()):
        if d.is_dir():
            out += sorted(d.glob("*.npz"))
    return out


def find_sightline(which) -> Path:
    """Path for an npz path, a file name, or a geom id (`edge_b100_a090`). FileNotFoundError if absent."""
    p = Path(str(which))
    if p.is_file():
        return p
    stem = p.name[:-4] if p.name.endswith(".npz") else p.name
    gid = stem[len(PREFIX):] if stem.startswith(PREFIX) else stem
    for d in (sightlines_dir(), generated_dir()):
        for name in (f"{PREFIX}{gid}.npz", f"{gid}.npz"):
            if (d / name).is_file():
                return d / name
    raise FileNotFoundError(f"no sightline {gid!r} in {sightlines_dir()} or {generated_dir()}")


def gid_of(path) -> str:
    s = Path(path).stem
    return s[len(PREFIX):] if s.startswith(PREFIX) else s
