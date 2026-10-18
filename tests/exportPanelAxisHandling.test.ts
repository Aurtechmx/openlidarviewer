/**
 * exportPanelAxisHandling.test.ts
 *
 * The Export panel's point-cloud path, with the real converter behind it. A
 * georeferenced PLY facade resolved to EPSG:32613 exports its own global
 * coordinates under Keep and Assign; the "Rotate a local Y-up model to Z-up"
 * option is offered only while the scan has no CRS, is off by default, reaches
 * the converter only when ticked, and is cleared when a CRS is resolved. Node
 * environment via a recording DOM stub.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FakeEl as BaseFakeEl } from './helpers/exportPanelPillDomFake';
import { PointCloud } from '../src/model/PointCloud';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { ConvertOptions } from '../src/convert/types';

const rec = vi.hoisted(() => ({
  downloads: [] as Array<{ name: string; text: string }>,
  options: [] as Array<Record<string, unknown>>,
}));
vi.mock('../src/io/download', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  downloadBytes: (name: string, bytes: Uint8Array) => rec.downloads.push({ name, text: new TextDecoder().decode(bytes) }),
}));
vi.mock('../src/lazyChunks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadConvertEngine: async () => {
    const real = await import('../src/convert/convertCloud');
    return {
      convertCloud: (cloud: PointCloud, options: ConvertOptions) => {
        rec.options.push(options as unknown as Record<string, unknown>);
        return real.convertCloud(cloud, options);
      },
      resolveExportDigests: async () => null,
    };
  },
}));

/** The shared stub, plus the one lookup the panel uses to clear the box. */
class FakeEl extends BaseFakeEl {
  querySelector(sel: string): FakeEl | null {
    const want = sel === 'input' ? 'input' : null;
    const walk = (n: BaseFakeEl): FakeEl | null => {
      if (want && n.tagName === want) return n as FakeEl;
      for (const c of n.children) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

/** A vertical facade facing north, at UTM 13N survey coordinates. */
function facade(): { cloud: PointCloud; first: [number, number, number] } {
  const origin: [number, number, number] = [500000, 4000000, 100];
  const local: number[] = [];
  for (let u = 0; u < 30; u++) for (let v = 0; v < 30; v++) {
    local.push(u * 2, 5 * Math.exp(-(((u - 15) ** 2 + (v - 15) ** 2) / 120)), v * 2);
  }
  const cloud = new PointCloud({ positions: Float32Array.from(local), origin, sourceFormat: 'ply', name: 'facade.ply' });
  return { cloud, first: [origin[0] + local[0], origin[1] + local[1], origin[2] + local[2]] };
}

const UTM13N: ResolvedCrs = {
  kind: 'projected', name: 'WGS 84 / UTM zone 13N', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1,
  source: 'user-override', confidence: 'high', userConfirmed: true,
} as ResolvedCrs;

type PanelInternals = {
  _format: string;
  _crsMode: string;
  _targetEpsg: string;
  _rotateYUp: boolean;
  _export(): Promise<void>;
  setCrsKnown(known: boolean): void;
  element: unknown;
};

async function makePanel(cloud: PointCloud, crs: ResolvedCrs | null): Promise<PanelInternals> {
  const { ExportPanel } = await import('../src/ui/ExportPanel');
  const panel = new ExportPanel({
    getCloud: () => cloud,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
    getResolvedSourceCrs: () => crs,
  });
  const p = panel as unknown as PanelInternals;
  p.setCrsKnown(crs != null);
  p._format = 'xyz';
  return p;
}

function firstRow(): number[] {
  const xyz = rec.downloads.find((d) => d.name.endsWith('.xyz'));
  const row = xyz!.text.split('\n').find((l) => l.trim() && !l.startsWith('#'))!;
  return row.split(/\s+/).map(Number);
}

describe('ExportPanel: a georeferenced facade keeps its coordinates', () => {
  for (const mode of ['keep', 'assign'] as const) {
    it(`${mode}: the written point is the source point, under EPSG:32613`, async () => {
      rec.downloads.length = 0;
      rec.options.length = 0;
      const { cloud, first } = facade();
      const p = await makePanel(cloud, UTM13N);
      p._crsMode = mode;
      p._targetEpsg = '32613';
      await p._export();
      expect(rec.options[0].axisHandling).toBe('preserve');
      const row = firstRow();
      expect(row[0]).toBeCloseTo(first[0], 3);
      expect(row[1]).toBeCloseTo(first[1], 3);
      expect(row[2]).toBeCloseTo(first[2], 3);
      expect(rec.downloads.find((d) => d.name.endsWith('.xyz'))!.text).toContain('# crs: EPSG:32613');
    });
  }

  it('a stale rotation request never reaches a georeferenced export', async () => {
    rec.downloads.length = 0;
    rec.options.length = 0;
    const { cloud, first } = facade();
    const p = await makePanel(cloud, null);
    p._rotateYUp = true;
    // The scan resolves a CRS: the option is withdrawn and cleared.
    p.setCrsKnown(true);
    expect(p._rotateYUp).toBe(false);
    await p._export();
    expect(rec.options[0].axisHandling).toBe('preserve');
    expect(firstRow()[1]).toBeCloseTo(first[1], 3);
  });
});

describe('ExportPanel: the Y-up to Z-up option', () => {
  const axisRow = (p: PanelInternals): BaseFakeEl => {
    const root = p.element as BaseFakeEl;
    const label = root.findOwnText('Rotate a local Y-up model to Z-up')[0];
    expect(label).toBeDefined();
    return root.children.flatMap(function find(n: BaseFakeEl): BaseFakeEl[] {
      return n.children.includes(label) || n.children.some((c) => c.children.includes(label)) ? [n] : n.children.flatMap(find);
    })[0];
  };

  it('is offered only while the scan has no CRS', async () => {
    const local = await makePanel(facade().cloud, null);
    expect(axisRow(local).style.display).toBe('');
    const georef = await makePanel(facade().cloud, UTM13N);
    expect(axisRow(georef).style.display).toBe('none');
  });

  it('is off by default: a local model is written as stored', async () => {
    rec.downloads.length = 0;
    rec.options.length = 0;
    const { cloud, first } = facade();
    const p = await makePanel(cloud, null);
    await p._export();
    expect(rec.options[0].axisHandling).toBe('preserve');
    const row = firstRow();
    expect(row[1]).toBeCloseTo(first[1], 3);
    expect(row[2]).toBeCloseTo(first[2], 3);
  });

  it('ticked, it rotates a local model and the file records it', async () => {
    rec.downloads.length = 0;
    rec.options.length = 0;
    const { cloud, first } = facade();
    const p = await makePanel(cloud, null);
    p._rotateYUp = true;
    await p._export();
    expect(rec.options[0].axisHandling).toBe('y-up-to-z-up');
    const row = firstRow();
    expect(row[1]).toBeCloseTo(-first[2], 3);
    expect(row[2]).toBeCloseTo(first[1], 3);
    const text = rec.downloads.find((d) => d.name.endsWith('.xyz'))!.text;
    expect(text).toContain('Conversion event axes-y-up-to-z-up');
    expect(text).not.toContain('coordinates unchanged');
  });
});
