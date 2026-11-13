#!/usr/bin/env node
// Build the story's floating equations at build time (DESIGN_final §3.1 D7, §5.5 U_eq; C_eng P1-7).
//
// Renders E1-E8 (+ E3b) with KaTeX in node into ROOT/eq/eq.json, so the page ships only the KaTeX CSS and the glyph
// fonts the equations use (no katex.js at runtime). Each equation has two layers:
//   val  the value-first line (bound numbers large, C_ux P1-4/P1-5), e.g. "b_H = 13.8 km/s <- T = 11 500 K"
//   sym  the symbolic form, smaller by default
// Terms are wrapped as  <span data-term="T" class="enclosing eqt eqt-T">  (hover/drag targets) and every bound number
// as a fixed set of spans  data-v=<id> data-part=m|t|p|e  that js/eq/bind.js rewrites per frame (mantissa, "x",
// "10^", exponent; parts not needed by a value are hidden), so no number is baked into the page.
//
// Usage:
//   node scripts/story_eq_build.mjs [--katex DIR] [--root DIR] [--check] [--measure]
//     --katex DIR   the katex npm package directory (default: $KATEX_DIR, else require.resolve("katex") from the cwd
//                   and from this script's directory). KaTeX is a build-time dependency only (MIT).
//     --check       rebuild in memory and compare with the committed eq.json and vendor/katex (exit 1 on a difference)
//     --measure     also measure every layer's box in headless Chrome (TNG_EDGE or findBrowser()) and store it as
//                   box_em (width, height in em of the box font size) for the node layout solver's fallback
// Output: ROOT/eq/eq.json, ROOT/vendor/katex/{katex.css, fonts/*.woff2, LICENSE, README.md}
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync, statSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ROOT = resolve(opt("--root") || join(REPO, "docs/tng50/learn/how-a-spectrum-is-made"));
const CHECK = args.includes("--check"), MEASURE = args.includes("--measure");

/* ------------------------------------------------------------------ the equations (single source of truth)
   TeX mini-language (expanded below before KaTeX sees it):
     @t{id}{tex}   a term: hover/drag target bound to terms[id]
     @v{id}        a bound number (spans m, t, p, e; see header)
   Term fields: label (spoken), unit (spoken), bind (js/eq/bind.js source), fmt (bind.js FORMATS), drag (slider spec or
   null), toggle (m: H <-> O), prop (which property of the bead/plaque/dip it lights up). */
