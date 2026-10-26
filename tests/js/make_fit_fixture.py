"""Build the JS fitter fixtures in tests/js/fixtures/ from a sightline library (design-3 section 5.6, Phase-3 C2).

fit_cases.json holds
  (a) 120 Faddeeva check points (a in [1e-7, 1], u in [0, 1e5]) with scipy.special.wofz values,
  (b) 24 degrade cases (every band, R at the range ends and the default, no-LSF, 3 S/N) with the noiseless model of
      tngsight.degrade.degrade_v (the web-path LSF of Phase-3 D1),
  (c) 60 fit cases (5 sightlines x 12 ions, one (R, S/N) case each from the 4-case set) with noisy data drawn by
      numpy and the result of the Python reference fitter below (a line-by-line numpy port of design-3 section 5.3:
      same windows, seed merge, LM, Delta-BIC pruning; flags as tngsight.vpfit, with vpfit's own tau_components and
      PARAMS for SAT), plus the chi^2 that scipy.optimize.least_squares(method="trf") reaches from the reference's
      final component set.
fit_bins/<id>.bin are the 5 sightlines' TNGS v2 binaries, copied from the library.
fit_tngs_cases.json holds crafted TNGS v2 blobs and the outcome both decoders must give (Phase-3 Code 4; written out
  by hand below, not taken from either decoder). tests/test_tngsight.py runs them through tngsight.library.decode_web,
  tests/js/fit_decode.mjs through decodeTNGS.
fit_native_<id>.json is a trimmed copy of the native 0.25 km/s optical depth of a few lines of one library sightline
  (tau > NATIVE_TRIM_TAU plus a margin; little-endian float32, base64); tests/test_web_lsf.py compares the web path
  with the native path on it. (JSON, not npz: the repository ignores *.npz.)
fit_native_cases.json holds the same lines zero-padded and encoded as TNGS v2 (one blob per line, "bins") with the native-path
  model (an exact Gaussian LSF of the 0.25 km/s point samples) at the output pixels, for tests/js/fit_degrade.mjs.

Usage:  python tests/js/make_fit_fixture.py --src LIBRARY [--ids ID x5] [--native-id ID] [--out tests/js/fixtures]
        python tests/js/make_fit_fixture.py --tngs-only          (fit_tngs_cases.json only; no library needed)
  --src  a v2 library directory (web/<id>.bin, sightlines/<id>.npz, components.json); default $TNG_FIT_SRC, else
         $TNG_WORK/data/library_v3 (TNG_WORK default /Volumes/cgm_work, tngsight.config.work_root).
"""
from __future__ import annotations
import argparse, base64, json, math, os, shutil, struct, sys
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares
from scipy.special import wofz

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tngsight import vpfit, ions as I, library as L  # noqa: E402
from tngsight import degrade as DG  # noqa: E402

def work_root() -> Path:
    """tngsight.config.work_root() (the TNG_WORK contract), or the same rule while config lacks it."""
    from tngsight import config
    f = getattr(config, "work_root", None)
    return Path(f()) if callable(f) else Path(os.environ.get("TNG_WORK") or "/Volumes/cgm_work")


# a v2 library dir (web/*.bin, sightlines/*.npz, components.json): $TNG_FIT_SRC, else $TNG_WORK/data/library_v3
DEFAULT_SRC = os.environ.get("TNG_FIT_SRC") or str(work_root() / "data" / "library_v3")
DEFAULT_IDS = ["edge_b075_a030", "edge_b100_a090", "face_b050_a090", "rand_b012_a158_s408616601",
               "rand_b031_a334_s175141482"]
NATIVE_ID = "edge_b100_a090"
NATIVE_KEYS = ("HI", "MgII", "SiII", "CII", "SiIV", "CIV", "OVI", "OVII")
NATIVE_TRIM_TAU, NATIVE_MARGIN_KMS = 1e-3, 20.0
NATIVE_R = {"uv": (150000, 100000, 50000, 20000), "xray": (150000, 20000, 5000, 1000, 300)}
C_KMS = 299792.458
FWHM_TO_SIGMA = 1 / 2.35482
PIX = 5
FIT_PARAMS = dict(maxIt=40, maxItPrune=20, maxTries=8, lambda0=1e-2, lambdaMin=1e-7, relTol=1e-5, padResel=2, padKms=10,
                  mergeFrac=0.5, bMax=300, logNMin=10, bicK=3, maxPrunePasses=30, chi2nuPoor=2.0)
FLAGS = {k: vpfit.FLAGS[k] for k in ("SAT", "BOUND", "POORFIT", "NOERR", "DAMPED")}
CASES = {"uv": [(15000, 20), (50000, 20), (15000, 5), (50000, 5)],
         "xray": [(300, 20), (3000, 20), (300, 5), (3000, 5)]}
