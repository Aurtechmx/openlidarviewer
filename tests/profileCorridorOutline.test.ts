/**
 * profileCorridorOutline.test.ts
 *
 * The outline drawn in the scene has to be the corridor the sampler walked,
 * not a shape that resembles it. So the checks here never ask the outline
 * where its vertices are; they re-derive, from the raw endpoints and up axis,
 * how far each emitted vertex is from the finite segment in the plane
 * perpendicular to `up`, and require that distance to be the half width.
 *
 * The distance is recomputed with independent arithmetic: a parametric
 * clamped projection onto `b - a`, where the module works from the frame's
 * chainage basis. A shared helper would let one mistake satisfy both sides.
 *
 * The discriminating case has its own test. A capsule and a rectangle agree
 * everywhere except past the endpoints, where a rectangle's corner sits at
 * `halfWidth * sqrt(2)` from the endpoint and the capsule's arc sits at
 * `halfWidth`. That factor is the whole claim, so it is asserted directly
 * rather than left to a general bound.
 *
 * No Math.random: every section, axis and vertex below is fixed.
 */
import { describe, it, expect } from 'vitest';
import {
  buildProfileCorridorOutline,
  profileCorridorBoundaryVertices,
  DEFAULT_CORRIDOR_ARC_SEGMENTS,
  CORRIDOR_ARC_CHORD_FRACTION,
  MIN_CORRIDOR_ARC_SEGMENTS,
  MAX_CORRIDOR_ARC_SEGMENTS,
  PROFILE_CORRIDOR_OUTLINE_LABEL,
  PROFILE_CORRIDOR_OUTLINE_LABEL_NO_BAND,
  PROFILE_CORRIDOR_OUTLINE_LABEL_NONE,
} from '../src/render/measure/profileCorridorOutline';
import { buildProfileFrame } from '../src/render/measure/profileGeometry';
import {
  profileCorridorAccepts,
  createProfileHitScratch,
} from '../src/render/measure/profileCorridor';
import type { Vec3 } from '../src/render/navMath';

/* ------------------------------------------------------------------ *
 * Independent geometry. None of this calls the module under test.
 * ------------------------------------------------------------------ */

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l === 0 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l];
}

/** `p` with its component along the unit vector `u` removed. */
function flatten(p: Vec3, u: Vec3): Vec3 {
  const h = p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
  return [p[0] - u[0] * h, p[1] - u[1] * h, p[2] - u[2] * h];
}

/**
 * Distance from `p` to the FINITE segment `a -> b`, measured in the plane
 * perpendicular to `up`. Parametric and clamped, deliberately not the
 * chainage form the module and the sampler share.
 */
function distanceToSegment(p: Vec3, a: Vec3, b: Vec3, up: Vec3): number {
  const u = unit(up);
  const pf = flatten(p, u);
  const af = flatten(a, u);
  const bf = flatten(b, u);
  const dx = bf[0] - af[0];
  const dy = bf[1] - af[1];
  const dz = bf[2] - af[2];
  const lenSq = dx * dx + dy * dy + dz * dz;
  const wx = pf[0] - af[0];
  const wy = pf[1] - af[1];
  const wz = pf[2] - af[2];
  let t = lenSq > 0 ? (wx * dx + wy * dy + wz * dz) / lenSq : 0;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return Math.hypot(wx - t * dx, wy - t * dy, wz - t * dz);
}

/**
 * Absolute tolerance for that distance, derived rather than tuned.
 *
 * `distanceToSegment` runs about twenty five double operations: three dot
 * products of three terms (five operations each) for the flattening, nine
 * subtractions, the parametric divide, and a three-term hypot. Each carries
 * at most half an ulp of its largest intermediate, and that intermediate is
 * the coordinate scale S, because removing the `up` component of a point of
 * magnitude S cancels two numbers of size S. That is 25 * 0.5 * eps * S, near
 * 3e-15 * S. The module's own vertex arithmetic adds the normalisation error
 * of `along`, `lateral` and `up`, a few eps applied to terms of the same
 * size. Around 20 eps * S in total; 64 is the next power of two above it, so
 * the bound has a factor of three in hand and no room to have been fitted to
 * an observed residual.
 */
function boundaryTolerance(scale: number): number {
  return 64 * Number.EPSILON * scale;
}

/** Coordinate scale of a case: the largest magnitude the arithmetic sees. */
function scaleOf(a: Vec3, b: Vec3, halfWidth: number): number {
  return Math.max(Math.hypot(a[0], a[1], a[2]), Math.hypot(b[0], b[1], b[2]), halfWidth);
}

