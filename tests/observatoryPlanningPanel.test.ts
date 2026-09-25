/**
 * observatoryPlanningPanel.test.ts — the O10 result on every surface that
 * shows it: the panel's Planning section (OB-UI-01/04/05, OB-INV-05, F15) and
 * the export bundle's `candidates.csv` (OB-EXP-01).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import { runObservatoryOverCloud, type ObservatoryRunOutcome } from '../src/app/observatoryFromCloud';
import { buildObservatoryPackage } from '../src/export/observatoryPackage';
import { wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';

beforeAll(() => {
  installRecordingDom();
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
});

const { renderObservatoryPanel } = await import('../src/ui/observatory/observatoryPanel');

const BANNED = ['probability', 'confidence', 'accuracy', 'optimal', 'guaranteed', 'complete coverage', 'free space'];
const RUN = { voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: 'wall.ptx', metresPerUnit: 1, buildTag: 'test', planning: { candidateCap: 12 } } as const;

function run(originStatus = 'DECLARED'): Extract<ObservatoryRunOutcome, { status: 'ok' }> {
  const out = runObservatoryOverCloud(wallAndGroundCloud(originStatus), RUN);
  if (out.status !== 'ok' || !out.planning) throw new Error('test setup: the run must succeed with planning');
  return out;
}

function planningText(outcome: ObservatoryRunOutcome): string {
  const node = renderObservatoryPanel({ phase: 'committed', outcome }, { run: () => {}, onExport: () => {} }) as unknown as RecordingEl;
  const section = node.children.find((c) => c.className === 'olv-observatory-section' && c.children[0]?.textContent === 'Planning');
  return section!.textContent;
}

function csvOf(outcome: Extract<ObservatoryRunOutcome, { status: 'ok' }>): string {
  const zip = buildObservatoryPackage(outcome.record, outcome.rows, outcome.frontier.frontierVoxelKeys, { planning: outcome.planning ?? null, generationDateIso: '2026-01-01T00:00:00.000Z' });
  const text = new TextDecoder('latin1').decode(zip);
  const start = text.indexOf('# methods: olv.observation.coverage-gain@1');
  return text.slice(start, text.indexOf('\n\n', start) === -1 ? undefined : text.indexOf('PK', start));
}

describe('Planning section', () => {
  const outcome = run();
  let text = '';
  beforeAll(() => { text = planningText(outcome); });

  it('replaces the not-implemented line with the Coverage Gain result', () => {
    expect(text).not.toMatch(/not implemented/i);
    expect(text).toContain('SUGGESTED STATION (not observed) 1: candidate');
    expect(text).toContain('SUGGESTED STATION (not observed) 2: candidate');
  });

  it('shows the instrument model, the candidate count and cap, and the NOT_READ count (OB-UI-04, OB-GAIN-05)', () => {
    expect(text).toContain('Instrument model: height 1.50 m');
    expect(text).toMatch(/Candidates: 12 scored \(\d+ qualifying, cap 12, \d+ dropped by the cap\)/);
    expect(text).toContain('Not read in this load: 0 voxel(s), weight 0');
  });

  it('shows every Coverage Gain term of each suggestion (OB-UI-04)', () => {
    for (const term of ['weighted sum', 'revisited', 'gain', 'shadowed', 'not addressed', 'fired, no return', 'conflict', 'weak surface', 'not read in this load']) {
      expect(text).toContain(term);
    }
  });

  it('labels a resident-only field preview and offers no reachable mode (OB-GAIN-05/06)', () => {
    expect(text).toContain('Authority: preview (basis resident-only)');
    expect(text).toContain('Reachability is not checked');
    expect(text).not.toMatch(/\breachable\b/);
  });

  it('carries no banned word (OB-UI-05)', () => {
    const lower = text.toLowerCase();
    for (const word of BANNED) expect(lower).not.toContain(word);
  });

  it('says so when planning did not run', () => {
    const bare = runObservatoryOverCloud(wallAndGroundCloud(), { ...RUN, planning: false });
    expect(planningText(bare)).toContain('Coverage Gain was not run for this field.');
  });
});

describe('F15 — assumed origin, labelled on every surface', () => {
  const outcome = run('ASSUMED');

  it('panel: ASSUMED ORIGIN badge in Sources and preview authority naming the station in Planning', () => {
    const node = renderObservatoryPanel({ phase: 'committed', outcome }, { run: () => {}, onExport: () => {} }) as unknown as RecordingEl;
    expect(node.textContent).toContain('ASSUMED ORIGIN');
    expect(planningText(outcome)).toContain('assumed origin: station-1');
  });

  it('export: candidates.csv and stations.json carry the assumed origin', () => {
    const csv = csvOf(outcome);
    expect(csv).toContain('# authority: preview (basis resident-only; assumed origin: station-1)');
    const zipText = new TextDecoder('latin1').decode(buildObservatoryPackage(outcome.record, outcome.rows, [], { planning: outcome.planning ?? null }));
    expect(zipText).toContain('"originStatus": "ASSUMED"');
  });
});

describe('candidates.csv (OB-EXP-01)', () => {
  const outcome = run();
  const csv = csvOf(outcome);

  it('lists every candidate with every term, and ranks the suggested ones', () => {
    const lines = csv.split('\n').filter((l) => /^\d/.test(l));
    expect(lines.length).toBe(outcome.planning!.candidates.length);
    for (const l of lines) expect(l.split(',').length).toBe(17);
    const ranked = lines.filter((l) => l.split(',')[4] !== '');
    expect(ranked.length).toBe(2);
    expect(csv).toContain('SUGGESTED STATION (not observed)');
  });

  it('records the instrument model and the weights', () => {
    expect(csv).toMatch(/# instrument model: heightAboveSurface=1\.5 minRange=0\.5 /);
    expect(csv).toContain('# weights: SHADOWED=1 UNADDRESSED=1 NO_RETURN_PATH=0.25 CONFLICT=0.5 WEAK_SURFACE=0.5 redundancyWeight=0.1');
  });
});
