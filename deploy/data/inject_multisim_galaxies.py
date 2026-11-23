#!/usr/bin/env python3
"""Build the SIMBA-25, SIMBA-100, AGORA, and CAMELS galaxy entries from record.json + web/catalog.json
and idempotently merge them into DATA.galaxies.list in docs/tng50/index.html (preserving all 198 TNG50
and 23 FIRE-2 galaxies).

    python deploy/data/inject_multisim_galaxies.py [--simba-root /scratch/tsingh65/cgm_work/data/simba_gal]
                                                   [--public-root /scratch/tsingh65/cgm_work/data/public_sims/cutouts]
                                                   [--index-html docs/tng50/index.html]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))

DEFAULT_SIMBA_ROOT = Path("/scratch/tsingh65/cgm_work/data/simba_gal")
DEFAULT_PUBLIC_ROOT = Path("/scratch/tsingh65/cgm_work/data/public_sims/cutouts")
DEFAULT_INDEX_HTML = ROOT / "docs" / "tng50" / "index.html"

PUBLIC_GIDS: tuple[str, ...] = (
    "agora_arepo_mw",
    "camels_tng_mw25",
    "camels_simba_mw30",
    "camels_astrid_mw26",
    "camels_eagle_mw27",
)


def _simba_sort_key(gid: str) -> tuple[int, int, str]:
    m = re.match(r"^simba(\d+)_g(\d+)$", gid)
    if m:
        return (int(m.group(1)), int(m.group(2)), gid)
    return (999, 999999, gid)


def build_entry(root: Path, gid: str, repo: str, default_sim: str) -> dict | None:
    gdir = root / gid
    rec_path = gdir / "record.json"
    if not rec_path.is_file():
        rec_path = gdir / "galaxy.json"
    cat_path = gdir / "web" / "catalog.json"
    viz_path = gdir / "viz" / "manifest_v2.json"
    if not (rec_path.is_file() and cat_path.is_file() and viz_path.is_file()):
        return None

    rec = json.loads(rec_path.read_text(encoding="utf-8"))
    cat = json.loads(cat_path.read_text(encoding="utf-8"))
    g_cat = cat.get("galaxy") or {}

    sim = str(rec.get("sim") or g_cat.get("sim") or default_sim)
    label = str(rec.get("label") or g_cat.get("label") or f"{sim} {gid}")
    mstar = float(rec.get("Mstar_Msun", g_cat.get("Mstar_Msun", 0.0)))
    sfr = float(rec.get("SFR_Msun_yr", g_cat.get("SFR_Msun_yr", 0.0)))
    m200c = float(rec.get("M200c_Msun", g_cat.get("M200c_Msun", 0.0)))
    r200c = float(rec.get("R200c_kpc", g_cat.get("R200c_kpc", 0.0)))
    central = bool(rec.get("central", g_cat.get("central", True)))
    is_mw = bool(rec.get("mw", g_cat.get("mw", False)))
    is_m31 = bool(rec.get("m31", g_cat.get("m31", False)))
    gas_poor = bool(rec.get("gas_poor", g_cat.get("gas_poor", False)))

    n_entries = len(cat.get("entries") or [])
    n_rays = n_entries if n_entries > 0 else 120

    return {
        "id": gid,
        "sim": sim,
        "label": label,
        "Mstar": round(mstar, 1),
        "SFR": round(sfr, 4),
        "M200c": round(m200c, 1),
        "R200c": round(r200c, 1),
        "central": central,
        "mw": is_mw,
        "m31": is_m31,
        "n": int(n_rays),
        "viz": True,
        "src": "trident",
        "gas_poor": gas_poor,
        "base": f"https://huggingface.co/datasets/{repo}/resolve/main/{gid}/",
    }


def collect_simba_entries(simba_root: Path, repo: str = "tanmay-starslab/simba-z0-web-0") -> list[dict]:
    if not simba_root.is_dir():
        return []
    gids = sorted(
        [p.name for p in simba_root.iterdir() if p.is_dir() and re.match(r"^simba\d+_g\d+$", p.name)],
        key=_simba_sort_key,
    )
    out = []
    for gid in gids:
        default_sim = "SIMBA-100" if gid.startswith("simba100_") else "SIMBA-25"
        e = build_entry(simba_root, gid, repo, default_sim)
        if e is not None:
            if e["sim"] == "SIMBA":
                e["sim"] = default_sim
            out.append(e)
    return out


def collect_public_entries(public_root: Path, repo: str = "tanmay-starslab/public-sims-web-0") -> list[dict]:
    if not public_root.is_dir():
        return []
    out = []
    for gid in PUBLIC_GIDS:
        e = build_entry(public_root, gid, repo, "CAMELS")
        if e is not None:
            out.append(e)
    return out


def inject_into_index_html(index_html: Path, new_entries: list[dict]) -> dict[str, int]:
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

    new_ids = {str(e["id"]) for e in new_entries}
    kept = [
        e for e in galaxies_cfg["list"]
        if str(e.get("id")) not in new_ids
        and not str(e.get("id", "")).startswith(("simba25_", "simba100_", "agora_", "camels_"))
    ]

    merged = kept + list(new_entries)
    galaxies_cfg["list"] = merged

    dumped = json.dumps(data, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")
    new_html = html[:start] + dumped + html[end:]
    if new_html != html:
        tmp = index_html.with_name(index_html.name + ".tmp")
        tmp.write_text(new_html, encoding="utf-8")
        tmp.replace(index_html)

    counts: dict[str, int] = {}
    for e in merged:
        s = str(e.get("sim") or "TNG50-1")
        counts[s] = counts.get(s, 0) + 1
    counts["total"] = len(merged)
    return counts


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--simba-root", type=Path, default=DEFAULT_SIMBA_ROOT)
    ap.add_argument("--public-root", type=Path, default=DEFAULT_PUBLIC_ROOT)
    ap.add_argument("--index-html", type=Path, default=DEFAULT_INDEX_HTML)
    ap.add_argument("--no-inject", action="store_true")
    args = ap.parse_args(argv)

    simba_entries = collect_simba_entries(args.simba_root)
    public_entries = collect_public_entries(args.public_root)
    all_new = simba_entries + public_entries
    print(f"Collected {len(simba_entries)} SIMBA entries and {len(public_entries)} AGORA/CAMELS entries ({len(all_new)} new total)")

    if not args.no_inject:
        counts = inject_into_index_html(args.index_html, all_new)
        print(f"Injected into {args.index_html}: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
