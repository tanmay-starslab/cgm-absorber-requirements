#!/usr/bin/env python3
"""Publish the 3D visualisation cubes to the PUBLIC Hugging Face dataset the explorer page loads them from.

    python deploy/data/upload_viz_dataset.py [--viz DIR] [--repo tanmay-starslab/tng50-sub488530-viz]
                                             [--token-file PATH] [--dry-run] [--verify-only] [--prune --yes]

The dataset holds ONLY derived visualisation products (design-2b §6.1):
  README.md                 dataset card, rendered from deploy/data/viz_dataset_card.md with sizes filled in
  manifest_v2.json          schema tng50-viz/2 (tngsight.vizpack); validated, with every file's size + sha256
  luts/luts.json            the page's colour maps
  gas/<L>/<field>.<id12>.p<0-3>.webp | .u8.gz,  stars/<S>/gri.<id12>.p<0-3>.webp | .rgba.gz
  previews/<name>.png       optional screenshots (<= 1 MB each)
Anything else under --viz (fragment manifests, caches, dotfiles, yt.toml, config.tri, *.ewah, *.npy, *.hdf5, ...)
is refused and never uploaded. Files whose remote LFS sha256 (or git blob id) already matches are skipped; the
rest go in commits of <= 100 files. Remote files are never deleted unless --prune --yes.

The write token comes from $HF_TOKEN, else --token-file (default $HF_HOME/token). It is never printed, logged or
put into an exception message. --verify (after an upload) and --verify-only fetch anonymously, with
Origin: https://tanmay-starslab.github.io, the manifest, one WebP part and one gz per kind, and check status,
CORS (on the 302 and on the final response), Content-Encoding, sha256 and a Range request.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(1, str(ROOT))

REPO = "tanmay-starslab/tng50-sub488530-viz"
HF_HOME = os.environ.get("HF_HOME", "/Volumes/cgm_work/cache/hf")
DEFAULT_TOKEN_FILE = Path(HF_HOME) / "token"
DEFAULT_VIZ = Path(os.environ.get("TNG_LIBRARY_DIR", "/Volumes/cgm_work/data/library")) / "viz"
CARD = ROOT / "deploy" / "data" / "viz_dataset_card.md"
ORIGIN = "https://tanmay-starslab.github.io"
PAGE_URL = "https://tanmay-starslab.github.io/cgm-absorber-requirements/tng50/"
COMMIT_MAX = 100
PREVIEW_MAX = 1_000_000
from tngsight import ions as _ions  # noqa: E402  (the gas fields are nH, T, Z plus every registry ion)
_GAS = "|".join(["nH", "T", "Z"] + [re.escape(k) for k in _ions.KEYS])
ALLOW_RE = re.compile(
    r"^(README\.md|manifest_v2\.json|luts/luts\.json|previews/[a-z0-9_]+\.png"
    rf"|gas/L[012]/({_GAS})\.[0-9a-f]{{12}}\.(p[0-3]\.webp|u8\.gz)"
    r"|stars/S[012]/gri\.[0-9a-f]{12}\.(p[0-3]\.webp|rgba\.gz))$")
CUBE_RE = re.compile(r"^(gas|stars)/")       # ALLOW_RE is applied with fullmatch: "$" alone would accept a trailing "\n"


def resolve_url(repo: str, path: str) -> str:
    return f"https://huggingface.co/datasets/{repo}/resolve/main/{path}"


# ---------------------------------------------------------------------------------------------------- plan
def manifest_cubes(man: dict):
    """Yield (kind, key, level, CUBE) for every cube in a manifest_v2 dict."""
    for key, f in (man.get("gas") or {}).get("fields", {}).items():
        for lev, cube in (f.get("cubes") or {}).items():
            yield "gas", key, lev, cube
    for lev, cube in ((man.get("stars") or {}).get("cubes") or {}).items():
        yield "stars", None, lev, cube


def cube_files(cube: dict) -> list[tuple[str, int, str]]:
    """[(path, bytes, sha256)] of one CUBE entry: 4 WebP parts + the gz."""
    w = cube["webp"]
    out = [(p, int(b), s) for p, b, s in zip(w["paths"], w["bytes"], w["sha256"])]
    out.append((cube["gz"]["path"], int(cube["gz"]["bytes"]), cube["gz"]["sha256"]))
    return out


def validate(man: dict, viz: Path) -> None:
    from tngsight import vizpack                       # CORE (design-2b §3.2); raises ImportError if absent
    vizpack.validate_manifest_v2(man, base_dir=viz)


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def git_blob_id(b: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(b) + b).hexdigest()


def render_card(man: dict | None, files: list[tuple[str, int]], card: Path = CARD) -> str:
    """The dataset card with {{STATUS}} and {{SIZES}} filled in from the manifest and the upload plan."""
    text = card.read_text(encoding="utf-8")
    if man is None:
        status = ("> **Status:** the dataset is being set up. The cubes and `manifest_v2.json` have not been "
                  "uploaded yet.")
        sizes = ""
    else:
        status = (f"> **Status:** {sum(1 for _ in manifest_cubes(man))} cubes, manifest created "
                  f"{man.get('created', '?')}.")
        groups: dict[str, list[int]] = {}
        for p, n in files:
            m = re.match(r"^(gas|stars)/([LS][012])/[^.]+\.[0-9a-f]{12}\.(p[0-3]\.webp|u8\.gz|rgba\.gz)$", p)
            if not m:
                continue
            g = groups.setdefault(f"{m.group(1)} {m.group(2)}", [0, 0, 0])
            if m.group(3).endswith(".webp"):
                g[0] += n
                g[2] += 1
            else:
                g[1] += n
        rows = ["| kind / level | cubes | WebP MB | gz MB |", "|---|---|---|---|"]
        tw = tg = 0
        for k in sorted(groups):
            w, gz, nparts = groups[k]
            tw, tg = tw + w, tg + gz
            rows.append(f"| {k} | {nparts // 4} | {w / 1e6:.1f} | {gz / 1e6:.1f} |")
        rows.append(f"| **total** | {sum(v[2] for v in groups.values()) // 4} | **{tw / 1e6:.1f}** | **{tg / 1e6:.1f}** |")
        sizes = "## Sizes\n\nA page visitor downloads only the WebP parts of the levels the current view needs.\n\n" \
                + "\n".join(rows)
    return text.replace("{{STATUS}}", status).replace("{{SIZES}}", sizes)


def plan(viz: Path, card: Path = CARD) -> dict:
    """-> {"items": [(path_in_repo, bytes_or_Path)], "refused": [rel], "reasons": {rel: why}, "manifest": dict,
    "total": int}. `refused` is every local file left out; `reasons` says why: off the allow-list, not referenced
    by manifest_v2.json (an older build of a cube), or a preview over the size limit.
    Raises ValueError when the manifest is missing/invalid or a manifest-listed file is off the allow-list."""
    man_p = viz / "manifest_v2.json"
    if not man_p.is_file():
        raise ValueError(f"{man_p} not found: run `python -m tngsight.vizpack merge {viz}` first")
    man = json.loads(man_p.read_text())
    validate(man, viz)
    wanted: dict[str, Path] = {"manifest_v2.json": man_p}
    for kind, key, lev, cube in manifest_cubes(man):
        for p, _, _ in cube_files(cube):
            wanted[p] = viz / p
    if (viz / "luts" / "luts.json").is_file():
        wanted["luts/luts.json"] = viz / "luts" / "luts.json"
    for p in sorted((viz / "previews").glob("*.png")) if (viz / "previews").is_dir() else []:
        rel = p.relative_to(viz).as_posix()
        if ALLOW_RE.fullmatch(rel) and p.stat().st_size <= PREVIEW_MAX:
            wanted[rel] = p
    for rel in wanted:
        if not ALLOW_RE.fullmatch(rel):
            raise ValueError(f"refusing to upload {rel}: not on the allow-list")
    refused = sorted(p.relative_to(viz).as_posix() for p in viz.rglob("*")
                     if p.is_file() and p.relative_to(viz).as_posix() not in wanted)
    reasons = {}
    for rel in refused:
        if not ALLOW_RE.fullmatch(rel):
            reasons[rel] = "off the allow-list"
        elif rel.startswith("previews/"):
            reasons[rel] = f"preview over {PREVIEW_MAX // 1_000_000} MB"
        else:
            reasons[rel] = "not referenced by manifest_v2.json"
    files = [(rel, p.stat().st_size) for rel, p in wanted.items()]
    readme = render_card(man, files, card).encode("utf-8")
    items: list[tuple[str, object]] = [("README.md", readme)] + sorted(wanted.items())
    total = len(readme) + sum(n for _, n in files)
    return {"items": items, "refused": refused, "reasons": reasons, "manifest": man, "total": total}


def _payload(src) -> bytes:
    return src if isinstance(src, bytes) else Path(src).read_bytes()


# ---------------------------------------------------------------------------------------------------- token / api
def read_token(token_file: Path | None) -> str:
    tok = os.environ.get("HF_TOKEN", "").strip()
    if not tok:
        p = token_file or DEFAULT_TOKEN_FILE
        try:
            tok = Path(p).read_text().strip()
        except OSError:
            raise RuntimeError(f"no token: HF_TOKEN unset and {p} unreadable") from None
    if not tok:
        raise RuntimeError("no token: empty token file")
    return tok


def _hf_error(exc: Exception) -> RuntimeError:
    """Reduce a huggingface_hub/httpx error to 'HF <status>: <short reason>' (no headers, no token)."""
    resp = getattr(exc, "response", None)
    status = getattr(resp, "status_code", None) or "error"
    reason = getattr(resp, "reason_phrase", None) or getattr(resp, "reason", None) or type(exc).__name__
    return RuntimeError(f"HF {status}: {str(reason)[:80]}")


def _call(fn, *args, **kw):
    try:
        return fn(*args, **kw)
    except Exception as exc:                               # noqa: BLE001 - every HF error is reduced, never echoed
        raise _hf_error(exc) from None


def remote_index(api, repo: str) -> dict[str, dict]:
    """{path: {"size", "sha256" (LFS) or None, "blob_id"}} of the remote tree; {} for an empty repo."""
    out = {}
    for f in _call(lambda: list(api.list_repo_tree(repo, repo_type="dataset", recursive=True, expand=True))):
        if not hasattr(f, "size") or f.__class__.__name__ == "RepoFolder":
            continue
        lfs = getattr(f, "lfs", None)
        sha = getattr(lfs, "sha256", None) if lfs is not None else None
        if sha is None and isinstance(lfs, dict):
            sha = lfs.get("sha256")
        out[f.path] = {"size": getattr(f, "size", None), "sha256": sha, "blob_id": getattr(f, "blob_id", None)}
    return out


def needs_upload(rel: str, data: bytes, remote: dict) -> bool:
    r = remote.get(rel)
    if r is None:
        return True
    if r.get("sha256"):
        return r["sha256"] != sha256_bytes(data)
    return r.get("blob_id") != git_blob_id(data)


def upload(api, repo: str, items, message: str, log=print) -> int:
    """create_repo(public) → skip files already identical remotely → commits of <= COMMIT_MAX files. -> n uploaded."""
    from huggingface_hub import CommitOperationAdd
    _call(api.create_repo, repo, repo_type="dataset", private=False, exist_ok=True)
    remote = remote_index(api, repo)
    todo = []
    for rel, src in items:
        if not ALLOW_RE.fullmatch(rel):
            raise ValueError(f"refusing to upload {rel}: not on the allow-list")
        data = _payload(src)
        if needs_upload(rel, data, remote):
            todo.append((rel, data))
    log(f"{len(items) - len(todo)} files already up to date, {len(todo)} to upload "
        f"({sum(len(d) for _, d in todo) / 1e6:.1f} MB)")
    # cubes first, then manifest/README/luts: a page never sees a manifest whose cubes are not there yet
    todo.sort(key=lambda t: (0 if CUBE_RE.match(t[0]) else 1, t[0]))
    for i in range(0, len(todo), COMMIT_MAX):
        chunk = todo[i:i + COMMIT_MAX]
        ops = [CommitOperationAdd(path_in_repo=r, path_or_fileobj=d) for r, d in chunk]
        log(f"commit {i + 1}-{i + len(chunk)} of {len(todo)}")
        _call(api.create_commit, repo, ops, repo_type="dataset",
              commit_message=f"{message} ({i + 1}-{i + len(chunk)} of {len(todo)})")
    return len(todo)


def stale_remote(remote: dict, items) -> list[str]:
    """Remote cube files not referenced by the local plan (candidates for --prune)."""
    keep = {rel for rel, _ in items}
    return sorted(p for p in remote if CUBE_RE.match(p) and p not in keep)


def prune(api, repo: str, paths: list[str], log=print) -> None:
    from huggingface_hub import CommitOperationDelete
    for i in range(0, len(paths), COMMIT_MAX):
        ops = [CommitOperationDelete(path_in_repo=p) for p in paths[i:i + COMMIT_MAX]]
        _call(api.create_commit, repo, ops, repo_type="dataset", commit_message=f"prune {len(ops)} stale cube files")
        log(f"deleted {len(ops)} remote files")


# ---------------------------------------------------------------------------------------------------- verify
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


def fetch_chain(url: str, origin: str = ORIGIN, rng: str | None = None, max_hops: int = 5, timeout: float = 60):
    """Anonymous GET following redirects by hand. -> [(status, headers{lower: value}, body or None)] per hop."""
    opener = urllib.request.build_opener(_NoRedirect)
    hops = []
    for _ in range(max_hops):
        hdr = {"Origin": origin, "User-Agent": "tng50-viz-verify/1", "Accept-Encoding": "identity"}
        if rng:
            hdr["Range"] = rng
        req = urllib.request.Request(url, headers=hdr)
        try:
            resp = opener.open(req, timeout=timeout)
            status, headers, body = resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
        except urllib.error.HTTPError as exc:
            status, headers, body = exc.code, {k.lower(): v for k, v in exc.headers.items()}, None
        hops.append((status, headers, body))
        if status in (301, 302, 303, 307, 308) and "location" in headers:
            url = urllib.parse.urljoin(url, headers["location"])
            continue
        break
    return hops


def check_url(url: str, want_sha: str | None, origin: str = ORIGIN) -> dict:
    """The §6.2 checks on one URL. -> row dict with 'ok' and 'problems'."""
    hops = fetch_chain(url, origin)
    status, h, body = hops[-1]
    problems = []
    ok_acao = ("*", origin)
    if status != 200:
        problems.append(f"final status {status}")
    for st, hh, _ in hops:
        if hh.get("access-control-allow-origin") not in ok_acao:
            problems.append(f"ACAO {hh.get('access-control-allow-origin')!r} on {st}")
    if h.get("content-encoding", "identity") not in ("identity", ""):
        problems.append(f"content-encoding {h['content-encoding']}")
    if want_sha and body is not None and sha256_bytes(body) != want_sha:
        problems.append("sha256 mismatch")
    r = fetch_chain(url, origin, rng="bytes=0-99")
    if r[-1][0] != 206:
        problems.append(f"Range -> {r[-1][0]}")
    return {"url": url, "hops": [st for st, _, _ in hops], "status": status,
            "acao": h.get("access-control-allow-origin"), "acao_302": [hh.get("access-control-allow-origin")
                                                                        for st, hh, _ in hops[:-1]],
            "content_type": h.get("content-type"), "cache_control": h.get("cache-control"),
            "cache_control_302": [hh.get("cache-control") for st, hh, _ in hops[:-1]],
            "etag": h.get("etag"), "bytes": len(body) if body is not None else None,
            "range": r[-1][0], "ok": not problems, "problems": problems}


def verify_targets(man: dict) -> list[tuple[str, str | None]]:
    """manifest_v2.json + one WebP part and one gz per kind (gas, stars) present in the manifest."""
    out = [("manifest_v2.json", None)]
    seen = set()
    for kind, key, lev, cube in manifest_cubes(man):
        if kind in seen:
            continue
        seen.add(kind)
        w = cube["webp"]
        out.append((w["paths"][0], w["sha256"][0]))
        out.append((cube["gz"]["path"], cube["gz"]["sha256"]))
    return out


def print_table(rows, log=print) -> None:
    log(f"{'path':58s} {'hops':10s} {'st':>3s} {'ACAO':6s} {'302 ACAO':10s} {'content-type':26s} "
        f"{'cache-control':16s} {'range':>5s} {'bytes':>10s} etag")
    for r in rows:
        log(f"{r['path'][:58]:58s} {','.join(map(str, r['hops'])):10s} {r['status']:>3} {str(r['acao'])[:6]:6s} "
            f"{','.join(map(str, r['acao_302']))[:10]:10s} {str(r['content_type'])[:26]:26s} "
            f"{str(r['cache_control'])[:16]:16s} {r['range']:>5} {str(r['bytes']):>10s} {str(r['etag'])[:24]}")
        for p in r["problems"]:
            log(f"    PROBLEM: {p}")


def verify(repo: str, man: dict, origin: str = ORIGIN, log=print) -> bool:
    rows = []
    for path, sha in verify_targets(man):
        if path == "manifest_v2.json":
            sha = None                                  # compared byte-for-byte with the local file by the caller
        row = check_url(resolve_url(repo, path), sha, origin)
        row["path"] = path
        rows.append(row)
    print_table(rows, log)
    return all(r["ok"] for r in rows)


# ---------------------------------------------------------------------------------------------------- main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--viz", type=Path, default=DEFAULT_VIZ, help=f"viz build dir (default {DEFAULT_VIZ})")
    ap.add_argument("--repo", default=REPO, help="dataset repo id")
    ap.add_argument("--token-file", type=Path, default=None, help=f"default $HF_HOME/token ({DEFAULT_TOKEN_FILE})")
    ap.add_argument("--message", default="Update TNG50 sub-488530 viz cubes")
    ap.add_argument("--dry-run", action="store_true", help="print the plan and total bytes; upload nothing")
    ap.add_argument("--verify-only", action="store_true", help="only run the anonymous CORS/sha/range checks")
    ap.add_argument("--no-verify", action="store_true", help="skip the checks after an upload")
    ap.add_argument("--prune", action="store_true",
                    help="after the upload (and before the verify), list remote cube files not in the local "
                         "manifest; with --dry-run, only list them (anonymous read, nothing uploaded or deleted)")
    ap.add_argument("--yes", action="store_true", help="with --prune (not --dry-run): actually delete them")
    a = ap.parse_args(argv)
    try:
        if a.verify_only:
            man_p = a.viz / "manifest_v2.json"
            if not man_p.is_file():
                ap.error(f"{man_p} not found")
            man = json.loads(man_p.read_text())
            hops = fetch_chain(resolve_url(a.repo, "manifest_v2.json"))
            same = hops[-1][2] == man_p.read_bytes()
            ok = verify(a.repo, man)
            print(f"remote manifest_v2.json {'matches' if same else 'DIFFERS FROM'} the local one")
            return 0 if ok and same else 1
        p = plan(a.viz)
        n = {k: sum(1 for r, _ in p["items"] if r.startswith(k)) for k in ("gas/", "stars/", "luts/", "previews/")}
        print(f"dataset {a.repo} (public): {len(p['items'])} files, {p['total'] / 1e6:.1f} MB "
              f"[{n['gas/']} gas, {n['stars/']} stars, {n['luts/']} luts, {n['previews/']} previews, README, manifest]")
        for rel in p["refused"]:
            print(f"  not uploaded ({p['reasons'][rel]}): {rel}")
        if a.dry_run:
            for rel, src in p["items"]:
                print(f"  {rel:60s} {len(_payload(src)) if isinstance(src, bytes) else Path(src).stat().st_size:>12,d}")
            if a.prune:                                     # list only: the dataset is public, so no token is needed
                from huggingface_hub import HfApi
                stale = stale_remote(remote_index(HfApi(token=None), a.repo), p["items"])
                for s in stale:
                    print(f"  stale remote file: {s}")
                print(f"{len(stale)} stale remote files (dry run: nothing deleted"
                      + ("; --yes is ignored with --dry-run" if a.yes else "") + ")")
            print("dry run: nothing uploaded")
            return 0
        from huggingface_hub import HfApi
        api = HfApi(token=read_token(a.token_file))
        upload(api, a.repo, p["items"], a.message)
        if a.prune:
            stale = stale_remote(remote_index(api, a.repo), p["items"])
            for s in stale:
                print(f"  stale remote file: {s}")
            if stale and a.yes:
                prune(api, a.repo, stale)
            elif stale:
                print(f"{len(stale)} stale files listed; pass --prune --yes to delete them")
        if not a.no_verify:
            return 0 if verify(a.repo, p["manifest"]) else 1
        return 0
    except (RuntimeError, ValueError, ImportError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
