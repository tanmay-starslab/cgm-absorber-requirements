"""S0b go/no-go and case selection for the Tier A sightline stories (DESIGN_tierA §2, §3 case/1, §4.3). DRAFT.

    select_cases.py measure   --s0b DIR [--task N ...]   per-ray case/1 measurement -> DIR/measure/<gid>_<ray>.json
    select_cases.py patchtest --s0b DIR --stage DIR [--n 20]   can `patch` re-plan staged stories from the JSON alone?
    select_cases.py select    --s0b DIR                  swap rule over primaries + alternates -> DIR/picks.json

Inputs per ray (written by s0b_chain.sbatch): out/<gid>_<ray>/{story_*.json, page_fits_*.json, clouds_x/, disk.json,
steps.tsv} and work/<gid>_<ray>/ (cells npz + meta; lib_<gid>/ one-ray Trident library on SBI hosts).

Everything is evaluated on the Trident story spectrum (never the SBI catalogue) over +-R200c at the page defaults
(R = 15 000, S/N 10 per resolution element). The SBI library value is read only to report SBI - Trident offsets.
Thresholds are case/1 exactly as written in DESIGN_tierA §3; where §3 leaves an operational detail open the choice is
named in RULE_NOTES and reported, never tuned per ray.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
import export_story_data as E  # noqa: E402  (partial_tau_fn, tau_matrix, segment_box, spectral_minima)

ABSREQ = Path(os.environ.get("ABSREQ_PATH", Path(__file__).resolve().parents[1]))
C_KMS = 299792.458
RULE_VERSION = "case/1"
R_PAGE, SN_PAGE, R_HIGH, NSIG = 15000.0, 10.0, 50000.0, 3.0
ALL_IONS = ("HI", "MgII", "SiII", "CII", "SiIII", "CIV", "OVI", "NeVIII")
EXTRA = {"clean": "CIV", "multiphase": "MgII", "hot": "NeVIII", "damped": None, "empty": None}
PRIORITY = ("damped", "empty", "hot", "multiphase", "clean")
CASE_ID = {"damped": "damped", "empty": "empty", "hot": "hot_only", "multiphase": "multiphase", "clean": "clean_single"}
MERGE_KPC, CAND_FRAC = 5.0, 0.05          # letters/2 step 1
LETTER_TAU0 = 0.05                         # an encounter is "letterable" when its lead-ion partial peak tau >= this
MARGIN_MIN = 0.1                           # §3: each pick's margin must be >= 0.1 in its own case
CELL_FIELD = {"HI": "H_p0_number_density", "MgII": "Mg_p1_number_density", "SiII": "Si_p1_number_density",
              "CII": "C_p1_number_density", "SiIII": "Si_p2_number_density", "CIV": "C_p3_number_density",
              "OVI": "O_p5_number_density", "NeVIII": "Ne_p7_number_density"}
ELEM = {"HI": "H", "MgII": "Mg", "SiII": "Si", "CII": "C", "SiIII": "Si", "CIV": "C", "OVI": "O", "NeVIII": "Ne"}
ABS_NAME = {"HI": ("H I", 1215.67), "MgII": ("Mg II", 2796.35), "SiII": ("Si II", 1260.42), "CII": ("C II", 1334.53),
            "SiIII": ("Si III", 1206.50), "CIV": ("C IV", 1548.19), "OVI": ("O VI", 1031.91), "NeVIII": ("Ne VIII", 770.41)}
RULE_NOTES = {
    "page_fit": "page fits are the precomputed story_fits.mjs cases; none is exactly (R 15000, S/N 10): grid4 "
                "R 15000 S/N 20 is used, the R 15000 S/N 5 and default R 30000 S/N 10 fits are reported beside it",
    "encounters": "letters/2 step 1 boundaries (CREST clouds of the exported ions >= 5 % of the column, merged within "
                  "5 kpc); an encounter's column, share, lead ion (largest tau0 sum) and partial spectrum use ALL ray "
                  "cells with kernel centre inside [l0, l1] (CREST drops compact one-cell clumps)",
    "encounter_peak": "per-encounter peak tau and spectral minimum = max / argmax of the window cells' intrinsic "
                      "Doppler-core tau(V), galaxy frame, 1 km/s grid",
    "cool_encounter": "cool = encounter with Mg II partial peak tau >= 0.05 or H I window column >= 10^15 (§3)",
    "minima": "cool speed from the H I partial spectrum (Mg II when N_HI < 1e15), warm speed from O VI",
    "two_h": "h = the larger kernel support radius of the two encounters' peak-column cells",
    "letterable": f"lettered encounter = an encounter whose lead-ion partial peak tau >= {LETTER_TAU0}",
    "ovi_trough_broad": "broad = O VI tau-weighted cell b >= 30 km/s or widest page-fit O VI b >= 40 km/s (proposal)",
    "detection": "3 sigma matched filter on the whole Trident spectrum: S = (S/N) sqrt(Int D^2 dv / FWHM), D = 1 - F_R",
    "margins": "signed margin of each condition: logN in dex, tau in dex (log10 ratio), fractions as difference, "
               "speed and width tests as (value - threshold)/threshold",
}


# ------------------------------------------------------------------------------------------------ spectra
def lsf(F, dv, R):
    s = C_KMS / R / 2.3548 / dv
    n = int(6 * s) + 1
    x = np.arange(-n, n + 1); k = np.exp(-0.5 * (x / s) ** 2); k /= k.sum()
    return np.convolve(np.pad(F, n, mode="edge"), k, mode="valid")


def load_spec(npz):
    from tngsight.library import load_npz
    p = load_npz(str(npz), id=Path(npz).stem)
    vs = float(p.get("v_sys") if p.get("v_sys") is not None else p["geom"].get("v_sys_kms", 0.0))
    out = {"v_sys": vs, "geom": p["geom"], "ions": {}}
    for k in ALL_IONS:
        if k not in p["tau"]:
            continue
        tau = np.asarray(p["tau"][k], float)
        lam = p["lam0"][k] + np.arange(tau.size) * p["dlam"][k]
        u = C_KMS * (lam / p["rest"][k] - 1)
        out["ions"][k] = {"V": u + vs, "tau": tau, "logN": float(p["logN"][k])}
    return out


def black_run(V, F, thr=0.05):
    """widest contiguous run with F < thr: (width km/s, lo, hi)"""
    m = F < thr
    best, i = (0.0, None, None), 0
    while i < len(m):
        if m[i]:
            j = i
            while j + 1 < len(m) and m[j + 1]:
                j += 1
            w = V[j] - V[i]
            if w > best[0]:
                best = (float(w), float(V[i]), float(V[j]))
            i = j + 1
        else:
            i += 1
    return best


def ion_metrics(s):
    V, tau = s["V"], s["tau"]
    dv = float(np.median(np.diff(V)))
    F = np.exp(-tau); F15 = lsf(F, dv, R_PAGE); F50 = lsf(F, dv, R_HIGH)
    fwhm = C_KMS / R_PAGE
    K = math.sqrt(float(np.sum((1 - F15) ** 2) * dv) / fwhm)
    k = int(np.argmax(tau))
    bw, blo, bhi = black_run(V, F15)
    ew_kms = float(np.sum(1 - F15) * dv)
    core = (V >= blo) & (V <= bhi) if bw > 0 else np.zeros_like(V, bool)
    ew_core = float(np.sum((1 - F15)[core]) * dv)
    return {"logN": s["logN"], "peak_tau": float(tau.max()), "V_peak": float(V[k]), "F_min_intr": float(F.min()),
            "F15_min": float(F15.min()), "F50_min": float(F50.min()), "r_contrast": float(F15.min() - F50.min()),
            "S_det": SN_PAGE * K, "detected_3sig": bool(SN_PAGE * K >= NSIG), "black15_width_kms": bw,
            "black15_range": [blo, bhi], "EW15_kms": ew_kms,
            "wing_frac": (ew_kms - ew_core) / ew_kms if ew_kms > 0 and bw > 0 else None,
            "edge_tau": float(max(tau[0], tau[-1])), "V_window": [float(V[0]), float(V[-1])]}


def limit_3sig(ion, sn=SN_PAGE, R=R_PAGE):
    """3 sigma minimum detectable log N at b = b_fid with absreq.detection's K (Gaussian LSF, S/N per resel)."""
    sys.path.insert(0, str(ABSREQ))
    from absreq.lines import get_line, CGM_IONS
    from absreq.detection import k_cube, logN_min
    name, lam = ABS_NAME[ion]
    row = next(r for r in CGM_IONS if r[0] == name)
    L = get_line(*row)
    logN = np.arange(9.0, 17.0, 0.02)
    K = k_cube(L, logN, np.array([L.b_fid]), np.array([R]))[:, 0, 0]
    return {"logN_3sig": round(logN_min(logN, K, sn), 3), "sn": sn, "R": R, "b": round(float(L.b_fid), 2),
            "method": "absreq.detection k_cube/logN_min, 3 sigma, b = b_fid"}


