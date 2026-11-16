#!/usr/bin/env python
"""story-data/3 planner for the Tier A sightline stories (DESIGN_tierA §3, §4.1, §4.2, §4.4).

Called by `export_story_data.py build --case <case>` in two phases:

  1. `Planner.windows(geo, cw, Nion)` (inside story_v2, once the kernel geometry and the CREST clouds exist): the
     letters/2 plan (encounters, lettered slots, flights, CUT_L) and the beat windows derived from it, so every /2 fact
     of a generated story (b3_ovi_depth, new_dips, b9_new_minima, cloud letters ...) is computed on the plan's windows
     (facts2.beat_windows_source = "plan"). The hero never comes here: it keeps BEAT_L/LETTER_BEATS.
  2. `Planner.assemble(d)` (after finish_story): the case/1 verdict of the declared case and the classifier scores of
     every case, the case's teaching claims (G16), roles, plan, tf_windows, limits, noise, cube_cover, lod, galaxy,
     the /3 flags and keys, eligible_case and gates_case (G13r, G15 data part, G16, parity, budget, cover).

Numbers are Trident only (the story spectrum and its cells), never the SBI catalogue. Thresholds are case/1 exactly as
DESIGN_tierA §3 states them; the measurement code is scripts/select_cases.py (S0b), shared, so the build and the
go/no-go measure the same thing. Encounters follow case/1.1 (OWNER_DECISIONS 15): CREST clouds set the boundaries, the
columns come from every ray cell whose kernel centre lies in the window.
"""
from __future__ import annotations

import gzip
import json
import math
import os
from pathlib import Path

import numpy as np

import export_story_data as E
import select_cases as S

PLAN_VERSION = "plan/1"
PLAN_RULE = "letters/2"
CASE_RULE_NOTE = "case/1.1"               # case/1 thresholds; encounter columns from all cells in the CREST window
CASES = ("clean", "multiphase", "damped", "empty", "hot")
STORY_ID = {"clean": "clean", "multiphase": "multiphase", "damped": "damped", "empty": "empty", "hot": "hot"}
EXTRA = dict(S.EXTRA)                     # ≤ 1 extra ion per story: C IV (clean), Mg II (multiphase), Ne VIII (hot)
STORY_LEAD = {"clean": "OVI", "multiphase": "HI", "damped": "HI", "empty": "HI", "hot": "OVI"}   # §5 lead ion
CASE_TITLE = {"clean": "A single cloud", "multiphase": "Cool gas and hot gas", "damped": "A damped system",
              "empty": "An empty halo", "hot": "Hot gas, faint hydrogen"}
LLS_TITLE = "A Lyman-limit system"
# B14 "another story" (§5 table); same_galaxy_next is true when the next story's frozen pick is on this galaxy
NEXT_STORY = {"clean": "damped", "multiphase": "clean", "damped": "clean", "empty": "hot", "hot": "empty"}

MERGE_KPC = S.MERGE_KPC                   # letters/2 step 1
PAD_MIN_KPC = 5.0                         # step 5: window = l-range +- max(5 kpc, 0.5 r90)
SYN_MIN_KPC, SYN_H = 5.0, 3.0             # step 2: synthetic B = +- max(5 kpc, 3 h) around S5
UNUSED_PENALTY = 0.1                      # step 3: maximise sum share(lead) - 0.1 x unused strong candidates
GAP_KPC = 20.0                            # step 7: has_gap_AB / has_gap_BC
STOP_TAU0 = 0.01                          # step 7: has_stop_cell
RESOLVE_MIN = 0.15                        # step 8: r_contrast >= 0.15 -> "resolve", else "resolve_saturated"
DAMPED_PIN_SHARE = 0.8                    # step 4 / claim hi_encounter_80
VWIN_DEFAULT = (-300.0, 300.0)
ROLE_S5_MIN_N, ROLE_S4A_MIN_X, ROLE_S4A_MIN_N = 10 ** 12.5, 1e-4, 1e13     # §3 role sanity
DETECT_TAU = 0.05                         # hi/ovi/lowion_detected: peak tau in the page spectrum
TF_PCTL = (5.0, 99.5)
TF_MIN_CELLS = 50
LOD_BIN_KPC = 10.0
VOXEL_KPC = {"L0": 3.125, "L1": 0.78125, "L2": 0.1953125}
LEVEL_HALF = {"L0": 400.0, "L1": 100.0, "L2": 25.0}
GZ_BASE, GZ_PER_EXTRA = 140 * 1024, 45 * 1024    # §4.4 item 4
END_R_MAX = 390.0
DATA_PREFIX = "v3/"                        # Tier A story files: ROOT/data/v3/ (index entry story = v3/story_<g>_<ray>.json)
HF_488530 = "https://huggingface.co/datasets/tanmay-starslab/tng50-sub488530-viz/resolve/main/"
HF_WEB = "https://huggingface.co/datasets/tanmay-starslab/{ds}/resolve/main/{g}/viz/"
# beat ids of the hero (BEAT_L) derived from the plan slots; the splits keep the hero's proportions
BEAT_SPLIT = {"F0": ("B3", "B4", 34.0 / 81.0), "B": ("B7a", "B7d", 7.95 / 24.0), "FBC": ("B7e", "B8", 17.0 / 48.0)}


def rnd(x, n=3):
    return None if x is None else round(float(x), n)


# ------------------------------------------------------------------------------------------------ letters/2
def encounter_record(e, exported):
    """public encounter (story-data/3 $defs.encounter) from a select_cases.encounters entry"""
    lead = e["lead"]
    return {"id": e["id"], "l0": rnd(e["l0"]), "l1": rnd(e["l1"]), "lc": rnd(e["lc"]), "r90": rnd(e["r90"] or 0.0),
            "V": rnd(e["V"][lead]["V_min"], 1), "lead": lead, "share": rnd(min(1.0, e["share"].get(lead, 0.0)), 4),
            "ions_at": [k for k in exported if e["V"].get(k, {}).get("tau_peak", 0.0) >= S.LETTER_TAU0],
            "shares": {k: rnd(v, 4) for k, v in e["share"].items() if k in exported},
            "logN": {k: e["logN"][k] for k in exported if k in e["logN"]},
            "tau_peak": {k: rnd(e["V"][k]["tau_peak"], 4) for k in exported if k in e["V"]},
            "V_ion": {k: rnd(e["V"][k]["V_min"], 1) for k in exported if k in e["V"]},
            "letterable": bool(e["letterable"]), "clouds": list(e["clouds"]), "n_cells": e["n_cells"],
            "letter": None, "synthetic": False}


