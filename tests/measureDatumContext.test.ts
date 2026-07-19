/**
 * measureDatumContext.test.ts
 *
 * `setContext` decides whether the profile surfaces print source elevations or
 * refuse and name their heights local. That is a PRESENTATION change to
 * already-placed measurements — exactly what `setUnitToMetres`,
 * `setVerticalUnitToMetres`, `setCrsKnown` and `setGeographicCrs` all emit for.
 * The panel repaints only on that emit, so a datum change that stays silent
 * reaches the screen only if some unrelated event happens to repaint first.
 *
 * Both directions matter and for different reasons. Refused → known is a stale
 * caveat: the model has a datum again while the panel still shows local
 * heights. Known → refused is the dangerous one: the panel keeps the previous
 * cloud's datum and the word "Elevation" over a scene that no longer has one —
 * the silent-wrong-elevation failure this whole gate exists to prevent.
 *
 * Runs in the node environment (the project keeps its unit tests DOM-free for
 * speed), so it drives the REAL MeasureController through a minimal recording
 * DOM stub — the same stub-the-slice approach the other panel tests use,
 * extended with the `createElementNS` surface the SVG overlay touches.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Vec3 } from '../src/render/navMath';

type Handler = (e: unknown) => void;

/** A recording DOM node covering only the surface the controller touches. */
class FakeEl {
  readonly tagName: string;
  private _classes = new Set<string>();
  textContent = '';
  title = '';
  value = '';
  innerHTML = '';
  tabIndex = 0;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  set className(v: string) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className(): string {
    return [...this._classes].join(' ');
  }
  get classList() {
    const classes = this._classes;
    return {
      add: (...c: string[]): void => void c.forEach((x) => classes.add(x)),
      remove: (...c: string[]): void => void c.forEach((x) => classes.delete(x)),
      contains: (c: string): boolean => classes.has(c),
      toggle: (c: string, force?: boolean): boolean => {
        const want = force === undefined ? !classes.has(c) : force;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    };
  }

  private _adopt(kid: unknown): FakeEl {
    if (kid instanceof FakeEl) {
      kid.parent = this;
      return kid;
    }
    const t = new FakeEl('#text');
    t.textContent = String(kid);
    t.parent = this;
    return t;
  }
  append(...kids: unknown[]): void {
    for (const k of kids) this.children.push(this._adopt(k));
  }
  replaceChildren(...kids: unknown[]): void {
    this.children.length = 0;
    for (const k of kids) this.children.push(this._adopt(k));
  }
  remove(): void {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }

  addEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    a.push(fn);
    this.handlers.set(type, a);
  }
  removeEventListener(): void {
    /* not exercised */
  }
  focus(): void {}
  blur(): void {}

  private _matches(sel: string): boolean {
    const parts = sel.split('.');
    const tag = parts[0];
    if (tag && this.tagName !== tag.toLowerCase()) return false;
    for (const c of parts.slice(1)) if (!this._classes.has(c)) return false;
    return true;
  }
  querySelector(sel: string): FakeEl | null {
    for (const c of this.children) {
      if (c._matches(sel)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl): void => {
      for (const c of n.children) {
        if (c._matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    // The measurement overlay is an <svg>, built through the namespaced call.
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  };
  // el() guards `props.type`/`props.href` with an `instanceof` check; the
  // globals must exist as constructors so the check returns false rather than
  // throwing on an undefined right-hand side.
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
});

const UP_Z: Vec3 = [0, 0, 1];
/** The user's streaming COPC: an octree-cube origin ~830 m up the Z axis. */
const ORIGIN_A: Vec3 = [514233, 2105887, 830];
/** A reference scan recentred somewhere else entirely. */
const ORIGIN_B: Vec3 = [514233, 2105887, 0];

/** The real controller behind a counting change listener. */
async function makeController(): Promise<{
  measure: { setContext: (c: { worldUp: Vec3; origin: Vec3 | null }) => void };
  emits: () => number;
}> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({
    onExit: () => {},
    getPickRay: () => null,
    getPointAt: () => null,
  } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  let count = 0;
  measure.setOnChange(() => {
    count++;
  });
  return { measure, emits: () => count };
}

describe('setContext announces a datum change', () => {
  it('emits when the scene loses its datum — the dangerous direction', async () => {
    // A second cloud with a conflicting origin arrives: the viewer resolves to
    // no datum and the panel must be told, or it keeps printing cloud A's
    // elevations for a scene that has none.
    const { measure, emits } = await makeController();
    measure.setContext({ worldUp: UP_Z, origin: ORIGIN_A });
    const before = emits();
    measure.setContext({ worldUp: UP_Z, origin: null });
    expect(emits()).toBe(before + 1);
  });

  it('emits when the datum comes back — a refusal must not outlive its cause', async () => {
    const { measure, emits } = await makeController();
    measure.setContext({ worldUp: UP_Z, origin: ORIGIN_A });
    measure.setContext({ worldUp: UP_Z, origin: null });
    const before = emits();
    measure.setContext({ worldUp: UP_Z, origin: ORIGIN_A });
    expect(emits()).toBe(before + 1);
  });

  it('emits when the datum moves from one origin to another', async () => {
    const { measure, emits } = await makeController();
    measure.setContext({ worldUp: UP_Z, origin: ORIGIN_A });
    const before = emits();
    measure.setContext({ worldUp: UP_Z, origin: ORIGIN_B });
    expect(emits()).toBe(before + 1);
  });

  it('emits when the up axis changes', async () => {
    const { measure, emits } = await makeController();
    measure.setContext({ worldUp: UP_Z, origin: ORIGIN_A });
    const before = emits();
    // Y-up reads a different component of the same origin, so the datum moves.
    measure.setContext({ worldUp: [0, 1, 0], origin: ORIGIN_A });
    expect(emits()).toBe(before + 1);
  });

  it('stays silent when nothing about the datum changed', async () => {
    // `_refreshMeasureDatum` runs on every change to the cloud set, including
    // ones that leave the frame alone — repainting the panel for those would be
    // churn, and the siblings all guard the same way.
    const { measure, emits } = await makeController();
    measure.setContext({ worldUp: UP_Z, origin: ORIGIN_A });
    const before = emits();
    measure.setContext({ worldUp: UP_Z, origin: [...ORIGIN_A] as Vec3 });
    measure.setContext({ worldUp: [...UP_Z] as Vec3, origin: [...ORIGIN_A] as Vec3 });
    expect(emits()).toBe(before);
  });

  it('stays silent on a repeated refusal', async () => {
    const { measure, emits } = await makeController();
    measure.setContext({ worldUp: UP_Z, origin: null });
    const before = emits();
    measure.setContext({ worldUp: UP_Z, origin: null });
    expect(emits()).toBe(before);
  });

  it('only the up-axis component of the origin decides the datum', async () => {
    // The datum is a height. A cloud that shifts east but keeps its elevation
    // frame has not changed what an elevation means, so nothing repaints.
    const { measure, emits } = await makeController();
    measure.setContext({ worldUp: UP_Z, origin: ORIGIN_A });
    const before = emits();
    measure.setContext({ worldUp: UP_Z, origin: [ORIGIN_A[0] + 500, ORIGIN_A[1], ORIGIN_A[2]] });
    expect(emits()).toBe(before);
  });
});
