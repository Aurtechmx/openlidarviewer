/**
 * volumeBaseLevel.test.ts
 *
 * A polygon volume is cut and fill against a base level, the median of the
 * outline's vertex heights, and that level was never shown. The summary now
 * carries it as a clause through the same datum offset the profile rows use,
 * marked local when the scene has no datum; the panel prints it under the
 * headline, the copied text and the PDF row include it, and the CSV and
 * GeoJSON write it as `base_level` in the output frame.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../src/ui/ResultFocus', () => ({ openResultFocus: () => {} }));

import type { Measurement, Vec3, VolumeRecord } from '../src/render/measure/types';
import type { MeasureController as MC, MeasurementSummary } from '../src/render/measure/MeasureController';
import { buildResultModel, measurementRowText } from '../src/app/measureResultModel';
import { measurementsToCsv, type MeasurementExportContext } from '../src/export/measurementExport';
import { volumeBaseLevelClause } from '../src/render/measure/format';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const Z: Vec3 = [0, 0, 1];
const RING: Vec3[] = [[0, 0, 12.0], [10, 0, 12.5], [10, 10, 12.35], [0, 10, 13.0]];
const RECORD = { referenceZ: 12.35, fill: 30, cut: 10, net: 20, footprintArea: 100, pointsInPolygon: 400, densityNative: 4, confidence: 'medium' } as unknown as VolumeRecord;

function volume(extra: Partial<Measurement> = {}): Measurement {
  return { id: 'v1', kind: 'volume', name: 'Volume 1', closed: true, points: RING.map((p) => [...p] as Vec3), volume: { ...RECORD }, ...extra } as Measurement;
}

async function controller(origin: Vec3 | null): Promise<MC> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: Z, origin });
  measure.setCrsKnown(true);
  measure.setUnitToMetres(1);
  return measure;
}

const CLAUSE = "Base level 412.35 m (median of the outline's vertex heights)";

describe('the summary', () => {
  it('states the base level as an elevation through the datum offset', async () => {
    const measure = await controller([0, 0, 400]);
    measure.loadMeasurements([volume()]);
    expect(measure.getSummaries()[0]!.volumeBaseLevel).toBe(CLAUSE);
  });

  it('marks the level local when the scene has no datum', async () => {
    const measure = await controller(null);
    measure.loadMeasurements([volume()]);
    expect(measure.getSummaries()[0]!.volumeBaseLevel).toBe("Base level 12.35 m, local (median of the outline's vertex heights)");
  });

  it('prints the source figure as unverified when the unit is unknown, and nothing without a record', async () => {
    const measure = await controller([0, 0, 400]);
    measure.setCrsKnown(false);
    measure.loadMeasurements([volume(), volume({ id: 'v2', volume: undefined })]);
    const [withRecord, without] = measure.getSummaries();
    expect(withRecord!.volumeBaseLevel).toMatch(/^Base level 412\.35 \(unit unverified\)/);
    expect(without!.volumeBaseLevel).toBeUndefined();
  });

  it('is absent on other kinds', async () => {
    const measure = await controller([0, 0, 400]);
    measure.loadMeasurements([{ id: 'd', kind: 'distance', name: 'd', closed: false, points: [[0, 0, 0], [1, 0, 0]] } as Measurement]);
    expect(measure.getSummaries()[0]!.volumeBaseLevel).toBeUndefined();
  });
});

describe('the row, the copy and the PDF text', () => {
  const summary = { id: 'v1', kind: 'volume', name: 'Volume 1', value: '100 m² · +30 m³ fill · −10 m³ cut · net 20 m³ fill', volumeBaseLevel: CLAUSE } as MeasurementSummary;

  it('the panel prints the clause under the headline', async () => {
    const { MeasurePanel } = await import('../src/ui/MeasurePanel');
    const panel = new MeasurePanel({ onDelete: () => {}, onRename: () => {}, onExport: () => {}, onImport: () => {}, getUnitSystem: () => 'metric' });
    panel.update([summary]);
    const row = (panel.element as unknown as FakeEl).querySelectorAll('.olv-mp-base-level');
    expect(row).toHaveLength(1);
    expect(row[0]!.textContent).toBe(CLAUSE);
  });

  it('the copied text and the PDF row carry the same clause', () => {
    const model = buildResultModel(summary, { datumResolved: true, layersProven: true, verticalReferenceKnown: true } as never);
    expect(model.copyText).toContain(`${summary.value} · ${CLAUSE}`);
    expect(measurementRowText(summary)).toBe(`${summary.value} · ${CLAUSE}`);
    expect(measurementRowText({ value: '4 m' })).toBe('4 m');
    expect(volumeBaseLevelClause('1.00 m', false)).toBe("Base level 1.00 m, local (median of the outline's vertex heights)");
  });
});

describe('the CSV', () => {
  const ctx: MeasurementExportContext = { toOutput: (p) => [p[0], p[1], p[2] + 400], up: Z, unitToMetres: 1 };

  it('writes base_level in the output frame beside cut, fill and net', () => {
    const lines = measurementsToCsv([volume()], ctx).split('\n');
    const header = lines[0]!.split(',');
    expect(header.indexOf('base_level')).toBe(header.indexOf('net_m3') + 1);
    const row = lines[1]!.split(',');
    expect(row[header.indexOf('base_level')]).toBe('412.35');
  });

  it('leaves the cell empty for other kinds and when heights are refused', () => {
    const header = measurementsToCsv([], ctx).split('\n')[0]!.split(',');
    const at = header.indexOf('base_level');
    const line = measurementsToCsv([{ id: 'd', kind: 'distance', name: 'd', closed: false, points: [[0, 0, 0], [1, 0, 0]] } as Measurement], ctx).split('\n')[1]!.split(',');
    expect(line[at]).toBe('');
    const refused = measurementsToCsv([volume()], { ...ctx, verticalRefused: true }).split('\n')[1]!.split(',');
    expect(refused[at]).toBe('');
  });
});
