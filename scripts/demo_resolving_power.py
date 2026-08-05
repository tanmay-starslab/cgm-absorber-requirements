#!/usr/bin/env python3
"""Do we actually need high spectral resolution for these lines?

Two rows, one sightline, noiseless (so only R matters):
  top    C III 977  — intrinsically NARROW (cool photoionised gas, FWHM ~ 5-9 km/s)
  bottom O VI 1032  — intrinsically BROAD  (hot gas, T~3e5 K, FWHM ~ 30 km/s)
Four columns: R = 20,000 / 40,000 / 100,000 / intrinsic (R = infinity, the true profile).

The grey curve in every panel is the intrinsic profile, so you can see directly what each R
throws away. Component centres are ticked on top.

Usage: python demo_resolving_power.py [geom_id]
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np
import matplotlib.pyplot as plt
from scipy.signal import find_peaks

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_style as CS                        # noqa: E402
from degrade import degrade, C_KMS            # noqa: E402

DATA = ROOT / "data" / "sightlines"
R_COLS = [20000, 40000, 100000, None]         # None = intrinsic (R = infinity)


def load(gid):
    return np.load(DATA / f"cgm_sid488530_{gid}.npz", allow_pickle=True)


def intrinsic(d, ion):
    lam = np.asarray(d[f"{ion}_lambda"], float)
    tau = np.asarray(d[f"{ion}_tau"], float)
    rest = float(d[f"{ion}_rest"]); vsys = float(d["v_sys"])
    v = C_KMS * (lam / rest - 1.0) - vsys
    return v, np.exp(-tau), tau, lam, rest, vsys


def main():
    CS.set_style(base=14)
    gid = sys.argv[1] if len(sys.argv) > 1 else "edge_b125_a090"
    d = load(gid)

    # zoom on the C III complex
    vC, fC, tC, *_ = intrinsic(d, "CIII")
    pk, _ = find_peaks(tC, height=0.3, prominence=0.2, distance=3)
    vc = vC[pk]
    centre = float(np.median(vc)); half = max(45.0, float(vc.ptp()) * 0.9 + 25)
    vlo, vhi = centre - half, centre + half

    fig, ax = plt.subplots(2, 4, figsize=(19, 8.6), sharex=True, sharey=True)
    for r, ion in enumerate(("CIII", "OVI")):
        lam = np.asarray(d[f"{ion}_lambda"], float)
        tau = np.asarray(d[f"{ion}_tau"], float)
        rest = float(d[f"{ion}_rest"]); vsys = float(d["v_sys"])
        col = CS.ION[ion]["color"]
        v_i, f_i, tau_i, *_ = intrinsic(d, ion)
        m = (v_i >= vlo) & (v_i <= vhi)
        # component centres for this ion
        pki, _ = find_peaks(tau_i, height=0.3, prominence=0.2, distance=3)
        pki = pki[(v_i[pki] >= vlo) & (v_i[pki] <= vhi)]
        for c, R in enumerate(R_COLS):
            a = ax[r][c]
            a.plot(v_i[m], f_i[m], color="0.55", lw=1.3, zorder=2)          # truth reference
            if R is None:
                a.plot(v_i[m], f_i[m], color=col, lw=3.0, zorder=3)
                a.fill_between(v_i[m], f_i[m], 1.0, where=(f_i[m] < 1), color=col,
                               alpha=0.17, lw=0, zorder=1)
                head = r"intrinsic  ($R=\infty$)"
            else:
                v, _, model = degrade(lam, tau, rest, R, None, vsys, vwin=max(abs(vlo), abs(vhi)))
                mm = (v >= vlo) & (v <= vhi)
                a.plot(v[mm], model[mm], color=col, lw=3.0, zorder=3)
                a.fill_between(v[mm], model[mm], 1.0, where=(model[mm] < 1), color=col,
                               alpha=0.17, lw=0, zorder=1)
                head = rf"$R = {R:,}$   ($c/R = {C_KMS/R:.1f}$ km/s)"
            for vv in v_i[pki]:                                              # component ticks
                a.plot([vv, vv], [1.13, 1.21], color=col, lw=1.6, zorder=4)
            a.axhline(1.0, color="0.6", ls="--", lw=1.0, zorder=0)
            a.set_xlim(vlo, vhi); a.set_ylim(-0.06, 1.30)
            if r == 0:
                a.set_title(head, fontsize=14, pad=8)
            if c == 0:
                a.set_ylabel("normalized flux")
                a.text(0.035, 0.08, CS.ION[ion]["label"], transform=a.transAxes, color=col,
                       fontsize=15, ha="left", va="bottom",
                       bbox=dict(boxstyle="round,pad=0.3", fc="white", ec=col, lw=1.4))
            if r == 1:
                a.set_xlabel(r"$V_{\rm LOS}-V_{\rm sys}\ \ [\mathrm{km\,s^{-1}}]$")
    fig.tight_layout(w_pad=0.6, h_pad=0.7)
    p = CS.save(fig, f"demo_resolving_power_{gid}")
    print(f"saved {p}   (zoom {vlo:.0f}..{vhi:.0f} km/s; C III components at "
          f"{np.round(vc,1)} km/s)")


if __name__ == "__main__":
    main()