CASES["euv"] = CASES["uv"]


def has_lsf(R):
    return bool(R and math.isfinite(R) and R > 0)


# --------------------------------------------------------------------------------------------------------------
def load_registry():
    reg = I.REGISTRY
    ions = {i["key"]: i for i in sorted(reg["ions"], key=lambda i: i["order"])}
    for k, i in ions.items():   # fit.js derives "damped" from the logN cap when the page passes no flag
        assert bool(i["damped"]) == (i["fit"]["logN_max"] > vpfit.PARAMS["damped_logN"]), k
    return reg, ions, "tngsight.ions"


def install_atomic(ions):
    """vpfit.ATOMIC gains every registry ion (in this process only) so vpfit's exact-wofz tau can be used."""
    for k, i in ions.items():
        vpfit.ATOMIC.setdefault(k, {"lam0": i["lam0_A"], "f": i["f"], "gamma": i["gamma_s"], "mass_amu": i["mass_amu"],
                                    "b_min": i["fit"]["b_min"]})


def decode_v2(blob):
    d = L.decode_web(blob)
    assert d["version"] == 2 and not d["skipped"], "TNGS v2 with registry lines expected"
    return d["vSys"], {k: {kk: ln[kk] for kk in ("n", "u0", "du", "rest", "flux")} for k, ln in d["lines"].items()}


# --------------------------------------------------------------------------------------------------------------
# Python reference fitter (design-3 section 5.3; the JS fit.js fitPanel runs the identical algorithm)
def tau_and_jac(v, p, key, want_jac):
    """tau (m,) and dtau/dp (m, 3n) for p = [v_c, logN, b] * n, exact wofz; tau equals vpfit.tau_components."""
    a = vpfit.ATOMIC[key]
    lam_cm = a["lam0"] * 1e-8
    k_tau, a0 = vpfit.SIGMA0 * a["f"] * lam_cm / (math.sqrt(math.pi) * 1e5), a["gamma"] * lam_cm / (4 * math.pi * 1e5)
    p = np.asarray(p, float).reshape(-1, 3)
    vc, logN, b = p[:, 0:1], p[:, 1:2], p[:, 2:3]
    u, aa = (v[None, :] - vc) / b, a0 / b
    w = wofz(u + 1j * aa)
    A = k_tau * 10.0 ** logN
    tau_c = A * w.real / b
    if not want_jac:
        return tau_c.sum(axis=0), None
    dw = -2.0 * (u + 1j * aa) * w + 2j / math.sqrt(math.pi)
    Hu, Ha = dw.real, -dw.imag
    jac = np.empty((v.size, p.size))
    jac[:, 0::3] = (-A * Hu / b ** 2).T
    jac[:, 1::3] = (tau_c * math.log(10)).T
    jac[:, 2::3] = (-(A / b ** 2) * (w.real + u * Hu + aa * Ha)).T
    return tau_c.sum(axis=0), jac


class Window:
    """Fit window: fine sub-grid i0..i1 of the decoded line, data pixels vd, and the sampling operator of fit.js
    makeSampler (tngsight.degrade.lsf_weights with box 0: the model is point-sampled on the fine grid)."""
    def __init__(self, line, v_sys, R, key, lo, hi, vd, d, sigma):
        du, n, u0 = line["du"], line["n"], line["u0"]
        h = DG.lsf_width(R, du, 0.0)[1] if has_lsf(R) else 0
        V0 = u0 + v_sys
        i0 = max(0, math.floor((lo - V0) / du) - h - 2)
        i1 = min(n - 1, math.ceil((hi - V0) / du) + h + 2)
        self.Vf = (u0 + np.arange(i0, i1 + 1) * du) + v_sys
        self.lsf = has_lsf(R)
        if self.lsf:
            idx, self.w, self.inside = DG.lsf_weights(vd, u0, du, n, v_sys, R, box=0.0)
            self.idx = np.clip(idx, i0, i1) - i0
        self.key, self.vd, self.d, self.sigma, self.N = key, vd, d, sigma, vd.size

    def sample(self, g, fill=1.0):
        g = np.asarray(g, float)
        if not self.lsf:
            return np.interp(self.vd, self.Vf, g, left=fill, right=fill)
        return np.where(self.inside, np.einsum("ij,ij->i", self.w, g[self.idx]), fill)

    def model(self, P, want_j=False):
        P = np.asarray(P, float)
        if P.size == 0:
            return np.ones(self.N), None
        tau, jt = tau_and_jac(self.Vf, P, self.key, want_j)
        F = np.exp(-tau)
        M = self.sample(F)
        if not want_j:
            return M, None
        J = np.stack([self.sample(-F * jt[:, c], 0.0) for c in range(P.size)])
        return M, J

    def chi2(self, M):
        return float(np.sum(((self.d - M) / self.sigma) ** 2))


