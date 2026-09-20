import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  PIVOT_FADE_MS,
  PIVOT_GROW_MS,
  PIVOT_MARKER_MS,
  PIVOT_START_SCALE,
  pivotMarkerState,
  visibleDuringCapture,
} from '../src/render/pivotMarker';

const SHOWN = 1000;

describe('the mark comes and goes', () => {
  it('is not drawn before it is shown', () => {
    expect(pivotMarkerState(null, SHOWN).visible).toBe(false);
    expect(pivotMarkerState(SHOWN, SHOWN - 1).visible).toBe(false);
  });

  it('is drawn the moment it is shown', () => {
    expect(pivotMarkerState(SHOWN, SHOWN).visible).toBe(true);
  });

  it('is gone once its life has run out', () => {
    expect(pivotMarkerState(SHOWN, SHOWN + PIVOT_MARKER_MS).visible).toBe(false);
    expect(pivotMarkerState(SHOWN, SHOWN + PIVOT_MARKER_MS + 10_000).visible).toBe(false);
  });

  it('reads an unusable time as nothing to draw', () => {
    expect(pivotMarkerState(Number.NaN, SHOWN).visible).toBe(false);
    expect(pivotMarkerState(SHOWN, Number.NaN).visible).toBe(false);
  });

  it('restarts rather than interleaving when shown again', () => {
    // A viewer double-clicking twice sees one mark that stays.
    const late = SHOWN + PIVOT_MARKER_MS - 50;
    expect(pivotMarkerState(SHOWN, late).opacity).toBeLessThan(1);
    expect(pivotMarkerState(late, late).opacity).toBe(1);
  });
});

describe('how it is drawn', () => {
  it('grows to full size and then stops growing', () => {
    expect(pivotMarkerState(SHOWN, SHOWN).scale).toBeCloseTo(PIVOT_START_SCALE, 6);
    expect(pivotMarkerState(SHOWN, SHOWN + PIVOT_GROW_MS).scale).toBeCloseTo(1, 6);
    expect(pivotMarkerState(SHOWN, SHOWN + PIVOT_GROW_MS + 200).scale).toBeCloseTo(1, 6);
  });

  it('holds at full opacity, then fades over the tail', () => {
    const fadeStart = SHOWN + PIVOT_MARKER_MS - PIVOT_FADE_MS;
    expect(pivotMarkerState(SHOWN, fadeStart).opacity).toBe(1);
    expect(pivotMarkerState(SHOWN, fadeStart + PIVOT_FADE_MS / 2).opacity).toBeCloseTo(0.5, 2);
    expect(pivotMarkerState(SHOWN, SHOWN + PIVOT_MARKER_MS - 1).opacity).toBeLessThan(0.02);
  });

  it('never leaves its bounds, at any moment of its life', () => {
    for (let age = -50; age <= PIVOT_MARKER_MS + 50; age += 7) {
      const s = pivotMarkerState(SHOWN, SHOWN + age);
      expect(s.opacity).toBeGreaterThanOrEqual(0);
      expect(s.opacity).toBeLessThanOrEqual(1);
      expect(s.scale).toBeGreaterThan(0);
      expect(s.scale).toBeLessThanOrEqual(1);
    }
  });

  it('fades without ever brightening again', () => {
    let previous = 1;
    for (let age = PIVOT_MARKER_MS - PIVOT_FADE_MS; age < PIVOT_MARKER_MS; age += 5) {
      const { opacity } = pivotMarkerState(SHOWN, SHOWN + age);
      expect(opacity).toBeLessThanOrEqual(previous + 1e-9);
      previous = opacity;
    }
  });
});

describe('reduced motion', () => {
  it('drops both ends of the animation rather than shortening them', () => {
    // The convention ResultFocus set: a fade is still something changing on
    // screen for a viewer who asked for less of that.
    for (let age = 0; age < PIVOT_MARKER_MS; age += 25) {
      const s = pivotMarkerState(SHOWN, SHOWN + age, true);
      expect(s.visible).toBe(true);
      expect(s.opacity).toBe(1);
      expect(s.scale).toBe(1);
    }
  });

  it('still goes away at the same moment', () => {
    expect(pivotMarkerState(SHOWN, SHOWN + PIVOT_MARKER_MS, true).visible).toBe(false);
  });

  it('shows nothing that moves at all', () => {
    const states = [0, 100, 300, 600].map((age) => pivotMarkerState(SHOWN, SHOWN + age, true));
    expect(new Set(states.map((s) => s.opacity)).size).toBe(1);
    expect(new Set(states.map((s) => s.scale)).size).toBe(1);
  });
});

describe('what it may never be', () => {
  it('never appears in a captured frame', () => {
    // A figure is a statement about what was observed; this is a statement
    // about where the camera is turning.
    expect(visibleDuringCapture()).toBe(false);
  });

  it('produces no position, measurement or record', () => {
    const source = readFileSync(new URL('../src/render/pivotMarker.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/position|coordinate|measure|export function pivotPoint/i);
    expect(code).toMatch(/export function pivotMarkerState/);
  });

  it('is unpickable because the pick path never traverses the scene', () => {
    // The structural half: Viewer resolves a click by walking its own cloud
    // registry, so an object added to the scene cannot be hit however it is
    // drawn. If picking ever raycasts the scene graph, this fails and the
    // marker needs a layer mask rather than an argument.
    const viewer = readFileSync(new URL('../src/render/Viewer.ts', import.meta.url), 'utf8');
    expect(viewer).not.toMatch(/intersectObjects?\(\s*this\._scene/);
    expect(viewer).toContain('for (const entry of this._clouds.values())');
  });
});
