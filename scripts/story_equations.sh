#!/usr/bin/env bash
# Build the story's equation SVGs (docs/tng50/learn/how-a-spectrum-is-made/eq/<id>.svg) from LaTeX with latex + dvisvgm.
# Glyphs become paths (no fonts needed at view or render time) and every fill is currentColor, so the page sets the
# colour from its theme when it inlines the SVG. Each SVG carries <title> (the spoken form) for screen readers.
# Usage: scripts/story_equations.sh            (needs latex with amsmath + standalone, and dvisvgm >= 2.3)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/docs/tng50/learn/how-a-spectrum-is-made/eq"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
command -v latex >/dev/null || { echo "latex not found" >&2; exit 1; }
command -v dvisvgm >/dev/null || { echo "dvisvgm not found" >&2; exit 1; }

# id | LaTeX (display math) | spoken form (goes into <title>)
EQS=$(cat <<'TEX'
tau0|\tau_0 = 1.4975\times10^{-15}\,\dfrac{N\,f\,\lambda_{[\mathrm{\AA}]}}{b_{[\mathrm{km\,s^{-1}}]}}|tau zero equals 1.4975 times ten to the minus 15, times N f lambda in angstrom, over b in kilometres per second
profile|\tau(V) = \tau_0\,e^{-(V-V_c)^2/b^2},\qquad F = e^{-\tau}|tau of V equals tau zero times e to the minus V minus V c squared over b squared; F equals e to the minus tau
doppler|V = c\left(\dfrac{\lambda}{\lambda_0}-1\right) + v_{\mathrm{sys}}|V equals c times lambda over lambda zero minus one, plus v sys
bwidth|b^2 = \dfrac{2kT}{m} + b_{\mathrm{turb}}^2|b squared equals 2 k T over m, plus b turb squared
tausum|\tau_{\mathrm{total}}(V) = \sum_i \tau_i(V),\qquad F = e^{-\tau_{\mathrm{total}}}|tau total equals the sum over cells of tau i; F equals e to the minus tau total
satwidth|\tau_0 \gg 1:\ \ \Delta V \propto b\sqrt{\ln\tau_0},\qquad a = \dfrac{\Gamma\lambda}{4\pi b}|for tau zero much greater than one, the width grows as b times the square root of ln tau zero; the damping parameter a equals Gamma lambda over 4 pi b
lsf|F_{\mathrm{obs}} = F \otimes \mathcal{G},\qquad \mathrm{FWHM} = \dfrac{c}{R}|F observed equals F convolved with a Gaussian; FWHM equals c over R
noise|\sigma_{\mathrm{pix}} = \dfrac{\sqrt{5}}{S/N}\quad(5\ \text{pixels per resolution element})|sigma per pixel equals root 5 over S over N, with 5 pixels per resolution element
lognsum|\log N_{\mathrm{total}} = \log_{10}\sum_i N_i|log N total equals log base ten of the sum of N i
aod|N = \dfrac{m_e c}{\pi e^2}\,\dfrac{\int \tau(V)\,dV}{f\,\lambda}|N equals m e c over pi e squared, times the integral of tau d V, over f lambda
TEX
)

n=0
while IFS='|' read -r id tex spoken; do
  [ -z "$id" ] && continue
  cat > "$TMP/$id.tex" <<DOC
\documentclass[border=1pt]{standalone}
\usepackage{amsmath,amssymb}
\begin{document}
\(\displaystyle $tex\)
\end{document}
DOC
  (cd "$TMP" && latex -interaction=nonstopmode -halt-on-error "$id.tex" >/dev/null) || { echo "latex failed: $id" >&2; cat "$TMP/$id.log" >&2; exit 1; }
  dvisvgm --no-fonts --exact --zoom=1 --precision=3 --stdout "$TMP/$id.dvi" 2>/dev/null > "$TMP/$id.svg"
  python3 - "$TMP/$id.svg" "$OUT/$id.svg" "$spoken" <<'PY'
import re, sys
src, dst, spoken = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src, encoding="utf-8").read()
s = re.sub(r"<\?xml[^>]*\?>\s*", "", s)
s = re.sub(r"<!--.*?-->\s*", "", s, flags=re.S)
s = re.sub(r"<!DOCTYPE[^>]*>\s*", "", s)
# every glyph and rule in currentColor; dvisvgm writes black as the default or as #000
s = re.sub(r'fill="(#000|#000000|black)"', 'fill="currentColor"', s)
s = re.sub(r'stroke="(#000|#000000|black)"', 'stroke="currentColor"', s)
s = re.sub(r"<svg ", '<svg role="img" fill="currentColor" ', s, count=1)
# glyph ids are per font (g0-61 ...), so two equations inlined in one page would borrow each other's glyphs: prefix them
pre = "eq-" + re.sub(r"\W", "", dst.rsplit("/", 1)[-1].rsplit(".", 1)[0]) + "-"
s = re.sub(r"id='([^']+)'", lambda m: f"id='{pre}{m.group(1)}'", s)
s = re.sub(r"href='#([^']+)'", lambda m: f"href='#{pre}{m.group(1)}'", s)
# size in em, not pt, so equations scale with the text around them (10 pt TeX ~ 1 em; x1.25 reads well at 16 px body)
s = re.sub(r"(width|height)='([\d.]+)pt'", lambda m: f"{m.group(1)}='{float(m.group(2)) / 10 * 1.25:.3f}em'", s, count=2)
esc = spoken.replace("&", "&amp;").replace("<", "&lt;")
s = re.sub(r"(<svg[^>]*>)", r"\1<title>" + esc + "</title>", s, count=1)
s = re.sub(r">\s+<", "><", s).strip() + "\n"
open(dst, "w", encoding="utf-8").write(s)
PY
  n=$((n+1))
done <<< "$EQS"
echo "wrote $n equations to $OUT"
