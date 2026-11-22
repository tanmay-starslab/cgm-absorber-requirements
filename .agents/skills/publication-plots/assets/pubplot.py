"""Publication figure setup: LaTeX type, journal widths, safe colours, logged output.

Import, call use(), build the figure, call save(). See the skill's SKILL.md.
Nothing here is a measurement; it is style and bookkeeping only.
"""
from __future__ import annotations

import datetime as _dt
import os
import shutil
import subprocess
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt          # noqa: E402
import numpy as np                        # noqa: E402

# AASTeX / ApJ geometry, inches.
WIDTH = {"single": 3.35, "double": 7.1, "onehalf": 5.0}

# Okabe-Ito: distinguishable under deuteranopia and protanopia, separates in grey.
PALETTE = ["#0072B2", "#D55E00", "#009E73", "#CC79A7",
           "#E69F00", "#56B4E9", "#F0E442", "#000000"]
DASHES = [(), (4, 1.6), (1.2, 1.2), (5, 1.4, 1.2, 1.4),
          (3, 1.2, 1.2, 1.2), (7, 2), (1.8, 1.0), (6, 1.4, 1.4, 1.4)]
MARKERS = ["o", "s", "^", "D", "v", "P", "X", "*"]

_LATEX_OK: bool | None = None
_LATEX_WHY = ""


def latex_ok() -> bool:
    """True if a usable latex+dvipng toolchain exists. Cached; never raises."""
    global _LATEX_OK, _LATEX_WHY
    if _LATEX_OK is not None:
        return _LATEX_OK
    missing = [b for b in ("latex", "dvipng") if shutil.which(b) is None]
    if missing:
        _LATEX_OK, _LATEX_WHY = False, f"missing binaries: {', '.join(missing)}"
        return False
    # Prove it actually compiles; a present binary with a broken tree is common.
    try:
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            src = Path(td, "t.tex")
            src.write_text(r"\documentclass{article}\usepackage{type1cm}"
                           r"\begin{document}$x_{1}$\end{document}")
            subprocess.run(["latex", "-interaction=nonstopmode", "-halt-on-error", src.name],
                           cwd=td, capture_output=True, timeout=120, check=True)
        _LATEX_OK, _LATEX_WHY = True, ""
    except Exception as exc:                                    # noqa: BLE001
        _LATEX_OK, _LATEX_WHY = False, f"test compile failed: {type(exc).__name__}"
    return _LATEX_OK


def use(width: str | float = "single", *, height: float | None = None,
        force_mathtext: bool = False) -> None:
    """Install the publication rcParams. Call once before creating figures."""
    w = WIDTH.get(width, width) if isinstance(width, str) else float(width)
    h = height if height is not None else w * 0.68

    if force_mathtext or not latex_ok():
        # Loud, never silent: a quiet fallback ships two looks for one figure.
        print(f"[pubplot] WARNING: real LaTeX not used ({_LATEX_WHY or 'forced'}); "
              f"falling back to matplotlib mathtext 'cm'. Type metrics will differ "
              f"slightly from a LaTeX build.", file=sys.stderr)
        tex = {"text.usetex": False, "mathtext.fontset": "cm",
               "font.family": "serif",
               "font.serif": ["CMU Serif", "Computer Modern Roman",
                              "DejaVu Serif"]}
    else:
        tex = {"text.usetex": True, "font.family": "serif",
               "font.serif": ["Computer Modern Roman"],
               "text.latex.preamble": r"\usepackage{amsmath}\usepackage{amssymb}"}

    plt.rcParams.update({
        **tex,
        "figure.figsize": (w, h), "figure.dpi": 140, "savefig.dpi": 400,
        "savefig.bbox": "tight", "savefig.pad_inches": 0.02,
        "axes.labelsize": 9, "axes.titlesize": 9, "font.size": 9,
        "xtick.labelsize": 8, "ytick.labelsize": 8, "legend.fontsize": 8,
        # House style (user requirement): boxed on all four sides, major AND minor
        # ticks pointing inward on all four sides, no grid.
        "axes.linewidth": 0.8,
        "axes.spines.top": True, "axes.spines.right": True,
        "axes.spines.bottom": True, "axes.spines.left": True,
        "xtick.direction": "in", "ytick.direction": "in",
        "xtick.top": True, "ytick.right": True,
        "xtick.bottom": True, "ytick.left": True,
        "xtick.minor.visible": True, "ytick.minor.visible": True,
        "xtick.major.size": 4.0, "ytick.major.size": 4.0,
        "xtick.minor.size": 2.0, "ytick.minor.size": 2.0,
        "xtick.major.width": 0.8, "ytick.major.width": 0.8,
        "xtick.minor.width": 0.6, "ytick.minor.width": 0.6,
        "axes.grid": False,
        "legend.frameon": False, "lines.linewidth": 1.3, "lines.markersize": 3.5,
        "axes.prop_cycle": plt.cycler(color=PALETTE),
        "pdf.fonttype": 42, "ps.fonttype": 42,
    })


