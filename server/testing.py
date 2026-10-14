"""FakeGenerator: a yt-free stand-in with the real Generator interface, producing a payload with the
exact load_npz() layout (real wavelength grids and geometry, synthetic Gaussian τ). Used by the
tests and for frontend development (`TNG_GENERATOR=server.testing:FakeGenerator`). Its spectra are
NOT physical; never deploy it."""
from __future__ import annotations
import time
import zlib

import numpy as np

STAGES = ("ray", "spectrum:OVI", "spectrum:HILyb", "spectrum:CIII", "save")


class FakeGenerator:
    def __init__(self, cutout=None, ion_table_dir=None, index_filename=None, workdir=None,
                 delay=0.0, fail_on=None):
        self.delay, self.fail_on, self.loaded, self.calls = float(delay), fail_on, False, 0

    def load(self, progress=None):
        if progress:
            progress("load", 1.0, "fake dataset")
        self.loaded = True

    def generate(self, geom: dict, progress=None) -> dict:
        from tngsight.config import LINE_KEYS, LINES, C_KMS
        from tngsight.geometry import make_sightline
        from tngsight.library import wavelength_grid
        self.calls += 1
        cb = progress or (lambda *a: None)
        if self.fail_on and geom["id"] == self.fail_on:
            raise RuntimeError(f"fake failure for {geom['id']}")
        g = make_sightline(geom["orientation"], float(geom["b_kpc"]), float(geom["azimuth_deg"]),
                           seed=geom.get("seed"))
        rng = np.random.default_rng(zlib.crc32(geom["id"].encode()))
        cb("ray", 0.1, "fake ray")
        lam, tau, rest, logN = {}, {}, {}, {}
        for i, k in enumerate(LINE_KEYS):
            if self.delay:
                time.sleep(self.delay)
            r = float(LINES[k]["rest_A"])
            lam[k] = wavelength_grid(k)
            v = C_KMS * (lam[k].astype(np.float64) / r - 1) + g["v_sys_kms"]
            t = np.zeros_like(v)
            for _ in range(int(rng.integers(1, 4))):
                t += rng.uniform(0.2, 2.0) * np.exp(-0.5 * ((v - rng.uniform(-200, 200)) / rng.uniform(10, 40)) ** 2)
            tau[k], rest[k] = t.astype(np.float32), r
            logN[k] = float(13.0 + rng.uniform(0, 2))
            cb(f"spectrum:{k}", 0.2 + 0.25 * (i + 1), f"fake {k}")
        cb("save", 0.98, "fake save")
        return {"id": geom["id"], "geom": g, "v_sys": float(g["v_sys_kms"]), "logN": logN,
                "lam": lam, "tau": tau, "rest": rest}


class SlowFakeGenerator(FakeGenerator):
    def __init__(self, **kw):
        kw.setdefault("delay", 0.3)
        super().__init__(**kw)


class BrokenLoadGenerator(FakeGenerator):
    def load(self, progress=None):
        raise RuntimeError("cutout missing (fake)")
