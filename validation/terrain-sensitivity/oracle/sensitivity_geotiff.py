#!/usr/bin/env python3
"""Terrain sensitivity GeoTIFF reader, written independently of the viewer.

Reads validation/terrain-sensitivity/fixture/terrain_sensitivity.tif byte by
byte from the TIFF 6.0 and OGC GeoTIFF 1.1 layouts and the GDAL_METADATA /
GDAL_NODATA tag conventions, then checks it against expected.json:

  - classic little-endian TIFF, one IFD, uncompressed, one strip;
  - two samples per pixel, 32-bit IEEE float each, PlanarConfiguration 1,
    ExtraSamples [0];
  - GDAL_METADATA band names sensitivity_range and sensitivity_members with
    their units, and GDAL_NODATA;
  - ModelPixelScale, ModelTiepoint (upper-left corner, PixelIsArea) and the
    projected EPSG GeoKey against the grid in expected.json;
  - every cell of both bands against expected.json, NoData where it is null.

It also recomputes both bands from the four member height grids listed in
expected.json rather than reading them: band 1 is the highest minus the
lowest member height at the cell, band 2 the number of members with a
height, and a cell is NoData exactly where member 0 (the DEM) has no height.

--check also runs a negative control: it perturbs one written cell of each
band in memory and confirms the checks then fail.

Agreement means the writer and this reader agree on the file format and on
that rule. It says nothing about how close any height is to the ground.

Nothing here imports OpenLiDARViewer code. Standard library only.

Usage: sensitivity_geotiff.py [--dir DIR] [--check]   exit 0 when every check holds.
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
TREE = os.path.realpath(os.path.join(HERE, '..'))

TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 12: 8}
TYPE_FMT = {1: 'B', 3: 'H', 4: 'I', 12: 'd'}
NBANDS = 2
NMEMBERS = 4
BAND_KEYS = ['sensitivityRange', 'sensitivityMembers']
MAX_CELLS = 1_000_000  # far above any committed fixture; bounds every loop below


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
            tags[tag] = data[at:at + count - 1].decode('ascii')
        else:
            tags[tag] = list(struct.unpack_from('<%d%s' % (count, TYPE_FMT[typ]), data, at))
    if struct.unpack_from('<I', data, start + 2 + 12 * n)[0] != 0:
        raise ValueError('more than one IFD')
    return tags


def geokeys(directory):
    out = {}
    for k in range(directory[3]):
        key, loc, count, value = directory[4 + 4 * k: 8 + 4 * k]
        if loc != 0 or count != 1:
            raise ValueError('GeoKey %d not an inline SHORT' % key)
        out[key] = value
    return out


def f32(x):
    return struct.unpack('<f', struct.pack('<f', x))[0]


def confined_dir(path):
    """Map a CLI directory onto a directory of this oracle tree, or refuse it."""
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
    check(t[277] == [NBANDS], 'samples per pixel is not %d' % NBANDS)
    check(t[258] == [32] * NBANDS, 'bits per sample')
    check(t[339] == [3] * NBANDS, 'sample format is not IEEE float')
    check(t[284] == [1], 'planar configuration is not 1')
    check(t[338] == [0] * (NBANDS - 1), 'extra samples')
    check(t[278] == [rows], 'rows per strip')
    check(t[279] == [cols * rows * NBANDS * 4], 'strip byte count')


def check_band_metadata(t, exp, check):
    meta = ET.fromstring(t[42112])
    names, units = {}, {}
    for item in meta.findall('Item'):
        sample = int(item.get('sample'))
        if item.get('role') == 'description':
            names[sample] = item.text
        elif item.get('role') == 'unittype':
            units[sample] = item.text
    check([names.get(i) for i in range(NBANDS)] == ['sensitivity_range', 'sensitivity_members'],
          'band names %r' % names)
    check([units.get(i) for i in range(NBANDS)] == exp['bandUnits'], 'band units %r' % units)


def check_georef(t, exp, rows, check):
    cell = exp['cellSize']
    check(t[33550] == [cell, cell, 0.0], 'pixel scale %r' % t[33550])
    check(t[33922] == [0.0, 0.0, 0.0, exp['xllCorner'], exp['yllCorner'] + rows * cell, 0.0],
          'tiepoint %r' % t[33922])
    keys = geokeys(t[34735])
    check(keys.get(1024) == 1, 'model type is not projected')
    check(keys.get(1025) == 1, 'raster type is not PixelIsArea')
    check(keys.get(3072) == exp['epsg'], 'projected EPSG %r' % keys.get(3072))
    check(4096 not in keys, 'sensitivity raster declares a vertical CRS')


def decode_bands(data, off, cols, rows, nodata):
    # Row 0 of the file is the north row; expected.json is south-first.
    bands = [[None] * (cols * rows) for _ in range(NBANDS)]
    fmt = '<%df' % NBANDS
    o = off
    for r in range(rows):
        grid_row = rows - 1 - r
        for c in range(cols):
            vals = struct.unpack_from(fmt, data, o)
            o += 4 * NBANDS
            for b in range(NBANDS):
                bands[b][grid_row * cols + c] = None if vals[b] == nodata else vals[b]
    return bands


def check_bands(bands, exp, n, check):
    for b, key in enumerate(BAND_KEYS):
        bad = [i for i in range(n) if bands[b][i] != exp[key][i]]
        check(not bad, '%s differs at cells %r' % (key, bad[:5]))


def check_recomputed(bands, exp, n, check):
    heights = exp['memberHeights']
    check(len(heights) == NMEMBERS, 'expected %d member grids, found %d' % (NMEMBERS, len(heights)))
    check(all(len(h) == n for h in heights), 'member grid length')
    rng, cnt = bands
    for i in range(n):
        zs = [h[i] for h in heights if h[i] is not None]
        if heights[0][i] is None:
            check(rng[i] is None and cnt[i] is None, 'band 1 at cell %d: written where the DEM has no height' % i)
            continue
        want_range = f32(f32(max(zs)) - f32(min(zs)))
        check(rng[i] == want_range, 'band 1 at cell %d: %r, recomputed %r' % (i, rng[i], want_range))
        check(cnt[i] == float(len(zs)), 'band 2 at cell %d: %r, recomputed %r' % (i, cnt[i], len(zs)))


def run_checks(data, exp, bands_override=None):
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
    bands = bands_override if bands_override is not None else decode_bands(data, t[273][0], cols, rows, nodata)
    check_bands(bands, exp, n, check)
    check_recomputed(bands, exp, n, check)
    return failures, bands


def negative_control(data, exp, bands):
    """Perturb one written cell of each band; each must be caught."""
    missed = []
    for b in range(NBANDS):
        i = next((k for k, v in enumerate(bands[b]) if v is not None), None)
        if i is None:
            missed.append('band %d has no written cell to perturb' % (b + 1))
            continue
        bad = [list(x) for x in bands]
        bad[b][i] = bad[b][i] + 1.0
        failures, _ = run_checks(data, exp, bad)
        if not any('band %d at cell %d' % (b + 1, i) in f for f in failures):
            missed.append('a wrong band %d value at cell %d was not caught' % (b + 1, i))
    return missed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=DEFAULT_DIR)
    ap.add_argument('--check', action='store_true', help='also run the negative control')
    args = ap.parse_args()
    base = confined_dir(args.dir)

    with open(os.path.join(base, 'terrain_sensitivity.tif'), 'rb') as fh:
        data = fh.read()
    with open(os.path.join(base, 'expected.json'), encoding='utf-8') as fh:
        exp = json.load(fh)

    failures, bands = run_checks(data, exp)
    if args.check and not failures:
        failures = negative_control(data, exp, bands)
    if failures:
        for f in failures:
            print('FAIL', f)
        return 1
    cols, rows = grid_size(exp)
    print('OK terrain_sensitivity.tif: %d x %d, %d bands, %d members; every cell matches and recomputes'
          % (cols, rows, NBANDS, NMEMBERS))
    return 0


if __name__ == '__main__':
    sys.exit(main())
