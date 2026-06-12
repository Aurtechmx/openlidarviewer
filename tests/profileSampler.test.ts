/**
 * tests/profileSampler.test.ts
 *
 * Unit coverage for the Profile measurement's height sampler. The geometry
 * half (length, drop, grade) lives in `geometry.ts` and is covered by
 * `measureGeometry.test.ts`; this file pins the chart half so the
 * sampler can ship without churning the measurement record schema.
 */

import { describe, it, expect } from 'vitest';
import {
  sampleProfile,
  summariseProfile,
  autoCorridorWidth,
  normaliseResampleParams,
  encodeSamplerParams,
  decodeSamplerParams,
  MIN_CORRIDOR_HALF_WIDTH_M,
  MAX_CORRIDOR_HALF_WIDTH_M,
  PROFILE_SAMPLE_COUNT_OPTIONS,
} from '../src/render/measure/profileSampler';

const Z_UP: [number, number, number] = [0, 0, 1];

/** Build an interleaved x/y/z Float32Array from a list of [x,y,z] tuples. */
function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

describe('sampleProfile — classified ground filtering', () => {
  it('drops vegetation returns so trees do not pull the floor up', () => {
    // One bin at distance 5: 1 ground return (z=0, class 2) and 9 tree
    // returns (z=10, class 5). Without classification a low percentile is
    // still dominated by the trees; with classification only the ground
    // remains, so the profile sits on bare earth.
    const tuples: Array<[number, number, number]> = [[5, 0, 0]];
    const cls: number[] = [2];
    for (let i = 0; i < 9; i++) { tuples.push([5, 0, 10]); cls.push(5); }
    const positions = pack(tuples);

    const noClass = sampleProfile({ a: [0, 0, 0], b: [10, 0, 0], up: Z_UP, positions, samples: 11, bandWidth: 1 });
    const withClass = sampleProfile({
      a: [0, 0, 0], b: [10, 0, 0], up: Z_UP, positions, samples: 11, bandWidth: 1,
      classification: Uint8Array.from(cls),
    });
    const midNo = noClass.find((s) => Math.abs(s.distance - 5) < 0.6);
    const midYes = withClass.find((s) => Math.abs(s.distance - 5) < 0.6);
    expect(midNo && midNo.height).toBeGreaterThan(5); // trees dominate
    expect(midYes && midYes.height).toBeCloseTo(0, 5); // bare earth
  });
});

