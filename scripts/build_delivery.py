#!/usr/bin/env python3
"""Assemble the self-contained, double-clickable CGM Explorer: inline Plotly.js + the exported
sightline data into delivery/template.html -> delivery/CGM_Explorer.html (one offline HTML file).
"""
from __future__ import annotations
from pathlib import Path
import plotly

ROOT = Path(__file__).resolve().parent.parent
DEL = ROOT / "delivery"
PLOTLY_JS = Path(plotly.__file__).parent / "package_data" / "plotly.min.js"


def safe(s: str) -> str:
    # keep an inline <script> from being closed early by any literal </script> in the payload
    return s.replace("</script>", "<\\/script>")


def main():
    tpl = (DEL / "template.html").read_text()
    pjs = safe(PLOTLY_JS.read_text())
    data = safe((DEL / "_webdata.json").read_text())
    html = tpl.replace("__PLOTLY_JS__", pjs).replace("__DATA_JSON__", data)
    out = DEL / "CGM_Explorer.html"
    out.write_text(html)
    print(f"wrote {out}  ({out.stat().st_size/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
