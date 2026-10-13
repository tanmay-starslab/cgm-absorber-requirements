#!/usr/bin/env python3
"""Assemble the PIXEL-IDENTICAL Explorer: inline the real Python modules (cgm_style, degrade,
make_publication_figure) + the exported data into delivery/template_wasm.html ->
delivery/CGM_Explorer.html. The page runs those exact modules in the browser via Pyodide, so its
figures are produced by the same matplotlib code as the live app.
"""
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SC = ROOT / "scripts"
DEL = ROOT / "delivery"
MODULES = ["cgm_style.py", "degrade.py", "make_publication_figure.py"]


def safe(s: str) -> str:
    return s.replace("</script>", "<\\/script>")


def main():
    pyfiles = {m: (SC / m).read_text() for m in MODULES}
    tpl = (DEL / "template_wasm.html").read_text()
    html = (tpl
            .replace("__PY_FILES__", safe(json.dumps(pyfiles)))
            .replace("__DATA_JSON__", safe((DEL / "_webdata_wasm.json").read_text())))
    out = DEL / "CGM_Explorer.html"
    out.write_text(html)
    print(f"wrote {out}  ({out.stat().st_size/1e6:.2f} MB)  [Pyodide/WASM, pixel-identical]")


if __name__ == "__main__":
    main()
