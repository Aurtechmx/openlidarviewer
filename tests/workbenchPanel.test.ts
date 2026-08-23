/**
 * workbenchPanel.test.ts
 *
 * The docked Profile Workbench panel (`src/ui/ProfileWorkbench.ts`), driven in
 * the node environment through a recording DOM stub and a plain-object host.
 * Nothing real is touched: no jsdom, no `window`, no `localStorage`, no
 * document-level listener — which is itself part of what is asserted, since a
 * panel that reached for any of them could not be driven this way.
 *
 * The suite is organised around the non-modal contract, which is what
 * separates this surface from `ResultFocus`: the 3D scene stays visible and
 * interactive while the workbench is open, so the panel takes no focus, traps
 * none, draws no backdrop, declares no `aria-modal`, and answers Escape only
 * for a press that came from inside it. Each of those has its own test.
 *
 * The height assertions call the dock module for their expected values rather
 * than restating its arithmetic, so a panel that computed a height itself
 * fails here the moment the two disagree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  COLLAPSED_DOCK_HEIGHT,
  PROFILE_WORKBENCH_DOCK_KEY,
  decodeDockPrefs,
  defaultDockHeight,
  dockOccupiedHeight,
  maxDockHeight,
} from '../src/ui/profileWorkbenchDock';
import type {
  ProfileWorkbenchHandle,
  ProfileWorkbenchHost,
  ProfileWorkbenchOptions,
} from '../src/ui/ProfileWorkbench';

/** A recorded listener registration. */
interface Listener {
  readonly type: string;
  readonly fn: (ev: unknown) => void;
}

/** A synthetic event, carrying the two calls the panel is allowed to make. */
interface FakeEvent {
  type: string;
  target: FakeEl | null;
  key?: string;
  clientY?: number;
  pointerId?: number;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Every listener the module registered on a non-element (document, global). */
const globalListeners: Listener[] = [];
/** Every element that had `focus()` called on it. */
const focused: FakeEl[] = [];

class FakeEl {
  readonly tagName: string;
  className = '';
  title = '';
  type = '';
  disabled = false;
  width = 0;
  height = 0;
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  readonly attrs: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly listeners: Listener[] = [];
  private readonly _classes = new Set<string>();
  private _text = '';

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  readonly classList = {
    add: (...c: string[]): void => c.forEach((n) => this._classes.add(n)),
    remove: (...c: string[]): void => c.forEach((n) => this._classes.delete(n)),
    contains: (c: string): boolean => this._classes.has(c),
    toggle: (c: string, on?: boolean): void => {
      const want = on ?? !this._classes.has(c);
      if (want) this._classes.add(c);
      else this._classes.delete(c);
    },
  };

  /** Class names from both `className` and `classList`, for assertions. */
  allClasses(): string[] {
    return [...this.className.split(/\s+/).filter(Boolean), ...this._classes];
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }

  set textContent(v: string) {
    this._text = v;
    this.children.length = 0;
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  /** This element's OWN text, ignoring descendants. */
  ownText(): string {
    return this._text;
  }

  append(...kids: FakeEl[]): void {
    for (const k of kids.filter(Boolean)) {
      k.parent = this;
      this.children.push(k);
    }
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.append(...kids);
  }
  remove(): void {
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1);
    this.parent = null;
  }
  contains(node: FakeEl | null): boolean {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.push({ type, fn });
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const at = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (at >= 0) this.listeners.splice(at, 1);
  }

