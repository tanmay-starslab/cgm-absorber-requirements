"""COS-LSF variants of the K and G cubes, next to (not replacing) the Gaussian grids in grids/.

For each ion and each stored HST/COS setting covering its rest wavelength (z = 0; absreq/lsf.py), K over logN x b and
G over logN x dv (at b_fid) are computed for the tabulated COS LSF and for a Gaussian of the same FWHM (the
'matched Gaussian').  The COS LSF has one resolution per setting, so the R axis becomes the setting.

    python scripts/build_cos_grids.py [ion ...]   # grids/cos/<key>_<setting>.npz
    python scripts/build_cos_grids.py --table     # grids/cos/summary.csv and paper/cos_lsf_table.tex
"""
import os, sys, time
from functools import lru_cache
from multiprocessing import Pool
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from absreq import lsf
from absreq.lines import cgm_lines
from absreq.detection import k_cube_lsf, logN_min
from absreq.separation import separation_G_lsf, dv_min
from build_grids import axes

OUT = ROOT / "grids" / "cos"
SNR = (10, 20, 50)


@lru_cache(maxsize=None)
def kernels(setting, lam):
    k = lsf.cos(*setting, lam)
    return k, lsf.gaussian(k.R)


def _row(args):
    line, setting, i, lN, dv = args
    out = np.empty((2, dv.size))
    for m, kern in enumerate(kernels(setting, line.lam)):
        out[m] = [separation_G_lsf(line, lN, line.b_fid, d, kern) for d in dv]
    return i, out


def build(line, setting, procs):
    t = time.time()
    kc, kg = kernels(setting, line.lam)
    logN_det, b_det, logN_sep, dv_sep = axes(line)
    K = k_cube_lsf(line, logN_det, b_det, [kc, kg])
    G = np.empty((2, logN_sep.size, dv_sep.size))
    with Pool(procs) as p:
        for i, out in p.imap_unordered(_row, [(line, setting, i, lN, dv_sep) for i, lN in enumerate(logN_sep)]):
            G[:, i] = out
    v = np.arange(-kc.half_width, kc.half_width, 0.25)
    np.savez_compressed(OUT / f"{line.key}_{kc.name}.npz", ion=line.ion, lam=line.lam, f=line.f, b_fid=line.b_fid,
                        setting=kc.name, fwhm=kc.fwhm, R_eff=kc.R, dv_pix=kc.dv_pix,
                        logN_det=logN_det, b_det=b_det, K_cos=K[:, :, 0], K_gauss=K[:, :, 1],
                        logN_sep=logN_sep, dv_sep=dv_sep, G_cos=G[0], G_gauss=G[1],
                        v_kernel=v, kernel=kc.profile(v))
    print(f"{line.key:10s} {kc.name:15s} R={kc.R:6.0f}  done in {time.time() - t:5.0f}s", flush=True)


def table():
    rows, tex = [], []
    for L in cgm_lines():
        for path in sorted(OUT.glob(f"{L.key}_*.npz")):
            g = np.load(path)
            jb = int(np.argmin(abs(g["b_det"] - L.b_fid))); iN = int(np.argmin(abs(g["logN_sep"] - L.logN_tau1())))
            r = [L.key, str(g["setting"]), f"{float(g['R_eff']):.0f}"]
            for s in SNR:
                nc, ng = (logN_min(g["logN_det"], g[k][:, jb], s) for k in ("K_cos", "K_gauss"))
                dc, dg = (dv_min(g["dv_sep"], g[k][iN], s) for k in ("G_cos", "G_gauss"))
                r += [f"{nc:.3f}", f"{ng:.3f}", f"{nc - ng:.3f}", f"{dc:.2f}", f"{dg:.2f}", f"{dc / dg:.3f}"]
            rows.append(r)
            el, st = L.ion.split(); i20 = 3 + 6 * SNR.index(20); i10 = 3
            tex.append(rf"{el}\,\textsc{{{st.lower()}}}\,$\lambda{L.label_lam}$ & "
                       + r[1].replace("-", "/", 1).replace("-", " ") + " & " + f"{int(r[2]):,}".replace(",", "{,}")
                       + rf" & {float(r[i10]):.2f} & {float(r[i10 + 2]):+.2f} & "
                       + (rf"{float(r[i20 + 3]):.1f} & {float(r[i20 + 5]):.2f}" if np.isfinite(float(r[i20 + 3]))
                          else r"$>300$ & ---") + r" \\")
    head = ["key", "setting", "R_eff"] + [f"{q}_snr{s}" for s in SNR for q in
                                          ("logNmin_cos", "logNmin_gauss", "dlogN", "dvmin_cos", "dvmin_gauss", "dv_ratio")]
    (OUT / "summary.csv").write_text("\n".join(",".join(x) for x in [head] + rows) + "\n")
    (ROOT / "paper" / "cos_lsf_table.tex").write_text(r"""\begin{table}[h]
\centering\footnotesize
\caption{Tabulated HST/COS LSF against a Gaussian of the same FWHM ($R_{\rm eff}=c/{\rm FWHM}$), at $z=0$ and $b=b_{\rm fid}$.
$\log N_{\rm min}$ at S/N\,=\,10 per FWHM and its excess over the matched Gaussian; $\Delta v_{\rm min}$ [\kms] for two
$\tau_0=1$ components at S/N\,=\,20 and its ratio to the matched Gaussian.}
\label{tab:cos}
\begin{tabular}{llrrrrr}
\toprule
Transition & Setting & $R_{\rm eff}$ & $\log N_{\rm min}$ & $\Delta\log N$ & $\Delta v_{\rm min}$ & ratio\\
\midrule
""" + "\n".join(tex) + r"""
\bottomrule
\end{tabular}
\end{table}
""")
    print((OUT / "summary.csv").read_text())


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    if "--table" in sys.argv:
        table(); sys.exit()
    procs = int(os.environ.get("SLURM_CPUS_PER_TASK", 2))
    want = sys.argv[1:]
    for L in cgm_lines():
        if not want or L.ion in want:
            for s in lsf.cos_settings_for(L.lam):
                build(L, s, procs)
