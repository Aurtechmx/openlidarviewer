/**
 * analyseRailBanner.test.ts — v0.5.5 P12 Analyse-rail consolidation pins.
 *
 * Two duplication defects, pinned against a REAL analysis result rendered
 * through the panel (node environment via the same recording DOM stub as
 * analysePanelCoverageTile.test.ts):
 *
 *  1. SINGLE-BANNER PIN — the DEM caveat ("Preliminary DEM — …") and the
 *     contour preview caveat ("Preview export — not survey-grade …") used to
 *     stack as two adjacent banners. When both apply they must render as ONE
 *     consolidated caveat that still states BOTH facts (preliminary DEM
 *     coverage/readiness + not-survey-grade + README caveat). When neither
 *     applies, no banner renders.
 *
 *  2. COMPACT TILE FOOTERS — each raster tile (coverage / relief / canopy)
 *     used to stack a full-width "Click the map to sample a point." row above
 *     a full-width "Export PNG" row. The readout + action now share one
 *     compact `.olv-analyse-tile-footer` line per tile; the hint text and the
 *     export button are both still present (nothing disclosed is removed).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
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
  removeAttribute(): void { /* no-op */ }
  getContext(): null { return null; }
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: 0, height: 0, left: 0, top: 0 };
  }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  /** Own text only — no descendant concatenation. */
  get ownText(): string { return this._text; }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }
  /** Every descendant (incl. self) whose OWN text contains `sub`. */
  findContaining(sub: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text.includes(sub)) out.push(this);
    for (const c of this.children) out.push(...c.findContaining(sub));
    return out;
  }
  /** Every descendant (incl. self) whose className contains `cls`. */
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
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

/** A small hill so the analysis yields real contours + coverage. */
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

describe('AnalysePanel — consolidated not-survey-grade banner', () => {
  it('preview readiness renders ONE caveat stating both facts, not two stacked banners', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    // No CRS / datum → the export gate lands on previewOnly with reasons.
    const result = analyseContours(hillScene(), { cellSizeM: 2 });
    expect(result.quality.exportReadiness).toBe('previewOnly');
    expect(result.model.features.length).toBeGreaterThan(0);
    panel.update(result);
    const root = panel.element as unknown as FakeEl;

    // Exactly one banner element carries the DEM caveat…
    const dem = root.findContaining('Preliminary DEM');
    expect(dem.length).toBe(1);
    // …and that single banner states BOTH facts (nothing disclosed is lost).
    expect(dem[0].ownText).toContain('not survey-grade');
    expect(dem[0].ownText).toContain('README');
    expect(dem[0].ownText).toContain('export readiness: preview');

    // The old second banner no longer renders as a separate element.
    const previewBanners = root.findContaining('Preview export — not survey-grade');
    expect(previewBanners.length).toBe(0);

    // Total "not survey-grade" statements in the export area: one.
    expect(root.findContaining('not survey-grade').length).toBe(1);
  });

  it('fully georeferenced full-coverage result renders NO caveat banner', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const result = analyseContours(hillScene(), {
      cellSizeM: 2,
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
    });
    panel.update(result);
    const root = panel.element as unknown as FakeEl;
    if (result.quality.exportReadiness === 'available' && result.dtm.coverageMode === 'full') {
      expect(root.findContaining('Preliminary DEM').length).toBe(0);
      expect(root.findContaining('Preview export').length).toBe(0);
    } else {
      // Georeferenced but still partial → a single banner, never two.
      expect(root.findContaining('Preliminary DEM').length).toBeLessThanOrEqual(1);
      expect(root.findContaining('not survey-grade').length).toBeLessThanOrEqual(1);
    }
  });
});

describe('AnalysePanel — compact per-tile footers', () => {
  it('each raster tile carries ONE footer line holding the sample hint + Export PNG', async () => {
    const { AnalysePanel } = await import('../src/ui/AnalysePanel');
    const panel = new AnalysePanel({});
    const result = analyseContours(hillScene(), {
      cellSizeM: 2,
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
    });
    panel.update(result);
    const root = panel.element as unknown as FakeEl;

    const footers = root.findByClass('olv-analyse-tile-footer');
    // Coverage + relief tiles at minimum (canopy joins when the CHM renders).
    expect(footers.length).toBeGreaterThanOrEqual(2);
    for (const footer of footers) {
      // The hint readout and the export action share the single footer line.
      expect(footer.findByClass('olv-analyse-sample').length).toBe(1);
      expect(footer.findContaining('Export PNG').length).toBe(1);
    }

    // Nothing disclosed was removed: every hint readout still exists, one per
    // tile footer (none stacked as standalone full-width rows any more).
    const hints = root.findContaining('Click the map to sample a point.');
    expect(hints.length).toBe(footers.length);
    for (const hint of hints) {
      expect(footers.some((f) => f.findByClass('olv-analyse-sample').includes(hint))).toBe(true);
    }
  });
});
