/**
 * contourStudioState.test.ts
 *
 * Pins the Contour Studio state model (spec §8): defaults, deterministic
 * serialization + schema-versioned parse/migration, stable hash, purpose presets
 * (defaults-only, never touching evidence), reducer transitions, and the
 * user-override preservation that keeps a purpose switch from discarding edits.
 */

import { describe, it, expect } from 'vitest';
import {
  baseContourStudioState,
  serializeContourStudioState,
  parseContourStudioState,
  contourStudioStateHash,
  CONTOUR_STUDIO_SCHEMA,
} from '../src/terrain/contourStudio/contourStudioState';
import {
  purposeDefaults,
  applyPurpose,
  PURPOSE_META,
} from '../src/terrain/contourStudio/contourStudioPurpose';
import {
  contourStudioReducer,
  type ContourStudioAction,
} from '../src/terrain/contourStudio/contourStudioReducer';

describe('ContourStudioState — defaults + serialization', () => {
  it('base state is schema 1, custom purpose, no overrides', () => {
    const s = baseContourStudioState();
    expect(s.schemaVersion).toBe(CONTOUR_STUDIO_SCHEMA);
    expect(s.purpose).toBe('custom');
    expect(Object.keys(s.overrides)).toHaveLength(0);
    expect(s.area).toEqual({ kind: 'entire-scan' });
  });

  it('serializes deterministically regardless of key insertion order', () => {
    const a = baseContourStudioState();
    // Same content, different construction order.
    const b = parseContourStudioState(JSON.stringify({ ...a }));
    expect(serializeContourStudioState(a)).toBe(serializeContourStudioState(b));
  });

  it('round-trips through serialize → parse unchanged', () => {
    const s = applyPurpose(baseContourStudioState(), 'terrain-research');
    const back = parseContourStudioState(serializeContourStudioState(s));
    expect(back).toEqual(s);
  });

  it('completes a partial same-version object against defaults', () => {
    const partial = JSON.stringify({ schemaVersion: 1, purpose: 'engineering-plan' });
    const s = parseContourStudioState(partial);
    expect(s.purpose).toBe('engineering-plan');
    // Missing groups fell back to base defaults.
    expect(s.surface).toEqual(baseContourStudioState().surface);
  });

  it('rejects an unsupported schema version rather than guessing', () => {
    expect(() => parseContourStudioState(JSON.stringify({ schemaVersion: 99 }))).toThrow(/schemaVersion/i);
  });

  it('rejects non-object / invalid JSON', () => {
    expect(() => parseContourStudioState('not json')).toThrow();
    expect(() => parseContourStudioState('42')).toThrow(/object/i);
  });

  it('hash is stable for equal states and differs when content changes', () => {
    const a = baseContourStudioState();
    const b = baseContourStudioState();
    expect(contourStudioStateHash(a)).toBe(contourStudioStateHash(b));
    const c = applyPurpose(a, 'survey-review');
    expect(contourStudioStateHash(c)).not.toBe(contourStudioStateHash(a));
  });
});

describe('purpose presets — defaults only, never evidence', () => {
  it('every purpose has metadata and a defaults bundle', () => {
    for (const id of ['engineering-plan', 'survey-review', 'terrain-research', 'presentation-map', 'custom'] as const) {
      expect(PURPOSE_META[id].label.length).toBeGreaterThan(0);
      expect(purposeDefaults(id)).toBeTruthy();
    }
  });

  it('survey-review requires the validation appendix and forbids exploratory output', () => {
    const d = purposeDefaults('survey-review');
    expect(d.validation.appendixRequired).toBe(true);
    expect(d.deliverable.allowExploratory).toBe(false);
    expect(d.surface.cartographicSmoothing).toBe(false); // exact analytical geometry
  });

  it('presentation-map favours cartographic output + simplified labels', () => {
    const d = purposeDefaults('presentation-map');
    expect(d.contour.cartographic).toBe(true);
    expect(d.contour.analytical).toBe(false);
    expect(d.labels.indexOnly).toBe(true);
  });

  it('applyPurpose only touches presentation settings — no evidence field exists to change', () => {
    const s = baseContourStudioState();
    const after = applyPurpose(s, 'survey-review');
    // Structural guarantee: the state has no evidence/validation-verdict/warning
    // field, so a purpose switch is incapable of raising a claim (§6.3). The
    // keys before and after are identical; only presentation values changed.
    expect(Object.keys(after).sort()).toEqual(Object.keys(s).sort());
    expect(after.purpose).toBe('survey-review');
  });
});

describe('reducer — transitions + override preservation', () => {
  const run = (actions: ContourStudioAction[]) =>
    actions.reduce(contourStudioReducer, baseContourStudioState());

  it('set-purpose applies the preset', () => {
    const s = run([{ type: 'set-purpose', purpose: 'engineering-plan' }]);
    expect(s.purpose).toBe('engineering-plan');
    expect(s.deliverable.dxf).toBe(true);
  });

  it('set-setting records an override', () => {
    const s = run([{ type: 'set-setting', path: 'labels.enabled', value: false }]);
    expect(s.labels.enabled).toBe(false);
    expect(s.overrides['labels.enabled']).toBe(true);
  });

  it('a later purpose switch preserves a user override', () => {
    const s = run([
      { type: 'set-setting', path: 'labels.enabled', value: false }, // user turns labels off
      { type: 'set-purpose', purpose: 'engineering-plan' }, // preset wants labels on
    ]);
    // The user's explicit choice wins over the preset default.
    expect(s.labels.enabled).toBe(false);
    expect(s.purpose).toBe('engineering-plan');
  });

  it('a purpose switch DOES change non-overridden settings', () => {
    const s = run([{ type: 'set-purpose', purpose: 'survey-review' }]);
    expect(s.surface.cartographicSmoothing).toBe(false);
  });

  it('reset returns to base and clears overrides', () => {
    const s = run([
      { type: 'set-setting', path: 'contour.indexEvery', value: 10 },
      { type: 'reset' },
    ]);
    expect(s).toEqual(baseContourStudioState());
  });

  it('set-area updates only the area', () => {
    const s = run([{ type: 'set-area', area: { kind: 'current-view' } }]);
    expect(s.area).toEqual({ kind: 'current-view' });
  });
});
