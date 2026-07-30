/**
 * `wireRailToggle` used to return nothing while owning three things that
 * outlive the column it was wired to: a ResizeObserver watching every panel, a
 * window `resize` handler that measures those panels, and the grabber button it
 * appended to the overlay. Tearing the UI down left all three running, so the
 * observer kept firing against detached nodes and the handler kept reading
 * their boxes for the rest of the page's life.
 *
 * `wireRailScrollAffordance` in the same module already returned a disposer;
 * these assertions pin the same contract on the toggle.
 *
 * A recording stub rather than jsdom, matching the other panel suites: what
 * matters is that every registration is matched by a removal, which is exactly
 * what a counting stub can prove and a real DOM cannot.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { wireRailToggle } from '../src/ui/panelChrome';

interface Registration {
  type: string;
  handler: unknown;
}

interface NodeStub {
  readonly classes: Set<string>;
  readonly attrs: Record<string, string>;
  readonly children: NodeStub[];
  readonly added: Registration[];
  readonly removed: Registration[];
  removedFromTree: boolean;
  offsetHeight: number;
  className: string;
  innerHTML: string;
  title: string;
  readonly style: Record<string, string>;
  readonly classList: {
    toggle(name: string, on?: boolean): void;
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
  readonly dataset: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): { top: number; bottom: number };
  append(...nodes: NodeStub[]): void;
  addEventListener(type: string, handler: unknown): void;
  removeEventListener(type: string, handler: unknown): void;
  remove(): void;
}

function makeNode(offsetHeight = 100): NodeStub {
  const classes = new Set<string>();
  const node: NodeStub = {
    classes,
    attrs: {},
    children: [],
    added: [],
    removed: [],
    removedFromTree: false,
    offsetHeight,
    className: '',
    innerHTML: '',
    title: '',
    style: {},
    classList: {
      toggle: (n, on) => void (on ?? !classes.has(n) ? classes.add(n) : classes.delete(n)),
      add: (n) => void classes.add(n),
      remove: (n) => void classes.delete(n),
      contains: (n) => classes.has(n),
    },
    dataset: {},
    setAttribute: (name, value) => void (node.attrs[name] = value),
    getBoundingClientRect: () => ({ top: 0, bottom: node.offsetHeight }),
    append: (...nodes) => void node.children.push(...nodes),
    addEventListener: (type, handler) => void node.added.push({ type, handler }),
    removeEventListener: (type, handler) => void node.removed.push({ type, handler }),
    remove: () => void (node.removedFromTree = true),
  };
  return node;
}

/** Records observe/disconnect so the disposer's effect on it is visible. */
class RecordingObserver {
  static instances: RecordingObserver[] = [];
  observed = 0;
  disconnects = 0;
  constructor() {
    RecordingObserver.instances.push(this);
  }
  observe(): void {
    this.observed += 1;
  }
  disconnect(): void {
    this.disconnects += 1;
  }
}

const windowStub = {
  added: [] as Registration[],
  removed: [] as Registration[],
  addEventListener(type: string, handler: unknown) {
    this.added.push({ type, handler });
  },
  removeEventListener(type: string, handler: unknown) {
    this.removed.push({ type, handler });
  },
};

function wire(overlay: NodeStub, panels: NodeStub[]): () => void {
  return wireRailToggle({
    overlay: overlay as unknown as HTMLElement,
    panels: panels as unknown as HTMLElement[],
    tabClass: 'olv-rail-tab',
    chevron: '<svg aria-hidden="true"></svg>',
    collapsedClass: 'olv-rail-collapsed',
    storageKey: 'olv.test.collapsed',
    ariaControls: 'olv-left-panels',
  });
}

describe('wireRailToggle teardown', () => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    resize: globalThis.ResizeObserver,
  };

  beforeEach(() => {
    RecordingObserver.instances = [];
    windowStub.added = [];
    windowStub.removed = [];
    // `el()` builds the grabber through document.createElement, so the stub
    // only has to answer that one call.
    globalThis.document = {
      createElement: () => makeNode(),
    } as unknown as Document;
    globalThis.window = windowStub as unknown as Window & typeof globalThis;
    globalThis.ResizeObserver = RecordingObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.ResizeObserver = saved.resize;
  });

  it('returns a disposer', () => {
    const dispose = wire(makeNode(), [makeNode()]);
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
  });

  it('disconnects the ResizeObserver it attached', () => {
    const dispose = wire(makeNode(), [makeNode(), makeNode()]);
    const ro = RecordingObserver.instances[0];
    expect(ro.observed).toBe(2); // one per panel
    expect(ro.disconnects).toBe(0);
    dispose();
    expect(ro.disconnects).toBe(1);
  });

  it('removes the window resize listener it added, by identity', () => {
    const dispose = wire(makeNode(), [makeNode()]);
    const resizeAdds = windowStub.added.filter((r) => r.type === 'resize');
    expect(resizeAdds).toHaveLength(1);
    dispose();
    expect(windowStub.removed).toEqual(resizeAdds);
  });

  it('removes the grabber it appended, and its click handler with it', () => {
    const overlay = makeNode();
    const dispose = wire(overlay, [makeNode()]);
    const tab = overlay.children[0];
    expect(tab).toBeDefined();
    const clickAdds = tab.added.filter((r) => r.type === 'click');
    expect(clickAdds).toHaveLength(1);

    dispose();
    expect(tab.removedFromTree).toBe(true);
    // Identity, not just count: a host that keeps the node must not keep a
    // handler that toggles panels it no longer owns.
    expect(tab.removed).toEqual(clickAdds);
  });

  it('leaves nothing attached when no ResizeObserver exists', () => {
    // @ts-expect-error removing the global for the span of one case
    delete globalThis.ResizeObserver;
    const overlay = makeNode();
    const dispose = wire(overlay, [makeNode()]);
    expect(RecordingObserver.instances).toHaveLength(0);
    dispose();
    // The static fallback still registers the window listener, so the disposer
    // is the only thing that can take it back.
    expect(windowStub.removed.filter((r) => r.type === 'resize')).toHaveLength(1);
    expect(overlay.children[0].removedFromTree).toBe(true);
  });

  it('is safe to call twice', () => {
    const dispose = wire(makeNode(), [makeNode()]);
    dispose();
    expect(() => dispose()).not.toThrow();
    // A second run must not double-disconnect an observer it already dropped.
    expect(RecordingObserver.instances[0].disconnects).toBe(1);
  });
});