  focus(): void {
    focused.push(this);
  }
  blur(): void {
    /* no-op */
  }
  click(): void {
    this.dispatch('click', {});
  }
  setPointerCapture(): void {
    /* no-op */
  }
  releasePointerCapture(): void {
    /* no-op */
  }
  getContext(): null {
    return null;
  }
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: 0, height: 0, left: 0, top: 0 };
  }

  /** Deliver an event to this element's listeners. Returns the event. */
  dispatch(type: string, props: Partial<FakeEvent>): FakeEvent {
    const ev: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault(): void {
        ev.defaultPrevented = true;
      },
      stopPropagation(): void {
        ev.propagationStopped = true;
      },
      ...props,
    };
    for (const l of [...this.listeners]) if (l.type === type) l.fn(ev);
    return ev;
  }

  /** Every element in this subtree, this one first. */
  tree(): FakeEl[] {
    return [this as FakeEl, ...this.children.flatMap((c) => c.tree())];
  }
  /** Descendants whose own text equals `label`. */
  findByText(label: string): FakeEl[] {
    return this.tree().filter((n) => n.ownText() === label);
  }
  /** The first descendant carrying `cls`, from `className` or `classList`. */
  byClass(cls: string): FakeEl | undefined {
    return this.tree().find((n) => n.allClasses().includes(cls));
  }
}

/** A host backed by nothing but plain values, so the panel has no other reach. */
class FakeHost implements ProfileWorkbenchHost {
  readonly root = new FakeEl('div');
  readonly notified: number[] = [];
  readonly store = new Map<string, string>();
  readonly resizeSubscribers: (() => void)[] = [];
  unsubscribeCalls = 0;
  stagePx: number;
  reducedMotion: boolean | null;

  constructor(stagePx = 1000, reducedMotion: boolean | null = false) {
    this.stagePx = stagePx;
    this.reducedMotion = reducedMotion;
  }

  container(): HTMLElement {
    return this.root as unknown as HTMLElement;
  }
  stageHeight(): number {
    return this.stagePx;
  }
  onStageResize(cb: () => void): () => void {
    this.resizeSubscribers.push(cb);
    return () => {
      this.unsubscribeCalls++;
      const at = this.resizeSubscribers.indexOf(cb);
      if (at >= 0) this.resizeSubscribers.splice(at, 1);
    };
  }
  notifyDockHeight(px: number): void {
    this.notified.push(px);
  }
  readonly storage = {
    getItem: (k: string): string | null => this.store.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      this.store.set(k, v);
    },
  };
  prefersReducedMotion(): boolean {
    return this.reducedMotion === true;
  }

  /** Resize the stage and run the subscribers, as the real stage would. */
  resizeStage(px: number): void {
    this.stagePx = px;
    for (const cb of [...this.resizeSubscribers]) cb();
  }
  stored(): { heightPx: number; collapsed: boolean } | null {
    return decodeDockPrefs(this.store.get(PROFILE_WORKBENCH_DOCK_KEY) ?? null);
  }
}

beforeEach(() => {
  globalListeners.length = 0;
  focused.length = 0;
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    // A document-level listener is the shape a focus trap and a stolen global
    // Escape both take. Recording it rather than dropping it is what lets the
    // tests below prove the panel registers none.
    addEventListener: (type: string, fn: (ev: unknown) => void): void => {
      globalListeners.push({ type, fn });
    },
    removeEventListener: (): void => {},
  };
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
  // `window` and `localStorage` are deliberately left undefined: any reach for
  // either throws a ReferenceError and fails the test that touched it.
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.HTMLInputElement;
  delete g.HTMLAnchorElement;
});

async function mount(
  host: FakeHost,
  options: ProfileWorkbenchOptions = {},
): Promise<{ handle: ProfileWorkbenchHandle; root: FakeEl }> {
  const { mountProfileWorkbench } = await import('../src/ui/ProfileWorkbench');
  const handle = mountProfileWorkbench(host, options);
  return { handle, root: handle.element as unknown as FakeEl };
}

