/**
 * analysisStatus.test.ts
 *
 * The Analyse home rows come from Process Studio's own verdicts: the product
 * authority (preflight where it answers, else ProcessService), the produced
 * set the terrain run writes, and the independent QA checks. A blocked lab
 * row offers the Terrain page as its fix.
 */

import { describe, it, expect } from 'vitest';
import type { ProductId, ScanFacts } from '../src/process/ProcessPlan';
import type { CrsInfo } from '../src/io/crs';
import { ProcessService } from '../src/process/ProcessService';
import {
  analysisRows,
  contoursStatus,
  productVerdict,
  capByRun,
  PREPARE_TERRAIN,
  type AnalysisStatusInput,
} from '../src/process/analysisStatus';
import type { PreflightView } from '../src/app/toolPreflightRuntime';
import type { ToolPreflight } from '../src/process/toolPreflight';

const metreCrs = { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, verticalDatum: 'NAVD88' } as unknown as CrsInfo;
const facts: ScanFacts = {
  kind: 'static', coverage: 'full', crs: metreCrs, pointCount: 1_000_000,
  hasRgb: false, hasIntensity: false, hasGpsTime: false, hasReturnNumber: false, hasPointSourceId: false,
  classification: 'full', classificationProvenance: 'producer', groundClassified: true, hasBuildingClass: false,
} as ScanFacts;

function input(over: Partial<AnalysisStatusInput> = {}): AnalysisStatusInput {
  return { facts, view: undefined, produced: new Set<ProductId>(), hasRange: false, hasFeatures: false, ...over };
}
const byId = (rows: ReturnType<typeof analysisRows>, id: string) => rows.find((r) => r.id === id)!;

describe('analysisRows', () => {
  it('lists the five analyses in order, plus scan-dependent entries only when present', () => {
    expect(analysisRows(input()).map((r) => r.id)).toEqual(['terrain', 'flow-pulse', 'terrain-access', 'observatory', 'objects']);
    expect(analysisRows(input({ hasFeatures: true, hasRange: true })).map((r) => r.id).slice(5)).toEqual(['features', 'range']);
  });

  it('Terrain takes the DTM verdict Process Studio shows', () => {
    const svc = ProcessService.fromFacts([facts]);
    const t = byId(analysisRows(input()), 'terrain');
    expect(t.status).toBe(svc.readiness('dtm'));
    expect(t.label).toBe('Terrain');
    expect(t.reason.length).toBeGreaterThan(0);
  });

  it('the preflight is the authority where it answers, reason and all', () => {
    const pre: ToolPreflight = {
      tool: 'terrain-dtm', status: 'blocked',
      reasons: [{ message: 'The linear unit is unknown.' } as ToolPreflight['reasons'][number]],
      remediations: [{ action: 'set-coordinate-system', label: 'Set coordinate system' }],
    };
    const view: PreflightView = { products: new Map([['dtm', pre]]), measureTools: [] };
    expect(productVerdict(facts, view, 'dtm')).toMatchObject({ status: 'blocked', reason: 'The linear unit is unknown.' });
    // The remedy is offered only when the app can carry it out.
    expect(byId(analysisRows(input({ view })), 'terrain').remedy).toBeNull();
    const t = byId(analysisRows(input({ view, canRemediate: () => true })), 'terrain');
    expect(t).toMatchObject({ status: 'blocked', reason: 'The linear unit is unknown.' });
    expect(t.remedy).toEqual({ kind: 'preflight', action: 'set-coordinate-system', tool: 'terrain-dtm', label: 'Set coordinate system' });
  });

  it('blocks both labs until a terrain run produced the DTM, with Prepare terrain as the fix', () => {
    for (const id of ['flow-pulse', 'terrain-access']) {
      const r = byId(analysisRows(input()), id);
      expect(r.status).toBe('blocked');
      expect(r.remedy).toEqual(PREPARE_TERRAIN);
      const after = byId(analysisRows(input({ produced: new Set<ProductId>(['dtm', 'contours']) })), id);
      expect(after.status).toBe(ProcessService.fromFacts([facts]).readiness('dtm'));
      expect(after.remedy).toBeNull();
    }
  });

  it('Observatory follows the coverage check and blocks a streaming scan', () => {
    expect(byId(analysisRows(input()), 'observatory').status).toBe('ready');
    expect(byId(analysisRows(input({ facts: { ...facts, coverage: 'sampled' } })), 'observatory').status).toBe('review');
    const s = byId(analysisRows(input({ facts: { ...facts, kind: 'streaming', coverage: 'resident-only' } })), 'observatory');
    expect(s.status).toBe('blocked');
    expect(s.reason).toMatch(/resident set/);
  });

  it('Objects & Space reads review without a known linear unit', () => {
    expect(byId(analysisRows(input()), 'objects').status).toBe('ready');
    expect(byId(analysisRows(input({ facts: { ...facts, crs: null } })), 'objects').status).toBe('review');
  });

  it('every row is blocked with no scan, and offers nothing', () => {
    for (const r of analysisRows(input({ facts: null }))) {
      expect(r).toMatchObject({ status: 'blocked', reason: 'Load a scan first.', remedy: null });
    }
  });

  it('a remedy is only ever offered on a blocked row without a run cap', () => {
    for (const r of analysisRows(input({ produced: new Set<ProductId>(['dtm']) }))) {
      if (r.status !== 'blocked') expect(r.remedy).toBeNull();
    }
  });

  it('Contours read blocked until produced, then take the contours verdict', () => {
    expect(contoursStatus(input())).toMatchObject({ status: 'blocked', remedy: PREPARE_TERRAIN });
    const done = contoursStatus(input({ produced: new Set<ProductId>(['dtm', 'contours']) }));
    expect(done.status).toBe(ProcessService.fromFacts([facts]).readiness('contours'));
  });

  it('Range frames states the grid is present rather than a readiness', () => {
    const r = byId(analysisRows(input({ hasRange: true })), 'range');
    expect(r.status).toBe('present');
  });
});

