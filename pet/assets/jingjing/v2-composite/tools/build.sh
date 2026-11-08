#!/usr/bin/env bash
# Rebuild the v2 expression frames from raw image-tool edits. Run from the jingjing-overlay folder:
#   bash assets/jingjing/v2-composite/tools/build.sh thinking smug panic
# closed = face pass on neutral_closed, then mouth and brow passes (thin strokes);
# open   = mouth pass on that closed frame, so eyes stay identical while the mouth flaps.
set -euo pipefail
RAW=assets/jingjing/v2-staging/raw
OUT=assets/jingjing/v2-composite
BASE=assets/jingjing
TOOL="uv run --quiet --with pillow --with numpy python -I assets/jingjing/v2-composite/tools/composite.py"
# Emotions whose raw edit moved the brows: neutral's brows sit above the face box and must be replaced too,
# otherwise two pairs show. stubborn and serious fixed 2026-11-05; smug added 2026-11-08.
OLD_BROW_EMOTIONS=" stubborn serious smug "
for emotion in "$@"; do
    $TOOL "$BASE/neutral_closed.png" "$RAW/${emotion}_closed.raw.png" "$OUT/${emotion}_closed.png" face
    $TOOL "$OUT/${emotion}_closed.png" "$RAW/${emotion}_closed.raw.png" "$OUT/${emotion}_closed.png" mouth
    $TOOL "$OUT/${emotion}_closed.png" "$RAW/${emotion}_closed.raw.png" "$OUT/${emotion}_closed.png" brows
    if [[ "$OLD_BROW_EMOTIONS" == *" $emotion "* ]]; then
        $TOOL "$OUT/${emotion}_closed.png" "$RAW/${emotion}_closed.raw.png" "$OUT/${emotion}_closed.png" oldbrows
    fi
    if [ -f "$RAW/${emotion}_open.raw.png" ]; then
        $TOOL "$OUT/${emotion}_closed.png" "$RAW/${emotion}_open.raw.png" "$OUT/${emotion}_open.png" mouth
    fi
done
