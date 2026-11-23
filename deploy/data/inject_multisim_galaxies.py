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
DEFAULT_AURIGA_ROOT = Path("/scratch/tsingh65/cgm_work/data/auriga/gal")
DEFAULT_TNG100_ROOT = Path("/scratch/tsingh65/cgm_work/data/tng100_z0")
DEFAULT_TNG300_ROOT = Path("/scratch/tsingh65/cgm_work/data/tng300_z0")
DEFAULT_ILLUSTRIS_ROOT = Path("/scratch/tsingh65/cgm_work/data/illustris1_z0")
DEFAULT_INDEX_HTML = ROOT / "docs" / "tng50" / "index.html"

PUBLIC_GIDS: tuple[str, ...] = (
    "agora_arepo_mw",
    # Quintet 1: Matched CAMELS CV_0 MW @ [4280, 29820, 22360] kpc
    "camels_tng_mw25",
    "camels_simba_mw30",
    "camels_astrid_mw26",
    "camels_eagle_mw27",
    "camels_crocodile_mw29",
    # Quintet 2: Matched CAMELS CV_0 MW @ [23167, 18895, 17007] kpc
    "camels_tng_mw95",
    "camels_simba_mw75",
    "camels_astrid_mw63",
    "camels_eagle_mw67",
    "camels_crocodile_mw60",
    # Quintet 3: Matched CAMELS CV_0 MW @ [14066, 11629, 6908] kpc
    "camels_tng_mw53",
    "camels_simba_mw63",
    "camels_astrid_mw46",
    "camels_eagle_mw56",
    "camels_crocodile_mw46",
    # Quintet 4: Matched CAMELS CV_0 MW @ [14494, 24861, 32956] kpc
    "camels_tng_mw41",
    "camels_simba_mw39",
    "camels_astrid_mw35",
    "camels_eagle_mw35",
    "camels_crocodile_mw36",
    # 28 CAMELS-GZ28 zoom-in halos (GZ28_0..GZ28_27)
    *[f"camels_gz28_{i}" for i in range(28)],
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

    spec_path = gdir / "SPECTRA"
    spec_txt = spec_path.read_text(encoding="utf-8").strip().lower() if spec_path.is_file() else ""
    cat_src = str((cat.get("spectra_source") or {}).get("source") or "").strip().lower()
    src = "sbi" if ((gdir / "DONE.thor_web").is_file() or spec_txt == "sbi" or cat_src == "sbi_cgm") else "trident"

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
        "src": src,
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


def _public_sort_key(gid: str) -> tuple[int, int, str]:
    if gid in PUBLIC_GIDS:
        return (0, PUBLIC_GIDS.index(gid), gid)
    m_gz = re.match(r"^camels_gz28_(\d+)$", gid)
    if m_gz:
        return (1, int(m_gz.group(1)), gid)
    return (2, 999999, gid)


def collect_public_entries(public_root: Path, repo: str = "tanmay-starslab/public-sims-web-0") -> list[dict]:
    if not public_root.is_dir():
        return []
    known = list(PUBLIC_GIDS)
    discovered = [
        p.name
        for p in public_root.iterdir()
        if p.is_dir() and not p.is_symlink() and p.name.startswith(("agora_", "camels_")) and p.name not in known
    ]
    gids = sorted(known + discovered, key=_public_sort_key)
    out = []
    for gid in gids:
        e = build_entry(public_root, gid, repo, "CAMELS")
        if e is not None:
            out.append(e)
    return out


def _auriga_sort_key(gid: str) -> tuple[int, int, str]:
    m_l4 = re.match(r"^Au(\d+)$", gid)
    if m_l4:
        return (0, int(m_l4.group(1)), gid)
    m_l3 = re.match(r"^Au(\d+)_L3$", gid)
    if m_l3:
        return (1, int(m_l3.group(1)), gid)
    m_low = re.match(r"^AuL(\d+)$", gid)
    if m_low:
        return (2, int(m_low.group(1)), gid)
    m_dw = re.match(r"^AuD(\d+)$", gid)
    if m_dw:
        return (3, int(m_dw.group(1)), gid)
    return (9, 999999, gid)


def collect_auriga_entries(auriga_root: Path, repo: str = "tanmay-starslab/auriga-z0-web-0") -> list[dict]:
    if not auriga_root.is_dir():
        return []
    gids = sorted(
        [
            p.name
            for p in auriga_root.iterdir()
            if p.is_dir() and not p.is_symlink() and re.match(r"^Au[A-Za-z0-9_]+$", p.name)
        ],
        key=_auriga_sort_key,
    )
    out = []
    for gid in gids:
        e = build_entry(auriga_root, gid, repo, "Auriga")
        if e is not None:
            e["sim"] = "Auriga"
            out.append(e)
    return out


def _sub_sort_key(gid: str) -> tuple[int, str]:
    m = re.search(r"_sub(\d+)$", gid)
    return (int(m.group(1)), gid) if m else (999999999, gid)


def collect_tng_illustris_entries(
    tng100_root: Path = DEFAULT_TNG100_ROOT,
    tng300_root: Path = DEFAULT_TNG300_ROOT,
    illustris_root: Path = DEFAULT_ILLUSTRIS_ROOT,
    repo: str = "tanmay-starslab/tng-illustris-z0-web-0",
) -> list[dict]:
    out = []
    for root, prefix, sim_name in (
        (tng100_root, "tng100_sub", "TNG100-1"),
        (tng300_root, "tng300_sub", "TNG300-1"),
        (illustris_root, "illustris1_sub", "Illustris-1"),
    ):
        if not root.is_dir():
            continue
        gids = sorted(
            [p.name for p in root.iterdir() if p.is_dir() and p.name.startswith(prefix) and (p / "DONE.web").is_file()],
            key=_sub_sort_key,
        )
        for gid in gids:
            e = build_entry(root, gid, repo, sim_name)
            if e is not None:
                e["sim"] = sim_name
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
    # Only strip existing entries for a simulation prefix if new_entries actually includes that prefix category;
    # that way running inject_multisim_galaxies.py when a source directory is absent or empty preserves existing entries!
    active_prefixes = tuple(
        pfx for pfx in (
            "simba25_", "simba100_", "agora_", "camels_",
            "Au", "auriga_", "tng100_", "tng300_", "illustris1_",
        )
        if any(nid.startswith(pfx) for nid in new_ids)
    )
    kept = [
        e for e in galaxies_cfg["list"]
        if str(e.get("id")) not in new_ids
        and not (active_prefixes and str(e.get("id", "")).startswith(active_prefixes))
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
    ap.add_argument("--auriga-root", type=Path, default=DEFAULT_AURIGA_ROOT)
    ap.add_argument("--tng100-root", type=Path, default=DEFAULT_TNG100_ROOT)
    ap.add_argument("--tng300-root", type=Path, default=DEFAULT_TNG300_ROOT)
    ap.add_argument("--illustris-root", type=Path, default=DEFAULT_ILLUSTRIS_ROOT)
    ap.add_argument("--index-html", type=Path, default=DEFAULT_INDEX_HTML)
    ap.add_argument("--no-inject", action="store_true")
    args = ap.parse_args(argv)

    simba_entries = collect_simba_entries(args.simba_root)
    public_entries = collect_public_entries(args.public_root)
    auriga_entries = collect_auriga_entries(args.auriga_root)
    tng_ill_entries = collect_tng_illustris_entries(args.tng100_root, args.tng300_root, args.illustris_root)
    all_new = simba_entries + public_entries + auriga_entries + tng_ill_entries
    print(
        f"Collected {len(simba_entries)} SIMBA, {len(public_entries)} AGORA/CAMELS, "
        f"{len(auriga_entries)} Auriga, and {len(tng_ill_entries)} TNG100/TNG300/Illustris-1 entries "
        f"({len(all_new)} new total)"
    )

    if not args.no_inject:
        counts = inject_into_index_html(args.index_html, all_new)
        print(f"Injected into {args.index_html}: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