describe('Terrain status: the more restrictive of Process Studio and the run', () => {
  const V = 'Run verdict.';
  const cases: Array<[string, 'Good' | 'Preview' | 'Limited' | 'Blocked', string, boolean]> = [
    ['ready', 'Good', 'ready', false],
    ['ready', 'Preview', 'review', true],
    ['ready', 'Limited', 'review', true],
    ['ready', 'Blocked', 'blocked', true],
    ['review', 'Good', 'review', false],
    ['review', 'Limited', 'review', true],
    ['review', 'Blocked', 'blocked', true],
    ['blocked', 'Good', 'blocked', false],
    ['blocked', 'Limited', 'blocked', false],
    ['blocked', 'Blocked', 'blocked', true],
  ];
  for (const [ps, tier, want, byRun] of cases) {
    it(`Process Studio ${ps} + run ${tier} reads ${want}`, () => {
      const out = capByRun({ status: ps as 'ready', reason: 'Studio reason.' }, { tier, verdict: V });
      expect(out.status).toBe(want);
      expect(out.reason).toBe(byRun ? V : 'Studio reason.');
    });
  }

  it('no run: Process Studio alone, and a run is ignored until a DTM is produced', () => {
    expect(capByRun({ status: 'ready', reason: 'x' }, null)).toMatchObject({ status: 'ready', reason: 'x' });
    const run = { tier: 'Blocked' as const, verdict: 'Not usable for terrain products as-is.' };
    expect(byId(analysisRows(input({ terrainRun: run })), 'terrain').status).toBe(ProcessService.fromFacts([facts]).readiness('dtm'));
    const after = byId(analysisRows(input({ terrainRun: run, produced: new Set<ProductId>(['dtm', 'contours']) })), 'terrain');
    expect(after).toMatchObject({ status: 'blocked', reason: 'Not usable for terrain products as-is.', remedy: null });
    expect(contoursStatus(input({ terrainRun: run, produced: new Set<ProductId>(['dtm', 'contours']) })).status).toBe('blocked');
  });

  const produced = new Set<ProductId>(['dtm', 'contours']);
  for (const id of ['flow-pulse', 'terrain-access']) {
    for (const [tier, want] of [['Good', null], ['Preview', 'review'], ['Limited', 'review'], ['Blocked', 'blocked']] as const) {
      it(`${id} after a ${tier} run reads ${want ?? 'as Process Studio says'}`, () => {
        const r = byId(analysisRows(input({ produced, terrainRun: { tier, verdict: 'V.' } })), id);
        const ps = ProcessService.fromFacts([facts]).readiness('dtm');
        if (want === null) {
          expect(r.status).toBe(ps);
          expect(r.reason.startsWith('Terrain run:')).toBe(false);
        } else {
          expect(r.status).toBe(want);
          expect(r.reason).toBe('Terrain run: V.');
          expect(r.remedy).toEqual(PREPARE_TERRAIN);
        }
        // Never better-looking than Terrain itself.
        const t = byId(analysisRows(input({ produced, terrainRun: { tier, verdict: 'V.' } })), 'terrain');
        const rank = { ready: 0, review: 1, blocked: 2 } as const;
        expect(rank[r.status as 'ready']).toBeGreaterThanOrEqual(rank[t.status as 'ready']);
      });
    }
  }
});
