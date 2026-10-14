#!/usr/bin/env python3
"""Interactive CGM mock-QSO spectra explorer for TNG50-1 subhalo 488530 (Panel + Bokeh).

Two S/N sliders (2-20), two R selectors, orientation / impact / azimuth controls + Submit; a
scrollable gallery of pre-generated sightlines; the on-screen 3x4 figure is the *publication*
figure (make_publication_figure). Spectral resolution R (Gaussian LSF, dλ = 0.002 Å) and S/N (per
resolution element) are applied LIVE from cached high-res noiseless spectra — instant, on the
fixed velocity axis V = c(λ/λ0−1) + v_sys (galaxy systemic at 0). Only a NEW geometry triggers a
Trident ray-cast (tngsight.generate.Generator on tngsight.config.cutout_path()); the result is saved
to <TNG_LIBRARY_DIR>/generated/<id>.npz — never into the repo or the read-only originals — and
immediately becomes scrollable. Download the exact 240-dpi publication PDF/PNG.

Run (from a directory holding config.tri, e.g. /Volumes/cgm_work/run, see tng50/README.md):
  panel serve <repo>/tng50/app/cgm_app.py --address 127.0.0.1 --port 8050 \
      --allow-websocket-origin=127.0.0.1:8050 --show
"""
from __future__ import annotations
import sys, io, json, shutil
from pathlib import Path
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.figure import Figure
import panel as pn

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import cgm_paths as P                # noqa: E402  (also puts the repo root on sys.path)
import cgm_style as CS               # noqa: E402
import cgm_geometry as G             # noqa: E402
from make_publication_figure import build_figure  # noqa: E402
from tngsight import config as TC                 # noqa: E402
from tngsight.library import load_npz as load_payload, save_npz  # noqa: E402

INDEX = P.repo_data() / "grid_index.csv"   # library catalog + showcase scores (read-only)
HAS_LATEX = shutil.which("latex") is not None and shutil.which("dvipng") is not None
ACCENT = "#1D4E89"

pn.extension(notifications=True, sizing_mode="stretch_width")
CS.set_style(usetex=False, base=13)   # fast mathtext for the live pane; export re-styles to LaTeX

# --------------------------------------------------------------------------- data access
_SCORES = {}      # generated npz path -> (mtime, score record); scored once with tngsight.scoring


def _generated_rows() -> list:
    from tngsight.scoring import score_payload
    rows = []
    gd = P.generated_dir()
    for f in sorted(gd.glob("*.npz")) if gd.is_dir() else []:
        try:
            mt = f.stat().st_mtime
            if _SCORES.get(str(f), (None,))[0] != mt:
                pl = load_payload(f)
                g = pl["geom"]
                _SCORES[str(f)] = (mt, dict(geom_id=pl["id"], orientation=g["orientation"],
                                            b_kpc=float(g["b_kpc"]), azimuth_deg=float(g["azimuth_deg"]),
                                            v_sys=pl["v_sys"], **score_payload(pl)))
            rows.append(dict(_SCORES[str(f)][1], file=str(f), generated=True))
        except Exception as e:             # noqa: BLE001  (a half-written or foreign file)
            print(f"skipping {f.name}: {type(e).__name__}: {e}", flush=True)
    return rows


def read_index() -> pd.DataFrame:
    """Library rows (committed grid_index.csv; files resolved in the sightlines dir) + generated rows."""
    df = pd.read_csv(INDEX) if INDEX.exists() and INDEX.stat().st_size > 0 else pd.DataFrame()
    if len(df):                                 # library files: <id>.npz or cgm_sid488530_<id>.npz
        have = {P.gid_of(f): str(f) for f in P.sightlines_dir().glob("*.npz")}
        df["file"] = [have.get(g) for g in df.geom_id]
        df = df[df.file.notna()]
    gen = pd.DataFrame(_generated_rows())
    if len(gen):
        gen = gen[~gen.geom_id.isin(df.geom_id)] if len(df) else gen
        df = pd.concat([df, gen], ignore_index=True)
    if not len(df):
        return pd.DataFrame(columns=["geom_id", "orientation", "b_kpc", "azimuth_deg", "file"])
    if "showcase_score" in df.columns:          # best multi-component/unsaturated first
        return df.sort_values("showcase_score", ascending=False,
                              na_position="last", kind="stable").reset_index(drop=True)
    return df.reset_index(drop=True)


