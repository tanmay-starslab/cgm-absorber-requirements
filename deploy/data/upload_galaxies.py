#!/usr/bin/env python3
"""Plan (default) or upload the multi-galaxy Hugging Face datasets of the TNG50 MW/M31 explorer.

  python deploy/data/upload_galaxies.py [--root DATA/gal] [--ids 1,2,...|--ids-file F] [--tier full|webp|nol2|lite|core]
         [--tier-file tiers.json] [--family pack|cutouts|all] [--index-out hosting_index.json] [--json plan.json]
  python deploy/data/upload_galaxies.py --measure-ref --ref-library LIB --ref-manifest viz/manifest_v2.json [--n 198]
  python deploy/data/upload_galaxies.py --verify-only [...]                # anonymous CORS / Range / sha256 checks
  python deploy/data/upload_galaxies.py --execute [...]                    # the ONLY mode that writes to the Hub

Without --execute nothing is uploaded and no token is read. Layout (docs/TNG50_OPERATIONS.md section 8):

  PUBLIC  tanmay-starslab/tng50-mwm31-web-<k>, k = subhalo_id % 4 (stable, independent of the galaxy list):
    README.md                               dataset card (generated)
    <id>/galaxy.json                        public fields only (no paths)
    <id>/catalog.json, <id>/components.json the sightline catalogue and Voigt components
    <id>/s/<sightline>.bin                  TNGS v2 web binaries (683 rays; all 12 ions in each file)
    <id>/viz/manifest_v2.json               tng50-viz/2 manifest, paths relative to <id>/viz/ (filtered per tier)
    <id>/viz/gas/<L>/<field>.<id12>.p<0-3>.webp|.u8.gz, <id>/viz/stars/<S>/gri.<id12>.p<0-3>.webp|.rgba.gz
    <id>/viz/luts/luts.json
  The page's per-galaxy base is https://huggingface.co/datasets/<repo>/resolve/main/<id>/ (written to --index-out).

  PRIVATE tanmay-starslab/tng50-mwm31-cutouts (one repo; the VM fetches one galaxy lazily with hf_hub_download):
    <id>/cutout_slim_R400.hdf5              slim cutout (r <= 400 kpc), the input of custom rays
    <id>/galaxy.json                        full record minus local paths (frame, centre, source sha256)
    trident/hm2012_ss_hr.h5                 the slim ion table (deploy/data/slim_iontable.py), once

Never uploaded: sightline npz (regenerable; 683 files and ~0.3 GB per galaxy), viz_cache, logs, *.ewah, config.tri,
yt.toml, tokens. A galaxy enters the plan only when DONE.web exists and check.json passes (--allow-unchecked to
plan it anyway; --execute refuses unchecked galaxies regardless).
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))

OWNER = "tanmay-starslab"
N_SHARDS = 4
PACK_REPO = OWNER + "/tng50-mwm31-web-{k}"
CUTOUT_REPO = OWNER + "/tng50-mwm31-cutouts"
REFERENCE_ID = 488530              # served by docs/tng50/data + tng50-sub488530-viz; in a shard only with --include-reference
ORIGIN = "https://tanmay-starslab.github.io"

# Hugging Face repository recommendations (https://huggingface.co/docs/hub/storage-limits, "Repository limitations
# and recommendations"): < 100k files per repo, < 10k entries per folder, < 200 GB per file (500 GB hard), commits of
# < 100 files. We plan to half the file budget: content-hashed cube names make a rebuild add files until --prune.
HF_FILES_PER_REPO = 100_000
FILES_PER_REPO_TARGET = 50_000
HF_ENTRIES_PER_FOLDER = 10_000
HF_FILE_MAX = 200e9
COMMIT_MAX = 100
FREE_PRIVATE_BYTES = 100e9         # free user/org private storage (same page, "Storage plans")

ALL_FIELDS = None                  # sentinel: every field of the manifest
TIERS = {
    #          gas/star levels kept                    gas fields kept                gz fallback hosted
    "full": {"levels": ("L0", "L1", "L2", "S0", "S1", "S2"), "fields": ALL_FIELDS, "gz": True},
    "webp": {"levels": ("L0", "L1", "L2", "S0", "S1", "S2"), "fields": ALL_FIELDS, "gz": False},
    "nol2": {"levels": ("L0", "L1", "S0", "S1"), "fields": ALL_FIELDS, "gz": True},
    "lite": {"levels": ("L0", "L1", "S0", "S1"), "fields": ALL_FIELDS, "gz": False},
    "core": {"levels": ("L0", "L1", "S0", "S1"),
             "fields": ("nH", "T", "Z", "HI", "MgII", "CIV", "OVI", "vx", "vy", "vz"), "gz": False},
}

_SID = r"(face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?"
_CUBE = (r"viz/(gas/L[012]/[A-Za-z0-9]+\.[0-9a-f]{12}\.(p[0-3]\.webp|u8\.gz)"
         r"|stars/S[012]/gri\.[0-9a-f]{12}\.(p[0-3]\.webp|rgba\.gz))")
PACK_RE = re.compile(rf"^(README\.md|\d+/(galaxy\.json|catalog\.json|components\.json|s/{_SID}\.bin"
                     rf"|viz/manifest_v2\.json|viz/luts/luts\.json|{_CUBE}))$")
CUTOUT_RE = re.compile(r"^(README\.md|trident/hm2012_ss_hr\.h5|\d+/(cutout_slim_R400\.hdf5|galaxy\.json))$")
HEAVY_RE = re.compile(rf"^\d+/({_CUBE}|s/.*\.bin|cutout_slim_R400\.hdf5)$|^trident/")   # committed before the JSONs
FORBIDDEN = re.compile(r"(^|/)(yt\.toml|config\.tri|\.env|token)$|\.(ewah|npy|npz|log)$|(^|/)\.")
PRIVATE_KEYS = {"path", "source_path", "cutout_path", "src", "file"}
ABS_PATH = re.compile(r"^(/(scratch|home|Users|Volumes|data|mnt|tmp|gpfs|packages)\b|[A-Za-z]:\\)")


def shard(gid: int) -> int:
    return int(gid) % N_SHARDS


def pack_repo(gid: int) -> str:
    return PACK_REPO.format(k=shard(gid))


def resolve_base(repo: str, gid: int) -> str:
    return f"https://huggingface.co/datasets/{repo}/resolve/main/{gid}/"


# ------------------------------------------------------------------------------------------------ privacy checks
def _pathlike(v) -> bool:
    """A string under a path-like key that names a file (absolute, or one token with a separator or extension).
    Prose under such a key (e.g. spectra_source.path = "+-2 R200c (half_kpc per sightline)") is not a path."""
    if not isinstance(v, str):
        return False
    if ABS_PATH.match(v):
        return True
    return not re.search(r"\s", v) and bool(re.search(r"[/\\]|\.[A-Za-z0-9]{1,6}$", v))


def private_leaks(obj, where="") -> list[str]:
    """Absolute local paths or path-like keys anywhere in a JSON value (they must never ship)."""
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k).lower() in PRIVATE_KEYS and _pathlike(v):
                out.append(f"{where}.{k}")
            else:
                out += private_leaks(v, f"{where}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj[:2000]):
            out += private_leaks(v, f"{where}[{i}]")
    elif isinstance(obj, str) and ABS_PATH.match(obj):
        out.append(where or "<root>")
    return out


def strip_private(obj):
    """Copy of a JSON value without path-like keys or absolute-path strings (the private galaxy.json)."""
    if isinstance(obj, dict):
        return {k: strip_private(v) for k, v in obj.items()
                if not (str(k).lower() in PRIVATE_KEYS and _pathlike(v))
                and not (isinstance(v, str) and ABS_PATH.match(v))}
    if isinstance(obj, list):
        return [strip_private(v) for v in obj if not (isinstance(v, str) and ABS_PATH.match(v))]
    return obj


def _json_bytes(obj) -> bytes:
    return (json.dumps(obj, indent=1, sort_keys=False) + "\n").encode("utf-8")


# ------------------------------------------------------------------------------------------------ manifests and tiers
def manifest_cubes(man: dict):
    """(kind, field|None, level, cube) for every cube of a tng50-viz/2 manifest."""
    for key, f in ((man.get("gas") or {}).get("fields") or {}).items():
        for lev, c in (f.get("cubes") or {}).items():
            yield "gas", key, lev, c
    for lev, c in ((man.get("stars") or {}).get("cubes") or {}).items():
        yield "stars", None, lev, c


def cube_files(cube: dict, gz: bool = True) -> list[tuple[str, int]]:
    out = [(p, int(b)) for p, b in zip(cube["webp"]["paths"], cube["webp"]["bytes"])]
    if gz:
        out.append((cube["gz"]["path"], int(cube["gz"]["bytes"])))
    return out


def filter_manifest(man: dict, tier: str) -> dict:
    """The manifest a tier publishes: dropped levels/fields removed everywhere; gz-less tiers set
    formats.gz.hosted = false (the page must then not fall back to .gz; see section 8 of the operations doc)."""
    t = TIERS[tier]
    keep = set(t["levels"])
    m = json.loads(json.dumps(man))
    m["levels"] = {L: v for L, v in m["levels"].items() if L in keep}
    gas = m.get("gas") or {}
    if "levels" in gas:
        gas["levels"] = [L for L in gas["levels"] if L in keep]
    fields = gas.get("fields") or {}
    for k in list(fields):
        if t["fields"] is not ALL_FIELDS and k not in t["fields"]:
            del fields[k]
            continue
        fields[k]["cubes"] = {L: c for L, c in fields[k]["cubes"].items() if L in keep}
    st = m.get("stars") or {}
    if "levels" in st:
        st["levels"] = [L for L in st["levels"] if L in keep]
    if "cubes" in st:
        st["cubes"] = {L: c for L, c in st["cubes"].items() if L in keep}
    if not t["gz"]:
        m.setdefault("formats", {}).setdefault("gz", {})["hosted"] = False
    return m


def validate_tier_manifest(m: dict) -> str | None:
    """None when tngsight.vizpack accepts the filtered manifest (structure only), else the reason."""
    try:
        from tngsight import vizpack
    except ImportError as exc:                       # pragma: no cover - tngsight is in this repo
        return f"vizpack not importable: {exc}"
    try:
        vizpack.validate_manifest_v2(m)
    except ValueError as exc:
        return str(exc)[:200]
    return None


# ------------------------------------------------------------------------------------------------ locating one galaxy
def _first(*paths: Path) -> Path | None:
    return next((p for p in paths if p.exists()), None)


def locate(gdir: Path) -> dict:
    """Where the web stage put this galaxy's products. Accepts <gdir>/web/{catalog.json,s/,viz/} (preferred) and
    falls back to <gdir>/library/{catalog.json,web/} + <gdir>/viz/."""
    web = gdir / "web"
    return {
        "galaxy": _first(web / "galaxy.json", gdir / "galaxy_public.json"),
        "galaxy_full": _first(gdir / "galaxy.json"),
        "catalog": _first(web / "catalog.json", gdir / "library" / "catalog.json"),
        "components": _first(web / "components.json", gdir / "library" / "components.json"),
        "bins": _first(web / "s", gdir / "library" / "web"),
        "viz": next((d for d in (web / "viz", gdir / "viz") if (d / "manifest_v2.json").is_file()), None),
        # the web stage writes only the (relative-path) manifest to web/viz; the cubes stay in <gdir>/viz
        "viz_dirs": [d for d in (web / "viz", gdir / "viz") if d.is_dir()],
        "cutout": _first(gdir / "cutout_slim_R400.hdf5"),
        "check": _first(gdir / "check.json", web / "check.json"),
        "done_web": (gdir / "DONE.web").is_file(),
    }


def check_status(loc: dict) -> tuple[bool, str]:
    if not loc["done_web"]:
        return False, "no DONE.web"
    if loc["check"] is None:
        return False, "no check.json"
    try:
        c = json.loads(loc["check"].read_text())
    except (OSError, ValueError) as exc:
        return False, f"check.json unreadable ({exc.__class__.__name__})"
    if isinstance(c, dict) and "pass" in c and isinstance(c["pass"], bool):
        return c["pass"], "check.json pass" if c["pass"] else "check.json: fail"
    gates = c.get("gates", c) if isinstance(c, dict) else {}
    bad = [k for k, v in gates.items() if (v is False) or (isinstance(v, dict) and v.get("pass") is False)]
    return (not bad), ("all gates pass" if not bad else "failed gates: " + ",".join(bad[:5]))


def plan_pack(gid: int, loc: dict, tier: str) -> dict:
    """{"items": [(path_in_repo, Path|bytes, size)], "problems": [...]} for one galaxy's public pack."""
    items, problems = [], []
    pre = f"{gid}/"
    for key, name in (("galaxy", "galaxy.json"), ("catalog", "catalog.json"), ("components", "components.json")):
        p = loc[key]
        if p is None:
            problems.append(f"missing {name}")
            continue
        try:
            obj = json.loads(p.read_text())
        except (OSError, ValueError) as exc:
            problems.append(f"{name} unreadable ({exc.__class__.__name__})")
            continue
        leaks = private_leaks(obj)
        if leaks:
            problems.append(f"{name} holds private paths/keys at {', '.join(leaks[:3])}")
            continue
        items.append((pre + name, p, p.stat().st_size))
    bins = sorted(loc["bins"].glob("*.bin")) if loc["bins"] else []
    if not bins:
        problems.append("no web binaries")
    for b in bins:
        items.append((pre + "s/" + b.name, b, b.stat().st_size))
    if loc["viz"] is None:
        problems.append("no viz/manifest_v2.json")
    else:
        man = json.loads((loc["viz"] / "manifest_v2.json").read_text())
        m = filter_manifest(man, tier)
        why = validate_tier_manifest(m)
        if why:
            problems.append(f"tier {tier} manifest invalid: {why}")
        gz = TIERS[tier]["gz"]
        for _, _, _, cube in manifest_cubes(m):
            for rel, n in cube_files(cube, gz):
                p = next((d / rel for d in loc.get("viz_dirs") or [loc["viz"]] if (d / rel).is_file()), loc["viz"] / rel)
                if not p.is_file():
                    problems.append(f"missing cube file viz/{rel}")
                elif p.stat().st_size != n:
                    problems.append(f"size mismatch viz/{rel}")
                else:
                    items.append((pre + "viz/" + rel, p, n))
        lut = next((d / "luts" / "luts.json" for d in loc.get("viz_dirs") or [loc["viz"]]
                    if (d / "luts" / "luts.json").is_file()), loc["viz"] / "luts" / "luts.json")
        if lut.is_file():
            items.append((pre + "viz/luts/luts.json", lut, lut.stat().st_size))
        mb = _json_bytes(m) if m != man else (loc["viz"] / "manifest_v2.json").read_bytes()
        items.append((pre + "viz/manifest_v2.json", mb, len(mb)))
    for rel, _, _ in items:
        if not PACK_RE.fullmatch(rel) or FORBIDDEN.search(rel):
            problems.append(f"off allow-list: {rel}")
    return {"items": items, "problems": problems}


