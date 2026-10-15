"""The ion registry: the single source of the 12 CGM lines (Phase-3 design §1).

`tngsight/ions.json` holds, per ion, the key, labels, Trident line name or supplement entry, atomic data
(λ0, f, Γ, mass), ionisation potentials, colours, band, generation window and fitter bounds, plus the band
(R slider) ranges, the S/N range, the generation grid and the page defaults. Every Python consumer
(generate, library, vpfit, components, search, scoring, figure, style, volume), the server, the exporter
(CFG.ions) and the chat tools derive from this module. Pure: no yt/trident import.

    python -m tngsight.ions --check      # validate the file, print the registry tag
    python -m tngsight.ions --print      # print the keys in order
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path

C_KMS = 299792.458
SIGMA0 = 0.02654008                 # pi e^2 / (m_e c) [cm^2 s^-1]
SQRT_PI = math.sqrt(math.pi)
PATH = Path(__file__).resolve().parent / "ions.json"
SCHEMA = "tngsight-ions/1"
KEY_RE = re.compile(r"^[A-Z][a-z]?[IVX]+$")
_ION_FIELDS = ("key", "order", "ion", "element", "ion_state", "trident_line", "source", "lam0_A", "f", "gamma_s",
               "mass_amu", "ip_eV", "field", "label", "label_tex", "color", "color_dark", "band", "v_gen_kms",
               "damped", "fit", "score_w")
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _load(path=PATH) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def validate(reg: dict) -> dict:
    """Raise ValueError on any registry inconsistency (design §1.4 validation); returns reg."""
    def need(c, msg):
        if not c:
            raise ValueError(f"ions.json: {msg}")
    need(isinstance(reg, dict) and reg.get("schema") == SCHEMA, f"schema must be {SCHEMA!r}")
    for k in ("bands", "snr", "grid", "defaults", "ions"):
        need(k in reg, f"missing {k!r}")
    for name, b in reg["bands"].items():
        r = b.get("R") or {}
        need(all(isinstance(r.get(x), (int, float)) for x in ("min", "max", "default")), f"band {name}: R min/max/default")
        need(r["min"] < r["default"] < r["max"], f"band {name}: need min < default < max")
        p = r.get("pair")
        need(isinstance(p, list) and len(p) == 2 and all(r["min"] <= x <= r["max"] for x in p),
             f"band {name}: pair must be 2 values inside [min, max]")
        need(isinstance(b.get("R_eval"), (int, float)) and r["min"] <= b["R_eval"] <= r["max"], f"band {name}: R_eval")
    s = reg["snr"]
    need(s["min"] < s["default"] < s["max"] and len(s["pair"]) == 2 and all(s["min"] <= x <= s["max"] for x in s["pair"]),
         "snr range")
    ions = reg["ions"]
    need(isinstance(ions, list) and len(ions) == 12, "exactly 12 ions")
    keys = [i.get("key") for i in ions]
    need(len(set(keys)) == 12, "keys must be unique")
    for n, i in enumerate(ions):
        need(set(i) == set(_ION_FIELDS), f"ion {i.get('key')}: fields must be exactly {list(_ION_FIELDS)}")
        need(isinstance(i["key"], str) and bool(KEY_RE.match(i["key"])), f"ion {i['key']!r}: bad key")
        need(i["order"] == n, f"ion {i['key']}: order {i['order']} != position {n}")
        need(i["band"] in reg["bands"], f"ion {i['key']}: unknown band {i['band']!r}")
        need(i["source"] in ("trident", "supplement"), f"ion {i['key']}: source")
        need(i["ion"] == f"{i['element']} {i['ion_state']}", f"ion {i['key']}: ion != element + state")
        need(i["key"] == i["element"] + i["ion_state"], f"ion {i['key']}: key != element + state")
        for f in ("lam0_A", "f", "gamma_s", "mass_amu", "v_gen_kms", "score_w"):
            need(isinstance(i[f], (int, float)) and math.isfinite(i[f]) and i[f] > 0, f"ion {i['key']}: {f}")
        need(len(i["ip_eV"]) == 2 and i["ip_eV"][0] < i["ip_eV"][1], f"ion {i['key']}: ip_eV")
        need(bool(_HEX.match(i["color"])) and bool(_HEX.match(i["color_dark"])), f"ion {i['key']}: colours")
        need(not re.search("[·•‧⋅・]", i["label"]) and not re.search(r"\.(?!\d)", i["label"]),
             f"ion {i['key']}: label separators (only decimal points may contain a dot)")
        need(isinstance(i["damped"], bool), f"ion {i['key']}: damped must be a bool")
        fit = i["fit"]
        need(set(fit) == {"b_min", "logN_max"} and 0 < fit["b_min"] < 50 and 10 < fit["logN_max"] <= 25,
             f"ion {i['key']}: fit bounds")
    need(sum(1 for i in ions if i["damped"]) == 1, "exactly one damped ion")
    for i in ions:
        if i["source"] == "supplement":
            need(_supplement_entry(i) is not None, f"ion {i['key']}: not in absreq/data/supplement_lines.txt")
    d = reg["defaults"]
    need(d.get("ions") and all(k in keys for k in d["ions"]), "defaults.ions must be registry keys")
    need(d.get("layout") in ("1", "2R", "2SN", "4"), "defaults.layout")
    g = reg["grid"]
    for f in ("dv_native_kms", "dv_web_kms", "v_gen_kms", "min_tau", "damped_tau_edge", "damped_v_max_kms",
              "damped_v_step_kms", "damped_logN_min"):
        need(isinstance(g.get(f), (int, float)) and g[f] > 0, f"grid.{f}")
    return reg


def _supplement_file() -> Path:
    return Path(__file__).resolve().parent.parent / "absreq" / "data" / "supplement_lines.txt"


def _supplement_entry(ion: dict):
    """(λ, Γ, f) of the supplement line matching ion (element, state, λ within 1e-3 Å), or None. The registry's
    own values are authoritative at run time (the file is checked only when it is present, i.e. in a checkout)."""
    p = _supplement_file()
    if not p.is_file():
        return (ion["lam0_A"], ion["gamma_s"], ion["f"])
    for line in p.read_text().splitlines():
        t = line.split()
        if line.startswith("#") or len(t) < 5:
            continue
        if t[0] == ion["element"] and t[1] == ion["ion_state"] and abs(float(t[2]) - ion["lam0_A"]) < 1e-3:
            return float(t[2]), float(t[3]), float(t[4])
    return None


REGISTRY: dict = validate(_load())
KEYS: tuple = tuple(i["key"] for i in REGISTRY["ions"])
BANDS: dict = REGISTRY["bands"]
SNR: dict = REGISTRY["snr"]
GRID: dict = REGISTRY["grid"]
DEFAULTS: dict = REGISTRY["defaults"]
_BY_KEY = {i["key"]: i for i in REGISTRY["ions"]}
DAMPED_KEY: str = next(i["key"] for i in REGISTRY["ions"] if i["damped"])


def get(key) -> dict:
    try:
        return _BY_KEY[key]
    except (KeyError, TypeError):
        raise KeyError(f"unknown ion key {key!r}; known: {', '.join(KEYS)}") from None


def band(key) -> dict:
    return BANDS[get(key)["band"]]


def atomic(key) -> dict:
    """vpfit's ATOMIC record of one ion: {"lam0","f","gamma","mass_amu","b_min","logN_max"}."""
    i = get(key)
    return {"lam0": i["lam0_A"], "f": i["f"], "gamma": i["gamma_s"], "mass_amu": i["mass_amu"],
            "b_min": i["fit"]["b_min"], "logN_max": i["fit"]["logN_max"]}


