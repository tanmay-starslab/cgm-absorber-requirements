#!/usr/bin/env python3
"""Reference vectors for tests/js/degrade_parity.mjs: the Python noiseless degrade model on web-binary inputs.

Uses tngsight.degrade / tngsight.library when importable; otherwise a self-contained copy of the design.md §3/§4
contract (astropy Gaussian1DKernel + convolve(boundary='extend'), numpy arange/interp), flagged in meta["impl"].
Inputs are synthetic multi-component spectra on the generation grid, plus optional real npz files (--npz, read-only).
Writes one JSON file (a few MB; keep it out of the repo)."""
from __future__ import annotations
import argparse, base64, json, struct, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
C_KMS, DLAMBDA, PIX, FW2SIG, VSYS_SIGN = 299792.458, 0.002, 5, 1.0 / 2.35482, +1
KEYS = ("OVI", "HILyb", "CIII")
REST = {"OVI": 1031.912, "HILyb": 1025.7222, "CIII": 977.02}

try:                                   # the real package (unit A) if it exists
    from tngsight import degrade as _tdeg, library as _tlib, config as _tcfg
    IMPL = "tngsight"
except Exception as exc:               # noqa: BLE001 - any import failure means "use the contract copy"
    _tdeg = _tlib = _tcfg = None
    IMPL = f"fallback ({type(exc).__name__}: {exc})"


def grid_params(rest, dlam=DLAMBDA, vwin=1500.0):
    """generation §1.7: lo/hi rounded to the dλ lattice, n samples, float64 linspace -> float32."""
    lo = round(rest * (1 - vwin / C_KMS) / dlam) * dlam
    hi = round(rest * (1 + vwin / C_KMS) / dlam) * dlam
    return lo, hi, int(round((hi - lo) / dlam + 1))


def wavelength_grid(key):
    if _tlib is not None:
        return _tlib.wavelength_grid(key)
    lo, hi, n = grid_params(REST[key])
    return np.linspace(lo, hi, n).astype(np.float32)


def degrade_model(lam, tau, rest, R, v_sys, dlam, vwin):
    if _tdeg is not None:
        return _tdeg.degrade(lam, tau, rest, R, None, v_sys, dlam=dlam, vwin=vwin)[::2]
    from astropy.convolution import Gaussian1DKernel, convolve
    lam = np.asarray(lam, float); flux_hi = np.exp(-np.asarray(tau, float))
    if R is None or not (R > 0) or not np.isfinite(R):
        flux_lsf = flux_hi
        dv_resel = float(np.median(np.abs(np.diff(C_KMS * (lam / rest - 1))))) * PIX
    else:
        sig = (rest / R) * FW2SIG / dlam
        flux_lsf = convolve(flux_hi, Gaussian1DKernel(max(sig, 1e-3)), boundary="extend", normalize_kernel=True)
        dv_resel = C_KMS / R
    dv_pix = dv_resel / PIX
    v_hi = C_KMS * (lam / rest - 1.0) + VSYS_SIGN * v_sys
    vlo, vhi = (v_hi.min(), v_hi.max()) if vwin is None else (-vwin, vwin)
    v = np.arange(vlo, vhi + dv_pix, dv_pix)
    return v, np.clip(np.interp(v, v_hi, flux_lsf, left=1.0, right=1.0), 0.0, None)


def encode_web(lines):
    """design §4 web binary; `lines` = {key: (q uint16 array, rest)} on the generation grid."""
    if _tlib is not None and hasattr(_tlib, "encode_web"):
        return None                     # encoded by the caller from a payload (see build_payload)
    out = [b"TNGS", struct.pack("<BBH", 1, len(KEYS), 0)]
    for k in KEYS:
        q, rest = lines[k]; lo, hi, n = grid_params(REST[k])
        assert q.size == n
        out += [struct.pack("<Idddd", n, lo, (hi - lo) / (n - 1), rest, DLAMBDA), q.astype("<u2").tobytes()]
    return b"".join(out)


def synth_tau(key, v_sys, seed):
    """multi-component Gaussian optical depth incl. saturated, narrow and edge components."""
    rng = np.random.default_rng(seed)
    lam = wavelength_grid(key).astype(float); v = C_KMS * (lam / REST[key] - 1.0) + v_sys
    comps = [(-160, 18, 0.4), (-70, 9, 2.5), (5, 25, 30.0), (40, 4, 0.9), (115, 12, 3000.0), (210, 2.0, 1.2), (1420, 15, 0.7)]
    tau = np.zeros_like(v)
    for vc, b, t0 in comps:
        tau += t0 * rng.uniform(0.6, 1.4) * np.exp(-((v - vc - rng.normal(0, 8)) / b) ** 2)
    return tau.astype(np.float32)


