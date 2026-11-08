/**
 * catchmentQuality.test.ts — the evidence behind a catchment and the grade it
 * earns. One test per edge of the rule: the exact boundary values 0.90 and
 * 0.10, a far-interpolated run of 5 against 6, a channel beside an enclosed
 * hole, an open catchment, and holes inside the divide.
 *
 * Every grid is drawn by hand so each share can be read off the picture.
 */
import { describe, expect, it } from 'vitest';
import { catchmentQuality } from '../src/simulation/flowPulse/watershed/catchmentQuality';
import { traceDivide } from '../src/simulation/flowPulse/watershed/divideTrace';
import type { MainChannel } from '../src/simulation/flowPulse/watershed/mainChannel';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

interface Scene {
  cols?: number;
  rows?: number;
  cellMetresX?: number;
  cellMetresY?: number;
  /** Cell indices that are NoData (excluded from the mask). */
  nodata?: number[];
  /** Cell indices with coverage 1 (interpolated); the rest of the valid cells are measured. */
  interpolated?: number[];
  /** Cell indices whose confidence is 10 (below the dashed threshold). */
  lowConfidence?: number[];
  /** Cell indices of the main channel, divide end first. */
  channel: number[];
  complete?: boolean;
  counts?: number;
  horizontalScaleResolved?: boolean;
}

function quality(scene: Scene) {
  const cols = scene.cols ?? 11;
  const rows = scene.rows ?? 10;
  const n = cols * rows;
  const valid = new Uint8Array(n).fill(1);
  for (const i of scene.nodata ?? []) valid[i] = 0;
  const flowGrid: FlowGrid = {
    z: new Float32Array(n), valid, cols, rows,
    cellMetresX: scene.cellMetresX ?? 1, cellMetresY: scene.cellMetresY ?? 1,
  };
  const coverage = new Uint8Array(n);
  const confidence = new Float32Array(n);
  const counts = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    if (valid[i] === 0) continue;
    coverage[i] = 2;
    confidence[i] = 100;
    counts[i] = scene.counts ?? 1;
  }
  for (const i of scene.interpolated ?? []) { coverage[i] = 1; counts[i] = 0; }
  for (const i of scene.lowConfidence ?? []) confidence[i] = 10;
  const dtm = {
    z: new Float32Array(n), confidence, coverage, counts,
    interpDistanceCells: new Float32Array(n), cols, rows, cellSizeM: 1,
  } as unknown as DtmGrid;

  const mask = Uint8Array.from(valid);
  const cells = Int32Array.from(scene.channel);
  const interpolated = Uint8Array.from(cells, (c) => (coverage[c] === 1 ? 1 : 0));
  const channel = {
    cells,
    profile: { distanceM: new Float64Array(cells.length), elevationM: new Float64Array(cells.length), interpolated },
  } as unknown as MainChannel;

  const divide = traceDivide(flowGrid, mask);
  return catchmentQuality({
    dtm, mask, channel, divide, flowGrid,
    complete: scene.complete ?? true,
    ...(scene.horizontalScaleResolved === undefined ? {} : { horizontalScaleResolved: scene.horizontalScaleResolved }),
  });
}

/** Row 0 of the default 11 x 10 grid, divide end (col 10) to outlet (col 0). */
const rowZero = Array.from({ length: 11 }, (_, i) => 10 - i);
/** Row 5, which no default channel uses: filler for cells that must be interpolated. */
const rowFive = Array.from({ length: 11 }, (_, i) => 55 + i);