describe('sampleProfile — height-vs-distance along a transect', () => {
  it('returns exactly `samples` records ordered by distance', () => {
    const positions = pack([
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 2],
      [3, 0, 3],
    ]);
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [3, 0, 0],
      up: Z_UP,
      positions,
      samples: 4,
    });
    expect(out).toHaveLength(4);
    expect(out[0].distance).toBe(0);
    expect(out[3].distance).toBeCloseTo(3, 6);
    // Strictly increasing distance.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].distance).toBeGreaterThan(out[i - 1].distance);
    }
  });

  it('reads the elevation of the nearest cloud point per bin', () => {
    // Four cloud points planted directly on the transect at evenly spaced
    // ground distances. Each one is the unambiguous nearest point for its
    // bin, so the sampler should return exactly its z.
    const positions = pack([
      [0, 0, 10],
      [1, 0, 12],
      [2, 0, 14],
      [3, 0, 11],
    ]);
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [3, 0, 0],
      up: Z_UP,
      positions,
      samples: 4,
    });
    expect(out[0].height).toBeCloseTo(10, 5);
    expect(out[1].height).toBeCloseTo(12, 5);
    expect(out[2].height).toBeCloseTo(14, 5);
    expect(out[3].height).toBeCloseTo(11, 5);
  });

  it('emits NaN heights for bins with no points inside the band', () => {
    // One point near the start, gap, one point near the end. The middle
    // bins have nothing within the auto band-width → NaN gap.
    const positions = pack([
      [0, 0, 5],
      [10, 0, 8],
    ]);
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions,
      samples: 5,
      bandWidth: 0.2,
    });
    expect(out).toHaveLength(5);
    expect(out[0].height).toBeCloseTo(5, 5);
    expect(out[4].height).toBeCloseTo(8, 5);
    expect(Number.isNaN(out[1].height)).toBe(true);
    expect(Number.isNaN(out[2].height)).toBe(true);
    expect(Number.isNaN(out[3].height)).toBe(true);
  });

  it('measures distance in the horizontal (map) plane, not 3D length', () => {
    // A line that climbs 4m over 3m of horizontal travel. Distance must
    // be 3m (horizontal) — not 5m (the 3D hypotenuse).
    const positions = pack([
      [0, 0, 0],
      [3, 0, 4],
    ]);
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [3, 0, 4],
      up: Z_UP,
      positions,
      samples: 2,
    });
    expect(out[0].distance).toBe(0);
    expect(out[1].distance).toBeCloseTo(3, 5);
  });

  it('returns the same elevation on both ends for a degenerate (a == b) line', () => {
    const positions = pack([[0, 0, 7]]);
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [0, 0, 0],
      up: Z_UP,
      positions,
      samples: 2,
    });
    expect(out).toHaveLength(2);
    expect(out[0].height).toBe(0);
    expect(out[1].height).toBe(0);
  });

  it('clamps the sample count to [2, 512]', () => {
    const positions = pack([
      [0, 0, 1],
      [10, 0, 2],
    ]);
    const tiny = sampleProfile({ a: [0, 0, 0], b: [10, 0, 0], up: Z_UP, positions, samples: 1 });
    expect(tiny).toHaveLength(2);
    const huge = sampleProfile({ a: [0, 0, 0], b: [10, 0, 0], up: Z_UP, positions, samples: 9999 });
    expect(huge).toHaveLength(512);
  });

  it('ignores points outside the perpendicular band width', () => {
    // Two near-line points (band-hit) plus one stray point far off to
    // the side at z=999. The stray must NOT contaminate any bin.
    const positions = pack([
      [0, 0, 1],
      [10, 0, 2],
      [5, 50, 999],
    ]);
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions,
      samples: 3,
      bandWidth: 0.5,
    });
    expect(out[0].height).toBeCloseTo(1, 5);
    // Middle bin sees no points within the band → NaN (the stray is
    // 50 m off-axis, well outside the 0.5 m band).
    expect(Number.isNaN(out[1].height)).toBe(true);
    expect(out[2].height).toBeCloseTo(2, 5);
  });

  it('rejects the high (vegetation) return in favour of bare earth', () => {
    // Two candidates for the middle bin: a ground return at z=10 and a
    // higher (canopy) return at z=20, both inside the corridor. The
    // default bare-earth percentile leans toward the LOWER ground value,
    // not the proximity winner — this is the de-noising contract.
    const positions = pack([
      [5, 0.4, 10], // ground
      [5, 0.0, 20], // canopy / non-ground (higher)
    ]);
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions,
      samples: 3,
      bandWidth: 1,
    });
    // type-7 quantile of [10,20] at p=25 → 12.5; clearly nearer ground.
    expect(out[1].height).toBeLessThan(15);
    expect(Math.abs(out[1].height - 10)).toBeLessThan(Math.abs(out[1].height - 20));
  });

  it('honours an explicit percentile: 0 = floor, 100 = canopy top', () => {
    const positions = pack([
      [5, 0.0, 10],
      [5, 0.1, 14],
      [5, 0.2, 30], // a vegetation spike
    ]);
    const base = { a: [0, 0, 0] as [number, number, number], b: [10, 0, 0] as [number, number, number], up: Z_UP, positions, samples: 3, bandWidth: 1 };
    const floor = sampleProfile({ ...base, groundPercentile: 0 });
    const canopy = sampleProfile({ ...base, groundPercentile: 100 });
    const median = sampleProfile({ ...base, groundPercentile: 50 });
    expect(floor[1].height).toBeCloseTo(10, 5); // strict floor
    expect(canopy[1].height).toBeCloseTo(30, 5); // canopy top
    expect(median[1].height).toBeCloseTo(14, 5); // robust middle, spike rejected
  });

  it('de-noises a spiky corridor: ground dominates over scattered high returns', () => {
    // One bin's corridor: mostly ground near z=5 with a few tall spikes.
    // The default bare-earth percentile should land near the ground, not
    // get dragged up by the spikes (the whole point of the estimator).
    const positions = pack([
      [5, 0.0, 5.0],
      [5, 0.1, 5.1],
      [5, 0.2, 4.9],
      [5, 0.3, 5.05],
      [5, 0.4, 22.0], // spike (tree)
      [5, 0.5, 18.0], // spike (tree)
    ]);
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions,
      samples: 3,
      bandWidth: 1,
    });
    expect(out[1].height).toBeLessThan(6); // sits on the ground, not the canopy
  });
});

