/**
 * The labels drawn in the 3D scene carry the same unit authority as the
 * Measurements panel: a scan with no verified unit prints source units marked
 * unverified (never metres, centimetres or dm³), a confirmed metric scan prints
 * one unit per readout at one precision, and a figure the frame refuses is not
 * drawn. Drives the real MeasureController for the scene labels.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Measurement, MeasurementKind, UnitSystem, Vec3 } from '../src/render/measure/types';
import { GEOGRAPHIC_NOT_AVAILABLE } from '../src/render/measure/types';
import {
  UNIT_UNVERIFIED,
  formatBoxHeadline,
  formatLengthsInSharedUnit,
  formatProfileHeadline,
} from '../src/render/measure/format';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const UP: Vec3 = [0, 0, 1];
const US_SURVEY_FOOT = 1200 / 3937;

function mk(kind: MeasurementKind, points: Vec3[]): Measurement {
  return { id: kind, kind, name: '', points, closed: kind === 'area' } as Measurement;
}

interface Frame {
  crsKnown?: boolean;
  unitToMetres?: number;
  geographic?: boolean;
  units?: UnitSystem;
}

async function render(m: Measurement, f: Frame = {}): Promise<{ value: string; labels: { text: string; primary: boolean }[] }> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({
    onExit: () => {}, getPickRay: () => null, getPointAt: () => null,
  } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: UP, origin: null });
  measure.setCrsKnown(f.crsKnown ?? false);
  measure.setUnitToMetres(f.unitToMetres ?? 1);
  measure.setGeographicCrs(f.geographic ?? false);
  if (f.units) measure.setUnitSystem(f.units);
  measure.loadMeasurements([structuredClone(m)]);
  const value = measure.getSummaries()[0].value;
  const model = (measure as unknown as {
    _buildModel(): { labels: { text: string; primary: boolean }[] };
  })._buildModel();
  return { value, labels: model.labels.map(({ text, primary }) => ({ text, primary })) };
}

const BOX = mk('box', [[0, 0, 0], [13.2, 4.8, 0.005]]);
const PROFILE = mk('profile', [[0, 0, 0], [30, 40, 0.4]]);
const METRIC_TOKENS = / m\b|\bm³|cm|mm|dm³|km/;

describe('scene labels: unit unverified', () => {
  it('a no-CRS box label is the panel headline, in source units', async () => {
    const { value, labels } = await render(BOX);
    const head = labels.find((l) => l.primary)!.text;
    expect(head).toBe(value);
    expect(head).toContain(UNIT_UNVERIFIED);
    expect(head).not.toMatch(METRIC_TOKENS);
    expect(head).toBe(
      `13.2 ${UNIT_UNVERIFIED} × 4.8 ${UNIT_UNVERIFIED} × 0.005 ${UNIT_UNVERIFIED}  · 0.3168 ${UNIT_UNVERIFIED}`,
    );
  });

  it('a no-CRS profile label is the panel headline, in source units', async () => {
    const { value, labels } = await render(PROFILE);
    const head = labels.find((l) => l.primary)!.text;
    expect(head).toBe(value);
    expect(head).toContain(UNIT_UNVERIFIED);
    expect(head).not.toMatch(METRIC_TOKENS);
  });

  it('no label of any kind claims a metric unit', async () => {
    const all: Measurement[] = [
      mk('distance', [[0, 0, 0], [0.3, 0.4, 0.002]]),
      mk('polyline', [[0, 0, 0], [0.3, 0.4, 0], [0.6, 0.4, 0]]),
      mk('area', [[0, 0, 0], [0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0]]),
      mk('height', [[0, 0, 0], [0.3, 0.4, 0.002]]),
      mk('slope', [[0, 0, 0], [0.3, 0.4, 0.002]]),
      PROFILE,
      BOX,
    ];
    for (const m of all) {
      for (const l of (await render(m)).labels) expect(l.text, m.kind).not.toMatch(METRIC_TOKENS);
    }
  });
});

describe('scene labels: confirmed units', () => {
  it('metres: one unit and one precision across the box label', async () => {
    const { value, labels } = await render(BOX, { crsKnown: true });
    const head = labels.find((l) => l.primary)!.text;
    expect(head).toBe(value);
    expect(head).toBe('13.2000 m × 4.8000 m × 0.0050 m  · 0.31680 m³');
    expect(head).not.toMatch(/cm|dm³/);
  });

  it('metres: the profile length and drop share a unit', async () => {
    const { value, labels } = await render(PROFILE, { crsKnown: true });
    const head = labels.find((l) => l.primary)!.text;
    expect(head).toBe(value);
    expect(head).toBe('50.002 m  · Δh +0.400 m  · 0.8%');
  });

  it('US survey feet scale to metres, and to feet on the imperial toggle', async () => {
    const box = mk('box', [[0, 0, 0], [10, 10, 1]]);
    const metric = await render(box, { crsKnown: true, unitToMetres: US_SURVEY_FOOT });
    expect(metric.labels[0].text).toBe(metric.value);
    expect(metric.value).toBe('3.0480 m × 3.0480 m × 0.3048 m  · 2.8317 m³');
    const imperial = await render(box, { crsKnown: true, unitToMetres: US_SURVEY_FOOT, units: 'imperial' });
    expect(imperial.labels[0].text).toBe(imperial.value);
    expect(imperial.value).toBe('10.000 ft × 10.000 ft × 1.000 ft  · 100.00 ft³');
  });
});

describe('scene labels: refused figures', () => {
  it('a height on a geographic frame keeps its height and drops the degree run', async () => {
    const h = mk('height', [[0, 0, 0], [0.001, 0.001, 12]]);
    const projected = await render(h, { crsKnown: true });
    expect(projected.labels).toHaveLength(2);
    const geo = await render(h, { crsKnown: true, geographic: true });
    expect(geo.labels).toEqual([{ text: projected.labels.find((l) => l.primary)!.text, primary: true }]);
    expect(geo.labels[0].text).toBe(geo.value);
  });

  it('a box on a geographic frame draws no figure', async () => {
    const { labels } = await render(BOX, { crsKnown: true, geographic: true });
    expect(labels.map((l) => l.text)).toEqual([GEOGRAPHIC_NOT_AVAILABLE]);
  });
});

describe('small figures never print as zero', () => {
  const TINY_BOX = mk('box', [[0, 0, 0], [13.2, 4.8, 0.0004]]);
  const TINY_DROP = mk('profile', [[0, 0, 0], [50, 0, 0.0004]]);

  it('metres: a 0.4 mm box height and profile drop keep their figures', async () => {
    const box = await render(TINY_BOX, { crsKnown: true });
    expect(box.labels[0].text).toBe(box.value);
    expect(box.value).toMatch(/× 0\.00040 m /);
    const prof = await render(TINY_DROP, { crsKnown: true });
    expect(prof.labels[0].text).toBe(prof.value);
    expect(prof.value).toContain('Δh +0.00040 m');
    expect(prof.labels.map((l) => l.text).join('|')).not.toMatch(/\b0\.0+ (m|cm)\b/);
  });

  it('US survey feet: the same 0.4 mm survives on both unit systems', async () => {
    const box = mk('box', [[0, 0, 0], [40, 15, 0.0013]]);
    const metric = await render(box, { crsKnown: true, unitToMetres: US_SURVEY_FOOT });
    expect(metric.value).not.toMatch(/× 0\.0+ m/);
    const imperial = await render(box, { crsKnown: true, unitToMetres: US_SURVEY_FOOT, units: 'imperial' });
    expect(imperial.value).toMatch(/× 0\.0013 ft /);
  });

  it('the scene drop and run labels share the headline unit', async () => {
    const { labels } = await render(PROFILE, { crsKnown: true });
    expect(labels.filter((l) => !l.primary).map((l) => l.text)).toEqual(['0.400 m', '50.000 m']);
  });

  it('unverified units still never print a metric unit', async () => {
    const { value, labels } = await render(TINY_BOX, { crsKnown: false });
    for (const t of [value, ...labels.map((l) => l.text)]) expect(t).not.toMatch(METRIC_TOKENS);
  });

  it('the helper widens decimals for the smallest non-zero figure, capped', () => {
    expect(formatLengthsInSharedUnit([13.2, 0.0004], 'metric')).toEqual(['13.20000 m', '0.00040 m']);
    expect(formatLengthsInSharedUnit([13.2, 0.0000001], 'metric')[1]).toBe('0.00000 m');
    expect(formatLengthsInSharedUnit([13.2, 0], 'metric')).toEqual(['13.200 m', '0.000 m']);
  });
});

describe('shared-unit formatting', () => {
  it('formats lengths on one line in one unit at one precision', () => {
    expect(formatLengthsInSharedUnit([13.2, 4.8, 0.005], 'metric')).toEqual(['13.2000 m', '4.8000 m', '0.0050 m']);
    expect(formatLengthsInSharedUnit([0.5, 0.02], 'metric')).toEqual(['50.000 cm', '2.000 cm']);
    expect(formatLengthsInSharedUnit([1, Number.NaN], 'metric')).toEqual(['1.0000 m', '—']);
    expect(formatLengthsInSharedUnit([2], 'unverified')).toEqual([`2 ${UNIT_UNVERIFIED}`]);
  });

  it('the box and profile headlines use it unless a formatter is passed', () => {
    expect(formatBoxHeadline(13.2, 4.8, 0.005, 0.3168, 'metric')).toBe('13.2000 m × 4.8000 m × 0.0050 m  · 0.31680 m³');
    expect(formatBoxHeadline(Number.NaN, 0, 0, Number.NaN, 'imperial')).not.toMatch(/NaN|Infinity/);
    expect(formatProfileHeadline(50, -0.4, -0.8, 'metric')).toBe('50.000 m  · Δh −0.400 m  · -0.8%');
  });
});
