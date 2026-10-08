/**
 * Grid north is not north.
 *
 * A projected scan's +Y axis is grid north. True north differs from it by the
 * meridian convergence: 1.29 degrees for EPSG:32612 at (-109, 40) by PROJ,
 * 2.27 degrees at a zone edge at 49 N, and at most 2.98 degrees at 84 N. The map sheet arrow and the
 * distance headline's bearing are measured against +Y, so they must say grid,
 * and a scan with no CRS has no north of any kind.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildMapSheetPdf } from '../src/render/measure/mapSheetPdf';
import type { ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';
import type { Vec3 } from '../src/render/navMath';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom({ ns: true });
});

const model: ContourFeatureModel = {
  features: [
    { value: 100, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [50, 10], [100, 0]] },
  ],
  crs: 'WGS 84 / UTM zone 12N',
  verticalDatum: 'NAVD88',
  intervalM: 10,
  contourStyle: 'smooth',
  bbox: { minX: 0, minY: 0, maxX: 100, maxY: 60 },
  interpolatedFraction: 0,
  coverageMode: 'full',
  warnings: [],
} as unknown as ContourFeatureModel;

/** Every text run drawn into the PDF, decoded from its content streams. */
function drawnText(bytes: Uint8Array): string[] {
  const runs: string[] = [];
  for (const seg of Buffer.from(bytes).toString('latin1').split(/stream\r?\n/).slice(1)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(seg.split('endstream')[0], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const m of content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) runs.push(Buffer.from(m[1]!, 'hex').toString('latin1'));
  }
  return runs;
}

describe('map sheet orientation arrow', () => {
  it('labels the georeferenced arrow "Grid N", never a bare "N"', async () => {
    const runs = drawnText(
      await buildMapSheetPdf({ model, labels: [], crs: 'WGS 84 / UTM zone 12N', worldOrigin: { x: 500000, y: 4400000 } }),
    );
    expect(runs).toContain('Grid N');
    expect(runs).not.toContain('N');
  });

  it('keeps the honest no-CRS label', async () => {
    const runs = drawnText(await buildMapSheetPdf({ model: { ...model, crs: null }, labels: [], crs: null }));
    expect(runs).toContain('local grid up');
    expect(runs).toContain('true north unknown');
    expect(runs).not.toContain('Grid N');
  });
});

describe('distance headline bearing', () => {
  const UP_Z: Vec3 = [0, 0, 1];
  const UP_Y: Vec3 = [0, 1, 0];
  const NE = { id: 'd1', kind: 'distance', name: 'd', points: [[0, 0, 0], [3, 3.3, 0]] };
  const NE_YUP = { id: 'd2', kind: 'distance', name: 'd', points: [[0, 0, 0], [3, 0, 3.3]] };

  async function controller(opts: { crsKnown: boolean; geographic?: boolean; projected?: boolean; up: Vec3 }) {
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    const m = new MeasureController({
      onExit: () => {},
      getPickRay: () => null,
      getPointAt: () => null,
    } as unknown as ConstructorParameters<typeof MeasureController>[0]);
    m.setContext({ worldUp: opts.up, origin: [0, 0, 0] });
    m.setCrsKnown(opts.crsKnown);
    if (opts.geographic) m.setGeographicCrs(true);
    if (opts.projected) m.setProjectedCrs(true);
    return (x: unknown) => (m as unknown as { _headlineText(x: unknown): string })._headlineText(x);
  }

  it('a georeferenced projected Z-up scan reads "042° grid"', async () => {
    const headline = await controller({ crsKnown: true, projected: true, up: UP_Z });
    expect(headline(NE)).toMatch(/· 042° grid$/);
  });

  it('a local engineering CRS with a metre unit (not projected) reads "(local axes)", not grid', async () => {
    const headline = await controller({ crsKnown: true, projected: false, up: UP_Z });
    expect(headline(NE)).toMatch(/· 042° \(local axes\)$/);
  });

  it('a local / unknown-CRS scan never shows a bare three-digit bearing', async () => {
    const headline = await controller({ crsKnown: false, up: UP_Z });
    const text = headline(NE);
    expect(text).not.toMatch(/\d{3}°$/);
    expect(text).toMatch(/\(local axes\)$/);
  });

  it('a Y-up scan without a CRS is marked local axes', async () => {
    const headline = await controller({ crsKnown: false, up: UP_Y });
    expect(headline(NE_YUP)).not.toMatch(/\d{3}°$/);
    expect(headline(NE_YUP)).toMatch(/\(local axes\)$/);
  });

  it('a Y-up scan with a CRS is also local axes: its north reference is +Z, not grid north', async () => {
    const headline = await controller({ crsKnown: true, projected: true, up: UP_Y });
    expect(headline(NE_YUP)).toMatch(/\(local axes\)$/);
  });

  it('a geographic CRS shows no bearing: degrees of longitude and latitude are not equal lengths', async () => {
    const headline = await controller({ crsKnown: false, geographic: true, up: UP_Z });
    expect(headline(NE)).not.toMatch(/°/);
  });
});
