#!/usr/bin/env python3
"""How narrow are the INTRINSIC absorption components, and what spectral resolution R do you
need to resolve them?

Works on the unconvolved optical depth tau(v) (the "show intrinsic" curve, R=infinity, sampled at
~0.6 km/s). Widths are measured in TAU space, not flux, so saturation does not bias them: a
saturated line is black in flux but its tau profile still has a well-defined width.

For every sightline x ion we measure
  * component FWHM  [km/s]  (scipy peak_widths at half the peak tau)  -> b = FWHM/1.6651
  * velocity separation between adjacent components
and compare them with the resolution element c/R for R = 20k, 40k, 100k.

A component is "resolved" only if FWHM > c/R; a pair is "separable" only if dv > c/R.

Usage: python analyze_line_widths.py [--figure]
"""
from __future__ import annotations
import sys, glob, json
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.signal import find_peaks, peak_widths

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_style as CS                       # noqa: E402

DATA = ROOT / "data" / "sightlines"
OUT = ROOT / "data" / "line_widths.csv"
C_KMS = 299792.458
FWHM_TO_B = 1.0 / 1.66511                    # Gaussian: FWHM = 2 sqrt(ln2) b = 1.665 b
TAU_MIN = 0.1                                # detectable component (~10% depth if unsaturated)
R_REF = [20000, 40000, 100000]
# Components narrower than this are below BOTH the ~0.6 km/s sampling and the thermal floor
# (C III at T=1e3 K already has FWHM=2 km/s), i.e. numerical sub-pixel deposition -> discard.
MIN_FWHM = 1.5

# thermal b = sqrt(2kT/(A m_u)) = 0.1285 * sqrt(T/A) km/s
ATOMIC = {"H I": 1.0, "C III": 12.0, "C IV": 12.0, "N V": 14.0, "O VI": 16.0,
          "Mg II": 24.3, "Si II": 28.1, "Si IV": 28.1, "S II": 32.1, "Fe II": 55.8}
T_TYPICAL = {"H I": 1e4, "C III": 2e4, "C IV": 1e5, "N V": 2e5, "O VI": 3e5,
             "Mg II": 1e4, "Si II": 1e4, "Si IV": 5e4, "S II": 1e4, "Fe II": 1e4}


def b_thermal(ion, T=None):
    A = ATOMIC[ion]; T = T_TYPICAL[ion] if T is None else T
    return 0.12849 * np.sqrt(T / A)


def measure(lam, tau, rest):
    """Return (fwhm_list, sep_list, peak_tau_list) in km/s from the intrinsic tau profile."""
    v = C_KMS * (lam / rest - 1.0)
    dv = float(np.median(np.diff(v)))
    pk, _ = find_peaks(tau, height=TAU_MIN, prominence=0.5 * TAU_MIN, distance=3)
    if pk.size == 0:
        return [], [], []
    w = peak_widths(tau, pk, rel_height=0.5)[0] * dv          # FWHM in km/s
    seps = list(np.diff(v[pk])) if pk.size > 1 else []
    return list(w), seps, list(tau[pk])


