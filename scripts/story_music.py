#!/usr/bin/env python3
"""Music for "How a spectrum is made". Two tracks for the page's optional music (js/ui/sound.js), each a seamless loop
built from a source file supplied by the site owner:

  dayone     Hans Zimmer, Day One (Interstellar, 2014)                     -> media/music_dayone.m4a (the default)
  beethoven  Beethoven, Symphony No. 7 in A major, Op. 92, II. Allegretto  -> media/music_loop.m4a
             and the film bed build/music_film.m4a (the movement's first <film seconds>, -18 LUFS, 2 s in, 7 s out)

  python3 scripts/story_music.py --track dayone    --src "<Day One.mp3>"
  python3 scripts/story_music.py --track beethoven --src <Allegretto.mp3> [--film-s 176]
  python3 scripts/story_music.py --check media/music_dayone.m4a     (seam level match, peak, quiet stretches)

Each loop is the window LOOP of the source (s) with its last XF seconds crossfaded into its first XF, so the wrap is
continuous; rumble cut (30 Hz high-pass), no denoising, compression or reverb; loudness-levelled to -23 LUFS, AAC
128 kb/s. media/music.json lists both tracks with their credits (the entry of the built track is rewritten).

Window choice
  beethoven 4-100 s: the quiet theme after the opening chord, before the crescendo (RMS envelope).
  dayone 10.75-110.75 s (a 96 s loop): Day One opens almost silent (about -50 dB for the first 6 s) and builds to its
    climax at 165-182 s. Search over starts 6-40 s and lengths 100-150 s ending before 150 s, minimising the level
    difference and the log-spectrum mismatch (32 bands, 40 Hz-8 kHz, 0.25 s frames) between the two sides of the 4 s
    crossfade: 0.0 dB and a frame-by-frame spectral correlation of 0.87 there (a 90 s window at 20.25 s matched slightly
    better but loops sooner). It starts on the quiet figure after the near-silent opening, rises to the first swell
    (about 95 s) and comes back down into the 106 s lull, so it never reaches the big climax. Levelled with a two-pass
    linear loudnorm (a plain gain) so the build keeps its shape: -22.9 LUFS, LRA 12.4, peak -7 dBFS, seam step 0.4 dB.
Needs ffmpeg and numpy.
"""
import argparse, hashlib, json, os, subprocess, tempfile
import numpy as np

SR = 44100
XF = 4.0                 # loop crossfade, s
TONE = "highpass=f=30"
TRACKS = {
    "dayone": {"id": "dayone", "label": "Day One", "file": "music_dayone.m4a", "default": True,
               "work": "Hans Zimmer, Day One (Interstellar, 2014)",
               "recording": "commercial soundtrack recording supplied by the site owner",
               "changes": "excerpted, crossfaded into a loop and loudness-levelled",
               "loop_window_s": [10.75, 110.75]},
    "beethoven": {"id": "beethoven", "label": "Beethoven", "file": "music_loop.m4a", "default": False,
                  "work": "Ludwig van Beethoven, Symphony No. 7 in A major, Op. 92, II. Allegretto",
                  "recording": "orchestral recording supplied by the site owner",
                  "changes": "excerpted, faded, looped and loudness-levelled",
                  "loop_window_s": [4.0, 100.0]},
}
ORDER = ["dayone", "beethoven"]


def ff(*a):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *a], check=True)


def decode(path, filt):
    p = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-af", filt, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
                       check=True, capture_output=True)
    return np.frombuffer(p.stdout, np.float32).reshape(-1, 2).copy()