const EQUATIONS = [
  {
    id: "E1", title: "Column density", svg: null, beats: ["B2", "B7b"], short: "N",
    variants: {
      OVI: {
        sym: String.raw`{@t{N}{N} = \sum_{\rm cells} @t{n}{n_{\rm ion}}\,@t{dl}{d\ell}},\qquad {n(\text{O\,VI}) = @t{nH}{n_{\rm H}}\,(\mathrm{O/H})_\odot\,@t{Z}{(Z/Z_\odot)}\,@t{f}{f_{\rm O\,VI}}(n_{\rm H},T)}`,
        val: String.raw`{@t{n}{n_{\rm O\,VI}} = @v{n}\ \mathrm{cm^{-3}}}\ \times\ {@t{dl}{d\ell} = @v{dl}\ \mathrm{kpc}}\ \ \Rightarrow\ \ {@t{N}{N} = @v{N}\ \mathrm{cm^{-2}}}`,
        spoken: "Column density N is the sum over cells of the ion density times the path length; the O VI density is the hydrogen density times the solar oxygen abundance times the metallicity times the O VI fraction. This cell: {{n}} ions per cubic centimetre over {{dl}} kiloparsecs gives N of ten to the {{N}} per square centimetre.",
      },
      HI: {
        sym: String.raw`{@t{N}{N} = \sum_{\rm cells} @t{n}{n_{\rm ion}}\,@t{dl}{d\ell}},\qquad {n(\text{H\,I}) = @t{f}{x_{\rm HI}}\,@t{nH}{n_{\rm H}}}`,
        val: String.raw`{@t{n}{n_{\rm H\,I}} = @v{n}\ \mathrm{cm^{-3}}}\ \times\ {@t{dl}{d\ell} = @v{dl}\ \mathrm{kpc}}\ \ \Rightarrow\ \ {@t{N}{N} = @v{N}\ \mathrm{cm^{-2}}}`,
        spoken: "Column density N is the sum over cells of the ion density times the path length; the neutral hydrogen density is the neutral fraction times the hydrogen density. This cell: {{n}} atoms per cubic centimetre over {{dl}} kiloparsecs gives N of ten to the {{N}} per square centimetre.",
      },
    },
    terms: {
      N: {label: "column density", unit: "per square centimetre, log", bind: {src: "cell", field: "logN"}, fmt: "pow2", prop: "N"},
      n: {label: "ion density", unit: "per cubic centimetre", bind: {src: "derived", fn: "n_ion"}, fmt: "sci3", prop: "n"},
      dl: {label: "path length through the cell", unit: "kiloparsecs", bind: {src: "cell", field: "dl_kpc"}, fmt: "sig3", prop: "dl",
        drag: {scale: "log", rel: [0.1, 10], step: 0.05, big: 0.5}},
      nH: {label: "hydrogen density", unit: "per cubic centimetre", bind: {src: "cell", field: "nH"}, fmt: "sci3", prop: "nH"},
      Z: {label: "metallicity", unit: "times solar", bind: {src: "cell", field: "Z"}, fmt: "sig3", prop: "Z", ions: ["OVI"],
        drag: {scale: "log", abs: [0.01, 3], step: 0.05, big: 0.5}},
      f: {label: "ion fraction", unit: "", bind: {src: "cell", field: "f_ion"}, fmt: "sig3", prop: "f"},
    },
  },
  {
    id: "E2", title: "Thermal width", svg: "bwidth", beats: ["B5", "B7b", "B7c"], short: "T",
    variants: {
      HI: {
        sym: String.raw`{@t{b}{b} = \sqrt{\dfrac{2k\,@t{T}{T}}{@t{m}{m}}}}\qquad {(b_{\rm turb} = 0)}`,
        val: String.raw`{@t{b}{b_{\rm H}} = @v{b}\ \mathrm{km\,s^{-1}}}\ \ \leftarrow\ \ {@t{T}{T} = @v{T}\ \mathrm{K}}\qquad\allowbreak {@t{m}{b_{\rm O}} = @v{b_alt}\ \mathrm{km\,s^{-1}}}`,
        // B7b chain row (review2_science M2): T enters tau0 only through b, so the compact row shows b <- T, not T alone
        shortc: String.raw`{@t{b}{b_{\rm H}} = @v{b}\ \mathrm{km\,s^{-1}}}\ \leftarrow\ {@t{T}{T} = @v{T}\ \mathrm{K}}`,
        spoken: "Thermal width b equals the square root of 2 k T over the atom's mass. Hydrogen at {{T}} kelvin: b is {{b}} kilometres per second; oxygen at the same temperature: {{b_alt}} kilometres per second.",
      },
      OVI: {
        sym: String.raw`{@t{b}{b} = \sqrt{\dfrac{2k\,@t{T}{T}}{@t{m}{m}}}}\qquad {(b_{\rm turb} = 0)}`,
        val: String.raw`{@t{b}{b_{\rm O}} = @v{b}\ \mathrm{km\,s^{-1}}}\ \ \leftarrow\ \ {@t{T}{T} = @v{T}\ \mathrm{K}}\qquad\allowbreak {@t{m}{b_{\rm H}} = @v{b_alt}\ \mathrm{km\,s^{-1}}}`,
        // B7b chain row (review2_science M2): T enters tau0 only through b, so the compact row shows b <- T, not T alone
        shortc: String.raw`{@t{b}{b_{\rm O}} = @v{b}\ \mathrm{km\,s^{-1}}}\ \leftarrow\ {@t{T}{T} = @v{T}\ \mathrm{K}}`,
        spoken: "Thermal width b equals the square root of 2 k T over the atom's mass. Oxygen at {{T}} kelvin: b is {{b}} kilometres per second; hydrogen at the same temperature: {{b_alt}} kilometres per second.",
      },
    },
    terms: {
      b: {label: "Doppler width", unit: "kilometres per second", bind: {src: "cell", field: "b"}, fmt: "sig3", prop: "b"},
      T: {label: "temperature", unit: "kelvin", bind: {src: "cell", field: "T"}, fmt: "grp", prop: "T",
        drag: {scale: "log", abs: [1e4, 5e6], step: 0.025, big: 0.25}},
      m: {label: "atom mass", unit: "", bind: {src: "derived", fn: "b_alt"}, fmt: "sig3", prop: "b", toggle: true},
      b_alt: {label: "width of the other atom", unit: "kilometres per second", bind: {src: "derived", fn: "b_alt"}, fmt: "sig3", value: true},
    },
  },
  {
    id: "E3", title: "Optical depth at line centre", svg: "tau0", beats: ["B4", "B7b", "B10"], short: "N", shortChain: "tau0",
    variants: {
      any: {
        sym: String.raw`{@t{tau0}{\tau_0} = 1.4975\times10^{-15}\,\dfrac{@t{N}{N}\ @t{f}{f}\ @t{lam}{\lambda_{[\text{\AA}]}}}{@t{b}{b_{[\mathrm{km/s}]}}}}`,
        val: String.raw`{@t{tau0}{\tau_0} = @v{tau0}}\ \ \leftarrow\ \ {@t{N}{N} = @v{N}\ \mathrm{cm^{-2}}},\allowbreak\ \ {@t{b}{b} = @v{b}\ \mathrm{km\,s^{-1}}}`,
        // B7b chain row (review2_science M2): N and b are independent inputs that meet in tau0
        shortc: String.raw`{@t{tau0}{\tau_0} = @v{tau0}}\ \ \propto\ \ {@t{N}{N}\,f\lambda\,/\,@t{b}{b}}`,
        spoken: "Optical depth at line centre tau zero equals 1.4975 times ten to the minus 15, times column density N, oscillator strength f and wavelength in angstrom, divided by the width b in kilometres per second. Here tau zero is {{tau0}}, from N of ten to the {{N}} and b of {{b}} kilometres per second.",
      },
    },
    terms: {
      tau0: {label: "optical depth at line centre", unit: "", bind: {src: "cell", field: "tau0"}, fmt: "sig3", prop: "depth",
        drag: {scale: "log", via: "N", step: 0.05, big: 0.5}},
      N: {label: "column density", unit: "per square centimetre, log", bind: {src: "cell", field: "logN"}, fmt: "pow2", prop: "N",
        drag: {scale: "log10value", ion: {HI: [12, 19], OVI: [11, 16]}, step: 0.05, big: 0.5}},
      f: {label: "oscillator strength", unit: "", bind: {src: "atom", field: "f"}, fmt: "sig3", prop: "f"},
      lam: {label: "rest wavelength", unit: "angstrom", bind: {src: "atom", field: "lam0_A"}, fmt: "fix3", prop: "lam"},
      b: {label: "Doppler width", unit: "kilometres per second", bind: {src: "cell", field: "b"}, fmt: "sig3", prop: "b"},
    },
  },
  {
    id: "E3b", title: "Line profile", svg: "profile", beats: ["B4", "B10"],
    variants: {
      any: {
        sym: String.raw`{\tau(v) = @t{tau0}{\tau_0}\,H\!\left(@t{a}{a},\,\dfrac{v - @t{V}{V}}{@t{b}{b}}\right)},\qquad {@t{a}{a} = \dfrac{\Gamma\lambda}{4\pi b}}`,
        val: String.raw`{@t{V}{V} = @v{V}\ \mathrm{km\,s^{-1}}},\allowbreak\ \ {@t{b}{b} = @v{b}\ \mathrm{km\,s^{-1}}},\allowbreak\ \ {@t{a}{a} = @v{a}}`,
        spoken: "The optical depth profile is tau zero times the Voigt function H of a and v minus V over b, with damping parameter a equal to Gamma lambda over 4 pi b. Here the dip sits at {{V}} kilometres per second with width {{b}} and damping parameter {{a}}.",
      },
    },
    terms: {
      tau0: {label: "optical depth at line centre", unit: "", bind: {src: "cell", field: "tau0"}, fmt: "sig3", prop: "depth"},
      V: {label: "line-of-sight velocity", unit: "kilometres per second", bind: {src: "cell", field: "V"}, fmt: "fix1s", prop: "V",
        drag: {scale: "lin", rel: [-200, 200], clamp: [-400, 400], step: 1, big: 10}},
      b: {label: "Doppler width", unit: "kilometres per second", bind: {src: "cell", field: "b"}, fmt: "sig3", prop: "b"},
      a: {label: "damping parameter", unit: "", bind: {src: "cell", field: "a"}, fmt: "sci3", prop: "wings"},
    },
  },
  {
    id: "E4", title: "Doppler shift", svg: "doppler", beats: ["B6"], short: "V",
    variants: {
      any: {
        sym: String.raw`{@t{V}{V} = c\left(\dfrac{@t{lam}{\lambda}}{@t{lam0}{\lambda_0}} - 1\right) - @t{vgal}{v_{\rm gal}}}`,
        val: String.raw`{@t{lam}{\lambda} = @v{lam}\ \text{\AA}}\ \ \Rightarrow\ \ {@t{V}{V} = @v{V}\ \mathrm{km\,s^{-1}}}\qquad\allowbreak {@t{vgal}{v_{\rm gal}} = @v{vgal}\ \mathrm{km\,s^{-1}}}`,
        spoken: "Velocity V equals the speed of light times the observed over the rest wavelength minus one, minus the galaxy's own velocity. Observed at {{lam}} angstrom, the gas moves at {{V}} kilometres per second relative to the galaxy, whose velocity is {{vgal}} kilometres per second.",
      },
    },
    terms: {
      V: {label: "velocity relative to the galaxy", unit: "kilometres per second", bind: {src: "cell", field: "V"}, fmt: "fix1s", prop: "V"},
      lam: {label: "observed wavelength", unit: "angstrom", bind: {src: "derived", fn: "lam_obs"}, fmt: "fix3", prop: "V",
        drag: {scale: "lin", via: "V", rel: [-200, 200], clamp: [-400, 400], step: 1, big: 10}},
      lam0: {label: "rest wavelength", unit: "angstrom", bind: {src: "atom", field: "lam0_A"}, fmt: "fix3", prop: "lam"},
      vgal: {label: "galaxy velocity", unit: "kilometres per second", bind: {src: "derived", fn: "v_gal"}, fmt: "fix1s", prop: "V"},
    },
  },
  {
    id: "E5", title: "Optical depths add", svg: "tausum", beats: ["B7d", "B11"],
    variants: {
      any: {
        sym: String.raw`{\tau_{\rm total}(v) = \sum_i @t{taui}{\tau_i(v)}},\qquad {@t{F}{F} = \exp(-\tau_{\rm total})}`,
        val: String.raw`{@t{taup}{\tau_{\rm peak}} = @v{taup}}\ \ \Rightarrow\ \ {@t{F}{F_{\rm min}} = @v{F}}`,
        spoken: "Optical depths of all cells add, and the transmitted flux F is e to the minus total optical depth. So far the deepest point has optical depth {{taup}}, so the flux there is {{F}} of the light.",
      },
    },
    terms: {
      taui: {label: "optical depth of each cell", unit: "", bind: null, prop: "cells"},
      taup: {label: "peak optical depth so far", unit: "", bind: {src: "live", field: "tau_peak", fallback: {src: "totals", field: "peak_tau", when: "totals"}}, fmt: "sig3", prop: "depth"},
      F: {label: "transmitted fraction at the deepest point", unit: "", bind: {src: "derived", fn: "F_min"}, fmt: "F", prop: "depth"},
    },
  },
  {
    id: "E6", title: "Instrument blur", svg: "lsf", beats: ["B12a"],
    variants: {
      any: {
        sym: String.raw`{F_{\rm obs} = F \otimes \mathcal{G}},\qquad {@t{fwhm}{\mathrm{FWHM}} = \dfrac{c}{@t{R}{R}}}`,
        val: String.raw`{@t{R}{R} = @v{R}}\ \ \Rightarrow\ \ {@t{fwhm}{\mathrm{FWHM}} = @v{fwhm}\ \mathrm{km\,s^{-1}}}`,
        spoken: "The observed spectrum is the true spectrum blurred by a Gaussian whose full width at half maximum is the speed of light over the resolving power R. At sharpness R of {{R}} the blur is {{fwhm}} kilometres per second wide.",
      },
    },
    terms: {
      R: {label: "sharpness, resolving power R", unit: "", bind: {src: "spec", field: "R"}, fmt: "grp", prop: "R", override: "R",
        drag: {scale: "log", abs: [3000, 150000], step: 0.025, big: 0.25}},
      fwhm: {label: "blur width", unit: "kilometres per second", bind: {src: "derived", fn: "fwhm"}, fmt: "sig3", prop: "R"},
    },
  },
  {
    id: "E7", title: "Noise per pixel", svg: "noise", beats: ["B12b"],
    variants: {
      any: {
        sym: String.raw`{@t{sig}{\sigma_{\rm pix}} = \dfrac{\sqrt{5}}{@t{sn}{S/N}}}\qquad {(5\ \text{pixels per resolution element})}`,
        val: String.raw`{@t{sn}{S/N} = @v{sn}}\ \ \Rightarrow\ \ {@t{sig}{\sigma_{\rm pix}} = @v{sig}}`,
        spoken: "The noise per pixel is the square root of 5 over the signal-to-noise ratio per resolution element, with 5 pixels per resolution element. At exposure S over N of {{sn}} each pixel scatters by {{sig}} of the continuum.",
      },
    },
    terms: {
      sn: {label: "exposure, signal-to-noise ratio", unit: "", bind: {src: "spec", field: "sn"}, fmt: "sig3", prop: "sn", override: "sn",
        drag: {scale: "log", abs: [2, 100], step: 0.025, big: 0.25}},
      sig: {label: "noise per pixel", unit: "of the continuum", bind: {src: "derived", fn: "sigma_pix"}, fmt: "fix3", prop: "sn"},
    },
  },
  {
    id: "E8", title: "Reading it back", svg: "aod", beats: ["B13"],
    variants: {
      any: {
        sym: String.raw`{@t{chi}{\chi^2} = \sum_j \dfrac{(F_{{\rm obs},j} - M_j)^2}{\sigma_j^2}},\qquad {@t{Na}{N_a} = \dfrac{m_e c}{\pi e^2}\,\dfrac{\int \tau_a(v)\,dv}{f\lambda}}`,
        val: String.raw`{@t{Na}{N_a} = @v{Na}\ \mathrm{cm^{-2}}}\qquad\allowbreak {@t{chi}{\chi^2_\nu} = @v{chi}}`,
        spoken: "The fit minimises chi squared, the summed squared difference between the observed flux and the model in units of the noise; the apparent optical depth method turns the area of the dip into a column density. Here N a is ten to the {{Na}} per square centimetre and the reduced chi squared is {{chi}}.",
      },
    },
    terms: {
      chi: {label: "reduced chi squared of the fit", unit: "", bind: {src: "live", field: "chi2nu"}, fmt: "fix2", prop: "fit"},
      Na: {label: "apparent column density", unit: "per square centimetre, log", bind: {src: "live", field: "logNa", fallback: {src: "aod", field: "logN"}}, fmt: "pow2", prop: "N"},
    },
  },
];

