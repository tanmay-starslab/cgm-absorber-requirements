"""Galaxy registry (Phase 4 W0-C): one JSON record per galaxy, galaxies/<sim>-<snap>-<id>.json, schema
tests/schemas/galaxy.schema.json, definitions in tngsight/definitions.json.

Measured from the published TNG50-1 MW/M31 cutouts (read-only, ±400 kpc cubes; Pillepich et al. 2024):
centre and SubhaloVel (galpipe._members: Subfind definitions), spherical-overdensity radii about the galaxy itself
(all particle types), T200, r_1/2,*, the signed stellar-spin frame, misalignments, satellite gas fraction and the
CGM phase masses. Catalogue values are kept beside the recomputed ones for cross-checks.

  python -m tngsight.registry build [--ids 488530 ...] [--out galaxies]     (SOL: one array task per id chunk)
  python -m tngsight.registry check [--out galaxies]                         (cross-check report, schema errors)
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from pathlib import Path

import numpy as np

from . import definitions
from .galpipe import COLD_NH_MIN, COLD_T_MAX, APER_FRAC, APER_MIN_KPC, M_H_G, _members, _wrap, temperature

REPO = Path(__file__).resolve().parents[1]
OUT_DEFAULT = REPO / "galaxies"
SCHEMA_PATH = REPO / "tests" / "schemas" / "galaxy.schema.json"
SCHEMA_ID = "galaxy/1"
SIM, SNAP = "TNG50-1", 99
G_CODE = 43007.1                 # G in kpc (km/s)^2 / (1e10 Msun), Arepo/TNG code units
RHO_CRIT_CODE = 3 * 0.1 ** 2 / (8 * math.pi * G_CODE)   # (1e10 Msun/h) / (ckpc/h)^3 at z = 0
M_P_G, K_B, G_CGS, MSUN_G, KPC_CM = 1.67262192e-24, 1.380649e-16, 6.6743e-8, 1.98847e33, 3.0856775814913673e21
MU = 0.59
SF_MIN_CELLS = 50
CITE = ["nelson19a", "pillepich24"]
FIRE2_SIM, FIRE2_SNAP = "FIRE-2", 600
FIRE2_CITE = ["hopkins18", "wetzel23"]
FIRE2_IDS = (
    "m12b", "m12c", "m12f", "m12i", "m12m", "m12r", "m12w", "m12z",
    "Romeo", "Juliet", "Romulus", "Remus", "Thelma", "Louise",
    "m11b", "m11d", "m11e", "m11h", "m11i", "m11q", "m10q", "m10v", "m09",
)
RHO_CRIT_0_H2_MSUN_KPC3 = 277.536627  # 3 H0^2 / (8 pi G) in h^2 Msun / kpc^3


def slug(sim: str, snap: int, sid: int | str) -> str:
    s = "fire2" if sim.upper() in ("FIRE-2", "FIRE2") else sim.lower()
    sid_str = str(int(sid)) if isinstance(sid, int) or str(sid).isdigit() else str(sid)
    return f"{s}-{int(snap):03d}-{sid_str}"


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def angle(a, b) -> float:
    return float(np.degrees(np.arccos(np.clip(np.dot(unit(a), unit(b)), -1.0, 1.0))))


def fold(a: float) -> float:
    """Angle between unsigned axes: 0-90 deg."""
    return float(min(a, 180.0 - a))


def delta_bn(om0: float) -> float:
    """Bryan & Norman (1998) Delta_c at z = 0 for flat LCDM."""
    x = om0 - 1.0
    return 18 * math.pi ** 2 + 82 * x - 39 * x ** 2


def so_radius(r, m, rho_thresh, r_complete=np.inf):
    """(R, M, extrapolated) where the mean enclosed density first drops below rho_thresh (any consistent units).
    Past r_complete (the largest sphere the cutout covers) M(<r) is extrapolated as a power law fitted over
    0.5-1 r_complete. shortcut: power-law extrapolation, only R200m of the biggest halos needs it."""
    o = np.argsort(r)
    rs, cm = r[o], np.cumsum(m[o])
    ok = (rs > 0) & (rs <= r_complete)
    rs, cm = rs[ok], cm[ok]
    rho = cm / (4 / 3 * np.pi * rs ** 3)
    below = np.nonzero((rho < rho_thresh) & (rs > rs[min(100, rs.size - 1)]))[0]
    if below.size:
        i = below[0]
        # log-linear interpolation of mean density between particle i-1 and i
        x0, x1 = np.log(rs[i - 1]), np.log(rs[i])
        y0, y1 = np.log(rho[i - 1]), np.log(rho[i])
        R = float(np.exp(x0 + (np.log(rho_thresh) - y0) * (x1 - x0) / (y1 - y0)))
        return R, float(rho_thresh * 4 / 3 * np.pi * R ** 3), False
    sel = rs > 0.5 * rs[-1]
    alpha = np.polyfit(np.log(rs[sel]), np.log(cm[sel]), 1)[0]
    R = float(rs[-1] * (rho[-1] / rho_thresh) ** (1.0 / (3.0 - alpha)))
    return R, float(rho_thresh * 4 / 3 * np.pi * R ** 3), True


def t200(m200_msun: float, r200_kpc: float, mu: float = MU) -> float:
    return mu * M_P_G * G_CGS * m200_msun * MSUN_G / (2 * K_B * r200_kpc * KPC_CM)


def half_mass_radius(r, m) -> float:
    o = np.argsort(r)
    cm = np.cumsum(m[o])
    return float(r[o][np.searchsorted(cm, 0.5 * cm[-1])])


def stellar_frame(pos, vel, mass, v_bulk) -> dict:
    """Signed stellar-spin frame: z = L of the given stars about v_bulk; x = projected major axis (mass-weighted
    second moment in the disk plane), sign: largest |box component| positive; y = z cross x. Returns R (rows x, y, z)."""
    L = np.sum(np.cross(pos, (vel - v_bulk) * mass[:, None]), axis=0)
    z = unit(L)
    pp = pos - np.outer(pos @ z, z)
    w, V = np.linalg.eigh((pp * mass[:, None]).T @ pp)
    x = unit(V[:, np.argmax(w)] - np.dot(V[:, np.argmax(w)], z) * z)
    if x[np.argmax(np.abs(x))] < 0:
        x = -x
    y = np.cross(z, x)
    return {"R": np.array([x, y, z]), "L": L}


def frame_of_cutout(coords, rotated, centre, box) -> np.ndarray:
    """3x3 matrix (rows) mapping box offsets to the cutout's RotatedCoordinates (affine least squares)."""
    x = _wrap(coords - centre, box)
    A = np.hstack([x, np.ones((x.shape[0], 1))])
    coef, *_ = np.linalg.lstsq(A, rotated, rcond=None)
    return coef[:3].T


