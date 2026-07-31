#!/usr/bin/env python3
"""Rank sightlines by how well they SHOW the effect of R and S/N — i.e. lines with MULTIPLE,
resolved velocity components that are NOT saturated (residual flux visible in the cores). Saturated
black troughs look identical at every R and S/N, so they are poor demonstrators; partially-absorbed
multi-component lines are the good ones.

For each sightline and ion we work on the R=40,000 noiseless model (the sharpest view) over
±400 km/s and measure:
  n_comp   number of distinct absorption components (scipy find_peaks on 1-flux)
  min_flux deepest residual flux  (min_flux -> 0 means saturated)
  depth    1 - min_flux
  unsat    1 - (fraction of absorbed pixels that are fully black)   [1 = unsaturated]
  score    n_comp * unsat * min(depth, 0.9)   (multi-component AND unsaturated AND detectable)
A per-sightline composite favours O VI (the ion whose R/S-N response is cleanest) but rewards
multi-ion richness. Writes the metrics back into grid_index.csv, a sorted showcase_ranking.csv,
and (optionally) renders the top-N publication figures.

Usage: python score_sightlines.py [--render N]
"""
from __future__ import annotations
import sys, json, glob
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.signal import find_peaks

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from degrade import degrade                       # noqa: E402
import cgm_style as CS                             # noqa: E402

DATA = ROOT / "data" / "sightlines"
INDEX = ROOT / "data" / "grid_index.csv"
RANK = ROOT / "data" / "showcase_ranking.csv"
VWIN = 400.0
R_EVAL = 40000
ION_W = {"OVI": 1.5, "CIII": 0.6, "HILyb": 0.35}   # O VI weighted most (cleanest R/S-N demo)


def ion_metrics(lam, tau, rest, v_sys):
    _, _, model = degrade(lam, tau, rest, R_EVAL, None, v_sys, vwin=VWIN)
    d = 1.0 - model
    # distinct components: >=20% deep, prominence >=0.12, >=~12 km/s apart (distance 8 px @1.5 km/s)
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


def score_file(fp):
    d = np.load(fp, allow_pickle=True)
    geom = json.loads(str(d["geom"])); v_sys = float(d["v_sys"])
    rec = dict(file=Path(fp).name, geom_id=Path(fp).stem.replace("cgm_sid488530_", ""),
               orientation=geom["orientation"], b_kpc=float(geom["b_kpc"]),
               azimuth_deg=float(geom["azimuth_deg"]), v_sys=v_sys)
    comp = 0.0
    n_show = 0
    for key in CS.ION_ORDER:
        m = ion_metrics(np.asarray(d[f"{key}_lambda"], float),
                        np.asarray(d[f"{key}_tau"], float),
                        float(d[f"{key}_rest"]), v_sys)
        for k, v in m.items():
            rec[f"{key}_{k}"] = v
        rec[f"logN_{key}"] = float(d[f"logN_{key}"])
        comp += ION_W[key] * m["score"]
        n_show += int(m["showcase"])
    rec["showcase_score"] = float(comp)
    rec["n_showcase_ions"] = int(n_show)
    rec["ovi_showcase"] = bool(rec["OVI_showcase"])
    return rec


def main():
    render_n = 0
    if "--render" in sys.argv:
        render_n = int(sys.argv[sys.argv.index("--render") + 1])
    files = sorted(glob.glob(str(DATA / "*.npz")))
    print(f"scoring {len(files)} sightlines on the R={R_EVAL:,} model ...", flush=True)
    rows = [score_file(f) for f in files]
    df = pd.DataFrame(rows).sort_values("showcase_score", ascending=False).reset_index(drop=True)
    df.insert(0, "rank", np.arange(1, len(df) + 1))

    # merge scores into grid_index.csv (keep its columns, add the score columns)
    score_cols = ["rank", "showcase_score", "n_showcase_ions", "ovi_showcase"] + \
        [f"{k}_{m}" for k in CS.ION_ORDER for m in ("n_comp", "min_flux", "depth", "score", "showcase")]
    if INDEX.exists():
        idx = pd.read_csv(INDEX)
        idx = idx.drop(columns=[c for c in score_cols if c in idx.columns], errors="ignore")
        idx = idx.merge(df[["file"] + score_cols], on="file", how="left")
        idx.to_csv(INDEX, index=False)
    df.to_csv(RANK, index=False)

    n_ovi = int(df.ovi_showcase.sum())
    n_multi = int((df.n_showcase_ions >= 1).sum())
    print(f"\n{n_ovi} sightlines are O VI multi-component & unsaturated; "
          f"{n_multi} show >=1 showcase ion.")
    print(f"\n{'rank':>4} {'geom_id':<26} {'OVIn':>4} {'OVImin':>6} {'CIIIn':>5} {'HIn':>4} "
          f"{'score':>6}  logN(OVI/HI/CIII)")
    for _, r in df.head(18).iterrows():
        print(f"{r['rank']:>4} {r.geom_id:<26} {int(r.OVI_n_comp):>4} {r.OVI_min_flux:>6.2f} "
              f"{int(r.CIII_n_comp):>5} {int(r.HILyb_n_comp):>4} {r.showcase_score:>6.2f}  "
              f"{r.logN_OVI:.2f}/{r.logN_HILyb:.2f}/{r.logN_CIII:.2f}")
    print(f"\nwrote {RANK}  and merged scores into {INDEX}")

    if render_n > 0:
        import make_publication_figure as MPF
        CS.set_style()
        for _, r in df.head(render_n).iterrows():
            data = np.load(DATA / r.file, allow_pickle=True)
            fig, _ = MPF.build_figure(data)
            CS.save(fig, f"showcase_rank{int(r['rank']):02d}_{r.geom_id}")
        print(f"rendered top {render_n} showcase figures -> figures/showcase_rank*.png")


if __name__ == "__main__":
    main()
