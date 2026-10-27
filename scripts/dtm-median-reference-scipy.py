"""SciPy reference for the DTM median gridding study.

Run from the repository root:  python3 -I scripts/dtm-median-reference-scipy.py
Protocol: validation/protocols/dtm-median-gridding-v1.md
Writes validation/cross-implementation/dtm-median/scipy/<fixture>__median.asc
(row 0 is the north row, NODATA -9999) and scipy/reference-run.json.
"""
import hashlib, json, platform, sys
import numpy as np
import scipy
from scipy.stats import binned_statistic_2d

FIX = 'validation/cross-implementation/pdal-pipeline/fixtures/'
OUT = 'validation/cross-implementation/dtm-median/scipy/'
NAMES = ['pc-01-plane-buildings', 'pc-02-rolling-buildings', 'pc-03-ridge-buildings',
         'pc-04-plane-lowblunders', 'pc-05-plane-gap', 'pc-06-bare-plane',
         'pc-07-bare-rolling', 'pc-08-bare-ridge']
N = 50
EDGES = np.arange(0, N + 1, dtype=float)


def sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def write_asc(path, grid):
    with open(path, 'w') as f:
        f.write(f'ncols {N}\nnrows {N}\nxllcorner 0\nyllcorner 0\ncellsize 1\nNODATA_value -9999\n')
        for r in range(N - 1, -1, -1):
            f.write(' '.join('-9999' if np.isnan(v) else f'{v:.9f}' for v in grid[r]) + '\n')


outputs = []
for name in NAMES:
    a = np.loadtxt(FIX + name + '.csv', delimiter=',', skiprows=1)
    truth = np.array(list(open(FIX + name + '.truth').read().strip()), dtype=int)
    sel = a[truth == 1]
    # statistic[i, j] is x-bin i, y-bin j; transpose to [row=y][col=x].
    stat = binned_statistic_2d(sel[:, 0], sel[:, 1], sel[:, 2], statistic='median',
                               bins=[EDGES, EDGES]).statistic.T
    path = OUT + name + '__median.asc'
    write_asc(path, stat)
    outputs.append({'fixture': name, 'returns': int(len(sel)), 'path': path, 'sha256': sha(path)})

json.dump({
    'tool': 'scipy.stats.binned_statistic_2d',
    'statistic': 'median',
    'scipy': scipy.__version__, 'numpy': np.__version__,
    'python': platform.python_version(), 'platform': f'{sys.platform}-{platform.machine()}',
    'commandLine': 'python3 -I scripts/dtm-median-reference-scipy.py',
    'outputs': outputs,
}, open(OUT + 'reference-run.json', 'w'), indent=2)

# Protocol v2 (validation/protocols/dtm-median-gridding-v2.md): cell sizes
# 0.25, 0.5, 2 and 5 m, input shifted by (+0.37, +0.61) m, origin at the data
# minimum and extent from the rasterizeDtm rule. Writes
# scipy/cell<s>/<fixture>__median.asc and scipy/reference-run-v2.json.
import math, os
outputs2 = []
for s in [0.25, 0.5, 2, 5]:
    d = f'{OUT}cell{s:g}/'
    os.makedirs(d, exist_ok=True)
    for name in NAMES:
        a = np.loadtxt(FIX + name + '.csv', delimiter=',', skiprows=1)
        truth = np.array(list(open(FIX + name + '.truth').read().strip()), dtype=int)
        sel = a[truth == 1]
        x = sel[:, 0] + 0.37
        y = sel[:, 1] + 0.61
        ox, oy = float(x.min()), float(y.min())
        nc = int(math.floor((x.max() - ox) / s)) + 1
        nr = int(math.floor((y.max() - oy) / s)) + 1
        ex = ox + s * np.arange(nc + 1, dtype=float)
        ey = oy + s * np.arange(nr + 1, dtype=float)
        stat = binned_statistic_2d(x, y, sel[:, 2], statistic='median', bins=[ex, ey]).statistic.T
        path = f'{d}{name}__median.asc'
        with open(path, 'w') as f:
            f.write(f'ncols {nc}\nnrows {nr}\nxllcorner {ox!r}\nyllcorner {oy!r}\ncellsize {s!r}\nNODATA_value -9999\n')
            for r in range(nr - 1, -1, -1):
                f.write(' '.join('-9999' if np.isnan(v) else f'{v:.9f}' for v in stat[r]) + '\n')
        outputs2.append({'fixture': name, 'cellSize': s, 'returns': int(len(sel)), 'path': path, 'sha256': sha(path)})

json.dump({
    'tool': 'scipy.stats.binned_statistic_2d',
    'statistic': 'median',
    'protocol': 'validation/protocols/dtm-median-gridding-v2.md',
    'scipy': scipy.__version__, 'numpy': np.__version__,
    'python': platform.python_version(), 'platform': f'{sys.platform}-{platform.machine()}',
    'commandLine': 'python3 -I scripts/dtm-median-reference-scipy.py',
    'outputs': outputs2,
}, open(OUT + 'reference-run-v2.json', 'w'), indent=2)
