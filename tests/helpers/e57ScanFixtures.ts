/**
 * e57ScanFixtures.ts: hand-built `parseE57` results for specs that mock the
 * parser and pin the multi-scan merge in `loadE57` (loadE57Merge,
 * e57AcquisitionStations). Each spec still declares its own `vi.mock`.
 */
import type { E57ScanData, E57ParseResult } from '../../src/io/e57/parseE57';
import type { E57DecodePlan } from '../../src/io/loadPlan';

/**
 * A decode plan that reads every record. `parseE57` is mocked in the specs
 * using this, so the buffer they pass carries no declaration for the loader
 * to preflight; handing it the plan directly keeps the subject of each test
 * the merge and attribute logic. The loader refuses an E57 whose plan cannot
 * be established, which is what `tests/e57PreflightGuard.test.ts` covers.
 */
export const READ_EVERY_RECORD: E57DecodePlan = {
  mode: 'all',
  stride: 1,
  sourceCount: 0,
  decodedCount: 0,
  memoryEstimateBytes: 0,
  fullDecodeEstimateBytes: 0,
  ceilingBytes: 0,
  fits: true,
};

/** Minimal scan builder: only the fields the merge actually consumes. */
export function scan(
  name: string,
  recordCount: number,
  columns: Record<string, Float64Array>,
  pose: E57ScanData['pose'] = null,
): E57ScanData {
  return {
    name,
    guid: `guid-${name}`,
    recordCount,
    declaredRecordCount: recordCount,
    columns,
    fields: [],
    pose,
    colorMax: null,
    intensityMax: null,
  };
}

export function parseResult(scans: E57ScanData[]): E57ParseResult {
  return {
    scans,
    metadata: { formatName: 'ASTM E57 3D Imaging Data File', guid: 'g', library: 'test-lib', creationDateTime: null },
    sourceMetadata: null,
    warnings: [],
  };
}
