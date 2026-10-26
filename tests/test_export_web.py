"""scripts/export_tng50_web.py (design-2 §7.6, §7.9; design-2b §6.4, §6.5): p0/p1 from the npz geom, components copy,
has_components, custom ids only with --include-generated, page config keys, js copy, and the Phase-2b viz manifest:
only manifest_v2.json is copied, CFG.viz shape, invalid/missing manifest -> viz null, --viz-local (refused for
docs/tng50), vol/vol_url gone, --prune removes data/vol; Phase 3: CFG v3 from the ion registry, catalog v2
passthrough, check_bin v1/v2, --allow-v1 and the mixed v1/v2 refusal. Output always into tmp."""
from __future__ import annotations
import gzip, hashlib, importlib.util, json, struct, sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("export_tng50_web", ROOT / "scripts" / "export_tng50_web.py")
EXP = importlib.util.module_from_spec(spec); spec.loader.exec_module(EXP)
GAL = json.loads((ROOT / "tngsight" / "galaxy_488530.json").read_text())
CENTER, H = np.asarray(GAL["center_kpc"]), GAL["TNG_H"]
LIB = EXP.default_library()        # the exporter's default: TNG_LIBRARY_DIR, else <TNG_WORK>/data/library
VIZ_CFG = {"manifest_url": "data/viz/manifest_v2.json",
           "base": "https://huggingface.co/datasets/tanmay-starslab/tng50-sub488530-viz/resolve/main/",
           "fallback_base": None, "dataset": "tanmay-starslab/tng50-sub488530-viz"}  # design-2b §5.10; no local cubes



def _page_config(out: Path) -> dict:
    html = (out / "index.html").read_text(encoding="utf-8")
    start = html.index("const DATA = ") + len("const DATA = ")
    return json.loads(html[start:html.index(";\n", start)])


def _bin(keys=("HI", "OVI", "OVII"), v_sys=12.5) -> bytes:
    """small valid TNGS v2 web binary (lines of 5 pixels, u = -2..2)"""
    out = b"TNGS" + struct.pack("<BBHd", 2, len(keys), 0, v_sys)
    for k in keys:
        out += struct.pack("<8sIIddd", k.encode().ljust(8, b"\0"), 5, 0, -2.0, 1.0, 1000.0) + \
            struct.pack("<5H", 65535, 30000, 20000, 65535, 65535)
    return out


def _bin_v1() -> bytes:
    """smallest valid TNGS v1 web binary (3 lines of 4 pixels)"""
    out = b"TNGS" + struct.pack("<BBH", 1, 3, 0)
    for rest in (1031.912, 1025.7222, 977.02):
        out += struct.pack("<Idddd", 4, rest - 0.004, 0.002, rest, 0.002) + struct.pack("<4H", 65535, 30000, 65535, 65535)
    return out


def _geom_npz(path: Path, p0, p1):
    start, end = CENTER + np.asarray(p0, float), CENTER + np.asarray(p1, float)
    geom = {"orientation": "custom", "start_ckpch": (start * H).tolist(), "end_ckpch": (end * H).tolist()}
    np.savez(path, geom=np.array(json.dumps(geom)), v_sys=np.float64(0.0))


