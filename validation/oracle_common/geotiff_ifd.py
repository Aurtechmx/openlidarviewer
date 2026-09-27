"""Shared TIFF 6.0 / GeoTIFF 1.1 reading helpers for the terrain oracles.

Parses a classic little-endian TIFF's single IFD and its GeoKey directory
with struct only, confines a CLI directory to an oracle tree, and checks the
grid size and georeferencing tags against an expected.json. Nothing here
imports OpenLiDARViewer code. Standard library only.
"""

import os
import struct

TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 12: 8}
TYPE_FMT = {1: 'B', 3: 'H', 4: 'I', 12: 'd'}


def f32(x):
    return struct.unpack('<f', struct.pack('<f', x))[0]


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


def confined_dir(path, tree):
    """Map a CLI directory onto a directory of `tree`, or refuse it."""
    wanted = os.path.realpath(path)
    for root, dirs, _files in os.walk(tree):
        if os.path.realpath(root) == wanted:
            return root
        dirs.sort()
    raise SystemExit('refusing to read outside %s: %s' % (tree, wanted))


def grid_size(exp, max_cells):
    cols, rows = exp['cols'], exp['rows']
    if not (isinstance(cols, int) and isinstance(rows, int)):
        raise ValueError('cols/rows are not integers')
    if cols <= 0 or rows <= 0 or cols * rows > max_cells:
        raise ValueError('grid %rx%r outside 1..%d cells' % (cols, rows, max_cells))
    return cols, rows


def check_georef(t, exp, rows, check):
    cell = exp['cellSize']
    check(t[33550] == [cell, cell, 0.0], 'pixel scale %r' % t[33550])
    check(t[33922] == [0.0, 0.0, 0.0, exp['xllCorner'], exp['yllCorner'] + rows * cell, 0.0],
          'tiepoint %r' % t[33922])
    keys = geokeys(t[34735])
    check(keys.get(1024) == 1, 'model type is not projected')
    check(keys.get(1025) == 1, 'raster type is not PixelIsArea')
    check(keys.get(3072) == exp['epsg'], 'projected EPSG %r' % keys.get(3072))
