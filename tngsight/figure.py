"""Publication figure for one sightline (successor of make_publication_figure.build_figure), registry-driven.

Rows = the requested ions in registry order (default the registry DEFAULTS["ions"] present in the payload, at most
6); columns = instrument cases, each {"R": {band: R}, "snr": S/N} (R is taken from the ion's band). The default
cases are the 2x2 R x S/N grid of the band `pair`s and S/N pair, in the page's column order (R0,s0), (R1,s0),
(R0,s1), (R1,s1). Each panel is degrade_v of the 1 km/s web flux (the page's data) at that R and S/N in the frame
V = u + v_sys, over the window [vc − vhw, vc + vhw]. Colours and labels come from the registry (tngsight.style).
Uses matplotlib.figure.Figure directly (no pyplot state) and a local rc_context: safe to call repeatedly in a
server. The v1 keywords (R_lo, R_hi, sn_hi, sn_lo, vwin) still work for one release and set the UV band.
"""
from __future__ import annotations
import io
import json
import math
import numpy as np
import matplotlib
from matplotlib.figure import Figure
from . import ions as I
from .config import C_KMS, FWHM_TO_SIGMA
from .degrade import degrade_v
from . import style as CS

VWIN = 400.0
MAX_ROWS = 6
LAYOUTS = ("1", "2R", "2SN", "4")
LSF_EDGE_SIGMAS = 4.0      # LSF edge pixels use the edge value: keep this many σ_LSF clear of the grid edge


def as_payload(data) -> dict:
    """Accept a load_npz() payload, or a raw npz mapping / np.load result (v1 or v2), or an npz path."""
    if isinstance(data, dict) and "tau" in data and "lines" in data:
        return data
    from .library import load_npz
    if hasattr(data, "files"):                          # an np.load() NpzFile
        data = {k: data[k] for k in data.files}
    if isinstance(data, dict):
        import tempfile
        with tempfile.TemporaryFile() as fh:
            np.savez(fh, **{k: (np.asarray(json.dumps(v)) if k == "geom" and isinstance(v, dict) else v)
                            for k, v in data.items()})
            fh.seek(0)
            return load_npz(fh, id=data.get("id") if isinstance(data.get("id"), str) else None)
    return load_npz(data)


def _band_pair(b) -> list:
    return list(I.BANDS[b]["R"]["pair"])


def cases_for(layout="4", R=None, sn=None) -> list:
    """Column cases of a layout (design §6.3): R = {band: [r0, r1]} (missing bands: registry pair), sn = [s0, s1]."""
    if layout not in LAYOUTS:
        raise ValueError(f"layout must be one of {', '.join(LAYOUTS)}, got {layout!r}")
    Rb = {b: list((R or {}).get(b) or _band_pair(b)) for b in I.BANDS}
    for b, v in Rb.items():
        if len(v) == 1:
            Rb[b] = [v[0], v[0]]
    s = list(sn or I.SNR["pair"])
    if len(s) == 1:
        s = [s[0], s[0]]
    idx = {"1": [(0, 0)], "2R": [(0, 0), (1, 0)], "2SN": [(0, 0), (0, 1)],
           "4": [(0, 0), (1, 0), (0, 1), (1, 1)]}[layout]
    return [{"R": {b: Rb[b][ri] for b in Rb}, "snr": s[si]} for ri, si in idx]


def default_ions(payload) -> list:
    keys = [k for k in I.DEFAULTS["ions"] if k in payload["lines"]]
    return keys or list(payload["lines"])[:MAX_ROWS]


def _check_ions(payload, ions) -> list:
    ions = default_ions(payload) if ions is None else list(ions)
    for k in ions:
        I.get(k)
        if k not in payload["lines"]:
            raise ValueError(f"ion {k!r} is not in this sightline (lines: {', '.join(payload['lines'])})")
    if not ions or len(ions) > MAX_ROWS or len(set(ions)) != len(ions):
        raise ValueError(f"ions: 1 to {MAX_ROWS} unique registry keys")
    return [k for k in I.KEYS if k in ions]


