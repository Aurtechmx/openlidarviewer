import { parsePrefs } from '../src/prefs';

// ────────────────────────────────────────────────────────────────────────────
// parsePrefs — validates a stored JSON string into partial preferences
// ────────────────────────────────────────────────────────────────────────────

describe('parsePrefs', () => {
  test('parses a complete, valid record', () => {
    const json = JSON.stringify({
      pointSize: 3,
      edlEnabled: true,
      edlStrength: 0.7,
      pointSizeMode: 'fixed',
      antialiasing: false,
      unitSystem: 'imperial',
    });
    expect(parsePrefs(json)).toEqual({
      pointSize: 3,
      edlEnabled: true,
      edlStrength: 0.7,
      pointSizeMode: 'fixed',
      antialiasing: false,
      unitSystem: 'imperial',
    });
  });

  test('returns an empty object for invalid JSON', () => {
    expect(parsePrefs('not json {')).toEqual({});
  });

  test('returns an empty object for non-object JSON', () => {
    expect(parsePrefs('42')).toEqual({});
    expect(parsePrefs('null')).toEqual({});
    expect(parsePrefs('"hello"')).toEqual({});
  });

  test('an empty object yields an empty result', () => {
    expect(parsePrefs('{}')).toEqual({});
  });

  test('keeps only the valid keys and drops malformed ones', () => {
    const json = JSON.stringify({
      pointSize: 4, // valid
      edlEnabled: 'yes', // wrong type — dropped
      pointSizeMode: 'weird', // not a valid mode — dropped
      unitSystem: 'furlongs', // not a valid unit system — dropped
      antialiasing: true, // valid
    });
    expect(parsePrefs(json)).toEqual({ pointSize: 4, antialiasing: true });
  });

  test('clamps point size into the 1–8 range', () => {
    expect(parsePrefs(JSON.stringify({ pointSize: 99 })).pointSize).toBe(8);
    expect(parsePrefs(JSON.stringify({ pointSize: -5 })).pointSize).toBe(1);
    expect(parsePrefs(JSON.stringify({ pointSize: 3.5 })).pointSize).toBe(3.5);
  });

  test('clamps EDL strength into the 0–1.5 range', () => {
    expect(parsePrefs(JSON.stringify({ edlStrength: 9 })).edlStrength).toBe(1.5);
    expect(parsePrefs(JSON.stringify({ edlStrength: -1 })).edlStrength).toBe(0);
  });

  test('drops a non-numeric point size', () => {
    expect(parsePrefs(JSON.stringify({ pointSize: null })).pointSize).toBeUndefined();
    expect(parsePrefs(JSON.stringify({ pointSize: '4' })).pointSize).toBeUndefined();
  });

  test('accepts both point-size modes and both unit systems', () => {
    expect(parsePrefs(JSON.stringify({ pointSizeMode: 'adaptive' })).pointSizeMode).toBe(
      'adaptive',
    );
    expect(parsePrefs(JSON.stringify({ pointSizeMode: 'fixed' })).pointSizeMode).toBe('fixed');
    expect(parsePrefs(JSON.stringify({ unitSystem: 'metric' })).unitSystem).toBe('metric');
    expect(parsePrefs(JSON.stringify({ unitSystem: 'imperial' })).unitSystem).toBe('imperial');
  });

  test('round-trips every valid splat mode (P13)', () => {
    for (const mode of ['classic', 'soft', 'inspection', 'gaussian'] as const) {
      expect(parsePrefs(JSON.stringify({ splatMode: mode })).splatMode).toBe(mode);
    }
  });

  test('drops an unknown or malformed splat mode, leaving it unset', () => {
    // Unknown / wrong-type values are dropped like every other malformed key,
    // so the viewer keeps its own default.
    expect(parsePrefs(JSON.stringify({ splatMode: 'hologram' })).splatMode).toBeUndefined();
    expect(parsePrefs(JSON.stringify({ splatMode: 42 })).splatMode).toBeUndefined();
    expect(parsePrefs('{}').splatMode).toBeUndefined();
  });
});
