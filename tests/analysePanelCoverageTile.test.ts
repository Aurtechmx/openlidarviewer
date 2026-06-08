/**
 * analysePanelCoverageTile.test.ts
 *
 * The Analyse panel's surface row exposes a COVERAGE heatmap tile alongside the
 * CHM / relief previews. Runs in the node environment via a small recording DOM
 * stub (same style as analysePanelReportButton.test.ts), driven with a REAL
 * analysis result so the tile actually renders. Asserts:
 *   - the "Coverage (trust)" tile is present with its honesty caption,
 *   - the 3-stop legend (strong / moderate / weak) is rendered,
 *   - the tile carries its own Export PNG button.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { COVERAGE_CAPTION } from '../src/terrain/surface/coverageHeatmap';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  width = 0;
  height = 0;
  href = '';
  download = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = {
    add(): void { /* no-op */ },
    remove(): void { /* no-op */ },
    toggle(): void { /* no-op */ },
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void { /* no-op */ }
  /** Canvas 2D context is unavailable in the stub — the tile path is null-safe. */
  getContext(): null { return null; }
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: 0, height: 0, left: 0, top: 0 };
  }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }
  /** Recursively collect every descendant whose own text equals `label`. */
  findByText(label: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text === label) out.push(this);
    for (const c of this.children) out.push(...c.findByText(label));
    return out;
  }
  /** Recursively collect every descendant whose own text CONTAINS `sub`. */
  findContaining(sub: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text.includes(sub)) out.push(this);
    for (const c of this.children) out.push(...c.findContaining(sub));
    return out;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  };
  (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
});

/** A small hill so the analysis yields measured + interpolated cells. */
function hillScene(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 30; x++) {
    for (let y = 0; y <= 30; y++) {
      const dx = x - 15;
      const dy = y - 15;
      pts.push({ x, y, z: 6 * Math.exp(-(dx * dx + dy * dy) / 200) });
    }
  }
  return pts;
}

describe('AnalysePanel — coverage tile', () => {
  it('renders the Coverage (trust) tile with caption, legend and Export PNG', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const result = analyseContours(hillScene(), {
      cellSizeM: 2,
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
    });
    panel.update(result);
    const root = panel.element as unknown as FakeEl;

    // The tile heading.
    expect(root.findByText('Coverage (trust)').length).toBe(1);

    // The honesty caption — green/yellow/red = measured/interpolated/unreliable.
    expect(root.findContaining(COVERAGE_CAPTION).length).toBeGreaterThan(0);

    // The 3-stop legend words.
    expect(root.findContaining('strong — measured').length).toBe(1);
    expect(root.findContaining('moderate — interpolated').length).toBe(1);
    expect(root.findContaining('weak — extrapolated / gap').length).toBe(1);

    // Coverage tile gets its own Export PNG button (one of several PNG buttons
    // in the surface row — assert at least the coverage one exists).
    expect(root.findByText('Export PNG').length).toBeGreaterThanOrEqual(1);

    // Honesty: nothing in the rendered tree claims survey-grade for coverage.
    expect(root.findContaining('survey-grade coverage').length).toBe(0);
  });
});
