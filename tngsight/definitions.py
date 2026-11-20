"""Physics definitions (D8/D9) as data: tngsight/definitions.json is the one source of truth for Python and JS.

load() returns the parsed JSON after validate(); validate() returns a list of problems ([] = consistent).
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

PATH = Path(__file__).resolve().parent / "definitions.json"


def validate(d: dict) -> list[str]:
    errs = []
    b = d.get("bins", {})
    for k in ("logT_edges", "r_edges_R200c"):
        e = b.get(k) or []
        if not e or e != sorted(e) or len(set(e)) != len(e):
            errs.append(f"bins.{k} must be non-empty, strictly increasing")
    for v in (4.5, 5.0, 5.5, 6.0):
        if v not in b.get("logT_edges", []):
            errs.append(f"bins.logT_edges lacks {v}")
    for v in (0.1, 0.15, 0.3, 1.0, 2.0):
        if v not in b.get("r_edges_R200c", []):
            errs.append(f"bins.r_edges_R200c lacks {v}")
    if "R200m" not in b.get("r_edges_per_halo", []):
        errs.append("bins.r_edges_per_halo lacks R200m")
    # phase boundaries and region edges must be bin edges, so every class is a union of bins
    for name, s in d["phases"]["schemes"].items():
        for c in s["classes"]:
            for k in ("logT_min", "logT_max"):
                if c.get(k) is not None and c[k] not in b["logT_edges"]:
                    errs.append(f"phases.{name}.{c['id']}.{k} = {c[k]} is not a bin edge")
    for name, r in d["regions"].items():
        if isinstance(r, dict):
            for k in ("r_min_R200c", "r_max_R200c"):
                if k in r and r[k] not in b["r_edges_R200c"]:
                    errs.append(f"regions.{name}.{k} = {r[k]} is not a bin edge")
    ids = [t["id"] for t in d.get("toggles", [])]
    if len(ids) != len(set(ids)):
        errs.append("duplicate toggle ids")
    for t in d.get("toggles", []):
        if t["default"] not in t["options"] or len(set(t["options"])) != len(t["options"]):
            errs.append(f"toggle {t['id']}: default {t['default']!r} not in options or options repeat")
    for sec in ("frame", "cooling", "t_ff", "satellites"):
        s = d[sec]
        opts = set(s.get("options", {})) | ({s["default"]} if sec == "frame" else set())
        if s["default"] not in opts:
            errs.append(f"{sec}.default {s['default']!r} has no definition")
    tog = {t["id"]: t for t in d.get("toggles", [])}
    for sec in ("frame", "cooling", "t_ff", "satellites"):
        if sec in tog and tog[sec]["default"] != d[sec]["default"]:
            errs.append(f"toggle {sec} default differs from {sec}.default")
    for t in tog.get("frame", {}).get("options", []):
        if t != d["frame"]["default"] and t not in d["frame"]["alternatives"]:
            errs.append(f"frame option {t} has no definition")
    if d["citations"]["ps20"]["arxiv"] != "2006.14322":
        errs.append("PS20 is arXiv:2006.14322")
    for k, s in d.get("texts", {}).items():
        if " · " in s or s.rstrip().endswith("."):
            errs.append(f"texts.{k}: owner style (no dot separators, no trailing full stop)")
    return errs


@lru_cache(maxsize=1)
def load() -> dict:
    d = json.loads(PATH.read_text())
    errs = validate(d)
    if errs:
        raise ValueError("definitions.json: " + "; ".join(errs))
    return d
