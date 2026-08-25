/**
 * profileSectionSeam.test.ts
 *
 * The seam that serves both profile products from one read of the scene.
 *
 * Each block below is written against a specific way the seam could be wrong
 * rather than against its happy path: take every cloud instead of the
 * eligible ones, read resident nodes in the order they arrived, let a stale
 * extraction land, drop the placement, or call a streaming snapshot a full
 * static source. A test that only asserts the correct answer on a clean
 * scene passes under all five.
 */
import { describe, it, expect } from 'vitest';
import {
  createProfileSectionSeam,
  type ProfileSeamLayer,
  type ProfileSeamResidentNode,
  type ProfileSectionSeamDeps,
} from '../src/render/measure/profileSectionSeam';
import { profileSectionHas } from '../src/render/measure/profileSectionBuilder';
import type { Vec3 } from '../src/render/measure/types';
import type { LayerCompatibility } from '../src/model/layerCompatibility';

const UP: Vec3 = [0, 0, 1];
const A: Vec3 = [0, 0, 0];
const B: Vec3 = [10, 0, 0];

interface LayerSpec {
  id: string;
  points: number[];
  visible?: boolean;
  locked?: boolean;
  mounted?: boolean;
  compatibility?: LayerCompatibility;
  offset?: [number, number, number];
  classification?: number[];
}

function layer(spec: LayerSpec): ProfileSeamLayer {
  return {
    id: spec.id,
    mesh: { visible: spec.visible ?? true },
    locked: spec.locked,
    mounted: spec.mounted,
    compatibility: spec.compatibility,
    positions: new Float32Array(spec.points),
    channels: spec.classification
      ? { classification: new Uint8Array(spec.classification) }
      : null,
    bounds: null,
    placement: spec.offset
      ? {
          sourceOrigin: spec.offset,
          sourceToProject: spec.offset,
          projectToSource: [-spec.offset[0], -spec.offset[1], -spec.offset[2]],
        }
      : null,
  };
}

function node(key: string, points: number[]): ProfileSeamResidentNode {
  return { key, positions: new Float32Array(points), channels: null };
}

function deps(over: Partial<ProfileSectionSeamDeps> = {}): ProfileSectionSeamDeps {
  return {
    layers: () => [],
    residentNodes: () => [],
    streamingMayCombine: () => false,
    worldUp: () => UP,
    streamingCoverage: () => null,
    ...over,
  };
}

/** Chainages in the order the seam emitted them. */
const chainages = (a: Float32Array): number[] => Array.from(a);

