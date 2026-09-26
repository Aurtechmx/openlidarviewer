import { parsePrefs } from '../src/prefs';
import {
  parseNavigationPreferences,
  navPresetSigns,
  DEFAULT_NAVIGATION_PREFERENCES,
} from '../src/render/navPrefs';
import { orbitDragAngles } from '../src/render/navMath';

// ────────────────────────────────────────────────────────────────────────────
// parseNavigationPreferences — validate a persisted value into a complete,
// well-typed NavigationPreferences, defaulting every field independently.
// ────────────────────────────────────────────────────────────────────────────

describe('parseNavigationPreferences', () => {
  test('defaults on a non-object (garbage) input', () => {
    for (const raw of [undefined, null, 42, 'nope', true, []]) {
      expect(parseNavigationPreferences(raw)).toEqual(DEFAULT_NAVIGATION_PREFERENCES);
    }
  });

  test('an empty object yields the shipped defaults', () => {
    // Vertical inverted, horizontal not: what a user who has never opened the
    // setting gets.
    expect(parseNavigationPreferences({})).toEqual({
      invertOrbitX: false,
      invertOrbitY: true,
      preset: 'default',
    });
  });

  test('round-trips a complete, valid record', () => {
    expect(
      parseNavigationPreferences({ invertOrbitX: true, invertOrbitY: false, preset: 'invert-vertical' }),
    ).toEqual({ invertOrbitX: true, invertOrbitY: false, preset: 'invert-vertical' });
  });

  test('validates each field independently — a bad field falls back, good ones survive', () => {
    // invertOrbitX malformed → false; invertOrbitY valid → kept; preset valid → kept.
    expect(
      parseNavigationPreferences({ invertOrbitX: 'yes', invertOrbitY: true, preset: 'no-invert' }),
    ).toEqual({ invertOrbitX: false, invertOrbitY: true, preset: 'no-invert' });
  });

  test('a malformed boolean falls back to that field default, not to false', () => {
    // Both values are the wrong type, so each takes its own default rather than
    // a blanket false: X defaults false, Y defaults true.
    expect(parseNavigationPreferences({ invertOrbitX: 1, invertOrbitY: 'true' })).toEqual({
      invertOrbitX: false,
      invertOrbitY: true,
      preset: 'default',
    });
  });

  test('an unknown preset falls back to default', () => {
    expect(parseNavigationPreferences({ preset: 'cad' }).preset).toBe('default');
    expect(parseNavigationPreferences({ preset: 42 }).preset).toBe('default');
  });

  test('maps preset ids stored by earlier builds to their current names', () => {
    expect(parseNavigationPreferences({ preset: 'recap' }).preset).toBe('invert-vertical');
    expect(parseNavigationPreferences({ preset: 'nira' }).preset).toBe('no-invert');
    // The flags are stored alongside and still win over the preset.
    expect(
      parseNavigationPreferences({ invertOrbitX: true, invertOrbitY: false, preset: 'nira' }),
    ).toEqual({ invertOrbitX: true, invertOrbitY: false, preset: 'no-invert' });
    // Inherited object keys are not legacy ids.
    expect(parseNavigationPreferences({ preset: 'toString' }).preset).toBe('default');
  });

  test('accepts each known preset', () => {
    for (const preset of ['default', 'invert-vertical', 'no-invert'] as const) {
      expect(parseNavigationPreferences({ preset }).preset).toBe(preset);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// navPresetSigns — the documented preset → invert-sign mapping (the adjustable
// product choice). default and invert-vertical invert only the vertical axis;
// no-invert inverts neither.
// ────────────────────────────────────────────────────────────────────────────

describe('navPresetSigns', () => {
  test('default inverts the vertical orbit, matching the shipped preferences', () => {
    // The preset named default has to agree with DEFAULT_NAVIGATION_PREFERENCES,
    // or selecting it would undo the shipped behaviour.
    expect(navPresetSigns('default')).toEqual({ invertOrbitX: false, invertOrbitY: true });
    expect(navPresetSigns('default')).toEqual({
      invertOrbitX: DEFAULT_NAVIGATION_PREFERENCES.invertOrbitX,
      invertOrbitY: DEFAULT_NAVIGATION_PREFERENCES.invertOrbitY,
    });
  });

  test('invert-vertical inverts the vertical orbit only', () => {
    expect(navPresetSigns('invert-vertical')).toEqual({ invertOrbitX: false, invertOrbitY: true });
  });

  test('no-invert inverts neither axis', () => {
    expect(navPresetSigns('no-invert')).toEqual({ invertOrbitX: false, invertOrbitY: false });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// orbitDragAngles — the pure delta → signed-yaw/pitch mapping. The flags are
// the source of truth for orbit handedness: invertOrbitX flips yaw, invertOrbitY
// flips pitch, and the two never cross-couple. dx / dy are the base (non-inverted)
// orbit angles the caller has already scaled for feel.
// ────────────────────────────────────────────────────────────────────────────

describe('orbitDragAngles', () => {
  test('passes the delta straight through when neither axis is inverted', () => {
    expect(orbitDragAngles(5, 3, false, false)).toEqual({ yaw: 5, pitch: 3 });
  });

  test('invertOrbitX flips yaw only', () => {
    expect(orbitDragAngles(5, 3, true, false)).toEqual({ yaw: -5, pitch: 3 });
  });

  test('invertOrbitY flips pitch only', () => {
    expect(orbitDragAngles(5, 3, false, true)).toEqual({ yaw: 5, pitch: -3 });
  });

  test('both flags flip both axes', () => {
    expect(orbitDragAngles(5, 3, true, true)).toEqual({ yaw: -5, pitch: -3 });
  });

  test('neither invert leaks into the other axis', () => {
    // Flipping X must not touch pitch; flipping Y must not touch yaw.
    expect(orbitDragAngles(5, 3, true, false).pitch).toBe(orbitDragAngles(5, 3, false, false).pitch);
    expect(orbitDragAngles(5, 3, false, true).yaw).toBe(orbitDragAngles(5, 3, false, false).yaw);
  });

  test('a zero delta maps to zero rotation (no signed-zero leak)', () => {
    for (const flags of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const { yaw, pitch } = orbitDragAngles(0, 0, flags[0], flags[1]);
      expect(yaw).toBe(0);
      expect(pitch).toBe(0);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ViewerPrefs.navigation round-trip through parsePrefs — present when stored,
// absent (undefined) when not, so the viewer keeps its own default.
// ────────────────────────────────────────────────────────────────────────────

describe('parsePrefs — navigation preferences', () => {
  test('preserves a stored navigation block', () => {
    const json = JSON.stringify({
      navigation: { invertOrbitX: false, invertOrbitY: true, preset: 'recap' },
    });
    expect(parsePrefs(json).navigation).toEqual({
      invertOrbitX: false,
      invertOrbitY: true,
      preset: 'invert-vertical',
    });
  });

  test('fills a partial navigation block with defaults', () => {
    const json = JSON.stringify({ navigation: { invertOrbitY: true } });
    expect(parsePrefs(json).navigation).toEqual({
      invertOrbitX: false,
      invertOrbitY: true,
      preset: 'default',
    });
  });

  test('leaves navigation undefined when it was never stored', () => {
    expect(parsePrefs('{}').navigation).toBeUndefined();
  });

  test('a malformed navigation value degrades to the defaults, not a throw', () => {
    expect(parsePrefs(JSON.stringify({ navigation: 42 })).navigation).toEqual(
      DEFAULT_NAVIGATION_PREFERENCES,
    );
  });
});
