"""deploy/data/upload_viz_dataset.py (design-2b §6.2, §6.5): allow-list, refusal cases, the upload plan and card,
skip-if-identical, commit chunking, prune listing, HF error reduction and that the token is never printed.
Uses a fake HfApi and a stand-in for vizpack.validate_manifest_v2; nothing touches the network."""
from __future__ import annotations
import gzip, hashlib, importlib.util, json, sys, types
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("upload_viz_dataset", ROOT / "deploy" / "data" / "upload_viz_dataset.py")
UP = importlib.util.module_from_spec(spec); spec.loader.exec_module(UP)
SECRET = "hf_TESTSECRETtokenDoNotPrint0123456789"


def _cube(viz: Path, rel_dir: str, stem: str, raw: bytes, ext: str, rng) -> dict:
    sha = hashlib.sha256(raw).hexdigest()
    paths, sizes, shas = [], [], []
    for p in range(4):
        rel = f"{rel_dir}/{stem}.{sha[:12]}.p{p}.webp"
        b = b"RIFF" + rng.bytes(40)
        (viz / rel).parent.mkdir(parents=True, exist_ok=True)
        (viz / rel).write_bytes(b)
        paths.append(rel); sizes.append(len(b)); shas.append(hashlib.sha256(b).hexdigest())
    gz = gzip.compress(raw, 9, mtime=0)
    rel = f"{rel_dir}/{stem}.{sha[:12]}.{ext}"
    (viz / rel).write_bytes(gz)
    return {"vmin": 0.0, "vmax": 1.0, "raw_bytes": len(raw), "raw_sha256": sha,
            "webp": {"paths": paths, "bytes": sizes, "sha256": shas},
            "gz": {"path": rel, "bytes": len(gz), "sha256": hashlib.sha256(gz).hexdigest()}}


@pytest.fixture()
def viz(tmp_path, monkeypatch):
    rng = np.random.default_rng(3)
    d = tmp_path / "viz"
    d.mkdir()
    man = {"schema": "tng50-viz/2", "created": "2026-10-14T12:00:00Z",
           "gas": {"levels": ["L1"], "fields": {
               "nH": {"cubes": {"L1": _cube(d, "gas/L1", "nH", rng.bytes(4096), "u8.gz", rng)}},
               "OVI": {"cubes": {"L1": _cube(d, "gas/L1", "OVI", rng.bytes(4096), "u8.gz", rng)}}}},
           "stars": {"levels": ["S2"], "cubes": {"S2": _cube(d, "stars/S2", "gri", rng.bytes(16384), "rgba.gz", rng)}}}
    (d / "manifest_v2.json").write_text(json.dumps(man))
    (d / "luts").mkdir(); (d / "luts" / "luts.json").write_text('{"version":1,"luts":{}}')
    (d / "previews").mkdir(); (d / "previews" / "face_on.png").write_bytes(b"\x89PNG small")
    (d / "previews" / "huge.png").write_bytes(b"\x89PNG" + b"0" * (UP.PREVIEW_MAX + 1))
    for junk in ("gas/manifest_gas.json", ".DS_Store", "yt.toml", "config.tri", "gas/L1/x.ewah", "cache.npy",
                 "cut.hdf5", "gas/L1/.nH.tmp"):
        (d / junk).parent.mkdir(parents=True, exist_ok=True)
        (d / junk).write_bytes(b"junk")
    fake = types.ModuleType("tngsight.vizpack")
    fake.validate_manifest_v2 = lambda m, base_dir=None: None if m.get("schema") == "tng50-viz/2" else (_ for _ in ()).throw(ValueError("schema"))
    import tngsight
    monkeypatch.setitem(sys.modules, "tngsight.vizpack", fake)
    monkeypatch.setattr(tngsight, "vizpack", fake, raising=False)
    return d


class FakeApi:
    def __init__(self, remote=None, fail=None):
        self.remote = remote or {}
        self.commits, self.created, self.fail = [], [], fail

    def create_repo(self, repo, repo_type=None, private=None, exist_ok=None):
        if self.fail:
            raise self.fail
        self.created.append((repo, repo_type, private, exist_ok))

    def list_repo_tree(self, repo, repo_type=None, recursive=None, expand=None):
        assert recursive and expand
        for path, (size, sha, blob) in self.remote.items():
            yield types.SimpleNamespace(path=path, size=size, blob_id=blob,
                                        lfs=types.SimpleNamespace(sha256=sha) if sha else None)

    def create_commit(self, repo, ops, repo_type=None, commit_message=None):
        self.commits.append([(o.path_in_repo, getattr(o, "path_or_fileobj", None)) for o in ops])


