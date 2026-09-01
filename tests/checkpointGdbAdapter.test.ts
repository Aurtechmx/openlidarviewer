/**
 * checkpointGdbAdapter.test.ts — unit tests for the 3DEP checkpoint adapter
 * (tests/support/checkpointGdb.ts): the fail-closed prerequisite gate, MAE,
 * and the CSV/extent/CRS helpers it is built from. No I/O, no GDAL calls.
 */
import { describe, it, expect } from 'vitest';
import {
  checkpointPrerequisites,
  withinTileExtent,
  crsMatchesTile,
  toAccuracyCheckpoints,
  meanAbsoluteError,
  runCheckpointStudy,
  MIN_CHECKPOINT_SAMPLE_SIZE,
  INDEPENDENCE_NOT_ESTABLISHED,
  type RawCheckpointRow,
  type TileFrame,
  type IndependenceProvenance,
} from './support/checkpointGdb';
import { referenceSigmaFromUncertainty } from '../src/validation/checkpointAccuracy';

/** Provenance marking a whole set of rows externally-confirmed independent. */
function allIndependent(rows: readonly RawCheckpointRow[]): IndependenceProvenance {
  return { independentIds: new Set(rows.map((r) => r.unique_identifier)) };
}

const TILE: TileFrame = {
  horizontalEpsg: 6339,
  verticalEpsg: 5703,
  minX: 437000,
  maxX: 438000,
  minY: 4646000,
  maxY: 4647000,
};

function row(overrides: Partial<RawCheckpointRow> = {}): RawCheckpointRow {
  return {
    unique_identifier: 'CKPT-1',
    point_type: 'NVA',
    source_easting: '437500',
    source_northing: '4646500',
    source_elevation: '1000.000',
    source_horizontal_epsg: '6339',
    source_vertical_epsg: '5703',
    accuracy: '0.05',
    project_id: '182543',
    ...overrides,
  };
}

/** A full sample of MIN_CHECKPOINT_SAMPLE_SIZE well-formed, in-extent, matching-CRS rows. */
function goodSample(n: number = MIN_CHECKPOINT_SAMPLE_SIZE): RawCheckpointRow[] {
  const rows: RawCheckpointRow[] = [];
  for (let i = 0; i < n; i++) {
    // Spread points across the tile deterministically so extent membership is exact.
    const x = TILE.minX + 100 + i * 5;
    const y = TILE.minY + 100 + i * 5;
    rows.push(
      row({
        unique_identifier: `CKPT-${i}`,
        source_easting: String(x),
        source_northing: String(y),
        source_elevation: String(1000 + i),
      }),
    );
  }
  return rows;
}

describe('withinTileExtent / crsMatchesTile', () => {
  it('accepts a point strictly inside the bounds', () => {
    expect(withinTileExtent(row(), TILE)).toBe(true);
  });

  it('rejects a point outside the bounds', () => {
    expect(withinTileExtent(row({ source_easting: '999999', source_northing: '999999' }), TILE)).toBe(
      false,
    );
  });

  it('rejects non-numeric coordinates', () => {
    expect(withinTileExtent(row({ source_easting: 'nan' }), TILE)).toBe(false);
  });

  it('matches only when both horizontal and vertical EPSG agree', () => {
    expect(crsMatchesTile(row(), TILE)).toBe(true);
    expect(crsMatchesTile(row({ source_horizontal_epsg: '4326' }), TILE)).toBe(false);
    expect(crsMatchesTile(row({ source_vertical_epsg: '5701' }), TILE)).toBe(false);
  });
});

