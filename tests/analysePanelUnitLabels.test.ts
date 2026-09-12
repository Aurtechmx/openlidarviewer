/**
 * analysePanelUnitLabels.test.ts — the validation row captions its figures in
 * the unit they are actually in.
 *
 * Every number on that row is a hold-out residual, and `holdoutRmse` computes
 * `residual = (z - predicted) * verticalUnitToMetres` with an inert fallback of
 * 1. On a frame that states no vertical scale the residuals are therefore in the
 * source Z unit — feet, millimetres, arbitrary scanner units — while the panel
 * stamped " m" on the overall RMSE, on the per-slope and per-zone strata, on the
 * measured-reliability tolerance and on the blocked RMSE.
 *
 * The metre-named ASPRS fields (`rmseZM`, `nvaM`, `vvaM`) were already withheld
 * on such a frame. These four rows sat beside them, captioned m, from the same
 * residuals: the analysis refused to state a standard while the panel printed
 * the quantity the standard is computed from.
 *
 * Rendered through the same recording DOM stub the other panel tests use, so
 * this asserts what a user reads rather than what a formatter was passed.
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
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }
  /** Every `title` attribute in the tree — the panel's hover hints. */
  hints(): string[] {
    const out: string[] = this.title === '' ? [] : [this.title];
    for (const c of this.children) out.push(...c.hints());
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

/**
 * A hill with enough relief and spread to produce a hold-out RMSE, both slope
 * bands and a blocked-hold-out figure. Without all three the assertions below
 * would pass on an empty row.
 */
function hillScene(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 40; x++) {
    for (let y = 0; y <= 40; y++) {
      const dx = x - 20;
      const dy = y - 20;
      pts.push({ x, y, z: 8 * Math.exp(-(dx * dx + dy * dy) / 220) + ((x * 7 + y * 3) % 5) * 0.01 });
    }
  }
  return pts;
}

const BASE = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' } as const;

/** Render the panel for one analysis and return the whole validation row's text. */
async function renderValidationText(
  params: Parameters<typeof analyseContours>[1],
): Promise<{ text: string; hints: string[] }> {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  const panel = new AnalysePanel({});
  panel.update(analyseContours(hillScene(), params));
  const root = panel.element as unknown as FakeEl;
  return { text: root.textContent, hints: root.hints() };
}

describe('the validation row states the unit its residuals are in', () => {
  it('says metres when the frame states a vertical scale', async () => {
    const { text } = await renderValidationText({
      ...BASE, horizontalUnitToMetres: 1, verticalUnitToMetres: 1,
    });
    // The fixture must actually produce these rows, or the unresolved-frame
    // assertions below prove nothing: an absent row has no caption to get wrong.
    expect(text, 'the fixture produced no overall RMSE').toMatch(/Vertical RMSE: [\d.]+ m/);
    expect(text, 'the fixture produced no blocked RMSE').toMatch(/Blocked RMSE: [\d.]+ m/);
  });

  it('does not call source Z units metres when no vertical scale resolved', async () => {
    // No `verticalUnitToMetres`: holdoutRmse falls back to an inert 1 and the
    // residuals stay in whatever the file's Z axis is.
    const { text } = await renderValidationText({ ...BASE, horizontalUnitToMetres: 1 });
    expect(text, 'an unresolved frame still produced a figure captioned "m"')
      .not.toMatch(/Vertical RMSE: [\d.]+ m\b/);
    expect(text).not.toMatch(/Blocked RMSE: [\d.]+ m\b/);
    expect(text).not.toMatch(/RMSE by slope:[^|]*? m\b/);
    expect(text).not.toMatch(/RMSE by zone:[^|]*? m\b/);
    expect(text).not.toMatch(/\|Δz\| ≤ [\d.]+ m\b/);
    // And it still reports the figure, under the unit it is genuinely in — the
    // residual statistics are unaffected, only the caption was wrong.
    expect(text).toMatch(/Vertical RMSE: [\d.]+ source Z units/);
  });
});

describe('the blocked hold-out is not described as the random one plus a gap', () => {
  it('names both treatments instead of attributing the difference to geometry', async () => {
    const { hints } = await renderValidationText({
      ...BASE, horizontalUnitToMetres: 1, verticalUnitToMetres: 1,
    });
    const blocked = hints.find((h) => h.startsWith('Spatially-blocked cross-validation'));
    expect(blocked, 'no blocked-RMSE hint was rendered').toBeDefined();

    // The withheld blocks are data the scan HAS. Calling them a real gap
    // described a different experiment from the one that ran.
    expect(blocked).not.toMatch(/real gap/);
    // Neither ordering is guaranteed, and the two figures differ in TREATMENT as
    // well as geometry: the random hold-out re-runs ground classification on the
    // training points only, the blocked pass keeps the whole-cloud mask. Naming
    // one "optimistic" because of where its points sit asserts a cause that the
    // confounded comparison cannot support.
    expect(blocked).not.toMatch(/runs larger/);
    expect(blocked).not.toMatch(/is optimistic/);
    expect(blocked).toMatch(/classification/);
    expect(blocked).toMatch(/neither is guaranteed the larger/);
  });
});