def assign_letters(case, encs, B, mp_best, pair_c, damped_target):
    """letters/2 steps 3-4: enumerate every path-order-consistent (A, C, D) around the anchor B, keep the assignments
    the case pins allow, maximise sum share(lead) - 0.1 x unused strong candidates; ties go to the earlier letters."""
    strong = [e for e in encs if e["letterable"] and e is not B.get("_enc")]
    before = [e for e in strong if e["l1"] < B["l0"]]
    after = [e for e in strong if e["l0"] > B["l1"]]
    if case == "empty":
        return {"A": None, "C": None, "D": None}, "empty: A, C, D off"
    cs = [pair_c] if pair_c is not None else [None] + after
    opts = []
    for A in [None] + before:
        for C in cs:
            for D in [None] + after:
                if D is not None:
                    if C is None and case != "damped":
                        continue                   # D follows C, except when the damped pin forces D
                    if C is not None and (D is C or D["l0"] <= C["l1"]):
                        continue
                opts.append({"A": A, "C": C, "D": D})

    def lettered(o):
        return [x for x in (o["A"], B.get("_enc"), o["C"], o["D"]) if x is not None]

    def ok(o):
        L = [x["id"] for x in lettered(o) if "id" in x]
        if case == "damped" and damped_target is not None and damped_target["id"] not in L:
            return False
        if case == "multiphase" and mp_best is not None and not (mp_best["cool"] in L and mp_best["warm"] in L):
            return False
        return True

    def score(o):
        used = {x["id"] for x in lettered(o) if "id" in x}
        s = sum(x["share"].get(x["lead"], 0.0) for x in (o["A"], o["C"], o["D"]) if x is not None and "share" in x)
        s -= UNUSED_PENALTY * sum(1 for e in strong if e["id"] not in used)
        ls = tuple(-(x["l0"] if x is not None else 1e9) for x in (o["A"], o["C"], o["D"]))
        return (round(s, 9), ls)

    good = [o for o in opts if ok(o)]
    note = "pins satisfied"
    if not good:
        good, note = opts, "case pin could not be satisfied around this B: unpinned best assignment"
    return max(good, key=score), note


def build_plan(case, encs, exported, S5, lc, h, tau0, half, ray, pair_cells, mp_best, spec_metrics, Vcell=None):
    """letters/2 (DESIGN_tierA §4.2) on the select_cases encounters -> plan block and the beat windows"""
    encs = sorted(encs, key=lambda e: e["l0"])
    s5l = float(lc[S5])
    Benc = None if case == "empty" else next((e for e in encs if e["l0"] <= s5l <= e["l1"]), None)
    if Benc is not None:
        B = {"l0": Benc["l0"], "l1": Benc["l1"], "_enc": Benc, "synthetic": False}
    else:
        w = max(SYN_MIN_KPC, SYN_H * float(h[S5]))
        B = {"l0": s5l - w, "l1": s5l + w, "_enc": None, "synthetic": True}
    pair_c = None
    if pair_cells and case != "empty":
        j = max(pair_cells, key=lambda c: lc[c])
        if lc[j] > B["l1"]:
            w = max(SYN_MIN_KPC, SYN_H * float(h[j]))
            pair_c = {"id": f"pair_{j}", "l0": float(lc[j]) - w, "l1": float(lc[j]) + w, "_pair": j, "lead": "OVI",
                      "share": {"OVI": 0.0}, "r90": 0.0}
    damped_target = None
    if case == "damped" and encs:
        damped_target = max(encs, key=lambda e: e["share"].get("HI", 0.0))
    if case == "damped" and damped_target is not None and damped_target is not Benc:
        if not damped_target["letterable"]:
            damped_target = dict(damped_target, letterable=True)
            encs = [damped_target if e["id"] == damped_target["id"] else e for e in encs]
    if case == "multiphase" and mp_best is not None:       # both members must be letter candidates
        encs = [dict(e, letterable=True) if e["id"] in (mp_best["cool"], mp_best["warm"]) else e for e in encs]
        if Benc is not None:
            Benc = next(e for e in encs if e["id"] == Benc["id"]); B["_enc"] = Benc
    asg, pin_note = assign_letters(case, encs, B, mp_best, pair_c, damped_target)
    letters = {"A": asg["A"], "B": B, "C": asg["C"], "D": asg["D"]}

    # step 5: windows (l-range +- max(5, 0.5 r90)), clipped so they stay ordered, inside [-half, +half]
    win = {}
    for L, x in letters.items():
        if x is None:
            continue
        if L == "B" and B["synthetic"]:
            win[L] = [B["l0"], B["l1"]]
        elif L == "B":
            pad = max(PAD_MIN_KPC, 0.5 * float(Benc["r90"] or 0.0))
            win[L] = [Benc["l0"] - pad, Benc["l1"] + pad]
        elif x.get("_pair") is not None:
            win[L] = [x["l0"], x["l1"]]
        else:
            pad = max(PAD_MIN_KPC, 0.5 * float(x["r90"] or 0.0))
            win[L] = [x["l0"] - pad, x["l1"] + pad]
    core = {L: ((letters[L]["l0"], letters[L]["l1"]) if L != "B" else (B["l0"], B["l1"])) for L in win}
    on = [L for L in "ABCD" if L in win]
    for a, b in zip(on, on[1:]):
        if win[a][1] > win[b][0]:
            m = 0.5 * (core[a][1] + core[b][0])
            win[a][1] = win[b][0] = m
    for L in on:
        win[L] = [max(-half, min(half, win[L][0])), max(-half, min(half, win[L][1]))]

    # slots covering [-half, +half] exactly: F0 A FAB B FBC C FCD D Fend (off letters and their flights zero length)
    slots, cur, pending = {}, -half, []
    flights = {"A": "F0", "B": "FAB", "C": "FBC", "D": "FCD"}
    for L in "ABCD":
        f = flights[L]
        if L in win:
            w0, w1 = win[L]
            slots_order = pending + [(f, "flight")]
            first = True
            for n, kind in slots_order:
                if kind == "flight":
                    slots[n] = {"on": first and w0 > cur, "l0": cur if first else w0, "l1": w0, "kind": "flight"}
                    first = False
                else:
                    slots[n] = {"on": False, "l0": w0, "l1": w0, "kind": "letter"}
            x = letters[L]
            if L == "B":
                kind = "stop"                      # B is the cell stop (S5); synthetic when no encounter holds S5
                lead = Benc["lead"] if Benc is not None else STORY_LEAD[case]
                eid = Benc["id"] if Benc is not None else "syn_B"
            else:
                kind = "pair" if x.get("_pair") is not None else "letter"
                lead = x["lead"]; eid = x["id"]
            slots[L] = {"on": True, "l0": w0, "l1": w1, "kind": kind, "lead": lead, "enc": eid}
            cur, pending = w1, []
        else:
            pending += [(f, "flight"), (L, "letter")]
    for n, kind in pending:
        slots[n] = {"on": False, "l0": cur, "l1": cur, "kind": kind}
    slots["Fend"] = {"on": half > cur, "l0": cur, "l1": half, "kind": "flight"}
    order = ["F0", "A", "FAB", "B", "FBC", "C", "FCD", "D", "Fend"]
    slots = {k: slots[k] for k in order}
    for k in ("FAB", "FBC", "FCD"):
        if slots[k]["l1"] - slots[k]["l0"] >= GAP_KPC:
            slots[k]["kind"] = "gap"
    for k, s_ in slots.items():
        s_["l0"], s_["l1"] = rnd(s_["l0"]), rnd(s_["l1"])

    # public encounters, letters marked; synthetic B listed as its own encounter
    pub = [encounter_record(e, exported) for e in encs]
    for L in "ACD":
        x = letters[L]
        if x is not None and x.get("_pair") is None:
            next(p for p in pub if p["id"] == x["id"])["letter"] = L
    if Benc is not None:
        next(p for p in pub if p["id"] == Benc["id"])["letter"] = "B"
    else:
        lead = STORY_LEAD[case]
        pub.append({"id": "syn_B", "l0": rnd(B["l0"]), "l1": rnd(B["l1"]), "lc": rnd(s5l), "r90": 0.0,
                    "V": rnd(Vcell[S5], 1) if Vcell is not None else 0.0, "V_source": "S5 cell (synthetic encounter)",
                    "lead": lead, "share": 0.0, "ions_at": [], "letter": "B", "synthetic": True,
                    "why": "no encounter contains S5" if case != "empty" else "empty case: B is synthetic (§4.2 step 4)"})
    if pair_c is not None and letters["C"] is pair_c:
        pub.append({"id": pair_c["id"], "l0": rnd(pair_c["l0"]), "l1": rnd(pair_c["l1"]), "lc": rnd(lc[pair_c["_pair"]]),
                    "r90": 0.0, "V": rnd(Vcell[pair_c["_pair"]], 1) if Vcell is not None else 0.0,
                    "V_source": "S6 pair cell (synthetic encounter)", "lead": "OVI", "share": 0.0, "ions_at": ["OVI"], "letter": "C",
                    "synthetic": True, "why": "S6 pair window (has_pair)"})

    # step 6: CUT_L
    ctr = lambda L: 0.5 * (slots[L]["l0"] + slots[L]["l1"])   # noqa: E731
    cut_l = [rnd(ctr("A")) if slots["A"]["on"] else rnd(-0.5 * half), rnd(s5l),
             rnd(ctr("D")) if slots["D"]["on"] else rnd(0.5 * half)]
    # step 7: flags
    lead5 = "OVI"
    pflags = {"has_gap_AB": bool(slots["A"]["on"] and slots["FAB"]["l1"] - slots["FAB"]["l0"] >= GAP_KPC),
              "has_gap_BC": bool(slots["C"]["on"] and slots["FBC"]["l1"] - slots["FBC"]["l0"] >= GAP_KPC),
              "has_stop_cell": bool(float(tau0[lead5][S5]) >= STOP_TAU0),
              "B7p": case == "multiphase" and mp_best is not None,
              "B10w": case == "damped", "B12n": case == "empty"}
    # step 8: resolve
    rc = {k: m["r_contrast"] for k, m in spec_metrics.items() if k in exported}
    rion = max(rc, key=lambda k: rc[k]) if rc else "OVI"
    m = spec_metrics.get(rion, {})
    resolve = {"ion": rion, "F15": rnd(m.get("F15_min"), 4), "F50": rnd(m.get("F50_min"), 4),
               "r_contrast": rnd(rc.get(rion, 0.0), 4),
               "mode": "resolve" if rc.get(rion, 0.0) >= RESOLVE_MIN else "resolve_saturated",
               "all": {k: rnd(v, 4) for k, v in rc.items()}}
    # bounds of the lettered encounters (fit-to-bounds tableau), disk frame kpc
    p0, n = np.asarray(ray["p0"], float), np.asarray(ray["n"], float)
    pt = lambda l: p0 + (l + half) * n   # noqa: E731
    lw = [(slots[L]["l0"], slots[L]["l1"]) for L in "ABCD" if slots[L]["on"]]
    if case == "empty" or not lw:
        lo, hi = -half, half
    else:
        lo, hi = min(a for a, _ in lw), max(b for _, b in lw)
    r90s = [float(p["r90"] or 0.0) for p in pub if p.get("letter")]
    c = 0.5 * (pt(lo) + pt(hi))
    bounds = {"c": [rnd(x, 2) for x in c], "r": rnd(0.5 * (hi - lo) + max(r90s + [PAD_MIN_KPC]), 2),
              "l": [rnd(lo), rnd(hi)]}
    # panel velocity window: default +-300; wider when a lettered speed needs it (never wider than the 1 km/s grid)
    vs = [abs(p["V"]) for p in pub if p.get("letter") and p.get("V") is not None and not p.get("synthetic")]
    w = VWIN_DEFAULT[1] if not vs else min(400.0, max(300.0, 50.0 * math.ceil((max(vs) + 100.0) / 50.0)))
    plan = {"version": PLAN_VERSION, "rule": PLAN_RULE, "half": rnd(half, 4), "encounters": pub, "slots": slots,
            "cut_l": cut_l, "bounds": bounds, "vwin": [-w, w], "resolve": resolve, "bridge_ion": None,
            "flags": pflags, "lead_ion": STORY_LEAD[case], "pin": pin_note,
            "damped_target": None if damped_target is None else damped_target["id"],
            "rules": {"candidates": f"CREST clouds of the exported ions with frac_ion_column >= {S.CAND_FRAC}, merged "
                                    f"when overlapping or within {MERGE_KPC:g} kpc (case/1.1 cell-window columns)",
                      "letterable": f"lead-ion partial peak tau >= {S.LETTER_TAU0}",
                      "windows": f"l-range +- max({PAD_MIN_KPC:g} kpc, 0.5 r90), clipped at midpoints to stay ordered",
                      "synthetic_B": f"+- max({SYN_MIN_KPC:g} kpc, {SYN_H:g} h) around S5",
                      "vwin": "+-300 km/s, widened in 50 km/s steps to |V| + 100 of the lettered encounters (<= 400)",
                      "beat_l": "hero beat ids from the slots: B3/B4 = F0 (34:47), B5 = A, B6 = FAB, B7a/B7d = B "
                                "(7.95:16.05), B7e/B8 = FBC (17:31), B9 = C, B10 = FCD + D, B11 = Fend"}}
    plan["beat_l"] = beat_windows_from_slots(slots)
    return plan


