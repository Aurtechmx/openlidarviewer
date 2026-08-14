/**
 * scanFootprint.test.ts: the scan-footprint polygon, geometry, the fail-closed
 * CRS gate, and the KML 2.2 document it becomes.
 *
 * Three things are load-bearing here and each has its own block.
 *
 * The RING is a closed LinearRing: four distinct corners plus a repeated first
 * vertex, wound counter-clockwise, because KML reads an outer boundary by the
 * right-hand rule and a reversed ring is a hole in some readers.
 *
 * The GATE is the honesty contract. A footprint is a claim about where on Earth
 * a scan sits, so an unknown or unconfirmed CRS must produce a refusal, never a
 * plausible-looking rectangle somewhere off the coast of Ghana. The expected
 * lon/lat values below come from proj4 run independently of the viewer's
 * vendored UTM converter, so agreement is evidence rather than a tautology.
 *
 * The DOCUMENT is checked with a small XML scanner rather than DOMParser, which
 * Node does not guarantee: it tokenises the emitted text and fails on any
 * unbalanced or mis-nested tag, so "well-formed" is asserted and not assumed.
 */

import { describe, it, expect } from 'vitest';
import {
  footprintRectangleRing,
  footprintConvexHullRing,
  footprintCrsRefusal,
  footprintLonLatRing,
  footprintAntimeridianRefusal,
  footprintUpAxisRefusal,
  ScanFootprintError,
  type FootprintExtent,
} from '../src/export/scanFootprint';
import { buildFootprintKml } from '../src/export/kmlExport';
import { makeLocalToLonLat } from '../src/export/lonLatMapper';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const utm12: ResolvedCrs = {
  kind: 'projected',
  name: 'WGS 84 / UTM zone 12N',
  epsg: 32612,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
};

/** Origin chosen so the ring's first corner lands on zone 12's central meridian. */
const UTM12_ORIGIN: readonly [number, number, number] = [500_000, 4_400_000, 0];

/** A 1000 m x 800 m scan, expressed in LOCAL (origin-relative) coordinates. */
const extent: FootprintExtent = { minX: 0, minY: 0, maxX: 1000, maxY: 800 };

/**
 * Expected degrees for the four corners, in ring order, computed with proj4
 * (+proj=utm +zone=12 +datum=WGS84) rather than with the converter under test.
 */
const EXPECTED_CORNERS: readonly (readonly [number, number])[] = [
  [-111.0, 39.749907519],
  [-110.988327342, 39.749906932],
  [-110.988326125, 39.757115082],
  [-111.0, 39.757115669],
];

const NOT_SURVEY_GRADE =
  'Estimates only — not survey-grade. Validate against ground control where survey-grade accuracy is required.';

// ─────────────────────────────────────────────────────────────────────────────
// A minimal well-formedness scanner. Rejects unbalanced or mis-nested tags and
// text that carries a raw `<`; returns the element path of every leaf so a test
// can assert nesting rather than mere substring presence.
// ─────────────────────────────────────────────────────────────────────────────

interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

function parseXml(source: string): XmlNode {
  const body = source.replace(/^<\?xml[^?]*\?>\s*/, '');
  const root: XmlNode = { name: '#root', children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].text += body.slice(i);
      break;
    }
    stack[stack.length - 1].text += body.slice(i, lt);
    const gt = body.indexOf('>', lt);
    if (gt < 0) throw new Error(`unterminated tag at ${lt}`);
    const raw = body.slice(lt + 1, gt).trim();
    if (raw.startsWith('/')) {
      const closed = stack.pop();
      if (!closed || closed.name !== raw.slice(1)) {
        throw new Error(`mismatched close </${raw.slice(1)}> for <${closed?.name}>`);
      }
    } else if (!raw.endsWith('/')) {
      const name = raw.split(/[\s>]/)[0];
      const node: XmlNode = { name, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
    i = gt + 1;
  }
  if (stack.length !== 1) throw new Error(`unclosed element <${stack[stack.length - 1].name}>`);
  if (root.text.trim().length > 0) throw new Error('text outside the root element');
  return root;
}

/** Depth-first search for the first element with `name`. */
function find(node: XmlNode, name: string): XmlNode | null {
  for (const child of node.children) {
    if (child.name === name) return child;
    const deeper = find(child, name);
    if (deeper) return deeper;
  }
  return null;
}