@pytest.fixture()
def fake_lib(tmp_path):
    lib = tmp_path / "lib"
    for d in ("web", "generated", "sightlines"):
        (lib / d).mkdir(parents=True)
    ents = [{"id": "edge_b100_a090", "orientation": "edge-on", "b_kpc": 100.0, "azimuth_deg": 90.0, "seed": None, "source": "library", "rank": 1},
            {"id": "rand_b075_a000_s12345", "orientation": "random", "b_kpc": 75.0, "azimuth_deg": 0.0, "seed": 12345, "source": "generated"},
            {"id": "cust_35277e0469", "orientation": "custom", "b_kpc": 0.0, "azimuth_deg": 0.0, "seed": None, "source": "generated",
             "kind": "endpoints", "p0": [-100.0, 0.0, 0.0], "p1": [100.0, 0.0, 0.0]},
            {"id": "face_b050_a000", "orientation": "face-on", "b_kpc": 50.0, "azimuth_deg": 0.0, "seed": None, "source": "library", "rank": 2}]
    (lib / "catalog.json").write_text(json.dumps({"version": 2, "registry_tag": "abc", "scoring": "s", "generation": {"min_tau": 1e-8},
                                                  "galaxy": {"R200c_kpc": 246.35}, "ions": ["HI"], "entries": ents}))
    (lib / "web" / "edge_b100_a090.bin").write_bytes(_bin()); (lib / "web" / "face_b050_a000.bin").write_bytes(_bin())
    (lib / "generated" / "rand_b075_a000_s12345.bin").write_bytes(_bin()); (lib / "generated" / "cust_35277e0469.bin").write_bytes(_bin())
    _geom_npz(lib / "sightlines" / "cgm_sid488530_edge_b100_a090.npz", [10.123, -200.456, 30.0], [-10.0, 180.004, -25.5])
    _geom_npz(lib / "generated" / "rand_b075_a000_s12345.npz", [-300.0, 1.0, 2.0], [250.0, -3.0, 4.0])
    # face_b050_a000 deliberately has no npz -> p0/p1 absent and reported
    comps = {"version": 1, "fitter": "tngsight.vpfit/1", "params_tag": "x", "params": {},
             "entries": {"edge_b100_a090": {"OVI": [], "HI": [], "CIII": []}, "cust_35277e0469": {"OVI": [], "HI": [], "CIII": []}}}
    (lib / "components.json").write_text(json.dumps(comps, separators=(",", ":")))
    return lib


def _run(lib, out, *extra):
    return EXP.main(["--library", str(lib), "--out", str(out), "--local-url", "", *extra])


def test_fake_library_export(fake_lib, tmp_path, capsys):
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--viz-dir", str(tmp_path / "noviz")) == 0
    cat = json.loads((out / "data" / "catalog.json").read_text())
    ids = {e["id"]: e for e in cat["entries"]}
    assert set(ids) == {"edge_b100_a090", "face_b050_a000"}          # generated + custom only with --include-generated
    e = ids["edge_b100_a090"]
    assert e["p0"] == [10.12, -200.46, 30.0] and e["p1"] == [-10.0, 180.0, -25.5]
    assert "p0" not in ids["face_b050_a000"] and "without p0/p1" in capsys.readouterr().out
    assert e["has_components"] is True and ids["face_b050_a000"]["has_components"] is False
    assert (out / "data" / "components.json").read_bytes() == (fake_lib / "components.json").read_bytes()
    cfg = _page_config(out)
    assert cfg["viz"] is None and "vol" not in cfg and "vol_url" not in cfg
    assert cfg["components_url"] == "data/components.json"
    assert cfg["three"] == "0.169.0" and cfg["chat"] == {"enabled": False, "webllm": "0.2.85", "model": "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"}
    assert cfg["custom"] == {"r_max_kpc": 395, "l_min_kpc": 20, "l_max_kpc": 800}
    assert set(cfg["frame"]) == {"Lhat", "xhat", "yhat", "R200c_kpc"} and cfg["frame"]["Lhat"] == GAL["Lhat"]
    assert {k: v for k, v in cat.items() if k != "entries"} == {"version": 2, "registry_tag": "abc", "scoring": "s",
                                                               "generation": {"min_tau": 1e-8},
                                                               "galaxy": {"R200c_kpc": 246.35}, "ions": ["HI"]}
    js = sorted(p.name for p in (out / "js").glob("*.js"))
    assert {"viewer3d.js", "picker.js", "search.js"} <= set(js)
    for name in js:
        assert (out / "js" / name).read_bytes() == (ROOT / "docs" / "tng50" / "js" / name).read_bytes()
    assert {"app.js", "state.js", "spectra.js", "gallery.js", "instrument.js", "fit.js", "fitworker.js"} <= set(js)   # Phase-3 page modules
    css = sorted(p.name for p in (out / "css").glob("*.css"))
    assert "page.css" in css and all((out / "css" / n).read_bytes() == (ROOT / "docs" / "tng50" / "css" / n).read_bytes() for n in css)
    html = (out / "index.html").read_text(encoding="utf-8")
    assert 'href="css/page.css"' in html and 'src="js/app.js"' in html and "Interactive companion" not in html
    assert not (out / "data" / "vol").exists() and not (out / "data" / "viz").exists()
    luts = ROOT / "docs" / "tng50" / "data" / "luts" / "luts.json"       # U_view's file; copied when --out is elsewhere
    if luts.is_file():
        assert (out / "data" / "luts" / "luts.json").read_bytes() == luts.read_bytes()
    else:
        assert not (out / "data" / "luts").exists()


