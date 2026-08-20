/**
 * planViewWiring.test.ts — that Plan View's intents actually reach the viewer.
 *
 * `planView.test.ts` covers the decision. Nothing there can fail if the decision
 * is never executed, which is the state the feature shipped in: a complete,
 * tested core with no caller. These tests cover the other half — the controller
 * that reads the scene, runs the intents, and puts the scene back.
 *
 * Three failures they exist to catch, all of them invisible to a pure test:
 *
 *   `Viewer.setStandardView` calls `setMode('orbit')`, so the hand tool plan
 *   mode depends on is taken away even when the planner had no reason to ask
 *   for it — a user who was already panning would enter plan mode orbiting.
 *
 *   `NavController.setMode` clears an in-flight camera tween, so applying the
 *   navigation intent straight after the view intent cancels the move to
 *   top-down and leaves the camera where it was.
 *
 *   `planViewSurvives` has to be asked. Without it the Plan chip keeps claiming
 *   plan mode after the user has turned the projection off by hand, and turning
 *   it off then "restores" a scene nobody was in.
 *
 * The fake viewport below reproduces both viewer behaviours deliberately: a
 * standard view forces orbit, and a mode change is refused when the hand tool is
 * off. A fake that did neither would pass on wiring that cannot work.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { NavMode } from '../src/render/NavController';
import type { StandardView } from '../src/render/camera/cameraPresets';
import {
  createPlanViewController,
  PLAN_VIEW_SETTLE_MS,
  type PlanViewChange,
  type PlanViewViewport,
} from '../src/render/camera/planViewController';

// ── A viewer that behaves the way the real one does ─────────────────────────

class FakeViewport implements PlanViewViewport {
  navMode: NavMode = 'orbit';
  orthographic = false;
  handPanEnabled = true;
  /** False stands in for "no scan loaded", which is what returns false. */
  hasScan = true;
  /** Every call, in order, so a test can pin the sequence and not just the end. */
  readonly calls: string[] = [];

  setStandardView(view: StandardView): boolean {
    this.calls.push(`view:${view}`);
    if (!this.hasScan) return false;
    // The real method hands the camera back to OrbitControls before tweening.
    this.navMode = 'orbit';
    return true;
  }

  setOrthographic(on: boolean): boolean {
    this.calls.push(`ortho:${on}`);
    this.orthographic = on;
    return true;
  }

  setMode(mode: NavMode): void {
    this.calls.push(`mode:${mode}`);
    // The real controller refuses pan when the `?handPan=off` flag disabled it.
    if (mode === 'pan' && !this.handPanEnabled) return;
    this.navMode = mode;
  }
}

/** A controller whose post-tween work is released by hand. */
function controller(v: FakeViewport | null) {
  const pending: (() => void)[] = [];
  const changes: { active: boolean; reason: PlanViewChange }[] = [];
  const plan = createPlanViewController({
    viewport: () => v,
    defer: (fn) => { pending.push(fn); },
    onChange: (active, reason) => { changes.push({ active, reason }); },
  });
  /** Let the camera tween land. */
  const settle = (): void => {
    for (const fn of pending.splice(0)) fn();
  };
  return { plan, settle, changes, pending };
}

describe('entering plan view', () => {
  it('looks straight down and drops the perspective', () => {
    const v = new FakeViewport();
    const { plan } = controller(v);

    plan.toggle();

    expect(v.calls).toEqual(['view:top', 'ortho:true']);
    expect(v.orthographic).toBe(true);
    expect(plan.active).toBe(true);
  });

  it('waits for the view to land before handing the drag to the hand tool', () => {
    const v = new FakeViewport();
    const { plan, settle } = controller(v);

    plan.toggle();
    // `NavController.setMode` clears the tween, so a mode set here would stop
    // the camera short of top-down.
    expect(v.calls).not.toContain('mode:pan');
    expect(v.navMode).toBe('orbit');

    settle();
    expect(v.navMode).toBe('pan');
  });

  it('keeps the hand tool when the scene was already panning', () => {
    const v = new FakeViewport();
    v.navMode = 'pan';
    const { plan, settle } = controller(v);

    plan.toggle();
    settle();

    // The planner asks for nothing here, having nothing to change. The standard
    // view takes pan away regardless, so plan mode would orbit without a repair.
    expect(v.navMode).toBe('pan');
  });

  it('does not ask for a hand tool the build does not have', () => {
    const v = new FakeViewport();
    v.handPanEnabled = false;
    const { plan, settle } = controller(v);

    plan.toggle();
    settle();

    expect(v.calls).not.toContain('mode:pan');
    expect(plan.active).toBe(true);
  });

  it('does not enter, or touch the projection, with no scan to look at', () => {
    const v = new FakeViewport();
    v.hasScan = false;
    const { plan, changes } = controller(v);

    plan.toggle();

    expect(plan.active).toBe(false);
    expect(v.orthographic).toBe(false);
    expect(v.calls).toEqual(['view:top']);
    expect(changes).toEqual([]);
  });

  it('is inert until the render chunk resolves', () => {
    const { plan, changes } = controller(null);
    plan.toggle();
    expect(plan.active).toBe(false);
    expect(changes).toEqual([]);
  });
});