function rotate(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Rotation by `angle` about the unit axis `k` (Rodrigues, row major). */
function rotationMatrix(axis: Vec3, angle: number): number[] {
  const k = unit(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * k[0] * k[0] + c,
    t * k[0] * k[1] - s * k[2],
    t * k[0] * k[2] + s * k[1],
    t * k[0] * k[1] + s * k[2],
    t * k[1] * k[1] + c,
    t * k[1] * k[2] - s * k[0],
    t * k[0] * k[2] - s * k[1],
    t * k[1] * k[2] + s * k[0],
    t * k[2] * k[2] + c,
  ];
}

/* ------------------------------------------------------------------ *
 * Fixed cases. Four up axes, one of them oblique to every world axis.
 * ------------------------------------------------------------------ */

const UP_AXES: ReadonlyArray<{ name: string; up: Vec3 }> = [
  { name: 'Z-up', up: [0, 0, 1] },
  { name: 'Y-up', up: [0, 1, 0] },
  { name: 'X-up', up: [1, 0, 0] },
  { name: 'oblique up', up: [0.37, -0.82, 0.44] },
  { name: 'oblique unnormalised up', up: [3, 4, 12] },
];

const SECTIONS: ReadonlyArray<{ name: string; a: Vec3; b: Vec3; halfWidth: number }> = [
  // No section here may run along any of the up axes above, or it would have
  // no plan extent under that axis and would be a disc rather than a capsule.
  { name: 'short run', a: [0, 0, 0], b: [10, 6, -3], halfWidth: 2 },
  { name: 'sloped diagonal', a: [-40, 12, 7], b: [63, -21, 30], halfWidth: 4.5 },
  { name: 'far from the origin', a: [820, -410, 95], b: [640, 300, 140], halfWidth: 12.25 },
  { name: 'hairline band', a: [5, 5, 5], b: [-15, 40, 2], halfWidth: 1e-3 },
];

describe('profileCorridorOutline: boundary fidelity', () => {
  for (const axis of UP_AXES) {
    for (const section of SECTIONS) {
      it(`every boundary vertex sits at the half width (${axis.name}, ${section.name})`, () => {
        const { a, b, halfWidth } = section;
        const frame = buildProfileFrame(a, b, axis.up);
        const outline = buildProfileCorridorOutline(frame, halfWidth);
        expect(outline.kind).toBe('capsule');

        const vertices = profileCorridorBoundaryVertices(outline);
        // Two walls of two vertices, and a cap of segs + 1 vertices at EACH
        // end. A corridor capped at one end only lands here, in every case,
        // rather than in one test that happens to look.
        const segs = outline.arcSegments;
        expect(vertices).toHaveLength(4 + 2 * (segs + 1));
        const tol = boundaryTolerance(scaleOf(a, b, halfWidth));

        // Each cap has to bulge past its own endpoint, so both apexes exist.
        const apex = (end: Vec3, sign: number): Vec3 => [
          end[0] + frame.along[0] * halfWidth * sign,
          end[1] + frame.along[1] * halfWidth * sign,
          end[2] + frame.along[2] * halfWidth * sign,
        ];
        const holds = (set: Vec3[], q: Vec3) =>
          set.some((v) => Math.hypot(v[0] - q[0], v[1] - q[1], v[2] - q[2]) <= tol);
        expect(holds(outline.startCap, apex(a, -1))).toBe(true);
        expect(holds(outline.endCap, apex(b, 1))).toBe(true);

        for (const v of vertices) {
          expect(Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])).toBe(
            true,
          );
          const d = distanceToSegment(v, a, b, axis.up);
          expect(Math.abs(d - halfWidth)).toBeLessThanOrEqual(tol);
        }
      });

      it(`the outline traces the sampler's own accept boundary (${axis.name}, ${section.name})`, () => {
        // The strongest statement available: nudge each emitted vertex a
        // little way in and a little way out along its own outward normal,
        // and require the corridor predicate to flip. Only a vertex actually
        // on the accepted region's edge can do that.
        const { a, b, halfWidth } = section;
        const frame = buildProfileFrame(a, b, axis.up);
        const outline = buildProfileCorridorOutline(frame, halfWidth);
        const scratch = createProfileHitScratch();
        const nudge = halfWidth * 1e-6;
        const u = unit(axis.up);

        for (const v of profileCorridorBoundaryVertices(outline)) {
          // Outward normal: the vertex minus its own foot on the segment,
          // rebuilt here from the flattened geometry.
          const pf = flatten(v, u);
          const af = flatten(a, u);
          const bf = flatten(b, u);
          const dx = bf[0] - af[0];
          const dy = bf[1] - af[1];
          const dz = bf[2] - af[2];
          const lenSq = dx * dx + dy * dy + dz * dz;
          const wx = pf[0] - af[0];
          const wy = pf[1] - af[1];
          const wz = pf[2] - af[2];
          let t = lenSq > 0 ? (wx * dx + wy * dy + wz * dz) / lenSq : 0;
          if (t < 0) t = 0;
          if (t > 1) t = 1;
          const n = unit([wx - t * dx, wy - t * dy, wz - t * dz]);

          const inward: Vec3 = [
            v[0] - n[0] * nudge,
            v[1] - n[1] * nudge,
            v[2] - n[2] * nudge,
          ];
          const outward: Vec3 = [
            v[0] + n[0] * nudge,
            v[1] + n[1] * nudge,
            v[2] + n[2] * nudge,
          ];
          const bandSq = halfWidth * halfWidth;
          expect(
            profileCorridorAccepts(frame, halfWidth, bandSq, inward[0], inward[1], inward[2], scratch),
          ).toBe(true);
          expect(
            profileCorridorAccepts(
              frame,
              halfWidth,
              bandSq,
              outward[0],
              outward[1],
              outward[2],
              scratch,
            ),
          ).toBe(false);
        }
      });
    }
  }
});

