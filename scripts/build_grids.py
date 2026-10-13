"""Precompute the detection cube K(logN, b, R) and separation cube G(logN, dv, R) for every ion.

    python scripts/build_grids.py            # all ions (~1 min per ion on 2 cores)
    python scripts/build_grids.py "O VI"     # one ion
"""
import sys, time
from multiprocessing import Pool
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from absreq.lines import cgm_lines
from absreq.detection import k_cube
from absreq.separation import separation_G

OUT = Path(__file__).resolve().parents[1] / "grids"
R_DET = np.logspace(3, 5, 33)
R_SEP = np.logspace(3, 5, 17)


def axes(line):
    n1 = line.logN_tau1()
    logN_det = np.round(np.arange(n1 - 1.7, n1 + 1.81, 0.1), 2)
    b_det = np.logspace(np.log10(max(1.5, line.b_fid / 3)), np.log10(line.b_fid * 4), 16)
    logN_sep = np.round(np.arange(n1 - 1.2, n1 + 1.41, 0.2), 2)
    dv_sep = np.logspace(np.log10(max(0.8, 0.3 * line.b_fid)), np.log10(300), 24)
    return logN_det, b_det, logN_sep, dv_sep


def _row(args):
    line, i, lN, dv = args
    out = np.empty((dv.size, R_SEP.size))
    for j, d in enumerate(dv):
        for k, R in enumerate(R_SEP):
            out[j, k] = separation_G(line, lN, line.b_fid, d, R)
    return i, out


def build(line, procs=2):
    t = time.time()
    logN_det, b_det, logN_sep, dv_sep = axes(line)
    K = k_cube(line, logN_det, b_det, R_DET)
    G = np.empty((logN_sep.size, dv_sep.size, R_SEP.size))
    with Pool(procs) as p:
        for i, out in p.imap_unordered(_row, [(line, i, lN, dv_sep) for i, lN in enumerate(logN_sep)]):
            G[i] = out
    np.savez_compressed(OUT / f"{line.key}.npz", ion=line.ion, lam=line.lam, f=line.f, b_fid=line.b_fid,
                        logN_det=logN_det, b_det=b_det, R_det=R_DET, K=K,
                        logN_sep=logN_sep, dv_sep=dv_sep, R_sep=R_SEP, G=G)
    print(f"{line.ion:8s} {line.lam:9.3f}  done in {time.time() - t:5.0f}s", flush=True)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    want = sys.argv[1:]
    for L in cgm_lines():
        if not want or L.ion in want:
            build(L)