describe('leaving plan view', () => {
  it('puts back the mode and the projection it captured', () => {
    const v = new FakeViewport();
    v.navMode = 'fly';
    const { plan, settle } = controller(v);

    plan.toggle();
    settle();
    v.calls.length = 0;

    plan.toggle();
    expect(v.calls).toEqual(['ortho:false', 'view:front']);
    settle();

    expect(v.orthographic).toBe(false);
    expect(v.navMode).toBe('fly');
    expect(plan.active).toBe(false);
  });

  it('leaves a projection the user chose themselves alone', () => {
    const v = new FakeViewport();
    v.orthographic = true;
    const { plan, settle } = controller(v);

    plan.toggle();
    settle();
    v.calls.length = 0;

    plan.toggle();
    settle();

    expect(v.calls).not.toContain('ortho:false');
    expect(v.orthographic).toBe(true);
  });

  it('returns a scene that was already panning to the hand tool', () => {
    const v = new FakeViewport();
    v.navMode = 'pan';
    const { plan, settle } = controller(v);

    plan.toggle();
    settle();
    plan.toggle();
    settle();

    // `view:front` set orbit on the way out; the capture said pan.
    expect(v.navMode).toBe('pan');
  });

  it('forgets the session when the scan closes, without aiming at nothing', () => {
    const v = new FakeViewport();
    const { plan, settle, changes } = controller(v);
    plan.toggle();
    settle();
    v.calls.length = 0;

    plan.reset();

    expect(plan.active).toBe(false);
    // The scan is gone; a restore would tween a camera at an empty stage.
    expect(v.calls).toEqual([]);
    expect(changes.at(-1)).toEqual({ active: false, reason: 'drift' });
  });

  it('has nothing to forget when plan mode is already off', () => {
    const v = new FakeViewport();
    const { plan, changes } = controller(v);
    plan.reset();
    expect(v.calls).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('reports the round trip as two deliberate toggles', () => {
    const v = new FakeViewport();
    const { plan, settle, changes } = controller(v);

    plan.toggle();
    settle();
    plan.toggle();
    settle();

    expect(changes).toEqual([
      { active: true, reason: 'toggle' },
      { active: false, reason: 'toggle' },
    ]);
  });
});

describe('when the user changes the scene by hand', () => {
  /** An active plan session with the entry work already applied. */
  function entered() {
    const v = new FakeViewport();
    const c = controller(v);
    c.plan.toggle();
    c.settle();
    v.calls.length = 0;
    return { v, ...c };
  }

  it('drops the claim when the projection goes back to perspective', () => {
    const { v, plan, changes } = entered();

    v.orthographic = false;
    plan.noteOrthographic(false);

    expect(plan.active).toBe(false);
    expect(changes.at(-1)).toEqual({ active: false, reason: 'drift' });
    // Dropping is not leaving: the user already has the scene they asked for,
    // and a restore here would undo their own click.
    expect(v.calls).toEqual([]);
  });

  it('drops the claim when the camera is aimed anywhere but straight down', () => {
    const { plan } = entered();
    plan.noteStandardView('front');
    expect(plan.active).toBe(false);
  });

  it('keeps the claim when the user re-picks the top view', () => {
    const { plan } = entered();
    plan.noteStandardView('top');
    expect(plan.active).toBe(true);
  });

  it('reads a camera preset the same way', () => {
    const first = entered();
    first.plan.noteCameraPreset('top');
    expect(first.plan.active).toBe(true);

    const second = entered();
    second.plan.noteCameraPreset('oblique');
    expect(second.plan.active).toBe(false);
  });

  it('cancels the mode change the entry still owed', () => {
    const v = new FakeViewport();
    const { plan, settle } = controller(v);

    plan.toggle();
    // Before the tween lands, the user turns the projection off.
    v.orthographic = false;
    plan.noteOrthographic(false);
    settle();

    // Arriving late, the hand tool would be switched on for a session that
    // ended — and the Plan chip would be off while the drag said otherwise.
    expect(v.navMode).toBe('orbit');
    expect(v.calls).not.toContain('mode:pan');
  });

  it('says nothing while plan mode is off', () => {
    const v = new FakeViewport();
    const { plan, changes } = controller(v);
    plan.noteOrthographic(false);
    plan.noteStandardView('left');
    expect(changes).toEqual([]);
  });
});

describe('the settle delay', () => {
  it('outlasts the 0.8 s standard-view tween', () => {
    expect(PLAN_VIEW_SETTLE_MS).toBeGreaterThan(800);
  });
});

// ── The NavBar chip ─────────────────────────────────────────────────────────

type Listener = () => void;

class FakeClassList {
  private readonly set = new Set<string>();
  add(...c: string[]): void { for (const x of c) this.set.add(x); }
  remove(...c: string[]): void { for (const x of c) this.set.delete(x); }
  contains(c: string): boolean { return this.set.has(c); }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(c);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  reset(v: string): void {
    this.set.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this.set.add(c);
  }
}

class FakeEl {
  private _className = '';
  classList = new FakeClassList();
  title = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  private readonly listeners: Listener[] = [];
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get className(): string { return this._className; }
  set className(v: string) { this._className = v; this.classList.reset(v); }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string { return this._text; }
  set innerHTML(_v: string) { /* icon markup is not under test */ }
  append(...kids: (FakeEl | string | null)[]): void {
    for (const k of kids) if (k && typeof k !== 'string') this.children.push(k);
  }
  addEventListener(_type: string, fn: Listener): void { this.listeners.push(fn); }
  blur(): void { /* no-op */ }
  click(): void { for (const fn of [...this.listeners]) fn(); }
  byClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.classList.contains(cls)) out.push(this);
    for (const c of this.children) out.push(...c.byClass(cls));
    return out;
  }
  text(): string {
    return [this._text, ...this.children.map((c) => c.text())].filter(Boolean).join(' ');
  }
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
  g.HTMLAnchorElement ??= class {};
  g.HTMLInputElement ??= class {};
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
});