describe('profileCorridorOutline: the caps are arcs, not corners', () => {
  // Y-up on purpose: a module that read height off the last component would
  // build this corridor in the wrong plane and never reach the assertions.
  const up: Vec3 = [0, 1, 0];
  const a: Vec3 = [0, 3, 0];
  const b: Vec3 = [10, 5, 0];
  const halfWidth = 2;
  const frame = buildProfileFrame(a, b, up);

  it('the cap apex is at the half width from the endpoint, not the half width times root two', () => {
    const outline = buildProfileCorridorOutline(frame, halfWidth);
    const along = frame.along;
    const apex: Vec3 = [
      a[0] - along[0] * halfWidth,
      a[1] - along[1] * halfWidth,
      a[2] - along[2] * halfWidth,
    ];
    const tol = boundaryTolerance(scaleOf(a, b, halfWidth));

    const hit = outline.startCap.find(
      (v) => Math.hypot(v[0] - apex[0], v[1] - apex[1], v[2] - apex[2]) <= tol,
    );
    expect(hit).toBeDefined();

    // The number that separates a capsule from a rectangle. The arc puts this
    // vertex at exactly the half width from the endpoint; a square corner
    // would put it at the half width times root two.
    const fromEndpoint = distanceToSegment(hit as Vec3, a, b, up);
    expect(Math.abs(fromEndpoint - halfWidth)).toBeLessThanOrEqual(tol);
    const squareCorner = halfWidth * Math.SQRT2;
    expect(squareCorner - fromEndpoint).toBeCloseTo(halfWidth * (Math.SQRT2 - 1), 9);
    // And the gap between the two is nine orders of magnitude above the
    // tolerance, so the check is discriminating rather than marginal.
    expect(squareCorner - fromEndpoint).toBeGreaterThan(tol * 1e9);
  });

  it('no vertex reaches a rectangle corner', () => {
    const outline = buildProfileCorridorOutline(frame, halfWidth);
    const along = frame.along;
    const lateral = frame.lateral;
    const corners: Vec3[] = [];
    for (const [end, dir] of [
      [a, -1],
      [b, 1],
    ] as ReadonlyArray<[Vec3, number]>) {
      for (const side of [1, -1]) {
        corners.push([
          end[0] + along[0] * halfWidth * dir + lateral[0] * halfWidth * side,
          end[1] + along[1] * halfWidth * dir + lateral[1] * halfWidth * side,
          end[2] + along[2] * halfWidth * dir + lateral[2] * halfWidth * side,
        ]);
      }
    }
    // A rectangle corner is halfWidth * (sqrt(2) - 1) away from the nearest
    // point of the capsule, so a quarter of the half width is a wide margin.
    const margin = halfWidth * 0.25;
    for (const v of profileCorridorBoundaryVertices(outline)) {
      for (const c of corners) {
        expect(Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2])).toBeGreaterThan(margin);
      }
      // And nothing anywhere claims more than the corridor.
      expect(distanceToSegment(v, a, b, up)).toBeLessThanOrEqual(
        halfWidth + boundaryTolerance(scaleOf(a, b, halfWidth)),
      );
    }
  });

  it('caps both ends, each with a full half turn', () => {
    const outline = buildProfileCorridorOutline(frame, halfWidth);
    const segs = DEFAULT_CORRIDOR_ARC_SEGMENTS;
    expect(outline.startCap).toHaveLength(segs + 1);
    expect(outline.endCap).toHaveLength(segs + 1);

    const along = frame.along;
    const tol = boundaryTolerance(scaleOf(a, b, halfWidth));
    const startApex: Vec3 = [
      a[0] - along[0] * halfWidth,
      a[1] - along[1] * halfWidth,
      a[2] - along[2] * halfWidth,
    ];
    const endApex: Vec3 = [
      b[0] + along[0] * halfWidth,
      b[1] + along[1] * halfWidth,
      b[2] + along[2] * halfWidth,
    ];
    const near = (set: Vec3[], q: Vec3) =>
      set.some((v) => Math.hypot(v[0] - q[0], v[1] - q[1], v[2] - q[2]) <= tol);
    expect(near(outline.startCap, startApex)).toBe(true);
    expect(near(outline.endCap, endApex)).toBe(true);
    // Each cap must bulge past its OWN endpoint. A cap drawn at the wrong end
    // would put its apex inside the corridor, at distance zero.
    expect(distanceToSegment(startApex, a, b, up)).toBeCloseTo(halfWidth, 9);
    expect(distanceToSegment(endApex, a, b, up)).toBeCloseTo(halfWidth, 9);
    for (const v of outline.startCap) {
      expect(
        Math.hypot(v[0] - endApex[0], v[1] - endApex[1], v[2] - endApex[2]),
      ).toBeGreaterThan(halfWidth);
    }
    for (const v of outline.endCap) {
      expect(
        Math.hypot(v[0] - startApex[0], v[1] - startApex[1], v[2] - startApex[2]),
      ).toBeGreaterThan(halfWidth);
    }
  });
});

