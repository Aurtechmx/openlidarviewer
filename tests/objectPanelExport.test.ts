/**
 * objectPanelExport.test.ts
 *
 * The non-terrain export row: a "Report PDF" button is present for BOTH object
 * and interior scans; a "Floor plan" button is present ONLY for interior scans.
 * Runs in the node environment via the same recording DOM stub as
 * objectPanelSpace.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly classList = { toggle(): void { /* no-op */ } };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void { /* no-op */ }
  /** Recursively collect every descendant whose textContent equals `label`. */
  findByText(label: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text === label) out.push(this);
    for (const c of this.children) out.push(...c.findByText(label));
    return out;
  }
}

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
  it('interior scan: Report PDF + Floor plan buttons present', async () => {
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
    expect(root.findByText('Report PDF').length).toBe(1);
    expect(root.findByText('Floor plan').length).toBe(1);
  });

  it('object scan: Report PDF present, Floor plan absent', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const { objectMetrics } = await import('../src/terrain/objectMetrics');

    const panel = new ObjectPanel({
      onExportReport: async () => {},
      onExportFloorPlan: async () => {},
    });
    panel.showObject(objectMetrics(cubeShell()), null, null);
    const root = panel.element as unknown as FakeEl;
    expect(root.findByText('Report PDF').length).toBe(1);
    expect(root.findByText('Floor plan').length).toBe(0);
  });
});
