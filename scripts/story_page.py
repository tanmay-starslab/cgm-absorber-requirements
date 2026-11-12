#!/usr/bin/env python3
"""Write the static step markup of the story page from steps.json (PLAN_final §1.3: the page is readable with no
JavaScript, and ?still / print / screen readers get every step as real HTML).

    python3 scripts/story_page.py            # rewrite index.html between <!--STEPS--> / <!--RAIL--> markers
    python3 scripts/story_page.py --check    # exit 1 if index.html is out of date with steps.json

Numbers are {{key}} templates: the static text uses the story data when it exists (steps.json meta.data), else each
key's fallback; every templated element keeps its raw template in data-tpl so the page refills it at runtime.
The number format matches fmt() in index.html (thin no-break space groups at 5+ digits, U+2212 minus).
"""
import html
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "docs/tng50/learn/how-a-spectrum-is-made"
SUP = dict(zip("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹"))


def group(s):
    return re.sub(r"\B(?=(\d{3})+(?!\d))", " ", s)


def fmt(v, f):
    """mirror of engine.js fmtValue"""
    if isinstance(v, str) and f and v.strip():
        try:
            v = float(v)
        except ValueError:
            pass
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return re.sub(r"^-(?=[\d.])", "\u2212", str(v))
    if not math.isfinite(v):
        return "–"
    a = abs(v)
    if f == "id":
        s = str(int(round(a)))
    elif f in ("int", "pct"):
        s = group(str(int(round(a))))
    elif f in ("f1", "f2", "f3"):
        s = f"{a:.{int(f[1])}f}"
    elif f == "sci2":
        if a == 0:
            return "0"
        e = math.floor(math.log10(a))
        m = round(a / 10 ** e, 2)
        if m >= 10:
            m, e = round(m / 10, 2), e + 1
        s = f"{m:.2f}×10" + "".join(SUP[c] for c in str(e))
    else:
        s = repr(a) if not float(a).is_integer() else str(int(a))
    return ("−" if v < 0 and not re.fullmatch(r"0(\.0*)?", s) else "") + s


def dig(o, path):
    for k in path.split("."):
        if isinstance(o, dict):
            o = o.get(k)
        elif isinstance(o, list) and k.isdigit() and int(k) < len(o):
            o = o[int(k)]
        else:
            return None
    return o