describe('profileCorridorOutline: assembly', () => {
  const frame = buildProfileFrame([2, -3, 1], [40, 18, 9], [0.2, 0.1, 0.97]);
  const halfWidth = 3;

  it('the loop closes exactly and meets the walls bit for bit', () => {
    const outline = buildProfileCorridorOutline(frame, halfWidth);
    const segs = outline.arcSegments;
    expect(outline.loop).toHaveLength(2 * segs + 3);
    expect(outline.loop[outline.loop.length - 1]).toEqual(outline.loop[0]);
    expect(outline.leftBoundary[0]).toEqual(outline.startCap[outline.startCap.length - 1]);
    expect(outline.leftBoundary[1]).toEqual(outline.endCap[0]);
    expect(outline.rightBoundary[0]).toEqual(outline.endCap[outline.endCap.length - 1]);
    expect(outline.rightBoundary[1]).toEqual(outline.startCap[0]);
  });

  it('the centre transect is the section itself and is not on the boundary', () => {
    const outline = buildProfileCorridorOutline(frame, halfWidth);
    expect(outline.centre).toEqual([frame.a, frame.b]);
    for (const v of outline.centre) {
      expect(distanceToSegment(v, frame.a, frame.b, frame.up)).toBeLessThan(1e-9);
    }
    expect(profileCorridorBoundaryVertices(outline)).not.toContainEqual(outline.centre[0]);
  });

  it('the walls stay at the endpoint heights', () => {
    const outline = buildProfileCorridorOutline(frame, halfWidth);
    const u = frame.up;
    const height = (p: Vec3) => p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
    const tol = boundaryTolerance(scaleOf(frame.a, frame.b, halfWidth));
    expect(Math.abs(height(outline.leftBoundary[0]) - height(frame.a))).toBeLessThanOrEqual(tol);
    expect(Math.abs(height(outline.leftBoundary[1]) - height(frame.b))).toBeLessThanOrEqual(tol);
    expect(Math.abs(height(outline.rightBoundary[0]) - height(frame.b))).toBeLessThanOrEqual(tol);
    expect(Math.abs(height(outline.rightBoundary[1]) - height(frame.a))).toBeLessThanOrEqual(tol);
  });

  it('rotating the scene rotates the outline, so no axis is baked in', () => {
    const m = rotationMatrix([0.4, 0.9, -0.2], 0.7);
    const a: Vec3 = [2, -3, 1];
    const b: Vec3 = [40, 18, 9];
    const up: Vec3 = [0.2, 0.1, 0.97];
    const plain = buildProfileCorridorOutline(buildProfileFrame(a, b, up), halfWidth);
    const turned = buildProfileCorridorOutline(
      buildProfileFrame(rotate(m, a), rotate(m, b), rotate(m, up)),
      halfWidth,
    );
    expect(turned.loop).toHaveLength(plain.loop.length);
    // Four times the direct bound: each side is now carried through an extra
    // three by three product, six operations on terms of the same size.
    const tol = 4 * boundaryTolerance(scaleOf(a, b, halfWidth));
    for (let i = 0; i < plain.loop.length; i++) {
      const want = rotate(m, plain.loop[i]);
      const got = turned.loop[i];
      expect(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])).toBeLessThanOrEqual(
        tol,
      );
    }
  });
});

