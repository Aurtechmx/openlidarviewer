/**
 * dialogStackCoverage.test.ts
 *
 * Every modal surface sits on the one dialog stack in Modal.ts, so only the
 * topmost answers Escape and Tab, and `dialogOpen()` sees each of them. This
 * covers the report verifier card, the onboarding tour card, a dialog removed
 * from the document without its teardown, and the Help overlay's refusal to
 * open over another dialog.
 *
 * Node environment with a small recording DOM: a node knows its parent,
 * whether it hangs under the body, and which node holds focus. `press`
 * dispatches a key in the order a browser uses for window listeners: window
 * capture, then document, then window bubble, stopping where a handler stops
 * propagation.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

type Handler = (e: unknown) => void;
interface Listener { readonly fn: Handler; readonly capture: boolean }

class FakeEl {
  readonly tagName: string;
  parent: FakeEl | null = null;
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  id = '';
  type = '';
  title = '';
  disabled = false;
  private _text = '';
  private readonly _attrs = new Map<string, string>();
  private readonly _classes = new Set<string>();
  private readonly _handlers = new Map<string, Handler[]>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  set className(v: string) {
    this._classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this._classes.add(c);
  }
  get className(): string {
    return [...this._classes].join(' ');
  }
  get classList() {
    const classes = this._classes;
    return {
      add: (...c: string[]): void => { for (const x of c) classes.add(x); },
      remove: (...c: string[]): void => { for (const x of c) classes.delete(x); },
      contains: (c: string): boolean => classes.has(c),
      toggle: (c: string, force?: boolean): boolean => {
        const on = force ?? !classes.has(c);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
    };
  }
  set textContent(v: string) {
    this._text = v;
    this.children.length = 0;
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].join('');
  }
  get isConnected(): boolean {
    for (let n: FakeEl | null = this; n; n = n.parent) if (n === BODY) return true;
    return false;
  }
  /** Laid out whenever it is connected; the trap drops unlaid nodes. */
  get offsetParent(): FakeEl | null {
    return this.isConnected ? BODY : null;
  }
  setAttribute(k: string, v: string): void { this._attrs.set(k, v); }
  getAttribute(k: string): string | null { return this._attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this._attrs.delete(k); }
  append(...kids: (FakeEl | string)[]): void {
    for (const k of kids) {
      const node = typeof k === 'string' ? textNode(k) : k;
      node.parent?.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...kids: FakeEl[]): void {
    for (const c of this.children) c.parent = null;
    this.children.length = 0;
    this.append(...kids);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  contains(n: unknown): boolean {
    if (n === this) return true;
    return this.children.some((c) => c.contains(n));
  }
  focus(): void {
    if (!this.disabled) STATE.active = this;
  }
  blur(): void {
    if (STATE.active === this) STATE.active = null;
  }
  addEventListener(type: string, fn: Handler): void {
    this._handlers.set(type, [...(this._handlers.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Handler): void {
    this._handlers.set(type, (this._handlers.get(type) ?? []).filter((f) => f !== fn));
  }
  click(): void {
    for (const fn of this._handlers.get('click') ?? []) fn({ target: this, stopPropagation() {} });
  }
  /** The modal FOCUSABLE selector, approximated by the enabled buttons. */
  querySelectorAll(_selector: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      for (const c of n.children) {
        if (c.tagName === 'BUTTON' && !c.disabled) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
}

function textNode(text: string): FakeEl {
  const t = new FakeEl('#text');
  t.textContent = text;
  return t;
}

const STATE: { active: FakeEl | null } = { active: null };
let BODY: FakeEl;
const WINDOW_KEYS: Listener[] = [];
const DOC_KEYS: Handler[] = [];

beforeAll(() => {
  BODY = new FakeEl('body');
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLElement = FakeEl;
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.document = {
    // The tooltip layer installs itself on import when it finds a document
    // with listeners; this stub has no pointer events to give it.
    __olvTipLayerInstalled: true,
    body: BODY,
    get activeElement() { return STATE.active ?? BODY; },
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => textNode(text),
    contains: (n: unknown) => BODY.contains(n),
    querySelector: () => null,
    addEventListener: (type: string, fn: Handler) => { if (type === 'keydown') DOC_KEYS.push(fn); },
    removeEventListener: (type: string, fn: Handler) => {
      if (type === 'keydown' && DOC_KEYS.includes(fn)) DOC_KEYS.splice(DOC_KEYS.indexOf(fn), 1);
    },
  };
  g.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (type: string, fn: Handler, capture?: boolean) => {
      if (type === 'keydown') WINDOW_KEYS.push({ fn, capture: capture === true });
    },
    removeEventListener: (type: string, fn: Handler, capture?: boolean) => {
      if (type !== 'keydown') return;
      const i = WINDOW_KEYS.findIndex((l) => l.fn === fn && l.capture === (capture === true));
      if (i >= 0) WINDOW_KEYS.splice(i, 1);
    },
  };
});

beforeEach(() => {
  // A fresh Modal module per case, so the dialog stack starts empty.
  vi.resetModules();
});

afterEach(() => {
  BODY.children.length = 0;
  WINDOW_KEYS.length = 0;
  DOC_KEYS.length = 0;
  STATE.active = null;
});

/** Press a key at the focused node; returns whether a handler prevented the default. */
function press(key: string, shiftKey = false, metaKey = false): boolean {
  let prevented = false;
  let stopped = false;
  const e = {
    key,
    shiftKey,
    metaKey,
    ctrlKey: false,
    altKey: false,
    target: STATE.active ?? BODY,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  };
  const phase = (fns: Handler[]): void => {
    for (const fn of fns) {
      if (stopped) return;
      fn(e);
    }
  };
  phase(WINDOW_KEYS.filter((l) => l.capture).map((l) => l.fn));
  phase([...DOC_KEYS]);
  phase(WINDOW_KEYS.filter((l) => !l.capture).map((l) => l.fn));
  return prevented;
}

/** A mounted card holding `n` buttons, the shape every hand-rolled dialog has. */
function card(n: number): { dialog: FakeEl; buttons: FakeEl[] } {
  const dialog = new FakeEl('div');
  const buttons = Array.from({ length: n }, () => new FakeEl('button'));
  dialog.append(...buttons);
  BODY.append(dialog);
  return { dialog, buttons };
}

const html = (n: FakeEl): HTMLElement => n as unknown as HTMLElement;

describe('the report verifier card', () => {
  const intact = { recognised: true, valid: true, cryptographic: true, reason: 'Digest matches.', algorithm: 'SHA-256' };

  it('keeps the command palette from opening over it', async () => {
    const { showReportVerification } = await import('../src/ui/reportVerifier');
    const { CommandPalette } = await import('../src/ui/CommandPalette');
    showReportVerification(intact as never);
    const palette = { _open: false, open: vi.fn(), close: vi.fn() };
    CommandPalette.prototype.toggle.call(palette as never);
    expect(palette.open).not.toHaveBeenCalled();
  });

  it('leaves Tab to a dialog opened over it, so the two traps never both move focus', async () => {
    const { showReportVerification } = await import('../src/ui/reportVerifier');
    const { wireDialogA11y } = await import('../src/ui/Modal');
    showReportVerification(intact as never);
    const upper = card(2);
    const handle = wireDialogA11y(html(upper.dialog), { onEscape: () => { handle.teardown(); upper.dialog.remove(); } });
    upper.buttons[1].focus();
    expect(press('Tab')).toBe(true);
    expect(STATE.active).toBe(upper.buttons[0]);
    // One Escape closes the upper dialog alone; the verifier stays up.
    press('Escape');
    expect(upper.dialog.isConnected).toBe(false);
    expect(BODY.children.some((c) => c.className === 'olv-verify-backdrop')).toBe(true);
  });
});

describe('the onboarding tour card', () => {
  async function runningTour() {
    const { TourOverlay } = await import('../src/ui/onboarding/TourOverlay');
    const { TourSession } = await import('../src/ui/onboarding/tourSteps');
    const seen = { value: false };
    const session = new TourSession(undefined, {
      hasSeen: () => seen.value,
      setSeen: () => { seen.value = true; },
      clear: () => { seen.value = false; },
    });
    const overlay = new TourOverlay(session);
    overlay.mount();
    return { session, overlay, seen };
  }

  it('is on the stack while a step shows, and off it once the tour ends', async () => {
    const { dialogOpen } = await import('../src/ui/Modal');
    const { session, overlay } = await runningTour();
    expect(dialogOpen()).toBe(false);
    session.start();
    expect(dialogOpen()).toBe(true);
    session.dismiss();
    expect(dialogOpen()).toBe(false);
    overlay.unmount();
  });

  it('brings a forward Tab from outside the card back to its first control', async () => {
    const { session, overlay } = await runningTour();
    session.start();
    const outside = new FakeEl('button');
    BODY.append(outside);
    outside.focus();
    expect(press('Tab')).toBe(true);
    // Back is disabled on the first step, so Next is the first control.
    expect(STATE.active?.textContent).toBe('Next');
    overlay.unmount();
  });

  it('skips on Escape, persisting the seen flag, and hands focus back', async () => {
    const { session, overlay, seen } = await runningTour();
    const trigger = new FakeEl('button');
    BODY.append(trigger);
    trigger.focus();
    session.start();
    expect(STATE.active?.textContent).toBe('Next');
    press('Escape');
    expect(session.state).toBe('skipped');
    expect(seen.value).toBe(true);
    expect(STATE.active).toBe(trigger);
    overlay.unmount();
  });
});

describe('the tour and the shortcuts its last step names', () => {
  it.each([['Cmd-K', 'k', true], ['?', '?', false]] as const)('%s ends the tour, so the palette or sheet can open', async (_name, key, meta) => {
    const { TourOverlay } = await import('../src/ui/onboarding/TourOverlay');
    const { TourSession } = await import('../src/ui/onboarding/tourSteps');
    const { dialogOpen } = await import('../src/ui/Modal');
    const session = new TourSession(undefined, { hasSeen: () => false, setSeen: () => {}, clear: () => {} });
    const overlay = new TourOverlay(session);
    overlay.mount();
    session.start();
    while (session.snapshot().index < session.snapshot().total - 1) session.next();
    let openedOverTour: boolean | null = null;
    // The shortcut dispatcher listens on window in the bubble phase, after the tour.
    (globalThis as unknown as { window: { addEventListener: (t: string, f: Handler) => void } }).window
      .addEventListener('keydown', () => { openedOverTour = dialogOpen(); });
    press(key, false, meta);
    expect(session.state).toBe('skipped');
    expect(openedOverTour).toBe(false);
    overlay.unmount();
  });
});

describe('a dialog removed without its teardown', () => {
  it('drops off the stack instead of blocking the palette, Tab and Escape', async () => {
    const { wireDialogA11y, dialogOpen } = await import('../src/ui/Modal');
    const lower = card(2);
    const lowerEscape = vi.fn();
    wireDialogA11y(html(lower.dialog), { onEscape: lowerEscape });
    const orphan = card(1);
    wireDialogA11y(html(orphan.dialog), { onEscape: () => {} });
    orphan.dialog.remove(); // gone from the page, never torn down
    // The dialog underneath is the top again: Tab and Escape reach it.
    lower.buttons[1].focus();
    expect(press('Tab')).toBe(true);
    expect(STATE.active).toBe(lower.buttons[0]);
    press('Escape');
    expect(lowerEscape).toHaveBeenCalledTimes(1);
    lower.dialog.remove();
    expect(dialogOpen()).toBe(false);
    expect(WINDOW_KEYS).toEqual([]);
  });

  it('no longer counts as open, so Cmd-K reaches the palette', async () => {
    const { wireDialogA11y, dialogOpen } = await import('../src/ui/Modal');
    const { CommandPalette } = await import('../src/ui/CommandPalette');
    const orphan = card(1);
    wireDialogA11y(html(orphan.dialog), { onEscape: () => {} });
    expect(dialogOpen()).toBe(true);
    orphan.dialog.remove();
    expect(dialogOpen()).toBe(false);
    const palette = { _open: false, open: vi.fn(), close: vi.fn() };
    CommandPalette.prototype.toggle.call(palette as never);
    expect(palette.open).toHaveBeenCalledTimes(1);
  });
});

describe('the Help overlay', () => {
  it('does not open over another open dialog, and still closes when open', async () => {
    const { wireDialogA11y } = await import('../src/ui/Modal');
    const { HelpOverlay } = await import('../src/ui/HelpOverlay');
    const other = card(1);
    const handle = wireDialogA11y(html(other.dialog), { onEscape: () => {} });
    const closed = { _open: false, open: vi.fn(), close: vi.fn() };
    HelpOverlay.prototype.toggle.call(closed as never);
    expect(closed.open).not.toHaveBeenCalled();
    const open = { _open: true, open: vi.fn(), close: vi.fn() };
    HelpOverlay.prototype.toggle.call(open as never);
    expect(open.close).toHaveBeenCalledTimes(1);
    handle.teardown();
    HelpOverlay.prototype.toggle.call(closed as never);
    expect(closed.open).toHaveBeenCalledTimes(1);
  });
});
