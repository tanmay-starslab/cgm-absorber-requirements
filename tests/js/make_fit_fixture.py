"""Build the JS fitter fixture tests/js/fixtures/fit_cases.json and copy the sample bins to tests/js/fixtures/fit_bins/.

Design-3 section 5.6. The fixture holds
  (a) 120 Faddeeva check points (a in [1e-7, 1], u in [0, 1e5]) with scipy.special.wofz values,
  (b) 24 degrade cases (every band, R at the range ends and the default, no-LSF, 3 S/N) with the noiseless model of
      tngsight.degrade.degrade_v when it exists, else of this file's port of design-3 section 3.4,
  (c) 60 fit cases (5 sightlines x 12 ions, one (R, S/N) case each from the 4-case set) with noisy data drawn by
      numpy and the result of the Python reference fitter below (a line-by-line numpy port of design-3 section 5.3:
      same windows, seed merge, LM, Delta-BIC pruning and flags), plus the chi^2 that
      scipy.optimize.least_squares(method="trf") reaches from the reference's final component set.

Usage:  python tests/js/make_fit_fixture.py [--src DIR] [--out tests/js/fixtures]
  --src  directory with <id>.bin (TNGS v2) and components_v2.json (default: the architect's sample_v2 scratch set;
         after the library regeneration, a directory holding the same 5 ids from library_v3).
"""
from __future__ import annotations
import argparse, base64, json, math, os, shutil, struct, sys
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares
from scipy.special import erf, wofz

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tngsight import vpfit  # noqa: E402

DEFAULT_SRC = os.environ.get("TNG_FIT_SRC", "")   # a library dir (web/*.bin + components.json)
DRAFT_REGISTRY = os.environ.get("TNG_FIT_REGISTRY", "")
C_KMS = 299792.458
FWHM_TO_SIGMA = 1 / 2.35482
PIX = 5
FIT_PARAMS = dict(maxIt=40, maxItPrune=20, maxTries=8, lambda0=1e-2, lambdaMin=1e-7, relTol=1e-5, padResel=2, padKms=10,
                  mergeFrac=0.5, bMax=300, logNMin=10, bicK=3, maxPrunePasses=30, chi2nuPoor=2.0)
FLAGS = {"SAT": 1, "BOUND": 2, "POORFIT": 8}
CASES = {"uv": [(15000, 20), (50000, 20), (15000, 5), (50000, 5)],
         "xray": [(300, 20), (3000, 20), (300, 5), (3000, 5)]}
CASES["euv"] = CASES["uv"]


# --------------------------------------------------------------------------------------------------------------
# registry (tngsight.ions once it exists; else the repo's ions.json; else the architect's draft, which equals it)
def load_registry():
    try:
        from tngsight import ions as I  # type: ignore
        reg, src = I.REGISTRY, "tngsight.ions"
    except Exception:
        p = ROOT / "tngsight" / "ions.json"
        if not p.exists():
            p = Path(DRAFT_REGISTRY)
        reg, src = json.loads(p.read_text()), str(p.name)
    ions = {i["key"]: i for i in sorted(reg["ions"], key=lambda i: i["order"])}
    return reg, ions, src


def install_atomic(ions):
    """vpfit.ATOMIC gains every registry ion (in this process only) so vpfit's exact-wofz tau can be used."""
    for k, i in ions.items():
        vpfit.ATOMIC.setdefault(k, {"lam0": i["lam0_A"], "f": i["f"], "gamma": i["gamma_s"], "mass_amu": i["mass_amu"],
                                    "b_min": i["fit"]["b_min"]})


# --------------------------------------------------------------------------------------------------------------
def decode_v2(blob):
    assert blob[:4] == b"TNGS" and blob[4] == 2, "TNGS v2 expected"
    nl, v_sys = blob[5], struct.unpack_from("<d", blob, 8)[0]
    o, lines = 16, {}
    for _ in range(nl):
        k = blob[o:o + 8].rstrip(b"\0").decode()
        n, _r, u0, du, rest = struct.unpack_from("<IIddd", blob, o + 8)
        q = np.frombuffer(blob, "<u2", n, o + 40)
        lines[k] = {"n": n, "u0": u0, "du": du, "rest": rest, "flux": q.astype(float) / 65535}
        o += 40 + 2 * n
    assert o == len(blob)
    return v_sys, lines