describe('profileCorridorOutline: arc resolution', () => {
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [30, 0, 4];
  const up: Vec3 = [0, 0, 1];
  const frame = buildProfileFrame(a, b, up);
  const halfWidth = 5;

  /** Worst chord sagitta over a cap, as a fraction of the half width. */
  function worstChordFraction(segs: number): number {
    const outline = buildProfileCorridorOutline(frame, halfWidth, segs);
    let worst = 0;
    for (const cap of [outline.startCap, outline.endCap]) {
      for (let i = 1; i < cap.length; i++) {
        const p = cap[i - 1];
        const q = cap[i];
        const mid: Vec3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        worst = Math.max(worst, halfWidth - distanceToSegment(mid, a, b, up));
      }
    }
    return worst / halfWidth;
  }

  it('the default is the fewest segments that hold the chord under one part in a thousand', () => {
    expect(DEFAULT_CORRIDOR_ARC_SEGMENTS).toBe(36);
    expect(worstChordFraction(DEFAULT_CORRIDOR_ARC_SEGMENTS)).toBeLessThanOrEqual(
      CORRIDOR_ARC_CHORD_FRACTION,
    );
    // One segment fewer misses it, which is what makes 36 the default rather
    // than a round number someone liked.
    expect(worstChordFraction(DEFAULT_CORRIDOR_ARC_SEGMENTS - 1)).toBeGreaterThan(
      CORRIDOR_ARC_CHORD_FRACTION,
    );
  });

  it('the chord always falls short of the boundary, never past it', () => {
    for (const segs of [1, 2, 8, 36, 200]) {
      expect(worstChordFraction(segs)).toBeGreaterThanOrEqual(0);
    }
  });

  it('clamps a segment count instead of trusting it', () => {
    expect(buildProfileCorridorOutline(frame, halfWidth, 0).arcSegments).toBe(
      MIN_CORRIDOR_ARC_SEGMENTS,
    );
    expect(buildProfileCorridorOutline(frame, halfWidth, -12).arcSegments).toBe(
      MIN_CORRIDOR_ARC_SEGMENTS,
    );
    expect(buildProfileCorridorOutline(frame, halfWidth, 1e9).arcSegments).toBe(
      MAX_CORRIDOR_ARC_SEGMENTS,
    );
    expect(buildProfileCorridorOutline(frame, halfWidth, 7.8).arcSegments).toBe(7);
    expect(buildProfileCorridorOutline(frame, halfWidth, Number.NaN).arcSegments).toBe(
      DEFAULT_CORRIDOR_ARC_SEGMENTS,
    );
    expect(buildProfileCorridorOutline(frame, halfWidth, Number.POSITIVE_INFINITY).arcSegments).toBe(
      DEFAULT_CORRIDOR_ARC_SEGMENTS,
    );
  });
});

