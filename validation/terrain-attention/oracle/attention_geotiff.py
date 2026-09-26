#!/usr/bin/env python3
"""Terrain attention GeoTIFF reader and residual recomputation, written
independently of the viewer.

Reads validation/terrain-attention/fixture/terrain_attention.tif byte by byte
from the TIFF 6.0 and OGC GeoTIFF 1.1 layouts and the GDAL_METADATA /
GDAL_NODATA tag conventions, then checks it against expected.json:

  - classic little-endian TIFF, one IFD, uncompressed, one strip;
  - two samples per pixel, 8-bit unsigned each, PlanarConfiguration 1,
    ExtraSamples [0];
  - GDAL_METADATA band names attention_level and dominant_reason with their
    units, and GDAL_NODATA 255;
  - ModelPixelScale, ModelTiepoint (upper-left corner, PixelIsArea) and the
    projected EPSG GeoKey against the grid in expected.json;
  - every cell of both bands against expected.json, NoData where it is null.

It recomputes rather than reads:

  - the reconstruction residual of every measured cell, from the heights and
    return counts: the cell is held out and rebuilt from its measured
    8-neighbours by an inverse distance prefill over the window of the cell
    and its in-grid neighbours, then a shortest path over that window whose
    step cost is sqrt(step^2 + dz^2), blending the measured neighbours with
    weight 1 / cost^2 (the rule recorded in
    validation/protocols/evidencedem-attention-v1.md). Heights are held in
    32-bit float where the file format and the writer hold them;
  - the attention level and dominant reason of every cell, from the scores
    and cut-offs recorded in the same protocol, using the recomputed
    residual.

--check also runs a negative control: it perturbs one written cell of each
band and one residual in memory and confirms the checks then fail.

Agreement means the writer and this reader agree on the file format and on
those rules. It says nothing about how close any height is to the ground.

Nothing here imports OpenLiDARViewer code. Standard library only.

Usage: attention_geotiff.py [--dir DIR] [--check]   exit 0 when every check holds.
"""

import argparse
import hashlib
import heapq
import json
import math
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
BAND_KEYS = ['attentionLevel', 'dominantReason']
MAX_CELLS = 1_000_000  # far above any committed fixture; bounds every loop below
RESIDUAL_TOL = 1e-6


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
    check(t[258] == [8] * NBANDS, 'bits per sample')
    check(t[339] == [1] * NBANDS, 'sample format is not unsigned integer')
    check(t[284] == [1], 'planar configuration is not 1')
    check(t[338] == [0] * (NBANDS - 1), 'extra samples')
    check(t[278] == [rows], 'rows per strip')
    check(t[279] == [cols * rows * NBANDS], 'strip byte count')


def check_band_metadata(t, exp, check):
    meta = ET.fromstring(t[42112])
    names, units = {}, {}
    for item in meta.findall('Item'):
        sample = int(item.get('sample'))
        if item.get('role') == 'description':
            names[sample] = item.text
        elif item.get('role') == 'unittype':
            units[sample] = item.text
    check([names.get(i) for i in range(NBANDS)] == ['attention_level', 'dominant_reason'], 'band names %r' % names)
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


def decode_bands(data, off, cols, rows, nodata):
    # Row 0 of the file is the north row; expected.json is south-first.
    bands = [[None] * (cols * rows) for _ in range(NBANDS)]
    o = off
    for r in range(rows):
        grid_row = rows - 1 - r
        for c in range(cols):
            for b in range(NBANDS):
                v = data[o]
                o += 1
                bands[b][grid_row * cols + c] = None if v == nodata else v
    return bands


# ── residual ────────────────────────────────────────────────────────────────

def measured(exp, i):
    return exp['counts'][i] > 0 and exp['heights'][i] is not None


