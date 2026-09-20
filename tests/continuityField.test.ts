import { describe, it, expect } from 'vitest';
import {
  CONTINUITY_DISABLED,
  anyCapabilityEnabled,
  displayStateKey,
  displayStateDiff,
  openEpoch,
  advanceEpoch,
  repairFor,
  type DisplayState,
} from '../src/render/continuity/continuityField';

const BASE: DisplayState = {
  camera: 'cam-a',
  projection: 'persp-60',
  widthPx: 1920,
  heightPx: 1080,
  dpr: 2,
  renderOrigin: 'origin-0',
  dataset: 'scan-1',
  lodFrontier: 'frontier-a',
  classFilter: 'all',
  scalarFilter: 'none',
  clip: 'none',
  colorMode: 'rgb',
  rgbSettings: 'default',
  pointSizeMode: 'adaptive',
  splatMode: 'soft',
  edl: 'off',
  deviceGeneration: 0,
};

const FIELDS = Object.keys(BASE) as (keyof DisplayState)[];

describe('capabilities', () => {
  it('ships with every capability off', () => {
    expect(anyCapabilityEnabled(CONTINUITY_DISABLED)).toBe(false);
    expect(Object.values(CONTINUITY_DISABLED).every((v) => v === false)).toBe(true);
  });

  it('reports a single enabled capability', () => {
    expect(anyCapabilityEnabled({ ...CONTINUITY_DISABLED, evidenceLens: true })).toBe(true);
  });
});

describe('display epoch', () => {
  it('holds the epoch when nothing moved', () => {
    const first = openEpoch(BASE);
    const next = advanceEpoch(first, { ...BASE });
    expect(next).toBe(first);
    expect(next.epoch).toBe(0);
  });

  // Every field is listed because it invalidates. A field that did not would be
  // a silent hole: history kept across a change that altered what a pixel means.
  it.each(FIELDS)('advances the epoch when %s changes', (field) => {
    const first = openEpoch(BASE);
    const moved: DisplayState =
      field === 'deviceGeneration' || field === 'widthPx' || field === 'heightPx' || field === 'dpr'
        ? { ...BASE, [field]: (BASE[field] as number) + 1 }
        : { ...BASE, [field]: `${BASE[field]}-changed` };
    const next = advanceEpoch(first, moved);
    expect(next.epoch).toBe(1);
    expect(next.changed).toEqual([field]);
  });

  it('never reuses an epoch number across a sequence of changes', () => {
    let state = BASE;
    let epoch = openEpoch(state);
    const seen = new Set<number>([epoch.epoch]);
    for (const camera of ['b', 'c', 'd', 'e']) {
      const next: DisplayState = { ...state, camera };
      epoch = advanceEpoch(epoch, next);
      state = next;
      expect(seen.has(epoch.epoch)).toBe(false);
      seen.add(epoch.epoch);
    }
    expect(epoch.epoch).toBe(4);
  });

  it('returning to an earlier state opens a new epoch rather than an old one', () => {
    const first = openEpoch(BASE);
    const away: DisplayState = { ...BASE, camera: 'cam-b' };
    const second = advanceEpoch(first, away);
    const back = advanceEpoch(second, BASE);
    expect(back.key).toBe(first.key);
    expect(back.epoch).toBe(2);
  });

  // Across a sequence, each diff has to be against the state actually in force,
  // not the one the sequence began at. The epoch carries its own state so the
  // caller cannot supply a mismatched pair.
  it('diffs against the epoch in force, not the first state', () => {
    const first = openEpoch(BASE);
    const second = advanceEpoch(first, { ...BASE, camera: 'cam-b' });
    const third = advanceEpoch(second, { ...BASE, camera: 'cam-b', colorMode: 'intensity' });
    expect(second.changed).toEqual(['camera']);
    expect(third.changed).toEqual(['colorMode']);
    expect(third.state.camera).toBe('cam-b');
  });

  it('names every input that changed at once', () => {
    const first = openEpoch(BASE);
    const moved: DisplayState = { ...BASE, camera: 'cam-b', dpr: 1, colorMode: 'intensity' };
    expect(advanceEpoch(first, moved).changed).toEqual(['camera', 'dpr', 'colorMode']);
  });
});

