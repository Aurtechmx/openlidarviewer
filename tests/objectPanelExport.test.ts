/**
 * objectPanelExport.test.ts
 *
 * The non-terrain export row: a "Report PDF" button is present for BOTH object
 * and interior scans; a "Floor plan preview" button is present ONLY for interior scans.
 * Runs in the node environment via the same recording DOM stub as
 * objectPanelSpace.test.ts. The last block pins that an export's busy and
 * failed states belong to the panel: a re-render during the export (a CRS
 * change re-measures the report) must not hide them on a detached button.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl } from './support/objectPanelDom';


beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

function room(W = 14, D = 29, H = 5, step = 0.5): Float32Array {
  const t: number[] = [];
  const push = (x: number, y: number, z: number): void => { t.push(x, y, z); };
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) { push(x, y, 0); push(x, y, H); }
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) { push(x, 0, z); push(x, D, z); }
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) { push(0, y, z); push(W, y, z); }
  return Float32Array.from(t);
}

function cubeShell(): Float32Array {
  const cube: number[] = [];
  for (let u = 0; u <= 4; u += 0.5)
    for (let w = 0; w <= 4; w += 0.5) {
      cube.push(u, w, 0, u, w, 4, u, 0, w, u, 4, w, 0, u, w, 4, u, w);
    }
  return Float32Array.from(cube);
}

describe('ObjectPanel — export row gating', () => {
  it('interior scan: Report PDF + Floor plan preview buttons present', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const { spaceMetrics } = await import('../src/terrain/spaceMetrics');
    const { classifyScanShape } = await import('../src/terrain/scanShape');

    const pos = room();
    const shape = classifyScanShape(pos);
    const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior' });

    const panel = new ObjectPanel({
      onExportReport: async () => {},
      onExportFloorPlan: async () => {},
    });
    panel.showSpace(space, shape);
    const root = panel.element as unknown as FakeEl;
    expect(root.findByText('Report PDF')).toHaveLength(1);
    expect(root.findByText('Floor plan preview')).toHaveLength(1);
  });

  it('object scan: Report PDF present, Floor plan preview absent', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const { objectMetrics } = await import('../src/terrain/objectMetrics');

    const panel = new ObjectPanel({
      onExportReport: async () => {},
      onExportFloorPlan: async () => {},
    });
    panel.showObject(objectMetrics(cubeShell()), null, null);
    const root = panel.element as unknown as FakeEl;
    expect(root.findByText('Report PDF')).toHaveLength(1);
    expect(root.findByText('Floor plan preview')).toHaveLength(0);
  });
});

describe('ObjectPanel: an export outlives a re-render of the report', () => {
  /** An export the test settles by hand. */
  function deferred() {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }
  const reportButton = (root: FakeEl): FakeEl | undefined =>
    root.findByText('Report PDF')[0] ?? root.findByText('…')[0] ?? root.findByText('Failed')[0];
  const settle = () => new Promise((r) => setTimeout(r, 0));

  async function mount() {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const { objectMetrics } = await import('../src/terrain/objectMetrics');
    const run = deferred();
    let calls = 0;
    const panel = new ObjectPanel({ onExportReport: () => { calls++; return run.promise; } });
    const metrics = objectMetrics(cubeShell());
    panel.showObject(metrics, null, null);
    const root = panel.element as unknown as FakeEl;
    return { panel, metrics, run, root, calls: () => calls };
  }

  it('a failure after a re-render shows on the button now in the panel', async () => {
    const { panel, metrics, run, root } = await mount();
    (reportButton(root) as unknown as { click(): void }).click();
    panel.showObject(metrics, null, null); // the report re-measures mid-export
    const shown = reportButton(root)!;
    expect(shown.textContent).toBe('…');
    expect(shown.disabled).toBe(true);
    run.reject(new Error('moved'));
    await settle();
    expect(reportButton(root)).toBe(shown);
    expect(shown.textContent).toBe('Failed');
    expect(shown.disabled).toBe(false);
  });

  it('the re-rendered button does not start a second export while the first runs', async () => {
    const { panel, metrics, run, root, calls } = await mount();
    (reportButton(root) as unknown as { click(): void }).click();
    panel.showObject(metrics, null, null);
    (reportButton(root) as unknown as { click(): void }).click();
    expect(calls()).toBe(1);
    run.resolve();
    await settle();
    expect(reportButton(root)!.textContent).toBe('Report PDF');
  });
});
