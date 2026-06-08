/**
 * workflowCardRender.test.ts
 *
 * DOM-stub coverage for the two new render surfaces in the Analyse panel:
 *   - the "Recommended workflow" card (one row per workflow, with a status
 *     class + glyph + label + optional note), and
 *   - the "Why? — what's holding this back" <details>, which renders ONLY when
 *     the surface is not fully-good (i.e. there are causes to explain).
 *
 * Runs in the node environment with the same minimal recording DOM stub used by
 * tests/scanTypeControl.test.ts — the builders only touch createElement +
 * className/textContent/append + a couple of attributes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { WorkflowItem } from '../src/terrain/contour/recommendedWorkflow';
import type { Limitations } from '../src/terrain/contour/whyNotReasons';

class FakeEl {
  title = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  private readonly _classes = new Set<string>();
  private readonly _attrs = new Map<string, string>();
  readonly tagName: string;
  readonly classList = {
    contains: (c: string): boolean => this._classes.has(c),
    add: (c: string): void => { this._classes.add(c); },
  };
  constructor(tagName: string) { this.tagName = tagName; }
  set className(v: string) {
    this._classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this._classes.add(c);
  }
  get className(): string { return [...this._classes].join(' '); }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  setAttribute(k: string, v: string): void { this._attrs.set(k, v); }
  getAttribute(k: string): string | null { return this._attrs.get(k) ?? null; }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  find(cls: string): FakeEl | null {
    if (this.classList.contains(cls)) return this;
    for (const c of this.children) { const hit = c.find(cls); if (hit) return hit; }
    return null;
  }
  findAll(cls: string, acc: FakeEl[] = []): FakeEl[] {
    if (this.classList.contains(cls)) acc.push(this);
    for (const c of this.children) c.findAll(cls, acc);
    return acc;
  }
  findTag(tag: string, acc: FakeEl[] = []): FakeEl[] {
    if (this.tagName === tag) acc.push(this);
    for (const c of this.children) c.findTag(tag, acc);
    return acc;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

async function load() {
  return import('../src/ui/workflowCardRender');
}

const ITEMS: WorkflowItem[] = [
  { label: 'Profile analysis', status: 'good' },
  { label: 'Measurement review', status: 'good' },
  { label: 'Surface sampling / inspection', status: 'good' },
  { label: 'DEM export', status: 'caution', note: 'georeferencing incomplete' },
  { label: 'Contour generation', status: 'caution', note: 'georeferencing incomplete' },
  { label: 'Map sheet (PDF)', status: 'blocked', note: 'quality gate stopped this surface' },
];

describe('renderWorkflowCard', () => {
  it('renders one row per workflow with the right status class + label', async () => {
    const { renderWorkflowCard } = await load();
    const card = renderWorkflowCard(ITEMS) as unknown as FakeEl;
    const rows = card.findAll('olv-analyse-workflow-row');
    expect(rows.length).toBe(ITEMS.length);
    expect(rows[0].classList.contains('is-good')).toBe(true);
    expect(rows[3].classList.contains('is-caution')).toBe(true);
    expect(rows[5].classList.contains('is-blocked')).toBe(true);
    // Labels and notes are present in the rendered text.
    expect(card.textContent).toContain('Profile analysis');
    expect(card.textContent).toContain('DEM export');
    expect(card.textContent).toContain('georeferencing incomplete');
  });

  it('puts a glyph on each row (✓ / ⚠ / ✕)', async () => {
    const { renderWorkflowCard } = await load();
    const card = renderWorkflowCard(ITEMS) as unknown as FakeEl;
    const glyphs = card.findAll('olv-analyse-workflow-glyph');
    expect(glyphs.length).toBe(ITEMS.length);
    expect(glyphs[0].textContent).toBe('✓');
    expect(glyphs[3].textContent).toBe('⚠');
    expect(glyphs[5].textContent).toBe('✕');
  });
});

describe('renderWhyDetails', () => {
  const LIM: Limitations = {
    causes: [
      { key: 'interpolation', text: '55% of the surface is interpolated, not measured.' },
      { key: 'datum', text: 'The vertical datum is unknown.' },
    ],
    fixes: [
      { key: 'interpolation', text: 'Fly lower, increase overlap, or scan more densely.' },
      { key: 'datum', text: 'Provide the vertical datum.' },
    ],
  };

  it('renders a <details> with the causes and fixes when there are causes', async () => {
    const { renderWhyDetails } = await load();
    const node = renderWhyDetails(LIM) as unknown as FakeEl | null;
    expect(node).not.toBeNull();
    expect(node!.tagName).toBe('details');
    expect(node!.findTag('summary').length).toBe(1);
    expect(node!.textContent).toContain('55% of the surface is interpolated');
    expect(node!.textContent).toContain('Provide the vertical datum');
    // Two short lists: Why (causes) and How to improve (fixes).
    expect(node!.findAll('olv-analyse-why-cause').length).toBe(2);
    expect(node!.findAll('olv-analyse-why-fix').length).toBe(2);
  });

  it('renders nothing when there are no causes (fully-good surface)', async () => {
    const { renderWhyDetails } = await load();
    const node = renderWhyDetails({ causes: [], fixes: [] });
    expect(node).toBeNull();
  });
});
