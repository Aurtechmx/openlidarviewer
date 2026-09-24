/**
 * observatoryPanelSections.test.ts — OB-UI-01: a committed run renders all
 * five named sections (Sources, Evidence, Shadow, Planning, Record).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';

beforeAll(() => {
  installRecordingDom();
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
});

const { renderObservatoryPanel } = await import('../src/ui/observatory/observatoryPanel');
type State = Parameters<typeof renderObservatoryPanel>[0];

function fakeRecord() {
  const stateCounts = { SURFACE: 3, PARTIAL: 0, OBSERVED_EMPTY: 2, CONFLICT: 0, SHADOWED: 1, NO_RETURN_PATH: 0, UNADDRESSED: 4, NOT_READ: 0, OUTSIDE_DOMAIN: 0 };
  return {
    schemaVersion: 1 as const,
    id: 'obs-test',
    generatedAt: '2026-01-01T00:00:00.000Z',
    build: 'test',
    source: { filename: 'fixture.ptx', sourceDigest: 'abc', basis: 'resident-only', metresPerUnit: 1 },
    domain: { min: [0, 0, 0] as const, max: [1, 1, 1] as const },
    voxelEdge: 0.5,
    stations: [{ id: 'station-1', source: 'ptx-block', originStatus: 'DECLARED', worldTranslation: [0, 0, 0] as const, sourceIndex: 0, tauAbs: 0.25, tauRel: 0 }],
    parameters: { p_solid: 0.9, p_empty: 0.1, n_min: 5, tau_abs: 0.25, tau_rel: 0 },
    methods: ['olv.observation.ledger@1'],
    fieldDigest: 'deadbeef',
    stateCounts,
    frontier: { frontierVoxelCount: 2, areaSquareMetres: 0.5, adjacentToShadowed: 1, adjacentToUnaddressed: 1, adjacentToNoReturnPath: 0 },
    rejectionRatio: 0,
    limitations: ['resident-only basis'],
    processingManifestHead: null,
    digest: 'f'.repeat(64),
  };
}

describe('OB-UI-01 panel sections', () => {
  it('a committed ok run shows all five sections', () => {
    const state: State = { phase: 'committed', outcome: { status: 'ok', record: fakeRecord() as never, stateByKey: new Map(), grid: { nx: 1, ny: 1, nz: 1 }, domain: { min: [0, 0, 0], max: [1, 1, 1] }, voxelEdge: 0.5, frontier: { frontierVoxelKeys: [], areaSquareMetres: 0.5, adjacentToShadowed: 1, adjacentToUnaddressed: 1, adjacentToNoReturnPath: 0 }, rows: [] } };
    const node = renderObservatoryPanel(state, { run: () => {}, onExport: () => {} }) as unknown as RecordingEl;
    const titles = node.children.filter((c) => c.className === 'olv-observatory-section').map((c) => c.children[0]?.textContent);
    expect(titles).toEqual(['Sources', 'Evidence', 'Shadow', 'Planning', 'Record']);
  });
});
