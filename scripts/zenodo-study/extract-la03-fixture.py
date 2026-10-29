#!/usr/bin/env python3
"""
extract-la03-fixture.py: a small sample of real LA03mapry.laz records for the
colour recommender test. Optional; not part of `npm run validate:zenodo-small`.

Source: Hrdina, M. LiDAR Scanners Comparison - Point Clouds, LA03mapry.laz.
Zenodo. https://doi.org/10.5281/zenodo.15421291 (CC BY 4.0), registered as
OLV-DS-054-SCANCMP-LA03.

Selection: source record indices 0, k, 2k, ... with k = point_count // N, the
first N of them. The records are copied unchanged (same point format, scale,
offset and every attribute); only the header counts and bounds are rewritten.

Usage (pinned venv, python -I):
  extract-la03-fixture.py <LA03mapry.laz> <out.las> [N=2000]
"""
import hashlib
import json
import sys

import laspy
import numpy as np

EXPECTED_SHA256 = '12a56908deea1b7462d8ca9d6fc7072fd04d1d8ac7eb616311f9c88ee0e2a4e9'


def main(src, out, n):
    h = hashlib.sha256()
    with open(src, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    if h.hexdigest() != EXPECTED_SHA256:
        sys.exit(f'SHA-256 mismatch: {h.hexdigest()}')
    las = laspy.read(src, laz_backend=laspy.LazBackend.Lazrs)
    total = int(las.header.point_count)
    k = total // n
    idx = np.arange(n, dtype=np.int64) * k
    sub = laspy.LasData(las.header)
    sub.points = las.points[idx].copy()
    sub.update_header()
    sub.write(out)
    print(json.dumps({'sourcePoints': total, 'stride': int(k), 'points': n,
                      'firstIndex': 0, 'lastIndex': int(idx[-1]),
                      'pointFormat': las.header.point_format.id,
                      'scale': [float(s) for s in las.header.scales],
                      'offset': [float(o) for o in las.header.offsets]}))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 2000)
