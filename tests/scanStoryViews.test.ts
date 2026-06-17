/**
 * scanStoryViews.test.ts
 *
 * Structure coverage for the Dataset Story card + Export Health summary
 * renderers, via the project's recording DOM stub (same style as
 * analysePanelReportButton.test.ts). Pixels are e2e's job; here we pin that the
 * synthesised facts actually reach the rendered tree.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { buildScanStory, buildExportHealth, type ScanStoryInputs } from '../src/intelligence/scanStory';

class FakeEl {
  className = '';
  title = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void { /* no-op */ }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) { /* unused here */ }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  /** Every class on any node in the subtree (space-split). */
  allClasses(): string[] {
    return [this.className, ...this.children.flatMap((c) => c.allClasses())]
      .flatMap((c) => c.split(' '))
      .filter(Boolean);
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

// Import AFTER the stub is installed (el() touches document at call time only).
const { renderDatasetStoryCard, renderExportHealthPanel } = await import('../src/ui/scanStoryViews');

const GOOD: ScanStoryInputs = {
  captureLabel: 'Aerial / airborne ALS',
  pointCount: 15_700_000,
  areaM2: 1_000_000,
  surfaceTier: 'Good',
  products: [
    { label: 'Profiles', status: 'Ready' },
    { label: 'DTM/DEM export', status: 'Preview' },
  ],
  density: 'dense',
  groundVisibility: 'good',
  coverageMode: 'full',
  crsKnown: true,
  datumKnown: true,
  classification: 'source',
};

describe('renderDatasetStoryCard', () => {
  it('surfaces the headline, assessment, limiter, best-for and next step', () => {
    const node = renderDatasetStoryCard(buildScanStory(GOOD)) as unknown as FakeEl;
    const text = node.textContent;
    expect(text).toContain('Dataset Story');
    expect(text).toContain('Aerial / airborne ALS');
    expect(text).toContain('Good');
    expect(text).toContain('Primary limiter');
    expect(text).toContain('Profiles');
    expect(text).toContain('→'); // next-step marker
    expect(node.allClasses()).toContain('is-good');
  });

  it('omits the caution / not-recommended rows when nothing is held back', () => {
    const allReady = buildScanStory({
      ...GOOD,
      products: [
        { label: 'Profiles', status: 'Ready' },
        { label: 'DTM/DEM export', status: 'Ready' },
      ],
    });
    const node = renderDatasetStoryCard(allReady) as unknown as FakeEl;
    expect(node.textContent).not.toContain('Use with caution');
    expect(node.textContent).not.toContain('Not recommended');
  });

  it('shows the caution + not-recommended rows when products are held back', () => {
    const story = buildScanStory({
      ...GOOD,
      surfaceTier: 'Limited',
      products: [
        { label: 'Profiles', status: 'Ready' },
        { label: 'DTM/DEM export', status: 'Preview' },
        { label: 'Contours', status: 'Blocked' },
      ],
    });
    const text = (renderDatasetStoryCard(story) as unknown as FakeEl).textContent;
    expect(text).toContain('Use with caution');
    expect(text).toContain('DTM/DEM export');
    expect(text).toContain('Not recommended');
    expect(text).toContain('Contours');
  });
});

describe('renderExportHealthPanel', () => {
  it('renders the verdict, every row, and no blocker list when ready', () => {
    const node = renderExportHealthPanel(buildExportHealth(GOOD)) as unknown as FakeEl;
    const text = node.textContent;
    expect(text).toContain('Ready to export');
    expect(text).toContain('Scan scope');
    expect(text).toContain('Classification');
    expect(node.textContent).not.toContain('Before you hand this off');
    expect(node.allClasses()).toContain('is-ready');
  });

  it('renders blockers + a caution verdict for a derived, ungeoreferenced preview', () => {
    const health = buildExportHealth({
      ...GOOD,
      coverageMode: 'resident-only',
      classification: 'derived',
      classConfidence: 0.42,
      crsKnown: false,
    });
    const node = renderExportHealthPanel(health) as unknown as FakeEl;
    const text = node.textContent;
    expect(text).toContain('Export with caution');
    expect(text).toContain('Before you hand this off');
    expect(text).toContain('heuristic');
    expect(text).toContain('42% confidence');
    expect(node.allClasses()).toContain('is-caution');
  });
});
