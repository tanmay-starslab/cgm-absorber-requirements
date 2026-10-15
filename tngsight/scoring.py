"""Showcase scoring (port of tng50/scripts/score_sightlines.py metrics, no rendering/CSV I/O), v2.

Per line present, on the noiseless model at the band's R_eval (UV/EUV 40,000, X-ray 1,000) over ±400 km/s, made by
degrade_v from the 1 km/s web flux (library.web_flux, the page's data) in the +v_sys frame:
n_comp (find_peaks on 1−flux), min_flux, depth, unsat, score = n_comp·unsat·min(depth, 0.9).
showcase_score = Σ score_w(k)·score_k over the lines present (registry weights); star = the O VI showcase flag.
"""
from __future__ import annotations
import numpy as np
from scipy.signal import find_peaks
from . import ions as I
from .config import DV_WEB
from .degrade import degrade_v

VWIN = 400.0
ION_W = {k: float(I.get(k)["score_w"]) for k in I.KEYS}
# Catalog-level marker of the frame/LSF the stored scores were computed in (catalog.json "scoring").
SCORING_TAG = "tngsight-score/2; V=u+v_sys; web 1 km/s; R_eval per band; vwin=400"


def metrics_from_model(model) -> dict:
    model = np.asarray(model, float)
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


def ion_metrics(u, flux, v_sys, R, du=DV_WEB) -> dict:
    """Metrics of one line from its (web) flux on the rest-frame velocity grid u."""
    _, _, model = degrade_v(u, flux, R, None, v_sys, du, vwin=VWIN)
    return metrics_from_model(model)


def ion_metrics_v1(lam, tau, rest, v_sys, dlam=None, R=40000) -> dict:
    """The v1 metrics (λ grid, degrade() with an explicit dλ); kept to reproduce the legacy grid_index.csv scores."""
    from .config import DLAMBDA
    from .degrade import degrade
    _, _, model = degrade(lam, tau, rest, R, None, v_sys, dlam=DLAMBDA if dlam is None else dlam, vwin=VWIN)
    return metrics_from_model(model)


def score_payload(payload) -> dict:
    """Flat record with the score columns (rank None: not part of a ranked set) over payload["lines"]."""
    from .library import web_flux
    rec, comp, n_show = {"rank": None}, 0.0, 0
    for key in payload["lines"]:
        u, F = web_flux(payload, key)
        m = ion_metrics(u, F, float(payload["v_sys"]), I.band(key)["R_eval"])
        for k, v in m.items():
            rec[f"{key}_{k}"] = v
        rec[f"logN_{key}"] = float(payload["logN"][key])
        comp += ION_W[key] * m["score"]
        n_show += int(m["showcase"])
    rec["showcase_score"] = float(comp)
    rec["n_showcase_ions"] = int(n_show)
    rec["ovi_showcase"] = bool(rec.get("OVI_showcase", False))
    return rec


def assign_ranks(entries) -> None:
    """In place: rank 1..N over entries with a score (showcase_score descending, id breaks ties)."""
    scored = sorted((e for e in entries if e.get("score") is not None), key=lambda e: (-e["score"], e["id"]))
    for i, e in enumerate(scored, 1):
        e["rank"] = i
