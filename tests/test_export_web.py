"""scripts/export_tng50_web.py (design-2 §7.6, §7.9): p0/p1 from the npz geom, components + volume copies,
has_components, custom ids only with --include-generated, page config keys, js copy. Output always into tmp."""
from __future__ import annotations
import hashlib, importlib.util, json, struct, sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("export_tng50_web", ROOT / "scripts" / "export_tng50_web.py")
EXP = importlib.util.module_from_spec(spec); spec.loader.exec_module(EXP)
GAL = json.loads((ROOT / "tngsight" / "galaxy_488530.json").read_text())
CENTER, H = np.asarray(GAL["center_kpc"]), GAL["TNG_H"]
LIB = Path("/Volumes/cgm_work/data/library")


def _page_config(out: Path) -> dict:
    html = (out / "index.html").read_text(encoding="utf-8")
    start = html.index("const DATA = ") + len("const DATA = ")
    return json.loads(html[start:html.index(";\n", start)])


def _bin() -> bytes:
    """smallest valid TNGS web binary (3 lines of 4 pixels)"""
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
    (lib / "catalog.json").write_text(json.dumps({"version": 1, "galaxy": {"R200c_kpc": 246.35}, "lines": {}, "entries": ents}))
    (lib / "web" / "edge_b100_a090.bin").write_bytes(_bin()); (lib / "web" / "face_b050_a000.bin").write_bytes(_bin())
    (lib / "generated" / "rand_b075_a000_s12345.bin").write_bytes(_bin()); (lib / "generated" / "cust_35277e0469.bin").write_bytes(_bin())
    _geom_npz(lib / "sightlines" / "cgm_sid488530_edge_b100_a090.npz", [10.123, -200.456, 30.0], [-10.0, 180.004, -25.5])
    _geom_npz(lib / "generated" / "rand_b075_a000_s12345.npz", [-300.0, 1.0, 2.0], [250.0, -3.0, 4.0])
    # face_b050_a000 deliberately has no npz -> p0/p1 absent and reported
    comps = {"version": 1, "fitter": "tngsight.vpfit/1", "params_tag": "x", "params": {},
             "entries": {"edge_b100_a090": {"OVI": [], "HILyb": [], "CIII": []}, "cust_35277e0469": {"OVI": [], "HILyb": [], "CIII": []}}}
    (lib / "components.json").write_text(json.dumps(comps, separators=(",", ":")))
    return lib


def _run(lib, out, *extra):
    return EXP.main(["--library", str(lib), "--out", str(out), "--local-url", "", *extra])


def test_fake_library_export(fake_lib, tmp_path, capsys):
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--vol-dir", str(tmp_path / "novol")) == 0
    cat = json.loads((out / "data" / "catalog.json").read_text())
    ids = {e["id"]: e for e in cat["entries"]}
    assert set(ids) == {"edge_b100_a090", "face_b050_a000"}          # generated + custom only with --include-generated
    e = ids["edge_b100_a090"]
    assert e["p0"] == [10.12, -200.46, 30.0] and e["p1"] == [-10.0, 180.0, -25.5]
    assert "p0" not in ids["face_b050_a000"] and "without p0/p1" in capsys.readouterr().out
    assert e["has_components"] is True and ids["face_b050_a000"]["has_components"] is False
    assert (out / "data" / "components.json").read_bytes() == (fake_lib / "components.json").read_bytes()
    cfg = _page_config(out)
    assert cfg["vol"] is None and cfg["vol_url"] == "data/vol/" and cfg["components_url"] == "data/components.json"
    assert cfg["three"] == "0.169.0" and cfg["chat"] == {"enabled": False, "webllm": "0.2.85", "model": "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"}
    assert cfg["custom"] == {"r_max_kpc": 395, "l_min_kpc": 20, "l_max_kpc": 800}
    assert set(cfg["frame"]) == {"Lhat", "xhat", "yhat", "R200c_kpc"} and cfg["frame"]["Lhat"] == GAL["Lhat"]
    js = sorted(p.name for p in (out / "js").glob("*.js"))
    assert {"viewer3d.js", "picker.js", "search.js"} <= set(js)
    for name in js:
        assert (out / "js" / name).read_bytes() == (ROOT / "docs" / "tng50" / "js" / name).read_bytes()
    assert not (out / "data" / "vol").exists()