def test_include_generated_and_custom(fake_lib, tmp_path):
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--include-generated", "--chat", "--viz-dir", str(tmp_path / "noviz")) == 0
    ids = {e["id"]: e for e in json.loads((out / "data" / "catalog.json").read_text())["entries"]}
    assert set(ids) == {"edge_b100_a090", "face_b050_a000", "rand_b075_a000_s12345", "cust_35277e0469"}
    assert ids["cust_35277e0469"]["p0"] == [-100.0, 0.0, 0.0]                     # catalogue p0/p1 kept as is
    assert ids["rand_b075_a000_s12345"]["p0"] == [-300.0, 1.0, 2.0]               # from generated/<id>.npz
    assert ids["cust_35277e0469"]["has_components"] and not ids["rand_b075_a000_s12345"]["has_components"]
    assert _page_config(out)["chat"]["enabled"] is True
    assert (out / "data" / "s" / "cust_35277e0469.bin").is_file()


def test_cfg_v3_from_registry(fake_lib, tmp_path):
    from tngsight import ions as I
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--viz-dir", str(tmp_path / "noviz")) == 0
    cfg = _page_config(out)
    assert cfg["version"] == 3 and "lines" not in cfg and "R_opts" not in cfg
    assert cfg["ions"] == I.page_ions() and [i["key"] for i in cfg["ions"]] == list(I.KEYS)
    assert cfg["bands"] == I.BANDS and cfg["snr"] == I.SNR and cfg["grid"] == {"dv_web": 1.0}
    assert cfg["registry_tag"] == I.registry_tag()
    assert cfg["fitter"] == {"worker": "js/fitworker.js", "budget_ms": 300, "cap_ms": 1500, "version": "fit/1"}
    assert cfg["defaults"] == {"id": "edge_b100_a090", "ions": ["HI", "MgII", "CIV", "OVI", "OVII"], "layout": "1",   # page opens on one case
                               "R": {"uv": [15000, 50000], "euv": [15000, 50000], "xray": [300, 3000]},
                               "sn": [20, 5], "vc": 0, "vhw": 400, "seed": 0, "intrinsic": False, "fit": False}
    for k in ("catalog_url", "bin_dir", "n_static", "backends", "galaxy", "frame", "viz", "components_url", "js_base",
              "three", "chat", "custom"):
        assert k in cfg, k
    html = (out / "index.html").read_text(encoding="utf-8")
    assert "\u00b7" not in json.dumps(cfg["ions"], ensure_ascii=False) and "·" not in json.dumps(cfg["ions"], ensure_ascii=False)
    assert "/Users/" not in html and "/Volumes/" not in json.dumps(cfg)
    for private in (str(tmp_path), str(fake_lib), str(EXP.default_library())):      # no local path of this machine
        assert private not in json.dumps(cfg), private


def test_check_bin_v1_v2():
    assert EXP.check_bin(_bin(), "x") == 2
    assert EXP.check_bin(_bin(("NeVIII",)), "x") == 2
    assert EXP.check_bin(_bin_v1(), "x", allow_v1=True) == 1
    for blob, msg in ((_bin_v1(), "pass --allow-v1"), (_bin() + b"\0", "length"), (_bin()[:-1], "length"),
                      (_bin(("HILyb",)), "unknown or repeated"), (_bin(("OVI", "OVI")), "unknown or repeated"),
                      (b"XXXX" + _bin()[4:], "bad magic"), (_bin()[:4] + bytes([3]) + _bin()[5:], "version 3")):
        with pytest.raises(ValueError, match=msg):
            EXP.check_bin(blob, "x")


def test_v1_bins_need_allow_v1_and_mixed_export_refused(fake_lib, tmp_path, capsys):
    (fake_lib / "web" / "face_b050_a000.bin").write_bytes(_bin_v1())
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--viz-dir", str(tmp_path / "noviz")) == 0          # v1 bin skipped without --allow-v1
    ids = {e["id"] for e in json.loads((out / "data" / "catalog.json").read_text())["entries"]}
    assert ids == {"edge_b100_a090"} and "pass --allow-v1" in capsys.readouterr().out
    out2 = tmp_path / "site2"
    with pytest.raises(SystemExit, match="mix TNGS v1"):
        _run(fake_lib, out2, "--viz-dir", str(tmp_path / "noviz"), "--allow-v1")
    assert not list((out2 / "data" / "s").glob("*.bin"))                          # refused before any write
    (fake_lib / "web" / "edge_b100_a090.bin").write_bytes(_bin_v1())
    out3 = tmp_path / "site3"
    assert _run(fake_lib, out3, "--viz-dir", str(tmp_path / "noviz"), "--allow-v1") == 0   # all-v1 is fine with the flag
    assert len(list((out3 / "data" / "s").glob("*.bin"))) == 2


