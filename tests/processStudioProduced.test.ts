/**
 * processStudioProduced.test.ts — the Process Studio "produced" state.
 *
 * After an analysis run the shell calls panel.setProduced(['dtm','contours']);
 * those products must then render a "produced" badge (above their eligibility),
 * and a scan close (update(null)) must clear it. ProcessStudioPanel is DOM-only,
 * so it builds under a minimal recording-DOM stub in the node environment.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { ScanFacts } from '../src/process/ProcessPlan';
import type { CrsInfo } from '../src/io/crs';

class FakeEl {
  className = '';
  title = '';
  hidden = false;
  readonly dataset: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private _text = '';
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string { return this._text; }
  setAttribute(): void { /* aria-label — unused by assertions */ }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  querySelector(sel: string): FakeEl | null {
    const cls = sel.replace(/^\./, '');
    const walk = (n: FakeEl): FakeEl | null => {
      for (const c of n.children) {
        if (c.className.split(' ').includes(cls)) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
  /** All descendants whose class list includes `cls`. */
  collect(cls: string, out: FakeEl[] = []): FakeEl[] {
    for (const c of this.children) {
      if (c.className.split(' ').includes(cls)) out.push(c);
      c.collect(cls, out);
    }
    return out;
  }
}

const metreCrs = { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1, verticalDatum: 'NAVD88' } as unknown as CrsInfo;
const facts: ScanFacts = {
  kind: 'static', coverage: 'full', crs: metreCrs, pointCount: 1_000_000,
  hasRgb: false, hasIntensity: false, hasGpsTime: false, hasReturnNumber: false, hasPointSourceId: false,
  classification: 'full', classificationProvenance: 'producer', groundClassified: true, hasBuildingClass: false,
} as ScanFacts;

let ProcessStudioPanel: typeof import('../src/ui/ProcessStudioPanel').ProcessStudioPanel;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  ({ ProcessStudioPanel } = await import('../src/ui/ProcessStudioPanel'));
});

/** The product row for a given label, if present. */
function productRow(panel: InstanceType<typeof ProcessStudioPanel>, label: string): FakeEl | undefined {
  const root = panel.element as unknown as FakeEl;
  return root.collect('olv-ps-product').find((li) => li.collect('olv-ps-name').some((s) => s.textContent === label));
}
function badgeText(row: FakeEl): string {
  return row.collect('olv-ps-badge')[0]?.textContent ?? '';
}

describe('Process Studio produced state', () => {
  it('marks DTM + contours produced after an analysis run, leaving others on eligibility', () => {
    const panel = new ProcessStudioPanel();
    panel.update(facts);
    // Before: DTM shows its eligibility badge, not "produced".
    expect(badgeText(productRow(panel, 'DTM')!)).toBe('ready');

    panel.setProduced(['dtm', 'contours']);
    const dtm = productRow(panel, 'DTM')!;
    const contours = productRow(panel, 'Contours')!;
    const dsm = productRow(panel, 'DSM')!;
    expect(badgeText(dtm)).toBe('produced');
    expect(dtm.className).toContain('olv-ps-produced');
    expect(badgeText(contours)).toBe('produced');
    // A product the run did NOT generate keeps its eligibility badge.
    expect(badgeText(dsm)).not.toBe('produced');
  });

  it('clears produced when the scan closes (update(null))', () => {
    const panel = new ProcessStudioPanel();
    panel.update(facts);
    panel.setProduced(['dtm']);
    expect(badgeText(productRow(panel, 'DTM')!)).toBe('produced');
    panel.update(null);   // scan closed
    panel.update(facts);  // same-shaped scan re-loaded
    // Produced did not leak across the close.
    expect(badgeText(productRow(panel, 'DTM')!)).toBe('ready');
  });
});