def label_of(r) -> str:
    tag = {"face-on": "face", "edge-on": "edge", "random": "rand"}.get(r.orientation, r.orientation)
    star = ""
    if r.get("ovi_showcase", False) in (True, 1):   # NaN (unscored) is not a star
        star = "★ "                               # O VI multi-component & unsaturated (best demo)
    elif (r.get("n_showcase_ions", 0) or 0) >= 1:
        star = "☆ "                               # some ion is showcase-quality
    sd = str(r.geom_id).rsplit("_s", 1)[1] if "_s" in str(r.geom_id) else ""
    seed = f"   seed {sd}" if sd else ""          # labels must be unique: same (b, Φ), other seed
    new = "   • new" if r.get("generated", False) is True else ""
    return f"{star}{tag}   b={r.b_kpc:g} kpc   Φ={r.azimuth_deg:g}°{seed}{new}"


def options_map(df, showcase_only=False) -> dict:
    if showcase_only and "n_showcase_ions" in df.columns:
        df = df[df.n_showcase_ions.fillna(0) >= 1]
    return {label_of(r): r.file for _, r in df.iterrows()}


def current_options():
    return options_map(read_index(), showcase_only.value)


def load_npz(fname):
    return np.load(fname, allow_pickle=True)


# ------------------------------------------------------ on-demand ray generation (lazy, warm Generator)
_GEN = {"gen": None}


def _generator():
    if _GEN["gen"] is None:
        from tngsight.generate import Generator
        _GEN["gen"] = Generator()
    return _GEN["gen"]


def ensure_sightline(orientation, b, az, seed=None, progress=None):
    """Return (path, generated?). Load from the library/generated dir if present, else cast a ray."""
    c = G.canonicalize(orientation, b, az, seed)       # ValueError on bad input (b range, seed)
    try:
        return str(P.find_sightline(c["id"])), False
    except FileNotFoundError:
        pass
    pl = _generator().generate(c, progress=progress)   # first call loads the cutout (minutes)
    out = P.generated_dir(create=True) / f"{c['id']}.npz"
    save_npz(out, pl["geom"], pl["logN"], pl["tau"])
    return str(out), True


# --------------------------------------------------------------------------- widgets
R_OPTS = [20000, 30000, 40000, 60000, 80000, 100000]
r_lo = pn.widgets.DiscreteSlider(name="R  —  columns 1 & 3", options=R_OPTS, value=20000)
r_hi = pn.widgets.DiscreteSlider(name="R  —  columns 2 & 4", options=R_OPTS, value=40000)
sn_hi = pn.widgets.IntSlider(name="S/N  —  columns 1 & 2", start=2, end=20, step=1, value=8)
sn_lo = pn.widgets.IntSlider(name="S/N  —  columns 3 & 4", start=2, end=20, step=1, value=5)
vwin = pn.widgets.IntSlider(name="velocity window  ± [km/s]", start=150, end=800, step=50, value=400)
show_intrinsic = pn.widgets.Checkbox(name="show intrinsic (unconvolved) spectrum", value=False)
reroll = pn.widgets.Button(name="↻ new noise draw", button_type="default", width=170)

orient = pn.widgets.RadioButtonGroup(name="orientation", options=["face-on", "edge-on", "random"],
                                     value="edge-on", button_type="primary")
b_slider = pn.widgets.EditableIntSlider(name="impact parameter  b [kpc]", start=0, end=int(TC.B_MAX_KPC),
                                       step=5, value=100, fixed_start=0, fixed_end=int(TC.B_MAX_KPC))
az_slider = pn.widgets.EditableIntSlider(name="azimuth  Φ [deg]", start=0, end=359, step=15, value=90)
seed_input = pn.widgets.IntInput(name="random seed", value=1, start=0, end=2**32 - 1, width=160)
submit = pn.widgets.Button(name="Submit  —  load / generate sightline",
                           button_type="primary", height=42)

showcase_only = pn.widgets.Checkbox(
    name="★ showcase only  (multi-component, unsaturated)", value=False)