# ------------------------------------------------------------------------------------------------ cells and clouds
def cell_columns(work, gid, ray, meta_lines):
    """per-cell N, b, V (galaxy frame) for every ion from the ray dump; V from the story JSON's H I cells (same order)"""
    z = np.load(Path(work) / f"{gid}_{ray}_cells.npz")
    dl = z["dl"].astype(float)
    T = z["temperature"].astype(float)
    out = {}
    for k, f in CELL_FIELD.items():
        if f not in z.files:
            continue
        N = z[f].astype(float) * dl
        b = np.sqrt(2 * E.KB * T / (E.TRIDENT_MASS[ELEM[k]] * E.AMU)) / 1e5
        ft, lam0 = meta_lines[k]
        out[k] = {"N": N, "b": b, "tau0": 1.4975e-15 * ft * lam0 * N / np.maximum(b, 1e-3)}
    return out, T


def osc(ion):
    sys.path.insert(0, str(ABSREQ))
    from absreq.lines import get_line, CGM_IONS
    name, lam = ABS_NAME[ion]
    L = get_line(*next(r for r in CGM_IONS if r[0] == name))
    return float(L.f), float(L.lam)


def encounters(cw, cellcols, exported, lc, h, V):
    """letters/2 step 1: CREST clouds of the exported ions with frac_ion_column >= 0.05, l-ranges merged when they overlap
    or lie within 5 kpc. CREST sets the encounter BOUNDARIES only; every column, lead ion and partial spectrum below
    comes from all ray cells whose kernel centre lies inside [l0, l1] (CREST drops compact one-cell clumps: on
    rand_b092_a287 and rand_b139_a096 the H I and C IV clumps have no CREST cloud at all)."""
    cands = []
    for ion in exported:
        if ion not in cw.get("ions", {}):
            continue
        for c in cw["ions"][ion]["clouds"]:
            if c["frac_ion_column"] >= CAND_FRAC:
                cands.append(dict(ion=ion, id=c["id"], l0=c["l_in"], l1=c["l_out"], f=c["frac_ion_column"],
                                  r90=c.get("r_perp_90"), V=c.get("V")))
    cands.sort(key=lambda c: c["l0"])
    groups = []
    for c in cands:
        if groups and c["l0"] <= groups[-1]["l1"] + MERGE_KPC:
            g = groups[-1]; g["l1"] = max(g["l1"], c["l1"]); g["clouds"].append(c)
        else:
            groups.append({"l0": c["l0"], "l1": c["l1"], "clouds": [c]})
    vg = np.arange(-400, 401, 1.0)
    out = []
    for i, g in enumerate(groups):
        m = (lc >= g["l0"]) & (lc <= g["l1"])
        idx = np.flatnonzero(m)
        share, t0, logN, spec = {}, {}, {}, {}
        for ion, cc in cellcols.items():
            Nt = cc["N"].sum()
            share[ion] = float(cc["N"][idx].sum() / Nt) if Nt > 0 else 0.0
            logN[ion] = round(math.log10(max(cc["N"][idx].sum(), 1e-30)), 3)
            t0[ion] = float(cc["tau0"][idx].sum())
            # partial intrinsic spectrum (Doppler cores) of the window's cells
            tau = (cc["tau0"][idx, None] * np.exp(-((vg[None, :] - V[idx, None]) / np.maximum(cc["b"][idx, None], 1e-3)) ** 2)).sum(0)
            spec[ion] = {"V_min": float(vg[int(np.argmax(tau))]), "tau_peak": float(tau.max())}
        lead = max(exported, key=lambda k: (t0.get(k, 0), k == "HI"))
        w = sum(cellcols[k]["N"][idx] / max(cellcols[k]["N"].sum(), 1e-30) for k in exported if k in cellcols)
        lcen = float(np.sum(w * lc[idx]) / np.sum(w)) if idx.size and np.sum(w) > 0 else 0.5 * (g["l0"] + g["l1"])
        pk = int(idx[np.argmax(w)]) if idx.size else None
        out.append({"id": f"e{i}", "l0": g["l0"], "l1": g["l1"], "lc": lcen, "n_cells": int(idx.size),
                    "r90": max((c["r90"] or 0) for c in g["clouds"]), "share": share, "logN": logN, "tau0_sum": t0,
                    "lead": lead, "V": spec, "clouds": [c["id"] for c in g["clouds"]],
                    "h_peak": float(h[pk]) if pk is not None else 0.0, "idx": idx,
                    "letterable": bool(spec.get(lead, {}).get("tau_peak", 0) >= LETTER_TAU0)})
    return out