def test_id_regex_matches_server():
    for good in ("edge_b100_a090", "rand_b075_a000_s12345", "cust_35277e0469"):
        assert EXP.ID_RE.match(good)
    for bad in ("cust_ABCDEF0123", "cust_123", "cust_0123456789a", "edge_b100_a90", "../etc"):
        assert not EXP.ID_RE.match(bad)
    try:
        from server.storage import ID_RE as SERVER_RE
    except Exception:                                   # noqa: BLE001 - server deps optional here
        pytest.skip("server.storage not importable")
    assert EXP.ID_RE.pattern == getattr(SERVER_RE, "pattern", SERVER_RE)


# ------------------------------------------------------------------------------------------- viz (design-2b §6.4)
def _cube(viz: Path, rel_dir: str, stem: str, raw: bytes, ext: str, rng) -> dict:
    """A CUBE entry (§3.3) with fake WebP parts and a real gz, files written under viz/."""
    sha = hashlib.sha256(raw).hexdigest()
    paths, sizes, shas = [], [], []
    for p in range(4):
        rel = f"{rel_dir}/{stem}.{sha[:12]}.p{p}.webp"
        b = b"RIFF" + rng.bytes(60)
        (viz / rel).parent.mkdir(parents=True, exist_ok=True)
        (viz / rel).write_bytes(b)
        paths.append(rel); sizes.append(len(b)); shas.append(hashlib.sha256(b).hexdigest())
    gz = gzip.compress(raw, 9, mtime=0)
    rel = f"{rel_dir}/{stem}.{sha[:12]}.{ext}"
    (viz / rel).write_bytes(gz)
    return {"vmin": -8.6, "vmax": 0.5, "raw_bytes": len(raw), "raw_sha256": sha,
            "webp": {"paths": paths, "bytes": sizes, "sha256": shas},
            "gz": {"path": rel, "bytes": len(gz), "sha256": hashlib.sha256(gz).hexdigest()},
            "stats": {"frac_empty": 0.5, "p01": -8.0, "p50": -4.0, "p99": -1.0, "max": 0.4},
            "deposit": {"n_elements": 10, "n_straddling": 1, "lost_fraction": 0.01, "seconds": 0.1, "workers": 1}}


@pytest.fixture()
def viz_dir(tmp_path):
    """A small manifest_v2-shaped viz dir: 2 gas cubes, 1 star cube, a fragment manifest and junk that must not ship."""
    rng = np.random.default_rng(7)
    viz = tmp_path / "viz"
    viz.mkdir()
    gas = {"nH": {"kind": "density", "vmin": -8.6, "vmax": 0.5,
                  "cubes": {"L0": _cube(viz, "gas/L0", "nH", rng.bytes(4096), "u8.gz", rng),
                            "L1": _cube(viz, "gas/L1", "nH", rng.bytes(4096), "u8.gz", rng)}}}
    stars = {"levels": ["S1"], "cubes": {"S1": _cube(viz, "stars/S1", "gri", rng.bytes(4 * 4096), "rgba.gz", rng)}}
    man = {"schema": "tng50-viz/2", "created": "2026-10-14T12:00:00Z", "gas": {"levels": ["L0", "L1"], "fields": gas},
           "stars": stars}
    (viz / "manifest_v2.json").write_text(json.dumps(man, indent=1))
    (viz / "gas" / "manifest_gas.json").write_text("{}")
    (viz / ".DS_Store").write_bytes(b"x")
    return viz


