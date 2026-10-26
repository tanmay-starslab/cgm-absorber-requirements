"""Generate the registry-derived chat artefacts (design.md §4.3) from tngsight/ions.json.

    python -m server.make_chat_tools            # (re)write every target
    python -m server.make_chat_tools --check    # exit 1 (and name the stale files) when any target differs

Targets:
  server/chat_tools.json            the Claude tool definitions (server/chat.py TOOLS reads it)
  server/chat_system_prompt.txt     the system prompt (server/chat.py SYSTEM_PROMPT reads it)
  docs/tng50/js/chat.js             blocks /*__GEN:TOOLS__*/, /*__GEN:PROMPT__*/, /*__GEN:IONS__*/
  docs/tng50/js/search.js           block /*__GEN:QUERY__*/ (ION_SHORT, ION_LABEL, ION_LOGN_MAX, QUERY_SCHEMA)

Only the text between a `/*__GEN:<NAME>__*/` marker and the next `/*__END__*/` is rewritten; the rest of
the JS files is never touched. The search query schema is tngsight.search.QUERY_SCHEMA verbatim; every
other bound comes from the registry (bands, snr, grid, KEYS)."""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS_JSON = ROOT / "server" / "chat_tools.json"
PROMPT_TXT = ROOT / "server" / "chat_system_prompt.txt"
CHAT_JS = ROOT / "docs" / "tng50" / "js" / "chat.js"
SEARCH_JS = ROOT / "docs" / "tng50" / "js" / "search.js"
FORBIDDEN = ("·", "•", "‧", "⋅", "・", " . ")   # design.md §6.2 C12
ID_PATTERN = r"^((face|edge|rand)_b\d{3}_a\d{3}(_s\d+)?|cust_[0-9a-f]{10})$"
LAYOUTS = ["1", "2R", "2SN", "4"]
VHW_MIN = 10
SPECIES_GAS = ["nH", "T", "Z"]

SET_INSTRUMENT_DESC = (
    "Set the spectrograph and view. R: resolving power per band (one value, or two for the two R cases). "
    "snr: S/N per resolution element (one value, or two for the two S/N cases). layout: 1 case, 2 cases "
    "varying R, 2 cases varying S/N, or the 2x2 grid. ions: the ions to plot. vhw: half-width of the velocity "
    "window (km/s). vc: window centre (km/s). fit: overplot on-the-fly component fits.")


def _ceilings(ions) -> str:
    """The per-ion logN ceilings (registry fit.logN_max) as text, e.g. '22.5 for HI, 19 otherwise'."""
    vals = {k: float(ions.atomic(k)["logN_max"]) for k in ions.KEYS}
    num = lambda v: str(int(v)) if v.is_integer() else str(v)          # noqa: E731
    common = max(set(vals.values()), key=lambda v: sum(1 for x in vals.values() if x == v))
    odd = [f"{num(v)} for {k}" for k, v in vals.items() if v != common]
    return ", ".join(odd + [f"{num(common)} otherwise"]) if odd else num(common)


def _one_or_two(item: dict) -> dict:
    return {"anyOf": [dict(item), {"type": "array", "items": dict(item), "minItems": 2, "maxItems": 2}]}