@pytest.mark.parametrize("rel,ok", [
    ("README.md", True), ("manifest_v2.json", True), ("luts/luts.json", True), ("previews/face_on.png", True),
    ("gas/L0/nH.0123456789ab.p0.webp", True), ("gas/L2/CIII.0123456789ab.u8.gz", True),
    ("stars/S1/gri.0123456789ab.p3.webp", True), ("stars/S0/gri.0123456789ab.rgba.gz", True),
    ("gas/L3/nH.0123456789ab.p0.webp", False), ("gas/L0/rho.0123456789ab.p0.webp", False),
    ("gas/L0/nH.0123456789AB.p0.webp", False), ("gas/L0/nH.0123456789ab.p4.webp", False),
    ("gas/L0/nH.0123456789ab.rgba.gz", False), ("stars/S1/gri.0123456789ab.u8.gz", False),
    ("gas/manifest_gas.json", False), (".gitattributes", False), ("yt.toml", False), ("config.tri", False),
    ("gas/L0/x.ewah", False), ("cache.npy", False), ("cut.hdf5", False), ("previews/Face.png", False),
    ("previews/../manifest_v2.json", False), ("/manifest_v2.json", False), ("manifest_v2.json\n", False)])
def test_allow_list(rel, ok):
    assert bool(UP.ALLOW_RE.fullmatch(rel)) is ok


def test_plan_lists_exactly_the_allowed_files(viz):
    p = UP.plan(viz)
    rels = [r for r, _ in p["items"]]
    assert rels[0] == "README.md" and len(rels) == len(set(rels))
    assert "manifest_v2.json" in rels and "luts/luts.json" in rels and "previews/face_on.png" in rels
    assert sum(r.startswith("gas/") for r in rels) == 10 and sum(r.startswith("stars/") for r in rels) == 5
    assert "previews/huge.png" not in rels                                         # > 1 MB preview
    for junk in ("gas/manifest_gas.json", ".DS_Store", "yt.toml", "config.tri", "gas/L1/x.ewah", "cache.npy",
                 "cut.hdf5", "gas/L1/.nH.tmp", "previews/huge.png"):
        assert junk in p["refused"] and junk not in rels
    assert all(UP.ALLOW_RE.fullmatch(r) for r in rels)
    card = p["items"][0][1].decode()
    assert "{{" not in card and "## Sizes" in card and "| gas L1 | 2 |" in card and "| stars S2 | 1 |" in card
    assert "license: other" in card and "tng-project.org/data/docs/background/#citation" in card
    assert "/Volumes" not in card and "hf_" not in card
    assert p["total"] == sum(len(s) if isinstance(s, bytes) else s.stat().st_size for _, s in p["items"])


def test_plan_refusals(viz):
    man = json.loads((viz / "manifest_v2.json").read_text())
    man["gas"]["fields"]["nH"]["cubes"]["L1"]["gz"]["path"] = "gas/L1/../../secret.hdf5"
    (viz / "manifest_v2.json").write_text(json.dumps(man))
    with pytest.raises(ValueError, match="allow-list"):
        UP.plan(viz)
    (viz / "manifest_v2.json").write_text(json.dumps(dict(man, schema="tng50-viz/1")))
    with pytest.raises(ValueError, match="schema"):
        UP.plan(viz)
    (viz / "manifest_v2.json").unlink()
    with pytest.raises(ValueError, match="vizpack merge"):
        UP.plan(viz)


def test_card_template_without_manifest():
    card = UP.render_card(None, [])
    assert "{{" not in card and "not been uploaded yet" in card and card.startswith("---\nlicense: other\n")
    for cite in ("Nelson et al. 2019, *Computational Astrophysics and Cosmology* 6, 2", "*MNRAS* 490, 3234",
                 "Pillepich et al. 2019", "Hummels", "Turk et al. 2011", "Haardt & Madau 2012", "Bruzual & Charlot 2003",
                 "Lupton et al. 2004", "MIT"):
        assert cite in card, cite
    for tag in ("astronomy", "simulation", "illustristng", "tng50", "volume-rendering"):
        assert f"- {tag}\n" in card