def quantize(tau):
    q = np.round(np.exp(-np.asarray(tau, float)) * 65535).astype(np.uint16)
    with np.errstate(divide="ignore"):
        tau_q = -np.log(q / 65535.0)    # exp(-tau_q) == q/65535 (q = 0 -> inf -> flux 0)
    return q, tau_q


def build_payload(name, v_sys, taus):
    q = {}; tq = {}
    for k in KEYS:
        q[k], tq[k] = quantize(taus[k])
    if _tlib is not None and hasattr(_tlib, "encode_web"):
        lam = {k: wavelength_grid(k) for k in KEYS}
        payload = {"id": "edge_b100_a090", "geom": {}, "v_sys": v_sys, "logN": {k: 14.0 for k in KEYS},
                   "lam": lam, "tau": {k: tq[k].astype(np.float32) for k in KEYS}, "rest": dict(REST)}
        blob = _tlib.encode_web(payload)
    else:
        blob = encode_web({k: (q[k], REST[k]) for k in KEYS})
    return dict(name=name, v_sys=v_sys, bin_b64=base64.b64encode(blob).decode(),
                q={k: base64.b64encode(q[k].astype("<u2").tobytes()).decode() for k in KEYS}), tq


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--npz", nargs="*", default=[], help="real sightline npz files (read-only) to add as payloads")
    a = ap.parse_args()
    from astropy.convolution import Gaussian1DKernel
    import astropy
    ref = dict(meta=dict(impl=IMPL, numpy=np.__version__, astropy=astropy.__version__, C_KMS=C_KMS, DLAMBDA=DLAMBDA),
               grid={k: [float(x) for x in wavelength_grid(k)] for k in KEYS}, payloads=[], cases=[], kernels=[], aranges=[], npz_direct=[])
    sources = [("synthA", -77.83367073425268, {k: synth_tau(k, -77.83, 1 + i) for i, k in enumerate(KEYS)}),
               ("synthB", 128.15, {k: synth_tau(k, 128.15, 11 + i) for i, k in enumerate(KEYS)})]
    for p in a.npz:
        d = np.load(p, allow_pickle=False)
        for k in KEYS:
            if not np.array_equal(d[f"{k}_lambda"], wavelength_grid(k)):
                sys.exit(f"{p}: {k} grid differs from wavelength_grid")
        sources.append((Path(p).stem, float(d["v_sys"]), {k: d[f"{k}_tau"] for k in KEYS}))
    cases = [(R, vw, DLAMBDA) for R in (20000, 30000, 40000, 100000) for vw in (400.0, 150.0, None)]
    cases += [(None, 400.0, DLAMBDA), (40000, 800.0, 0.001953125), (2000, 350.0, DLAMBDA)]
    for ip, (name, vs, taus) in enumerate(sources):
        pl, tq = build_payload(name, vs, taus); ref["payloads"].append(pl)
        for k in KEYS:
            lam = wavelength_grid(k)
            for R, vw, dl in cases:
                v, m = degrade_model(lam, tq[k], REST[k], R, vs, dl, vw)
                ref["cases"].append(dict(payload=ip, key=k, R=R, vwin=vw, dlam=dl, v=v.tolist(), model=m.tolist()))
            if ip >= 2:                     # unquantized npz tau: measures the u16 quantization, not the port
                v, m = degrade_model(lam, taus[k], REST[k], 40000, vs, DLAMBDA, 400.0)
                ref["npz_direct"].append(dict(payload=ip, key=k, R=40000, vwin=400.0, dlam=DLAMBDA, v=v.tolist(), model=m.tolist()))
    for s in (1e-3, 0.3, 0.5, 2.0599, 5.4065, 10.955, 12.5, 11.2182):
        ref["kernels"].append(dict(sigma=s, k=Gaussian1DKernel(max(s, 1e-3)).array.tolist()))
    for st, sp, dv in ((-400.0, 400.0, 1.49896229), (-150.0, 150.0, 2.99792458), (-1422.37, 1578.11, 0.599584916), (-800.0, 800.0, 0.2997924580)):
        ref["aranges"].append(dict(start=st, stop=sp + dv, step=dv, v=np.arange(st, sp + dv, dv).tolist()))
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(ref, separators=(",", ":")))
    print(f"wrote {a.out} ({a.out.stat().st_size / 1e6:.1f} MB): {len(ref['cases'])} cases, impl={IMPL}")


if __name__ == "__main__":
    main()
