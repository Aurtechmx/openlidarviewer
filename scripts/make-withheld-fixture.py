#!/usr/bin/env python3
"""Write the one LAS fixture that carries classification flags.

Every other LAS fixture in this repository leaves the flag byte at zero. That
is why `V070_IMPLEMENTATION_LEDGER.md` entry L26 records the Withheld policy
as written but its consequence as unmeasured: there was no file in the tree on
which excluding Withheld points would change any number, so no test could
show what the exclusion costs or spares.

This writes such a file. It does NOT apply the policy anywhere; it gives the
policy something to be measured against.

The flags are spread deliberately rather than set on a block of points:

  - Withheld alone, on ground returns, so a ground-only reader sees the
    exclusion rather than it hiding behind a class filter.
  - Withheld together with Overlap, because a producer commonly sets Withheld
    on overlap points culled during flight-line merging, and the two must stay
    separable: `withheldPolicy` excludes the first and never the second.
  - Overlap alone, which must not be excluded by anything.
  - Synthetic and Key-point, which the policy does not read at all, present so
    a reader that confuses one bit for another fails here.
  - Points with no flags, so the file has a control group.

Separate from `make-fixtures.py` on purpose: that script rewrites every
fixture it owns, and several tests assert byte identity against those files.

Usage: make-withheld-fixture.py
"""
import sys
from pathlib import Path

import laspy
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "withheld-flags.las"

SCALE = (0.001, 0.001, 0.001)
OFFSET = (500000.0, 4100000.0, 200.0)

# 12 points on a 4x3 lattice, heights rising east, so a DTM built from the
# ground returns has a gradient whether or not the withheld ones are read.
XYZ = np.array(
    [[500000.0 + (i % 4) * 3.0, 4100000.0 + (i // 4) * 3.0, 200.0 + (i % 4) * 0.5]
     for i in range(12)],
    dtype=np.float64,
)

#            0  1  2  3  4  5  6  7  8  9 10 11
CLASS = np.array([2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 6, 6], dtype=np.uint8)
WITHHELD = np.array([0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0], dtype=bool)
OVERLAP = np.array([0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0], dtype=bool)
SYNTHETIC = np.array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], dtype=bool)
KEYPOINT = np.array([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0], dtype=bool)


def main() -> int:
    header = laspy.LasHeader(point_format=6, version="1.4")
    header.scales = np.array(SCALE, dtype=np.float64)
    header.offsets = np.array(OFFSET, dtype=np.float64)
    las = laspy.LasData(header)
    las.x = XYZ[:, 0]
    las.y = XYZ[:, 1]
    las.z = XYZ[:, 2]
    las.intensity = np.arange(12, dtype=np.uint16) * 10
    las.classification = CLASS
    las.withheld = WITHHELD
    las.overlap = OVERLAP
    las.synthetic = SYNTHETIC
    las.key_point = KEYPOINT
    OUT.parent.mkdir(parents=True, exist_ok=True)
    las.write(str(OUT))

    r = laspy.read(str(OUT))
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  points      {int(r.header.point_count)}")
    print(f"  withheld    {int(np.count_nonzero(r.withheld))}")
    print(f"  overlap     {int(np.count_nonzero(r.overlap))}")
    print(f"  synthetic   {int(np.count_nonzero(r.synthetic))}")
    print(f"  key_point   {int(np.count_nonzero(r.key_point))}")
    print(f"  ground (2)  {int(np.count_nonzero(r.classification == 2))}")
    print(f"  ground withheld {int(np.count_nonzero((r.classification == 2) & r.withheld))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
