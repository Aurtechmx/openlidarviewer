/**
 * An Area draft whose ring establishes no area stays open when finished, and
 * says why when the mode is left. Rings near a plane stay accepted, and the
 * output for an ordinary ring is unchanged.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Vec3 } from '../src/render/navMath';
import { installFakeDom } from './support/measurePanelDom';
import { areaRingVerdict, areaRingVerdictCached } from '../src/render/measure/areaValidity';
import { measurementsToCsv, measurementsToGeoJSON, type MeasurementExportContext } from '../src/export/measurementExport';
import type { Measurement } from '../src/render/measure/types';


beforeAll(() => {
  installFakeDom({ ns: true });
  (globalThis as { window?: unknown }).window ??= { addEventListener: () => {}, removeEventListener: () => {} };
});

interface Internals {
  _draft: { kind: string; points: Vec3[]; closed?: boolean } | null;
  _newDraft(): { kind: string; points: Vec3[] };
}

async function make(points: Vec3[]) {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setActive(true);
  measure.setKind('area');
  const inner = measure as unknown as Internals;
  const d = inner._newDraft();
  d.points = points.map((p) => [...p] as Vec3);
  inner._draft = d;
  return { measure, inner };
}

const BOWTIE: Vec3[] = [[0, 0, 0], [2, 2, 0], [0, 2, 0], [2, 0, 0]];
const SQUARE: Vec3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];

describe('finishing an Area draft', () => {
  it('commits a valid ring', async () => {
    const { measure } = await make(SQUARE);
    measure.finishCurrent();
    expect(measure.getMeasurements()).toHaveLength(1);
  });
  it('keeps a refused ring as the open draft and commits nothing', async () => {
    const { measure, inner } = await make(BOWTIE);
    measure.finishCurrent();
    expect(measure.getMeasurements()).toHaveLength(0);
    expect(inner._draft?.points).toHaveLength(4);
  });
  it('states the reason on the measure bar when the mode is left with a refused ring', async () => {
    const { measure } = await make(BOWTIE);
    measure.finishCurrent();
    measure.setActive(false);
    const bar = measure as unknown as { _hintEl: { textContent: string }; hint: { classList: { contains(c: string): boolean } } };
    expect(bar._hintEl.textContent).toMatch(/not saved.*crosses itself/);
    expect(bar.hint.classList.contains('olv-hidden')).toBe(false);
    measure.dispose();
  });
  it('says nothing when the mode is left with a valid or empty draft', async () => {
    const a = await make(SQUARE);
    a.measure.setActive(false);
    const b = await make([]);
    b.measure.setActive(false);
    for (const x of [a, b]) {
      expect((x.measure as unknown as { _hintEl: { textContent: string } })._hintEl.textContent).not.toMatch(/not saved/);
    }
  });
});

describe('plane tolerance', () => {
  it('accepts a roof facet with small out-of-plane noise', () => {
    const noise = [0.01, -0.02, 0.015, -0.01, 0.02, -0.015];
    const facet: Vec3[] = [[0, 0, 0], [3, 0, 1.5], [6, 0, 3], [6, 4, 3], [3, 4, 1.5], [0, 4, 0]]
      .map((p, i) => [p[0], p[1], p[2] + noise[i]] as Vec3);
    expect(areaRingVerdict(facet).ok).toBe(true);
  });
  it('accepts a stepped terrace-like ring on a slope', () => {
    const terrace: Vec3[] = [[0, 0, 0], [8, 0, 0.8], [8, 2, 0.8], [6, 2, 0.6], [6, 4, 0.6], [4, 4, 0.4], [4, 6, 0.4], [0, 6, 0]];
    expect(areaRingVerdict(terrace).ok).toBe(true);
  });
  it('refuses a ring that touches itself at a vertex', () => {
    const pinched: Vec3[] = [[0, 0, 0], [4, 0, 0], [4, 4, 0], [2, 0, 0], [0, 4, 0]];
    expect(areaRingVerdict(pinched).ok).toBe(false);
  });
});

describe('memoised verdict', () => {
  it('returns the same verdict object until the ring changes', () => {
    const ring: Vec3[] = SQUARE.map((p) => [...p] as Vec3);
    const a = areaRingVerdictCached(ring);
    expect(areaRingVerdictCached(ring)).toBe(a);
    ring[1] = [2, 2, 0];
    ring[2] = [2, 0, 0];
    expect(areaRingVerdictCached(ring)).not.toBe(a);
    expect(areaRingVerdictCached(ring).ok).toBe(false);
  });
});

describe('an ordinary ring with a non-zero first vertex exports as before', () => {
  const ctx: MeasurementExportContext = { toOutput: (p) => [p[0], p[1], p[2]], up: [0, 0, 1], unitToMetres: 1, crsName: 'EPSG:32612' };
  const m: Measurement = {
    id: 'a', kind: 'area', name: 'Plot',
    points: [[1000, 2000, 3], [1010, 2000, 3], [1010, 2010, 3], [1000, 2010, 3]], closed: true,
  };
  it('keeps the CSV row', () => {
    const row = measurementsToCsv([m], ctx).split('\n')[1];
    expect(row).toContain(',area,');
    expect(row).toContain(',100,100,');
    expect(row).toContain(',40,');
    expect(row).not.toContain('withheld');
  });
  it('keeps the GeoJSON properties', () => {
    const p = JSON.parse(measurementsToGeoJSON([m], ctx)).features[0].properties;
    expect(p.area_m2).toBe(100);
    expect(p.horizontal_area_m2).toBe(100);
    expect(p.perimeter_m).toBe(40);
    expect(p.area_withheld).toBeUndefined();
  });
});
