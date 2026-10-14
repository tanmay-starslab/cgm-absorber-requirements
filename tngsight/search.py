"""Deterministic sightline search over fitted Voigt components (phase-2 design §6).

Python mirror of docs/tng50/js/search.js; the two must agree exactly (ids, order, n, pairs, reasons; score to
1e-9). The exact semantics, with golden cases, are in tests/search_golden.json (written by `--golden`).

    python -m tngsight.search --schema OUT.json        # QUERY_SCHEMA as JSON
    python -m tngsight.search --fixture OUT.json       # the synthetic 40-entry fixture
    python -m tngsight.search --reference OUT.json     # fixed cases over the fixture with their outputs
    python -m tngsight.search --golden OUT.json        # semantics + fixture path + cases (tests/search_golden.json)
"""
from __future__ import annotations
import argparse
import json
import math
import sys
from pathlib import Path

ION_KEYS = ("OVI", "HILyb", "CIII")
ION_SHORT = {"OVI": "O VI", "HILyb": "H I", "CIII": "C III"}
ORIENTATIONS = ("face-on", "edge-on", "random", "custom")
SORTS = ("score", "b_kpc", "n")
DEFAULTS = {"n_min": 1, "sort": "score", "limit": 50}
EN_DASH = "–"
DELTA = "Δ"
MAX_PAIRS = 10

QUERY_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["ion"],
    "properties": {
        "ion": {"type": "string", "enum": list(ION_KEYS)},
        "n_min": {"type": "integer", "minimum": 0, "maximum": 30},
        "n_max": {"type": "integer", "minimum": 0, "maximum": 30},
        "sep_kms": {"type": "array", "items": {"type": "number", "minimum": 0, "maximum": 3000},
                    "minItems": 2, "maxItems": 2},
        "logN_min": {"type": "number", "minimum": 10, "maximum": 19},
        "logN_max": {"type": "number", "minimum": 10, "maximum": 19},
        "b_min": {"type": "number", "minimum": 0, "maximum": 150},
        "b_max": {"type": "number", "minimum": 0, "maximum": 150},
        "b_kpc": {"type": "array", "items": {"type": "number", "minimum": 0, "maximum": 400},
                  "minItems": 2, "maxItems": 2},
        "orientation": {"type": "string", "enum": list(ORIENTATIONS)},
        "sort": {"type": "string", "enum": list(SORTS)},
        "limit": {"type": "integer", "minimum": 1, "maximum": 200},
    },
}


# ------------------------------------------------------------------------------- numbers (§2)
def round_half_away(x, d):
    """sign(x)·floor(|x|·10^d + 0.5)/10^d; −0 normalised to +0 (JS toFixed prints −0 as "0")."""
    s = 10.0 ** d
    return math.copysign(math.floor(abs(x) * s + 0.5) / s, x) + 0.0


def fmt(x, d):
    return f"{round_half_away(x, d):.{d}f}"


def r6(x):
    return round_half_away(x, 6)


# ------------------------------------------------------------------------------- validation
def _is_num(x):
    return not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(x)


def _check(name, x, spec):
    t = spec["type"]
    if t == "string":
        if not isinstance(x, str):
            raise ValueError(f"{name}: must be a string")
        if x not in spec["enum"]:
            raise ValueError(f"{name}: must be one of {', '.join(spec['enum'])}")
        return x
    if t == "array":
        if not isinstance(x, (list, tuple)):
            raise ValueError(f"{name}: must be an array")
        if len(x) != 2:
            raise ValueError(f"{name}: must have exactly 2 items")
        out = [_check(f"{name}[{i}]", v, spec["items"]) for i, v in enumerate(x)]
        if out[0] > out[1]:
            raise ValueError(f"{name}: lower bound exceeds upper bound")
        return out
    if not _is_num(x):
        raise ValueError(f"{name}: must be a number" if t == "number" else f"{name}: must be an integer")
    if t == "integer":
        if x != math.floor(x):
            raise ValueError(f"{name}: must be an integer")
        x = int(x)
    else:
        x = float(x)
    if x < spec["minimum"]:
        raise ValueError(f"{name}: must be >= {_num_txt(spec['minimum'])}")
    if x > spec["maximum"]:
        raise ValueError(f"{name}: must be <= {_num_txt(spec['maximum'])}")
    return x


def _num_txt(v):
    return str(int(v)) if float(v).is_integer() else str(v)


