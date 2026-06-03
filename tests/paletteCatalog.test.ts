/**
 * tests/paletteCatalog.test.ts
 *
 * Coverage for the v0.3.7 palette catalogue (A.4):
 *   - the built-in registry returns the 5 perceptual presets
 *   - colour-blind safety is reported correctly
 *   - custom-palette registration enforces the shape contract
 *   - the in-memory registry supports add / lookup / remove / list
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  listBuiltinPalettes,
  getBuiltinPalette,
  registerCustomPalette,
  unregisterCustomPalette,
  getCustomPalette,
  listCustomPalettes,
  clearCustomPalettes,
  validateCustomStops,
} from '../src/render/paletteCatalog';

describe('built-in palette catalogue', () => {
  it('lists exactly five perceptual presets', () => {
    const ids = listBuiltinPalettes().map((p) => p.id);
    expect(ids).toEqual(['cividis', 'viridis', 'inferno', 'turbo', 'classic']);
  });

  it('only Cividis is marked fully colour-blind safe', () => {
    const safe = listBuiltinPalettes().filter((p) => p.colorblindSafe);
    expect(safe.map((p) => p.id)).toEqual(['cividis']);
  });

  it('getBuiltinPalette returns the meta for the requested id', () => {
    expect(getBuiltinPalette('inferno').label).toBe('Inferno');
  });

  it('every built-in has a label + description', () => {
    for (const p of listBuiltinPalettes()) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});

describe('validateCustomStops — shape contract', () => {
  it('accepts a 2-point monotonic ramp', () => {
    expect(() =>
      validateCustomStops([
        [0, 0, 0, 0],
        [1, 255, 255, 255],
      ]),
    ).not.toThrow();
  });

  it('accepts an 8-point monotonic ramp (max length)', () => {
    expect(() =>
      validateCustomStops([
        [0.0, 0, 0, 0],
        [0.14, 30, 30, 30],
        [0.28, 60, 60, 60],
        [0.42, 90, 90, 90],
        [0.57, 120, 120, 120],
        [0.71, 150, 150, 150],
        [0.85, 180, 180, 180],
        [1.0, 255, 255, 255],
      ]),
    ).not.toThrow();
  });

  it('rejects fewer than 2 control points', () => {
    expect(() => validateCustomStops([[0, 0, 0, 0]])).toThrow(/at least 2/);
  });

  it('rejects more than 8 control points', () => {
    expect(() =>
      validateCustomStops(
        Array.from({ length: 9 }, (_, i) => [i / 8, 0, 0, 0] as [number, number, number, number]),
      ),
    ).toThrow(/at most 8/);
  });

  it('rejects a non-monotonic t', () => {
    expect(() =>
      validateCustomStops([
        [0, 0, 0, 0],
        [0.5, 100, 100, 100],
        [0.3, 50, 50, 50], // t went backwards
        [1, 255, 255, 255],
      ]),
    ).toThrow(/monotonic/);
  });

  it('rejects t outside [0, 1]', () => {
    expect(() =>
      validateCustomStops([
        [-0.1, 0, 0, 0],
        [1, 255, 255, 255],
      ]),
    ).toThrow(/\[0, 1\]/);
  });

  it('rejects r/g/b outside [0, 255]', () => {
    expect(() =>
      validateCustomStops([
        [0, 0, 0, 0],
        [1, 256, 0, 0],
      ]),
    ).toThrow(/\[0, 255\]/);
  });
});

describe('custom palette registry', () => {
  beforeEach(() => clearCustomPalettes());

  it('registers and looks up a custom palette', () => {
    registerCustomPalette({
      id: 'my-ramp',
      label: 'My Ramp',
      stops: [
        [0, 10, 20, 30],
        [1, 200, 220, 240],
      ],
      colorblindSafe: false,
    });
    expect(getCustomPalette('my-ramp')?.label).toBe('My Ramp');
  });

  it('lists registered custom palettes', () => {
    registerCustomPalette({
      id: 'a',
      label: 'A',
      stops: [
        [0, 0, 0, 0],
        [1, 1, 1, 1],
      ],
      colorblindSafe: false,
    });
    registerCustomPalette({
      id: 'b',
      label: 'B',
      stops: [
        [0, 0, 0, 0],
        [1, 1, 1, 1],
      ],
      colorblindSafe: true,
    });
    const list = listCustomPalettes();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('unregisters by id', () => {
    registerCustomPalette({
      id: 'gone',
      label: 'Gone',
      stops: [
        [0, 0, 0, 0],
        [1, 1, 1, 1],
      ],
      colorblindSafe: false,
    });
    unregisterCustomPalette('gone');
    expect(getCustomPalette('gone')).toBeUndefined();
  });

  it('rejects an empty id', () => {
    expect(() =>
      registerCustomPalette({
        id: '',
        label: 'X',
        stops: [
          [0, 0, 0, 0],
          [1, 1, 1, 1],
        ],
        colorblindSafe: false,
      }),
    ).toThrow();
  });

  it('rejects an empty label', () => {
    expect(() =>
      registerCustomPalette({
        id: 'x',
        label: '',
        stops: [
          [0, 0, 0, 0],
          [1, 1, 1, 1],
        ],
        colorblindSafe: false,
      }),
    ).toThrow();
  });

  it('propagates the stops-shape validation', () => {
    expect(() =>
      registerCustomPalette({
        id: 'bad',
        label: 'Bad',
        stops: [[0, 0, 0, 0]] as never,
        colorblindSafe: false,
      }),
    ).toThrow(/at least 2/);
  });
});
