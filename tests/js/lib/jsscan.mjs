// Source scanners for ui_static.mjs: the text of a JS or HTML file that can reach the UI, with comments removed.
// Not a test itself (run_all.mjs only runs tests/js/*.mjs).
//   jsStrings(src)  -> [{s, line}]  every string literal and every static part of a template literal (regex literals
//                                   and comments are skipped; a heuristic tokenizer, good enough for our own sources)
//   htmlParts(src)  -> [{s, line, kind}]  the HTML outside comments and <script>/<style> (kind "html"), the CSS of
//                                   <style> blocks without /* */ comments (kind "css"), and the jsStrings of every
//                                   inline <script> that is not JSON data or an importmap (kind "js")
const NL = new Map(), lineAt = (src, i) => {   // 1-based line of offset i (newline offsets cached per source string)
  let a = NL.get(src); if (!a) { a = []; for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) a.push(k); NL.set(src, a); }
  let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < i) lo = m + 1; else hi = m; } return lo + 1; };

export function jsStrings(src, base = 0, full = src) {
  const out = []; let i = 0, last = "";   // last significant code char, for the regex-vs-divide decision
  const N = src.length, push = (s, at) => out.push({s, line: lineAt(full, base + at)});
  const regexOk = () => last === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(prevWord);
  let prevWord = "";
  const stack = [];   // template-literal nesting: each entry = brace depth at which the ${ } expression closes
  let depth = 0;
  const readTemplate = start => {   // i points after the backtick (or after a closing } of ${ }); returns at "`" or at "${"
    let s = "", at = i;
    while (i < N) { const c = src[i];
      if (c === "\\") { s += src.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { push(s, at); i++; return "end"; }
      if (c === "$" && src[i + 1] === "{") { push(s, at); i += 2; return "expr"; }
      s += c; i++; }
    push(s, at); return "end"; };
  while (i < N) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < N && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? N : e + 2; continue; }
    if (c === "'" || c === '"') { const at = i; let s = ""; i++;
      while (i < N && src[i] !== c && src[i] !== "\n") { if (src[i] === "\\") { s += src.slice(i, i + 2); i += 2; } else s += src[i++]; }
      i++; push(s, at); last = "a"; prevWord = ""; continue; }
    if (c === "`") { i++; if (readTemplate() === "expr") { stack.push(depth); depth++; } last = "a"; prevWord = ""; continue; }
    if (c === "/" && regexOk()) { i++; let cls = false;
      while (i < N && src[i] !== "\n") { const x = src[i]; if (x === "\\") { i += 2; continue; } if (x === "[") cls = true; else if (x === "]") cls = false; else if (x === "/" && !cls) break; i++; }
      i++; while (i < N && /[a-z]/i.test(src[i])) i++; last = "a"; prevWord = ""; continue; }
    if (c === "{") { depth++; last = c; prevWord = ""; i++; continue; }
    if (c === "}") { depth--; i++;
      if (stack.length && depth === stack[stack.length - 1]) { stack.pop(); if (readTemplate() === "expr") { stack.push(depth); depth++; } last = "a"; prevWord = ""; continue; }
      last = "}"; prevWord = ""; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$0-9]/.test(c)) { let w = ""; while (i < N && /[A-Za-z_$0-9]/.test(src[i])) w += src[i++]; prevWord = w; last = /^(return|typeof|case|do|else|in|of|void|yield|await)$/.test(w) ? "(" : "a"; continue; }
    last = c; prevWord = ""; i++;
  }
  return out;
}

export function htmlParts(src) {
  const out = []; let i = 0; const N = src.length;
  while (i < N) {
    const com = src.indexOf("<!--", i), scr = src.indexOf("<script", i), sty = src.indexOf("<style", i);
    const next = Math.min(...[com, scr, sty].map(x => (x < 0 ? N : x)));
    if (next > i) out.push({s: src.slice(i, next), line: lineAt(src, i), kind: "html"});
    if (next >= N) break;
    if (next === com) { const e = src.indexOf("-->", com + 4); i = e < 0 ? N : e + 3; continue; }
    if (next === sty) { const o = src.indexOf(">", sty) + 1, e = src.indexOf("</style>", o);
      out.push({s: src.slice(sty, o), line: lineAt(src, sty), kind: "html"});
      const css = src.slice(o, e < 0 ? N : e).replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
      out.push({s: css, line: lineAt(src, o), kind: "css"}); i = e < 0 ? N : e + 8; continue; }
    const o = src.indexOf(">", scr) + 1, e = src.indexOf("</script>", o), tag = src.slice(scr, o), body = src.slice(o, e < 0 ? N : e);
    out.push({s: tag, line: lineAt(src, scr), kind: "html"});
    if (!/type="(importmap|application\/json)"/.test(tag) && !/^\s*(const|var|let)\s+(DATA|MOCKDATA)\s*=/.test(body) && !/^\s*window\.MOCKDATA\s*=/.test(body))
      for (const x of jsStrings(body, o, src)) out.push({...x, kind: "js"});
    i = e < 0 ? N : e + 9;
  }
  return out;
}