describe('catchmentQuality verdict rule', () => {
  it('is supported at measured share exactly 0.90 and channel share exactly 0.10 when complete', () => {
    // 110 valid cells, 11 interpolated: 99 / 110 = 0.90. One of the 11 is the
    // divide-end channel cell, so 1 of the 10 channel steps is interpolated: 0.10.
    const q = quality({ channel: rowZero, interpolated: [rowZero[0], ...rowFive.slice(0, 10)] });
    expect(q.measuredShare).toBe(0.9);
    expect(q.channelInterpolatedShare).toBe(0.1);
    expect(q.verdict).toBe('supported');
    expect(q.reasons).toEqual([]);
  });

  it('is limited when the measured share is 0.899', () => {
    // 1000 valid cells, 101 interpolated: 899 / 1000.
    const cols = 100;
    const interpolated = Array.from({ length: 101 }, (_, i) => 5 * cols + i % cols + (i >= 100 ? cols : 0));
    const q = quality({ cols, rows: 10, channel: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0], interpolated });
    expect(q.measuredShare).toBeCloseTo(0.899, 12);
    expect(q.measuredShare).toBeLessThan(0.9);
    expect(q.verdict).toBe('limited');
    expect(q.reasons).toEqual(['measured-share-below-0.90']);
  });

  it('is limited when more than 0.10 of the channel is interpolated', () => {
    // 2 of 10 steps over interpolated cells, measured share stays 0.90 or better.
    const q = quality({ channel: rowZero, interpolated: [rowZero[0], rowZero[1]] });
    expect(q.channelInterpolatedShare).toBe(0.2);
    expect(q.verdict).toBe('limited');
    expect(q.reasons).toEqual(['channel-interpolated-over-0.10']);
  });

  it('is not supported when the channel has a run of 6 far-interpolated cells', () => {
    const run = rowZero.slice(2, 8);
    const q = quality({ channel: rowZero, interpolated: run, lowConfidence: run });
    expect(q.longestFarInterpolatedRun).toBe(6);
    expect(q.verdict).toBe('not-supported');
    expect(q.reasons).toContain('channel-far-interpolated-run');
  });

  it('does not use the run rule for a run of 5', () => {
    const run = rowZero.slice(2, 7);
    const q = quality({ channel: rowZero, interpolated: run, lowConfidence: run });
    expect(q.longestFarInterpolatedRun).toBe(5);
    expect(q.reasons).not.toContain('channel-far-interpolated-run');
    // 5 of 10 steps are interpolated, so the channel rule still limits it.
    expect(q.verdict).toBe('limited');
  });

  it('counts only consecutive cells, and only low-confidence interpolated ones', () => {
    // 3 + 3 low cells split by a measured cell; two interpolated cells with good confidence do not count.
    const low = [...rowZero.slice(0, 3), ...rowZero.slice(4, 7)];
    const q = quality({ channel: rowZero, interpolated: [...low, rowZero[8], rowZero[9]], lowConfidence: low });
    expect(q.longestFarInterpolatedRun).toBe(3);
    expect(q.reasons).not.toContain('channel-far-interpolated-run');
    expect(q.verdict).toBe('limited');
  });

  it('is not supported when the channel touches a NoData cell enclosed by data', () => {
    // Cell (5,1) is a hole one row above the channel on row 0; the rest is data.
    const q = quality({ channel: rowZero, nodata: [1 * 11 + 5] });
    expect(q.touchesEnclosedHole).toBe(true);
    expect(q.verdict).toBe('not-supported');
    expect(q.reasons).toContain('channel-touches-hole');
  });

  it('counts a diagonal neighbour as touching', () => {
    const q = quality({ channel: rowZero, nodata: [1 * 11 + 4] });
    expect(q.touchesEnclosedHole).toBe(true);
  });

  it('does not treat NoData that reaches the grid border as an enclosed hole', () => {
    // The whole row 1 is NoData, so it reaches the border: outside the survey.
    const rowOne = Array.from({ length: 11 }, (_, i) => 11 + i);
    const q = quality({ channel: rowZero, nodata: rowOne });
    expect(q.touchesEnclosedHole).toBe(false);
    expect(q.verdict).toBe('supported');
  });

  it('is limited, at best, when the catchment is open, even with perfect data', () => {
    const q = quality({ channel: rowZero, complete: false });
    expect(q.measuredShare).toBe(1);
    expect(q.channelInterpolatedShare).toBe(0);
    expect(q.verdict).toBe('limited');
    expect(q.reasons).toEqual(['catchment-open']);
  });

  it('stays not supported when open and the channel also fails', () => {
    const run = rowZero.slice(0, 6);
    const q = quality({ channel: rowZero, interpolated: run, lowConfidence: run, complete: false });
    expect(q.verdict).toBe('not-supported');
  });

  it('lists every condition that applies, not only the first', () => {
    const run = rowZero.slice(0, 6);
    const q = quality({ channel: rowZero, interpolated: run, lowConfidence: run, nodata: [1 * 11 + 5], complete: false });
    expect(q.verdict).toBe('not-supported');
    expect(q.reasons).toEqual([
      'channel-interpolated-over-0.10',
      'channel-far-interpolated-run',
      'channel-touches-hole',
      'catchment-open',
    ]);
  });
});