describe('summariseProfile — chart card headline strip', () => {
  it('returns NaN fields and zero coverage when every bin is empty', () => {
    const summary = summariseProfile([
      { distance: 0, height: NaN },
      { distance: 1, height: NaN },
    ]);
    expect(Number.isNaN(summary.minHeight)).toBe(true);
    expect(Number.isNaN(summary.maxHeight)).toBe(true);
    expect(Number.isNaN(summary.heightSpan)).toBe(true);
    expect(summary.coverage).toBe(0);
  });

  it('computes min / max / span over the populated bins only', () => {
    const summary = summariseProfile([
      { distance: 0, height: 10 },
      { distance: 1, height: NaN },
      { distance: 2, height: 15 },
      { distance: 3, height: 12 },
    ]);
    expect(summary.minHeight).toBe(10);
    expect(summary.maxHeight).toBe(15);
    expect(summary.heightSpan).toBe(5);
    expect(summary.coverage).toBeCloseTo(0.75, 5);
  });

  it('coverage equals 1 when every bin has a hit', () => {
    const summary = summariseProfile([
      { distance: 0, height: 1 },
      { distance: 1, height: 2 },
      { distance: 2, height: 3 },
    ]);
    expect(summary.coverage).toBe(1);
  });
});

describe('sampleProfile — per-bin evidence counts (v0.4.5)', () => {
  it('emits the corridor point count behind each bin, 0 for a gap', () => {
    // Three points stack on the bin at distance 0; the far bin sees none.
    const positions = pack([
      [0, 0, 1],
      [0, 0.2, 2],
      [0, -0.2, 3],
    ]);
    const out = sampleProfile({
      a: [0, 0, 0],
      b: [10, 0, 0],
      up: Z_UP,
      positions,
      samples: 2,
      bandWidth: 1,
    });
    expect(out[0].count).toBe(3);
    expect(out[1].count).toBe(0);
    expect(Number.isNaN(out[1].height)).toBe(true);
  });
});

describe('autoCorridorWidth (v0.4.5, B4 provenance)', () => {
  it('is 5 % of the HORIZONTAL length — the vertical leg never widens the band', () => {
    // a → b spans (30, 40) in plan = 50 m horizontal; the 12 m climb is
    // along up and must not contribute. 50 × 0.05 = 2.5.
    expect(autoCorridorWidth([0, 0, 0], [30, 40, 12], Z_UP)).toBeCloseTo(2.5, 12);
  });

  it('projects out whichever axis is up', () => {
    // Y-up: the horizontal plane is XZ, so the span is hypot(30, 12).
    expect(
      autoCorridorWidth([0, 0, 0], [30, 40, 12], [0, 1, 0]),
    ).toBeCloseTo(Math.hypot(30, 12) * 0.05, 12);
  });

  it('degenerate line (a = b) yields a zero-width corridor', () => {
    expect(autoCorridorWidth([3, 4, 5], [3, 4, 5], Z_UP)).toBe(0);
  });

  it('passing it explicitly reproduces the bandWidth:null auto result exactly', () => {
    // The Viewer now computes the corridor first (to stamp provenance) and
    // hands it to the sampler; this pins that the explicit value IS the
    // auto value, so the stamped number is honest.
    const positions = pack([
      [1, 0.1, 5],
      [5, -0.2, 7],
      [9, 0.3, 6],
    ]);
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [10, 0, 0];
    const auto = sampleProfile({ a, b, up: Z_UP, positions, samples: 8 });
    const explicit = sampleProfile({
      a, b, up: Z_UP, positions, samples: 8,
      bandWidth: autoCorridorWidth(a, b, Z_UP),
    });
    expect(explicit).toEqual(auto);
  });
});