def lm(W, P0, lb, ub, max_it, prm):
    P = np.array(P0, float)
    lam = prm["lambda0"]
    M, J = W.model(P, True)
    c2 = W.chi2(M)
    for _ in range(max_it):
        A = J @ J.T
        g = J @ (W.d - M)
        free = ~(((P <= lb) & (g < 0)) | ((P >= ub) & (g > 0)))    # active set: bound params pushed outward stay fixed
        Af, gf = A[np.ix_(free, free)], g[free]
        ok, rel = False, 1.0
        for _t in range(prm["maxTries"] if free.any() else 0):
            B = Af + lam * np.diag(np.maximum(np.diag(Af), 1e-12))
            try:
                dxf = np.linalg.solve(B, gf)
                if not np.all(np.isfinite(dxf)):
                    raise np.linalg.LinAlgError
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            dx = np.zeros_like(P)
            dx[free] = dxf
            Pn = np.clip(P + dx, lb, ub)
            cn = W.chi2(W.model(Pn)[0])
            if cn < c2:
                rel = (c2 - cn) / c2
                P, c2 = Pn, cn
                lam = max(lam / 10, prm["lambdaMin"])
                M, J = W.model(P, True)
                ok = True
                break
            lam *= 10
        if not ok or rel < prm["relTol"]:
            break
    return P, c2


def merge_seeds(sd, fw, frac):
    merged = True
    while merged and len(sd) > 1:
        merged = False
        for i in range(len(sd) - 1):
            p, q = sd[i], sd[i + 1]
            fe = math.sqrt(fw * fw + (1.665 * 0.5 * (p["b"] + q["b"])) ** 2)
            if q["v"] - p["v"] < frac * fe:
                N = p["N"] + q["N"]
                v = (p["N"] * p["v"] + q["N"] * q["v"]) / N
                s2 = (p["N"] * (p["b"] ** 2 / 2 + (p["v"] - v) ** 2) + q["N"] * (q["b"] ** 2 / 2 + (q["v"] - v) ** 2)) / N
                sd[i:i + 2] = [{"v": v, "N": N, "b": math.sqrt(2 * s2)}]
                merged = True
                break
    return sd


def rnd(x, d):
    return None if x is None or not math.isfinite(x) else vpfit.fmt_round(float(x), d)


def comp_flags(vc, lN, b, M, vd, w, logN_max, b_min, poor, err_ok, damped, key, prm=FIT_PARAMS):
    """The flags of one fitted component, as tngsight.vpfit sets them (vpfit's own tau_components and PARAMS):
    DAMPED for the damped ion at logN >= damped_logN; SAT when the intrinsic line-centre tau reaches sat_tau0 or the
    model drops below sat_flux within +-b; BOUND within 1e-3 of a box limit; POORFIT; NOERR without covariance or
    for SAT without DAMPED (whose dlogN and db are then null). Returns (flag, sat_noerr)."""
    P = vpfit.PARAMS
    flag = FLAGS["DAMPED"] if damped and lN >= P["damped_logN"] else 0
    s = (vd >= vc - b) & (vd <= vc + b)
    tau0 = float(vpfit.tau_components(np.array([vc]), [[vc, lN, b]], key)[0])
    if tau0 >= P["sat_tau0"] or (s.any() and float(M[s].min()) < P["sat_flux"]):
        flag |= FLAGS["SAT"]
    if (min(vc - w["lo"], w["hi"] - vc) < 1e-3 or min(lN - prm["logNMin"], logN_max - lN) < 1e-3
            or min(b - b_min, prm["bMax"] - b) < 1e-3):
        flag |= FLAGS["BOUND"]
    if poor:
        flag |= FLAGS["POORFIT"]
    sat_noerr = bool(flag & FLAGS["SAT"]) and not flag & FLAGS["DAMPED"]
    if not err_ok or sat_noerr:
        flag |= FLAGS["NOERR"]
    return flag, sat_noerr


