"""Showcase scoring (port of tng50/scripts/score_sightlines.py metrics, no rendering/CSV I/O).

Per ion, on the R=40,000 noiseless model over ±400 km/s (full npz grid, dλ=0.002, +v_sys frame):
n_comp (find_peaks on 1−flux), min_flux, depth, unsat, score = n_comp·unsat·min(depth, 0.9).
"""
from __future__ import annotations
import numpy as np
from scipy.signal import find_peaks
from .config import LINE_KEYS, DLAMBDA
from .degrade import degrade

VWIN = 400.0
R_EVAL = 40000
ION_W = {"OVI": 1.5, "CIII": 0.6, "HILyb": 0.35}
# Catalog-level marker of the frame/LSF the stored scores were computed in (catalog.json "scoring");
# deploy/data/build_library.py rescores every library entry when it differs.
SCORING_TAG = "V=c(lam/lam0-1)+v_sys; dlam=0.002; R=40000; vwin=400"


def ion_metrics(lam, tau, rest, v_sys, dlam=DLAMBDA) -> dict:
    _, _, model = degrade(lam, tau, rest, R_EVAL, None, v_sys, dlam=dlam, vwin=VWIN)
    d = 1.0 - model
    peaks, _ = find_peaks(d, height=0.20, prominence=0.12, distance=8)
    n_comp = int(peaks.size)
    min_flux = float(model.min())
    depth = 1.0 - min_flux
    absorbed = model < 0.85
    n_abs = int(absorbed.sum())
    frac_black = (float((model < 0.05).sum()) / n_abs) if n_abs else 0.0
    unsat = 1.0 - frac_black
    score = n_comp * unsat * min(depth, 0.9)
    showcase = (n_comp >= 2) and (min_flux > 0.06) and (depth >= 0.35)
    return dict(n_comp=n_comp, min_flux=min_flux, depth=depth, unsat=unsat,
                score=float(score), showcase=bool(showcase))


def score_payload(payload) -> dict:
    """Flat record with the grid_index.csv score columns (rank None: not part of a ranked set)."""
    rec, comp, n_show = {"rank": None}, 0.0, 0
    for key in LINE_KEYS:
        m = ion_metrics(np.asarray(payload["lam"][key], float), np.asarray(payload["tau"][key], float),
                        float(payload["rest"][key]), float(payload["v_sys"]))
        for k, v in m.items():
            rec[f"{key}_{k}"] = v
        rec[f"logN_{key}"] = float(payload["logN"][key])
        comp += ION_W[key] * m["score"]
        n_show += int(m["showcase"])
    rec["showcase_score"] = float(comp)
    rec["n_showcase_ions"] = int(n_show)
    rec["ovi_showcase"] = bool(rec["OVI_showcase"])
    return rec


def assign_ranks(entries) -> None:
    """In place: rank 1..N over entries with a score (showcase_score descending, id breaks ties)."""
    scored = sorted((e for e in entries if e.get("score") is not None), key=lambda e: (-e["score"], e["id"]))
    for i, e in enumerate(scored, 1):
        e["rank"] = i