describe('Profile Workbench — the non-modal contract', () => {
  it('is a labelled region, and declares no modal semantics anywhere in its tree', async () => {
    const host = new FakeHost();
    const { root } = await mount(host, { title: 'Profile workbench' });

    expect(root.getAttribute('role')).toBe('region');
    expect(root.getAttribute('aria-label')).toBe('Profile workbench');

    for (const node of root.tree()) {
      expect(node.getAttribute('aria-modal')).toBeNull();
      expect(node.getAttribute('role')).not.toBe('dialog');
      expect(node.getAttribute('role')).not.toBe('alertdialog');
    }
  });

  it('traps no focus: no document listener, no focus taken, and Tab is left alone', async () => {
    const host = new FakeHost();
    const { root } = await mount(host);

    // A trap needs somewhere to listen from. There is nowhere.
    expect(globalListeners).toEqual([]);
    // Opening a non-modal panel must not pull focus off the scene.
    expect(focused).toEqual([]);

    const close = root.findByText('Close')[0];
    const tab = close.dispatch('keydown', { key: 'Tab', target: close });
    expect(tab.defaultPrevented).toBe(false);
    const rootTab = root.dispatch('keydown', { key: 'Tab', target: close });
    expect(rootTab.defaultPrevented).toBe(false);
    // Nothing was pulled back to the panel's own edges.
    expect(focused).toEqual([]);
  });

  it('draws no backdrop and blurs nothing', async () => {
    const host = new FakeHost();
    const { root } = await mount(host);

    // Exactly one element was mounted: the panel. A backdrop is a sibling.
    expect(host.root.children).toHaveLength(1);
    expect(host.root.children[0]).toBe(root);

    for (const node of root.tree()) {
      for (const cls of node.allClasses()) {
        expect(cls).not.toMatch(/backdrop|scrim|olv-modal/);
      }
      expect(node.style.filter ?? '').not.toContain('blur');
      expect(node.style.backdropFilter ?? '').toBe('');
    }
  });

  it('answers Escape from inside the panel, collapsing and then closing', async () => {
    const host = new FakeHost();
    const { handle, root } = await mount(host);
    const inside = root.findByText('Close')[0];

    const first = root.dispatch('keydown', { key: 'Escape', target: inside });
    expect(handle.collapsed()).toBe(true);
    // Handled here, so it does not also reach a global Escape binding.
    expect(first.propagationStopped).toBe(true);

    root.dispatch('keydown', { key: 'Escape', target: inside });
    expect(host.root.children).toHaveLength(0);
  });

  it('ignores an Escape whose focus is outside, leaving the press to the app', async () => {
    const host = new FakeHost();
    const { handle, root } = await mount(host);
    const outside = new FakeEl('button');

    const ev = root.dispatch('keydown', { key: 'Escape', target: outside });

    expect(handle.collapsed()).toBe(false);
    expect(host.root.children).toHaveLength(1);
    expect(ev.propagationStopped).toBe(false);
  });
});

describe('Profile Workbench — structure', () => {
  it('holds a described canvas whose exact figures also exist as real text', async () => {
    const host = new FakeHost();
    const { handle, root } = await mount(host);
    const canvas = handle.canvas as unknown as FakeEl;

    expect(canvas.tagName).toBe('canvas');
    expect(canvas.getAttribute('role')).toBe('img');
    expect((canvas.getAttribute('aria-label') ?? '').length).toBeGreaterThan(20);

    // Nothing selected reads as nothing selected, not as an empty panel.
    expect(root.textContent).toContain('No return selected.');

    handle.setDetail([
      { label: 'Station', value: '12.480 m' },
      { label: 'Elevation', value: '104.113 m' },
    ]);
    // The figures are DOM text, so they are reachable without reading a canvas.
    expect(root.findByText('Station')).toHaveLength(1);
    expect(root.findByText('12.480 m')).toHaveLength(1);
    expect(root.findByText('104.113 m')).toHaveLength(1);
  });

  it('announces status politely, never assertively', async () => {
    const host = new FakeHost();
    const { handle, root } = await mount(host);
    const status = root.byClass('olv-workbench-status');

    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('role')).toBe('status');

    handle.setStatus('Sampling 4,182 returns.');
    expect(status?.textContent).toContain('4,182');
  });

  it('carries the animation class only when the host has no reduced-motion preference', async () => {
    const moving = new FakeHost(1000, false);
    const { root: movingRoot } = await mount(moving);
    expect(movingRoot.allClasses()).toContain('olv-workbench-animate');

    const still = new FakeHost(1000, true);
    const { root: stillRoot } = await mount(still);
    expect(stillRoot.allClasses()).not.toContain('olv-workbench-animate');
  });
});

