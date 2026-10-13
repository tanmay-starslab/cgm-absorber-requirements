#!/usr/bin/env python3
"""Pedagogical demo of how spectral resolution R, S/N, and pixels-per-resolution-element shape a
mock CGM absorption line. Three stories in one figure:
  Row A: same line at increasing R (noiseless)  -> lines sharpen, blended components separate.
  Row B: same line at fixed R, decreasing S/N    -> noise grows, weak structure gets buried.
  Row C: zoom showing 1 resolution element (=c/R) sampled by 5 detector pixels.
Usage: python demo_resolution_snr.py [geom_id] [ion]
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np
import matplotlib.pyplot as plt
from matplotlib import gridspec

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_style as CS                                   # noqa: E402
import cgm_paths as P                                    # noqa: E402
from degrade import degrade, velocity_axis, C_KMS, PIX_PER_RESEL        # noqa: E402



def load(gid):
    return np.load(P.find_sightline(gid), allow_pickle=True)


def arrays(data, ion):
    lam = np.asarray(data[f"{ion}_lambda"], float)
    tau = np.asarray(data[f"{ion}_tau"], float)
    rest = float(data[f"{ion}_rest"]); vsys = float(data["v_sys"])
    return lam, tau, rest, vsys


def _fmt(ax, vwin, ylab=False, xlab=False):
    ax.set_xlim(-vwin, vwin); ax.set_ylim(-0.08, 1.30)
    ax.axhline(1.0, color="0.6", ls="--", lw=1.0, zorder=0)
    if ylab:
        ax.set_ylabel("normalized flux")
    if xlab:
        ax.set_xlabel(r"$V_{\rm LOS}-V_{\rm sys}\ \ [\mathrm{km\,s^{-1}}]$")


def main():
    CS.set_style(base=15)
    gid = sys.argv[1] if len(sys.argv) > 1 else "face_b050_a090"
    ion = sys.argv[2] if len(sys.argv) > 2 else "CIII"
    vwin = 300.0
    data = load(gid)
    col = CS.ION[ion]["color"]; ionlab = CS.ION[ion]["label"]
    lam, tau, rest, vsys = arrays(data, ion)
    v_hi = velocity_axis(lam, rest, vsys)       # same (fixed) frame as degrade()
    f_hi = np.exp(-tau)
    mtruth = (v_hi >= -vwin) & (v_hi <= vwin)

    fig = plt.figure(figsize=(17, 12.6))
    gs = gridspec.GridSpec(3, 3, height_ratios=[1.0, 1.0, 0.95], hspace=0.46, wspace=0.14,
                           left=0.06, right=0.985, top=0.94, bottom=0.07)

    # ---------- Row A: effect of R (noiseless) ----------
    for j, R in enumerate([10000, 20000, 40000]):
        ax = fig.add_subplot(gs[0, j])
        ax.plot(v_hi[mtruth], f_hi[mtruth], color="0.62", lw=1.3, zorder=2,
                label="intrinsic (unconvolved)")
        _, _, fm = degrade(lam, tau, rest, R, None, vsys, vwin=vwin)
        v = np.linspace(-vwin, vwin, fm.size)
        ax.plot(v, fm, color=col, lw=3.4, zorder=3, label=f"observed at R={R:,}")
        ax.fill_between(v, fm, 1.0, where=(fm < 1.0), color=col, alpha=0.16, lw=0, zorder=1)
        ax.set_title(rf"$R = {R:,}$    ($c/R = {C_KMS/R:.1f}$ km/s)")
        _fmt(ax, vwin, ylab=(j == 0))
        if j == 0:
            ax.legend(loc="lower left", fontsize=11.5, framealpha=0.95)
    fig.text(0.5, 0.955, r"\textbf{A.  Spectral resolution }$R$\textbf{ (Gaussian LSF blur) — noiseless}"
             if CS.plt.rcParams["text.usetex"] else "A.  Spectral resolution R (Gaussian LSF blur) — noiseless",
             ha="center", va="bottom", fontsize=16)

    # ---------- Row B: effect of S/N at fixed R ----------
    R0 = 40000
    for j, snr in enumerate([15, 8, 5]):
        ax = fig.add_subplot(gs[1, j])
        v, fn, fm = degrade(lam, tau, rest, R0, snr, vsys, seed=7, vwin=vwin)
        ax.step(v, fn, where="mid", color=col, lw=0.9, alpha=0.55, zorder=2,
                label=f"S/N = {snr} data")
        ax.fill_between(v, fm, 1.0, where=(fm < 1.0), color=col, alpha=0.16, lw=0, zorder=1)
        ax.plot(v, fm, color=col, lw=3.0, zorder=3, label="noiseless model")
        sig = np.sqrt(PIX_PER_RESEL) / snr
        ax.set_title(rf"$R = {R0:,}$,  S/N $= {snr}$    ($\sigma_{{\rm pix}} = {sig:.2f}$)")
        _fmt(ax, vwin, ylab=(j == 0))
        if j == 0:
            ax.legend(loc="lower left", fontsize=11.5, framealpha=0.95)
    fig.text(0.5, 0.635, "B.  Signal-to-noise S/N (per resolution element) at fixed R = 40,000",
             ha="center", va="bottom", fontsize=16)

    # ---------- Row C: pixels per resolution element (zoom on a steep line wing) ----------
    axz = fig.add_subplot(gs[2, :])
    v, fn, fm = degrade(lam, tau, rest, R0, 8, vsys, seed=11, vwin=vwin)
    dv_resel = C_KMS / R0            # 7.5 km/s
    # centre on the steepest, non-saturated wing so the 5-pixel sampling traces a real gradient
    grad = np.abs(np.gradient(fm, v))
    wing = np.where((fm > 0.08) & (fm < 0.95), grad, 0.0)
    i0 = int(np.argmax(wing))
    vc = v[i0]
    zoom = 34.0
    axz.plot(v, fm, color=col, lw=3.2, zorder=3, label="noiseless model (continuous line)")
    axz.plot(v, fm, ls="none", marker="o", ms=8, mfc=col, mec="white", mew=1.0, zorder=4,
             label="detector pixels (samples)")
    # shade one resolution element straddling the wing; drop a tick at each of its 5 pixels
    es = vc - dv_resel / 2.0
    axz.axvspan(es, es + dv_resel, color="0.86", zorder=0)
    inside = (v >= es - 1e-6) & (v <= es + dv_resel + 1e-6)
    axz.plot(v[inside], fm[inside], ls="none", marker="o", ms=8, mfc="0.15", mec="white",
             mew=1.0, zorder=6)
    axz.plot(v[inside], np.full(inside.sum(), 1.20), ls="none", marker="|", ms=18,
             mec="0.15", mew=1.8, zorder=5)
    axz.annotate("", xy=(es, 1.235), xytext=(es + dv_resel, 1.235),
                 arrowprops=dict(arrowstyle="<->", color="0.15", lw=1.8))
    axz.text(es + dv_resel / 2, 1.255,
             rf"1 resolution element $= c/R = {dv_resel:.1f}$ km/s $= {PIX_PER_RESEL}$ pixels",
             ha="center", va="bottom", fontsize=13.5)
    axz.set_xlim(vc - zoom, vc + zoom); axz.set_ylim(-0.05, 1.34)
    axz.axhline(1.0, color="0.6", ls="--", lw=1.0, zorder=0)
    axz.set_ylabel("normalized flux")
    axz.set_xlabel(r"$V_{\rm LOS}-V_{\rm sys}\ \ [\mathrm{km\,s^{-1}}]$")
    axz.legend(loc="lower right", fontsize=12, framealpha=0.95)
    fig.text(0.5, 0.335, rf"C.  Sampling: {PIX_PER_RESEL} detector pixels per resolution element "
             rf"(R = 40,000  $\rightarrow$  pixel = {dv_resel/PIX_PER_RESEL:.1f} km/s)",
             ha="center", va="bottom", fontsize=16)

    # ion tag
    fig.text(0.995, 0.005, ionlab + rf"   ·   sightline {gid}", ha="right", va="bottom",
             color=col, fontsize=13)
    CS.save(fig, "demo_resolution_snr")
    print(f"saved demo for ion={ion} gid={gid}  deepest pixel at v={vc:+.1f} km/s")


if __name__ == "__main__":
    main()
