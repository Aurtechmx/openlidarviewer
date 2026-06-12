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
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly classList = { toggle(): void { /* no-op */ } };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void { /* no-op */ }
  removeAttribute(): void { /* no-op */ }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void { /* no-op */ }
}

/** Depth-first flatten of a FakeEl tree (self included). */
function flatten(root: FakeEl, acc: FakeEl[] = []): FakeEl[] {
  acc.push(root);
  for (const c of root.children) flatten(c, acc);
  return acc;
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

  // The dead-panel fix: when detection reads the scan as interior/object the
  // host passes a disabled-with-reason map for the Terrain segment. The
  // ObjectPanel must carry it through every body rebuild (showSpace/showObject
  // re-render the control), keep the visible reason line, and keep the
  // "Run terrain contours anyway" escape hatch functional.
  it('keeps the Treat-as Terrain segment disabled (with reason) across a re-render', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const { spaceMetrics } = await import('../src/terrain/spaceMetrics');
    const { classifyScanShape } = await import('../src/terrain/scanShape');

    const REASON =
      "This scan reads as an interior — terrain analysis would be misleading. " +
      "Use 'Run terrain contours anyway' to override.";
    const pos = room();
    const shape = classifyScanShape(pos);
    const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior' });

    const panel = new ObjectPanel();
    panel.setScanType('auto', 'interior', { terrain: REASON });
    panel.showSpace(space, shape); // body rebuild — the disabled state must survive

    const root = panel.element as unknown as FakeEl;
    const all = flatten(root);
    const pill = (v: string) =>
      all.find((e) => e.className.includes('olv-scan-type-opt') && e.dataset.value === v)!;

    // Terrain: disabled + the reason as its title (the codebase pattern).
    expect(pill('terrain').disabled).toBe(true);
    expect(pill('terrain').title).toBe(REASON);
    // The other three routes stay clickable.
    for (const v of ['object', 'interior', 'auto']) expect(pill(v).disabled).toBe(false);
    // The visible reason line rides in the rendered panel text.
    expect(root.textContent).toContain("Use 'Run terrain contours anyway' to override");
    // The explicit escape hatch is still rendered.
    expect(all.some((e) => e.className.includes('olv-object-run-anyway'))).toBe(true);
  });

  it('the empty interior state still offers the Treat-as control and the hatch', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const panel = new ObjectPanel();
    // The graceful-recovery path: a forced non-terrain route with no metrics
    // available must render an alive panel, never a torn-down one.
    panel.showSpace(null, null);
    const root = panel.element as unknown as FakeEl;
    const all = flatten(root);
    expect(root.textContent).toContain('No space measurements available');
    expect(all.filter((e) => e.className.includes('olv-scan-type-opt')).length).toBe(4);
    expect(all.some((e) => e.className.includes('olv-object-run-anyway'))).toBe(true);
  });
});