def partial_spec(d, ion, members):
    """intrinsic tau(V) of an encounter's member cells (story JSON per-cell Voigt, 1 km/s galaxy-frame grid)"""
    ic = d["ions"][ion]; cells = ic["cells"]
    vg = np.arange(-400, 401, 1.0)
    idx = np.asarray(members, int)
    N = np.array([10 ** cells["logN"][i] if cells["logN"][i] is not None else 0.0 for i in idx])
    tm = E.tau_matrix(ic["atom"], N, np.asarray(cells["V"], float)[idx], np.asarray(cells["b"], float)[idx],
                      np.asarray(cells["a"], float)[idx], vg)
    return vg, tm.sum(axis=0)


# ------------------------------------------------------------------------------------------------ geometry checks
def cube_cover(ray):
    p0, p1 = np.asarray(ray["p0"], float), np.asarray(ray["p1"], float)
    out = {"end_r_kpc": round(float(max(np.linalg.norm(p0), np.linalg.norm(p1))), 1)}
    for lv, hk in (("L0", 400.0), ("L1", 100.0), ("L2", 25.0)):
        seg = E.segment_box(p0, p1, hk)
        out[f"frac_in_{lv}"] = 0.0 if seg is None else round(seg[1] - seg[0], 4)
    out["finest_bins"] = {"L2": out["frac_in_L2"], "L1": round(out["frac_in_L1"] - out["frac_in_L2"], 4),
                          "L0": round(out["frac_in_L0"] - out["frac_in_L1"], 4),
                          "none": round(1 - out["frac_in_L0"], 4)}
    return out


def g19_estimate(ray, encs, disk, fov_deg=45.0, aspect=16 / 9, nphi=72, rng=None):
    """Quick G19 feasibility: tableau views perpendicular to the ray, >= 60 deg from the disk normal (z of the disk
    frame), framed to fit the bounds (distance r_bound/tan(fov/2) x 1.15). Reports the smallest disk-ellipse share of
    the frame over the allowed views, for the whole-ray tableau and the lettered-encounter tableau, and whether the
    camera would sit in the forbidden slab (|z| < 2 kpc within 30 kpc)."""
    rng = np.random.default_rng(3) if rng is None else rng   # fresh per call: order-independent
    n = np.asarray(ray["n"], float); n /= np.linalg.norm(n)
    p0 = np.asarray(ray["p0"], float); half = float(ray["half"])
    z = np.array([0, 0, 1.0])
    e1 = np.cross(n, z); e1 = e1 / np.linalg.norm(e1) if np.linalg.norm(e1) > 1e-6 else np.array([1.0, 0, 0])
    e2 = np.cross(n, e1)
    rd = float(disk["disk_radius_kpc"])
    # disk sample points (uniform on the disk of radius rd in the z = 0 plane)
    m = 20000
    rr = rd * np.sqrt(rng.uniform(0, 1, m)); th = rng.uniform(0, 2 * np.pi, m)
    dp = np.stack([rr * np.cos(th), rr * np.sin(th), np.zeros(m)], 1)
    targets = {"ray": (p0 + half * n, half)}
    if encs:
        lo, hi = min(e["l0"] for e in encs), max(e["l1"] for e in encs)
        rb = max(0.5 * (hi - lo) + 0.5 * max((e["r90"] or 0) for e in encs), 10.0)
        targets["encounters"] = (p0 + (0.5 * (lo + hi) + half) * n, rb)
        for e in encs:                      # close-up framing of each lettered encounter (cloud orbit / stop)
            rbe = max(0.5 * (e["l1"] - e["l0"]) + 0.5 * (e["r90"] or 0), 10.0)
            targets["closeup_" + e["id"]] = (p0 + (e["lc"] + half) * n, rbe)
    out = {"disk_radius_kpc": rd, "fov_deg": fov_deg, "rule": "<= 15 % of frame, view >= 60 deg from disk normal"}
    for name, (tc, rb) in targets.items():
        best, worst, n_ok, n_all = None, None, 0, 0
        for phi in np.linspace(0, 2 * np.pi, nphi, endpoint=False):
            v = math.cos(phi) * e1 + math.sin(phi) * e2       # view direction (camera -> target)
            if abs(float(v @ z)) > 0.5:                        # closer than 60 deg to the normal
                continue
            D = rb / math.tan(math.radians(fov_deg) / 2) * 1.15
            cam = tc - D * v
            slab = bool(abs(cam[2]) < 2 and np.linalg.norm(cam) < 30)
            up = np.cross(np.cross(v, z), v); up = up / np.linalg.norm(up) if np.linalg.norm(up) > 1e-6 else n
            side = np.cross(v, up)
            hh = D * math.tan(math.radians(fov_deg) / 2); hw = hh * aspect
            rel = dp - cam                                    # disk points from the camera
            depth = rel @ v
            x = (rel @ side) / np.maximum(depth, 1e-6) * D; y = (rel @ up) / np.maximum(depth, 1e-6) * D
            inside = (depth > 0) & (np.abs(x) < hw) & (np.abs(y) < hh)
            # projected disk area inside the frame, at the target-plane scale: each sample carries pi rd^2 / m of disk,
            # foreshortened by |v.z| and scaled by (D / depth)^2 for perspective
            dA = math.pi * rd ** 2 / m * abs(float(v @ z))
            area = float(np.sum(dA * (D / depth[inside]) ** 2)) if inside.any() else 0.0
            frac = area / (4 * hh * hw)
            cand = {"phi_deg": round(math.degrees(phi), 1), "view_from_normal_deg": round(math.degrees(math.acos(abs(float(v @ z)))), 1),
                    "disk_frame_frac": round(frac, 4), "camera_in_slab": slab, "r_bound_kpc": round(rb, 1)}
            if not slab and (best is None or frac < best["disk_frame_frac"]):
                best = cand
            if worst is None or frac > worst["disk_frame_frac"] or (slab and not worst["camera_in_slab"]):
                worst = cand
            n_ok += int(frac <= 0.15 and not slab); n_all += 1
        out[name] = {"best": best, "worst": worst, "frac_of_allowed_views_passing": round(n_ok / max(n_all, 1), 3)}
        out[name + "_ok"] = bool(best and best["disk_frame_frac"] <= 0.15)
    cl = {k: v for k, v in out.items() if k.startswith("closeup_") and not k.endswith("_ok")}
    out["closeups_worst_share"] = max((v["worst"]["disk_frame_frac"] for v in cl.values() if v["worst"]), default=None)
    out["closeups_min_pass_frac"] = min((v["frac_of_allowed_views_passing"] for v in cl.values()), default=None)
    out["closeups_ok"] = all(out[k + "_ok"] for k in cl)
    return out


