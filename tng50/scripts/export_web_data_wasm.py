#!/usr/bin/env python3
"""Export data for the PIXEL-IDENTICAL (Pyodide/WASM) Explorer, which runs the ACTUAL matplotlib
build_figure()/degrade() in the browser. We therefore ship the real inputs those functions need:
per ion the (shared) wavelength grid once, and per (sightline, ion) the optical depth tau on that
grid, trimmed to +-1000 km/s (covers vwin<=800 plus the LSF wings) and stored as float16.
Reads the library at cgm_paths.sightlines_dir(); writes cgm_paths.out_dir()/delivery/_webdata_wasm.json
(~18 MB, so never into the repo). The browser degrade() uses the explicit dλ = 0.002 Å, so the
±1000 km/s trim no longer changes the H I Lyβ LSF width (it used median(diff(λ)) of the trimmed grid).
"""
from __future__ import annotations
import sys, json, base64
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_paths as P                      # noqa: E402
import cgm_style as CS                     # noqa: E402
from tngsight.config import C_KMS          # noqa: E402

INDEX = P.repo_data() / "grid_index.csv"
OUT = P.out_dir() / "delivery" / "_webdata_wasm.json"
VTRIM = 1000.0
ION_LABEL = {"OVI": "O VI λ1032", "HILyb": "H I Lyβ", "CIII": "C III λ977"}


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    scores = {}
    if INDEX.exists():
        for _, r in pd.read_csv(INDEX).iterrows():
            scores[r["geom_id"]] = r          # by id: library files may be <id>.npz or cgm_sid488530_<id>.npz

    # canonical (trimmed) wavelength grid per ion, taken from the first sightline
    files = sorted(str(f) for f in P.sightlines_dir().glob("*.npz"))
    d0 = np.load(files[0], allow_pickle=True)
    canon = {}
    ions_meta = []
    for k in CS.ION_ORDER:
        rest = float(d0[f"{k}_rest"])
        lam0 = np.asarray(d0[f"{k}_lambda"], float)
        v = C_KMS * (lam0 / rest - 1.0)
        m = np.abs(v) <= VTRIM
        lam = lam0[m]
        canon[k] = (lam, rest)
        ions_meta.append(dict(
            key=k, color=CS.ION[k]["color"], label=ION_LABEL[k], rest=rest, n=int(lam.size),
            lam=base64.b64encode(lam.astype("<f4").tobytes()).decode("ascii")))

    sightlines = []
    for fp in files:
        d = np.load(fp, allow_pickle=True)
        geom = json.loads(str(d["geom"])); vsys = float(d["v_sys"])
        row = scores.get(P.gid_of(fp))
        star = 0
        if row is not None:
            if bool(row.get("ovi_showcase", False)):
                star = 2
            elif (row.get("n_showcase_ions", 0) or 0) >= 1:
                star = 1
        tau_b = {}
        for k in CS.ION_ORDER:
            lam, rest = canon[k]
            lamk = np.asarray(d[f"{k}_lambda"], float); tauk = np.asarray(d[f"{k}_tau"], float)
            # onto the shared grid (identity if same); clip tau<=40 (exp(-40)~0) to fit float16
            tc = np.clip(np.interp(lam, lamk, tauk), 0.0, 40.0).astype("<f2")
            tau_b[k] = base64.b64encode(tc.tobytes()).decode("ascii")
        sightlines.append(dict(
            id=P.gid_of(fp),
            orient=geom["orientation"], b=round(float(geom["b_kpc"]), 1),
            az=round(float(geom["azimuth_deg"]), 1), vsys=round(vsys, 4),
            logN={k: round(float(d[f"logN_{k}"]), 2) for k in CS.ION_ORDER},
            score=float(row["showcase_score"]) if (row is not None and "showcase_score" in row
                                                   and pd.notna(row["showcase_score"])) else 0.0,
            star=star, tau=tau_b))
    sightlines.sort(key=lambda s: s["score"], reverse=True)

    payload = dict(meta=dict(
        title="CGM Mock-QSO Spectra · TNG50-1 sub-488530", vtrim=VTRIM, c_kms=C_KMS,
        pix_per_resel=5, columns=[[20000, 8], [40000, 8], [20000, 5], [40000, 5]],
        ions=ions_meta, n=len(sightlines)), sightlines=sightlines)
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {OUT}  ({OUT.stat().st_size/1e6:.2f} MB, {len(sightlines)} sightlines, "
          f"grid pts/ion: {[im['n'] for im in ions_meta]})")


if __name__ == "__main__":
    main()