// Phase 6 names the display changes that must invalidate history. The per-field
// test above walks whatever `DisplayState` happens to contain, so deleting a
// field would shrink that set silently and still pass green. This pins the
// required list to fields by name, and asserts the two sets match in both
// directions: a dropped trigger fails, and so does a field that invalidates
// without being named as one of them.
describe('required invalidation triggers', () => {
  const REQUIRED: Readonly<Record<string, readonly (keyof DisplayState)[]>> = {
    'camera transform': ['camera'],
    'projection change': ['projection'],
    'viewport resize': ['widthPx', 'heightPx'],
    'DPR change': ['dpr'],
    'render-origin change': ['renderOrigin'],
    'dataset replacement': ['dataset'],
    'visible LOD frontier change': ['lodFrontier'],
    'classification filter change': ['classFilter'],
    'intensity or elevation filter change': ['scalarFilter'],
    'clip change': ['clip'],
    'colour mode change': ['colorMode'],
    'RGB settings change': ['rgbSettings'],
    'point size mode change': ['pointSizeMode'],
    'splat mode change': ['splatMode'],
    'EDL mode or parameter change': ['edl'],
    'backend or device reset': ['deviceGeneration'],
  };

  it.each(Object.entries(REQUIRED))('%s invalidates', (_trigger, fields) => {
    for (const field of fields) {
      expect(FIELDS).toContain(field);
      const moved: DisplayState =
        typeof BASE[field] === 'number'
          ? { ...BASE, [field]: (BASE[field] as number) + 1 }
          : { ...BASE, [field]: `${String(BASE[field])}-changed` };
      expect(advanceEpoch(openEpoch(BASE), moved).epoch).toBe(1);
    }
  });

  it('names every field, so nothing invalidates unnamed', () => {
    const named = [...new Set(Object.values(REQUIRED).flat())].sort();
    expect([...FIELDS].sort()).toEqual(named);
  });
});

describe('display state key', () => {
  it('is stable for equal states and differs for unequal ones', () => {
    expect(displayStateKey(BASE)).toBe(displayStateKey({ ...BASE }));
    expect(displayStateKey(BASE)).not.toBe(displayStateKey({ ...BASE, clip: 'box' }));
  });

  // Length prefixes keep field boundaries unambiguous, so values carrying the
  // separator cannot spell a different state's key.
  it('does not collide when a value contains the separator', () => {
    const a: DisplayState = { ...BASE, camera: 'a|b', projection: '' };
    const b: DisplayState = { ...BASE, camera: 'a', projection: 'b' };
    expect(displayStateKey(a)).not.toBe(displayStateKey(b));
    expect(displayStateDiff(a, b)).toEqual(['camera', 'projection']);
  });
});

describe('repairFor', () => {
  it('asks for nothing when nothing changed', () => {
    expect(repairFor([])).toBe('none');
  });

  it('clears rather than reallocates for a camera nudge', () => {
    // Reallocating here would rebuild three textures every time the view
    // moves, which costs more than the accumulation saves.
    expect(repairFor(['camera'])).toBe('clear');
    expect(repairFor(displayStateDiff(BASE, { ...BASE, camera: 'cam-b' }))).toBe('clear');
  });

  it('reallocates for a backing store of a different shape', () => {
    expect(repairFor(['widthPx'])).toBe('reallocate');
    expect(repairFor(['heightPx'])).toBe('reallocate');
    expect(repairFor(['dpr'])).toBe('reallocate');
  });

  it('reallocates for a device that was remade at the same size', () => {
    // Surfaces from a dead device are the problem a size check cannot see.
    const remade = displayStateDiff(BASE, { ...BASE, deviceGeneration: 1 });
    expect(remade).toEqual(['deviceGeneration']);
    expect(repairFor(remade)).toBe('reallocate');
  });

  it('takes the most expensive repair any changed field asks for', () => {
    expect(repairFor(['camera', 'colorMode'])).toBe('clear');
    expect(repairFor(['camera', 'widthPx', 'colorMode'])).toBe('reallocate');
  });

  it('classifies every display input, so none is silently free', () => {
    for (const field of FIELDS) {
      expect(['clear', 'reallocate'], field).toContain(repairFor([field]));
    }
  });

  it('agrees with the epoch about what a change costs', () => {
    const moved = advanceEpoch(openEpoch(BASE), { ...BASE, colorMode: 'intensity' });
    expect(repairFor(moved.changed)).toBe('clear');
    const resized = advanceEpoch(openEpoch(BASE), { ...BASE, widthPx: 1280 });
    expect(repairFor(resized.changed)).toBe('reallocate');
  });
});
