#!/bin/bash
# Add the music bed (build/music_film.m4a from scripts/story_music.py) to the rendered films, video copied, soft captions
# and chapters kept, credit written into the MP4 metadata. Run after scripts/story_render.sbatch.
#   bash scripts/story_mux_music.sh [ROOT]
set -euo pipefail
ROOT=${1:-docs/tng50/learn/how-a-spectrum-is-made}
MUSIC=$ROOT/build/music_film.m4a
[ -f "$MUSIC" ] || { echo "no $MUSIC: run python3 scripts/story_music.py first"; exit 1; }
CREDIT="Music: Beethoven, Symphony No. 7 in A major, Op. 92, II. Allegretto (orchestral recording)"
for f in "$ROOT"/media/story_1080p.mp4 "$ROOT"/media/story_720p.mp4; do
  [ -f "$f" ] || continue
  t=${f%.mp4}.music.mp4
  ffmpeg -nostdin -v error -y -i "$f" -i "$MUSIC" -map 0:v -map 1:a -map 0:s? -map_chapters 0 -map_metadata 0 \
    -c:v copy -c:s copy -c:a aac -b:a 160k -shortest -metadata comment="$CREDIT" \
    -metadata:s:a:0 language=zxx -movflags +faststart "$t"
  mv "$t" "$f"; echo "music added: $f ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f") s)"
done