def ref_fit(case, line, v_sys, atom, key, comp_keys, damped, prm=FIT_PARAMS):
    R, v, d, sigma = case["R"], case["v"], case["flux"], case["sigma"]
    fw = C_KMS / R
    iv, iN, ib, ir = (comp_keys.index(x) for x in ("v", "logN", "b", "region"))
    logN_max, b_min = atom["logN_max"], atom["b_min"]
    pad = prm["padResel"] * fw + prm["padKms"]
    by = {}
    for r in case["seeds"]:
        by.setdefault(r[ir], []).append(r)
    wins = sorted(({"lo": lo_ - pad, "hi": hi_ - 0 + pad, "region": g, "rows": list(by[g])}
                   for g, lo_, hi_, *_ in case["regions"] if g in by), key=lambda w: (w["lo"], w["region"]))
    mw = []
    for w in wins:
        if mw and w["lo"] <= mw[-1]["hi"]:
            mw[-1]["hi"] = max(mw[-1]["hi"], w["hi"]); mw[-1]["region"] = min(mw[-1]["region"], w["region"])
            mw[-1]["rows"] += w["rows"]
        else:
            mw.append(w)
    out = {"comps": [], "windows": [], "chi2": 0.0, "dof": 0, "npix": 0, "bic": 0.0, "nfit": 0, "chi2_scipy": 0.0}
    any_fit = False
    for w in mw:
        sel = np.nonzero((v >= w["lo"]) & (v <= w["hi"]))[0]
        if sel.size < 4:
            continue
        W = Window(line, v_sys, R, key, w["lo"], w["hi"], v[sel], d[sel], sigma)
        sd = sorted(({"v": r[iv], "N": 10 ** min(max(r[iN], prm["logNMin"]), logN_max),
                      "b": min(max(r[ib], b_min), prm["bMax"])} for r in w["rows"]), key=lambda s: s["v"])
        sd = merge_seeds(sd, fw, prm["mergeFrac"])
        P0, lb, ub = [], [], []
        for s in sd:
            P0 += [min(max(s["v"], w["lo"]), w["hi"]), min(max(math.log10(s["N"]), prm["logNMin"]), logN_max),
                   min(max(s["b"], b_min), prm["bMax"])]
            lb += [w["lo"], prm["logNMin"], b_min]; ub += [w["hi"], logN_max, prm["bMax"]]
        lb, ub = np.array(lb), np.array(ub)
        any_fit = True
        P, c2 = lm(W, P0, lb, ub, prm["maxIt"], prm); out["nfit"] += 1
        lnN, K = math.log(W.N), prm["bicK"]
        for _pass in range(prm["maxPrunePasses"]):
            nc = P.size // 3
            if nc < 2:
                break
            dch = [W.chi2(W.model(np.delete(P, slice(3 * c, 3 * c + 3)))[0]) - c2 for c in range(nc)]
            bc = int(np.argmin(dch))
            Q = np.delete(P, slice(3 * bc, 3 * bc + 3))
            Pq, cq = lm(W, Q, lb[:Q.size], ub[:Q.size], prm["maxItPrune"], prm); out["nfit"] += 1
            if cq + K * (nc - 1) * lnN <= c2 + K * nc * lnN:
                P, c2 = Pq, cq
            else:
                break
        if P.size == 3:
            c0 = float(np.sum(((W.d - 1) / sigma) ** 2))
            if c0 <= c2 + K * lnN:
                P, c2 = np.zeros(0), c0
        nc = P.size // 3
        M = W.model(P)[0]
        c2 = W.chi2(M)
        dof = W.N - 3 * nc
        out["windows"].append([w["lo"], w["hi"]]); out["chi2"] += c2; out["dof"] += dof; out["npix"] += W.N
        out["bic"] += c2 + K * nc * lnN
        if not nc:
            out["chi2_scipy"] += c2
            continue
        r = least_squares(lambda p: (W.d - W.model(p)[0]) / sigma, np.clip(P, lb[:P.size], ub[:P.size]),
                          bounds=(lb[:P.size], ub[:P.size]), method="trf", x_scale="jac")
        out["chi2_scipy"] += float(2 * r.cost)
        J = W.model(P, True)[1]
        try:
            cov = np.linalg.inv(J @ J.T / sigma ** 2)
            dg = np.diag(cov)
            err = np.sqrt(dg) if np.all(np.isfinite(dg)) and np.all(dg >= 0) else None
        except np.linalg.LinAlgError:
            err = None
        poor = c2 / max(dof, 1) > prm["chi2nuPoor"]
        for c in range(nc):
            vc, lN, b = P[3 * c:3 * c + 3]
            flag, sat_noerr = comp_flags(vc, lN, b, M, W.vd, w, logN_max, b_min, poor, err is not None, damped, key, prm)
            e = (None, None, None) if err is None else err[3 * c:3 * c + 3]
            out["comps"].append({"v": rnd(vc, 2), "dv": rnd(e[0], 2), "logN": rnd(lN, 3),
                                 "dlogN": None if sat_noerr else rnd(e[1], 3), "b": rnd(b, 2),
                                 "db": None if sat_noerr else rnd(e[2], 2), "flag": flag, "region": w["region"]})
    out["comps"].sort(key=lambda c: c["v"])
    out["status"] = "ok" if any_fit else "no_seeds"
    return out


# --------------------------------------------------------------------------------------------------------------
def b64(a, dt):
    return base64.b64encode(np.ascontiguousarray(a, dtype=dt).tobytes()).decode()


