/**
 * terrainAccessLabExportButton.test.ts — drives the mounted Terrain Access Lab
 * over a live fake DOM: apply a profile, set start and goal from the
 * keyboard, run, and read the Export button's disabled state before and
 * after the run.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

beforeAll(() => {
  installLiveFakeDom();
  const doc = (globalThis as unknown as { document: { createElement: (t: string) => unknown; createElementNS?: unknown } }).document;
  doc.createElementNS = (_ns: string, tag: string) => doc.createElement(tag);
  // The busy emblem appends text as well as elements.
  const append = FakeEl.prototype.append;
  FakeEl.prototype.append = function (this: FakeEl, ...kids: (FakeEl | string)[]): void {
    append.call(this, ...kids.map((k) => {
      if (typeof k !== 'string') return k;
      const t = new FakeEl('#text');
      t.textContent = k;
      return t;
    }));
  };
});

const { mountTerrainAccessInteractive } = await import('../src/ui/fieldSimulation/terrainAccessLab');

function flatDtm(cols: number, rows: number): DtmGrid {
  const n = cols * rows;
  return {
    z: new Float32Array(n), coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n).fill(100),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols, rows, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n,
    analyzedPointCount: n, withheldExcluded: true, meanConfidence: 100, warnings: [],
  } as DtmGrid;
}

const byClass = (root: FakeEl, cls: string): FakeEl => {
  const hit = root.find((e) => e.hasClass(cls));
  if (!hit) throw new Error(`no .${cls}`);
  return hit;
};

const key = (k: string) => ({ key: k, preventDefault: () => {} });

type Lab = ReturnType<typeof mountTerrainAccessInteractive>;

function mount(dsm?: unknown): { lab: Lab; root: FakeEl } {
  const lab = mountTerrainAccessInteractive({
    dtm: flatDtm(4, 3),
    scale: { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true },
    layerId: 'layer-a',
    filename: 'site',
    dsm: dsm as never,
  });
  return { lab, root: lab.element as unknown as FakeEl };
}

function applyProfile(root: FakeEl): void {
  const values = ['test', '30', '30', '1', '0', '0'];
  const inputs = root.findAll((e) => e.hasClass('olv-ta-field-input'));
  inputs.forEach((input, i) => { (input as unknown as { value: string }).value = values[i] ?? ''; });
  byClass(root, 'olv-ta-form-submit').fire('click');
}

function setEndpoints(root: FakeEl): void {
  const canvas = byClass(root, 'olv-ta-grid-canvas');
  canvas.fire('keydown', key('Enter'));
  root.find((e) => e.hasClass('olv-ta-segmented-btn') && e.dataset.value === 'goal')!.fire('click');
  canvas.fire('keydown', key('ArrowRight'));
  canvas.fire('keydown', key('ArrowDown'));
  canvas.fire('keydown', key('Enter'));
}

const runOf = (root: FakeEl) => byClass(root, 'olv-ta-run') as unknown as { onclick: () => Promise<void> };

describe('Terrain Access Lab export button', () => {
  it('is disabled until a run finds a route, then enabled', async () => {
    const { lab, root } = mount();
    applyProfile(root);
    const exportButton = byClass(root, 'olv-ta-export');
    expect(exportButton.disabled).toBe(true);
    setEndpoints(root);
    expect(exportButton.disabled).toBe(true);
    await runOf(root).onclick();
    expect(byClass(root, 'olv-ta-run-card').textContent).toContain('geometric traversability screening');
    expect(exportButton.disabled).toBe(false);
    lab.dispose();
  });

  it('moving the start or goal clears the route, its card and the export', async () => {
    const { lab, root } = mount();
    applyProfile(root);
    setEndpoints(root);
    await runOf(root).onclick();
    const exportButton = byClass(root, 'olv-ta-export');
    expect(exportButton.disabled).toBe(false);
    root.find((e) => e.hasClass('olv-ta-segmented-btn') && e.dataset.value === 'start')!.fire('click');
    const canvas = byClass(root, 'olv-ta-grid-canvas');
    canvas.fire('keydown', key('ArrowRight'));
    canvas.fire('keydown', key('Enter'));
    expect(exportButton.disabled).toBe(true);
    expect(byClass(root, 'olv-ta-run-card').textContent).not.toContain('geometric traversability screening');
    lab.dispose();
  });
});

describe('Terrain Access Lab failures', () => {
  // A surface that throws on any read once armed stands in for an internal failure.
  function trap(): { dsm: unknown; arm: () => void } {
    let armed = false;
    const dsm = new Proxy({ cols: 99, rows: 99, cellSizeM: 1 }, {
      get(target, prop) {
        if (armed) throw new Error('boom');
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });
    return { dsm, arm: () => { armed = true; } };
  }

  it('a run that throws restores the controls and shows a failure card', async () => {
    const t = trap();
    const { lab, root } = mount(t.dsm);
    applyProfile(root);
    setEndpoints(root);
    t.arm();
    await runOf(root).onclick();
    const card = byClass(root, 'olv-ta-run-card').textContent;
    expect(card).toContain('Terrain Access did not run');
    expect(card).toContain('could not finish: boom');
    expect((byClass(root, 'olv-ta-run') as unknown as { disabled: boolean }).disabled).toBe(false);
    lab.dispose();
  });

  it('a preview that throws shows a failure and a way back to the form', () => {
    const t = trap();
    t.arm();
    const { lab, root } = mount(t.dsm);
    applyProfile(root);
    expect(root.textContent).toContain('could not finish: boom');
    expect(byClass(root, 'olv-ta-retry')).toBeTruthy();
    lab.dispose();
  });
});
