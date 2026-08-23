/**
 * profileWorkbenchDock.test.ts
 *
 * The dock shares the stage's height with the 3D canvas, so "the scene stays
 * visible with the workbench open" is a number, not a styling intention.
 * These hold that number at every stage size, including ones too small to
 * satisfy everything.
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
  refitDock,
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

describe('the scene keeps height whatever the dock does', () => {
  const SIZES = [0, 1, 100, 200, 260, 400, 720, 1080, 2160, 8000];

  it('never leaves the scene negative', () => {
    for (const h of SIZES) {
      for (const collapsed of [false, true]) {
        for (const want of [-1e6, 0, 1, 200, 1e6, Number.NaN]) {
          const s: DockState = { heightPx: want, collapsed };
          expect(sceneHeightFor(s, stage(h))).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('keeps the documented scene minimum whenever the stage can afford it', () => {
    for (const h of SIZES) {
      if (h < MIN_SCENE_HEIGHT + MIN_DOCK_HEIGHT) continue;
      const open = clampDockHeight(Number.POSITIVE_INFINITY, stage(h));
      expect(sceneHeightFor({ heightPx: open, collapsed: false }, stage(h))).toBeGreaterThanOrEqual(
        MIN_SCENE_HEIGHT,
      );
    }
  });

  it('yields a cramped layout rather than a negative one on a tiny stage', () => {
    // 200 px cannot give the dock 140 and the scene 120 at once.
    const s = initialDockState(stage(200));
    expect(dockOccupiedHeight(s, stage(200))).toBe(MIN_DOCK_HEIGHT);
    expect(sceneHeightFor(s, stage(200))).toBe(60);
  });

  it('adds up to the stage exactly', () => {
    for (const h of SIZES) {
      const s = initialDockState(stage(h));
      const total = dockOccupiedHeight(s, stage(h)) + sceneHeightFor(s, stage(h));
      if (h >= MIN_SCENE_HEIGHT + MIN_DOCK_HEIGHT) expect(total).toBe(h);
      else expect(total).toBeGreaterThanOrEqual(h);
    }
  });
});

describe('default height', () => {
  it('takes the documented fraction of a roomy stage', () => {
    expect(defaultDockHeight(stage(1000))).toBe(Math.round(1000 * DEFAULT_DOCK_FRACTION));
  });

  it('never opens below the dock minimum', () => {
    expect(defaultDockHeight(stage(300))).toBeGreaterThanOrEqual(MIN_DOCK_HEIGHT);
  });

  it('never opens past what the stage can spare', () => {
    for (const h of [200, 300, 500, 1000]) {
      expect(defaultDockHeight(stage(h))).toBeLessThanOrEqual(maxDockHeight(stage(h)));
    }
  });
});

describe('splitter drag', () => {
  const limits = stage(1000);

  it('grows the dock when dragged upward', () => {
    const s: DockState = { heightPx: 400, collapsed: false };
    expect(resizeDock(s, -50, limits).heightPx).toBe(450);
  });

  it('shrinks the dock when dragged downward', () => {
    const s: DockState = { heightPx: 400, collapsed: false };
    expect(resizeDock(s, 50, limits).heightPx).toBe(350);
  });

  it('clamps rather than letting a drag eat the scene', () => {
    const s: DockState = { heightPx: 400, collapsed: false };
    const huge = resizeDock(s, -100000, limits);
    expect(huge.heightPx).toBe(maxDockHeight(limits));
    expect(sceneHeightFor(huge, limits)).toBe(MIN_SCENE_HEIGHT);
    const tiny = resizeDock(s, 100000, limits);
    expect(tiny.heightPx).toBe(MIN_DOCK_HEIGHT);
  });

  it('reopens a collapsed dock at the dragged height', () => {
    const s: DockState = { heightPx: 400, collapsed: true };
    const out = resizeDock(s, -100, limits);
    expect(out.collapsed).toBe(false);
    expect(out.heightPx).toBe(clampDockHeight(COLLAPSED_DOCK_HEIGHT + 100, limits));
  });

  it('ignores a non-finite delta', () => {
    const s: DockState = { heightPx: 400, collapsed: false };
    expect(resizeDock(s, Number.NaN, limits).heightPx).toBe(400);
  });
});

describe('collapse', () => {
  it('retains the open height so restore returns to it', () => {
    const open: DockState = { heightPx: 512, collapsed: false };
    const collapsed = toggleDockCollapsed(open);
    expect(collapsed.collapsed).toBe(true);
    expect(collapsed.heightPx).toBe(512);
    const restored = toggleDockCollapsed(collapsed);
    expect(restored).toEqual(open);
  });

  it('occupies only the header while collapsed', () => {
    const s: DockState = { heightPx: 512, collapsed: true };
    expect(dockOccupiedHeight(s, stage(1000))).toBe(COLLAPSED_DOCK_HEIGHT);
    expect(sceneHeightFor(s, stage(1000))).toBe(1000 - COLLAPSED_DOCK_HEIGHT);
  });
});

describe('stage resize', () => {
  it('returns the user height when the stage grows back', () => {
    const chosen: DockState = { heightPx: 600, collapsed: false };
    const shrunk = refitDock(chosen, stage(400));
    expect(shrunk.heightPx).toBeLessThan(600);
    // Refitting the ORIGINAL preference to the restored stage gives it back.
    const regrown = refitDock(chosen, stage(1200));
    expect(regrown.heightPx).toBe(600);
  });

  it('keeps the collapsed flag across a resize', () => {
    expect(refitDock({ heightPx: 600, collapsed: true }, stage(300)).collapsed).toBe(true);
  });
});

describe('persistence', () => {
  it('round trips', () => {
    const s: DockState = { heightPx: 377, collapsed: true };
    expect(decodeDockPrefs(encodeDockPrefs(s))).toEqual({ heightPx: 377, collapsed: true });
  });

  it('stores the open height even while collapsed', () => {
    const s: DockState = { heightPx: 377, collapsed: true };
    expect(decodeDockPrefs(encodeDockPrefs(s))!.heightPx).toBe(377);
  });

  it('rejects anything that is not a preference, without throwing', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '[]',
      'null',
      '"str"',
      '42',
      '{}',
      '{"heightPx":400}',
      '{"collapsed":true}',
      '{"heightPx":"400","collapsed":true}',
      '{"heightPx":400,"collapsed":"yes"}',
      '{"heightPx":null,"collapsed":false}',
      '{"heightPx":0,"collapsed":false}',
      '{"heightPx":-10,"collapsed":false}',
    ]) {
      expect(decodeDockPrefs(raw)).toBeNull();
    }
  });

  it('opens at the default when the stored value is corrupt', () => {
    expect(restoreDockState('{{{', stage(1000))).toEqual(initialDockState(stage(1000)));
    expect(restoreDockState(null, stage(1000))).toEqual(initialDockState(stage(1000)));
  });

  it('clamps a stored height that no longer fits', () => {
    const raw = encodeDockPrefs({ heightPx: 5000, collapsed: false });
    const s = restoreDockState(raw, stage(600));
    expect(s.heightPx).toBe(maxDockHeight(stage(600)));
    expect(sceneHeightFor(s, stage(600))).toBe(MIN_SCENE_HEIGHT);
  });

  it('rejects a non-finite stored height', () => {
    expect(decodeDockPrefs('{"heightPx":1e999,"collapsed":false}')).toBeNull();
  });
});
