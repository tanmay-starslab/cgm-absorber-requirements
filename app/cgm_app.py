#!/usr/bin/env python3
"""Interactive CGM mock-QSO spectra explorer for TNG50-1 subhalo 488530 (Panel + Bokeh).

Two S/N sliders (2-20), two R selectors, orientation / impact / azimuth controls + Submit; a
scrollable gallery of pre-generated sightlines; the on-screen 3x4 figure is the *publication*
figure (make_publication_figure). Spectral resolution R (Gaussian LSF) and S/N (per resolution
element) are applied LIVE from cached high-res noiseless spectra — instant. Only a NEW geometry
triggers a Trident ray-cast, which is saved to data/sightlines/ + grid_index.csv and immediately
becomes scrollable. Download the exact 240-dpi publication PDF/PNG.

Run:  panel serve app/cgm_app.py --show --autoreload  (or --port 8050)
"""
from __future__ import annotations
import os, sys, io, json, shutil
from pathlib import Path
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import panel as pn

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_style as CS               # noqa: E402
import cgm_geometry as G             # noqa: E402
from make_publication_figure import build_figure  # noqa: E402

DATA = ROOT / "data" / "sightlines"
INDEX = ROOT / "data" / "grid_index.csv"
HAS_LATEX = shutil.which("latex") is not None and shutil.which("dvipng") is not None
ACCENT = "#1D4E89"

pn.extension(notifications=True, sizing_mode="stretch_width")
CS.set_style(usetex=False, base=13)   # fast mathtext for the live pane; export re-styles to LaTeX

# --------------------------------------------------------------------------- data access
def read_index() -> pd.DataFrame:
    if INDEX.exists() and INDEX.stat().st_size > 0:
        df = pd.read_csv(INDEX)
        order = {"face-on": 0, "edge-on": 1, "random": 2}
        df["_o"] = df.orientation.map(lambda o: order.get(o, 3))
        return df.sort_values(["_o", "b_kpc", "azimuth_deg"]).reset_index(drop=True)
    return pd.DataFrame(columns=["geom_id", "orientation", "b_kpc", "azimuth_deg", "file"])


def label_of(r) -> str:
    tag = {"face-on": "face", "edge-on": "edge", "random": "rand"}.get(r.orientation, r.orientation)
    return f"{tag}   b={r.b_kpc:g} kpc   Φ={r.azimuth_deg:g}°"


def options_map(df) -> dict:
    return {label_of(r): r.file for _, r in df.iterrows()}


def load_npz(fname):
    return np.load(DATA / fname, allow_pickle=True)


# ------------------------------------------------------ on-demand ray generation (lazy, cached ds)
_GEN = {"mod": None, "ds": None}

def _gen_mod():
    if _GEN["mod"] is None:
        import importlib
        _GEN["mod"] = importlib.import_module("gen_cgm_sightlines")
    return _GEN["mod"]


def ensure_sightline(orientation, b, az, seed=None):
    """Return (fname, generated?). Load from cache if present, else cast a Trident ray and save."""
    gid = G.geom_id(orientation, b, az)
    if orientation == "random" and seed is not None:
        gid = f"{gid}_s{int(seed)}"
    fname = f"cgm_sid488530_{gid}.npz"
    if (DATA / fname).exists():
        return fname, False
    gm = _gen_mod()
    if _GEN["ds"] is None:
        _GEN["ds"] = gm.load_ds()                      # ~1 min, first off-grid request only
    ds = _GEN["ds"]
    geom = G.make_sightline(orientation, float(b), float(az), seed=seed)
    tmp = f"/tmp/_cgmray_gui_{os.getpid()}.h5"
    ray = gm.cast_ray(ds, geom, tmp)
    cols = gm.ray_columns(tmp)
    payload = dict(geom=json.dumps(geom), v_sys=geom["v_sys_kms"],
                   **{f"logN_{k}": cols[k] for k in gm.LINES})
    for key in gm.LINES:
        lam, tau = gm.make_line_spectrum(ray, key)
        payload[f"{key}_lambda"] = lam; payload[f"{key}_tau"] = tau
        payload[f"{key}_rest"] = gm.LINES[key]["rest_A"]
    np.savez_compressed(DATA / fname, **payload)
    rec = dict(geom_id=gid, v_sys=geom["v_sys_kms"], orientation=str(orientation),
               b_kpc=float(b), azimuth_deg=float(az), file=fname,
               **{f"log{k}": cols[k] for k in gm.LINES})
    gm.append_index([rec])
    if os.path.exists(tmp):
        os.remove(tmp)
    return fname, True


