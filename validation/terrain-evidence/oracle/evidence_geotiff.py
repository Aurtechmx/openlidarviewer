#!/usr/bin/env python3
"""Terrain evidence GeoTIFF reader, written independently of the viewer.

Reads validation/terrain-evidence/fixture/terrain_evidence.tif byte by byte
from the TIFF 6.0 and OGC GeoTIFF 1.1 layouts and the GDAL_METADATA /
GDAL_NODATA tag conventions, then checks it against the TypeScript values in
expected.json:

  - classic little-endian TIFF, one IFD, uncompressed, one strip;
  - six samples per pixel, 32-bit IEEE float each, PlanarConfiguration 1,
    ExtraSamples [0, 0, 0, 0, 0];
  - GDAL_METADATA band names support_count, interpolation_distance,
    cell_state, nearest_support_distance, vertical_dispersion, edge_distance
    with their units, and GDAL_NODATA;
  - ModelPixelScale, ModelTiepoint (upper-left corner, PixelIsArea) and the
    projected EPSG GeoKey against the grid in expected.json;
  - every cell of every band against expected.json, NoData where it is null.

It also recomputes from the raster (and, for band 5, from the fixture's
ground returns) rather than reading them:

  - band 2 / cell size equals the Chebyshev distance (8-connected steps on an
    open grid) from each cell to the nearest cell with support_count > 0;
  - band 4 / cell size equals the straight-line distance to the nearest cell
    centre with support_count > 0, by brute force over every pair;
  - band 5 is the median absolute deviation of the cell's returns in
    expected.json (median of |z - median z|), NoData under two returns;
  - band 6 / cell size is the 4-connected step count to the survey boundary:
    NoData cells at 0, measured cells on the grid edge at 1, stepping through
    written cells only;
  - cell_state is 1 exactly where support_count > 0, 4 exactly on the filled
    cells 3 or more steps from a measured cell, and 5 exactly on the other
    filled cells within edgeAffectedWithinCells steps of the boundary.

--check also runs a negative control: it perturbs one written cell of each
recomputed band in memory and confirms the checks then fail.

Agreement means the writer and this reader agree on the file format and on
those rules. It says nothing about the accuracy of any height.

Nothing here imports OpenLiDARViewer code. Standard library only.

Usage: evidence_geotiff.py [--dir DIR] [--check]   exit 0 when every check holds.
"""

import argparse
import hashlib
import json
import os
import struct
import sys
import xml.etree.ElementTree as ET
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DIR = os.path.join(HERE, '..', 'fixture')

TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 12: 8}
TYPE_FMT = {1: 'B', 3: 'H', 4: 'I', 12: 'd'}
NBANDS = 6
BAND_KEYS = ['supportCount', 'interpolationDistance', 'cellState',
             'nearestSupportDistance', 'verticalDispersion', 'edgeDistance']
MAX_RETURNS = 10_000  # per cell; bounds the median loops


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
    check([names.get(i) for i in range(NBANDS)] == exp['bandNames'], 'band names %r' % names)
    check([units.get(i) for i in range(NBANDS)] == exp['bandUnits'], 'band units %r' % units)
    check(exp['bandNames'][:3] == ['support_count', 'interpolation_distance', 'cell_state'],
          'bands 1 to 3 moved from the ED-1 layout')


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


def check_bands(bands, exp, n, cell, check):
    for b, key in enumerate(BAND_KEYS):
        bad = [i for i in range(n) if bands[b][i] != exp[key][i]]
        check(not bad, '%s differs at cells %r' % (key, bad[:5]))
    dist = bands[1]
    for i in range(n):
        if exp['interpDistanceCells'][i] is not None:
            check(dist[i] == f32(exp['interpDistanceCells'][i] * cell),
                  'band 2 != interpDistanceCells x cell size at %d' % i)


def median(values):
    """Type-7 median, the same arithmetic as the viewer's quantile helper."""
    v = sorted(values)
    h = (len(v) - 1) / 2.0
    lo, hi = int(h), int(h) if h == int(h) else int(h) + 1
    if lo == hi:
        return v[lo]
    return v[lo] * 0.5 + v[hi] * 0.5


def mad(values):
    m = median(values)
    return median([abs(x - m) for x in values])


