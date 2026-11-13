"""Per-galaxy product pipeline for the TNG50 MW/M31 sample (galaxy-sample spec, "Pipeline contract").

    python -m tngsight.galpipe <stage> --galaxy <id> [--root DIR] [--shard i/n] [--workers k] [--force]
    stages, in order: record slim import_sbi rays fits cubes web check   (also: all, status, regress --ref DIR)

Spectra source (spec revision 2026-11-12): every galaxy except 488530 takes its spectra from the SBI_CGM ray library
(`import_sbi`: a reproducible stratified subset of ~700 of its 53,248 rays -> our npz v2 + TNGS v2 bins, list in
library/rays.json, provenance in library/spectra_source.json; tngsight.sbi); `rays` then only checks completeness
(no tracing). 488530 keeps its Trident library (`import_sbi` is a no-op there unless --spectra sbi).

One galaxy per call; every stage is idempotent and resumable, writes <root>/<id>/DONE.<stage> (JSON: wall time, host,
peak RSS, versions) when complete and is skipped while that marker exists (unless --force). --root defaults to
config.gal_root() ($TNG_GAL_ROOT, else <work root>/data/gal). Inputs: the sample's published cutouts and host
catalogue under tngsight.galaxy.mwm31_root() ($TNG_MWM31_ROOT); never written.

1. record  galaxy.json: centre = position of the most bound member (minimum Potential over the cutout particles with
           SubfindID == id; Subfind's SubhaloPos definition), SubhaloVel = mass-weighted mean velocity of the members,
           R200c, M200c, M*, SFR and flags from the host catalogue, the disk frame from the cold-gas angular momentum
           (the recipe that made the 488530 frame: OVI_CGM_compare ovi_common.compute_orientation, T < 1.5e4 K or
           n_H > 0.1 cm^-3 within max(0.1 R200c, 10 kpc), mass-weighted, L about the cold-gas mass-weighted velocity;
           xhat = the major in-plane PCA axis of those cells, yhat = Lhat x xhat), frame checks and the source sha256.
2. slim    cutout_slim_R400.hdf5: PartType0 cells with r - hsml < 400 kpc (hsml = 2 (3 m / 4 pi rho)^(1/3)), the 9
           datasets of the 488530 slim cutout (src/slim_cutout.py recipe), its Header attributes; then the yt index
           <id>/library/cutout.ewah is built once (array tasks of the rays stage only read it).
3. rays    the 683 geometries of the 488530 library (tngsight/galaxy_rays.json: orientation, b, azimuth, seed) in
           this galaxy's frame; half length min(R200c, sqrt(395^2 - b^2)) so a ray never leaves the complete slim
           sphere; 12 lines, npz v2 (library/sightlines/<sid>.npz) + TNGS v2 (library/web/<sid>.bin). --shard i/n
           takes every n-th ray from i (0-based), so an array can split one galaxy.
4. fits    vpfit components (tngsight.components.fit_payload, the C1 params) per ray (library/components/<sid>.json,
           shardable), then catalog.json (scoring, ranks, showcase flags) and components.json once all are present.
5. cubes   deploy/data/build_volumes.py (nH, T, Z, 12 ions; then vx, vy, vz) at L0-L2 and deploy/data/build_stars.py
           (S0-S2, from the published cutout's PartType4), then `vizpack merge` -> viz/manifest_v2.json.
6. web     web/: catalog.json, s/<sid>.bin, components.json, galaxy.json (public fields + frame), viz/manifest_v2.json
           (cube paths relative to viz/), the layout scripts/export_tng50_web.py --galaxies consumes.
7. check   check.json: per-gate pass/fail (counts, finite spectra, column conservation, H I <= n_H, frame sanity).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import resource
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

STAGES = ("record", "slim", "import_sbi", "rays", "fits", "cubes", "web", "check")
SPECTRA_SOURCES = ("auto", "sbi", "trident")
ROOT_REPO = Path(__file__).resolve().parents[1]
RAYS_FILE = Path(__file__).resolve().parent / "galaxy_rays.json"
SLIM_NAME = "cutout_slim_R400.hdf5"
R_SLIM_KPC = 400.0
R_RAY_MAX_KPC = 395.0                     # = geometry.R_CUSTOM_MAX_KPC: ray endpoints stay inside the slim sphere
SLIM_FIELDS = ("Coordinates", "Masses", "Density", "Velocities", "InternalEnergy", "ElectronAbundance",
               "NeutralHydrogenAbundance", "GFM_Metals", "GFM_Metallicity")
# Header attributes of the 488530 slim cutout that the published mwm31s cutouts lack (TNG50-1 run constants, as in
# the full-snapshot header the 488530 slim was copied from). NumPart_* are recomputed.
HEADER_TEMPLATE = {"Composition_vector_length": np.int32(0), "Flag_Cooling": np.int32(1),
                   "Flag_DoublePrecision": np.int32(0), "Flag_Feedback": np.int32(1), "Flag_Metals": np.int32(0),
                   "Flag_Sfr": np.int32(1), "Flag_StellarAge": np.int32(0),
                   "Git_commit": np.bytes_(b"d203ec8b07c7e2bdda5f608aa0babea46d603699"),
                   "Git_date": np.bytes_(b"Thu Apr 7 14:14:27 2016 +0200"), "NumFilesPerSnapshot": np.int32(1)}
HEADER_KEYS = ("BoxSize", "Composition_vector_length", "Flag_Cooling", "Flag_DoublePrecision", "Flag_Feedback",
               "Flag_Metals", "Flag_Sfr", "Flag_StellarAge", "Git_commit", "Git_date", "HubbleParam", "MassTable",
               "NumFilesPerSnapshot", "NumPart_ThisFile", "NumPart_Total", "NumPart_Total_HighWord", "Omega0",
               "OmegaBaryon", "OmegaLambda", "Redshift", "Time", "UnitLength_in_cm", "UnitMass_in_g",
               "UnitVelocity_in_cm_per_s")
# cold-gas frame recipe (OVI_CGM_compare/analysis/ovi_common.py compute_orientation + extract.py, constants verbatim)
MSUN_G = 1.98847e33
KPC_CM = 3.0856775814913673e21
M_H_G = 1.6735575e-24
K_B = 1.380649e-16
GAMMA = 5.0 / 3.0
COLD_T_MAX = 1.5e4
COLD_NH_MIN = 0.1
APER_FRAC = 0.1
APER_MIN_KPC = 10.0
BBOX_HALF_CKPCH = 500.0                   # yt domain half width for unwrapped (boundary-straddling) slim cutouts
CUBE_HALF_CKPC = 400.0                    # published mwm31s cutouts: cube of half width 400 ckpc around the subhalo


# ============================================================================== small utilities
def log(msg):
    print(f"[galpipe {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def atomic_write(path: Path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data if isinstance(data, bytes) else data.encode())
    os.replace(tmp, path)


def dump_json(path: Path, obj, indent=1) -> None:
    atomic_write(path, json.dumps(obj, indent=indent, allow_nan=False) + "\n")


def sha256_file(path, chunk=1 << 24) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def peak_rss_gb() -> dict:
    s = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6
    c = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1e6
    return {"self": round(s, 2), "children_max": round(c, 2)}


def parse_shard(s):
    if not s:
        return 0, 1
    i, n = (int(x) for x in str(s).split("/"))
    if not (n >= 1 and 0 <= i < n):
        raise ValueError(f"--shard {s}: need 0 <= i < n")
    return i, n


class Galaxy:
    """Paths of one galaxy under the pipeline root."""

    def __init__(self, gid, root=None):
        from . import config
        self.id = int(gid)
        self.root = Path(root) if root else config.gal_root()
        self.dir = self.root / str(self.id)
        self.record = self.dir / "galaxy.json"
        self.slim = self.dir / SLIM_NAME
        self.lib = self.dir / "library"
        self.index = self.lib / "cutout.ewah"
        # yt never caches the Morton index of a single-chunk dataset (fewer than 64^3 cells); build_index then
        # writes this marker instead and index_ready() accepts either
        self.index_none = self.lib / "cutout.ewah.single_chunk"
        self.viz = self.dir / "viz"
        self.cache = self.dir / "viz_cache"
        self.web = self.dir / "web"
        self.logs = self.dir / "logs"

    def index_ready(self) -> bool:
        return self.index.is_file() or self.index_none.is_file()

    def done(self, stage) -> Path:
        return self.dir / f"DONE.{stage}"

    def is_done(self, stage) -> bool:
        return self.done(stage).is_file()

    def mark(self, stage, t0, **extra) -> None:
        rec = {"stage": stage, "galaxy": self.id, "finished": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "wall_s": round(time.time() - t0, 1), "host": socket.gethostname(), "peak_rss_gb": peak_rss_gb(),
               "slurm_job": os.environ.get("SLURM_JOB_ID"), **extra}
        dump_json(self.done(stage), rec)

    def load_record(self) -> dict:
        if not self.record.is_file():
            raise SystemExit(f"galaxy {self.id}: no {self.record}; run the record stage first")
        return json.loads(self.record.read_text())

    def source(self) -> Path:
        from . import galaxy as G
        return G.source_cutout(self.id)


def select_galaxy(g: Galaxy) -> dict:
    """Point this process (and every child it spawns) at the galaxy: TNG_GALAXY_JSON / TNG_CUTOUT / TNG_LIBRARY_DIR /
    TNG_INDEX_FILE in the environment, config.use_galaxy in-process. Returns the record."""
    from . import config
    os.environ["TNG_GALAXY_JSON"] = str(g.record)
    os.environ["TNG_CUTOUT"] = str(g.slim)
    os.environ["TNG_LIBRARY_DIR"] = str(g.lib)
    os.environ["TNG_INDEX_FILE"] = str(g.index)
    return config.use_galaxy(g.load_record())


def ray_list(g: "Galaxy | None" = None) -> list[dict]:
    """The galaxy's sightline list: <lib>/rays.json when the galaxy has one (SBI_CGM import: the selected subset),
    else the 683 library geometries of tngsight/galaxy_rays.json (Trident rays)."""
    p = sbi_rays_path(g) if g is not None else None
    d = json.loads((p if p is not None and p.is_file() else RAYS_FILE).read_text())
    cols = d["columns"]
    return [dict(zip(cols, r)) for r in d["rays"]]


def sbi_rays_path(g: "Galaxy") -> Path:
    return g.lib / "rays.json"


def is_sbi(g: "Galaxy") -> bool:
    """True when the galaxy's spectra come from the SBI_CGM import (its rays.json exists)."""
    return sbi_rays_path(g).is_file()


def done_info(g: "Galaxy", stage) -> dict:
    """The JSON body of DONE.<stage> ({} when missing or unreadable)."""
    try:
        return json.loads(g.done(stage).read_text())
    except (OSError, ValueError):
        return {}


def spectra_source(g: "Galaxy", choice="auto") -> str:
    """'sbi' or 'trident'. auto: a galaxy already imported -> sbi; else a source recorded outside library/ (the
    SPECTRA marker, DONE.import_sbi, or DONE.rays info.source == "sbi_cgm") -> that source, so deleting library/ for
    a reselect keeps an SBI galaxy SBI (review2 M3); Trident rays DONE -> trident; else 488530 (the shipped Trident
    library) -> trident and every other galaxy -> sbi (spec revision 2026-11-12)."""
    if choice in ("sbi", "trident"):
        return choice
    if is_sbi(g):
        return "sbi"
    mark = g.dir / "SPECTRA"
    if mark.is_file():
        v = mark.read_text().strip()
        if v in ("sbi", "trident"):
            return v
    if g.is_done("import_sbi"):
        return "sbi"
    if g.is_done("rays"):
        return "sbi" if (done_info(g, "rays").get("info") or {}).get("source") == "sbi_cgm" else "trident"
    from .config import DEFAULT_GALAXY_ID
    return "trident" if g.id == DEFAULT_GALAXY_ID else "sbi"


def mark_spectra(g: "Galaxy", src: str) -> None:
    """Record the galaxy's spectra source outside library/ (<id>/SPECTRA), read first by spectra_source."""
    if src in ("sbi", "trident") and not ((g.dir / "SPECTRA").is_file()
                                          and (g.dir / "SPECTRA").read_text().strip() == src):
        atomic_write(g.dir / "SPECTRA", src + "\n")


TMP_PATTERNS = (("sightlines", ".*.tmp.npz"), ("web", ".*.tmp"), ("components", ".*.tmp"), (".", ".*.tmp"))


def clean_stale_tmp(g: "Galaxy", min_age_s=3600.0) -> int:
    """Delete partial writes a killed task left in library/ (`.<sid>.<rand>.tmp.npz` from library.save_npz, `.x.<pid>.tmp`
    from atomic_write). They end in .npz, so a `*.npz` glob would count them (validate2_0). Only files older than
    min_age_s are removed, so a concurrent shard's in-flight write is never touched. Returns the number removed."""
    n, now = 0, time.time()
    for sub, pat in TMP_PATTERNS:
        d = g.lib / sub
        if not d.is_dir():
            continue
        for f in d.glob(pat):
            try:
                if now - f.stat().st_mtime >= min_age_s:
                    f.unlink()
                    n += 1
            except FileNotFoundError:
                pass
    if n:
        log(f"galaxy {g.id}: removed {n} stale partial write(s) under {g.lib}")
    return n


def ray_half_kpc(b_kpc, r200c) -> float:
    """±half length: R200c, shortened so the endpoints stay within R_RAY_MAX_KPC of the centre."""
    return float(min(float(r200c), math.sqrt(R_RAY_MAX_KPC ** 2 - float(b_kpc) ** 2)))


def ray_geometry(ray: dict, r200c: float) -> dict:
    """Full stored geometry dict (+ "id") of one library ray in the selected galaxy's frame."""
    from .geometry import make_sightline, geom_id
    if ray["orientation"] == "random" and ray.get("los_seed") is None:
        raise ValueError(f"{ray['id']}: a random ray needs a los_seed")
    sl = make_sightline(ray["orientation"], float(ray["b_kpc"]), float(ray["azimuth_deg"]), seed=ray.get("los_seed"),
                        half_kpc=ray_half_kpc(ray["b_kpc"], r200c))
    gid = geom_id(ray["orientation"], ray["b_kpc"], ray["azimuth_deg"], seed=ray["seed"])
    if gid != ray["id"]:
        raise RuntimeError(f"geometry id {gid} != {ray['id']}")
    return {**sl, "id": gid}


