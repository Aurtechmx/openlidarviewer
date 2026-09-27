/**
 * observatoryOverlayLifecycle.test.ts: O11 disposal and device loss.
 *
 * Open -> run -> close, repeated, must leave nothing attached to the scene and
 * every GPU geometry and material the overlays made disposed. After a restored
 * WebGL context, the overlays are rebuilt from the run already in memory (the
 * compute step is not called again) and a notice says so.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import { installRecordingDom } from './helpers/recordingDom';
import { runObservatoryOverCloud, type ObservatoryRunOutcome } from '../src/app/observatoryFromCloud';
import { createObservatoryRunner } from '../src/app/observatoryRunner';
import { invalidateObservatoryOverlay } from '../src/lazyChunks';
import { wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';

vi.mock('../src/ui/Modal', () => ({
  openModal: (opts: { onClose?: () => void }) => {
    const handle = { close: () => { opts.onClose?.(); } };
    return handle;
  },
}));
const announced: string[] = [];
vi.mock('../src/ui/politeAnnounce', () => ({ announcePolite: (m: string) => { announced.push(m); return true; } }));

const listeners: { type: string; fn: () => void }[] = [];
beforeAll(() => {
  installRecordingDom();
  const doc = (globalThis as unknown as { document: Record<string, unknown> }).document;
  doc.addEventListener = (type: string, fn: () => void) => { listeners.push({ type, fn }); };
  doc.querySelector = () => null;
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
});

const { openObservatoryPanel, OVERLAYS_REDRAWN_NOTICE } = await import('../src/ui/observatory/observatoryPanel');

const RUN = { voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: 'wall.ptx', metresPerUnit: 1, buildTag: 'test', planning: { candidateCap: 12 } } as const;
const cloud = wallAndGroundCloud('DECLARED');
const outcome: ObservatoryRunOutcome = runObservatoryOverCloud(cloud, RUN);

/** A scene host that tracks every GPU resource reachable from what is attached. */
function trackingHost() {
  const attached = new Set<THREE.Object3D>();
  const live = new Set<{ dispose(): void }>();
  const track = (r: THREE.EventDispatcher & { dispose(): void }) => {
    if (live.has(r)) return;
    live.add(r);
    r.addEventListener('dispose' as never, () => { live.delete(r); });
  };
  return {
    attached,
    live,
    add(o: THREE.Object3D) {
      attached.add(o);
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.geometry) track(m.geometry);
        if (m.material) track(m.material as THREE.Material);
      });
    },
    remove(o: THREE.Object3D) { attached.delete(o); },
    requestFrame() {},
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

describe('Observatory overlay lifecycle', () => {
  it('open -> run -> close, eight times, leaves no attached object and no live GPU resource', async () => {
    const host = trackingHost();
    let computes = 0;
    const runner = createObservatoryRunner({
      getActiveCloud: () => cloud,
      getDatasetId: () => 'scan-1',
      getCrsRevision: () => 0,
      buildOptions: () => ({ filename: 'wall.ptx', metresPerUnit: 1, buildTag: 'test' }),
      compute: () => { computes++; return outcome; },
    });
    for (let i = 0; i < 8; i++) {
      const handle = openObservatoryPanel({ runner, overlayHost: host, worldToLocal: (p) => p });
      runner.run();
      await until(() => host.attached.size === 2);
      handle.close();
      invalidateObservatoryOverlay(); // scan close, through the same seam main.ts uses
      await flush();
      expect(host.attached.size).toBe(0);
      expect(host.live.size).toBe(0);
    }
    expect(computes).toBe(8);
  });

  it('a restored context redraws the overlays from the run in memory, without recomputing, and says so', async () => {
    const host = trackingHost();
    let computes = 0;
    const runner = createObservatoryRunner({
      getActiveCloud: () => cloud,
      getDatasetId: () => 'scan-2',
      getCrsRevision: () => 0,
      buildOptions: () => ({ filename: 'wall.ptx', metresPerUnit: 1, buildTag: 'test' }),
      compute: () => { computes++; return outcome; },
    });
    openObservatoryPanel({ runner, overlayHost: host, worldToLocal: (p) => p });
    runner.run();
    await until(() => host.attached.size === 2);
    const before = [...host.attached];
    expect(before.length).toBe(2);
    const restore = listeners.filter((l) => l.type === 'webglcontextrestored');
    expect(restore.length).toBe(1);
    restore[0]!.fn();
    await until(() => announced.includes(OVERLAYS_REDRAWN_NOTICE));
    expect(computes).toBe(1);
    expect(host.attached.size).toBe(2);
    for (const o of before) expect(host.attached.has(o)).toBe(false);
    expect(announced).toContain(OVERLAYS_REDRAWN_NOTICE);
    invalidateObservatoryOverlay();
    await flush();
    expect(host.live.size).toBe(0);
  });
});