def plan_cutout(gid: int, loc: dict) -> dict:
    items, problems = [], []
    if loc["cutout"] is None:
        problems.append("no cutout_slim_R400.hdf5")
    else:
        items.append((f"{gid}/cutout_slim_R400.hdf5", loc["cutout"], loc["cutout"].stat().st_size))
    if loc["galaxy_full"] is not None:
        g = _json_bytes(strip_private(json.loads(loc["galaxy_full"].read_text())))
        items.append((f"{gid}/galaxy.json", g, len(g)))
    else:
        problems.append("no galaxy.json")
    return {"items": items, "problems": problems}


# ------------------------------------------------------------------------------------------------ repo-level checks
def repo_checks(items: list[tuple[str, object, int]]) -> dict:
    folders = Counter(rel.rsplit("/", 1)[0] if "/" in rel else "." for rel, _, _ in items)
    biggest = max((n for _, _, n in items), default=0)
    n = len(items)
    warn = []
    if n >= HF_FILES_PER_REPO:
        warn.append(f"ERROR {n} files >= HF recommendation {HF_FILES_PER_REPO}")
    elif n > FILES_PER_REPO_TARGET:
        warn.append(f"{n} files > planning target {FILES_PER_REPO_TARGET} (rebuild headroom)")
    f, c = folders.most_common(1)[0] if folders else (".", 0)
    if c >= HF_ENTRIES_PER_FOLDER:
        warn.append(f"ERROR folder {f} has {c} entries >= {HF_ENTRIES_PER_FOLDER}")
    if biggest >= HF_FILE_MAX:
        warn.append(f"ERROR a file of {biggest / 1e9:.1f} GB >= {HF_FILE_MAX / 1e9:.0f} GB")
    return {"files": n, "bytes": sum(s for _, _, s in items), "largest_file": biggest,
            "largest_folder": [f, c], "commits": math.ceil(n / COMMIT_MAX), "warnings": warn}


