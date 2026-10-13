"""Publication figures (LaTeX-rendered) from the precomputed grids.

    python scripts/make_figures.py                 # everything
    python scripts/make_figures.py matrix lsf      # selected figures
    python scripts/make_figures.py ions "O VI"     # per-ion figures for one ion

Outputs go to figures/ (summary figures) and figures/ions/ (one pair per transition).
"""
import sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from absreq import style
style.apply()
import matplotlib.pyplot as plt
import matplotlib.patheffects as pe
from matplotlib.colors import LinearSegmentedColormap, BoundaryNorm, ListedColormap
from matplotlib.ticker import NullFormatter
from matplotlib.lines import Line2D
from absreq.lines import cgm_lines
from absreq.profiles import C_KMS, FW2SIG, velocity_grid, observed_flux
from absreq.detection import logN_min
from absreq.separation import dv_min, sparrow
from absreq import theory

FIG = ROOT / "figures"
INK, INK2 = style.INK, style.INK2
HALO = [pe.withStroke(linewidth=2.0, foreground="white")]
CASE = [pe.withStroke(linewidth=2.4, foreground="white")]
GREY = "#b9b8b2"
INSTR = [("COS G140L", 2000), ("COS G130M/G160M", 17000), ("STIS E140M", 45800), ("HIRES/UVES", 72000)]


def grid(line):
    return np.load(ROOT / "grids" / f"{line.key}.npz")


def binned(colors, n, under=None, over=None):
    base = LinearSegmentedColormap.from_list("s", colors)
    cm = ListedColormap([base(i / (n - 1)) for i in range(n)])
    if under: cm.set_under(under)
    if over: cm.set_over(over)
    return cm


def logR_fine(R, A, axis):
    """Interpolate a positive array smoothly onto a finer log-R grid (A is smooth in log R)."""
    Rf = np.logspace(np.log10(R[0]), np.log10(R[-1]), 121)
    la = np.log(np.maximum(A, 1e-300))
    out = np.apply_along_axis(lambda y: np.interp(np.log(Rf), np.log(R), y), axis, la)
    return Rf, np.exp(out)


def snr_axis(ax, ylabel=True):
    ax.set_xscale("log"); ax.set_yscale("log"); ax.set_xlim(1e3, 1e5); ax.set_ylim(3, 100)
    ax.set_yticks([3, 5, 10, 20, 50, 100]); ax.set_yticklabels(["3", "5", "10", "20", "50", "100"])
    ax.yaxis.set_minor_formatter(NullFormatter())
    if ylabel: ax.set_ylabel(r"S/N per resolution element")


def instruments(ax, label):
    for name, Rv in INSTR:
        ax.axvline(Rv, color=INK, lw=0.5, ls=":")
        if label:
            ax.text(Rv * 1.07, 95, name, rotation=90, ha="left", va="top", fontsize=6.0, color=INK,
                    bbox=dict(boxstyle="round,pad=0.12", fc="white", ec="none", alpha=0.85))


def label_low(ax, cs, fmt):
    pts = []
    for k, seg in enumerate(cs.allsegs):
        ytar = (4.5, 7.0, 11.0, 6.0)[k % 4]
        for v in seg:
            ok = (v[:, 0] > 1.3e3) & (v[:, 0] < 7e4)
            if ok.any():
                vv = v[ok]; pts.append(tuple(vv[np.argmin(np.abs(np.log(vv[:, 1] / ytar)))]))
    if pts:
        ax.clabel(cs, fmt=fmt, fontsize=6.8, inline_spacing=2, manual=pts)