# ------------------------------------------------------------------------------------------------ case rules
def dex(x, thr, above=True):
    """signed dex margin of x >= thr (above) or x < thr"""
    if x is None or thr is None:
        return None
    x = max(float(x), 1e-30)
    return math.log10(x / thr) if above else math.log10(thr / x)


def cond(name, value, margin, unit):
    return {"name": name, "value": value, "margin": None if margin is None else round(float(margin), 3),
            "unit": unit, "pass": bool(margin is not None and margin >= 0)}


def verdict(conds):
    """boolean/count conditions gate pass/fail only; the score is the weakest numeric margin (dex or fraction)"""
    ok = all(c["pass"] for c in conds)
    num = [c for c in conds if c["unit"] not in ("bool", "count") and c["margin"] is not None]
    ms = [c["margin"] for c in num]
    fails = [c for c in conds if not c["pass"]]
    weakest = fails[0] if fails else (min(num, key=lambda c: c["margin"]) if num else conds[0])
    return {"ok": ok, "score": round(min(ms), 3) if ms else None, "weakest": weakest["name"],
            "fails": [c["name"] for c in conds if not c["pass"]], "conditions": conds,
            "margin_ok": bool(ok and min(ms) >= MARGIN_MIN) if ms else False}


def rule_damped(M):
    hi = M["ions"]["HI"]
    return verdict([cond("logN(HI) >= 19.0", hi["logN"], hi["logN"] - 19.0, "dex")])


def rule_empty(M):
    I = M["ions"]; exp = ["HI", "OVI"]
    det = [k for k in exp if I[k]["detected_3sig"]]
    sdet = max(I[k]["S_det"] for k in exp)
    c = [cond("logN(HI) < 13.5", I["HI"]["logN"], 13.5 - I["HI"]["logN"], "dex"),
         cond("logN(OVI) < 13.3", I["OVI"]["logN"], 13.3 - I["OVI"]["logN"], "dex"),
         cond("HI peak tau < 0.3", I["HI"]["peak_tau"], dex(I["HI"]["peak_tau"], 0.3, False), "dex"),
         cond("OVI peak tau < 0.1", I["OVI"]["peak_tau"], dex(I["OVI"]["peak_tau"], 0.1, False), "dex"),
         cond("no exported ion with 3 sigma detection", {k: round(I[k]["S_det"], 2) for k in exp},
              (NSIG - sdet) / NSIG, "frac"),
         cond("no lettered encounter", M["n_letterable"], 0.0 if M["n_letterable"] == 0 else -1.0, "count")]
    return verdict(c)


def rule_hot(M):
    I = M["ions"]
    low = max(I[k]["peak_tau"] for k in ("MgII", "SiII", "CII"))
    c = [cond("logN(OVI) >= 14.0", I["OVI"]["logN"], I["OVI"]["logN"] - 14.0, "dex"),
         cond("OVI peak tau >= 0.5", I["OVI"]["peak_tau"], dex(I["OVI"]["peak_tau"], 0.5), "dex"),
         cond("logN(HI) < 14.5", I["HI"]["logN"], 14.5 - I["HI"]["logN"], "dex"),
         cond("HI peak tau < 1", I["HI"]["peak_tau"], dex(I["HI"]["peak_tau"], 1.0, False), "dex"),
         cond("MgII, SiII, CII peak tau < 0.05", round(low, 5), dex(low, 0.05, False), "dex"),
         cond("NeVIII exported", "NeVIII" in I, 0.0 if "NeVIII" in I else -1.0, "bool")]
    return verdict(c)


def rule_multiphase(M):
    best = M.get("mp_pair")
    if not best:
        return verdict([cond("cool encounter and O VI-led encounter exist", M.get("mp_why"), -1.0, "bool")])
    return verdict([cond("cool encounter", best["cool_why"], 0.0, "bool"),
                    cond("O VI-led encounter logN(OVI) >= 13.5", best["warm_logN_OVI"], best["warm_logN_OVI"] - 13.5, "dex"),
                    cond("minima differ >= max(40, 2 b_OVI)", best["dv"], (best["dv"] - best["dv_thr"]) / best["dv_thr"], "frac"),
                    cond("l-centres >= 2 h apart", best["dl"], (best["dl"] - best["dl_thr"]) / best["dl_thr"], "frac")])


def rule_clean(M):
    I = M["ions"]; e = M.get("clean_enc")
    if e is None:
        return verdict([cond("an encounter exists", None, -1.0, "bool")])
    t = I["OVI"]["peak_tau"]
    c = [cond("one encounter >= 70 % of OVI column", round(e["share"].get("OVI", 0), 3), e["share"].get("OVI", 0) - 0.7, "frac"),
         cond("same encounter >= 70 % of CIV column", round(e["share"].get("CIV", 0), 3), e["share"].get("CIV", 0) - 0.7, "frac"),
         cond("logN(HI) < 17.2", I["HI"]["logN"], 17.2 - I["HI"]["logN"], "dex"),
         cond("OVI peak tau in 0.3-3", t, min(dex(t, 0.3), dex(t, 3.0, False)), "dex")]
    for k, (dv, tol) in M["clean_minima"].items():
        c.append(cond(f"{k} minimum within max(15, b) of c1_v", round(dv, 1), (tol - dv) / tol, "frac"))
    return verdict(c)


RULES = {"damped": rule_damped, "empty": rule_empty, "hot": rule_hot, "multiphase": rule_multiphase, "clean": rule_clean}


# ------------------------------------------------------------------------------------------------ measure one ray
def page_fit(pf, ion, R=15000, snr=20, case=None):
    for c in (pf or {}).get("cases", []):
        if c["ion"] == ion and c["R"] == R and c["snr"] == snr and (case is None or c["case"] == case):
            return c
    return None