def _fake_validate(man, base_dir=None):
    """Stand-in for tngsight.vizpack.validate_manifest_v2 (schema + per-file size/sha with base_dir)."""
    if man.get("schema") != "tng50-viz/2":
        raise ValueError("schema")
    if base_dir is not None:
        for rel in EXP.manifest_files(man):
            if not (Path(base_dir) / rel).is_file():
                raise ValueError(f"{rel} missing")
        for c in [c for f in man["gas"]["fields"].values() for c in f["cubes"].values()] + list(man["stars"]["cubes"].values()):
            for rel, n, sha in [(p, b, h) for p, b, h in zip(c["webp"]["paths"], c["webp"]["bytes"], c["webp"]["sha256"])] \
                    + [(c["gz"]["path"], c["gz"]["bytes"], c["gz"]["sha256"])]:
                b = (Path(base_dir) / rel).read_bytes()
                if len(b) != n or hashlib.sha256(b).hexdigest() != sha:
                    raise ValueError(f"{rel} sha256")


@pytest.fixture()
def fake_vizpack(monkeypatch):
    monkeypatch.setattr(EXP, "_validate_manifest_v2", _fake_validate)


def test_viz_manifest_only_copy_and_cfg(fake_lib, viz_dir, tmp_path, fake_vizpack):
    out = tmp_path / "site"
    (out / "data" / "vol").mkdir(parents=True)
    (out / "data" / "vol" / "nH.u8.gz").write_bytes(b"old phase-2 volume")
    assert _run(fake_lib, out, "--viz-dir", str(viz_dir)) == 0
    cfg = _page_config(out)
    assert cfg["viz"] == VIZ_CFG
    assert "vol" not in cfg and "vol_url" not in cfg
    assert (out / "data" / "viz" / "manifest_v2.json").read_bytes() == (viz_dir / "manifest_v2.json").read_bytes()
    shipped = sorted(p.relative_to(out / "data" / "viz").as_posix() for p in (out / "data" / "viz").rglob("*") if p.is_file())
    assert shipped == ["manifest_v2.json"]                                  # no cube ever lands in the page tree
    assert (out / "data" / "vol").is_dir()                                  # only --prune deletes data/vol
    mtime = (out / "data" / "viz" / "manifest_v2.json").stat().st_mtime_ns
    assert _run(fake_lib, out, "--viz-dir", str(viz_dir), "--prune") == 0   # unchanged manifest -> not rewritten
    assert (out / "data" / "viz" / "manifest_v2.json").stat().st_mtime_ns == mtime
    assert not (out / "data" / "vol").exists()


def test_viz_base_override(fake_lib, viz_dir, tmp_path, fake_vizpack):
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--viz-dir", str(viz_dir), "--viz-base", "http://127.0.0.1:8881/viz/") == 0
    assert _page_config(out)["viz"]["base"] == "http://127.0.0.1:8881/viz/"
    with pytest.raises(SystemExit):
        _run(fake_lib, out, "--viz-dir", str(viz_dir), "--viz-base", "https://example.org/no-slash")
    with pytest.raises(SystemExit):
        _run(fake_lib, out, "--viz-dir", str(viz_dir), "--viz-base", "javascript:alert(1)/")


@pytest.mark.parametrize("damage", ["not json {", "[]", '{"schema": "tng50-viz/1"}'])
def test_viz_invalid_manifest_gives_null(fake_lib, viz_dir, tmp_path, fake_vizpack, damage, capsys):
    (viz_dir / "manifest_v2.json").write_text(damage)
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--viz-dir", str(viz_dir)) == 0
    assert _page_config(out)["viz"] is None
    assert not (out / "data" / "viz").exists()
    assert "viz: null" in capsys.readouterr().out


def test_viz_without_vizpack_gives_null(fake_lib, viz_dir, tmp_path, monkeypatch):
    def no_vizpack(man, base_dir=None):
        raise ImportError("No module named 'tngsight.vizpack'")
    monkeypatch.setattr(EXP, "_validate_manifest_v2", no_vizpack)
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--viz-dir", str(viz_dir)) == 0
    assert _page_config(out)["viz"] is None


def test_viz_real_validator_rejects_garbage(fake_lib, viz_dir, tmp_path):
    pytest.importorskip("tngsight.vizpack")
    (viz_dir / "manifest_v2.json").write_text('{"schema": "tng50-viz/2"}')
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--viz-dir", str(viz_dir)) == 0
    assert _page_config(out)["viz"] is None