// Line breaks (phone chips wrap): every "symbol = value unit" clause is braced, so KaTeX breaks only at the arrows,
// x and explicit \allowbreak, never between a symbol and its value.
// Type floor (G2, 12 CSS px): the TeX uses at most one script level (no \tfrac, no scripts on scripts), so with the
// overlay's sizes (value line 1.06 x --eq-size, symbolic line 0.8 x that, scripts 0.7 x) every glyph stays >= 12 px
// for --eq-size >= 17 px. tests/js/story_eq.mjs measures it.

/* ------------------------------------------------------------------ short layer (one-line phone / tight-band chip) */
// Layers per variant: val, sym, and short = the value line's headline clause alone ("N = 10^14.16 cm^-2"), one line
// that fits the phone's stepped equation band. The headline is the braced clause whose first term is E.short (default:
// the first braced clause of the value line).
export const LAYERS = ["val", "sym", "short"];   // + "shortc" where E.shortChain is set (B7b chain's compact row)
export function headline(val, E) {
  const groups = [];
  for (let i = 0; i < val.length;) {
    if (val[i] === "\\") { i += 2; continue; }
    if (val[i] === "{") { const [g, j] = readGroup(val, i); if (g.startsWith("@t{")) groups.push(g); i = j; continue; }
    i++;
  }
  if (!groups.length) return val;
  const want = E.short && groups.find(g => g.startsWith(`@t{${E.short}}`));
  return `{${want || groups[0]}}`;
}

