/**
 * The freshness stamp has to be MINTED with the result and CHECKED at the
 * export gate. A pure test of `analysisFreshnessBreach` cannot see either.
 *
 * The defect was never in the comparison — there was no comparison. The panel
 * checked scan identity alone, so an edited classification or a changed CRS
 * exported behind a caveat, and the composition root never supplied the two
 * facts that would have caught it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const PANEL = strip(readFileSync(resolve(__dirname, '../src/ui/AnalysePanel.ts'), 'utf8'));
const MAIN = strip(readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8'));
const CRS = strip(readFileSync(resolve(__dirname, '../src/geo/CrsService.ts'), 'utf8'));

describe('the stamp is minted where the result is', () => {
  it('update() records all four facts, not just the scan', () => {
    const at = PANEL.indexOf('_resultStamp = result');
    expect(at, 'stamp never minted').toBeGreaterThan(-1);
    const block = PANEL.slice(at, at + 420);
    expect(block).toMatch(/targetId:/);
    expect(block).toMatch(/classificationEpoch:/);
    expect(block).toMatch(/crsRevision:/);
    expect(block).toMatch(/coverageMode:/);
  });
});

describe('the export gate checks the stamp, not scan identity alone', () => {
  it('refuses via analysisFreshnessBreach', () => {
    const at = PANEL.indexOf('_refuseForeignScanExport()');
    expect(at).toBeGreaterThan(-1);
    const body = PANEL.slice(at, at + 700);
    expect(body).toMatch(/analysisFreshnessBreach\(/);
    expect(body).toMatch(/FRESHNESS_REFUSALS\[/);
    // The old gate returned false on a same-scan comparison alone.
    expect(body).not.toMatch(/if \(sameExportTarget\([^)]*\)\) return false;/);
  });
});

describe('the composition root supplies the facts the stamp needs', () => {
  it('passes a classification epoch and a CRS revision to the panel', () => {
    const at = MAIN.indexOf('getFeatureCloud:');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, at + 400);
    expect(block).toMatch(/activeClassificationEpoch:/);
    expect(block).toMatch(/crsRevision:\s*\(\)\s*=>\s*crsService\.crsRevision\(\)/);
  });

  it('the revision advances on the single CRS mutation seam', () => {
    // If the bump moved off _setCurrent, some override path would stop
    // invalidating and the gate would silently pass on a changed frame.
    const at = CRS.indexOf('private _setCurrent(');
    expect(at).toBeGreaterThan(-1);
    expect(CRS.slice(at, at + 400)).toMatch(/_crsRevision \+= 1;/);
  });
});
