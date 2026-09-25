/**
 * profileWithheld.test.ts
 *
 * Profiles leave points carrying the LAS Withheld flag out of what they read,
 * keep Overlap points, and record points read, Withheld excluded and points
 * analysed. A source with no flags channel is read whole and its exclusion
 * count is 'unknown', never 0.
 */
import { describe, it, expect } from 'vitest';
import {
  createProfileSectionSeam,
  type ProfileSeamLayer,
  type ProfileSectionSeamDeps,
} from '../src/render/measure/profileSectionSeam';
import {
  dropWithheld,
  PROFILE_SERIES_METHOD_TAG,
} from '../src/render/measure/profileSampler';
import { extractProfileSection } from '../src/render/measure/profileSectionExtract';
import { buildProfileFrame } from '../src/render/measure/profileGeometry';
import { encodeExtendedClassificationFlags } from '../src/lasSemantics';
import {
  alignedFlags,
  describeWithheldRead,
  withheldReadCounts,
} from '../src/science/withheldCounts';
import { parseWithheldReadCounts } from '../src/io/withheldCountsJson';
import { methodRef, methodTag } from '../src/science/methodRegistry';
import type { Vec3 } from '../src/render/measure/types';

const UP: Vec3 = [0, 0, 1];
const A: Vec3 = [0, 0, 0];
const B: Vec3 = [10, 0, 0];
const W = encodeExtendedClassificationFlags({ withheld: true });
const O = encodeExtendedClassificationFlags({ overlap: true });
const WO = encodeExtendedClassificationFlags({ withheld: true, overlap: true });

/**
 * Five points in one corridor bin near chainage 5:
 *   ground z=1, ground z=2, Overlap z=3, Withheld z=90, Withheld+Overlap z=80.
 */
const POINTS = [5, 0, 1, 5.01, 0, 2, 5.02, 0, 3, 5.03, 0, 90, 5.04, 0, 80];
const FLAGS = [0, 0, O, W, WO];

function layer(id: string, flags: number[] | null, points = POINTS): ProfileSeamLayer {
  return {
    id,
    mesh: { visible: true },
    positions: new Float32Array(points),
    channels: flags ? { classificationFlags: new Uint8Array(flags) } : null,
    bounds: null,
    placement: null,
  };
}

function deps(layers: ProfileSeamLayer[]): ProfileSectionSeamDeps {
  return {
    layers: () => layers,
    residentNodes: () => [],
    streamingMayCombine: () => false,
    worldUp: () => UP,
    streamingCoverage: () => null,
  };
}

/** The height of the one covered bin at the top percentile. */
function topHeight(seam: ReturnType<typeof createProfileSectionSeam>): number {
  const r = seam.sampleSeries(A, B, { corridorWidth: 1, groundPercentile: 100, sampleCount: 2 })!;
  const covered = r.samples.filter((s) => Number.isFinite(s.height));
  expect(covered).toHaveLength(1);
  return covered[0]!.height;
}

describe('profile series — Withheld excluded, Overlap kept', () => {
  it('drops both Withheld points and keeps the Overlap one', () => {
    const seam = createProfileSectionSeam(deps([layer('a', FLAGS)]));
    // p100 of {1,2,3} is the Overlap point; with Withheld read it would be 90.
    expect(topHeight(seam)).toBeCloseTo(3, 5);
    const r = seam.sampleSeries(A, B, { corridorWidth: 1 })!;
    expect(r.withheld).toEqual({ sourcePoints: 5, withheldExcluded: 2, analysedPoints: 3 });
    expect(r.method).toBe(PROFILE_SERIES_METHOD_TAG);
  });

  it("reads every point and records 'unknown' when the source has no flags", () => {
    const seam = createProfileSectionSeam(deps([layer('a', null)]));
    expect(topHeight(seam)).toBeCloseTo(90, 5);
    expect(seam.sampleSeries(A, B, { corridorWidth: 1 })!.withheld).toEqual({
      sourcePoints: 5,
      withheldExcluded: 'unknown',
      analysedPoints: 5,
    });
  });

  it("treats a misaligned flags channel as absent, so the count is 'unknown'", () => {
    const seam = createProfileSectionSeam(deps([layer('a', [W, W])]));
    expect(seam.sampleSeries(A, B, { corridorWidth: 1 })!.withheld.withheldExcluded).toBe('unknown');
  });

  it("still excludes on the flagged source when another source has no flags", () => {
    const flagged = layer('a', FLAGS);
    const bare = layer('b', null, [5.05, 0, 1.5]);
    const r = createProfileSectionSeam(deps([flagged, bare])).sampleSeries(A, B, {
      corridorWidth: 1,
      groundPercentile: 100,
      sampleCount: 2,
    })!;
    expect(r.withheld).toEqual({ sourcePoints: 6, withheldExcluded: 'unknown', analysedPoints: 4 });
    expect(r.samples.find((s) => Number.isFinite(s.height))!.height).toBeCloseTo(3, 5);
  });

  it('matches the pre-exclusion series exactly when no point is Withheld', () => {
    const clean = [0, 0, O, 0, O];
    const flagged = createProfileSectionSeam(deps([layer('a', clean)])).sampleSeries(A, B)!;
    const bare = createProfileSectionSeam(deps([layer('a', null)])).sampleSeries(A, B)!;
    expect(flagged.samples).toEqual(bare.samples);
    expect(flagged.withheld).toEqual({ sourcePoints: 5, withheldExcluded: 0, analysedPoints: 5 });
  });
});