describe('normaliseResampleParams — the B7/B8 panel→sampler seam (hand-computed)', () => {
  it('passes in-range values through, converting metres → render units', () => {
    // Metric scan (factor 1): the metre value IS the render value.
    expect(normaliseResampleParams({ corridorWidthM: 2.5 }, 1)).toEqual({
      corridorWidth: 2.5,
      groundPercentile: null,
      sampleCount: null,
    });
    // Foot-CRS scan (factor 0.3048): a 3.048 m corridor is 10 render feet —
    // the exact inverse of the B2 summary scaling.
    expect(
      normaliseResampleParams({ corridorWidthM: 3.048 }, 0.3048).corridorWidth,
    ).toBeCloseTo(10, 12);
  });

  it('clamps the corridor to the shared bounds BEFORE unit conversion', () => {
    // 0.001 m clamps up to the 0.05 m floor; 9 999 m clamps down to 500 m.
    expect(normaliseResampleParams({ corridorWidthM: 0.001 }, 1).corridorWidth).toBe(
      MIN_CORRIDOR_HALF_WIDTH_M,
    );
    expect(normaliseResampleParams({ corridorWidthM: 9999 }, 1).corridorWidth).toBe(
      MAX_CORRIDOR_HALF_WIDTH_M,
    );
    // Clamp happens in metres: floor 0.05 m on a foot scan = 0.05/0.3048 render ft.
    expect(
      normaliseResampleParams({ corridorWidthM: 0.001 }, 0.3048).corridorWidth,
    ).toBeCloseTo(MIN_CORRIDOR_HALF_WIDTH_M / 0.3048, 12);
  });

  it('clamps the percentile to 0..100 and rounds the sample count', () => {
    expect(normaliseResampleParams({ groundPercentile: -5 }, 1).groundPercentile).toBe(0);
    expect(normaliseResampleParams({ groundPercentile: 120 }, 1).groundPercentile).toBe(100);
    expect(normaliseResampleParams({ groundPercentile: 50 }, 1).groundPercentile).toBe(50);
    expect(normaliseResampleParams({ sampleCount: 33.4 }, 1).sampleCount).toBe(33);
  });

  it('null / non-finite fields stay null ("use the default"), bad factors fall back to 1', () => {
    expect(normaliseResampleParams({}, 1)).toEqual({
      corridorWidth: null,
      groundPercentile: null,
      sampleCount: null,
    });
    expect(
      normaliseResampleParams({ corridorWidthM: Number.NaN, sampleCount: null }, 1)
        .corridorWidth,
    ).toBeNull();
    // A zero/garbage unit factor must not divide the corridor to Infinity —
    // mislabelled-as-metres (factor 1) is the documented fallback.
    expect(normaliseResampleParams({ corridorWidthM: 2 }, 0).corridorWidth).toBe(2);
  });

  it('every panel sample-count option survives the sampler clamp unchanged', () => {
    // Hand-checked against MIN/MAX_SAMPLES (2..512): a profile resampled at
    // any offered option must come back with exactly that many bins.
    const positions = pack([[5, 0, 3]]);
    for (const n of PROFILE_SAMPLE_COUNT_OPTIONS) {
      const out = sampleProfile({
        a: [0, 0, 0],
        b: [10, 0, 0],
        up: Z_UP,
        positions,
        samples: n,
      });
      expect(out.length).toBe(n);
    }
  });
});

describe('encode/decodeSamplerParams — the B7/B8 persistence seam', () => {
  it('round-trips a full preference record', () => {
    const enc = encodeSamplerParams({ corridorWidthM: 2.5, groundPercentile: 50, sampleCount: 128 });
    expect(decodeSamplerParams(enc)).toEqual({
      corridorWidthM: 2.5,
      groundPercentile: 50,
      sampleCount: 128,
    });
  });

  it('round-trips a partial record (unset fields stay null = "default")', () => {
    const enc = encodeSamplerParams({ sampleCount: 256 });
    expect(decodeSamplerParams(enc)).toEqual({
      corridorWidthM: null,
      groundPercentile: null,
      sampleCount: 256,
    });
  });

  it('a Reset (all nulls) decodes to null — "no stored preference"', () => {
    const enc = encodeSamplerParams({
      corridorWidthM: null,
      groundPercentile: null,
      sampleCount: null,
    });
    expect(decodeSamplerParams(enc)).toBeNull();
  });

  it('encode normalises non-finite values to null rather than persisting them', () => {
    const enc = encodeSamplerParams({ corridorWidthM: Number.NaN, groundPercentile: Infinity });
    expect(decodeSamplerParams(enc)).toBeNull();
  });

  it('decode refuses garbage: absent storage, bad JSON, wrong shapes, wrong types', () => {
    expect(decodeSamplerParams(null)).toBeNull();
    expect(decodeSamplerParams('not json {')).toBeNull();
    expect(decodeSamplerParams('"a string"')).toBeNull();
    expect(decodeSamplerParams('[1,2,3]')).toBeNull();
    expect(decodeSamplerParams('null')).toBeNull();
    // A hand-edited string value drops to null instead of poisoning the
    // sampler; the surviving numeric field still applies.
    expect(decodeSamplerParams('{"corridorWidthM":"wide","sampleCount":64}')).toEqual({
      corridorWidthM: null,
      groundPercentile: null,
      sampleCount: 64,
    });
  });

  it('out-of-range persisted values degrade via the SAME clamp the panel uses', () => {
    // decode leaves the value as stored; normaliseResampleParams clamps at
    // the point of use — one rule for live edits and reloads alike.
    const decoded = decodeSamplerParams(encodeSamplerParams({ corridorWidthM: 9999 }))!;
    expect(decoded.corridorWidthM).toBe(9999);
    expect(normaliseResampleParams(decoded, 1).corridorWidth).toBe(MAX_CORRIDOR_HALF_WIDTH_M);
  });
});
