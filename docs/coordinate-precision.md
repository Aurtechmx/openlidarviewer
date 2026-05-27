# Coordinate precision invariants — v0.3.2 research-grade audit

OpenLiDARViewer claims survey-grade accuracy on georeferenced scans. This
document is the precision-audit ledger: it spells out every coordinate
space the runtime uses, where Float64 ends and Float32 begins, and which
tests pin each invariant.

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
within 10 km of the render origin per Task 32).

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
(optional) is the absolute coord. v0.2.8 + v0.3.1 Phase 6 Task 23
guarantees the local position is a world-stable scan-space anchor (not
node-relative), so streaming-node refinement does not move annotations.

When a session is loaded against a re-opened scan, the local position is
the source of truth; the world position is recomputed from
`local + origin`. This preserves annotation positions exactly across
session reloads.

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

## How to verify locally

```bash
npm run typecheck
npx vitest run tests/coordinatePrecision.test.ts tests/crs.test.ts tests/copcDecodePrecision.test.ts
```

All three suites green means the precision contract holds.