def mp_pairs(encs, cellcols):
    """multiphase candidates (§3): every (cool encounter, O VI-led encounter) pair with its speeds and separations, the
    best pair (largest weakest margin) and, when there is none, why. Used by measure_core and by the letters/2 pin."""
    pairs = []
    for a in encs:
        mg_ok = a["V"].get("MgII", {}).get("tau_peak", 0) >= 0.05
        nhi = 10 ** a["logN"].get("HI", -30)
        if not (mg_ok or nhi >= 1e15):
            continue
        for b in encs:
            if b is a or b["lead"] != "OVI":
                continue
            idx = b["idx"]; N = cellcols["OVI"]["N"][idx]
            bovi = float(np.sum(N * cellcols["OVI"]["b"][idx]) / max(N.sum(), 1e-30))
            vc = a["V"]["HI"]["V_min"] if nhi >= 1e15 else a["V"]["MgII"]["V_min"]
            vw = b["V"]["OVI"]["V_min"]
            pairs.append({"cool": a["id"], "warm": b["id"],
                          "cool_why": f"MgII tau {a['V'].get('MgII', {}).get('tau_peak', 0):.2f}, N_HI {nhi:.2e}",
                          "warm_logN_OVI": b["logN"]["OVI"], "v_cool": vc, "v_warm": vw, "dv": abs(vc - vw),
                          "b_OVI": round(bovi, 1), "dv_thr": max(40.0, 2 * bovi), "dl": abs(a["lc"] - b["lc"]),
                          "dl_thr": 2 * max(a["h_peak"], b["h_peak"])})
    if pairs:
        best = max(pairs, key=lambda p: min(p["warm_logN_OVI"] - 13.5, (p["dv"] - p["dv_thr"]) / p["dv_thr"],
                                            (p["dl"] - p["dl_thr"]) / p["dl_thr"]))
        return pairs, best, None
    cool = [e["id"] for e in encs if e["V"].get("MgII", {}).get("tau_peak", 0) >= 0.05 or 10 ** e["logN"].get("HI", -30) >= 1e15]
    return pairs, None, ("no cool encounter" if not cool else "no O VI-led encounter (lead = largest tau0 sum)")


def measure_core(M, case, extra, d, pf, cellcols, T, cw, cw_path=None):
    """case/1 measurement shared by S0b (measure_ray) and the production build (story_plan.py): encounters (letters/2
    step 1), the clean and multiphase candidates, every rule in priority order, the declared case's verdict and its
    claims. M must already hold "ions" (ion_metrics per ion) and "trident_npz". d is the story JSON (/2 keys), cw the
    CREST clouds.json of the exported ions (None when CREST found nothing). Returns the encounters (with cell idx)."""
    # encounters (letters/2 boundaries from CREST clouds of the declared case's exported ions), cell-window columns
    encs = []
    exported = ["HI", "OVI"] + ([extra] if extra else [])
    M["exported"] = exported
    if d is not None and cellcols:
        g = d["geometry"]["cells"]; lc = np.asarray(g["lc"], float); h = np.asarray(g["h"], float)
        Vc = np.asarray(d["ions"]["HI"]["cells"]["V"], float)
        assert len(Vc) == len(cellcols["HI"]["N"]) == len(lc), "cell order mismatch between story JSON and ray dump"
        if cw is not None:
            encs = encounters(cw, cellcols, exported, lc, h, Vc)
            M["cw_path"] = None if cw_path is None else str(cw_path)
        else:
            M["cw_path"] = None
            M["cw_note"] = "no clouds.json (CREST failed: no non-percolating level, or no gas)"
    M["encounters"] = [{k: v for k, v in e.items() if k != "idx"} for e in encs]
    M["n_letterable"] = sum(1 for e in encs if e.get("letterable"))
    # clean: the encounter with the largest O VI share; minima tests against c1_v
    if encs:
        e = max(encs, key=lambda e: e["share"].get("OVI", 0))
        M["clean_enc"] = {"id": e["id"], "share": {k: round(v, 3) for k, v in e["share"].items()}}
        idx = e["idx"]; N = cellcols["OVI"]["N"][idx]
        c1v = float(np.sum(N * Vc[idx]) / N.sum()) if N.sum() > 0 else None
        M["c1_v"] = None if c1v is None else round(c1v, 1)
        mins = {}
        for k in ["HI", "OVI"] + (["CIV"] if "CIV" in exported else []):
            im = M["ions"][k]
            if im["peak_tau"] >= 0.3 and c1v is not None:
                vmin = 0.5 * sum(im["black15_range"]) if im["black15_width_kms"] > 0 and k == "HI" else im["V_peak"]
                bb = float(np.sum(cellcols[k]["N"][idx] * cellcols[k]["b"][idx]) / max(cellcols[k]["N"][idx].sum(), 1e-30))
                mins[k] = (abs(vmin - c1v), max(15.0, bb))
        M["clean_minima"] = mins
    # multiphase: best (cool, O VI-led) pair
    pairs, best, why = mp_pairs(encs, cellcols)
    if best is not None:
        M["mp_pair"] = best
    else:
        M["mp_why"] = why
    M["mp_pairs"] = pairs
    # case/1 rules (classifier in priority order) and the declared case's verdict
    M["case"] = {"declared": CASE_ID[case], "rule_version": RULE_VERSION, "scores": {}, "fails": {}, "verdicts": {}}
    label = "generic"
    for k in PRIORITY:
        try:
            v = RULES[k](M)
        except (KeyError, TypeError, ValueError) as exc:
            v = {"ok": False, "score": None, "fails": [f"error: {exc!r}"], "conditions": [], "margin_ok": False}
        M["case"]["verdicts"][k] = v
        M["case"]["scores"][CASE_ID[k]] = v["score"]; M["case"]["fails"][CASE_ID[k]] = v["fails"]
        if v["ok"] and label == "generic":
            label = CASE_ID[k]
    M["case"]["id"] = label
    M["case"]["subcase"] = ("dla" if M["ions"]["HI"]["logN"] >= 20.3 else "lls") if M["ions"]["HI"]["logN"] >= 19 else None
    M["case"]["verdict"] = M["case"]["verdicts"][case]
    M["claims"] = claims(case, M, d, pf, cellcols, T, encs)
    return encs