describe('profileCorridorOutline: degenerate input', () => {
  const allVertices = (o: ReturnType<typeof buildProfileCorridorOutline>): Vec3[] => [
    ...o.centre,
    ...profileCorridorBoundaryVertices(o),
    ...o.loop,
  ];
  const allFinite = (o: ReturnType<typeof buildProfileCorridorOutline>) =>
    allVertices(o).every(
      (v) => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]),
    );

  it('a zero-length section becomes the cylinder the sampler actually walks', () => {
    for (const axis of UP_AXES) {
      const a: Vec3 = [7, -2, 11];
      const frame = buildProfileFrame(a, a, axis.up);
      const outline = buildProfileCorridorOutline(frame, 3);
      expect(outline.kind).toBe('disc');
      expect(allFinite(outline)).toBe(true);
      expect(outline.leftBoundary).toHaveLength(0);
      // A closed ring at each endpoint height: 2n chords, 2n + 1 vertices.
      expect(outline.startCap).toHaveLength(2 * DEFAULT_CORRIDOR_ARC_SEGMENTS + 1);
      expect(outline.startCap[outline.startCap.length - 1]).toEqual(outline.startCap[0]);
      const tol = boundaryTolerance(scaleOf(a, a, 3));
      for (const v of outline.startCap) {
        expect(Math.abs(distanceToSegment(v, a, a, axis.up) - 3)).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('a purely vertical section becomes a ring at each end', () => {
    const up: Vec3 = [0, 1, 0];
    const a: Vec3 = [4, 0, 6];
    const b: Vec3 = [4, 25, 6];
    const outline = buildProfileCorridorOutline(buildProfileFrame(a, b, up), 2);
    expect(outline.kind).toBe('disc');
    expect(allFinite(outline)).toBe(true);
    const tol = boundaryTolerance(scaleOf(a, b, 2));
    for (const v of [...outline.startCap, ...outline.endCap]) {
      expect(Math.abs(distanceToSegment(v, a, b, up) - 2)).toBeLessThanOrEqual(tol);
    }
    for (const v of outline.startCap) expect(Math.abs(v[1] - a[1])).toBeLessThanOrEqual(tol);
    for (const v of outline.endCap) expect(Math.abs(v[1] - b[1])).toBeLessThanOrEqual(tol);
  });

  it('a zero or negative band leaves the transect and nothing else', () => {
    const frame = buildProfileFrame([0, 0, 0], [10, 0, 0], [0, 0, 1]);
    for (const w of [0, -0, -4, Number.NaN]) {
      const outline = buildProfileCorridorOutline(frame, w);
      expect(outline.kind).toBe('line');
      expect(outline.label).toBe(PROFILE_CORRIDOR_OUTLINE_LABEL_NO_BAND);
      expect(outline.centre).toHaveLength(2);
      expect(profileCorridorBoundaryVertices(outline)).toHaveLength(0);
      expect(outline.loop).toHaveLength(0);
      expect(allFinite(outline)).toBe(true);
      expect(outline.halfWidth).toBe(0);
    }
  });

  it('a non-finite endpoint emits nothing at all', () => {
    const bad: Vec3[] = [
      [Number.NaN, 0, 0],
      [0, Number.POSITIVE_INFINITY, 0],
      [0, 0, Number.NEGATIVE_INFINITY],
    ];
    for (const p of bad) {
      for (const frame of [
        buildProfileFrame(p, [10, 0, 0], [0, 0, 1]),
        buildProfileFrame([0, 0, 0], p, [0, 0, 1]),
      ]) {
        const outline = buildProfileCorridorOutline(frame, 2);
        expect(outline.kind).toBe('none');
        expect(outline.label).toBe(PROFILE_CORRIDOR_OUTLINE_LABEL_NONE);
        expect(allVertices(outline)).toHaveLength(0);
      }
    }
  });

  it('a degenerate up axis emits nothing at all', () => {
    for (const up of [
      [0, 0, 0],
      [Number.NaN, 1, 0],
      [Number.POSITIVE_INFINITY, 0, 0],
    ] as Vec3[]) {
      const outline = buildProfileCorridorOutline(buildProfileFrame([0, 0, 0], [10, 0, 0], up), 2);
      expect(outline.kind).toBe('none');
      expect(allVertices(outline)).toHaveLength(0);
    }
  });

  it('an enormous half width still terminates and stays finite', () => {
    const frame = buildProfileFrame([0, 0, 0], [1, 0, 0], [0, 0, 1]);
    const outline = buildProfileCorridorOutline(frame, 1e12);
    expect(outline.kind).toBe('capsule');
    expect(allFinite(outline)).toBe(true);
  });
});

describe('profileCorridorOutline: label', () => {
  it('names the outline as sampling support rather than an uncertainty band', () => {
    const frame = buildProfileFrame([0, 0, 0], [10, 0, 0], [0, 0, 1]);
    const outline = buildProfileCorridorOutline(frame, 2);
    expect(outline.label).toBe(PROFILE_CORRIDOR_OUTLINE_LABEL);
    expect(outline.label.toLowerCase()).toContain('sampl');
    expect(outline.label.toLowerCase()).toContain('not an uncertainty band');
    expect(outline.label.length).toBeLessThanOrEqual(90);
  });
});
