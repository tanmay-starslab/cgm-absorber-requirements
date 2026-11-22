"""Tests for multi-simulation (TNG50 + FIRE-2) galaxy IDs in server/galaxies.py and deploy/data/upload_galaxies.py."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from server import galaxies as GX
from tests.test_server_galaxies import (
     FakeFetcher,
    GID,
    GID2,
    MB,
    ROOT,
    client,
    fake_record,
    libdir,
    root,
    src,
    warm,
)

spec = importlib.util.spec_from_file_location("upload_galaxies", ROOT / "deploy" / "data" / "upload_galaxies.py")
UP = importlib.util.module_from_spec(spec)
spec.loader.exec_module(UP)


def test_gal_id_re_and_check_galaxy_multisim():
    assert GX.GAL_ID_RE.pattern == r"^(?:[0-9]{1,9}|[A-Za-z][A-Za-z0-9_]{1,23})$"
    assert UP.GAL_ID_RE.pattern == GX.GAL_ID_RE.pattern
    # Numeric TNG50 IDs
    assert GX.check_galaxy(488530) == "488530"
    assert GX.check_galaxy("00488530") == "488530"
    # FIRE-2 alphanumeric IDs
    for fid in ("m12i", "m12b", "m12f", "Romeo", "Juliet", "Romulus", "Remus", "Thelma", "Louise", "m12i_res7100"):
        assert GX.check_galaxy(fid) == fid
        assert UP.norm_gid(fid) == fid
    # Invalid IDs
    for bad in ("", "x", "9m12i", "1234567890", "m12i-bad", "../m12i", "a" * 25):
        with pytest.raises(ValueError):
            GX.check_galaxy(bad)
        with pytest.raises(ValueError):
            UP.norm_gid(bad)


def test_upload_galaxies_allow_list_and_sorting_multisim(tmp_path):
    for gid in ("488530", "900001", "m12i", "Romeo"):
        assert UP.PACK_RE.fullmatch(f"{gid}/galaxy.json")
        assert UP.PACK_RE.fullmatch(f"{gid}/catalog.json")
        assert UP.PACK_RE.fullmatch(f"{gid}/components.json")
        assert UP.PACK_RE.fullmatch(f"{gid}/s/edge_b100_a090.bin")
        assert UP.PACK_RE.fullmatch(f"{gid}/viz/manifest_v2.json")
        assert UP.CUTOUT_RE.fullmatch(f"{gid}/cutout_slim_R400.hdf5")
        assert UP.CUTOUT_RE.fullmatch(f"{gid}/galaxy.json")
        assert UP.HEAVY_RE.match(f"{gid}/cutout_slim_R400.hdf5")
        assert 0 <= UP.shard(gid) < UP.N_SHARDS

    for d in ("900002", "512345", "m12i", "Romeo", "488530"):
        (tmp_path / d).mkdir()
    class Args:
        ids = None
        ids_file = None
        include_reference = False
    assert UP.galaxy_ids(Args, tmp_path) == [512345, 900002, "Romeo", "m12i"]


def test_server_routes_and_open_ids_with_fire2_galaxy(libdir, src):
    fgid = "m12i"
    d = src / "gal" / fgid
    d.mkdir(parents=True)
    frec = {**fake_record(GID), "sim": "FIRE-2", "subhalo_id": fgid}
    (d / GX.META_NAME).write_text(json.dumps(frec))
    (d / GX.CUTOUT_NAME).write_bytes(b"\0" * MB)

    with client(libdir, FakeFetcher(src)) as c:
        warm(c)
        assert c.get(f"/api/catalog?g={GID}").status_code == 200
        r = c.get(f"/api/catalog?g={fgid}")
        assert r.status_code == 200
        doc = r.json()
        assert doc["galaxy"]["subhalo_id"] == fgid and doc["galaxy"]["sim"] == "FIRE-2"
        body = {"orientation": "face-on", "b_kpc": 50, "azimuth_deg": 90}
        g_res = c.post(f"/api/geometry?g={fgid}", json=body)
        assert g_res.status_code == 200 and g_res.json()["galaxy"] == fgid
        h = c.get("/api/health").json()["galaxies"]
        assert h["open"] == ["488530", GID, fgid]
