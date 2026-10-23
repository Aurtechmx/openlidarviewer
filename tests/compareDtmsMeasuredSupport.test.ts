import { describe, expect, it } from 'vitest';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import { changeCellSupport, compareDtms, dtmToChangeGrid, summarizeChange } from '../src/terrain/change/compareDtms';
import { buildSharedEpochDtms, type EpochCloud } from '../src/terrain/change/compareEpochs';

/**
 * A change cell is compared only where both epochs hold a measured height.
 * An interpolated cell (coverage 1) may be an extrapolation past the epoch's
 * own footprint, and differencing it against a measured cell reports the fill
 * as terrain change.
 */

function grid(z: number[], coverage: number[]): DtmGrid {
  const n = z.length;
  return {
    z: Float32Array.from(z),
    confidence: new Float32Array(n).fill(100),
    coverage: Uint8Array.from(coverage),
    counts: Uint32Array.from(coverage, (c) => (c === 2 ? 1 : 0)),
    interpDistanceCells: new Float32Array(n),
    cols: n,
    rows: 1,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
    crs: 'EPSG:32612',
    verticalDatum: 'EPSG:5703',
    coverageMode: 'full',
    sourcePointCount: n,
    analyzedPointCount: n,
    meanConfidence: 100,
    warnings: [],
  } as DtmGrid;
}

describe('dtmToChangeGrid', () => {
  it('keeps measured cells and carries interpolated and empty cells as NaN', () => {
    const cg = dtmToChangeGrid(grid([1, 2, 3], [2, 1, 0]));
    expect(cg.values[0]).toBe(1);
    expect(Number.isNaN(cg.values[1])).toBe(true);
    expect(Number.isNaN(cg.values[2])).toBe(true);
  });
});

describe('compareDtms on measured-only support', () => {
  // Cells: both measured, before interpolated, after interpolated, both
  // interpolated, before empty.
  const before = grid([0, 0, 0, 0, 0], [2, 1, 2, 1, 0]);
  const after = grid([1, 5, 5, 5, 5], [2, 2, 1, 1, 2]);

  it('differences only the cell measured in both epochs', () => {
    const cmp = compareDtms(before, after, { levelOfDetectionM: 0.1, horizontalUnitToMetres: 1 });
    expect(cmp.result.stats.comparable).toBe(1);
    expect(cmp.result.stats.rawNetVolumeM3).toBeCloseTo(1, 9);
  });

  it('counts the cells left out because one surface is interpolated', () => {
    const s = changeCellSupport(before, after);
    expect(s.measuredInBoth).toBe(1);
    expect(s.interpolatedExcluded).toBe(3);
    expect(s.interpolatedExcludedFraction).toBeCloseTo(0.75, 12);
  });

  it('states the excluded share in the summary', () => {
    const cmp = compareDtms(before, after, { levelOfDetectionM: 0.1, horizontalUnitToMetres: 1 });
    const text = summarizeChange(cmp, { horizontalUnitToMetres: 1, levelOfDetectionSupplied: true }).join('\n');
    expect(text).toContain('Compared only cells measured in both epochs. 3 cells (75%');
  });

  it('says nothing extra when every cell with a height is measured in both', () => {
    const a = grid([0, 0], [2, 2]);
    const b = grid([1, 1], [2, 2]);
    const text = summarizeChange(compareDtms(a, b, { levelOfDetectionM: 0.1 })).join('\n');
    expect(text).not.toContain('Compared only cells measured');
  });
});

describe('epochs of different extent over one identical surface', () => {
  const surf = (x: number, y: number): number => 3 * Math.sin(x / 9) + 2 * Math.cos(y / 7) + 0.02 * x;
  const cloud = (x1: number): EpochCloud => {
    const out: number[] = [];
    for (let x = 0; x <= x1; x++) for (let y = 0; y <= 100; y++) out.push(x, y, surf(x, y));
    return { positions: new Float32Array(out), crs: 'EPSG:32612', verticalDatum: 'NAVD88', linearUnitToMetres: 1 };
  };

  it('compares every cell of the shared footprint, none beyond it, and reports about zero change', () => {
    const d = buildSharedEpochDtms(cloud(100), cloud(130))!;
    // 1 m points: the shared cell is twice the mean spacing (about 2 m), so a
    // cell holds several returns instead of most cells being fill between them.
    expect(d.cellSizeM).toBeGreaterThan(1.9);
    expect(d.cellSizeM).toBeLessThan(2.2);
    const cmp = compareDtms(d.before, d.after, { horizontalUnitToMetres: 1, horizontalUnitKnown: true, levelOfDetectionM: 0.1 });
    const W = cmp.result.width;
    let beyond = 0, inside = 0, insideCompared = 0;
    for (let r = 0; r < cmp.result.height; r++) {
      for (let c = 0; c < W; c++) {
        const x = d.before.originH1 + (c + 0.5) * d.cellSizeM;
        const y = d.before.originH2 + (r + 0.5) * d.cellSizeM;
        const compared = Number.isFinite(cmp.result.diff[r * W + c]);
        if (x > 101) { if (compared) beyond++; continue; }
        if (x <= 100 && y <= 100) { inside++; if (compared) insideCompared++; }
      }
    }
    expect(beyond).toBe(0);
    // Every cell centred in the shared footprint is compared (2,450 of 2,450);
    // on the 0.5 m grid the extent rule gave, three cells in four were fill.
    expect(insideCompared / inside).toBeGreaterThan(0.99);
    // Before the measured-only rule 4,334 extrapolated cells were compared, for a raw net of 1,462 m³.
    expect(Math.abs(cmp.result.stats.rawNetVolumeM3)).toBeLessThan(1);
    expect(cmp.result.stats.meanAbsChangeM).toBeLessThan(0.01);
    // The earlier epoch carries no height past its own footprint at all, so
    // there is no extrapolated fringe left for the measured-only rule to drop.
    let beforeBeyond = 0;
    for (let r = 0; r < d.before.rows; r++) {
      for (let c = 0; c < d.before.cols; c++) {
        const x = d.before.originH1 + (c + 0.5) * d.cellSizeM;
        if (x > 102 && d.before.coverage[r * d.before.cols + c] > 0) beforeBeyond++;
      }
    }
    expect(beforeBeyond).toBe(0);
  });
});
