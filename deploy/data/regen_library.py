#!/usr/bin/env python3
"""Regenerate the sightline library as data v2 (12 registry lines, npz v2 + TNGS v2 + components v2): job J_regen.

    python deploy/data/regen_library.py --out /Volumes/cgm_work/data/library_v3 \\
           [--src /Volumes/cgm_work/data/library] [-j 4] [--ids a,b] [--limit N] [--no-fit] [--gate-only] [--force]
           [--index FILE] [--cutout FILE]

Inputs (only read): the ids and sources of every entry of <src>/catalog.json (library and generated), and the stored
`geom` member of <src>/sightlines/<id>.npz or <src>/generated/<id>.npz, passed with the id to
generate.resolve_geometry, so the ray endpoints are bit-identical to the v1 library.

Process: the parent loads the slim cutout once to build the yt index (<out>/cutout.ewah unless --index), then
min(j, 4) spawn workers each hold one warm Generator (index_filename = that index, workdir <out>/.work/<pid>) and
make one sightline at a time: 12 lines (generate.Generator.generate, fit off), npz v2, TNGS v2, then the vpfit
components (tngsight.components.fit_payload with the AOD record) unless --no-fit.

Outputs under <out>: sightlines/<id>.npz | generated/<id>.npz, web/<id>.bin | generated/<id>.bin,
components/<id>.json ({"id", "fitter", "params_tag", "components": {k: rows}, "aod": {k: ...}}), regen_state.jsonl
(one JSON line per finished id: id, source, npz_sha256, registry_tag, params_tag, t_ray, t_spec, t_fit, n_px, logN),
and after all ids catalog.json (v2; ranks 1..N over library rows), components.json (v2, merged) and gate_report.json.
Every file write is atomic (tmp + os.replace); state lines are appended and fsynced one at a time.

Resume: an id is skipped when its last state line has the current registry_tag (and params_tag, unless --no-fit)
and its npz sha256 matches; an id whose npz is current but whose fit is stale is refitted only. A kill loses at most
the in-flight ids. --force redoes everything; --gate-only recomputes the gate (and the merged outputs) from the
state and the npz files.

Regression gate (gate_report.json; exit 2 on failure): hard |logN_v3 − logN_v1| ≤ 0.02 dex for OVI, CIII and
HI (vs the v1 HILyb: the same ion column), all ray columns (both −inf passes); hard |logN_aod_v3 − logN_v3| ≤ 0.01
for every line with logN_v3 ≥ 12; reported: AOD_v3 − AOD_v1 for OVI and CIII (expected ≥ −0.002; the positive tail is
the min_tau 1e-3 → 1e-8 deficit of the v1 library) and the 10 largest. A failing id is attributed to geometry
(endpoints differ), grid (n or u0 differ from native_grid), min_tau (AOD-only) or kernel.
Never run concurrently with J_viz or another heavy job (machine: 11 cores, 18 GB).
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import multiprocessing as mp
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))
import numpy as np  # noqa: E402
from tngsight import config, ions as I  # noqa: E402
from tngsight import library as Lb  # noqa: E402

MAX_WORKERS = 4
GATE_RAY_DEX = 0.02
GATE_AOD_DEX = 0.01
GATE_AOD_LOGN_MIN = 12.0
GATE_LINES = (("OVI", "OVI"), ("CIII", "CIII"), ("HI", "HILyb"))     # (v3 key, v1 key)
SRC_DEFAULT = Path("/Volumes/cgm_work/data/library")


# ------------------------------------------------------------------------------------------ io helpers
def sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def atomic_write(path: Path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.part")
    tmp.write_bytes(data)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def append_state(path: Path, rec: dict) -> None:
    line = (json.dumps(rec, separators=(",", ":"), allow_nan=False) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line)
        os.fsync(fd)
    finally:
        os.close(fd)


def read_state(path: Path) -> dict:
    """{id: last state record} (a truncated last line from a kill is ignored)."""
    out = {}
    if not path.is_file():
        return out
    for line in path.read_text().splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and "id" in r:
            out[r["id"]] = r
    return out


def _fin(x, nd=6):
    x = float(x)
    return round(x, nd) if math.isfinite(x) else None


def paths_for(out: Path, sid: str, source: str) -> dict:
    sub = "generated" if source == "generated" else "sightlines"
    web = out / ("generated" if source == "generated" else "web") / f"{sid}.bin"
    return {"npz": out / sub / f"{sid}.npz", "bin": web, "comp": out / "components" / f"{sid}.json"}


def src_npz(src: Path, sid: str, source: str) -> Path:
    sub = "generated" if source == "generated" else "sightlines"
    for p in (src / sub / f"{sid}.npz", src / sub / Lb.npz_name(sid)):
        if p.is_file():
            return p
    raise FileNotFoundError(f"{sid}: no npz under {src / sub}")


def collect(src: Path, ids=None, limit=None) -> list:
    """[(id, source, src npz path)] from <src>/catalog.json, in catalog order."""
    cat = json.loads((src / "catalog.json").read_text())
    rows = [(e["id"], e.get("source", "library")) for e in cat["entries"]]
    if ids:
        known = {r[0] for r in rows}
        missing = [s for s in ids if s not in known]
        if missing:
            raise SystemExit(f"ids not in {src / 'catalog.json'}: {missing}")
        rows = [r for r in rows if r[0] in set(ids)]
    if limit:
        rows = rows[: int(limit)]
    return [(sid, source, src_npz(src, sid, source)) for sid, source in rows]


def stored_geom(npz: Path) -> dict:
    with np.load(npz, allow_pickle=False) as d:
        return json.loads(str(d["geom"]))


# ------------------------------------------------------------------------------------------ worker
_G = None


def _init_worker(index, cutout, out, fit):
    for v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        os.environ.setdefault(v, "1")
    global _G
    from tngsight.generate import Generator
    _G = Generator(cutout=cutout, index_filename=index, workdir=Path(out) / ".work" / str(os.getpid()),
                   fit_components=False)
    _G._fit = bool(fit)


def fit_record(payload, sid):
    from tngsight import components as C
    aod = {}
    t0 = time.perf_counter()
    comps = C.fit_payload(payload, aod=aod)
    dt = time.perf_counter() - t0
    rows = {k: C.dicts_to_rows(v) for k, v in C.validate_components(comps).items()}
    rec = {"id": sid, "fitter": C.FITTER_TAG, "params_tag": C.params_tag(), "components": rows,
           "aod": C.validate_aod(aod)}
    return rec, dt


def work(job):
    """job = (sid, source, geom, out, mode) with mode "full" | "fit"; returns the state record."""
    sid, source, geom, out, mode = job
    from tngsight.generate import resolve_geometry
    P = paths_for(Path(out), sid, source)
    rec = {"id": sid, "source": source, "registry_tag": I.registry_tag(), "params_tag": None,
           "t_ray": None, "t_spec": None, "t_fit": None}
    if mode == "full":
        _G.load()
        sl, gid = resolve_geometry({**geom, "id": sid})
        payload = _G.generate({**sl, "id": gid})
        if payload["id"] != sid:
            raise RuntimeError(f"{sid}: generator returned id {payload['id']}")
        Lb.save_npz(P["npz"], payload)
        atomic_write(P["bin"], Lb.encode_web(Lb.load_npz(P["npz"], id=sid)))
        rec["t_ray"] = round(_G.timings.get("ray", 0.0), 2); rec["t_spec"] = round(_G.timings.get("spectra", 0.0), 2)
    payload = Lb.load_npz(P["npz"], id=sid)
    if payload["format"] != 2:
        raise RuntimeError(f"{sid}: {P['npz']} is not npz v2")
    if _G._fit:
        crec, dt = fit_record(payload, sid)
        atomic_write(P["comp"], json.dumps(crec, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())
        rec["params_tag"] = crec["params_tag"]; rec["t_fit"] = round(dt, 2)
    rec["npz_sha256"] = sha256(P["npz"])
    rec["n_px"] = {k: int(payload["tau"][k].size) for k in payload["lines"]}
    rec["logN"] = {k: _fin(payload["logN"][k]) for k in payload["lines"]}
    return rec


def work_safe(job):
    """work(job), but an exception becomes {"id", "error"} so one bad id never stops the pool (it is retried on resume)."""
    try:
        return work(job)
    except Exception as e:                                            # noqa: BLE001 (logged by the parent)
        import traceback
        return {"id": job[0], "error": f"{e.__class__.__name__}: {e}", "trace": traceback.format_exc()[-2000:]}


# ------------------------------------------------------------------------------------------ final outputs + gate
def build_index(index: Path, cutout, out: Path) -> float:
    """Load the cutout once in this process so yt writes the EWAH index file (then workers only read it)."""
    t0 = time.time()
    from tngsight.generate import Generator
    g = Generator(cutout=cutout, index_filename=index, workdir=out / ".work" / "index", fit_components=False)
    g.load()
    _ = g.ds.index                                                    # forces the particle index to be built/read
    del g
    return time.time() - t0


def merged_outputs(out: Path, jobs: list, state: dict, fit: bool) -> dict:
    from tngsight import components as C
    from tngsight.scoring import score_payload, assign_ranks, SCORING_TAG
    cat = Lb.catalog_skeleton()
    entries, comps, aods = [], {}, {}
    for sid, source, _ in jobs:
        if sid not in state:
            continue
        P = paths_for(out, sid, source)
        payload = Lb.load_npz(P["npz"], id=sid)
        crow = None
        if fit and P["comp"].is_file():
            crec = json.loads(P["comp"].read_text())
            comps[sid] = crec["components"]; aods[sid] = crec["aod"]
            crow = C.validate_components(crec["components"])
        e = Lb.catalog_entry(payload, score_payload(payload), source, components=crow)
        e["rank"] = None
        entries.append(e)
    assign_ranks([e for e in entries if e["source"] == "library"])
    cat["entries"] = entries
    cat["scoring"] = SCORING_TAG
    blob = json.dumps(cat, separators=(",", ":"), allow_nan=False).encode()
    atomic_write(out / "catalog.json", blob)
    res = {"catalog_bytes": len(blob), "n_entries": len(entries)}
    if fit:
        cobj = C.make_catalogue(comps, aod=aods)
        C.validate_catalogue(cobj)
        cb = C.dump_catalogue(cobj)
        atomic_write(out / "components.json", cb)
        res["components_bytes"] = len(cb)
    return res


def _gate_cause(v1p, v3p, sid):
    g1, g3 = v1p["geom"], v3p["geom"]
    for k in ("start_ckpch", "end_ckpch"):
        if not np.array_equal(np.asarray(g1[k], float), np.asarray(g3[k], float)):
            return "geometry"
    for k in v3p["lines"]:
        lam0, dlam, n = Lb.native_grid(k, v3p["W"][k])
        if n != v3p["tau"][k].size or abs(v3p["lam0"][k] - lam0) > 1e-9 * lam0:
            return "grid"
    return "kernel"


PIXEL_TAU_MIN = 1.0                                                   # "strong" v1 pixels for the pixel comparison


def pixel_compare(v1p, v3p, keys=("OVI", "CIII")) -> dict:
    """Reported, never gating (C1 / D3): per line, v1 vs v3 τ on the strong v1 pixels (τ1 > PIXEL_TAU_MIN, ≥ 5 of
    them, 3 km/s inside the v3 window). v3 is interpolated onto the v1 velocity labels; Trident labels a v1 bin by its
    left edge λ_k although it averages τ over [λ_k, λ_k + dλ), so the same comparison is repeated on the bin centres
    (u1 + c dλ/2 / λ0), and the least-squares shift s (v3 at u1 + s, −2..2 km/s in 0.01) is measured.
    Returns {k: {n, half_dlam_kms, rel_med, rel_p99, rel_p99_centre, shift_kms}} (relative |τ3 − τ1| / τ1)."""
    out = {}
    for k in keys:
        if k not in v1p.get("tau", {}) or k not in v3p.get("tau", {}):
            continue
        u1, t1 = np.asarray(v1p["u"][k], float), np.asarray(v1p["tau"][k], float)
        u3, t3 = np.asarray(v3p["u"][k], float), np.asarray(v3p["tau"][k], float)
        m = (t1 > PIXEL_TAU_MIN) & (u1 > u3[0] + 3.0) & (u1 < u3[-1] - 3.0)
        if m.sum() < 5:
            continue
        half = 0.5 * float(v1p["du"][k])
        rel = np.abs(np.interp(u1[m], u3, t3) - t1[m]) / t1[m]
        relc = np.abs(np.interp(u1[m] + half, u3, t3) - t1[m]) / t1[m]
        ss = np.arange(-2.0, 2.0005, 0.01)
        chi = [float(np.sum((np.interp(u1[m] + x, u3, t3) - t1[m]) ** 2)) for x in ss]
        out[k] = {"n": int(m.sum()), "half_dlam_kms": _fin(half, 4), "rel_med": _fin(np.median(rel), 4),
                  "rel_p99": _fin(np.percentile(rel, 99), 4), "rel_p99_centre": _fin(np.percentile(relc, 99), 4),
                  "shift_kms": _fin(ss[int(np.argmin(chi))], 3)}
    return out


def gate(out: Path, jobs: list, state: dict, report_path: Path | None = None) -> dict:
    """The regression gate over `jobs` (module doc); written to report_path (default <out>/gate_report.json)."""
    rows, fails, d_aod = [], [], {"OVI": [], "CIII": []}
    pix = {"OVI": [], "CIII": []}
    for sid, source, srcp in jobs:
        if sid not in state:
            fails.append({"id": sid, "check": "missing", "cause": "not generated"})
            continue
        v3 = Lb.load_npz(paths_for(out, sid, source)["npz"], id=sid)
        with np.load(srcp, allow_pickle=False) as d:
            v1_logN = {k: float(d[f"logN_{k}"]) for k in Lb.V1_KEYS if f"logN_{k}" in d.files}
        v1 = None
        a3 = Lb.aod_columns(v3, nd=6)
        r = {"id": sid, "ray": {}, "aod_complete": {}}
        for k3, k1 in GATE_LINES:
            x3, x1 = v3["logN"].get(k3, -math.inf), v1_logN.get(k1, -math.inf)
            if math.isinf(x3) and math.isinf(x1):
                dd = 0.0
            else:
                dd = abs(x3 - x1) if math.isfinite(x3) and math.isfinite(x1) else math.inf
            r["ray"][k3] = _fin(dd, 5) if math.isfinite(dd) else "inf"
            if dd > GATE_RAY_DEX:
                v1 = v1 or Lb.load_npz(srcp, id=sid)
                fails.append({"id": sid, "check": f"ray {k3}", "d": _fin(dd, 5), "cause": _gate_cause(v1, v3, sid)})
        for k in v3["lines"]:
            x = v3["logN"][k]
            if math.isfinite(x) and x >= GATE_AOD_LOGN_MIN:
                a = a3.get(k)
                dd = math.inf if a is None else abs(a - x)
                r["aod_complete"][k] = _fin(dd, 5) if math.isfinite(dd) else "inf"
                if dd > GATE_AOD_DEX:
                    v1 = v1 or Lb.load_npz(srcp, id=sid)
                    cause = _gate_cause(v1, v3, sid)
                    fails.append({"id": sid, "check": f"aod {k}", "d": _fin(dd, 5),
                                  "cause": "min_tau" if cause == "kernel" else cause})
        v1 = v1 or Lb.load_npz(srcp, id=sid)
        a1 = Lb.aod_columns(v1, nd=6)
        for k in ("OVI", "CIII"):
            if a1.get(k) is not None and a3.get(k) is not None:
                d_aod[k].append((a3[k] - a1[k], sid))
        for k, x in pixel_compare(v1, v3).items():
            pix[k].append((sid, x))
        rows.append(r)
    rep = {"hard": {"ray_dex": GATE_RAY_DEX, "aod_complete_dex": GATE_AOD_DEX, "aod_logN_min": GATE_AOD_LOGN_MIN},
           "n_ids": len(jobs), "n_checked": len(rows), "pass": not fails, "fails": fails,
           "max_ray": {k: max([x["ray"][k] for x in rows if isinstance(x["ray"].get(k), float)] or [None])
                       if rows else None for k, _ in GATE_LINES},
           "aod_v3_minus_v1": {}, "note": "AOD differences come from min_tau 1e-3 -> 1e-8 (the v1 deposition deficit); "
                                          "the grid and the kernel are neutral (design §0.1)", "rows": rows}
    for k, v in d_aod.items():
        if v:
            a = np.array([x for x, _ in v])
            rep["aod_v3_minus_v1"][k] = {"n": int(a.size), "min": _fin(a.min(), 4), "p01": _fin(np.percentile(a, 1), 4),
                                         "median": _fin(np.median(a), 4), "p99": _fin(np.percentile(a, 99), 4),
                                         "max": _fin(a.max(), 4), "n_below_-0.002": int((a < -0.002).sum()),
                                         "largest10": [[sid, _fin(x, 4)] for x, sid in sorted(v, reverse=True)[:10]]}
    rep["pixel_v1_v3"] = {"note": "reported, not gating: v1 vs v3 tau on strong v1 pixels (tau1 > 1); v1 bins are "
                                  "labelled by their left edge (Trident sub-bins over [lam_k, lam_k + dlam)), so narrow "
                                  "v1 lines sit up to dlam/2 blue of v3; only the integrated AOD is grid-neutral",
                          "tau_min": PIXEL_TAU_MIN}
    for k, v in pix.items():
        if not v:
            continue
        col = lambda f: np.array([x[f] for _, x in v], float)
        rp, sh = col("rel_p99"), col("shift_kms")
        rep["pixel_v1_v3"][k] = {
            "n_sightlines": len(v), "half_dlam_kms": v[0][1]["half_dlam_kms"],
            "rel_med": {"median": _fin(np.median(col("rel_med")), 4), "max": _fin(col("rel_med").max(), 4)},
            "rel_p99": {"median": _fin(np.median(rp), 4), "p90": _fin(np.percentile(rp, 90), 4), "max": _fin(rp.max(), 4)},
            "rel_p99_centre": {"median": _fin(np.median(col("rel_p99_centre")), 4),
                               "max": _fin(col("rel_p99_centre").max(), 4)},
            "shift_kms": {"median": _fin(np.median(sh), 3), "p10": _fin(np.percentile(sh, 10), 3),
                          "p90": _fin(np.percentile(sh, 90), 3)},
            "largest5_rel_p99": [[sid, x["rel_p99"], x["shift_kms"]] for sid, x in
                                 sorted(v, key=lambda t: -t[1]["rel_p99"])[:5]]}
    atomic_write(report_path or out / "gate_report.json", (json.dumps(rep, indent=1, allow_nan=False) + "\n").encode())
    return rep


# ------------------------------------------------------------------------------------------ main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--src", type=Path, default=SRC_DEFAULT)
    ap.add_argument("-j", "--jobs", type=int, default=MAX_WORKERS)
    ap.add_argument("--ids", default="")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--no-fit", action="store_true")
    ap.add_argument("--gate-only", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--index", type=Path, default=None, help="yt index file (default <out>/cutout.ewah)")
    ap.add_argument("--cutout", type=Path, default=None, help="slim cutout (default tngsight.config.cutout_path())")
    a = ap.parse_args(argv)
    if a.jobs > MAX_WORKERS:
        ap.error(f"-j {a.jobs} refused: at most {MAX_WORKERS} workers (machine memory)")
    out, src = a.out.resolve(), a.src.resolve()
    if out == src or src in out.parents or out in src.parents:
        ap.error(f"--out {out} must be separate from --src {src} (the source library is only read)")
    if str(out).startswith("/Volumes/LaCie"):
        ap.error("never write to /Volumes/LaCie")
    out.mkdir(parents=True, exist_ok=True)
    index = (a.index or out / "cutout.ewah").resolve()
    cutout = a.cutout or config.cutout_path()
    fit = not a.no_fit
    ids = [s.strip() for s in a.ids.split(",") if s.strip()] or None
    jobs = collect(src, ids, a.limit)
    state_p = out / "regen_state.jsonl"
    state = read_state(state_p)
    tag = I.registry_tag()
    from tngsight import components as C
    ptag = C.params_tag()
    T0 = time.time()
    print(f"[regen] {len(jobs)} ids from {src}; out {out}; registry_tag {tag}; params_tag {ptag if fit else '-'}; "
          f"jobs {a.jobs}; min_tau {config.SPEC_MIN_TAU:g}", flush=True)
    if not a.gate_only:
        todo = []
        for sid, source, srcp in jobs:
            P = paths_for(out, sid, source)
            s = state.get(sid)
            npz_ok = (not a.force and s is not None and s.get("registry_tag") == tag and P["npz"].is_file()
                      and P["bin"].is_file() and s.get("npz_sha256") == sha256(P["npz"]))
            fit_ok = (not fit) or (npz_ok and s.get("params_tag") == ptag and P["comp"].is_file())
            if npz_ok and fit_ok:
                continue
            todo.append((sid, source, stored_geom(srcp), str(out), "fit" if npz_ok else "full"))
        print(f"[regen] {len(jobs) - len(todo)} up to date, {len(todo)} to do "
              f"({sum(1 for t in todo if t[4] == 'fit')} refit only)", flush=True)
        if todo:
            if not index.is_file():
                print(f"[regen] building the yt index {index} ...", flush=True)
                print(f"[regen] index ready in {build_index(index, cutout, out):.0f} s", flush=True)
            nw = max(1, min(a.jobs, MAX_WORKERS, len(todo)))
            ctx = mp.get_context("spawn")
            done = errs = 0
            with ctx.Pool(nw, initializer=_init_worker, initargs=(str(index), str(cutout), str(out), fit),
                          maxtasksperchild=None) as pool:
                for rec in pool.imap_unordered(work_safe, todo):
                    if "error" in rec:
                        errs += 1
                        append_state(out / "regen_errors.jsonl", {**rec, "t": round(time.time() - T0, 1)})
                        print(f"[regen] ERROR {rec['id']}: {rec['error']}", flush=True)
                        continue
                    append_state(state_p, rec)
                    state[rec["id"]] = rec
                    done += 1
                    print(f"[regen] {done}/{len(todo)} {rec['id']}: ray {rec['t_ray']} s, spectra {rec['t_spec']} s, "
                          f"fit {rec['t_fit']} s; {time.time() - T0:.0f} s elapsed", flush=True)
        if todo and errs:
            print(f"[regen] {errs} ids failed (regen_errors.jsonl); rerun to retry them", flush=True)
    t = time.time()
    res = merged_outputs(out, jobs, state, fit)
    print(f"[regen] catalog.json {res['catalog_bytes'] / 1e6:.3f} MB ({res['n_entries']} rows)"
          + (f", components.json {res['components_bytes'] / 1e6:.3f} MB" if fit else "")
          + f" in {time.time() - t:.0f} s", flush=True)
    rep = gate(out, jobs, state)
    print(f"[gate] {'PASS' if rep['pass'] else 'FAIL'}: {len(rep['fails'])} failures over {rep['n_checked']} ids; "
          f"max ray |d| {rep['max_ray']}; AOD v3-v1 {json.dumps({k: {x: v[x] for x in ('min', 'median', 'max')} for k, v in rep['aod_v3_minus_v1'].items()})}",
          flush=True)
    for f in rep["fails"][:20]:
        print(f"[gate]   {f}", flush=True)
    print(f"[regen] wall {time.time() - T0:.0f} s", flush=True)
    return 0 if rep["pass"] else 2


if __name__ == "__main__":
    sys.exit(main())