/** A NavBar whose callbacks are spies; only the Plan chip is under test. */
async function navbar(onPlanView: () => void) {
  const { NavBar } = await import('../src/ui/NavBar');
  const noop = (): void => { /* inert */ };
  const bar = new NavBar({
    onMode: noop,
    onSpeed: noop,
    onReset: noop,
    onCameraPreset: noop,
    onStandardView: noop,
    onOrthographic: noop,
    onPlanView,
  });
  const root = bar.element as unknown as FakeEl;
  return { bar, root, chip: root.byClass('olv-plan-toggle')[0] };
}

describe('the Plan chip', () => {
  it('sits in the Views row, unpressed, beside the projection toggle', async () => {
    const { root, chip } = await navbar(() => { /* inert */ });
    expect(chip).toBeDefined();
    expect(chip.text()).toBe('Plan');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    const views = root.byClass('olv-cam-views')[0];
    expect(views.byClass('olv-plan-toggle')).toHaveLength(1);
    expect(views.byClass('olv-ortho-toggle')).toHaveLength(1);
  });

  it('reports the press and lets the caller own the state', async () => {
    const onPlanView = vi.fn();
    const { chip } = await navbar(onPlanView);

    chip.click();

    expect(onPlanView).toHaveBeenCalledTimes(1);
    // Pressing itself would strand the chip on when entering was refused for
    // want of a scan, or when plan mode drops itself a moment later.
    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });

  it('follows the state it is told about', async () => {
    const { bar, chip } = await navbar(() => { /* inert */ });

    bar.setPlanActive(true);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.classList.contains('is-on')).toBe(true);

    bar.setPlanActive(false);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.classList.contains('is-on')).toBe(false);
  });

  it('lets the projection chip be corrected from outside', async () => {
    const { bar, root } = await navbar(() => { /* inert */ });
    const ortho = root.byClass('olv-ortho-toggle')[0];

    // Plan mode turns the projection on without touching this chip.
    bar.setOrthographicActive(true);

    expect(ortho.getAttribute('aria-pressed')).toBe('true');
    expect(ortho.classList.contains('is-on')).toBe(true);
  });
});

// ── The shell wiring ────────────────────────────────────────────────────────

/** The viewport plus the rest of the surface the bar's other handlers touch. */
class FakeViewer extends FakeViewport {
  setCameraPreset(name: string): boolean {
    this.calls.push(`preset:${name}`);
    return this.hasScan;
  }
  setNavSpeed(multiplier: number): void { this.calls.push(`speed:${multiplier}`); }
  frameAll(): void { this.calls.push('frameAll'); }
}