def test_viz_local_copies_cubes(fake_lib, viz_dir, tmp_path, fake_vizpack):
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--viz-dir", str(viz_dir), "--viz-local") == 0
    cfg = _page_config(out)
    assert cfg["viz"] == dict(VIZ_CFG, base="data/viz/", fallback_base="data/viz/")
    man = json.loads((viz_dir / "manifest_v2.json").read_text())
    files = EXP.manifest_files(man)
    assert len(files) == 15                                                 # 3 cubes x (4 WebP + gz)
    for rel in files:
        assert (out / "data" / "viz" / rel).read_bytes() == (viz_dir / rel).read_bytes()
    assert not (out / "data" / "viz" / "gas" / "manifest_gas.json").exists()
    assert not (out / "data" / "viz" / ".DS_Store").exists()
    # a corrupted cube is caught by the base_dir check -> viz null
    (viz_dir / files[0]).write_bytes(b"RIFF corrupted")
    out2 = tmp_path / "site2"
    assert _run(fake_lib, out2, "--viz-dir", str(viz_dir), "--viz-local") == 0
    assert _page_config(out2)["viz"] is None


def test_viz_local_refused_for_docs(fake_lib, viz_dir, fake_vizpack, capsys):
    with pytest.raises(SystemExit) as ei:
        EXP.main(["--library", str(fake_lib), "--out", str(ROOT / "docs" / "tng50"), "--local-url", "",
                  "--viz-dir", str(viz_dir), "--viz-local"])
    assert ei.value.code == 2 and "refused" in capsys.readouterr().err


def test_repo_has_no_phase2_volumes():
    """design-2b §6.4: docs/tng50/data/vol is gone and ignored; cube subdirs of data/viz are ignored."""
    assert not (ROOT / "docs" / "tng50" / "data" / "vol").exists()
    ign = (ROOT / ".gitignore").read_text().splitlines()
    assert "docs/tng50/data/vol/" in ign and "docs/tng50/data/viz/*/" in ign


@pytest.mark.skipif(not (LIB / "catalog.json").is_file(), reason="real library not present")
def test_real_library_p0_p1(tmp_path):
    from tngsight.library import load_npz
    ids = ["face_b050_a090", "edge_b100_a090", "edge_b050_a000", "rand_b052_a069", "rand_b031_a334_s175141482"]
    out = tmp_path / "site"
    v1 = (LIB / "web" / f"{ids[0]}.bin").read_bytes()[4] == 1                   # the v1 library until the switch-over
    assert _run(LIB, out, "--ids", ",".join(ids), "--viz-dir", str(tmp_path / "noviz"),
                "--components", str(tmp_path / "none.json"), *(["--allow-v1"] if v1 else [])) == 0
    ents = {e["id"]: e for e in json.loads((out / "data" / "catalog.json").read_text())["entries"]}
    assert set(ents) == set(ids)
    for sid in ids:
        g = load_npz(EXP.find_npz(LIB, sid), id=sid)["geom"]
        p0 = np.asarray(g["start_ckpch"]) / H - CENTER       # = start_kpc - center_kpc (design-2 §2)
        p1 = np.asarray(g["end_ckpch"]) / H - CENTER
        assert np.max(np.abs(np.asarray(ents[sid]["p0"]) - p0)) <= 0.005, sid
        assert np.max(np.abs(np.asarray(ents[sid]["p1"]) - p1)) <= 0.005, sid
        assert ents[sid]["has_components"] is False


def test_default_library_follows_tng_work(tmp_path, monkeypatch):
    """--library default: TNG_LIBRARY_DIR, else $TNG_WORK/data/library (TNG_WORK default /Volumes/cgm_work), with tngsight
    importable or not (the script's fallback repeats tngsight.config's rule)."""
    import tngsight
    for v in ("TNG_WORK", "TNG_LIBRARY_DIR"):
        monkeypatch.delenv(v, raising=False)
    for unimportable in (False, True):
        if unimportable:
            monkeypatch.delattr(tngsight, "config")
            monkeypatch.setitem(sys.modules, "tngsight.config", None)
        assert EXP.default_library() == Path("/Volumes/cgm_work/data/library")
        monkeypatch.setenv("TNG_WORK", str(tmp_path))
        assert EXP.default_library() == tmp_path / "data" / "library"
        monkeypatch.setenv("TNG_LIBRARY_DIR", str(tmp_path / "lib"))
        assert EXP.default_library() == tmp_path / "lib"
        monkeypatch.delenv("TNG_WORK"); monkeypatch.delenv("TNG_LIBRARY_DIR")
