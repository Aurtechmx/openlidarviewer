/**
 * pointFrames.test.ts: the frame-naming accessors, and the proof that routing a
 * raw `.positions` read through one changes nothing.
 *
 * The point of the accessors is documentary. They exist so a call site says
 * WHICH coordinate frame it expects, which a bare `cloud.positions` never
 * could. That only holds if adopting one is free, in both senses:
 *
 *   - free at runtime, so a hot path has no reason to route around the label
 *     (asserted here as reference identity, not just equal contents);
 *   - free in behaviour, so every call site this change converted produces the
 *     same numbers it produced before.
 *
 * Reference identity is the strong form. `sourcePositions(cloud) === cloud.positions`
 * means each substitution made in this change is the same expression under a
 * different name, so the conversions cannot have altered a result. The
 * end-to-end cases below then check the converted modules against values
 * computed straight from the raw buffer, so the claim does not rest on the
 * identity argument alone.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { sourcePositions, renderLocalPositions } from '../src/model/pointFrames';
import {
  stridePlacedPositions,
  copyPlacedPositions,
} from '../src/render/measure/lassoVolumeCompute';
import type { LayerSpatialTransform } from '../src/geo/ProjectSpatialFrame';
import { clipCloud } from '../src/render/clip/clipCloud';
import { makeClipBox } from '../src/render/clip/clipBox';
import { cloudToGlobal } from '../src/convert/globalPoints';
import { colorByElevation, colorForMode, rampRangeForMode } from '../src/render/colorModes';

function cloud(origin: [number, number, number] = [1000, 2000, 30]): PointCloud {
  return new PointCloud({
    positions: new Float32Array([
      0, 0, 0,
      1, 2, 3,
      -4, 5, 6.5,
      7.25, -8, 9,
      2, 2, 2,
    ]),
    origin,
    sourceFormat: 'las',
    name: 'frames.las',
  });
}

/** The shape `renderLocalPositions` accepts: a decoded streaming chunk. */
const chunk = (): { positions: Float32Array; pointCount: number } => ({
  positions: new Float32Array([0.5, 1.5, 2.5, 3.5, 4.5, 5.5]),
  pointCount: 2,
});

const placement = (dx: number, dy: number, dz: number): LayerSpatialTransform =>
  ({
    sourceToProject: [dx, dy, dz],
    projectToSource: [-dx, -dy, -dz],
  }) as unknown as LayerSpatialTransform;

describe('pointFrames accessors are free', () => {
  it('sourcePositions returns the SAME buffer, not a copy', () => {
    const c = cloud();
    expect(sourcePositions(c)).toBe(c.positions);
  });

  it('renderLocalPositions returns the SAME buffer, not a copy', () => {
    const d = chunk();
    expect(renderLocalPositions(d)).toBe(d.positions);
  });

  it('does not let a caller observe a different length or content', () => {
    const c = cloud();
    const p = sourcePositions(c);
    expect(p).toHaveLength(15);
    expect([...p]).toEqual([...c.positions]);
  });

  it('pointCount is exactly positions.length / 3', () => {
    // Two call sites in this change swapped `positions.length / 3` for
    // `pointCount` (the lasso candidate count and the Viewer clip counter).
    const c = cloud();
    expect(c.pointCount).toBe(c.positions.length / 3);
    expect(c.pointCount | 0).toBe((c.positions.length / 3) | 0);
  });
});

