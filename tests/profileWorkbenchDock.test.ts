/**
 * profileWorkbenchDock.test.ts
 *
 * The dock shares the stage's height with the 3D canvas, so "the scene stays
 * visible with the workbench open" is a number, not a styling intention.
 * These hold that number at every stage size, including sizes too small to
 * satisfy the dock's own minimum.
 */
import { describe, it, expect } from 'vitest';
import {
  clampDockHeight,
  defaultDockHeight,
  maxDockHeight,
  dockOccupiedHeight,
  sceneHeightFor,
  resizeDock,
  toggleDockCollapsed,
  initialDockState,
  encodeDockPrefs,
  decodeDockPrefs,
  restoreDockState,
  MIN_DOCK_HEIGHT,
  MIN_SCENE_HEIGHT,
  COLLAPSED_DOCK_HEIGHT,
  DEFAULT_DOCK_FRACTION,
  type DockState,
} from '../src/ui/profileWorkbenchDock';

const stage = (h: number) => ({ stageHeight: h });
const SIZES = [1, 2, 20, 36, 100, 140, 141, 200, 259, 260, 261, 400, 720, 1080, 2160, 8000];

describe('the scene keeps height whatever the dock does', () => {
  it('leaves the scene a positive height at every stage with any height', () => {
    // Regression: a stage at or below the dock's own minimum used to hand the
    // dock everything and leave the canvas a zero-height buffer, which no
    // drag could recover from.
    for (const h of SIZES) {
      for (const collapsed of [false, true]) {
        for (const want of [-1e6, 0, 1, 200, 5000, 1e6, Number.NaN]) {
          const s: DockState = { preferredHeightPx: want, collapsed };
          const scene = sceneHeightFor(s, stage(h));
          expect(scene).toBeGreaterThan(0);
          expect(Number.isFinite(scene)).toBe(true);
        }
      }
    }
  });

  it('returns zero only for a stage with no height', () => {
    for (const h of [0, -10, Number.NaN]) {
      expect(sceneHeightFor({ preferredHeightPx: 400, collapsed: false }, stage(h))).toBe(0);
    }
  });

  it('keeps the documented scene minimum whenever the stage can afford it', () => {
    for (const h of SIZES) {
      if (h < MIN_SCENE_HEIGHT + MIN_DOCK_HEIGHT) continue;
      const open = clampDockHeight(Number.POSITIVE_INFINITY, stage(h));
      expect(
        sceneHeightFor({ preferredHeightPx: open, collapsed: false }, stage(h)),
      ).toBeGreaterThanOrEqual(MIN_SCENE_HEIGHT);
    }
  });

  it('splits a stage too short for both minimums', () => {
    // 200 cannot give the dock 140 and the scene 120 at once.
    const s = initialDockState(stage(200));
    expect(dockOccupiedHeight(s, stage(200))).toBe(100);
    expect(sceneHeightFor(s, stage(200))).toBe(100);
    // 140 is exactly the dock minimum, and still leaves the scene half.
    const t = initialDockState(stage(140));
    expect(dockOccupiedHeight(t, stage(140))).toBe(70);
    expect(sceneHeightFor(t, stage(140))).toBe(70);
  });

  it('adds up to the stage exactly', () => {
    for (const h of SIZES) {
      const s = initialDockState(stage(h));
      expect(dockOccupiedHeight(s, stage(h)) + sceneHeightFor(s, stage(h))).toBe(h);
    }
  });

  it('shrinks even the collapsed header on a stage that cannot hold it', () => {
    const s: DockState = { preferredHeightPx: 400, collapsed: true };
    expect(dockOccupiedHeight(s, stage(1000))).toBe(COLLAPSED_DOCK_HEIGHT);
    expect(dockOccupiedHeight(s, stage(40))).toBe(20);
    expect(sceneHeightFor(s, stage(40))).toBe(20);
  });
});

describe('default height', () => {
  it('takes the documented fraction of a roomy stage', () => {
    expect(defaultDockHeight(stage(1000))).toBe(Math.round(1000 * DEFAULT_DOCK_FRACTION));
  });

  it('never exceeds what the stage can spare', () => {
    for (const h of SIZES) {
      expect(defaultDockHeight(stage(h))).toBeLessThanOrEqual(maxDockHeight(stage(h)));
    }
  });
});

