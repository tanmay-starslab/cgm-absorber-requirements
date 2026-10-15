"""Publication style for the CGM spectra figures (port of tng50/scripts/cgm_style.py).
Computer-Modern serif (usetex optional, mathtext 'cm' otherwise), inward major+minor ticks on all
sides, thick spines, per-ion colours from the ion registry. FIGDIR comes from config.figdir() (no cluster paths)."""
from __future__ import annotations
import shutil
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from .config import figdir

from . import ions as _ions


def _tex_label(key) -> str:
    """'$\\mathrm{O\\,VI}\\ \\lambda1032$' from the registry label_tex 'O\\,VI\\ \\lambda1032'."""
    t = _ions.get(key)["label_tex"]
    ion, _, rest = t.partition("\\ ")
    return rf"$\mathrm{{{ion}}}\ {rest}$" if rest else f"${t}$"


# Per-ion colours (light theme: >= 4.99:1 on white) and LaTeX labels, from the ion registry.
ION = {k: dict(color=_ions.get(k)["color"], color_dark=_ions.get(k)["color_dark"], label=_tex_label(k))
       for k in _ions.KEYS}
ION_ORDER = list(_ions.KEYS)


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