# crafted TNGS v2 blobs (Phase-3 Code 4): both decoders must accept or refuse each one identically
def _blob(lines, nlines=None, v_sys=12.5, tail=b""):
    """lines: [(key bytes (<= 8), n, u0, du, rest, number of u16 data values or None = n)]."""
    out = [struct.pack("<4sBBHd", b"TNGS", 2, len(lines) if nlines is None else nlines, 0, v_sys)]
    for kb, n, u0, du, rest, nd in lines:
        nd = n if nd is None else nd
        out.append(struct.pack("<8sIIddd", kb.ljust(8, b"\0"), n, 0, u0, du, rest))
        out.append(np.linspace(0, 65535, nd).astype("<u2").tobytes() if nd else b"")
    return b"".join(out) + tail


def tngs_cases():
    nan, inf = float("nan"), float("inf")
    ln = lambda k, n=3, u0=-1.0, du=1.0, rest=1031.912, nd=None: (k, n, u0, du, rest, nd)  # noqa: E731
    base = [ln(b"HI"), ln(b"OVI")]
    full = [ln(k.encode()) for k in I.KEYS]
    cases = [
        ("valid", _blob(base)), ("valid_all_registry_lines", _blob(full)), ("valid_any_order", _blob(base[::-1])),
        ("nlines_0", _blob([], nlines=0)), ("nlines_0_with_data", _blob(base, nlines=0)),
        ("nlines_over_registry", _blob(full + [ln(b"FeXVII")])), ("nlines_13_header_only", _blob(full, nlines=13)),
        ("nlines_255", _blob(base, nlines=255)),
        ("embedded_nul_key", _blob([ln(b"HI"), ln(b"OV\0I")])), ("leading_nul_key", _blob([ln(b"HI"), ln(b"\0OVI")])),
        ("nul_then_char_key", _blob([ln(b"HI"), ln(b"OVI\0x")])), ("non_ascii_key", _blob([ln(b"HI"), ln(b"OVI\xff")])),
        ("key_toString", _blob([ln(b"HI"), ln(b"toString")])), ("key___proto__", _blob([ln(b"HI"), ln(b"__proto_")])),
        ("key_valueOf", _blob([ln(b"valueOf"), ln(b"OVI")])), ("key_constructor", _blob([ln(b"construc"), ln(b"OVI")])),
        ("key_hasOwnProperty", _blob([ln(b"hasOwnPr"), ln(b"OVI")])),
        ("key_lowercase_ovi", _blob([ln(b"HI"), ln(b"ovi")])), ("unknown_key", _blob([ln(b"FeXVII"), ln(b"OVI")])),
        ("empty_key", _blob([ln(b""), ln(b"OVI")])),
        ("duplicate_key", _blob([ln(b"HI"), ln(b"HI")])), ("duplicate_unknown_key", _blob([ln(b"FeXVII"), ln(b"FeXVII")])),
        ("duplicate_proto_key", _blob([ln(b"toString"), ln(b"toString")])),
        ("n_0", _blob([ln(b"HI"), ln(b"OVI", n=0)])), ("n_1", _blob([ln(b"HI", n=1)])), ("n_max", _blob([ln(b"HI", n=20001)])),
        ("n_over_max", _blob([ln(b"HI", n=20002)])), ("n_0_unknown_key", _blob([ln(b"FeXVII", n=0), ln(b"OVI")])),
        ("du_0", _blob([ln(b"HI", du=0.0)])), ("du_negative", _blob([ln(b"HI", du=-1.0)])),
        ("du_nan", _blob([ln(b"HI", du=nan)])), ("du_inf", _blob([ln(b"HI", du=inf)])),
        ("u0_nan", _blob([ln(b"HI", u0=nan)])), ("u0_inf", _blob([ln(b"HI", u0=-inf)])),
        ("rest_nan", _blob([ln(b"HI", rest=nan)])), ("rest_inf", _blob([ln(b"HI", rest=inf)])),
        ("du_0_unknown_key", _blob([ln(b"FeXVII", du=0.0), ln(b"OVI")])),
        ("v_sys_nan", _blob(base, v_sys=nan)), ("v_sys_inf", _blob(base, v_sys=inf)),
        ("truncated_data", _blob(base)[:-1]), ("truncated_line_header", _blob(base)[:16 + 20]),
        ("truncated_file_header", _blob(base)[:12]),
        ("trailing_byte", _blob(base, tail=b"\0")), ("n_beyond_data", _blob([ln(b"HI", n=50, nd=3)])),
    ]
    # the outcome each case must have, written out by hand (not taken from either decoder):
    # (lines, skipped) when it decodes; every case not listed must be refused
    ok = {"valid": (["HI", "OVI"], []), "valid_all_registry_lines": (list(I.KEYS), []),
          "valid_any_order": (["OVI", "HI"], []),
          "embedded_nul_key": (["HI"], ["OV\0I"]), "leading_nul_key": (["HI"], ["\0OVI"]),
          "nul_then_char_key": (["HI"], ["OVI\0x"]), "non_ascii_key": (["HI"], ["OVI�"]),
          "key_toString": (["HI"], ["toString"]), "key___proto__": (["HI"], ["__proto_"]),
          "key_valueOf": (["OVI"], ["valueOf"]), "key_constructor": (["OVI"], ["construc"]),
          "key_hasOwnProperty": (["OVI"], ["hasOwnPr"]),
          "key_lowercase_ovi": (["HI"], ["ovi"]), "unknown_key": (["OVI"], ["FeXVII"]),
          "empty_key": (["OVI"], [""]), "n_1": (["HI"], []), "n_max": (["HI"], [])}
    out = []
    for name, blob in cases:
        exp = {"ok": True, "lines": ok[name][0], "skipped": ok[name][1]} if name in ok else {"ok": False}
        out.append({"name": name, "blob": base64.b64encode(blob).decode(), "expect": exp})
    assert set(ok) <= {n for n, _ in cases}
    return out


