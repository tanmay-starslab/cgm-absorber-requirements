"""FakeGenerator: a yt-free stand-in with the real Generator interface, producing a v2 payload with the
exact tngsight.library.load_npz() layout (design.md §2.3): all registry lines on their true native grids
(tngsight.library.native_grid, window tngsight.ions.gen_window), real geometry, synthetic Gaussian τ,
and generation.registry_tag. Used by the tests and for frontend development
(`TNG_GENERATOR=server.testing:FakeGenerator`). Its spectra are NOT physical; never deploy it.

Geometry: orientation dicts (canonicalize) and custom rays (canonicalize_endpoints, kind "endpoints").
Stage "fit" (between the spectra and "save"): components="auto" uses the real
tngsight.components.fit_payload when that module implements catalogue v2, else "fake" components read
off the injected Gaussians (valid v2 shape, not a fit); "real" forces the real fitter (skipped if absent);
"fake" always uses the fake ones; None skips the stage like Generator(fit_components=False)."""
from __future__ import annotations
import time
import zlib

import numpy as np

SIGMA0 = 0.02654008                  # pi e^2 / (m_e c) [cm^2 s^-1]
C_KMS = 299792.458
_trapz = getattr(np, "trapezoid", None) or np.trapz


def stages() -> tuple:
    """Progress stage names, identical to tngsight.generate.STAGES (design.md §3.2)."""
    from tngsight.ions import KEYS
    return ("load", "ray", *(f"spectrum:{k}" for k in KEYS), "fit", "save")


def __getattr__(name):
    if name == "STAGES":
        return stages()
    raise AttributeError(name)


class FakeGenerator:
    def __init__(self, cutout=None, ion_table_dir=None, index_filename=None, workdir=None,
                 delay=0.0, fail_on=None, components="auto", logN=None):
        self.delay, self.fail_on, self.loaded, self.calls = float(delay), fail_on, False, 0
        self.components = components
        self.logN = dict(logN or {})               # per-key ray column override (e.g. a damped H I)

    def load(self, progress=None):
        if progress:
            progress("load", 1.0, "fake dataset")
        self.loaded = True

    def generate(self, geom: dict, progress=None) -> dict:
        from tngsight import ions
        from tngsight.geometry import make_endpoints, make_sightline
        from tngsight.library import native_grid
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
        v_sys = float(g["v_sys_kms"])
        keys = list(ions.KEYS)
        out = {k: {} for k in ("logN", "tau", "rest", "W", "lam0", "dlam", "lam", "u", "du")}
        gauss = {}
        for i, k in enumerate(keys):
            if self.delay:
                time.sleep(self.delay)
            logN = float(self.logN.get(k, 13.0 + rng.uniform(0, 2)))
            W = float(ions.gen_window(k, logN))
            lam0, dlam, n = native_grid(k, W)
            rest = float(ions.get(k)["lam0_A"])
            lam = lam0 + np.arange(n) * dlam
            u = C_KMS * (lam / rest - 1.0)
            v = u + v_sys
            t = np.zeros(n)
            gauss[k] = []
            for _ in range(int(rng.integers(1, 4))):
                amp, vc, sig = rng.uniform(0.2, 2.0), rng.uniform(-200, 200), rng.uniform(10, 40)
                t += amp * np.exp(-0.5 * ((v - vc) / sig) ** 2)
                gauss[k].append((amp, vc, sig))
            out["logN"][k], out["tau"][k], out["rest"][k], out["W"][k] = logN, t.astype(np.float32), rest, W
            out["lam0"][k], out["dlam"][k], out["lam"][k] = float(lam0), float(dlam), lam
            out["u"][k], out["du"][k] = u, C_KMS * dlam / rest
            cb(f"spectrum:{k}", 0.15 + 0.7 * (i + 1) / len(keys), f"fake {k}")
        payload = {"id": geom["id"], "geom": g, "v_sys": v_sys, "format": 2, "lines": keys,
                   "generation": {"min_tau": 1e-8, "dv_kms": 0.25, "trident": "fake",
                                  "ion_table": "fake", "registry_tag": ions.registry_tag()},
                   **out}
        if self.components is not None:
            self._fit(payload, gauss, cb)
        cb("save", 0.98, "fake save")
        return payload

    def _fit(self, payload, gauss, cb):
        """Stage "fit": the real (v2) fitter when available (mode auto/real), else fake components."""
        mode = self.components
        if mode in ("auto", "real"):
            try:
                from tngsight import components as _real
                have = getattr(_real, "CATALOGUE_VERSION", 1) >= 2
            except ImportError:
                have = False
            if have or mode == "real":
                from tngsight.generate import fit_stage    # the production hook (guarded)
                fit_stage(payload, cb)
                return
        cb("fit", 0.0, "fake components")
        payload["components"], payload["components_aod"] = fake_components(gauss, aod=True)
        cb("fit", 1.0, "fake components")


def fake_components(gauss: dict, aod=False):
    """{ion: [comp dict]} (components v2 dict form) from the injected Gaussians (amp τ0, centre v, σ):
    b = √2·σ, logN from τ0 = N·SIGMA0·f·λ0/(√π·b), EW of the Gaussian, one region per ion. With aod=True
    also returns the v2 AOD record {ion: [logN_total, [[0, v_lo, v_hi, logN_region]]]}. Deterministic;
    NOT a Voigt fit."""
    from tngsight import ions
    out, rec = {}, {}
    for k, comps in gauss.items():
        L = ions.get(k)
        lam0, f = float(L["lam0_A"]), float(L["f"])
        n_hi = float(L["fit"]["logN_max"])
        rows, N_tot = [], 0.0
        for amp, vc, sig in comps:
            b = float(np.sqrt(2.0) * sig)
            N = amp * np.sqrt(np.pi) * b * 1e5 / (SIGMA0 * f * lam0 * 1e-8)
            N_tot += N
            vv = np.linspace(vc - 8 * sig, vc + 8 * sig, 801)
            ew = lam0 / C_KMS * _trapz(1 - np.exp(-amp * np.exp(-0.5 * ((vv - vc) / sig) ** 2)), vv) * 1e3
            rows.append({"v": round(float(vc), 2), "dv": 0.1, "logN": round(float(np.clip(np.log10(N), 10, n_hi)), 3),
                         "dlogN": 0.01, "b": round(b, 2), "db": 0.2, "region": 0, "flag": 0,
                         "EW": round(float(ew), 2)})
        rows.sort(key=lambda c: (c["v"], -c["logN"]))
        out[k] = rows
        if comps:
            lo = min(vc - 4 * sig for _, vc, sig in comps)
            hi = max(vc + 4 * sig for _, vc, sig in comps)
            lt = round(float(np.log10(N_tot)), 3)
            rec[k] = [lt, [[0, round(float(lo), 1), round(float(hi), 1), lt]]]
        else:
            rec[k] = [None, []]
    return (out, rec) if aod else out


class SlowFakeGenerator(FakeGenerator):
    def __init__(self, **kw):
        kw.setdefault("delay", 0.075)        # 12 lines: ~0.9 s per sightline, as before
        super().__init__(**kw)


class BrokenLoadGenerator(FakeGenerator):
    def load(self, progress=None):
        raise RuntimeError("cutout missing (fake)")