def _coverage(payload, key, R_min=None) -> tuple:
    """[lo, hi] of V covered by computed data for `key`, minus the LSF edge reserve when it leaves ≥ half."""
    u = np.asarray(payload["u"][key], float)
    lo, hi = float(u[0] + payload["v_sys"]), float(u[-1] + payload["v_sys"])
    if R_min:
        e = LSF_EDGE_SIGMAS * (C_KMS / float(R_min)) * FWHM_TO_SIGMA
        if hi - lo - 2 * e >= 0.5 * (hi - lo):
            lo, hi = lo + e, hi - e
    return lo, hi


def max_vwin(payload, R_min=None, ions=None) -> float:
    """Largest symmetric |V| window covered by computed data for every (shown) line; with R_min the LSF edge
    reserve (LSF_EDGE_SIGMAS·σ_LSF) is kept clear as well."""
    p = as_payload(payload)
    keys = p["lines"] if ions is None else ions
    return float(min(min(-lo, hi) for lo, hi in (_coverage(p, k, R_min) for k in keys)))


def clamp_window(payload, ions, cases, vc=0.0, vhw=VWIN) -> tuple:
    """(vc, vhw) moved/shrunk so the window lies inside every shown row's covered range."""
    vc, vhw = float(vc), float(vhw)
    if not (math.isfinite(vhw) and vhw > 0 and math.isfinite(vc)):
        raise ValueError(f"vhw must be a positive finite number and vc finite, got vhw={vhw!r} vc={vc!r}")
    lo, hi = -math.inf, math.inf
    for k in ions:
        b = I.get(k)["band"]
        r_min = min(c["R"][b] for c in cases if c["R"].get(b)) if any(c["R"].get(b) for c in cases) else None
        a, z = _coverage(payload, k, r_min)
        lo, hi = max(lo, a), min(hi, z)
    vhw = min(vhw, 0.5 * (hi - lo))
    vc = min(max(vc, lo + vhw), hi - vhw)
    return vc, vhw


def _fmt_R(R) -> str:
    return f"{int(R):,}"


def _build(p, ions, cases, vc, vhw, intrinsic, seed):
    from .library import web_flux
    rcp = matplotlib.rcParams
    nr, nc = len(ions), len(cases)
    v_sys = float(p["v_sys"])
    fig = Figure(figsize=(4.75 * nc, 0.6 + 3.33 * nr))
    ax = fig.subplots(nr, nc, sharex=True, sharey=True, squeeze=False)
    for r, key in enumerate(ions):
        u, F = web_flux(p, key)
        col = CS.ION[key]["color"]
        band = I.get(key)["band"]
        if intrinsic:
            V = u + v_sys
            m = (V >= vc - vhw) & (V <= vc + vhw)
            v_hi, f_hi = V[m], F[m]
        for c, case in enumerate(cases):
            a = ax[r][c]
            R, SN = case["R"][band], case["snr"]
            v, flux, model = degrade_v(u, F, R, SN, v_sys, 1.0, seed=seed + 17 * c + 101 * r, vwin=vhw, vcenter=vc)
            a.step(v, flux, where="mid", color=col, lw=0.9, alpha=0.5, zorder=2)
            a.fill_between(v, model, 1.0, where=(model < 1.0), color=col, alpha=0.22, lw=0, zorder=1)
            if intrinsic:
                a.plot(v_hi, f_hi, color="0.45", lw=1.2, alpha=0.9, zorder=2.4)
            a.plot(v, model, color=col, lw=2.6, solid_joinstyle="round", zorder=3)
            a.axhline(1.0, color="0.55", ls="--", lw=1.0, zorder=1)
            if vc - vhw <= 0.0 <= vc + vhw:
                a.axvline(0.0, color="0.4", ls=":", lw=1.1, zorder=1)
            a.set_xlim(vc - vhw, vc + vhw); a.set_ylim(-0.08, 1.32)
            a.text(0.97, 0.07, rf"$R$ = {_fmt_R(R)}", transform=a.transAxes, ha="right", va="bottom",
                   fontsize=rcp["xtick.labelsize"], color="0.25")
            if r == 0:
                a.set_title(f"S/N = {SN}", fontsize=rcp["axes.titlesize"], pad=8)
        ax[r][0].text(0.035, 0.09, CS.ION[key]["label"], transform=ax[r][0].transAxes,
                      color=col, ha="left", va="bottom", fontsize=rcp["axes.labelsize"],
                      bbox=dict(boxstyle="round,pad=0.3", fc="white", ec=col, lw=1.4, alpha=0.95))
    for c in range(nc):
        ax[nr - 1][c].set_xlabel(r"$V_{\rm LOS}-V_{\rm sys}\ \ [\mathrm{km\,s^{-1}}]$")
    for r in range(nr):
        ax[r][0].set_ylabel(r"normalized flux")
    fig.tight_layout(w_pad=0.6, h_pad=0.6)
    return fig


