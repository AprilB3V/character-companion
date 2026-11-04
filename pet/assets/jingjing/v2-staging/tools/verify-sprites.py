import hashlib
import json
import struct
import zlib
from pathlib import Path

STAGING = Path(__file__).resolve().parent.parent
SOURCE = STAGING.parent / 'neutral_closed.png'


def readRgba(path):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'Not a PNG'
    offset, compressed = 8, bytearray()
    while offset < len(data):
        length = struct.unpack_from('>I', data, offset)[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        if kind == b'IHDR':
            width, height, depth, color, _, _, interlace = struct.unpack('>IIBBBBB', payload)
            assert (depth, color, interlace) == (8, 6, 0), 'Requires 8-bit noninterlaced RGBA'
        elif kind == b'IDAT':
            compressed.extend(payload)
        offset += length + 12
    raw = zlib.decompress(compressed)
    stride = width * 4
    pixels = bytearray()
    previous = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        filterType = raw[start]
        row = bytearray(raw[start + 1:start + 1 + stride])
        for i in range(stride):
            left = row[i - 4] if i >= 4 else 0
            up = previous[i]
            upperLeft = previous[i - 4] if i >= 4 else 0
            if filterType == 1:
                predictor = left
            elif filterType == 2:
                predictor = up
            elif filterType == 3:
                predictor = (left + up) // 2
            elif filterType == 4:
                p = left + up - upperLeft
                a, b, c = abs(p - left), abs(p - up), abs(p - upperLeft)
                predictor = left if a <= b and a <= c else up if b <= c else upperLeft
            else:
                assert filterType == 0, 'Invalid PNG filter'
                predictor = 0
            row[i] = (row[i] + predictor) & 255
        pixels.extend(row)
        previous = row
    return width, height, pixels


def main():
    _, _, reference = readRgba(SOURCE)
    entries = []
    for path in sorted(STAGING.glob('*.png')):
        width, height, pixels = readRgba(path)
        entry = {'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                 'size': [width, height], 'mode': 'RGBA', 'diff_bbox': None, 'status': 'rejected'}
        corners = [pixels[(y * width + x) * 4 + 3] for x, y in
                   [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]]
        entry['alpha_corners'] = corners
        if (width, height) == (1254, 1254):
            minX, minY, maxX, maxY = width, height, -1, -1
            outsideCount = 0
            for i in range(0, len(pixels), 4):
                if any(abs(pixels[i + c] - reference[i + c]) > 24 for c in range(4)):
                    y, x = divmod(i // 4, width)
                    minX, minY, maxX, maxY = min(minX, x), min(minY, y), max(maxX, x), max(maxY, y)
                    outsideCount += not (380 <= x < 880 and 300 <= y < 720)
            if maxX >= 0:
                entry['diff_bbox'] = [minX, minY, maxX + 1, maxY + 1]
            entry['pixels_differing_outside_face'] = outsideCount
            if not any(corners) and not outsideCount and maxX >= 0:
                entry['status'] = 'ok'
            else:
                entry['reason'] = 'Differences outside face region' if outsideCount else 'Invalid alpha or no expression edit'
        else:
            entry['reason'] = 'Canvas size differs from 1254x1254'
        entries.append(entry)
        print(json.dumps(entry))
    manifest = {'tool': 'built-in image_gen', 'threshold': '>24 in any RGBA channel',
                'bbox_convention': '[left, top, right_exclusive, bottom_exclusive]',
                'allowed_face_region': [380, 300, 880, 720], 'files': entries}
    (STAGING / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=4) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