def phase_masses(logT, m, sel, d=None) -> dict:
    d = d or definitions.load()
    out = {}
    for c in d["phases"]["schemes"]["three"]["classes"]:
        lo = -np.inf if c["logT_min"] is None else c["logT_min"]
        hi = np.inf if c["logT_max"] is None else c["logT_max"]
        out[c["id"]] = float(m[sel & (logT >= lo) & (logT < hi)].sum())
    return out


def _read(f, pt, field, idx=None):
    a = f[f"PartType{pt}"][field]
    return a[()] if idx is None else a[()][idx]


def host_of(sid: int, cat: dict) -> int | None:
    """The FoF central of a satellite of the sample: the sample central with the same group M200c and R200c (the host
    catalogue stores the FoF group's values for satellites). None when the central is not in the sample.
    The cutout cannot tell: the 4 matched hosts sit 600-950 kpc away, outside the +-400 ckpc cube."""
    i = int(np.nonzero(cat["SubfindID"] == sid)[0][0])
    m = np.nonzero((cat["HaloMass_M200c"] == cat["HaloMass_M200c"][i]) & (cat["HaloVirialRadius_R200c"] == cat["HaloVirialRadius_R200c"][i])
                   & (cat["FlagCentral"] == 1) & (cat["SubfindID"] != sid))[0]
    return int(cat["SubfindID"][m[0]]) if m.size == 1 else None


