/**
 * sourceTopologyManifest.test.ts
 *
 * The processing manifest's record of source-record identity: whether a display
 * point still resolves to the acquisition-grid cell that produced it, and which
 * step spent that identity when it no longer does.
 *
 * The properties pinned here are the ones a reviewer holding only the artifact
 * depends on:
 *
 *   1. THREE DISTINCT ANSWERS. A cloud that never carried an acquisition grid
 *      gains no op (silence), an exactly linked one records `exact`, and a
 *      degraded one records the state AND the reason. Absent, exact and
 *      degraded can never be read for one another.
 *   2. INSIDE THE CHAIN. The record is an ordinary op, so it folds into the
 *      hash chain and cannot be stripped or reworded while verification passes.
 *   3. UNCHANGED FOR ORDINARY FORMATS. A manifest built with no topology is
 *      byte-identical, hash for hash, to what the same inputs produced before
 *      the field existed — pinned against literal digests captured from the
 *      previous implementation, not recomputed from the new one.
 */

import { describe, it, expect } from 'vitest';
import {
  buildProcessingManifest,
  verifyProcessingManifest,
  sourceTopologyOp,
  SOURCE_TOPOLOGY_METHOD_ID,
  PROCESSING_MANIFEST_SCHEMA,
  type ProcessingManifest,
  type ProcessingOpInput,
} from '../src/science/processingManifest';
import { sourceTopologyRecord, compareCodeUnits } from '../src/science/sourceTopology';
import { methodRef, methodTag } from '../src/science/methodRegistry';
import {
  CellState,
  tallyCellStates,
  type OrganizedRangeFrame,
  type OrganizedRangeSet,
  type RangeLinkage,
} from '../src/model/OrganizedRange';
import { PointCloud } from '../src/model/PointCloud';
import { voxelDownsample } from '../src/process/voxelDownsample';

const BUILD = '0.5.9 (abc1234, release channel, built 2026-07-01T00:00:00Z)';

/** The op sequence the terrain producer emits, used as the unchanged baseline. */
function sampleOps(): ProcessingOpInput[] {
  return [
    { method: 'olv.ground.smrf@1', params: {}, note: 'params not captured in this slice' },
    { method: 'olv.dtm.idw-fill@1', params: { coverageMode: 'full' } },
    { method: 'olv.terrain.vrm@1', params: { windowCells: 3, windowGroundM: 3.2 } },
  ];
}

/**
 * The chain those ops produced BEFORE this change, captured by running the
 * previous implementation. These literals are the byte-identity proof: if the
 * topology field ever perturbs a manifest that carries no topology, the ops'
 * own hashes move and these fail. They are never to be regenerated to make a
 * test pass — a change here means a no-topology manifest stopped matching what
 * the shipped artifacts already carry.
 */
const BASELINE_OP_HASHES = [
  '137eeeb8bf34b6ac0c32467b880937e35130c1dd24dd37fa31da31b6655361f6',
  'c9f6a627ba8bf9a1ced0b96420ef4fb5075ad0211885d89a54d87ae76d79389e',
  'c659eab6ec457e12277ac6468ebae4bc4ad1aefd3cb33392a77f04164d00081c',
];
const BASELINE_HEAD = 'c659eab6ec457e12277ac6468ebae4bc4ad1aefd3cb33392a77f04164d00081c';

/** A 3 wide by 2 high frame, non-square so a transposed read cannot hide. */
function frame(over: Partial<OrganizedRangeFrame> = {}): OrganizedRangeFrame {
  const width = 3;
  const height = 2;
  const cellState = new Uint8Array(width * height).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(width * height);
  for (let i = 0; i < cellToRecord.length; i++) cellToRecord[i] = i;
  return {
    id: 'setup-1',
    sourceKind: 'ptx-grid',
    width,
    height,
    cellState,
    cellToRecord,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
    ...over,
  };
}

function set(linkages: RangeLinkage[]): OrganizedRangeSet {
  return {
    kind: 'organized-range',
    organization: linkages.length > 1 ? 'multi-grid' : 'organized-grid',
    frames: linkages.map((linkage, i) => frame({ id: `setup-${i}`, linkage })),
  };
}

/** Six points on a 3x2 grid, carrying the given topology. */
function cloudWith(topology: OrganizedRangeSet | undefined): PointCloud {
  const positions = new Float32Array(6 * 3);
  for (let i = 0; i < 6; i++) {
    // Two points per voxel at size 4, so a downsample genuinely merges records.
    positions[i * 3] = Math.floor(i / 2) * 5;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = 0;
  }
  return new PointCloud({
    positions,
    origin: [0, 0, 0],
    sourceFormat: 'ptx',
    name: 'scan.ptx',
    ...(topology ? { organizedRange: topology } : {}),
  });
}

