"""3x4 publication figure for one sightline (port of make_publication_figure.build_figure).
Rows O VI 1032 / H I Lyβ / C III 977; columns (R_lo,S/N_hi),(R_hi,S/N_hi),(R_lo,S/N_lo),(R_hi,S/N_lo).
x = V_LOS − V_sys in the fixed frame (config.VSYS_SIGN). Uses matplotlib.figure.Figure directly
(no pyplot state) and a local rc_context, so it is safe to call repeatedly in a server."""
from __future__ import annotations
import io
import json
import numpy as np
import matplotlib
from matplotlib.figure import Figure
from .config import C_KMS, FWHM_TO_SIGMA, LINE_KEYS
from .degrade import degrade, velocity_axis
from . import style as CS

VWIN = 400.0
LSF_EDGE_SIGMAS = 4.0      # LSF edge pixels use boundary="extend": keep this many σ_LSF clear of the grid edge


def max_vwin(payload, R_min=None) -> float:
    """Largest symmetric |V| window fully covered by computed data for every line of `payload`.
    The ±1500 km/s generation grid is shifted by +v_sys in the fixed frame, so it covers only
    [−1500+v_sys, 1500+v_sys]; beyond that degrade() pads with flux 1.0 (fake continuum). With R_min,
    LSF_EDGE_SIGMAS·σ_LSF more is reserved for the convolution edge."""
    p = as_payload(payload)
    v_sys = float(p["v_sys"])
    cover = min(min(-v.min(), v.max()) for v in
                (velocity_axis(np.asarray(p["lam"][k], float), float(p["rest"][k]), v_sys) for k in LINE_KEYS))
    if R_min:
        cover -= LSF_EDGE_SIGMAS * (C_KMS / float(R_min)) * FWHM_TO_SIGMA
    return float(cover)


def _columns(R_lo, R_hi, sn_hi, sn_lo):
    return [(R_lo, sn_hi), (R_hi, sn_hi), (R_lo, sn_lo), (R_hi, sn_lo)]


def as_payload(data) -> dict:
    """Accept a load_npz() payload or a raw npz mapping (np.load result / dict of npz keys)."""
    if "tau" in data:
        return data
    g = data["geom"]
    return {"id": None, "geom": g if isinstance(g, dict) else json.loads(str(g)), "v_sys": float(data["v_sys"]),
            "logN": {k: float(data[f"logN_{k}"]) for k in LINE_KEYS},
            "lam": {k: data[f"{k}_lambda"] for k in LINE_KEYS}, "tau": {k: data[f"{k}_tau"] for k in LINE_KEYS},
            "rest": {k: float(data[f"{k}_rest"]) for k in LINE_KEYS}}


def _build(p, R_lo, R_hi, sn_hi, sn_lo, vwin, intrinsic, seed):
    rcp = matplotlib.rcParams
    cols = _columns(R_lo, R_hi, sn_hi, sn_lo)
    v_sys = float(p["v_sys"])
    fig = Figure(figsize=(19, 10.6))
    ax = fig.subplots(3, 4, sharex=True, sharey=True, squeeze=False)
    for r, key in enumerate(CS.ION_ORDER):
        lam = np.asarray(p["lam"][key], float)
        tau = np.asarray(p["tau"][key], float)
        rest = float(p["rest"][key])
        col = CS.ION[key]["color"]
        if intrinsic:
            v_hi = velocity_axis(lam, rest, v_sys)
            f_hi = np.exp(-tau)
            m_hi = (v_hi >= -vwin) & (v_hi <= vwin)
            v_hi, f_hi = v_hi[m_hi], f_hi[m_hi]
        for c, (R, SN) in enumerate(cols):
            a = ax[r][c]
            v, flux, model = degrade(lam, tau, rest, R, SN, v_sys, seed=seed + 17 * c + 101 * r, vwin=vwin)
            a.step(v, flux, where="mid", color=col, lw=0.9, alpha=0.5, zorder=2)
            a.fill_between(v, model, 1.0, where=(model < 1.0), color=col, alpha=0.22, lw=0, zorder=1)
            if intrinsic:
                a.plot(v_hi, f_hi, color="0.45", lw=1.2, alpha=0.9, zorder=2.4)
            a.plot(v, model, color=col, lw=2.6, solid_joinstyle="round", zorder=3)
            a.axhline(1.0, color="0.55", ls="--", lw=1.0, zorder=1)
            a.axvline(0.0, color="0.4", ls=":", lw=1.1, zorder=1)
            a.set_xlim(-vwin, vwin); a.set_ylim(-0.08, 1.32)
            if r == 0:
                a.set_title(rf"$R$ = {R:,},  S/N = {SN}", fontsize=rcp["axes.titlesize"], pad=8)
        ax[r][0].text(0.035, 0.09, CS.ION[key]["label"], transform=ax[r][0].transAxes,
                      color=col, ha="left", va="bottom", fontsize=rcp["axes.labelsize"],
                      bbox=dict(boxstyle="round,pad=0.3", fc="white", ec=col, lw=1.4, alpha=0.95))
    for c in range(4):
        ax[2][c].set_xlabel(r"$V_{\rm LOS}-V_{\rm sys}\ \ [\mathrm{km\,s^{-1}}]$")
    for r in range(3):
        ax[r][0].set_ylabel(r"normalized flux")
    fig.tight_layout(w_pad=0.6, h_pad=0.6)
    return fig


def build_figure(payload, R_lo=20000, R_hi=40000, sn_hi=8, sn_lo=5, vwin=VWIN, intrinsic=False,
                 seed=0, usetex=False) -> Figure:
    """The original 3x4 layout/colours; mathtext (Computer Modern) when usetex=False. `vwin` is clamped
    to max_vwin(payload, min(R_lo, R_hi)) so no uncomputed (padded) region is drawn as continuum."""
    p = as_payload(payload)
    vwin = float(vwin)
    if not (np.isfinite(vwin) and vwin > 0):
        raise ValueError(f"vwin must be a positive finite number, got {vwin!r}")
    Rs = [R for R in (R_lo, R_hi) if R]
    vwin = min(vwin, max_vwin(p, min(Rs) if Rs else None))
    with matplotlib.rc_context(CS.rc(usetex)):
        return _build(p, R_lo, R_hi, sn_hi, sn_lo, vwin, bool(intrinsic), int(seed))


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
