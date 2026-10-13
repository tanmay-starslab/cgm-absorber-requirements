"""Pack the grids and theory curves into docs/index.html (single self-contained page).

    python scripts/export_web_data.py
The page template is docs/_template.html; the data replace the /*__DATA__*/ marker.
"""
import json, sys
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from absreq.lines import cgm_lines
from absreq import theory


def r(a, nd=4):
    return [round(float(x), nd) for x in np.ravel(a)]


def main():
    ions = []
    for L in cgm_lines():
        g = np.load(ROOT / "grids" / f"{L.key}.npz")
        kR = slice(None, None, 2)
        K = g["K"][:, :, kR]
        ions.append(dict(
            key=L.key, ion=L.ion, lam=L.lam, label=L.label_lam, f=L.f, gamma=L.gamma, source=L.source,
            T=L.T, phase=L.phase, b_fid=round(L.b_fid, 3), logN_tau1=round(L.logN_tau1(), 3),
            det=dict(logN=r(g["logN_det"], 3), b=r(g["b_det"], 3), R=r(g["R_det"][kR], 1),
                     shape=list(K.shape), logK=r(np.log10(K), 4)),
            sep=dict(logN=r(g["logN_sep"], 3), dv=r(g["dv_sep"], 3), R=r(g["R_sep"], 1),
                     shape=list(g["G"].shape), logG=r(np.log10(np.maximum(g["G"], 1e-30)), 4)),
        ))
    S = np.logspace(np.log10(3), 3, 120)
    th = dict(S=r(S, 3), curves={k: [None if not np.isfinite(v) else round(float(v), 4) for v in theory.dvmin_over_fwhm(S, q)]
                                for k, q in (("1:1", 0.5), ("1:2", 1 / 3), ("1:4", 0.2))})
    data = json.dumps(dict(ions=ions, theory=th), separators=(",", ":"))
    tpl = (ROOT / "docs" / "_template.html").read_text()
    (ROOT / "docs" / "index.html").write_text(tpl.replace("/*__DATA__*/null", data))
    print(f"docs/index.html written ({len(data) / 1e6:.2f} MB of data)")


if __name__ == "__main__":
    main()
