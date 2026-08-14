/**
 * tests/measurementAnalyticalFixtures.test.ts
 *
 * Synthetic known-truth fixtures for the five interactive measurement
 * claims in `docs/validation/claim-register.yaml`:
 *
 *   MEAS-DISTANCE, MEAS-AREA, MEAS-HEIGHT, MEAS-ANGLE, MEAS-PROFILE.
 *
 * Companion to `tests/volumeAnalyticalFixtures.test.ts` and
 * `tests/profileAnalyticalFixtures.test.ts`: every scene here has a
 * CLOSED-FORM answer a reader can verify by hand (a 3-4-5 triangle, a
 * unit square, a regular hexagon, an equilateral triangle, an exactly
 * sampled sine), and every tolerance carries a one-line reason for the
 * number chosen.
 *
 * WHAT THIS EVIDENCE IS
 *   Synthetic validation of the pure arithmetic: given the points the
 *   user picked, the reported number is the right number. Each scene is
 *   deterministic, pure-Node (no DOM, no three.js, no network) and
 *   compares against an analytic value, not a stored snapshot.
 *
 * WHAT THIS EVIDENCE IS NOT
 *   It is NOT field validation and NOT an accuracy figure. Nothing here
 *   measures how well a picked point sits on the real surface, and
 *   precision is not accuracy: an exact shoelace over a badly traced
 *   polygon is exactly the wrong area. The register's "visual-inspection
 *   grade" label is unchanged by these tests.
 *
 * Each claim gets closed-form scenes FIRST and then at least one scene
 * that drives the failure modes the register already names for it. The
 * failure-mode scenes assert the CURRENT behaviour of shipped code —
 * including the places where the core degrades silently rather than
 * refusing. Where that is the case the test says so in a comment; it is
 * a documented limit, not a licence to change the core.
 */

import { describe, it, expect } from 'vitest';
import {
  distance,
  polylineLength,
  segmentLengths,
  polygonAreaPlanar,
  polygonAreaHorizontal,
  polygonPerimeter,
  newellNormal,
  angleAtVertex,
  verticalDelta,
  profileMetrics,
  upAxisIndex,
} from '../src/render/measure/geometry';
import {
  signedArea2D,
  validatePolygon,
  polygonXY,
} from '../src/render/measure/polygonHygiene';
import { sampleProfile, summariseProfile } from '../src/render/measure/profileSampler';
import {
  sourceUnits,
  knownUnit,
  unknownUnit,
  toMetresIfKnown,
  raw,
  usSurveyFeetToMetres,
  feetToMetres,
  feet,
} from '../src/units/units';
import type { Vec3 } from '../src/render/navMath';

const Z_UP: Vec3 = [0, 0, 1];
const Y_UP: Vec3 = [0, 1, 0];

/**
 * Round-off budget for a closed-form value that is reached through a
 * handful (< 20) of IEEE-754 double flops — hypot, dot, acos, a shoelace
 * sum over ≤ 8 vertices. Each flop contributes ≲ 2^-52 ≈ 2.2e-16 of
 * relative error, so the accumulated error is ≲ 1e-14 for O(1)-magnitude
 * inputs. 1e-12 leaves two orders of headroom over that bound while
 * still being far tighter than any drift a real algorithm change could
 * hide inside.
 */
const FLOP_TOL = 1e-12;

/** Pack an interleaved x/y/z Float32Array from a flat list of triples. */
function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// MEAS-DISTANCE — Euclidean distance between picked points (unit-aware)
// Core: src/render/measure/geometry.ts  distance() / segmentLengths() /
//       polylineLength(); unit conversion src/units/units.ts
// ═══════════════════════════════════════════════════════════════════════

describe('MEAS-DISTANCE / D1 — Pythagorean triples (exact closed form)', () => {
  it('3-4-5 in the map plane reads exactly 5', () => {
    // Every intermediate (9, 16, 25, sqrt(25)) is exactly representable
    // in binary64, so the answer is EXACT — no tolerance is warranted.
    expect(distance([0, 0, 0], [3, 4, 0])).toBe(5);
    expect(distance([3, 4, 0], [0, 0, 0])).toBe(5); // symmetric
  });

  it('the 1-2-2 / 3 space triple reads exactly 3', () => {
    // 1 + 4 + 4 = 9, sqrt(9) = 3. Exact in binary64.
    expect(distance([0, 0, 0], [1, 2, 2])).toBe(3);
  });

  it('the 3-4-12 / 13 space triple reads exactly 13', () => {
    // 9 + 16 + 144 = 169, sqrt(169) = 13. Exact in binary64.
    expect(distance([0, 0, 0], [3, 4, 12])).toBe(13);
  });

  it('translation invariance: the same triple offset by a large origin is unchanged', () => {
    // Measurements run in recentred render-local space; a 1e5 offset is
    // a realistic projected-CRS easting. The subtraction happens in
    // binary64 before the hypot, so this stays exact.
    expect(distance([100000, 200000, 300], [100003, 200004, 300])).toBe(5);
  });
});

