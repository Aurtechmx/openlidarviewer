/**
 * The measurement overlay feeds snapshot PNGs and Studio image exports, so on
 * a geographic CRS it must not draw a grade, angle, length or area that the
 * live grade refuses. Drives the real MeasureController for every kind; the
 * refused set comes from the same rule the grade and the exports use.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Measurement, MeasurementKind, Vec3 } from '../src/render/measure/types';
import { GEOGRAPHIC_NOT_AVAILABLE } from '../src/render/measure/types';
import { geographicRefusesKind } from '../src/render/measure/measurementTrust';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

function mk(kind: MeasurementKind, points: Vec3[], extra: Partial<Measurement> = {}): Measurement {
  return { id: kind, kind, name: '', points, ...extra } as Measurement;
}

const FIXTURES: Record<MeasurementKind, Measurement> = {
  distance: mk('distance', [[0, 0, 0], [0.001, 0, 1]]),
  polyline: mk('polyline', [[0, 0, 0], [0.001, 0, 1], [0.002, 0, 0]]),
  area: mk('area', [[0, 0, 0], [0.001, 0, 1], [0.001, 0.001, 1]], { closed: true }),
  height: mk('height', [[0, 0, 0], [0, 0, 1]]),
  angle: mk('angle', [[0.001, 0, 0], [0, 0, 0], [0, 0, 1]]),
  slope: mk('slope', [[0, 0, 0], [0.001, 0, 1]]),
  profile: mk('profile', [[0, 0, 0], [0.001, 0, 1]]),
  box: mk('box', [[0, 0, 0], [0.001, 0.001, 1]]),
  volume: mk('volume', [[0, 0, 0], [0.001, 0, 0], [0.001, 0.001, 0]], {
    volume: { cut: 0.5, fill: 1, net: 0.5, footprintArea: 0.0000005 },
  } as Partial<Measurement>),
};

async function labelsFor(m: Measurement, geographic: boolean): Promise<string[]> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({
    onExit: () => {}, getPickRay: () => null, getPointAt: () => null,
  } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setGeographicCrs(geographic);
  measure.loadMeasurements([structuredClone(m)]);
  const model = (measure as unknown as { _buildModel(): { labels: { text: string }[] } })._buildModel();
  return model.labels.map((l) => l.text);
}

describe('overlay labels on a geographic CRS', () => {
  for (const kind of Object.keys(FIXTURES) as MeasurementKind[]) {
    it(`${kind}: ${geographicRefusesKind(kind) ? 'refused' : 'drawn'}`, async () => {
      const geo = await labelsFor(FIXTURES[kind], true);
      expect(geo.length).toBeGreaterThan(0);
      if (geographicRefusesKind(kind)) {
        expect(geo).toEqual([GEOGRAPHIC_NOT_AVAILABLE]);
      } else {
        expect(geo).not.toContain(GEOGRAPHIC_NOT_AVAILABLE);
      }
      // A projected frame draws the figures as before.
      expect(await labelsFor(FIXTURES[kind], false)).not.toContain(GEOGRAPHIC_NOT_AVAILABLE);
    });
  }

  it('the audit slope draws no grade or angle', async () => {
    expect((await labelsFor(FIXTURES.slope, true)).join(' ')).not.toMatch(/%|°/);
  });
});
