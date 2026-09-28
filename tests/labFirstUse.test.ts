/**
 * labFirstUse.test.ts — the first-use guide the three labs share: the
 * readiness rule, the Observatory's no-station row, and the copy each lab and
 * its Analyse home row show (purpose, stages, legend, how to read, method
 * details). Values and methods are untouched; these pin presentation only.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import { flowDtmOfCounted as dtmOf } from './helpers/flowFixtures';
import type { ProductId, ScanFacts } from '../src/process/ProcessPlan';
import type { CrsInfo } from '../src/io/crs';

beforeAll(() => {
  installRecordingDom();
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
});

const copy = await import('../src/process/labGuideCopy');
const { analysisRows } = await import('../src/process/analysisStatus');
const { renderFlowPulseLab, renderFlowPulseNeedsGround, runLabFlowPulse } = await import('../src/ui/fieldSimulation/flowPulseLab');
const { renderTerrainAccessRunCard, terrainAccessReadiness } = await import('../src/ui/fieldSimulation/terrainAccessLab');
const { renderObservatoryPanel } = await import('../src/ui/observatory/observatoryPanel');
const { runObservatoryOverCloud } = await import('../src/app/observatoryFromCloud');
const { wallAndGroundCloud } = await import('./helpers/observatoryPlanningFixtures');

const text = (n: HTMLElement): string => (n as unknown as RecordingEl).textContent;
const rec = (n: HTMLElement): RecordingEl => n as unknown as RecordingEl;

const metreCrs = { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, verticalDatum: 'NAVD88' } as unknown as CrsInfo;
const facts = {
  kind: 'static', coverage: 'full', crs: metreCrs, pointCount: 1_000_000,
  hasRgb: false, hasIntensity: false, hasGpsTime: false, hasReturnNumber: false, hasPointSourceId: false,
  classification: 'full', classificationProvenance: 'producer', groundClassified: true, hasBuildingClass: false,
} as ScanFacts;
const baseInput = (over: object = {}) => ({ facts, view: undefined, produced: new Set<ProductId>(), hasRange: false, hasFeatures: false, ...over });

describe('purpose lines', () => {
  it('are the agreed plain sentences', () => {
    expect(copy.LAB_PURPOSE['flow-pulse']).toBe('See which way water would run downhill over the ground surface, and which area drains to a point. Counts cells, not rainfall.');
    expect(copy.LAB_PURPOSE['terrain-access']).toBe('Screen a possible route over the ground for a vehicle or walker you describe. Not a safety guarantee.');
    expect(copy.LAB_PURPOSE.observatory).toBe('Shows what the scanner saw from each setup, what was hidden behind objects, and where another setup would help.');
  });

  it('each lab has three to five numbered stages', () => {
    for (const stages of Object.values(copy.LAB_STAGES)) {
      expect(stages.length).toBeGreaterThanOrEqual(3);
      expect(stages.length).toBeLessThanOrEqual(5);
    }
  });
});

describe('readiness', () => {
  it('a missing ground surface blocks both labs, and units are not checked yet', () => {
    for (const lab of ['flow-pulse', 'terrain-access'] as const) {
      const items = copy.labReadiness(lab, false, false);
      expect(copy.firstBlocker(items)?.label).toBe('Ground surface (terrain run)');
      expect(items[1]!.note).toBe('Checked once the ground surface exists.');
    }
  });

  it('unknown units block Terrain Access but only withhold areas in Flow Pulse', () => {
    expect(copy.firstBlocker(copy.labReadiness('terrain-access', true, false))?.label).toBe('Units known');
    const flow = copy.labReadiness('flow-pulse', true, false);
    expect(copy.firstBlocker(flow)).toBeNull();
    expect(flow[1]!.met).toBe(false);
    expect(flow[1]!.note).toContain('areas are withheld');
  });

  it('everything met: no blocker', () => {
    expect(copy.firstBlocker(copy.labReadiness('terrain-access', true, true))).toBeNull();
  });

  it('Terrain Access reads units the way its runner does', () => {
    const dtm = { verticalUnitToMetres: 1 } as never;
    const scale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
    const ok = { dtm, scale, layerId: null, filename: null };
    expect(copy.firstBlocker(terrainAccessReadiness(ok))).toBeNull();
    expect(copy.firstBlocker(terrainAccessReadiness({ ...ok, scale: { ...scale, resolved: false } }))?.label).toBe('Units known');
    expect(copy.firstBlocker(terrainAccessReadiness({ ...ok, scale: { ...scale, isGeographic: true } }))?.label).toBe('Units known');
    expect(copy.firstBlocker(terrainAccessReadiness({ ...ok, dtm: { verticalUnitToMetres: null } as never }))?.label).toBe('Units known');
    expect(copy.firstBlocker(terrainAccessReadiness(null))?.label).toBe('Ground surface (terrain run)');
  });

  it('shows a grade in degrees next to its tangent', () => {
    expect(copy.tangentToDegrees(1)).toBe('45.0°');
    expect(copy.tangentToDegrees(0)).toBe('0.0°');
  });
});

describe('Observatory row', () => {
  const obs = (over: object) => analysisRows(baseInput(over)).find((r) => r.id === 'observatory')!;

  it('a scan with no declared stations is never Ready', () => {
    const r = obs({ hasStations: false });
    expect(r.status).toBe('blocked');
    expect(r.reason).toBe(copy.NEEDS_STATIONS);
    expect(r.reason).toBe('Needs scanner setups (station positions), for example from PTX files.');
  });

  it('declared stations, or no station fact, leave the row as before', () => {
    expect(obs({ hasStations: true })).toEqual(obs({}));
  });

  it('the panel refusal uses the same sentence', () => {
    const node = renderObservatoryPanel({ phase: 'committed', outcome: { status: 'ineligible', reason: 'no-stations' } }, { run: () => {}, onExport: () => {} });
    expect(text(node)).toContain(copy.NEEDS_STATIONS);
    expect(text(node)).toContain(copy.LAB_PURPOSE.observatory);
  });
});

describe('lab copy', () => {
  it('Flow Pulse with no ground surface: purpose, stages, checklist and the terrain run, no refusal dead end', () => {
    const node = renderFlowPulseNeedsGround(() => {});
    const t = text(node);
    expect(t).toContain(copy.LAB_PURPOSE['flow-pulse']);
    expect(t).toContain('1. Ground surface');
    expect(t).toContain('Ground surface (terrain run)');
    expect(t).toContain(copy.NEEDS_GROUND);
    expect(rec(node).find('olv-lab-fix')?.textContent).toBe('Run terrain analysis');
    expect(t).not.toContain('Retry');
  });

  it('Flow Pulse result keeps its method ID inside Method details', () => {
    const input = {
      result: { dtm: dtmOf([[3, 2, 1], [3, 2, 1]]), horizontalScaleResolved: true } as never,
      isGeographic: false, worldOriginY: null, resolvedUnitToMetres: 1, layerId: null, filename: null,
    };
    const card = rec(renderFlowPulseLab(runLabFlowPulse(input)));
    const details = card.find('olv-lab-method')!;
    expect(details.tagName).toBe('details');
    expect(details.textContent).toContain('Method details');
    expect(details.textContent).toContain('olv.simulation.terrain-flow.d8');
  });

  it('a Terrain Access refusal names the reason in plain text and keeps the code in Method details', () => {
    const card = rec(renderTerrainAccessRunCard({ ok: false, code: 'NO_DTM', reason: 'No terrain surface is available.' } as never));
    expect(card.find('olv-story-headline')!.textContent).toBe('Terrain Access did not run');
    expect(card.find('olv-lab-method')!.textContent).toContain('NO_DTM');
  });

  it('Observatory evidence pairs each code with a plain label, and moves IDs into Method details', () => {
    const outcome = runObservatoryOverCloud(wallAndGroundCloud('DECLARED'), {
      voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: null, metresPerUnit: null, buildTag: 'test', planning: { candidateCap: 6 },
    });
    const node = rec(renderObservatoryPanel({ phase: 'committed', outcome } as never, { run: () => {}, onExport: () => {} }));
    const counts = node.find('olv-observatory-state-counts')!.textContent;
    expect(counts).toContain('Shadowed: behind something the scanner hit');
    expect(counts).toMatch(/SHADOWED: \d+/);
    expect(node.textContent).toContain('How to read this');
    const method = node.find('olv-lab-method')!.textContent;
    expect(method).toContain('OB-EXP-01');
    expect(method).toContain('Digest:');
  });
});
