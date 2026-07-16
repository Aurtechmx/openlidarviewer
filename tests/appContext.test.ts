/**
 * tests/appContext.test.ts
 *
 * Characterizes the v0.6 shared-state foundation: the AppContext cluster the
 * composition root owns, and the guarantee that main.ts's migrated layer state
 * (visibility intent, solo, last comparison) starts empty and is mutable and
 * per-instance isolated. Locks the contract the extracted services rely on.
 */

import { describe, it, expect } from 'vitest';
import { createAppContext } from '../src/app/appContext';
import { createAppRuntime } from '../src/app/AppRuntime';

describe('createAppContext — layer cluster defaults', () => {
  it('starts with an empty visibility map, no solo, and no comparison', () => {
    const ctx = createAppContext();
    expect(ctx.layers.visible.size).toBe(0);
    expect(ctx.layers.solo).toBeNull();
    expect(ctx.layers.lastDifference).toBeNull();
  });

  it('carries mutable state (the migrated main.ts assignments write through)', () => {
    const ctx = createAppContext();
    ctx.layers.visible.set('cloud-a', false);
    ctx.layers.solo = 'cloud-a';
    ctx.layers.lastDifference = { stem: 'a-to-b-difference', asc: () => 'ncols 1' };
    expect(ctx.layers.visible.get('cloud-a')).toBe(false);
    expect(ctx.layers.solo).toBe('cloud-a');
    expect(ctx.layers.lastDifference?.stem).toBe('a-to-b-difference');
    expect(ctx.layers.lastDifference?.asc()).toBe('ncols 1');
  });

  it('gives each context an independent visibility map', () => {
    const a = createAppContext();
    const b = createAppContext();
    a.layers.visible.set('x', true);
    expect(b.layers.visible.has('x')).toBe(false);
  });
});

describe('createAppRuntime — composition root', () => {
  it('exposes a fresh AppContext with the layer cluster', () => {
    const runtime = createAppRuntime();
    expect(runtime.context.layers.visible.size).toBe(0);
    expect(runtime.context.layers.solo).toBeNull();
    expect(runtime.context.layers.lastDifference).toBeNull();
  });

  it('gives each runtime its own context', () => {
    const r1 = createAppRuntime();
    const r2 = createAppRuntime();
    r1.context.layers.solo = 'only-r1';
    expect(r2.context.layers.solo).toBeNull();
  });
});