def render(payload, ions=None, cases=None, vc=0.0, vhw=VWIN, intrinsic=False, seed=0, usetex=False) -> Figure:
    """The figure for `ions` (rows) x `cases` (columns); see the module doc. The window is clamped to the data."""
    p = as_payload(payload)
    ions = _check_ions(p, ions)
    cases = cases_for("4") if cases is None else [
        {"R": {b: (c["R"].get(b) if isinstance(c["R"], dict) else c["R"]) or _band_pair(b)[0] for b in I.BANDS},
         "snr": c["snr"]} if isinstance(c, dict) else
        {"R": {b: (c[0].get(b) if isinstance(c[0], dict) else c[0]) or _band_pair(b)[0] for b in I.BANDS}, "snr": c[1]}
        for c in cases]
    if not cases:
        raise ValueError("cases: at least one")
    vc, vhw = clamp_window(p, ions, cases, vc, vhw)
    with matplotlib.rc_context(CS.rc(usetex)):
        return _build(p, ions, cases, vc, vhw, bool(intrinsic), int(seed))


def build_figure(payload, R_lo=None, R_hi=None, sn_hi=None, sn_lo=None, vwin=None, intrinsic=False, seed=0,
                 usetex=False, ions=None, R=None, sn=None, layout="4", vhw=None, vc=0.0) -> Figure:
    """render() from page-style arguments: layout, R = {band: [r0, r1]}, sn = [s0, s1], vhw, vc. The v1 keywords
    R_lo/R_hi (UV band), sn_hi/sn_lo (S/N pair) and vwin (= vhw) are still accepted."""
    R = {b: list(v) if isinstance(v, (list, tuple)) else [v, v] for b, v in (R or {}).items()}
    if R_lo is not None or R_hi is not None:
        lo = R_lo if R_lo is not None else _band_pair("uv")[0]
        R["uv"] = [lo, R_hi if R_hi is not None else lo]
    if sn_hi is not None or sn_lo is not None:
        hi = sn_hi if sn_hi is not None else I.SNR["pair"][0]
        sn = [hi, sn_lo if sn_lo is not None else hi]
    w = vhw if vhw is not None else (vwin if vwin is not None else VWIN)
    w = float(w)
    if not (np.isfinite(w) and w > 0):
        raise ValueError(f"vwin must be a positive finite number, got {w!r}")
    return render(payload, ions=ions, cases=cases_for(layout, R, sn), vc=vc, vhw=w, intrinsic=intrinsic,
                  seed=seed, usetex=usetex)


def render_bytes(payload, fmt="png", dpi=240, **build_kwargs) -> bytes:
    """PNG/PDF bytes of build_figure (bbox_inches='tight'; PDF without a creation date)."""
    if fmt not in ("png", "pdf"):
        raise ValueError(f"fmt must be png or pdf, got {fmt!r}")
    usetex = build_kwargs.get("usetex", False)
    fig = build_figure(payload, **build_kwargs)
    buf = io.BytesIO()
    meta = {"CreationDate": None} if fmt == "pdf" else None
    with matplotlib.rc_context(CS.rc(usetex)):
        fig.savefig(buf, format=fmt, dpi=dpi, bbox_inches="tight", metadata=meta)
    return buf.getvalue()