def beat_windows_from_slots(slots) -> dict:
    """hero beat ids (BEAT_L keys) from the plan slots, so the /2 facts of a generated story use the plan's windows"""
    def split(k):
        a, b = slots[k]["l0"], slots[k]["l1"]
        x, y, f = BEAT_SPLIT[k]
        m = a + f * (b - a)
        return {x: [a, rnd(m)], y: [rnd(m), b]}
    w = {}
    w.update(split("F0"))
    w["B5"] = [slots["A"]["l0"], slots["A"]["l1"]]
    w["B6"] = [slots["FAB"]["l0"], slots["FAB"]["l1"]]
    w.update(split("B"))
    w.update(split("FBC"))
    w["B9"] = [slots["C"]["l0"], slots["C"]["l1"]]
    w["B10"] = [slots["FCD"]["l0"], slots["D"]["l1"]]
    w["B11"] = [slots["Fend"]["l0"], slots["Fend"]["l1"]]
    return {k: w[k] for k in E.BEAT_L}


# ------------------------------------------------------------------------------------------------ the planner
class Planner:
    """state shared by the two build phases of one Tier A story"""

    def __init__(self, case, gid, ray, work: Path, out: Path, paths: dict, pf_path: Path | None = None):
        if case not in CASES:
            raise SystemExit(f"--case {case!r}: one of {CASES}")
        self.case, self.gid, self.ray, self.work, self.out, self.paths = case, int(gid), ray, Path(work), Path(out), paths
        self.extra = EXTRA.get(case)
        self.exported = ["HI", "OVI"] + ([self.extra] if self.extra else [])
        self.lines = {k: S.osc(k) for k in S.CELL_FIELD}
        self.cellcols, self.T = S.cell_columns(self.work, self.gid, ray, self.lines)
        self.plan = None
        self.cw = None
        self.notes = []
        self.story_galaxies = {}               # story id -> galaxy of the frozen picks (same_galaxy_next)
        self.hosted = None                     # hosted_cover.json entry of this host (manifest-audit), when given

    # phase 1 -----------------------------------------------------------------------------------------------------
    def clouds_x(self):
        p = self.out / "clouds_x" / E.stem(self.gid, self.ray) / "clouds.json"
        if p.exists():
            return json.loads(p.read_text()), p
        return None, None

    def spec(self):
        npz = Path(self.paths["library"]) / "sightlines" / f"{self.ray}.npz"
        sp = S.load_spec(npz)
        return npz, sp, {k: S.ion_metrics(v) for k, v in sp["ions"].items()}

    def windows(self, geo, cw, Nion, Vr, pair):
        """letters/2 plan -> (beat windows, source) for story_v2"""
        self.cw, self.cw_path = self.clouds_x()
        if self.cw is None and cw is not None:
            self.notes.append("no clouds_x CREST file: encounters from the H I/O VI clouds only")
            self.cw = cw
        set_cloud_v(self.cw)
        lc, h = np.asarray(geo["lc"], float), np.asarray(geo["h"], float)
        self.encs = S.encounters(self.cw, self.cellcols, self.exported, lc, h, np.asarray(Vr, float)) if self.cw else []
        _, self.mp_best, self.mp_why = S.mp_pairs(self.encs, self.cellcols)
        S5 = int(np.argmax(Nion["OVI"]))
        tau0 = {k: self.cellcols[k]["tau0"] for k in self.exported}
        self.npz, self.sp, self.metrics = self.spec()
        r = geo["ray"]
        self.plan = build_plan(self.case, self.encs, self.exported, S5, lc, h, tau0, float(r["half"]),
                               {"p0": r["p0"], "n": r["n"]}, (pair or {}).get("cells"), self.mp_best, self.metrics,
                               np.asarray(Vr, float))
        bw = {k: tuple(v) for k, v in self.plan["beat_l"].items()}
        return bw, f"plan ({PLAN_RULE}, story {STORY_ID[self.case]})"

    # phase 2 -----------------------------------------------------------------------------------------------------
    def assemble(self, d, pf, gal, disk, hosted=None, tube_bin=None):
        case = self.case
        M = {"declared": case, "galaxy": self.gid, "ray": self.ray, "extra_ion": self.extra, "rule_version": S.RULE_VERSION,
             "page": {"R": S.R_PAGE, "sn": S.SN_PAGE}, "trident_npz": str(self.npz), "v_sys": self.sp["v_sys"],
             "ions": self.metrics}
        encs = S.measure_core(M, case, self.extra, d, pf_page(pf), self.cellcols, self.T, self.cw, self.cw_path)
        claims_raw = M["claims"]
        plan = self.plan
        if case == "multiphase" and claims_raw.get("bridge_ion", {}).get("value"):
            # schema: one ion key (string|null) -> the strongest bridge ion (largest tau between the two speeds,
            # +-20 km/s inset); the full list goes to plan.bridge_ions
            br = list(claims_raw["bridge_ion"]["value"])
            lo, hi = sorted((claims_raw["cool_v"]["value"], claims_raw["warm_v"]["value"]))
            def tmax(k):
                sk = self.sp["ions"][k]; m = (sk["V"] > lo + 20) & (sk["V"] < hi - 20)
                return float(sk["tau"][m].max()) if m.any() else 0.0
            plan["bridge_ion"] = max(br, key=tmax)
            plan["bridge_ions"] = br
        # slot new dips (G13r "new dip" key: argmax of the lead-ion tau gained over each window)
        for k, s_ in plan["slots"].items():
            ions = [s_["lead"]] if s_.get("lead") else [STORY_LEAD[case]]
            s_["new_dip"] = {}
            for ion in sorted(set(ions + ["HI", "OVI"])):
                f, vg = E.partial_tau_fn(d, ion)
                dt = f(s_["l1"]) - f(s_["l0"]) if s_["l1"] > s_["l0"] else np.zeros_like(vg)
                j = int(np.argmax(dt))
                s_["new_dip"][ion] = {"V": float(vg[j]), "dtau": rnd(dt[j], 5)}
        out = {}
        out["case"] = case_block(M, case)
        out["claims"] = claims_block(case, claims_raw, M, plan, pf, d)
        out["roles"] = roles_block(d, self.cellcols, self.exported, plan)
        out["plan"] = plan
        out["cloud_names"] = dict(d.get("cloud_names") or {}, plan={p["letter"]: {"enc": p["id"], "clouds": p.get("clouds", []),
                                                                                  "lead": p["lead"], "V": p["V"]}
                                                                   for p in plan["encounters"] if p.get("letter")},
                                  rule_v3="letters come from plan.encounters (letters/2); 'letters' keeps the v2 view "
                                          "computed on the plan's beat windows")
        out["tf_windows"] = tf_windows(d, tube_bin, self.exported, STORY_LEAD[case], plan, hosted, self.work,
                                       self.gid, self.ray)
        out["limits"] = {k: S.limit_3sig(k) for k in ("HI", "OVI")}
        if case == "empty":
            nz = (pf or {}).get("noise")
            if not nz:
                raise SystemExit("empty case: page_fits has no noise block (run story_fits.mjs --noise)")
            out["noise"] = nz
            sig = nz.get("excursion_sigma")
            out["claims"]["noise_dip"] = claim(sig, sig is not None and 2 <= sig < 3,
                                               "the chosen noise seed shows exactly one 2-3 sigma excursion, named noise",
                                               ion=nz.get("ion"), V=nz.get("V"), seed=nz.get("seed"))
            out["claims"]["limits"] = claim(None, True, "3 sigma upper limits with their S/N, R and b",
                                            HI=out["limits"]["HI"]["logN_3sig"], OVI=out["limits"]["OVI"]["logN_3sig"])
        out["cube_cover"] = cube_cover(d["geometry"]["ray"])
        out["lod"] = lod_block(d["geometry"]["ray"], hosted)
        out["galaxy"] = galaxy_block(self.gid, gal, d, disk, hosted)
        out["ions_extra"] = [self.extra] if self.extra else []
        out["story_id"] = STORY_ID[case]
        out["next_story"] = NEXT_STORY[case]
        out["flags_v3"] = flags_v3(case, M, out, d, plan)
        nxt = self.story_galaxies.get(NEXT_STORY[case])
        out["flags_v3"]["same_galaxy_next"] = bool(nxt is not None and int(nxt) == self.gid)
        plan["next_story"] = {"id": NEXT_STORY[case], "galaxy": nxt, "same_galaxy": out["flags_v3"]["same_galaxy_next"]}
        out["keys_v3"] = keys_v3(case, M, out, d, pf)
        out["gates_case"] = gates_block(case, M, out, d, encs, self.cellcols, self.exported, plan)
        out["eligible_case"] = bool(out["gates_case"]["G16"]["pass"])
        out["notes"] = self.notes
        return out