def test_include_generated_and_custom(fake_lib, tmp_path):
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--include-generated", "--chat", "--vol-dir", str(tmp_path / "novol")) == 0
    ids = {e["id"]: e for e in json.loads((out / "data" / "catalog.json").read_text())["entries"]}
    assert set(ids) == {"edge_b100_a090", "face_b050_a000", "rand_b075_a000_s12345", "cust_35277e0469"}
    assert ids["cust_35277e0469"]["p0"] == [-100.0, 0.0, 0.0]                     # catalogue p0/p1 kept as is
    assert ids["rand_b075_a000_s12345"]["p0"] == [-300.0, 1.0, 2.0]               # from generated/<id>.npz
    assert ids["cust_35277e0469"]["has_components"] and not ids["rand_b075_a000_s12345"]["has_components"]
    assert _page_config(out)["chat"]["enabled"] is True
    assert (out / "data" / "s" / "cust_35277e0469.bin").is_file()


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


def test_volume_copy_and_sha_check(fake_lib, tmp_path):
    V = pytest.importorskip("tngsight.volume")
    vol = tmp_path / "vol"
    n = 16
    i, j, k = np.meshgrid(*(np.arange(n),) * 3, indexing="ij")
    vals = 10.0 ** (-5 + 3 * ((i + 2 * j + 3 * k) % 17) / 16)
    entry = V.write_field(vol, "nH", vals, np.ones(vals.shape, bool))
    V.write_manifest(vol, {"nH": entry}, {"n": n})
    out = tmp_path / "site"
    assert _run(fake_lib, out, "--vol-dir", str(vol)) == 0
    man = json.loads((out / "data" / "vol" / "manifest.json").read_text())
    for res, name in man["fields"]["nH"]["files"].items():
        assert hashlib.sha256((out / "data" / "vol" / name).read_bytes()).hexdigest() == man["fields"]["nH"]["sha256"][res]
    assert _page_config(out)["vol"] == {"keys": ["nH"], "grids": ["8", "16"]}
    # a corrupted file is refused: no copy, vol null
    name = man["fields"]["nH"]["files"]["16"]
    (vol / name).write_bytes(b"\x1f\x8b corrupted")
    out2 = tmp_path / "site2"
    assert _run(fake_lib, out2, "--vol-dir", str(vol)) == 0
    assert _page_config(out2)["vol"] is None and not (out2 / "data" / "vol").exists()


@pytest.mark.skipif(not (LIB / "catalog.json").is_file(), reason="real library not present")
def test_real_library_p0_p1(tmp_path):
    from tngsight.library import load_npz
    ids = ["face_b050_a090", "edge_b100_a090", "edge_b050_a000", "rand_b052_a069", "rand_b031_a334_s175141482"]
    out = tmp_path / "site"
    assert _run(LIB, out, "--ids", ",".join(ids), "--vol-dir", str(tmp_path / "novol"), "--components", str(tmp_path / "none.json")) == 0
    ents = {e["id"]: e for e in json.loads((out / "data" / "catalog.json").read_text())["entries"]}
    assert set(ents) == set(ids)
    for sid in ids:
        g = load_npz(EXP.find_npz(LIB, sid), id=sid)["geom"]
        p0 = np.asarray(g["start_ckpch"]) / H - CENTER       # = start_kpc - center_kpc (design-2 §2)
        p1 = np.asarray(g["end_ckpch"]) / H - CENTER
        assert np.max(np.abs(np.asarray(ents[sid]["p0"]) - p0)) <= 0.005, sid
        assert np.max(np.abs(np.asarray(ents[sid]["p1"]) - p1)) <= 0.005, sid
        assert ents[sid]["has_components"] is False
