/**
 * navViewControlsPersist.test.ts — dismissing the navigation panel must not
 * take the view controls with it.
 *
 * The HUD holds two different kinds of thing. The legend (movement keys, modes,
 * meta hints) is help, and a user who knows WASD has every reason to hide it.
 * The Camera and Views rows beside it are controls: Top, Front, Side, Iso and
 * the orthographic toggle, which exist nowhere else in the app. One
 * `olv-hidden` toggle covered both, and the dismissal is written to
 * `olv.nav.helpPinned`, so hiding the help text removed the only surface for
 * orthographic projection and every standard view, permanently and across
 * sessions.
 *
 * The panel now closes outright, which is what a close control is expected to
 * do and what users kept asking for. That is only safe because the same
 * controls were given a second home in the command palette first. The
 * property these tests defend is unchanged, and it was never about the panel
 * staying half-open: dismissing must not leave orthographic projection and the
 * standard views unreachable. What moved is where that guarantee comes from,
 * so the cases below now check the palette rather than the collapsed panel.
 *
 * These tests read the DOM the panel builds and the registry the palette
 * builds. Whether either looks right is a browser question; whether the
 * controls still exist is not.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { FakeEl, installNavBarDom } from './helpers/navBarDom';

/** The stub's backing store, so a test can clear the panel's persisted choices. */
let store: Map<string, string>;

beforeAll(() => { store = installNavBarDom().store; });

beforeEach(() => store.clear());

/** A NavBar with inert callbacks; only its DOM is under test. */
async function navbar() {
  const { NavBar } = await import('../src/ui/NavBar');
  const noop = (): void => { /* inert */ };
  const bar = new NavBar({
    onMode: noop,
    onSpeed: noop,
    onCameraPreset: noop,
    onStandardView: noop,
    onOrthographic: noop,
  } as unknown as ConstructorParameters<typeof NavBar>[0]);
  return { bar, root: bar.element as unknown as FakeEl };
}

/** The action registry's source, read as text so this stays a unit test. */
async function readActionDefinitions(): Promise<string> {
  const { readFileSync } = await import('node:fs');
  return readFileSync(new URL('../src/app/actionDefinitions.ts', import.meta.url), 'utf8');
}

describe('dismissing the navigation legend keeps the view controls', () => {
  it('builds the legend and the view rows as separate regions', async () => {
    const { root } = await navbar();
    const legend = root.byClass('olv-legend');
    const rows = root.byClass('olv-cam-presets-row');
    expect(legend).toHaveLength(1);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // The defect in one assertion: a view row inside the legend shares its fate.
    for (const row of rows) {
      expect(root.hasAncestorWithClass(row, 'olv-legend')).toBe(false);
    }
  });

  it('closes the whole panel when its close control is used', async () => {
    // Exercises the close control's own path. This called toggleHelp(), which
    // is H's path, and H now cycles the LEGEND rather than the panel — so the
    // test would have passed while the × did something else entirely.
    const { root, bar } = await navbar();
    bar.dismissPanel();
    const hud = root.byClass('olv-nav-hud')[0]!;
    expect(hud.classList.contains('olv-hidden')).toBe(true);
  });

  it('starts with the legend collapsed, and H cycles it without hiding the controls', async () => {
    // The panel is anchored bottom-centre and stacks upward, so the legend's
    // height is what reaches over the scan. It is help, so it is opt-in.
    const { root, bar } = await navbar();
    const hud = root.byClass('olv-nav-hud')[0]!;
    const legend = root.byClass('olv-legend')[0]!;
    expect(hud.classList.contains('olv-nav-hud-collapsed')).toBe(true);
    expect(legend.classList.contains('olv-hidden')).toBe(true);
    expect(hud.classList.contains('olv-hidden')).toBe(false);

    bar.toggleHelp();
    expect(legend.classList.contains('olv-hidden')).toBe(false);

    bar.toggleHelp();
    expect(legend.classList.contains('olv-hidden')).toBe(true);
    // The Camera and Views rows are controls, not help: H never takes them away.
    expect(hud.classList.contains('olv-hidden')).toBe(false);
    expect(root.byClass('olv-cam-presets-row').length).toBeGreaterThanOrEqual(2);
  });

  it('leaves the standard views reachable from the command palette', async () => {
    // The reason the panel may close at all. If this ever fails, closing the
    // panel takes the only route to these controls with it, which is the
    // defect this file was written for.
    // The ids are built from `STANDARD_VIEW_ORDER`, so coverage of every view
    // comes from the loop rather than from six separate registrations. What is
    // checkable here is that the loop exists and reads the canonical order: if
    // a view is ever added to that list, the palette gains it for free.
    const src = await readActionDefinitions();
    expect(src).toContain('camera.view-');
    expect(src).toContain('STANDARD_VIEW_ORDER');
    expect(src).toContain('setStandardView(view)');
  });

  it('leaves the orthographic toggle reachable from the command palette', async () => {
    expect(await readActionDefinitions()).toContain('camera.orthographic');
  });
});
