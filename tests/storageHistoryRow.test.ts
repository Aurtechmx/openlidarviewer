/**
 * tests/storageHistoryRow.test.ts
 *
 * The "Storage history" row: its wording for a supported grid, for none detected and for a
 * test that did not run, the figures its detail carries, and its place in the static and the
 * streaming scan report.
 */
import { describe, expect, it } from 'vitest';
import { formatGridStep, storageHistoryRow, STORAGE_HISTORY_METHOD_TAG, type StorageHistoryOutcome } from '../src/analysis/storageHistoryRow';
import { STORAGE_HISTORY_METHOD_ID } from '../src/science/storageHistory';
import { methodRef, methodTag } from '../src/science/methodRegistry';
import { scanReport } from '../src/analysis/modules/scanReport';
import { runStreamingModules } from '../src/app/streamingScanReport';
import { PointCloud } from '../src/model/PointCloud';
import { spatialContextFrom } from '../src/geo/SpatialContext';

const SUPPORTED: StorageHistoryOutcome = {
  kind: 'supported',
  step: 0.01,
  unit: 'ft',
  rotationDeg: 12,
  pJoint: 3.1e-6,
  pBonferroni: 9.6e-5,
  amplitudeRatio: 0.97,
  candidatesTested: 31,
  supportedCount: 1,
  windows: 20,
  points: 12_000,
};

const CERTAINTY = /\b(certain|certainly|definitely|proves?|proven|confirms?|confirmed|guarantee[ds]?)\b/i;

describe('storageHistoryRow', () => {
  it('names a supported grid with its step, unit and rotation', () => {
    const row = storageHistoryRow(SUPPORTED);
    expect(row.label).toBe('Storage history');
    expect(row.value).toBe('coordinates supported on a 0.01 ft grid rotated 12°');
    expect(row.status).toBe('info');
  });
  it('leaves the rotation out of the file frame and shows source units when the unit is not declared', () => {
    expect(storageHistoryRow({ ...SUPPORTED, unit: 'm', rotationDeg: 0 }).value).toBe('coordinates supported on a 0.01 m grid');
    expect(storageHistoryRow({ ...SUPPORTED, unit: 'source', rotationDeg: 0, step: 0.1 }).value)
      .toBe('coordinates supported on a 0.1 source-unit grid');
  });
  it('carries p before and after Bonferroni and the amplitude ratio in the detail, without a certainty word', () => {
    const row = storageHistoryRow(SUPPORTED);
    expect(row.detail).toContain('p 3.1e-6');
    expect(row.detail).toContain('9.6e-5 after Bonferroni over 31 tested candidate grids');
    expect(row.detail).toContain('amplitude ratio 0.97');
    expect(row.detail).toContain('20 windows, 12,000 points');
    expect(row.detail).toContain('compatible with');
    expect(row.detail).toContain('olv.storage.grid-history@1');
    for (const o of [SUPPORTED, { kind: 'none', candidatesTested: 31, windows: 20, points: 12_000 } as const]) {
      const r = storageHistoryRow(o);
      expect(`${r.value} ${r.detail}`).not.toMatch(CERTAINTY);
    }
  });
  it('says none detected, and why a test did not run', () => {
    const none = storageHistoryRow({ kind: 'none', candidatesTested: 31, windows: 20, points: 12_000 });
    expect(none.value).toBe('none detected');
    expect(none.detail).toContain('31 tested candidate grids');
    expect(storageHistoryRow({ kind: 'not-tested', reason: 'streamed scan' }).value).toBe('not tested (streamed scan)');
    expect(storageHistoryRow({ kind: 'not-tested', reason: 'too few points' }).value).toBe('not tested (too few points)');
    expect(storageHistoryRow({ kind: 'running' }).value).toBe('test running');
  });
  it('cites the method at the version the registry declares', () => {
    expect(STORAGE_HISTORY_METHOD_TAG).toBe(methodTag(methodRef(STORAGE_HISTORY_METHOD_ID)));
  });
  it('formats grid steps without trailing zeros', () => {
    expect(formatGridStep(0.01)).toBe('0.01');
    expect(formatGridStep(0.1 * 1200 / 3937)).toBe('0.03048');
    expect(formatGridStep(1)).toBe('1');
  });
});

function cloud(): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 1]),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'row-fixture',
  });
}

describe('the row in the scan reports', () => {
  it('appears in the static report only when the shell threads an outcome in', () => {
    const without = scanReport.run(cloud()).rows.find((r) => r.label === 'Storage history');
    expect(without).toBeUndefined();
    const rows = scanReport.run(cloud(), undefined, { storageHistory: SUPPORTED }).rows;
    const row = rows.find((r) => r.label === 'Storage history');
    expect(row?.value).toBe('coordinates supported on a 0.01 ft grid rotated 12°');
    const labels = rows.map((r) => r.label);
    expect(labels.indexOf('Storage history')).toBeGreaterThan(labels.indexOf('In-memory resolution'));
    expect(labels.indexOf('Storage history')).toBeLessThan(labels.indexOf('RGB'));
  });
  it('reads not tested (streamed scan) in the streaming report', () => {
    const ctx = spatialContextFrom({ source: 'epsg', name: 'EPSG:32610', isGeographic: false, linearUnit: 'metre', linearUnitToMetres: 1 });
    const rows = runStreamingModules({ kind: 'copc', name: 'stream.copc', sourcePointCount: 1000 }, ctx);
    expect(rows.find((r) => r.label === 'Storage history')?.value).toBe('not tested (streamed scan)');
  });
});