def rebuild(exp, index, cell_x=1.0, cell_y=1.0, zscale=1.0):
    cols, rows = exp['cols'], exp['rows']
    col, row = index % cols, index // cols
    c0, c1 = max(0, col - 1), min(cols - 1, col + 1)
    r0, r1 = max(0, row - 1), min(rows - 1, row + 1)
    cells = [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]
    z = {}
    for r, c in cells:
        j = r * cols + c
        if j != index and measured(exp, j):
            z[(r, c)] = f32(exp['heights'][j])
    if not z:
        return None
    # Inverse distance prefill of every non-measured window cell, search radius 1.
    surface = dict(z)
    for r, c in cells:
        if (r, c) in z:
            continue
        w_sum = v_sum = 0.0
        for (mr, mc), v in z.items():
            if max(abs(mr - r), abs(mc - c)) == 1:
                w = 1.0 / (math.hypot(mr - r, mc - c) ** 2)
                w_sum += w
                v_sum += w * v
        surface[(r, c)] = f32(v_sum / w_sum) if w_sum > 0 else None
    # Shortest path from the held-out cell; measured cells end a path.
    diag = math.hypot(cell_x, cell_y)
    dist = {(row, col): 0.0}
    heap = [(0.0, row, col)]
    done = set()
    while heap:
        d, r, c = heapq.heappop(heap)
        if (r, c) in done or d > dist[(r, c)]:
            continue
        done.add((r, c))
        if (r, c) in z:
            continue
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nb = (r + dr, c + dc)
                if nb not in surface or surface[nb] is None:
                    continue
                step = diag if dr and dc else (cell_x if dc else cell_y)
                dz = (surface[nb] - surface[(r, c)]) * zscale
                nd = d + math.sqrt(step * step + dz * dz)
                if nb not in dist or nd < dist[nb]:
                    dist[nb] = nd
                    heapq.heappush(heap, (nd, nb[0], nb[1]))
    w_sum = v_sum = 0.0
    for key, v in sorted(z.items()):
        if key in dist:
            w = 1.0 / (dist[key] ** 2)
            w_sum += w
            v_sum += w * v
    return f32(v_sum / w_sum) if w_sum > 0 else None


def recompute_residual(exp):
    n = exp['cols'] * exp['rows']
    out = [None] * n
    for i in range(n):
        if not measured(exp, i):
            continue
        rb = rebuild(exp, i)
        if rb is not None:
            out[i] = f32(abs(f32(exp['heights'][i]) - rb))
    return out


# ── attention ───────────────────────────────────────────────────────────────

def clip01(x):
    if x is None or not math.isfinite(x):
        return 0.0
    return min(1.0, max(0.0, x))


def level_of(score, cuts):
    lvl = 0
    for k, cut in enumerate(cuts):
        if score >= cut:
            lvl = k + 1
    return lvl


def recompute_attention(exp, residual):
    p = exp['params']
    codes = p['reasonCodes']
    r_ref = p['verticalReference']
    n = exp['cols'] * exp['rows']
    level, reason = [0] * n, [0] * n
    for i in range(n):
        if exp['coverage'][i] == 0:
            continue
        interp = exp['interpDistanceCells'][i]
        scores = {
            'LONG_INTERPOLATION': clip01(None if interp is None else f32(interp) / p['longInterpolationCells']),
            'LOW_SUPPORT': clip01(1 - f32(exp['confidence'][i]) / p['lowSupportConfidence']),
            'EDGE_AFFECTED': 1.0 if exp['cellState'][i] == p['edgeAffectedState'] else 0.0,
            'MODEL_SENSITIVITY': clip01(f32(exp['sensitivityRange'][i]) / r_ref),
            'RECONSTRUCTION_RESIDUAL': clip01(None if residual[i] is None else residual[i] / r_ref),
        }
        best, best_name = 0.0, None
        for name in p['reasonOrder']:
            s = scores.get(name, 0.0)
            if s > best:
                best, best_name = s, name
        lv = level_of(best, p['levelCuts'])
        level[i] = lv
        if lv > 0:
            reason[i] = codes[best_name]
    return level, reason