def dataset_card(repo: str, gids: list[int], kind: str, total: int) -> bytes:
    if kind == "pack":
        body = (f"# TNG50 MW/M31 CGM explorer: web pack shard {repo.rsplit('-', 1)[-1]}\n\n"
                "Synthetic CGM absorption spectra (683 sightlines, 12 ions, TNGS v2 binaries), Voigt components and 3D "
                "gas/star cubes (tng50-viz/2) for TNG50-1 z = 0 Milky Way / M31 analogues (Pillepich et al. 2024), "
                "read by the explorer page at https://tanmay-starslab.github.io/cgm-absorber-requirements/tng50/.\n\n"
                f"Galaxies here: subhalo_id % {N_SHARDS} == {repo.rsplit('-', 1)[-1]} ({len(gids)} galaxies, "
                f"{total / 1e9:.1f} GB). One folder per subhalo id: galaxy.json, catalog.json, components.json, "
                "s/<sightline>.bin, viz/manifest_v2.json and the cubes it lists.\n\n"
                "Derived from IllustrisTNG public data (Nelson et al. 2019; Pillepich et al. 2018, 2024). "
                "Code: https://github.com/tanmay-starslab/cgm-absorber-requirements (MIT).\n")
        meta = "---\nlicense: cc-by-4.0\npretty_name: TNG50 MW/M31 CGM explorer web pack\n---\n"
    else:
        body = ("# TNG50 MW/M31 slim cutouts (private)\n\nGas within 400 kpc of each host (the fields the sightline "
                "generator reads) plus the slim Trident ion table; the explorer backend downloads one galaxy on demand "
                f"for custom sightlines. {len(gids)} galaxies, {total / 1e9:.1f} GB.\n")
        meta = "---\nlicense: other\n---\n"
    return (meta + "\n" + body).encode("utf-8")