/* ------------------------------------------------------------------ TeX mini-language expansion */
function readGroup(s, i) {            // s[i] === "{": return [content, index after the closing brace]
  if (s[i] !== "{") throw new Error(`expected { at ${i} in ${s}`);
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "{") d++;
    else if (s[j] === "}" && --d === 0) return [s.slice(i + 1, j), j + 1];
  }
  throw new Error(`unbalanced braces in ${s}`);
}
const ID = /^[A-Za-z][A-Za-z0-9_]*$/;
export function expand(tex, eqId) {
  // KaTeX renders "\ " as an inline-block holding a collapsible space, which vanishes in the overlay's nowrap boxes
  // (number and unit ran together: "13.8km"); "\;" is an explicit kern of the same visual weight
  tex = tex.replace(/\\ /g, "\\;");
  // every \qquad separates two clauses: a line-break opportunity on phones (symbolic lines too)
  tex = tex.replace(/\\qquad(?!\\allowbreak)/g, "\\qquad\\allowbreak ");
  let out = "", i = 0;
  const used = {terms: [], values: []};
  while (i < tex.length) {
    if (tex.startsWith("@t{", i)) {
      const [id, j] = readGroup(tex, i + 2); const [body, k] = readGroup(tex, j);
      if (!ID.test(id)) throw new Error(`${eqId}: bad term id ${id}`);
      used.terms.push(id);
      const inner = expand(body, eqId); used.values.push(...inner.used.values);
      out += String.raw`\htmlData{term=${id}}{\htmlClass{eqt eqt-${id}}{${inner.tex}}}`; i = k; continue;
    }
    if (tex.startsWith("@v{", i)) {
      const [id, j] = readGroup(tex, i + 2);
      if (!ID.test(id)) throw new Error(`${eqId}: bad value id ${id}`);
      used.values.push(id);
      // m: mantissa or plain number; t: "x"; p: "10^{e}"; placeholders only (bind.js writes the real digits)
      out += String.raw`\htmlData{v=${id},part=m}{\htmlClass{eqv}{0.00}}` +
             String.raw`\htmlData{v=${id},part=t}{{}\times{}}` +
             String.raw`\htmlData{v=${id},part=p}{10^{\htmlData{v=${id},part=e}{\htmlClass{eqv}{0}}}}`;
      i = j; continue;
    }
    out += tex[i++];
  }
  return {tex: out, used};
}