# ============================================================================== stage 1: record
def _members(f, gid, mass_table):
    """(centre ckpc/h, velocity km/s, n per type, total mass 1e10 Msun/h) of the Subfind members in the cutout."""
    best_pot, centre = np.inf, None
    P = np.zeros(3)
    M = 0.0
    n = {}
    for pt in (0, 1, 4, 5):
        key = f"PartType{pt}"
        if key not in f or "SubfindID" not in f[key]:
            continue
        g = f[key]
        sel = g["SubfindID"][()] == gid
        n[pt] = int(sel.sum())
        if not n[pt]:
            continue
        idx = np.nonzero(sel)[0]
        pot = g["Potential"][()][idx]
        j = int(np.argmin(pot))
        if pot[j] < best_pot:
            best_pot = float(pot[j])
            centre = np.asarray(g["Coordinates"][idx[j]], dtype=np.float64)
        v = g["Velocities"][()][idx].astype(np.float64)
        m = (g["Masses"][()][idx].astype(np.float64) if "Masses" in g
             else np.full(idx.size, float(mass_table[pt])))
        P += (m[:, None] * v).sum(0)
        M += float(m.sum())
    if centre is None:
        raise RuntimeError(f"no particle with SubfindID == {gid} in the cutout")
    return centre, P / M, n, M


def _wrap(d, box):
    return d - box * np.round(d / box)


def temperature(u_code, xe, X_H):
    """T [K] (extract.temperature, a = 1)."""
    u_cgs = np.asarray(u_code, float) * 1.0e10
    X_H = np.clip(np.asarray(X_H, float), 0.5, 0.76)
    xe = np.where(np.isfinite(xe), xe, 1.0)
    mu = 4.0 / (1.0 + 3.0 * X_H + 4.0 * X_H * xe)
    return (GAMMA - 1.0) * u_cgs * mu * M_H_G / K_B


# cold-gas frame reliability (fix3, validate2_1): the frame falls back to the stars in the aperture when the cold gas is
# too sparse, is an offset clump/stream rather than a disk around the subhalo, or barely rotates. Measured on the 198:
# 511920 (717 cold cells, |v_cen - SubhaloVel| = 362 km/s), 541218 (507, 132), 516101 (738, 194), 428177 (2985, 211),
# 482155 (5004, 150), 546870 (2735, 104), 588831 (1483, 156); 546114 (3902 cells, cold v_phi 46 km/s). Massive cold
# disks are never affected (487742: 125522 cells, offset 114 km/s, v_phi 159), nor is 488530 (208978, 33, 239).
FRAME_MIN_COLD = 1000          # fewer cold cells than this: no cold disk to define a frame
FRAME_MAX_DV_KMS = 100.0       # cold-gas mean velocity this far from SubhaloVel ...
FRAME_DV_MAX_COLD = 20000      # ... with fewer cold cells than this: an offset clump or stream, not the galaxy's disk
FRAME_MIN_VPHI_KMS = 60.0      # cold gas rotating slower than this about its own L: disturbed, no disk plane
FRAME_MIN_STARS = 100


def cold_frame_reliability(n_cold, dv_kms, vphi_kms) -> list[str]:
    """Reasons the cold-gas frame is unreliable ([] = reliable); see FRAME_* above."""
    why = []
    if n_cold < FRAME_MIN_COLD:
        why.append(f"{n_cold} cold cells < {FRAME_MIN_COLD}")
    if dv_kms is not None and dv_kms > FRAME_MAX_DV_KMS and n_cold < FRAME_DV_MAX_COLD:
        why.append(f"cold-gas mean velocity {dv_kms:.0f} km/s from SubhaloVel (> {FRAME_MAX_DV_KMS:.0f}) with "
                   f"{n_cold} < {FRAME_DV_MAX_COLD} cold cells")
    if vphi_kms is not None and vphi_kms < FRAME_MIN_VPHI_KMS:
        why.append(f"cold v_phi {vphi_kms:.0f} km/s < {FRAME_MIN_VPHI_KMS:.0f}")
    return why


def _frame_of(p, v, m) -> dict:
    vcen = np.average(v, weights=m, axis=0)
    L = np.sum(np.cross(p, (v - vcen) * m[:, None]), axis=0)
    zhat = L / np.linalg.norm(L)
    pp = p - np.outer(p @ zhat, zhat)
    evals, evecs = np.linalg.eigh(np.cov(pp.T, aweights=m))
    xhat = evecs[:, np.argsort(evals)[-1]]
    xhat = xhat - np.dot(xhat, zhat) * zhat
    xhat /= np.linalg.norm(xhat)
    yhat = np.cross(zhat, xhat)
    return {"Lhat": zhat.tolist(), "xhat": xhat.tolist(), "yhat": yhat.tolist(), "vcenter_kms": vcen.tolist()}


def cold_gas_frame(pos_kpc, vel_kms, mass_msun, rho_cgs, T_K, x_H, r200c, stars=None, v_ref=None) -> dict:
    """ovi_common.compute_orientation on the cold gas in the aperture; falls back to the stars in the aperture when
    the cold-gas frame is unreliable (cold_frame_reliability: few cold cells, cold gas offset from `v_ref` =
    SubhaloVel, or weak rotation). The result names the tracer and the reasons (`fallback_reasons`)."""
    nH = rho_cgs * x_H / M_H_G
    r = np.linalg.norm(pos_kpc, axis=1)
    aper = max(APER_FRAC * r200c, APER_MIN_KPC)
    cold = ((T_K < COLD_T_MAX) | (nH > COLD_NH_MIN)) & (r < aper)
    p, v, m = pos_kpc[cold], vel_kms[cold], mass_msun[cold]
    n_cold = int(p.shape[0])
    cold_fr, why = None, []
    if n_cold >= 50:
        cold_fr = _frame_of(p, v, m)
        dv = None if v_ref is None else float(np.linalg.norm(np.asarray(cold_fr["vcenter_kms"]) - np.asarray(v_ref)))
        vp = v_phi(p, v - np.asarray(cold_fr["vcenter_kms"]), m, np.asarray(cold_fr["Lhat"]))
        why = cold_frame_reliability(n_cold, dv, vp)
        cold_fr.update(cold_dv_kms=dv, cold_vphi_own_kms=vp)
    else:
        why = [f"{n_cold} cold cells < {FRAME_MIN_COLD}"]
    tracer, fr = "cold_gas", cold_fr
    if why and stars is not None:
        ins = np.linalg.norm(stars["pos_kpc"], axis=1) < aper
        if np.count_nonzero(ins) >= FRAME_MIN_STARS:
            tracer = "stars"
            p, v, m = stars["pos_kpc"][ins], stars["vel_kms"][ins], stars["mass_msun"][ins]
            fr = _frame_of(p, v, m)
    if fr is None or p.shape[0] < 50:
        raise RuntimeError(f"too few {tracer} elements ({p.shape[0]}) for the disk frame")
    out = {"tracer": tracer, "n_used": int(p.shape[0]), "n_cold": n_cold, "aperture_kpc": float(aper),
           "fallback_reasons": why if tracer == "stars" else [], "cold_frame_warnings": why if tracer != "stars" else [],
           **{k: fr[k] for k in ("Lhat", "xhat", "yhat", "vcenter_kms")}}
    if cold_fr is not None:
        out.update(cold_dv_kms=cold_fr["cold_dv_kms"], cold_vphi_own_kms=cold_fr["cold_vphi_own_kms"])
    return out


def disk_frame_label(fr: dict) -> str:
    """Human label of the frame recipe actually used (galaxy.json disk_frame_source)."""
    aper = fr["aperture_kpc"]
    if fr["tracer"] == "stars":
        return (f"stellar angular momentum (stars within r < {aper:.2f} kpc; cold-gas frame unreliable: "
                + "; ".join(fr.get("fallback_reasons") or ["no cold gas"]) + ")")
    return ("cold-gas angular momentum (OVI_CGM_compare recipe: T < 1.5e4 K or nH > 0.1 cm^-3, "
            f"r < {aper:.2f} kpc)")


def v_phi(pos, vel, m, lhat) -> float:
    """Mass-weighted mean azimuthal velocity about lhat (km/s; > 0 = co-rotating with lhat)."""
    R = pos - np.outer(pos @ lhat, lhat)
    Rn = np.linalg.norm(R, axis=1)
    ok = Rn > 0
    phi_hat = np.cross(lhat, R[ok] / Rn[ok, None])
    return float(np.average(np.sum(vel[ok] * phi_hat, axis=1), weights=m[ok]))


def published_frame_angle(f, centre_ckpch, lhat, n=4000) -> float | None:
    """Angle (deg) between Lhat and the z axis of the cutout's own rotated frame (stars + SF gas within 2 r_half;
    RotatedCoordinates), from an affine least-squares fit of RotatedCoordinates on Coordinates. Diagnostic only."""
    try:
        g = f["PartType4"]
        N = g["Coordinates"].shape[0]
        idx = np.unique(np.linspace(0, N - 1, min(n, N)).astype(int))
        x = g["Coordinates"][idx].astype(np.float64) - centre_ckpch
        x = _wrap(x, float(f["Header"].attrs["BoxSize"]))          # boundary galaxies (fix3: 546114 read 84 deg)
        y = g["RotatedCoordinates"][idx].astype(np.float64)
        A = np.hstack([x, np.ones((x.shape[0], 1))])
        coef, *_ = np.linalg.lstsq(A, y, rcond=None)
        Rm = coef[:3].T                                         # y ≈ Rm x + t
        z = Rm[2] / np.linalg.norm(Rm[2])
        return float(np.degrees(np.arccos(min(1.0, abs(float(np.dot(z, lhat)))))))
    except Exception:                                            # noqa: BLE001 (diagnostic)
        return None


def stage_record(g: Galaxy, a) -> dict:
    import h5py
    from . import galaxy as G
    from .config import C_KMS
    src = g.source()
    row = G.catalogue_row(g.id)
    t = {}
    t0 = time.time()
    with h5py.File(src, "r") as f:
        hd = f["Header"].attrs
        h = float(hd["HubbleParam"]); box = float(hd["BoxSize"]); z = float(hd["Redshift"])
        if "SubfindID_This_Snapshot" in hd and int(hd["SubfindID_This_Snapshot"]) != g.id:
            raise RuntimeError(f"{src}: header SubfindID_This_Snapshot {int(hd['SubfindID_This_Snapshot'])} != {g.id}")
        centre, vel, nmem, mtot = _members(f, g.id, hd["MassTable"])
        t["members_s"] = round(time.time() - t0, 1)
        r200 = float(row["HaloVirialRadius_R200c"])
        centre_kpc = centre / h
        # gas within 2.5 R200c (the extract.py cut; the aperture is far inside)
        gp = f["PartType0"]
        x = gp["Coordinates"][()]
        draw = x - centre
        d = _wrap(draw, box)
        wrapped = bool(np.any(np.abs(draw - d) > 0))
        lo = (d.min(0) / h).tolist(); hi = (d.max(0) / h).tolist()
        rel = d / h
        sel = np.linalg.norm(rel, axis=1) < 2.5 * r200
        rel = rel[sel]
        idx = np.nonzero(sel)[0]
        metals_H = gp["GFM_Metals"][()][idx, 0].astype(np.float64)
        rho = gp["Density"][()][idx].astype(np.float64) * (1.0e10 * MSUN_G / h) / (KPC_CM / h) ** 3
        u = gp["InternalEnergy"][()][idx].astype(np.float64)
        xe = gp["ElectronAbundance"][()][idx].astype(np.float64)
        mass = gp["Masses"][()][idx].astype(np.float64) * 1e10 / h
        velg = gp["Velocities"][()][idx].astype(np.float64)
        T = temperature(u, xe, metals_H)
        xH = np.clip(metals_H, 0.5, 0.76).astype(np.float32).astype(np.float64)
        # the 488530 frame was computed from a float32 cache (pos, vel): same rounding here
        pos32 = rel.astype(np.float32).astype(np.float64)
        vel32 = velg.astype(np.float32).astype(np.float64)
        sp = f["PartType4"]
        sx = _wrap(sp["Coordinates"][()] - centre, box) / h
        sr = np.linalg.norm(sx, axis=1)
        sft = sp["GFM_StellarFormationTime"][()]
        ssel = (sr < 2.5 * r200) & (sft > 0)
        stars = {"pos_kpc": sx[ssel], "vel_kms": sp["Velocities"][()][ssel].astype(np.float64),
                 "mass_msun": sp["Masses"][()][ssel].astype(np.float64) * 1e10 / h}
        fr = cold_gas_frame(pos32, vel32, mass, rho, T, xH, r200, stars=stars, v_ref=vel)
        t["frame_s"] = round(time.time() - t0 - t["members_s"], 1)
        L = np.asarray(fr["Lhat"])
        aper = fr["aperture_kpc"]
        cg = (np.linalg.norm(pos32, axis=1) < aper) & ((T < COLD_T_MAX) | (rho * xH / M_H_G > COLD_NH_MIN))
        vc = np.asarray(fr["vcenter_kms"])
        sa = np.linalg.norm(stars["pos_kpc"], axis=1) < aper
        checks = {"cold_vphi_kms": v_phi(pos32[cg], vel32[cg] - vc, mass[cg], L) if cg.any() else None,
                  "stars_vphi_kms": v_phi(stars["pos_kpc"][sa], stars["vel_kms"][sa] - vc, stars["mass_msun"][sa], L)
                  if sa.any() else None,
                  "angle_to_published_frame_deg": published_frame_angle(f, centre, L),
                  "n_members": {f"PartType{k}": v for k, v in nmem.items()},
                  "member_mass_Msun": mtot * 1e10 / h,
                  "gas_extent_kpc": {"min": lo, "max": hi},
                  # cells exist out to the cube faces in every direction beyond the farthest ray endpoint
                  "slim_sphere_complete": bool(min(-np.asarray(lo).max(), np.asarray(hi).min()) >= R_RAY_MAX_KPC),
                  "periodic_wrap": wrapped}
    t1 = time.time()
    sha = sha256_file(src)
    t["sha256_s"] = round(time.time() - t1, 1)
    mw, m31 = G.mw_m31_flags(row)
    rec = {
        "sim": "TNG50-1", "snapshot": 99, "redshift": round(z, 12) + 0.0, "subhalo_id": g.id,
        "central": bool(row["FlagCentral"]), "TNG_H": h, "box_ckpch": box, "C_KMS": C_KMS,
        "CM_PER_KPC": KPC_CM,
        "center_ckpch": centre.tolist(), "center_kpc": centre_kpc.tolist(),
        "R200c_kpc": r200, "M200c_Msun": float(row["HaloMass_M200c"]),
        "Mstar_Msun": float(row["StellarMass_all"]), "SFR_Msun_yr": float(row["SFR_inst"]),
        "SubhaloVel_kms": vel.tolist(),
        "disk_frame_source": disk_frame_label(fr),
        "Lhat": fr["Lhat"], "xhat": fr["xhat"], "yhat": fr["yhat"],
        "label": f"Subhalo {g.id}", "mw": mw, "m31": m31,
        "catalogue": {k: (bool(v) if k.startswith("Flag") else v) for k, v in row.items() if k != "SubfindID"},
        "frame": {k: fr[k] for k in ("tracer", "n_used", "n_cold", "aperture_kpc", "vcenter_kms", "fallback_reasons",
                                     "cold_frame_warnings", "cold_dv_kms", "cold_vphi_own_kms") if k in fr},
        "checks": checks,
        "method": {"center": "minimum Potential among cutout particles with SubfindID == id (SubhaloPos definition)",
                   "SubhaloVel": "mass-weighted mean velocity of the cutout's members (gas, DM, stars+winds, BHs)",
                   "R200c_M200c": "host catalogue HaloVirialRadius_R200c (kpc), HaloMass_M200c (Msun)",
                   "Mstar": "host catalogue StellarMass_all", "SFR": "host catalogue SFR_inst"},
        "source": {"kind": "mwm31s_cutouts", "relpath": f"10_raw/snap_099/subhalo_{g.id}/snap_99.hdf5",
                   "bytes": src.stat().st_size, "sha256": sha},
        "notes": ("v_sys = SubhaloVel . los. Ray endpoints in ckpc/h (code_length) = kpc * TNG_H. Rays: the 683 "
                  "geometries of the 488530 library, half length min(R200c, sqrt(395^2 - b^2)) kpc."),
        "pipeline": {"timings": t},
    }
    rec["gas_poor"] = G.gas_poor(rec)
    adopt_reference(rec, no_adopt=getattr(a, "no_adopt", False))
    dump_json(g.record, rec)
    log(f"record {g.id}: recomputed centre {np.round(centre_kpc, 3).tolist()} kpc, R200c {r200:.1f}, Lhat "
        f"{np.round(L, 4).tolist()} ({fr['tracer']}, n={fr['n_used']}), v_phi cold {checks['cold_vphi_kms']}")
    return {"timings": t}