def measure_ray(s0b: Path, row) -> dict:
    tid, case, role, gid, ray, extra = row[:6]
    gid = int(gid); extra = None if extra == "-" else extra
    if len(row) > 6 and row[6]:
        os.environ["TNG_STORY_LIBRARY"] = row[6]
    else:
        os.environ.pop("TNG_STORY_LIBRARY", None)
    out_d, work = s0b / "out" / f"{gid}_{ray}", s0b / "work" / f"{gid}_{ray}"
    steps = {}
    if (out_d / "steps.tsv").exists():
        for ln in (out_d / "steps.tsv").read_text().split("\n"):
            if ln.strip():
                k, rc, w = ln.split("\t"); steps[k] = {"rc": int(rc), "wall_s": int(w)}
    M = {"task": int(tid), "declared": case, "role": role, "galaxy": gid, "ray": ray, "extra_ion": extra,
         "rule_version": RULE_VERSION, "steps": steps, "page": {"R": R_PAGE, "sn": SN_PAGE}}
    lib = work / f"lib_{gid}" / "sightlines" / f"{ray}.npz"
    sbi_npz = None
    if not lib.exists():
        lib = E.galaxy_paths(gid)["library"] / "sightlines" / f"{ray}.npz"
    else:
        sbi_npz = E.galaxy_paths(gid)["library"] / "sightlines" / f"{ray}.npz"
    M["trident_npz"] = str(lib)
    sp = load_spec(lib)
    M["v_sys"] = sp["v_sys"]
    M["ions"] = {k: ion_metrics(v) for k, v in sp["ions"].items()}
    # SBI - Trident offsets (same geometry; SBI spans its own window, the Trident re-cast spans +-R200c)
    if sbi_npz is not None and sbi_npz.exists():
        sb = load_spec(sbi_npz)
        M["sbi_minus_trident"] = {k: round(sb["ions"][k]["logN"] - sp["ions"][k]["logN"], 3) for k in ALL_IONS
                                  if k in sb["ions"] and k in sp["ions"]
                                  and sb["ions"][k]["logN"] > 5 and sp["ions"][k]["logN"] > 5}
        M["sbi_peak_tau"] = {k: round(float(sb["ions"][k]["tau"].max()), 4) for k in ("HI", "OVI", "NeVIII") if k in sb["ions"]}
        M["sbi_half_kpc"] = sb["geom"].get("half_kpc")
    else:
        M["sbi_minus_trident"] = None
        M["sbi_note"] = "488530 rays: catalogue already Trident (library_v3r); no SBI spectrum on this id"
    story_p = out_d / f"story_{gid}_{ray}.json"
    d = json.loads(story_p.read_text()) if story_p.exists() else None
    pf_p = out_d / f"page_fits_{gid}_{ray}.json"
    pf = json.loads(pf_p.read_text()) if pf_p.exists() else None
    M["story_built"] = d is not None
    lines = {k: osc(k) for k in CELL_FIELD}
    cellcols, T = ({}, None)
    if (work / f"{gid}_{ray}_cells.npz").exists():
        cellcols, T = cell_columns(work, gid, ray, lines)
        meta = json.loads((work / f"{gid}_{ray}_meta.json").read_text())
        M["cell_logN"] = {k: round(math.log10(max(v["N"].sum(), 1e-30)), 3) for k, v in cellcols.items()}
        M["trident_cols_meta"] = {k: round(float(v), 3) for k, v in meta.get("cols", {}).items() if k in ALL_IONS}
    # parity (fail-loud in build): the build's own checks
    if d is not None:
        ch = d["meta"].get("checks", {})
        M["parity"] = {k: {"dF": ch[k].get("max_abs_dF_cellsum_vs_stored"), "dF_limit": ch[k].get("dF_limit"),
                           "EW_rel": ch[k].get("EW_rel"), "EW_limit": ch[k].get("EW_limit"),
                           "logN_cells": ch[k].get("logN_cells")} for k in ("HI", "OVI") if k in ch}
        M["parity_ok"] = steps.get("build2", {}).get("rc") == 0
    cw_p = out_d / "clouds_x" / f"{gid}_{ray}" / "clouds.json"
    if not cw_p.exists():
        cw_p = out_d / "clouds" / f"{gid}_{ray}" / "clouds.json"
    cw = json.loads(cw_p.read_text()) if cw_p.exists() else None
    encs = measure_core(M, case, extra, d, pf, cellcols, T, cw, cw_p if cw is not None else None)
    # geometry
    if d is not None:
        ray_g = d["geometry"]["ray"]
        M["cube_cover"] = cube_cover(ray_g)
        disk_p = out_d / "disk.json"
        if disk_p.exists():
            disk = json.loads(disk_p.read_text())
            M["disk"] = disk
            lett = [e for e in encs if e.get("letterable")]
            M["g19"] = g19_estimate(ray_g, lett, disk)
    if case == "empty" or M["case"]["id"] == "empty":
        M["limits"] = {k: limit_3sig(k) for k in ("HI", "OVI")}
    return M


