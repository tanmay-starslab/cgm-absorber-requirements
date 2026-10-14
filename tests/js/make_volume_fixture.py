#!/usr/bin/env python3
"""16^3 volume fixture for tests/js/volume_decode.mjs (design-2 §7.9).

    python tests/js/make_volume_fixture.py --out DIR
Writes DIR/manifest.json, DIR/f.u8.gz, DIR/f.raw.u8 (the same bytes, already decompressed), DIR/f.bad.u8.gz (wrong
length) and DIR/expect.json (q bytes as a list + tngsight.volume.decode_u8 values, x-fastest). Uses
tngsight.volume (encode_u8 / gzip_bytes / decode_u8) when it is importable; otherwise the §3.1 encoding written out
here (then the JS test still checks layout and decoding, but not against U_vol's implementation)."""
from __future__ import annotations
import argparse, gzip, hashlib, json, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
try:
    from tngsight import volume as V  # noqa: E402
except Exception:                     # noqa: BLE001 - U_vol's module may not exist yet
    V = None


def _encode(values, mask, lo, hi):
    with np.errstate(divide="ignore", invalid="ignore"):
        lg = np.log10(values)
    q = np.clip(1 + np.round((lg - lo) / (hi - lo) * 254), 1, 255)
    q[~mask | ~np.isfinite(lg) | ~(values > 0)] = 0
    return q.astype(np.uint8).transpose(2, 1, 0).tobytes()


def _decode(buf, n, lo, hi):
    q = np.frombuffer(buf, np.uint8).reshape(n, n, n).transpose(2, 1, 0).astype(np.float64)
    out = lo + (q - 1) * (hi - lo) / 254
    out[q == 0] = np.nan
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args(argv)
    a.out.mkdir(parents=True, exist_ok=True)
    n, lo, hi = 16, -6.0, 1.0
    i, j, k = np.meshgrid(np.arange(n), np.arange(n), np.arange(n), indexing="ij")
    vals = 10.0 ** (lo + (hi - lo) * ((i + 3 * j + 7 * k) % 97) / 96.0)        # [i,j,k] = (x,y,z), distinct along each axis
    vals[0, 0, 0] = np.nan; vals[1, 0, 0] = 0.0; vals[2, 0, 0] = -1.0           # empty cases -> q = 0
    r = np.sqrt(sum(((x + 0.5) / n - 0.5) ** 2 for x in (i, j, k)))
    mask = r <= 0.5
    if V is not None:
        raw = V.encode_u8(vals, mask, lo, hi); gz = V.gzip_bytes(raw); dec = V.decode_u8(raw, n, lo, hi); impl = "tngsight.volume"
    else:
        raw = _encode(vals, mask, lo, hi); gz = gzip.compress(raw, 9, mtime=0); dec = _decode(raw, n, lo, hi); impl = "spec-fallback"
    (a.out / "f.u8.gz").write_bytes(gz)
    (a.out / "f.raw.u8").write_bytes(raw)
    (a.out / "f.bad.u8.gz").write_bytes(gzip.compress(raw[:-5], 9, mtime=0))
    man = {"version": 1, "generator": "fixture", "half_kpc": 400.0, "grids": {"16": {"n": n, "voxel_kpc": 50.0}, "raw": {"n": n, "voxel_kpc": 50.0},
           "bad": {"n": n, "voxel_kpc": 50.0}},
           "fields": {"f": {"label": "f", "units": "cm^-3", "lo": lo, "hi": hi, "cmap": "viridis", "default_window": [-4.0, 0.0],
                            "files": {"16": "f.u8.gz", "raw": "f.raw.u8", "bad": "f.bad.u8.gz"},
                            "sha256": {"16": hashlib.sha256(gz).hexdigest()}}}}
    (a.out / "manifest.json").write_text(json.dumps(man))
    flat = np.asarray(dec, np.float64).transpose(2, 1, 0).ravel()             # x-fastest, like the bytes
    (a.out / "expect.json").write_text(json.dumps({"impl": impl, "n": n, "lo": lo, "hi": hi, "q": list(raw),
                                                    "decoded": [None if not np.isfinite(x) else float(x) for x in flat],
                                                    "probe": {"i": 5, "j": 3, "k": 9, "value_log10": float(np.log10(vals[5, 3, 9]))}}))
    print(f"wrote 16^3 fixture ({impl}) to {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
