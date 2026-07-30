/**
 * Two teardown holes met in the Stage.
 *
 * The header full-screen control was built into a local `const` and dropped on
 * the floor. It owns document-level `fullscreenchange` listeners, so once the
 * reference was gone nothing could detach them and the button stayed reachable
 * from the document for the page's lifetime. The Stage now holds it and
 * disposes it.
 *
 * The rail toggles are wired after construction by the composition root, which
 * had nowhere to keep their disposers, so `wireRailToggle` returning one would
 * change nothing on its own. `addTeardown` gives them a home that survives to
 * `dispose()`.
 *
 * A recording stub rather than jsdom, matching the other panel suites. The stub
 * answers `createElement` for every tag the empty state builds; the assertions
 * are about registration and teardown, never layout.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Stage } from '../src/ui/Stage';

interface Registration {
  type: string;
  handler: unknown;
}

interface NodeStub {
  readonly tag: string;
  readonly added: Registration[];
  readonly removed: Registration[];
  readonly attrs: Record<string, string>;
  readonly classes: Set<string>;
  readonly children: NodeStub[];
  className: string;
}

const nodes: NodeStub[] = [];

function makeNode(tag: string): NodeStub {
  const classes = new Set<string>();
  const children: NodeStub[] = [];
  const added: Registration[] = [];
  const removed: Registration[] = [];
  const attrs: Record<string, string> = {};
  const node = {
    tag,
    added,
    removed,
    attrs,
    classes,
    children,
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    hidden: false,
    type: '',
    value: '',
    placeholder: '',
    src: '',
    alt: '',
    href: '',
    id: '',
    target: '',
    rel: '',
    decoding: '',
    disabled: false,
    files: null,
    onclick: null,
    offsetHeight: 0,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    classList: {
      add: (...n: string[]) => void n.forEach((x) => classes.add(x)),
      remove: (...n: string[]) => void n.forEach((x) => classes.delete(x)),
      toggle: (n: string, on?: boolean) =>
        void (on ?? !classes.has(n) ? classes.add(n) : classes.delete(n)),
      contains: (n: string) => classes.has(n),
    },
    setAttribute: (name: string, value: string) => void (attrs[name] = value),
    getAttribute: (name: string) => attrs[name] ?? null,
    append: (...kids: unknown[]) => {
      for (const k of kids) if (typeof k === 'object' && k !== null) children.push(k as NodeStub);
    },
    insertBefore: (child: NodeStub) => void children.push(child),
    replaceChildren: () => void children.splice(0, children.length),
    remove: () => {},
    click: () => {},
    blur: () => {},
    focus: () => {},
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    addEventListener: (type: string, handler: unknown) => void added.push({ type, handler }),
    removeEventListener: (type: string, handler: unknown) => void removed.push({ type, handler }),
  } as unknown as NodeStub;
  nodes.push(node);
  return node;
}

/** Every node the Stage built, in creation order, filtered by class name. */
const byClass = (name: string): NodeStub[] =>
  nodes.filter((n) => n.classes.has(name) || n.className.split(' ').includes(name));

const windowStub = {
  added: [] as Registration[],
  removed: [] as Registration[],
  addEventListener(type: string, handler: unknown) {
    this.added.push({ type, handler });
  },
  removeEventListener(type: string, handler: unknown) {
    this.removed.push({ type, handler });
  },
  // Desktop shape: the Stage's mobile copy variants are irrelevant here, and a
  // fixed answer keeps the empty state deterministic.
  matchMedia: () => ({ matches: false }),
};

describe('Stage teardown', () => {
  const saved = { document: globalThis.document, window: globalThis.window };
  let stage: Stage;
  let mount: NodeStub;
  let docAdded: Registration[];
  let docRemoved: Registration[];

  beforeEach(() => {
    nodes.length = 0;
    windowStub.added = [];
    windowStub.removed = [];
    docAdded = [];
    docRemoved = [];
    globalThis.document = {
      createElement: (tag: string) => makeNode(tag),
      // A supported element Fullscreen API, so the header control renders and
      // wires up. That is the state whose teardown is under test.
      documentElement: { requestFullscreen: () => Promise.resolve() },
      fullscreenEnabled: true,
      fullscreenElement: null,
      addEventListener: (type: string, handler: unknown) => void docAdded.push({ type, handler }),
      removeEventListener: (type: string, handler: unknown) =>
        void docRemoved.push({ type, handler }),
    } as unknown as Document;
    globalThis.window = windowStub as unknown as Window & typeof globalThis;
    // `el()` type-narrows with these before touching href / type, so they have
    // to exist as constructors even though the stub is not an instance.
    (globalThis as { HTMLAnchorElement?: unknown }).HTMLAnchorElement = class {};
    (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement = class {};
    mount = makeNode('div');
    stage = new Stage(mount as unknown as HTMLElement);
  });

  afterEach(() => {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  });

  it('builds the top bar with the full-screen control and its status region', () => {
    expect(byClass('olv-fs-toggle')).toHaveLength(1);
    const status = byClass('olv-fs-status');
    expect(status).toHaveLength(1);
    expect(status[0].attrs['aria-live']).toBe('polite');
  });

  it('disposes the full-screen control, detaching its document listeners', () => {
    const button = byClass('olv-fs-toggle')[0];
    expect(button.added.map((r) => r.type)).toEqual(['click']);
    expect(docAdded.map((r) => r.type)).toEqual(['fullscreenchange', 'webkitfullscreenchange']);
    stage.dispose();
    // Held, not dropped: an unheld control cannot be told to let go, and the
    // document outlives the Stage, so these are the listeners that leaked.
    expect(docRemoved).toEqual(docAdded);
    expect(button.removed).toEqual(button.added);
  });

  it('runs cleanups handed to addTeardown', () => {
    let runs = 0;
    stage.addTeardown(() => void (runs += 1));
    stage.addTeardown(() => void (runs += 1));
    expect(runs).toBe(0);
    stage.dispose();
    expect(runs).toBe(2);
  });

  it('runs each cleanup once even if dispose is called twice', () => {
    let runs = 0;
    stage.addTeardown(() => void (runs += 1));
    stage.dispose();
    stage.dispose();
    expect(runs).toBe(1);
  });

  it('still removes its own online/offline listeners', () => {
    const own = windowStub.added.filter((r) => r.type === 'online' || r.type === 'offline');
    expect(own).toHaveLength(2);
    stage.dispose();
    expect(windowStub.removed).toEqual(own);
  });
});