describe('catchmentQuality measured share', () => {
  it('counts enclosed NoData holes inside the divide in the denominator', () => {
    // 5 x 5 grid with a 3 x 3 hole in the middle: 16 valid cells, 9 hole cells.
    const hole: number[] = [];
    for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) hole.push(r * 5 + c);
    const q = quality({ cols: 5, rows: 5, nodata: hole, channel: [4, 3, 2, 1, 0] });
    expect(q.measuredShare).toBeCloseTo(16 / 25, 12);
    // Row 1 holds the first row of the hole, so the channel on row 0 touches it.
    expect(q.touchesEnclosedHole).toBe(true);
  });

  it('does not count NoData outside the divide', () => {
    const q = quality({ cols: 5, rows: 5, nodata: [20, 21, 22, 23, 24], channel: [4, 3, 2, 1, 0] });
    expect(q.measuredShare).toBe(1);
  });

  it('does not treat interpolated cells as measured', () => {
    const q = quality({ channel: rowZero, interpolated: rowFive });
    expect(q.measuredShare).toBeCloseTo(99 / 110, 12);
  });

  it('is 0 for an empty catchment instead of NaN', () => {
    const all = Array.from({ length: 25 }, (_, i) => i);
    const q = quality({ cols: 5, rows: 5, nodata: all, channel: [] });
    expect(q.measuredShare).toBe(0);
    expect(q.channelInterpolatedShare).toBe(0);
    expect(q.longestFarInterpolatedRun).toBe(0);
    expect(q.touchesEnclosedHole).toBe(false);
    expect(q.verdict).toBe('limited');
  });
});

describe('catchmentQuality channel share by length', () => {
  it('weights each step by its length on the anisotropic grid', () => {
    // (0,0) -> (1,0) east 3 m, then (1,0) -> (1,1) north 1 m. Only the first upstream cell is interpolated.
    const q = quality({ cols: 4, rows: 4, cellMetresX: 3, cellMetresY: 1, channel: [0, 1, 5], interpolated: [0] });
    expect(q.channelInterpolatedShare).toBeCloseTo(3 / 4, 12);
  });

  it('weights a diagonal step by its hypotenuse', () => {
    // (0,0) -> (1,1) diagonal sqrt(9 + 1); then (1,1) -> (2,1) east 3 m. Only the second upstream cell is interpolated.
    const q = quality({ cols: 4, rows: 4, cellMetresX: 3, cellMetresY: 1, channel: [0, 5, 6], interpolated: [5] });
    expect(q.channelInterpolatedShare).toBeCloseTo(3 / (Math.hypot(3, 1) + 3), 12);
  });

  it('judges a step by its upstream cell, so an interpolated outlet cell adds no length', () => {
    const q = quality({ channel: rowZero, interpolated: [rowZero[10]] });
    expect(q.channelInterpolatedShare).toBe(0);
  });
});

describe('catchmentQuality ground density', () => {
  it('sums the returns counted in each mask cell and divides by the catchment area', () => {
    // 110 cells of 2 m x 0.5 m = 110 m2; 3 returns each.
    const q = quality({ channel: rowZero, cellMetresX: 2, cellMetresY: 0.5, counts: 3 });
    expect(q.groundPointsPerM2).toBeCloseTo((110 * 3) / 110, 12);
  });

  it('only counts cells inside the mask', () => {
    // Row 9 is NoData (outside the mask) and carries no counts; 100 cells of 1 m2, 4 returns each.
    const rowNine = Array.from({ length: 11 }, (_, i) => 99 + i);
    const q = quality({ channel: rowZero, nodata: rowNine, counts: 4 });
    expect(q.groundPointsPerM2).toBeCloseTo(4, 12);
  });

  it('is null when the horizontal scale is not resolved', () => {
    expect(quality({ channel: rowZero, horizontalScaleResolved: false }).groundPointsPerM2).toBeNull();
    expect(quality({ channel: rowZero, cellMetresX: Number.NaN }).groundPointsPerM2).toBeNull();
  });

  it('is null for an empty catchment', () => {
    const all = Array.from({ length: 25 }, (_, i) => i);
    expect(quality({ cols: 5, rows: 5, nodata: all, channel: [] }).groundPointsPerM2).toBeNull();
  });
});