describe('profile section seam — eligibility is decided once', () => {
  it('leaves a hidden layer out of the section and out of the series alike', () => {
    const shown = layer({ id: 'shown', points: [2, 0, 5] });
    const hidden = layer({ id: 'hidden', points: [4, 0, 90], visible: false });

    const both = createProfileSectionSeam(deps({ layers: () => [shown, hidden] }));
    const alone = createProfileSectionSeam(deps({ layers: () => [shown] }));

    const section = both.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.points.count).toBe(1);
    expect(section.sources.map((s) => s.id)).toEqual(['shown']);
    expect(Array.from(section.points.height)).toEqual([5]);

    // The derived series must reach the same verdict, or the chart and the
    // returns under it describe different scenes.
    const seriesBoth = both.sampleSeries(A, B, { corridorWidth: 1 })!;
    const seriesAlone = alone.sampleSeries(A, B, { corridorWidth: 1 })!;
    expect(seriesBoth.samples).toEqual(seriesAlone.samples);
    // The hidden layer sits 85 m above the visible one; taking it would move
    // every covered bin.
    expect(seriesBoth.samples.some((s) => s.height === 90)).toBe(false);
  });

  it('leaves a locked layer out', () => {
    const shown = layer({ id: 'shown', points: [2, 0, 5] });
    const locked = layer({ id: 'locked', points: [4, 0, 90], locked: true });
    const seam = createProfileSectionSeam(deps({ layers: () => [shown, locked] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.sources.map((s) => s.id)).toEqual(['shown']);
  });

  it('leaves an unmounted layer out once layers would be combined', () => {
    const mounted = layer({ id: 'mounted', points: [2, 0, 5] });
    const adrift = layer({ id: 'adrift', points: [4, 0, 6], mounted: false });
    const seam = createProfileSectionSeam(deps({ layers: () => [mounted, adrift] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.sources.map((s) => s.id)).toEqual(['mounted']);
    expect(section.points.count).toBe(1);
  });

  it('analyses a lone layer in its own frame, mounted or not', () => {
    const only = layer({ id: 'only', points: [2, 0, 5], mounted: false });
    const seam = createProfileSectionSeam(deps({ layers: () => [only] }));
    expect(seam.section({ a: A, b: B, corridorWidth: 1 })!.points.count).toBe(1);
  });

  it('refuses resident nodes on the terms the host states', () => {
    const nodes = [node('0-0-0-0', [2, 0, 7])];
    const refused = createProfileSectionSeam(
      deps({ residentNodes: () => nodes, streamingMayCombine: () => false }),
    );
    const admitted = createProfileSectionSeam(
      deps({ residentNodes: () => nodes, streamingMayCombine: () => true }),
    );
    expect(refused.section({ a: A, b: B, corridorWidth: 1 })!.points.count).toBe(0);
    expect(admitted.section({ a: A, b: B, corridorWidth: 1 })!.points.count).toBe(1);
    expect(refused.sampleSeries(A, B, { corridorWidth: 1 })).toBeNull();
    expect(admitted.sampleSeries(A, B, { corridorWidth: 1 })).not.toBeNull();
  });
});

describe('profile section seam — resident nodes read in key order', () => {
  // Offered in an order no sort would produce by accident: depth 2 first, a
  // string compare would put depth 10 before depth 2, and arrival order is
  // what the map would hand back.
  const offered = [
    node('2-1-0-0', [3, 0, 30]),
    node('10-0-0-0', [5, 0, 100]),
    node('1-0-0-0', [1, 0, 10]),
  ];

  it('orders by depth then x, y, z, not by arrival and not as text', () => {
    const seam = createProfileSectionSeam(
      deps({ residentNodes: () => offered, streamingMayCombine: () => true }),
    );
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.sources.map((s) => s.id)).toEqual(['1-0-0-0', '2-1-0-0', '10-0-0-0']);
    // The returns follow the slots, so the point order is fixed too.
    expect(Array.from(section.points.height)).toEqual([10, 30, 100]);
    expect(Array.from(section.points.sourceSlot)).toEqual([0, 1, 2]);
    // Arrival order and a text sort both differ from the answer above, so
    // this cannot pass by reading the map as it comes.
    expect(offered.map((n) => n.key)).not.toEqual(['1-0-0-0', '2-1-0-0', '10-0-0-0']);
    expect([...offered.map((n) => n.key)].sort()).not.toEqual([
      '1-0-0-0',
      '2-1-0-0',
      '10-0-0-0',
    ]);
  });

  it('gives the same order whichever order the host offers them in', () => {
    const forwards = createProfileSectionSeam(
      deps({ residentNodes: () => offered, streamingMayCombine: () => true }),
    );
    const backwards = createProfileSectionSeam(
      deps({ residentNodes: () => [...offered].reverse(), streamingMayCombine: () => true }),
    );
    expect(forwards.section({ a: A, b: B, corridorWidth: 1 })!.sources).toEqual(
      backwards.section({ a: A, b: B, corridorWidth: 1 })!.sources,
    );
  });

  it('reports the same series whichever order the host offers them in', () => {
    const forwards = createProfileSectionSeam(
      deps({ residentNodes: () => offered, streamingMayCombine: () => true }),
    );
    const backwards = createProfileSectionSeam(
      deps({ residentNodes: () => [...offered].reverse(), streamingMayCombine: () => true }),
    );
    expect(forwards.sampleSeries(A, B, { corridorWidth: 1 })).toEqual(
      backwards.sampleSeries(A, B, { corridorWidth: 1 }),
    );
  });
});

describe('profile section seam — a stale extraction never lands', () => {
  const seamWith = () =>
    createProfileSectionSeam(
      deps({ layers: () => [layer({ id: 'one', points: [1, 0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4] })] }),
    );

  it('discards a walk a newer request overtook', () => {
    const seam = seamWith();
    const slow = seam.sectionChunks({ a: A, b: B, corridorWidth: 1, chunkSize: 1 });
    expect(slow.next().done).toBe(false); // the slow walk has started

    const fresh = seam.section({ a: A, b: B, corridorWidth: 1 });
    expect(fresh).not.toBeNull();
    expect(fresh!.generation).toBe(2);

    let step = slow.next();
    while (!step.done) step = slow.next();
    expect(step.value).toBeNull();
  });

  it('keeps a walk nothing overtook', () => {
    const seam = seamWith();
    const only = seam.sectionChunks({ a: A, b: B, corridorWidth: 1, chunkSize: 1 });
    let step = only.next();
    while (!step.done) step = only.next();
    expect(step.value).not.toBeNull();
    expect(step.value!.generation).toBe(1);
    expect(step.value!.points.count).toBe(4);
  });

  it('refuses every result once abandoned', () => {
    const seam = seamWith();
    seam.abandon();
    expect(seam.section({ a: A, b: B, corridorWidth: 1 })).toBeNull();
  });
});

describe('profile section seam — the placement is part of the read', () => {
  it('reads a laterally placed layer where the placement puts it', () => {
    const here = layer({ id: 'here', points: [2, 0, 5] });
    const shifted = layer({ id: 'shifted', points: [2, 0, 5], offset: [0, 50, 0] });

    const seamHere = createProfileSectionSeam(deps({ layers: () => [here] }));
    const seamShifted = createProfileSectionSeam(deps({ layers: () => [shifted] }));

    expect(seamHere.section({ a: A, b: B, corridorWidth: 1 })!.points.count).toBe(1);
    // Same source buffer, 50 m off the corridor once placed. Reading the raw
    // buffer would accept it.
    expect(seamShifted.section({ a: A, b: B, corridorWidth: 1 })!.points.count).toBe(0);
  });

  it('carries the placement into chainage and lateral offset', () => {
    const shifted = layer({ id: 'shifted', points: [0, 0, 5], offset: [3, 0.25, 0] });
    const seam = createProfileSectionSeam(deps({ layers: () => [shifted] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.points.count).toBe(1);
    expect(chainages(section.points.chainage)[0]).toBeCloseTo(3, 12);
    expect(Math.abs(section.points.lateralOffset[0]!)).toBeCloseTo(0.25, 6);
  });

  it('resolves height in float64, which a float32 read would round away', () => {
    // 1e7 + 0.5: float32 spacing at 1e7 is 1, so a float32 intermediate
    // cannot hold the half metre.
    const far = layer({ id: 'far', points: [2, 0, 0.5], offset: [0, 0, 1e7] });
    const seam = createProfileSectionSeam(deps({ layers: () => [far] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.points.height[0]).toBe(10000000.5);
    expect(Math.fround(10000000.5)).not.toBe(10000000.5);
  });

  it('neither writes nor copies the source buffer', () => {
    const source = new Float32Array([2, 0, 5, 4, 0, 6]);
    const before = Float32Array.from(source);
    const held: ProfileSeamLayer = {
      id: 'held',
      mesh: { visible: true },
      positions: source,
      channels: null,
      bounds: null,
      placement: {
        sourceOrigin: [1, 0, 0],
        sourceToProject: [1, 0, 0],
        projectToSource: [-1, 0, 0],
      },
    };
    const seam = createProfileSectionSeam(deps({ layers: () => [held] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.points.count).toBe(2);
    expect(Array.from(source)).toEqual(Array.from(before));
    // The section's own arrays are sized to the accepted returns, not to the
    // source, and share no storage with it.
    expect(section.points.height.buffer).not.toBe(source.buffer);
  });
});

describe('profile section seam — the scope says where the returns came from', () => {
  const statics = () => [layer({ id: 'static', points: [2, 0, 5] })];
  const residents = () => [node('0-0-0-0', [4, 0, 6])];

  it('calls a static-only read a full static source', () => {
    const seam = createProfileSectionSeam(deps({ layers: statics }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.scope).toBe('full-static-source');
    expect(section.scopeLabel).toBe('Full static source');
    expect(section.streamingComplete).toBeNull();
  });

  it('never calls a streaming read a full static source', () => {
    const seam = createProfileSectionSeam(
      deps({ residentNodes: residents, streamingMayCombine: () => true }),
    );
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.scope).toBe('resident-snapshot');
    expect(section.scope).not.toBe('full-static-source');
    expect(section.scopeLabel).toBe('Resident snapshot, coverage unknown');
  });

  it('says snapshot for a mixed read, not full static', () => {
    const seam = createProfileSectionSeam(
      deps({ layers: statics, residentNodes: residents, streamingMayCombine: () => true }),
    );
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.scope).toBe('mixed-full-and-resident');
    expect(section.scopeLabel).toBe('Mixed static and resident streaming snapshot');
  });

  it('separates an unknown node count from an incomplete one', () => {
    const unknown = createProfileSectionSeam(
      deps({
        residentNodes: residents,
        streamingMayCombine: () => true,
        streamingCoverage: () => ({ knownNodeCount: null, residentNodeCount: 1 }),
      }),
    );
    const partial = createProfileSectionSeam(
      deps({
        residentNodes: residents,
        streamingMayCombine: () => true,
        streamingCoverage: () => ({ knownNodeCount: 8, residentNodeCount: 1 }),
      }),
    );
    const whole = createProfileSectionSeam(
      deps({
        residentNodes: residents,
        streamingMayCombine: () => true,
        streamingCoverage: () => ({ knownNodeCount: 1, residentNodeCount: 1 }),
      }),
    );
    expect(unknown.section({ a: A, b: B, corridorWidth: 1 })!.streamingComplete).toBeNull();
    expect(partial.section({ a: A, b: B, corridorWidth: 1 })!.streamingComplete).toBe(false);
    expect(whole.section({ a: A, b: B, corridorWidth: 1 })!.streamingComplete).toBe(true);
    // Even fully resident, the scope stays a snapshot: it describes where the
    // returns came from, not how much of the transfer finished.
    expect(whole.section({ a: A, b: B, corridorWidth: 1 })!.scope).toBe('resident-snapshot');
  });
});

describe('profile section seam — the two products walk one corridor', () => {
  it('takes the same auto width the series takes', () => {
    const only = layer({ id: 'only', points: [5, 0.4, 5, 5, 0.6, 9] });
    const seam = createProfileSectionSeam(deps({ layers: () => [only] }));
    const series = seam.sampleSeries(A, B)!;
    // 5 % of a 10 m section.
    expect(series.corridorWidth).toBeCloseTo(0.5, 12);
    const section = seam.section({ a: A, b: B })!;
    expect(section.band).toBeCloseTo(series.corridorWidth, 12);
    // 0.4 is inside the auto corridor and 0.6 is outside it.
    expect(section.points.count).toBe(1);
  });

  it('returns null series when nothing is loaded, and an empty section', () => {
    const seam = createProfileSectionSeam(deps());
    expect(seam.sampleSeries(A, B)).toBeNull();
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.points.count).toBe(0);
    expect(section.scope).toBe('empty');
  });

  it('keeps a channel only where its source carried one', () => {
    const classed = layer({ id: 'classed', points: [2, 0, 5], classification: [2] });
    const bare = layer({ id: 'bare', points: [4, 0, 6] });
    const seam = createProfileSectionSeam(deps({ layers: () => [classed, bare] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.points.count).toBe(2);
    expect(profileSectionHas(section.points, 0, 'classification')).toBe(true);
    expect(profileSectionHas(section.points, 1, 'classification')).toBe(false);
  });

  // The exclusion policy can only act on a source that classifies. "Every",
  // not "any": one bare source means part of the read reached the percentile
  // unfiltered, and a header claiming classification would overstate what
  // shaped the heights.
  it('reports the class basis as missing when only one of two sources classifies', () => {
    const classed = layer({ id: 'classed', points: [2, 0, 5], classification: [2] });
    const bare = layer({ id: 'bare', points: [4, 0, 6] });
    const seam = createProfileSectionSeam(deps({ layers: () => [classed, bare] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.classificationOnEverySource).toBe(false);
  });

  it('reports the class basis as present when every source classifies', () => {
    const one = layer({ id: 'one', points: [2, 0, 5], classification: [2] });
    const two = layer({ id: 'two', points: [4, 0, 6], classification: [2] });
    const seam = createProfileSectionSeam(deps({ layers: () => [one, two] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.classificationOnEverySource).toBe(true);
  });

  it('asserts no class basis over a read that contributed nothing', () => {
    const seam = createProfileSectionSeam(deps({ layers: () => [] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.classificationOnEverySource).toBe(false);
  });

  it('counts a misaligned classification as absent for the basis', () => {
    // The same rule `viewOf` applies to the channel itself: an array that
    // cannot be indexed alongside the points is not classification that was
    // applied, so the basis must not claim it was.
    const misaligned: ProfileSeamLayer = {
      ...layer({ id: 'misaligned', points: [2, 0, 5, 4, 0, 6] }),
      channels: { classification: new Uint8Array([2]) },
    };
    const seam = createProfileSectionSeam(deps({ layers: () => [misaligned] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(section.classificationOnEverySource).toBe(false);
  });

  it('drops a classification whose length disagrees with the point count', () => {
    const misaligned: ProfileSeamLayer = {
      ...layer({ id: 'misaligned', points: [2, 0, 5, 4, 0, 6] }),
      channels: { classification: new Uint8Array([2]) },
    };
    const seam = createProfileSectionSeam(deps({ layers: () => [misaligned] }));
    const section = seam.section({ a: A, b: B, corridorWidth: 1 })!;
    expect(profileSectionHas(section.points, 0, 'classification')).toBe(false);
    // And the series must not gate on it either: a misaligned array is the
    // absence of a classification, so both returns stay in.
    const series = seam.sampleSeries(A, B, { corridorWidth: 1 })!;
    expect(series.samples.reduce((n, s) => n + (s.count ?? 0), 0)).toBe(2);
  });

  it('reports resident-only whenever streaming bytes were in the walk', () => {
    const seam = createProfileSectionSeam(
      deps({
        layers: () => [layer({ id: 'static', points: [2, 0, 5] })],
        residentNodes: () => [node('0-0-0-0', [4, 0, 6])],
        streamingMayCombine: () => true,
      }),
    );
    expect(seam.sampleSeries(A, B, { corridorWidth: 1 })!.residentOnly).toBe(true);
    const staticOnly = createProfileSectionSeam(
      deps({ layers: () => [layer({ id: 'static', points: [2, 0, 5] })] }),
    );
    expect(staticOnly.sampleSeries(A, B, { corridorWidth: 1 })!.residentOnly).toBe(false);
  });
});
