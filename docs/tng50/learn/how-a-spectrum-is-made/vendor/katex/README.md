# vendor/katex

KaTeX 0.16.47 (https://katex.org), MIT licence (see LICENSE). Only the stylesheet and the glyph fonts used by the story's
equations are vendored; **no KaTeX JavaScript ships to the browser**. The equations are rendered at build time by
`scripts/story_eq_build.mjs` into `../../eq/eq.json`.

- `katex.css`: `dist/katex.min.css` with the @font-face rules reduced to the faces below, woff2 only.
- `fonts/`: 5 faces: `KaTeX_Caligraphic-Regular.woff2`, `KaTeX_Main-Regular.woff2`, `KaTeX_Math-Italic.woff2`, `KaTeX_Size1-Regular.woff2`, `KaTeX_Size3-Regular.woff2`.

Rebuild: `node scripts/story_eq_build.mjs --katex <path to node_modules/katex>` (add `--check` to verify the committed files).
