"""FakeGenerator: a yt-free stand-in with the real Generator interface, producing a payload with the
exact load_npz() layout (real wavelength grids and geometry, synthetic Gaussian τ). Used by the
tests and for frontend development (`TNG_GENERATOR=server.testing:FakeGenerator`). Its spectra are
NOT physical; never deploy it.

Geometry: orientation dicts (canonicalize) and custom rays (canonicalize_endpoints, kind "endpoints").
Stage "fit" (between the spectra and "save"): components="auto" uses the real
tngsight.components.fit_payload when that module is importable, else "fake" components read off the
injected Gaussians (valid §5.3 shape, not a fit); "real" forces the real fitter (skipped if absent);
None skips the stage like Generator(fit_components=False)."""
from __future__ import annotations
import time
import zlib

import numpy as np

STAGES = ("ray", "spectrum:OVI", "spectrum:HILyb", "spectrum:CIII", "fit", "save")
SIGMA0 = 0.02654008                  # pi e^2 / (m_e c) [cm^2 s^-1]


class FakeGenerator:
    def __init__(self, cutout=None, ion_table_dir=None, index_filename=None, workdir=None,
                 delay=0.0, fail_on=None, components="auto"):
        self.delay, self.fail_on, self.loaded, self.calls = float(delay), fail_on, False, 0
        self.components = components

    def load(self, progress=None):
        if progress:
            progress("load", 1.0, "fake dataset")
        self.loaded = True

    def generate(self, geom: dict, progress=None) -> dict:
        from tngsight.config import LINE_KEYS, LINES, C_KMS
        from tngsight.geometry import make_endpoints, make_sightline
        from tngsight.library import wavelength_grid
        self.calls += 1
        cb = progress or (lambda *a: None)
        if self.fail_on and geom["id"] == self.fail_on:
            raise RuntimeError(f"fake failure for {geom['id']}")
        if geom.get("kind") == "endpoints":
            g = make_endpoints(geom["p0_kpc"], geom["p1_kpc"])
        else:
            g = make_sightline(geom["orientation"], float(geom["b_kpc"]), float(geom["azimuth_deg"]),
                               seed=geom.get("seed"))
        rng = np.random.default_rng(zlib.crc32(geom["id"].encode()))
        cb("ray", 0.1, "fake ray")
        lam, tau, rest, logN, gauss = {}, {}, {}, {}, {}
        for i, k in enumerate(LINE_KEYS):
            if self.delay:
                time.sleep(self.delay)
            r = float(LINES[k]["rest_A"])
            lam[k] = wavelength_grid(k)
            v = C_KMS * (lam[k].astype(np.float64) / r - 1) + g["v_sys_kms"]
            t = np.zeros_like(v)
            gauss[k] = []
            for _ in range(int(rng.integers(1, 4))):
                amp, vc, sig = rng.uniform(0.2, 2.0), rng.uniform(-200, 200), rng.uniform(10, 40)
                t += amp * np.exp(-0.5 * ((v - vc) / sig) ** 2)
                gauss[k].append((amp, vc, sig))
            tau[k], rest[k] = t.astype(np.float32), r
            logN[k] = float(13.0 + rng.uniform(0, 2))
            cb(f"spectrum:{k}", 0.2 + 0.25 * (i + 1), f"fake {k}")
        payload = {"id": geom["id"], "geom": g, "v_sys": float(g["v_sys_kms"]), "logN": logN,
                   "lam": lam, "tau": tau, "rest": rest}
        if self.components is not None:
            self._fit(payload, gauss, cb)
        cb("save", 0.98, "fake save")
        return payload

    def _fit(self, payload, gauss, cb):
        """Stage "fit": the real fitter when available (mode auto/real), else fake components."""
        mode = self.components
        if mode in ("auto", "real"):
            try:
                from tngsight import components as _real   # noqa: F401  (U_fit module)
                have = True
            except ImportError:
                have = False
            if have or mode == "real":
                from tngsight.generate import fit_stage    # the production hook (guarded)
                fit_stage(payload, cb)
                return
        cb("fit", 0.0, "fake components")
        payload["components"] = fake_components(gauss)
        cb("fit", 1.0, "fake components")


def fake_components(gauss: dict) -> dict:
    """{ion: [comp]} (§5.3 shape) from the injected Gaussians (amp τ0, centre v, σ): b = √2·σ,
    logN from τ0 = N·SIGMA0·f·λ0/(√π·b), EW of the Gaussian. Deterministic; NOT a Voigt fit."""
    from tngsight.config import C_KMS, LINES
    out = {}
    for k, comps in gauss.items():
        L = LINES[k]
        lam0, f = float(L["rest_A"]), float(L.get("f", L.get("f_value", 0.1)))
        rows = []
        for amp, vc, sig in comps:
            b = float(np.sqrt(2.0) * sig)
            N = amp * np.sqrt(np.pi) * b * 1e5 / (SIGMA0 * f * lam0 * 1e-8)
            vv = np.linspace(vc - 8 * sig, vc + 8 * sig, 801)
            ew = lam0 / C_KMS * np.trapz(1 - np.exp(-amp * np.exp(-0.5 * ((vv - vc) / sig) ** 2)), vv) * 1e3
            rows.append({"v": round(float(vc), 2), "dv": 0.1, "logN": round(float(np.clip(np.log10(N), 10, 19)), 3),
                         "dlogN": 0.01, "b": round(b, 2), "db": 0.2, "region": 0, "flag": 0,
                         "EW": round(float(ew), 2)})
        rows.sort(key=lambda c: (c["v"], -c["logN"]))
        out[k] = rows
    return out


class SlowFakeGenerator(FakeGenerator):
    def __init__(self, **kw):
        kw.setdefault("delay", 0.3)
        super().__init__(**kw)


class BrokenLoadGenerator(FakeGenerator):
    def load(self, progress=None):
        raise RuntimeError("cutout missing (fake)")