def claims(case, M, d, pf, cellcols, T, encs) -> dict:
    I = M["ions"]; C = {}
    fit = lambda ion: page_fit(pf, ion)   # noqa: E731
    if case == "damped":
        hi = I["HI"]
        C["hi_black_core"] = {"value": hi["black15_width_kms"], "pass": hi["black15_width_kms"] >= 50}
        C["wing_frac"] = {"value": hi["wing_frac"], "pass": bool(hi["wing_frac"] is not None and hi["wing_frac"] >= 0.2)}
        f = fit("HI"); cs = d["ions"]["HI"]["totals"]["logN"] if d else None
        C["hi_fit_dhi"] = {"value": None if not f or cs is None else round(f["total_logN"] - cs, 3),
                           "pass": bool(f and cs is not None and abs(f["total_logN"] - cs) <= 0.15),
                           "fit": "grid4 R15000 S/N20"}
        top = max((e["share"].get("HI", 0) for e in encs), default=0)
        tot = sum(e["share"].get("HI", 0) for e in encs)
        C["hi_encounter_80"] = {"value": {"largest_single": round(top, 3), "all_encounters": round(tot, 3)},
                                "pass": top >= 0.8,
                                "note": "largest single-encounter share of the H I column (cells inside the encounter "
                                        "window; boundaries from CREST clouds >= 5 %, merged at 5 kpc)"}
        rc = {k: round(I[k]["r_contrast"], 3) for k in ("HI", "OVI")}
        C["resolve_saturated"] = {"value": rc, "pass": all(v < 0.15 for v in rc.values())}
        C["hi_damped"] = {"value": I["HI"]["logN"], "pass": I["HI"]["logN"] >= 20.3}
    elif case == "empty":
        C["limits"] = {"value": {k: limit_3sig(k) for k in ("HI", "OVI")}, "pass": True}
        C["noise_dip"] = {"value": None, "pass": None, "note": "noise seed search is an R1 step (§4.4 item 6)"}
    elif case == "hot":
        t = I["HI"]["peak_tau"]
        C["hi_faint"] = {"value": round(t, 4), "pass": 0.05 <= t <= 1}
        ne = I.get("NeVIII")
        C["has_neviii"] = {"value": None if not ne else {"logN": round(ne["logN"], 3), "F15_min": round(ne["F15_min"], 3)},
                           "pass": bool(ne and ne["logN"] >= 13.5 and ne["F15_min"] < 0.9)}
        if d is not None:
            ic = d["ions"]["OVI"]["cells"]
            N = np.array([10 ** x if x is not None else 0 for x in ic["logN"]]); Tc = np.asarray(ic["T"], float)
            sh = float(N[Tc >= 10 ** 5.3].sum() / N.sum())
            C["ovi_hot_share"] = {"value": round(sh, 3), "pass": sh >= 0.6}
            bw = float(np.sum(N * np.asarray(ic["b"], float)) / N.sum())
            f = fit("OVI"); bfit = max((c[4] for c in f["comps"]), default=0) if f and f.get("comps") else 0
            C["ovi_trough_broad"] = {"value": {"b_cells_Nw": round(bw, 1), "b_fit_max": bfit},
                                     "pass": bw >= 30 or bfit >= 40, "note": RULE_NOTES["ovi_trough_broad"]}
    elif case == "multiphase":
        p = M.get("mp_pair")
        C["has_phase_offset"] = {"value": None if not p else round(p["dv"], 1), "pass": bool(p and p["dv"] >= p["dv_thr"])}
        if p:
            C["cool_v"] = {"value": p["v_cool"], "pass": True}; C["warm_v"] = {"value": p["v_warm"], "pass": True}
            ec = next(e for e in encs if e["id"] == p["cool"]); ew = next(e for e in encs if e["id"] == p["warm"])
            C["no_ovi_in_cool"] = {"value": {"OVI_share_in_cool": round(ec["share"].get("OVI", 0), 3),
                                             "MgII_share_in_warm": round(ew["share"].get("MgII", 0), 3)},
                                   "pass": ec["share"].get("OVI", 0) <= 0.2 and ew["share"].get("MgII", 0) <= 0.2}
            lo, hi = sorted((p["v_cool"], p["v_warm"]))
            br = []
            for k in ("HI", "OVI", "MgII", "CIV"):
                if k in I:
                    s = load_spec(Path(M["trident_npz"]))["ions"][k]
                    m = (s["V"] > lo + 20) & (s["V"] < hi - 20)
                    if m.any() and float(s["tau"][m].max()) >= 0.1:
                        br.append(k)
            C["bridge_ion"] = {"value": br or None, "pass": True,
                               "note": "ions with tau >= 0.1 between the two speeds (+-20 km/s inset)"}
            fh, fo = fit("HI"), fit("OVI")
            vs = sorted([c[0] for f in (fh, fo) if f and f.get("comps") for c in f["comps"]])
            distinct = sum(1 for i, v in enumerate(vs) if i == 0 or v - vs[i - 1] > 40)
            C["page_fit_2comp"] = {"value": distinct, "pass": distinct >= 2,
                                   "note": "distinct (> 40 km/s apart) component speeds over the H I and O VI page fits"}
            bc = None
            if cellcols:
                idx = ec["idx"]; N = cellcols["HI"]["N"][idx]
                bc = float(np.sum(N * cellcols["HI"]["b"][idx]) / max(N.sum(), 1e-30))
            C["narrow"] = {"value": None if bc is None else {"b_cool_HI": round(bc, 1), "b_OVI": p["b_OVI"]},
                           "pass": bool(bc is not None and bc < 0.5 * p["b_OVI"])}
    elif case == "clean":
        hi = I["HI"]; f = fit("HI")
        C["c1_v"] = {"value": M.get("c1_v"), "pass": M.get("c1_v") is not None}
        nh = len(f["comps"]) if f and f.get("comps") else None
        C["hi_black_single"] = {"value": {"black15_kms": hi["black15_width_kms"], "HI_fit_comps": nh},
                                "pass": bool(hi["F15_min"] < 0.05 and nh == 1)}
        C["ovi_grey"] = {"value": round(I["OVI"]["F15_min"], 3), "pass": I["OVI"]["F15_min"] > 0.1}
        fo = fit("OVI"); cs = d["ions"]["OVI"]["totals"]["logN"] if d else None
        C["fit_dex"] = {"value": None if not fo or cs is None else {"n_comp": len(fo["comps"]), "dlogN": round(fo["total_logN"] - cs, 3)},
                        "pass": bool(fo and cs is not None and len(fo["comps"]) == 1 and abs(fo["total_logN"] - cs) <= 0.1)}
    # page-fit context for every case
    C["_page_fits"] = {"value": {f"{c['ion']} R{c['R']} SN{c['snr']} {c['case']}": [c["status"], c.get("total_logN"), len(c.get("comps") or [])]
                                 for c in (pf or {}).get("cases", []) if c["case"] in ("default", "grid4")}, "pass": None}
    return C


