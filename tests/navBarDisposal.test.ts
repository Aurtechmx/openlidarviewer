/**
 * navBarDisposal.test.ts
 *
 * The nav HUD yields while the pointer drags anywhere on the page, so it
 * listens on `window` — outside its own element tree. Those listeners outlive
 * the panel unless it removes them, and an anonymous handler cannot be removed
 * at all, so a rebuilt shell would leave a live set behind on every
 * construction. dispose() is the removal path.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

class FakeEl {
  private _className = '';
  classList = { add: (): void => {}, remove: (): void => {}, contains: (): boolean => false, toggle: (): boolean => false };
  title = '';
  type = '';
  disabled = false;
  textContent = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get className(): string { return this._className; }
  set className(v: string) { this._className = v; }
  setAttribute(): void {}
  removeAttribute(): void {}
  getAttribute(): string | null { return null; }
  append(...kids: (FakeEl | null)[]): void { for (const k of kids) if (k) this.children.push(k); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(): void {}
  removeEventListener(): void {}
  closest(): null { return null; }
  querySelector(): null { return null; }
  querySelectorAll(): FakeEl[] { return []; }
  focus(): void {}
  click(): void {}
  remove(): void {}
}

const WINDOW_EVENTS = ['pointerdown', 'pointerup', 'pointercancel'];
let added: string[] = [];
let removed: string[] = [];
const store = new Map<string, string>();

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLAnchorElement ??= class {};
  g.HTMLInputElement ??= class {};
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (t: string) => { added.push(t); },
    removeEventListener: (t: string) => { removed.push(t); },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  };
});

beforeEach(() => { added = []; removed = []; store.clear(); });

/** A NavBar with inert callbacks; only its listener lifecycle is under test. */
async function navbar() {
  const { NavBar } = await import('../src/ui/NavBar');
  const noop = (): void => { /* inert */ };
  return new NavBar({
    onMode: noop, onSpeed: noop, onCameraPreset: noop, onStandardView: noop, onOrthographic: noop,
  } as unknown as ConstructorParameters<typeof NavBar>[0]);
}

const windowOnly = (types: string[]): string[] => types.filter((t) => WINDOW_EVENTS.includes(t));

describe('NavBar releases what it registers outside its own DOM', () => {
  it('registers on window and removes every one on dispose', async () => {
    const bar = await navbar();
    for (const t of WINDOW_EVENTS) expect(added, `${t} was never registered`).toContain(t);
    bar.dispose();
    for (const t of WINDOW_EVENTS) expect(removed, `${t} was not removed`).toContain(t);
    expect(removed.length).toBe(windowOnly(added).length);
  });

  it('a second dispose is a no-op, so teardown is idempotent', async () => {
    const bar = await navbar();
    bar.dispose();
    const after = removed.length;
    bar.dispose();
    expect(removed.length).toBe(after);
  });

  it('two panels built and disposed leave nothing registered', async () => {
    const a = await navbar();
    const b = await navbar();
    a.dispose();
    b.dispose();
    expect(removed.length).toBe(windowOnly(added).length);
  });
});