def pf_page(pf):
    """page fits as select_cases.page_fit reads them (it looks for R 15 000, S/N 20 grid4 by default; the Tier A build
    adds the true page case R 15 000, S/N 10, which claims_block prefers)"""
    return pf


def page_case_fit(pf, ion):
    for c in (pf or {}).get("cases", []):
        if c["case"] == "page" and c["ion"] == ion:
            return c
    return None


# ------------------------------------------------------------------------------------------------ blocks
def case_block(M, case):
    c = M["case"]
    v = c["verdict"]
    return {"id": c["id"], "declared": S.CASE_ID[case], "subcase": c["subcase"] if case == "damped" else None,
            "rule_version": S.RULE_VERSION, "rule_note": CASE_RULE_NOTE,
            "scores": c["scores"], "fails": c["fails"],
            "verdict": {"ok": bool(v["ok"]), "margin": v["score"], "margin_ok": bool(v["margin_ok"]),
                        "weakest": v["weakest"], "metrics": {x["name"]: {"value": jsonable(x["value"]), "margin": x["margin"],
                                                                         "unit": x["unit"], "pass": x["pass"]}
                                                             for x in v["conditions"]}},
            "margin_min": S.MARGIN_MIN, "page": M["page"]}


def jsonable(x):
    return json.loads(json.dumps(x, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o)))


