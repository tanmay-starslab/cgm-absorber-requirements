#!/usr/bin/env python3
"""3x4 publication figure for one CGM sightline: 3 rows (O VI 1032, H I Lyβ, C III 977) x 4
columns (instrument setups). x-axis = V_LOS − V_sys. Thick vivid curves, major+minor ticks,
beautiful ion-line labels, x/y labels, NO title. Resolution R (Gaussian LSF) and S/N
(per-resolution-element) are applied live from the stored high-res noiseless spectra.

Usage: python make_publication_figure.py <geom_id | npz path> [Rlo Rhi SNhi SNlo]
"""
from __future__ import annotations
import sys, json
from pathlib import Path
import numpy as np
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_style as CS              # noqa: E402
from degrade import degrade, C_KMS  # noqa: E402

DATA = ROOT / "data" / "sightlines"
# columns in the order the user specified: (Rlo,SNhi),(Rhi,SNhi),(Rlo,SNlo),(Rhi,SNlo)
DEF_RLO, DEF_RHI, DEF_SNHI, DEF_SNLO = 20000, 40000, 8, 5
VWIN = 400.0                    # km/s x-range


def load_sightline(which):
    p = Path(which)
    if not p.exists():
        p = DATA / (which if which.endswith(".npz") else f"cgm_sid488530_{which}.npz")
    d = np.load(p, allow_pickle=True)
    return d


def _columns(Rlo, Rhi, SNhi, SNlo):
    return [(Rlo, SNhi), (Rhi, SNhi), (Rlo, SNlo), (Rhi, SNlo)]


def build_figure(data, Rlo=DEF_RLO, Rhi=DEF_RHI, SNhi=DEF_SNHI, SNlo=DEF_SNLO,
                 vwin=VWIN, seed=0, show_intrinsic=False):
    cols = _columns(Rlo, Rhi, SNhi, SNlo)
    v_sys = float(data["v_sys"])
    geom = json.loads(str(data["geom"]))
    fig, ax = plt.subplots(3, 4, figsize=(19, 10.6), sharex=True, sharey=True)
    for r, key in enumerate(CS.ION_ORDER):
        lam = np.asarray(data[f"{key}_lambda"], float)
        tau = np.asarray(data[f"{key}_tau"], float)
        rest = float(data[f"{key}_rest"])
        col = CS.ION[key]["color"]
        # intrinsic (unconvolved) spectrum on the native velocity grid — same behind all 4 columns
        if show_intrinsic:
            v_hi = C_KMS * (lam / rest - 1.0) - v_sys
            f_hi = np.exp(-tau)
            m_hi = (v_hi >= -vwin) & (v_hi <= vwin)
            v_hi, f_hi = v_hi[m_hi], f_hi[m_hi]
        for c, (R, SN) in enumerate(cols):
            a = ax[r][c]
            v, flux, model = degrade(lam, tau, rest, R, SN, v_sys,
                                     seed=seed + 17 * c + 101 * r, vwin=vwin)
            # noisy "observed" spectrum (thin step) + noiseless model (thick + fill)
            a.step(v, flux, where="mid", color=col, lw=0.9, alpha=0.5, zorder=2)
            a.fill_between(v, model, 1.0, where=(model < 1.0), color=col, alpha=0.22, lw=0, zorder=1)
            if show_intrinsic:   # faint grey truth reference, behind the thick model
                a.plot(v_hi, f_hi, color="0.45", lw=1.2, alpha=0.9, zorder=2.4)
            a.plot(v, model, color=col, lw=2.6, solid_joinstyle="round", zorder=3)
            a.axhline(1.0, color="0.55", ls="--", lw=1.0, zorder=1)
            a.axvline(0.0, color="0.4", ls=":", lw=1.1, zorder=1)
            a.set_xlim(-vwin, vwin); a.set_ylim(-0.08, 1.32)
            if r == 0:      # column headers: instrument setup (usetex- and mathtext-safe)
                a.set_title(rf"$R$ = {R:,},  S/N = {SN}",
                            fontsize=plt.rcParams["axes.titlesize"], pad=8)
        # row / ion label in the leftmost panel, in the ion colour
        ax[r][0].text(0.035, 0.09, CS.ION[key]["label"], transform=ax[r][0].transAxes,
                      color=col, ha="left", va="bottom",
                      fontsize=plt.rcParams["axes.labelsize"],
                      bbox=dict(boxstyle="round,pad=0.3", fc="white", ec=col, lw=1.4, alpha=0.95))
    for c in range(4):
        ax[2][c].set_xlabel(r"$V_{\rm LOS}-V_{\rm sys}\ \ [\mathrm{km\,s^{-1}}]$")
    for r in range(3):
        ax[r][0].set_ylabel(r"normalized flux")
    fig.tight_layout(w_pad=0.6, h_pad=0.6)
    return fig, geom


def main():
    CS.set_style()
    argv = list(sys.argv[1:])
    show_intrinsic = "intrinsic" in argv
    if show_intrinsic:
        argv.remove("intrinsic")
    which = argv[0] if argv else "edge_b100_a090"
    rr = [int(x) for x in argv[1:5]] if len(argv) >= 5 else [DEF_RLO, DEF_RHI, DEF_SNHI, DEF_SNLO]
    data = load_sightline(which)
    fig, geom = build_figure(data, *rr, show_intrinsic=show_intrinsic)
    name = f"spectra_{Path(str(which)).stem.replace('cgm_sid488530_','')}"
    p = CS.save(fig, name)
    print(f"saved {p}  (orient={geom['orientation']} b={geom['b_kpc']:.0f} az={geom['azimuth_deg']:.0f} "
          f"v_sys={geom['v_sys_kms']:+.0f})")


if __name__ == "__main__":
    main()
