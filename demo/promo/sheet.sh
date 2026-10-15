#!/bin/sh
# Builds a 2x2 contact sheet from stills in out/stills.
# Usage: ./sheet.sh <out.png> <t1> <t2> <t3> <t4>   (t = seconds as written by render.mjs, e.g. 5.60)
set -e
cd "$(dirname "$0")/out/stills"
OUT="$1"; shift
ffmpeg -v error -y -i "t-$1.png" -i "t-$2.png" -i "t-$3.png" -i "t-$4.png" \
  -filter_complex "[0]scale=960:-1[a];[1]scale=960:-1[b];[2]scale=960:-1[c];[3]scale=960:-1[d];[a][b]hstack[r1];[c][d]hstack[r2];[r1][r2]vstack" \
  -frames:v 1 "$OUT"
