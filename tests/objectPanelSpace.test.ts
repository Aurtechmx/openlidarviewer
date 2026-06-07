/**
 * objectPanelSpace.test.ts
 *
 * The unified non-terrain panel renders the INTERIOR room report for an
 * interior scan and the OBJECT report for an object scan. The test runs in the
 * node environment (no DOM), so it drives `ObjectPanel` through a minimal
 * recording DOM stub — the same stub-the-slice approach used elsewhere — and
 * asserts on the gathered text rather than pixels.
 */

import { describe, it, expect, beforeAll } from 'vitest';

/** A tiny fake element supporting only the surface ObjectPanel touches. */
class FakeEl {
  className = '';
  title = '';
  type = '';
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
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

describe('ObjectPanel — space / object routing', () => {
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

  it('renders the interior room fields when spaceKind is interior', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const { spaceMetrics } = await import('../src/terrain/spaceMetrics');
    const { classifyScanShape } = await import('../src/terrain/scanShape');

    const pos = room();
    const shape = classifyScanShape(pos);
    expect(shape.spaceKind).toBe('interior');
    const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior' });

    const panel = new ObjectPanel();
    panel.showSpace(space, shape);
    const text = (panel.element as unknown as FakeEl).textContent;
    for (const field of [
      'Space scan', 'Dimensions (L×W×H)', 'Floor area', 'Ceiling height',
      'Enclosed volume', 'Storeys', 'Planes', 'Walls', 'Capture quality',
      'currently loaded / streamed',
    ]) {
      expect(text).toContain(field);
    }
  });

  function cubeShell(): Float32Array {
    const cube: number[] = [];
    for (let u = 0; u <= 4; u += 0.5)
      for (let w = 0; w <= 4; w += 0.5) {
        cube.push(u, w, 0, u, w, 4, u, 0, w, u, 4, w, 0, u, w, 4, u, w);
      }
    return Float32Array.from(cube);
  }

  it('renders the object fields when showing an object', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const { objectMetrics } = await import('../src/terrain/objectMetrics');

    const panel = new ObjectPanel();
    panel.showObject(objectMetrics(cubeShell()), null, null);
    const text = (panel.element as unknown as FakeEl).textContent;
    expect(text).toContain('Object scan');
    expect(text).toContain('Dimensions (oriented)');
    expect(text).toContain('Envelope volume');
  });

  it('object report reaches interior parity: m+ft, largest dim, surface, quality', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const { objectMetrics } = await import('../src/terrain/objectMetrics');
    const { spaceMetrics } = await import('../src/terrain/spaceMetrics');

    const pos = cubeShell();
    const space = spaceMetrics(pos, { upAxis: 'z', spaceKind: 'object', hasRgb: true });

    const panel = new ObjectPanel();
    panel.showObject(objectMetrics(pos), space, null);
    const text = (panel.element as unknown as FakeEl).textContent;
    for (const field of [
      'Object scan',
      'Dimensions (oriented)',
      'Largest dimension',
      'Envelope volume',
      'ft³',           // envelope volume shows feet³ alongside metres³
      'Bounding surface area',
      'ft²',           // surface area shows feet² alongside metres²
      'ft)',           // largest dimension shows feet alongside metres
      'Capture quality',
      'Density',
      'Colour (RGB)',
    ]) {
      expect(text).toContain(field);
    }
  });
});
