/**
 * reducedMotionGuard.test.ts
 *
 * `src/reducedMotion.ts` is the single `prefers-reduced-motion` reader shared
 * by src/ui/ResultFocus.ts, src/app/profileWorkbenchStage.ts and
 * src/render/NavController.ts, which previously carried three independent
 * copies with differing guards. This pins the union of those guards: it
 * reports the OS preference when `matchMedia` is available, and stays `false`
 * — never throws — with no `window`, no `matchMedia`, or a `matchMedia` that
 * throws.
 *
 * Runs in the node environment (no DOM global by default), so each case sets
 * `globalThis.window` itself and restores it afterwards.
 */

import { afterEach, describe, expect, it } from 'vitest';

describe('prefersReducedMotion', () => {
  const saved = globalThis.window;

  afterEach(() => {
    globalThis.window = saved;
  });

  it('reports true when matchMedia matches the reduce query', async () => {
    globalThis.window = {
      matchMedia: (q: string) => ({ matches: q.includes('prefers-reduced-motion'), media: q }),
    } as unknown as Window & typeof globalThis;
    const { prefersReducedMotion } = await import('../src/reducedMotion');
    expect(prefersReducedMotion()).toBe(true);
  });

  it('reports false when matchMedia does not match', async () => {
    globalThis.window = {
      matchMedia: (q: string) => ({ matches: false, media: q }),
    } as unknown as Window & typeof globalThis;
    const { prefersReducedMotion } = await import('../src/reducedMotion');
    expect(prefersReducedMotion()).toBe(false);
  });

  it('returns false with no window at all', async () => {
    // @ts-expect-error deliberately deleting the global for the guard test
    delete globalThis.window;
    const { prefersReducedMotion } = await import('../src/reducedMotion');
    expect(prefersReducedMotion()).toBe(false);
  });

  it('returns false when window has no matchMedia', async () => {
    globalThis.window = {} as unknown as Window & typeof globalThis;
    const { prefersReducedMotion } = await import('../src/reducedMotion');
    expect(prefersReducedMotion()).toBe(false);
  });

  it('returns false, not throws, when matchMedia itself throws', async () => {
    globalThis.window = {
      matchMedia: () => {
        throw new Error('blocked');
      },
    } as unknown as Window & typeof globalThis;
    const { prefersReducedMotion } = await import('../src/reducedMotion');
    expect(() => prefersReducedMotion()).not.toThrow();
    expect(prefersReducedMotion()).toBe(false);
  });

  it('follows a live change of the OS setting on the next read', async () => {
    const mql = { matches: false, media: '' };
    globalThis.window = { matchMedia: () => mql } as unknown as Window & typeof globalThis;
    const { prefersReducedMotion } = await import('../src/reducedMotion');
    expect(prefersReducedMotion()).toBe(false);
    mql.matches = true;
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe('reduced motion composes with the glide rest rule', () => {
  it('drops every released glide at once when reduced', async () => {
    const { glideRestRule, glideAtRest, orbitVelocityAtRest } = await import('../src/render/orbitFeel');
    const view = { heightPx: 800, fovYRad: 1 };
    expect(glideRestRule(500, 0.1, 1e-5)).toBe(false);
    expect(glideRestRule(500, 0.1, 1e-5, true)).toBe(true);
    const big = glideAtRest({ theta: 0.5, phi: 0.2 }, { x: 1, y: 0, z: 0 }, 10, 0.1, view);
    expect(big).toEqual({ rotation: false, pan: false });
    expect(glideAtRest({ theta: 0.5, phi: 0.2 }, { x: 1, y: 0, z: 0 }, 10, 0.1, view, true))
      .toEqual({ rotation: true, pan: true });
    expect(orbitVelocityAtRest(1.6, 8, 10, view)).toBe(false);
    expect(orbitVelocityAtRest(1.6, 8, 10, view, true)).toBe(true);
  });
});
