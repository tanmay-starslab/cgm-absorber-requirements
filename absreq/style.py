"""Shared publication style: LaTeX text (Times via txfonts, T1 encoding), AAS column widths."""
import matplotlib as mpl
mpl.use("Agg")
COL, PAGE = 3.35, 7.1          # AAS single column / full-page width in inches
INK, INK2, GRID = "#111111", "#4a4a4a", "#d0d0d0"
BLUES = ["#eaf2fd", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
ORANGES = ["#fdeee4", "#fbd9c5", "#f6b594", "#f08f62", "#e36a37", "#bf4f21", "#933a16", "#66270d"]
TEAL = "#1baf7a"
def apply():
    mpl.rcParams.update({
        "text.usetex": True,
        "text.latex.preamble": r"\usepackage{amsmath}\usepackage[T1]{fontenc}\usepackage{txfonts}",
        "font.family": "serif", "font.size": 8.5, "axes.labelsize": 9, "axes.titlesize": 9,
        "legend.fontsize": 7.5, "xtick.labelsize": 8, "ytick.labelsize": 8,
        "axes.linewidth": 0.6, "axes.edgecolor": INK, "axes.labelcolor": INK,
        "xtick.color": INK, "ytick.color": INK, "xtick.direction": "in", "ytick.direction": "in",
        "xtick.top": True, "ytick.right": True, "xtick.major.size": 3.2, "ytick.major.size": 3.2,
        "xtick.minor.size": 1.8, "ytick.minor.size": 1.8, "xtick.major.width": 0.6, "ytick.major.width": 0.6,
        "lines.linewidth": 1.1, "savefig.dpi": 400, "pdf.fonttype": 42, "savefig.bbox": "tight",
        "savefig.pad_inches": 0.02, "legend.frameon": False,
    })
