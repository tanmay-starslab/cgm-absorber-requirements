#!/usr/bin/env python3
"""Reference vectors for tests/js/picker_math.mjs (design-2 §7.9): 200+ endpoint pairs with Python's canonical
quantisation (round(10*x), half-to-even), custom ids and tngsight.geometry.make_endpoints metrics, plus
ray/plane and radius-clamp cases computed with numpy.

    python tests/js/make_picker_reference.py --out REF.json
Imports tngsight only (plus numpy)."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tngsight import geometry as G  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    rng = np.random.default_rng(20261013)
    pairs = [((-100, 0, 0), (100, 0, 0)), ((12.34, -56.78, 90.05), (-200.0, 150.25, -0.04))]
    # exact .x5 / sign / -0 cases (binary values decide: 0.15*10 = 1.5 exactly -> 2; 0.25*10 = 2.5 -> 2; 2.675*10 ...)
    ties = [0.05, -0.05, 0.15, -0.15, 0.25, -0.25, 0.35, 1.25, -1.25, 2.675, 150.25, -150.25, 0.45, -0.04, -0.4, 12.35, 99.95, 394.95, -394.95, 0.0]
    for i in range(0, len(ties) - 2, 3):
        pairs.append(((ties[i], ties[i + 1], ties[i + 2]), (100.0 + ties[i + 2], -50.0, 30.0 - ties[i])))
    while len(pairs) < 230:
        k = len(pairs) % 4
        if k == 0:      # generic, within the sphere
            p0, p1 = rng.uniform(-220, 220, 3), rng.uniform(-220, 220, 3)
        elif k == 1:    # quantised to 0.05 kpc: many exact halves
            p0, p1 = np.round(rng.uniform(-200, 200, 3) * 20) / 20, np.round(rng.uniform(-200, 200, 3) * 20) / 20
        elif k == 2:    # long rays near the 395 kpc limit
            u, v = rng.normal(size=3), rng.normal(size=3)
            p0, p1 = u / np.linalg.norm(u) * rng.uniform(380, 400), v / np.linalg.norm(v) * rng.uniform(380, 400)
        else:           # short rays near the 20 kpc limit, off-centre
            c = rng.uniform(-150, 150, 3); d = rng.normal(size=3); d /= np.linalg.norm(d)
            p0, p1 = c - d * rng.uniform(8, 12), c + d * rng.uniform(8, 12)
        pairs.append((tuple(float(x) for x in p0), tuple(float(x) for x in p1)))
    cases = []
    for p0, p1 in pairs:
        p0, p1 = [float(x) for x in p0], [float(x) for x in p1]
        t = [int(round(10 * x)) for x in p0 + p1]
        q0, q1 = [x / 10 for x in t[:3]], [x / 10 for x in t[3:]]
        try:
            can = G.canonicalize_endpoints(p0, p1); err = None
        except ValueError as exc:
            can, err = None, str(exc)
        L = float(np.linalg.norm(np.subtract(q1, q0)))
        m = G.make_endpoints(q0, q1) if L > 0 else None
        cases.append({"p0": p0, "p1": p1, "tenths": t, "q0": q0, "q1": q1, "id": G.custom_id(q0, q1),
                      "canonical_id": can["id"] if can else None, "error": err,
                      "length": m and m["length_kpc"], "b": m and m["b_kpc"], "b_segment": m and m["b_segment_kpc"],
                      "angle_deg": m and m["angle_to_normal_deg"],
                      "closest": m and (np.asarray(m["anchor_kpc"]) - G.CENTER_KPC).tolist()})
    planes = []
    for _ in range(40):
        o = rng.uniform(-1500, 1500, 3); n = rng.normal(size=3); n /= np.linalg.norm(n)
        d = float(rng.uniform(-100, 100)); dirv = rng.normal(size=3); dirv /= np.linalg.norm(dirv)
        den = float(np.dot(n, dirv)); tt = (d - float(np.dot(n, o))) / den
        planes.append({"o": o.tolist(), "dir": dirv.tolist(), "n": n.tolist(), "d": d,
                       "hit": (o + tt * dirv).tolist() if tt >= 0 else None})
    clamps = []
    for _ in range(30):
        p = rng.normal(size=3) * rng.uniform(50, 700)
        r = float(np.linalg.norm(p))
        clamps.append({"p": p.tolist(), "out": (p * (395.0 / r)).tolist() if r > 395.0 else p.tolist()})
    out = {"meta": {"Lhat": G.LHAT.tolist(), "n": len(cases)}, "cases": cases, "planes": planes, "clamps": clamps,
           "golden": {"cust_35277e0469": [[-100, 0, 0], [100, 0, 0]], "cust_b7fe2279d7": [[12.34, -56.78, 90.05], [-200.0, 150.25, -0.04]]}}
    Path(a.out).write_text(json.dumps(out))
    print(f"wrote {len(cases)} endpoint cases, {len(planes)} planes, {len(clamps)} clamps to {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
