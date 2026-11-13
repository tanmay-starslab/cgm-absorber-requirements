"""U_spec (run: python tests/js/fixtures/story_spec/make_tau_ref.py <repo root>): independent offline reference for the live spectrum dock (DESIGN_final §5.4 acceptance).

Reads the SHIPPED story-data/2 JSON (the same inputs the browser gets) and computes, with numpy + scipy wofz
(an implementation independent of the JS code):
  W_i(s) = kcdf_eval(table, q_i = d_i/h_i, u = (s - lc_i)/c_i), c_i = sqrt(h_i^2 - d_i^2)   (exporter's rule)
  tau_i(v) = k_tau N_i H(a_i, (v - V_i)/b_i) / b_i    on the 1 km/s grid V0..V1
  tau(s, v) = sum_i W_i(s) tau_i(v)
at 500 seeded random s in [s_min - 5, s_max + 5] (plus the ends), for both ions, on every 8th grid bin plus the bins of
the spectral minima, and the full-grid end-of-flight tau. Writes tests/js/fixtures/story_spec/tau_ref.json.
"""
import json, math, sys
from pathlib import Path
import numpy as np
from scipy.special import wofz

root = Path(sys.argv[1])
data = json.loads((root / "docs/tng50/learn/how-a-spectrum-is-made/data/story_488530_rand_b062_a062.json").read_text())
out = root / "tests/js/fixtures/story_spec/tau_ref.json"

g = data["geometry"]["cells"]
h = np.asarray(g["h"], float); d = np.asarray(g["d"], float); lc = np.asarray(g["lc"], float)
q = np.clip(d / h, 0, 1)
c = np.sqrt(np.maximum(h * h - d * d, 0.0))
kc = data["geometry"]["kernel_cdf"]
tab = np.asarray([row for row in kc["table"]], float)


def kcdf_eval(tab, q, u):
    nq, nu = tab.shape
    qq = np.clip(np.asarray(q, float), 0, 1) * (nq - 1)
    uu = (np.clip(np.asarray(u, float), -1, 1) + 1) * 0.5 * (nu - 1)
    i = np.minimum(np.floor(qq).astype(int), nq - 2); j = np.minimum(np.floor(uu).astype(int), nu - 2)
    tq = qq - i; tu = uu - j
    return ((1 - tq) * (1 - tu) * tab[i, j] + tq * (1 - tu) * tab[i + 1, j] + (1 - tq) * tu * tab[i, j + 1]
            + tq * tu * tab[i + 1, j + 1])


def W(s):
    return kcdf_eval(tab, q, (s - lc) / np.maximum(c, 1e-12))


grid = data["meta"]["grid"]
v = np.arange(grid["V0"], grid["V1"] + 0.5 * grid["dV"], grid["dV"], dtype=float)
tm = {}
for ion in ("OVI", "HI"):
    I = data["ions"][ion]; at = I["atom"]; C = I["cells"]
    M = np.zeros((len(lc), v.size))
    for i, (lN, V, b, a) in enumerate(zip(C["logN"], C["V"], C["b"], C["a"])):
        if lN is None or not (b > 0):
            continue
        M[i] = at["k_tau"] * 10 ** lN * wofz((v - V) / b + 1j * a).real / b
    tm[ion] = M

rng = np.random.default_rng(20261112)
smin, smax = float((lc - c).min()), float((lc + c).max())
S = np.round(np.concatenate([[smin - 1, smax + 1], rng.uniform(smin - 5, smax + 5, 498)]), 6)
bins = sorted(set(range(0, v.size, 40)) | {int(round(x - grid["V0"])) for x in (-55, 12, 61, 96, -96, 35)})
ref = {"schema": "story-spec-tau-ref/1", "source": "scipy.special.wofz + numpy kcdf_eval on the shipped JSON",
       "s": [round(float(x), 6) for x in S], "bins": bins, "v0": grid["V0"], "dv": grid["dV"], "tau": {}, "eof": {},
       "cells": {}}
for ion in ("OVI", "HI"):
    T = np.stack([W(s) @ tm[ion] for s in S])
    ref["tau"][ion] = [[float("%.9g" % x) for x in row[bins]] for row in T]
    ref["eof"][ion] = [float("%.9g" % x) for x in (W(smax + 1) @ tm[ion])]
    top = np.argsort(-tm[ion].max(axis=1))[:2].tolist() + [300]
    ref["cells"][ion] = {str(i): [float("%.9g" % x) for x in tm[ion][i]] for i in top}
    Fst = np.asarray(data["ions"][ion]["F_intrinsic"], float)
    ref.setdefault("eof_vs_stored_maxdF", {})[ion] = float(np.max(np.abs(np.exp(-W(smax + 1) @ tm[ion]) - Fst)))
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(ref, separators=(",", ":")))
print(out, out.stat().st_size, ref["eof_vs_stored_maxdF"])