describe('splitter drag', () => {
  const limits = stage(1000);

  it('grows the dock when dragged upward', () => {
    expect(resizeDock({ preferredHeightPx: 400, collapsed: false }, -50, limits).preferredHeightPx)
      .toBe(450);
  });

  it('shrinks the dock when dragged downward', () => {
    expect(resizeDock({ preferredHeightPx: 400, collapsed: false }, 50, limits).preferredHeightPx)
      .toBe(350);
  });

  it('clamps rather than letting a drag eat the scene', () => {
    const s: DockState = { preferredHeightPx: 400, collapsed: false };
    const huge = resizeDock(s, -100000, limits);
    expect(huge.preferredHeightPx).toBe(maxDockHeight(limits));
    expect(sceneHeightFor(huge, limits)).toBe(MIN_SCENE_HEIGHT);
    expect(resizeDock(s, 100000, limits).preferredHeightPx).toBe(MIN_DOCK_HEIGHT);
  });

  it('reopens a collapsed dock only on an upward drag', () => {
    const s: DockState = { preferredHeightPx: 400, collapsed: true };
    const up = resizeDock(s, -100, limits);
    expect(up.collapsed).toBe(false);
    expect(up.preferredHeightPx).toBe(clampDockHeight(COLLAPSED_DOCK_HEIGHT + 100, limits));
  });

  it('leaves a collapsed dock alone when dragged downward', () => {
    // Regression: a downward drag used to reopen the dock and grow it from
    // the header to the minimum, moving the surface opposite the gesture.
    const s: DockState = { preferredHeightPx: 400, collapsed: true };
    for (const dy of [0, 1, 10, 50, 100, 1000]) {
      expect(resizeDock(s, dy, limits)).toEqual(s);
    }
  });

  it('drags from the height on screen, not from an unhonoured preference', () => {
    // On a stage too small for the preference, the surface must follow the
    // pointer from where it actually sits.
    const small = stage(400);
    const s: DockState = { preferredHeightPx: 5000, collapsed: false };
    const shown = dockOccupiedHeight(s, small);
    expect(resizeDock(s, 40, small).preferredHeightPx).toBe(clampDockHeight(shown - 40, small));
  });

  it('ignores a non-finite delta', () => {
    expect(resizeDock({ preferredHeightPx: 400, collapsed: false }, Number.NaN, limits)
      .preferredHeightPx).toBe(400);
  });
});

describe('collapse', () => {
  it('retains the open height so restore returns to it', () => {
    const open: DockState = { preferredHeightPx: 512, collapsed: false };
    const collapsed = toggleDockCollapsed(open);
    expect(collapsed).toEqual({ preferredHeightPx: 512, collapsed: true });
    expect(toggleDockCollapsed(collapsed)).toEqual(open);
  });
});

describe('stage resize', () => {
  it('returns the user height after any sequence of stage sizes', () => {
    // Regression: the preference used to be clamped in place, so shrinking
    // the window and growing it again left the clamped remnant behind.
    const chosen: DockState = { preferredHeightPx: 600, collapsed: false };
    expect(dockOccupiedHeight(chosen, stage(400))).toBeLessThan(600);
    expect(dockOccupiedHeight(chosen, stage(1200))).toBe(600);
    for (const h of SIZES) dockOccupiedHeight(chosen, stage(h));
    expect(chosen.preferredHeightPx).toBe(600);
    expect(dockOccupiedHeight(chosen, stage(1200))).toBe(600);
  });

  it('keeps the collapsed flag across a resize', () => {
    const s: DockState = { preferredHeightPx: 600, collapsed: true };
    expect(dockOccupiedHeight(s, stage(300))).toBe(COLLAPSED_DOCK_HEIGHT);
    expect(s.collapsed).toBe(true);
  });
});

describe('persistence', () => {
  it('round trips', () => {
    const s: DockState = { preferredHeightPx: 377, collapsed: true };
    expect(decodeDockPrefs(encodeDockPrefs(s))).toEqual({ heightPx: 377, collapsed: true });
  });

  it('rejects anything that is not a preference, without throwing', () => {
    for (const raw of [
      null, '', 'not json', '[]', 'null', '"str"', '42', '{}',
      '{"heightPx":400}', '{"collapsed":true}',
      '{"heightPx":"400","collapsed":true}', '{"heightPx":400,"collapsed":"yes"}',
      '{"heightPx":null,"collapsed":false}', '{"heightPx":0,"collapsed":false}',
      '{"heightPx":-10,"collapsed":false}', '{"heightPx":1e999,"collapsed":false}',
    ]) {
      expect(decodeDockPrefs(raw)).toBeNull();
    }
  });

  it('opens at the default when the stored value is corrupt', () => {
    expect(restoreDockState('{{{', stage(1000))).toEqual(initialDockState(stage(1000)));
    expect(restoreDockState(null, stage(1000))).toEqual(initialDockState(stage(1000)));
  });

  it('keeps a stored height that no longer fits, and honours it again later', () => {
    // Regression: restoring on a small stage used to overwrite the stored
    // height with the clamped one, losing it for every later stage.
    const raw = encodeDockPrefs({ preferredHeightPx: 900, collapsed: false });
    const s = restoreDockState(raw, stage(600));
    expect(s.preferredHeightPx).toBe(900);
    expect(dockOccupiedHeight(s, stage(600))).toBe(maxDockHeight(stage(600)));
    expect(sceneHeightFor(s, stage(600))).toBe(MIN_SCENE_HEIGHT);
    expect(dockOccupiedHeight(s, stage(2000))).toBe(900);
  });
});
