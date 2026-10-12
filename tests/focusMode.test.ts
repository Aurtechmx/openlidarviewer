/**
 * Focus mode (src/app/workspace/focusMode.ts): enter records the rails and the
 * route, exit puts exactly that back, the stored rail preference is never
 * written, Escape yields to anything with a stronger claim, and a closed scan
 * or a navigation leaves no Focus state behind.
 *
 * The module reaches the rails only through `setCollapsed`, so recording rails
 * prove both what it changes and that it never persists.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { createFocusMode, FOCUS_MODE_CLASS, type FocusModeDeps, type FocusRail } from '../src/app/workspace/focusMode';

interface RecordingRail extends FocusRail {
  collapsed: boolean;
  readonly calls: Array<{ collapsed: boolean; persist: boolean }>;
}

function rail(collapsed = false): RecordingRail {
  const r: RecordingRail = {
    collapsed,
    calls: [],
    isCollapsed: () => r.collapsed,
    setCollapsed: (c, opts) => {
      r.collapsed = c;
      r.calls.push({ collapsed: c, persist: !!opts?.persist });
    },
  };
  return r;
}

function setup(over: Partial<FocusModeDeps> & { leftCollapsed?: boolean; rightCollapsed?: boolean } = {}) {
  const classes = new Set<string>();
  const root = { classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) } };
  const left = rail(over.leftCollapsed);
  const right = rail(over.rightCollapsed);
  const state = { route: { mode: 'work', page: 'measure' as string | null }, available: true, blocked: false };
  const onChange = vi.fn();
  const focus = createFocusMode({
    root: root as unknown as HTMLElement,
    left,
    right,
    route: () => state.route,
    available: () => state.available,
    escapeBlocked: () => state.blocked,
    onChange,
    ...over,
  });
  return { focus, left, right, classes, state, onChange };
}

describe('Focus mode', () => {
  it('enter collapses both rails and marks the overlay', () => {
    const { focus, left, right, classes } = setup();
    expect(focus.enter()).toBe(true);
    expect(left.collapsed).toBe(true);
    expect(right.collapsed).toBe(true);
    expect(classes.has(FOCUS_MODE_CLASS)).toBe(true);
    expect(focus.snapshot()).toEqual({ leftCollapsed: false, rightCollapsed: false, route: { mode: 'work', page: 'measure' } });
  });

  it('exit restores exactly what enter found', () => {
    const { focus, left, right, classes, onChange } = setup({ rightCollapsed: true });
    focus.enter();
    focus.exit();
    expect(left.collapsed).toBe(false);
    expect(right.collapsed).toBe(true);
    expect(classes.has(FOCUS_MODE_CLASS)).toBe(false);
    expect(focus.isActive()).toBe(false);
    expect(focus.snapshot()).toBeNull();
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('a rail the user had collapsed stays collapsed after exit', () => {
    const { focus, left, right } = setup({ leftCollapsed: true, rightCollapsed: true });
    focus.toggle();
    focus.toggle();
    expect(left.collapsed).toBe(true);
    expect(right.collapsed).toBe(true);
  });

  it('never writes the stored rail preference', () => {
    const { focus, left, right } = setup();
    for (let i = 0; i < 5; i += 1) focus.toggle();
    focus.exit();
    expect([...left.calls, ...right.calls].every((c) => !c.persist)).toBe(true);
  });

  it('leaves the workspace mode and page alone', () => {
    const { focus, state } = setup();
    focus.enter();
    focus.sync(); // a route re-apply that did not navigate
    expect(focus.isActive()).toBe(true);
    focus.exit();
    expect(state.route).toEqual({ mode: 'work', page: 'measure' });
  });

  it('navigating elsewhere ends Focus mode and keeps the new route', () => {
    const { focus, state, left } = setup();
    focus.enter();
    state.route = { mode: 'data', page: 'classes' };
    focus.sync();
    expect(focus.isActive()).toBe(false);
    expect(left.collapsed).toBe(false);
    expect(state.route).toEqual({ mode: 'data', page: 'classes' });
  });

  it('is not offered where unavailable (phone layout, no scan)', () => {
    const { focus, state, left, classes } = setup();
    state.available = false;
    expect(focus.enter()).toBe(false);
    expect(focus.toggle()).toBe(false);
    expect(left.calls).toHaveLength(0);
    expect(classes.size).toBe(0);
  });

  it('a closed scan leaves no Focus state behind', () => {
    const { focus, state, classes, left, right } = setup();
    focus.enter();
    state.available = false; // the scan closed, or the layout became a phone
    focus.sync();
    expect(focus.isActive()).toBe(false);
    expect(focus.snapshot()).toBeNull();
    expect(classes.size).toBe(0);
    expect(left.collapsed).toBe(false);
    expect(right.collapsed).toBe(false);
    // The next scan starts from the rails as they were, not a stale snapshot.
    state.available = true;
    expect(focus.enter()).toBe(true);
    expect(focus.snapshot()?.leftCollapsed).toBe(false);
  });

  it('Escape exits only when nothing else claims it', () => {
    const { focus, state } = setup();
    expect(focus.escape()).toBe(false); // not in Focus mode: Escape is not spent
    focus.enter();
    state.blocked = true; // a dialog, popover or pointer lock is up
    expect(focus.escape()).toBe(false);
    expect(focus.isActive()).toBe(true);
    state.blocked = false;
    expect(focus.escape()).toBe(true);
    expect(focus.isActive()).toBe(false);
  });

  it('enter twice keeps the first snapshot; exit twice is harmless', () => {
    const { focus, left, onChange } = setup();
    focus.enter();
    focus.enter();
    expect(focus.snapshot()?.leftCollapsed).toBe(false);
    focus.exit();
    focus.exit();
    focus.dispose();
    expect(left.collapsed).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('touches only the rails: no camera, data, classification, clipping, measurement or analysis', () => {
    const src = readFileSync('src/app/workspace/focusMode.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/\bimport\b/);
    expect(src).not.toMatch(/viewer|camera|clip|measure|classif|analys/i);
  });
});

describe('Focus mode wiring in the workspace shell', () => {
  const shell = readFileSync('src/app/workspace/workspaceShell.ts', 'utf8');

  it('moves the rails through their programmatic seam, never a simulated click on a grabber', () => {
    const fn = shell.slice(shell.indexOf('function mountFocusMode'));
    expect(fn).not.toMatch(/\.click\(\)/);
    expect(shell).toMatch(/mountFocusMode\(d, leftRail, rightRailToggle/);
  });

  it('removes every listener it adds and ends Focus mode on teardown', () => {
    const fn = shell.slice(shell.indexOf('function mountFocusMode'));
    expect(fn).toMatch(/document\.removeEventListener\(FOCUS_MODE_TOGGLE_EVENT, onToggle\)/);
    expect(fn).toMatch(/button\.removeEventListener\('click', onClick\)/);
    expect(fn).toMatch(/focus\.dispose\(\)/);
  });

  it('re-checks Focus mode when the scan or layout changes and when the route syncs', () => {
    expect(shell).toMatch(/refreshLogPage\(\); focus\?\.sync\(\);/);
    const apply = shell.slice(shell.indexOf('const applyMobileSheet'));
    expect(apply).toMatch(/focus\?\.sync\(\)/);
  });
});
