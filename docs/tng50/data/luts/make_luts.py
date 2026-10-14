#!/usr/bin/env python3
"""Colour look-up tables for the 3D viewer (Phase-2b design §5.2).

    python docs/tng50/data/luts/make_luts.py [--out docs/tng50/data/luts/luts.json] [--js docs/tng50/js/colormaps.js]

Writes luts.json = {"version": 1, "luts": {name: {"hex": 768 hex chars (256 sRGB entries), "source", "licence"}}}
and, with --js, rewrites the STOPS block of colormaps.js: 33 stops of every LUT, each an (entry index, RGB) knot
placed so that linear interpolation reproduces all 256 entries (tests/js/colormaps.mjs checks within +-1).

- magma, inferno, viridis, cividis: matplotlib 3.9 colormaps sampled at 256 points (viridis/magma/inferno CC0,
  van der Walt & Smith; cividis: Nunez, Anderton & Renslow 2018, under the matplotlib licence).
- grey: linear ramp.
- tng_dusk, tng_ice: our own maps, defined by OKLCh control points (t, L, C, h deg) in Ottosson's OKLab
  (matrices from https://bottosson.github.io/posts/oklab/). L, C and the unwrapped hue are interpolated linearly in t;
  each entry is gamut-mapped to the largest C' <= C whose linear sRGB lies inside [0, 1] (30-step bisection),
  then sRGB-encoded.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np

NAMES = ["tng_dusk", "tng_ice", "magma", "inferno", "viridis", "cividis", "grey"]
N_STOPS = 33
OKLCH = {
    "tng_dusk": [(0, 0.13, 0.06, 265), (0.30, 0.38, 0.15, 305), (0.58, 0.62, 0.18, 385), (0.82, 0.83, 0.15, 425),
                 (1, 0.97, 0.06, 460)],
    "tng_ice": [(0, 0.12, 0.05, 255), (0.35, 0.42, 0.11, 235), (0.70, 0.72, 0.12, 195), (1, 0.97, 0.05, 170)],
}
HERE = Path(__file__).resolve().parent


def oklab_to_linear_srgb(L, a, b):
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    return np.array([4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                     -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                     -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s])


def srgb_encode(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * x ** (1 / 2.4) - 0.055)


def oklch_lut(points, n=256):
    P = np.array(points, float)
    t = np.linspace(0.0, 1.0, n)
    L, C, H = (np.interp(t, P[:, 0], P[:, k]) for k in (1, 2, 3))
    out = np.zeros((n, 3))
    for i in range(n):
        h = np.radians(H[i])

        def rgb(c):
            return oklab_to_linear_srgb(L[i], c * np.cos(h), c * np.sin(h))

        inside = lambda v: bool(np.all(v >= 0.0) and np.all(v <= 1.0))  # noqa: E731
        c = C[i]
        if not inside(rgb(c)):
            lo, hi = 0.0, c
            for _ in range(30):
                mid = 0.5 * (lo + hi)
                if inside(rgb(mid)):
                    lo = mid
                else:
                    hi = mid
            c = lo
        out[i] = srgb_encode(rgb(c))
    return np.clip(np.floor(out * 255 + 0.5), 0, 255).astype(np.uint8)


def mpl_lut(name, n=256):
    import matplotlib
    cm = matplotlib.colormaps[name]
    return np.clip(np.floor(cm(np.linspace(0, 1, n))[:, :3] * 255 + 0.5), 0, 255).astype(np.uint8)


def build():
    import matplotlib
    luts = {}
    for name in NAMES:
        if name in OKLCH:
            a = oklch_lut(OKLCH[name])
            src = "OKLCh control points " + " ".join(f"({t},{L},{C},{h})" for t, L, C, h in OKLCH[name]) + \
                  " in OKLab (B. Ottosson 2020), gamut-mapped by chroma bisection"
            lic = "MIT (this repository)"
        elif name == "grey":
            a = np.repeat(np.arange(256, dtype=np.uint8)[:, None], 3, axis=1)
            src, lic = "linear grey ramp", "MIT (this repository)"
        else:
            a = mpl_lut(name)
            src = f"matplotlib {matplotlib.__version__} colormap '{name}', 256 samples"
            lic = "CC0 1.0 (van der Walt & Smith)" if name != "cividis" else \
                "matplotlib licence (Nunez, Anderton & Renslow 2018)"
        luts[name] = {"hex": a.tobytes().hex(), "source": src, "licence": lic}
    return {"version": 1, "luts": luts}


def _seg_err(a, i, j):
    t = (np.arange(i, j + 1) - i) / (j - i)
    y = np.floor(a[i] * (1 - t)[:, None] + a[j] * t[:, None] + 0.5)      # = JS Math.round for these values
    return int(np.abs(y - a[i:j + 1]).max())


def knot_positions(a, m=N_STOPS):
    """Entries kept as stops: the fewest knots (dynamic programming) whose linear interpolation reproduces every
    entry within the smallest tolerance (0, then 1) that m knots allow, then padded to exactly m knots by splitting
    the longest segments. Evenly spaced stops cannot meet +-1 on tng_ice / cividis (gamut and data kinks: up to 8)."""
    n = len(a)
    for tol in (0, 1, 2, 3):
        best, prev = [10 ** 9] * n, [-1] * n
        best[0] = 1
        for j in range(1, n):
            for i in range(j - 1, -1, -1):
                if best[i] + 1 < best[j] and _seg_err(a, i, j) <= tol:
                    best[j], prev[j] = best[i] + 1, i
        if best[n - 1] <= m:
            break
    ks, j = [], n - 1
    while j >= 0:
        ks.append(j)
        j = prev[j]
    ks = sorted(ks)
    while len(ks) < m:            # pad: split the longest segment where both halves still meet the tolerance
        for g in np.argsort(-np.diff(ks), kind="stable"):
            a0, b0 = ks[g], ks[g + 1]
            mids = sorted(range(a0 + 1, b0), key=lambda c: abs(c - (a0 + b0) / 2))
            c = next((c for c in mids if _seg_err(a, a0, c) <= tol and _seg_err(a, c, b0) <= tol), None)
            if c is not None:
                ks.insert(int(g) + 1, c)
                break
        else:
            raise RuntimeError("cannot pad the stops")
    return ks


def stops(hexstr, m=N_STOPS):
    """m stops as 8 hex chars each: entry index (00..ff) then R, G, B of that entry."""
    a = np.frombuffer(bytes.fromhex(hexstr), np.uint8).reshape(256, 3).astype(int)
    return "".join(f"{k:02x}" + bytes(a[k].astype(np.uint8)).hex() for k in knot_positions(a, m))


def write_js(js_path: Path, obj):
    src = js_path.read_text()
    block = "export const STOPS = {\n" + ",\n".join(
        f'  {n}: "{stops(obj["luts"][n]["hex"])}"' for n in NAMES) + "\n};"
    new, k = re.subn(r"export const STOPS = \{[\s\S]*?\n\};", block, src)
    if k != 1:
        raise SystemExit("STOPS block not found in " + str(js_path))
    js_path.write_text(new)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=HERE / "luts.json")
    ap.add_argument("--js", type=Path, default=None)
    a = ap.parse_args(argv)
    obj = build()
    a.out.write_text(json.dumps(obj, indent=1) + "\n")
    print(f"wrote {a.out} ({len(obj['luts'])} LUTs)")
    if a.js:
        write_js(a.js, obj)
        print(f"updated STOPS in {a.js}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
