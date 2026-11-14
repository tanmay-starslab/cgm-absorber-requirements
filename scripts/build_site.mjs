#!/usr/bin/env node
// Builds the Cloudflare site (galaxies.tanmaysingh.uk) from docs/ into dist/, no dependencies:
//   /                                   the TNG50 explorer          (docs/tng50/)
//   /learn/how-a-spectrum-is-made/      the explainer               (docs/tng50/learn/...)
//   /requirements/                      Detect & Resolve            (docs/index.html)
// The relative links inside the explorer and the explainer already work at this layout; only the two links between
// Detect & Resolve and the explorer are rewritten. dist/_redirects keeps old /tng50/... paths working.
// Used by Cloudflare Workers Builds (build command: node scripts/build_site.mjs) and locally.
import {cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from "node:fs";
import {join, basename, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "docs"), OUT = join(ROOT, "dist");
const SKIP_NAMES = new Set(["_template.html", ".gitignore", ".DS_Store", "build"]);
const SKIP_EXT = [".md", ".py", ".sh"];
const skip = p => { const b = basename(p); return SKIP_NAMES.has(b) || SKIP_EXT.some(e => b.endsWith(e)) || b.endsWith(".mp4"); };

rmSync(OUT, {recursive: true, force: true});
mkdirSync(OUT, {recursive: true});
cpSync(join(SRC, "tng50"), OUT, {recursive: true, filter: src => !skip(src)});

// Detect & Resolve at /requirements/: its links to tng50/... now point at the site root
mkdirSync(join(OUT, "requirements"), {recursive: true});
let dr = readFileSync(join(SRC, "index.html"), "utf8");
dr = dr.replaceAll('href="tng50/learn/', 'href="/learn/').replaceAll('href="tng50/"', 'href="/"').replaceAll('href="tng50/favicon.ico"', 'href="/favicon.ico"').replaceAll('href="tng50/img/icon/', 'href="/img/icon/').replaceAll('href="tng50/site.webmanifest"', 'href="/site.webmanifest"');
writeFileSync(join(OUT, "requirements", "index.html"), dr);

// the explorer's companion link (was ../ on GitHub Pages)
const ix = join(OUT, "index.html");
writeFileSync(ix, readFileSync(ix, "utf8").replaceAll('<a href="../">Detect and resolve', '<a href="/requirements/">Detect and resolve'));

writeFileSync(join(OUT, "_redirects"), ["/tng50/* /:splat 301", "/tng50 / 301", ""].join("\n"));
writeFileSync(join(OUT, "_headers"), ["/*", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: strict-origin-when-cross-origin", ""].join("\n"));
if (!existsSync(join(OUT, "index.html")) || !existsSync(join(OUT, "learn", "how-a-spectrum-is-made", "index.html"))) throw new Error("build: missing pages");
console.log("built", OUT);