/* ------------------------------------------------------------------ KaTeX */
function findKatex() {
  const tries = [opt("--katex"), process.env.KATEX_DIR].filter(Boolean);
  for (const d of tries) if (existsSync(join(d, "package.json"))) return resolve(d);
  for (const base of [process.cwd() + "/", HERE + "/"]) {
    try { return dirname(createRequire(base).resolve("katex/package.json")); } catch {}
  }
  return null;
}
const KDIR = findKatex();
if (!KDIR) {
  console.error("story_eq_build: KaTeX not found. Install it outside the repo (npm install katex) and pass --katex <dir>/node_modules/katex or set KATEX_DIR.");
  process.exit(2);
}
const katex = createRequire(join(KDIR, "package.json"))(KDIR);
const KVER = JSON.parse(readFileSync(join(KDIR, "package.json"), "utf8")).version;

function render(tex, eqId) {
  return katex.renderToString(tex, {
    displayMode: false, output: "html", throwOnError: true, strict: "ignore",
    trust: ctx => ctx.command === "\\htmlData" || ctx.command === "\\htmlClass",
  });
}

/* Post-process KaTeX HTML: drop KaTeX's own wrapper aria-hidden (the overlay's group carries the spoken form and the
   katex-html stays aria-hidden), keep everything else byte-for-byte. */
