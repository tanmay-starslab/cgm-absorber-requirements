#!/usr/bin/env python3
"""How spectral resolution R affects lines of very different intrinsic width.

One sightline, one figure: rows = transitions (ordered broad -> narrow, i.e. hot/light ion at the
top, cool/heavy ion at the bottom), columns = R = 20,000 / 40,000 / 100,000 / intrinsic (R = inf).
Noiseless throughout, so ONLY the resolution differs. The grey curve in every panel is the
intrinsic profile, so what each R throws away is visible directly.

Colour encodes the expected thermal width b = 0.1285 sqrt(T/A): warm colours = broad lines
(insensitive to R), cool colours = narrow lines (need high R).

Usage: python plot_multiion_resolution.py [geom_id] [--vwin 400]
"""
from __future__ import annotations
import sys, json
from pathlib import Path
import numpy as np
import matplotlib.pyplot as plt
from matplotlib import cm, colors

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_style as CS                    # noqa: E402
from degrade import degrade, C_KMS        # noqa: E402

MULTI = ROOT / "data" / "multiion"
R_COLS = [20000, 40000, 100000, None]     # None = intrinsic (R = infinity)

PRETTY = {
    "OVI1032": r"O\,VI $\lambda$1032", "NV1239": r"N\,V $\lambda$1239",
    "CIV1548": r"C\,IV $\lambda$1548", "HI1216": r"H\,I Ly$\alpha$",
    "HI1026": r"H\,I Ly$\beta$", "SiIV1403": r"Si\,IV $\lambda$1403",
    "CIII977": r"C\,III $\lambda$977", "SiIII1206": r"Si\,III $\lambda$1206",
    "CII1335": r"C\,II $\lambda$1335", "SiII1260": r"Si\,II $\lambda$1260",
    "MgII2796": r"Mg\,II $\lambda$2796", "FeII1608": r"Fe\,II $\lambda$1608",
}


def b_thermal(A, logT):
    return 0.12849 * np.sqrt((10 ** logT) / A)


def main():
    CS.set_style(base=13)
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    gid = args[0] if args else "rand_b012_a034_s536718143"
    vwin = 400.0
    if "--vwin" in sys.argv:
        vwin = float(sys.argv[sys.argv.index("--vwin") + 1])

    d = np.load(MULTI / f"multiion_{gid}.npz", allow_pickle=True)
    lines = json.loads(str(d["lines"]))
    v_sys = float(d["v_sys"])
    geom = json.loads(str(d["geom"]))

    # colour by expected thermal width: broad = warm/red, narrow = cool/blue
    bs = np.array([b_thermal(l["A"], l["logT"]) for l in lines])
    norm = colors.Normalize(vmin=np.log10(bs.min()) - 0.05, vmax=np.log10(bs.max()) + 0.05)
    cmap = plt.get_cmap("Spectral_r")

    def darken(rgba, lmax=0.52):
        """Keep the hue but cap luminance so every colour reads on white."""
        r, g, b_, a = rgba
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b_
        if lum > lmax:
            s = lmax / lum
            r, g, b_ = r * s, g * s, b_ * s
        return (r, g, b_, a)

    cols = [darken(cmap(norm(np.log10(b)))) for b in bs]

    n = len(lines)
    fig, ax = plt.subplots(n, 4, figsize=(18.5, 1.62 * n + 1.1), sharex=True, sharey=True)
    for r, (L, col) in enumerate(zip(lines, cols)):
        key, rest = L["key"], float(L["rest"])
        lam = np.asarray(d[f"{key}_lambda"], float)
        tau = np.asarray(d[f"{key}_tau"], float)
        v_i = C_KMS * (lam / rest - 1.0) - v_sys
        f_i = np.exp(-tau)
        m = (v_i >= -vwin) & (v_i <= vwin)
        bth = b_thermal(L["A"], L["logT"])
        for c, R in enumerate(R_COLS):
            a = ax[r][c]
            a.plot(v_i[m], f_i[m], color="0.62", lw=1.0, zorder=2)        # truth reference
            if R is None:
                v, f = v_i[m], f_i[m]
            else:
                vv, _, model = degrade(lam, tau, rest, R, None, v_sys, vwin=vwin)
                v, f = vv, model
            a.plot(v, f, color=col, lw=2.5, zorder=3)
            a.fill_between(v, f, 1.0, where=(f < 1.0), color=col, alpha=0.20, lw=0, zorder=1)
            a.axhline(1.0, color="0.6", ls="--", lw=0.9, zorder=0)
            a.axvline(0.0, color="0.45", ls=":", lw=0.9, zorder=0)
            a.set_xlim(-vwin, vwin); a.set_ylim(-0.08, 1.28)
            a.set_yticks([0, 0.5, 1.0])
            if r == 0:
                head = (r"intrinsic  ($R=\infty$)" if R is None
                        else rf"$R = {R:,}$   ($c/R = {C_KMS/R:.1f}$ km/s)")
                a.set_title(head, fontsize=14, pad=9)
            if c == 0:
                a.set_ylabel("norm. flux", fontsize=11)
                a.text(0.022, 0.60, PRETTY.get(key, key), transform=a.transAxes, color=col,
                       fontsize=13.5, ha="left", va="center", fontweight="bold", zorder=10,
                       bbox=dict(boxstyle="round,pad=0.28", fc="white", ec=col, lw=1.4))
            if c == 3:   # annotate the intrinsic thermal width on the right
                a.text(0.978, 0.60, rf"$b_{{\rm th}}\!\approx\!{bth:.1f}$ km/s",
                       transform=a.transAxes, ha="right", va="center", fontsize=10.5,
                       color="0.2", zorder=10,
                       bbox=dict(boxstyle="round,pad=0.22", fc="white", ec="0.75", lw=0.8))
            if r == n - 1:
                a.set_xlabel(r"$V_{\rm LOS}-V_{\rm sys}\ \ [\mathrm{km\,s^{-1}}]$", fontsize=12.5)
    fig.tight_layout(w_pad=0.5, h_pad=0.35)
    p = CS.save(fig, f"multiion_resolution_{gid}")
    print(f"saved {p}\n  sightline: {geom['orientation']} b={geom['b_kpc']:.0f} kpc "
          f"Phi={geom['azimuth_deg']:.0f} deg  v_sys={v_sys:+.0f} km/s")
    print(f"  rows (broad -> narrow): " + ", ".join(l['key'] for l in lines))


if __name__ == "__main__":
    main()