def measure(src: Path, sid: int, row: dict, host: int | None = None) -> dict:
    """The registry record body for one galaxy (see module docstring). row = galaxy.catalogue_row(sid); host = the FoF
    central of a satellite (host_of) when known."""
    import h5py
    d = definitions.load()
    t0 = time.time()
    with h5py.File(src, "r") as f:
        hd = dict(f["Header"].attrs)
        h, box = float(hd["HubbleParam"]), float(hd["BoxSize"])
        om0 = float(hd["Omega0"])
        if int(hd["SubfindID_This_Snapshot"]) != sid:
            raise RuntimeError(f"{src}: SubfindID_This_Snapshot != {sid}")
        mt = hd["MassTable"]
        centre, vel, nmem, _ = _members(f, sid, mt)

        def offs(pt, c=centre):
            return _wrap(_read(f, pt, "Coordinates") - c, box)        # ckpc/h

        x0 = offs(0)
        r_complete = float(min(x0.max(0).min(), (-x0.min(0)).min()))   # ckpc/h
        m0 = _read(f, 0, "Masses").astype(np.float64)
        parts = {0: (x0, m0)}
        for pt in (1, 4, 5):
            if f"PartType{pt}" not in f or "Coordinates" not in f[f"PartType{pt}"]:
                continue
            x = offs(pt)
            mm = (_read(f, pt, "Masses").astype(np.float64) if "Masses" in f[f"PartType{pt}"]
                  else np.full(len(x), float(mt[pt])))
            parts[pt] = (x, mm)
        rall = np.concatenate([np.linalg.norm(p[0], axis=1) for p in parts.values()])
        mall = np.concatenate([p[1] for p in parts.values()])
        so = {}
        for key, rho in (("R200c", 200 * RHO_CRIT_CODE), ("R200m", 200 * om0 * RHO_CRIT_CODE),
                         ("Rvir_BN", delta_bn(om0) * RHO_CRIT_CODE)):
            R, M, ex = so_radius(rall, mall, rho, r_complete)
            so[key] = {"R_kpc": R / h, "M_Msun": M * 1e10 / h, "extrapolated": ex}
        r200 = so["R200c"]["R_kpc"]
        del rall, mall

        # gas (physical kpc, km/s, Msun)
        xg = x0 / h
        rg = np.linalg.norm(xg, axis=1)
        mg = m0 * 1e10 / h
        vg = _read(f, 0, "Velocities").astype(np.float64)
        subg = _read(f, 0, "SubfindID")
        sfr = _read(f, 0, "StarFormationRate").astype(np.float64)
        sf = sfr > 0
        XH = _read(f, 0, "GFM_Metals")[:, 0].astype(np.float64)
        T = temperature(_read(f, 0, "InternalEnergy"), _read(f, 0, "ElectronAbundance").astype(np.float64), XH)
        logT = np.log10(T)
        rho = _read(f, 0, "Density").astype(np.float64) * (1e10 * MSUN_G / h) / (KPC_CM / h) ** 3
        nH = rho * np.clip(XH, 0.5, 0.76) / M_H_G
        # stars (no wind particles)
        xs = parts[4][0] / h
        rs = np.linalg.norm(xs, axis=1)
        ms = parts[4][1] * 1e10 / h
        vs = _read(f, 4, "Velocities").astype(np.float64)
        bound_s = (_read(f, 4, "SubfindID") == sid) & (_read(f, 4, "GFM_StellarFormationTime") > 0)
        # cutout frame (stars)
        k = np.unique(np.linspace(0, len(xs) - 1, min(4000, len(xs))).astype(int))
        Rcut = frame_of_cutout(_read(f, 4, "Coordinates", k), _read(f, 4, "RotatedCoordinates", k), centre, box)
    rhalf = half_mass_radius(rs[bound_s], ms[bound_s])
    s10 = bound_s & (rs < d["frame"]["stellar_L"]["bulk_velocity_r_kpc"])
    vbulk = np.average(vs[s10], weights=ms[s10], axis=0)
    ap = bound_s & (rs < d["frame"]["stellar_L"]["aperture_rhalf"] * rhalf)
    fr = stellar_frame(xs[ap], vs[ap], ms[ap], vbulk)
    Lst = fr["L"]
    # cold gas (the explorer's recipe) and SF gas
    aper = max(APER_FRAC * r200, APER_MIN_KPC)
    cold = ((T < COLD_T_MAX) | (nH > COLD_NH_MIN)) & (rg < aper)
    ang_cold = None
    if cold.sum() >= SF_MIN_CELLS:
        vc = np.average(vg[cold], weights=mg[cold], axis=0)
        ang_cold = angle(np.sum(np.cross(xg[cold], (vg[cold] - vc) * mg[cold, None]), axis=0), Lst)
    sfa = sf & (subg == sid) & (rg < d["frame"]["alternatives"]["sf_gas_L"]["aperture_rhalf"] * rhalf)
    ang_sf = (angle(np.sum(np.cross(xg[sfa], (vg[sfa] - vbulk) * mg[sfa, None]), axis=0), Lst)
              if sfa.sum() >= SF_MIN_CELLS else None)
    # about half the cutouts' rotations are improper (det -1, a reflection): z of the matrix is still the axis
    zc = unit(Rcut[2])
    ang_cut = angle(Lst, zc)
    cut_det = float(np.sign(np.linalg.det(Rcut)))
    # satellites, phases
    central = bool(row["FlagCentral"])
    host_c = sid if central else host
    sat = (subg != sid) & (subg != (sid if host_c is None else host_c)) & (subg >= 0)
    shell = (rg >= 0.15 * r200) & (rg < r200)
    cgm = shell & ~sf
    sat_frac = float(mg[shell & sat].sum() / mg[shell].sum())
    lim = r_complete / h
    outsk = (rg >= r200) & (rg < 2 * r200) & ~sf
    bound_g = subg == sid
    rec_masses = {
        "cgm": phase_masses(logT, mg, cgm, d),
        "cgm_exclude_bound": phase_masses(logT, mg, cgm & ~sat, d),
        "ism": float(mg[(sf & (rg < r200)) | (rg < 0.15 * r200)].sum()),
        "outskirts": phase_masses(logT, mg, outsk, d),
        "outskirts_complete": bool(2 * r200 <= lim),
        "cgm_sf_excluded": float(mg[shell & sf].sum()),
    }
    rec_masses["cgm"]["total"] = float(sum(rec_masses["cgm"].values()))
    t200_K = t200(so["R200c"]["M_Msun"], r200)
    flags = {
        "fof_satellite": not central,
        "host_unknown": host_c is None,
        "no_sf_gas": not bool((sf & bound_g).any()),
        "few_sf_cells": ang_sf is None,
        "misaligned_cold": ang_cold is not None and ang_cold > d["frame"]["misalignment_flag_deg"],
        "misaligned_sf": ang_sf is not None and ang_sf > d["frame"]["misalignment_flag_deg"],
        "R200m_extrapolated": so["R200m"]["extrapolated"],
        "R200c_beyond_cutout": r200 > lim,
        "outskirts_incomplete": not rec_masses["outskirts_complete"],
    }
    s30 = bound_s & (rs < 30)
    rec = {
        "sim": SIM, "snap": SNAP, "subhalo_id": sid,
        "central": central,
        "host_subhalo_id": host_c,
        "pos_kpc": (centre / h).tolist(),
        "vel_kms": vel.tolist(),
        "so": {k: {"R_kpc": v["R_kpc"], "M_Msun": v["M_Msun"], "extrapolated": v["extrapolated"]} for k, v in so.items()},
        "T200_K": t200_K,
        "rhalf_star_kpc": rhalf,
        "Mstar_Msun": float(ms[bound_s].sum()),
        "Mstar_30kpc_Msun": float(ms[s30].sum()),
        "Mstar_2rhalf_Msun": float(ms[ap].sum()),
        "Mgas_Msun": float(mg[bound_g].sum()),
        "SFR_Msun_yr": float(sfr[bound_g].sum()),
        "frame": {
            "R": fr["R"].tolist(),
            "v_bulk_kms": vbulk.tolist(),
            "n_stars": int(ap.sum()),
            "aperture_kpc": 2 * rhalf,
        },
        "misalignment_deg": {"cold_gas": ang_cold, "sf_gas": ang_sf, "tng_cutout_raw": ang_cut,
                             "tng_cutout": fold(ang_cut)},
        "tng_cutout_handedness": int(cut_det),
        "sat_gas_frac": sat_frac,
        "masses_Msun": rec_masses,
        "r_complete_kpc": lim,
        "flags": flags,
        "catalogue": {"R200c_kpc": float(row["HaloVirialRadius_R200c"]), "M200c_Msun": float(row["HaloMass_M200c"]),
                      "Mstar_30kpc_Msun": float(row["StellarMass_30kpc"]), "Mstar_all_Msun": float(row["StellarMass_all"]),
                      "Mstar_2rh_Msun": float(row["StellarMass_2rh"]), "SFR_inst_Msun_yr": float(row["SFR_inst"]),
                      "SFR_50Myr_Msun_yr": float(row["SFR_50Myr"]), "FlagCentral": bool(row["FlagCentral"])},
        "n_members": {f"PartType{k}": v for k, v in nmem.items()},
        "wall_s": round(time.time() - t0, 1),
    }
    return rec


