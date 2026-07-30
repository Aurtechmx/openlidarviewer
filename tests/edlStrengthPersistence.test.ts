/**
 * `Viewer.edlStrength` returns `_edlBaseStrength`, not `_edlLiveStrength`. Static
 * analysis reports that as a getter failing to refer to its matching field and
 * suggests "fixing" it. Doing so would introduce a real bug, which is why this
 * is a test rather than only a comment.
 *
 * The two fields hold different things. `_edlLiveStrength` is the live uniform,
 * recomputed each frame as the base times an adaptive factor that depends on
 * camera distance. `_edlBaseStrength` is what the user set.
 *
 * The getter feeds preference persistence (`main.ts` reads it when saving and
 * writes it back through `setEdlStrength`). Returning the live value would
 * save a frame- and camera-dependent number, so a user who saved after
 * inspecting something close up would find their setting had drifted — a
 * round-trip bug visible only across sessions.
 *
 * These assertions use the public surface only: set a value, read it back, and
 * require the reading to be exactly what was set regardless of what any
 * adaptive pass would do to the live uniform.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The round-trip the preference path performs, with no renderer involved. */
class EdlRoundTrip {
  private base = 0.7;
  private live = { value: 0.7 };

  setEdlStrength(strength: number): void {
    this.base = Math.max(0, strength);
    this.live.value = this.base;
  }

  /** Stands in for the per-frame adaptive pass. */
  applyAdaptiveFactor(factor: number): void {
    this.live.value = this.base * factor;
  }

  get edlStrength(): number {
    return this.base;
  }

  get liveUniform(): number {
    return this.live.value;
  }
}

describe('EDL strength round-trips through preferences', () => {
  it('reads back exactly what was set', () => {
    const v = new EdlRoundTrip();
    v.setEdlStrength(1.2);
    expect(v.edlStrength).toBe(1.2);
  });

  it('is unchanged by the adaptive pass that moves the live uniform', () => {
    const v = new EdlRoundTrip();
    v.setEdlStrength(1.2);
    v.applyAdaptiveFactor(0.4); // camera moved close; the uniform drops
    expect(v.liveUniform).toBeCloseTo(0.48);
    // The saved preference must not follow it.
    expect(v.edlStrength).toBe(1.2);
  });

  it('survives repeated save and restore without drifting', () => {
    // The failure this guards against is cumulative: each save-restore cycle
    // would multiply in another adaptive factor.
    const v = new EdlRoundTrip();
    v.setEdlStrength(1.0);
    for (let i = 0; i < 5; i++) {
      v.applyAdaptiveFactor(0.5);
      v.setEdlStrength(v.edlStrength); // save, then restore
    }
    expect(v.edlStrength).toBe(1.0);
  });

  it('clamps a negative to zero rather than storing it', () => {
    const v = new EdlRoundTrip();
    v.setEdlStrength(-3);
    expect(v.edlStrength).toBe(0);
  });
});

describe('the getter reads the base field', () => {
  // The assertions above run against a stand-in, so they would still pass if
  // someone changed the real getter. This one reads the source, which is the
  // only way to hold a single accessor on a file this suite does not import.
  it('returns _edlBaseStrength in Viewer.ts', () => {
    const src = readFileSync(join(__dirname, '../src/render/Viewer.ts'), 'utf8');
    const getter = /get edlStrength\(\): number \{\s*return\s+(this\.\w+);/.exec(src);
    expect(getter, 'the edlStrength getter should still exist').not.toBeNull();
    expect(getter?.[1]).toBe('this._edlBaseStrength');
  });
});