gallery = pn.widgets.Select(name="pre-generated sightlines", options=current_options(), size=10)
prev_btn = pn.widgets.Button(name="◀ prev", width=95)
next_btn = pn.widgets.Button(name="next ▶", width=95)

mpl = pn.pane.Matplotlib(Figure(figsize=(1, 1)), dpi=96, tight=False, format="png",
                         sizing_mode="stretch_width", min_height=560)
status = pn.pane.Markdown("", styles={"font-size": "14px", "padding": "2px 6px"})

STATE = {"data": None, "fname": None, "seed": 0}


# --------------------------------------------------------------------------- rendering
def _build(export=False):
    data = STATE["data"]
    if export:
        CS.set_style(usetex=HAS_LATEX, base=15)
    fig, geom = build_figure(data, Rlo=r_lo.value, Rhi=r_hi.value, SNhi=sn_hi.value,
                             SNlo=sn_lo.value, vwin=float(vwin.value), seed=STATE["seed"],
                             show_intrinsic=show_intrinsic.value)
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
        f"<b><code>{P.gid_of(STATE['fname'])}</code></b> &nbsp;|&nbsp; orientation <b>{geom['orientation']}</b>, "
        f"b = <b>{geom['b_kpc']:.0f} kpc</b>, &Phi; = <b>{geom['azimuth_deg']:.0f}&deg;</b>, "
        f"<i>v</i><sub>sys</sub> = <b>{geom['v_sys_kms']:+.0f} km/s</b> &nbsp;|&nbsp; "
        f"log <i>N</i> [cm<sup>&minus;2</sup>]: O VI <b>{lN['OVI']:.2f}</b>, "
        f"H I <b>{lN['HILyb']:.2f}</b>, C III <b>{lN['CIII']:.2f}</b>")


def load_file(fname):
    STATE["data"] = load_npz(fname)
    STATE["fname"] = fname
    _sync_names()
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

        def progress(stage, frac, msg=""):
            status.object = f"**Generating** &nbsp; {stage} &nbsp; {frac:.0%} &nbsp; {msg}"
        fname, generated = ensure_sightline(o, b, az, seed, progress=progress)
        if generated:
            gallery.options = current_options()
            if pn.state.notifications:
                pn.state.notifications.success(f"Generated new sightline: {P.gid_of(fname)}",
                                               duration=4000)
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
show_intrinsic.param.watch(lambda e: rerender(), "value")   # checkbox: fires on toggle


def refresh_gallery(*_):
    cur = gallery.value
    gallery.options = current_options()
    if cur in gallery.options.values():
        gallery.value = cur
showcase_only.param.watch(lambda e: refresh_gallery(), "value")


# --------------------------------------------------------------------------- downloads
def _fname(ext):
    return f"cgm_spectra_488530_{P.gid_of(STATE['fname'] or 'none')}.{ext}"


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


def _sync_names(*_):
    dl_png.filename, dl_pdf.filename = _fname("png"), _fname("pdf")


# --------------------------------------------------------------------------- layout
def h(txt):
    return pn.pane.Markdown(txt, styles={"margin-bottom": "-6px", "color": ACCENT})

sidebar = [
    h("### ◉ Sightline geometry"),
    orient, b_slider, az_slider, seed_input, submit,
    pn.pane.Markdown("<span style='font-size:11.5px;color:#888'>On-grid geometries load instantly; "
                     "off-grid ones cast a fresh Trident ray (the first one also loads the cutout, "
                     "minutes from a USB disk) and are saved for later scrolling. b ≤ "
                     f"{TC.B_MAX_KPC:g} kpc; Φ wraps at 360°.</span>"),
    pn.layout.Divider(),
    h("### ◉ Instrument  (live)"),
    r_lo, r_hi, sn_hi, sn_lo, vwin, show_intrinsic, reroll,
    pn.layout.Divider(),
    h("### ◉ Gallery"),
    showcase_only, gallery, pn.Row(prev_btn, next_btn),
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
    try:
        f0 = str(P.find_sightline("edge_b100_a090"))
    except FileNotFoundError:
        f0 = _idx.iloc[0].file
    if f0 in gallery.options.values():
        gallery.value = f0
    load_file(f0)

tmpl.servable()