def lsf_kernel(R, du):
    if not (R and math.isfinite(R) and R > 0):
        return np.ones(1)
    sp = (C_KMS / R) * FWHM_TO_SIGMA / du
    h = max(1, math.ceil(4 * sp))
    j = np.arange(-h, h + 1, dtype=float)
    k = 0.5 * (erf((j + 0.5) / (math.sqrt(2) * sp)) - erf((j - 0.5) / (math.sqrt(2) * sp)))
    return k / k.sum()


def conv_extend(f, k):
    h = (k.size - 1) // 2
    return np.convolve(np.pad(f, h, mode="edge"), k, mode="valid") if h else f.copy()


def degrade_v_port(u, flux, R, snr, v_sys, du, pix_per_resel=PIX, seed=None, vwin=None, vcenter=0.0):
    """design-3 section 3.4 degrade_v (used when tngsight.degrade.degrade_v is not importable)."""
    lsf = bool(R and math.isfinite(R) and R > 0)
    F = conv_extend(np.asarray(flux, float), lsf_kernel(R, du)) if lsf else np.asarray(flux, float)
    dv_pix = (C_KMS / R) / pix_per_resel if lsf else du * pix_per_resel
    V = np.asarray(u, float) + v_sys
    lo, hi = (vcenter - vwin, vcenter + vwin) if vwin is not None else (V[0], V[-1])
    v = np.arange(lo, hi + dv_pix, dv_pix)
    model = np.interp(v, V, F, left=1.0, right=1.0)
    if snr and snr > 0:
        noisy = np.clip(model + np.random.default_rng(seed).normal(0.0, math.sqrt(pix_per_resel) / snr, v.size), 0, None)
    else:
        noisy = model.copy()
    return v, noisy, model


def get_degrade():
    try:
        from tngsight.degrade import degrade_v  # type: ignore
        return degrade_v, "tngsight.degrade.degrade_v"
    except Exception:
        return degrade_v_port, "make_fit_fixture.degrade_v_port"


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
    def __init__(self, line, v_sys, k, key, lo, hi, vd, d, sigma):
        h = (k.size - 1) // 2
        V0 = line["u0"] + v_sys
        i0 = max(0, math.floor((lo - V0) / line["du"]) - h - 2)
        i1 = min(line["n"] - 1, math.ceil((hi - V0) / line["du"]) + h + 2)
        self.Vf = (line["u0"] + np.arange(i0, i1 + 1) * line["du"]) + v_sys
        self.k, self.key, self.vd, self.d, self.sigma, self.N = k, key, vd, d, sigma, vd.size

    def sample(self, g):
        return np.interp(self.vd, self.Vf, conv_extend(g, self.k))

    def model(self, P, want_j=False):
        P = np.asarray(P, float)
        if P.size == 0:
            return np.ones(self.N), None
        tau, jt = tau_and_jac(self.Vf, P, self.key, want_j)
        F = np.exp(-tau)
        M = self.sample(F)
        if not want_j:
            return M, None
        J = np.stack([np.interp(self.vd, self.Vf, conv_extend(-F * jt[:, c], self.k)) for c in range(P.size)])
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


def ref_fit(case, line, v_sys, atom, key, comp_keys, prm=FIT_PARAMS):
    R, v, d, sigma = case["R"], case["v"], case["flux"], case["sigma"]
    k = lsf_kernel(R, line["du"])
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
        W = Window(line, v_sys, k, key, w["lo"], w["hi"], v[sel], d[sel], sigma)
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
            flag = 0
            s = (W.vd >= vc - b) & (W.vd <= vc + b)
            if s.any() and float(M[s].min()) < 0.05:
                flag |= FLAGS["SAT"]
            if (min(vc - w["lo"], w["hi"] - vc) < 1e-3 or min(lN - prm["logNMin"], logN_max - lN) < 1e-3
                    or min(b - b_min, prm["bMax"] - b) < 1e-3):
                flag |= FLAGS["BOUND"]
            if poor:
                flag |= FLAGS["POORFIT"]
            e = (None, None, None) if err is None else err[3 * c:3 * c + 3]
            out["comps"].append({"v": rnd(vc, 2), "dv": rnd(e[0], 2), "logN": rnd(lN, 3), "dlogN": rnd(e[1], 3),
                                 "b": rnd(b, 2), "db": rnd(e[2], 2), "flag": flag, "region": w["region"]})
    out["comps"].sort(key=lambda c: c["v"])
    out["status"] = "ok" if any_fit else "no_seeds"
    return out


