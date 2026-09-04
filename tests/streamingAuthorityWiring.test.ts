/**
 * Production-wiring regressions for the streaming identity seam.
 *
 * `ScanService.activeExportTargetId()` was added because a streaming scan
 * leaves `activeId` null, so a streaming A → B swap compared null with null and
 * every guard built on `activeId` saw no change. The seam existed and three
 * consumers had not adopted it, which a unit test of the seam itself cannot
 * catch — the defect was in the composition root.
 *
 * Source-level, like the wiring test that caught the object-metrics regression:
 * the bug was that main.ts passed the wrong fact, so main.ts is what to assert.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const MAIN = strip(readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8'));
const RUNNER = strip(
  readFileSync(resolve(__dirname, '../src/app/terrainAnalysisRunner.ts'), 'utf8'),
);

describe('streaming identity reaches the guards that need it', () => {
  it('the session export compares export-target ids, not raw active ids', () => {
    const at = MAIN.indexOf('requestedScanId:');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, at + 240);
    expect(block).toMatch(/requestedScanId:\s*scans\.activeExportTargetId\(\)/);
    expect(block).toMatch(/activeScanId:\s*\(\)\s*=>\s*scans\.activeExportTargetId\(\)/);
    expect(block).not.toMatch(/requestedScanId:\s*scans\.activeId\b/);
  });

  it('the terrain runner is wired to the export-target id', () => {
    const at = MAIN.indexOf('getAnalysePanel:');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, at + 320);
    expect(block).toMatch(/getActiveId:\s*\(\)\s*=>\s*scans\.activeExportTargetId\(\)/);
  });
});

describe('Contour Studio is told the coverage the result actually recorded', () => {
  it('derives the streaming flag from the result, never a literal', () => {
    const at = RUNNER.indexOf('setContourFrame({');
    expect(at).toBeGreaterThan(-1);
    const block = RUNNER.slice(at, at + 260);
    // The launcher caps a streaming frame to exploratory. Hardcoding false told
    // it a resident-only analysis was a complete scan.
    expect(block).not.toMatch(/streaming:\s*false/);
    expect(block).toMatch(/streaming:\s*result\.dtm\.coverageMode === 'resident-only'/);
  });
});
