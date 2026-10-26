# Field simulation: RichDEM reference grids

Six small grids from RichDEM, Richard Barnes's terrain analysis library, which
is the implementation the Priority-Flood paper (Barnes, Lehman and Mulla 2014)
was released with. They are kept here byte for byte as fetched, under their
upstream paths, and are read as data only. Nothing from RichDEM is built or
run. The comparison is pre-registered in
`validation/protocols/richdem-references-v1.md`.

Source: <https://github.com/r-barnes/richdem>, commit
`9a1c97bb2529e386451a7dd54768b8b74bb4d620`.

| File | Bytes | sha256 | Register id |
| --- | --- | --- | --- |
| `data/garbrecht.dem` | 206 | `8f5e69fe353940e95f4797af9d9312169ce6af7684342b9667d48950f58c7fb3` | `OLV-DS-122-RICHDEM-GARBRECHT-DEM` |
| `data/pit.dem` | 236 | `c81f23e1b217f31eea9870922c06e2a18bf545193ec769d0e98a80ac93b46370` | `OLV-DS-123-RICHDEM-PIT-DEM` |
| `tests/depressions/testdem1.dem` | 309 | `825730d5e4488f197c853989344d4f95d04d4ae77095df8492ddba08f445dd10` | `OLV-DS-124-RICHDEM-DEPRESSIONS-TESTDEM1` |
| `tests/depressions/testdem1.all.out` | 309 | `fd6c48bb002e35fb21750ab1aa5b7d0e3a366bace10702598f018d1fe99af249` | `OLV-DS-125-RICHDEM-DEPRESSIONS-TESTDEM1-FILLED` |
| `tests/flow_accum/testdem1.d8` | 309 | `15ec72b87f21801d2ff1b3884bc48a4bd65445ce062eecc164e2c3e373c0bbe1` | `OLV-DS-126-RICHDEM-FLOWACCUM-TESTDEM1-D8` |
| `tests/flow_accum/testdem1.out` | 510 | `ab4b94c92337d4b40478a1948b834855e3c64bae3f6ec8ef33f4e27672950936` | `OLV-DS-127-RICHDEM-FLOWACCUM-TESTDEM1-ACCUM` |

All six are Esri ASCII grids. Row 0 of the text is the northern row.

## What each file is, from RichDEM's own tests

Read from `tests/tests.cpp` and `include/richdem/` at the commit above.

- `tests/depressions/testdem1.all.out` is the expected result of the test case
  "Checking depression filling": `PriorityFlood_Original`,
  `PriorityFlood_Barnes2014`, `PriorityFlood_Zhou2016`, `PriorityFlood_Wei2018`
  and `FillDepressions`, all with D8 topology, must each turn
  `testdem1.dem` into exactly this grid. It is a filled elevation with no
  gradient. The grid edge drains; `NODATA_value` is 9 and no cell holds 9.
- `tests/flow_accum/testdem1.out` is the expected result of "Checking flow
  accumulation": `d8_flow_accum` applied to the directions in `testdem1.d8`,
  compared as a whole grid. In `d8_flow_accum` every cell counts itself, flow
  that leaves the grid is dropped, and a NoData cell gets NoData.
- Directions in `.d8` files use RichDEM's D8 layout: `2 3 4 / 1 0 5 / 8 7 6`
  around the centre, so 1 is west, 2 north-west, 3 north, 4 north-east, 5 east,
  6 south-east, 7 south, 8 south-west and 0 is no flow (`NO_FLOW`).
- `data/garbrecht.dem` and `data/pit.dem` are example grids. No test at this
  commit reads them and no expected output for them was fetched, so they serve
  here only as grids with hand-derived expectations.

## Licence

RichDEM is distributed under the GNU General Public License v3.0
(<https://github.com/r-barnes/richdem/blob/9a1c97bb2529e386451a7dd54768b8b74bb4d620/LICENSE.txt>).
The licence file does not say whether later versions apply. GPL-3.0 is
compatible with this repository's AGPL-3.0. Credit:

- Barnes, R. (2016). RichDEM: Terrain Analysis Software.
  <https://github.com/r-barnes/richdem>
- Barnes, R., Lehman, C., Mulla, D. (2014). Priority-flood: An optimal
  depression-filling and watershed-labeling algorithm for digital elevation
  models. Computers & Geosciences 62, 117-127.
  <https://doi.org/10.1016/j.cageo.2013.04.024>
