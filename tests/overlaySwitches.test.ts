/**
 * overlaySwitches.test.ts
 *
 * The "Created layers" checkbox list: hidden until an overlay exists, one
 * labelled checkbox row per overlay, a toggle writes through the owner, and
 * a change made elsewhere re-renders the row.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl, installFakeDom } from './support/measurePanelDom';
import { createOverlayRegistry } from '../src/app/overlayRegistry';
import { createOverlaySwitches } from '../src/ui/OverlaySwitches';

beforeAll(() => { installFakeDom({ fragment: true }); });

function checks(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl): void => {
    if (n.tagName === 'input') out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

describe('OverlaySwitches', () => {
  it('stays hidden with no overlay and shows one labelled checkbox per overlay', () => {
    const reg = createOverlayRegistry();
    const state = { contours: false, flow: false, vis: true };
    reg.register({ id: 'contours', label: 'Contours', isAvailable: () => state.contours, get: () => state.vis, set: (v) => { state.vis = v; } });
    reg.register({ id: 'flow', label: 'Drainage lines', isAvailable: () => state.flow, get: () => true, set: () => {} });
    const ui = createOverlaySwitches(reg);
    const root = ui.element as unknown as FakeEl;
    expect(root.classList.contains('olv-hidden')).toBe(true);

    state.contours = true;
    reg.changed();
    expect(root.classList.contains('olv-hidden')).toBe(false);
    const [cb] = checks(root);
    expect(cb.type).toBe('checkbox');
    expect(cb.checked).toBe(true);
    // The checkbox sits inside a <label> carrying the name, so it is announced.
    expect(cb.parent?.parent?.tagName).toBe('label');
    expect(cb.parent?.parent?.textContent).toContain('Contours');
    expect(checks(root)).toHaveLength(1);

    cb.checked = false;
    cb.dispatchEvent({ type: 'change' });
    expect(state.vis).toBe(false);
    const [after] = checks(root);
    expect(after.checked).toBe(false);
    expect(after.parent?.parent?.classList.contains('is-hidden')).toBe(true);

    // Changed elsewhere (the Analyse checkbox): the row follows.
    state.vis = true;
    reg.changed();
    expect(checks(root)[0].checked).toBe(true);

    // Scan closed: rows go and the section hides.
    state.contours = false;
    reg.changed();
    expect(checks(root)).toHaveLength(0);
    expect(root.classList.contains('olv-hidden')).toBe(true);
    ui.dispose();
  });
});
