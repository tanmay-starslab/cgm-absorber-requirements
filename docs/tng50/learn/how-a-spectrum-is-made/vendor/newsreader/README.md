# Newsreader (display serif for the act lines)

Source: Newsreader by Production Type, via the npm package `@fontsource-variable/newsreader` 5.3.0
(`files/newsreader-latin-opsz-{normal,italic}.woff2`). Licence: SIL Open Font License 1.1 (`OFL.txt`, copied from the package).

Modified Version (OFL §1): static instances made with fontTools 4.68 for this page, so the files carry no Reserved Font Name
claim beyond the original authors' copyright:

    fonttools varLib.instancer <src>.woff2 wght=400 opsz=48
    pyftsubset <inst>.ttf --unicodes="U+0020-007E,U+00A0-00FF,U+2009,U+2010-2027,U+202F,U+2030-203A,U+2212,U+2192" \
      --layout-features='kern,liga,clig,calt,onum,lnum,tnum' --flavor=woff2

| file | style | bytes |
|---|---|---|
| newsreader-display-latin.woff2 | 400 normal, opsz 48 | 19 576 |
| newsreader-display-latin-italic.woff2 | 400 italic, opsz 48 | 21 096 |

Why static: the variable opsz files are 132 + 147 kB; the act lines are 26-56 px, where one display optical size reads well,
and the G6 font budget (≤ 250 kB with Space Grotesk, JetBrains Mono and KaTeX) needs the bytes.
