#!/usr/bin/env python3
"""Slim the Trident ion table to the elements the explorer needs (H, C, N, O, Ne, Mg, Si).

    python deploy/data/slim_iontable.py [--src FILE] [--out FILE] [--elements H C N O Ne Mg Si] [--no-trident-check]
    (defaults: --src $TNG_WORK/data/trident/hm2012_ss_hr.h5, --out $TNG_WORK/data/trident_slim_v3/hm2012_ss_hr.h5;
    TNG_WORK is the work root, default /Volumes/cgm_work)

Each element dataset is copied with h5py's object copy (same dtype >f4, shape, layout and the three
axis attributes Parameter1/Parameter2/Temperature, verbatim); file-level attributes are copied too.
The element list is the set of elements of the 12 registry ions (tngsight/ions.json: H I, Mg II,
Si II-IV, C II-IV, N V, O VI, O VII, Ne VIII; design.md §4.4); the result is about 186 MB, under the
200 MB guard of upload_hf_dataset.py. H must be kept even though H I comes from
NeutralHydrogenAbundance: trident loads the table for every ion field it adds (critic.md §2.1). The result is then checked value-by-value against the
source and loaded with trident.ion_balance.IonBalanceTable in a subprocess whose cwd holds a
config.tri pointing at the output directory (the same mechanism the server uses).
"""
from __future__ import annotations
import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))
from tngsight.config import work_root  # noqa: E402  (TNG_WORK, default /Volumes/cgm_work)

SRC = work_root() / "data" / "trident" / "hm2012_ss_hr.h5"                # the full HM2012 table
OUT = work_root() / "data" / "trident_slim_v3" / "hm2012_ss_hr.h5"        # v1 (H, C, O): trident_slim/
ELEMENTS = ("H", "C", "N", "O", "Ne", "Mg", "Si")
MAX_BYTES = 190e6                    # design.md §8 U_server 2 (measured 185.7 MB)
AXES = ("Parameter1", "Parameter2", "Temperature")


def slim(src: Path, out: Path, elements=ELEMENTS) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.name}.{os.getpid()}.part")
    with h5py.File(src, "r") as fi, h5py.File(tmp, "w") as fo:
        for k, v in fi.attrs.items():
            fo.attrs[k] = v
        for el in elements:
            if el not in fi:
                raise KeyError(f"{el} not in {src}")
            fi.copy(fi[el], fo, name=el)
    os.replace(tmp, out)


def check(src: Path, out: Path, elements=ELEMENTS) -> None:
    """Datasets, dtypes and attributes identical; nothing else in the file."""
    with h5py.File(src, "r") as fi, h5py.File(out, "r") as fo:
        if sorted(fo.keys()) != sorted(elements):
            raise AssertionError(f"slim file holds {sorted(fo.keys())}")
        if dict(fo.attrs) != dict(fi.attrs):
            raise AssertionError("file attributes differ")
        for el in elements:
            a, b = fi[el], fo[el]
            if a.dtype != b.dtype or a.shape != b.shape:
                raise AssertionError(f"{el}: {b.dtype}{b.shape} != {a.dtype}{a.shape}")
            if sorted(a.attrs) != sorted(b.attrs) or not all(
                    a.attrs[k].dtype == b.attrs[k].dtype and np.array_equal(a.attrs[k], b.attrs[k]) for k in a.attrs):
                raise AssertionError(f"{el}: attributes differ")
            if not all(k in b.attrs for k in AXES):
                raise AssertionError(f"{el}: missing axis attributes")
            if not np.array_equal(a[()], b[()]):
                raise AssertionError(f"{el}: values differ")


TRIDENT_CHECK = r"""
import os, sys, numpy as np, trident
from trident.ion_balance import IonBalanceTable, ion_table_filepath
assert os.path.samefile(ion_table_filepath, sys.argv[1]), ion_table_filepath
for el, n in zip(sys.argv[2].split(","), map(int, sys.argv[3].split(","))):
    t = IonBalanceTable(None, el)                    # None -> the configured default table
    assert t.ion_fraction.shape[0] == n and len(t.parameters) == 3, (el, t.ion_fraction.shape)
    assert np.all(np.isfinite(t.ion_fraction)), el
print("trident ok:", trident.__version__, ion_table_filepath)
"""


def trident_check(out: Path, elements=ELEMENTS, python=sys.executable) -> str:
    """Import trident with a config.tri that points at the slim table and load each element."""
    with h5py.File(out, "r") as fo:
        n = [fo[el].shape[0] for el in elements]
    with tempfile.TemporaryDirectory(prefix="tri_check_", dir=os.environ.get("TNG_WORKDIR")) as cwd:
        Path(cwd, "config.tri").write_text(
            f"[Trident]\nion_table_dir = {out.parent}\nion_table_file = {out.name}\n")
        r = subprocess.run([python, "-c", TRIDENT_CHECK, str(out), ",".join(elements), ",".join(map(str, n))],
                           cwd=cwd, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=1800)
    if r.returncode:
        raise RuntimeError(f"trident check failed:\n{r.stdout}\n{r.stderr[-3000:]}")
    return r.stdout.strip().splitlines()[-1]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", type=Path, default=SRC)
    ap.add_argument("--out", type=Path, default=OUT, help="keep the name hm2012_ss_hr.h5 (config.tri default)")
    ap.add_argument("--elements", nargs="+", default=list(ELEMENTS))
    ap.add_argument("--no-trident-check", action="store_true")
    a = ap.parse_args(argv)
    os.environ.setdefault("HDF5_USE_FILE_LOCKING", "FALSE")
    if a.out.resolve() == a.src.resolve():
        ap.error("--out must differ from --src")
    if a.out.is_file():
        try:
            check(a.src, a.out, a.elements); print(f"{a.out} already up to date")
        except Exception:
            slim(a.src, a.out, a.elements)
    else:
        slim(a.src, a.out, a.elements)
    check(a.src, a.out, a.elements)
    print(f"{a.out}: {a.out.stat().st_size:,} B ({', '.join(a.elements)}); src {a.src.stat().st_size:,} B; "
          "values and attributes identical")
    if a.out.stat().st_size > MAX_BYTES:
        print(f"error: {a.out.stat().st_size:,} B exceeds the {MAX_BYTES:,.0f} B budget", file=sys.stderr)
        return 1
    if not a.no_trident_check:
        print(trident_check(a.out, a.elements))
    return 0


if __name__ == "__main__":
    sys.exit(main())
