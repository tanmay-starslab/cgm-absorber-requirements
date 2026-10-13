#!/usr/bin/env python3
"""Sanity-check the CGM pipeline: synthetic O VI columns (integrated along each mock-QSO ray)
vs the independent OVI_CGM_compare radial O VI profile for the SAME TNG50-1 subhalo 488530.

The OVI_CGM_compare profile logN_OVI(R_perp) is an azimuthally-averaged, face-projected sightline
column (rays along the projection axis). Our rays are full ±R200c chords at impact b, so at a given
b they should bracket that averaged profile (with azimuthal scatter from disk/outflow structure).
A match to ~0.1-0.2 dex confirms geometry, ion fields, and ray integration are all correct.
Writes figures/validate_ovi_columns.{png,pdf} and prints a per-b comparison table.
"""
from __future__ import annotations
import sys, json
from pathlib import Path
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_style as CS  # noqa: E402

REF = Path("<SCRATCH>/OVI_CGM_compare/cache/tng_sanity.json")
DATA = ROOT / "data" / "sightlines"
INDEX = ROOT / "data" / "grid_index.csv"


def load_reference():
    d = json.load(open(REF))
    return np.asarray(d["radial_bins_kpc"], float), np.asarray(d["radial_logN_OVI"], float)


def load_mine():
    df = pd.read_csv(INDEX)
    rows = []
    for _, r in df.iterrows():
        rows.append(dict(b=float(r["b_kpc"]), orient=str(r["orientation"]),
                         az=float(r["azimuth_deg"]), logOVI=float(r["logOVI"])))
    return pd.DataFrame(rows)


def main():
    CS.set_style()
    Rb, logN = load_reference()
    mine = load_mine()

    fig, ax = plt.subplots(figsize=(9.2, 7.2))
    # reference azimuthally-averaged profile
    ax.plot(Rb, logN, color="0.25", lw=3.0, zorder=4,
            label=r"OVI\_CGM\_compare radial mean")
    ax.fill_between(Rb, logN - 0.15, logN + 0.15, color="0.6", alpha=0.25, lw=0, zorder=1)

    # my synthetic ray columns, coloured by orientation, sized to show azimuthal spread
    styles = {"face-on": dict(marker="o", color=CS.ION["OVI"]["color"], label="face-on rays"),
              "edge-on": dict(marker="s", color=CS.ION["HILyb"]["color"], label="edge-on rays")}
    for orient, st in styles.items():
        sub = mine[mine.orient == orient]
        ax.scatter(sub.b + (2.0 if orient == "edge-on" else -2.0), sub.logOVI,
                   s=120, marker=st["marker"], facecolor=st["color"], edgecolor="white",
                   linewidth=1.2, alpha=0.9, zorder=5, label=st["label"])

    # per-b comparison table (interp reference to each b)
    print(f"{'b[kpc]':>7} {'ref':>7} {'mine(mean)':>11} {'min':>7} {'max':>7} {'Δmean':>7}")
    for b in sorted(mine.b.unique()):
        sub = mine[mine.b == b]
        ref = float(np.interp(b, Rb, logN))
        mmean = float(sub.logOVI.mean())
        print(f"{b:7.0f} {ref:7.2f} {mmean:11.2f} {sub.logOVI.min():7.2f} "
              f"{sub.logOVI.max():7.2f} {mmean-ref:+7.2f}")

    ax.set_xlabel(r"impact parameter $b\ [\mathrm{kpc}]$")
    ax.set_ylabel(r"$\log_{10} N_{\mathrm O\,VI}\ [\mathrm{cm^{-2}}]$")
    ax.set_xlim(0, 165)
    ax.legend(loc="upper right", fontsize=CS.plt.rcParams["legend.fontsize"])
    fig.tight_layout()
    p = CS.save(fig, "validate_ovi_columns")
    print(f"\nsaved {p}")


if __name__ == "__main__":
    main()
