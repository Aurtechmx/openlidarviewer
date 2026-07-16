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

describe('createAppContext — scan cluster', () => {
  it('starts with no active scan', () => {
    expect(createAppContext().scan.activeId).toBeNull();
  });

  it('carries the active-scan selection (the migrated main.ts assignments write through)', () => {
    const ctx = createAppContext();
    ctx.scan.activeId = 'cloud-1';
    expect(ctx.scan.activeId).toBe('cloud-1');
    ctx.scan.activeId = null;
    expect(ctx.scan.activeId).toBeNull();
  });

  it('isolates the active scan per context', () => {
    const a = createAppContext();
    const b = createAppContext();
    a.scan.activeId = 'x';
    expect(b.scan.activeId).toBeNull();
  });
});

describe('createAppContext — view-bookmarks cluster', () => {
  it('starts with no saved views and a zeroed counter', () => {
    const ctx = createAppContext();
    expect(ctx.viewBookmarks.savedViews).toEqual([]);
    expect(ctx.viewBookmarks.viewCounter).toBe(0);
  });

  it('carries saved views and the counter (the migrated main.ts state)', () => {
    const ctx = createAppContext();
    ctx.viewBookmarks.savedViews.push({
      name: 'View 1',
      pose: { position: [0, 0, 0], target: [1, 1, 1], up: [0, 0, 1] } as never,
    });
    ctx.viewBookmarks.viewCounter += 1;
    expect(ctx.viewBookmarks.savedViews).toHaveLength(1);
    expect(ctx.viewBookmarks.savedViews[0].name).toBe('View 1');
    expect(ctx.viewBookmarks.viewCounter).toBe(1);
  });

  it('isolates view bookmarks per context', () => {
    const a = createAppContext();
    const b = createAppContext();
    a.viewBookmarks.viewCounter = 5;
    expect(b.viewBookmarks.viewCounter).toBe(0);
    expect(b.viewBookmarks.savedViews).toEqual([]);
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
