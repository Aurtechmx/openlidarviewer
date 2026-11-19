/**
 * navBarFrameAllBare.test.ts — Frame all in the nav row in the bare layouts.
 *
 * Embed (`?embed=1`) and `?ui=minimal` build no workspace shell, so the dock
 * and its Frame all button are never mounted, and the ViewCube has no Home
 * control. The nav row is the one visible surface left there, so it carries
 * Frame all in those layouts. Every other layout shows Frame all once, on the
 * dock, and the nav row has none.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FakeEl as BaseEl, installNavBarDom } from './helpers/navBarDom';

type Listener = () => void;

/** The shared NavBar stub element, with click listeners and a lookup by button name. */
class FakeEl extends BaseEl {
  private readonly listeners: Listener[] = [];
  override addEventListener(type?: string, fn?: Listener): void { if (type === 'click' && fn) this.listeners.push(fn); }
  override click(): void { for (const fn of [...this.listeners]) fn(); }
  /** Every descendant (and self) that is a button named `name`. */
  buttonsNamed(name: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.tagName === 'button' && this.attrs['aria-label'] === name) out.push(this);
    for (const c of this.children) if (c instanceof FakeEl) out.push(...c.buttonsNamed(name));
    return out;
  }
}

beforeAll(() => {
  installNavBarDom();
  (globalThis as unknown as { document: unknown }).document = { createElement: (tag: string) => new FakeEl(tag) };
});

/** A NavBar wired as main.ts wires it, over a viewer whose Frame all is a spy. */
async function navbar(options?: { readonly frameAllButton?: boolean }) {
  const { NavBar } = await import('../src/ui/NavBar');
  const { createNavBarWiring } = await import('../src/ui/navBarWiring');
  const frameAll = vi.fn();
  const viewer = { frameAll } as unknown as import('../src/render/Viewer').Viewer;
  let bar: InstanceType<typeof NavBar> | null = null;
  const wiring = createNavBarWiring({ getViewer: () => viewer, getNavBar: () => bar, toast: () => {} });
  bar = new NavBar(wiring.callbacks, options);
  const row = (bar.element as unknown as FakeEl).byClass('olv-nav-row')[0] as FakeEl;
  return { row, frameAll };
}

describe('Frame all in the nav row', () => {
  it('in a bare layout the nav row has a Frame all control that frames the scan', async () => {
    const { row, frameAll } = await navbar({ frameAllButton: true });
    const buttons = row.buttonsNamed('Frame all');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].attrs['aria-keyshortcuts']).toBe('R');
    expect(buttons[0].title).toMatch(/\(R\)/);
    buttons[0].click();
    expect(frameAll).toHaveBeenCalledTimes(1);
  });

  it('in every other layout the nav row has no Frame all control', async () => {
    const { row } = await navbar();
    expect(row.buttonsNamed('Frame all')).toHaveLength(0);
    const off = await navbar({ frameAllButton: false });
    expect(off.row.buttonsNamed('Frame all')).toHaveLength(0);
  });

  it('main.ts asks for it in the bare layouts only', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toContain('const bareMode = embed || embedConfig.uiMinimal;');
    expect(main).toContain('new NavBar(navWiring.callbacks, { frameAllButton: bareMode })');
  });
});
