/**
 * exportPanelPillsAria.test.ts
 *
 * The Export panel's format (LAS 1.4 / LAS / LAZ / XYZ / ASC) and CRS
 * (Keep / Assign EPSG / Reproject) pill rows signalled the selected option
 * only through the `is-active` CSS class — no `aria-pressed` (v0.7 audit,
 * finding OUTPUT-F3), unlike every other single-choice toggle-button group
 * in this codebase (NavBar, Inspector, AnalysePanel, contourStudioWorkspace,
 * WorkflowConfigPanel…). Pins that `_renderFormatPills`/`_renderCrsPills`
 * now set `aria-pressed` alongside `is-active`, both on the initial render
 * and after a pill click re-renders the row.
 *
 * Runs in the node environment via a recording DOM stub extending the
 * exportPanelCrs.test.ts FakeEl with a working `addEventListener`/`click()`
 * pair, since the fix is only observable across a click-driven re-render.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl as BaseFakeEl } from './helpers/exportPanelPillDomFake';

/**
 * The base stub's `addEventListener` is a no-op — most ExportPanel tests
 * only read the rendered tree — but this suite drives a pill click and
 * observes the re-render, so it needs a real listener/`click()` pair.
 */
class FakeEl extends BaseFakeEl {
  private readonly _listeners: Record<string, (() => void)[]> = {};
  override addEventListener(type: string, handler: () => void): void {
    (this._listeners[type] ??= []).push(handler);
  }
  click(): void {
    for (const h of this._listeners.click ?? []) h();
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

async function makePanel() {
  const { ExportPanel } = await import('../src/ui/ExportPanel');
  const panel = new ExportPanel({
    getCloud: () => null,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
  });
  const root = panel.element as unknown as FakeEl;
  return { panel, root };
}

describe('ExportPanel — format pills expose aria-pressed (OUTPUT-F3)', () => {
  it('the default format (LAS 1.4) is pressed; the rest are not', async () => {
    const { root } = await makePanel();
    const las14 = root.findOwnText('LAS 1.4')[0];
    expect(las14.attrs['aria-pressed']).toBe('true');
    const xyz = root.findOwnText('XYZ')[0];
    expect(xyz.attrs['aria-pressed']).toBe('false');
  });

  it('clicking XYZ flips aria-pressed on both the newly active and newly inactive pills', async () => {
    const { root } = await makePanel();
    (root.findOwnText('XYZ')[0] as FakeEl).click();
    const xyz = root.findOwnText('XYZ')[0];
    const las14 = root.findOwnText('LAS 1.4')[0];
    expect(xyz.attrs['aria-pressed']).toBe('true');
    expect(las14.attrs['aria-pressed']).toBe('false');
  });

  it('the disabled LAZ pill (unavailable in-browser) is aria-pressed="false" and never clickable-active', async () => {
    const { root } = await makePanel();
    const laz = root.findOwnText('LAZ')[0];
    expect(laz.attrs['aria-pressed']).toBe('false');
    expect(laz.disabled).toBe(true);
  });
});

describe('ExportPanel — CRS pills expose aria-pressed (OUTPUT-F3)', () => {
  it('the default mode (Keep) is pressed; the rest are not', async () => {
    const { root } = await makePanel();
    const keep = root.findOwnText('Keep')[0];
    const reproject = root.findOwnText('Reproject')[0];
    expect(keep.attrs['aria-pressed']).toBe('true');
    expect(reproject.attrs['aria-pressed']).toBe('false');
  });

  it('clicking Reproject flips aria-pressed on both the newly active and newly inactive pills', async () => {
    const { root } = await makePanel();
    (root.findOwnText('Reproject')[0] as FakeEl).click();
    const reproject = root.findOwnText('Reproject')[0];
    const keep = root.findOwnText('Keep')[0];
    expect(reproject.attrs['aria-pressed']).toBe('true');
    expect(keep.attrs['aria-pressed']).toBe('false');
  });
});