def edge_steps(written, measured, cols, rows):
    """4-connected steps to the survey boundary (cells without a height at 0,
    measured cells on the grid edge at 1), stepping through written cells."""
    n = cols * rows
    dist = [None] * n
    queue = deque()
    # Breadth-first in distance order: every 0 seed, then every 1 seed.
    for i in range(n):
        if not written[i]:
            dist[i] = 0
            queue.append(i)
    for i in range(n):
        x, y = i % cols, i // cols
        if written[i] and measured[i] and (x == 0 or y == 0 or x == cols - 1 or y == rows - 1):
            dist[i] = 1
            queue.append(i)
    visits = 0
    while queue and visits <= n:
        visits += 1
        i = queue.popleft()
        x, y = i % cols, i // cols
        for nx, ny in ((x, y - 1), (x, y + 1), (x - 1, y), (x + 1, y)):
            if 0 <= nx < cols and 0 <= ny < rows:
                j = ny * cols + nx
                if written[j] and dist[j] is None:
                    dist[j] = dist[i] + 1
                    queue.append(j)
    return dist


def check_recomputed(bands, exp, cols, rows, cell, check):
    n = cols * rows
    count, dist, state, near, disp, edge = bands
    written = [v is not None for v in count]
    measured_flag = [count[i] is not None and count[i] > 0 for i in range(n)]
    measured = [(i % cols, i // cols) for i in range(n) if measured_flag[i]]
    edges = edge_steps(written, measured_flag, cols, rows)
    within = exp['edgeAffectedWithinCells']
    resolved = exp['frameResolved']
    returns = exp['returns']
    check(len(returns) == n, 'returns list length')
    for i in range(n):
        if count[i] is None:
            continue
        x, y = i % cols, i // cols
        steps = min(max(abs(x - mx), abs(y - my)) for mx, my in measured)
        d2 = min((x - mx) ** 2 + (y - my) ** 2 for mx, my in measured)
        check(dist[i] == f32(steps * cell), 'band 2 at cell %d: %r, recomputed %r' % (i, dist[i], steps * cell))
        check(near[i] == f32(d2 ** 0.5 * cell), 'band 4 at cell %d: %r, recomputed %r' % (i, near[i], d2 ** 0.5 * cell))
        zs = returns[i][:MAX_RETURNS]
        check(len(zs) == count[i], 'returns at cell %d do not match support_count' % i)
        want = f32(mad(zs)) if len(zs) >= 2 else None
        check(disp[i] == want, 'band 5 at cell %d: %r, recomputed %r' % (i, disp[i], want))
        want_edge = None if edges[i] is None else f32(edges[i] * cell)
        check(edge[i] == want_edge, 'band 6 at cell %d: %r, recomputed %r' % (i, edge[i], want_edge))
        if not resolved:
            check(state[i] == 6, 'cell_state 6 on an unresolved frame at %d' % i)
            continue
        check((state[i] == 1) == (count[i] > 0), 'cell_state 1 <-> support_count > 0 at %d' % i)
        check((state[i] == 4) == (count[i] == 0 and steps >= 3), 'cell_state 4 rule at %d' % i)
        near_edge = edges[i] is not None and edges[i] <= within
        check((state[i] == 5) == (count[i] == 0 and steps < 3 and near_edge), 'cell_state 5 rule at %d' % i)
        check(state[i] in (1, 2, 3, 4, 5), 'cell_state code %r at %d' % (state[i], i))


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
    check_bands(bands, exp, n, exp['cellSize'], check)
    check_recomputed(bands, exp, cols, rows, exp['cellSize'], check)
    return failures, bands


def negative_control(data, exp, bands):
    """Perturb one written cell of each recomputed band; each must be caught."""
    missed = []
    for b in (1, 2, 3, 4, 5):
        i = next((k for k, v in enumerate(bands[b]) if v is not None), None)
        if i is None:
            missed.append('band %d has no written cell to perturb' % (b + 1))
            continue
        bad = [list(x) for x in bands]
        bad[b][i] = bad[b][i] + 1.0
        failures, _ = run_checks(data, exp, bad)
        if not any('band %d at cell %d' % (b + 1, i) in f or 'cell_state' in f for f in failures):
            missed.append('a wrong band %d value at cell %d was not caught' % (b + 1, i))
    return missed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=DEFAULT_DIR)
    ap.add_argument('--check', action='store_true', help='also run the negative control')
    args = ap.parse_args()
    base = confined_dir(args.dir)

    with open(os.path.join(base, 'terrain_evidence.tif'), 'rb') as fh:
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
    n = cols * rows
    written = sum(1 for v in bands[2] if v is not None)
    print('evidence_geotiff: OK: %dx%d grid, %d Float32 bands, %d written cells, %d NoData%s'
          % (cols, rows, NBANDS, written, n - written,
             '; negative control caught a wrong value in bands 2 to 6' if args.check else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