def build_tools(ions=None, query_schema=None) -> list:
    """The six tools, in the fixed order; registry-derived parts per design.md §4.3."""
    if ions is None:
        from tngsight import ions
    if query_schema is None:
        from tngsight.search import QUERY_SCHEMA as query_schema
    keys = list(ions.KEYS)
    vmax = ions.GRID["v_gen_kms"]
    R = {"type": "object", "additionalProperties": False, "properties": {
        b: _one_or_two({"type": "integer", "minimum": int(d["R"]["min"]), "maximum": int(d["R"]["max"])})
        for b, d in ions.BANDS.items()}}
    snr = _one_or_two({"type": "integer", "minimum": int(ions.SNR["min"]), "maximum": int(ions.SNR["max"])})
    set_instrument = {
        "name": "set_instrument", "description": SET_INSTRUMENT_DESC,
        "input_schema": {"type": "object", "additionalProperties": False, "properties": {
            "R": R, "snr": snr,
            "layout": {"type": "string", "enum": list(LAYOUTS)},
            "ions": {"type": "array", "items": {"type": "string", "enum": keys}, "minItems": 1,
                     "maxItems": len(keys), "uniqueItems": True},
            "vhw": {"type": "integer", "minimum": VHW_MIN, "maximum": int(vmax)},
            "vc": {"type": "number", "minimum": -int(vmax), "maximum": int(vmax)},
            "fit": {"type": "boolean"}}}}
    return [
        set_instrument,
        {"name": "select_sightline",
         "description": "Show an existing sightline by id (as returned by search_sightlines or request_*).",
         "input_schema": {"type": "object", "additionalProperties": False, "required": ["id"],
                          "properties": {"id": {"type": "string", "pattern": ID_PATTERN}}}},
        {"name": "search_sightlines",
         "description": "Find sightlines by their fitted Voigt components. Returns ranked ids with reasons. "
                        "Saturated or degenerate components are lower limits on log N, never measurements: one "
                        "meets logN_min when its lower limit does, and never meets a logN_max below the ion's "
                        f"ceiling ({_ceilings(ions)}). Reasons count them as lower limits.",
         "input_schema": {"type": "object", "additionalProperties": False, "required": ["query"],
                          "properties": {"query": json.loads(json.dumps(query_schema))}}},
        {"name": "request_sightline",
         "description": "Load or generate the sightline with this orientation, impact parameter b (kpc) and "
                        "azimuth (deg from the projected major axis). seed is required for random orientation.",
         "input_schema": {"type": "object", "additionalProperties": False,
                          "required": ["orientation", "b_kpc", "azimuth_deg"],
                          "properties": {"orientation": {"type": "string", "enum": ["face-on", "edge-on", "random"]},
                                         "b_kpc": {"type": "number", "minimum": 0, "maximum": 300},
                                         "azimuth_deg": {"type": "number", "minimum": 0, "maximum": 360},
                                         "seed": {"type": "integer", "minimum": 0, "maximum": 4294967295}}}},
        {"name": "request_custom_ray",
         "description": "Generate a straight ray between two points given in kpc relative to the galaxy centre "
                        "(simulation box axes). |p| <= 395 kpc, length 20-800 kpc.",
         "input_schema": {"type": "object", "additionalProperties": False, "required": ["p0_kpc", "p1_kpc"],
                          "properties": {
                              "p0_kpc": {"type": "array", "items": {"type": "number", "minimum": -395, "maximum": 395},
                                         "minItems": 3, "maxItems": 3},
                              "p1_kpc": {"type": "array", "items": {"type": "number", "minimum": -395, "maximum": 395},
                                         "minItems": 3, "maxItems": 3}}}},
        {"name": "show_3d",
         "description": "Open the 3D tab, optionally choosing the gas field and camera preset.",
         "input_schema": {"type": "object", "additionalProperties": False, "properties": {
             "species": {"type": "string", "enum": SPECIES_GAS + keys},
             "preset": {"type": "string", "enum": ["face-on", "edge-on", "sightline"]}}}},
    ]


def _join(words) -> str:
    words = list(words)
    return ", ".join(words[:-1]) + " and " + words[-1] if len(words) > 1 else "".join(words)


def build_prompt(ions=None) -> str:
    """One paragraph; ion list, keys, bands and S/N range from the registry. No dot separators."""
    if ions is None:
        from tngsight import ions
    rows = [ions.get(k) for k in ions.KEYS]
    labels = ", ".join(r["label"] for r in rows)
    bands = ", ".join(f"{d['label']} {int(d['R']['min'])} to {int(d['R']['max'])}" for d in ions.BANDS.values())
    notes = []
    for b, d in ions.BANDS.items():
        if d.get("note"):
            members = [r["label"] for r in rows if r["band"] == b]
            if members:
                notes.append(f"{_join(members)} {'is' if len(members) == 1 else 'are'} in the {d['label']} band "
                             f"({d['note']}). ")
    s = ions.SNR
    text = (
        "You are the assistant of the TNG50 sightline explorer, a web page showing mock quasar absorption "
        f"spectra of {len(rows)} ions ({labels}) through the circumgalactic medium of one simulated "
        "Milky-Way-mass galaxy (TNG50-1 subhalo 488530, z = 0). "
        f"Tool arguments name the ions by key: {', '.join(ions.KEYS)}. "
        + "".join(notes) +
        "You act only by calling the provided tools; the page executes them and returns JSON results. Every "
        "number, id or property you state must come from a tool result in this conversation or from the user; "
        "if the tools cannot answer, say so. Never invent sightline ids. Prefer search_sightlines to find "
        "sightlines, select_sightline to show one, set_instrument to set the resolving power R per band "
        f"({bands}), the S/N per resolution element ({int(s['min'])} to {int(s['max'])}), the layout, the ions "
        "shown and the velocity window, show_3d for the gas distribution, and request_sightline or "
        "request_custom_ray only when the user asks for a new sightline (generation takes one to two minutes "
        "and the page opens it when ready). Velocities are km/s relative to the galaxy's systemic velocity; "
        "column densities are log10 cm^-2; distances are kpc. A fitted component given as logN_lower "
        "(saturated, or degenerate with no errors) is a lower limit: say log N > that value, never quote it "
        "as a measured column. Keep answers short.")
    bad = [c for c in FORBIDDEN if c in text]
    if bad:
        raise ValueError(f"system prompt contains forbidden separators {bad!r}")
    return text