describe('Profile Workbench — dock geometry', () => {
  it('opens at this stage default when nothing is stored', async () => {
    const host = new FakeHost(1000);
    const { handle, root } = await mount(host);
    const expected = defaultDockHeight({ stageHeight: 1000 });

    expect(handle.height()).toBe(expected);
    expect(root.style.height).toBe(`${expected}px`);
    expect(host.notified.at(-1)).toBe(expected);
  });

  it('opens at the stored height, and at the default when the stored value is unusable', async () => {
    const good = new FakeHost(1000);
    good.store.set(PROFILE_WORKBENCH_DOCK_KEY, JSON.stringify({ heightPx: 512, collapsed: false }));
    const { handle } = await mount(good);
    expect(handle.height()).toBe(512);

    const corrupt = new FakeHost(1000);
    corrupt.store.set(PROFILE_WORKBENCH_DOCK_KEY, '{not json');
    const { handle: fallback } = await mount(corrupt);
    expect(fallback.height()).toBe(defaultDockHeight({ stageHeight: 1000 }));
  });

  it('keeps a stored height the stage cannot honour inside this stage allowance', async () => {
    const host = new FakeHost(400);
    host.store.set(PROFILE_WORKBENCH_DOCK_KEY, JSON.stringify({ heightPx: 5000, collapsed: false }));
    const { handle, root } = await mount(host);
    const allowed = maxDockHeight({ stageHeight: 400 });

    expect(allowed).toBeLessThan(5000);
    expect(handle.height()).toBe(allowed);
    expect(root.style.height).toBe(`${allowed}px`);
    expect(host.notified.at(-1)).toBe(allowed);
  });

  it('resizes on a splitter drag, persists the preference, and tells the host', async () => {
    const host = new FakeHost(1000);
    const { handle, root } = await mount(host);
    const splitter = root.byClass('olv-workbench-splitter');
    const start = handle.height();
    const before = host.notified.length;

    splitter?.dispatch('pointerdown', { clientY: 600, pointerId: 1 });
    splitter?.dispatch('pointermove', { clientY: 540, pointerId: 1 });

    // Dragging the top edge UP by 60px makes the dock 60px taller.
    expect(handle.height()).toBe(start + 60);
    expect(root.style.height).toBe(`${start + 60}px`);
    expect(host.notified.length).toBeGreaterThan(before);
    expect(host.notified.at(-1)).toBe(start + 60);

    splitter?.dispatch('pointerup', { clientY: 540, pointerId: 1 });
    expect(host.stored()).toEqual({ heightPx: start + 60, collapsed: false });
  });

  it('resizes from the keyboard through the same dock arithmetic', async () => {
    const host = new FakeHost(1000);
    const { handle, root } = await mount(host);
    const splitter = root.byClass('olv-workbench-splitter');
    const start = handle.height();

    const up = splitter?.dispatch('keydown', { key: 'ArrowUp' });
    expect(up?.defaultPrevented).toBe(true);
    const taller = handle.height();
    expect(taller).toBeGreaterThan(start);

    splitter?.dispatch('keydown', { key: 'ArrowDown' });
    expect(handle.height()).toBe(start);
    expect(host.stored()?.heightPx).toBe(start);
  });

  it('collapses and restores, persisting both', async () => {
    const host = new FakeHost(1000);
    const { handle, root } = await mount(host);
    const open = handle.height();

    handle.setCollapsed(true);
    expect(handle.collapsed()).toBe(true);
    expect(handle.height()).toBe(COLLAPSED_DOCK_HEIGHT);
    expect(root.style.height).toBe(`${COLLAPSED_DOCK_HEIGHT}px`);
    expect(host.notified.at(-1)).toBe(COLLAPSED_DOCK_HEIGHT);
    expect(host.stored()).toEqual({ heightPx: open, collapsed: true });

    handle.setCollapsed(false);
    expect(handle.height()).toBe(open);
    expect(host.stored()).toEqual({ heightPx: open, collapsed: false });
  });

  it('re-derives on a stage resize from the same preference, so a shrink and a re-grow return the chosen height', async () => {
    const host = new FakeHost(1000);
    const { handle, root } = await mount(host);
    const splitter = root.byClass('olv-workbench-splitter');
    splitter?.dispatch('pointerdown', { clientY: 600, pointerId: 1 });
    splitter?.dispatch('pointermove', { clientY: 400, pointerId: 1 });
    splitter?.dispatch('pointerup', { clientY: 400, pointerId: 1 });
    const chosen = handle.height();

    host.resizeStage(300);
    const squeezed = dockOccupiedHeight({ preferredHeightPx: chosen, collapsed: false }, { stageHeight: 300 });
    expect(handle.height()).toBe(squeezed);
    expect(squeezed).toBeLessThan(chosen);
    expect(root.style.height).toBe(`${squeezed}px`);
    // The host has to hear about it, or its 3D canvas keeps the old height.
    expect(host.notified.at(-1)).toBe(squeezed);

    host.resizeStage(1000);
    expect(handle.height()).toBe(chosen);
    expect(host.notified.at(-1)).toBe(chosen);
  });
});

