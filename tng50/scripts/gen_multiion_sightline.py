#!/usr/bin/env python3
"""Generate high-res noiseless spectra for MANY ions along ONE existing sightline, so we can see
how spectral resolution R affects lines of very different intrinsic width.

The geometry is read verbatim from the stored npz (exact endpoints), so this is the same physical
ray as the existing 3-ion product -- we just add more transitions.

Lines are ordered from the broadest (hot, light ion) to the narrowest (cool, heavy ion), since
thermal width b = 0.1285 sqrt(T/A).

Cutout/index paths come from tngsight.config (cutout_path(), index_path(); the yt index is never
written next to the cutout). Needs an ion table with N, Si, Mg, Fe too (the full hm2012_ss_hr.h5),
and cwd with config.tri. Writes cgm_paths.out_dir()/multiion/multiion_<gid>.npz.

Usage: python gen_multiion_sightline.py [geom_id]
"""
from __future__ import annotations
import os, sys, json, tempfile
from pathlib import Path
import numpy as np

os.environ.setdefault("HDF5_USE_FILE_LOCKING", "FALSE")
os.environ.setdefault("MPLBACKEND", "Agg")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import h5py                      # noqa: E402
import yt                        # noqa: E402
import trident                   # noqa: E402
yt.set_log_level(50)
import cgm_geometry as G         # noqa: E402
import cgm_paths as P            # noqa: E402
from tngsight import config as TC   # noqa: E402

GAL = G.GAL
OUTDIR = P.out_dir(create=False) / "multiion"
C_KMS = GAL["C_KMS"]
VWIN_KMS = 1200.0
DLAMBDA_KMS = 0.55               # target sampling in km/s (kept ~constant across wavelengths)

# (key, trident line name, ion for add_ion_fields, atomic weight, typical log T) broad -> narrow
LINES = [
    ("OVI1032",  "O VI 1032",   "O VI",   16.0, 5.5),
    ("NV1239",   "N V 1239",    "N V",    14.0, 5.3),
    ("CIV1548",  "C IV 1548",   "C IV",   12.0, 5.0),
    ("HI1216",   "H I 1216",    "H I",     1.0, 4.0),
    ("HI1026",   "H I 1026",    "H I",     1.0, 4.0),
    ("SiIV1403", "Si IV 1403",  "Si IV",  28.1, 4.7),
    ("CIII977",  "C III 977",   "C III",  12.0, 4.3),
    ("SiIII1206", "Si III 1206", "Si III", 28.1, 4.3),
    ("CII1335",  "C II 1335",   "C II",   12.0, 4.0),
    ("SiII1260", "Si II 1260",  "Si II",  28.1, 4.0),
    ("MgII2796", "Mg II 2796",  "Mg II",  24.3, 4.0),
    ("FeII1608", "Fe II 1608",  "Fe II",  55.8, 4.0),
]


def line_info():
    """Resolve rest wavelength + number-density field for each requested transition."""
    from trident.line_database import LineDatabase
    ld = LineDatabase("lines.txt")
    by_name = {l.name: l for l in ld.lines_all}
    out = []
    for key, name, ion, A, logT in LINES:
        if name not in by_name:
            print(f"  !! {name} not in Trident line list -- skipped", flush=True)
            continue
        l = by_name[name]
        out.append(dict(key=key, name=name, ion=ion, A=A, logT=logT,
                        rest=float(l.wavelength), f=float(l.f_value), field=l.field[1]))
    return out


def load_ds(ions):
    TC.index_path().parent.mkdir(parents=True, exist_ok=True)
    ds = yt.load(str(TC.cutout_path()), index_filename=str(TC.index_path()))
    if ("gas", "metallicity") not in ds.derived_field_list:
        def _Z(field, data):
            return data["PartType0", "GFM_Metallicity"]
        ds.add_field(("gas", "metallicity"), function=_Z, sampling_type="local",
                     units="", force_override=True)
    trident.add_ion_fields(ds, ions=sorted(set(ions)), ftype="gas")
    return ds


def main():
    gid = sys.argv[1] if len(sys.argv) > 1 else "rand_b012_a034_s536718143"
    src = P.find_sightline(gid)
    geom = json.loads(str(np.load(src, allow_pickle=True)["geom"]))
    v_sys = float(np.load(src, allow_pickle=True)["v_sys"])
    info = line_info()
    print(f"[{gid}] {len(info)} transitions; v_sys={v_sys:+.1f} km/s; loading cutout...", flush=True)

    ds = load_ds([i["ion"] for i in info])
    fields = [("gas", "density"), ("gas", "temperature"), ("gas", "metallicity")] + \
             [("gas", i["field"]) for i in info]
    p0 = ds.arr(np.array(geom["start_ckpch"], float), "code_length")
    p1 = ds.arr(np.array(geom["end_ckpch"], float), "code_length")
    ds.domain_left_edge = ds.domain_left_edge.copy()
    ds.domain_right_edge = ds.domain_right_edge.copy()
    fd, tmp = tempfile.mkstemp(suffix=".h5", prefix="_cgmray_multi_", dir=P.out_dir())
    os.close(fd); os.remove(tmp)
    ray = trident.make_simple_ray(ds, start_position=p0, end_position=p1,
                                  fields=fields, ftype="gas", data_filename=tmp)
    print("  ray cast; generating spectra...", flush=True)

    # integrated columns for reference
    cols = {}
    with h5py.File(tmp, "r") as h:
        dl = h["grid"]["dl"][()]
        for i in info:
            fld = i["field"]
            n = h["grid"][fld][()] if fld in h["grid"] else np.zeros_like(dl)
            N = float(np.sum(n * dl))
            cols[i["key"]] = np.log10(N) if N > 0 else -np.inf

    payload = dict(geom=json.dumps(geom), v_sys=v_sys,
                   lines=json.dumps([{k: i[k] for k in ("key", "name", "ion", "A", "logT",
                                                        "rest", "f")} for i in info]))
    for i in info:
        rest = i["rest"]
        dlam = DLAMBDA_KMS / C_KMS * rest            # constant velocity sampling
        lo, hi = rest * (1 - VWIN_KMS / C_KMS), rest * (1 + VWIN_KMS / C_KMS)
        sg = trident.SpectrumGenerator(lambda_min=lo, lambda_max=hi, dlambda=dlam)
        sg.make_spectrum(ray, lines=[i["name"]], use_peculiar_velocity=True,
                         use_doppler_redshift_only=True, ly_continuum=False, njobs=1)
        payload[f"{i['key']}_lambda"] = np.array(sg.lambda_field, dtype=np.float64)
        payload[f"{i['key']}_tau"] = np.array(sg.tau_field, dtype=np.float32)
        payload[f"{i['key']}_rest"] = rest
        payload[f"logN_{i['key']}"] = cols[i["key"]]
        print(f"    {i['name']:<13} logN={cols[i['key']]:6.2f}  tau_max={np.max(sg.tau_field):9.2f}",
              flush=True)
    OUTDIR.mkdir(parents=True, exist_ok=True)
    out = OUTDIR / f"multiion_{gid}.npz"
    np.savez_compressed(out, **payload)
    if os.path.exists(tmp):
        os.remove(tmp)
    print(f"saved {out}")


if __name__ == "__main__":
    main()