# --------------------------------------------------------------------------- widgets
R_OPTS = [20000, 30000, 40000, 60000, 80000, 100000]
r_lo = pn.widgets.DiscreteSlider(name="R  —  columns 1 & 3", options=R_OPTS, value=20000)
r_hi = pn.widgets.DiscreteSlider(name="R  —  columns 2 & 4", options=R_OPTS, value=40000)
sn_hi = pn.widgets.IntSlider(name="S/N  —  columns 1 & 2", start=2, end=20, step=1, value=8)
sn_lo = pn.widgets.IntSlider(name="S/N  —  columns 3 & 4", start=2, end=20, step=1, value=5)
vwin = pn.widgets.IntSlider(name="velocity window  ± [km/s]", start=150, end=800, step=50, value=400)
reroll = pn.widgets.Button(name="↻ new noise draw", button_type="default", width=170)

orient = pn.widgets.RadioButtonGroup(name="orientation", options=["face-on", "edge-on", "random"],
                                     value="edge-on", button_type="primary")
b_slider = pn.widgets.EditableIntSlider(name="impact parameter  b [kpc]", start=20, end=160, step=5, value=100)
az_slider = pn.widgets.EditableIntSlider(name="azimuth  Φ [deg]", start=0, end=360, step=15, value=90)
seed_input = pn.widgets.IntInput(name="random seed", value=1, start=0, end=100000, width=140)
submit = pn.widgets.Button(name="Submit  —  load / generate sightline",
                           button_type="primary", height=42)

gallery = pn.widgets.Select(name="pre-generated sightlines", options=options_map(read_index()), size=8)
prev_btn = pn.widgets.Button(name="◀ prev", width=95)
next_btn = pn.widgets.Button(name="next ▶", width=95)

mpl = pn.pane.Matplotlib(plt.figure(figsize=(1, 1)), dpi=96, tight=False, format="png",
                         sizing_mode="stretch_width", min_height=560)
status = pn.pane.Markdown("", styles={"font-size": "14px", "padding": "2px 6px"})

STATE = {"data": None, "fname": None, "seed": 0}


# --------------------------------------------------------------------------- rendering
def _build(export=False):
    data = STATE["data"]
    if export:
        CS.set_style(usetex=HAS_LATEX, base=15)
    fig, geom = build_figure(data, Rlo=r_lo.value, Rhi=r_hi.value, SNhi=sn_hi.value,
                             SNlo=sn_lo.value, vwin=float(vwin.value), seed=STATE["seed"])
    if export:
        CS.set_style(usetex=False, base=13)
    return fig, geom


def rerender(*_):
    if STATE["data"] is None:
        return
    fig, geom = _build(export=False)
    old = mpl.object
    mpl.object = fig
    if isinstance(old, plt.Figure):
        plt.close(old)
    data = STATE["data"]
    lN = {k: float(data[f"logN_{k}"]) for k in CS.ION_ORDER}
    status.object = (
        f"<b><code>{STATE['fname']}</code></b> &nbsp;|&nbsp; orientation <b>{geom['orientation']}</b>, "
        f"b = <b>{geom['b_kpc']:.0f} kpc</b>, &Phi; = <b>{geom['azimuth_deg']:.0f}&deg;</b>, "
        f"<i>v</i><sub>sys</sub> = <b>{geom['v_sys_kms']:+.0f} km/s</b> &nbsp;|&nbsp; "
        f"log <i>N</i> [cm<sup>&minus;2</sup>]: O VI <b>{lN['OVI']:.2f}</b>, "
        f"H I <b>{lN['HILyb']:.2f}</b>, C III <b>{lN['CIII']:.2f}</b>")


def load_file(fname):
    STATE["data"] = load_npz(fname)
    STATE["fname"] = fname
    rerender()