# ------------------------------------------------------------------------------------------------ reference measurement
def measure_reference(lib: Path, manifest: Path, n: int) -> dict:
    """Per-galaxy files/bytes of each tier, measured on the shipped 488530 products, and the sample totals."""
    man = json.loads(manifest.read_text())
    bins = sorted((lib / "web").glob("*.bin")) or sorted((lib / "s").glob("*.bin"))
    jsons = [lib / "catalog.json", lib / "components.json"]
    spec_files = len(bins) + len(jsons) + 1                                   # + galaxy.json
    spec_bytes = sum(p.stat().st_size for p in bins + jsons if p.is_file()) + 2_000
    out = {"reference": {"bins": len(bins), "spectra_bytes": spec_bytes}, "tiers": {}}
    per_group = defaultdict(lambda: [0, 0, 0])                                # webp bytes, gz bytes, cubes
    for kind, key, lev, cube in manifest_cubes(man):
        grp = "stars" if kind == "stars" else ("vel" if key in ("vx", "vy", "vz") else
                                               "phys" if key in ("nH", "T", "Z") else "ion")
        g = per_group[(lev, grp)]
        g[0] += sum(int(b) for b in cube["webp"]["bytes"])
        g[1] += int(cube["gz"]["bytes"])
        g[2] += 1
    out["reference"]["cube_groups"] = {f"{L}/{grp}": {"cubes": v[2], "webp_MB": round(v[0] / 1e6, 1),
                                                      "gz_MB": round(v[1] / 1e6, 1)}
                                       for (L, grp), v in sorted(per_group.items())}
    for tier in TIERS:
        m = filter_manifest(man, tier)
        cubes = list(manifest_cubes(m))
        files = [f for _, _, _, c in cubes for f in cube_files(c, TIERS[tier]["gz"])]
        mb = len(_json_bytes(m))
        nf = spec_files + len(files) + 2                                      # + manifest + luts
        nb = spec_bytes + sum(b for _, b in files) + mb + 12_006
        per_shard = math.ceil(n / N_SHARDS * 1.15)                            # id % 4 is uneven: 40-56 of 198
        out["tiers"][tier] = {"cubes": len(cubes), "files_per_galaxy": nf, "bytes_per_galaxy": nb,
                              "sample_files": nf * n, "sample_bytes": nb * n,
                              "files_per_shard_max": nf * per_shard, "bytes_per_shard_max": nb * per_shard,
                              "manifest_ok": validate_tier_manifest(m) is None}
    return out


