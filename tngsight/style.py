"""Publication style for the CGM spectra figures (port of tng50/scripts/cgm_style.py).
Computer-Modern serif (usetex optional, mathtext 'cm' otherwise), inward major+minor ticks on all
sides, thick spines, vivid per-ion colours. FIGDIR comes from config.figdir() (no cluster paths)."""
from __future__ import annotations
import shutil
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from .config import figdir

ION = {
    "OVI":   dict(color="#D81E5B", label=r"$\mathrm{O\,VI}\ \lambda1032$"),      # magenta-red
    "HILyb": dict(color="#1D4E89", label=r"$\mathrm{H\,I}\ \mathrm{Ly}\beta$"),  # deep blue
    "CIII":  dict(color="#1B998B", label=r"$\mathrm{C\,III}\ \lambda977$"),      # teal-green
}
ION_ORDER = ["OVI", "HILyb", "CIII"]


def has_latex() -> bool:
    return shutil.which("latex") is not None and shutil.which("dvipng") is not None


def rc(usetex=None, base=15.0) -> dict:
    """rcParams of the publication style (usetex None = auto-detect latex+dvipng)."""
    if usetex is None:
        usetex = has_latex()
    r = {
        "font.family": "serif", "font.size": base,
        "axes.labelsize": base + 3, "axes.titlesize": base + 1,
        "xtick.labelsize": base - 2, "ytick.labelsize": base - 2, "legend.fontsize": base - 2,
        "axes.linewidth": 1.6,
        "xtick.direction": "in", "ytick.direction": "in", "xtick.top": True, "ytick.right": True,
        "xtick.major.size": 8.0, "ytick.major.size": 8.0,
        "xtick.major.width": 1.4, "ytick.major.width": 1.4,
        "xtick.minor.size": 4.5, "ytick.minor.size": 4.5,
        "xtick.minor.width": 1.0, "ytick.minor.width": 1.0,
        "xtick.minor.visible": True, "ytick.minor.visible": True,
        "legend.frameon": True, "legend.framealpha": 0.92, "legend.edgecolor": "0.55",
        "axes.grid": False, "figure.facecolor": "white", "savefig.facecolor": "white",
        "figure.dpi": 110, "lines.solid_capstyle": "round",
    }
    if usetex:
        r.update({"text.usetex": True, "font.serif": ["Computer Modern Roman"],
                  "text.latex.preamble": r"\usepackage{amsmath}\usepackage{textcomp}"})
    else:
        r.update({"text.usetex": False, "mathtext.fontset": "cm",
                  "font.serif": ["cmr10", "DejaVu Serif"], "axes.formatter.use_mathtext": True})
    return r


def set_style(usetex=None, base=15.0):
    """Apply the style globally (as the original); returns the usetex flag used."""
    r = rc(usetex, base)
    plt.rcParams.update(r)
    return r["text.usetex"]


def save(fig, name, dpi=240, outdir=None):
    """Write <outdir or config.figdir()>/<name>.{pdf,png}; closes fig; returns the png path."""
    d = figdir() if outdir is None else Path(outdir)
    d.mkdir(parents=True, exist_ok=True)
    for ext in ("pdf", "png"):
        fig.savefig(d / f"{name}.{ext}", dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    return d / f"{name}.png"