def encode(x, out, lufs, kbps, linear=False):
    """loudnorm: one pass (dynamic, as the Beethoven files were built) or, linear=True, two passes with a plain gain so the
    track lands on the target and keeps its dynamics"""
    with tempfile.NamedTemporaryFile(suffix=".f32") as t:
        x.astype(np.float32).tofile(t.name)
        src = ["-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", t.name]
        ln = f"loudnorm=I={lufs}:TP=-1.5:LRA=20"
        if linear:
            p = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", *src, "-af", ln + ":print_format=json", "-f", "null", "-"],
                               check=True, capture_output=True, text=True)
            m = json.loads(p.stderr[p.stderr.rfind("{"):p.stderr.rfind("}") + 1])
            ln += (f":measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
                   f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
        else:
            ln = f"loudnorm=I={lufs}:TP=-1.5:LRA=14"
        ff(*src, "-af", ln, "-ar", str(SR), "-c:a", "aac", "-b:a", f"{kbps}k", "-movflags", "+faststart", out)


def loop(x, win):
    """L = A[XF:], its last XF seconds crossfaded into A[:XF], so the wrap back to L[0] = A[XF] is continuous"""
    s = lambda t: int(round(t * SR))
    A = x[s(win[0]):s(win[1])]
    L = A[s(XF):].copy(); n = s(XF)
    w = np.sin(np.linspace(0, np.pi / 2, n))[:, None] ** 2
    L[-n:] = A[-n:] * (1 - w) + A[:n] * w
    return L


def check(path):
    """seam: RMS (dB) of the last and first 1 s and the sample step at the wrap; peak; integrated loudness; the longest
    stretch of 0.5 s frames more than 30 dB below the loop's mean level"""
    x = decode(path, "anull"); m = x.mean(1)
    rms = lambda v: 10 * np.log10((v.astype(np.float64) ** 2).mean() + 1e-20)
    tail, head = rms(m[-SR:]), rms(m[:SR])
    h = SR // 2; fr = m[:len(m) // h * h].reshape(-1, h); db = 10 * np.log10((fr.astype(np.float64) ** 2).mean(1) + 1e-20)
    quiet = db < rms(m) - 30; run = best = 0
    for q in quiet: run = run + 1 if q else 0; best = max(best, run)
    p = subprocess.run(["ffmpeg", "-nostdin", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True)
    summ = p.stderr[p.stderr.rfind("Summary:"):]
    pick = lambda key: float(summ.split(key)[1].split()[0])
    out = {"file": os.path.basename(path), "s": round(len(m) / SR, 3), "tail_db": round(tail, 2), "head_db": round(head, 2),
           "seam_db": round(head - tail, 2), "wrap_step": round(float(np.abs(x[0] - x[-1]).max()), 4),
           "peak_dbfs": round(20 * np.log10(np.abs(x).max()), 2), "lufs": pick("I:"), "lra": pick("LRA:"), "true_peak_dbfs": pick("Peak:"),
           "longest_quiet_s": best * 0.5, "min_frame_db_rel": round(float(db.min() - rms(m)), 1)}
    print(json.dumps(out)); return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", choices=ORDER, default="beethoven"); ap.add_argument("--src")
    ap.add_argument("--root", default="docs/tng50/learn/how-a-spectrum-is-made")
    ap.add_argument("--film-s", type=float, default=176.0); ap.add_argument("--check")
    a = ap.parse_args()
    if a.check: check(a.check); return
    if not a.src: ap.error("--src is required")
    T = dict(TRACKS[a.track])
    h = hashlib.sha256(open(a.src, "rb").read()).hexdigest()
    x = decode(a.src, TONE)
    media = os.path.join(a.root, "media"); os.makedirs(media, exist_ok=True)
    L = loop(x, T["loop_window_s"])
    encode(L, os.path.join(media, T["file"]), -23, 128, linear=a.track == "dayone")
    T.update(source_sha256=h, loop_s=round(len(L) / SR, 3))

    if a.track == "beethoven":   # film bed
        F = x[:int(round(a.film_s * SR))].copy()
        fi, fo = int(2.0 * SR), int(7.0 * SR)
        F[:fi] *= np.linspace(0, 1, fi)[:, None]; F[-fo:] *= np.cos(np.linspace(0, np.pi / 2, fo))[:, None] ** 2
        os.makedirs(os.path.join(a.root, "build"), exist_ok=True)
        encode(F, os.path.join(a.root, "build", "music_film.m4a"), -18, 192)
        T["film_s"] = a.film_s

    jp = os.path.join(media, "music.json")
    try: J = json.load(open(jp))
    except (OSError, ValueError): J = {}
    tracks = {t["id"]: t for t in J.get("tracks", [])}
    if "work" in J and "tracks" not in J:   # the one-track format before Day One: it was the Beethoven loop
        tracks["beethoven"] = {**TRACKS["beethoven"], **{k: J[k] for k in ("source_sha256", "loop_s", "film_s") if k in J}}
    tracks[a.track] = T
    json.dump({"tracks": [tracks[k] for k in ORDER if k in tracks]}, open(jp, "w"), indent=1)
    print(json.dumps({"track": a.track, "sha256": h, "loop_s": T["loop_s"]}))


if __name__ == "__main__":
    main()
