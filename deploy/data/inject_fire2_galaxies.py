#!/usr/bin/env python3
"""Build the 23 FIRE-2 galaxy entries from record.json + web/catalog.json and idempotently merge them into
DATA.galaxies.list in docs/tng50/index.html (preserving all 198 TNG50 galaxies + 23 FIRE-2 galaxies = 221 total).

    python deploy/data/inject_fire2_galaxies.py [--fire2-root /data/sborthak/cgm_absorber_requirements/fire2]
                                                [--json-out /data/sborthak/cgm_absorber_requirements/fire2/fire2_galaxies_list.json]
                                                [--index-html docs/tng50/index.html]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))

FIRE2_GIDS: tuple[str, ...] = (
    "m12b",
    "m12c",
    "m12f",
    "m12i",
    "m12m",
    "m12r",
    "m12w",
    "m12z",
    "Romeo",
    "Juliet",
    "Romulus",
    "Remus",
    "Thelma",
    "Louise",
    "m11b",
    "m11d",
    "m11e",
    "m11h",
    "m11i",
    "m11q",
    "m10q",
    "m10v",
    "m09",
)

MW_ELVIS_GIDS: frozenset[str] = frozenset({
    "m12b", "m12c", "m12f", "m12i", "m12m", "m12r", "m12w", "m12z",
    "Romeo", "Juliet", "Romulus", "Remus", "Thelma", "Louise",
})

DEFAULT_FIRE2_ROOT = Path("/data/sborthak/cgm_absorber_requirements/fire2")
DEFAULT_JSON_OUT = DEFAULT_FIRE2_ROOT / "fire2_galaxies_list.json"
DEFAULT_INDEX_HTML = ROOT / "docs" / "tng50" / "index.html"


def shard(gid: int | str) -> int:
    if isinstance(gid, int) or str(gid).isdigit():
        return int(gid) % 4
    return int(hashlib.sha256(str(gid).encode("utf-8")).hexdigest()[:8], 16) % 4


def build_fire2_entry(fire2_root: Path, gid: str) -> dict:
    gdir = fire2_root / gid
    rec_path = gdir / "record.json"
    cat_path = gdir / "web" / "catalog.json"
    if not rec_path.is_file():
        raise FileNotFoundError(f"Missing record.json: {rec_path}")
    if not cat_path.is_file():
        raise FileNotFoundError(f"Missing web/catalog.json: {cat_path}")

    rec = json.loads(rec_path.read_text(encoding="utf-8"))
    cat = json.loads(cat_path.read_text(encoding="utf-8"))
    g_cat = cat.get("galaxy") or {}

    mstar = float(rec.get("Mstar_Msun", g_cat.get("Mstar_Msun", 0.0)))
    sfr = float(rec.get("SFR_Msun_yr", g_cat.get("SFR_Msun_yr", 0.0)))
    m200c = float(rec.get("M200c_Msun", g_cat.get("M200c_Msun", 0.0)))
    r200c = float(rec.get("R200c_kpc", g_cat.get("R200c_kpc", 0.0)))

    n_entries = len(cat.get("entries") or [])
    n_rays = n_entries if n_entries > 0 else 120
    k = shard(gid)
    is_mw = gid in MW_ELVIS_GIDS
    is_m31 = bool(m200c >= 1.2e12)

    return {
        "id": gid,
        "sim": "FIRE-2",
        "label": f"Halo {gid}",
        "Mstar": round(mstar, 1),
        "SFR": round(sfr, 4),
        "M200c": round(m200c, 1),
        "R200c": round(r200c, 1),
        "central": True,
        "mw": is_mw,
        "m31": is_m31,
        "n": int(n_rays),
        "viz": True,
        "src": "trident",
        "gas_poor": False,
        "base": f"https://huggingface.co/datasets/tanmay-starslab/fire2-core-web-{k}/resolve/main/{gid}/",
    }


def build_fire2_list(fire2_root: Path = DEFAULT_FIRE2_ROOT) -> list[dict]:
    return [build_fire2_entry(fire2_root, gid) for gid in FIRE2_GIDS]


def inject_into_index_html(index_html: Path, fire2_entries: list[dict]) -> tuple[int, int, int]:
    """Idempotently merge `fire2_entries` into `DATA.galaxies.list` in `index_html`.
    Returns (n_tng50, n_fire2, n_total)."""
    html = index_html.read_text(encoding="utf-8")
    marker = "const DATA = "
    if marker not in html:
        raise ValueError(f"Could not find {marker!r} in {index_html}")
    start = html.index(marker) + len(marker)
    end = html.index(";\n", start)
    data = json.loads(html[start:end])

    galaxies_cfg = data.get("galaxies")
    if not isinstance(galaxies_cfg, dict) or not isinstance(galaxies_cfg.get("list"), list):
        raise ValueError(f"{index_html}: DATA.galaxies.list is missing or not a list")

    fire2_ids = {str(e["id"]) for e in fire2_entries}
    tng50_entries = [
        e for e in galaxies_cfg["list"]
        if str(e.get("id")) not in fire2_ids and str(e.get("sim") or "").upper() != "FIRE-2"
    ]

    merged = tng50_entries + list(fire2_entries)
    galaxies_cfg["list"] = merged

    dumped = json.dumps(data, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")
    new_html = html[:start] + dumped + html[end:]
    if new_html != html:
        tmp = index_html.with_name(index_html.name + ".tmp")
        tmp.write_text(new_html, encoding="utf-8")
        tmp.replace(index_html)

    return len(tng50_entries), len(fire2_entries), len(merged)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fire2-root", type=Path, default=DEFAULT_FIRE2_ROOT,
                    help=f"FIRE-2 data root (default: {DEFAULT_FIRE2_ROOT})")
    ap.add_argument("--json-out", type=Path, default=DEFAULT_JSON_OUT,
                    help=f"Output JSON file for the 23 FIRE-2 entries (default: {DEFAULT_JSON_OUT})")
    ap.add_argument("--index-html", type=Path, default=DEFAULT_INDEX_HTML,
                    help=f"Path to docs/tng50/index.html (default: {DEFAULT_INDEX_HTML})")
    ap.add_argument("--no-inject", action="store_true",
                    help="Only write --json-out without modifying --index-html")
    args = ap.parse_args(argv)

    entries = build_fire2_list(args.fire2_root)
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(entries)} FIRE-2 galaxy entries to {args.json_out}")

    if not args.no_inject:
        n_tng, n_fire, n_tot = inject_into_index_html(args.index_html, entries)
        print(f"Injected into {args.index_html}: {n_tng} TNG50 + {n_fire} FIRE-2 = {n_tot} galaxies total")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