# ------------------------------------------------------------------------- per-ion: instrument plane
def ion_instrument_plane(line):
    g = grid(line)
    snr = np.logspace(np.log10(3), 2, 60)
    fig, axes = plt.subplots(2, 3, figsize=(style.PAGE, 5.8), sharex=True, sharey=True,
                             gridspec_kw=dict(wspace=0.12, hspace=0.22, right=0.875, left=0.08, top=0.9, bottom=0.12))
    # row 1: detection, columns = b
    logN, b, R, K = g["logN_det"], g["b_det"], g["R_det"], g["K"]
    lo, hi = logN[0], logN[-1]
    lev = np.arange(np.ceil(lo * 4) / 4 + 0.25, hi - 0.24, 0.25)
    cm = binned(style.BLUES, len(lev) + 1); norm = BoundaryNorm(lev, cm.N, extend="both")
    bcols = [line.b_fid / 2, line.b_fid, line.b_fid * 2]
    for c, bv in enumerate(bcols):
        ax = axes[0, c]; j = int(np.argmin(abs(np.log(b / bv))))
        Z = np.clip([[logN_min(logN, K[:, j, k], s) for k in range(R.size)] for s in snr], lo - 1, hi + 1)
        cf = ax.contourf(R, snr, Z, levels=lev, cmap=cm, norm=norm, extend="both")
        cs = ax.contour(R, snr, Z, levels=lev[::2], colors=INK, linewidths=0.6)
        if c == 0: label_low(ax, cs, "%.1f")
        else: ax.clabel(cs, fmt="%.1f", fontsize=6.8, inline_spacing=2)
        instruments(ax, c == 0)
        snr_axis(ax, c == 0)
        ax.set_title(rf"single component, $b={b[j]:.0f}$ km\,s$^{{-1}}$", fontsize=8.5, pad=3)
    p = axes[0, 2].get_position(); cax = fig.add_axes([0.89, p.y0, 0.013, p.height])
    cb = fig.colorbar(cf, cax=cax, ticks=lev[::2]); cb.outline.set_linewidth(0.5)
    cb.set_label(r"min.\ detectable $\log N$ (3$\sigma$)")
    # row 2: separation, columns = log N per component
    logN, dv, R, G = g["logN_sep"], g["dv_sep"], g["R_sep"], g["G"]
    Rf, Gf = logR_fine(R, G, 2)
    levs = np.array([2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150])
    levs = levs[(levs >= dv[0]) & (levs <= 200)]
    cm2 = binned(style.BLUES[1:], len(levs) - 1, under=style.BLUES[0], over=GREY); norm2 = BoundaryNorm(levs, cm2.N)
    n1 = line.logN_tau1()
    for c, dN in enumerate([-0.6, 0.0, 0.6]):
        ax = axes[1, c]; i = int(np.argmin(abs(logN - (n1 + dN))))
        Z = np.array([[dv_min(dv, Gf[i, :, k], s) for k in range(Rf.size)] for s in snr])
        Zc = np.clip(Z, 0.5 * levs[0], 2 * levs[-1])
        cf2 = ax.contourf(Rf, snr, Zc, levels=levs, cmap=cm2, norm=norm2, extend="both")
        cs = ax.contour(Rf, snr, Zc, levels=[l for l in (5, 10, 20, 50, 100) if levs[0] < l < levs[-1]],
                        colors=INK, linewidths=0.6)
        if c == 0: label_low(ax, cs, lambda x: f"{x:g}")
        else: ax.clabel(cs, fmt=lambda x: f"{x:g}", fontsize=6.8, inline_spacing=2)
        ratio = np.clip(Z / sparrow(Rf, line.b_fid)[None, :], 0, 5)
        ax.contour(Rf, snr, ratio, levels=[1.0], colors="white", linewidths=1.6)
        ax.contour(Rf, snr, ratio, levels=[1.0], colors=INK, linewidths=0.8, linestyles=[(0, (3, 1.5))])
        instruments(ax, False)
        snr_axis(ax, c == 0)
        ax.set_xlabel(r"resolving power $R$")
        ax.set_title(rf"two components, $\log N={logN[i]:.1f}$ each", fontsize=8.5, pad=3)
    p = axes[1, 2].get_position(); cax = fig.add_axes([0.89, p.y0, 0.013, p.height])
    cb = fig.colorbar(cf2, cax=cax, ticks=levs, extendfrac=0.06)
    cb.ax.set_yticklabels([f"{l:g}" for l in levs]); cb.ax.minorticks_off(); cb.outline.set_linewidth(0.5)
    cb.set_label(r"$\Delta v_{\rm min}$ [km\,s$^{-1}$] (3$\sigma$)")
    p = axes[0, 0].get_position()
    fig.text(p.x0, p.y1 + 0.05, line.tex + rf"\quad{{\normalsize $f={line.f:.3g}$, $b_{{\rm fid}}={line.b_fid:.1f}$ km\,s$^{{-1}}$, "
             rf"$\tau_0=1$ at $\log N={n1:.2f}$}}", fontsize=10.5, ha="left", va="bottom")
    fig.legend([Line2D([], [], color=INK, lw=0.8, ls=(0, (3, 1.5)), path_effects=CASE), Line2D([], [], color=INK, lw=0.5, ls=":")],
               [r"$\Delta v_{\rm min}=\Delta v_{\rm S}$ (Sparrow); above: resolved below the classical limit",
                r"existing spectrographs (nominal $R$)"], loc="lower center", ncol=2, fontsize=7, bbox_to_anchor=(0.48, -0.005))
    out = FIG / "ions" / f"{line.key}_instrument_plane"
    fig.savefig(f"{out}.pdf"); fig.savefig(f"{out}.png", dpi=220); plt.close(fig)


