# Coordinate precision invariants — v0.3.2 research-grade audit

OpenLiDARViewer holds itself to a research-grade precision contract on
georeferenced scans (positions retain millimetre-class fidelity in the
internal float pipeline). Measurement is for visual inspection rather
than survey-grade output unless the workflow has been validated against
survey-grade data and procedures. This document is the precision-audit
ledger: it spells out every coordinate space the runtime uses, where
Float64 ends and Float32 begins, and which tests pin each invariant.

If you change anything in the coordinate pipeline, re-validate against this
doc and update the corresponding test. The numbers here are the contract.

## Coordinate spaces

The pipeline has **three** distinct coordinate spaces. Knowing which space
you're in is the single biggest source of correctness bugs.

### 1. File CRS (Float64, large magnitudes)

The coordinates as stored in the source file — e.g. UTM 12N northing
4,100,876.789 m, Mercator easting 11,800,000.005 m, or geographic latitude
40.71428 °. Magnitudes can be in the millions for projected CRSs, hundreds
of degrees for geographic ones.

- **Reader:** the LAS chunk decoder reads `int32` X/Y/Z values, applies the
  per-cloud `scale` and `offset` from the LAS public header, both Float64.
- **Storage:** **NEVER stored as Float32.** A UTM coordinate at 4M m has
  only ~0.5 m precision when narrowed to Float32 — sub-mm precision needs
  Float64.

### 2. Local render space (Float32 + Float64 origin)

The space the GPU operates in. We pick a per-cloud integer `origin`
(`Math.floor(min)`) and subtract it from every coordinate **while still in
Float64**, then narrow the small residual to Float32. The residual stays
within roughly `[0, size_of_cloud]`, so for a 10 km × 10 km × 1 km scan,
the largest residual is 10,000 m — well within Float32's sub-mm sweet spot.

- **Storage:** Float32Array buffers on the GPU.
- **Origin:** kept as a Float64 `[number, number, number]` tuple on the
  `PointCloud` (`origin` field) or in `StreamingPointCloud.renderOrigin`.
- **Invariant:** `world = local + origin` is exact to within Float32
  precision of the local residual.

#### The frame behind that invariant

The addition above is one case of a general conversion, and every streaming
source now carries it explicitly as a `SpatialFrame`
(`src/geo/frame/spatialFrame.ts`). COPC, EPT and the OLV tile store build a
`translated-cartesian` frame from their own `renderOrigin`, so their arithmetic
is unchanged and `frame.isTranslationOnly` is true.

An offset is not enough for a source whose coordinates are geocentric. On a
globe the source +Z is the polar axis, not up, so a scene drawn without rotating
into a tangent frame is wrong about which way is down, and a Float32 buffer
holding a coordinate near the Earth's radius has lost the millimetre before the
first frame is drawn. `createLocalEnuFrame` covers that case: it subtracts the
anchor in Float64, then rotates into east-north-up, so render up is `[0, 0, 1]`
and the residual reaching Float32 is metre-scale.

Nothing ships on the rotating path yet, because no format OLV reads today
declares a geocentric frame. A consumer that still performs `local + origin`
directly should test `frame.isTranslationOnly` and refuse rather than report a
coordinate that a rotation would have moved by hundreds of metres.

Note what the frame will not do: decide that a source is geocentric. A tileset
whose coordinates sit near the Earth's radius may be EPSG:4978, or a local
model that happens to be large, and the numbers do not separate the two. The
frame is built from a declaration, never from the magnitude of a coordinate.

### 3. Camera/view space (Float32 on the GPU)

Three.js's standard space. Camera position + projection matrices operate
on the local-render-space coordinates.

- **Implication:** measurements computed against camera-space data inherit
  Float32 precision. For research-grade absolute distances, do the math
  against the world-space coordinates (local + origin) in Float64.

## The Float64 → Float32 narrow point

Exactly **one** narrow happens per coordinate, in `coordinateBridge.ts`:

```ts
export function recenter(coords: Float64Array, origin: [number, number, number]): Float32Array {
  const out = new Float32Array(coords.length);
  const [ox, oy, oz] = origin;
  for (let i = 0; i < coords.length; i += 3) {
    out[i]     = coords[i]     - ox;  // Float64 subtraction; narrow on assign
    out[i + 1] = coords[i + 1] - oy;
    out[i + 2] = coords[i + 2] - oz;
  }
  return out;
}
```

The subtraction happens in Float64 (both operands are doubles), and the
narrow to Float32 happens only on assignment to the `Float32Array`. Doing
those two steps in the opposite order — narrow first, subtract second —
would discard sub-metre detail before it could be kept. This is enforced
by `tests/coordinatePrecision.test.ts` and a regression check on the
COPC decode path.

