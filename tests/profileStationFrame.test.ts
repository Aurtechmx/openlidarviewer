import { describe, it, expect } from 'vitest';
import {
  buildProfileFrame,
  projectPointToProfile,
  positionAtProfileChainage,
} from '../src/render/measure/profileGeometry';
import {
  stationsAlongLine,
  slopeGradesPerSegment,
  summariseSlopes,
} from '../src/render/measure/profileStations';
import { sampleProfile } from '../src/render/measure/profileSampler';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { measurementMetrics } from '../src/export/measurementExport';
import type { Measurement, Vec3 } from '../src/render/measure/types';

/**
 * tests/profileStationFrame.test.ts
 *
 * Stationing under an arbitrary scene up axis, and the gap rule the station
 * elevations obey.
 *
 * Chainage is the distance along the projection of the section onto the plane
 * perpendicular to `up`; height is the component along `up`. Reading chainage
 * off X/Y and height off Z is only equivalent when `up` is [0, 0, 1], so every
 * case here uses a non-Z up except where a Z-up control is the point.
 */

const Z_UP: Vec3 = [0, 0, 1];
const Y_UP: Vec3 = [0, 1, 0];
/** Unit, on no axis: [1, 2, 2] / 3. */
const SKEW_UP: Vec3 = [1 / 3, 2 / 3, 2 / 3];

/**
 * Section built on SKEW_UP with exact integer endpoints:
 *   b - a           = [48, -24, 36]
 *   up component    = 24
 *   horizontal part = [40, -40, 20], length 60
 * The XY-only reading is hypot(48, -24) = 53.665..., 10.6 % short of 60.
 */
const SKEW_A: Vec3 = [0, 0, 0];
const SKEW_B: Vec3 = [48, -24, 36];
const SKEW_HORIZONTAL = 60;
const SKEW_VERTICAL = 24;

// Fixed rotation for the metamorphic case: Rodrigues about [1, 1, 1]/sqrt(3)
// by 40 degrees. Deterministic, fixed inputs only.
const RA = 1 / Math.sqrt(3);
const RAXIS: Vec3 = [RA, RA, RA];
const RANGLE = (40 * Math.PI) / 180;
function rotate(v: Vec3): Vec3 {
  const c = Math.cos(RANGLE);
  const s = Math.sin(RANGLE);
  const k = RAXIS;
  const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const cross: Vec3 = [
    k[1] * v[2] - k[2] * v[1],
    k[2] * v[0] - k[0] * v[2],
    k[0] * v[1] - k[1] * v[0],
  ];
  return [
    v[0] * c + cross[0] * s + k[0] * kv * (1 - c),
    v[1] * c + cross[1] * s + k[1] * kv * (1 - c),
    v[2] * c + cross[2] * s + k[2] * kv * (1 - c),
  ];
}