def k_tau(key) -> float:
    """tau = k_tau * N * H(a, u) / b[km/s]."""
    i = get(key)
    return SIGMA0 * i["f"] * i["lam0_A"] * 1e-8 / (SQRT_PI * 1e5)


def a0(key) -> float:
    """Damping parameter a = a0 / b[km/s]."""
    i = get(key)
    return i["gamma_s"] * i["lam0_A"] * 1e-8 / (4.0 * math.pi * 1e5)


def hi_window(logN) -> float:
    """Half-window W (km/s) of the damped ion (design §2.1): clip(step*ceil(sqrt(K_w N/tau_edge)/step), 1500, v_max),
    K_w = k_tau a0/sqrt(pi) (the Lorentzian wing tau(dv) = K_w N/dv^2). 1500 when logN <= damped_logN_min or not finite."""
    base = float(get(DAMPED_KEY)["v_gen_kms"])
    try:
        logN = float(logN)
    except (TypeError, ValueError):
        return base
    if not math.isfinite(logN) or logN <= GRID["damped_logN_min"]:
        return base
    kw = k_tau(DAMPED_KEY) * a0(DAMPED_KEY) / SQRT_PI
    step = float(GRID["damped_v_step_kms"])
    w = step * math.ceil(math.sqrt(kw * 10.0 ** logN / GRID["damped_tau_edge"]) / step)
    return float(min(max(w, base), float(GRID["damped_v_max_kms"])))


def gen_window(key, logN=None) -> float:
    """Generation half-window W (km/s) of ion `key` for a ray column logN."""
    i = get(key)
    return hi_window(logN) if i["damped"] else float(i["v_gen_kms"])


def registry_tag(reg=None) -> str:
    """sha1[:12] of the canonical JSON of the registry."""
    r = REGISTRY if reg is None else reg
    return hashlib.sha1(json.dumps(r, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]


def add_supplement_lines(line_db) -> list:
    """Add every "source": "supplement" ion (O VII) to a trident LineDatabase, once (idempotent by identifier).
    Returns the identifiers added."""
    added = []
    have = {getattr(l, "identifier", None) for l in getattr(line_db, "lines_all", [])}
    for i in REGISTRY["ions"]:
        if i["source"] != "supplement" or i["trident_line"] in have:
            continue
        line_db.add_line(i["element"], i["ion_state"], i["lam0_A"], i["gamma_s"], i["f"],
                         field=i["field"], identifier=i["trident_line"])
        added.append(i["trident_line"])
    return added


_PAGE_FIELDS = ("key", "order", "ion", "label", "lam0_A", "f", "gamma_s", "mass_amu", "band", "color", "color_dark",
                "damped", "fit")


def page_ions() -> list:
    """What the page's CFG.ions carries, per ion in registry order."""
    return [{k: (dict(i[k]) if isinstance(i[k], dict) else i[k]) for k in _PAGE_FIELDS} for i in REGISTRY["ions"]]


def label_wavelength(key) -> str:
    """The label's wavelength part, e.g. '1032' or '21.6'."""
    return get(key)["label"].split()[-1]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="tngsight ion registry")
    ap.add_argument("--check", action="store_true", help="validate tngsight/ions.json")
    ap.add_argument("--print", action="store_true", help="print the keys in order")
    a = ap.parse_args(argv)
    if a.check:
        validate(_load())
        print(f"ok: {len(KEYS)} ions, registry_tag {registry_tag()}")
    if a.print:
        print(" ".join(KEYS))
    if not (a.check or a.print):
        ap.error("nothing to do (use --check or --print)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
