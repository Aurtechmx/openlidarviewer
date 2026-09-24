/**
 * withheldAwareTerrainGather.test.ts: recovering the Withheld outcome for a
 * static file the display path voxel-downsampled at load.
 *
 * The scenario (ledger L26/L28): a static file above the display point budget
 * is voxel-downsampled at load, and the reduction leaves `classificationFlags`
 * undefined on the reduced cloud. The canonical gather (`sampleStridedTerrain`)
 * then has no flags channel to read, so it can only declare the Withheld
 * outcome "not recorded", a true statement about the buffer it was handed,
 * but not about the source, which still carries flags.
 *
 * `gatherWithheldAwareTerrainSource` and `gatherWithheldAwareTerrainCore`
 * re-decode the ORIGINAL bytes at full resolution and hand that buffer to the
 * SAME canonical gather, unmodified, so the declaration becomes "excluded"
 * whenever the source actually carries flags, without ever touching the
 * cloud the display path produced.
 *
 * A 20-point LAS is built in-test with the repo's own writer (`writeLas`),
 * well under the real 4,000,000-point display budget. The "large file" is
 * simulated by parsing it through the display path with a budget of 4, the
 * existing test seam (`parseBuffer`'s `budget` parameter), which forces the
 * same voxel reduction a genuinely huge file would trigger.
 */
import { describe, expect, it } from 'vitest';

import { parseBuffer } from '../src/io/parseBuffer';
import { writeLas } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { isWithheld } from '../src/science/withheldPolicy';
import { computeTerrainCore } from '../src/terrain/contour/analyseContours';
import type { HorizontalScale } from '../src/simulation/flowPulse/dtmFlowGrid';
import { runFlowPulse, FLOW_PULSE_DEFAULTS, type FlowRunIdentity } from '../src/simulation/flowPulse/flowPulseRunner';
import {
  gatherWithheldAwareTerrainCore,
  gatherWithheldAwareTerrainSource,
  WITHHELD_GATHER_MAX_SOURCE_BYTES,
} from '../src/terrain/ground/withheldAwareTerrainGather';
import type { PointCloud } from '../src/model/PointCloud';

const WITHHELD_FLAG = 0b0100; // extended layout: Withheld
const GROUND = 2;
const POINT_COUNT = 20; // 5x4 grid
const WITHHELD_INDICES = new Set([0, 5, 10, 15]); // 4 of 20

/** A 5x4 ground grid, spacing 1 unit, with 4 points marked Withheld. */
function buildLasBuffer(): ArrayBuffer {
  const x = new Float64Array(POINT_COUNT);
  const y = new Float64Array(POINT_COUNT);
  const z = new Float64Array(POINT_COUNT);
  const classification = new Uint8Array(POINT_COUNT).fill(GROUND);
  const classificationFlags = new Uint8Array(POINT_COUNT);
  let i = 0;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++, i++) {
      x[i] = col;
      y[i] = row;
      z[i] = 10 + 0.1 * (col + row);
      if (WITHHELD_INDICES.has(i)) classificationFlags[i] = WITHHELD_FLAG;
    }
  }
  const g: GlobalPoints = { count: POINT_COUNT, x, y, z, classification, classificationFlags };
  const bytes = writeLas(g);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const LAS_BUFFER = buildLasBuffer();
/** A fresh independent copy each call: no test shares a buffer another test/parse might read from concurrently. */
const fresh = (): ArrayBuffer => LAS_BUFFER.slice(0);

const NAME = 'big-static-file.las';

describe('the scenario: a display cloud with no flags channel', () => {
  it('the source has 20 points, 4 of them Withheld', async () => {
    const { cloud } = await parseBuffer(fresh(), 'las', NAME);
    expect(cloud.pointCount).toBe(POINT_COUNT);
    const flags = cloud.classificationFlags;
    expect(flags).toBeTruthy();
    let withheld = 0;
    for (let k = 0; k < flags!.length; k++) if (isWithheld(flags![k])) withheld++;
    expect(withheld).toBe(WITHHELD_INDICES.size);
  });

  it('a budget below the point count voxel-downsamples and drops the flags channel', async () => {
    const { cloud, downsampled } = await parseBuffer(fresh(), 'las', NAME, 4);
    expect(downsampled).toBe(true);
    expect(cloud.pointCount).toBeLessThan(POINT_COUNT);
    expect(cloud.classificationFlags).toBeUndefined();
  });
});