def write_tngs_cases(out):
    path = Path(out) / "fit_tngs_cases.json"
    path.write_text(json.dumps({"note": "crafted TNGS v2 blobs, tests/js/make_fit_fixture.py tngs_cases()",
                                "cases": tngs_cases()}, indent=0) + "\n")
    print(f"wrote {path}")


# --------------------------------------------------------------------------------------------------------------
# native 0.25 km/s fixture (Phase-3 D1)
def write_native(src, out, sid):
    p = L.load_npz(Path(src) / "sightlines" / f"{sid}.npz")
    doc = {"note": "native 0.25 km/s tau of library sightline lines, trimmed; tests/js/make_fit_fixture.py write_native()",
           "id": sid, "v_sys": float(p["v_sys"]), "trim_tau": NATIVE_TRIM_TAU, "lines": {}}
    for k in NATIVE_KEYS:
        u, t = np.asarray(p["u"][k], float), np.asarray(p["tau"][k], float)
        du = float(p["du"][k])
        s = np.nonzero(t > NATIVE_TRIM_TAU)[0]
        m = int(math.ceil(NATIVE_MARGIN_KMS / du))
        a, b = max(0, int(s[0]) - m), min(u.size - 1, int(s[-1]) + m)
        doc["lines"][k] = {"u0": float(u[a]), "du": du, "rest": float(p["rest"][k]), "n": int(b - a + 1),
                           "tau": b64(np.asarray(p["tau"][k][a:b + 1]), "<f4")}
    path = Path(out) / f"fit_native_{sid}.json"
    path.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    print(f"wrote {path} ({path.stat().st_size / 1e3:.0f} kB)")
    return path


def native_line(doc, k, pad):
    """(u, tau) of one fixture line zero-padded by `pad` km/s on both sides, on its native grid."""
    ln = doc["lines"][k]
    u0, du = ln["u0"], ln["du"]
    t = np.frombuffer(base64.b64decode(ln["tau"]), "<f4").astype(float)
    m = int(math.ceil(pad / du))
    tau = np.concatenate((np.zeros(m), t, np.zeros(m)))
    return u0 - m * du + du * np.arange(tau.size), tau


def native_model(u, tau, R, v, v_sys):
    """Native path: the exact Gaussian LSF (FWHM c/R) of the point samples exp(-tau) on u, evaluated at v."""
    sig = (C_KMS / R) * FWHM_TO_SIGMA
    du = (u[-1] - u[0]) / (u.size - 1)
    V0, F = u[0] + v_sys, np.exp(-tau)
    K = int(math.ceil(6 * sig / du))
    out = np.empty(v.size)
    for a in range(0, v.size, 256):
        vv = v[a:a + 256]
        jc = np.rint((vv - V0) / du).astype(int)
        j = np.clip(jc[:, None] + np.arange(-K, K + 1)[None, :], 0, u.size - 1)
        e2 = ((vv[:, None] - (u[j] + v_sys)) / sig) ** 2
        w = np.exp(-0.5 * (e2 - e2.min(axis=1, keepdims=True)))      # no underflow beyond the data (edge sample)
        out[a:a + 256] = (w * F[j]).sum(1) / w.sum(1)
    return out


def moments(v, D):
    s0 = float(D.sum()); mu = float((v * D).sum()) / s0
    return s0, mu, float(((v - mu) ** 2 * D).sum()) / s0