describe('the NavBar callbacks', () => {
  async function wired() {
    const { createNavBarWiring } = await import('../src/ui/navBarWiring');
    const v = new FakeViewer();
    const pending: (() => void)[] = [];
    const toasts: string[] = [];
    const bar = { setPlanActive: vi.fn(), setOrthographicActive: vi.fn() };
    const wiring = createNavBarWiring({
      getViewer: () => v,
      getNavBar: () => bar,
      toast: (m: string) => { toasts.push(m); },
      defer: (fn: () => void) => { pending.push(fn); },
    } as unknown as Parameters<typeof createNavBarWiring>[0]);
    const settle = (): void => { for (const fn of pending.splice(0)) fn(); };
    return {
      v,
      bar,
      toasts,
      settle,
      cb: wiring.callbacks,
      toggle: wiring.togglePlanView,
      notePreset: wiring.notePlanViewPreset,
      reset: wiring.resetPlanView,
    };
  }

  it('reaches the viewer and reports back to the bar', async () => {
    const { v, bar, toasts, settle, toggle } = await wired();

    await toggle();
    settle();

    expect(v.orthographic).toBe(true);
    expect(v.navMode).toBe('pan');
    expect(bar.setPlanActive).toHaveBeenLastCalledWith(true);
    // The Ortho chip was never clicked, but the projection changed under it.
    expect(bar.setOrthographicActive).toHaveBeenLastCalledWith(true);
    expect(toasts.at(-1)).toMatch(/^Plan view on/);
  });

  it('tells plan mode when the user turns the projection off', async () => {
    const { bar, toasts, settle, cb, toggle } = await wired();
    await toggle();
    settle();

    cb.onOrthographic(false);

    expect(bar.setPlanActive).toHaveBeenLastCalledWith(false);
    // A drift is not an announcement; the chip going dark is the feedback.
    expect(toasts.at(-1)).toBe('Perspective view restored.');
  });

  it('tells plan mode when the user aims the camera elsewhere', async () => {
    const { bar, settle, cb, toggle } = await wired();
    await toggle();
    settle();

    cb.onStandardView('left');

    expect(bar.setPlanActive).toHaveBeenLastCalledWith(false);
  });

  it('hears about a preset fired from outside the bar', async () => {
    const { bar, settle, notePreset, toggle } = await wired();
    await toggle();
    settle();

    // The command palette runs the same presets the chips do.
    notePreset('oblique');

    expect(bar.setPlanActive).toHaveBeenLastCalledWith(false);
  });

  it('forgets plan mode when the scan closes', async () => {
    const { bar, settle, reset, toggle } = await wired();
    await toggle();
    settle();

    reset();

    expect(bar.setPlanActive).toHaveBeenLastCalledWith(false);
  });

  it('costs nothing until the chip is pressed', async () => {
    const { bar, cb, notePreset, reset } = await wired();
    // The controller chunk has not been asked for, so these can only no-op.
    cb.onStandardView('top');
    cb.onOrthographic(true);
    cb.onCameraPreset('iso');
    notePreset('top');
    reset();
    expect(bar.setPlanActive).not.toHaveBeenCalled();
  });

  it('turns plan mode back off on a second press', async () => {
    const { v, bar, settle, toggle } = await wired();
    await toggle();
    settle();

    await toggle();
    settle();

    expect(v.orthographic).toBe(false);
    expect(v.navMode).toBe('orbit');
    expect(bar.setPlanActive).toHaveBeenLastCalledWith(false);
  });

  it('keeps the existing view and preset toasts', async () => {
    const { toasts, cb } = await wired();
    cb.onStandardView('front');
    expect(toasts.at(-1)).toBe('View · Front.');
    cb.onCameraPreset('oblique');
    expect(toasts.at(-1)).toBe('Camera · Oblique view.');
  });

  it('says nothing when there is no scan to view', async () => {
    const { v, toasts, cb } = await wired();
    v.hasScan = false;
    cb.onStandardView('front');
    expect(toasts).toEqual([]);
  });
});

describe('reset cancels work the scene will not be there for', () => {
  it('drops a deferred mode change owed by a leave that already completed', () => {
    const v = new FakeViewport();
    const { plan, settle } = controller(v);

    plan.toggle();
    settle();
    v.calls.length = 0;

    // Leaving goes INACTIVE immediately and leaves a deferred setMode owed.
    plan.toggle();
    expect(plan.active).toBe(false);

    // The scan closes before the camera tween lands.
    plan.reset();
    settle();

    // Nothing may steer a viewer whose scan just went away.
    expect(v.calls.filter((c) => c.startsWith('mode:'))).toEqual([]);
  });

  it('still cancels when reset runs while plan is active', () => {
    const v = new FakeViewport();
    const { plan, settle } = controller(v);

    plan.toggle();
    v.calls.length = 0;
    plan.reset();
    settle();

    expect(v.calls.filter((c) => c.startsWith('mode:'))).toEqual([]);
    expect(plan.active).toBe(false);
  });
});
