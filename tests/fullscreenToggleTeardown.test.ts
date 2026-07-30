/**
 * The header full-screen button attached three listeners in its constructor:
 * one click on itself, plus `fullscreenchange` and the webkit-prefixed twin on
 * the DOCUMENT. It had no way to detach any of them. The document outlives every
 * Stage, so those two closures kept the instance and its button alive for the
 * page's lifetime; nothing in the app could reach them. Worse, they were
 * attached even where the element Fullscreen API does not exist and the control
 * is hidden, so an iPhone paid for listeners for a button it never shows.
 *
 * A refused request was also silent. `requestFullscreen` rejects under a
 * permissions policy or an unsandboxed iframe, and the catch swallowed it, so
 * pressing the button looked identical to a dead control. The refusal now
 * reaches a polite live region and the tooltip, while an unsupported platform
 * stays silent because there is no user request there to report on.
 *
 * A recording stub rather than jsdom: the claim is about which registrations
 * exist and which are taken back, by handler identity: countable on a stub,
 * invisible in a real DOM.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { FullscreenToggle, fullscreenSupported } from '../src/ui/FullscreenToggle';

interface Registration {
  type: string;
  handler: unknown;
}

interface NodeStub {
  readonly added: Registration[];
  readonly removed: Registration[];
  readonly attrs: Record<string, string>;
  readonly classes: Set<string>;
  className: string;
  textContent: string;
  innerHTML: string;
  title: string;
  hidden: boolean;
  type: string;
  readonly dataset: Record<string, string>;
  readonly classList: { toggle(name: string, on?: boolean): void };
  setAttribute(name: string, value: string): void;
  append(...nodes: unknown[]): void;
  addEventListener(type: string, handler: unknown): void;
  removeEventListener(type: string, handler: unknown): void;
  blur(): void;
}

function makeNode(): NodeStub {
  const classes = new Set<string>();
  const node: NodeStub = {
    added: [],
    removed: [],
    attrs: {},
    classes,
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    hidden: false,
    type: '',
    dataset: {},
    classList: {
      toggle: (n, on) => void (on ?? !classes.has(n) ? classes.add(n) : classes.delete(n)),
    },
    setAttribute: (name, value) => void (node.attrs[name] = value),
    append: () => {},
    addEventListener: (type, handler) => void node.added.push({ type, handler }),
    removeEventListener: (type, handler) => void node.removed.push({ type, handler }),
    blur: () => {},
  };
  return node;
}

interface DocStub {
  added: Registration[];
  removed: Registration[];
  fullscreenElement: unknown;
  documentElement: { requestFullscreen?: () => Promise<void> };
  fullscreenEnabled?: boolean;
  exitFullscreen?: () => Promise<void>;
  createElement(): NodeStub;
  addEventListener(type: string, handler: unknown): void;
  removeEventListener(type: string, handler: unknown): void;
}

/**
 * `request` decides the platform: a function means the element Fullscreen API
 * exists (the control renders and wires up), `null` means it does not (the
 * control hides and must wire nothing).
 */
function makeDoc(request: (() => Promise<void>) | null): DocStub {
  const doc: DocStub = {
    added: [],
    removed: [],
    fullscreenElement: null,
    documentElement: request ? { requestFullscreen: request } : {},
    fullscreenEnabled: request ? true : undefined,
    exitFullscreen: () => Promise.resolve(),
    createElement: () => makeNode(),
    addEventListener: (type, handler) => void doc.added.push({ type, handler }),
    removeEventListener: (type, handler) => void doc.removed.push({ type, handler }),
  };
  return doc;
}

