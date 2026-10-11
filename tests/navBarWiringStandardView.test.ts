/**
 * navBarWiringStandardView.test.ts — the compass and the NavBar view buttons
 * share ONE standard-view path (spec 1.4), so Plan View reacts the same to a
 * compass face click as to a NavBar view button: a non-top view leaves plan
 * mode, a top view keeps it, with exactly one viewer call and no recursion.
 */

import { describe, it, expect } from 'vitest';
import { createNavBarWiring } from '../src/ui/navBarWiring';
import type { NavBar } from '../src/ui/NavBar';
import type { Viewer } from '../src/render/Viewer';

function setup() {
  const calls: string[] = [];
  const viewer = {
    navMode: 'orbit', orthographic: false, handPanEnabled: true,
    setStandardView(view: string) { calls.push(`view:${view}`); this.navMode = 'orbit'; return true; },
    setOrthographic(on: boolean) { calls.push(`ortho:${on}`); this.orthographic = on; return true; },
    setMode(mode: string) { calls.push(`mode:${mode}`); this.navMode = mode; },
    // The ViewCube's turn-in-place: keeps pivot and distance, so it never refits.
    orientView(dir: readonly number[]) { calls.push(`orient:${dir.map((d) => Math.round(d * 100) / 100).join(',')}`); this.navMode = 'orbit'; return true; },
    frameAll() { calls.push('frameAll'); },
  };
  const planStates: boolean[] = [];
  const bar = { setPlanActive: (on: boolean) => planStates.push(on), setOrthographicActive: () => {} };
  const pending: (() => void)[] = [];
  const wiring = createNavBarWiring({
    getViewer: () => viewer as unknown as Viewer,
    getNavBar: () => bar as unknown as NavBar,
    toast: () => {},
    defer: (fn) => { pending.push(fn); },
  });
  const settle = (): void => { for (const fn of pending.splice(0)) fn(); };
  return { wiring, calls, planStates, settle };
}

describe('standard view while Plan View is on', () => {
  it('a non-top view (compass face or NavBar button) exits plan mode once', async () => {
    const { wiring, calls, planStates, settle } = setup();
    await wiring.togglePlanView();
    settle();
    expect(planStates.at(-1)).toBe(true);
    calls.length = 0;
    wiring.callbacks.onStandardView('back');
    settle();
    expect(calls.filter((c) => c.startsWith('view:'))).toEqual(['view:back']);
    expect(planStates.at(-1)).toBe(false);
    expect(planStates.filter((s) => !s)).toHaveLength(1);
  });

  it('the top view keeps plan mode', async () => {
    const { wiring, planStates, settle } = setup();
    await wiring.togglePlanView();
    settle();
    wiring.callbacks.onStandardView('top');
    settle();
    expect(planStates.at(-1)).toBe(true);
  });
});

describe('ViewCube clicks', () => {
  it('a cube face turns in place (orientView) instead of refitting (setStandardView): no zoom reset', () => {
    const { wiring, calls } = setup();
    wiring.callbacks.onStandardView('front', { dir: [0, 1, 0] });
    expect(calls).toEqual(['orient:0,1,0']);
    // A NavBar / palette view button still refits.
    wiring.callbacks.onStandardView('front');
    expect(calls.at(-1)).toBe('view:front');
  });

  it('a cube face keeps Plan View in sync: Top keeps it, another face leaves it', async () => {
    const { wiring, planStates, settle } = setup();
    await wiring.togglePlanView();
    settle();
    wiring.callbacks.onStandardView('top', { dir: [0, 0.02, 1] });
    settle();
    expect(planStates.at(-1)).toBe(true);
    wiring.callbacks.onStandardView('left', { dir: [1, 0, 0] });
    settle();
    expect(planStates.at(-1)).toBe(false);
  });

  it('an edge or corner turns in place and drops Plan View, so its chip cannot stay on', async () => {
    const { wiring, calls, planStates, settle } = setup();
    await wiring.togglePlanView();
    settle();
    expect(planStates.at(-1)).toBe(true);
    calls.length = 0;
    wiring.onOrientView([0.58, 0.58, 0.58]);
    settle();
    expect(calls.filter((c) => c.startsWith('orient:'))).toEqual(['orient:0.58,0.58,0.58']);
    expect(calls.some((c) => c.startsWith('view:'))).toBe(false);
    expect(planStates.at(-1)).toBe(false);
  });

  it('an edge or corner before Plan View was ever used loads nothing and still turns', () => {
    const { wiring, calls, planStates } = setup();
    wiring.onOrientView([0, 0.7, 0.7]);
    expect(calls).toEqual(['orient:0,0.7,0.7']);
    expect(planStates).toEqual([]);
  });
});
