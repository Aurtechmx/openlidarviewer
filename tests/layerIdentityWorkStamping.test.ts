/**
 * tests/layerIdentityWorkStamping.test.ts
 *
 * The creation-path half of the wiring: a new measurement or annotation records
 * WHICH layer it belongs to, by stable id, in that layer's source-local frame —
 * and records NOTHING while a single layer is open, so the session it serialises
 * into keeps its exact pre-identity byte shape.
 *
 * These drive the REAL controllers (through the same DOM stub the other
 * controller tests use — the project keeps its unit tests DOM-free for speed),
 * because the guarantee is about the object the controller actually pushes onto
 * its store, not about a pure helper in isolation. The owner VALUE and its
 * gating are proven exhaustively in `layerIdentityService.test.ts`; here the
 * provider is a plain stub, so what is under test is that the controllers
 * consult it at creation and that an unowned result leaves the record untouched.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { serializeSession, parseSession } from '../src/io/session';
import { sourceLocalOwnership, type WorkOwnership } from '../src/model/workOwnership';
import type { VolumeRecord, Vec3 } from '../src/render/measure/types';

type Handler = (e: unknown) => void;

/** A recording DOM node covering only the surface the two controllers touch. */
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
  appendChild(kid: unknown): unknown {
    this.children.push(this._adopt(kid));
    return kid;
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
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  };
  g.HTMLInputElement = class HTMLInputElement {};
  g.HTMLAnchorElement = class HTMLAnchorElement {};
  g.HTMLTextAreaElement = class HTMLTextAreaElement {};
});

const OWNER: WorkOwnership = sourceLocalOwnership('layer_test_active');

/** A minimal, schema-valid cut/fill record — enough to make a Volume measurement. */
function volumeRecord(): VolumeRecord {
  return {
    fill: 10,
    cut: 4,
    net: 6,
    referenceZ: 1,
    footprintArea: 20,
    pointsInPolygon: 100,
    densityNative: 5,
    confidence: 'high',
  };
}

const TRIANGLE: Vec3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [1, 2, 0],
];

async function makeMeasure() {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  return new MeasureController({
    onExit: () => {},
  } as unknown as ConstructorParameters<typeof MeasureController>[0]);
}

async function makeAnnotate() {
  const { AnnotationController } = await import('../src/render/annotate/AnnotationController');
  return new AnnotationController();
}

describe('a new measurement records the active layer, by stable id', () => {
  it('stamps the provider-supplied owner onto a created measurement', async () => {
    const measure = await makeMeasure();
    measure.setOwnerProvider(() => OWNER);
    const id = measure.addLassoVolumeMeasurement({ polygon: TRIANGLE, volume: volumeRecord() });
    const m = measure.getMeasurements().find((x) => x.id === id);
    expect(m!.owner).toEqual({ layerId: 'layer_test_active', frame: 'source-local' });
  });

  it('leaves the measurement unowned when the provider returns nothing (single-layer)', async () => {
    const measure = await makeMeasure();
    measure.setOwnerProvider(() => undefined);
    const id = measure.addLassoVolumeMeasurement({ polygon: TRIANGLE, volume: volumeRecord() });
    const m = measure.getMeasurements().find((x) => x.id === id);
    expect(m!.owner).toBeUndefined();
  });

  it('leaves the measurement unowned when no provider is wired at all', async () => {
    const measure = await makeMeasure();
    const id = measure.addLassoVolumeMeasurement({ polygon: TRIANGLE, volume: volumeRecord() });
    const m = measure.getMeasurements().find((x) => x.id === id);
    expect(m!.owner).toBeUndefined();
  });
});

describe('a new annotation records the active layer, by stable id', () => {
  it('stamps the provider-supplied owner onto a created annotation', async () => {
    const annotate = await makeAnnotate();
    annotate.setOwnerProvider(() => OWNER);
    const a = annotate.add({ title: 'crack', type: 'issue', localPosition: { x: 1, y: 2, z: 3 } });
    expect(a.owner).toEqual({ layerId: 'layer_test_active', frame: 'source-local' });
  });

  it('leaves the annotation unowned when the provider returns nothing (single-layer)', async () => {
    const annotate = await makeAnnotate();
    annotate.setOwnerProvider(() => undefined);
    const a = annotate.add({ title: 'crack', type: 'issue', localPosition: { x: 1, y: 2, z: 3 } });
    expect(a.owner).toBeUndefined();
  });
});

describe('single-layer work still round-trips byte-identically', () => {
  it('a session of unowned, controller-created work carries no ownership surface', async () => {
    const measure = await makeMeasure();
    measure.setOwnerProvider(() => undefined); // single-layer: the provider withholds an owner
    measure.addLassoVolumeMeasurement({ polygon: TRIANGLE, volume: volumeRecord() });
    const annotate = await makeAnnotate();
    annotate.setOwnerProvider(() => undefined);
    annotate.add({ title: 'note', type: 'note', localPosition: { x: 4, y: 5, z: 6 } });

    const session = {
      upAxis: 'z' as const,
      origin: [100, 200, 300] as Vec3,
      unitSystem: 'metric' as const,
      views: [],
      measurements: measure.getMeasurements(),
      annotations: annotate.getAnnotations(),
    };
    const json = serializeSession(session);
    // The pre-identity byte shape has no ownership / project-frame / layer-id noise.
    expect(json).not.toContain('"owner"');
    expect(json).not.toContain('projectFrame');
    expect(json).not.toContain('"layerId"');
    // And the file is stable across a reload — parse → re-serialise is identical.
    expect(serializeSession({ ...session, measurements: parseSession(json).measurements, annotations: parseSession(json).annotations })).toBe(json);
  });
});
