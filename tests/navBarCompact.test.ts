/**
 * navBarCompact.test.ts — the compact navigation row.
 *
 * Orbit | Walk | Fly | Pan is one segmented control; Frame all sits beside it;
 * the six axis views live in a "More" disclosure that only a click opens and
 * that is never persisted. The one-time desktop hint shows once ever, and the
 * prompt carries the existing hold-Space sentence while a modal tool is armed.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { FakeEl, installNavBarDom } from './helpers/navBarDom';
import { STANDARD_VIEW_ORDER } from '../src/render/camera/cameraPresets';

let store: Map<string, string>;

beforeAll(() => {
  store = installNavBarDom({ window: true }).store;
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
  w.setTimeout = (): number => 1;
  w.clearTimeout = (): void => {};
});

beforeEach(() => store.clear());

async function navbar() {
  const { NavBar } = await import('../src/ui/NavBar');
  const noop = (): void => { /* inert */ };
  const bar = new NavBar({
    onMode: noop, onSpeed: noop, onReset: noop, onCameraPreset: noop,
    onStandardView: noop, onOrthographic: noop, onPlanView: noop,
  });
  return { bar, root: bar.element as unknown as FakeEl };
}

describe('the compact mode selector', () => {
  it('is one segmented group of Orbit, Walk, Fly and Pan, in that order', async () => {
    const { root } = await navbar();
    const group = root.byClass('olv-modes-segmented');
    expect(group).toHaveLength(1);
    expect(group[0].attrs.role).toBe('group');
    const labels = group[0].byClass('olv-mode').map((b) => b.byClass('olv-mode-label')[0].textContent);
    expect(labels).toEqual(['Orbit', 'Walk', 'Fly', 'Pan']);
    // No triangle artwork is left behind.
    expect(root.byClass('olv-modes-tri-bg')).toHaveLength(0);
    expect(root.byClass('olv-modes-triangle')).toHaveLength(0);
  });

  it('keeps Frame all beside the selector and Pan capability gating', async () => {
    const { root, bar } = await navbar();
    const row = root.byClass('olv-nav-row')[0];
    expect(row.byClass('olv-mode-reset')).toHaveLength(1);
    bar.setPanAvailable(false);
    expect(root.byClass('olv-mode-pan')[0].classList.contains('olv-hidden')).toBe(true);
  });

  it('reflects the active mode with aria-pressed', async () => {
    const { root, bar } = await navbar();
    bar.setMode('fly');
    const pressed = root.byClass('olv-mode').filter((b) => b.attrs['aria-pressed'] === 'true');
    expect(pressed.map((b) => b.byClass('olv-mode-label')[0].textContent)).toEqual(['Fly']);
  });
});

describe('the "More" disclosure', () => {
  it('holds all six axis views and starts closed', async () => {
    const { root, bar } = await navbar();
    const menu = root.byClass('olv-nav-more-menu')[0];
    expect(menu.classList.contains('olv-hidden')).toBe(true);
    expect(bar.isMoreOpen()).toBe(false);
    expect(menu.byClass('olv-cam-chip')).toHaveLength(STANDARD_VIEW_ORDER.length);
    expect(root.byClass('olv-nav-more')[0].attrs['aria-expanded']).toBe('false');
  });

  it('opens and closes on request, and never on its own during navigation', async () => {
    const { root, bar } = await navbar();
    bar.setMoreOpen(true);
    expect(root.byClass('olv-nav-more')[0].attrs['aria-expanded']).toBe('true');
    // Mode changes, pointer lock, measuring and help do not touch it…
    bar.setMoreOpen(false);
    bar.setMode('walk');
    bar.setLocked(true);
    bar.setMeasuring(true);
    bar.toggleHelp();
    expect(bar.isMoreOpen()).toBe(false);
    // …and it writes nothing to storage.
    bar.setMoreOpen(true);
    expect([...store.keys()].some((k) => /more/i.test(k))).toBe(false);
  });

  it('the axis views stay reachable with the navigation panel dismissed', async () => {
    const { root, bar } = await navbar();
    bar.dismissPanel();
    const more = root.byClass('olv-nav-more-menu')[0];
    expect(root.hasAncestorWithClass(more, 'olv-nav-hud')).toBe(false);
  });
});

describe('guidance', () => {
  it('shows the first-use hint once ever, with the agreed wording', async () => {
    const { bar } = await navbar();
    const hint = bar.touchHint as unknown as FakeEl;
    bar.flashFirstUseHint();
    expect(hint.allText()).toContain('Drag to orbit · Scroll to zoom · Double-click to focus');
    expect(hint.classList.contains('olv-visible')).toBe(true);
    bar.hideTouchHint();
    expect(hint.classList.contains('olv-visible')).toBe(false);
    // A second scan, or a second session (same storage), does not bring it back.
    const again = await navbar();
    again.bar.flashFirstUseHint();
    expect((again.bar.touchHint as unknown as FakeEl).classList.contains('olv-visible')).toBe(false);
  });

  it('the phone gesture hint keeps its own text after the desktop hint used the card', async () => {
    const { bar } = await navbar();
    bar.flashFirstUseHint();
    bar.hideTouchHint();
    bar.flashTouchHint();
    expect((bar.touchHint as unknown as FakeEl).allText()).toContain('Pinch to zoom');
  });

  it('while a modal tool is armed the prompt offers hold-Space, in the Help guide’s words', async () => {
    const { bar } = await navbar();
    const prompt = bar.prompt as unknown as FakeEl;
    bar.setMeasuring(true);
    expect(prompt.classList.contains('olv-visible')).toBe(true);
    expect(prompt.allText()).toContain('Hold Space while a tool is active to rotate or pan, then release to resume.');
    bar.setMeasuring(false);
    expect(prompt.classList.contains('olv-visible')).toBe(false);
    const { readFileSync } = await import('node:fs');
    const help = readFileSync(new URL('../src/app/helpCatalog.ts', import.meta.url), 'utf8');
    expect(help).toContain('Hold Space while a tool is active to rotate or pan, then release to resume.');
  });
});
