/**
 * viewCubeDom.test.ts — the compass rose's DOM writes (spec 6A).
 *
 * A minimal recording DOM: the rose's transform must follow the UNWRAPPED
 * heading (no long-way spin across north), skip writes when the rounded angle
 * is unchanged, hold through a NaN (near-vertical) heading, and drop the CSS
 * transition under prefers-reduced-motion.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { StandardView } from '../src/render/viewCubeMath';

class FakeStyle {
  cssText = '';
  writes = 0;
  private _transform = '';
  width = '';
  padding = '';
  borderRadius = '';
  color = '';
  get transform(): string { return this._transform; }
  set transform(v: string) { this._transform = v; this.writes++; }
}

class FakeEl {
  className = '';
  type = '';
  title = '';
  textContent = '';
  readonly style = new FakeStyle();
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private readonly listeners: Record<string, ((e: { stopPropagation(): void }) => void)[]> = {};
  removed = false;
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  appendChild(c: FakeEl): FakeEl { this.children.push(c); return c; }
  addEventListener(t: string, fn: (e: { stopPropagation(): void }) => void): void { (this.listeners[t] ??= []).push(fn); }
  click(): void { for (const fn of this.listeners.click ?? []) fn({ stopPropagation: () => {} }); }
  remove(): void { this.removed = true; }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}

const g = globalThis as unknown as Record<string, unknown>;
function installDom(reduced: boolean): void {
  g.document = { createElement: () => new FakeEl() };
  g.matchMedia = (q: string) => ({ matches: reduced && q.includes('reduce') });
}
afterEach(() => { delete g.document; delete g.matchMedia; });

async function mount(reduced = false) {
  installDom(reduced);
  const { mountViewCube } = await import('../src/ui/viewCube');
  const host = new FakeEl();
  let heading = 0;
  const views: StandardView[] = [];
  const handle = mountViewCube({
    host: host as unknown as HTMLElement,
    getHeading: () => heading,
    onView: (v) => views.push(v),
  });
  const rose = host.all().find((e) => e.className === 'olv-viewcube-rose')!;
  return { handle, rose, views, host, setHeading: (h: number) => { heading = h; } };
}

describe('viewCube rose rotation', () => {
  it('crosses north the short way (359 -> 1 is +2 degrees of heading)', async () => {
    const { handle, rose, setHeading } = await mount();
    setHeading(359); handle.update();
    expect(rose.style.transform).toBe('rotate(1deg)'); // 0 -> 359 is -1 the short way
    setHeading(1); handle.update();
    expect(rose.style.transform).toBe('rotate(-1deg)');
    setHeading(359); handle.update();
    expect(rose.style.transform).toBe('rotate(1deg)');
  });

  it('skips DOM writes while the rounded angle is unchanged', async () => {
    const { handle, rose, setHeading } = await mount();
    const before = rose.style.writes;
    handle.update(); handle.update();
    setHeading(0.01); handle.update();
    expect(rose.style.writes).toBe(before);
    setHeading(10); handle.update();
    expect(rose.style.writes).toBe(before + 1);
  });

  it('holds the last angle when the heading is NaN (camera near vertical)', async () => {
    const { handle, rose, setHeading } = await mount();
    setHeading(90); handle.update();
    const writes = rose.style.writes;
    setHeading(Number.NaN); handle.update();
    expect(rose.style.transform).toBe('rotate(-90deg)');
    expect(rose.style.writes).toBe(writes);
  });

  it('has a transition normally and none under prefers-reduced-motion', async () => {
    expect((await mount(false)).rose.style.cssText).toContain('transition');
    expect((await mount(true)).rose.style.cssText).not.toContain('transition');
  });

  it('a face click goes to onView', async () => {
    const { host, views } = await mount();
    host.all().find((e) => e.attrs['data-testid'] === 'viewcube-back')!.click();
    expect(views).toEqual(['back']);
  });
});