def claim(value, ok, why=None, **detail):
    """story-data/3 $defs.claim: scalar value, boolean pass, optional why; structured detail under 'detail'"""
    if isinstance(value, (dict, list)):
        detail = dict(detail, value=value); value = None
    out = {"value": value if value is None or isinstance(value, (bool, str)) else rnd(value, 4), "pass": bool(ok)}
    if why:
        out["why"] = why
    if detail:
        out["detail"] = jsonable(detail)
    return out


def page_fit_2comp(pf, grid4=None):
    """fix2 (review2 R2-B2/R3-S9): measured on the fits B13 draws (js/plot.js picks: the O VI page seeds at R 30 000,
    S/N 10, first three by seedParam), not pooled over H I and O VI: every draw needs >= 2 speeds > 40 km/s apart"""
    seeds = sorted([c for c in (pf or {}).get("cases", []) if c.get("ion") == "OVI" and c.get("R") == 30000
                    and c.get("snr") == 10 and c.get("ci", 0) == 0], key=lambda c: c.get("seedParam", 0))[:3]

    def distinct(f):
        vs = sorted(c[0] for c in f.get("comps") or [])
        return sum(1 for i, v in enumerate(vs) if i == 0 or v - vs[i - 1] > 40)
    n = min((distinct(f) for f in seeds), default=0)
    return claim(n, bool(seeds) and n >= 2, "fewest distinct (> 40 km/s apart) component speeds over the O VI page "
                 "draws B13 shows (R 30 000, S/N 10)", draws=[distinct(f) for f in seeds], grid4=grid4)


def claims_block(case, C, M, plan, pf, d):
    """the declared case's teaching claims (§3; G16). Values come from select_cases.claims on the Trident story, with
    the page case (R 15 000, S/N 10) fit preferred where §3 says 'page fit'."""
    I = M["ions"]; out = {}
    if case == "damped":
        out["hi_black_core"] = claim(C["hi_black_core"]["value"], C["hi_black_core"]["pass"], "F < 0.05 over >= 50 km/s at R 15 000 (km/s)")
        out["wing_frac"] = claim(C["wing_frac"]["value"], C["wing_frac"]["pass"], "EW outside the black core / total >= 0.2")
        f = page_case_fit(pf, "HI"); cs = d["ions"]["HI"]["totals"]["logN"]
        dv = None if not f or f.get("total_logN") is None else f["total_logN"] - cs
        out["hi_fit_dhi"] = claim(dv, dv is not None and abs(dv) <= 0.15, "page fit (R 15 000, S/N 10) total minus the cell sum, |dex| <= 0.15",
                                  grid4=C["hi_fit_dhi"]["value"])
        v = C["hi_encounter_80"]["value"]
        out["hi_encounter_80"] = claim(v["largest_single"], C["hi_encounter_80"]["pass"],
                                       "largest single H I encounter's share of the column >= 0.8; the damped pin letters "
                                       "the largest encounter either way, so a false claim only gates the copy line",
                                       all_encounters=v["all_encounters"], lettered=plan.get("damped_target"))
        out["resolve_saturated"] = claim(plan["resolve"]["r_contrast"], plan["resolve"]["mode"] == "resolve_saturated",
                                         "no exported ion with r_contrast (F15_min - F50_min) >= 0.15")
        out["hi_damped"] = claim(I["HI"]["logN"], I["HI"]["logN"] >= 20.3, "log N(H I) >= 20.3")
    elif case == "empty":
        out["limits"] = claim(None, True, "3 sigma upper limits stated with their S/N, R and b (limits block)")
        out["noise_dip"] = claim(None, False, "set by assemble from the noise block")
    elif case == "hot":
        out["hi_faint"] = claim(C["hi_faint"]["value"], C["hi_faint"]["pass"], "H I peak tau in 0.05-1 (faint, not absent)")
        ne = C["has_neviii"]["value"] or {}
        out["has_neviii"] = claim(ne.get("logN"), C["has_neviii"]["pass"], "log N(Ne VIII) >= 13.5 and F15_min < 0.9",
                                  F15_min=ne.get("F15_min"))
        if "ovi_hot_share" in C:
            out["ovi_hot_share"] = claim(C["ovi_hot_share"]["value"], C["ovi_hot_share"]["pass"], ">= 60 % of the O VI column in cells with T >= 10^5.3 K")
        if "ovi_trough_broad" in C:
            v = C["ovi_trough_broad"]["value"]
            out["ovi_trough_broad"] = claim(v["b_cells_Nw"], C["ovi_trough_broad"]["pass"], S.RULE_NOTES["ovi_trough_broad"],
                                            b_fit_max=v["b_fit_max"])
    elif case == "multiphase":
        for k in ("has_phase_offset", "cool_v", "warm_v"):
            if k in C:
                out[k] = claim(C[k]["value"], C[k]["pass"])
        if "no_ovi_in_cool" in C:
            v = C["no_ovi_in_cool"]["value"]
            out["no_ovi_in_cool"] = claim(v["OVI_share_in_cool"], C["no_ovi_in_cool"]["pass"],
                                          "<= 20 % of the O VI column inside the cool encounter (and <= 20 % of Mg II in the hot one)",
                                          MgII_share_in_warm=v["MgII_share_in_warm"])
        if "bridge_ion" in C:
            v = C["bridge_ion"]["value"]
            out["nothing_between"] = claim(None, not v, "no ion with tau >= 0.1 between the two speeds (+-20 km/s inset); "
                                           "false means the copy must never say 'nothing between them'", bridge_ion=v)
        if "page_fit_2comp" in C:
            out["page_fit_2comp"] = page_fit_2comp(pf, C["page_fit_2comp"]["value"])
        if "narrow" in C:
            v = C["narrow"]["value"] or {}
            out["narrow"] = claim(v.get("b_cool_HI"), C["narrow"]["pass"], "b_cool < 1/2 b_OVI", b_OVI=v.get("b_OVI"))
    elif case == "clean":
        out["c1_v"] = claim(C["c1_v"]["value"], C["c1_v"]["pass"])
        v = C["hi_black_single"]["value"]
        f = page_case_fit(pf, "HI"); nh = len(f["comps"]) if f and f.get("comps") else None
        out["hi_black_single"] = claim(v["black15_kms"], bool(I["HI"]["F15_min"] < 0.05 and nh == 1), "H I black at R 15 000 and one page-fit component",
                                       HI_page_fit_comps=nh)
        out["ovi_grey"] = claim(C["ovi_grey"]["value"], C["ovi_grey"]["pass"], "O VI F15_min > 0.1")
        fo = page_case_fit(pf, "OVI"); cs = d["ions"]["OVI"]["totals"]["logN"]
        ok = bool(fo and fo.get("comps") and len(fo["comps"]) == 1 and abs(fo["total_logN"] - cs) <= 0.1)
        out["fit_dex"] = claim(None if not fo or fo.get("total_logN") is None else fo["total_logN"] - cs, ok,
                               "single-component O VI page fit within 0.1 dex of the cell sum")
    return out


