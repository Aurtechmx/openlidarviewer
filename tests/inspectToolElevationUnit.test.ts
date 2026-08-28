/**
 * Inspector elevation-row unit honesty.
 *
 * The Geographic and UTM groups printed their Elevation value with a hardcoded
 * " m" suffix, while the value itself is the source Z carried through
 * unconverted — so a scan whose vertical unit is feet (metre horizontal, foot
 * height) showed the World Z row in feet and these Elevation rows in metres on
 * the same card. The suffix must be the CRS-aware `worldCoordLabels(crs).zUnit`,
 * the same one the World / Local Z rows already use.
 *
 * A recording DOM stub rather than jsdom (which this repo does not install),
 * matching the panel suites — what matters is the string the row renders.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { InspectTool } from '../src/render/InspectTool';
import { makePointInfo, worldCoordLabels } from '../src/render/pointInfo';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

type Handler = (e: unknown) => void;

/** A recording DOM node covering only the surface InspectTool touches. */
class FakeEl {
  readonly tagName: string;
  private _classes = new Set<string>();
  textContent = '';
  title = '';
  innerHTML = '';
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
      add: (c: string): void => void classes.add(c),
      remove: (c: string): void => void classes.delete(c),
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
  remove(): void {}
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  addEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    a.push(fn);
    this.handlers.set(type, a);
  }
  removeEventListener(): void {}
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
});

/** Geographic horizontal frame with a DECLARED foot height. */
const geoFootHeight: ResolvedCrs = {
  kind: 'geographic',
  name: 'WGS 84 + foot height',
  epsg: 4326,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  verticalUnitToMetres: 0.3048, // international foot
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
};

function elevationRowValues(card: FakeEl): string[] {
  const out: string[] = [];
  for (const row of card.querySelectorAll('.olv-inspect-row')) {
    const label = row.querySelector('.olv-inspect-row-label')?.textContent ?? '';
    const value = row.querySelector('.olv-inspect-row-value')?.textContent ?? '';
    if (label === 'Elevation') out.push(value);
  }
  return out;
}

describe('InspectTool elevation-row unit', () => {
  it('renders the Elevation suffix from worldLabels.zUnit, never a hardcoded metre', () => {
    const camera = {} as unknown as THREE.PerspectiveCamera;
    const canvas = new FakeEl('canvas') as unknown as HTMLCanvasElement;
    const tool = new InspectTool(camera, canvas, { onExit: vi.fn() });

    // A geographic pick: world X = lon, Y = lat (inside the UTM latitude band),
    // Z = a foot height. No origin shift, so world == the local values.
    const info = makePointInfo({
      layer: 'survey.laz',
      index: 3,
      local: [-100, 40, 123.456],
      origin: [0, 0, 0],
      distance: 0,
      geographicHorizontal: true,
      intensity: null,
      classification: null,
      rgb: null,
    });
    (tool as unknown as { _selected: unknown })._selected = {
      info,
      world: new THREE.Vector3(-100, 40, 123.456),
    };

    // Triggers a card repaint with the new context.
    tool.setCoordinateContext({ crs: geoFootHeight });

    const zUnit = worldCoordLabels(geoFootHeight).zUnit;
    expect(zUnit).toBe(' ft');

    const elevValues = elevationRowValues(tool.card as unknown as FakeEl);
    // The UTM group's Elevation row exists and carries the CRS-aware unit.
    expect(elevValues.length).toBeGreaterThan(0);
    for (const v of elevValues) {
      expect(v.endsWith(zUnit)).toBe(true);
      expect(v.endsWith(' m')).toBe(false);
    }
  });
});