describe('gatherWithheldAwareTerrainSource', () => {
  it('recovers "excluded" over the full-resolution source', async () => {
    const gathered = await gatherWithheldAwareTerrainSource(fresh(), NAME);
    expect(gathered).not.toBeNull();
    expect(gathered!.totalPoints).toBe(POINT_COUNT);
    expect(gathered!.sample.withheldExcluded).toBe(true);
    expect(gathered!.sample.withheldExcludedCount).toBe(WITHHELD_INDICES.size);
    expect(gathered!.sample.positions.length / 3).toBe(POINT_COUNT - WITHHELD_INDICES.size);
  });

  it('samples the same candidates as an unfiltered full gather, minus the Withheld ones', async () => {
    // Same stride-invariance property `sampleStridedTerrain` itself pins,
    // demonstrated end to end through the re-decode seam: nothing here
    // reimplements the filter, it only supplies flagged points to read.
    const { cloud: full } = await parseBuffer(fresh(), 'las', NAME);
    const gathered = await gatherWithheldAwareTerrainSource(fresh(), NAME);
    expect(gathered).not.toBeNull();
    const kept: number[] = [];
    for (let k = 0; k < full.pointCount; k++) {
      if (!isWithheld(full.classificationFlags![k])) kept.push(k);
    }
    expect(kept.length).toBe(gathered!.sample.positions.length / 3);
    for (let k = 0; k < kept.length; k++) {
      expect(gathered!.sample.positions[k * 3]).toBeCloseTo(full.positions[kept[k] * 3], 5);
      expect(gathered!.sample.positions[k * 3 + 1]).toBeCloseTo(full.positions[kept[k] * 3 + 1], 5);
    }
  });

  it('does not touch or invalidate the display decode', async () => {
    const before = await parseBuffer(fresh(), 'las', NAME, 4);
    await gatherWithheldAwareTerrainSource(fresh(), NAME);
    const after = await parseBuffer(fresh(), 'las', NAME, 4);
    expect(after.cloud.pointCount).toBe(before.cloud.pointCount);
    expect(Buffer.from(after.cloud.positions.buffer)).toEqual(Buffer.from(before.cloud.positions.buffer));
    expect(after.cloud.classificationFlags).toBeUndefined();
    expect(before.cloud.classificationFlags).toBeUndefined();
  });

  it('leaves the source buffer bytes unchanged', async () => {
    const buf = fresh();
    const snapshot = Buffer.from(buf.slice(0));
    await gatherWithheldAwareTerrainSource(buf, NAME);
    expect(Buffer.from(buf)).toEqual(snapshot);
  });
});

describe('gatherWithheldAwareTerrainCore: DTM cells match a gather over the non-Withheld source points', () => {
  it('produces a DTM identical to computeTerrainCore run directly over the manually-filtered source', async () => {
    const recovered = await gatherWithheldAwareTerrainCore(fresh(), NAME, { cellSizeM: 1 });
    expect(recovered).not.toBeNull();
    expect(recovered!.core.dtm.withheldExcluded).toBe(true);
    expect(recovered!.core.dtm.withheldExcludedCount).toBe(WITHHELD_INDICES.size);

    // Independent reference: decode in full, filter Withheld points by hand
    // (not through any gather function), rasterise the same way.
    const { cloud: full } = await parseBuffer(fresh(), 'las', NAME);
    const flags = full.classificationFlags!;
    const cls = full.classification!;
    const refPositions = new Float32Array((POINT_COUNT - WITHHELD_INDICES.size) * 3);
    const refClass = new Uint8Array(POINT_COUNT - WITHHELD_INDICES.size);
    let o = 0;
    for (let k = 0; k < POINT_COUNT; k++) {
      if (isWithheld(flags[k])) continue;
      refPositions[o * 3] = full.positions[k * 3];
      refPositions[o * 3 + 1] = full.positions[k * 3 + 1];
      refPositions[o * 3 + 2] = full.positions[k * 3 + 2];
      refClass[o] = cls[k];
      o++;
    }
    const refCore = computeTerrainCore(refPositions, { cellSizeM: 1, classification: refClass });

    expect(Buffer.from(recovered!.core.dtm.z.buffer)).toEqual(Buffer.from(refCore.dtm.z.buffer));
    expect(Array.from(recovered!.core.dtm.counts)).toEqual(Array.from(refCore.dtm.counts));
    expect(Array.from(recovered!.core.dtm.coverage)).toEqual(Array.from(refCore.dtm.coverage));
    expect(recovered!.core.dtm.cols).toBe(refCore.dtm.cols);
    expect(recovered!.core.dtm.rows).toBe(refCore.dtm.rows);
  });
});

const scale: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };

function identity(analysisInputDigest: string): FlowRunIdentity {
  return {
    layerId: 'scan-1', filename: NAME, sourceDigest: null, analysisInputDigest,
    build: 'test-build', id: 'run-1', generatedAt: '2026-01-01T00:00:00.000Z',
    processingManifestHead: null,
  };
}