def roles_block(d, cellcols, exported, plan):
    """roles.<r> = {cell, ok, why} (§3 role sanity) plus the geometry of every referenced cell"""
    g = d["geometry"]["cells"]
    cen = np.asarray(g["centre"], float).reshape(-1, 3)
    lc = np.asarray(g["lc"], float); h = np.asarray(g["h"], float)
    xHI = np.asarray([x if x is not None else 0.0 for x in d["ions"]["HI"]["cells"]["f_ion"]], float)
    N = {k: cellcols[k]["N"] for k in cellcols}
    t0 = {k: cellcols[k]["tau0"] for k in cellcols}
    R = {}
    s5 = int(d["select"]["S5_cell"])
    R["S5"] = {"cell": s5, "ok": bool(N["OVI"][s5] >= ROLE_S5_MIN_N),
               "why": "" if N["OVI"][s5] >= ROLE_S5_MIN_N else f"N_OVI(cell) = {N['OVI'][s5]:.2e} < 10^12.5"}
    s4 = int(d["select"]["S4a_cell"])
    ok4 = bool(xHI[s4] >= ROLE_S4A_MIN_X and N["HI"][s4] >= ROLE_S4A_MIN_N)
    R["S4a"] = {"cell": s4, "ok": ok4, "why": "" if ok4 else f"x_HI {xHI[s4]:.1e}, N_HI {N['HI'][s4]:.1e} (needs >= 1e-4 and >= 1e13)"}
    f2 = d.get("facts2") or {}
    core = f2.get("cloudA_core_cell")
    if core is not None:
        R["cloudA.core"] = {"cell": int(core), "ok": True, "why": f2.get("cloudA_source") or ""}
    else:
        R["cloudA.core"] = {"cell": s4, "ok": False, "why": "no H I cloud lettered A and no black H I cloud"}
    R["hiPeak"] = {"cell": int(np.argmax(t0["HI"])), "ok": bool(t0["HI"].max() > 0), "why": "H I cell with the largest tau0"}
    R["oviPeak"] = {"cell": int(np.argmax(t0["OVI"])), "ok": bool(t0["OVI"].max() > 0), "why": "O VI cell with the largest tau0"}
    if "NeVIII" in exported:
        R["neviiiPeak"] = {"cell": int(np.argmax(t0["NeVIII"])), "ok": bool(t0["NeVIII"].max() > 0), "why": "Ne VIII cell with the largest tau0"}
    lead = plan["lead_ion"]
    R["lead.core"] = {"cell": int(np.argmax(t0[lead])), "ok": bool(t0[lead].max() > 0), "why": f"story lead ion {lead}: cell with the largest tau0"}
    for L in "ABCD":
        s_ = plan["slots"][L]
        if not s_["on"]:
            continue
        ion = s_.get("lead") or lead
        m = np.flatnonzero((lc >= s_["l0"]) & (lc <= s_["l1"]))
        if m.size:
            j = int(m[np.argmax(t0[ion][m])])
            R[f"{L}.core"] = {"cell": j, "ok": bool(t0[ion][j] > 0), "why": f"{ion} cell with the largest tau0 in slot {L}"}
    pair = (d.get("select") or {}).get("S6_pair")
    if pair:
        R["pair"] = {"cells": [int(c) for c in pair["cells"]], "ok": True, "why": pair.get("rule", "")}
        R["pairMid"] = {"l": rnd(0.5 * (lc[pair["cells"][0]] + lc[pair["cells"][1]])), "ok": True, "why": "midpoint of the S6 pair"}
    cells = set()
    for v in R.values():
        if "cell" in v:
            cells.add(v["cell"])
        for c in v.get("cells", []):
            cells.add(c)
    R["cells"] = {str(c): {"c": [rnd(x, 3) for x in cen[c]], "h": rnd(max(h[c], 1e-4), 4), "l": rnd(lc[c])} for c in sorted(cells)}
    return R


def tube_records(tube_bin: Path):
    """story-tube/1 records (14 B, little endian): returns dict of decoded arrays"""
    raw = gzip.decompress(Path(tube_bin).read_bytes())
    dt = np.dtype([("q", "<u2", 3), ("nH", "u1"), ("T", "u1"), ("Z", "u1"), ("req", "u1"), ("nHI", "u1"),
                   ("nOVI", "u1"), ("cloud", "u1"), ("v", "i1")])
    r = np.frombuffer(raw, dt)
    return {"lognH": r["nH"] / 255.0 * 8 - 7, "logT": r["T"] / 255.0 * 5 + 3,
            "lognHI": r["nHI"] / 255.0 * 16 - 16, "lognOVI": r["nOVI"] / 255.0 * 16 - 16, "v": r["v"] * 4.0,
            "hasHI": r["nHI"] > 0, "hasOVI": r["nOVI"] > 0}


def tf_windows(d, tube_bin, exported, lead, plan, hosted, work, gid, ray):
    """per-story TF windows (§6.2 step 10): [p5, p99.5] of the near-field tube cells (story-tube/1) per field; an ion
    window from the ray cells when the tube has no such field; 'manifest' (the hosted galaxy histogram vol_window)
    when fewer than 50 cells qualify. bands = the lead ion's 50/80/95 % percentiles; speed = +-1.5 max|V| (>= 100)."""
    out, src = {"pctl": list(TF_PCTL)}, {}
    man = (hosted or {}).get("vol_window") or {}
    t = tube_records(tube_bin) if tube_bin and Path(tube_bin).exists() else None

    def win(vals, key, mkey, where):
        vals = np.asarray(vals, float); vals = vals[np.isfinite(vals)]
        if vals.size >= TF_MIN_CELLS:
            src[key] = where
            return [rnd(np.percentile(vals, TF_PCTL[0])), rnd(np.percentile(vals, TF_PCTL[1]))]
        if man.get(mkey):
            src[key] = "manifest"
            return [rnd(x) for x in man[mkey]]
        src[key] = "none"
        return None
    z = np.load(Path(work) / f"{gid}_{ray}_cells.npz")
    if t is not None:
        out["density"] = win(t["lognH"], "density", "nH", "tube")
        out["halo"] = win(t["logT"], "halo", "T", "tube")
        out["ion:HI"] = win(t["lognHI"][t["hasHI"]], "ion:HI", "HI", "tube")
        out["ion:OVI"] = win(t["lognOVI"][t["hasOVI"]], "ion:OVI", "OVI", "tube")
    else:                                        # no near-field tube: the ray cells
        nh = z["H_nuclei_density"].astype(float); tt = z["temperature"].astype(float)
        out["density"] = win(np.log10(nh[nh > 0]), "density", "nH", "ray_cells")
        out["halo"] = win(np.log10(tt[tt > 0]), "halo", "T", "ray_cells")
    for k in exported:
        if out.get(f"ion:{k}") is not None:
            continue
        f = S.CELL_FIELD[k]
        n = z[f].astype(float) if f in z.files else np.zeros(1)
        out[f"ion:{k}"] = win(np.log10(n[n > 0]), f"ion:{k}", k, "ray_cells")
    out = {k: v for k, v in out.items() if v is not None}
    lv = None
    if t is not None and lead in ("HI", "OVI"):
        lv = t[f"logn{lead}"][t[f"has{lead}"]]
    if lv is None or lv.size < TF_MIN_CELLS:
        n = z[S.CELL_FIELD[lead]].astype(float); lv = np.log10(n[n > 0])
    if lv.size:
        out["bands"] = [rnd(np.percentile(lv, q)) for q in (50, 80, 95)]
    vs = [abs(p["V"]) for p in plan["encounters"] if p.get("letter") and p.get("V") is not None and not p.get("synthetic")]
    s = max(100.0, 1.5 * max(vs)) if vs else 100.0
    out["speed"] = [-rnd(s, 1), rnd(s, 1)]
    out["source"] = "manifest" if "manifest" in src.values() else "tube"   # schema enum: tube (incl. ray cells) | manifest
    out["sources"] = src
    return out