describe('stationsAlongLine: arbitrary up axis', () => {
  it('Y-up: chainage spans the horizontal leg, not the XY diagonal', () => {
    // Run 30 along +Z, rise 40 along the scene up (+Y). The XY reading is
    // hypot(0, 40) = 40, which is the RISE, not the run.
    const stations = stationsAlongLine({
      a: [0, 0, 0],
      b: [0, 40, 30],
      up: Y_UP,
      intervalM: 10,
    });
    expect(stations.map((s) => s.chainage)).toEqual([0, 10, 20, 30]);
    expect(stations.at(-1)!.chainage).toBe(30);
    expect(stations.at(-1)!.chainage).not.toBe(40);
  });

  it('Y-up: heights come off the up axis, so the grade is 40 over 30', () => {
    const stations = stationsAlongLine({
      a: [0, 0, 0],
      b: [0, 40, 30],
      up: Y_UP,
      intervalM: 10,
    });
    const heights = stations.map((s) => s.height!);
    [0, 40 / 3, 80 / 3, 40].forEach((h, i) => expect(heights[i]).toBeCloseTo(h, 9));
    const grades = slopeGradesPerSegment({ stations });
    for (const g of grades) expect(g.gradePercent).toBeCloseTo((100 * 40) / 30, 9);
  });

  it('skew up on no axis: horizontal span and vertical delta match the frame', () => {
    const frame = buildProfileFrame(SKEW_A, SKEW_B, SKEW_UP);
    expect(frame.horizontalLength).toBeCloseTo(SKEW_HORIZONTAL, 9);
    expect(frame.verticalDelta).toBeCloseTo(SKEW_VERTICAL, 9);
    // The XY-only reading a Z-up implementation would produce.
    expect(Math.hypot(SKEW_B[0] - SKEW_A[0], SKEW_B[1] - SKEW_A[1])).toBeCloseTo(53.6656, 3);

    const stations = stationsAlongLine({
      a: SKEW_A,
      b: SKEW_B,
      up: SKEW_UP,
      intervalM: 10,
    });
    const chainages = stations.map((s) => s.chainage);
    expect(chainages.slice(0, 6)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(chainages.at(-1)).toBeCloseTo(SKEW_HORIZONTAL, 9);
  });

  it('includes both endpoints, at the picked coordinates', () => {
    const stations = stationsAlongLine({
      a: SKEW_A,
      b: SKEW_B,
      up: SKEW_UP,
      intervalM: 25,
    });
    expect(stations[0].chainage).toBe(0);
    expect(stations[0].position).toEqual(SKEW_A);
    expect(stations[0].isEndpoint).toBe(false);
    expect(stations.at(-1)!.position).toEqual(SKEW_B);
    expect(stations.at(-1)!.isEndpoint).toBe(true);
    // 60 m at 25 m spacing: 0, 25, 50, then the terminal 60.
    expect(stations.map((s) => s.chainage)).toEqual([0, 25, 50, stations.at(-1)!.chainage]);
    expect(stations.at(-1)!.chainage).toBeCloseTo(60, 9);
  });

  it('returns [] when a and b differ only along up', () => {
    // 100 units apart, entirely along the scene up axis: no horizontal span,
    // so there is no section to station. The XY reading would call this 100 m.
    expect(
      stationsAlongLine({ a: [5, 5, 5], b: [5, 105, 5], up: Y_UP, intervalM: 10 }),
    ).toEqual([]);
    expect(Math.hypot(5 - 5, 105 - 5)).toBe(100);
    // Same section under the skew axis: a and b separated along SKEW_UP only.
    const sa: Vec3 = [1, 1, 1];
    const sb: Vec3 = [1 + 30 / 3, 1 + 60 / 3, 1 + 60 / 3];
    expect(buildProfileFrame(sa, sb, SKEW_UP).horizontalLength).toBeCloseTo(0, 9);
    expect(stationsAlongLine({ a: sa, b: sb, up: SKEW_UP, intervalM: 5 })).toEqual([]);
  });

  it('defaults to Z-up when no up is supplied', () => {
    const withUp = stationsAlongLine({ a: [0, 0, 0], b: [30, 40, 12], up: Z_UP, intervalM: 10 });
    const implied = stationsAlongLine({ a: [0, 0, 0], b: [30, 40, 12], intervalM: 10 });
    expect(implied).toEqual(withUp);
  });

  it('returns [] for a non-finite up', () => {
    expect(
      stationsAlongLine({ a: [0, 0, 0], b: [100, 0, 0], up: [0, Number.NaN, 1], intervalM: 10 }),
    ).toEqual([]);
  });
});

describe('station positions reproject to their own chainages', () => {
  it('every station projects back onto the chainage it advertises', () => {
    const frame = buildProfileFrame(SKEW_A, SKEW_B, SKEW_UP);
    const stations = stationsAlongLine({
      a: SKEW_A,
      b: SKEW_B,
      up: SKEW_UP,
      intervalM: 7,
    });
    expect(stations.length).toBeGreaterThan(5);
    for (const s of stations) {
      const p = projectPointToProfile(frame, s.position);
      expect(p.chainage).toBeCloseTo(s.chainage, 9);
      // A station sits ON the section line, so it has no lateral offset.
      expect(p.lateralOffset).toBeCloseTo(0, 9);
      expect(p.height).toBeCloseTo(s.height!, 9);
    }
  });

  it('positionAtProfileChainage lands on the picked segment', () => {
    const frame = buildProfileFrame(SKEW_A, SKEW_B, SKEW_UP);
    const mid = positionAtProfileChainage(frame, SKEW_HORIZONTAL / 2);
    // Halfway in chainage is halfway along a -> b for a straight section.
    expect(mid[0]).toBeCloseTo(24, 9);
    expect(mid[1]).toBeCloseTo(-12, 9);
    expect(mid[2]).toBeCloseTo(18, 9);
  });
});

describe('station chainages agree with the sampleProfile x-axis', () => {
  it('one cloud point per station lands in the bin at that chainage', () => {
    const stations = stationsAlongLine({
      a: SKEW_A,
      b: SKEW_B,
      up: SKEW_UP,
      intervalM: 10,
    });
    expect(stations).toHaveLength(7);
    const positions = new Float32Array(stations.length * 3);
    stations.forEach((s, i) => {
      positions[i * 3] = s.position[0];
      positions[i * 3 + 1] = s.position[1];
      positions[i * 3 + 2] = s.position[2];
    });
    const out = sampleProfile({
      a: SKEW_A,
      b: SKEW_B,
      up: SKEW_UP,
      positions,
      samples: stations.length,
      bandWidth: 1,
    });
    expect(out).toHaveLength(stations.length);
    out.forEach((bin, i) => {
      expect(bin.count).toBe(1);
      expect(bin.distance).toBeCloseTo(stations[i].chainage, 9);
      expect(bin.height).toBeCloseTo(stations[i].height!, 9);
    });
    // The sampler's last bin sits at the terminal station's chainage.
    expect(out.at(-1)!.distance).toBeCloseTo(stations.at(-1)!.chainage, 9);
  });
});

describe('rigid-rotation metamorphic invariance', () => {
  // Chainage, station count and height are defined by the section and the up
  // axis alone, so rotating points, endpoints and up together must leave them
  // unchanged. Tolerance: 9 decimal places (1e-9 absolute) on quantities of
  // order 10 to 100. A Rodrigues rotation plus a normalisation accumulates
  // roughly 1e-14 absolute at this magnitude, so 1e-9 clears the float noise
  // by five orders while staying far below the error a wrong axis produces
  // (the XY reading is off by 6.3 units on this same section).
  const TOL = 9;

  it('chainages, counts and heights are invariant under a rigid rotation', () => {
    const plain = stationsAlongLine({
      a: SKEW_A,
      b: SKEW_B,
      up: SKEW_UP,
      intervalM: 9,
    });
    const rotated = stationsAlongLine({
      a: rotate(SKEW_A),
      b: rotate(SKEW_B),
      up: rotate(SKEW_UP),
      intervalM: 9,
    });
    expect(rotated).toHaveLength(plain.length);
    plain.forEach((s, i) => {
      expect(rotated[i].chainage).toBeCloseTo(s.chainage, TOL);
      expect(rotated[i].height).toBeCloseTo(s.height!, TOL);
      expect(rotated[i].isEndpoint).toBe(s.isEndpoint);
      // The rotated station is the rotation of the plain one.
      const r = rotate(s.position);
      expect(rotated[i].position[0]).toBeCloseTo(r[0], TOL);
      expect(rotated[i].position[1]).toBeCloseTo(r[1], TOL);
      expect(rotated[i].position[2]).toBeCloseTo(r[2], TOL);
    });
  });

  it('sampled profile heights and distances are invariant under the same rotation', () => {
    const raw: Vec3[] = [
      [4, -2, 7],
      [17, -9, 14],
      [26, -11, 22],
      [39, -20, 29],
      [45, -22, 34],
    ];
    const pack = (pts: Vec3[]): Float32Array => {
      const f = new Float32Array(pts.length * 3);
      pts.forEach((p, i) => {
        f[i * 3] = p[0];
        f[i * 3 + 1] = p[1];
        f[i * 3 + 2] = p[2];
      });
      return f;
    };
    const plain = sampleProfile({
      a: SKEW_A, b: SKEW_B, up: SKEW_UP,
      positions: pack(raw), samples: 8, bandWidth: 12,
    });
    const rotated = sampleProfile({
      a: rotate(SKEW_A), b: rotate(SKEW_B), up: rotate(SKEW_UP),
      positions: pack(raw.map(rotate)), samples: 8, bandWidth: 12,
    });
    expect(rotated).toHaveLength(plain.length);
    plain.forEach((s, i) => {
      expect(rotated[i].count).toBe(s.count);
      expect(rotated[i].distance).toBeCloseTo(s.distance, 6);
      if (Number.isFinite(s.height)) {
        // Float32 storage caps the recoverable precision at ~1e-5 absolute on
        // coordinates of this size, so heights compare at 4 decimal places.
        expect(rotated[i].height).toBeCloseTo(s.height, 4);
      } else {
        expect(rotated[i].height).toBeNaN();
      }
    });
  });
});

describe('report station interval uses the measurementMetrics horizontal length', () => {
  const profileAt = (a: Vec3, b: Vec3): Measurement[] => [
    { id: 'p', kind: 'profile', name: 'Section', points: [a, b] },
  ];

  it('Y-up: the last station label equals the summary Horizontal value', () => {
    // Run 30 along +Z, rise 40 along +Y. Horizontal length is 30; the XY
    // reading is 40.
    const rows = buildMeasurementRows(profileAt([0, 0, 0], [0, 40, 30]), 'metric', 1, Y_UP);
    const extras = rows[0].profileExtras;
    expect(extras).toBeDefined();
    const horizontal = extras!.summary.split(' · ')[0].replace('Horizontal ', '');
    expect(extras!.stations.split(' · ').at(-1)).toBe(horizontal);
    expect(horizontal).toBe('30.000 m');
    // 30 m at the ladder's 5 m rung: 0, 5, 10, 15, 20, 25, 30.
    expect(extras!.stationInterval).toBe('Station interval 5.0000 m (7 stations)');
  });

  it('skew up: the frame length matches measurementMetrics.horizontal_m', () => {
    const m = profileAt(SKEW_A, SKEW_B)[0];
    const mm = measurementMetrics(m, SKEW_UP, 1, 1, 6);
    expect(buildProfileFrame(SKEW_A, SKEW_B, SKEW_UP).horizontalLength).toBeCloseTo(
      mm.horizontal_m,
      6,
    );
    const extras = buildMeasurementRows([m], 'metric', 1, SKEW_UP)[0].profileExtras;
    expect(extras).toBeDefined();
    const horizontal = extras!.summary.split(' · ')[0].replace('Horizontal ', '');
    expect(extras!.stations.split(' · ').at(-1)).toBe(horizontal);
  });
});

describe('elevationAtChainage: gap propagation', () => {
  const LINE_A: Vec3 = [0, 0, 0];
  const LINE_B: Vec3 = [100, 0, 0];
  const stationsAt = (intervalM: number) =>
    stationsAlongLine({ a: LINE_A, b: LINE_B, up: Z_UP, intervalM });

  it('interpolates between two finite brackets', () => {
    const grades = slopeGradesPerSegment({
      stations: stationsAt(50),
      samples: [
        { distance: 0, height: 10 },
        { distance: 100, height: 20 },
      ],
    });
    // The station at chainage 50 reads 15, so both 50 m segments are +10 %.
    expect(grades).toHaveLength(2);
    expect(grades[0].gradePercent).toBeCloseTo(10, 9);
    expect(grades[1].gradePercent).toBeCloseTo(10, 9);
  });

  it('finite then NaN: a station inside the gap is unknown, not the finite bracket', () => {
    const grades = slopeGradesPerSegment({
      stations: stationsAt(50),
      samples: [
        { distance: 0, height: 10 },
        { distance: 100, height: Number.NaN },
      ],
    });
    expect(grades[0].rise).toBeNaN();
    expect(grades[0].gradePercent).toBeNaN();
    expect(grades[1].gradePercent).toBeNaN();
    expect(summariseSlopes(grades).avgGradePercent).toBeNaN();
  });

  it('NaN then finite: the station inside the gap is unknown in that direction too', () => {
    const grades = slopeGradesPerSegment({
      stations: stationsAt(50),
      samples: [
        { distance: 0, height: Number.NaN },
        { distance: 100, height: 20 },
      ],
    });
    expect(grades[0].gradePercent).toBeNaN();
    expect(grades[1].gradePercent).toBeNaN();
  });

  it('an exact finite sample on a gap boundary keeps its value', () => {
    const grades = slopeGradesPerSegment({
      stations: stationsAt(25),
      samples: [
        { distance: 0, height: 5 },
        { distance: 50, height: 7 },
        { distance: 100, height: Number.NaN },
      ],
    });
    // 0 -> 25 -> 50 are covered: 5, 6, 7. Both segments are +4 %.
    expect(grades[0].gradePercent).toBeCloseTo(4, 9);
    expect(grades[1].gradePercent).toBeCloseTo(4, 9);
    // 50 -> 75 crosses into the gap: unknown, not "flat".
    expect(grades[2].gradePercent).toBeNaN();
    expect(grades[3].gradePercent).toBeNaN();
    // The covered part still summarises.
    expect(summariseSlopes(grades).avgGradePercent).toBeCloseTo(4, 9);
  });

  it('report slope summary over a section whose far half has no coverage', () => {
    const m: Measurement = {
      id: 'p',
      kind: 'profile',
      name: 'Section',
      points: [[0, 0, 0], [100, 0, 0]],
      profileChart: [
        { distance: 0, height: 5 },
        { distance: 50, height: 7 },
        { distance: 100, height: Number.NaN },
      ],
    };
    const extras = buildMeasurementRows([m], 'metric', 1, Z_UP)[0].profileExtras;
    expect(extras).toBeDefined();
    // Only the covered half contributes: +4 % throughout, never a 0 % segment
    // manufactured from the last finite sample.
    expect(extras!.slopeSummary).toBe('Max +4.00%, Min +4.00%, Avg +4.00%');
  });
});