def test_upload_skips_identical_and_chunks(viz, monkeypatch, capsys):
    p = UP.plan(viz)
    data = {r: (s if isinstance(s, bytes) else s.read_bytes()) for r, s in p["items"]}
    lfs_same = "gas/L1/" + next(r.split("/")[-1] for r in data if r.startswith("gas/L1/nH"))
    remote = {lfs_same: (len(data[lfs_same]), hashlib.sha256(data[lfs_same]).hexdigest(), "x"),
              "luts/luts.json": (1, None, UP.git_blob_id(data["luts/luts.json"])),       # small git file, same blob
              "manifest_v2.json": (1, None, "0" * 40)}                                       # changed
    api = FakeApi(remote)
    monkeypatch.setattr(UP, "COMMIT_MAX", 4)
    n = UP.upload(api, UP.REPO, p["items"], "msg", log=print)
    assert api.created == [(UP.REPO, "dataset", False, True)]                             # public, exist_ok
    sent = [r for c in api.commits for r, _ in c]
    assert n == len(p["items"]) - 2 and lfs_same not in sent and "luts/luts.json" not in sent
    assert all(len(c) <= 4 for c in api.commits) and len(sent) == len(set(sent))
    cubes_done = max(i for i, r in enumerate(sent) if UP.CUBE_RE.match(r))
    assert all(not UP.CUBE_RE.match(r) for r in sent[cubes_done + 1:])
    assert sent.index("manifest_v2.json") > cubes_done                                     # manifest after cubes
    assert all(isinstance(b, bytes) for c in api.commits for _, b in c)
    with pytest.raises(ValueError, match="allow-list"):
        UP.upload(FakeApi(), UP.REPO, [("yt.toml", b"x")], "m")


def test_prune_lists_only_stale_cubes(viz):
    p = UP.plan(viz)
    remote = {r: (1, "a" * 64, None) for r, _ in p["items"]}
    remote.update({"gas/L1/nH.ffffffffffff.u8.gz": (1, "b" * 64, None), "previews/old.png": (1, "c" * 64, None)})
    assert UP.stale_remote(remote, p["items"]) == ["gas/L1/nH.ffffffffffff.u8.gz"]


def test_hf_errors_are_reduced_and_token_never_printed(viz, tmp_path, monkeypatch, capsys):
    tok = tmp_path / "token"
    tok.write_text(SECRET + "\n")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    assert UP.read_token(tok) == SECRET
    monkeypatch.setenv("HF_TOKEN", SECRET)
    assert UP.read_token(tmp_path / "missing") == SECRET
    monkeypatch.delenv("HF_TOKEN")
    with pytest.raises(RuntimeError) as ei:
        UP.read_token(tmp_path / "missing")
    assert SECRET not in str(ei.value)

    class Boom(Exception):
        def __init__(self):
            super().__init__(f"401 Unauthorized, headers: {{'authorization': 'Bearer {SECRET}'}}")
            self.response = types.SimpleNamespace(status_code=401, reason_phrase="Unauthorized")
    with pytest.raises(RuntimeError) as ei:
        UP.upload(FakeApi(fail=Boom()), UP.REPO, [("README.md", b"x")], "m")
    assert str(ei.value) == "HF 401: Unauthorized" and ei.value.__cause__ is None and ei.value.__suppress_context__

    # the CLI end to end with a fake huggingface_hub.HfApi that fails: exit 2, short message, no token anywhere
    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "HfApi", lambda token=None: FakeApi(fail=Boom()))
    monkeypatch.setenv("HF_TOKEN", SECRET)
    assert UP.main(["--viz", str(viz), "--no-verify"]) == 2
    # and a successful fake upload
    monkeypatch.setattr(huggingface_hub, "HfApi", lambda token=None: FakeApi())
    assert UP.main(["--viz", str(viz), "--no-verify", "--prune"]) == 0
    assert UP.main(["--viz", str(viz), "--dry-run"]) == 0
    out = capsys.readouterr()
    assert "HF 401: Unauthorized" in out.err and "dry run: nothing uploaded" in out.out
    assert SECRET not in out.out and SECRET not in out.err and "Bearer" not in out.out + out.err


