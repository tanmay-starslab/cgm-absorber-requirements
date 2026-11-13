"""Galaxy registry helpers for the TNG50 MW/M31 sample (Pillepich et al. 2024; 198 z = 0 hosts).

Where things live (no private paths are hard-coded; every location derives from the environment):

- the sample's source data: $TNG_MWM31_ROOT (else <work root>/data/mwm31), holding
  00_catalogs/mwm31s_hostcatalog.hdf5 and 10_raw/snap_099/subhalo_<id>/snap_99.hdf5 (the published per-galaxy
  ±400 ckpc cutouts, read-only); $TNG_MWM31_CATALOG (the catalogue file) and $TNG_MWM31_CUTOUTS (the directory of
  subhalo_<id>/) override the two parts (the deploy/hpc launcher's variables);
- the pipeline's per-galaxy data: config.gal_root()/<id>/ (galaxy.json, cutout_slim_R400.hdf5, library/, viz/, ...).

The catalogue columns are read with h5py only (no yt); `catalogue_row` returns plain Python scalars.
"""
from __future__ import annotations

import os
from pathlib import Path

from . import config

SNAP = 99
CATALOG_REL = Path("00_catalogs") / "mwm31s_hostcatalog.hdf5"
CUTOUT_REL = "10_raw/snap_{snap:03d}/subhalo_{id}/snap_{snap}.hdf5"


def mwm31_root() -> Path:
    """$TNG_MWM31_ROOT, else <work root>/data/mwm31."""
    v = os.environ.get("TNG_MWM31_ROOT")
    return Path(v).expanduser() if v else config.work_root() / "data" / "mwm31"


def catalog_path() -> Path:
    v = os.environ.get("TNG_MWM31_CATALOG")
    return Path(v).expanduser() if v else mwm31_root() / CATALOG_REL


def source_cutout(galaxy_id: int, snap: int = SNAP) -> Path:
    """The published cutout of one galaxy (read-only input of the record and slim stages):
    $TNG_MWM31_CUTOUTS/subhalo_<id>/snap_<snap>.hdf5 when that variable is set, else under mwm31_root()."""
    v = os.environ.get("TNG_MWM31_CUTOUTS")
    if v:
        return Path(v).expanduser() / f"subhalo_{int(galaxy_id)}" / f"snap_{snap}.hdf5"
    return mwm31_root() / CUTOUT_REL.format(snap=snap, id=int(galaxy_id))


def galaxy_dir(galaxy_id: int, root=None) -> Path:
    return (Path(root) if root else config.gal_root()) / str(int(galaxy_id))


def read_catalogue() -> dict:
    """{column: numpy array} of the host catalogue (198 rows)."""
    import h5py
    with h5py.File(catalog_path(), "r") as h:
        return {k: h[k][()] for k in h.keys() if hasattr(h[k], "shape")}


def sample_ids() -> list[int]:
    """Subfind ids of the sample, in catalogue order."""
    return [int(x) for x in read_catalogue()["SubfindID"]]


def catalogue_row(galaxy_id: int, cat: dict | None = None) -> dict:
    """{column: python scalar} of one galaxy. KeyError when the id is not in the sample."""
    import numpy as np
    cat = cat if cat is not None else read_catalogue()
    idx = np.nonzero(cat["SubfindID"] == int(galaxy_id))[0]
    if idx.size != 1:
        raise KeyError(f"subhalo {galaxy_id} is not in the MW/M31 host catalogue {catalog_path()}")
    i = int(idx[0])
    return {k: v[i].item() for k, v in cat.items()}


def label(galaxy_id: int, row: dict) -> str:
    kind = "MW/M31 analogue" if row.get("FlagMWM31") else "MW/M31 sample"
    return f"Subhalo {int(galaxy_id)} ({'central' if row.get('FlagCentral') else 'satellite'}, {kind})"


def mw_m31_flags(row: dict) -> tuple[bool, bool]:
    """(MW-like, M31-like) by stellar mass within 30 kpc, the Pillepich et al. (2024, §2.3) demarcation at
    10^10.9 Msun: MW-like 10^10.5-10.9, M31-like 10^10.9-11.2 Msun (FlagMWM31 is the catalogue's own flag)."""
    m = float(row.get("StellarMass_30kpc") or 0.0)
    return (m < 10 ** 10.9, m >= 10 ** 10.9)


def list_ready(root=None, marker: str = "record") -> list[int]:
    """Galaxy ids under the pipeline root whose DONE.<marker> exists."""
    r = Path(root) if root else config.gal_root()
    if not r.is_dir():
        return []
    return sorted(int(p.name) for p in r.iterdir() if p.is_dir() and p.name.isdigit()
                  and (p / f"DONE.{marker}").is_file())


GAS_POOR_COLD_CELLS = 1000      # = galpipe.FRAME_MIN_COLD: no cold gas disk (T < 1.5e4 K or n_H > 0.1 within the aperture)


def gas_poor(rec: dict) -> bool | None:
    """True when the galaxy has (almost) no cold gas disk: fewer than GAS_POOR_COLD_CELLS cold cells within the
    frame aperture (galaxy.json frame.n_cold). Such hosts (e.g. the gas-free S0 613192, the quenched 447914) show
    low-ion columns orders of magnitude below 488530; the picker tags them. Records made before frame.n_cold existed:
    a stellar-tracer frame meant < 200 cold cells. None when the record has no frame block."""
    fr = rec.get("frame") or {}
    if not fr:
        return None
    n = fr.get("n_cold")
    if n is None:
        return fr.get("tracer") == "stars"
    return int(n) < GAS_POOR_COLD_CELLS