# ------------------------------------------------------------------------------------------------ patch test
def patch_test(stage: Path, n=20) -> dict:
    """Can `patch` re-plan a staged story from the JSON alone? Rebuild tau(l) with partial_tau_fn (geometry + per-cell
    N, V, b, a) and recompute the window-dependent facts the re-plan needs (new_dips per beat, b3_ovi_depth,
    b9_new_minima, end-of-flight F) against the values the build wrote from the cutout path."""
    files = sorted(stage.glob("*/story_*.json"))
    files = [p for p in files if "_rejected" not in str(p)]
    rej = sorted(stage.glob("*/_rejected/story_*.json"))
    root = E.OUT_DEFAULT                                      # the 4 shipped stories carry the newer keys
    pick = (sorted(root.glob("story_*.json")) + files[: n // 2] + rej)[:n]
    rows = []
    for p in pick:
        d = json.loads(p.read_text()); f2 = d.get("facts2") or {}
        r = {"story": str(p.relative_to(stage)) if stage in p.parents else str(p), "ok": True, "err": {}}
        try:
            tau, vg = E.partial_tau_fn(d, "OVI"); tauH, _ = E.partial_tau_fn(d, "HI")
            win = f2["beat_windows"]
            e1 = 0.0
            for b_, (l0, l1) in win.items():
                for key, tf in (("OVI", tau), ("HI", tauH)):
                    dt = tf(l1) - tf(l0); k = int(np.argmax(dt))
                    st = f2["new_dips"][b_][key]
                    e1 = max(e1, abs(float(dt[k]) - st["dtau_max"]) / max(1.0, abs(st["dtau_max"])))
                    if abs(float(vg[k]) - st["V_argmax"]) > 1.0 and abs(float(dt[k]) - st["dtau_max"]) > 1e-3:
                        r["ok"] = False
            r["err"]["new_dips_rel"] = e1
            b3 = E.depth_of(tau(win["B3"][1])); r["err"]["b3_ovi_depth"] = abs(b3 - f2["b3_ovi_depth"])
            mf = E.minima_facts(d)
            if f2.get("b9_new_minima") is None:      # built before minima_facts existed: patch adds the key
                r["err"]["b9_new_minima_equal"] = None
            else:
                a_, b_ = mf.get("b9_new_minima") or [], f2.get("b9_new_minima") or []
                r["err"]["b9_new_minima_equal"] = len(a_) == len(b_) and all(
                    abs(x[0] - y[0]) <= 1 and abs(x[1] - y[1]) <= 1e-3 for x, y in zip(a_, b_))
            Fend = np.exp(-tau(1e6)); r["err"]["eof_dF"] = float(np.max(np.abs(Fend - np.asarray(d["ions"]["OVI"]["F_intrinsic"], float))))
            # a re-plan with other windows needs nothing else: show it on shifted windows (the planner's job)
            shifted = {b: (l0 + 7.0, l1 + 7.0) for b, (l0, l1) in win.items()}
            _ = {b: float(np.max(tau(l1) - tau(l0))) for b, (l0, l1) in shifted.items()}
            r["ok"] = r["ok"] and e1 < 1e-3 and r["err"]["b3_ovi_depth"] < 1e-3 and r["err"]["b9_new_minima_equal"] is not False \
                and r["err"]["eof_dF"] < 5e-3
            r["has_cloud_members"] = (p.parent / "clouds").exists()
            r["has_roles_cells"] = all(k in f2 for k in ("S5_cell",))
        except Exception as exc:  # noqa: BLE001  (report, do not debug ray by ray)
            r["ok"] = False; r["exc"] = repr(exc)
        rows.append(r)
    return {"n": len(rows), "n_ok": sum(r["ok"] for r in rows), "rows": rows,
            "question": "can `export_story_data.py patch` re-plan staged stories from the per-cell blocks in the JSON?"}


# ------------------------------------------------------------------------------------------------ select
def select(s0b: Path) -> dict:
    rows = [ln.split("\t") for ln in (s0b / "rays.tsv").read_text().strip().split("\n")]
    ms = {}
    for r in rows:
        p = s0b / "measure" / f"{r[3]}_{r[4]}.json"
        if p.exists():
            ms[(r[1], r[2])] = json.loads(p.read_text())
    # the full alternate lists (DESIGN_tierA §2); S0b measured primary + alt1 for every case and, under the swap
    # rule, the later alternates of the cases whose earlier rays failed
    alts = {"clean": ["488530 edge_b075_a300", "424288 rand_b203_a284_s46082"],
            "multiphase": ["488530 rand_b139_a096", "424288 edge_b057_a235_s3421"],
            "damped": ["488530 rand_b085_a006_s625643225", "424288 face_b086_a141_s6365"],
            "empty": ["511920 rand_b051_a022_s24997", "424288 rand_b089_a317_s49981"],
            "hot": ["511920 face_b046_a242_s15743", "488530 rand_b103_a094_s0", "424288 edge_b216_a284_s4133"]}
    picks = {}
    for case in ("clean", "multiphase", "damped", "empty", "hot"):
        cand = []
        for role in ("primary", "alt1", "alt2", "alt3"):
            m = ms.get((case, role))
            if not m:
                continue
            v = m["case"]["verdict"]
            cand.append({"role": role, "galaxy": m["galaxy"], "ray": m["ray"], "rule_ok": v["ok"],
                         "score": v["score"], "weakest": v.get("weakest"), "margin_ok": v["margin_ok"],
                         "fails": v["fails"], "story_built": m.get("story_built"),
                         "steps_failed": sorted(k for k, x in m.get("steps", {}).items() if x["rc"] != 0),
                         "label": m["case"]["id"],
                         "claims_failed": sorted(k for k, c in m["claims"].items() if c.get("pass") is False)})
        chosen = next((c for c in cand if c["margin_ok"]), None)
        picks[case] = {"primary": next((f"{c['galaxy']} {c['ray']}" for c in cand if c["role"] == "primary"), None),
                       "pick": None if not chosen else f"{chosen['galaxy']} {chosen['ray']}",
                       "pick_role": None if not chosen else chosen["role"],
                       "alternates": alts[case], "candidates": cand,
                       "verdict": ("go" if chosen and chosen["role"] == "primary" else
                                   "swap" if chosen else "no-go (case fails; picker lists only passing stories)")}
    return {"schema": "picks/1", "rule_version": RULE_VERSION, "page": {"R": R_PAGE, "sn": SN_PAGE},
            "margin_min": MARGIN_MIN, "swap_rule": "a primary that fails its case rule (or margin < 0.1) on Trident is "
            "replaced by the next alternate; thresholds are never loosened without science sign-off",
            "rule_notes": RULE_NOTES, "picks": picks}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("measure"); a1.add_argument("--s0b", type=Path, required=True); a1.add_argument("--task", type=int, nargs="*")
    a2 = sub.add_parser("patchtest"); a2.add_argument("--s0b", type=Path, required=True)
    a2.add_argument("--stage", type=Path, required=True); a2.add_argument("--n", type=int, default=20)
    a3 = sub.add_parser("select"); a3.add_argument("--s0b", type=Path, required=True)
    a = ap.parse_args(argv)
    if a.cmd == "measure":
        rows = [ln.split("\t") for ln in (a.s0b / "rays.tsv").read_text().strip().split("\n")]
        (a.s0b / "measure").mkdir(exist_ok=True)
        for r in rows:
            if a.task and int(r[0]) not in a.task:
                continue
            m = measure_ray(a.s0b, r)
            (a.s0b / "measure" / f"{r[3]}_{r[4]}.json").write_text(json.dumps(m, indent=1, default=float))
            v = m["case"]["verdict"]
            print(f"{r[1]:10s} {r[2]:7s} {r[3]} {r[4]}: declared ok={v['ok']} score={v['score']} fails={v['fails']} "
                  f"label={m['case']['id']}", flush=True)
    elif a.cmd == "patchtest":
        res = patch_test(a.stage, a.n)
        (a.s0b / "patch_test.json").write_text(json.dumps(res, indent=1, default=float))
        print(f"patch test: {res['n_ok']}/{res['n']} reproduce from JSON alone")
    else:
        res = select(a.s0b)
        (a.s0b / "picks.json").write_text(json.dumps(res, indent=1, default=float))
        for k, v in res["picks"].items():
            print(f"{k:10s} {v['verdict']:6s} pick={v['pick']}")


if __name__ == "__main__":
    main()