describe('checkpointPrerequisites — fail-closed gate', () => {
  it('reports ok:true over a full, well-formed sample at the minimum size', () => {
    const result = checkpointPrerequisites(goodSample(), TILE);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.usable.length).toBe(MIN_CHECKPOINT_SAMPLE_SIZE);
  });

  it('fails closed with 0 checkpoints in the tile extent (the Rogue-tile case)', () => {
    const rows = [row({ source_easting: '0', source_northing: '0' })];
    const result = checkpointPrerequisites(rows, TILE);
    expect(result.ok).toBe(false);
    expect(result.usable.length).toBe(0);
    expect(result.reasons.some((r) => r.includes('fall inside the tile extent'))).toBe(true);
  });

  it('fails closed when in-extent checkpoints carry a mismatched CRS', () => {
    const rows = goodSample().map((r) => ({ ...r, source_horizontal_epsg: '4326' }));
    const result = checkpointPrerequisites(rows, TILE);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("share the tile's"))).toBe(true);
  });

  it('fails closed when checkpoints lack a stated accuracy value', () => {
    const rows = goodSample().map((r) => ({ ...r, accuracy: '' }));
    const result = checkpointPrerequisites(rows, TILE);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('accuracy/uncertainty value'))).toBe(true);
  });

  it('fails closed when checkpoints lack a point_type', () => {
    const rows = goodSample().map((r) => ({ ...r, point_type: '' }));
    const result = checkpointPrerequisites(rows, TILE);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('point_type'))).toBe(true);
  });

  it('fails closed below MIN_CHECKPOINT_SAMPLE_SIZE even when every other gate passes', () => {
    const rows = goodSample(MIN_CHECKPOINT_SAMPLE_SIZE - 1);
    const result = checkpointPrerequisites(rows, TILE);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('MIN_CHECKPOINT_SAMPLE_SIZE'))).toBe(true);
  });

  it('lists every failing reason at once, not just the first', () => {
    // accuracy missing cascades (point_type is only checked among rows that
    // already have an accuracy value), so this hits: missing accuracy, AND
    // below minimum sample size — both reported together, not just the first.
    const rows = goodSample(3).map((r) => ({ ...r, accuracy: '' }));
    const result = checkpointPrerequisites(rows, TILE);
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.reasons.some((r) => r.includes('accuracy/uncertainty value'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('MIN_CHECKPOINT_SAMPLE_SIZE'))).toBe(true);
  });
});

describe('meanAbsoluteError', () => {
  it('matches a hand-computed value: residuals [1, -2, 3, -4] -> mean(|r|) = (1+2+3+4)/4 = 2.5', () => {
    expect(meanAbsoluteError([1, -2, 3, -4])).toBeCloseTo(2.5, 12);
  });

  it('returns null for an empty residual set', () => {
    expect(meanAbsoluteError([])).toBeNull();
  });
});

describe('toAccuracyCheckpoints — independence, uncertainty meaning, coverage', () => {
  it('does not treat an NVA/VVA row as independent without external provenance', () => {
    // point_type is NVA (an accuracy-type label); no provenance is supplied.
    const rows = [row({ point_type: 'NVA' })];
    const measured = new Map([[rows[0].unique_identifier, 1000.02]]);
    const { checkpoints } = toAccuracyCheckpoints(rows, measured);
    expect(checkpoints[0].usage).not.toBe('independent');
    expect(checkpoints[0].usage).toBe(INDEPENDENCE_NOT_ESTABLISHED);
  });

  it('marks a checkpoint independent only when provenance names it', () => {
    const rows = [row()];
    const measured = new Map([[rows[0].unique_identifier, 1000.02]]);
    const { checkpoints } = toAccuracyCheckpoints(rows, measured, {
      independence: allIndependent(rows),
    });
    expect(checkpoints[0].usage).toBe('independent');
  });

  it('wraps the accuracy value with meaning unknown by default (no 1-sigma sigma)', () => {
    const rows = [row({ accuracy: '0.07' })];
    const measured = new Map([[rows[0].unique_identifier, 1000.02]]);
    const { checkpoints } = toAccuracyCheckpoints(rows, measured);
    const u = checkpoints[0].referenceUncertainty;
    expect(u?.valueMetres).toBeCloseTo(0.07, 12);
    expect(u?.meaning).toBe('unknown');
    // The engine must not fabricate a sigma from an unknown-meaning value.
    expect(referenceSigmaFromUncertainty(u!)).toBeNull();
    // The legacy 1-sigma field is no longer asserted from an unlabelled value.
    expect(checkpoints[0].referenceSigma).toBeUndefined();
  });

  it('carries a caller-stated 95-percent meaning through so a sigma can be recovered', () => {
    const rows = [row({ accuracy: '0.098' })];
    const measured = new Map([[rows[0].unique_identifier, 1000.02]]);
    const { checkpoints } = toAccuracyCheckpoints(rows, measured, { accuracyMeaning: '95-percent' });
    const u = checkpoints[0].referenceUncertainty;
    expect(u?.meaning).toBe('95-percent');
    expect(referenceSigmaFromUncertainty(u!)).toBeCloseTo(0.098 / 1.96, 12);
  });

  it('counts an unpredicted row in the coverage ledger rather than dropping it silently', () => {
    const rows = goodSample(2);
    const measured = new Map([[rows[0].unique_identifier, 1000.1]]); // rows[1] absent
    const { checkpoints, ledger } = toAccuracyCheckpoints(rows, measured);
    // The unpredicted row still forms no comparison...
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0].id).toBe(rows[0].unique_identifier);
    // ...but it is COUNTED, not vanished: eligible = 2, predicted = 1.
    expect(ledger.eligible).toBe(2);
    expect(ledger.predicted).toBe(1);
    expect(ledger.unpredicted).toBe(1);
  });
});

