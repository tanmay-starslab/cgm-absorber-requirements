#!/usr/bin/env python3
"""Export all sightlines to a compact JSON blob for the self-contained browser app.

For each (sightline, ion) we resample the noiseless transmission flux = exp(-tau) onto a uniform
velocity grid V = V_LOS - V_sys in [-850, 850] km/s (1 km/s) and store it as uint8 (flux*255),
base64-encoded. The browser then applies the SAME degrade() math (Gaussian LSF for R, noise per
resolution element for S/N) live in JavaScript. Sorted by showcase score; ships the star flag.
Writes delivery/_webdata.json.
"""
from __future__ import annotations
import sys, json, base64, glob
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_style as CS                     # noqa: E402

DATA = ROOT / "data" / "sightlines"
INDEX = ROOT / "data" / "grid_index.csv"
OUT = ROOT / "delivery" / "_webdata.json"
C_KMS = 299792.458
VMIN, VMAX, DV = -850.0, 850.0, 1.0

ION_LABEL = {"OVI": "O VI λ1032", "HILyb": "H I Lyβ", "CIII": "C III λ977"}


def flux_b64(lam, tau, rest, vsys, vgrid):
    v = C_KMS * (lam / rest - 1.0) - vsys
    flux = np.exp(-np.asarray(tau, float))
    order = np.argsort(v)
    f = np.interp(vgrid, v[order], flux[order], left=1.0, right=1.0)
    u8 = np.clip(np.round(np.clip(f, 0.0, 1.0) * 255.0), 0, 255).astype(np.uint8)
    return base64.b64encode(u8.tobytes()).decode("ascii")


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    vgrid = np.arange(VMIN, VMAX + DV, DV)
    scores = {}
    if INDEX.exists():
        idx = pd.read_csv(INDEX)
        for _, r in idx.iterrows():
            scores[r["file"]] = r
    files = sorted(glob.glob(str(DATA / "*.npz")))
    sightlines = []
    for fp in files:
        d = np.load(fp, allow_pickle=True)
        geom = json.loads(str(d["geom"])); vsys = float(d["v_sys"])
        name = Path(fp).name
        row = scores.get(name)
        star = 0
        if row is not None:
            if bool(row.get("ovi_showcase", False)):
                star = 2
            elif (row.get("n_showcase_ions", 0) or 0) >= 1:
                star = 1
        rec = dict(
            id=Path(fp).stem.replace("cgm_sid488530_", ""),
            orient=geom["orientation"], b=round(float(geom["b_kpc"]), 1),
            az=round(float(geom["azimuth_deg"]), 1), vsys=round(vsys, 1),
            logN={k: round(float(d[f"logN_{k}"]), 2) for k in CS.ION_ORDER},
            score=float(row["showcase_score"]) if (row is not None and "showcase_score" in row
                                                   and pd.notna(row["showcase_score"])) else 0.0,
            star=star,
            flux={k: flux_b64(np.asarray(d[f"{k}_lambda"], float),
                              np.asarray(d[f"{k}_tau"], float),
                              float(d[f"{k}_rest"]), vsys, vgrid) for k in CS.ION_ORDER},
        )
        sightlines.append(rec)
    sightlines.sort(key=lambda s: s["score"], reverse=True)

    payload = dict(
        meta=dict(
            title="CGM Mock-QSO Spectra · TNG50-1 sub-488530",
            vmin=VMIN, vmax=VMAX, dv=DV, c_kms=C_KMS, pix_per_resel=5,
            columns=[[20000, 8], [40000, 8], [20000, 5], [40000, 5]],
            ions=[dict(key=k, color=CS.ION[k]["color"], label=ION_LABEL[k]) for k in CS.ION_ORDER],
            n=len(sightlines),
        ),
        sightlines=sightlines,
    )
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    mb = OUT.stat().st_size / 1e6
    n_star = sum(s["star"] == 2 for s in sightlines)
    print(f"wrote {OUT}  ({mb:.2f} MB, {len(sightlines)} sightlines, {n_star} O VI showcase)")


if __name__ == "__main__":
    main()