### COPC streaming decode

`src/io/copc/copcChunkDecode.ts` inlines the same recenter for performance:

```ts
positions[i * 3]     = view.getInt32(p,     true) * sx + ox - rx;
positions[i * 3 + 1] = view.getInt32(p + 4, true) * sy + oy - ry;
positions[i * 3 + 2] = view.getInt32(p + 8, true) * sz + oz - rz;
```

`sx, sy, sz` are the LAS scale doubles; `ox, oy, oz` are the LAS offset
doubles; `rx, ry, rz` are the render origin doubles. The expression
`int * sx + ox - rx` evaluates in Float64 from end to end; the `Float32Array`
assignment is the single narrow. Verified by `tests/copcDecodePrecision.test.ts`.

## Inspection accuracy

`pointInfo.ts` reports absolute world coordinates by adding the render
origin back to the local position:

```ts
x: round(raw.local[0] + raw.origin[0], 3),
y: round(raw.local[1] + raw.origin[1], 3),
z: round(raw.local[2] + raw.origin[2], 3),
```

Rounded to 3 decimals = millimetres. The addition happens in Float64;
the Float32 precision of `raw.local` is the limiting factor (sub-mm
within 10 km of the render origin per the v0.3.1 precision contract).

## Measurements

Measurements are computed against the **local-space mesh positions**
(Float32). For a single scan whose render origin is the scan's own
floored-min, this is correct — both endpoints share the same origin so
the displacement is precise.

The unit reported by the measurement tool is METRES. For LAS files whose
CRS declares a non-metric linear unit (international foot, US survey
foot), the v0.3.2-Georef cut threads `crs.linearUnitToMetres` through so
measurements are converted to true metres before display. See
`tests/crs.test.ts` for the exact conversion factors:
- International foot: × 0.3048
- US survey foot: × 1200/3937 = 0.30480060960121922

## Annotation persistence

`Annotation.localPosition` is the render-space anchor; `worldPosition`
(optional) is the absolute coord. v0.2.8 + v0.3.1
guarantees the local position is a world-stable scan-space anchor (not
node-relative), so streaming-node refinement does not move annotations.

When a session is loaded against a re-opened scan, the local position is
the source of truth; the world position is recomputed from
`local + origin`. This preserves annotation positions exactly across
session reloads.

## Wide-area precision policy

Recentring bounds the Float32 residual by the cloud's extent rather than by
its absolute coordinate, which is why a UTM tile loads at sub-millimetre
resolution. It does not make the residual free. Float32 carries a 24-bit
significand, so the gap between representable values doubles at every power of
two. Past a certain extent the in-memory step reaches centimetres while the
source file is still millimetre-quantized, and a measurement then carries more
error than the data does.

`src/geo/inMemoryPrecision.ts` computes that step, grades it, and mints the
permit the scientific deliverables consult. It is pure: no DOM, no three.js.

### The quantity

For each axis the policy computes the **reach**, the largest local coordinate
magnitude the local-origin strategy leaves:

```
reach_a = max(|min_a − origin_a|, |max_a − origin_a|)
```

The two strategies the runtime uses are both covered. A single cloud is
recentred on `computeOrigin(min)` (`io/coordinateBridge.ts`), so its reach is
its own extent. A layer in a shared project frame (`geo/ProjectSpatialFrame.ts`)
is recentred on the project anchor, so its reach is its distance from that
anchor plus its own extent. A streaming COPC or EPT source is recentred on the
floored octree-cube centre, so its residuals straddle zero and its reach is read
from `dataBounds()`, the tight data extent, never from `localBounds()`, the
octree root cube.

The worst-case resolution on an axis is the Float32 spacing at that reach:

```
spacing(m) = 2^(floor(log2 m) − 23)
```

read from the IEEE-754 bit pattern rather than from `Math.log2`, so it is exact
at zero, at every binade edge, and at the top of the range. This is the same
quantity `PointCloud.rebaseQuantum` already reports for a mount, and the two
agree at every normal magnitude by test.

### Why that is the right figure

Float32 has a 24-bit significand. A value in the binade `[2^b, 2^(b+1))` is
stored as a 24-bit integer scaled by `2^(b−23)`, so `2^(b−23)` is the distance
between adjacent representable values there. Nothing between two adjacent
values survives storage: the assignment rounds to the nearer of the two, so the
largest error on one coordinate is half a step. Because the step is set by
magnitude, the far corner of the extent is where it is largest, which makes the
reach the correct argument for a worst case.

The policy also reports a **typical** step, the mean over coordinates spread
uniformly across `[0, reach]`. The step function is piecewise constant on
binades, so the mean has a closed form. With `b = floor(log2 R)` and
`top = 2^(b−23)`:

```
E[step] = (1/R) · [ Σ_{k<b} 2^(k−23)·2^k + top·(R − 2^b) ]
        = top · [ 1 − (2/3)·(2^b / R) ]
```

which runs from `top/3` when the reach sits exactly on a power of two to
`2·top/3` at the far end of a binade. `tests/inMemoryPrecision.test.ts` checks
it against a direct numerical integration of the real step function.

### The grades

| Grade | Worst-case step | Meaning |
|---|---|---|
| `fine` | ≤ 1 mm | The step adds nothing the source file did not already quantize away. |
| `coarse` | > 1 mm, ≤ 10 mm | Above the file's own quantum, inside the tightest accuracy class the data can be specified at. |
| `unusable` | > 10 mm | The step consumes that whole accuracy budget on its own. |
| `unknown` | no linear unit | The step has no length, so it is not graded. Never a pass. |

**1 mm** is where two independent anchors land. LAS and LAZ store scaled
integers and the conventional scale factor is 0.001, so a source file is itself
millimetre-quantized. And 1 mm is already this project's boundary elsewhere:
`REBASE_QUANTUM_BUDGET_M` in `src/app/LayerService.ts` refuses a mount that
cannot hold it.

**10 mm** is the tightest vertical accuracy class in the ASPRS positional
accuracy standard, 1 cm RMSE. A step above that consumes the entire error
budget of the strictest class a dataset can be specified at, before any analysis
has run. It is also the resolution the measurement surfaces print at
(`formatLength` switches to centimetres below a metre), so past it the final
digit of a reported figure is quantization rather than data.

### Measured, on a metre-unit grid

Produced and asserted by `tests/benchmark/inMemoryPrecisionExtents.test.ts`.

| Extent | Worst case | Typical | Grade |
|---|---|---|---|
| 100 m | 0.0076 mm | 0.0044 mm | fine |
| 1 km | 0.0610 mm | 0.0402 mm | fine |
| 4 km | 0.2441 mm | 0.1608 mm | fine |
| 10 km | 0.9766 mm | 0.4432 mm | fine |
| 20 km | 1.9531 mm | 0.8865 mm | coarse |
| 50 km | 3.9063 mm | 2.1996 mm | coarse |
| 100 km | 7.8125 mm | 4.3992 mm | coarse |
| 200 km | 15.6250 mm | 8.7983 mm | unusable |
| 400 km | 31.2500 mm | 17.5967 mm | unusable |
| 800 km | 62.5000 mm | 35.1933 mm | unusable |

A 1 km tile placed in a shared project frame pays for its distance from the
anchor, not for its own size: 0.061 mm at the anchor, 0.98 mm at 10 km out,
7.81 mm at 100 km, 31.25 mm at 500 km.

The grade boundaries therefore fall on exact powers of two. On a metre grid a
scan stays `fine` while its reach is under 16,384 m, and the refusal engages
once the reach reaches 131,072 m. A foot grid reaches the same metre steps
further out, because a foot is 0.3048 m: `fine` holds under 32,768 ft and the
refusal engages at 524,288 ft.

### Where the figure is disclosed

The Scan Report carries two rows next to the extent they derive from
(`src/analysis/modules/scanReport.ts`):

- **In-memory resolution**: worst case and typical, with the grade. A grade
  other than `fine` renders as a warning row.
- **Quantization basis**, under the Advanced report: the governing axis, its
  reach, and the local origin the figures were computed against.

Both fail closed on the unit, the same rule the extent block follows. Without an
established linear unit there is no length to report, so the step is shown in
source units and left ungraded rather than stamped with a fabricated millimetre.
Both are whole-buffer facts, so neither carries a class-scope stamp: every point
is resident regardless of which classes are visible.

### What refuses, and above what

`ExportDecisionContext` (`src/export/exportManifest.ts`) carries a required
precision term, and `resolveExportDecision` blocks when the measured worst-case
step in metres exceeds the budget. That covers all eight registered scientific
exporters through the one resolver they already pass through: the contour map
PDF, the four contour vector formats, the DTM raster, the deliverable package,
and the terrain intelligence report. Those are the products that mint a file of
coordinates and elevations at a declared interval or cell size, which is the
claim the representation has to be able to support.

The default budget is `PRECISION_BUDGET_M`, 10 mm, tied to the `coarse` ceiling
so the grade and the refusal cannot drift apart. It is overridable per call
through `PrecisionPermitOptions.budgetMetres`; a value that is not a usable
length falls back to the default rather than disabling the gate.

The refusal states the measured step, the axis and reach it came from, the
budget, and the remedy: tile the dataset into smaller extents, or load it as
COPC so each region streams near its own local origin, and run the deliverable
per tile.