def run_checks(data, exp, bands_override=None, residual_override=None):
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    check(hashlib.sha256(data).hexdigest() == exp['sha256'], 'file sha256 differs from expected.json')
    t = read_ifd(data)
    cols, rows = grid_size(exp)
    n = cols * rows
    check_layout(t, cols, rows, check)
    nodata = int(float(t[42113]))
    check(nodata == exp['noData'], 'GDAL_NODATA %r' % t[42113])
    check_band_metadata(t, exp, check)
    check_georef(t, exp, rows, check)
    bands = bands_override if bands_override is not None else decode_bands(data, t[273][0], cols, rows, nodata)
    for b, key in enumerate(BAND_KEYS):
        bad = [i for i in range(n) if bands[b][i] != exp[key][i]]
        check(not bad, '%s differs at cells %r' % (key, bad[:5]))

    residual = residual_override if residual_override is not None else recompute_residual(exp)
    for i in range(n):
        a, e = residual[i], exp['residual'][i]
        ok = (a is None and e is None) or (a is not None and e is not None and abs(a - e) <= RESIDUAL_TOL)
        check(ok, 'residual at cell %d: expected.json %r, recomputed %r' % (i, e, a))

    level, reason = recompute_attention(exp, residual)
    for i in range(n):
        written = exp['coverage'][i] != 0 and exp['heights'][i] is not None
        if not written:
            check(bands[0][i] is None and bands[1][i] is None, 'band 1 at cell %d: written where the DEM has no height' % i)
            continue
        check(bands[0][i] == level[i], 'band 1 at cell %d: %r, recomputed %r' % (i, bands[0][i], level[i]))
        check(bands[1][i] == reason[i], 'band 2 at cell %d: %r, recomputed %r' % (i, bands[1][i], reason[i]))
    return failures, bands, residual


def negative_control(data, exp, bands, residual):
    """Perturb one written cell of each band, and one residual; each must be caught."""
    missed = []
    for b in range(NBANDS):
        i = next((k for k, v in enumerate(bands[b]) if v), None)
        if i is None:
            missed.append('band %d has no non-zero cell to perturb' % (b + 1))
            continue
        bad = [list(x) for x in bands]
        bad[b][i] = (bad[b][i] + 1) % 4
        failures, _, _ = run_checks(data, exp, bad)
        if not any('band %d at cell %d' % (b + 1, i) in f for f in failures):
            missed.append('a wrong band %d value at cell %d was not caught' % (b + 1, i))
    i = next((k for k, v in enumerate(residual) if v), None)
    if i is None:
        missed.append('no non-zero residual to perturb')
    else:
        bad = list(residual)
        bad[i] = bad[i] + 0.01
        failures, _, _ = run_checks(data, exp, None, bad)
        if not any('residual at cell %d' % i in f for f in failures):
            missed.append('a wrong residual at cell %d was not caught' % i)
    return missed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=DEFAULT_DIR)
    ap.add_argument('--check', action='store_true', help='also run the negative control')
    args = ap.parse_args()
    base = confined_dir(args.dir)

    with open(os.path.join(base, 'terrain_attention.tif'), 'rb') as fh:
        data = fh.read()
    with open(os.path.join(base, 'expected.json'), encoding='utf-8') as fh:
        exp = json.load(fh)

    failures, bands, residual = run_checks(data, exp)
    if args.check and not failures:
        failures = negative_control(data, exp, bands, residual)
    if failures:
        for f in failures:
            print('FAIL', f)
        return 1
    cols, rows = grid_size(exp)
    print('OK terrain_attention.tif: %d x %d, %d bands; every cell, residual, level and reason matches and recomputes'
          % (cols, rows, NBANDS))
    return 0


if __name__ == '__main__':
    sys.exit(main())
