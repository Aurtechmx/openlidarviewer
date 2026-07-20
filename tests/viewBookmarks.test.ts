import { describe, it, expect } from 'vitest';
import { createViewBookmarks } from '../src/app/viewBookmarks';
import { createAppContext } from '../src/app/appContext';
import type { CameraPose } from '../src/render/NavController';

// A minimal camera pose — the bookmark service treats it as opaque payload.
const POSE = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] } as unknown as CameraPose;

describe('viewBookmarks service', () => {
  it('names each added view monotonically and returns the assigned name', () => {
    const svc = createViewBookmarks(createAppContext());
    expect(svc.add({ pose: POSE })).toBe('View 1');
    expect(svc.add({ pose: POSE })).toBe('View 2');
    expect(svc.names()).toEqual(['View 1', 'View 2']);
    expect(svc.count()).toBe(2);
  });

  it('gets by index and returns undefined out of range', () => {
    const svc = createViewBookmarks(createAppContext());
    svc.add({ pose: POSE });
    expect(svc.get(0)?.name).toBe('View 1');
    expect(svc.get(5)).toBeUndefined();
    expect(svc.get(-1)).toBeUndefined();
  });

  it('removes by index and is a no-op out of range', () => {
    const svc = createViewBookmarks(createAppContext());
    svc.add({ pose: POSE });
    svc.add({ pose: POSE });
    svc.remove(9); // out of range — unchanged
    expect(svc.count()).toBe(2);
    svc.remove(0);
    expect(svc.names()).toEqual(['View 2']);
  });

  it('renames by index and is a no-op out of range', () => {
    const svc = createViewBookmarks(createAppContext());
    svc.add({ pose: POSE });
    svc.rename(0, 'north scarp');
    svc.rename(9, 'ignored');
    expect(svc.names()).toEqual(['north scarp']);
  });

  it('restore replaces the list and reseeds from the highest View N, not the count', () => {
    const svc = createViewBookmarks(createAppContext());
    svc.restore([
      { name: 'A', pose: POSE },
      { name: 'B', pose: POSE },
    ]);
    expect(svc.names()).toEqual(['A', 'B']);
    // No `View N` among the restored names, so numbering starts fresh.
    expect(svc.add({ pose: POSE })).toBe('View 1');
  });

  // Regression: restore() used to seed the counter from the LIST LENGTH, so a
  // session carrying ["View 3", "North"] (length 2) regenerated "View 3" and
  // collided with the entry already in the list.
  it('a sparse restored set does not regenerate a name already present', () => {
    const svc = createViewBookmarks(createAppContext());
    svc.restore([
      { name: 'View 3', pose: POSE },
      { name: 'North', pose: POSE },
    ]);
    const next = svc.add({ pose: POSE });
    expect(next).toBe('View 4');
    expect(new Set(svc.names()).size).toBe(svc.count());
  });

  it('a high-numbered restored view pushes numbering past it', () => {
    const svc = createViewBookmarks(createAppContext());
    svc.restore([{ name: 'View 41', pose: POSE }]);
    expect(svc.add({ pose: POSE })).toBe('View 42');
  });

  it('renaming a view TO an unused View N is not handed out again', () => {
    const svc = createViewBookmarks(createAppContext());
    svc.add({ pose: POSE }); // View 1
    svc.rename(0, 'View 2'); // the counter has not reached 2 yet
    expect(svc.add({ pose: POSE })).toBe('View 3');
    expect(new Set(svc.names()).size).toBe(svc.count());
  });

  it('duplicate imported names survive restore without breaking numbering', () => {
    const svc = createViewBookmarks(createAppContext());
    svc.restore([
      { name: 'Site', pose: POSE },
      { name: 'Site', pose: POSE },
    ]);
    expect(svc.count()).toBe(2);
    expect(svc.add({ pose: POSE })).toBe('View 1');
  });

  it('an empty imported name is preserved and does not affect numbering', () => {
    const svc = createViewBookmarks(createAppContext());
    svc.restore([{ name: '', pose: POSE }]);
    expect(svc.names()).toEqual(['']);
    expect(svc.add({ pose: POSE })).toBe('View 1');
  });

  it('clear drops every view and resets the counter', () => {
    const svc = createViewBookmarks(createAppContext());
    svc.add({ pose: POSE });
    svc.add({ pose: POSE });
    svc.clear();
    expect(svc.count()).toBe(0);
    expect(svc.add({ pose: POSE })).toBe('View 1');
  });

  it('writes through to the shared AppContext cluster (same state the panels read)', () => {
    const ctx = createAppContext();
    const svc = createViewBookmarks(ctx);
    svc.add({ pose: POSE });
    expect(ctx.viewBookmarks.savedViews).toHaveLength(1);
    expect(ctx.viewBookmarks.viewCounter).toBe(1);
  });
});
