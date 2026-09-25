#!/usr/bin/env python3
"""Terrain evidence GeoTIFF reader, written independently of the viewer.

Reads validation/terrain-evidence/fixture/terrain_evidence.tif byte by byte
from the TIFF 6.0 and OGC GeoTIFF 1.1 layouts and the GDAL_METADATA /
GDAL_NODATA tag conventions, then checks it against the TypeScript values in
expected.json:

  - classic little-endian TIFF, one IFD, uncompressed, one strip;
  - three samples per pixel, 32-bit IEEE float each, PlanarConfiguration 1,
    ExtraSamples [0, 0];
  - GDAL_METADATA band names support_count, interpolation_distance,
    cell_state with their units, and GDAL_NODATA;
  - ModelPixelScale, ModelTiepoint (upper-left corner, PixelIsArea) and the
    projected EPSG GeoKey against the grid in expected.json;
  - every cell of every band against expected.json, NoData where it is null.

It also recomputes two things from the raster alone rather than reading them:

  - band 2 / cell size equals the Chebyshev distance (8-connected steps on an
    open grid) from each cell to the nearest cell with support_count > 0;
  - cell_state is 1 exactly where support_count > 0, and 4 exactly on the
    filled cells 3 or more steps from a measured cell.

Agreement means the writer and this reader agree on the file format and on
those two rules. It says nothing about the accuracy of any height.

Nothing here imports OpenLiDARViewer code. Standard library only.

Usage: evidence_geotiff.py [--dir DIR]   exit 0 when every check holds.
"""

import argparse
import hashlib
import json
import os
import struct
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DIR = os.path.join(HERE, '..', 'fixture')

TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 12: 8}
TYPE_FMT = {1: 'B', 3: 'H', 4: 'I', 12: 'd'}


def read_ifd(data):
    if data[:2] != b'II' or struct.unpack_from('<H', data, 2)[0] != 42:
        raise ValueError('not a classic little-endian TIFF')
    start = struct.unpack_from('<I', data, 4)[0]
    (n,) = struct.unpack_from('<H', data, start)
    tags = {}
    prev = -1
    for k in range(n):
        p = start + 2 + 12 * k
        tag, typ, count = struct.unpack_from('<HHI', data, p)
        if tag <= prev:
            raise ValueError('IFD tags not ascending at %d' % tag)
        prev = tag
        size = TYPE_SIZE[typ] * count
        at = p + 8 if size <= 4 else struct.unpack_from('<I', data, p + 8)[0]
        if typ == 2:
            raw = data[at:at + count]
            if not raw.endswith(b'\0'):
                raise ValueError('ASCII tag %d not NUL-terminated' % tag)
            tags[tag] = raw[:-1].decode('ascii')
        else:
            tags[tag] = list(struct.unpack_from('<%d%s' % (count, TYPE_FMT[typ]), data, at))
    (nxt,) = struct.unpack_from('<I', data, start + 2 + 12 * n)
    if nxt != 0:
        raise ValueError('more than one IFD')
    return tags


def geokeys(directory):
    version, _rev, _minor, n = directory[:4]
    if version != 1:
        raise ValueError('GeoKey directory version %d' % version)
    out = {}
    for k in range(n):
        key, loc, count, value = directory[4 + 4 * k: 8 + 4 * k]
        if loc != 0 or count != 1:
            raise ValueError('GeoKey %d not an inline SHORT' % key)
        out[key] = value
    return out


def f32(x):
    return struct.unpack('<f', struct.pack('<f', x))[0]


TREE = os.path.realpath(os.path.join(HERE, '..'))
MAX_CELLS = 1_000_000  # far above any committed fixture; bounds every loop below


def confined_dir(path):
    """Map a CLI directory onto a directory of this oracle tree, or refuse it.

    The returned path is the tree's own directory entry, never the argument,
    so nothing outside validation/terrain-evidence/ can be opened.
    """
    wanted = os.path.realpath(path)
    for root, dirs, _files in os.walk(TREE):
        if os.path.realpath(root) == wanted:
            return root
        dirs.sort()
    raise SystemExit('refusing to read outside %s: %s' % (TREE, wanted))


def grid_size(exp):
    cols, rows = exp['cols'], exp['rows']
    if not (isinstance(cols, int) and isinstance(rows, int)):
        raise ValueError('cols/rows are not integers')
    if cols <= 0 or rows <= 0 or cols * rows > MAX_CELLS:
        raise ValueError('grid %rx%r outside 1..%d cells' % (cols, rows, MAX_CELLS))
    return cols, rows