def print_measure(res: dict, n: int, log=print) -> None:
    r = res["reference"]
    log(f"reference 488530: {r['bins']} web binaries, spectra pack {r['spectra_bytes'] / 1e6:.1f} MB")
    for k, v in r["cube_groups"].items():
        log(f"  {k:10s} {v['cubes']:3d} cubes  webp {v['webp_MB']:7.1f} MB  gz {v['gz_MB']:7.1f} MB")
    log(f"{'tier':6s} {'cubes':>5s} {'files/gal':>9s} {'MB/gal':>8s} {'files×' + str(n):>12s} {'GB×' + str(n):>9s} "
        f"{'max files/shard':>15s} {'max GB/shard':>12s} manifest")
    for t, v in res["tiers"].items():
        log(f"{t:6s} {v['cubes']:5d} {v['files_per_galaxy']:9d} {v['bytes_per_galaxy'] / 1e6:8.1f} "
            f"{v['sample_files']:12,d} {v['sample_bytes'] / 1e9:9.1f} {v['files_per_shard_max']:15,d} "
            f"{v['bytes_per_shard_max'] / 1e9:12.1f} {'ok' if v['manifest_ok'] else 'INVALID'}")


# ------------------------------------------------------------------------------------------------ upload (--execute)
def _viz_helpers():
    spec = importlib.util.spec_from_file_location("upload_viz_dataset", Path(__file__).with_name("upload_viz_dataset.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _sha256(src) -> str:
    if isinstance(src, bytes):
        return hashlib.sha256(src).hexdigest()
    h = hashlib.sha256()
    with open(src, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def _git_blob(src) -> str:
    data = src if isinstance(src, bytes) else Path(src).read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def upload_repo(api, repo: str, items, private: bool, message: str, allow: re.Pattern, log=print) -> int:
    """create_repo -> skip remote-identical files -> heavy files first, JSON last, commits of <= COMMIT_MAX files."""
    from huggingface_hub import CommitOperationAdd
    V = _viz_helpers()
    V._call(api.create_repo, repo, repo_type="dataset", private=private, exist_ok=True)
    remote = V.remote_index(api, repo)
    todo = []
    for rel, src, size in items:
        if not allow.fullmatch(rel) or FORBIDDEN.search(rel):
            raise ValueError(f"refusing to upload {rel}: not on the allow-list")
        r = remote.get(rel)
        if r is not None and r.get("size") == size and (
                (r.get("sha256") and r["sha256"] == _sha256(src)) or
                (not r.get("sha256") and r.get("blob_id") == _git_blob(src))):
            continue
        todo.append((rel, src))
    log(f"{repo}: {len(items) - len(todo)} files up to date, {len(todo)} to upload")
    # cubes, binaries and cutouts first, then galaxy/catalog/manifest JSON, README last: a page never reads a
    # manifest or catalogue whose files are not there yet
    todo.sort(key=lambda t: (0 if HEAVY_RE.match(t[0]) else 2 if t[0] == "README.md" else 1, t[0]))
    for i in range(0, len(todo), COMMIT_MAX):
        chunk = todo[i:i + COMMIT_MAX]
        ops = [CommitOperationAdd(path_in_repo=r, path_or_fileobj=s if isinstance(s, bytes) else str(s))
               for r, s in chunk]
        V._call(api.create_commit, repo, ops, repo_type="dataset",
                commit_message=f"{message} ({i + 1}-{i + len(chunk)} of {len(todo)})")
        log(f"  commit {i + 1}-{i + len(chunk)} of {len(todo)}")
    return len(todo)


def verify_pack(repo: str, gid: int, items, log=print) -> bool:
    """Anonymous checks with the page's Origin: catalog.json, one binary, the manifest, one WebP part."""
    V = _viz_helpers()
    picks = [r for r, _, _ in items if r.endswith("/catalog.json") or r.endswith("/viz/manifest_v2.json")]
    picks += [next((r for r, _, _ in items if r.endswith(".bin")), None),
              next((r for r, _, _ in items if r.endswith(".p0.webp")), None)]
    srcs = {r: s for r, s, _ in items}
    rows = []
    for rel in filter(None, picks):
        url = f"https://huggingface.co/datasets/{repo}/resolve/main/{rel}"
        row = V.check_url(url, _sha256(srcs[rel]))
        row["path"] = rel
        rows.append(row)
    V.print_table(rows, log)
    return all(r["ok"] for r in rows)


# ------------------------------------------------------------------------------------------------ main
def galaxy_ids(a, root: Path) -> list[int]:
    if a.ids:
        ids = [int(x) for x in a.ids.split(",") if x.strip()]
    elif a.ids_file:
        txt = a.ids_file.read_text()
        ids = [int(x) for x in re.findall(r"\d+", txt)]
    else:
        ids = sorted(int(p.name) for p in root.iterdir() if p.is_dir() and p.name.isdigit()) if root.is_dir() else []
    if not a.include_reference:
        ids = [i for i in ids if i != REFERENCE_ID]
    return sorted(set(ids))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    try:
        from tngsight.config import work_root
        default_root = work_root() / "data" / "gal"
        default_table = work_root() / "data" / "trident_slim_v3" / "hm2012_ss_hr.h5"
    except Exception:                                                     # noqa: BLE001
        default_root, default_table = Path("data/gal"), Path("data/trident_slim_v3/hm2012_ss_hr.h5")
    ap.add_argument("--root", type=Path, default=default_root, help="data root holding <id>/ (default $TNG_WORK/data/gal)")
    ap.add_argument("--ids", help="comma-separated subhalo ids (default: every <id>/ under --root)")
    ap.add_argument("--ids-file", type=Path, help="file listing subhalo ids")
    ap.add_argument("--include-reference", action="store_true", help=f"also pack {REFERENCE_ID} into its shard")
    ap.add_argument("--family", choices=("pack", "cutouts", "all"), default="pack")
    ap.add_argument("--tier", choices=tuple(TIERS), default="full", help="default tier of every galaxy")
    ap.add_argument("--tier-file", type=Path, help='JSON {"<id>": "<tier>", ...} overriding --tier per galaxy')
    ap.add_argument("--ion-table", type=Path, default=default_table, help="slim ion table for the private repo")
    ap.add_argument("--allow-unchecked", action="store_true", help="plan galaxies without DONE.web / passing check.json")
    ap.add_argument("--index-out", type=Path, help="write {id: {repo, base, tier, files, bytes}} for the page export")
    ap.add_argument("--json", type=Path, help="write the full plan / measurement as JSON")
    ap.add_argument("--measure-ref", action="store_true", help="measure tiers on the shipped 488530 products")
    ap.add_argument("--ref-library", type=Path, help="488530 library dir (web/*.bin, catalog.json, components.json)")
    ap.add_argument("--ref-manifest", type=Path, help="488530 viz manifest_v2.json (with vx/vy/vz)")
    ap.add_argument("--n", type=int, default=198, help="sample size for --measure-ref totals")
    ap.add_argument("--verify-only", action="store_true", help="anonymous CORS/Range/sha checks of planned packs")
    ap.add_argument("--execute", action="store_true", help="upload (needs a write token); default is a dry run")
    ap.add_argument("--token-file", type=Path, default=None)
    ap.add_argument("--message", default="Update TNG50 MW/M31 galaxy packs")
    a = ap.parse_args(argv)

    if a.measure_ref:
        if not (a.ref_library and a.ref_manifest):
            ap.error("--measure-ref needs --ref-library and --ref-manifest")
        res = measure_reference(a.ref_library, a.ref_manifest, a.n)
        print_measure(res, a.n)
        if a.json:
            a.json.write_text(json.dumps(res, indent=1) + "\n")
        return 0

    tiers = json.loads(a.tier_file.read_text()) if a.tier_file else {}
    bad = sorted(set(tiers.values()) - set(TIERS))
    if bad:
        ap.error(f"unknown tiers in --tier-file: {bad}")
    ids = galaxy_ids(a, a.root)
    if not ids:
        print(f"no galaxies under {a.root} (nothing built yet?); use --measure-ref for the sizing table")
        return 0
    repos: dict[str, dict] = defaultdict(lambda: {"gids": [], "items": [], "private": False})
    index, skipped, problems = {}, {}, {}
    for gid in ids:
        loc = locate(a.root / str(gid))
        ok, why = check_status(loc)
        if not ok and not a.allow_unchecked:
            skipped[gid] = why
            continue
        tier = tiers.get(str(gid), a.tier)
        if a.family in ("pack", "all"):
            p = plan_pack(gid, loc, tier)
            if p["problems"]:
                problems[gid] = p["problems"]
            else:
                repo = pack_repo(gid)
                repos[repo]["gids"].append(gid)
                repos[repo]["items"] += p["items"]
                index[str(gid)] = {"repo": repo, "base": resolve_base(repo, gid), "tier": tier, "checked": ok,
                                   "files": len(p["items"]), "bytes": sum(s for _, _, s in p["items"])}
        if a.family in ("cutouts", "all"):
            c = plan_cutout(gid, loc)
            if c["problems"]:
                problems.setdefault(gid, []).extend(c["problems"])
            else:
                repos[CUTOUT_REPO]["gids"].append(gid)
                repos[CUTOUT_REPO]["items"] += c["items"]
                repos[CUTOUT_REPO]["private"] = True
    if CUTOUT_REPO in repos and a.ion_table.is_file():
        repos[CUTOUT_REPO]["items"].append(("trident/hm2012_ss_hr.h5", a.ion_table, a.ion_table.stat().st_size))
    for repo, r in repos.items():
        total = sum(s for _, _, s in r["items"])
        card = dataset_card(repo, r["gids"], "cutouts" if r["private"] else "pack", total)
        r["items"].append(("README.md", card, len(card)))
        r["checks"] = repo_checks(r["items"])

    print(f"{'repo':42s} {'vis':4s} {'gal':>4s} {'files':>8s} {'GB':>7s} {'commits':>7s} largest-folder")
    for repo in sorted(repos):
        r, c = repos[repo], repos[repo]["checks"]
        print(f"{repo:42s} {'priv' if r['private'] else 'pub':4s} {len(r['gids']):4d} {c['files']:8,d} "
              f"{c['bytes'] / 1e9:7.2f} {c['commits']:7d} {c['largest_folder'][0]}={c['largest_folder'][1]}")
        for w in c["warnings"]:
            print(f"   ! {w}")
    priv = sum(r["checks"]["bytes"] for r in repos.values() if r["private"])
    pub = sum(r["checks"]["bytes"] for r in repos.values() if not r["private"])
    print(f"public {pub / 1e9:.1f} GB, private {priv / 1e9:.1f} GB"
          + (f"  (! private > free {FREE_PRIVATE_BYTES / 1e9:.0f} GB quota)" if priv > FREE_PRIVATE_BYTES else ""))
    for gid, why in skipped.items():
        print(f"skip {gid}: {why}")
    for gid, ps in problems.items():
        print(f"PROBLEM {gid}: " + "; ".join(ps[:4]) + (f" (+{len(ps) - 4})" if len(ps) > 4 else ""))
    if a.index_out:
        a.index_out.write_text(json.dumps({"schema": "tng50-galaxy-hosting/1", "shards": N_SHARDS,
                                           "galaxies": index}, indent=1) + "\n")
    if a.json:
        a.json.write_text(json.dumps({"repos": {k: {"gids": v["gids"], "private": v["private"], **v["checks"]}
                                                for k, v in repos.items()},
                                      "skipped": {str(k): v for k, v in skipped.items()},
                                      "problems": {str(k): v for k, v in problems.items()}, "index": index},
                                     indent=1) + "\n")
    errors = any(w.startswith("ERROR") for r in repos.values() for w in r["checks"]["warnings"])

    if a.verify_only:
        good = True
        for repo, r in sorted(repos.items()):
            if r["private"]:
                continue
            for gid in r["gids"]:
                its = [t for t in r["items"] if t[0].startswith(f"{gid}/")]
                good &= verify_pack(repo, gid, its)
        return 0 if good else 1
    if not a.execute:
        print("dry run: nothing uploaded (pass --execute to upload)")
        return 1 if (errors or problems) else 0
    if errors or problems or (skipped and a.allow_unchecked):
        print("refusing --execute: fix the ERROR/PROBLEM lines (and never upload unchecked galaxies)", file=sys.stderr)
        return 2
    if any(not v["checked"] for v in index.values()):
        print("refusing --execute: unchecked galaxies in the plan", file=sys.stderr)
        return 2
    try:
        from huggingface_hub import HfApi
        V = _viz_helpers()
        api = HfApi(token=V.read_token(a.token_file))
        for repo in sorted(repos, key=lambda k: (repos[k]["private"], k)):
            r = repos[repo]
            upload_repo(api, repo, r["items"], r["private"], a.message, CUTOUT_RE if r["private"] else PACK_RE)
        ok = all(verify_pack(repo, gid, [t for t in r["items"] if t[0].startswith(f"{gid}/")])
                 for repo, r in repos.items() if not r["private"] for gid in r["gids"][:1])
        return 0 if ok else 1
    except (RuntimeError, ValueError, ImportError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