# ------------------------------------------------------------------------- per-ion: absorber plane
def ion_absorber_plane(line):
    g = grid(line)
    lev = np.array([3, 5, 7, 10, 15, 20, 30, 50, 100])
    cm = binned(style.ORANGES[1:], len(lev) - 1, under="#ffffff", over=GREY); norm = BoundaryNorm(lev, cm.N)
    Rcols = [2000, 18000, 45000] if line.b_fid > 10 else [18000, 45000, 100000]
    fig, axes = plt.subplots(2, 3, figsize=(style.PAGE, 5.7),
                             gridspec_kw=dict(wspace=0.08, hspace=0.42, right=0.875, left=0.08, top=0.9, bottom=0.12))
    n1 = line.logN_tau1()
    logN, b, R, K = g["logN_det"], g["b_det"], g["R_det"], g["K"]
    for c, Rv in enumerate(Rcols):
        ax = axes[0, c]; k = int(np.argmin(abs(np.log(R / Rv))))
        S = (3.0 / K[:, :, k]).T
        cf = ax.contourf(logN, b, S, levels=lev, cmap=cm, norm=norm, extend="both")
        cs = ax.contour(logN, b, S, levels=[5, 10, 20, 50], colors=INK, linewidths=0.6)
        ax.clabel(cs, fmt=lambda x: f"{x:g}", fontsize=6.8, inline_spacing=2)
        ax.plot(np.log10(b / (1.4975e-15 * line.f * line.lam)), b, color=INK, lw=0.8, ls="-.", path_effects=CASE)
        ax.axhline(line.b_fid, color=INK2, lw=0.5, ls=":")
        ax.set_yscale("log"); ax.set_xlim(logN[0], logN[-1]); ax.set_ylim(b[0], b[-1])
        ax.yaxis.set_minor_formatter(NullFormatter())
        yt = [t for t in (2, 3, 5, 10, 20, 30, 50, 100) if b[0] <= t <= b[-1]]
        ax.set_yticks(yt); ax.set_yticklabels([str(t) for t in yt])
        if c: ax.set_yticklabels([])
        ax.set_xticks(np.arange(np.ceil(logN[0] * 2) / 2, logN[-1] - 0.05, 0.5))
        ax.set_title(rf"$R={Rv:,}$".replace(",", "{,}"), fontsize=8.5, pad=3)
        ax.set_xlabel(r"$\log N$ [cm$^{-2}$]")
        if c == 0: ax.set_ylabel(r"$b$ [km\,s$^{-1}$]")
    logN, dv, R, G = g["logN_sep"], g["dv_sep"], g["R_sep"], g["G"]
    for c, Rv in enumerate(Rcols):
        ax = axes[1, c]; k = int(np.argmin(abs(np.log(R / Rv))))
        S = (3.0 / np.sqrt(np.maximum(G[:, :, k], 1e-300))).T
        cf = ax.contourf(logN, dv, S, levels=lev, cmap=cm, norm=norm, extend="both")
        cs = ax.contour(logN, dv, S, levels=[5, 10, 20, 50], colors=INK, linewidths=0.6)
        ax.clabel(cs, fmt=lambda x: f"{x:g}", fontsize=6.8, inline_spacing=2)
        ax.axhline(sparrow(R[k], line.b_fid), color=INK, lw=0.9, ls=(0, (5, 2)), path_effects=CASE)
        ax.axvline(n1, color=INK, lw=0.8, ls="-.", path_effects=CASE)
        ax.set_yscale("log"); ax.set_xlim(logN[0], logN[-1]); ax.set_ylim(dv[0], dv[-1])
        ax.yaxis.set_minor_formatter(NullFormatter())
        yt = [t for t in (1, 2, 5, 10, 20, 50, 100, 200) if dv[0] <= t <= dv[-1]]
        ax.set_yticks(yt); ax.set_yticklabels([str(t) for t in yt])
        if c: ax.set_yticklabels([])
        ax.set_xticks(np.arange(np.ceil(logN[0] * 2) / 2, logN[-1] - 0.05, 0.5))
        ax.set_title(rf"$R={Rv:,}$".replace(",", "{,}"), fontsize=8.5, pad=3)
        ax.set_xlabel(r"$\log N$ per component [cm$^{-2}$]")
        if c == 0: ax.set_ylabel(r"separation $\Delta v$ [km\,s$^{-1}$]")
    for r, lab in enumerate([r"S/N to detect at 3$\sigma$", r"S/N to resolve at 3$\sigma$"]):
        p = axes[r, 2].get_position(); cax = fig.add_axes([0.89, p.y0, 0.013, p.height])
        cb = fig.colorbar(cf, cax=cax, ticks=lev, extendfrac=0.06)
        cb.ax.set_yticklabels([f"{l:g}" for l in lev]); cb.ax.minorticks_off(); cb.outline.set_linewidth(0.5)
        cb.set_label(lab)
    p = axes[0, 0].get_position()
    fig.text(p.x0, p.y1 + 0.045, line.tex + r"\quad{\normalsize top: one component; bottom: two equal components, "
             rf"$b={line.b_fid:.1f}$ km\,s$^{{-1}}$ each}}", fontsize=10.5, ha="left", va="bottom")
    fig.legend([Line2D([], [], color=INK, lw=0.8, ls="-.", path_effects=CASE),
                Line2D([], [], color=INK, lw=0.9, ls=(0, (5, 2)), path_effects=CASE),
                Line2D([], [], color=INK2, lw=0.5, ls=":")],
               [r"$\tau_0=1$", r"Sparrow separation $\Delta v_{\rm S}$", r"fiducial $b$"],
               loc="lower center", ncol=3, fontsize=7, bbox_to_anchor=(0.48, -0.005))
    out = FIG / "ions" / f"{line.key}_absorber_plane"
    fig.savefig(f"{out}.pdf"); fig.savefig(f"{out}.png", dpi=220); plt.close(fig)