def validate_query(q) -> dict:
    """Validate a query object; returns a normalised copy with defaults (n_min, sort, limit) filled in.
    Check order: object → unknown keys (sorted) → ion required → each property in QUERY_SCHEMA order →
    cross-field (n_min ≤ n_max, logN_min ≤ logN_max, b_min ≤ b_max). Raises ValueError("<field>: <reason>")."""
    if not isinstance(q, dict):
        raise ValueError("query: must be an object")
    props = QUERY_SCHEMA["properties"]
    for k in sorted(q):
        if k not in props:
            raise ValueError(f"{k}: unknown field")
    if "ion" not in q:
        raise ValueError("ion: required")
    out = {}
    for k, spec in props.items():
        if k in q:
            out[k] = _check(k, q[k], spec)
    for lo, hi in (("n_min", "n_max"), ("logN_min", "logN_max"), ("b_min", "b_max")):
        a = out.get(lo, DEFAULTS.get(lo))
        if a is not None and hi in out and a > out[hi]:
            raise ValueError(f"{lo}: exceeds {hi}")
    for k, v in DEFAULTS.items():
        out.setdefault(k, v)
    return out


# ------------------------------------------------------------------------------- query
def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def _reason(ion, n, matching, best_dv, b_kpc):
    s = f"{n} {ION_SHORT[ion]} component" + ("s" if n != 1 else "")
    if matching:
        lN = [c["logN"] for c in matching]; bs = [c["b"] for c in matching]
        s += f", logN {fmt(min(lN), 1)}{EN_DASH}{fmt(max(lN), 1)}"
        s += f", b {fmt(min(bs), 0)}{EN_DASH}{fmt(max(bs), 0)} km/s"
    if best_dv is not None:
        s += f", {DELTA}v {fmt(best_dv, 0)} km/s"
    if _is_num(b_kpc):
        s += f", {fmt(b_kpc, 0)} kpc"
    return s


def _evaluate(q, e, comps):
    ion = q["ion"]
    if q.get("orientation") is not None and e.get("orientation") != q["orientation"]:
        return None
    bk = e.get("b_kpc")
    if "b_kpc" in q and not (_is_num(bk) and q["b_kpc"][0] <= bk <= q["b_kpc"][1]):
        return None
    lN_lo, lN_hi = q.get("logN_min", -math.inf), q.get("logN_max", math.inf)
    b_lo, b_hi = q.get("b_min", -math.inf), q.get("b_max", math.inf)
    M = [dict(c, idx=i) for i, c in enumerate(comps)
         if lN_lo <= c["logN"] <= lN_hi and b_lo <= c["b"] <= b_hi]
    n = len(M)
    if n < q["n_min"] or ("n_max" in q and n > q["n_max"]):
        return None
    pairs = []
    if "sep_kms" in q:
        lo, hi = q["sep_kms"]
        for a in range(n):
            for b in range(a + 1, n):
                dv = r6(abs(M[a]["v"] - M[b]["v"]))
                if lo <= dv <= hi:
                    pairs.append((dv, M[a]["idx"], M[b]["idx"]))
        if not pairs:
            return None
        in_p = {i for _, i, j in pairs} | {j for _, i, j in pairs}
        matching = [c for c in M if c["idx"] in in_p]
    else:
        matching = M
    score = 0.0
    for c in matching:                                        # by idx (M is idx-ordered)
        score += 1.0 + _clamp(c["logN"] - 12.0, 0.0, 4.0) / 4.0
    score -= 0.5 * sum(1 for c in matching if int(c["flag"]) & 1)
    if "sep_kms" in q:
        score += 0.25 * min(len(pairs), 4)
    score = r6(score)
    pairs.sort()
    best_dv = pairs[0][0] if pairs else None
    return {"id": e["id"], "score": score, "n": n, "b_kpc": bk, "orientation": e.get("orientation"),
            "components": sorted(matching, key=lambda c: (c["v"], c["idx"])),
            "pairs": [[i, j, round_half_away(dv, 1)] for dv, i, j in pairs[:MAX_PAIRS]],
            "reason": _reason(q["ion"], n, matching, best_dv, bk)}


def _sort_key(sort):
    if sort == "b_kpc":
        return lambda r: (r["b_kpc"] if _is_num(r["b_kpc"]) else math.inf, -r["score"], r["id"])
    if sort == "n":
        return lambda r: (-r["n"], -r["score"], r["id"])
    return lambda r: (-r["score"], r["id"])