describe('profile section — Withheld excluded, identity kept', () => {
  it('skips Withheld returns, keeps Overlap, and keeps source indices', () => {
    const seam = createProfileSectionSeam(deps([layer('a', FLAGS)]));
    const s = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(Array.from(s.points.pointIndex)).toEqual([0, 1, 2]);
    expect(Array.from(s.points.height)).toEqual([1, 2, 3]);
    expect(s.withheld).toEqual({ sourcePoints: 5, withheldExcluded: 2, analysedPoints: 3 });
  });

  it("records 'unknown' for a source without flags", () => {
    const s = createProfileSectionSeam(deps([layer('a', null)])).section({
      a: A,
      b: B,
      corridorWidth: 1,
    })!;
    expect(s.points.count).toBe(5);
    expect(s.withheld.withheldExcluded).toBe('unknown');
  });

  it('counts Withheld over the examined points, not the skipped sources', () => {
    const frame = buildProfileFrame(A, B, UP);
    const pos = new Float32Array(POINTS);
    const r = extractProfileSection({
      frame,
      band: 1,
      sources: [
        {
          slot: 0,
          pointCount: 5,
          channels: { classificationFlags: new Uint8Array(FLAGS) },
          bounds: null,
          readProjectXYZ(i, out) {
            out[0] = pos[i * 3]!;
            out[1] = pos[i * 3 + 1]!;
            out[2] = pos[i * 3 + 2]!;
          },
        },
      ],
    });
    expect(r.examined).toBe(5);
    expect(r.withheldExcluded).toBe(2);
    expect(r.everySourceFlagged).toBe(true);
  });
});

describe('Withheld accounting helpers', () => {
  it('dropWithheld returns the same buffer when nothing is Withheld', () => {
    const buf = { pos: new Float32Array(POINTS) };
    const r = dropWithheld(buf, [0, O, 0, O, 0]);
    expect(r.buffer).toBe(buf);
    expect(r.excluded).toBe(0);
  });

  it('dropWithheld keeps classification aligned to the kept points', () => {
    const r = dropWithheld(
      { pos: new Float32Array(POINTS), cls: [2, 2, 2, 7, 7] },
      FLAGS,
    );
    expect(r.excluded).toBe(2);
    expect(Array.from(r.buffer.cls!)).toEqual([2, 2, 2]);
    expect(Array.from(r.buffer.pos)).toEqual(Array.from(new Float32Array(POINTS.slice(0, 9))));
  });

  it('alignedFlags rejects a channel of the wrong length', () => {
    expect(alignedFlags([0, 0], 3)).toBeUndefined();
    expect(alignedFlags(null, 0)).toBeUndefined();
    expect(alignedFlags([0, 0, 0], 3)).toEqual([0, 0, 0]);
  });

  it("never reports 0 when flags were missing", () => {
    expect(withheldReadCounts(10, 0, false).withheldExcluded).toBe('unknown');
    expect(describeWithheldRead(withheldReadCounts(10, 0, false))).toContain('unknown');
    expect(describeWithheldRead(withheldReadCounts(10, 2, true))).toBe(
      '8 of 10 analysed; Withheld excluded: 2',
    );
  });

  it('parses a stored record and refuses one that does not add up', () => {
    expect(parseWithheldReadCounts({ sourcePoints: 5, withheldExcluded: 2, analysedPoints: 3 })).toEqual({
      sourcePoints: 5,
      withheldExcluded: 2,
      analysedPoints: 3,
    });
    expect(
      parseWithheldReadCounts({ sourcePoints: 5, withheldExcluded: 'unknown', analysedPoints: 5 }),
    ).toEqual({ sourcePoints: 5, withheldExcluded: 'unknown', analysedPoints: 5 });
    expect(parseWithheldReadCounts({ sourcePoints: 5, withheldExcluded: 1, analysedPoints: 3 })).toBeNull();
    expect(parseWithheldReadCounts({ sourcePoints: 5, withheldExcluded: 0, analysedPoints: 6 })).toBeNull();
    expect(parseWithheldReadCounts('x')).toBeNull();
  });

  it('stamps the registered method version', () => {
    expect(PROFILE_SERIES_METHOD_TAG).toBe(methodTag(methodRef('olv.profile.corridor-percentile')));
  });
});