def test_dry_run_needs_no_token(viz, monkeypatch, capsys):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setattr(UP, "DEFAULT_TOKEN_FILE", Path("/nonexistent/token"))
    assert UP.main(["--viz", str(viz), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "(public): 19 files" in out and "not uploaded (off the allow-list): yt.toml" in out
    assert "not uploaded (preview over 1 MB): previews/huge.png" in out


def test_superseded_cubes_get_their_own_reason(viz, monkeypatch, capsys):
    old = viz / "gas" / "L1" / "nH.ffffffffffff.p0.webp"                 # an older build, still on disk
    old.write_bytes(b"RIFFold")
    p = UP.plan(viz)
    assert p["reasons"]["gas/L1/nH.ffffffffffff.p0.webp"] == "not referenced by manifest_v2.json"
    assert p["reasons"]["gas/manifest_gas.json"] == "off the allow-list"
    monkeypatch.delenv("HF_TOKEN", raising=False)
    assert UP.main(["--viz", str(viz), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "not uploaded (not referenced by manifest_v2.json): gas/L1/nH.ffffffffffff.p0.webp" in out


def test_dry_run_prune_only_lists(viz, monkeypatch, capsys):
    import huggingface_hub
    p = UP.plan(viz)
    remote = {r: (1, "a" * 64, None) for r, _ in p["items"]}
    remote["stars/S2/gri.ffffffffffff.rgba.gz"] = (1, "b" * 64, None)
    api = FakeApi(remote=remote)
    seen = []
    monkeypatch.setattr(huggingface_hub, "HfApi", lambda token=None: (seen.append(token), api)[1])
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setattr(UP, "DEFAULT_TOKEN_FILE", Path("/nonexistent/token"))
    assert UP.main(["--viz", str(viz), "--dry-run", "--prune", "--yes"]) == 0
    out = capsys.readouterr().out
    assert "stale remote file: stars/S2/gri.ffffffffffff.rgba.gz" in out and "nothing deleted" in out
    assert seen == [None] and api.commits == [] and api.created == []      # anonymous, no upload, no delete


def test_verify_targets_and_check_rules(viz, monkeypatch):
    man = json.loads((viz / "manifest_v2.json").read_text())
    t = UP.verify_targets(man)
    assert t[0] == ("manifest_v2.json", None) and len(t) == 5
    assert [p.rsplit(".", 2)[-2:] for p, _ in t[1:]] in ([["p0", "webp"], ["u8", "gz"], ["p0", "webp"], ["rgba", "gz"]],)
    body = b"0123456789" * 20
    sha = hashlib.sha256(body).hexdigest()
    good302 = (302, {"access-control-allow-origin": UP.ORIGIN, "location": "https://cdn/x", "cache-control": "no-store"}, None)
    good200 = (200, {"access-control-allow-origin": "*", "content-type": "application/octet-stream", "etag": '"e"'}, body)

    def chain(hops, range_status=206):
        return lambda url, origin=UP.ORIGIN, rng=None, **kw: [(range_status, {}, body[:100])] if rng else hops
    monkeypatch.setattr(UP, "fetch_chain", chain([good302, good200]))
    r = UP.check_url("u", sha)
    assert r["ok"] and r["hops"] == [302, 200] and r["acao_302"] == [UP.ORIGIN] and r["range"] == 206
    monkeypatch.setattr(UP, "fetch_chain", chain([(302, {"location": "x"}, None), good200]))
    assert "ACAO None on 302" in UP.check_url("u", sha)["problems"]
    monkeypatch.setattr(UP, "fetch_chain", chain([good302, (200, dict(good200[1], **{"content-encoding": "gzip"}), body)]))
    assert UP.check_url("u", sha)["problems"] == ["content-encoding gzip"]
    monkeypatch.setattr(UP, "fetch_chain", chain([good302, good200], range_status=200))
    assert UP.check_url("u", "f" * 64)["problems"] == ["sha256 mismatch", "Range -> 200"]


def test_card_kernel_floor_matches_the_manifest():
    """The card's kernel-floor sentence must state the floors the published manifest records."""
    import re
    card = UP.CARD.read_text(encoding="utf-8")
    man_p = ROOT / "docs" / "tng50" / "data" / "viz" / "manifest_v2.json"
    if not man_p.is_file():
        pytest.skip("no committed manifest_v2.json")
    k = json.loads(man_p.read_text())["kernel"]
    gas, stars = float(k["h_min_voxels_gas"]), float(k["h_min_voxels"])
    fmt = lambda v: "Δ" if v == 1 else f"{v:g}Δ"
    assert re.search(rf"gas h_eff = max\(h, {fmt(gas)}\)", card), "card gas floor differs from the manifest"
    assert re.search(rf"stars h_eff = max\(h, {fmt(stars)}\)", card), "card star floor differs from the manifest"
    assert f"kernel.h_min_voxels_gas` = {gas:g}" in card and f"kernel.h_min_voxels` = {stars:g}" in card