function manifestFor(topology: OrganizedRangeSet | undefined): ProcessingManifest {
  return buildProcessingManifest({
    build: BUILD,
    source: 'site.laz',
    ops: sampleOps(),
    sourceTopology: sourceTopologyRecord(topology),
  });
}

describe('a cloud that never carried an acquisition topology', () => {
  it('gains no op, so the manifest asserts no grid and no identity', () => {
    const m = manifestFor(undefined);
    expect(sourceTopologyRecord(undefined)).toBeUndefined();
    expect(m.ops).toHaveLength(3);
    expect(m.ops.map((o) => o.method)).toEqual([
      'olv.ground.smrf@1',
      'olv.dtm.idw-fill@1',
      'olv.terrain.vrm@1',
    ]);
    // Nothing anywhere in the manifest mentions linkage: absence is silence,
    // not a third value spelled out as if a grid had been inspected.
    expect(JSON.stringify(m)).not.toContain('linkage');
    expect(JSON.stringify(m)).not.toContain(SOURCE_TOPOLOGY_METHOD_ID);
  });

  it('is byte-identical to the manifest the previous implementation built', () => {
    const withField = manifestFor(undefined);
    const withoutField = buildProcessingManifest({
      build: BUILD,
      source: 'site.laz',
      ops: sampleOps(),
    });
    expect(withField).toEqual(withoutField);
    expect(withField.ops.map((o) => o.hash)).toEqual(BASELINE_OP_HASHES);
    expect(withField.head).toBe(BASELINE_HEAD);
    expect(withField.schemaVersion).toBe(PROCESSING_MANIFEST_SCHEMA);
    expect(PROCESSING_MANIFEST_SCHEMA).toBe(1);
  });

  it('holds for a cloud whose set declares no frame at all', () => {
    const empty: OrganizedRangeSet = {
      kind: 'organized-range',
      organization: 'organized-grid',
      frames: [],
    };
    expect(sourceTopologyRecord(empty)).toBeUndefined();
    expect(manifestFor(empty).head).toBe(BASELINE_HEAD);
  });
});

describe('a cloud whose topology is still exactly linked', () => {
  it('leads the chain with an op recording exact linkage and no reason', () => {
    const m = manifestFor(set([{ kind: 'exact' }]));
    expect(m.ops).toHaveLength(4);
    const op = m.ops[0];
    expect(op.seq).toBe(0);
    expect(op.method).toBe(methodTag(methodRef(SOURCE_TOPOLOGY_METHOD_ID)));
    expect(op.method).toBe('olv.topology.linkage-record@1');
    expect(op.params).toEqual({
      organization: 'organized-grid',
      frames: 1,
      linkage: 'exact',
    });
    expect(op.params).not.toHaveProperty('reasons');
    expect(op.note).toBe(
      'Every frame still resolves a grid cell to the display record the loader decoded it from.',
    );
    // The recorded steps follow it: the topology describes the cloud that
    // entered the pipeline, before its first step.
    expect(m.ops[1].method).toBe('olv.ground.smrf@1');
  });
});

describe('a cloud reduced to voxel centroids', () => {
  /** The real reduction path, not a hand-degraded fixture. */
  function reducedManifest(): ProcessingManifest {
    const reduced = voxelDownsample(cloudWith(set([{ kind: 'exact' }])), 4);
    return manifestFor(reduced.organizedRange);
  }

  it('records that source-record identity is gone and names the step', () => {
    const op = reducedManifest().ops[0];
    expect(op.params).toEqual({
      organization: 'organized-grid',
      frames: 1,
      linkage: 'unavailable',
      reasons: ['voxel-centroids'],
    });
    expect(op.note).toBe(
      'No cell resolves to a source record any more; the reason names the step that spent that identity. ' +
        'Reason: voxel reduction replaced source records with one centroid per occupied voxel.',
    );
  });

  it('reads as a degradation, never as the exact case', () => {
    const op = reducedManifest().ops[0];
    expect(op.params.linkage).not.toBe('exact');
    expect(op.note).not.toContain('still resolves');
  });

  it('reports the least faithful frame of a multi-grid set, with its reasons', () => {
    const op = manifestFor(
      set([
        { kind: 'exact' },
        { kind: 'unavailable', reason: 'voxel-centroids' },
        { kind: 'unavailable', reason: 'invalid-source-topology' },
      ]),
    ).ops[0];
    expect(op.params).toEqual({
      organization: 'multi-grid',
      frames: 3,
      linkage: 'unavailable',
      // Sorted, so the record is deterministic whatever order the frames load in.
      reasons: ['invalid-source-topology', 'voxel-centroids'],
    });
  });

  it('keeps a partial shortfall distinct from a permanent one', () => {
    const op = manifestFor(set([{ kind: 'partial', reason: 'stride' }])).ops[0];
    expect(op.params.linkage).toBe('partial');
    expect(op.params.reasons).toEqual(['stride']);
    expect(op.note).toContain('records that were decoded still resolve');
  });
});