The precision term is **required**, not optional, because a call site can forget
an optional field and a forgotten precision term reads exactly like a passing
one. `null` is the honest "no scan frame was measured" and is spelled out at
each call site. `tests/terrainRunnerPrecisionWiring.test.ts` proves the terrain
runner supplies a real measurement rather than `null`.

### What the policy deliberately does not do

It does not refuse when the linear unit is unestablished. There is no metre
figure to compare in that case, and the unit question already has an authority:
`SpatialContext.metricClaimsPermitted` blocks a metric claim on an unknown-unit
CRS before a deliverable is reached. Two gates answering one question is how
they drift apart.

It also changes nothing about the representation. Positions stay Float32, there
is no high/low split, and no GPU attribute is widened. The coordinate-integrity
roadmap asks for measured cases before a precision architecture is adopted; this
is the measurement, not the architecture.

## What this audit pins (test inventory)

| Invariant | Test |
|---|---|
| Sub-mm precision at ±10 km from render origin | `tests/coordinatePrecision.test.ts` |
| Extreme UTM coordinate narrows correctly via recenter | `tests/coordinatePrecision.test.ts` (extended in v0.3.2) |
| COPC decode preserves sub-mm precision at extreme origins | `tests/copcDecodePrecision.test.ts` (new in v0.3.2) |
| US survey foot ↔ metres exact | `tests/crs.test.ts` |
| International foot ↔ metres exact | `tests/crs.test.ts` |
| CRS detection from OGC WKT and GeoTIFF VLRs | `tests/crs.test.ts` |
| Annotation world-position round-trip via session JSON | covered in v0.2.8 e2e |
| Float32 spacing is exact at zero, binade edges and range top | `tests/inMemoryPrecision.test.ts` |
| Mean step matches a numerical integration of the step function | `tests/inMemoryPrecision.test.ts` |
| Both local-origin strategies produce the reach they claim | `tests/inMemoryPrecision.test.ts`, `tests/scanPrecisionPolicy.test.ts` |
| Metres withheld when the linear unit is unestablished | `tests/inMemoryPrecision.test.ts`, `tests/scanReportPrecision.test.ts` |
| Grade boundaries fall where the measured table says | `tests/benchmark/inMemoryPrecisionExtents.test.ts` |
| Every registered scientific exporter blocks on a refused permit | `tests/precisionExportRefusal.test.ts` |
| The terrain runner supplies a real measurement, not null | `tests/terrainRunnerPrecisionWiring.test.ts` |

## Known limits (where research-grade *doesn't* extend)

- **Reprojection.** v0.3.2 does NOT reproject coordinates between CRSs.
  An analyst comparing a UTM 12N scan and a UTM 13N scan needs a
  downstream tool (PDAL, GDAL, proj4) to align them. The viewer flags
  the CRS in the scan-report card; equal-CRS scans display alongside
  each other correctly, mixed-CRS scans display in local render space
  with the visual offset they have on disk.
- **Geographic CRSs (degrees).** Latitude/longitude in degrees aren't a
  natural unit for the measurement tool — "0.0001 degrees" reads as
  about 11 m near the equator, but as ~7.8 m at 45° latitude. The
  measurement tool's "(unknown units)" annotation is the v0.3.2 honest
  output. Real geographic distance needs spherical math (haversine /
  geodesic) — out of scope for v0.3.2.
- **Vertical datums.** The CRS's vertical reference (ellipsoidal vs
  orthometric height) is recorded in the WKT but not currently
  surfaced. Survey-grade vertical comparisons require knowing the
  geoid model used; we plan to surface this in v0.3.3.
- **Wide-area Float32 quantization.** Measured, graded and refused past
  10 mm, but not fixed. Positions remain Float32, so a wide extent still
  resolves coarsely; the policy above states the figure and declines the
  deliverables that would claim more than it supports. The streaming
  Scan Report does not yet carry the disclosure rows, because the row set
  it emits is assembled in `src/main.ts` rather than in the pure module
  the static report uses. The measurement itself covers streaming: the
  terrain deliverables read a COPC/EPT source's render origin and tight
  data bounds through the same path.

## How to verify locally

```bash
npm run typecheck
npx vitest run tests/coordinatePrecision.test.ts tests/crs.test.ts tests/copcDecodePrecision.test.ts
npx vitest run tests/inMemoryPrecision.test.ts tests/scanPrecisionPolicy.test.ts \
  tests/scanReportPrecision.test.ts tests/precisionExportRefusal.test.ts \
  tests/benchmark/inMemoryPrecisionExtents.test.ts
```

The first three suites green means the recentring contract holds; the rest
green means the wide-area precision policy still reports and refuses on the
measured figures above.