ADOPT_KEYS = ("center_ckpch", "center_kpc", "R200c_kpc", "M200c_Msun", "Mstar_Msun", "SFR_Msun_yr", "SubhaloVel_kms",
              "disk_frame_source", "Lhat", "xhat", "yhat")


def adopt_reference(rec: dict, no_adopt=False) -> dict:
    """For the default galaxy (488530) the shipped record defines the published library: adopt its centre, velocity,
    halo numbers and frame (so the pipeline's 488530 products use the shipped geometry exactly) and keep the values
    recomputed here, with their deviations, under rec["recomputed"] (the recipe's regression). Other galaxies: no-op."""
    from . import config
    if int(rec["subhalo_id"]) != config.DEFAULT_GALAXY_ID:
        return rec
    ref = json.loads(config.PACKAGED_GALAXY.read_text())
    recomputed = {k: rec[k] for k in ADOPT_KEYS}
    dev = {f"{k}_deg": float(np.degrees(np.arccos(np.clip(np.dot(rec[k], ref[k]), -1.0, 1.0))))
           for k in ("Lhat", "xhat", "yhat")}
    dev["center_kpc"] = float(np.linalg.norm(np.asarray(rec["center_kpc"]) - np.asarray(ref["center_kpc"])))
    dev["SubhaloVel_kms"] = float(np.linalg.norm(np.asarray(rec["SubhaloVel_kms"]) - np.asarray(ref["SubhaloVel_kms"])))
    for k in ("R200c_kpc", "M200c_Msun", "Mstar_Msun", "SFR_Msun_yr"):
        dev[f"{k}_rel"] = float(rec[k] / ref[k] - 1.0)
    recomputed["deviation_from_shipped"] = dev
    rec["recomputed"] = recomputed
    if not no_adopt:
        for k in ADOPT_KEYS:
            rec[k] = ref[k]
        rec["method"] = {**rec.get("method", {}), "adopted": "centre, SubhaloVel, R200c, M200c, M*, SFR and frame "
                         "adopted from the packaged galaxy_488530.json (the shipped library's geometry); the values "
                         "recomputed by this recipe are under 'recomputed'"}
    return rec


# ============================================================================== stage 2: slim
def stage_slim(g: Galaxy, a) -> dict:
    import h5py
    rec = g.load_record()
    src = g.source()
    t0 = time.time()
    centre = np.asarray(rec["center_ckpch"], float)
    with h5py.File(src, "r") as f:
        hd = f["Header"].attrs
        hub = float(hd["HubbleParam"]); box = float(hd["BoxSize"])
        gp = f["PartType0"]
        x = gp["Coordinates"][()]
        draw = x - centre
        d = _wrap(draw, box)
        unwrapped = bool(np.any(np.abs(draw - d) > 0))
        r = np.sqrt((d ** 2).sum(1))
        m = gp["Masses"][()].astype(np.float64); rho = gp["Density"][()].astype(np.float64)
        hsml = 2.0 * (3.0 / (4 * np.pi) * m / rho) ** (1 / 3)
        keep = (r - hsml) < R_SLIM_KPC * hub
        idx = np.nonzero(keep)[0]
        xout = (centre + d) if unwrapped else x               # cells across the periodic boundary: unwrapped
        tmp = g.slim.with_name(f".{g.slim.name}.{os.getpid()}.tmp")
        g.dir.mkdir(parents=True, exist_ok=True)
        with h5py.File(tmp, "w") as o:
            ho = o.create_group("Header")
            for k in HEADER_KEYS:
                if k in hd:
                    ho.attrs[k] = hd[k]
                elif k in HEADER_TEMPLATE:
                    ho.attrs[k] = HEADER_TEMPLATE[k]
            npart = np.zeros(6, dtype=np.int32); npart[0] = idx.size
            ho.attrs["NumPart_ThisFile"] = npart
            ho.attrs["NumPart_Total"] = npart.astype(np.uint64)
            ho.attrs["NumPart_Total_HighWord"] = np.zeros(6, dtype=np.uint32)
            ci = o.create_group("CutoutInfo")
            ci.attrs["Selection"] = json.dumps({
                "type": "cube", "center_ckpc_h": [round(float(c), 2) for c in centre],
                "half_width_ckpc": CUBE_HALF_CKPC, "source": "TNG50-1 snapshot 99 mwm31s_cutouts",
                "subhalo_id": g.id, "note": "published per-galaxy cutout (Pillepich et al. 2024)"
                + ("; coordinates unwrapped across the periodic boundary" if unwrapped else "")})
            ci.attrs["SlimmedBy"] = (f"tngsight.galpipe slim (slim_cutout.py recipe) r-hsml<{R_SLIM_KPC} kpc; "
                                     f"fields={','.join(SLIM_FIELDS)}")
            go = o.create_group("PartType0")
            for k in SLIM_FIELDS:
                arr = xout if k == "Coordinates" else gp[k][()]
                go.create_dataset(k, data=arr[idx])
                for ak, av in gp[k].attrs.items():
                    go[k].attrs[ak] = av
        os.replace(tmp, g.slim)
    t_write = time.time() - t0
    info = {"n_cells": int(idx.size), "n_source": int(keep.size), "max_r_kpc": float(r[idx].max() / hub),
            "unwrapped": unwrapped, "bytes": g.slim.stat().st_size, "write_s": round(t_write, 1)}
    rec.setdefault("checks", {})["slim_unwrapped"] = unwrapped
    if unwrapped:                     # yt domain = a cube around the centre holding every (unwrapped) slim cell
        rec["yt_bounding_box_ckpch"] = [[float(c - BBOX_HALF_CKPCH), float(c + BBOX_HALF_CKPCH)] for c in centre]
    else:
        rec.pop("yt_bounding_box_ckpch", None)
    dump_json(g.record, rec)
    t1 = time.time()
    build_index(g)
    info["index_s"] = round(time.time() - t1, 1)
    log(f"slim {g.id}: {idx.size:,}/{keep.size:,} cells, {info['bytes'] / 1e6:.0f} MB, index {info['index_s']} s")
    return info


def build_index(g: Galaxy) -> None:
    """Load the slim cutout once with yt so the EWAH index file is written (array tasks then only read it)."""
    import yt
    yt.set_log_level(50)
    g.lib.mkdir(parents=True, exist_ok=True)
    for f in (g.index, g.index_none):
        if f.exists():
            f.unlink()
    bb = g.load_record().get("yt_bounding_box_ckpch")
    ds = yt.load(str(g.slim), index_filename=str(g.index), **({"bounding_box": bb} if bb else {}))
    _ = ds.index
    ad = ds.all_data()
    n = int(ad["PartType0", "Masses"].size)
    if n <= 0:
        raise RuntimeError("yt read no gas cells from the slim cutout")
    if not g.index.is_file():
        if len(ds.index.data_files) != 1:
            raise RuntimeError(f"yt did not write the index {g.index}")
        # single-chunk dataset: yt builds a trivial Morton index in memory on every load and never writes one
        g.index_none.write_text(json.dumps({"n_cells": n, "data_files": 1,
                                            "note": "yt keeps single-chunk indexes in memory; no .ewah"}) + "\n")


# ============================================================================== stage 3: rays
_GEN = None


def _ray_paths(g: Galaxy, sid):
    return g.lib / "sightlines" / f"{sid}.npz", g.lib / "web" / f"{sid}.bin"


def _init_ray_worker(gdir_root, gid, workdir):
    for v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ[v] = "1"
    global _GEN
    g = Galaxy(gid, gdir_root)
    select_galaxy(g)
    from .generate import Generator
    _GEN = (g, Generator(cutout=g.slim, index_filename=g.index, workdir=Path(workdir) / str(os.getpid()),
                         fit_components=False))


def _ray_work(job):
    from . import library as Lb, ions as I
    sid, geom = job
    g, gen = _GEN
    try:
        t0 = time.time()
        gen.load()
        t_load = time.time() - t0
        payload = gen.generate(geom)
        if payload["id"] != sid:
            raise RuntimeError(f"generator returned id {payload['id']}")
        npz, binp = _ray_paths(g, sid)
        npz.parent.mkdir(parents=True, exist_ok=True)
        tmp = npz.with_name(f".{npz.stem}.{os.getpid()}.tmp.npz")
        Lb.save_npz(tmp, payload)
        os.replace(tmp, npz)
        atomic_write(binp, Lb.encode_web(Lb.load_npz(npz, id=sid)))
        return {"id": sid, "registry_tag": I.registry_tag(), "t_load": round(t_load, 2),
                "t_ray": round(gen.timings.get("ray", 0.0), 2), "t_spec": round(gen.timings.get("spectra", 0.0), 2),
                "t_total": round(time.time() - t0, 2), "half_kpc": geom["half_kpc"],
                "logN": {k: (round(float(v), 4) if math.isfinite(v) else None) for k, v in payload["logN"].items()},
                "host": socket.gethostname()}
    except Exception as e:                                      # noqa: BLE001 (recorded; retried on resume)
        import traceback
        return {"id": sid, "error": f"{e.__class__.__name__}: {e}", "trace": traceback.format_exc()[-1500:]}