def cube_cover(ray):
    c = S.cube_cover(ray)
    return {"end_r_kpc": c["end_r_kpc"], "frac_in_L0": c["frac_in_L0"], "frac_in_L1": c["frac_in_L1"],
            "frac_in_L2": c["frac_in_L2"], "finest_bins": c["finest_bins"],
            "director_note": None if c["end_r_kpc"] <= END_R_MAX else f"end r {c['end_r_kpc']} kpc > {END_R_MAX}: B3 starts inside the L0 boundary (§6.2 step 5)"}


def lod_block(ray, hosted=None):
    """finest hosted cube level containing point(l), per 10 kpc bin of l (key = bin start, kpc)"""
    p0, p1 = np.asarray(ray["p0"], float), np.asarray(ray["p1"], float)
    half = float(ray["half"]); n = (p1 - p0) / np.linalg.norm(p1 - p0)
    levels = [L for L in ("L2", "L1", "L0") if not hosted or L in hosted.get("levels", {})]
    fin = {}
    edges = np.arange(-half, half, LOD_BIN_KPC)
    for a in edges:
        b = min(half, a + LOD_BIN_KPC)
        pts = [p0 + (x + half) * n for x in np.linspace(a, b, 5)]
        lv = next((L for L in levels if all(np.max(np.abs(p)) <= LEVEL_HALF[L] for p in pts)), None)
        fin[f"{a:.0f}"] = lv or "L0"
    vox = {L: VOXEL_KPC[L] for L in ("L0", "L1", "L2")}
    if hosted:
        vox = {L: hosted["levels"][L]["voxel_kpc"] for L in hosted["levels"] if L in VOXEL_KPC}
    return {"finest": fin, "voxel_kpc": vox, "bin_kpc": LOD_BIN_KPC,
            "rule": "finest level whose cube (|x|_inf <= half, disk frame) holds the whole 10 kpc bin"}


def disk_record(gid, gal, work: Path):
    """stellar half-mass radius of the bound stars (SubfindID == host, wind particles excluded) from the raw cutout;
    disk ellipse radius = max(2 r_half, 10 kpc) (G19). Cached in <work>/disk_<gid>.json (S0b's rule, same numbers)."""
    cache = Path(work) / f"disk_{gid}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    import h5py
    H = float(gal["TNG_H"]); box = float(gal["box_ckpch"]); c = np.asarray(gal["center_ckpch"], float)
    with h5py.File(E.raw_cutout(gid), "r") as f:
        p = f["PartType4"]
        sft = p["GFM_StellarFormationTime"][()]; sid = p["SubfindID"][()]
        keep = (sft > 0) & (sid == int(gid))
        x = p["Coordinates"][()][keep]; m = p["Masses"][()][keep]
    dd = x - c; dd -= box * np.round(dd / box); r = np.linalg.norm(dd, axis=1) / H
    o = np.argsort(r); cm = np.cumsum(m[o]); rh = float(r[o][np.searchsorted(cm, 0.5 * cm[-1])])
    rec = {"galaxy": int(gid), "r_half_star_kpc": round(rh, 3), "n_star": int(keep.sum()),
           "disk_radius_kpc": round(max(2 * rh, 10.0), 3),
           "rule": "stellar half-mass radius of bound stars (SubfindID == host, wind particles excluded), raw cutout; "
                   "disk ellipse radius = max(2 r_half, 10 kpc) (G19)"}
    cache.write_text(json.dumps(rec, indent=1))
    return rec


def gas_poor_of(gid, gal):
    from tngsight import galaxy as G
    rec = gal
    gp = rec.get("gas_poor")
    if gp is None:
        p = E.work_root() / "data" / "gal" / str(gid) / "galaxy.json"
        if p.exists():
            r2 = json.loads(p.read_text())
            gp = r2.get("gas_poor")
            if gp is None:
                gp = G.gas_poor(r2)
    if gp is None:
        gp = G.gas_poor(rec)
    return bool(gp) if gp is not None else False


def galaxy_block(gid, gal, d, disk, hosted):
    m = d["meta"]
    base = (hosted or {}).get("base") or (HF_488530 if gid == E.REF_GALAXY else None)
    return {"id": int(gid), "viz_base": base, "viz_manifest": (hosted or {}).get("manifest_url"),
            "gas_poor": gas_poor_of(gid, gal), "vsys": m["v_sys_kms"], "R200c": m["R200c_kpc"],
            "disk": {"c": [0.0, 0.0, 0.0], "n": [0.0, 0.0, 1.0], "r_kpc": disk["disk_radius_kpc"],
                     "r_half_star_kpc": disk["r_half_star_kpc"], "frame": "disk frame (xhat, yhat, Lhat), kpc from the galaxy centre"},
            "label": m.get("label"), "source": "trident"}


def flags_v3(case, M, out, d, plan):
    """§7.1 /3 copy flags (all booleans) + the three carried fixes (§4.4 item 5)"""
    I = M["ions"]
    hi = I["HI"]["logN"]
    low = [k for k in ("MgII", "SiII", "CII") if k in I]
    det = lambda k: bool(k in I and I[k]["F15_min"] <= 1 - DETECT_TAU and I[k]["peak_tau"] >= DETECT_TAU)  # noqa: E731
    C = out["claims"]
    disk_r = out["galaxy"]["disk"]["r_kpc"]
    f = {"gas_poor": out["galaxy"]["gas_poor"],
         "has_phase_offset": bool(C.get("has_phase_offset", {}).get("pass", False)),
         "hi_faint": bool(C.get("hi_faint", {}).get("pass", False)),
         "near_disk": bool((d["meta"].get("b_kpc") or 1e9) < 3 * disk_r),
         "empty_faint": bool(case == "empty" and max(I[k]["peak_tau"] for k in ("HI", "OVI")) < 0.01),
         "same_galaxy_next": None,
         "resolve_saturated": plan["resolve"]["mode"] == "resolve_saturated",
         "has_gap_AB": plan["flags"]["has_gap_AB"], "has_gap_BC": plan["flags"]["has_gap_BC"],
         "has_stop_cell": plan["flags"]["has_stop_cell"],
         "hi_lls": bool(E.LLS_LOGN <= hi < 20.3), "hi_damped": bool(hi >= 20.3),
         "hi_detected": det("HI"), "ovi_detected": det("OVI"), "lowion_detected": any(det(k) for k in low),
         "bridge_ion": bool(plan.get("bridge_ion"))}
    return f


def fmt_v(x):
    return E.NA if x is None else f"{x:+.0f}"


def keys_v3(case, M, out, d, pf):
    """/3 display keys (§7.1): c1_v, cool_v, warm_v, fit_dex, ovi_logN_lim, hi_logN_lim, case_title (+ grouped R)"""
    C = out["claims"]; L = out["limits"]
    sub = out["case"]["subcase"]
    title = LLS_TITLE if case == "damped" and sub == "lls" else CASE_TITLE[case]
    fd = C.get("fit_dex", {}).get("value")
    k = {"c1_v": fmt_v(C.get("c1_v", {}).get("value")), "cool_v": fmt_v(C.get("cool_v", {}).get("value")),
         "warm_v": fmt_v(C.get("warm_v", {}).get("value")), "fit_dex": E.NA if fd is None else f"{abs(fd):.2f}",
         "ovi_logN_lim": f"{L['OVI']['logN_3sig']:.1f}", "hi_logN_lim": f"{L['HI']['logN_3sig']:.1f}",
         "case_title": title, "page_R": E.fmt_int(S.R_PAGE), "page_sn": f"{S.SN_PAGE:g}",
         "lim_b_HI": f"{L['HI']['b']:.0f}", "lim_b_OVI": f"{L['OVI']['b']:.0f}"}
    if M["ions"]["HI"]["logN"] >= 20.3:          # §4.4 item 5: the hi_lls string says damped above 20.3
        k["hi_lls"] = "above 20.3: a damped Lyman-alpha system"
    if case == "multiphase" and C.get("cool_v", {}).get("value") is not None and C.get("warm_v", {}).get("value") is not None:
        k["dv_pair"] = f"{abs(C['cool_v']['value'] - C['warm_v']['value']):.0f}"
    return k