/** Let the request promise settle so its rejection handler has run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'];

describe('FullscreenToggle teardown', () => {
  const savedDocument = globalThis.document;
  let doc: DocStub;
  const live: FullscreenToggle[] = [];

  const install = (request: (() => Promise<void>) | null): FullscreenToggle => {
    doc = makeDoc(request);
    globalThis.document = doc as unknown as Document;
    const toggle = new FullscreenToggle();
    live.push(toggle);
    return toggle;
  };

  beforeEach(() => {
    doc = makeDoc(() => Promise.resolve());
    globalThis.document = doc as unknown as Document;
  });

  afterEach(() => {
    // Disposing here also clears the message timer, so a refusal case does not
    // leave a 6-second handle behind.
    while (live.length) live.pop()?.dispose();
    globalThis.document = savedDocument;
  });

  it('reads the stub platform the way the app reads a browser', () => {
    install(() => Promise.resolve());
    expect(fullscreenSupported(doc as unknown as Document)).toBe(true);
    const bare = makeDoc(null);
    expect(fullscreenSupported(bare as unknown as Document)).toBe(false);
  });

  it('registers both the standard and the prefixed change event', () => {
    install(() => Promise.resolve());
    expect(doc.added.map((r) => r.type)).toEqual(CHANGE_EVENTS);
  });

  it('detaches every listener it added, by identity', () => {
    const toggle = install(() => Promise.resolve());
    const button = toggle.element as unknown as NodeStub;
    expect(button.added.map((r) => r.type)).toEqual(['click']);

    toggle.dispose();
    // Same handler references, not merely the same event names: a bound
    // handler stored per instance is the only thing removeEventListener can
    // match, which is exactly what the anonymous closures could not offer.
    expect(doc.removed).toEqual(doc.added);
    expect(button.removed).toEqual(button.added);
  });

  it('registers nothing at all where the API is unsupported', () => {
    const toggle = install(null);
    expect((toggle.element as unknown as NodeStub).hidden).toBe(true);
    expect(doc.added).toEqual([]);
    expect((toggle.element as unknown as NodeStub).added).toEqual([]);
  });

  it('leaves an unsupported instance disposable without throwing', () => {
    const toggle = install(null);
    expect(() => toggle.dispose()).not.toThrow();
    expect(doc.removed).toEqual([]);
  });

  it('is safe to dispose twice on a supported platform', () => {
    const toggle = install(() => Promise.resolve());
    toggle.dispose();
    expect(() => toggle.dispose()).not.toThrow();
    expect(doc.removed).toHaveLength(CHANGE_EVENTS.length * 2);
  });
});

describe('FullscreenToggle refusal status', () => {
  const savedDocument = globalThis.document;
  const live: FullscreenToggle[] = [];

  const install = (
    request: (() => Promise<void>) | null,
    options: { announce?: (message: string) => void } = {},
  ): { toggle: FullscreenToggle; doc: DocStub } => {
    const doc = makeDoc(request);
    globalThis.document = doc as unknown as Document;
    const toggle = new FullscreenToggle(options);
    live.push(toggle);
    return { toggle, doc };
  };

  /** Press the button the way a user does, through the registered handler. */
  const press = (toggle: FullscreenToggle): void => {
    const button = toggle.element as unknown as NodeStub;
    const click = button.added.find((r) => r.type === 'click');
    expect(click).toBeDefined();
    (click?.handler as () => void)();
  };

  afterEach(() => {
    while (live.length) live.pop()?.dispose();
    globalThis.document = savedDocument;
  });

  it('does not create a second live region', () => {
    // This assertion is inverted from what it first said, and the reason is
    // worth keeping. Giving this node role="status" added a SECOND polite live
    // region to a page that mounts exactly one, which broke
    // tests/e2e/a11yAnnouncements.spec.ts and, more to the point, gives a
    // screen reader two competing polite queues. The node carries the refusal
    // text for a sighted user; the announcement travels through the host's
    // single region instead.
    const { toggle } = install(() => Promise.resolve());
    const status = toggle.status as unknown as NodeStub;
    expect(status.attrs.role).toBeUndefined();
    expect(status.attrs['aria-live']).toBeUndefined();
    // Kept out of the button because anything inside it joins the accessible
    // name, and the name has to keep saying what the button does.
    expect(status).not.toBe(toggle.element);
  });

  it('routes a refusal to the host live region when one is supplied', async () => {
    const announced: string[] = [];
    const { toggle } = install(() => Promise.reject(new Error('blocked')), {
      announce: (m: string) => announced.push(m),
    });
    press(toggle);
    await Promise.resolve();
    await Promise.resolve();
    expect(announced.length).toBe(1);
    expect(announced[0]).toBe((toggle.status as unknown as NodeStub).textContent);
  });

  it('says nothing until something is refused', async () => {
    const { toggle } = install(() => Promise.resolve());
    press(toggle);
    await settle();
    expect((toggle.status as unknown as NodeStub).textContent).toBe('');
  });

  it('surfaces a refused request in the live region and the tooltip', async () => {
    const { toggle } = install(() => Promise.reject(new Error('permissions policy')));
    press(toggle);
    await settle();
    const status = toggle.status as unknown as NodeStub;
    expect(status.textContent).toMatch(/refused/i);
    expect((toggle.element as unknown as NodeStub).title).toBe(status.textContent);
  });

  it('keeps a refusal non-fatal, so the button stays usable', async () => {
    let calls = 0;
    const { toggle } = install(() => {
      calls += 1;
      return Promise.reject(new Error('permissions policy'));
    });
    press(toggle);
    await settle();
    press(toggle);
    await settle();
    expect(calls).toBe(2);
  });

  it('emits nothing on a platform where the API is unsupported', async () => {
    const { toggle } = install(null);
    const status = toggle.status as unknown as NodeStub;
    expect(status.hidden).toBe(true);
    // No click listener exists, so no user path can reach the request. Calling
    // the announcement directly proves the guard rather than the wiring: even
    // if a future caller reached it, an unsupported platform stays silent.
    (toggle as unknown as { _announce(m: string): void })._announce('should not appear');
    await settle();
    expect(status.textContent).toBe('');
  });
});

describe('Stage full-screen comment', () => {
  const source = readFileSync(new URL('../src/ui/Stage.ts', import.meta.url), 'utf8');

  it('no longer claims the control tracks F11', () => {
    // The old comment said the toggle "tracks F11/Esc too". F11 is the
    // browser's own window fullscreen: it fires no `fullscreenchange` and
    // leaves `document.fullscreenElement` null, so no code here can see it.
    // FullscreenToggle.ts already carried the correction; Stage.ts contradicted
    // it, which is how the wrong claim survived a read of either file alone.
    expect(source).not.toMatch(/tracks F11/);
  });

  it('describes what the control actually follows', () => {
    expect(source).toMatch(/fullscreenchange/);
    expect(source).toMatch(/does not see F11/);
  });
});