def figure(nrows: int = 1, ncols: int = 1, **kw):
    return plt.subplots(nrows, ncols, constrained_layout=True, **kw)


def box_ticks(ax, color: str | None = None) -> None:
    """Re-assert the house style on an axis that was customised after use().

    Boxed on all four sides, major and minor ticks inward on all four sides.
    Call it on image panels too (pass color="white" over dark images) and on any
    axis built after use() with settings that might have been overridden.
    """
    for sp in ax.spines.values():
        sp.set_visible(True)
    ax.minorticks_on()
    kw = dict(direction="in", top=True, right=True, bottom=True, left=True)
    if color is not None:
        kw["color"] = color
    ax.tick_params(which="both", **kw)
    ax.tick_params(which="major", length=4.0, width=0.8)
    ax.tick_params(which="minor", length=2.0, width=0.6)
    ax.grid(False)


def _git_commit(start: Path) -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=start,
                              capture_output=True, text=True, timeout=20).stdout.strip() or "n/a"
    except Exception:                                            # noqa: BLE001
        return "n/a"


def _pdf_size_in(path: Path):
    """True page size of a saved PDF, from its MediaBox, in inches."""
    import re
    m = re.search(rb"/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)",
                  path.read_bytes())
    if not m:
        return None
    x0, y0, x1, y1 = (float(v) for v in m.groups())
    return (x1 - x0) / 72.0, (y1 - y0) / 72.0


def save(fig, stem: str, outdir: str | Path = ".", *, caption: str = "",
         formats=("pdf", "png"), close: bool = True, exact: bool = False) -> list[Path]:
    """Write every format, append a log line with the TRUE saved size, return paths.

    exact=True saves the canvas as laid out (no tight crop) and asserts the PDF
    is exactly the figure size. Use it whenever a figure must be a given width,
    e.g. the paper's linewidth: savefig.bbox='tight' silently crops the canvas,
    so a 7.10 in figure can come out 7.04 in and LaTeX then rescales its type.
    With exact=True you must leave margins wide enough for every tick label.
    """
    out = Path(outdir); out.mkdir(parents=True, exist_ok=True)
    # NB: savefig(bbox_inches=None) does NOT disable cropping -- None means "use
    # rcParams['savefig.bbox']", which use() sets to "tight". Override the rc.
    rc = {"savefig.bbox": "standard"} if exact else {}
    paths = []
    with plt.rc_context(rc):
        for ext in formats:
            p = out / f"{stem}.{ext}"
            fig.savefig(p)
            paths.append(p)
    want_w, want_h = fig.get_size_inches()
    pdfs = [p for p in paths if p.suffix == ".pdf"]
    got = _pdf_size_in(pdfs[0]) if pdfs else None
    if exact and got is not None and (abs(got[0] - want_w) > 0.002 or abs(got[1] - want_h) > 0.002):
        raise RuntimeError(f"{stem}: saved {got[0]:.3f}x{got[1]:.3f} in, wanted {want_w:.3f}x{want_h:.3f}")
    log = out / "FIGURE_LOG.tsv"
    new = not log.exists()
    script = Path(sys.argv[0]).name if sys.argv and sys.argv[0] else "interactive"
    size = f"{got[0]:.3f}x{got[1]:.3f}" if got else f"{want_w:.2f}x{want_h:.2f}(canvas)"
    with log.open("a") as fh:
        if new:
            fh.write("utc\tstem\tscript\tgit\tlatex\tsaved_size_in\tcaption\n")
        fh.write(f"{_dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')}\t"
                 f"{stem}\t{script}\t{_git_commit(out)}\t"
                 f"{'usetex' if plt.rcParams['text.usetex'] else 'mathtext-cm'}\t"
                 f"{size}\t{caption}\n")
    if close:
        plt.close(fig)
    return paths


def check_palette(colors=None) -> float:
    """Print pairwise CIE76 distances; return the minimum. Higher is safer (>25 good)."""
    cols = colors or PALETTE[:6]
    def to_lab(hx):
        r, g, b = (int(hx[i:i + 2], 16) / 255 for i in (1, 3, 5))
        f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        r, g, b = f(r), f(g), f(b)
        x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
        y = (0.2126 * r + 0.7152 * g + 0.0722 * b)
        z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
        g2 = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
        fx, fy, fz = g2(x), g2(y), g2(z)
        return np.array([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)])
    labs = [to_lab(c) for c in cols]
    worst = np.inf
    for i in range(len(cols)):
        for j in range(i + 1, len(cols)):
            d = float(np.linalg.norm(labs[i] - labs[j]))
            worst = min(worst, d)
            print(f"  {cols[i]} vs {cols[j]}: dE76 = {d:.1f}")
    print(f"minimum dE76 = {worst:.1f}")
    return worst