describe('Profile Workbench — teardown', () => {
  it('releases every listener, removes the element, and leaves a later mount clean', async () => {
    const host = new FakeHost(1000);
    const { handle, root } = await mount(host);
    const splitter = root.byClass('olv-workbench-splitter');
    splitter?.dispatch('pointerdown', { clientY: 600, pointerId: 1 });
    splitter?.dispatch('pointermove', { clientY: 500, pointerId: 1 });
    splitter?.dispatch('pointerup', { clientY: 500, pointerId: 1 });
    const chosen = handle.height();
    const nodes = root.tree();
    expect(nodes.some((n) => n.listeners.length > 0)).toBe(true);

    handle.close();

    for (const node of nodes) {
      expect(node.listeners, `${node.tagName}.${node.className} kept a listener`).toEqual([]);
    }
    expect(host.unsubscribeCalls).toBe(1);
    expect(host.resizeSubscribers).toEqual([]);
    expect(host.root.children).toHaveLength(0);

    // A stage resize after close reaches nothing.
    const notifiedAtClose = host.notified.length;
    host.resizeStage(700);
    expect(host.notified).toHaveLength(notifiedAtClose);

    // Mounting again works, and picks up the preference the closed panel left.
    const { handle: second } = await mount(host);
    expect(host.root.children).toHaveLength(1);
    expect(host.stored()?.heightPx).toBe(chosen);
    expect(second.height()).toBe(
      dockOccupiedHeight({ preferredHeightPx: chosen, collapsed: false }, { stageHeight: 700 }),
    );
  });

  it('closes once, however many times it is asked', async () => {
    const host = new FakeHost(1000);
    const { handle } = await mount(host);

    handle.close();
    handle.close();

    expect(host.unsubscribeCalls).toBe(1);
    expect(host.root.children).toHaveLength(0);
  });

  it('reports the close through the option the caller passed', async () => {
    const host = new FakeHost(1000);
    let closes = 0;
    const { root } = await mount(host, { onClose: () => { closes++; } });

    root.findByText('Close')[0].dispatch('click', {});

    expect(closes).toBe(1);
    expect(host.root.children).toHaveLength(0);
  });
});
