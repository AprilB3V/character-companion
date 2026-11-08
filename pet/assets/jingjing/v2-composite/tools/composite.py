"""Composite only the changed face pixels of a raw image-tool edit onto the approved base sprite.

Usage: composite.py <base.png> <raw.png> <out.png> [face|mouth|brows|oldbrows]
Mask = pixels differing from base by >24 inside the face box, dilated and feathered.
Outside the face box the output is byte-identical to the base; that is asserted.
"""
import hashlib
import json
import sys

import numpy as np
from PIL import Image, ImageFilter

FACE_BOX = (395, 455, 865, 715)  # left, top, right, bottom on the 1254x1254 canvas
THRESHOLD = 24

basePath, rawPath, outPath = sys.argv[1:4]
MODE = sys.argv[4] if len(sys.argv) > 4 else 'face'
# Optional 5th argument:
#   mouth - only the mouth box. Open frames are built on the emotion's closed frame this way, so eyes never
#           flicker while the mouth flaps; closed frames get a second mouth pass to keep thin mouth lines.
#   brows - only the brow band, for thin brow strokes the face pass filters out.
#   oldbrows - band above the face box where neutral's brows are drawn over the bangs (y~415-450). When the raw
#           edit moved or erased the brows, this pass takes the raw pixels there too; otherwise neutral's brows
#           survive outside the other boxes and the frame shows two pairs.
if MODE == 'mouth':
    FACE_BOX = (540, 580, 720, 690)
elif MODE == 'brows':
    FACE_BOX = (440, 455, 820, 512)
elif MODE == 'oldbrows':
    FACE_BOX = (440, 400, 820, 462)
# Thin strokes matter in the small boxes, and hair drift there is negligible, so they skip the opening.
OPEN_FILTER = MODE == 'face'
base = np.asarray(Image.open(basePath).convert('RGBA')).astype(np.float32)
raw = np.asarray(Image.open(rawPath).convert('RGBA')).astype(np.float32)
assert base.shape == raw.shape == (1254, 1254, 4), (base.shape, raw.shape)

diff = np.abs(raw - base).max(axis=2) > THRESHOLD
inside = np.zeros_like(diff)
left, top, right, bottom = FACE_BOX
inside[top:bottom, left:right] = True
seed = Image.fromarray((diff & inside).astype(np.uint8) * 255)
# Opening drops thin line-art drift (sub-pixel redraw of hair edges); solid changes (eyes, mouth, blush) survive.
blobs = seed.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5)) if OPEN_FILTER else seed
mask = blobs.filter(ImageFilter.MaxFilter(17 if OPEN_FILTER else 9)).filter(ImageFilter.GaussianBlur(4 if OPEN_FILTER else 3))
alpha = np.asarray(mask).astype(np.float32) / 255.0
# Fade to zero over the last 12 px inside the face box so nothing can form a hard edge there.
yy, xx = np.mgrid[0:base.shape[0], 0:base.shape[1]]
edgeDistance = np.minimum.reduce([xx - left, right - 1 - xx, yy - top, bottom - 1 - yy]).astype(np.float32)
alpha = alpha * np.clip(edgeDistance / 12.0, 0.0, 1.0)
alpha[~inside] = 0.0  # never leak outside the face box
out = base * (1 - alpha[..., None]) + raw * alpha[..., None]
out = np.clip(np.rint(out), 0, 255).astype(np.uint8)
Image.fromarray(out, 'RGBA').save(outPath)

check = np.asarray(Image.open(outPath).convert('RGBA'))
# Compare with the base as loaded before writing: the output may overwrite the base file in multi-pass builds.
baseBytes = base.astype(np.uint8)
outsideSame = bool((check[~inside] == baseBytes[~inside]).all())
assert outsideSame
ys, xs = np.nonzero(alpha > 0)
print(json.dumps({
    'file': outPath.replace('\\', '/').split('/')[-1],
    'base': basePath.replace('\\', '/').split('/')[-1],
    'raw': rawPath.replace('\\', '/').split('/')[-1],
    'maskBox': [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None,
    'changedPixels': int((alpha > 0).sum()),
    'outsideFaceBoxIdentical': outsideSame,
    'sha256': hashlib.sha256(open(outPath, 'rb').read()).hexdigest(),
}, ensure_ascii=False))
