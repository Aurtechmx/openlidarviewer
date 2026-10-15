/**
 * Studio card units follow the same frame verdicts as the scan reports.
 *
 * - A Web Mercator grid or a geocentric frame names metres, but its X/Y spans
 *   are not ground metres: Width/Depth stay in source units, no density is
 *   printed, and a Units row says why.
 * - A geocentric Z span is not a height, so up-axis rows carry no metre unit.
 * - Up-axis rows use the VERTICAL unit the elevation colorbar shows, not the
 *   horizontal one (a compound CRS with US-survey-foot heights).
 * - With visible layers in different vertical frames, Min/Max are omitted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured: { rows: { label: string; value: string }[]; meta: Record<string, unknown> }[] = [];
vi.mock('../src/export/BaseExportMode', async (orig) => {
  const real = await orig<typeof import('../src/export/BaseExportMode')>();
  return {
    ...real,
    runStudioExport: vi.fn(async (_c, mode, _t, _cm, _o, rows, meta) => {
      captured.push({ rows, meta });
      return { blob: new Blob(), mode, width: 1, height: 1, mimeType: 'image/png' };
    }),
  };
});

import { baseReportRows } from '../src/export/BaseExportMode';
import { heightMapExporter } from '../src/export/HeightMapExporter';
import { depthMapExporter } from '../src/export/DepthMapExporter';
import { contourMapExporter } from '../src/export/ContourMapExporter';
import { buildExportAdapter } from '../src/render/exportAdapter';
import type { ExportAdapterCloud, ExportAdapterHost } from '../src/render/exportAdapter';
import { resolvedExportCrs } from '../src/app/exportCrsResolver';
import { resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';
import type { CrsInfo } from '../src/io/crs';
import { intensityWindow } from '../src/render/colorModes';
import { buildActiveColorbarSpec } from '../src/render/activeColorbar';

const WEB_MERCATOR: CrsInfo = {
  source: 'epsg', name: 'WGS 84 / Pseudo-Mercator', epsg: 3857,
  linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false,
};
const GEOCENTRIC: CrsInfo = {
  source: 'epsg', name: 'WGS 84 (geocentric)', epsg: 4978,
  linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false, geocentric: true,
};
const UTM: CrsInfo = {
  source: 'epsg', name: 'WGS 84 / UTM zone 15N', epsg: 32615,
  linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false,
};

function entry(
  origin: [number, number, number],
  placement: unknown = null,
  bounds: { min: number[]; max: number[] } = { min: [0, 0, 0], max: [2000, 2000, 50] },
): ExportAdapterCloud {
  return {
    mode: 'elevation',
    visible: true,
    placement,
    cloud: { name: 'scan', pointCount: 1_000_000, sourceOrigin: origin, bounds: () => bounds },
  } as unknown as ExportAdapterCloud;
}

function adapterFor(crs: CrsInfo, over: Partial<ExportAdapterHost> = {}) {
  return buildExportAdapter({
    clouds: () => new Map([['a', entry([0, 0, 100])]]),
    streaming: () => null,
    resolveCloudCrs: () => resolvedExportCrs(resolvedFromCrsInfo(crs, 'las-vlr')),
    ...over,
  } as ExportAdapterHost);
}

const val = (rows: readonly { label: string; value: string }[], label: string) =>
  rows.find((r) => r.label === label)?.value;
const card = (label: string) => val(captured[0]!.rows, label);

beforeEach(() => {
  captured.length = 0;
});

describe('Studio card ground-metre gating', () => {
  it('Web Mercator: Width/Depth in source units, no Density, Units row says why', () => {
    const rows = baseReportRows(adapterFor(WEB_MERCATOR), null);
    expect(val(rows, 'Width')).toBe('2000.0 units');
    expect(val(rows, 'Depth')).toBe('2000.0 units');
    expect(val(rows, 'Density')).toBeUndefined();
    expect(val(rows, 'Units')).toMatch(/^Not ground metres\. Web Mercator/);
    // Heights survive on a Web Mercator grid.
    expect(val(rows, 'Height')).toBe('50.00 m');
  });

  it('geocentric: no Density, and the Z span is not printed as a metre height', () => {
    const rows = baseReportRows(adapterFor(GEOCENTRIC), null);
    expect(val(rows, 'Density')).toBeUndefined();
    expect(val(rows, 'Units')).toMatch(/^Not ground metres\. Geocentric/);
    expect(val(rows, 'Height')).toBe('50.00 units');
  });

  it('geocentric: Height/Depth/Contour Min/Max carry no metre unit', async () => {
    const context = { adapter: adapterFor(GEOCENTRIC, { elevationUnitLabel: () => 'm' }) } as never;
    await heightMapExporter.render(context, {} as never);
    await depthMapExporter.render(context, {} as never);
    await contourMapExporter.render(context, {} as never);
    expect(val(captured[0]!.rows, 'Min Z')).toBe('100.00 units');
    expect(val(captured[1]!.rows, 'Far Z')).toBe('150.00 units');
    expect(val(captured[2]!.rows, 'Z range')).toBe('100.00 units – 150.00 units');
  });

  it('a ground-metre frame keeps metres and density', () => {
    const rows = baseReportRows(adapterFor(UTM), null);
    expect(val(rows, 'Width')).toBe('2.00 km');
    expect(val(rows, 'Density')).toBe('0.3 pts/m²');
    expect(val(rows, 'Units')).not.toMatch(/Not ground metres/);
  });
});

describe('Studio card up-axis rows use the vertical unit', () => {
  // Metre grid with US-survey-foot heights: the colorbar reads "ft".
  const ft = () => ({ adapter: adapterFor(UTM, { elevationUnitLabel: () => 'ft' }) }) as never;

  it('base Height row', () => {
    const rows = baseReportRows(adapterFor(UTM, { elevationUnitLabel: () => 'ft' }), null);
    expect(val(rows, 'Height')).toBe('50.00 ft');
    expect(val(rows, 'Width')).toBe('2.00 km');
  });

  it('Height Map Min/Max', async () => {
    await heightMapExporter.render(ft(), {} as never);
    expect(card('Min Z')).toBe('100.00 ft');
    expect(card('Max Z')).toBe('150.00 ft');
  });

  it('Depth Map Near/Far', async () => {
    await depthMapExporter.render(ft(), {} as never);
    expect(card('Near Z')).toBe('100.00 ft');
    expect(card('Far Z')).toBe('150.00 ft');
  });

  it('Contour interval and Z range', async () => {
    await contourMapExporter.render(ft(), { interval: 5 } as never);
    expect(card('Interval')).toBe('5 ft');
    expect(card('Z range')).toBe('100.00 ft – 150.00 ft');
  });

  it('an unknown vertical unit prints bare source units, like the colorbar', async () => {
    await heightMapExporter.render({ adapter: adapterFor(UTM, { elevationUnitLabel: () => null }) } as never, {} as never);
    expect(card('Min Z')).toBe('100.00 units');
  });
});

describe('Studio card vertical frame across visible layers', () => {
  // B is placed into a project frame anchored at z = 50; A is unplaced at z = 0.
  const mixed = () =>
    adapterFor(UTM, {
      clouds: () => new Map([
        ['a', entry([0, 0, 0])],
        ['b', entry([0, 0, 80], { sourceToProject: [0, 0, 30] })],
      ]),
    });

  it('heightOrigin is null when visible layers do not share a vertical frame', () => {
    expect(mixed().heightOrigin!()).toBeNull();
  });

  it('heightOrigin is the shared origin when they do', () => {
    const a = adapterFor(UTM, {
      clouds: () => new Map([
        ['a', entry([0, 0, 50])],
        ['b', entry([0, 0, 80], { sourceToProject: [0, 0, 30] })],
      ]),
    });
    expect(a.heightOrigin!()).toBe(50);
  });

  it('Height Map omits Min/Max and says why', async () => {
    await heightMapExporter.render({ adapter: mixed() } as never, {} as never);
    expect(card('Min Z')).toBeUndefined();
    expect(card('Max Z')).toBeUndefined();
    expect(card('Z range')).toMatch(/not in one vertical frame/);
    expect(captured[0]!.meta.minZ).toBeUndefined();
  });

  it('Depth and Contour omit Min/Max too', async () => {
    await depthMapExporter.render({ adapter: mixed() } as never, {} as never);
    await contourMapExporter.render({ adapter: mixed() } as never, {} as never);
    expect(val(captured[0]!.rows, 'Near Z')).toBeUndefined();
    expect(val(captured[0]!.rows, 'Z range')).toMatch(/not in one vertical frame/);
    expect(val(captured[1]!.rows, 'Z range')).toMatch(/not in one vertical frame/);
  });
});

describe('intensity window fallback is labelled honestly', () => {
  // 97% of values identical: the p2–p98 band collapses to one value.
  const n = 10000;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i < 150 ? 65535 : i < 300 ? 0 : 1200;

  it('intensityWindow flags the full-range fallback', () => {
    const w = intensityWindow(a, n);
    expect(w.min).toBe(0);
    expect(w.max).toBe(65535);
    expect(w.fullRange).toBe(true);
  });

  it('a normal window is not flagged', () => {
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) b[i] = i % 1000;
    expect(intensityWindow(b, n).fullRange).toBeUndefined();
  });

  it('the colorbar note does not claim p2–p98 for the fallback', () => {
    const bar = buildActiveColorbarSpec({
      mode: 'intensity', range: { min: 0, max: 65535 }, trimPercent: 2, sampleCount: n, fullRange: true,
    });
    expect(bar!.note).not.toMatch(/p2/);
    expect(bar!.note).toBe('full range of the loaded sample');
  });
});
