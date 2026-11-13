#!/usr/bin/env python3
"""Music for "How a spectrum is made": Beethoven, Symphony No. 7 in A major, Op. 92, II. Allegretto (orchestral
recording). Builds two files from the owner's source file:

  media/music_loop.m4a   the page's optional sound: the quiet opening theme, before the build, crossfaded so it loops
                         without a seam, quiet (-23 LUFS)
  build/music_film.m4a   the film bed: the movement's first <film seconds> (quiet theme, then the build), -18 LUFS,
                         2 s fade in, 7 s fade out

  python3 scripts/story_music.py --src <recording.mp3> [--root docs/tng50/learn/how-a-spectrum-is-made] [--film-s 176]

The recording is clean (hiss about -57 dB below the music in the quiet passage), so no denoising, compression or
reverb is applied: only a rumble cut, trimming, fades, the loop crossfade and loudness levelling, to keep it natural.
Needs ffmpeg and numpy.
"""
import argparse, hashlib, json, os, subprocess, tempfile
import numpy as np

SR = 44100
LOOP = (4.0, 100.0)      # s in the source: the quiet theme after the opening chord, before the crescendo (RMS envelope)
XF = 4.0                 # loop crossfade, s
TONE = "highpass=f=30"
CREDIT = {"work": "Ludwig van Beethoven, Symphony No. 7 in A major, Op. 92, II. Allegretto",
          "recording": "orchestral recording supplied by the site owner",
          "changes": "excerpted, faded, looped and loudness-levelled"}


def ff(*a):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *a], check=True)


def decode(path, filt):
    p = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-af", filt, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                       check=True, capture_output=True)
    return np.frombuffer(p.stdout, np.float32).reshape(-1, 2).copy()


def encode(x, out, lufs, kbps):
    with tempfile.NamedTemporaryFile(suffix=".f32") as t:
        x.astype(np.float32).tofile(t.name)
        ff("-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", t.name, "-af", f"loudnorm=I={lufs}:TP=-1.5:LRA=14",
           "-ar", str(SR), "-c:a", "aac", "-b:a", f"{kbps}k", "-movflags", "+faststart", out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True); ap.add_argument("--root", default="docs/tng50/learn/how-a-spectrum-is-made")
    ap.add_argument("--film-s", type=float, default=176.0)
    a = ap.parse_args()
    h = hashlib.sha256(open(a.src, "rb").read()).hexdigest()
    x = decode(a.src, TONE)
    s = lambda t: int(round(t * SR))

    # page loop: L = A[XF:], its last XF seconds crossfaded into A[:XF], so the wrap back to L[0] = A[XF] is continuous
    A = x[s(LOOP[0]):s(LOOP[1])]
    L = A[s(XF):].copy(); n = s(XF)
    w = np.sin(np.linspace(0, np.pi / 2, n))[:, None] ** 2
    L[-n:] = A[-n:] * (1 - w) + A[:n] * w
    os.makedirs(os.path.join(a.root, "media"), exist_ok=True)
    encode(L, os.path.join(a.root, "media", "music_loop.m4a"), -23, 128)

    # film bed
    F = x[:s(a.film_s)].copy()
    fi, fo = s(2.0), s(7.0)
    F[:fi] *= np.linspace(0, 1, fi)[:, None]; F[-fo:] *= np.cos(np.linspace(0, np.pi / 2, fo))[:, None] ** 2
    os.makedirs(os.path.join(a.root, "build"), exist_ok=True)
    encode(F, os.path.join(a.root, "build", "music_film.m4a"), -18, 192)

    json.dump({**CREDIT, "source_sha256": h, "loop_s": round(len(L) / SR, 3), "loop_window_s": LOOP, "film_s": a.film_s},
              open(os.path.join(a.root, "media", "music.json"), "w"), indent=1)
    print(json.dumps({"sha256": h, "loop_s": len(L) / SR, "film_s": a.film_s}))


if __name__ == "__main__":
    main()