def _js(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def js_blocks(tools, prompt, ions=None, query_schema=None) -> dict:
    if ions is None:
        from tngsight import ions
    if query_schema is None:
        from tngsight.search import QUERY_SCHEMA as query_schema
    short = {k: ions.get(k)["ion"] for k in ions.KEYS}
    label = {k: ions.get(k)["label"] for k in ions.KEYS}
    logn_max = {k: ions.atomic(k)["logN_max"] for k in ions.KEYS}       # = tngsight.search.LOGN_MAX
    return {
        "chat": {
            "TOOLS": f"export const TOOLS = {_js(tools)};",
            "PROMPT": f"export const SYSTEM_PROMPT = {_js(prompt)};",
            "IONS": f"const ION_KEYS = {_js(list(ions.KEYS))};"},
        "search": {
            "QUERY": (f"export const ION_SHORT = {_js(short)};\n"
                      f"export const ION_LABEL = {_js(label)};\n"
                      f"export const ION_LOGN_MAX = {_js(logn_max)};\n"
                      f"export const QUERY_SCHEMA = {_js(query_schema)};")},
    }


def _block_re(name):
    return re.compile(r"(/\*__GEN:" + re.escape(name) + r"__\*/\n)(.*?)(\n/\*__END__\*/)", re.S)


def splice(text: str, blocks: dict, where="") -> str:
    """Replace each named block's body; every marker must be present exactly once."""
    for name, body in blocks.items():
        rx = _block_re(name)
        n = len(rx.findall(text))
        if n != 1:
            raise ValueError(f"{where}: marker /*__GEN:{name}__*/ ... /*__END__*/ found {n} times (need 1)")
        text = rx.sub(lambda m: m.group(1) + body + m.group(3), text)
    return text


def read_block(text: str, name: str) -> str:
    m = _block_re(name).search(text)
    return None if m is None else m.group(2)


def targets() -> dict:
    """{path: wanted text} for every generated file."""
    tools = build_tools()
    prompt = build_prompt()
    blocks = js_blocks(tools, prompt)
    return {
        TOOLS_JSON: json.dumps(tools, indent=1, ensure_ascii=False) + "\n",
        PROMPT_TXT: prompt + "\n",
        CHAT_JS: splice(CHAT_JS.read_text(encoding="utf-8"), blocks["chat"], CHAT_JS.name),
        SEARCH_JS: splice(SEARCH_JS.read_text(encoding="utf-8"), blocks["search"], SEARCH_JS.name),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="verify only; exit 1 when a target is stale")
    a = ap.parse_args(argv)
    stale = []
    for path, want in targets().items():
        have = path.read_text(encoding="utf-8") if path.is_file() else None
        if have == want:
            continue
        stale.append(path.relative_to(ROOT).as_posix())
        if not a.check:
            tmp = path.with_name(f".{path.name}.part")
            tmp.write_text(want, encoding="utf-8")
            tmp.replace(path)
    if a.check:
        if stale:
            print("stale (run python -m server.make_chat_tools): " + ", ".join(stale))
            return 1
        print("chat artefacts up to date")
        return 0
    print("wrote " + ", ".join(stale) if stale else "chat artefacts already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