# --------------------------------------------------------------------------- callbacks
def on_gallery(ev):
    if ev.new:
        load_file(ev.new)
gallery.param.watch(on_gallery, "value")


def step_gallery(d):
    opts = list(gallery.options.values())
    if not opts:
        return
    cur = gallery.value
    i = opts.index(cur) if cur in opts else 0
    gallery.value = opts[(i + d) % len(opts)]
prev_btn.on_click(lambda e: step_gallery(-1))
next_btn.on_click(lambda e: step_gallery(+1))


def on_submit(ev):
    submit.loading = True
    try:
        o = orient.value
        b = int(b_slider.value)
        az = int(az_slider.value)
        seed = int(seed_input.value) if o == "random" else None
        fname, generated = ensure_sightline(o, b, az, seed)
        if generated:
            new_opts = options_map(read_index())
            gallery.options = new_opts
            if pn.state.notifications:
                pn.state.notifications.success(f"Generated new sightline: {fname}", duration=4000)
        elif pn.state.notifications:
            pn.state.notifications.info("Loaded from cache (instant)", duration=2500)
        if fname in gallery.options.values():
            gallery.value = fname          # triggers load via watcher
        else:
            load_file(fname)
    except Exception as e:                 # noqa: BLE001
        if pn.state.notifications:
            pn.state.notifications.error(f"{type(e).__name__}: {e}", duration=9000)
        status.object = f"**Error:** {type(e).__name__}: {e}"
    finally:
        submit.loading = False
submit.on_click(on_submit)


def on_reroll(e):
    STATE["seed"] = (STATE["seed"] + 1) % 100000
    rerender()
reroll.on_click(on_reroll)

for w in (r_lo, r_hi, sn_hi, sn_lo, vwin):
    w.param.watch(lambda e: rerender(), "value_throttled")


# --------------------------------------------------------------------------- downloads
def _fig_bytes(fmt):
    fig, _ = _build(export=True)
    buf = io.BytesIO()
    fig.savefig(buf, format=fmt, dpi=240, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf
dl_png = pn.widgets.FileDownload(label="⬇ Download PNG (240 dpi)", filename="cgm_spectra_488530.png",
                                 callback=lambda: _fig_bytes("png"), button_type="success", width=230)
dl_pdf = pn.widgets.FileDownload(label="⬇ Download PDF (vector)", filename="cgm_spectra_488530.pdf",
                                 callback=lambda: _fig_bytes("pdf"), button_type="success", width=230)


# --------------------------------------------------------------------------- layout
def h(txt):
    return pn.pane.Markdown(txt, styles={"margin-bottom": "-6px", "color": ACCENT})

sidebar = [
    h("### ◉ Sightline geometry"),
    orient, b_slider, az_slider, seed_input, submit,
    pn.pane.Markdown("<span style='font-size:11.5px;color:#888'>On-grid geometries load instantly; "
                     "off-grid ones cast a fresh Trident ray (~1 min the first time) and are saved "
                     "for later scrolling.</span>"),
    pn.layout.Divider(),
    h("### ◉ Instrument  (live)"),
    r_lo, r_hi, sn_hi, sn_lo, vwin, reroll,
    pn.layout.Divider(),
    h("### ◉ Gallery"),
    gallery, pn.Row(prev_btn, next_btn),
]
main = [
    pn.Row(status, sizing_mode="stretch_width"),
    mpl,
    pn.Row(dl_png, dl_pdf, pn.layout.HSpacer()),
]
tmpl = pn.template.FastListTemplate(
    title="CGM Mock-QSO Spectra  ·  TNG50-1 sub-488530  ·  O VI / Lyβ / C III",
    sidebar=sidebar, main=main, accent=ACCENT, header_background=ACCENT,
    sidebar_width=340, theme="default", main_max_width="1500px",
)

# initial sightline
_idx = read_index()
if len(_idx):
    default = "cgm_sid488530_edge_b100_a090.npz"
    f0 = default if (DATA / default).exists() else _idx.iloc[0].file
    if f0 in gallery.options.values():
        gallery.value = f0
    load_file(f0)

tmpl.servable()