describe('MEAS-DISTANCE / D2 — polyline totals (exact closed form)', () => {
  it('the four sides of a unit square sum to 4 with correct running totals', () => {
    const ring: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 0],
    ];
    const { segments, cumulative, total } = polylineLength(ring);
    // Unit steps: every value is an exact small integer.
    expect(segments).toEqual([1, 1, 1, 1]);
    expect(cumulative).toEqual([1, 2, 3, 4]);
    expect(total).toBe(4);
  });

  it('a 3-4-5 dog-leg totals 12 (3 + 4 + 5)', () => {
    const { total } = polylineLength([
      [0, 0, 0],
      [3, 0, 0],
      [3, 4, 0],
      [0, 0, 0],
    ]);
    expect(total).toBe(12);
  });
});

describe('MEAS-DISTANCE / D3 — unit awareness: source units → metres', () => {
  it('100 international feet convert to 30.48 m exactly by definition', () => {
    // The international foot is DEFINED as 0.3048 m, so 100 ft is
    // 30.48 m by definition. Tolerance is the flop budget only: the
    // conversion is a single multiply against a decimal literal that is
    // not exactly representable in binary.
    const m = feetToMetres(feet(100));
    expect(raw(m)).toBeCloseTo(30.48, 12);
  });

  it('100 US survey feet convert to 30.480060960121… m (1200/3937 definition)', () => {
    // 100 × 1200/3937 = 30.48006096012192 m. Same single-multiply flop
    // budget as the international foot above.
    const m = usSurveyFeetToMetres(100);
    expect(raw(m)).toBeCloseTo((100 * 1200) / 3937, 12);
    // The two foot definitions differ by 2 ppm — 61 µm at 100 ft. Small,
    // but it grows to 6 mm over a 10 km state-plane baseline, so the
    // constants must not be interchanged. Threshold 1e-5 m sits an order
    // above the flop budget and an order below the real 6.1e-5 m gap.
    expect(Math.abs(raw(m) - 30.48)).toBeGreaterThan(1e-5);
  });

  it('a 5 m distance measured in a foot frame converts through the known scale', () => {
    // A picked distance of 5 SOURCE units in a frame whose CRS declares
    // the international foot is 1.524 m. Exercises the registered
    // "unknown unit" guard's happy path.
    const d = distance([0, 0, 0], [3, 4, 0]); // 5 source units
    const m = toMetresIfKnown(sourceUnits(d), knownUnit(0.3048));
    expect(m).not.toBeNull();
    expect(raw(m!)).toBeCloseTo(1.524, 12);
  });
});

