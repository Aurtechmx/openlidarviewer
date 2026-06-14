/**
 * coverageLabelHonesty.test.ts
 *
 * WIN 2 — close the last flagged drift bug. The capture-quality "coveragePct"
 * is computed as occupied-cells / (cols*rows) over the scan's axis-aligned
 * BOUNDING-BOX grid (spaceMetrics.ts) — a fill ratio of the EXTENT, not a share
 * of a measured footprint outline. The old label "Coverage … % of footprint"
 * (hint: "Share of the footprint with returns") implied the latter.
 *
 * The honest fix keeps the (low-risk) computation and renames the LABEL so the
 * words match the math: "Bounding area filled" with a bare "%" value, and a hint
 * that says it is a fill ratio of the bounding-box footprint grid. This test
 * pins label == definition in BOTH surfaces that print it (the ObjectPanel row
 * and the report-PDF layout), and guards against the dishonest phrasing
 * regressing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { SpaceMetrics } from '../src/terrain/spaceMetrics';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly classList = { toggle(): void {} };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void {}
  removeAttribute(): void {}
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  get ownText(): string { return this._text; }
  get titleAttr(): string { return this.title; }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void {}
  findAll(pred: (e: FakeEl) => boolean, acc: FakeEl[] = []): FakeEl[] {
    if (pred(this)) acc.push(this);
    for (const c of this.children) c.findAll(pred, acc);
    return acc;
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

async function interiorSpace(): Promise<{ space: SpaceMetrics; shape: import('../src/terrain/scanShape').ScanShape }> {
  const { spaceMetrics } = await import('../src/terrain/spaceMetrics');
  const { classifyScanShape } = await import('../src/terrain/scanShape');
  const pos = room();
  const shape = classifyScanShape(pos);
  const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior' });
  return { space, shape };
}

describe('WIN 2 — capture-quality coverage label is honest to its computation', () => {
  it('ObjectPanel row: label is "Bounding area filled", value is a bare %, hint says fill-ratio', async () => {
    const { ObjectPanel } = await import('../src/ui/ObjectPanel');
    const { space, shape } = await interiorSpace();
    const panel = new ObjectPanel();
    panel.showSpace(space, shape);
    const root = panel.element as unknown as FakeEl;

    const labelEls = root.findAll((e) => e.ownText === 'Bounding area filled');
    expect(labelEls.length).toBe(1);

    // The OLD dishonest phrasing must be gone.
    const allText = root.textContent;
    expect(allText).not.toContain('% of footprint');
    expect(allText).not.toContain('Share of the footprint with returns');

    // The value sibling is a bare percentage (a fill ratio of the extent — no
    // "of footprint" qualifier the math doesn't support). Find the value node
    // whose title carries the honest fill-ratio definition.
    const honestHint = root.findAll((e) => /bounding-box footprint grid/.test(e.titleAttr));
    expect(honestHint.length).toBe(1);
    // Its text is a plain "NN%" with nothing implying a traced outline.
    expect(honestHint[0].ownText).toMatch(/^\d+%$/);
  });

  it('report-PDF layout: Coverage row renamed to "Bounding area filled" with bare %', async () => {
    const { buildSpaceReportContent } = await import('../src/terrain/space/spaceReportLayout');
    const { space } = await interiorSpace();
    const content = buildSpaceReportContent({
      space,
      name: 'Room',
      softwareVersion: '0.4.7',
      metricVersion: 'v0.4.1',
      generatedAt: new Date('2026-06-13T00:00:00Z'),
    });
    const rows = content.sections.flatMap((s) => s.rows);
    const row = rows.find((r) => r.label === 'Bounding area filled');
    expect(row, 'capture-quality row should be "Bounding area filled"').toBeDefined();
    expect(row?.value).toMatch(/^\d+%$/);
    // No row should carry the old phrasing.
    expect(rows.some((r) => /% of footprint/.test(r.value))).toBe(false);
  });
});