def record(body: dict, src: Path) -> dict:
    """Wrap a measure() body with schema id, slug, units and provenance."""
    dl = src.with_name(src.name + ".download.json")
    meta = json.loads(dl.read_text()) if dl.is_file() else {}
    return {
        "schema": SCHEMA_ID,
        "slug": slug(body["sim"], body["snap"], body["subhalo_id"]),
        **{k: v for k, v in body.items() if k != "wall_s"},
        "units": {"length": "kpc physical", "mass": "Msun", "velocity": "km/s", "T": "K", "SFR": "Msun/yr",
                  "angle": "deg"},
        "provenance": {
            "source": meta.get("source_url", f"mwm31s_cutouts/{body['subhalo_id']}"),
            "sha256": meta.get("sha256"),
            "definitions": definitions.load()["version"],
            "built": time.strftime("%Y-%m-%d", time.gmtime()),
            "methods": {
                "pos_vel": "SubhaloPos = minimum-potential bound particle; SubhaloVel = mass-weighted mean of bound particles (all types)",
                "so": "spherical overdensity about pos_kpc, all particle types in the cutout",
                "Mstar": "bound stars, no wind particles (all, < 30 kpc, < 2 r_1/2)",
                "Mgas_SFR": "bound gas (SubfindID == id)",
                "host": "FoF central of a satellite: the sample central with the same catalogue group M200c and R200c; null if not in the sample",
                "catalogue": "mwm31s_hostcatalog.hdf5 (Pillepich+24); R200c/M200c there are the FoF group's",
            },
            "citations": CITE,
        },
    }


