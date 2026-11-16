#!/usr/bin/env node
// Builds the Cloudflare site (galaxies.tanmaysingh.uk) from docs/ into dist/, no dependencies:
//   /                                   the TNG50 explorer          (docs/tng50/)
//   /learn/how-a-spectrum-is-made/      the explainer               (docs/tng50/learn/...)
//   /requirements/                      Detect & Resolve            (docs/index.html)
// The relative links inside the explorer and the explainer already work at this layout; only the two links between
// Detect & Resolve and the explorer are rewritten. dist/_redirects keeps old /tng50/... paths working.
//   /learn/how-a-spectrum-is-made/<id>/ one page per listed Tier A story, only when data/index.json has picker "cases"
// Used by Cloudflare Workers Builds (build command: node scripts/build_site.mjs) and locally.
// Test hooks (tests/js/site_paths.mjs): BUILD_SITE_OUT (output dir), BUILD_SITE_INDEX (an index.json used as the shipped one).
import {cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from "node:fs";
import {join, basename, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "docs"), OUT = process.env.BUILD_SITE_OUT || join(ROOT, "dist");
const SKIP_NAMES = new Set(["_template.html", ".gitignore", ".DS_Store", "build"]);
const SKIP_EXT = [".md", ".py", ".sh"];
const skip = p => { const b = basename(p); return SKIP_NAMES.has(b) || SKIP_EXT.some(e => b.endsWith(e)) || b.endsWith(".mp4"); };

rmSync(OUT, {recursive: true, force: true});
mkdirSync(OUT, {recursive: true});
cpSync(join(SRC, "tng50"), OUT, {recursive: true, filter: src => !skip(src)});

// Detect & Resolve at /requirements/: its links to tng50/... now point at the site root
mkdirSync(join(OUT, "requirements"), {recursive: true});
let dr = readFileSync(join(SRC, "index.html"), "utf8");
dr = dr.replaceAll('href="tng50/learn/', 'href="/learn/').replaceAll('href="tng50/"', 'href="/"');
writeFileSync(join(OUT, "requirements", "index.html"), dr);

// the explorer's companion link (was ../ on GitHub Pages)
const ix = join(OUT, "index.html");
writeFileSync(ix, readFileSync(ix, "utf8").replaceAll('<a href="../">Detect and resolve', '<a href="/requirements/">Detect and resolve'));

writeFileSync(join(OUT, "_redirects"), ["/tng50/* /:splat 301", "/tng50 / 301", ""].join("\n"));
writeFileSync(join(OUT, "_headers"), ["/*", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: strict-origin-when-cross-origin", ""].join("\n"));
// Per-case story paths (DESIGN_tierA §7.3, behind the picker flag): a copy of the explainer page per listed story, with
// <base href="../"> for its relative assets and the story id put into ?story= before any page script reads it.
// shortcut: the shim rewrites the address to <id>/?story=<id> because js/main.js reads only ?story=; drop it once
// main.js also reads <html data-story>.
const LEARN = join(OUT, "learn", "how-a-spectrum-is-made"), SITE = "https://galaxies.tanmaysingh.uk/learn/how-a-spectrum-is-made/";
if (process.env.BUILD_SITE_INDEX) cpSync(process.env.BUILD_SITE_INDEX, join(LEARN, "data", "index.json"));
const sidx = JSON.parse(readFileSync(join(LEARN, "data", "index.json"), "utf8"));
const caseIds = sidx.picker === "cases" ? (sidx.stories || []).filter(e => e.case && e.case !== "full" && e.gates && e.gates.all === true).map(e => e.id) : [];
const page = caseIds.length ? readFileSync(join(LEARN, "index.html"), "utf8") : "";
for (const id of caseIds) {
  if (!/^[a-z][a-z0-9-]*$/.test(id) || existsSync(join(LEARN, id))) throw new Error(`build: story id ${JSON.stringify(id)} cannot be a path`);
  // <base> would also resolve history.replaceState("#frag") to the hero page, so the shim resolves state URLs against the address.
  const shim = `<script>(function(){var h=history;["pushState","replaceState"].forEach(function(k){var f=h[k];h[k]=function(s,t,u){return f.call(h,s,t,u==null?u:new URL(u,location.href).href);};});var q=new URLSearchParams(location.search);if(q.get("story")!=="${id}"){q.set("story","${id}");history.replaceState(history.state,"",location.pathname+"?"+q+location.hash);}})()</script>`;
  const html = page.replace('<html lang="en"', `<html lang="en" data-story="${id}"`).replace("<head>\n", `<head>\n<base href="../">\n${shim}\n`)
    .replaceAll(`href="${SITE}"`, `href="${SITE}${id}/"`).replaceAll(`content="${SITE}"`, `content="${SITE}${id}/"`);
  if (!html.includes('<base href="../">') || !html.includes(`data-story="${id}"`)) throw new Error("build: explainer page head changed; update the per-story page edit");
  mkdirSync(join(LEARN, id));
  writeFileSync(join(LEARN, id, "index.html"), html);
}
if (!existsSync(join(OUT, "index.html")) || !existsSync(join(LEARN, "index.html")) || caseIds.some(id => !existsSync(join(LEARN, id, "index.html")))) throw new Error("build: missing pages");
console.log("built", OUT);
