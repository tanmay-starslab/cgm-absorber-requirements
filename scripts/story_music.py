#!/usr/bin/env python3
"""Music for "How a spectrum is made": Beethoven, Symphony No. 7, II. Allegretto, cello arrangement and recording by
John Michel (Wikimedia Commons, CC BY-SA 3.0). Builds two files from the Commons original:

  media/music_loop.m4a   the page's optional sound: the quiet opening theme (about 2 min), dynamics gently compressed,
                         a soft room added, crossfaded so it loops without a seam, quiet (-24 LUFS)
  build/music_film.m4a   the film bed: the movement's first <film seconds> (quiet theme, then the build), compressed so the
                         quiet start stays audible on laptop speakers, -18 LUFS, 2 s fade in, 7 s fade out

  python3 scripts/story_music.py [--src michel.ogg] [--root docs/tng50/learn/how-a-spectrum-is-made] [--film-s 176]

The source is downloaded and checked against SRC_SHA256 when --src is not given. Needs ffmpeg and numpy.
"""
import argparse, hashlib, json, os, subprocess, sys, tempfile, urllib.request
import numpy as np

SRC_URL = "https://upload.wikimedia.org/wikipedia/commons/0/0c/JOHN_MICHEL_CELLO-BEETHOVEN_SYMPHONY_7_Allegretto.ogg"
SRC_PAGE = "https://commons.wikimedia.org/wiki/File:JOHN_MICHEL_CELLO-BEETHOVEN_SYMPHONY_7_Allegretto.ogg"
SRC_SHA256 = "0cc82867e2ff62baf4d22dfbc6d339f21bbcaf033a6c0565adfab4f65ebf482e"  # the Commons file as of 2026-11-13
SR = 44100
LOOP = (8.0, 128.0)      # s in the source: the quiet theme, after the opening chord, before the build (RMS envelope)
XF = 4.0                 # loop crossfade, s
# warmth and space: rumble cut, soft top, 2:1 compression above -36 dB, a faint early-reflection room
TONE = "highpass=f=40,lowpass=f=13000,acompressor=threshold=-36dB:ratio=2:attack=40:release=600:makeup=2,aecho=0.85:0.6:45|95:0.18|0.10"
CREDIT = {"work": "Ludwig van Beethoven, Symphony No. 7 in A major, Op. 92, II. Allegretto",
          "performer": "John Michel (cello arrangement and recording)", "source": SRC_PAGE,
          "license": "CC BY-SA 3.0", "license_url": "https://creativecommons.org/licenses/by-sa/3.0/",
          "changes": "excerpted, dynamics compressed, equalised, light reverb, faded and looped"}

def ff(*a):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *a], check=True)

def decode(path, filt):
    p = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-af", filt, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                       check=True, capture_output=True)
    return np.frombuffer(p.stdout, np.float32).reshape(-1, 2).copy()

def encode(x, out, lufs, kbps):
    with tempfile.NamedTemporaryFile(suffix=".f32") as t:
        x.astype(np.float32).tofile(t.name)
        ff("-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", t.name, "-af", f"loudnorm=I={lufs}:TP=-2:LRA=9",
           "-ar", str(SR), "-c:a", "aac", "-b:a", f"{kbps}k", "-movflags", "+faststart", out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src"); ap.add_argument("--root", default="docs/tng50/learn/how-a-spectrum-is-made")
    ap.add_argument("--film-s", type=float, default=176.0)
    a = ap.parse_args()
    src = a.src
    if not src:
        src = os.path.join(tempfile.mkdtemp(), "michel.ogg")
        urllib.request.urlretrieve(SRC_URL, src)
    h = hashlib.sha256(open(src, "rb").read()).hexdigest()
    if SRC_SHA256 and h != SRC_SHA256: sys.exit(f"source sha256 {h} != {SRC_SHA256}")
    x = decode(src, TONE)
    s = lambda t: int(round(t * SR))

    # page loop: L = A[XF:], its last XF seconds crossfaded into A[:XF], so the wrap back to L[0] = A[XF] is continuous
    A = x[s(LOOP[0]):s(LOOP[1])]
    L = A[s(XF):].copy(); n = s(XF)
    w = np.sin(np.linspace(0, np.pi / 2, n))[:, None] ** 2   # equal-power-ish
    L[-n:] = A[-n:] * (1 - w) + A[:n] * w
    os.makedirs(os.path.join(a.root, "media"), exist_ok=True)
    encode(L, os.path.join(a.root, "media", "music_loop.m4a"), -24, 96)

    # film bed
    F = x[:s(a.film_s)].copy()
    fi, fo = s(2.0), s(7.0)
    F[:fi] *= np.linspace(0, 1, fi)[:, None]; F[-fo:] *= np.cos(np.linspace(0, np.pi / 2, fo))[:, None] ** 2
    os.makedirs(os.path.join(a.root, "build"), exist_ok=True)
    encode(F, os.path.join(a.root, "build", "music_film.m4a"), -18, 160)

    json.dump({**CREDIT, "source_sha256": h, "loop_s": round(len(L) / SR, 3), "loop_window_s": LOOP, "film_s": a.film_s},
              open(os.path.join(a.root, "media", "music.json"), "w"), indent=1)
    print(json.dumps({"sha256": h, "loop_s": len(L) / SR, "film_s": a.film_s}))

if __name__ == "__main__":
    main()