describe('MEAS-DISTANCE / D4 — registered failure modes', () => {
  // Register failureModes: geographic-degree CRS, unknown unit,
  // coarse pick on sparse cloud.

  it('unknown unit REFUSES a metric value (returns null, never a fake metre)', () => {
    // This is the type-level fail-CLOSED guard: no metres come out of an
    // undeclared unit. The refusal, not a silent 1.0 scale, is the
    // shipped behaviour.
    const d = distance([0, 0, 0], [3, 4, 0]);
    expect(toMetresIfKnown(sourceUnits(d), unknownUnit())).toBeNull();
  });

  it('a bad scale factor is rejected at construction rather than applied', () => {
    // knownUnit() refuses non-finite / non-positive factors, so a broken
    // CRS parse cannot masquerade as a valid conversion.
    expect(() => knownUnit(0)).toThrow(RangeError);
    expect(() => knownUnit(-1)).toThrow(RangeError);
    expect(() => knownUnit(Number.NaN)).toThrow(RangeError);
  });

  it('a zero-length pick reads exactly 0, not NaN', () => {
    expect(distance([7, -3, 2], [7, -3, 2])).toBe(0);
    expect(segmentLengths([[1, 1, 1]])).toEqual([]); // single pick: no segment yet
    expect(polylineLength([]).total).toBe(0);
  });

  it('duplicate consecutive picks contribute exactly zero to the total', () => {
    // A double-click on the same point must not inflate the tally.
    const { segments, total } = polylineLength([
      [0, 0, 0],
      [3, 4, 0],
      [3, 4, 0], // duplicate
      [3, 4, 12],
    ]);
    expect(segments).toEqual([5, 0, 12]);
    expect(total).toBe(17);
  });

  it('DEGRADATION (documented): a non-finite pick propagates NaN rather than throwing', () => {
    // Shipped behaviour, asserted as-is. `distance` is a bare hypot with
    // no finite guard, so a NaN coordinate surfaces as a NaN reading.
    // The UI's formatter renders NaN as "—", so the user sees an absent
    // number rather than a wrong one — but the CORE does not refuse.
    expect(Number.isNaN(distance([0, 0, 0], [Number.NaN, 0, 0]))).toBe(true);
    expect(distance([0, 0, 0], [Infinity, 0, 0])).toBe(Infinity);
  });

  it('LIMIT (not covered): geographic-degree refusal is not in this core', () => {
    // The register's "geographic-degree CRS" refusal is enforced one
    // level up, in MeasureController (three.js-entangled), not in
    // `distance()`. `distance()` will happily hypot degrees against
    // metres and return a meaningless scalar — recorded here so the
    // scope of this file's evidence is not overstated.
    const nonsense = distance([0, 0, 0], [0.001, 0.001, 5]); // deg, deg, metres
    expect(Number.isFinite(nonsense)).toBe(true); // no refusal at this layer
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MEAS-AREA — polygon shoelace area (planimetric, unit-aware)
// Core: src/render/measure/geometry.ts polygonAreaPlanar() /
//       polygonAreaHorizontal() / newellNormal();
//       src/render/measure/polygonHygiene.ts signedArea2D() /
//       validatePolygon()
// ═══════════════════════════════════════════════════════════════════════

describe('MEAS-AREA / A1 — convex closed forms', () => {
  it('a unit square is exactly 1 m² and a 10 m square exactly 100 m²', () => {
    const unit: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ];
    // Integer vertices: the Newell sum is an exact integer, so no
    // tolerance is warranted.
    expect(polygonAreaPlanar(unit)).toBe(1);
    expect(polygonPerimeter(unit)).toBe(4);
    expect(newellNormal(unit)).toEqual([0, 0, 2]); // |N| = 2·area

    const ten: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ];
    expect(polygonAreaPlanar(ten)).toBe(100);
    expect(polygonPerimeter(ten)).toBe(40);
  });

  it('a 3-4-5 right triangle is exactly 6 m² (½·3·4)', () => {
    expect(
      polygonAreaPlanar([
        [0, 0, 0],
        [4, 0, 0],
        [0, 3, 0],
      ]),
    ).toBe(6);
  });

  it('a unit-radius regular hexagon is 3√3/2 ≈ 2.598076 m²', () => {
    // A genuinely irrational closed form, so the shoelace round-off is
    // actually exercised (unlike the integer fixtures above).
    const verts: Vec3[] = [];
    for (let k = 0; k < 6; k++) {
      const t = (k * Math.PI) / 3;
      verts.push([Math.cos(t), Math.sin(t), 0]);
    }
    const expected = (3 * Math.sqrt(3)) / 2;
    // 6-term shoelace over O(1) values → ≲ 1e-15 accumulated round-off;
    // FLOP_TOL (1e-12) is the documented budget with headroom.
    expect(Math.abs(polygonAreaPlanar(verts) - expected)).toBeLessThan(FLOP_TOL);
    // Perimeter of a unit-circumradius hexagon is 6 (side = radius).
    expect(Math.abs(polygonPerimeter(verts) - 6)).toBeLessThan(FLOP_TOL);
  });
});

describe('MEAS-AREA / A2 — NON-CONVEX closed forms (shoelace must not need convexity)', () => {
  it('an L-shape (4×4 square minus a 2×2 corner) is exactly 12 m²', () => {
    // Hand check: outer 4×4 = 16, bite 2×2 = 4, so 12.
    const L: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 2, 0],
      [2, 2, 0],
      [2, 4, 0],
      [0, 4, 0],
    ];
    expect(polygonAreaPlanar(L)).toBe(12);
    expect(signedArea2D(polygonXY(L))).toBe(12); // CCW ⇒ positive
    expect(validatePolygon(polygonXY(L)).validity).toBe('ok');
  });

  it('a plus/cross shape (5 unit cells) is exactly 5 m²', () => {
    // A 12-vertex re-entrant ring: 3×3 square (9) minus four 1×1
    // corners (4) = 5.
    const plus: Vec3[] = [
      [1, 0, 0],
      [2, 0, 0],
      [2, 1, 0],
      [3, 1, 0],
      [3, 2, 0],
      [2, 2, 0],
      [2, 3, 0],
      [1, 3, 0],
      [1, 2, 0],
      [0, 2, 0],
      [0, 1, 0],
      [1, 1, 0],
    ];
    expect(polygonAreaPlanar(plus)).toBe(5);
    expect(polygonPerimeter(plus)).toBe(12);
    expect(validatePolygon(polygonXY(plus)).validity).toBe('ok');
  });

  it('winding order does not change the reported (unsigned) area', () => {
    const cw: Vec3[] = [
      [0, 0, 0],
      [0, 4, 0],
      [2, 4, 0],
      [2, 2, 0],
      [4, 2, 0],
      [4, 0, 0],
    ];
    expect(polygonAreaPlanar(cw)).toBe(12); // same L, reversed
    expect(signedArea2D(polygonXY(cw))).toBe(-12); // sign flips
  });
});

describe('MEAS-AREA / A3 — horizontal (map) projection', () => {
  it('a 60°-tilted unit square projects to exactly cos(60°) = 0.5 m² on the map', () => {
    // Square of side 1 in the x–z plane rotated so its normal makes 60°
    // with +Z: horizontal area = planar × cos(60°) = 0.5.
    const c = Math.cos(Math.PI / 3);
    const s = Math.sin(Math.PI / 3);
    const tilted: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, c, s],
      [0, c, s],
    ];
    expect(Math.abs(polygonAreaPlanar(tilted) - 1)).toBeLessThan(FLOP_TOL);
    // cos/sin round-off + Newell sum, same flop budget as A1's hexagon.
    expect(Math.abs(polygonAreaHorizontal(tilted, Z_UP) - 0.5)).toBeLessThan(FLOP_TOL);
  });

  it('a vertical wall has exactly zero map area', () => {
    const wall: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 3],
      [0, 0, 3],
    ];
    expect(polygonAreaPlanar(wall)).toBe(12);
    expect(polygonAreaHorizontal(wall, Z_UP)).toBe(0);
  });
});