def main():
    files = sorted(glob.glob(str(DATA / "*.npz")))
    rows = []
    for fp in files:
        d = np.load(fp, allow_pickle=True)
        geom = json.loads(str(d["geom"]))
        for key in CS.ION_ORDER:
            lam = np.asarray(d[f"{key}_lambda"], float)
            tau = np.asarray(d[f"{key}_tau"], float)
            rest = float(d[f"{key}_rest"])
            fw, sp, pt = measure(lam, tau, rest)
            for i, f in enumerate(fw):
                rows.append(dict(file=Path(fp).name, ion=key, b_kpc=float(geom["b_kpc"]),
                                 kind="fwhm", value=float(f), peak_tau=float(pt[i])))
            for s in sp:
                rows.append(dict(file=Path(fp).name, ion=key, b_kpc=float(geom["b_kpc"]),
                                 kind="sep", value=float(s), peak_tau=np.nan))
    df = pd.DataFrame(rows)
    n_sub = int(((df.kind == "fwhm") & (df.value < MIN_FWHM)).sum())
    df = df[~((df.kind == "fwhm") & (df.value < MIN_FWHM))].reset_index(drop=True)
    df.to_csv(OUT, index=False)

    print(f"measured {len(files)} sightlines -> {OUT}")
    print(f"(discarded {n_sub} components with FWHM < {MIN_FWHM} km/s: below the ~0.6 km/s "
          f"sampling and the thermal floor -> numerical)\n")
    print("INTRINSIC COMPONENT WIDTHS  (FWHM, km/s; b = FWHM/1.665)")
    print(f"{'ion':<8}{'N':>7}{'median':>9}{'16th':>8}{'5th':>8}{'min':>8}"
          f"{'  b_med':>8}   unresolved at R=20k / 40k / 100k")
    for ion in CS.ION_ORDER:
        w = df[(df.ion == ion) & (df.kind == "fwhm")].value.values
        if not w.size:
            continue
        frac = [100 * np.mean(w < C_KMS / R) for R in R_REF]
        print(f"{ion:<8}{w.size:>7}{np.median(w):>9.1f}{np.percentile(w,16):>8.1f}"
              f"{np.percentile(w,5):>8.1f}{w.min():>8.1f}{np.median(w)*FWHM_TO_B:>8.1f}"
              f"      {frac[0]:5.1f}% /{frac[1]:5.1f}% /{frac[2]:5.1f}%")

    print("\nVELOCITY SEPARATION OF ADJACENT COMPONENTS (km/s)")
    print(f"{'ion':<8}{'N':>7}{'median':>9}{'16th':>8}{'5th':>8}{'min':>8}"
          f"        blended at R=20k / 40k / 100k")
    for ion in CS.ION_ORDER:
        s = df[(df.ion == ion) & (df.kind == "sep")].value.values
        if not s.size:
            continue
        frac = [100 * np.mean(s < C_KMS / R) for R in R_REF]
        print(f"{ion:<8}{s.size:>7}{np.median(s):>9.1f}{np.percentile(s,16):>8.1f}"
              f"{np.percentile(s,5):>8.1f}{s.min():>8.1f}"
              f"              {frac[0]:5.1f}% /{frac[1]:5.1f}% /{frac[2]:5.1f}%")

    print("\nPURE THERMAL WIDTHS for other ions  (b = 0.1285 sqrt(T/A); FWHM = 1.665 b)")
    print(f"{'ion':<8}{'A':>6}{'T_typ[K]':>10}{'b[km/s]':>9}{'FWHM':>7}   R needed (FWHM = c/R)")
    for ion in ATOMIC:
        b = b_thermal(ion); fw = b * 1.66511
        print(f"{ion:<8}{ATOMIC[ion]:>6.0f}{T_TYPICAL[ion]:>10.0e}{b:>9.1f}{fw:>7.1f}"
              f"   R >= {C_KMS/fw:>8,.0f}")

    # narrowest / closest examples worth looking at in the GUI
    print("\nNARROWEST intrinsic components (best case for needing high R):")
    nw = df[df.kind == "fwhm"].nsmallest(6, "value")
    for _, r in nw.iterrows():
        print(f"  {r.ion:<6} FWHM={r.value:5.1f} km/s  b_imp={r.b_kpc:6.1f} kpc  "
              f"{r.file.replace('cgm_sid488530_','').replace('.npz','')}")
    print("\nCLOSEST component pairs:")
    cs = df[df.kind == "sep"].nsmallest(6, "value")
    for _, r in cs.iterrows():
        print(f"  {r.ion:<6} dv={r.value:5.1f} km/s   b_imp={r.b_kpc:6.1f} kpc  "
              f"{r.file.replace('cgm_sid488530_','').replace('.npz','')}")

    if "--figure" in sys.argv:
        make_figure(df)


def make_figure(df):
    import matplotlib.pyplot as plt
    CS.set_style(base=14)
    fig, ax = plt.subplots(1, 2, figsize=(15.5, 6.2))
    bins = np.logspace(np.log10(1.5), np.log10(400), 46)
    for a, kind, title in ((ax[0], "fwhm", r"intrinsic component width  FWHM"),
                           (ax[1], "sep", r"separation of adjacent components  $\Delta v$")):
        for ion in CS.ION_ORDER:
            v = df[(df.ion == ion) & (df.kind == kind)].value.values
            if not v.size:
                continue
            a.hist(v, bins=bins, histtype="step", lw=2.8, color=CS.ION[ion]["color"],
                   label=CS.ION[ion]["label"], density=True)
        for R, ls in zip(R_REF, ("-", "--", ":")):
            a.axvline(C_KMS / R, color="0.25", ls=ls, lw=1.8)
            a.text(C_KMS / R, a.get_ylim()[1] * 0.96, rf"  $R$={R//1000}k",
                   rotation=90, va="top", ha="left", fontsize=11, color="0.25")
        a.set_xscale("log"); a.set_xlabel(title + r"  $[\mathrm{km\,s^{-1}}]$")
        a.set_ylabel("probability density")
        a.set_xlim(1.5, 400)
    ax[0].legend(loc="upper right", fontsize=12)
    ax[0].text(0.03, 0.95, "left of a line = unresolved at that $R$", transform=ax[0].transAxes,
               fontsize=11, va="top", color="0.3")
    ax[1].text(0.03, 0.95, "left of a line = blended at that $R$", transform=ax[1].transAxes,
               fontsize=11, va="top", color="0.3")
    fig.tight_layout()
    p = CS.save(fig, "line_width_analysis")
    print(f"\nsaved {p}")


if __name__ == "__main__":
    main()
