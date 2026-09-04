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
    // Routed through the shared helper so the gate and the session accessor
    // cannot disagree about what "stale" means.
    expect(body).toMatch(/_freshnessBreach\(\)/);
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

describe('the session manifest cannot embed a foreign or stale analysis', () => {
  it('the attributable accessor withholds what the gate would refuse', () => {
    const at = PANEL.indexOf('currentResultForProvenance(): AnalyseContoursResult | null');
    expect(at, 'attributable accessor missing').toBeGreaterThan(-1);
    expect(PANEL.slice(at, at + 200)).toMatch(/_freshnessBreach\(\) === null/);
  });

  it('keeps display and attribution as separate accessors', () => {
    // Conflating them made a refusal look like the panel had discarded the
    // user's analysis, which is a behaviour analysePanelScanIdentity pins.
    const at = PANEL.indexOf('currentResult(): AnalyseContoursResult | null');
    expect(at).toBeGreaterThan(-1);
    expect(PANEL.slice(at, at + 120)).toMatch(/return this\._result;/);
  });

  it('the session manifest reads the attributable accessor', () => {
    // Anchor on the assignment, not on the first mention of the manifest
    // builder — that one is the destructured serialize() parameter.
    const at = MAIN.indexOf('const analysed =');
    expect(at, 'session manifest source not found').toBeGreaterThan(-1);
    const block = MAIN.slice(at, at + 160);
    expect(block).toMatch(/currentResultForProvenance\(\)/);
    // The display accessor must never be the one that feeds provenance.
    expect(MAIN).not.toMatch(/const analysed = analysePanel\?\.currentResult\(\)/);
  });

  it('the gate and the accessor share one breach computation', () => {
    // Two computations could drift, and the accessor is the one with no UI to
    // reveal the drift.
    expect((PANEL.match(/analysisFreshnessBreach\(/g) ?? []).length).toBe(1);
    expect(PANEL).toMatch(/private _freshnessBreach\(\)/);
  });
});
