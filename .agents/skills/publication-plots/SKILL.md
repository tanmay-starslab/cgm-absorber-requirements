---
name: publication-plots
description: "Use for EVERY figure, plot, chart or diagram produced for a paper, thesis, talk or report — matplotlib, or any Python plotting. Enforces LaTeX-formatted type (Computer Modern), journal column widths, colour-vision-safe palettes, vector + raster output, and a written log per figure. Trigger on: make a plot, make a figure, plot this, chart, histogram, scatter, map, panel figure, publication quality, LaTeX fonts."
---

# Publication-quality figures

Every figure is LaTeX-typeset, sized for its destination column, colour-vision
safe, emitted as **both** vector and raster, and logged. No exceptions for
"quick look" plots — a quick look that gets shown to a supervisor becomes a
figure, and restyling later costs more than doing it once.

## Use the helper

`assets/pubplot.py` does the setup. Copy it next to the plotting script (or add
its directory to `sys.path`) and start every figure script with:

```python
import pubplot
pubplot.use(width="single")        # "single" | "double" | float inches
fig, ax = pubplot.figure()
...
pubplot.save(fig, "fig07_my_figure", outdir="figures", caption="One line on what it shows.")
# no panel_tag(): final figures carry no (a)/(b)/(c) letters
```

`pubplot.save` writes `.pdf` **and** `.png` at 400 dpi, plus appends a line to
`figures/FIGURE_LOG.tsv` recording the stem, timestamp, git commit, the script
that made it, whether real LaTeX was used, and the caption.

## The rules it enforces

**Type is LaTeX.** `text.usetex=True` with Computer Modern when a working
`latex` + `dvipng` exist. If they do not, it falls back to matplotlib's `cm`
mathtext with CM-matched serif text — and **says so loudly** on stderr and in
the log, because a silent fallback yields two different-looking versions of the
same figure. Never set `usetex` by hand elsewhere; ask `pubplot.latex_ok()`.

**Exact width means exact.** When a figure must be the paper's `\linewidth`,
save with `pubplot.save(..., exact=True)`. The default tight bounding box crops
the canvas, so a 7.10 in figure silently becomes ~7.04 in and LaTeX rescales the
type. With `exact=True`, lay the axes out in inches and leave margins for every
tick label (the last x tick label overhangs the right edge by half its width).
The log records the size read back from the saved PDF, not the requested one.
Measure `\linewidth` from the actual document class rather than assuming it.

**Text over images: placement, not outlines.** Do not wrap text in a contrasting
stroke or box to rescue legibility. Place labels where the background is
already plain — treat bright image pixels as obstacles in the collision test —
and use a plain colour that contrasts with that background. A black outline on
an already black sky only thickens the glyphs.

**Every annotation goes through a collision test,** against other text, data
points, lines, arrows and image-bright regions, and the build fails rather than
writing a figure with a collision.

**Width is the destination's width, and the figure is never scaled afterwards.**
AASTeX single column is 3.35 in, full width 7.1 in. Scaling a figure in LaTeX
changes its effective font size and breaks the match with body text, so set the
width here and use `\includegraphics[width=\columnwidth]` with no scale factor.

**Font sizes are absolute, not relative.** Axis labels 9 pt, ticks 8 pt, legend
8 pt, panel tags 10 pt bold. At single-column width these land at 7–9 pt on the
page, which is the floor for print legibility.

**Colour never carries meaning alone.** Every series gets a second channel —
linestyle, marker or hatch. The default palette is Okabe–Ito, which stays
distinguishable under deuteranopia and protanopia and separates in greyscale.
`pubplot.check_palette()` prints the pairwise CIE76 distances.

**Axes tell the truth.** Bar baselines include zero; a truncated axis is marked
with a break glyph; log axes are labelled as log; shared panels share limits
unless the caption says otherwise. State units in every axis label.

**Every axis is boxed, with inward ticks on all four sides.** All four spines
visible; major and minor ticks on top, bottom, left and right, all pointing
inward. This applies to image panels too (use white ticks over a dark image).
`pubplot.use()` sets it; call `pubplot.box_ticks(ax)` on any axis you customise
afterwards, and on secondary axes, which do not inherit it.

**No panel letters in final figures.** No "(a)", "(b)", "(c)", no sub-titles or
sub-captions acting as panel labels. Panels are referred to by position in the
caption ("left", "centre", "right", "top row").

**No chartjunk.** No 3-D effects on 2-D data, no gradient fills, no shadows, no
gridlines.

**Error bars must be visible.** If the uncertainties are smaller than the marker,
shrink the marker, darken the bars and give them caps; if they are still hidden,
say so in the caption rather than letting the reader assume they were omitted.

## Rasters inside vectors

Scatter plots above ~5000 points and all image/pcolormesh layers get
`rasterized=True` so the PDF stays small while axes, text and lines remain
vector. This project has previously shipped 15 MB vector scatter figures; don't
repeat that.

## Per-project style

If the project already has a style module — this repo has
`62_family_models/famstyle.py` — read it first and keep its palette and
semantics (one hue per family, dash patterns, hatches). Override the type, the
LaTeX switch, and the frame: the boxed, inward-tick, no-panel-letter rules above
are the user's house style and win over any project module (famstyle uses
outward ticks on two sides; that is superseded). Do not create a second competing look for the same figure
family, and say so if the project style and these rules genuinely conflict.

## Before declaring a figure done

- Open the PNG and look at it. Do not ship an unexamined figure.
- Check at final size that nothing collides and no label is clipped.
- Confirm every axis has units and every series is in the legend or labelled.
- Confirm the log line was written.