def main(check=False):
    doc = json.loads((ROOT / "steps.json").read_text(encoding="utf-8"))
    dpath = ROOT / doc["meta"]["data"]
    data = json.loads(dpath.read_text(encoding="utf-8")) if dpath.exists() else None
    if data and data.get("meta"):
        pf = ROOT / "data" / f"page_fits_{data['meta']['galaxy']}_{data['meta']['ray']}.json"
        if pf.exists():
            data.setdefault("page_fits", json.loads(pf.read_text(encoding="utf-8")))
    keys = doc["keys"]

    def val(k):
        """same order as the engine: the data's pre-formatted keys block, then the path, then the fallback"""
        K = keys[k]
        pre = (data or {}).get("keys", {}).get(k)
        if isinstance(pre, (str, int, float)) and not isinstance(pre, bool):
            return fmt(pre, K.get("fmt"))
        v = dig(data, K["path"]) if data else None
        return fmt(v if isinstance(v, (str, int, float)) else K["fallback"], K.get("fmt"))

    def fill(s):
        return re.sub(r"\{\{(\w+)\}\}", lambda m: val(m.group(1)), s or "")

    def tpl(tag, s, attrs=""):
        """element with static text and, if templated, the raw template for the runtime"""
        a = f' data-tpl="{html.escape(s, quote=True)}"' if "{{" in s else ""
        return f"<{tag}{attrs}{a}>{html.escape(fill(s), quote=False)}</{tag}>"

    eq_title = {}
    for svg in (ROOT / "eq").glob("*.svg"):
        m = re.search(r"<title>(.*?)</title>", svg.read_text(encoding="utf-8"))
        eq_title[svg.stem] = html.unescape(m.group(1)) if m else svg.stem

    order = [c["id"] for c in doc["chapters"]]
    titles = {c["id"]: c["title"] for c in doc["chapters"]}
    present = []
    for st in doc["steps"]:
        if st["chapter"] not in present:
            present.append(st["chapter"])

    out = []
    for ch in present:
        steps = [s for s in doc["steps"] if s["chapter"] == ch]
        num = order.index(ch) + 1
        out.append(f'    <section class="chapter" id="ch-{ch}" data-chapter="{ch}" aria-labelledby="h2-{ch}">')
        out.append(f'      <h2 id="h2-{ch}"><span class="num" aria-hidden="true">{num:02d}</span>'
                   f'<span class="vh">Chapter {num}: </span><span class="q">{html.escape(titles[ch])}</span></h2>')
        for k, st in enumerate(steps):
            sid = st["id"]
            lay = st["layout"]
            attrs = (f' class="step" id="s-{sid}" data-step="{sid}" data-scene="{st["scene"]}" data-layout="{lay["land"]}"'
                     f' data-port="{lay["port"]}" data-film="{1 if st["film"] else 0}" data-dur="{st["dur_s"]}"'
                     f' aria-labelledby="h-{sid}"')
            out.append(f"      <article{attrs}>")
            out.append('        <div class="card">')
            out.append("          " + tpl("h3", st["text"], f' id="h-{sid}" tabindex="-1"'))
            out.append("          " + tpl("p", st["sub"], ' class="sub"'))
            out.append("          " + tpl("p", "Figure: " + st["aria"], ' class="aria vh"'))
            ph = st.get("physics") or {}
            eq = ph.get("eq")
            eqel = (f'<span class="eq" data-eq="{eq}" role="img" aria-label="{html.escape(eq_title.get(eq, eq), quote=True)}"></span>'
                    if eq else "")
            out.append(f'          <div class="phys">{eqel}{tpl("p", ph.get("line", ""))}</div>')
            if st.get("controls"):
                out.append('          <div class="ctrls" hidden>')
                for c in st["controls"]:
                    out.append("            " + control(c, st["params"], sid))
                out.append("          </div>")
            acts = []
            if st.get("controls"):
                acts.append(f'<button class="btn try" type="button" data-try aria-expanded="false" aria-controls="s-{sid}">Try it</button>')
                acts.append('<button class="btn quiet" type="button" data-back hidden>Back to story</button>')
            if st["scene"] == "yourturn":
                acts = [f'<a class="btn primary" data-handoff="{sid}" href="../../#id={st["handoff"]["id"]}">Open in Spectra</a>',
                        f'<a class="btn" data-handoff="{sid}" data-tab="3d" href="../../#id={st["handoff"]["id"]}&amp;tab=3d">See it in 3D</a>',
                        '<a class="btn quiet" data-replay href="#s=' + doc["steps"][0]["id"] + '">Replay</a>']
            acts.append('<span class="sp"></span>')
            if sid != doc["steps"][0]["id"]:
                acts.append('<button class="btn quiet nav" type="button" data-prev>Previous</button>')
            if sid != doc["steps"][-1]["id"]:
                acts.append('<button class="btn nav" type="button" data-next>Next</button>')
            out.append('          <div class="acts">' + "".join(acts) + "</div>")
            if st["scene"] == "yourturn":
                out.append(f'          <p class="sub"><a href="../../">Pick another galaxy</a>: all {doc["meta"]["n_galaxies"]} are in the explorer.</p>')
            out.append("        </div>")
            out.append("      </article>")
        out.append("    </section>")
    rail = ['  <ol>']
    for ch in present:
        first = next(s["id"] for s in doc["steps"] if s["chapter"] == ch)
        num = order.index(ch) + 1
        rail.append(f'    <li><a href="#s={first}" data-chapter="{ch}" data-first="{first}"><span class="dot" aria-hidden="true"></span>'
                    f'<span class="tip">{num:02d} {html.escape(titles[ch])}</span></a></li>')
    rail.append("  </ol>")

    page = (ROOT / "index.html").read_text(encoding="utf-8")
    new = re.sub(r"<!--STEPS-->.*?<!--/STEPS-->", lambda m: "<!--STEPS-->\n" + "\n".join(out) + "\n<!--/STEPS-->", page, flags=re.S)
    new = re.sub(r"<!--RAIL-->.*?<!--/RAIL-->", lambda m: "<!--RAIL-->\n" + "\n".join(rail) + "\n<!--/RAIL-->", new, flags=re.S)
    if check:
        if new != page:
            print("index.html is out of date: run scripts/story_page.py", file=sys.stderr)
            return 1
        print("index.html up to date")
        return 0
    (ROOT / "index.html").write_text(new, encoding="utf-8")
    print(f"wrote {len(doc['steps'])} steps in {len(present)} chapters ({'data' if data else 'fallback numbers'})")
    return 0


def control(c, params, sid):
    """one Try-it control: range (lin or log), enum (range over words), toggle (checkbox) or button"""
    p, lab = c["param"], html.escape(c["label"])
    if c["scale"] == "button":
        return f'<button class="btn" type="button" data-param="{p}">{lab}</button>'
    if c["scale"] == "toggle":
        on = " checked" if params.get(p) else ""
        return f'<label><span>{lab} <output></output></span><input type="checkbox" data-param="{p}"{on}></label>'
    if c["scale"] == "enum":
        words = c.get("valuetext") or []
        vals = c.get("values") or list(range(len(words)))
        cur = params.get(p, vals[0])
        opts = "".join(f'<label><input type="radio" name="{p}-{sid}" data-param="{p}" value="{html.escape(str(v))}"'
                       f'{" checked" if v == cur else ""}><span>{html.escape(w)}</span></label>' for v, w in zip(vals, words))
        return f'<fieldset class="seg"><legend>{lab}</legend>{opts}</fieldset>'
    defaults = {"logN": 14.16, "b": 17.3, "V": 0}
    v = params.get(p, defaults.get(p, c["min"]))
    lo, hi, step = c["min"], c["max"], c["step"]
    if c["scale"] == "log":
        lo, hi, v, step = round(math.log10(lo), 4), round(math.log10(hi), 4), round(math.log10(v), 4), 0.001
    unit = html.escape(c.get("unit", ""))
    return (f'<label><span>{lab} <output></output></span><input type="range" data-param="{p}" data-scale="{c["scale"]}" '
            f'data-unit="{unit}" min="{lo}" max="{hi}" step="{step}" value="{v}"></label>')


if __name__ == "__main__":
    sys.exit(main(check="--check" in sys.argv))