# ------------------------------------------------------------------------- summary: requirement matrix
def requirement_matrix(snr_det=10, snr_sep=20):
    lines = cgm_lines()
    Rs = [2000, 5000, 10000, 18000, 30000, 45000, 100000]
    A = np.full((len(lines), len(Rs)), np.nan); B = np.full_like(A, np.nan); Bs = np.full_like(A, np.nan)
    for i, L in enumerate(lines):
        g = grid(L)
        jb = int(np.argmin(abs(g["b_det"] - L.b_fid)))
        iN = int(np.argmin(abs(g["logN_sep"] - L.logN_tau1())))
        for k, Rv in enumerate(Rs):
            kd = int(np.argmin(abs(np.log(g["R_det"] / Rv))))
            A[i, k] = logN_min(g["logN_det"], g["K"][:, jb, kd], snr_det) - L.logN_tau1()
            Rf, Gf = logR_fine(g["R_sep"], g["G"][iN], 1)
            ks = int(np.argmin(abs(np.log(Rf / Rv))))
            B[i, k] = dv_min(g["dv_sep"], Gf[:, ks], snr_sep)
            Bs[i, k] = sparrow(Rv, L.b_fid)
    fig, axes = plt.subplots(1, 2, figsize=(style.PAGE, 3.9), gridspec_kw=dict(wspace=0.08, left=0.11, right=0.99, top=0.84, bottom=0.12))
    ylab = [L.tex for L in lines]
    cmA = LinearSegmentedColormap.from_list("a", style.BLUES[1:])
    ax = axes[0]
    ax.imshow(np.where(np.isfinite(A), A, 0.8), cmap=cmA, vmin=-1.4, vmax=0.8, aspect="auto")
    for i in range(A.shape[0]):
        for k in range(A.shape[1]):
            v = A[i, k] + lines[i].logN_tau1()
            txt = f"{v:.1f}" if np.isfinite(v) else rf"$>${grid(lines[i])['logN_det'][-1]:.1f}"
            ax.text(k, i, txt, ha="center", va="center", fontsize=6.6 if np.isfinite(v) else 5.6,
                    color="white" if (not np.isfinite(A[i, k]) or A[i, k] > 0.0) else INK)
    ax.set_title(rf"(a) min.\ detectable $\log N$ at 3$\sigma$, S/N$={snr_det}$, $b=b_{{\rm fid}}$", fontsize=8.5, pad=4)
    ax2 = axes[1]
    ratio = B / Bs
    cmB = LinearSegmentedColormap.from_list("b", style.ORANGES[1:])
    ax2.imshow(np.log10(np.clip(B, 1, 400)), cmap=cmB, vmin=0.3, vmax=2.4, aspect="auto")
    for i in range(B.shape[0]):
        for k in range(B.shape[1]):
            txt = f"{B[i, k]:.0f}" if np.isfinite(B[i, k]) and B[i, k] < 290 else r"$>$300"
            star = r"$^\ast$" if np.isfinite(ratio[i, k]) and ratio[i, k] < 1 else ""
            ax2.text(k, i, txt + star, ha="center", va="center", fontsize=6.6,
                     color="white" if np.log10(np.clip(B[i, k], 1, 400)) > 1.6 else INK)
    ax2.set_title(rf"(b) min.\ resolvable $\Delta v$ [km\,s$^{{-1}}$], S/N$={snr_sep}$, $\tau_0=1$ each", fontsize=8.5, pad=4)
    for a in axes:
        a.set_xticks(range(len(Rs))); a.set_xticklabels([f"{r/1000:g}k" for r in Rs])
        a.set_xlabel(r"resolving power $R$")
        a.tick_params(length=0, top=False, right=False)
        for s in a.spines.values(): s.set_visible(False)
        a.set_xticks(np.arange(-0.5, len(Rs)), minor=True); a.set_yticks(np.arange(-0.5, len(lines)), minor=True)
        a.grid(which="minor", color="white", lw=1.5); a.tick_params(which="minor", length=0)
    axes[0].set_yticks(range(len(lines))); axes[0].set_yticklabels(ylab, fontsize=7.5)
    axes[1].set_yticks([])
    fig.text(0.99, 0.01, r"$^\ast$ resolved below the classical Sparrow separation", fontsize=6.8, ha="right", color=INK2)
    fig.savefig(FIG / "requirements_matrix.pdf"); fig.savefig(FIG / "requirements_matrix.png", dpi=250); plt.close(fig)
    return A, B


