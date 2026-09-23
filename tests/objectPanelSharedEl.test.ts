/**
 * objectPanelSharedEl.test.ts
 *
 * ANALYSIS-F8: ObjectPanel.ts reimplemented a local `el()` — a strict subset
 * of `src/ui/dom.ts`'s shared helper missing `ariaLabel`/`unsafeHtml`/`tip`/
 * `href`/`type` — instead of importing the shared one every other panel in
 * this review uses. Pins that the file now imports the shared helper and no
 * longer defines its own, and that the panel still renders (the two
 * signatures are compatible for every call site this file has today: the
 * behavioural half of the fix).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FakeEl } from './support/objectPanelDom';

const PANEL = readFileSync(resolve(__dirname, '../src/ui/ObjectPanel.ts'), 'utf8');

describe('ObjectPanel uses the shared dom.ts el() helper', () => {
  it('imports el from ./dom', () => {
    expect(PANEL).toMatch(/import \{ el \} from '\.\/dom';/);
  });

  it('no longer defines its own local el()', () => {
    expect(PANEL).not.toMatch(/^function el\(/m);
  });
});

describe('ObjectPanel still renders with the shared helper', () => {
  beforeAll(() => {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string) => new FakeEl(tag),
    };
  });

  it('builds its chrome (title, Run terrain contours anyway) unchanged', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const panel = new ObjectPanel();
    const root = panel.element as unknown as FakeEl;
    expect(root.textContent).toContain('Object scan');
    expect(root.textContent).toContain('Run terrain contours anyway');
  });

  it('renders an interior room report through the shared el(), same fields as before', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const { spaceMetrics } = await import('../src/terrain/spaceMetrics');
    const { classifyScanShape } = await import('../src/terrain/scanShape');

    const t: number[] = [];
    const push = (x: number, y: number, z: number): void => {
      t.push(x, y, z);
    };
    const W = 14, D = 29, H = 5, step = 0.5;
    for (let x = 0; x <= W; x += step) for (let y = 0; y <= D; y += step) { push(x, y, 0); push(x, y, H); }
    for (let z = 0; z <= H; z += step) for (let x = 0; x <= W; x += step) { push(x, 0, z); push(x, D, z); }
    for (let z = 0; z <= H; z += step) for (let y = 0; y <= D; y += step) { push(0, y, z); push(W, y, z); }
    const pos = Float32Array.from(t);

    const shape = classifyScanShape(pos);
    const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior' });
    const panel = new ObjectPanel();
    panel.showSpace(space, shape);
    const text = (panel.element as unknown as FakeEl).textContent;
    for (const field of ['Space scan', 'Floor area', 'Ceiling height', 'Capture quality']) {
      expect(text).toContain(field);
    }
  });
});