def check_layout(t, cols, rows, check):
    check(t[256] == [cols] and t[257] == [rows], 'image size')
    check(t[259] == [1], 'compression is not none')
    check(t[277] == [3], 'samples per pixel is not 3')
    check(t[258] == [32, 32, 32], 'bits per sample')
    check(t[339] == [3, 3, 3], 'sample format is not IEEE float')
    check(t[284] == [1], 'planar configuration is not 1')
    check(t[338] == [0, 0], 'extra samples')
    check(t[278] == [rows], 'rows per strip')
    check(t[279] == [cols * rows * 3 * 4], 'strip byte count')


def check_band_metadata(t, exp, check):
    meta = ET.fromstring(t[42112])
    names, units = {}, {}
    for item in meta.findall('Item'):
        sample = int(item.get('sample'))
        if item.get('role') == 'description':
            names[sample] = item.text
        elif item.get('role') == 'unittype':
            units[sample] = item.text
    check([names.get(i) for i in range(3)] == exp['bandNames'], 'band names %r' % names)
    check([units.get(i) for i in range(3)] == exp['bandUnits'], 'band units %r' % units)


def check_georef(t, exp, rows, check):
    cell = exp['cellSize']
    check(t[33550] == [cell, cell, 0.0], 'pixel scale %r' % t[33550])
    check(t[33922] == [0.0, 0.0, 0.0, exp['xllCorner'], exp['yllCorner'] + rows * cell, 0.0],
          'tiepoint %r' % t[33922])
    keys = geokeys(t[34735])
    check(keys.get(1024) == 1, 'model type is not projected')
    check(keys.get(1025) == 1, 'raster type is not PixelIsArea')
    check(keys.get(3072) == exp['epsg'], 'projected EPSG %r' % keys.get(3072))
    check(4096 not in keys, 'evidence raster declares a vertical CRS')


def decode_bands(data, off, cols, rows, nodata):
    # Row 0 of the file is the north row; expected.json is south-first.
    bands = [[None] * (cols * rows) for _ in range(3)]
    o = off
    for r in range(rows):
        grid_row = rows - 1 - r
        for c in range(cols):
            vals = struct.unpack_from('<3f', data, o)
            o += 12
            for b in range(3):
                bands[b][grid_row * cols + c] = None if vals[b] == nodata else vals[b]
    return bands


def check_bands(bands, exp, n, cell, check):
    for b, key in enumerate(['supportCount', 'interpolationDistance', 'cellState']):
        bad = [i for i in range(n) if bands[b][i] != exp[key][i]]
        check(not bad, '%s differs at cells %r' % (key, bad[:5]))
    dist = bands[1]
    for i in range(n):
        if exp['interpDistanceCells'][i] is not None:
            check(dist[i] == f32(exp['interpDistanceCells'][i] * cell),
                  'band 2 != interpDistanceCells x cell size at %d' % i)


def check_recomputed(bands, cols, n, cell, check):
    count, dist, state = bands
    measured = [(i % cols, i // cols) for i in range(n) if count[i] is not None and count[i] > 0]
    for i in range(n):
        if count[i] is None:
            continue
        x, y = i % cols, i // cols
        steps = min(max(abs(x - mx), abs(y - my)) for mx, my in measured)
        check(dist[i] == f32(steps * cell), 'band 2 at cell %d: %r, recomputed %r' % (i, dist[i], steps * cell))
        check((state[i] == 1) == (count[i] > 0), 'cell_state 1 <-> support_count > 0 at %d' % i)
        check((state[i] == 4) == (count[i] == 0 and steps >= 3), 'cell_state 4 rule at %d' % i)
        check(state[i] in (1, 2, 3, 4), 'cell_state code %r at %d' % (state[i], i))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=DEFAULT_DIR)
    args = ap.parse_args()
    base = confined_dir(args.dir)

    with open(os.path.join(base, 'terrain_evidence.tif'), 'rb') as fh:
        data = fh.read()
    with open(os.path.join(base, 'expected.json'), encoding='utf-8') as fh:
        exp = json.load(fh)

    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    check(hashlib.sha256(data).hexdigest() == exp['sha256'], 'file sha256 differs from expected.json')

    t = read_ifd(data)
    cols, rows = grid_size(exp)
    n = cols * rows
    check_layout(t, cols, rows, check)

    nodata = float(t[42113])
    check(nodata == exp['noData'], 'GDAL_NODATA %r' % t[42113])

    check_band_metadata(t, exp, check)
    check_georef(t, exp, rows, check)

    bands = decode_bands(data, t[273][0], cols, rows, nodata)
    check_bands(bands, exp, n, exp['cellSize'], check)
    check_recomputed(bands, cols, n, exp['cellSize'], check)

    written = sum(1 for v in bands[2] if v is not None)
    if failures:
        for f in failures:
            print('FAIL', f)
        return 1
    print('evidence_geotiff: OK: %dx%d grid, 3 Float32 bands, %d written cells, %d NoData'
          % (cols, rows, written, n - written))
    return 0


if __name__ == '__main__':
    sys.exit(main())