/** Twice the signed area of a closed ring. Positive means counter-clockwise. */
function signedArea2(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ring geometry
// ─────────────────────────────────────────────────────────────────────────────

describe('footprintRectangleRing', () => {
  it('closes the ring with five coordinate pairs for four corners', () => {
    const ring = footprintRectangleRing(extent);
    expect(ring).toHaveLength(5);
    expect(ring[4]).toEqual(ring[0]);
  });

  it('visits every corner of the extent exactly once', () => {
    const ring = footprintRectangleRing(extent);
    expect(ring.slice(0, 4)).toEqual([
      [0, 0],
      [1000, 0],
      [1000, 800],
      [0, 800],
    ]);
  });

  it('winds counter-clockwise, as a KML outer boundary must', () => {
    expect(signedArea2(footprintRectangleRing(extent))).toBeGreaterThan(0);
  });

  it('refuses an inverted extent rather than emitting a folded ring', () => {
    expect(() => footprintRectangleRing({ minX: 10, minY: 0, maxX: 5, maxY: 8 }))
      .toThrow(ScanFootprintError);
  });

  it('refuses a zero-area extent', () => {
    expect(() => footprintRectangleRing({ minX: 4, minY: 0, maxX: 4, maxY: 8 }))
      .toThrow(ScanFootprintError);
  });

  it('refuses a non-finite extent', () => {
    expect(() => footprintRectangleRing({ minX: 0, minY: 0, maxX: NaN, maxY: 8 }))
      .toThrow(ScanFootprintError);
  });
});

/** Build an interleaved local xyz buffer from `[x, y]` pairs (z is arbitrary). */
function xyz(pairs: readonly (readonly [number, number])[]): Float32Array {
  const out = new Float32Array(pairs.length * 3);
  pairs.forEach(([x, y], i) => {
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = 42; // z ignored
  });
  return out;
}

/** Is `[x, y]` a vertex of `ring` (to float tolerance)? */
function ringHas(ring: readonly (readonly [number, number])[], x: number, y: number): boolean {
  return ring.some(([rx, ry]) => Math.abs(rx - x) < 1e-6 && Math.abs(ry - y) < 1e-6);
}

describe('footprintConvexHullRing', () => {
  it('traces the hull, dropping interior points, and closes counter-clockwise', () => {
    // A unit square with a point in the middle: the centre must not survive.
    const ring = footprintConvexHullRing(xyz([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]));
    expect(ring[0]).toEqual(ring[ring.length - 1]); // closed
    expect(signedArea2(ring)).toBeGreaterThan(0); // CCW
    for (const [x, y] of [[0, 0], [10, 0], [10, 10], [0, 10]]) {
      expect(ringHas(ring, x, y)).toBe(true);
    }
    expect(ringHas(ring, 5, 5)).toBe(false);
  });

  it('is a tighter outline than the bounding rectangle for a diagonal spread', () => {
    // A diamond: its hull is the four tips; the bounding rectangle would add the
    // four empty corners, so the hull encloses exactly half the rectangle's area.
    const hull = footprintConvexHullRing(xyz([[5, 0], [10, 5], [5, 10], [0, 5]]));
    const rect = footprintRectangleRing({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(signedArea2(hull)).toBeLessThan(signedArea2(rect));
  });

  it('refuses fewer than three points', () => {
    expect(() => footprintConvexHullRing(xyz([[0, 0], [1, 1]]))).toThrow(ScanFootprintError);
  });

  it('refuses collinear points: a line is not an area', () => {
    expect(() => footprintConvexHullRing(xyz([[0, 0], [1, 1], [2, 2], [3, 3]])))
      .toThrow(ScanFootprintError);
  });

  it('refuses coincident points', () => {
    expect(() => footprintConvexHullRing(xyz([[7, 7], [7, 7], [7, 7]])))
      .toThrow(ScanFootprintError);
  });

  it('refuses a non-finite coordinate rather than tracing a bad hull', () => {
    expect(() => footprintConvexHullRing(xyz([[0, 0], [10, 0], [NaN, 10], [0, 10]])))
      .toThrow(ScanFootprintError);
  });

  it('keeps every hull vertex that is not an axis/diagonal extreme', () => {
    // A regular 16-gon: its vertices at 22.5°, 67.5°, … are genuine hull corners
    // but NOT among the eight extremes the Akl-Toussaint octagon captures, so
    // they only survive if the pruning octagon is a real convex polygon (a
    // scrambled vertex order would test a self-crossing star and drop some).
    const verts: [number, number][] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      verts.push([1000 + 1000 * Math.cos(a), 1000 + 1000 * Math.sin(a)]);
    }
    // Dense interior filler so pruning has real work and can misfire.
    const filler: [number, number][] = [];
    for (let gx = 700; gx <= 1300; gx += 100) {
      for (let gy = 700; gy <= 1300; gy += 100) filler.push([gx, gy]);
    }
    const ring = footprintConvexHullRing(xyz([...verts, ...filler]));
    const near = (x: number, y: number) =>
      ring.some(([rx, ry]) => Math.abs(rx - x) < 1 && Math.abs(ry - y) < 1);
    for (const [x, y] of verts) expect(near(x, y)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The fail-closed CRS gate
// ─────────────────────────────────────────────────────────────────────────────

describe('footprintCrsRefusal', () => {
  it('allows a confidently detected projected CRS', () => {
    expect(footprintCrsRefusal(utm12)).toBeNull();
  });

  it('allows a geographic CRS', () => {
    const geographic: ResolvedCrs = { ...utm12, kind: 'geographic', epsg: 4326, linearUnit: 'unknown' };
    expect(footprintCrsRefusal(geographic)).toBeNull();
  });

  it('refuses when there is no CRS at all', () => {
    expect(footprintCrsRefusal(null)).toMatch(/coordinate system/i);
  });

  it('refuses an unknown frame', () => {
    expect(footprintCrsRefusal({ ...utm12, kind: 'unknown' })).toMatch(/coordinate system/i);
  });

  it('refuses local coordinates', () => {
    expect(footprintCrsRefusal({ ...utm12, kind: 'local' })).toMatch(/coordinate system/i);
  });

  it('refuses a CRS carrying no detection confidence', () => {
    expect(footprintCrsRefusal({ ...utm12, confidence: 'none' })).toBeTruthy();
  });

  it('refuses a low-confidence detection the user has not confirmed', () => {
    const refusal = footprintCrsRefusal({ ...utm12, confidence: 'low', userConfirmed: false });
    expect(refusal).toMatch(/confirm/i);
  });

  it('allows a low-confidence detection once the user confirms it', () => {
    expect(footprintCrsRefusal({ ...utm12, confidence: 'low', userConfirmed: true })).toBeNull();
  });

  it('names the Inspector so the refusal is actionable', () => {
    expect(footprintCrsRefusal(null)).toMatch(/inspector/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reprojection to WGS84
// ─────────────────────────────────────────────────────────────────────────────

describe('footprintLonLatRing', () => {
  const mapper = makeLocalToLonLat(utm12, UTM12_ORIGIN);

  it('returns a closed ring of five lon/lat pairs', () => {
    const ring = footprintLonLatRing(footprintRectangleRing(extent), mapper);
    expect(ring).toHaveLength(5);
    expect(ring[4]).toEqual(ring[0]);
  });

  it('lands every corner inside the geographic domain', () => {
    const ring = footprintLonLatRing(footprintRectangleRing(extent), mapper);
    for (const [lon, lat] of ring) {
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThanOrEqual(180);
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
    }
  });

  it('matches the degrees proj4 computes for the same UTM corners', () => {
    const ring = footprintLonLatRing(footprintRectangleRing(extent), mapper);
    EXPECTED_CORNERS.forEach(([lon, lat], i) => {
      expect(ring[i][0]).toBeCloseTo(lon, 6);
      expect(ring[i][1]).toBeCloseTo(lat, 6);
    });
  });

  it('preserves counter-clockwise winding through the reprojection', () => {
    expect(signedArea2(footprintLonLatRing(footprintRectangleRing(extent), mapper)))
      .toBeGreaterThan(0);
  });

  it('REFUSES rather than emitting coordinates when there is no mapper', () => {
    expect(() => footprintLonLatRing(footprintRectangleRing(extent), null))
      .toThrow(ScanFootprintError);
  });

  it('REFUSES when a corner leaves the projection grid', () => {
    // The origin converts, so the mapper exists; this corner's absolute easting
    // is 900001, off the UTM grid. Emitting raw metres as degrees is the bug
    // this guards.
    const far = footprintRectangleRing({ minX: 0, minY: 0, maxX: 400_001, maxY: 800 });
    expect(() => footprintLonLatRing(far, mapper)).toThrow(ScanFootprintError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The antimeridian
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A ring that straddles ±180° is the one wrong footprint that every existing
 * check passes. Each corner is a valid longitude, so the per-coordinate domain
 * guard in `kmlExport.ts` is silent; the extent is finite and non-degenerate, so
 * `footprintRectangleRing` is silent; the reprojection succeeds, so the mapper
 * is silent. What comes out is a rectangle from -179.8° to 179.8° — 359.6° of
 * longitude, a box around nearly the whole planet, delivered as "the scanned
 * area" with the not-survey-grade caveat attached and nothing else to warn on.
 *
 * The defect lives in the RING rather than in any vertex, so the test does too.
 */
describe('the antimeridian', () => {
  const wgs84: ResolvedCrs = {
    kind: 'geographic',
    name: 'WGS 84',
    epsg: 4326,
    linearUnit: 'unknown',
    linearUnitToMetres: 1,
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: false,
  };
  /** Degrees in, degrees out: local coordinates ARE lon/lat for this frame. */
  const degrees = makeLocalToLonLat(wgs84, [0, 0, 0]);

  /** A scan a few hundred metres wide sitting on top of the 180th meridian. */
  const crossing: FootprintExtent = { minX: -179.8, minY: -0.2, maxX: 179.8, maxY: 0.2 };

  it('REFUSES a ring whose corners wrap ±180° instead of drawing a world-sized box', () => {
    expect(() => footprintLonLatRing(footprintRectangleRing(crossing), degrees))
      .toThrow(ScanFootprintError);
  });

  it('says the antimeridian is the reason and how to proceed', () => {
    const refusal = footprintAntimeridianRefusal(footprintRectangleRing(crossing));
    expect(refusal).toMatch(/antimeridian/i);
    expect(refusal).toMatch(/180/);
    expect(refusal).toMatch(/split|reproject/i);
  });

  it('does not clamp, wrap or otherwise repair the coordinates', () => {
    // The failure mode this replaces is a plausible file. Anything that returns
    // a ring here — normalised, clipped or split — is the defect in a new shape.
    let produced: unknown = 'not called';
    try {
      produced = footprintLonLatRing(footprintRectangleRing(crossing), degrees);
    } catch {
      produced = null;
    }
    expect(produced).toBeNull();
  });

  it('leaves a normal, small, non-crossing scan untouched', () => {
    const local: FootprintExtent = { minX: -111.05, minY: 39.7, maxX: -110.95, maxY: 39.8 };
    const ring = footprintLonLatRing(footprintRectangleRing(local), degrees);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual([-111.05, 39.7]);
    expect(ring[4]).toEqual(ring[0]);
  });

  it('allows a legitimately wide extent that never crosses ±180°', () => {
    // 160° of longitude is enormous for a scan and still entirely honest: the
    // short way between -100° and 60° does not pass through the antimeridian.
    const wide: FootprintExtent = { minX: -100, minY: -10, maxX: 60, maxY: 10 };
    expect(footprintAntimeridianRefusal(footprintRectangleRing(wide))).toBeNull();
    expect(footprintLonLatRing(footprintRectangleRing(wide), degrees)).toHaveLength(5);
  });

  it('treats exactly 180° of span as the last honest case, not the first bad one', () => {
    // At exactly 180° the two arcs are equal, so nothing is being wrapped; the
    // refusal starts above it. Pinned so the comparison cannot drift to `<`.
    expect(footprintAntimeridianRefusal([[-90, 0], [90, 0], [90, 1], [-90, 1], [-90, 0]]))
      .toBeNull();
    expect(footprintAntimeridianRefusal([[-90.1, 0], [90, 0], [90, 1], [-90.1, 1], [-90.1, 0]]))
      .toBeTruthy();
  });

  it('says nothing about an ordinary projected footprint', () => {
    expect(footprintAntimeridianRefusal(
      footprintLonLatRing(footprintRectangleRing(extent), makeLocalToLonLat(utm12, UTM12_ORIGIN)),
    )).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The horizontal plane
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The extent is read off local X/Y, and X/Y is the ground plane only when Z is
 * up. A Y-up source keeps its horizontal plane on X/Z, so the same two fields
 * describe one horizontal axis and the elevation axis — and the rectangle that
 * comes out is a vertical slice of the site published as the area covered. It
 * lands on the map looking exactly like a footprint.
 */
describe('footprintUpAxisRefusal', () => {
  it('allows a Z-up frame, which is what the X/Y reading assumes', () => {
    expect(footprintUpAxisRefusal('z')).toBeNull();
  });

  it('refuses a Y-up source rather than outlining its X/Y plane', () => {
    const refusal = footprintUpAxisRefusal('y');
    expect(refusal).toMatch(/Y-up/i);
    expect(refusal).toMatch(/horizontal/i);
  });

  it('refuses an undetermined up-axis: absence of evidence is not Z-up', () => {
    expect(footprintUpAxisRefusal('unknown')).toBeTruthy();
    expect(footprintUpAxisRefusal(null)).toBeTruthy();
    expect(footprintUpAxisRefusal(undefined)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The emitted KML document
// ─────────────────────────────────────────────────────────────────────────────

function footprintKml(over: Partial<Parameters<typeof buildFootprintKml>[0]> = {}): string {
  return buildFootprintKml({
    name: 'quarry-north',
    ring: footprintLonLatRing(footprintRectangleRing(extent), makeLocalToLonLat(utm12, UTM12_ORIGIN)),
    crsName: utm12.name,
    extentBasis: 'the resident points',
    notSurveyGradeNote: NOT_SURVEY_GRADE,
    ...over,
  });
}

describe('buildFootprintKml', () => {
  it('emits well-formed XML', () => {
    expect(() => parseXml(footprintKml())).not.toThrow();
  });

  it('nests the ring the way KML 2.2 requires', () => {
    const doc = parseXml(footprintKml());
    const placemark = find(doc, 'Placemark');
    expect(placemark).not.toBeNull();
    const polygon = find(placemark!, 'Polygon');
    expect(polygon).not.toBeNull();
    const outer = find(polygon!, 'outerBoundaryIs');
    expect(outer).not.toBeNull();
    expect(find(outer!, 'LinearRing')).not.toBeNull();
  });

  it('writes five lon,lat pairs, first repeated as last', () => {
    const coords = find(parseXml(footprintKml()), 'coordinates')!.text.trim().split(/\s+/);
    expect(coords).toHaveLength(5);
    expect(coords[4]).toBe(coords[0]);
    expect(coords[0]).toBe('-111,39.749908');
  });

  it('names the placemark after the scan', () => {
    expect(find(parseXml(footprintKml()), 'name')!.text).toContain('quarry-north');
  });

  it('escapes a hostile scan name instead of breaking the document', () => {
    const kml = footprintKml({ name: 'a<b>&"c"' });
    expect(() => parseXml(kml)).not.toThrow();
    expect(kml).toContain('a&lt;b&gt;&amp;&quot;c&quot;');
  });

  it('carries the CRS and the not-survey-grade caveat', () => {
    const kml = footprintKml();
    expect(kml).toContain('WGS 84 / UTM zone 12N');
    expect(kml).toContain('not survey-grade');
  });

  it('states which points the extent came from', () => {
    expect(footprintKml({ extentBasis: 'the declared header extent' }))
      .toContain('declared header extent');
  });

  it('clamps to ground, since a footprint asserts no elevation', () => {
    expect(footprintKml()).toContain('<altitudeMode>clampToGround</altitudeMode>');
  });

  it('refuses a ring that is not closed', () => {
    const open = footprintLonLatRing(footprintRectangleRing(extent), makeLocalToLonLat(utm12, UTM12_ORIGIN))
      .slice(0, 4);
    expect(() => footprintKml({ ring: open })).toThrow(ScanFootprintError);
  });

  it('refuses a ring with too few corners', () => {
    expect(() => footprintKml({ ring: [[0, 0], [1, 1], [0, 0]] })).toThrow(ScanFootprintError);
  });
});
