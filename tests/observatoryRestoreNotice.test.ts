/**
 * observatoryRestoreNotice.test.ts
 *
 * A restored WebGL context redraws the Observatory overlays and posts one
 * notice in the panel. A second restore replaces that notice instead of
 * stacking another above it, and once the overlays are cleared (scan closed)
 * a restore draws nothing from the run it no longer shows.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import { installRecordingDom } from './helpers/recordingDom';
import { runObservatoryOverCloud, type ObservatoryRunOutcome } from '../src/app/observatoryFromCloud';
import { createObservatoryRunner } from '../src/app/observatoryRunner';
import { invalidateObservatoryOverlay } from '../src/lazyChunks';
import { wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';

vi.mock('../src/ui/Modal', () => ({
  openModal: (opts: { onClose?: () => void }) => ({ close: () => { opts.onClose?.(); } }),
}));
const announced: string[] = [];
vi.mock('../src/ui/politeAnnounce', () => ({ announcePolite: (m: string) => { announced.push(m); return true; } }));

/** The panel root: records prepended notices and removes them on request. */
const panel = {
  notices: [] as { className: string }[],
  prepend(n: { className: string }) { this.notices.unshift(n); },
  querySelectorAll(sel: string) {
    const cls = sel.slice(1);
    return this.notices.filter((n) => n.className === cls).map((n) => ({
      remove: () => { panel.notices.splice(panel.notices.indexOf(n), 1); },
    }));
  },
};
const listeners: { type: string; fn: () => void }[] = [];
beforeAll(() => {
  installRecordingDom();
  const doc = (globalThis as unknown as { document: Record<string, unknown> }).document;
  doc.addEventListener = (type: string, fn: () => void) => { listeners.push({ type, fn }); };
  doc.querySelector = (sel: string) => (sel === '.olv-observatory-panel' ? panel : null);
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
});

const { openObservatoryPanel, OVERLAYS_REDRAWN_NOTICE } = await import('../src/ui/observatory/observatoryPanel');

const RUN = { voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: 'wall.ptx', metresPerUnit: 1, buildTag: 'test', planning: { candidateCap: 12 } } as const;
const cloud = wallAndGroundCloud('DECLARED');
const outcome: ObservatoryRunOutcome = runObservatoryOverCloud(cloud, RUN);

function host() {
  const attached = new Set<THREE.Object3D>();
  return { attached, add(o: THREE.Object3D) { attached.add(o); }, remove(o: THREE.Object3D) { attached.delete(o); }, requestFrame() {} };
}
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}
const restore = () => { for (const l of listeners) if (l.type === 'webglcontextrestored') l.fn(); };

describe('Observatory context-restore notice', () => {
  it('a second restore replaces the notice rather than stacking one', async () => {
    const h = host();
    const runner = createObservatoryRunner({
      getActiveCloud: () => cloud,
      getDatasetId: () => 'scan-n',
      getCrsRevision: () => 0,
      buildOptions: () => ({ filename: 'wall.ptx', metresPerUnit: 1, buildTag: 'test' }),
      compute: () => outcome,
    });
    const handle = openObservatoryPanel({ runner, overlayHost: h, worldToLocal: (p) => p });
    runner.run();
    await until(() => h.attached.size === 2);
    restore();
    await until(() => announced.length === 1);
    restore();
    await until(() => announced.length === 2);
    expect(announced).toEqual([OVERLAYS_REDRAWN_NOTICE, OVERLAYS_REDRAWN_NOTICE]);
    expect(panel.notices.filter((n) => n.className === 'olv-observatory-redrawn')).toHaveLength(1);
    handle.close();
    invalidateObservatoryOverlay();
  });

  it('after the overlays are cleared a restore draws nothing', async () => {
    const h = host();
    const worldToLocal = vi.fn((p: readonly [number, number, number]) => p);
    const runner = createObservatoryRunner({
      getActiveCloud: () => cloud,
      getDatasetId: () => 'scan-m',
      getCrsRevision: () => 0,
      buildOptions: () => ({ filename: 'wall.ptx', metresPerUnit: 1, buildTag: 'test' }),
      compute: () => outcome,
    });
    const handle = openObservatoryPanel({ runner, overlayHost: h, worldToLocal });
    runner.run();
    await until(() => h.attached.size === 2);
    handle.close();
    invalidateObservatoryOverlay();
    await new Promise((r) => setTimeout(r, 0));
    const calls = worldToLocal.mock.calls.length;
    const before = announced.length;
    restore();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.attached.size).toBe(0);
    expect(worldToLocal.mock.calls.length).toBe(calls);
    expect(announced.length).toBe(before);
  });
});
