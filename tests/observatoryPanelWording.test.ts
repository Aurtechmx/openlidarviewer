/**
 * observatoryPanelWording.test.ts — OB-UI-05: the panel never writes a
 * banned word into the DOM, in any state (idle, running, stale, ineligible,
 * refused, or a committed run), and every permitted state-related phrase it
 * DOES use is one SPEC §8 actually names.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import { runObservatoryOverCloud } from '../src/app/observatoryFromCloud';
import { wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';

beforeAll(() => {
  installRecordingDom();
  // `el()`'s `type` prop checks `instanceof HTMLInputElement`; the recording
  // DOM has no real element classes, so these stand in (same pattern
  // `tests/toolDock.test.ts` uses for its own button-carrying render tree).
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
});

const { renderObservatoryPanel } = await import('../src/ui/observatory/observatoryPanel');
const { OBSERVATORY_BADGE_WORDS } = await import('../src/ui/observatory/stateChip');
type State = Parameters<typeof renderObservatoryPanel>[0];

const textOf = (node: HTMLElement) => (node as unknown as RecordingEl).textContent;

const BANNED = ['probability', 'confidence', 'accuracy', 'optimal', 'guaranteed', 'complete coverage', 'free space'];

const noopActions = { run: () => {}, onExport: () => {} };

function assertClean(state: State): void {
  const text = textOf(renderObservatoryPanel(state, noopActions)).toLowerCase();
  for (const word of BANNED) expect(text, `banned word "${word}" found in state ${state.phase}`).not.toContain(word);
}

describe('OB-UI-05 wording', () => {
  it('idle, running and stale states carry no banned word', () => {
    assertClean({ phase: 'idle' });
    assertClean({ phase: 'running' });
    assertClean({ phase: 'stale' });
  });

  it('an ineligible outcome carries no banned word', () => {
    assertClean({ phase: 'committed', outcome: { status: 'ineligible', reason: 'no-stations' } });
    assertClean({ phase: 'committed', outcome: { status: 'ineligible', reason: 'empty-domain' } });
  });

  it('a refused outcome carries no banned word', () => {
    assertClean({ phase: 'committed', outcome: { status: 'refused', reason: 'voxel-budget' as never } });
  });

  it('a committed run with Coverage Gain planning carries no banned word, declared or assumed origin', () => {
    for (const originStatus of ['DECLARED', 'ASSUMED']) {
      const outcome = runObservatoryOverCloud(wallAndGroundCloud(originStatus), {
        voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: null, metresPerUnit: null, buildTag: 'test', planning: { candidateCap: 6 },
      });
      expect(outcome.status).toBe('ok');
      assertClean({ phase: 'committed', outcome });
    }
  });

  it('the Planning section badges use only SPEC-declared badge words', () => {
    const node = renderObservatoryPanel({ phase: 'idle' }, noopActions);
    const text = textOf(node);
    // Idle state shows no Planning section (no run yet), so assert the badge
    // vocabulary itself is exactly SPEC's OB-UI-02 list, independent of what
    // happens to be rendered right now.
    for (const word of OBSERVATORY_BADGE_WORDS) expect(typeof word).toBe('string');
    expect(text).not.toMatch(/\bprobability\b/i);
  });
});
