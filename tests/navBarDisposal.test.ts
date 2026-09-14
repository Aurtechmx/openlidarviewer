/**
 * navBarDisposal.test.ts
 *
 * The nav HUD yields while the pointer drags anywhere on the page, so it
 * listens on `window` — outside its own element tree. Those listeners outlive
 * the panel unless it removes them, and an anonymous handler cannot be dom.windowEvents.removed
 * at all, so a rebuilt shell would leave a live set behind on every
 * construction. dispose() is the removal path.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { installNavBarDom } from './helpers/navBarDom';

const WINDOW_EVENTS = ['pointerdown', 'pointerup', 'pointercancel'];
let dom: ReturnType<typeof installNavBarDom>;

beforeAll(() => { dom = installNavBarDom({ window: true }); });
beforeEach(() => {
  dom.windowEvents.added.length = 0;
  dom.windowEvents.removed.length = 0;
  dom.store.clear();
});

/** A NavBar with inert callbacks; only its listener lifecycle is under test. */
async function navbar() {
  const { NavBar } = await import('../src/ui/NavBar');
  const noop = (): void => { /* inert */ };
  return new NavBar({
    onMode: noop, onSpeed: noop, onCameraPreset: noop, onStandardView: noop, onOrthographic: noop,
  } as unknown as ConstructorParameters<typeof NavBar>[0]);
}

const windowOnly = (types: readonly string[]): string[] => types.filter((t) => WINDOW_EVENTS.includes(t));

describe('NavBar releases what it registers outside its own DOM', () => {
  it('registers on window and removes every one on dispose', async () => {
    const bar = await navbar();
    for (const t of WINDOW_EVENTS) expect(dom.windowEvents.added, `${t} was never registered`).toContain(t);
    bar.dispose();
    for (const t of WINDOW_EVENTS) expect(dom.windowEvents.removed, `${t} was not dom.windowEvents.removed`).toContain(t);
    expect(dom.windowEvents.removed.length).toBe(windowOnly(dom.windowEvents.added).length);
  });

  it('a second dispose is a no-op, so teardown is idempotent', async () => {
    const bar = await navbar();
    bar.dispose();
    const after = dom.windowEvents.removed.length;
    bar.dispose();
    expect(dom.windowEvents.removed.length).toBe(after);
  });

  it('two panels built and disposed leave nothing registered', async () => {
    const a = await navbar();
    const b = await navbar();
    a.dispose();
    b.dispose();
    expect(dom.windowEvents.removed.length).toBe(windowOnly(dom.windowEvents.added).length);
  });
});