describe('runCheckpointStudy — end to end', () => {
  it('reports full pooled statistics when every gate passes and independence is established', () => {
    const rows = goodSample();
    // measured = reference + 0.1 for every checkpoint -> bias should be exactly 0.1
    const measured = new Map(rows.map((r) => [r.unique_identifier, Number(r.source_elevation) + 0.1]));
    const { prereq, result, mae, coverage, predictionCoverage } = runCheckpointStudy(rows, TILE, measured, {
      independence: allIndependent(rows),
    });
    expect(prereq.ok).toBe(true);
    expect(result?.status).toBe('reported');
    if (result?.status === 'reported') {
      expect(result.pooled.n).toBe(MIN_CHECKPOINT_SAMPLE_SIZE);
      expect(result.pooled.bias).toBeCloseTo(0.1, 9);
      expect(result.pooled.rmse).toBeCloseTo(0.1, 9);
      // Accuracy field left at its default unknown meaning: no reference sigma,
      // so no combined RMSE is fabricated.
      expect(result.pooled.referenceUncertaintyState).toBe('not-established');
      expect(result.pooled.referenceRmse).toBeNull();
      expect(result.pooled.combinedRmse).toBeNull();
    }
    expect(mae).toBeCloseTo(0.1, 9);
    expect(coverage.eligible).toBe(MIN_CHECKPOINT_SAMPLE_SIZE);
    expect(coverage.predicted).toBe(MIN_CHECKPOINT_SAMPLE_SIZE);
    expect(predictionCoverage).toBe(1);
  });

  it('refuses (unknown-usage) rather than reporting when independence is not established', () => {
    const rows = goodSample();
    const measured = new Map(rows.map((r) => [r.unique_identifier, Number(r.source_elevation) + 0.1]));
    const { prereq, result } = runCheckpointStudy(rows, TILE, measured);
    expect(prereq.ok).toBe(true);
    expect(result?.status).toBe('refused');
    if (result?.status === 'refused') {
      expect(result.reason).toBe('unknown-usage');
    }
  });

  it('surfaces prediction coverage on a mixed covered/uncovered sample', () => {
    // Every gate passes (all rows in extent, matching CRS, accuracy + point_type),
    // and independence is established, but the product predicted only half of them.
    const rows = goodSample(MIN_CHECKPOINT_SAMPLE_SIZE);
    const predictedRows = rows.slice(0, MIN_CHECKPOINT_SAMPLE_SIZE / 2);
    const measured = new Map(
      predictedRows.map((r) => [r.unique_identifier, Number(r.source_elevation) + 0.1]),
    );
    const { coverage, predictionCoverage } = runCheckpointStudy(rows, TILE, measured, {
      independence: allIndependent(rows),
    });
    expect(coverage.eligible).toBe(MIN_CHECKPOINT_SAMPLE_SIZE);
    expect(coverage.predicted).toBe(MIN_CHECKPOINT_SAMPLE_SIZE / 2);
    expect(coverage.unpredicted).toBe(MIN_CHECKPOINT_SAMPLE_SIZE / 2);
    expect(predictionCoverage).toBeCloseTo(0.5, 12);
    expect(predictionCoverage).toBe(coverage.predicted / coverage.eligible);
  });

  it('fails closed with result:null and mae:null on the 0-in-extent case', () => {
    const rows = [row({ source_easting: '0', source_northing: '0' })];
    const { prereq, result, mae, coverage, predictionCoverage } = runCheckpointStudy(rows, TILE, new Map());
    expect(prereq.ok).toBe(false);
    expect(result).toBeNull();
    expect(mae).toBeNull();
    expect(coverage.eligible).toBe(0);
    expect(predictionCoverage).toBeNull();
  });
});
