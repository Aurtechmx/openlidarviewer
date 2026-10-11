/**
 * On a compound CRS (metre horizontal, foot heights) every on-screen figure is
 * computed in the same per-axis metre frame the exporters use
 * (`measurementMetrics` via `toMetricFrame`), so the headline the user reads
 * equals the number written to CSV / GeoJSON / PDF for every kind.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Measurement, MeasurementKind, Vec3 } from '../src/render/measure/types';
import { measurementMetrics } from '../src/export/measurementExport';
import {
  formatAngle,
  formatAreaRender,
  formatBoxHeadline,
  formatGrade,
  formatLengthRender,
  formatProfileHeadline,
} from '../src/render/measure/format';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const UP: Vec3 = [0, 0, 1];
const FT = 0.3048;

function mk(kind: MeasurementKind, points: Vec3[]): Measurement {
  return { id: kind, kind, name: '', points, closed: kind === 'area' } as Measurement;
}

const FIXTURES: Measurement[] = [
  mk('distance', [[0, 0, 0], [3, 4, 10]]),
  mk('polyline', [[0, 0, 0], [3, 4, 10], [8, 4, -5]]),
  mk('area', [[0, 0, 0], [10, 0, 10], [10, 10, 10], [0, 10, 0]]),
  mk('height', [[0, 0, 0], [3, 4, 10]]),
  mk('angle', [[10, 0, 0], [0, 0, 0], [10, 0, 10]]),
  mk('slope', [[0, 0, 0], [3, 4, 10]]),
  mk('profile', [[0, 0, 0], [3, 4, 10]]),
  mk('box', [[0, 0, 0], [3, 4, 10]]),
];

async function headline(m: Measurement, h: number, v: number): Promise<{ value: string; labels: string[] }> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({
    onExit: () => {}, getPickRay: () => null, getPointAt: () => null,
  } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: UP, origin: null });
  measure.setCrsKnown(true);
  measure.setUnitToMetres(h);
  measure.setVerticalUnitToMetres(v);
  measure.loadMeasurements([structuredClone(m)]);
  const value = measure.getSummaries()[0].value;
  const model = (measure as unknown as {
    _buildModel(): { labels: { text: string; primary: boolean }[] };
  })._buildModel();
  return { value, labels: model.labels.filter((l) => l.primary).map((l) => l.text) };
}

/** The headline string the export's metric numbers format to. */
function expected(m: Measurement, h: number, v: number): string {
  const x = measurementMetrics(m, UP, h, v, 12);
  const len = (n: number | undefined): string => formatLengthRender(n!, 1, 'metric');
  switch (m.kind) {
    case 'distance':
    case 'polyline':
      return len(x.length_m);
    case 'area':
      return formatAreaRender(x.area_m2!, 1, 'metric');
    case 'height':
      return len(Math.abs(x.vertical_m!));
    case 'angle':
      return formatAngle(x.angle_deg!);
    case 'slope':
      return `${formatGrade(x.grade_pct!)} · ${formatAngle(x.angle_deg!)}`;
    case 'profile':
      return formatProfileHeadline(x.length_m!, x.vertical_m!, x.grade_pct!, 'metric');
    case 'box':
      return formatBoxHeadline(x.width_m!, x.depth_m!, x.height_m!, x.volume_m3!, 'metric');
    default:
      throw new Error(m.kind);
  }
}

describe('screen value equals export value on a compound CRS', () => {
  for (const m of FIXTURES) {
    it(m.kind, async () => {
      const { value } = await headline(m, 1, FT);
      // The distance headline carries a bearing suffix after the length.
      const shown = m.kind === 'distance' ? value.split(' · ')[0] : value;
      expect(shown).toBe(expected(m, 1, FT));
    });
  }

  it('the angle reads the true 16.95°, not the raw-coordinate 45°', async () => {
    const angle = FIXTURES.find((m) => m.kind === 'angle')!;
    const { value, labels } = await headline(angle, 1, FT);
    expect(value).toBe('17.0°');
    expect(labels).toContain('17.0°');
  });

  it('the overlay label matches the headline for the mixed-axis kinds', async () => {
    for (const m of FIXTURES.filter((f) => ['polyline', 'angle', 'slope', 'profile'].includes(f.kind))) {
      const { value, labels } = await headline(m, 1, FT);
      expect(labels).toContain(value);
    }
  });

  it('a single-unit CRS is unchanged', async () => {
    for (const m of FIXTURES) {
      const { value } = await headline(m, FT, FT);
      const shown = m.kind === 'distance' ? value.split(' · ')[0] : value;
      expect(shown).toBe(expected(m, FT, FT));
    }
  });
});