# ------------------------------------------------------------------------- summary: LSF and resolution theory
def lsf_resolution():
    line = [L for L in cgm_lines() if L.ion == "O VI"][0]
    b = line.b_fid; RAMP = ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"]; CAT = ["#2a78d6", "#eb6834", "#1baf7a"]
    fig, axes = plt.subplots(1, 3, figsize=(style.PAGE, 2.45), gridspec_kw=dict(wspace=0.5))
    ax = axes[0]; lN, dv = line.logN_tau1() - 0.1, 40.0
    comps = [(lN, b, -dv / 2), (lN, b, dv / 2)]
    v = np.linspace(-150, 150, 3001)
    tau = sum(line.tau0(c[0], c[1]) * np.exp(-((v - c[2]) / c[1]) ** 2) for c in comps)
    ax.plot(v, np.exp(-tau), color=INK, lw=0.8, ls=(0, (3, 1.5)), label="intrinsic", zorder=5)
    for R, col in zip([2000, 18000, 45000, 100000], RAMP):
        vv, step, T = velocity_grid(dv, b, R)
        ax.plot(vv, observed_flux(vv, T, line, comps), color=col, lw=1.2, label=rf"$R={R:,}$".replace(",", "{,}"))
    ax.annotate("", xy=(dv / 2, 1.05), xytext=(-dv / 2, 1.05), arrowprops=dict(arrowstyle="<->", lw=0.6, color=INK, shrinkA=0, shrinkB=0))
    ax.text(0, 1.075, r"$\Delta v$", ha="center", va="bottom", fontsize=8)
    ax.set_xlim(-150, 150); ax.set_ylim(0.0, 1.38)
    ax.set_xlabel(r"velocity [km\,s$^{-1}$]"); ax.set_ylabel("normalized flux")
    ax.legend(loc="lower center", ncol=2, handlelength=1.4, labelspacing=0.2, columnspacing=0.8, fontsize=6.6)
    ax.text(0.03, 0.975, line.tex + rf", $b={b:.1f}$" "\n" rf"$\log N={lN:.2f}$ each, $\Delta v={dv:.0f}$ km\,s$^{{-1}}$",
            transform=ax.transAxes, ha="left", va="top", fontsize=6.6, linespacing=1.2)
    ax = axes[1]
    R = np.logspace(3, np.log10(3e5), 300)
    ax.plot(R, 2 * C_KMS / R * FW2SIG, color=INK, ls=(0, (4, 2)), lw=1.0)
    ax.text(2.0e5, 0.6, r"$b=0$", fontsize=7, ha="right", va="bottom")
    for bb, col in zip([5, 15, 30], [RAMP[0], RAMP[2], RAMP[3]]):
        ax.plot(R, sparrow(R, bb), color=col, lw=1.3)
        Rk = C_KMS / (1.6651 * bb)
        ax.plot(Rk, sparrow(Rk, bb), "o", ms=3.2, mfc="white", mec=col, mew=1.0, zorder=6)
        ax.text(2.2e5, np.sqrt(2) * bb * 1.09, rf"$b={bb}$", fontsize=7, ha="right", va="bottom")
    for Rv, name in [(2000, "G140L"), (17000, "G130M"), (45800, "E140M")]:
        ax.axvline(Rv, color=INK2, lw=0.5, ls=":")
        ax.text(Rv * 1.06, 0.6, name, rotation=90, fontsize=6.2, color=INK2, ha="left", va="bottom")
    ax.set_xscale("log"); ax.set_yscale("log"); ax.set_xlim(1e3, 3e5); ax.set_ylim(0.5, 400)
    ax.set_xlabel(r"resolving power $R$"); ax.set_ylabel(r"Sparrow separation $\Delta v_{\rm S}$ [km\,s$^{-1}$]")
    ax.text(0.97, 0.96, r"$\Delta v_{\rm S}=2\,(b^2/2+\sigma_{\rm LSF}^2)^{1/2}$", transform=ax.transAxes, ha="right", va="top", fontsize=7, path_effects=HALO)
    ax = axes[2]
    S = np.logspace(np.log10(3), 3, 300)
    for (lab, q), col in zip([("1:1", 0.5), ("1:2", 1 / 3), ("1:4", 0.2)], CAT):
        ax.plot(S, theory.dvmin_over_fwhm(S, q), color=col, lw=1.4, label=lab)
    Sh = S[S > 40]
    ax.plot(Sh, (3 / (theory.C4 * Sh)) ** 0.25 / theory.FWHM_PER_SIGMA, color=INK2, lw=0.7, ls=(0, (2, 1.5)))
    ax.text(420, (3 / (theory.C4 * 420)) ** 0.25 / theory.FWHM_PER_SIGMA * 1.2, r"$\propto S_{\rm det}^{-1/4}$", fontsize=7, ha="center", va="bottom", color=INK2)
    ax.plot(Sh, (3 / (theory.C3(1 / 3) * Sh)) ** (1 / 3) / theory.FWHM_PER_SIGMA * 0.8, color=INK2, lw=0.7, ls=(0, (2, 1.5)))
    ax.text(120, (3 / (theory.C3(1 / 3) * 120)) ** (1 / 3) / theory.FWHM_PER_SIGMA * 0.8 * 0.88, r"$\propto S_{\rm det}^{-1/3}$", fontsize=7, ha="right", va="top", color=INK2)
    for yv in (1.0, 0.8493): ax.axhline(yv, color=INK2, lw=0.5, ls=":")
    ax.text(950, 1.03, r"$\Delta v=\mathrm{FWHM}_{\rm eff}$", fontsize=6.6, color=INK2, va="bottom", ha="right")
    ax.text(3.3, 0.83, r"Sparrow (1:1)", fontsize=6.6, color=INK2, va="top", ha="left")
    ax.set_xscale("log"); ax.set_yscale("log"); ax.set_xlim(3, 1000); ax.set_ylim(0.2, 3.2)
    ax.set_yticks([0.2, 0.3, 0.5, 1, 2, 3]); ax.set_yticklabels(["0.2", "0.3", "0.5", "1", "2", "3"]); ax.yaxis.set_minor_formatter(NullFormatter())
    ax.set_xlabel(r"detection significance of the blend, $S_{\rm det}$"); ax.set_ylabel(r"$\Delta v_{\rm min}/\mathrm{FWHM}_{\rm eff}$ (3$\sigma$)")
    ax.legend(title=r"$W_1\!:\!W_2$", loc="upper right", handlelength=1.5, fontsize=7, title_fontsize=7, labelspacing=0.25)
    for a, l in zip(axes, "abc"):
        a.text(-0.02, 1.04, rf"({l})", transform=a.transAxes, ha="right", va="bottom", fontsize=9)
    fig.savefig(FIG / "lsf_resolution.pdf"); fig.savefig(FIG / "lsf_resolution.png", dpi=250); plt.close(fig)


if __name__ == "__main__":
    args = sys.argv[1:] or ["lsf", "matrix", "ions"]
    (FIG / "ions").mkdir(parents=True, exist_ok=True)
    if "lsf" in args: lsf_resolution(); print("lsf done", flush=True)
    if "matrix" in args: requirement_matrix(); print("matrix done", flush=True)
    if "ions" in args:
        want = [a for a in args if a not in ("lsf", "matrix", "ions")]
        for L in cgm_lines():
            if (not want or L.ion in want) and (ROOT / "grids" / f"{L.key}.npz").exists():
                ion_instrument_plane(L); ion_absorber_plane(L); print(L.ion, "done", flush=True)