describe('the record is inside the tamper-evident chain', () => {
  const degraded = () => manifestFor(set([{ kind: 'unavailable', reason: 'voxel-centroids' }]));

  it('verifies over the whole chain, topology op included', () => {
    expect(verifyProcessingManifest(degraded())).toEqual({ ok: true });
    expect(verifyProcessingManifest(manifestFor(set([{ kind: 'exact' }])))).toEqual({ ok: true });
    expect(verifyProcessingManifest(manifestFor(undefined))).toEqual({ ok: true });
  });

  it('breaks at op 0 when the degradation is reworded to exact', () => {
    const m = degraded();
    const forged: ProcessingManifest = {
      ...m,
      ops: [{ ...m.ops[0], params: { ...m.ops[0].params, linkage: 'exact' } }, ...m.ops.slice(1)],
    };
    expect(verifyProcessingManifest(forged)).toEqual({ ok: false, firstInvalid: 0 });
  });

  it('breaks when the topology op is dropped from the front', () => {
    const m = degraded();
    expect(verifyProcessingManifest({ ...m, ops: m.ops.slice(1) })).toEqual({
      ok: false,
      firstInvalid: 0,
    });
  });

  it('gives a degraded cloud a different head from an exactly linked one', () => {
    expect(degraded().head).not.toBe(manifestFor(set([{ kind: 'exact' }])).head);
    expect(degraded().head).not.toBe(manifestFor(undefined).head);
  });
});

describe('wording discipline', () => {
  it('never reaches for a prohibited claim', () => {
    const strings = [
      JSON.stringify(manifestFor(set([{ kind: 'exact' }]))),
      JSON.stringify(manifestFor(set([{ kind: 'partial', reason: 'stride' }]))),
      JSON.stringify(
        sourceTopologyOp({
          organization: 'organized-grid',
          frames: 1,
          linkage: 'unavailable',
          reasons: [
            'voxel-centroids',
            'invalid-source-topology',
            'source-record-identity-unavailable',
          ],
        }),
      ),
    ].join(' ');
    for (const banned of ['measured range', 'sensor accuracy', 'confidence', 'Flash LiDAR']) {
      expect(strings).not.toContain(banned);
    }
  });
});

describe('the reason order cannot depend on the machine', () => {
  it('sorts by code unit, so the digest is the same everywhere', () => {
    // These strings are hashed into a tamper-evident chain. Ordering them with
    // String.localeCompare would consult the runtime's locale and ICU data, so
    // a developer's laptop, a CI runner and a reviewer's machine could each
    // produce a different digest for identical input. The characters below are
    // ones where a locale-aware collation and a code-unit comparison genuinely
    // disagree: in several locales an accented letter sorts beside its base
    // letter, while by code unit every ASCII letter precedes it.
    // The comparator itself is pinned, not a sample of today's reason strings:
    // the three reasons in use sort the same way under either comparator, so a
    // test over them would pass with a locale-aware sort and only start failing
    // once a future reason string had already changed a shipped digest.
    const sample = ['Zebra', 'apple', 'ápple'];
    expect([...sample].sort(compareCodeUnits)).toEqual(['Zebra', 'apple', 'ápple']);
    expect(compareCodeUnits('Zebra', 'apple')).toBeLessThan(0);
    // A locale-aware comparison of that same pair goes the other way in most
    // locales, which is the divergence this comparator exists to refuse.
    expect('Zebra'.localeCompare('apple')).toBeGreaterThan(0);
  });

  it('produces a byte-identical manifest for the same input, twice', () => {
    const build = (): string => {
      return JSON.stringify(
        sourceTopologyRecord(
          set([
            { kind: 'unavailable', reason: 'voxel-centroids' },
            { kind: 'unavailable', reason: 'invalid-source-topology' },
            { kind: 'unavailable', reason: 'source-record-identity-unavailable' },
          ]),
        ),
      );
    };
    expect(build()).toBe(build());
  });
});