def native_cases(path):
    doc = json.loads(Path(path).read_text())
    keys, v_sys = list(doc["lines"]), float(doc["v_sys"])
    cases, bins = [], {}
    for k in keys:
        band = I.get(k)["band"]
        Rs = NATIVE_R["xray" if band == "xray" else "uv"]
        pad = 8 * (C_KMS / min(Rs)) * FWHM_TO_SIGMA + 50
        u, tau = native_line(doc, k, pad)
        W = int(math.ceil(max(abs(u[0]), abs(u[-1])))) + 1
        pay = {"lines": [k], "v_sys": v_sys, "u": {k: u}, "tau": {k: tau.astype(np.float32)}, "W": {k: W},
               "rest": {k: doc["lines"][k]["rest"]}}
        blob = L.encode_web(pay)
        bins[k] = base64.b64encode(blob).decode()
        ln = L.decode_web(blob)["lines"][k]
        s_int = moments(u, -np.expm1(-tau))
        for R in Rs:
            v, _n, web = DG.degrade_v(ln["u"], ln["flux"], R, None, v_sys, ln["du"])
            sig = (C_KMS / R) * FWHM_TO_SIGMA
            core = np.nonzero(1 - web > 1e-4)[0]
            reach = int(math.ceil(7 * sig / (v[1] - v[0])))
            a, b = max(0, int(core[0]) - reach), min(v.size - 1, int(core[-1]) + reach)
            nat = native_model(u, tau, R, v[a:b + 1], v_sys)
            cases.append({"ion": k, "band": band, "R": R, "vSys": v_sys, "n": int(v.size), "a": a, "b": b, "native": b64(nat, "<f4"),
                          "ew_int": s_int[0], "mu_int": s_int[1] + v_sys, "m2_int": s_int[2]})
    return cases, bins


def write_native_cases(out, native_path):
    cases, bins = native_cases(native_path)
    path = Path(out) / "fit_native_cases.json"
    path.write_text(json.dumps({"note": "native-path LSF reference, tests/js/make_fit_fixture.py native_cases()",
                                "native": Path(native_path).name, "bins": bins, "cases": cases}, separators=(",", ":")) + "\n")
    print(f"wrote {path} ({path.stat().st_size / 1e3:.0f} kB), {len(cases)} cases")