describe('MEAS-AREA / A4 — registered failure modes', () => {
  // Register failureModes: geographic degrees, non-planar / large extent.
  // Plus the polygon-hygiene failure surface the volume path already
  // guards: self-intersection, duplicate vertices, degeneracy.

  it('a bow-tie (self-intersecting) polygon is REFUSED, not silently zeroed', () => {
    // Shoelace cancels the two lobes to 0. Reporting "zero area" would
    // read as "spread your vertices"; the validator names the real
    // problem instead.
    const bowtie = polygonXY([
      [0, 0, 0],
      [2, 2, 0],
      [2, 0, 0],
      [0, 2, 0],
    ]);
    expect(signedArea2D(bowtie)).toBe(0);
    expect(validatePolygon(bowtie).validity).toBe('self-intersecting');
  });

  it('collinear vertices are REFUSED as zero-area', () => {
    const line = polygonXY([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ]);
    expect(signedArea2D(line)).toBe(0);
    expect(validatePolygon(line).validity).toBe('zero-area');
  });

  it('fewer than three vertices is REFUSED', () => {
    expect(polygonAreaPlanar([[0, 0, 0], [1, 1, 0]])).toBe(0);
    expect(validatePolygon(polygonXY([[0, 0, 0], [1, 1, 0]])).validity).toBe('too-few-vertices');
  });

  it('a non-finite vertex is REFUSED rather than producing NaN area', () => {
    const bad = polygonXY([
      [0, 0, 0],
      [Number.NaN, 0, 0],
      [1, 1, 0],
    ]);
    expect(signedArea2D(bad)).toBe(0); // NaN-safe, not NaN
    expect(validatePolygon(bad).validity).toBe('non-finite-vertex');
  });

  it('DEGRADATION (documented): duplicate vertices do not change the area', () => {
    // A repeated pick adds a zero-length edge. Shoelace is unaffected,
    // which is the desirable outcome, but note that `validatePolygon`
    // still reports 'ok' — the duplicate is absorbed, never surfaced.
    const withDupe: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 0], // duplicate
      [4, 2, 0],
      [2, 2, 0],
      [2, 4, 0],
      [0, 4, 0],
    ];
    expect(polygonAreaPlanar(withDupe)).toBe(12);
    expect(validatePolygon(polygonXY(withDupe)).validity).toBe('ok');
  });

  it('DEGRADATION (documented): a non-planar ring reports a LOWER BOUND, not draped area', () => {
    // Four corners of a unit square with one corner lifted 1 m. The
    // Newell (vector) area of the warped ring is strictly LESS than the
    // area of the two triangles it could be split into — the folded-away
    // components cancel in the vector sum. This is the register's
    // "non-planar" caveat, made numeric.
    const warped: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 1], // lifted corner
      [0, 1, 0],
    ];
    const vectorArea = polygonAreaPlanar(warped);
    // Triangulated surface area: (0,0,0)-(1,0,0)-(1,1,1) plus
    // (0,0,0)-(1,1,1)-(0,1,0). Both have area √3/2 (each is a triangle
    // with sides 1, √2, √2 → area = √3/2 ≈ 0.8660254).
    const drapedArea = 2 * (Math.sqrt(3) / 2);
    expect(vectorArea).toBeLessThan(drapedArea);
    // The vector area of this ring is |N|/2 with N = (−1, −1, 2)·… ;
    // numerically ≈ 1.2247449 = √6/2. Asserted against that closed form.
    expect(Math.abs(vectorArea - Math.sqrt(6) / 2)).toBeLessThan(FLOP_TOL);
  });

  it('LIMIT (not covered): the geographic-degree refusal is not in this core', () => {
    // As with distance, `polygonAreaPlanar` over degree coordinates
    // returns a finite square-degree number with no unit awareness. The
    // refusal lives in MeasureController.
    const degrees: Vec3[] = [
      [0, 0, 0],
      [0.001, 0, 0],
      [0.001, 0.001, 0],
      [0, 0.001, 0],
    ];
    expect(polygonAreaPlanar(degrees)).toBeGreaterThan(0); // no refusal here
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MEAS-HEIGHT — vertical delta (unit-aware, up-axis-aware)
// Core: src/render/measure/geometry.ts verticalDelta() (line ~300),
//       upAxisIndex() (line ~395)
// ═══════════════════════════════════════════════════════════════════════

describe('MEAS-HEIGHT / H1 — closed-form vertical deltas', () => {
  it('a Z-up 3-4-12 pick splits into vertical 12 and horizontal 5 exactly', () => {
    const { vertical, horizontal } = verticalDelta([0, 0, 0], [3, 4, 12], Z_UP);
    expect(vertical).toBe(12);
    expect(horizontal).toBe(5);
  });

  it('a Y-up scan reads its height off Y, not Z', () => {
    // Legacy phone-scan / glTF convention. Same numbers, axes swapped.
    const { vertical, horizontal } = verticalDelta([0, 0, 0], [3, 12, 4], Y_UP);
    expect(vertical).toBe(12);
    expect(horizontal).toBe(5);
  });

  it('the sign follows the direction of travel (down is negative)', () => {
    expect(verticalDelta([0, 0, 10], [0, 0, 4], Z_UP).vertical).toBe(-6);
    expect(verticalDelta([0, 0, 4], [0, 0, 10], Z_UP).vertical).toBe(6);
  });

  it('a non-unit up vector is normalised rather than trusted', () => {
    // A caller handing in [0, 0, 7] must not get a 7× height.
    const { vertical, horizontal } = verticalDelta([0, 0, 0], [3, 4, 12], [0, 0, 7]);
    // One extra division by hypot vs the exact case → flop budget.
    expect(Math.abs(vertical - 12)).toBeLessThan(FLOP_TOL);
    expect(Math.abs(horizontal - 5)).toBeLessThan(FLOP_TOL);
  });

  it('height is invariant to a large datum offset (deltas need no datum)', () => {
    // Clouds are recentred on load; a delta over local heights is
    // already correct. 1e6 is a realistic COPC octree-centre offset.
    expect(verticalDelta([0, 0, 1000000], [3, 4, 1000012], Z_UP).vertical).toBe(12);
  });
});

describe('MEAS-HEIGHT / H2 — vertical unit conversion', () => {
  it('a 12-unit delta in a US-survey-foot vertical frame is 3.65760731… m', () => {
    // 12 × 1200/3937 = 3.6576073152400304 m. Catches a foot-definition
    // swap (the international foot gives 3.6576 exactly, 7.3 µm apart —
    // below the 12-digit tolerance only because the values differ in the
    // 6th decimal, which this assertion resolves).
    const delta = verticalDelta([0, 0, 0], [0, 0, 12], Z_UP).vertical;
    const m = toMetresIfKnown(sourceUnits(delta), knownUnit(1200 / 3937));
    expect(raw(m!)).toBeCloseTo((12 * 1200) / 3937, 12);
  });

  it('an undeclared vertical unit REFUSES a metre value', () => {
    const delta = verticalDelta([0, 0, 0], [0, 0, 12], Z_UP).vertical;
    expect(toMetresIfKnown(sourceUnits(delta), unknownUnit())).toBeNull();
  });
});

describe('MEAS-HEIGHT / H3 — registered failure modes', () => {
  // Register failureModes: unknown vertical datum, Y-up vs Z-up ambiguity.

  it('a zero-length pick reads exactly zero height and zero run', () => {
    const { vertical, horizontal } = verticalDelta([5, 5, 5], [5, 5, 5], Z_UP);
    expect(vertical).toBe(0);
    expect(horizontal).toBe(0);
  });

  it('DEGRADATION (documented): a degenerate up vector zeroes the height but reports the full 3D length as "horizontal"', () => {
    // normalize([0,0,0]) → [0,0,0], so `vertical` is 0 (an absent axis
    // gives an absent height — acceptable) but `horizontal` is
    // length(d − 0·u) = the full 3D distance, 13 m, NOT the 5 m map
    // run. Shipped behaviour, asserted as-is: the height fails quiet,
    // the horizontal companion fails WRONG. No refusal at this layer.
    const { vertical, horizontal } = verticalDelta([0, 0, 0], [3, 4, 12], [0, 0, 0]);
    expect(vertical).toBe(0);
    expect(horizontal).toBe(13); // 3D length, not the 5 m horizontal run
  });

  it('DEGRADATION (documented): a TILTED up axis silently projects instead of refusing', () => {
    // 45° tilt between +Y and +Z. The same physical 12 m rise now reads
    // (12 + 4)/√2 ≈ 11.3137 — a 6 % error with no warning. This is the
    // register's "Y-up vs Z-up ambiguity" failure mode: `verticalDelta`
    // accepts any up vector and projects onto it.
    const tilt: Vec3 = [0, Math.SQRT1_2, Math.SQRT1_2];
    const { vertical } = verticalDelta([0, 0, 0], [3, 4, 12], tilt);
    expect(Math.abs(vertical - (4 + 12) * Math.SQRT1_2)).toBeLessThan(FLOP_TOL);
    expect(vertical).not.toBeCloseTo(12, 1); // wrong, and reported anyway
  });

  it('the BOX height path DOES refuse a tilted up axis (contrast with the above)', () => {
    // upAxisIndex throws rather than reporting the nearest-axis extent.
    // Recorded here so the asymmetry between the two paths is on record.
    expect(() => upAxisIndex([0, Math.SQRT1_2, Math.SQRT1_2])).toThrow(/axis-aligned/);
    expect(() => upAxisIndex([0, 0, 0])).toThrow(/axis-aligned/);
    expect(upAxisIndex([0, 0, 1])).toBe(2);
    expect(upAxisIndex([0, -1, 0])).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MEAS-ANGLE — angle between two vectors
// Core: src/render/measure/geometry.ts angleAtVertex() (line ~176)
// ═══════════════════════════════════════════════════════════════════════

describe('MEAS-ANGLE / N1 — cardinal closed forms (90 / 45 / 60 / 180 / 0)', () => {
  it('a right angle reads exactly 90°', () => {
    // acos(0) = π/2 exactly in binary64, and 180/π × π/2 round-trips to
    // exactly 90 — asserted without tolerance.
    expect(angleAtVertex([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBe(90);
    expect(angleAtVertex([4, 0, 0], [0, 0, 0], [0, 3, 0])).toBe(90);
  });

  it('a square-diagonal angle reads 45°', () => {
    // acos(1/√2) is irrational-adjacent; flop budget applies.
    const a = angleAtVertex([1, 0, 0], [0, 0, 0], [1, 1, 0]);
    expect(Math.abs(a - 45)).toBeLessThan(FLOP_TOL);
  });

  it('every interior angle of an equilateral triangle reads 60°', () => {
    const A: Vec3 = [0, 0, 0];
    const B: Vec3 = [1, 0, 0];
    const C: Vec3 = [0.5, Math.sqrt(3) / 2, 0];
    // acos(0.5) — one sqrt plus one acos over O(1) values.
    expect(Math.abs(angleAtVertex(B, A, C) - 60)).toBeLessThan(FLOP_TOL);
    expect(Math.abs(angleAtVertex(A, B, C) - 60)).toBeLessThan(FLOP_TOL);
    expect(Math.abs(angleAtVertex(A, C, B) - 60)).toBeLessThan(FLOP_TOL);
  });

  it('a 30-60-90 triangle reads 30° and 60° at the right vertices', () => {
    // Legs 1 and √3 → the angle opposite the short leg is 30°.
    const A: Vec3 = [0, 0, 0];
    const B: Vec3 = [Math.sqrt(3), 0, 0];
    const C: Vec3 = [0, 1, 0];
    expect(Math.abs(angleAtVertex(B, A, C) - 90)).toBeLessThan(FLOP_TOL);
    expect(Math.abs(angleAtVertex(A, B, C) - 30)).toBeLessThan(FLOP_TOL);
    expect(Math.abs(angleAtVertex(A, C, B) - 60)).toBeLessThan(FLOP_TOL);
  });
});

describe('MEAS-ANGLE / N2 — a full 3-4-5 triangle sums to 180° (internal consistency)', () => {
  it('reads 90 / 36.86989765° / 53.13010235° and sums to 180', () => {
    const A: Vec3 = [0, 0, 0];
    const B: Vec3 = [4, 0, 0];
    const C: Vec3 = [0, 3, 0];
    const at = {
      A: angleAtVertex(B, A, C),
      B: angleAtVertex(A, B, C),
      C: angleAtVertex(A, C, B),
    };
    expect(at.A).toBe(90);
    // acos(0.8) and acos(0.6), the classic 3-4-5 angles.
    expect(Math.abs(at.B - (Math.acos(0.8) * 180) / Math.PI)).toBeLessThan(FLOP_TOL);
    expect(Math.abs(at.B - 36.86989764584402)).toBeLessThan(1e-10); // literal at 1e-10: the
    // decimal literal above is itself only written to 14 significant digits.
    expect(Math.abs(at.C - 53.13010235415598)).toBeLessThan(1e-10);
    // A triangle's angles must sum to 180 — an independent check that
    // does not reuse the same acos argument. Three acos results summed:
    // ~3× the single-value budget, still inside FLOP_TOL.
    expect(Math.abs(at.A + at.B + at.C - 180)).toBeLessThan(FLOP_TOL);
  });
});

describe('MEAS-ANGLE / N3 — 3D angles (not just map-plane)', () => {
  it('the angle between +X and the +X+Z diagonal is 45° out of the map plane', () => {
    const a = angleAtVertex([1, 0, 0], [0, 0, 0], [1, 0, 1]);
    expect(Math.abs(a - 45)).toBeLessThan(FLOP_TOL);
  });

  it('the angle between two adjacent cube-body diagonals is acos(1/3) ≈ 70.5288°', () => {
    // The tetrahedral angle. A genuinely 3D closed form.
    const a = angleAtVertex([1, 1, 1], [0, 0, 0], [1, -1, -1]);
    const expected = (Math.acos(-1 / 3) * 180) / Math.PI; // 109.4712°
    expect(Math.abs(a - expected)).toBeLessThan(FLOP_TOL);
  });
});

describe('MEAS-ANGLE / N4 — registered failure modes', () => {
  // Register failureModes: mixed horizontal/vertical scale,
  // geographic degrees for planar angle.

  it('collinear rays read exactly 180° (straight) and 0° (folded back)', () => {
    expect(angleAtVertex([-1, 0, 0], [0, 0, 0], [1, 0, 0])).toBe(180);
    expect(angleAtVertex([1, 0, 0], [0, 0, 0], [2, 0, 0])).toBe(0);
  });

  it('AMBIGUITY (documented): a degenerate ray also returns 0 — same value as a real 0° angle', () => {
    // `angleAtVertex` returns 0 for a coincident pick so a half-placed
    // measurement reads cleanly. That sentinel is INDISTINGUISHABLE from
    // a genuine 0° fold-back (asserted directly above). Callers must
    // track placement state separately; the core cannot tell them apart.
    expect(angleAtVertex([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBe(0);
    expect(angleAtVertex([1, 0, 0], [0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('a non-finite pick yields NaN rather than a plausible angle', () => {
    expect(Number.isNaN(angleAtVertex([Number.NaN, 0, 0], [0, 0, 0], [1, 0, 0]))).toBe(true);
  });

  it('DEGRADATION (documented): mixed horizontal/vertical scale changes the answer', () => {
    // A physical 45° slope: 1 m across, 1 m up. If the frame carries its
    // VERTICAL in feet while X/Y are metres, the same geometry reads
    // atan(1/0.3048) = 73.06°, a 28° error with no warning. This makes
    // the register's "mixed horizontal/vertical scale" failure mode
    // numeric — the core has no unit awareness at all.
    const trueAngle = angleAtVertex([1, 0, 0], [0, 0, 0], [1, 0, 1]);
    expect(Math.abs(trueAngle - 45)).toBeLessThan(FLOP_TOL);
    const zInFeet = 1 / 0.3048;
    const skewed = angleAtVertex([1, 0, 0], [0, 0, 0], [1, 0, zInFeet]);
    const expectedSkew = (Math.atan2(zInFeet, 1) * 180) / Math.PI; // 73.0576°
    expect(Math.abs(skewed - expectedSkew)).toBeLessThan(FLOP_TOL);
    expect(skewed - trueAngle).toBeGreaterThan(28); // the error is huge and silent
  });

  it('DEGRADATION (documented): degree coordinates give a plausible-looking wrong angle', () => {
    // At 45° N a degree of longitude is ~0.707 of a degree of latitude
    // on the ground, so a segment that is geometrically 45° in degree
    // space is ~54.7° on the ground. The core reports the degree-space
    // number with no refusal — the register's "geographic degrees for
    // planar angle" failure mode.
    const inDegreeSpace = angleAtVertex([0.001, 0, 0], [0, 0, 0], [0.001, 0.001, 0]);
    expect(Math.abs(inDegreeSpace - 45)).toBeLessThan(FLOP_TOL); // reported as 45
    const cosPhi = Math.cos((45 * Math.PI) / 180);
    const onGround = (Math.atan2(0.001, 0.001 * cosPhi) * 180) / Math.PI; // ≈ 54.7356°
    expect(Math.abs(onGround - 45)).toBeGreaterThan(9); // truth is ~9.7° away
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MEAS-PROFILE — sampled elevation along a section line
// Core: src/render/measure/profileSampler.ts sampleProfile() (line ~363)
//       / summariseProfile() (line ~487);
//       src/render/measure/geometry.ts profileMetrics() (line ~251)
// Extends tests/profileAnalyticalFixtures.test.ts (plane / ramp / step /
// diagonal / gap) with an analytic sine surface and undersampling.
// ═══════════════════════════════════════════════════════════════════════

describe('MEAS-PROFILE / P1 — analytic sine surface, one cloud point per bin (exact)', () => {
  it('reproduces z = 2·sin(2πx/20) at every station', () => {
    // 21 bins over x ∈ [0, 20] (binStep = 1) with one cloud point placed
    // exactly on each bin centre. Each bin therefore holds exactly one
    // elevation, so the 25th-percentile reducer returns that value
    // unchanged and the comparison is against the analytic surface with
    // NO sampling bias at all.
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i <= 20; i++) {
      pts.push([i, 0, 2 * Math.sin((2 * Math.PI * i) / 20)]);
    }
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [20, 0, 0],
      up: Z_UP,
      positions: pack(pts),
      samples: 21,
    });
    expect(out).toHaveLength(21);
    for (let i = 0; i < out.length; i++) {
      expect(out[i].count).toBe(1); // one point per bin: no reducer bias
      expect(out[i].distance).toBeCloseTo(i, 12); // binStep = 1 exactly
      const truth = 2 * Math.sin((2 * Math.PI * i) / 20);
      // Positions are stored as Float32Array (the shipped buffer type),
      // so the elevation round-trips through binary32: ~6e-8 relative on
      // an O(1) value. 1e-6 absolute is the documented budget — an order
      // of magnitude above f32 quantisation, still 4 orders below the
      // 2 m amplitude being measured.
      expect(Math.abs(out[i].height - truth)).toBeLessThan(1e-6);
    }
    const summary = summariseProfile(out);
    // Full-period sine of amplitude 2: min −2, max +2, span 4.
    expect(Math.abs(summary.minHeight + 2)).toBeLessThan(1e-6);
    expect(Math.abs(summary.maxHeight - 2)).toBeLessThan(1e-6);
    expect(Math.abs(summary.heightSpan - 4)).toBeLessThan(1e-6);
    expect(summary.coverage).toBe(1);
  });
});

describe('MEAS-PROFILE / P2 — analytic plane with a known cross-slope', () => {
  it('a 5 % grade plane reads a 1 m rise over a 20 m section', () => {
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i <= 20; i++) pts.push([i, 0, 0.05 * i]);
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [20, 0, 0],
      up: Z_UP,
      positions: pack(pts),
      samples: 21,
    });
    for (let i = 0; i < out.length; i++) {
      // Same f32 storage budget as P1.
      expect(Math.abs(out[i].height - 0.05 * i)).toBeLessThan(1e-6);
    }
    expect(Math.abs(summariseProfile(out).heightSpan - 1)).toBeLessThan(1e-6);
    // Scalar half of the same section, straight from geometry.ts.
    const m = profileMetrics([0, 0, 0], [20, 0, 1], Z_UP);
    expect(m.lengthHorizontal).toBe(20);
    expect(m.verticalDrop).toBe(1);
    expect(Math.abs(m.gradePercent - 5)).toBeLessThan(FLOP_TOL);
    expect(Math.abs(m.length3d - Math.hypot(20, 1))).toBeLessThan(FLOP_TOL);
  });
});

describe('MEAS-PROFILE / P3 — registered failure modes', () => {
  // Register failureModes: gaps along the section, sparse cloud.
  // Register scope: "vertical fidelity between samples" is explicitly
  // NOT claimed. P3 makes that limit numeric.

  it('DEGRADATION (documented): undersampling a sine loses amplitude AND misplaces the stations', () => {
    // The SAME analytic surface as P1, but only 3 bins over a full
    // period. Two things go wrong at once, and both are the register's
    // "sampling density limits vertical fidelity" assumption made
    // numeric:
    //   (a) the reported span shrinks well below the true 4 m, and
    //   (b) each reported height is a 25th-percentile statistic over a
    //       10 m-wide corridor slab, NOT the surface at that station —
    //       the middle bin sits on a true elevation of 0 m and reports
    //       something more than 0.5 m away from it.
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i <= 200; i++) {
      const x = i / 10;
      pts.push([x, 0, 2 * Math.sin((2 * Math.PI * x) / 20)]);
    }
    const dense = sampleProfile({
      a: [0, 0, 0],
      b: [20, 0, 0],
      up: Z_UP,
      positions: pack(pts),
      samples: 201,
    });
    const sparse = sampleProfile({
      a: [0, 0, 0],
      b: [20, 0, 0],
      up: Z_UP,
      positions: pack(pts),
      samples: 3,
    });
    const denseSpan = summariseProfile(dense).heightSpan;
    const sparseSpan = summariseProfile(sparse).heightSpan;
    // Dense sampling recovers the full 4 m amplitude.
    expect(Math.abs(denseSpan - 4)).toBeLessThan(0.05); // 200 bins over a
    // 20 m period: bin half-width 0.05 m, so the peak can be missed by
    // at most 2·(1 − cos(2π·0.05/20)) ≈ 3e-4 m; 0.05 is a generous band
    // that still fails loudly if the sampler stops resolving the peak.
    // Sparse sampling loses a third of the amplitude (observed 2.598 m
    // of the true 4 m). Threshold 3.5 m is comfortably above the
    // observed value and comfortably below the truth, so this fails if
    // the loss ever disappears (which would mean the fixture stopped
    // exercising undersampling).
    expect(sparseSpan).toBeLessThan(3.5);
    expect(sparseSpan).toBeLessThan(denseSpan - 1);
    // (b) The middle station (x = 10) sits on a true elevation of
    // exactly 0 m, but reads a corridor percentile drawn from
    // x ∈ [5, 15) where the surface runs +2 → −2. The reported height
    // is more than 0.5 m from the truth at that station.
    expect(sparse).toHaveLength(3);
    expect(Math.abs(sparse[1].distance - 10)).toBeLessThan(FLOP_TOL);
    expect(Math.abs(sparse[1].height - 0)).toBeGreaterThan(0.5);
  });

  it('a section over a gap marks the empty bins NaN and lowers coverage', () => {
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i <= 10; i++) pts.push([i * 0.2, 0, 3]); // x ∈ [0, 2]
    for (let i = 0; i <= 10; i++) pts.push([8 + i * 0.2, 0, 3]); // x ∈ [8, 10]
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions: pack(pts),
      samples: 11,
      bandWidth: 0.2,
    });
    const nanBins = out.filter((s) => Number.isNaN(s.height)).length;
    expect(nanBins).toBeGreaterThan(0);
    const summary = summariseProfile(out);
    expect(summary.coverage).toBeLessThan(1);
    expect(summary.coverage).toBeGreaterThan(0);
    // Every bin that DOES have data reads the true plateau elevation.
    for (const s of out) {
      if (Number.isFinite(s.height)) expect(Math.abs(s.height - 3)).toBeLessThan(1e-6);
    }
  });

  it('an entirely empty section yields NaN summary fields and zero coverage', () => {
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions: pack([[100, 100, 5]]), // far outside the corridor
      samples: 8,
    });
    const summary = summariseProfile(out);
    expect(summary.coverage).toBe(0);
    expect(Number.isNaN(summary.minHeight)).toBe(true);
    expect(Number.isNaN(summary.heightSpan)).toBe(true);
  });

  it('a zero-length section degenerates to two zero-evidence samples', () => {
    const out = sampleProfile({
      a: [4, 4, 7],
      b: [4, 4, 7],
      up: Z_UP,
      positions: pack([[4, 4, 7]]),
      samples: 32,
    });
    expect(out).toHaveLength(2);
    expect(out[0].distance).toBe(0);
    expect(out[1].distance).toBe(0);
    // count 0 marks the heights as endpoint elevations, not corridor
    // statistics — the evidence column stays honest.
    expect(out[0].count).toBe(0);
    expect(out[0].height).toBe(7);
  });

  it('non-finite cloud points (organized-cloud invalid samples) are dropped, not binned', () => {
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions: pack([
        [0, 0, 1],
        [Number.NaN, Number.NaN, Number.NaN],
        [10, 0, 1],
      ]),
      samples: 3,
      bandWidth: 0.5,
    });
    for (const s of out) {
      expect(Number.isNaN(s.height) || Math.abs(s.height - 1) < 1e-6).toBe(true);
    }
    expect(out.reduce((n, s) => n + (s.count ?? 0), 0)).toBe(2); // the NaN point is gone
  });

  it('the section distance axis is HORIZONTAL, not 3D length', () => {
    // 3-4-5 in plan with a 12 m climb (3D length 13 m): the chart's
    // X-axis must end at 5 m. Guards the register's "local frame"
    // statement against a 3D-length regression.
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [3, 4, 12],
      up: Z_UP,
      positions: pack([[0, 0, 0], [3, 4, 12]]),
      samples: 2,
    });
    expect(out[0].distance).toBe(0);
    expect(Math.abs(out[1].distance - 5)).toBeLessThan(FLOP_TOL);
  });
});
