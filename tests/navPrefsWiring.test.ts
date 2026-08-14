import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyNavPrefsChange,
  navigationPrefs,
  toggleNavInvert,
  resetNavPrefs,
} from '../src/render/navPrefsWiring';
import { DEFAULT_NAVIGATION_PREFERENCES, type NavigationPreferences } from '../src/render/navPrefs';

function fakes() {
  const applied: NavigationPreferences[] = [];
  const synced: NavigationPreferences[] = [];
  let persists = 0;
  return {
    viewer: { setNavigationPreferences: (p: NavigationPreferences) => applied.push(p) },
    inspector: { syncNavigationPrefs: (p: NavigationPreferences) => synced.push(p) },
    persist: () => { persists++; },
    applied, synced, get persists() { return persists; },
  };
}

describe('navPrefsWiring external toggles', () => {
  beforeEach(() => {
    // Reset the module-level current prefs to the shipped defaults.
    const f = fakes();
    resetNavPrefs(f.viewer, f.inspector, f.persist);
  });

  it('toggleNavInvert flips only the named axis and keeps the preset', () => {
    // Seed a non-default preset via applyNavPrefsChange.
    const f0 = fakes();
    applyNavPrefsChange({ invertOrbitX: false, invertOrbitY: false, preset: 'recap' }, f0.viewer, f0.persist);

    const f = fakes();
    const afterY = toggleNavInvert('y', f.viewer, f.inspector, f.persist);
    expect(afterY.invertOrbitY).toBe(true);
    expect(afterY.invertOrbitX).toBe(false);
    expect(afterY.preset).toBe('recap'); // flags win, preset label preserved
    // Applied to the viewer, synced to the inspector, and persisted — all three.
    expect(f.applied.at(-1)).toEqual(afterY);
    expect(f.synced.at(-1)).toEqual(afterY);
    expect(f.persists).toBe(1);

    const f2 = fakes();
    const afterX = toggleNavInvert('x', f2.viewer, f2.inspector, f2.persist);
    expect(afterX.invertOrbitX).toBe(true);
    expect(afterX.invertOrbitY).toBe(true); // the earlier Y flip is retained
  });

  it('toggling the same axis twice returns to the original state', () => {
    const f = fakes();
    toggleNavInvert('y', f.viewer, f.inspector, f.persist);
    const back = toggleNavInvert('y', f.viewer, f.inspector, f.persist);
    expect(back.invertOrbitY).toBe(false);
  });

  it('resetNavPrefs restores the shipped defaults and notifies all surfaces', () => {
    const f0 = fakes();
    toggleNavInvert('x', f0.viewer, f0.inspector, f0.persist);
    const f = fakes();
    const reset = resetNavPrefs(f.viewer, f.inspector, f.persist);
    expect(reset).toEqual(DEFAULT_NAVIGATION_PREFERENCES);
    expect(navigationPrefs()).toEqual(DEFAULT_NAVIGATION_PREFERENCES);
    expect(f.applied.at(-1)).toEqual(DEFAULT_NAVIGATION_PREFERENCES);
    expect(f.synced.at(-1)).toEqual(DEFAULT_NAVIGATION_PREFERENCES);
    expect(f.persists).toBe(1);
  });
});