def _append_jsonl(path: Path, rec: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as fh:
        fh.write(json.dumps(rec, allow_nan=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def _read_jsonl(paths) -> dict:
    out = {}
    for p in paths:
        if not Path(p).is_file():
            continue
        for line in Path(p).read_text().splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if "error" not in r:
                out[r["id"]] = r
    return out


def ray_state(g: Galaxy) -> dict:
    return _read_jsonl(sorted((g.lib / "state").glob("rays*.jsonl")))


def rays_complete(g: Galaxy) -> list[str]:
    """Ray ids still missing an npz, a web binary or a current state line."""
    from . import ions as I
    st = ray_state(g)
    tag = I.registry_tag()
    miss = []
    for r in ray_list(g):
        npz, binp = _ray_paths(g, r["id"])
        s = st.get(r["id"])
        if not (npz.is_file() and binp.is_file() and s is not None and s.get("registry_tag") == tag):
            miss.append(r["id"])
    return miss


def _pool_run(fn, jobs, workers, init, initargs, on_result):
    import multiprocessing as mp
    if workers <= 1:
        init(*initargs)
        for j in jobs:
            on_result(fn(j))
        return
    ctx = mp.get_context("spawn")
    # a spawned child imports this module (numpy, OpenBLAS) before `init` runs, so thread limits set in `init` come
    # too late: the children must inherit them from the parent's environment at spawn time. Otherwise each of the
    # `workers` processes starts cpus BLAS/OpenMP threads (task.sh exports OMP_NUM_THREADS=cpus): run3 fits ran
    # 16 x 16 threads per 16-core task and NHC drained 40 public nodes for load average (185-229 on 128 cores)
    keys = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS",
            "NUMEXPR_MAX_THREADS", "VECLIB_MAXIMUM_THREADS")
    saved = {k: os.environ.get(k) for k in keys}
    os.environ.update({k: "1" for k in keys})
    try:
        with ctx.Pool(workers, initializer=init, initargs=initargs) as pool:
            for res in pool.imap_unordered(fn, jobs):
                on_result(res)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def stage_rays(g: Galaxy, a) -> dict:
    from . import ions as I
    rec = select_galaxy(g)
    if spectra_source(g, getattr(a, "spectra", "auto")) == "sbi":
        # SBI_CGM galaxies: the spectra are imported (import_sbi), nothing is traced; DONE.rays follows completeness
        if not is_sbi(g):
            raise SystemExit(f"galaxy {g.id}: spectra come from SBI_CGM; run the import_sbi stage first")
        miss = rays_complete(g)
        log(f"rays {g.id}: SBI_CGM spectra, {len(miss)} of {len(ray_list(g))} imported rays missing; no tracing")
        if miss:
            raise SystemExit(f"rays {g.id}: {len(miss)} SBI rays not imported yet (e.g. {miss[:3]}); rerun import_sbi")
        return {"source": "sbi_cgm", "n_rays": len(ray_list(g))}
    if not g.index_ready():
        raise SystemExit(f"galaxy {g.id}: no yt index {g.index}; run the slim stage first")
    mark_spectra(g, "trident")
    clean_stale_tmp(g)
    i, n = parse_shard(a.shard)
    rays = ray_list(g)[i::n]
    if a.ids:
        want = set(a.ids.split(","))
        rays = [r for r in rays if r["id"] in want]
    if a.limit:
        rays = rays[: a.limit]
    st = ray_state(g)
    tag = I.registry_tag()
    todo = []
    for r in rays:
        npz, binp = _ray_paths(g, r["id"])
        s = st.get(r["id"])
        if not a.force and npz.is_file() and binp.is_file() and s is not None and s.get("registry_tag") == tag:
            continue
        todo.append((r["id"], ray_geometry(r, rec["R200c_kpc"])))
    sfx = f"{i}of{n}"
    state_p = g.lib / "state" / f"rays.{sfx}.jsonl"
    err_p = g.lib / "state" / f"rays_errors.{sfx}.jsonl"
    work = Path(os.environ.get("TMPDIR") or "/tmp") / f"galpipe_{g.id}_{sfx}_{os.getpid()}"
    log(f"rays {g.id} shard {sfx}: {len(rays)} rays, {len(rays) - len(todo)} done, {len(todo)} to do, "
        f"{a.workers} workers, workdir {work}")
    T0 = time.time()
    cnt = {"ok": 0, "err": 0}
    times = []

    def on_result(res):
        if "error" in res:
            cnt["err"] += 1
            _append_jsonl(err_p, {**res, "t": round(time.time() - T0, 1)})
            log(f"ERROR {res['id']}: {res['error']}")
            return
        cnt["ok"] += 1
        times.append(res["t_total"])
        _append_jsonl(state_p, res)
        if cnt["ok"] % 10 == 0 or cnt["ok"] == len(todo):
            log(f"rays {cnt['ok']}/{len(todo)} ({res['id']}: ray {res['t_ray']} s, spectra {res['t_spec']} s); "
                f"{time.time() - T0:.0f} s")

    if todo:
        nw = max(1, min(int(a.workers), len(todo)))
        try:
            _pool_run(_ray_work, todo, nw, _init_ray_worker, (str(g.root), g.id, str(work)), on_result)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    info = {"shard": sfx, "n_rays": len(rays), "n_done_now": cnt["ok"], "n_errors": cnt["err"],
            "wall_s": round(time.time() - T0, 1), "workers": a.workers,
            "ray_s_median": round(float(np.median(times)), 2) if times else None,
            "ray_s_sum": round(float(np.sum(times)), 1) if times else 0.0}
    dump_json(g.logs / f"rays.{sfx}.json", {**info, "peak_rss_gb": peak_rss_gb()})
    if cnt["err"]:
        raise SystemExit(f"rays {g.id} shard {sfx}: {cnt['err']} rays failed (see {err_p}); rerun to retry")
    return info


# ============================================================================== stage 3a: import_sbi
SBI_BATCH = 192          # rays read per batch (12 lines x 6000 x 8 B x 192 ~ 110 MB of tau)
SBI_STATE_GLOB = "rays_sbi.*.jsonl"


def sbi_selection(g: Galaxy, rec: dict, a, gdir: Path, geo: dict, ours: dict) -> dict:
    """<lib>/rays.json: the reproducible web subset (sbi.select) with ids and geometry columns; written once and
    reused (a changed rule/record needs --force). Returns the rays.json object."""
    from . import sbi as S
    p = sbi_rays_path(g)
    rec_sha = hashlib.sha256(g.record.read_bytes()).hexdigest()
    if p.is_file() and not a.force:
        d = json.loads(p.read_text())
        if d.get("sbi_galaxy") != g.id:
            raise SystemExit(f"{p}: selection is for galaxy {d.get('sbi_galaxy')}")
        if d.get("record_sha256") != rec_sha:
            # warn only when the selection's geometry moved (frame, centre, R200c), not for bookkeeping fields of
            # galaxy.json (review2_robust L4): recompute b and the orientation word of the stored rows
            cols = d["columns"]
            rows = [dict(zip(cols, r)) for r in d["rays"]]
            ix = np.array([int(r["sbi_row"]) for r in rows], int)
            db = float(np.max(np.abs(ours["b_kpc"][ix] - np.array([float(r["b_kpc"]) for r in rows])))) if rows else 0.0
            same_word = all(str(ours["orientation"][i]) == r["orientation"] for i, r in zip(ix, rows))
            if db > 0.01 or not same_word:
                log(f"import_sbi {g.id}: WARNING the disk frame / centre changed since the selection was made "
                    f"(max |db| {db:.3f} kpc; orientation words {'same' if same_word else 'differ'}); ids keep their "
                    "stored geometry; rerun with --force to reselect")
        return d
    n_target = int(getattr(a, "n_select", None) or S.N_TARGET)
    rows, rule = S.select(ours, rec, geo["ray_id"], g.id, n_target=n_target)
    cols = ["id", "orientation", "b_kpc", "azimuth_deg", "seed", "los_seed", "source", "sbi_ray_id", "sbi_row",
            "inclination_deg", "rho_sbi", "half_kpc"]
    rays, seen = [], set()
    for r in rows:
        sid = S.ray_sid(ours["orientation"][r], ours["b_kpc"][r], ours["azimuth_deg"][r], geo["ray_id"][r])
        if sid in seen:
            raise RuntimeError(f"duplicate sightline id {sid}")
        seen.add(sid)
        rays.append([sid, str(ours["orientation"][r]), round(float(ours["b_kpc"][r]), 3),
                     round(float(ours["azimuth_deg"][r]), 3), None, None, "sbi_cgm", int(geo["ray_id"][r]), int(r),
                     round(float(ours["inclination_deg"][r]), 3), round(float(geo["rho"][r]), 5),
                     round(float(ours["half_kpc"][r]), 3)])
    d = {"version": 1, "source": "sbi_cgm", "sbi_galaxy": g.id, "sbi_run": S.run_name(gdir),
         "record_sha256": rec_sha, "selection": rule, "columns": cols, "rays": rays}
    dump_json(p, d, indent=None)
    log(f"import_sbi {g.id}: selected {len(rays)} of {geo['n']} SBI rays ({rule['rule']}, seed {rule['seed']})")
    n_old = archive_unselected(g, seen)
    if n_old:
        log(f"import_sbi {g.id}: moved {n_old} files of the previous selection to logs/unselected/ (validate3 F1)")
    return d


LIB_RAY_FILES = (("sightlines", ".npz"), ("web", ".bin"), ("components", ".json"))


def archive_unselected(g: Galaxy, keep: set) -> int:
    """Move library/{sightlines,web,components} files whose id is not in the current selection to
    logs/unselected/<sub>/ (a forced reselection, e.g. after a re-record, must not leave old-frame rays next to the
    new ones: anything that globs library/ would pick them up). Moved, not deleted; safe under parallel shards."""
    n = 0
    for sub, ext in LIB_RAY_FILES:
        d = g.lib / sub
        if not d.is_dir():
            continue
        for f in d.glob(f"*{ext}"):
            if f.name.startswith(".") or f.name[:-len(ext)] in keep:
                continue
            dst = g.logs / "unselected" / sub
            dst.mkdir(parents=True, exist_ok=True)
            try:
                f.replace(dst / f.name)
                n += 1
            except FileNotFoundError:  # another shard moved it first
                pass
    return n


def stage_import_sbi(g: Galaxy, a) -> dict:
    """SBI_CGM spectra -> library/sightlines/<sid>.npz (v2) + library/web/<sid>.bin (TNGS v2) + state lines, for the
    selected subset (spec revision 2026-11-12, steps 2-3). --shard i/n splits the selected rays."""
    from . import sbi as S, library as Lb, ions as I
    rec = select_galaxy(g)
    if spectra_source(g, getattr(a, "spectra", "auto")) != "sbi":
        msg = (f"import_sbi {g.id}: spectra source is Trident for this galaxy (use --spectra sbi to import anyway); "
               "nothing to do")
        if a.force:
            # an explicit forced import that silently does nothing hides a mis-resolved source (review2 M3)
            raise SystemExit(msg + " [--force given: refusing a silent no-op]")
        log(msg)
        return {"skipped": "trident galaxy"}
    mark_spectra(g, "sbi")
    clean_stale_tmp(g)
    gdir = S.galaxy_dir(g.id)
    run = S.run_name(gdir)
    geo = S.read_geometry(gdir)
    ours = S.our_geometry(geo, rec)
    d = sbi_selection(g, rec, a, gdir, geo, ours)
    cols = d["columns"]
    rays = [dict(zip(cols, r)) for r in d["rays"]]
    i, n = parse_shard(a.shard)
    rays = rays[i::n]
    if a.ids:
        want = set(a.ids.split(","))
        rays = [r for r in rays if r["id"] in want]
    if a.limit:
        rays = rays[: a.limit]
    st = ray_state(g)
    tag = I.registry_tag()
    todo = []
    for r in rays:
        npz, binp = _ray_paths(g, r["id"])
        s = st.get(r["id"])
        if not a.force and npz.is_file() and binp.is_file() and s is not None and s.get("registry_tag") == tag:
            continue
        todo.append(r)
    sfx = f"{i}of{n}"
    state_p = g.lib / "state" / f"rays_sbi.{sfx}.jsonl"
    gen = None                    # per-line offsets / f ratios need the feature metadata of the first batch
    fit_atom = None
    log(f"import_sbi {g.id} shard {sfx}: {len(rays)} rays, {len(rays) - len(todo)} done, {len(todo)} to import "
        f"(run {run})")
    T0 = time.time()
    ys, ds, frames, n_ok = [], [], [], 0
    fx = {}
    for b0 in range(0, len(todo), SBI_BATCH):
        batch = sorted(todo[b0:b0 + SBI_BATCH], key=lambda r: r["sbi_row"])
        rows = [int(r["sbi_row"]) for r in batch]
        t0 = time.time()
        data = S.read_rays(gdir, rows)
        t_read = time.time() - t0
        if gen is None:
            gen = S.generation_record(gdir, run, data["feature"])
            fit_atom = S.fit_atomic(data["feature"])
        y, dd = S.frame_samples(data, ours["n_los"][data["rows"]])
        ys.append(y); ds.append(dd); frames.append(json.dumps(data["frame"], sort_keys=True))
        f_ovii = S.effective_f(data, "OVII")
        if f_ovii is not None:
            fx.setdefault("OVII", []).append(f_ovii)
        pos = {int(rw): j for j, rw in enumerate(data["rows"])}
        vb_batch = S.bulk_velocity(data["frame"])
        for r in batch:
            j = pos[int(r["sbi_row"])]
            if int(data["ray_id"][j]) != int(r["sbi_ray_id"]):
                raise RuntimeError(f"{r['id']}: SBI ray id {data['ray_id'][j]} != selection {r['sbi_ray_id']}")
            u_max = S.window_excess_kms(tuple(data["vlos_range"][j]), vb_batch, ours["n_los"][int(r["sbi_row"])])
            p = S.payload(data, j, ours, int(r["sbi_row"]), rec, gen,
                          {"run": run, "rho_R200c_sbi": r["rho_sbi"],
                           "u_absmax_kms": round(u_max, 1) if math.isfinite(u_max) else None,
                           "inclination_sbi_deg": round(math.degrees(float(geo["inclination_folded_rad"][r["sbi_row"]])), 3),
                           "point_index": int(geo["point_index"][r["sbi_row"]]),
                           "scramble_index": int(geo["scramble_index"][r["sbi_row"]])})
            if p["geom"]["orientation"] != r["orientation"] or abs(p["geom"]["b_kpc"] - r["b_kpc"]) > 0.01:
                raise RuntimeError(f"{r['id']}: geometry differs from the selection (galaxy.json changed? --force)")
            npz, binp = _ray_paths(g, r["id"])
            Lb.save_npz(npz, p)
            atomic_write(binp, Lb.encode_web(Lb.load_npz(npz, id=r["id"])))
            _append_jsonl(state_p, {"id": r["id"], "registry_tag": tag, "source": "sbi_cgm",
                                    "sbi_ray_id": int(r["sbi_ray_id"]), "t_read": round(t_read / len(batch), 3),
                                    "u_absmax_kms": round(u_max, 1) if math.isfinite(u_max) else None,
                                    "logN": {k: (round(float(v), 4) if math.isfinite(v) else None)
                                             for k, v in p["logN"].items()}, "host": socket.gethostname()})
            n_ok += 1
        log(f"import_sbi {g.id}: {n_ok}/{len(todo)} ({t_read:.1f} s read); {time.time() - T0:.0f} s")
    if not ys and rays:
        # nothing imported now (resume): verify the frame on this shard's first batch anyway, so that check.json
        # always reflects the current code and data
        batch = sorted(rays, key=lambda r: r["sbi_row"])[:SBI_BATCH]
        data = S.read_rays(gdir, [int(r["sbi_row"]) for r in batch])
        if gen is None:
            gen = S.generation_record(gdir, run, data["feature"])
        y, dd = S.frame_samples(data, ours["n_los"][data["rows"]])
        ys.append(y); ds.append(dd); frames.append(json.dumps(data["frame"], sort_keys=True))
    if len(set(frames)) > 1:
        raise RuntimeError(f"galaxy {g.id}: the SBI render frame differs between batches")
    frame = json.loads(frames[0]) if frames else None
    fcheck = None
    if ys:
        fcheck = S.frame_fit(np.concatenate(ys), np.concatenate(ds), S.bulk_velocity(frame))
        log(f"import_sbi {g.id}: frame check {fcheck}")
        if fcheck.get("pass") is False:
            raise SystemExit(f"import_sbi {g.id}: SBI velocity frame check failed: {fcheck}")
    info = {"shard": sfx, "n_rays": len(rays), "n_done_now": n_ok, "wall_s": round(time.time() - T0, 1),
            "frame_check": fcheck, "sbi_run": run,
            "f_eff": {k: round(float(np.median(v)), 5) for k, v in fx.items()}}
    dump_json(g.logs / f"import_sbi.{sfx}.json", {**info, "peak_rss_gb": peak_rss_gb()})
    # public provenance (merged by web into galaxy.json; checked by check)
    src_p = g.lib / "spectra_source.json"
    old = json.loads(src_p.read_text()) if src_p.is_file() else {}
    checks = dict(old.get("frame_checks", {}))
    if fcheck is not None:
        checks[sfx] = fcheck
    feff = dict(old.get("f_eff", {}))
    feff.update(info["f_eff"])
    vb = S.bulk_velocity(frame) if frame else np.asarray(old.get("sbi_bulk_velocity_kms") or [0, 0, 0], float)
    if gen is None:
        gen = old.get("generation") or S.generation_record(gdir, run)
    elif old.get("generation") and old["generation"] != gen:
        log(f"import_sbi {g.id}: generation block changed since the previous shard: {old['generation']} -> {gen}")
    dump_json(src_p, {
        "source": "sbi_cgm", "label": S.PROVENANCE_LABEL, "text": S.PROVENANCE_TEXT,
        "sbi_run": run, "n_pool": int(geo["n"]), "n_selected": len(d["rays"]), "selection": d["selection"],
        "generation": gen, "render_frame": (frame or {}).get("kind", old.get("render_frame")),
        "sbi_bulk_velocity_kms": [round(float(x), 4) for x in vb],
        "subhalo_vel_kms": rec["SubhaloVel_kms"], "frame_checks": checks, "f_eff": feff,
        "fit_atomic": fit_atom or old.get("fit_atomic") or S.fit_atomic(S.read_features(gdir)),
        "f_registry": {k: I.get(k)["f"] for k in S.LINE_MAP}, "sbi_provenance": S.read_provenance(gdir)})
    return info


# ============================================================================== stage 4: fits
def _comp_path(g: Galaxy, sid) -> Path:
    return g.lib / "components" / f"{sid}.json"


def fit_atomic_for(g: Galaxy) -> dict | None:
    """SBI galaxies: the per-line atomic data of the rendered tau (sbi.fit_atomic; stored in spectra_source.json at
    import, else read once from the SBI feature metadata and stored). None for Trident galaxies (registry data)."""
    if not is_sbi(g):
        return None
    from . import sbi as S
    src_p = g.lib / "spectra_source.json"
    src = json.loads(src_p.read_text()) if src_p.is_file() else {}
    fa = src.get("fit_atomic")
    if not fa:
        fa = S.fit_atomic(S.read_features(S.galaxy_dir(g.id)))
        if src:
            src["fit_atomic"] = fa
            dump_json(src_p, src)
    return fa


def apply_fit_atomic(g: Galaxy) -> dict | None:
    """Point vpfit at the galaxy's atomic data (in this process): registry values, overridden for SBI galaxies by
    fit_atomic_for (review2_physics P1: damped H I +0.126 dex with Trident's Gamma). components.params_tag and the
    params.atomic block of components.json follow, so the browser refit uses the same values and fits made with
    other atomic data are no longer current (refit)."""
    from . import vpfit, ions as I
    for k in I.KEYS:
        vpfit.ATOMIC[k] = I.atomic(k)
    fa = fit_atomic_for(g)
    for k, v in (fa or {}).items():
        if k in vpfit.ATOMIC:
            vpfit.ATOMIC[k] = {**vpfit.ATOMIC[k], **{x: v[x] for x in ("lam0", "f", "gamma") if x in v}}
    return fa


def _init_fit_worker(gdir_root, gid):
    for v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ[v] = "1"
    global _GEN
    g = Galaxy(gid, gdir_root)
    select_galaxy(g)
    apply_fit_atomic(g)
    _GEN = (g, None)


def _fit_work(sid):
    from . import library as Lb, components as C
    g, _ = _GEN
    try:
        npz, _b = _ray_paths(g, sid)
        payload = Lb.load_npz(npz, id=sid)
        aod = {}
        t0 = time.perf_counter()
        comps = C.fit_payload(payload, aod=aod)
        dt = time.perf_counter() - t0
        rows = {k: C.dicts_to_rows(v) for k, v in C.validate_components(comps).items()}
        crec = {"id": sid, "fitter": C.FITTER_TAG, "params_tag": C.params_tag(), "components": rows,
                "aod": C.validate_aod(aod)}
        atomic_write(_comp_path(g, sid), json.dumps(crec, sort_keys=True, separators=(",", ":"), allow_nan=False))
        return {"id": sid, "t_fit": round(dt, 2)}
    except Exception as e:                                      # noqa: BLE001
        import traceback
        return {"id": sid, "error": f"{e.__class__.__name__}: {e}", "trace": traceback.format_exc()[-1500:]}


def _fit_current(g: Galaxy, sid, ptag) -> bool:
    p = _comp_path(g, sid)
    if not p.is_file():
        return False
    try:
        return json.loads(p.read_text()).get("params_tag") == ptag
    except ValueError:
        return False


def sbi_window(g: Galaxy, rays=None) -> dict:
    """{sid: max |u| (km/s) of the ray's cells in the spectrum frame} for an SBI galaxy: gas beyond the +-1500 km/s
    window (> sbi.W_SBI) is missing from the spectrum (388544: 5-10 % of the metal column at |v_los| up to 2400 km/s
    on two central rays). From the import's state lines (u_absmax_kms); rays imported before that field existed are
    read once from the SBI CSR velocities (velocity_los_kms only) and cached in library/window.json."""
    from . import sbi as S, library as Lb
    rays = rays if rays is not None else ray_list(g)
    st = ray_state(g)
    cache_p = g.lib / "window.json"
    cache = json.loads(cache_p.read_text()) if cache_p.is_file() else {}
    out, need = {}, []
    for r in rays:
        sid = r["id"]
        v = (st.get(sid) or {}).get("u_absmax_kms", cache.get(sid))
        if v is None and sid not in cache:
            need.append(r)
        out[sid] = v
    if need:
        src = json.loads((g.lib / "spectra_source.json").read_text())
        vb = src.get("sbi_bulk_velocity_kms") or [0.0, 0.0, 0.0]
        vr = S.vlos_range(S.galaxy_dir(g.id), [int(r["sbi_row"]) for r in need])
        for r in need:
            pl = Lb.load_npz(_ray_paths(g, r["id"])[0], id=r["id"])
            u = S.window_excess_kms(vr.get(int(r["sbi_row"]), (math.nan, math.nan)), vb, pl["geom"]["n_los"])
            out[r["id"]] = cache[r["id"]] = round(u, 1) if math.isfinite(u) else None
        dump_json(cache_p, cache, indent=None)
    return out


def target_weights(g: Galaxy, rec: dict, rays=None) -> dict:
    """{sid: w_target}: post-stratification weight of each selected SBI ray to an area-uniform (in b within
    1.5 R200c), isotropic (inclination) sample: w = target mass of its stratum / (taken in the stratum / n). The target
    mass of a stratum [r1, r2) x [i1, i2) is ((r2^2 - r1^2) / 1.5^2) (cos i1 - cos i2) (review2_physics P4,
    verify P4: computed from b, inclination and R200c alone), renormalised over the occupied strata so the mean
    weight over the subset is 1."""
    from . import sbi as S
    rays = rays if rays is not None else ray_list(g)
    sel = json.loads(sbi_rays_path(g).read_text()).get("selection", {})
    re_ = sel.get("rho_edges_R200c") or list(S.RHO_EDGES)
    ie = sel.get("inclination_edges_deg") or list(S.INC_EDGES)
    rmax = float(re_[-1])
    R = float(rec["R200c_kpc"])

    def stratum(r):
        rho = float(r["b_kpc"]) / R
        a = min(max(int(np.searchsorted(re_, rho, side="right")) - 1, 0), len(re_) - 2)
        b = min(max(int(np.searchsorted(ie, float(r["inclination_deg"]), side="right")) - 1, 0), len(ie) - 2)
        return a, b

    st = {r["id"]: stratum(r) for r in rays}
    taken = {}
    for k in st.values():
        taken[k] = taken.get(k, 0) + 1
    n = len(rays)

    def mass(a, b):
        return ((re_[a + 1] ** 2 - re_[a] ** 2) / rmax ** 2) * (math.cos(math.radians(ie[b]))
                                                                - math.cos(math.radians(ie[b + 1])))

    m_occ = sum(mass(a, b) for a, b in taken) or 1.0          # = 1 when every stratum holds rays (the 700 subset)
    return {sid: round(mass(a, b) / m_occ * n / taken[(a, b)], 5) for sid, (a, b) in st.items()}


def spectra_source_public(g: Galaxy, src: dict | None = None) -> dict:
    """The page's provenance block of the galaxy's spectra (current wording; the stored text may be older)."""
    from . import sbi as S
    if is_sbi(g):
        src = src if src is not None else json.loads((g.lib / "spectra_source.json").read_text())
        out = {k: src[k] for k in ("sbi_run", "n_pool", "n_selected", "render_frame") if k in src}
        out.update(source="sbi_cgm", label=S.PROVENANCE_LABEL, short=S.PROVENANCE_SHORT, text=S.PROVENANCE_TEXT,
                   path="+-2 R200c (half_kpc per sightline)", ion_model="CLOUDY FG11 + Rahmati13 (THOR)",
                   cubes="Trident HM2012, H I from the TNG neutral fraction, r <= 400 kpc",
                   weights="w_target per entry (area-uniform b <= 1.5 R200c, isotropic)",
                   engineering_scope=True)
        if src.get("selection"):
            out["selection"] = {k: src["selection"][k] for k in
                                ("rule", "seed", "n_target", "rho_edges_R200c", "inclination_edges_deg",
                                 "inclination_words", "description") if k in src["selection"]}
        return out
    return {"source": "trident", "label": "Trident (HM2012)", "short": "Trident HM2012",
            "text": ("Spectra from Trident on yt (HM2012 metal-ion table; H I from the TNG neutral fraction), "
                     "sightlines +-R200c long on a fixed 683-ray design grid (also a designed, not random, "
                     "sample). The 3D cubes use the same ion model."),
            "path": "+-R200c", "ion_model": "Trident HM2012", "engineering_scope": False}


def merge_library(g: Galaxy) -> dict:
    """catalog.json (v2; ranks over the library) + components.json from the npz and component files."""
    from . import library as Lb, components as C, sbi as S
    from . import galaxy as G
    from .scoring import score_payload, assign_ranks, SCORING_TAG
    cat = Lb.catalog_skeleton()
    sbi = is_sbi(g)
    rays = ray_list(g)
    rec = g.load_record()
    cat["galaxy"]["gas_poor"] = G.gas_poor(rec)
    wts, win = {}, {}
    if sbi:
        src = json.loads((g.lib / "spectra_source.json").read_text())
        cat["generation"] = {**src["generation"], "dv_web_kms": cat["generation"]["dv_web_kms"]}
        cat["spectra_source"] = spectra_source_public(g, src)
        wts = target_weights(g, rec, rays)
        win = sbi_window(g, rays)
    entries, comps, aods = [], {}, {}
    for r in rays:
        sid = r["id"]
        npz, _b = _ray_paths(g, sid)
        payload = Lb.load_npz(npz, id=sid)
        crec = json.loads(_comp_path(g, sid).read_text())
        comps[sid] = crec["components"]; aods[sid] = crec["aod"]
        e = Lb.catalog_entry(payload, score_payload(payload), "library",
                             components=C.validate_components(crec["components"]))
        e["rank"] = None
        if sbi:
            # the `_s` number of an SBI id is the SBI ray id, not a regenerable Trident seed
            gs = payload["geom"].get("sbi", {})
            u = win.get(sid)
            e.update(seed=None, spectra="sbi_cgm", sbi_ray_id=gs.get("ray_id"),
                     inclination_deg=_round_or_none(payload["geom"].get("inclination_deg"), 1),
                     half_kpc=_round_or_none(payload["geom"].get("half_kpc"), 1),
                     w_target=wts.get(sid), u_absmax_kms=u,
                     window_truncated=bool(u is not None and u > S.W_SBI))
        entries.append(e)
    assign_ranks(entries)
    cat["entries"] = entries
    cat["scoring"] = SCORING_TAG
    blob = json.dumps(cat, separators=(",", ":"), allow_nan=False).encode()
    atomic_write(g.lib / "catalog.json", blob)
    cobj = C.make_catalogue(comps, aod=aods)
    C.validate_catalogue(cobj)
    cb = C.dump_catalogue(cobj)
    atomic_write(g.lib / "components.json", cb)
    return {"catalog_bytes": len(blob), "components_bytes": len(cb), "n_entries": len(entries),
            "n_window_truncated": sum(bool(e.get("window_truncated")) for e in entries)}


def _round_or_none(x, nd):
    return None if x is None else round(float(x), nd)


def stage_fits(g: Galaxy, a) -> dict:
    from . import components as C
    select_galaxy(g)
    fa = apply_fit_atomic(g)
    if fa:
        log(f"fits {g.id}: SBI atomic data " + ", ".join(f"{k} f={v['f']:.5g} Gamma={v['gamma']:.4g}"
                                                         for k, v in sorted(fa.items()) if k in ("HI", "CII", "MgII")))
    miss = rays_complete(g)
    i, n = parse_shard(a.shard)
    ids = [r["id"] for r in ray_list(g)][i::n]
    if a.ids:
        ids = [s for s in ids if s in set(a.ids.split(","))]
    missing_rays = [s for s in ids if s in set(miss)]
    if missing_rays:
        raise SystemExit(f"fits {g.id}: {len(missing_rays)} rays of this shard are not generated yet "
                         f"(e.g. {missing_rays[:3]}); run the rays stage first")
    ptag = C.params_tag()
    todo = [s for s in ids if a.force or not _fit_current(g, s, ptag)]
    if a.limit:
        todo = todo[: a.limit]
    sfx = f"{i}of{n}"
    log(f"fits {g.id} shard {sfx}: {len(ids)} rays, {len(todo)} to fit, {a.workers} workers")
    T0 = time.time()
    cnt = {"ok": 0, "err": 0}
    times = []
    err_p = g.lib / "state" / f"fits_errors.{sfx}.jsonl"

    def on_result(res):
        if "error" in res:
            cnt["err"] += 1
            _append_jsonl(err_p, res)
            log(f"ERROR fit {res['id']}: {res['error']}")
            return
        cnt["ok"] += 1
        times.append(res["t_fit"])
        if cnt["ok"] % 25 == 0 or cnt["ok"] == len(todo):
            log(f"fits {cnt['ok']}/{len(todo)}; {time.time() - T0:.0f} s")

    if todo:
        _pool_run(_fit_work, todo, max(1, min(int(a.workers), len(todo))), _init_fit_worker, (str(g.root), g.id),
                  on_result)
    info = {"shard": sfx, "n_fit_now": cnt["ok"], "n_errors": cnt["err"], "wall_s": round(time.time() - T0, 1),
            "fit_s_median": round(float(np.median(times)), 2) if times else None,
            "fit_s_sum": round(float(np.sum(times)), 1) if times else 0.0}
    if cnt["err"]:
        raise SystemExit(f"fits {g.id} shard {sfx}: {cnt['err']} fits failed (see {err_p})")
    all_ids = [r["id"] for r in ray_list(g)]
    miss = rays_complete(g)              # recomputed: other shards' rays may have finished while this shard ran
    left = [s for s in all_ids if not _fit_current(g, s, ptag)]
    info["merged"] = None
    if not left and not miss:
        t = time.time()
        info["merged"] = merge_library(g)
        info["merge_s"] = round(time.time() - t, 1)
    else:
        info["remaining_global"] = len(left)
    dump_json(g.logs / f"fits.{sfx}.json", {**info, "peak_rss_gb": peak_rss_gb()})
    return info


# ============================================================================== stage 5: cubes
def _run(cmd, env, logfile: Path, tolerate=None) -> float:
    logfile.parent.mkdir(parents=True, exist_ok=True)
    t = time.time()
    log(f"$ {' '.join(str(c) for c in cmd)}  (log {logfile})")
    with open(logfile, "a") as fh:
        fh.write(f"\n# {time.strftime('%Y-%m-%dT%H:%M:%S')} {' '.join(str(c) for c in cmd)}\n")
        fh.flush()
        rc = subprocess.call([str(c) for c in cmd], env=env, stdout=fh, stderr=subprocess.STDOUT, cwd=str(ROOT_REPO))
    if rc != 0 and not (tolerate and tolerate(rc, logfile)):
        raise SystemExit(f"command failed (exit {rc}); see {logfile}")
    return round(time.time() - t, 1)


def recheck_columns(g: Galaxy, a) -> dict:
    """Column checks of already-built cubes from the cache (`build_volumes --check`, report
    viz_cache/gas/check_report.json). For SBI galaxies whose cubes were built before build_volumes substituted the
    missing 488530 check sightlines (run2: the build report then has no check rows at all); reused when newer than
    the build report."""
    gas = g.cache / "gas"
    out = gas / "check_report.json"
    if not (out.is_file() and out.stat().st_mtime >= (gas / "build_report.json").stat().st_mtime):
        env = dict(os.environ)
        env.update({"TNG_HEAVY_LOCK": "", "PYTHONPATH": str(ROOT_REPO) + os.pathsep + env.get("PYTHONPATH", "")})
        bv = ROOT_REPO / "deploy" / "data" / "build_volumes.py"
        t0 = time.time()
        _run([sys.executable, bv, "--check", "--library", g.lib, "--viz", g.viz, "--cache", gas, "--index", g.index,
              "--cutout", g.slim, "--report", out], env, g.logs / "check_columns.log",
             tolerate=lambda rc, lf: rc == 1 and out.is_file() and out.stat().st_mtime >= t0)
    return json.loads(out.read_text()).get("checks", {})


def _stars_budget_only(rc, logfile: Path) -> bool:
    """build_stars exits 1 also when a cube is only over its size budget (the shipped 488530 S2 is: 9.18 MB > 9.0);
    that is reported, not fatal. Any verify error or other failure stays fatal."""
    tail = logfile.read_text(errors="replace").splitlines()[-12:]
    last = [ln for ln in tail if ln.startswith("[stars] fragment")]
    ok = rc == 1 and last and "verify OK" in last[-1]
    if ok:
        log(f"build_stars: size budget exceeded (reported, not fatal): "
            + "; ".join(ln for ln in tail if "OVER BUDGET" in ln))
    return bool(ok)


def _gas_checks_only(t_start):
    """build_volumes exits 1 when only its column checks fail (the build, manifest and report are complete). The
    checks' tolerances were tuned on 488530; for the sample the check stage grades them (gate column_checks), so a
    check-only failure is reported here, not fatal. Any other failure (no fresh report) stays fatal."""
    def tol(rc, logfile: Path) -> bool:
        rep = logfile.parent.parent / "viz_cache" / "gas" / "build_report.json"
        tail = logfile.read_text(errors="replace").splitlines()[-6:]
        ok = (rc == 1 and rep.is_file() and rep.stat().st_mtime >= t_start
              and any(ln.startswith("[build] CHECK FAILURES") for ln in tail))
        if ok:
            log("build_volumes: column checks outside the 488530 tolerances (graded by the check stage): "
                + next(ln for ln in tail if ln.startswith("[build] CHECK FAILURES"))[:600])
        return bool(ok)
    return tol


def stage_cubes(g: Galaxy, a) -> dict:
    from . import ions as I
    select_galaxy(g)
    if not g.index_ready() or not g.slim.is_file():
        raise SystemExit(f"galaxy {g.id}: slim stage not done")
    env = dict(os.environ)
    env.update({"TNG_HEAVY_LOCK": "", "PYTHONPATH": str(ROOT_REPO) + os.pathsep + env.get("PYTHONPATH", "")})
    py = sys.executable
    bv = ROOT_REPO / "deploy" / "data" / "build_volumes.py"
    bs = ROOT_REPO / "deploy" / "data" / "build_stars.py"
    levels = a.levels or "L0,L1,L2"
    slevels = a.star_levels or "S0,S1,S2"
    gas_cache = g.cache / "gas"
    common = ["--library", g.lib, "--viz", g.viz, "--cache", gas_cache, "--index", g.index, "--cutout", g.slim,
              "--levels", levels, "--workers", str(a.workers), "--no-merge-manifest",
              # the design §3.4 range bounds were tuned on 488530: for the sample they are reported, not fatal
              # (the §2.3 rule still sets every range); see logs/cubes_gas.log "[range] OUTSIDE"
              "--allow-range", "nH,T,Z," + ",".join(I.KEYS) + ",vx,vy,vz"]
    if a.force:
        common.append("--force")
    t = {}
    fields = a.fields or None
    t["gas_s"] = _run([py, bv, *common] + (["--fields", fields] if fields else []), env, g.logs / "cubes_gas.log",
                      tolerate=_gas_checks_only(time.time() - 1))
    gas_report = json.loads((gas_cache / "build_report.json").read_text())
    if not a.fields:
        t["vel_s"] = _run([py, bv, *common, "--fields", "vx,vy,vz", "--report", gas_cache / "build_report_vel.json"],
                          env, g.logs / "cubes_vel.log")
    if not a.no_stars:
        t["stars_s"] = _run([py, bs, "--viz", g.viz, "--cache", g.cache / "stars", "--cutout", g.source(),
                             "--levels", slevels, "--workers", str(a.workers)]
                            + (["--force"] if a.force else []), env, g.logs / "cubes_stars.log",
                            tolerate=_stars_budget_only)
        t["merge_s"] = _run([py, "-m", "tngsight.vizpack", "merge", g.viz], env, g.logs / "cubes_merge.log")
    return {"timings": t, "gas_report_timings": gas_report.get("timings"), "peak_rss_gb_gas": gas_report.get("peak_rss_gb"),
            "levels": levels, "fields": fields or "all", "stars": not a.no_stars}


# ============================================================================== stage 6: web
def public_record(rec: dict) -> dict:
    keys = ("sim", "snapshot", "redshift", "subhalo_id", "central", "TNG_H", "label", "mw", "m31", "R200c_kpc",
            "M200c_Msun", "Mstar_Msun", "SFR_Msun_yr", "SubhaloVel_kms", "center_kpc", "Lhat", "xhat", "yhat",
            "disk_frame_source")
    out = {k: rec[k] for k in keys if k in rec}
    from . import galaxy as G
    out["gas_poor"] = G.gas_poor(rec)
    cat = rec.get("catalogue") or {}
    out["catalogue"] = {k: cat[k] for k in ("SFR_50Myr", "StellarMass_30kpc", "StellarMass_2rh", "HaloMass_Mdyn",
                                            "DiskScaleLength", "FlagMWM31", "FlagDisky", "FlagBarredZana22",
                                            "FlagS0", "FlagIsolated", "SMBH_Mass") if k in cat}
    return out


def _link_or_copy(src: Path, dst: Path) -> bool:
    """Hard link (same file system) else byte copy; True when written."""
    if dst.is_file() and dst.stat().st_size == src.stat().st_size and \
            (os.path.samefile(src, dst) or dst.read_bytes() == src.read_bytes()):
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)
    return True


def stage_web(g: Galaxy, a) -> dict:
    rec = select_galaxy(g)
    cat_p, comp_p = g.lib / "catalog.json", g.lib / "components.json"
    if not cat_p.is_file() or not comp_p.is_file():
        raise SystemExit(f"galaxy {g.id}: fits stage not merged (no catalog.json / components.json)")
    cat = json.loads(cat_p.read_text())
    keep = []
    n_new = 0
    for e in cat["entries"]:
        b = g.lib / "web" / f"{e['id']}.bin"
        if b.is_file():
            n_new += _link_or_copy(b, g.web / "s" / f"{e['id']}.bin")
            keep.append(e)
    cat["entries"] = keep
    atomic_write(g.web / "catalog.json", json.dumps(cat, separators=(",", ":"), allow_nan=False))
    _link_or_copy(comp_p, g.web / "components.json")
    pub = public_record(rec)
    src_p = g.lib / "spectra_source.json"
    if is_sbi(g) and not src_p.is_file():
        # an SBI galaxy without its provenance must never be labelled Trident (verify_robust M1 aside)
        raise SystemExit(f"galaxy {g.id}: SBI library without library/spectra_source.json; rerun import_sbi")
    pub["spectra_source"] = spectra_source_public(g)
    # the page's copy: catalog.json carries the current provenance and galaxy flags too (exporters may whitelist
    # galaxy.json keys)
    cat["spectra_source"] = pub["spectra_source"]
    cat.setdefault("galaxy", {})["gas_poor"] = pub.get("gas_poor")
    atomic_write(g.web / "catalog.json", json.dumps(cat, separators=(",", ":"), allow_nan=False))
    atomic_write(g.web / "galaxy.json", json.dumps(pub, separators=(",", ":"), allow_nan=False))
    viz = None
    man_p = g.viz / "manifest_v2.json"
    if man_p.is_file():
        from . import vizpack
        man = json.loads(man_p.read_text())
        vizpack.validate_manifest_v2(man, base_dir=g.viz)
        atomic_write(g.web / "viz" / "manifest_v2.json", man_p.read_bytes())
        viz = {"cubes": sum(len(f.get("cubes", {})) for f in man.get("gas", {}).get("fields", {}).values())}
    for stale in (g.web / "s").glob("*.bin"):
        if stale.stem not in {e["id"] for e in keep}:
            stale.unlink()
    return {"n_entries": len(keep), "bins_written": n_new, "viz": viz}


# ============================================================================== stage 7: check
COL_FLOOR_LOGN = 10.0       # columns below 1e10 cm^-2 are zero for every purpose (no observable absorption)
COL_GROSS_DEX = 0.5         # a cube column this far from its reference at logN >= COL_FLOOR_LOGN is a build error
# a log difference only matters when the columns themselves differ by an observable amount: a row whose two columns
# differ by less than 1e11 cm^-2 (both segment columns, cube and reference) is below any detection limit whatever
# its dex (571454: L2 C III cube 10^10.74 vs smoothed 10^2.4 over a 50 kpc segment of empty gas)
COL_FLOOR_DIFF_LOGN = 11.0
# A coarse level smooths what a finer one resolves: a gross L0 or L1 row is graded soft when the same sightline and ion
# agree within COL_GROSS_DEX at a finer level (L0: the L1/L2 segment; L1: the L2 segment) and the offset stays below
# this (372754: rand_b031 at the cold-disk edge, L0 +0.5..+1.15 dex, L1/L2 within 0.17 dex; 400973 L1 rand_b008 H I
# -0.50 at logN 17.8, L2 +0.07). Only one sightline per level may be softened this way: a mis-scaled or misplaced
# cube at one level with intact finer levels offsets every sightline of that level, not one.
COL_L0_EDGE_MAX_DEX = 1.5
# Relative column floor (owner decision 2026-11-12, notes/gal/U_grading.md). The deposit conserves every quantity to
# 1e-15 (gate cube_conservation), so a cube column can only be wrong by atoms moved between neighbouring voxels.
# Where a low-column sightline grazes a compact dense clump (b ~ h + one voxel), the trilinear cube read reaches about
# one voxel beyond the kernel support and the ±Δ/2 smoothed bundle does not, so the two estimates of the
# voxel-footprint column differ by a kernel tail of the clump: in the 7 run3 cases |ΔN| = 3e-7..8e-5 of the densest
# smoothed column of that level and ion, from one or two cells 2-9 kpc off the ray. A misplaced, mis-scaled,
# mis-framed or empty cube is wrong by a sizeable fraction of the dense columns themselves (ΔN/N_dense >= 0.1). So a
# gross row is soft when |ΔN| <= COL_REL_FLOOR * N_dense, N_dense being the largest smoothed reference column among
# that level's check sightlines for the ion, provided the N_dense row itself agrees within COL_GROSS_DEX and is not
# the row being graded.
COL_REL_FLOOR = 1e-3


def grade_column_checks(chk: dict) -> dict:
    """Grade build_volumes' column checks (design §4.3) for the sample.

    hard (gate fails): no check rows at all, or any row with |Δ| > COL_GROSS_DEX where either segment column is
    ≥ 1e10 cm^-2 and the columns differ by ≥ 10^COL_FLOOR_DIFF_LOGN cm^-2 (a misplaced, mis-framed or empty cube;
    resolution effects stay well below this), except
    - rows whose |ΔN| is ≤ COL_REL_FLOOR of the level's densest correctly deposited column of that ion (kernel-tail
      leakage of a dense clump into a grazing low-column sightline), and
    - L0/L1 rows confirmed by a finer level within COL_GROSS_DEX (|Δ| ≤ COL_L0_EDGE_MAX_DEX; one sightline per level);
    soft (reported as warnings, gate passes): rows beyond the 488530-tuned tolerances (physics 0.05, u8 0.02,
    reference 0.02 dex) but within COL_GROSS_DEX, the two exceptions above, and rows below the difference floor.
    Rows where both columns are below the floor (e.g. Mg II 1e-2.7 vs 0: Δ = -inf in the raw report) are ignored."""
    def lg(x):
        return -math.inf if x is None else float(x)

    def lin(x):
        return 10.0 ** x if math.isfinite(x) else 0.0

    def lin_diff(a_, b_):
        return abs(lin(a_) - lin(b_))

    def dlog(a_, b_):
        return a_ - b_ if math.isfinite(a_) and math.isfinite(b_) else (0.0 if a_ == b_ else math.inf)

    rows = chk.get("rows") or []
    refs = chk.get("reference") or []
    warn, gross, floored, l0_edge, tiny, rel = [], [], 0, [], 0, []
    finer = {"L0": ("L1", "L2"), "L1": ("L2",)}
    fine_ok = set()
    dense = {}                                   # (level, ion) -> (N_ref, row agrees within COL_GROSS_DEX, row id)
    for i, r in enumerate(rows):
        a_, b_ = lg(r.get("cube4")), lg(r.get("ref"))
        d = dlog(a_, b_)
        if abs(d) <= COL_GROSS_DEX:              # this level is consistent (also when both are empty)
            fine_ok.add((r.get("level"), r["sid"], r["ion"]))
        k = (r.get("level"), r["ion"])
        if k not in dense or lin(b_) > dense[k][0]:
            dense[k] = (lin(b_), abs(d) <= COL_GROSS_DEX, i)
    fine_soft = {}                               # level -> {sid: [tags]}
    for i, r in enumerate(rows):
        tol = float(r.get("tol") or 0.05)
        a_, b_ = lg(r.get("cube4")), lg(r.get("ref"))
        if max(a_, b_) < COL_FLOOR_LOGN:
            floored += 1
            continue
        d = a_ - b_ if math.isfinite(a_) and math.isfinite(b_) else math.inf
        tag = f"physics {r['level']} {r['sid']} {r['ion']} {d:+.3f} (logN {max(a_, b_):.2f})"
        if abs(d) > COL_GROSS_DEX:
            nd, nd_ok, nd_i = dense.get((r.get("level"), r["ion"]), (0.0, False, i))
            dn = lin_diff(a_, b_)
            if dn < 10.0 ** COL_FLOOR_DIFF_LOGN:
                tiny += 1
                warn.append(tag + " [below the 1e11 difference floor]")
            elif nd_ok and nd_i != i and dn <= COL_REL_FLOOR * nd:
                rel.append(tag)
                warn.append(tag + f" [|dN| = {dn / nd:.1e} of the densest {r['level']} column: relative floor]")
            elif (r.get("level") in finer and abs(d) <= COL_L0_EDGE_MAX_DEX
                  and any((f, r["sid"], r["ion"]) in fine_ok for f in finer[r["level"]])):
                fine_soft.setdefault(r["level"], {}).setdefault(r["sid"], []).append(tag)
            else:
                gross.append(tag)
        elif abs(d) > tol:
            warn.append(tag)
        du = r.get("d_u8")
        if du is not None and abs(du) > 0.02 and max(a_, b_) >= COL_FLOOR_LOGN:
            (gross if abs(du) > COL_GROSS_DEX else warn).append(
                f"u8 {r['level']} {r['sid']} {r['ion']} {du:+.3f} (logN {max(a_, b_):.2f})")
    for L, by_sid in fine_soft.items():
        for tags in by_sid.values():
            if len(by_sid) == 1:
                l0_edge.extend(tags)
                warn.extend(t + f" [{L} resolution; finer level agrees]" for t in tags)
            else:                                # several sightlines of one level: a level-wide error, not resolution
                gross.extend(t + f" [finer level agrees, but {len(by_sid)} {L} sightlines are off]" for t in tags)
    for r in refs:
        a_, b_ = lg(r.get("line_integral")), lg(r.get("npz"))
        if max(a_, b_) < COL_FLOOR_LOGN:
            floored += 1
            continue
        d = a_ - b_ if math.isfinite(a_) and math.isfinite(b_) else math.inf
        tag = f"reference {r['sid']} {r['ion']} {d:+.4f} (logN {max(a_, b_):.2f})"
        if abs(d) > COL_GROSS_DEX and lin_diff(a_, b_) >= 10.0 ** COL_FLOOR_DIFF_LOGN:
            gross.append(tag)
        elif abs(d) > 0.02:
            warn.append(tag)
    return {"hard_pass": bool(rows) and not gross, "n_rows": len(rows), "n_reference": len(refs),
            "n_below_floor": floored, "n_below_diff_floor": tiny, "n_l0_edge": len(l0_edge),
            "n_relative_floor": len(rel), "relative_floor": rel[:30],
            "gross": gross[:30], "n_gross": len(gross), "warnings": warn[:40],
            "n_warnings": len(warn), "raw_fails": (chk.get("fails") or [])[:20], "summary": chk.get("summary"),
            "grading": (f"hard |d| > {COL_GROSS_DEX} dex at logN >= {COL_FLOOR_LOGN} with |dN| >= "
                        f"1e{COL_FLOOR_DIFF_LOGN:g} cm^-2, except |dN| <= {COL_REL_FLOOR:g} x the level's densest "
                        f"correctly deposited column of the ion (relative floor) and L0/L1 rows confirmed by a finer "
                        f"level within {COL_GROSS_DEX} dex (soft up to {COL_L0_EDGE_MAX_DEX} dex, one sightline per "
                        f"level); soft beyond the 488530 tolerances")}


CUBE_GATES = ("cube_conservation", "column_checks", "HI_le_nH", "viz_manifest")


def _manifest_sha(g: Galaxy):
    p = g.viz / "manifest_v2.json"
    return sha256_file(p) if p.is_file() else None


def cube_gate_snapshot(g: Galaxy) -> dict | None:
    """The last computed cube gates (logs/cube_gates.json, keyed by the viz manifest sha256), so a check after the
    float viz_cache was deleted (to free BeeGFS) regrades the cubes without the npy files (review2_robust L3).
    Bootstrap for galaxies cleaned before the snapshot existed: the cube gates of check.json when the cubes were not
    rebuilt since (DONE.cubes older than check.json)."""
    p = g.logs / "cube_gates.json"
    sha = _manifest_sha(g)
    if p.is_file():
        d = json.loads(p.read_text())
        if d.get("manifest_sha256") == sha:
            return d
        return None
    ck = g.dir / "check.json"
    if ck.is_file() and g.is_done("cubes") and g.done("cubes").stat().st_mtime < ck.stat().st_mtime:
        gates = json.loads(ck.read_text()).get("gates", {})
        if all(k in gates for k in ("cube_conservation", "HI_le_nH")):
            return {"manifest_sha256": sha, "from": "check.json", "gates": {k: gates[k] for k in CUBE_GATES
                                                                          if k in gates}}
    return None


def stage_check(g: Galaxy, a) -> dict:
    from . import library as Lb, ions as I
    rec = select_galaxy(g)
    gates = {}

    def gate(name, ok, **info):
        gates[name] = {"pass": bool(ok), **info}

    ids = [r["id"] for r in ray_list(g)]
    n_npz = sum((g.lib / "sightlines" / f"{s}.npz").is_file() for s in ids)
    n_bin = sum((g.lib / "web" / f"{s}.bin").is_file() for s in ids)
    n_comp = sum(_comp_path(g, s).is_file() for s in ids)
    n_web = sum((g.web / "s" / f"{s}.bin").is_file() for s in ids)
    cat = json.loads((g.lib / "catalog.json").read_text()) if (g.lib / "catalog.json").is_file() else {"entries": []}
    gate("counts", n_npz == n_bin == n_comp == n_web == len(cat["entries"]) == len(ids),
         expected=len(ids), npz=n_npz, bins=n_bin, components=n_comp, web_bins=n_web, catalog=len(cat["entries"]))
    # finite spectra + positive columns
    bad, n_checked = [], 0
    for s in ids:
        p = g.lib / "sightlines" / f"{s}.npz"
        if not p.is_file():
            continue
        pl = Lb.load_npz(p, id=s)
        n_checked += 1
        for k in pl["lines"]:
            tau = np.asarray(pl["tau"][k])
            if not np.all(np.isfinite(tau)) or np.any(tau < 0) or math.isnan(float(pl["logN"][k])):
                bad.append(f"{s}:{k}")
    gate("finite_spectra", not bad and n_checked == len(ids), n_checked=n_checked, bad=bad[:20], n_bad=len(bad))
    if is_sbi(g):
        sbi_gates(g, ids, gate)
    # frame sanity
    ch = rec.get("checks", {})
    tracer = rec.get("frame", {}).get("tracer", "cold_gas")
    vt = ch.get("stars_vphi_kms") if tracer == "stars" else ch.get("cold_vphi_kms")
    # the frame tracer must rotate about +Lhat; a counter-rotating stellar disk (cold gas and stars misaligned,
    # 20 of the 198 at z = 0) is physical and only flagged
    gate("frame_corotation", (vt or 0) > 0, tracer=tracer, tracer_vphi_kms=vt,
         cold_vphi_kms=ch.get("cold_vphi_kms"), stars_vphi_kms=ch.get("stars_vphi_kms"),
         stars_counter_rotating=bool((ch.get("stars_vphi_kms") or 0) < 0),
         angle_to_published_frame_deg=ch.get("angle_to_published_frame_deg"))
    lh, xh, yh = (np.asarray(rec[k]) for k in ("Lhat", "xhat", "yhat"))
    orth = float(max(abs(lh @ xh), abs(lh @ yh), abs(xh @ yh), abs(np.linalg.norm(lh) - 1)))
    gate("frame_orthonormal", orth < 1e-9, max_dev=orth)
    gate("slim_complete", bool(ch.get("slim_sphere_complete", False)), gas_extent_kpc=ch.get("gas_extent_kpc"))
    # cubes: conservation + column checks (build_volumes report) + H I <= n_H voxelwise
    rep_p = g.cache / "gas" / "build_report.json"
    snap = None
    if rep_p.is_file():
        rep = json.loads(rep_p.read_text())
        mass = rep.get("mass", {})
        cons = max((max(abs(v["conservation_N_nH"]), abs(v["conservation_m"])) for v in mass.values()), default=None)
        gate("cube_conservation", cons is not None and cons < 1e-5, max_rel=cons,
             lost_m={L: v["lost_m"] for L, v in mass.items()})
        chk = rep.get("checks", {})
        if not chk.get("rows") and not chk.get("reference"):
            cr = g.cache / "gas" / "check_report.json"
            if cr.is_file() and cr.stat().st_mtime >= rep_p.stat().st_mtime:
                chk = json.loads(cr.read_text()).get("checks", {})
            elif all((g.cache / "gas" / f"{L}_HI.npy").is_file() for L in mass):
                chk = recheck_columns(g, a)
        cc = grade_column_checks(chk)
        gate("column_checks", cc["hard_pass"], **cc)
        hi_bad = {}
        for L in mass:
            fH, fn = g.cache / "gas" / f"{L}_HI.npy", g.cache / "gas" / f"{L}_nH.npy"
            if fH.is_file() and fn.is_file():
                HI = np.load(fH, mmap_mode="r"); nH = np.load(fn, mmap_mode="r")
                ratio_max = float(np.max(np.where(nH > 0, HI / np.where(nH > 0, nH, 1), 0)))
                hi_bad[L] = ratio_max
        if not hi_bad:
            # float cubes deleted after an earlier passing check: reuse that voxelwise result (same manifest)
            snap = cube_gate_snapshot(g)
            prev = ((snap or {}).get("gates") or {}).get("HI_le_nH") or {}
            if prev.get("max_ratio"):
                hi_bad = dict(prev["max_ratio"])
        gate("HI_le_nH", bool(hi_bad) and all(v <= 1 + 1e-5 for v in hi_bad.values()), max_ratio=hi_bad,
             **({"reused_from": (snap or {}).get("from", "logs/cube_gates.json")} if snap else {}))
        gate("viz_manifest", (g.viz / "manifest_v2.json").is_file() and (g.web / "viz" / "manifest_v2.json").is_file())
        if not snap:
            dump_json(g.logs / "cube_gates.json", {"manifest_sha256": _manifest_sha(g), "from": "check",
                                                   "checked": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                                   "gates": {k: gates[k] for k in CUBE_GATES if k in gates}})
    else:
        gate("cubes_built", False, reason=f"no {rep_p}")
    # fits made with the galaxy's current atomic data and fit parameters (SBI: SBI f, Gamma; review2_physics P1)
    comp_p = g.lib / "components.json"
    if comp_p.is_file():
        from . import components as C
        apply_fit_atomic(g)
        have = json.loads(comp_p.read_text()).get("params_tag")
        gate("fit_params", have == C.params_tag(), components_params_tag=have, expected=C.params_tag())
    # column conservation ray vs cells along a few rays (the cell-h line integral = what the ray deposits)
    st = ray_state(g)
    lN_ok = [s for s in ids if s in st and st[s].get("logN", {}).get("HI") is not None]
    gate("ray_columns_present", len(lN_ok) == len(ids), n=len(lN_ok))
    out = {"galaxy": g.id, "pass": all(v["pass"] for v in gates.values()), "gates": gates,
           "registry_tag": I.registry_tag(), "checked": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    dump_json(g.dir / "check.json", out)
    log(f"check {g.id}: {'PASS' if out['pass'] else 'FAIL'} "
        + ", ".join(f"{k}={'ok' if v['pass'] else 'FAIL'}" for k, v in gates.items()))
    if not out["pass"]:
        raise SystemExit(f"check {g.id}: gates failed: {[k for k, v in gates.items() if not v['pass']]}")
    return {"pass": out["pass"]}


SBI_AOD_TOL_DEX = 0.02      # AOD of the stored (resampled) tau vs the ray column, optically thin metal lines
SBI_WINDOW_MARGIN_KMS = 25.0  # a cell within this of the +-1500 km/s edge already spills its line wing outside


def _sbi_window_truncated(tau) -> bool:
    """Absorption reaches the +-1500 km/s window edge: tau > 1e-4 within 20 km/s of an edge, or tau still rising
    toward an edge (edge value > 1e-7 and above the value 50 km/s inside), i.e. line cores beyond the window."""
    t = np.asarray(tau, dtype=float)
    if t.size < 200:
        return False
    if max(float(t[:40].max()), float(t[-40:].max())) > 1e-4:
        return True
    return bool((t[-1] > 1e-7 and t[-1] > t[-100]) or (t[0] > 1e-7 and t[0] > t[99]))


def sbi_gates(g: Galaxy, ids, gate) -> None:
    """SBI-import gates: velocity frame recovered from the data matches the render metadata (every shard), and the
    stored tau holds the ray column (AOD with our registry f, corrected by the SBI/registry f*lambda ratio, vs the CSR
    column; tau_max < 3, 12 <= logN <= 15.5, metal lines; rays whose absorption reaches the window edge, or that cross
    any cell with |u| > W_SBI - SBI_WINDOW_MARGIN_KMS (sbi_window: gas outside the spectrum; 388544), are counted as
    n_window_truncated, not graded)."""
    from . import library as Lb, ions as I
    src_p = g.lib / "spectra_source.json"
    src = json.loads(src_p.read_text()) if src_p.is_file() else {}
    fc = src.get("frame_checks", {})
    gate("sbi_frame", bool(fc) and all(v.get("pass") is not False for v in fc.values())
         and any(v.get("pass") for v in fc.values()), checks=fc)
    gen = src.get("generation") or {}
    fr = {k: (1.0 if v is None else v) for k, v in (gen.get("f_lambda_ratio") or {}).items()}
    if not fr:
        fr = {k: 1.0 for k in I.KEYS if k != "OVII"}
    devs, worst, n, n_edge, edge_rays = {}, 0.0, 0, 0, []
    from . import sbi as S
    try:
        win = sbi_window(g, [r for r in ray_list(g) if r["id"] in set(ids)])
    except (OSError, KeyError, RuntimeError, ValueError) as e:     # SBI tree unreachable: fall back to the tau test
        log(f"check {g.id}: window velocities unavailable ({e}); tau edge heuristic only")
        win = {}
    n_fast = 0
    for s in ids:
        p = g.lib / "sightlines" / f"{s}.npz"
        if not p.is_file():
            continue
        pl = Lb.load_npz(p, id=s)
        aod = Lb.aod_columns(pl, nd=4)
        # gas moving faster than the +-1500 km/s window (fast outflows through face-on centres) leaves part of the
        # cell column outside the spectrum for every ion on the ray, so truncation is decided per ray (pilot2:
        # 411449 face_b002_a080_s44052, O VI -0.049 / N V -0.038 dex with edge tau only ~1e-4 / 4e-7)
        # (only the graded thin lines trigger it: saturated low ions have Lorentzian wings at the edge, not gas)
        graded = []
        for k in pl["lines"]:
            if k == "HI" or aod.get(k) is None or fr.get(k) is None:
                continue
            lN = float(pl["logN"][k])
            t = np.asarray(pl["tau"][k])
            if not (12.0 <= lN <= 15.5) or float(np.max(t)) >= 3.0:
                continue
            graded.append((k, lN))
        u = win.get(s)
        fast = u is not None and u > S.W_SBI - SBI_WINDOW_MARGIN_KMS
        n_fast += bool(fast)
        if fast or any(_sbi_window_truncated(pl["tau"][k]) for k, _ in graded):
            n_edge += 1
            edge_rays.append(s)
            continue
        for k, lN in graded:
            dv = aod[k] - lN - math.log10(fr[k])
            devs.setdefault(k, []).append(dv)
            n += 1
            worst = max(worst, abs(dv))
    gate("sbi_columns", n > 0 and worst <= SBI_AOD_TOL_DEX, n=n, n_window_truncated=n_edge,
         n_fast_cells=n_fast, window_velocities=bool(win),
         window_truncated_rays=edge_rays[:20],
         max_abs_dex=round(worst, 4), tol=SBI_AOD_TOL_DEX,
         median_dex={k: round(float(np.median(v)), 4) for k, v in devs.items()}, f_lambda_ratio=fr,
         f_eff_OVII=(src.get("f_eff") or {}).get("OVII"), f_registry_OVII=I.get("OVII")["f"])


# ============================================================================== regression against a shipped library
def regress(g: Galaxy, ref: Path, ref_record: Path | None = None, n_rays=None, tol=0.02) -> dict:
    """Compare a pipeline run with the shipped library: frame angle and centre offset against `ref_record`
    (default: the packaged galaxy_488530.json), logN per ion per ray (state lines or npz) against <ref>/catalog.json,
    and cube statistics (float cache) against <ref>/viz_cache/gas when both exist."""
    from . import config
    rec = g.load_record()
    rec = {**rec, **{k: v for k, v in (rec.get("recomputed") or {}).items() if k in ADOPT_KEYS}}   # the recipe's values
    rr = json.loads(Path(ref_record or config.PACKAGED_GALAXY).read_text())
    ang = {k: float(np.degrees(np.arccos(np.clip(np.dot(rec[k], rr[k]), -1, 1)))) for k in ("Lhat", "xhat", "yhat")}
    dc = float(np.linalg.norm(np.asarray(rec["center_kpc"]) - np.asarray(rr["center_kpc"])))
    dv = float(np.linalg.norm(np.asarray(rec["SubhaloVel_kms"]) - np.asarray(rr["SubhaloVel_kms"])))
    out = {"frame_deg": ang, "frame_pass": max(ang.values()) < 1.0, "centre_kpc": dc, "centre_pass": dc < 0.1,
           "SubhaloVel_dkms": dv, "R200c_rel": rec["R200c_kpc"] / rr["R200c_kpc"] - 1}
    refcat = {e["id"]: e for e in json.loads((Path(ref) / "catalog.json").read_text())["entries"]}
    st = ray_state(g)
    rows, worst = [], 0.0
    for sid, s in st.items():
        e = refcat.get(sid)
        if e is None:
            continue
        d = {}
        for k, v in s["logN"].items():
            rv = e["logN"].get(k)
            if v is None or rv is None:
                d[k] = None if (v is None) == (rv is None) else float("inf")
            else:
                d[k] = round(v - rv, 4)
        m = max((abs(x) for x in d.values() if x is not None), default=0.0)
        worst = max(worst, m)
        rows.append({"id": sid, "max_abs_dex": m, "d": d})
    rows.sort(key=lambda r: -r["max_abs_dex"])
    out["rays"] = {"n": len(rows), "max_abs_dex": worst, "pass": bool(rows) and worst <= tol, "tol": tol,
                   "worst": rows[:5],
                   "per_ion_max": {k: max((abs(r["d"][k]) for r in rows if r["d"].get(k) is not None), default=None)
                                   for k in (rows[0]["d"] if rows else {})}}
    rc = Path(ref) / "viz_cache" / "gas"
    cubes = {}
    for f in sorted((g.cache / "gas").glob("L*_*.npy")):
        rf = rc / f.name
        if not rf.is_file() or f.stem.split("_", 1)[1] == "m":
            continue
        A = np.load(f, mmap_mode="r"); B = np.load(rf, mmap_mode="r")
        pos = (A > 0) & (B > 0)
        la, lb = np.log10(np.where(pos, A, 1)), np.log10(np.where(pos, B, 1))
        cubes[f.stem] = {"sum_ratio": float(np.sum(A, dtype=np.float64) / np.sum(B, dtype=np.float64)) if np.sum(B) else None,
                         "nonzero_frac": [float(np.mean(A > 0)), float(np.mean(B > 0))],
                         "median_dlog": float(np.median((la - lb)[pos])) if pos.any() else None,
                         "p99_abs_dlog": float(np.percentile(np.abs(la - lb)[pos], 99)) if pos.any() else None}
    out["cubes"] = cubes
    dump_json(g.dir / "regress.json", out)
    return out


# ============================================================================== CLI
FUNCS = {"record": stage_record, "slim": stage_slim, "import_sbi": stage_import_sbi, "rays": stage_rays, "fits": stage_fits, "cubes": stage_cubes,
         "web": stage_web, "check": stage_check}


def run_stage(stage, g: Galaxy, a) -> int:
    i, n = parse_shard(a.shard)
    sharded = stage in ("rays", "fits", "import_sbi") and (n > 1 or a.ids or a.limit)
    if g.is_done(stage) and not a.force:
        log(f"{stage} {g.id}: DONE marker present, skipped")
        return 0
    if stage != "record" and not g.record.is_file():
        raise SystemExit(f"galaxy {g.id}: run the record stage first")
    t0 = time.time()
    info = FUNCS[stage](g, a)
    complete = True
    if stage == "rays":
        complete = not rays_complete(g)
    elif stage == "import_sbi":
        complete = "skipped" not in info and is_sbi(g) and not rays_complete(g)
    elif stage == "fits":
        complete = bool(info.get("merged"))
    elif stage == "cubes":
        complete = not (a.levels or a.star_levels or a.fields or a.no_stars)     # a partial build never completes
    if n > 1 and stage in ("rays", "fits", "import_sbi") and not (a.ids or a.limit) and "skipped" not in info:
        # per-shard marker (deploy/hpc contract: DONE.<stage>.<i>of<n>, 0-based i): every ray of this shard is done
        # (a failed ray raises SystemExit above, so reaching here means the shard is complete)
        g.mark(f"{stage}.{i}of{n}", t0, info=info)
    if complete:
        g.mark(stage, t0, info=info)
        log(f"{stage} {g.id}: done in {time.time() - t0:.1f} s")
    else:
        log(f"{stage} {g.id}: shard finished in {time.time() - t0:.1f} s; stage not complete yet"
            + (" (subset run)" if (a.ids or a.limit) else ""))
    dump_json(g.logs / f"{stage}{'.' + str(i) + 'of' + str(n) if n > 1 else ''}.stage.json",
              {"wall_s": round(time.time() - t0, 1), "info": info, "peak_rss_gb": peak_rss_gb(),
               "host": socket.gethostname(), "slurm_job": os.environ.get("SLURM_JOB_ID")})
    return 0


def status(g: Galaxy) -> dict:
    out = {"galaxy": g.id, "dir": str(g.dir), "done": {s: g.is_done(s) for s in STAGES}}
    if g.record.is_file() and g.is_done("slim"):
        out["rays_missing"] = len(rays_complete(g))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m tngsight.galpipe", description=__doc__.split("\n\n")[0])
    ap.add_argument("stage", choices=STAGES + ("all", "status", "regress"))
    ap.add_argument("--galaxy", type=int, required=True)
    ap.add_argument("--root", type=Path, default=None)
    ap.add_argument("--shard", default=None, help="i/n (rays, fits): every n-th ray from i")
    ap.add_argument("--workers", type=int, default=int(os.environ.get("SLURM_CPUS_PER_TASK") or 1))
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--ids", default="", help="rays/fits: only these ray ids (testing; never completes the stage)")
    ap.add_argument("--limit", type=int, default=None, help="rays/fits: at most N rays of the shard (testing)")
    ap.add_argument("--levels", default=None, help="cubes: gas levels (default L0,L1,L2)")
    ap.add_argument("--star-levels", default=None, help="cubes: star levels (default S0,S1,S2)")
    ap.add_argument("--fields", default=None, help="cubes: gas fields (default all + vx,vy,vz)")
    ap.add_argument("--no-stars", action="store_true", help="cubes: skip the star cubes and the manifest merge")
    ap.add_argument("--no-adopt", action="store_true", help="record: keep the recomputed 488530 frame/centre "
                    "instead of adopting the shipped ones (recipe regression)")
    ap.add_argument("--spectra", choices=SPECTRA_SOURCES, default="auto",
                    help="import_sbi/rays: spectra source (auto: 488530 Trident, every other galaxy SBI_CGM)")
    ap.add_argument("--n-select", type=int, default=None, help="import_sbi: subset size (default sbi.N_TARGET)")
    ap.add_argument("--ref", type=Path, default=None, help="regress: reference library dir (catalog.json, viz_cache)")
    a = ap.parse_args(argv)
    g = Galaxy(a.galaxy, a.root)
    g.dir.mkdir(parents=True, exist_ok=True)
    if a.stage == "status":
        print(json.dumps(status(g), indent=1))
        return 0
    if a.stage == "regress":
        if a.ref is None:
            ap.error("regress needs --ref")
        print(json.dumps(regress(g, a.ref), indent=1, default=str)[:20000])
        return 0
    stages = STAGES if a.stage == "all" else (a.stage,)
    for s in stages:
        if a.stage == "all" and s == "import_sbi" and (not g.record.is_file()
                                                      or spectra_source(g, a.spectra) == "trident"):
            continue
        run_stage(s, g, a)
        if a.stage == "all" and s in ("import_sbi", "rays", "fits") and not g.is_done(s):
            log(f"all {g.id}: {s} not complete; stopping")
            return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