# --------------------------------------------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--ids", nargs=5, default=DEFAULT_IDS)
    ap.add_argument("--native-id", default=NATIVE_ID)
    ap.add_argument("--out", default=str(ROOT / "tests" / "js" / "fixtures"))
    ap.add_argument("--tngs-only", action="store_true")
    a = ap.parse_args(argv)
    write_tngs_cases(a.out)
    if a.tngs_only:
        return
    src, out = Path(a.src), Path(a.out)
    if not (src / "components.json").is_file():
        ap.error(f"{src} is not a v2 library directory (no components.json); pass --src or set TNG_FIT_SRC")
    reg, ions, reg_src = load_registry()
    install_atomic(ions)
    for k in ions:   # the reference tau is vpfit's (exact wofz) to rounding
        vt = np.linspace(-300, 300, 601)
        pt = [[-20.0, 14.0, 12.0], [35.0, 13.2, 30.0]]
        assert np.allclose(tau_and_jac(vt, pt, k, False)[0], vpfit.tau_components(vt, pt, k), rtol=1e-12, atol=0)
    degrade_v, deg_src = DG.degrade_v, "tngsight.degrade.degrade_v"
    comp = json.loads((src / "components.json").read_text())
    ids = list(a.ids)
    assert all(i in comp["entries"] for i in ids), "the 5 ids must be in the library's components.json"
    (out / "fit_bins").mkdir(parents=True, exist_ok=True)
    for old in (out / "fit_bins").glob("*.bin"):
        if old.stem not in ids:
            old.unlink()
    payloads = {}
    for sid in ids:
        shutil.copyfile(src / "web" / f"{sid}.bin", out / "fit_bins" / f"{sid}.bin")
        payloads[sid] = decode_v2((src / "web" / f"{sid}.bin").read_bytes())
    for old in out.glob("fit_native_*_*.json"):
        if old.name != f"fit_native_{a.native_id}.json":
            old.unlink()
    write_native_cases(out, write_native(src, out, a.native_id))

    # (a) Faddeeva points
    rs = np.random.default_rng(20261014)
    aa = 10 ** rs.uniform(-7, 0, 120); aa[:4] = [1e-7, 1e-3, 0.2, 1.0]
    uu = np.concatenate([[0.0, 5.0, 10.0], rs.uniform(0, 10, 57), [10.0 + 1e-6, 1e5], 10 ** rs.uniform(1, 5, 58)])
    w = wofz(uu + 1j * aa)
    voigt = [[float(u), float(x), float(z.real), float(z.imag)] for u, x, z in zip(uu, aa, w)]

    # (b) degrade cases: every band at its R range ends and default, plus no LSF; 3 S/N
    B = reg["bands"]
    rconf = [("uv", B["uv"]["R"]["min"]), ("uv", B["uv"]["R"]["default"]), ("uv", B["uv"]["R"]["max"]),
             ("euv", B["euv"]["R"]["default"]), ("xray", B["xray"]["R"]["min"]), ("xray", B["xray"]["R"]["default"]),
             ("xray", B["xray"]["R"]["max"]), ("uv", None)]
    band_ions = {b: [k for k, i in ions.items() if i["band"] == b] for b in B}
    degrade = []
    for ci, (band, R) in enumerate(rconf):
        for si, snr in enumerate((5, 20, 100)):
            sid = ids[(ci + si) % len(ids)]
            key = band_ions[band][(ci * 3 + si) % len(band_ions[band])]
            v_sys, Ls = payloads[sid]
            ln = Ls[key]
            u = ln["u0"] + ln["du"] * np.arange(ln["n"])
            vwin = None if (R is None or R <= 30000) and si != 1 else 250.0
            vcenter = 0.0 if vwin is None else 17.5 * (si - 1)
            vv, _noisy, model = degrade_v(u, ln["flux"], R, snr, v_sys, ln["du"], PIX, 1, vwin, vcenter)
            degrade.append({"id": sid, "ion": key, "band": band, "R": R, "snr": snr, "vwin": vwin, "vcenter": vcenter,
                            "n": int(vv.size), "v": b64(vv, "<f8"), "model": b64(model, "<f8")})

    # (c) fit cases
    fits = []
    keys = list(ions)
    for si, sid in enumerate(ids):
        v_sys, Ls = payloads[sid]
        for ii, key in enumerate(keys):
            ion = ions[key]
            R, snr = CASES[ion["band"]][(si + ii) % 4]
            seed = 1000 + si * 12 + ii
            ln = Ls[key]
            u = ln["u0"] + ln["du"] * np.arange(ln["n"])
            vv, noisy, _m = degrade_v(u, ln["flux"], R, snr, v_sys, ln["du"], PIX, seed, None, 0.0)
            V0, dvp = u + v_sys, (C_KMS / R) / PIX     # data grid = numpy arange(V0[0], V0[-1] + dvp, dvp)
            assert np.array_equal(vv, np.arange(float(vv[0]), float(V0[-1]) + dvp, dvp))
            noisy32 = noisy.astype("<f4")
            # the atom the page passes (app.js); fit.js derives "damped" from logN_max (checked in load_registry)
            atom = {"lam0_A": ion["lam0_A"], "f": ion["f"], "gamma_s": ion["gamma_s"], "b_min": ion["fit"]["b_min"],
                    "logN_max": ion["fit"]["logN_max"]}
            seeds = comp["entries"][sid].get(key, [])
            regions = comp["aod"][sid].get(key, [None, []])[1]
            case = {"R": R, "v": vv, "flux": noisy32.astype(float), "sigma": math.sqrt(PIX) / snr, "seeds": seeds,
                    "regions": regions}
            exp = ref_fit(case, ln, v_sys, atom, key, comp["comp_keys"], bool(ion["damped"]))
            fits.append({"id": sid, "ion": key, "R": R, "snr": snr, "seed": seed, "vSys": v_sys, "atom": atom,
                         "n": int(vv.size), "v_arange": [float(vv[0]), float(V0[-1]) + dvp, dvp], "flux": b64(noisy32, "<f4"), "sigma": case["sigma"],
                         "seeds": seeds, "regions": regions, "expected": exp})
            print(f"{sid:28s} {key:7s} R={R:<6} S/N={snr:<3} seeds={len(seeds):2d} -> n={len(exp['comps']):2d} "
                  f"chi2={exp['chi2']:.1f}/{exp['dof']} scipy={exp['chi2_scipy']:.1f} "
                  f"flags={[c['flag'] for c in exp['comps']]}")

    doc = {"meta": {"fit_params": FIT_PARAMS, "registry": reg_src, "degrade": deg_src, "numpy": np.__version__,
                    "pix_per_resel": PIX, "comp_keys": comp["comp_keys"], "ids": ids, "src": src.name,
                    "params_tag": comp.get("params_tag"), "fitter": comp.get("fitter"),
                    "sat": {k: vpfit.PARAMS[k] for k in ("sat_tau0", "sat_flux", "damped_logN")}},
           "ions": {k: {"band": i["band"], "lam0_A": i["lam0_A"], "f": i["f"], "gamma_s": i["gamma_s"],
                        "b_min": i["fit"]["b_min"], "logN_max": i["fit"]["logN_max"], "damped": bool(i["damped"])}
                    for k, i in ions.items()},
           "bands": B, "voigt": voigt, "degrade": degrade, "fits": fits}
    path = out / "fit_cases.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, separators=(",", ":")))
    os.replace(tmp, path)
    print(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB), {len(voigt)} voigt, {len(degrade)} degrade, {len(fits)} fit cases")


if __name__ == "__main__":
    main()