def search(q, entries, components) -> dict:
    """{"n_total": all matches, "results": the first `limit` (query) results}."""
    q = validate_query(q)
    by_id = {}
    for e in entries:                                         # later duplicates win (backend over static)
        by_id[e["id"]] = e
    out = []
    for sid in sorted(by_id):
        c = (components.get(sid) or {}).get(q["ion"])
        if c is None:
            continue
        r = _evaluate(q, by_id[sid], c)
        if r is not None:
            out.append(r)
    out.sort(key=_sort_key(q["sort"]))
    return {"n_total": len(out), "results": out[:q["limit"]]}


def run_query(q, entries, components, limit=None) -> list:
    """Ranked result list (§6.2). `limit` (if given) overrides the query's limit."""
    if limit is not None:
        q = dict(q, limit=limit)
    return search(q, entries, components)["results"]


# ------------------------------------------------------------------------------- fixture + golden cases
FIXTURE_PATH = Path(__file__).resolve().parent.parent / "tests" / "data" / "search_fixture.json"
GOLDEN_PATH = Path(__file__).resolve().parent.parent / "tests" / "search_golden.json"


def make_fixture() -> dict:
    """40 synthetic catalog entries + components (deterministic; numbers rounded like components.json).
    Includes deliberate edge cases: entries without components, empty ion lists, a missing ion key, b_kpc ties,
    SAT flags, pairs exactly at 30.00 km/s whose float difference is not exactly 30, duplicate logN values."""
    import numpy as np
    rng = np.random.default_rng(20261013)
    orients = ["face-on", "edge-on", "random", "custom"]
    entries, comps = [], {}
    for i in range(40):
        o = orients[i % 4]
        sid = (f"cust_{i:010x}" if o == "custom" else
               f"{o[:4] if o != 'random' else 'rand'}_b{10 + 7 * i:03d}_a{(37 * i) % 360:03d}"
               + ("_s%d" % (1000 + i) if o == "random" else ""))
        b_kpc = round_half_away(float(rng.uniform(5, 300)), 1) if i % 9 else 100.0     # ties at 100.0
        entries.append({"id": sid, "orientation": o, "b_kpc": b_kpc, "azimuth_deg": float((37 * i) % 360)})
        if i % 13 == 5:
            continue                                          # no components at all
        per = {}
        for k in ION_KEYS:
            if i % 17 == 3 and k == "CIII":
                continue                                      # ion key missing
            n = int(rng.integers(0, 7)) if i % 11 else 0
            v = np.sort(rng.uniform(-250, 250, n))
            lst = []
            for j in range(n):
                lst.append({"v": round_half_away(float(v[j]), 2), "dv": round_half_away(float(rng.uniform(0.05, 3)), 2),
                            "logN": round_half_away(float(rng.uniform(11.5, 16.5)), 3),
                            "dlogN": round_half_away(float(rng.uniform(0.001, 0.2)), 3),
                            "b": round_half_away(float(rng.uniform(3, 90)), 2),
                            "db": round_half_away(float(rng.uniform(0.05, 5)), 2),
                            "region": int(j // 2), "flag": int(rng.choice([0, 0, 0, 1, 2, 9, 16])),
                            "EW": round_half_away(float(rng.uniform(1, 400)), 2)})
            per[k] = lst
        comps[sid] = per
    # hand-made edge cases
    e0 = entries[0]["id"]
    comps[e0]["OVI"] = [
        {"v": -157.99, "dv": 0.5, "logN": 13.5, "dlogN": 0.01, "b": 20.0, "db": 0.3, "region": 0, "flag": 0, "EW": 50.0},
        {"v": -127.99, "dv": 0.5, "logN": 13.5, "dlogN": 0.01, "b": 20.0, "db": 0.3, "region": 0, "flag": 1, "EW": 50.0},
        {"v": -127.99, "dv": 0.5, "logN": 12.25, "dlogN": 0.01, "b": 12.5, "db": 0.3, "region": 0, "flag": 0, "EW": 8.0},
        {"v": 77.7, "dv": 0.5, "logN": 16.4, "dlogN": 0.01, "b": 35.5, "db": 0.3, "region": 1, "flag": 9, "EW": 300.0}]
    return {"version": 1, "note": "synthetic search fixture (tngsight.search.make_fixture); not real data",
            "entries": entries, "components": comps}


CASES = [
    {"name": "ovi_default", "query": {"ion": "OVI"}},
    {"name": "ovi_pairs_30_80", "query": {"ion": "OVI", "sep_kms": [30, 80]}},
    {"name": "ovi_pair_exact_30", "query": {"ion": "OVI", "sep_kms": [30, 30]}},
    {"name": "ovi_pair_zero_sep", "query": {"ion": "OVI", "sep_kms": [0, 0]}},
    {"name": "hi_n_range", "query": {"ion": "HILyb", "n_min": 2, "n_max": 3}},
    {"name": "ciii_zero_comps", "query": {"ion": "CIII", "n_min": 0, "n_max": 0}},
    {"name": "ovi_logN_window", "query": {"ion": "OVI", "logN_min": 13.5, "logN_max": 14.5}},
    {"name": "ovi_b_window", "query": {"ion": "OVI", "b_min": 12.5, "b_max": 20}},
    {"name": "edge_on_only", "query": {"ion": "OVI", "orientation": "edge-on"}},
    {"name": "custom_only", "query": {"ion": "HILyb", "orientation": "custom", "n_min": 0}},
    {"name": "impact_window_sort_b", "query": {"ion": "OVI", "b_kpc": [50, 150], "sort": "b_kpc"}},
    {"name": "impact_tie_100", "query": {"ion": "HILyb", "b_kpc": [100, 100], "n_min": 0}},
    {"name": "sort_n", "query": {"ion": "CIII", "sort": "n", "limit": 7}},
    {"name": "limit_1", "query": {"ion": "OVI", "limit": 1}},
    {"name": "many_comps", "query": {"ion": "HILyb", "n_min": 5}},
    {"name": "pairs_strong", "query": {"ion": "CIII", "sep_kms": [10, 200], "logN_min": 13}},
    {"name": "pairs_wide_sort_n", "query": {"ion": "HILyb", "sep_kms": [100, 3000], "sort": "n"}},
    {"name": "random_b_sort", "query": {"ion": "CIII", "orientation": "random", "sort": "b_kpc", "n_min": 0}},
    {"name": "narrow_lines", "query": {"ion": "OVI", "b_max": 10, "n_min": 1}},
    {"name": "everything", "query": {"ion": "OVI", "n_min": 1, "n_max": 30, "sep_kms": [0, 3000],
                                     "logN_min": 10, "logN_max": 19, "b_min": 0, "b_max": 150, "b_kpc": [0, 400],
                                     "orientation": "face-on", "sort": "score", "limit": 200}},
]

INVALID_CASES = [
    ({"n_min": 1}, "ion: required"),
    ({"ion": "NV"}, "ion: must be one of OVI, HILyb, CIII"),
    ({"ion": "OVI", "foo": 1}, "foo: unknown field"),
    ({"ion": "OVI", "n_min": 2.5}, "n_min: must be an integer"),
    ({"ion": "OVI", "n_min": True}, "n_min: must be an integer"),
    ({"ion": "OVI", "n_max": 31}, "n_max: must be <= 30"),
    ({"ion": "OVI", "n_min": 3, "n_max": 2}, "n_min: exceeds n_max"),
    ({"ion": "OVI", "n_max": 0}, "n_min: exceeds n_max"),
    ({"ion": "OVI", "sep_kms": [80, 30]}, "sep_kms: lower bound exceeds upper bound"),
    ({"ion": "OVI", "sep_kms": [30]}, "sep_kms: must have exactly 2 items"),
    ({"ion": "OVI", "sep_kms": [-1, 30]}, "sep_kms[0]: must be >= 0"),
    ({"ion": "OVI", "logN_min": 9.5}, "logN_min: must be >= 10"),
    ({"ion": "OVI", "logN_min": 15, "logN_max": 14}, "logN_min: exceeds logN_max"),
    ({"ion": "OVI", "b_kpc": [0, "x"]}, "b_kpc[1]: must be a number"),
    ({"ion": "OVI", "limit": 0}, "limit: must be >= 1"),
    ({"ion": "OVI", "sort": "random"}, "sort: must be one of score, b_kpc, n"),
    ("OVI", "query: must be an object"),
]

SEMANTICS = [
    "Query: validate_query per QUERY_SCHEMA; integers may arrive as integral floats (JSON 3.0); booleans are not "
    "numbers. Check order: object, unknown keys (sorted), ion required, properties in schema order, then cross-field "
    "n_min<=n_max (n_min default 1 applies), logN_min<=logN_max, b_min<=b_max. Error text '<field>: <reason>' exactly "
    "as in invalid_cases. Defaults: n_min 1, n_max none (infinite), sort 'score', limit 50.",
    "Entries: duplicates by id are collapsed, the LATER entry wins (backend after static); iterate ids in ascending "
    "code-point order.",
    "1. Skip unless components[id][ion] exists (an empty list exists; a missing id or ion key does not). Skip if "
    "orientation given and != entry.orientation. Skip if b_kpc=[lo,hi] given and not (entry.b_kpc is a finite number "
    "and lo<=b_kpc<=hi).",
    "2. M = components (original list index idx kept) with logN_min<=logN<=logN_max and b_min<=b<=b_max, inclusive, "
    "absent bound unbounded. n=|M|; require n_min<=n (and n<=n_max if given).",
    "3. If sep_kms=[lo,hi]: for a<b over M in idx order, dv=r6(|v_a-v_b|) with r6(x)=round_half_away(x,6); pair if "
    "lo<=dv<=hi. Require >=1 pair. matching = members of any pair (idx order); else matching = M.",
    "4. score = sum over matching in idx order of (1 + clamp(logN-12,0,4)/4), then minus 0.5*count(matching with "
    "flag&1), then plus 0.25*min(npairs,4) when sep_kms given; score = r6(score). Evaluate in exactly this order "
    "with IEEE doubles.",
    "5. Sort 'score': (-score, id); 'b_kpc': (b_kpc [non-number -> +inf], -score, id); 'n': (-n, -score, id). "
    "n_total = number of matches; results = first limit.",
    "6. Result {id, score, n, b_kpc, orientation, components: matching sorted by (v, idx), each the stored "
    "component plus 'idx'; pairs: sorted by (dv[r6], idx_a, idx_b), first 10, each [idx_a, idx_b, "
    "round_half_away(dv,1)]; reason}. pairs is [] without sep_kms.",
    "7. reason = '{n} {ION_SHORT} component' + ('s' if n!=1) + (if matching: ', logN {fmt(min,1)}–{fmt(max,1)}"
    ", b {fmt(min,0)}–{fmt(max,0)} km/s' over matching) + (if pairs: ', Δv {fmt(dv_smallest,0)} km/s') + "
    "(if b_kpc is a number: ', {fmt(b_kpc,0)} kpc'). fmt(x,d) = round_half_away(x,d) printed with d decimals; "
    "round_half_away(x,d) = sign(x)*floor(|x|*10^d+0.5)/10^d, -0 -> 0. ION_SHORT = {OVI:'O VI', HILyb:'H I', "
    "CIII:'C III'}.",
]


def load_fixture(path=FIXTURE_PATH) -> dict:
    return json.loads(Path(path).read_text())


def reference_cases(fixture=None) -> list:
    """Outputs of CASES over `fixture` (default: the committed tests/data/search_fixture.json if present)."""
    fx = fixture if fixture is not None else (load_fixture() if FIXTURE_PATH.is_file() else make_fixture())
    out = []
    for c in CASES:
        res = search(c["query"], fx["entries"], fx["components"])
        out.append({"name": c["name"], "query": c["query"], "n_total": res["n_total"],
                    "ids": [r["id"] for r in res["results"]], "results": res["results"]})
    return out


def golden(fixture_rel="tests/data/search_fixture.json") -> dict:
    return {"version": 1, "fixture": fixture_rel, "query_schema": QUERY_SCHEMA, "defaults": DEFAULTS,
            "semantics": SEMANTICS, "score_tolerance": 1e-9,
            "cases": reference_cases(),
            "invalid_cases": [{"query": q, "error": msg} for q, msg in INVALID_CASES]}


def _write(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, indent=1, ensure_ascii=False, allow_nan=False) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description="tngsight.search reference outputs")
    ap.add_argument("--schema"); ap.add_argument("--fixture"); ap.add_argument("--reference")
    ap.add_argument("--golden")
    a = ap.parse_args(argv)
    if not any((a.schema, a.fixture, a.reference, a.golden)):
        ap.error("nothing to do")
    if a.schema:
        _write(a.schema, QUERY_SCHEMA)
    if a.fixture:
        _write(a.fixture, make_fixture())
    if a.reference:
        _write(a.reference, {"version": 1, "fixture": "tests/data/search_fixture.json", "cases": reference_cases()})
    if a.golden:
        _write(a.golden, golden())
    return 0


if __name__ == "__main__":
    sys.exit(main())