def gates_block(case, M, out, d, encs, cellcols, exported, plan):
    """data-side gates: G16 (case rule with margin >= 0.1 + claims recorded), G15 data part, G13r data part, parity"""
    v = out["case"]["verdict"]
    g16 = {"pass": bool(v["ok"] and v["margin_ok"]), "margin": v["margin"], "weakest": v["weakest"],
           "rule": f"{S.CASE_ID[case]} case/1 passes on the Trident story with margin >= {S.MARGIN_MIN}; claims recorded "
                   "(a false claim gates its copy line, never the story)",
           "claims_false": sorted(k for k, c in out["claims"].items() if not c["pass"])}
    # G15 data part
    lc = np.asarray(d["geometry"]["cells"]["lc"], float)
    e_by = {e["id"]: e for e in encs}
    cw_ions = (M.get("cw_path") is not None)
    g15 = []
    for p in plan["encounters"]:
        if not p.get("letter") or p.get("synthetic"):
            continue
        e = e_by[p["id"]]; s_ = plan["slots"][p["letter"]]
        lead = p["lead"]; N = cellcols[lead]["N"]
        inside = N[(lc >= s_["l0"]) & (lc <= s_["l1"])].sum(); tot = N[e["idx"]].sum()
        share = float(inside / tot) if tot > 0 else 0.0
        vcat = catalogue_v(p, lead)
        dv = None if vcat is None or p["V"] is None else abs(p["V"] - vcat)
        g15.append({"letter": p["letter"], "enc": p["id"], "crest": bool(p.get("clouds")), "window_share": rnd(share, 3),
                    "V": p["V"], "V_catalogue": rnd(vcat, 1), "dV": rnd(dv, 1),
                    "pass": bool(p.get("clouds")) and share >= 0.5 and (dv is None or dv <= 10.0)})
    syn = [p for p in plan["encounters"] if p.get("letter") and p.get("synthetic")]
    g15_ok = all(x["pass"] for x in g15)
    # G13r data part: the worked S5 tau0 recomputed from the shipped cells
    w = d["worked"]["S5"]; c5 = int(w["cell"]); oc = d["ions"]["OVI"]["cells"]
    t0 = float(oc["tau0"][c5]) if oc["tau0"][c5] is not None else 0.0
    rel = abs(t0 - float(w["tau0"])) / max(abs(t0), 1e-12)
    g13 = {"S5_tau0_cells": rnd(t0, 5), "S5_tau0_worked": w["tau0"], "rel": rnd(rel, 4), "pass": rel < 0.01,
           "roles_dropped": sorted(k for k, r in out["roles"].items() if k != "cells" and r.get("ok") is False),
           "new_dip_key": "plan.slots.<slot>.new_dip.<ion> = argmax of the tau gained over the slot window"}
    ch = d["meta"]["checks"]
    parity = {k: {"dF": rnd(ch[k]["max_abs_dF_cellsum_vs_stored"], 6), "dF_limit": rnd(ch[k]["dF_limit"], 6),
                  "EW_rel": rnd(ch[k]["EW_rel"], 6), "EW_limit": rnd(ch[k]["EW_limit"], 6)} for k in ch}
    cc = out["cube_cover"]
    return {"G16": g16, "G15_data": {"pass": g15_ok, "letters": g15, "synthetic": [p["id"] for p in syn],
                                     "note": "catalogue V = column-weighted V of the encounter's lead-ion CREST clouds"},
            "G13r_data": g13, "parity": {"pass": True, "ions": parity, "note": "the build fails loud when parity misses"},
            "cover": {"pass": cc["end_r_kpc"] <= END_R_MAX or cc["director_note"] is not None, "end_r_kpc": cc["end_r_kpc"]},
            "budget": None, "all_data": None}


_CLOUD_V = {}


def catalogue_v(p, lead):
    """column-weighted V of the encounter's lead-ion CREST clouds (set by export_story_data via set_cloud_v)"""
    vs = [(c["V"], c["N"]) for cid in p.get("clouds", []) for c in [_CLOUD_V.get(cid)] if c and c["ion"] == lead and c["V"] is not None]
    if not vs:
        return None
    w = sum(n for _, n in vs)
    return sum(v * n for v, n in vs) / w if w > 0 else None


def set_cloud_v(cw):
    _CLOUD_V.clear()
    for ion, rec in (cw or {}).get("ions", {}).items():
        for c in rec["clouds"]:
            _CLOUD_V[c["id"]] = {"ion": ion, "V": c.get("V"), "N": 10 ** c["logN_ray"] if c.get("logN_ray") is not None else c.get("frac_ion_column", 0)}


def finalize(data, extra_ion, v3):
    """merge the /3 blocks into the story dict in place; meta.schema -> story-data/3; returns the gz budget"""
    data["meta"]["schema"] = "story-data/3"
    data["meta"]["story_id"] = v3["story_id"]
    for k in ("case", "claims", "roles", "plan", "cloud_names", "tf_windows", "limits", "cube_cover", "lod", "galaxy",
              "ions_extra", "eligible_case", "gates_case"):
        data[k] = v3[k]
    if "noise" in v3:
        data["noise"] = v3["noise"]
    if v3.get("notes"):
        data["meta"]["plan_notes"] = v3["notes"]
    # Tier A files live under data/v3/ (story, page fits, clouds/, tube/), so a re-planned staged ray (the damped
    # rand_b050_a215) never overwrites its v2 files; paths inside the story stay relative to data/
    for k in ("tube", "clouds"):
        blk = data.get(k)
        if isinstance(blk, dict) and blk.get("path") and not blk["path"].startswith(DATA_PREFIX):
            blk["path"] = DATA_PREFIX + blk["path"]
    if data.get("clouds") is None:              # /3 schema: an object; a gas-free ray has no CREST cloud
        data["clouds"] = {"path": None, "schema": None, "summary": {},
                          "why": "CREST found no non-percolating level on this ray (no gas): no clouds"}
    if data.get("tube") is None:
        data["tube"] = {"path": None, "n": 0, "why": "no near-field tube was built for this ray"}
    data["flags"] = {**data["flags"], **{k: v for k, v in v3["flags_v3"].items() if isinstance(v, bool)}}
    # §4.4 item 5: richest_not_closest only when O VI is detected
    data["flags"]["richest_not_closest"] = bool(data["flags"].get("richest_not_closest") and data["flags"].get("ovi_detected"))
    data["keys"] = {**data["keys"], **v3["keys_v3"]}
    for k in ("s11_R", "broad_R", "invented_R"):       # §4.4 item 5: R digit grouping (site style 15 000)
        x = data["keys"].get(k)
        if isinstance(x, str) and x.isdigit():
            data["keys"][k] = E.fmt_int(int(x))
    return GZ_BASE + GZ_PER_EXTRA * (1 if extra_ion else 0)


def case_of_story_id(sid):
    return sid if sid in CASES else None


if __name__ == "__main__":                      # pragma: no cover
    print(__doc__)
    print("cases:", CASES, "extra ions:", EXTRA, "lead ions:", STORY_LEAD, os.environ.get("TNG_WORK"))