describe('copyPlacedPositions matches the buffer-level primitive exactly', () => {
  const cases: Array<[string, number, LayerSpatialTransform | null]> = [
    ['identity, no stride', 1, null],
    ['identity, stride 2', 2, null],
    ['placed, no stride', 1, placement(10, -20, 0.5)],
    ['placed, stride 2', 2, placement(10, -20, 0.5)],
    ['zero placement, stride 3', 3, placement(0, 0, 0)],
  ];

  for (const [name, stride, tf] of cases) {
    it(name, () => {
      const c = cloud();
      const viaCloud = copyPlacedPositions(c, stride, tf);
      const viaBuffer = stridePlacedPositions(c.positions, stride, tf);
      expect([...viaCloud]).toEqual([...viaBuffer]);
      expect(viaCloud).toHaveLength(viaBuffer.length);
    });
  }

  it('allocates nothing in the shipped single-layer case', () => {
    // Identity placement at stride 1 must hand back the source buffer itself.
    // A copy here would double the memory of every lasso and class edit.
    const c = cloud();
    expect(copyPlacedPositions(c, 1, null)).toBe(c.positions);
  });

  it('adds the placement exactly once', () => {
    const c = cloud();
    const out = copyPlacedPositions(c, 1, placement(100, 200, 300));
    expect([...out.subarray(0, 3)]).toEqual([100, 200, 300]);
    expect([...out.subarray(3, 6)]).toEqual([101, 202, 303]);
  });
});

describe('converted call sites are unchanged', () => {
  it('clipCloud keeps the same points through the accessor', () => {
    const c = cloud();
    const box = { ...makeClipBox({ min: [-1, -1, -1], max: [3, 3, 3] }), enabled: true };
    const kept = clipCloud(c, box);
    // Inside [-1,3]^3: (0,0,0), (1,2,3) and (2,2,2). The other two are out.
    expect(kept.pointCount).toBe(3);
    expect([...kept.positions]).toEqual([0, 0, 0, 1, 2, 3, 2, 2, 2]);
  });

  it('cloudToGlobal still lifts by sourceOrigin, in Float64', () => {
    const c = cloud([500000, 4000000, 120]);
    const g = cloudToGlobal(c);
    expect(g.count).toBe(5);
    for (let i = 0; i < g.count; i++) {
      expect(g.x[i]).toBeCloseTo(c.positions[i * 3] + 500000, 9);
      expect(g.y[i]).toBeCloseTo(c.positions[i * 3 + 1] + 4000000, 9);
      expect(g.z[i]).toBeCloseTo(c.positions[i * 3 + 2] + 120, 9);
    }
  });

  it('the elevation ramp is byte-identical to the same ramp over the raw buffer', () => {
    const c = cloud();
    const opts = { upAxis: 2 } as const;
    const range = rampRangeForMode('elevation', c, opts);
    expect(range).not.toBeNull();
    const viaAccessor = colorForMode('elevation', c, opts);
    const viaRawBuffer = colorByElevation(
      c.positions,
      c.pointCount,
      range!.min,
      range!.max,
      undefined,
      2,
    );
    expect(viaAccessor).toHaveLength(c.pointCount * 3);
    expect([...viaAccessor]).toEqual([...viaRawBuffer]);
  });
});

describe('the frame allowlist is a usable document', () => {
  const VALID = ['source-local', 'project-local', 'render-local', 'world'];
  const doc = JSON.parse(
    readFileSync(new URL('../docs/validation/position-frames.json', import.meta.url), 'utf8'),
  ) as {
    frames: Record<string, string>;
    entries: Array<{ file: string; symbol: string; frame: string | string[]; reads: number; why: string }>;
  };

  it('defines exactly the four frames the gate accepts', () => {
    expect(Object.keys(doc.frames).sort()).toEqual([...VALID].sort());
  });

  it('names a real frame, and a reason, for every site', () => {
    expect(doc.entries.length).toBeGreaterThan(0);
    for (const e of doc.entries) {
      const named = Array.isArray(e.frame) ? e.frame : [e.frame];
      expect(named.length).toBeGreaterThan(0);
      for (const f of named) expect(VALID).toContain(f);
      // A reason that just repeats the frame name teaches a reviewer nothing.
      expect(e.why.trim().length).toBeGreaterThan(20);
      expect(e.reads).toBeGreaterThan(0);
    }
  });

  it('has one entry per site', () => {
    const keys = doc.entries.map((e) => `${e.file}::${e.symbol}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('agrees with the shrink-only baseline on the total', () => {
    const baseline = JSON.parse(
      readFileSync(new URL('../docs/validation/position-access-baseline.json', import.meta.url), 'utf8'),
    ) as { total: number };
    const classified = doc.entries.reduce((a, e) => a + e.reads, 0);
    expect(classified).toBe(baseline.total);
  });
});