function tidy(html) {
  return html.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ fonts actually used */
function cssRules(css) {
  // flat rule list of the minified KaTeX CSS (no nested at-rules except @font-face)
  const rules = []; let i = 0;
  while (i < css.length) {
    const a = css.indexOf("{", i); if (a < 0) break;
    const sel = css.slice(i, a).trim(); let d = 1, j = a + 1;
    while (j < css.length && d) { if (css[j] === "{") d++; else if (css[j] === "}") d--; j++; }
    rules.push({sel, body: css.slice(a + 1, j - 1)}); i = j;
  }
  return rules;
}
function usedFaces(htmls, rules) {
  // Simulate the cascade on KaTeX's span tree: every text node gets the font-family/weight/style of the last matching
  // rule on itself or the nearest ancestor (KaTeX's rules are all ".katex .x" and in source order). Returns face keys
  // "KaTeX_Main|normal|normal" for the @font-face rules to keep.
  const fontRules = [];
  for (const r of rules) {
    if (r.sel.startsWith("@")) continue;
    const fam = (r.body.match(/font-family:\s*([A-Za-z0-9_]+)/) || [])[1];
    const wt = (r.body.match(/font-weight:\s*(\w+)/) || [])[1];
    const st = (r.body.match(/font-style:\s*(\w+)/) || [])[1];
    if (!fam && !wt && !st) continue;
    const comps = r.sel.split(",").map(x => x.trim().split(/\s+/).pop()).map(last => [...last.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]))
      .filter(c => c.length && !/[:\[>]/.test(r.sel));
    if (comps.length) fontRules.push({comps, fam, wt, st});
  }
  const faces = new Set();
  const norm = w => (w === "bold" || w === "700" ? "bold" : w === "normal" || w === "400" ? "normal" : w);
  for (const h of htmls) {
    const stack = [{fam: "KaTeX_Main", wt: "normal", st: "normal"}];
    for (const m of h.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/g)) {
      if (m[5] !== undefined) {
        if (m[5].trim() && stack.length) { const f = stack[stack.length - 1]; faces.add(`${f.fam}|${f.wt}|${f.st}`); }
        continue;
      }
      if (m[1]) { stack.pop(); continue; }
      const parent = stack[stack.length - 1];
      const cls = new Set(((m[3].match(/class="([^"]*)"/) || [])[1] || "").split(/\s+/).filter(Boolean));
      const f = {...parent};
      if (m[2] === "svg") f.fam = null;      // svg glyphs are paths
      for (const r of fontRules) if (r.comps.some(c => c.every(x => cls.has(x)))) {
        if (r.fam) f.fam = r.fam; if (r.wt) f.wt = norm(r.wt); if (r.st) f.st = r.st;
      }
      if (!m[4]) stack.push(f);
    }
  }
  return [...faces].filter(k => !k.startsWith("null"));
}

/* ------------------------------------------------------------------ build */
function build() {
  const out = {
    schema: "story-eq/1",
    generator: "scripts/story_eq_build.mjs",
    katex: KVER,
    css: "vendor/katex/katex.css",
    note: "Rendered at build time with KaTeX (MIT); the runtime ships only vendor/katex/katex.css and the fonts listed here. " +
      "Bound numbers are placeholders (0.00 x 10^0) rewritten by js/eq/bind.js from story data keys.",
    fonts: [],
    eqs: {},
  };
  const htmls = [];
  for (const E of EQUATIONS) {
    const rec = {id: E.id, title: E.title, svg: E.svg, beats: E.beats, terms: {}, variants: {}};
    for (const [tid, t] of Object.entries(E.terms)) rec.terms[tid] = t;
    for (const [vk, V0] of Object.entries(E.variants)) {
      const layers = {};
      const V = {...V0, short: V0.short || headline(V0.val, E)};
      if (V0.shortc) V.shortc = V0.shortc;                                 // explicit chain row (E2 b <- T, E3 tau0 ∝ N f λ / b)
      else if (E.shortChain) V.shortc = headline(V0.val, {short: E.shortChain});   // the chain's compact row, if it differs
      for (const L of [...LAYERS, ...(V.shortc ? ["shortc"] : [])]) {
        const {tex, used} = expand(V[L], E.id);
        for (const id of [...used.terms, ...used.values]) if (!E.terms[id]) throw new Error(`${E.id}.${vk}.${L}: ${id} has no term definition`);
        const html = tidy(render(tex, E.id));
        htmls.push(html);
        layers[L] = {tex: V[L], html, terms: [...new Set(used.terms)], values: [...new Set(used.values)]};
      }
      rec.variants[vk] = {...layers, spoken: V.spoken};
      for (const m of V.spoken.matchAll(/\{\{(\w+)\}\}/g)) if (!E.terms[m[1]]) throw new Error(`${E.id}.${vk}: spoken uses unknown {{${m[1]}}}`);
    }
    out.eqs[E.id] = rec;
  }
  // trimmed CSS: keep the layout rules, @font-face only for used families, woff2 only
  const css = readFileSync(join(KDIR, "dist/katex.min.css"), "utf8");
  const rules = cssRules(css);
  const used = new Set(usedFaces(htmls, rules));
  const faces = [];
  const kept = rules.map(r => {
    if (r.sel !== "@font-face") return `${r.sel}{${r.body}}`;
    const fam = (r.body.match(/font-family:\s*([A-Za-z0-9_]+)/) || [])[1];
    const wt = /font-weight:\s*(bold|700)/.test(r.body) ? "bold" : "normal", st = /font-style:\s*italic/.test(r.body) ? "italic" : "normal";
    if (!used.has(`${fam}|${wt}|${st}`)) return "";
    const woff2 = (r.body.match(/url\((fonts\/[^)]+\.woff2)\)/) || [])[1];
    if (!woff2) throw new Error(`no woff2 for ${fam}`);
    faces.push(woff2.slice(6));
    const body = r.body.replace(/src:[^;}]+/, `src:url(${woff2}) format("woff2")`);
    return `@font-face{${body}}`;
  }).filter(Boolean).join("");
  out.fonts = [...new Set(faces)].sort();
  const header = `/* KaTeX ${KVER} CSS (MIT, Khan Academy and contributors; see LICENSE), trimmed by scripts/story_eq_build.mjs to the ` +
    `${out.fonts.length} woff2 faces the story equations use. */\n`;
  return {json: JSON.stringify(out, null, 1) + "\n", css: header + kept + "\n", fonts: out.fonts, out};
}