describe('Flow Pulse reads the recovered outcome as excluded, not not-recorded', () => {
  it('the recovered DTM: the run record and limitations state exclusion, recorded', async () => {
    const recovered = await gatherWithheldAwareTerrainCore(fresh(), NAME, { cellSizeM: 1 });
    expect(recovered).not.toBeNull();
    const outcome = runFlowPulse(recovered!.core.dtm, scale, FLOW_PULSE_DEFAULTS, identity('recovered'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.source.basis.withheldExcluded).toBe(true);
    expect(outcome.limitations.some((s) => /not recorded/i.test(s))).toBe(false);
  });

  it('contrast: the plain display DTM (no re-decode) states the exclusion is not recorded', async () => {
    const { cloud } = await parseBuffer(fresh(), 'las', NAME, 4); // forced downsample, flags lost
    const core = computeTerrainCore(cloud.positions, { cellSizeM: 1, classification: cloud.classification });
    expect(core.dtm.withheldExcluded == null).toBe(true);
    const outcome = runFlowPulse(core.dtm, scale, FLOW_PULSE_DEFAULTS, identity('display'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.source.basis.withheldExcluded).toBeNull();
    expect(outcome.limitations.some((s) => /not recorded/i.test(s))).toBe(true);
  });
});

// ── Defect E: when the re-decode strides the source down (`maxPoints` below
// the source's point count), the recovered DTM must state `coverageMode:
// 'sampled'`, not the `rasterizeDtm` default of `'full'` — the exact
// disagreement a real run showed between the run record (`coverage: 'full',
// complete: true`) and the Analyse/Contour Studio panel's own "only a sample
// was read" disclosure for the identical gather.
describe('a strided re-decode states the true coverage, agreeing with the rest of the app', () => {
  it('stamps coverageMode "sampled" when the re-decode strides the source down', async () => {
    // maxPoints below the 20-point source forces `sampleStridedTerrain` to
    // stride, so `sample.sampled` is true.
    const recovered = await gatherWithheldAwareTerrainCore(
      fresh(), NAME, { cellSizeM: 1 }, { maxPoints: 8 },
    );
    expect(recovered).not.toBeNull();
    expect(recovered!.sample.sampled).toBe(true);
    expect(recovered!.core.dtm.coverageMode).toBe('sampled');

    const outcome = runFlowPulse(recovered!.core.dtm, scale, FLOW_PULSE_DEFAULTS, identity('strided'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The run record must therefore agree: NOT `coverage: 'full', complete: true`.
    expect(outcome.record.source.basis.coverage).toBe('sampled');
    expect(outcome.record.source.basis.complete).toBe(false);
    expect(outcome.limitations.some((s) => /sample of the source/i.test(s))).toBe(true);
  });

  it('keeps coverageMode "full" when the re-decode reads every point (no stride)', async () => {
    // maxPoints above the source's point count: stride collapses to 1.
    const recovered = await gatherWithheldAwareTerrainCore(
      fresh(), NAME, { cellSizeM: 1 }, { maxPoints: 1_000_000 },
    );
    expect(recovered).not.toBeNull();
    expect(recovered!.sample.sampled).toBe(false);
    expect(recovered!.core.dtm.coverageMode).toBe('full');
  });
});

describe('refusals stay honest: "not recorded" rather than a crash or a false "excluded"', () => {
  it('refuses a source over the byte ceiling without attempting a decode', async () => {
    const result = await gatherWithheldAwareTerrainSource(fresh(), NAME, { maxSourceBytes: 4 });
    expect(result).toBeNull();
  });

  it('the real ceiling is the export path\'s own re-decode threshold', () => {
    expect(WITHHELD_GATHER_MAX_SOURCE_BYTES).toBe(750 * 1024 * 1024);
  });

  it('refuses immediately on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await gatherWithheldAwareTerrainSource(fresh(), NAME, { signal: controller.signal });
    expect(result).toBeNull();
  });

  it('refuses when the decode rejects', async () => {
    const result = await gatherWithheldAwareTerrainSource(fresh(), NAME, {
      decodeFn: async () => { throw new Error('unparseable'); },
    });
    expect(result).toBeNull();
  });

  it('refuses a decode that does not finish within the time budget', async () => {
    const result = await gatherWithheldAwareTerrainSource(fresh(), NAME, {
      timeoutMs: 5,
      decodeFn: () => new Promise<PointCloud>(() => { /* never resolves */ }),
    });
    expect(result).toBeNull();
  });

  it('refuses a decode with no points', async () => {
    const result = await gatherWithheldAwareTerrainSource(fresh(), NAME, {
      decodeFn: async () => ({ pointCount: 0, positions: new Float32Array(0) }) as unknown as PointCloud,
    });
    expect(result).toBeNull();
  });

  it('refuses an empty buffer', async () => {
    const result = await gatherWithheldAwareTerrainSource(new ArrayBuffer(0), NAME);
    expect(result).toBeNull();
  });
});
