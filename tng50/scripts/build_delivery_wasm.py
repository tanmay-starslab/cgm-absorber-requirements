#!/usr/bin/env python3
"""Assemble the PIXEL-IDENTICAL Explorer: inline the real Python modules (cgm_style, degrade,
make_publication_figure) + the exported data into delivery/template_wasm.html ->
<out_dir>/delivery/CGM_Explorer.html. The page runs those exact modules in the browser via Pyodide,
so its figures are produced by the same matplotlib code as the live app.
degrade/cgm_style are shims over the tngsight package, so its sources are bundled too: the template
writes flat files only, so `_tngsight_bundle.py` recreates tngsight/ in the Pyodide FS on import.
Reads/writes under cgm_paths.out_dir() (env TNG_LEGACY_OUT); the template stays in the repo.
"""
from __future__ import annotations
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SC = ROOT / "scripts"
sys.path.insert(0, str(SC))
import cgm_paths as P  # noqa: E402

DEL = ROOT / "delivery"
MODULES = ["cgm_style.py", "degrade.py", "make_publication_figure.py"]
BOOT = "import _tngsight_bundle  # noqa: F401  (bundled by build_delivery_wasm.py)\n"


def safe(s: str) -> str:
    return s.replace("</script>", "<\\/script>")


def tngsight_bundle() -> str:
    """Source of a module that writes the tngsight package next to itself if it is not importable."""
    pkg = P.REPO / "tngsight"
    files = {f"tngsight/{f.name}": f.read_text() for f in sorted(pkg.iterdir())
             if f.suffix in (".py", ".json")}
    return ("import os, importlib.util\n"
            f"_FILES = {files!r}\n"
            "if importlib.util.find_spec('tngsight') is None:\n"
            "    _here = os.path.dirname(os.path.abspath(__file__))\n"
            "    for _n, _src in _FILES.items():\n"
            "        _p = os.path.join(_here, _n)\n"
            "        os.makedirs(os.path.dirname(_p), exist_ok=True)\n"
            "        with open(_p, 'w') as _f:\n"
            "            _f.write(_src)\n"
            "    importlib.invalidate_caches()\n")


def pyfiles() -> dict:
    out = {m: (SC / m).read_text() for m in MODULES}
    for m in ("cgm_style.py", "degrade.py"):          # first imports: make tngsight importable
        fut = "from __future__ import annotations\n"   # must stay the first statement
        out[m] = out[m].replace(fut, fut + BOOT, 1) if fut in out[m] else BOOT + out[m]
    out["_tngsight_bundle.py"] = tngsight_bundle()
    return out


def main():
    od = P.out_dir() / "delivery"
    tpl = (DEL / "template_wasm.html").read_text()
    html = (tpl
            .replace("__PY_FILES__", safe(json.dumps(pyfiles())))
            .replace("__DATA_JSON__", safe((od / "_webdata_wasm.json").read_text())))
    out = od / "CGM_Explorer.html"
    out.write_text(html)
    print(f"wrote {out}  ({out.stat().st_size/1e6:.2f} MB)  [Pyodide/WASM, pixel-identical]")


if __name__ == "__main__":
    main()
