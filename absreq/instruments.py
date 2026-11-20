"""Spectrograph markers (R, optional S/N) read from data/instruments.json; see that file's _comment."""
import json
from pathlib import Path

PATH = Path(__file__).parent / "data" / "instruments.json"
FIELDS = ("lam", "R", "snr")


def load(path=PATH):
    return json.loads(Path(path).read_text())


def validate(d):
    """Raise ValueError unless every number has a known source and shown entries are complete."""
    refs = d["references"]
    for ins in d["instruments"]:
        who = ins["name"] or ins["status"]
        if ins.get("proposed") and ins["show"] and not ins["name"]:
            raise ValueError("proposed instrument is shown without a name")
        if ins["show"] and not ins["label"]:
            raise ValueError(f"{who}: shown without a label")
        for m in ins["modes"]:
            if ins["show"] and (m["lam"] is None or m["R"] is None):
                raise ValueError(f"{who}: shown with lam or R missing")
            for k in FIELDS:
                if m.get(k) is not None and m["sources"].get(k) not in refs:
                    raise ValueError(f"{who} {m['setting']}: {k} has no source in references")
            R = m["R"] if isinstance(m["R"], list) else [m["R"]]
            if m["R"] is not None and not all(1e2 < r < 1e6 for r in R):
                raise ValueError(f"{who}: implausible R {m['R']}")
    return d


def markers(lam, d=None):
    """Shown instruments covering rest wavelength lam [A] at z = 0:
    dicts with label, status, proposed, R_lo, R_hi (span over the covering modes) and snr (or None)."""
    d = validate(d or load())
    out = []
    for ins in d["instruments"]:
        modes = [m for m in ins["modes"] if ins["show"] and m["lam"][0] <= lam <= m["lam"][1]]
        if not modes:
            continue
        R = [r for m in modes for r in (m["R"] if isinstance(m["R"], list) else [m["R"]])]
        snr = next((m["snr"] for m in modes if m.get("snr") is not None), None)
        out.append(dict(label=ins["label"], status=ins["status"], proposed=bool(ins.get("proposed")),
                        R_lo=min(R), R_hi=max(R), snr=snr))
    return out