const README = fonts => `# vendor/katex

KaTeX ${KVER} (https://katex.org), MIT licence (see LICENSE). Only the stylesheet and the glyph fonts used by the story's
equations are vendored; **no KaTeX JavaScript ships to the browser**. The equations are rendered at build time by
\`scripts/story_eq_build.mjs\` into \`../../eq/eq.json\`.

- \`katex.css\`: \`dist/katex.min.css\` with the @font-face rules reduced to the faces below, woff2 only.
- \`fonts/\`: ${fonts.length} faces: ${fonts.map(f => "`" + f + "`").join(", ")}.

Rebuild: \`node scripts/story_eq_build.mjs --katex <path to node_modules/katex>\` (add \`--check\` to verify the committed files).
`;

/* --measure: every layer's box in em (font-size 100 px, after document.fonts.ready) in headless Chrome, through the
   repo's CDP harness (tests/js/lib/browser.mjs; TNG_EDGE picks the binary). */
async function measureBoxes() {
  const {serve, launch} = await import(join(REPO, "tests/js/lib/browser.mjs"));
  const {mkdtempSync} = await import("node:fs"); const {tmpdir} = await import("node:os");
  const tmp = mkdtempSync(join(tmpdir(), "eqm-")), page = join(tmp, "index.html");
  const rel = ROOT.slice(join(REPO, "docs/tng50").length + 1);
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${rel}/vendor/katex/katex.css">
<body style="margin:0;background:#000;color:#fff"><div id="m" style="position:absolute;left:0;top:0;font-size:100px;white-space:nowrap"></div>
<script>window.boxes = (async () => { const eq = await (await fetch("${rel}/eq/eq.json")).json(); const m = document.getElementById("m"); const out = {};
for (const [id, E] of Object.entries(eq.eqs)) for (const [vk, v] of Object.entries(E.variants)) for (const L of Object.keys(v).filter(k => v[k] && v[k].html)) m.insertAdjacentHTML("beforeend", '<div data-k="' + id + "." + vk + "." + L + '" style="display:inline-block">' + v[L].html + "</div><br>");
await document.fonts.ready; await new Promise(r => setTimeout(r, 300)); await document.fonts.ready;
for (const d of m.querySelectorAll("[data-k]")) { const r = d.getBoundingClientRect(); out[d.dataset.k] = {w: +(r.width / 100).toFixed(3), h: +(r.height / 100).toFixed(3)}; }
const bad = [...document.fonts].filter(f => f.status === "error").map(f => f.family);
return {out, bad, loaded: [...document.fonts].filter(f => f.status === "loaded").map(f => f.family)}; })();</script>`);
  const srv = await serve({dir: join(REPO, "docs/tng50"), page});
  const P = await launch({width: 1600, height: 900});
  try {
    await P.goto(srv.base);
    await P.waitFor("window.boxes", 30000);
    const r = await P.eval("window.boxes");
    if (r.bad.length) throw new Error(`fonts failed to load: ${r.bad.join(", ")}`);
    console.log(`--measure: ${Object.keys(r.out).length} layers; fonts loaded: ${[...new Set(r.loaded)].join(", ")}`);
    return r.out;
  } finally { await P.close(); await srv.close(); rmSync(tmp, {recursive: true, force: true}); }
}

const B = build();
const EQ = join(ROOT, "eq/eq.json"), VK = join(ROOT, "vendor/katex");
if (CHECK) {
  const bad = [];
  if (!existsSync(EQ)) bad.push("eq/eq.json missing");
  else {
    const cur = JSON.parse(readFileSync(EQ, "utf8")); const nu = JSON.parse(B.json);
    for (const E of Object.values(cur.eqs)) for (const v of Object.values(E.variants)) for (const L of Object.keys(v)) if (v[L] && v[L].html) delete v[L].box_em;
    if (JSON.stringify(cur) !== JSON.stringify(nu)) bad.push("eq/eq.json differs from a fresh build");
  }
  if (!existsSync(join(VK, "katex.css")) || readFileSync(join(VK, "katex.css"), "utf8") !== B.css) bad.push("vendor/katex/katex.css differs");
  for (const f of B.fonts) if (!existsSync(join(VK, "fonts", f))) bad.push(`vendor/katex/fonts/${f} missing`);
  if (existsSync(join(VK, "fonts"))) for (const f of readdirSync(join(VK, "fonts"))) if (!B.fonts.includes(f)) bad.push(`vendor/katex/fonts/${f} unused`);
  if (bad.length) { console.error("story_eq_build --check: FAIL\n  " + bad.join("\n  ")); process.exit(1); }
  console.log(`story_eq_build --check: OK (KaTeX ${KVER}, ${Object.keys(B.out.eqs).length} equations, ${B.fonts.length} fonts)`);
  process.exit(0);
}
mkdirSync(join(ROOT, "eq"), {recursive: true});
mkdirSync(join(VK, "fonts"), {recursive: true});
for (const f of readdirSync(join(VK, "fonts"))) if (!B.fonts.includes(f)) rmSync(join(VK, "fonts", f));
for (const f of B.fonts) copyFileSync(join(KDIR, "dist/fonts", f), join(VK, "fonts", f));
writeFileSync(join(VK, "katex.css"), B.css);
copyFileSync(join(KDIR, "LICENSE"), join(VK, "LICENSE"));
writeFileSync(join(VK, "README.md"), README(B.fonts));

let json = B.json;
if (MEASURE) {
  writeFileSync(EQ, json);
  const boxes = await measureBoxes();
  const o = JSON.parse(json);
  for (const [k, b] of Object.entries(boxes)) { const [id, vk, L] = k.split("."); o.eqs[id].variants[vk][L].box_em = b; }
  json = JSON.stringify(o, null, 1) + "\n";
}
writeFileSync(EQ, json);
const kb = f => (statSync(f).size / 1024).toFixed(1);
const fontKB = B.fonts.reduce((s, f) => s + statSync(join(VK, "fonts", f)).size, 0) / 1024;
console.log(`story_eq_build: KaTeX ${KVER}; ${Object.keys(B.out.eqs).length} equations -> eq/eq.json (${kb(EQ)} kB); ` +
  `katex.css ${kb(join(VK, "katex.css"))} kB; ${B.fonts.length} fonts ${fontKB.toFixed(1)} kB`);
