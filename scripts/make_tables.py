"""Write paper/requirements_table.tex from the grids (log N_min at S/N=10, Dv_min at S/N=20)."""
import sys
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from absreq.lines import cgm_lines
from absreq.detection import logN_min
from absreq.separation import dv_min, sparrow

RS = [17000, 45800, 100000]


def cell(x, nd, hi):
    return f"{x:.{nd}f}" if np.isfinite(x) else (rf"$>{hi}$" if x > 0 else "---")


rows = []
for L in cgm_lines():
    g = np.load(ROOT / "grids" / f"{L.key}.npz")
    jb = int(np.argmin(abs(g["b_det"] - L.b_fid))); iN = int(np.argmin(abs(g["logN_sep"] - L.logN_tau1())))
    det, sep = [], []
    for R in RS:
        kd = int(np.argmin(abs(np.log(g["R_det"] / R)))); ks = int(np.argmin(abs(np.log(g["R_sep"] / R))))
        det.append(cell(logN_min(g["logN_det"], g["K"][:, jb, kd], 10), 2, f"{g['logN_det'][-1]:.1f}"))
        d = dv_min(g["dv_sep"], g["G"][iN, :, ks], 20)
        sep.append(cell(d, 1, "300") + (r"$^\ast$" if np.isfinite(d) and d < sparrow(R, L.b_fid) else ""))
    el, st = L.ion.split()
    rows.append(rf"{el}\,\textsc{{{st.lower()}}}\,$\lambda{L.label_lam}$ & {L.f:.4g} & {L.b_fid:.1f} & {L.logN_tau1():.2f} & "
                + " & ".join(det) + " & " + " & ".join(sep) + r" \\")
tab = r"""\begin{table*}[t]
\centering\small
\caption{Requirements for twelve CGM transitions. Columns 5--7: minimum detectable $\log N$ (3$\sigma$, S/N\,=\,10 per resolution element, $b=b_{\rm fid}$). Columns 8--10: smallest separation [\kms] at which two equal components, each with $\tau_0=1$, are resolved at 3$\sigma$ with S/N\,=\,20. $^\ast$: below the classical Sparrow separation.}
\label{tab:ions}
\begin{tabular}{lrrrrrrrrr}
\toprule
 & & & & \multicolumn{3}{c}{$\log N_{\rm min}$} & \multicolumn{3}{c}{$\Delta v_{\rm min}$}\\
\cmidrule(lr){5-7}\cmidrule(lr){8-10}
Transition & $f$ & $b_{\rm fid}$ & $\log N(\tau_0{=}1)$ & 17{,}000 & 45{,}800 & 100{,}000 & 17{,}000 & 45{,}800 & 100{,}000\\
\midrule
""" + "\n".join(rows) + r"""
\bottomrule
\end{tabular}
\end{table*}
"""
(ROOT / "paper" / "requirements_table.tex").write_text(tab)
print(tab)