# ------------------------------------------------------------------- schema (the subset tests/js engine.js reads)
def _type_of(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    return {float: "number", str: "string", list: "array", dict: "object"}[type(v)]


def schema_errors(schema, value, root=None, path="$", out=None) -> list[str]:
    """Python twin of docs/.../engine.js schemaErrors (JSON Schema subset; no dependency)."""
    root = schema if root is None else root
    out = [] if out is None else out
    if schema is True or schema is None:
        return out
    if "$ref" in schema:
        return schema_errors(root["$defs"][schema["$ref"].split("/")[-1]], value, root, path, out)
    if "type" in schema:
        t, want = _type_of(value), schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(w == t or (w == "number" and t == "integer") for w in want):
            out.append(f"{path}: expected {want}, got {t}")
            return out
    if "const" in schema and schema["const"] != value:
        out.append(f"{path}: must be {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        out.append(f"{path}: {value!r} not in enum")
    if isinstance(value, str) and "pattern" in schema and not re.search(schema["pattern"], value):
        out.append(f"{path}: {value!r} does not match {schema['pattern']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            out.append(f"{path}: below {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            out.append(f"{path}: above {schema['maximum']}")
        if "exclusiveMinimum" in schema and not value > schema["exclusiveMinimum"]:
            out.append(f"{path}: must be > {schema['exclusiveMinimum']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            out.append(f"{path}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            out.append(f"{path}: more than {schema['maxItems']} items")
        if "items" in schema:
            for i, v in enumerate(value):
                schema_errors(schema["items"], v, root, f"{path}[{i}]", out)
    if isinstance(value, dict):
        out += [f"{path}: missing {k}" for k in schema.get("required", []) if k not in value]
        props, extra = schema.get("properties", {}), schema.get("additionalProperties")
        for k, v in value.items():
            if k in props:
                schema_errors(props[k], v, root, f"{path}.{k}", out)
            elif extra is False:
                out.append(f"{path}: unknown key {k}")
            elif isinstance(extra, dict):
                schema_errors(extra, v, root, f"{path}.{k}", out)
    return out


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def _round(o, sig=7, key=None):
    if key == "pos_kpc":                       # box positions: keep 0.1 pc
        return [round(float(v), 4) for v in o]
    if isinstance(o, float):
        return float(f"{o:.{sig}g}") if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _round(v, sig, k) for k, v in o.items()}
    if isinstance(o, list):
        return [_round(v, sig) for v in o]
    return o


def write(rec: dict, out: Path) -> Path:
    errs = schema_errors(load_schema(), rec)
    if errs:
        raise ValueError(f"{rec.get('slug')}: schema errors: {errs[:5]}")
    out.mkdir(parents=True, exist_ok=True)
    p = out / f"{rec['slug']}.json"
    p.write_text(json.dumps(rec, separators=(",", ":")) + "\n")
    return p


def load(slug_or_id, out: Path = OUT_DEFAULT) -> dict:
    if isinstance(slug_or_id, str) and "-" in slug_or_id:
        s = slug_or_id
    elif isinstance(slug_or_id, str) and slug_or_id in FIRE2_IDS:
        s = slug(FIRE2_SIM, FIRE2_SNAP, slug_or_id)
    else:
        s = slug(SIM, SNAP, int(slug_or_id))
    return json.loads((Path(out) / f"{s}.json").read_text())


def fire2_root() -> Path:
    import os
    from . import config
    v = os.environ.get("TNG_FIRE2_ROOT")
    if v:
        return Path(v).expanduser()
    cand = config.work_root() / "data" / "gal_fire2"
    if cand.is_dir():
        return cand
    return Path("/data/sborthak/cgm_absorber_requirements/fire2")


def measure_fire2(gdir: Path, hid: str) -> dict:
    """Measure the Phase-4 galaxy/1 registry record body for one FIRE-2 zoom-in halo from its slim cutout and galaxy.json."""
    import h5py
    d = definitions.load()
    t0 = time.time()
    gmeta_path = gdir / "galaxy.json"
    if not gmeta_path.is_file():
        gmeta_path = gdir / "record.json"
    gmeta = json.loads(gmeta_path.read_text())
    src = gdir / "cutout_slim_R400.hdf5"
    with h5py.File(src, "r") as f:
        hd = dict(f["Header"].attrs)
        h = float(hd.get("HubbleParam", gmeta["TNG_H"]))
        om0 = float(hd.get("Omega0", 0.272))
        centre_kpc = np.asarray(gmeta["center_kpc"], dtype=np.float64)
        vel_kms = np.asarray(gmeta["SubhaloVel_kms"], dtype=np.float64)

        xg = _read(f, 0, "Coordinates").astype(np.float64) / h - centre_kpc
        rg = np.linalg.norm(xg, axis=1)
        mg = _read(f, 0, "Masses").astype(np.float64) * 1e10 / h
        vg = _read(f, 0, "Velocities").astype(np.float64)
        XH = _read(f, 0, "GFM_Metals")[:, 0].astype(np.float64)
        T = temperature(_read(f, 0, "InternalEnergy"), _read(f, 0, "ElectronAbundance").astype(np.float64), XH)
        logT = np.log10(T)
        rho = _read(f, 0, "Density").astype(np.float64) * (1e10 * MSUN_G / h) / (KPC_CM / h) ** 3
        nH = rho * np.clip(XH, 0.5, 0.76) / M_H_G
        if "StarFormationRate" in f["PartType0"]:
            sfr_arr = _read(f, 0, "StarFormationRate").astype(np.float64)
            sf = sfr_arr > 0
        else:
            sfr_arr = None
            sf = np.zeros(len(rg), dtype=bool)

        xs = _read(f, 4, "Coordinates").astype(np.float64) / h - centre_kpc
        rs = np.linalg.norm(xs, axis=1)
        ms = _read(f, 4, "Masses").astype(np.float64) * 1e10 / h
        vs = _read(f, 4, "Velocities").astype(np.float64)
        sft_key = "GFM_StellarFormationTime" if "GFM_StellarFormationTime" in f["PartType4"] else "StellarFormationTime"
        sft = _read(f, 4, sft_key).astype(np.float64)

    rho_crit = RHO_CRIT_0_H2_MSUN_KPC3 * (h ** 2)
    m200c = float(gmeta["M200c_Msun"])
    r200 = float(gmeta["R200c_kpc"])
    mvir = float(gmeta.get("Mvir_Msun") or gmeta.get("catalogue", {}).get("HaloMass_Mdyn") or m200c)
    rvir = float((3.0 * mvir / (4.0 * math.pi * delta_bn(om0) * rho_crit)) ** (1.0 / 3.0))
    m200m = float(gmeta.get("M200m_Msun") or mvir)
    r200m = float(gmeta.get("R200m_kpc") or (3.0 * m200m / (4.0 * math.pi * 200.0 * om0 * rho_crit)) ** (1.0 / 3.0))
    lim = 400.0
    so = {
        "R200c": {"R_kpc": r200, "M_Msun": m200c, "extrapolated": False},
        "R200m": {"R_kpc": r200m, "M_Msun": m200m, "extrapolated": bool(r200m > lim)},
        "Rvir_BN": {"R_kpc": rvir, "M_Msun": mvir, "extrapolated": bool(rvir > lim)},
    }

    r_gal = max(0.15 * r200, 20.0)
    bound_s = (rs < r_gal) & (sft > 0)
    if not bound_s.any():
        bound_s = sft > 0
    rhalf = half_mass_radius(rs[bound_s], ms[bound_s])
    s10 = bound_s & (rs < d["frame"]["stellar_L"]["bulk_velocity_r_kpc"])
    vbulk = np.average(vs[s10], weights=ms[s10], axis=0) if s10.any() else np.average(vs[bound_s], weights=ms[bound_s], axis=0)
    ap = bound_s & (rs < d["frame"]["stellar_L"]["aperture_rhalf"] * rhalf)
    if ap.sum() < 3:
        ap = bound_s
    fr = stellar_frame(xs[ap], vs[ap], ms[ap], vbulk)
    Lst = fr["L"]

    aper = max(APER_FRAC * r200, APER_MIN_KPC)
    cold = ((T < COLD_T_MAX) | (nH > COLD_NH_MIN)) & (rg < aper)
    ang_cold = None
    if cold.sum() >= SF_MIN_CELLS:
        vc = np.average(vg[cold], weights=mg[cold], axis=0)
        ang_cold = angle(np.sum(np.cross(xg[cold], (vg[cold] - vc) * mg[cold, None]), axis=0), Lst)

    bound_g = rg < r200
    sfa = sf & bound_g & (rg < d["frame"]["alternatives"]["sf_gas_L"]["aperture_rhalf"] * rhalf)
    ang_sf = (angle(np.sum(np.cross(xg[sfa], (vg[sfa] - vbulk) * mg[sfa, None]), axis=0), Lst)
              if sfa.sum() >= SF_MIN_CELLS else None)

    lhat_cat = np.asarray(gmeta.get("Lhat", fr["R"][2]), dtype=np.float64)
    ang_cut = angle(Lst, lhat_cat)
    cut_det = 1

    shell = (rg >= 0.15 * r200) & (rg < r200)
    cgm = shell & ~sf
    outsk = (rg >= r200) & (rg < 2 * r200) & ~sf
    cgm_phases = phase_masses(logT, mg, cgm, d)
    rec_masses = {
        "cgm": {**cgm_phases, "total": float(sum(cgm_phases.values()))},
        "cgm_exclude_bound": dict(cgm_phases),
        "ism": float(mg[(sf & (rg < r200)) | (rg < 0.15 * r200)].sum()),
        "outskirts": phase_masses(logT, mg, outsk, d),
        "outskirts_complete": bool(2 * r200 <= lim),
        "cgm_sf_excluded": float(mg[shell & sf].sum()),
    }
    t200_K = t200(m200c, r200)
    sfr_val = float(sfr_arr[bound_g].sum()) if sfr_arr is not None and sfr_arr[bound_g].sum() > 0 else float(gmeta["SFR_Msun_yr"])
    no_sf = not bool((sf & bound_g).any()) and (sfr_val <= 0.0)
    flags = {
        "fof_satellite": False,
        "host_unknown": False,
        "no_sf_gas": no_sf,
        "few_sf_cells": ang_sf is None,
        "misaligned_cold": ang_cold is not None and ang_cold > d["frame"]["misalignment_flag_deg"],
        "misaligned_sf": ang_sf is not None and ang_sf > d["frame"]["misalignment_flag_deg"],
        "R200m_extrapolated": so["R200m"]["extrapolated"],
        "R200c_beyond_cutout": r200 > lim,
        "outskirts_incomplete": not rec_masses["outskirts_complete"],
    }
    s30 = (rs < 30.0) & (sft > 0)
    mstar_bound = float(ms[bound_s].sum())
    mstar_30 = float(ms[s30].sum())
    mstar_2rh = float(ms[ap].sum())
    cat_meta = gmeta.get("catalogue", {})
    nmem = gmeta.get("checks", {}).get("n_members") or {"PartType0": int(len(rg)), "PartType4": int(len(rs))}
    return {
        "sim": FIRE2_SIM, "snap": FIRE2_SNAP, "subhalo_id": hid,
        "central": True,
        "host_subhalo_id": hid,
        "pos_kpc": centre_kpc.tolist(),
        "vel_kms": vel_kms.tolist(),
        "so": so,
        "T200_K": t200_K,
        "rhalf_star_kpc": rhalf,
        "Mstar_Msun": mstar_bound,
        "Mstar_30kpc_Msun": mstar_30,
        "Mstar_2rhalf_Msun": mstar_2rh,
        "Mgas_Msun": float(mg[bound_g].sum()),
        "SFR_Msun_yr": sfr_val,
        "frame": {
            "R": fr["R"].tolist(),
            "v_bulk_kms": vbulk.tolist(),
            "n_stars": int(ap.sum()),
            "aperture_kpc": 2 * rhalf,
        },
        "misalignment_deg": {
            "cold_gas": ang_cold,
            "sf_gas": ang_sf,
            "tng_cutout_raw": ang_cut,
            "tng_cutout": fold(ang_cut),
        },
        "tng_cutout_handedness": int(cut_det),
        "sat_gas_frac": 0.0,
        "masses_Msun": rec_masses,
        "r_complete_kpc": lim,
        "flags": flags,
        "catalogue": {
            "R200c_kpc": r200,
            "M200c_Msun": m200c,
            "Mstar_30kpc_Msun": mstar_30,
            "Mstar_all_Msun": mstar_bound,
            "Mstar_2rh_Msun": mstar_2rh,
            "SFR_inst_Msun_yr": sfr_val,
            "SFR_50Myr_Msun_yr": float(cat_meta.get("SFR_50Myr", sfr_val)),
            "FlagCentral": True,
        },
        "n_members": {str(k): int(v) for k, v in nmem.items()},
        "wall_s": round(time.time() - t0, 1),
    }


def record_fire2(body: dict, gdir: Path) -> dict:
    """Wrap a measure_fire2() body with schema id, slug, units and FIRE-2 provenance."""
    gmeta_path = gdir / "galaxy.json"
    if not gmeta_path.is_file():
        gmeta_path = gdir / "record.json"
    gmeta = json.loads(gmeta_path.read_text()) if gmeta_path.is_file() else {}
    sim_dir = Path(gmeta.get("source", {}).get("sim_dir", ""))
    sim_run = gmeta.get("sim_run", body["subhalo_id"])
    dl = sim_dir / "DONE.download.json" if sim_dir.is_dir() else Path("/nonexistent")
    dl_meta = json.loads(dl.read_text()) if dl.is_file() else {}
    sha = None
    for fentry in dl_meta.get("files", []):
        if fentry.get("filename", "").startswith("halo_600.hdf5") and fentry.get("sha256"):
            sha = fentry["sha256"]
            break
    if not sha and (sim_dir / "halo_600.hdf5").is_file():
        import hashlib
        sha = hashlib.sha256((sim_dir / "halo_600.hdf5").read_bytes()).hexdigest()
    base_url = dl_meta.get("base_url") or f"https://users.flatironinstitute.org/~mgrudic/fire2_public_release/core/{sim_run}"
    return {
        "schema": SCHEMA_ID,
        "slug": slug(body["sim"], body["snap"], body["subhalo_id"]),
        **{k: v for k, v in body.items() if k != "wall_s"},
        "units": {"length": "kpc physical", "mass": "Msun", "velocity": "km/s", "T": "K", "SFR": "Msun/yr",
                  "angle": "deg"},
        "provenance": {
            "source": base_url,
            "sha256": sha,
            "definitions": definitions.load()["version"],
            "built": time.strftime("%Y-%m-%d", time.gmtime()),
            "methods": {
                "pos_vel": "iterative shrinking-sphere maximum stellar density + minimum Potential within 30 kpc of Rockstar host; velocity = mass-weighted mean of stars within 15 kpc",
                "so": "Rockstar halo_600.hdf5 M200c, Mvir (Bryan & Norman 1998), and M200m spherical overdensities about the host",
                "Mstar": "stars within max(0.15 R200c, 20 kpc), < 30 kpc, and < 2 r_1/2",
                "Mgas_SFR": "gas within R200c; instantaneous StarFormationRate or 100 Myr stellar mass formed",
                "host": "isolated central or Elvis Local Group paired central (central = true, host_subhalo_id = subhalo_id)",
                "catalogue": "Rockstar halo_600.hdf5 + star_600.hdf5 (Wetzel+23 FIRE-2 public data release)",
            },
            "citations": FIRE2_CITE,
        },
    }


def _build_fire2_one(args):
    hid, root_str, out_str = args
    gdir = Path(root_str) / str(hid)
    body = measure_fire2(gdir, str(hid))
    p = write(_round(record_fire2(body, gdir)), Path(out_str))
    return hid, body["so"]["R200c"]["R_kpc"], body["T200_K"], p.name, body["wall_s"]


def build_fire2(ids=None, out: Path = OUT_DEFAULT, root: Path | None = None, workers: int = 1) -> None:
    import multiprocessing as mp
    ids = list(ids or FIRE2_IDS)
    froot = Path(root) if root else fire2_root()
    tasks = [(str(hid), str(froot), str(out)) for hid in ids]
    if workers > 1 and len(tasks) > 1:
        with mp.get_context("spawn").Pool(min(workers, len(tasks))) as pool:
            for hid, r200, t200_val, pname, wall in pool.imap_unordered(_build_fire2_one, tasks):
                print(f"{hid}: R200c {r200:.2f} T200 {t200_val:.3g} -> {pname} [{wall} s]", flush=True)
    else:
        for t in tasks:
            hid, r200, t200_val, pname, wall = _build_fire2_one(t)
            print(f"{hid}: R200c {r200:.2f} T200 {t200_val:.3g} -> {pname} [{wall} s]", flush=True)


def build(ids, out: Path) -> None:
    from . import galaxy as G
    cat = G.read_catalogue()
    for sid in ids:
        row = G.catalogue_row(sid, cat)
        src = G.source_cutout(sid)
        host = None if row["FlagCentral"] else host_of(sid, cat)
        body = measure(src, sid, row, host)
        p = write(_round(record(body, src)), out)
        print(f"{sid}: R200c {body['so']['R200c']['R_kpc']:.2f} (cat {row['HaloVirialRadius_R200c']:.2f}) "
              f"T200 {body['T200_K']:.3g} -> {p.name} [{body['wall_s']} s]", flush=True)


def check(out: Path) -> dict:
    """Cross-checks of every record against the catalogue (and the d8 summary when given)."""
    sch = load_schema()
    all_recs = [json.loads(p.read_text()) for p in sorted(Path(out).glob("*.json"))]
    recs = [r for r in all_recs if r.get("sim") == SIM]
    fire2_recs = [r for r in all_recs if r.get("sim") == FIRE2_SIM]
    rep = {
        "n": len(all_recs),
        "n_tng50": len(recs),
        "n_fire2": len(fire2_recs),
        "schema_errors": {r["slug"]: e for r in all_recs if (e := schema_errors(sch, r))},
    }
    cen = [r for r in all_recs if r["central"]]

    def rel(a, b):
        return a / b - 1.0
    dr = np.array([rel(r["so"]["R200c"]["R_kpc"], r["catalogue"]["R200c_kpc"]) for r in cen])
    dm = np.array([rel(r["so"]["R200c"]["M_Msun"], r["catalogue"]["M200c_Msun"]) for r in cen])
    rep["centrals_R200c_rel"] = {"max_abs": float(np.abs(dr).max()), "median": float(np.median(dr)),
                                 "n_over_0.1pct": int((np.abs(dr) > 1e-3).sum())}
    rep["centrals_M200c_rel"] = {"max_abs": float(np.abs(dm).max()), "median": float(np.median(dm))}
    by = {r["subhalo_id"]: r for r in recs}
    rep["satellites"] = []
    for r in recs:
        if r["central"]:
            continue
        e = {"id": r["subhalo_id"], "host": r["host_subhalo_id"], "R200c_own": r["so"]["R200c"]["R_kpc"],
             "R200c_cat_group": r["catalogue"]["R200c_kpc"]}
        hr = by.get(r["host_subhalo_id"])
        if hr:
            d = np.subtract(r["pos_kpc"], hr["pos_kpc"])
            box = 35000.0 / 0.6774
            e.update(host_R200c_recomputed=hr["so"]["R200c"]["R_kpc"],
                     host_dist_kpc=float(np.linalg.norm(d - box * np.round(d / box))))
        rep["satellites"].append(e)
    for key, ck in (("Mstar_30kpc_Msun", "Mstar_30kpc_Msun"), ("Mstar_Msun", "Mstar_all_Msun"),
                    ("Mstar_2rhalf_Msun", "Mstar_2rh_Msun"), ("SFR_Msun_yr", "SFR_inst_Msun_yr")):
        v = np.array([rel(r[key], r["catalogue"][ck]) for r in all_recs if r["catalogue"].get(ck, 0) > 0])
        rep[f"{key}_vs_{ck}"] = {"median": float(np.median(v)), "p05": float(np.percentile(v, 5)),
                                 "p95": float(np.percentile(v, 95)), "max_abs": float(np.abs(v).max())}
    rep["flags"] = {k: [r["subhalo_id"] for r in all_recs if r["flags"][k]] for k in all_recs[0]["flags"]} if all_recs else {}
    return rep


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m tngsight.registry")
    ap.add_argument("cmd", choices=("build", "build_fire2", "check"))
    ap.add_argument("--sim", choices=("tng50", "fire2", "all"), default="tng50")
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--chunk", help="i/n: build the i-th of n chunks of the sample (SLURM arrays)")
    ap.add_argument("--workers", type=int, default=1, help="Parallel worker processes for FIRE-2 build")
    ap.add_argument("--fire2-root", type=Path, default=None, help="FIRE-2 galaxy root directory")
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    a = ap.parse_args(argv)
    if a.cmd == "check":
        print(json.dumps(check(a.out), indent=1))
        return 0
    if a.cmd == "build_fire2" or a.sim == "fire2":
        ids = [str(x) for x in a.ids] if a.ids else list(FIRE2_IDS)
        if a.chunk:
            i, n = map(int, a.chunk.split("/"))
            ids = ids[i::n]
        build_fire2(ids, a.out, root=a.fire2_root, workers=a.workers)
        return 0
    from . import galaxy as G
    ids = [int(x) for x in a.ids] if a.ids else G.sample_ids()
    if a.chunk:
        i, n = map(int, a.chunk.split("/"))
        ids = ids[i::n]
    build(ids, a.out)
    if a.sim == "all":
        fids = list(FIRE2_IDS)
        if a.chunk:
            i, n = map(int, a.chunk.split("/"))
            fids = fids[i::n]
        build_fire2(fids, a.out, root=a.fire2_root, workers=a.workers)
    return 0


if __name__ == "__main__":
    sys.exit(main())