# --------------------------------------------------------------------------------------------------------------
def b64(a, dt):
    return base64.b64encode(np.ascontiguousarray(a, dtype=dt).tobytes()).decode()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out", default=str(ROOT / "tests" / "js" / "fixtures"))
    a = ap.parse_args(argv)
    src, out = Path(a.src), Path(a.out)
    reg, ions, reg_src = load_registry()
    install_atomic(ions)
    for k in ions:   # the reference tau is vpfit's (exact wofz) to rounding
        vt = np.linspace(-300, 300, 601)
        pt = [[-20.0, 14.0, 12.0], [35.0, 13.2, 30.0]]
        assert np.allclose(tau_and_jac(vt, pt, k, False)[0], vpfit.tau_components(vt, pt, k), rtol=1e-12, atol=0)
    degrade_v, deg_src = get_degrade()
    comp = json.loads((src / "components_v2.json").read_text())
    ids = sorted(comp["entries"])[:5]
    (out / "fit_bins").mkdir(parents=True, exist_ok=True)
    payloads = {}
    for sid in ids:
        shutil.copyfile(src / f"{sid}.bin", out / "fit_bins" / f"{sid}.bin")
        payloads[sid] = decode_v2((src / f"{sid}.bin").read_bytes())

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
            v_sys, L = payloads[sid]
            ln = L[key]
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
        v_sys, L = payloads[sid]
        for ii, key in enumerate(keys):
            ion = ions[key]
            R, snr = CASES[ion["band"]][(si + ii) % 4]
            seed = 1000 + si * 12 + ii
            ln = L[key]
            u = ln["u0"] + ln["du"] * np.arange(ln["n"])
            vv, noisy, _m = degrade_v(u, ln["flux"], R, snr, v_sys, ln["du"], PIX, seed, None, 0.0)
            V0, dvp = u + v_sys, (C_KMS / R) / PIX     # data grid = numpy arange(V0[0], V0[-1] + dvp, dvp)
            assert np.array_equal(vv, np.arange(float(vv[0]), float(V0[-1]) + dvp, dvp))
            noisy32 = noisy.astype("<f4")
            atom = {"lam0_A": ion["lam0_A"], "f": ion["f"], "gamma_s": ion["gamma_s"], "b_min": ion["fit"]["b_min"],
                    "logN_max": ion["fit"]["logN_max"]}
            seeds = comp["entries"][sid].get(key, [])
            regions = comp["aod"][sid].get(key, [None, []])[1]
            case = {"R": R, "v": vv, "flux": noisy32.astype(float), "sigma": math.sqrt(PIX) / snr, "seeds": seeds,
                    "regions": regions}
            exp = ref_fit(case, ln, v_sys, atom, key, comp["comp_keys"])
            fits.append({"id": sid, "ion": key, "R": R, "snr": snr, "seed": seed, "vSys": v_sys, "atom": atom,
                         "n": int(vv.size), "v_arange": [float(vv[0]), float(V0[-1]) + dvp, dvp], "flux": b64(noisy32, "<f4"), "sigma": case["sigma"],
                         "seeds": seeds, "regions": regions, "expected": exp})
            print(f"{sid:28s} {key:7s} R={R:<6} S/N={snr:<3} seeds={len(seeds):2d} -> n={len(exp['comps']):2d} "
                  f"chi2={exp['chi2']:.1f}/{exp['dof']} scipy={exp['chi2_scipy']:.1f}")

    doc = {"meta": {"fit_params": FIT_PARAMS, "registry": reg_src, "degrade": deg_src, "numpy": np.__version__,
                    "pix_per_resel": PIX, "comp_keys": comp["comp_keys"], "ids": ids,
                    "src": "sample_v2" if str(src) == DEFAULT_SRC else src.name},
           "ions": {k: {"band": i["band"], "lam0_A": i["lam0_A"], "f": i["f"], "gamma_s": i["gamma_s"],
                        "b_min": i["fit"]["b_min"], "logN_max": i["fit"]["logN_max"]} for k, i in ions.items()},
           "bands": B, "voigt": voigt, "degrade": degrade, "fits": fits}
    path = out / "fit_cases.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, separators=(",", ":")))
    os.replace(tmp, path)
    print(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB), {len(voigt)} voigt, {len(degrade)} degrade, {len(fits)} fit cases")


if __name__ == "__main__":
    main()
