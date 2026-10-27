/**
 * overlayRegistry.test.ts
 *
 * The registry behind the "Created layers" list: it lists only generated
 * overlays, holds no visibility of its own (owners do), and applies a
 * restored session preference once, when the overlay next appears.
 */
import { describe, it, expect, vi } from 'vitest';
import { createOverlayRegistry, type OverlayEntry } from '../src/app/overlayRegistry';

function owner(id: string, label = id) {
  const state = { available: false, visible: true };
  const entry: OverlayEntry = {
    id,
    label,
    isAvailable: () => state.available,
    get: () => state.visible,
    set: vi.fn((v: boolean) => { state.visible = v; }),
  };
  return { state, entry };
}

describe('overlayRegistry', () => {
  it('lists only overlays that have been generated, in registration order', () => {
    const reg = createOverlayRegistry();
    const a = owner('contours');
    const b = owner('flow');
    reg.register(a.entry);
    reg.register(b.entry);
    expect(reg.available()).toEqual([]);
    b.state.available = true;
    a.state.available = true;
    expect(reg.available().map((e) => e.id)).toEqual(['contours', 'flow']);
  });

  it('reads visibility from the owner, so another control changing it is seen', () => {
    const reg = createOverlayRegistry();
    const a = owner('contours');
    a.state.available = true;
    reg.register(a.entry);
    const fn = vi.fn();
    reg.onChange(fn);
    a.state.visible = false; // e.g. the Analyse checkbox
    reg.changed();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reg.snapshot()).toEqual({ contours: false });
  });

  it('unregister removes the row and notifies', () => {
    const reg = createOverlayRegistry();
    const a = owner('flow');
    a.state.available = true;
    const off = reg.register(a.entry);
    const fn = vi.fn();
    reg.onChange(fn);
    off();
    expect(reg.available()).toEqual([]);
    expect(fn).toHaveBeenCalled();
  });

  it('applies a restored preference once when the overlay appears', () => {
    const reg = createOverlayRegistry();
    const a = owner('flow');
    reg.register(a.entry);
    reg.restore({ flow: false, bogus: 'x' as unknown as boolean });
    expect(a.entry.set).not.toHaveBeenCalled();
    a.state.available = true;
    reg.changed();
    expect(a.entry.set).toHaveBeenCalledWith(false);
    // A later user choice is not overridden by the old preference.
    a.state.visible = true;
    reg.changed();
    expect(a.entry.set).toHaveBeenCalledTimes(1);
  });

  it('restore of an older session with no field is a no-op', () => {
    const reg = createOverlayRegistry();
    expect(() => reg.restore(undefined)).not.toThrow();
    expect(reg.snapshot()).toEqual({});
  });
});
