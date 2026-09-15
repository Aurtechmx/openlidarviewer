/**
 * reportVerifierFocusTrap.test.ts
 *
 * The "Verify integrity report" card claims `role="dialog"` + `aria-modal`, so
 * Tab must cycle inside it instead of walking into the page behind it. The trap
 * itself lives in Modal.ts (`trapTab` / `focusableIn`) and is shared, so the
 * modal primitive and the hand-rolled verifier card cannot drift apart.
 *
 * Runs in the node environment via a small recording DOM stub, the same style
 * the other panel tests use.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';

type Handler = (e: unknown) => void;

class FakeEl {
  id = '';
  type = '';
  className = '';
  textContent = '';
  tabIndex = 0;
  disabled = false;
  focused = 0;
  /** jsdom-free stand-in for "is laid out": every stub node is visible. */
  offsetParent: FakeEl | null = null;
  readonly children: FakeEl[] = [];
  readonly attrs: Record<string, string> = {};
  readonly style = { cssText: '' };
  readonly listeners = new Map<string, Handler[]>();
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.offsetParent = this;
  }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  remove(): void { /* detach is not observed here */ }
  focus(): void { this.focused += 1; doc.activeElement = this; }
  addEventListener(type: string, fn: Handler): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(): void { /* no-op */ }
  /** Only the modal FOCUSABLE selector is asked for; buttons are what we hold. */
  querySelectorAll(_sel: string): FakeEl[] {
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
  contains(n: unknown): boolean {
    if (n === this) return true;
    return this.children.some((c) => c.contains(n));
  }
}

const doc = {
  activeElement: null as FakeEl | null,
  body: new FakeEl('body'),
  createElement: (tag: string): FakeEl => new FakeEl(tag),
  listeners: new Map<string, Handler[]>(),
  addEventListener(type: string, fn: Handler): void {
    const list = doc.listeners.get(type) ?? [];
    list.push(fn);
    doc.listeners.set(type, list);
  },
  removeEventListener(type: string, fn: Handler): void {
    const list = doc.listeners.get(type) ?? [];
    doc.listeners.set(type, list.filter((f) => f !== fn));
  },
};

function keyEvent(key: string, shiftKey = false): { key: string; shiftKey: boolean; prevented: number; preventDefault(): void } {
  return {
    key,
    shiftKey,
    prevented: 0,
    preventDefault(): void { this.prevented += 1; },
  };
}

let trapTab: typeof import('../src/ui/Modal')['trapTab'];
let focusableIn: typeof import('../src/ui/Modal')['focusableIn'];
let showReportVerification: typeof import('../src/ui/reportVerifier')['showReportVerification'];

beforeAll(async () => {
  (globalThis as { document?: unknown }).document = doc;
  const modal = await import('../src/ui/Modal');
  trapTab = modal.trapTab;
  focusableIn = modal.focusableIn;
  ({ showReportVerification } = await import('../src/ui/reportVerifier'));
});

afterEach(() => {
  doc.activeElement = null;
  doc.listeners.clear();
  doc.body.children.length = 0;
});

function dialogOfThree(): { dialog: FakeEl; buttons: FakeEl[] } {
  const dialog = new FakeEl('div');
  const buttons = ['a', 'b', 'c'].map((id) => {
    const b = new FakeEl('button');
    b.id = id;
    return b;
  });
  dialog.append(...buttons);
  return { dialog, buttons };
}

describe('trapTab', () => {
  it('wraps Tab from the last focusable back to the first', () => {
    const { dialog, buttons } = dialogOfThree();
    expect(focusableIn(dialog as unknown as HTMLElement).length).toBe(3);
    doc.activeElement = buttons[2];
    const e = keyEvent('Tab');
    trapTab(dialog as unknown as HTMLElement, e as unknown as KeyboardEvent);
    expect(e.prevented).toBe(1);
    expect(buttons[0].focused).toBe(1);
    expect(doc.activeElement).toBe(buttons[0]);
  });

  it('wraps Shift+Tab from the first focusable to the last', () => {
    const { dialog, buttons } = dialogOfThree();
    doc.activeElement = buttons[0];
    const e = keyEvent('Tab', true);
    trapTab(dialog as unknown as HTMLElement, e as unknown as KeyboardEvent);
    expect(e.prevented).toBe(1);
    expect(buttons[2].focused).toBe(1);
  });

  it('leaves an interior Tab alone, and ignores other keys', () => {
    const { dialog, buttons } = dialogOfThree();
    doc.activeElement = buttons[0];
    const tab = keyEvent('Tab');
    trapTab(dialog as unknown as HTMLElement, tab as unknown as KeyboardEvent);
    expect(tab.prevented).toBe(0);
    const other = keyEvent('a');
    trapTab(dialog as unknown as HTMLElement, other as unknown as KeyboardEvent);
    expect(other.prevented).toBe(0);
  });
});

describe('showReportVerification', () => {
  const result = {
    valid: true,
    recognised: true,
    cryptographic: true,
    reason: 'Digest matches the recorded value.',
    algorithm: 'SHA-256',
  };

  it('focuses the dialog on open and keeps Tab inside it', () => {
    showReportVerification(result as never);
    const backdrop = doc.body.children.at(-1)!;
    const card = backdrop.children[0];
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    // Focus landed inside the card, so the trap has somewhere to cycle from.
    expect(card.contains(doc.activeElement)).toBe(true);

    const onKey = doc.listeners.get('keydown')![0];
    const e = keyEvent('Tab');
    onKey(e);
    // Tab did not escape: it was swallowed and focus stayed in the dialog.
    expect(e.prevented).toBe(1);
    expect(card.contains(doc.activeElement)).toBe(true);
  });
});
