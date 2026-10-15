/**
 * Studio card heights are SOURCE heights, not render-local ones.
 *
 * The loaders subtract a per-cloud origin from every position, so the export
 * adapter's `localBoundsAabb()` is measured from that origin. A 3DEP tile with
 * elevations −7.86…39.72 m loaded at origin z = −8 has a local up-axis extent
 * of 0.14…47.72, and the Height Map card printed exactly that ("Min Z 14.0 cm /
 * Max Z 47.7 m") beside a colorbar labelled in true heights. The card rows must
 * add the frame origin back, the same reconstruction the elevation legend does.
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

import { heightMapExporter } from '../src/export/HeightMapExporter';
import { depthMapExporter } from '../src/export/DepthMapExporter';
import { contourMapExporter } from '../src/export/ContourMapExporter';
import { buildExportAdapter } from '../src/render/exportAdapter';
import type { ExportAdapterCloud, ExportAdapterHost } from '../src/render/exportAdapter';

// The user's tile: local up extent 0.14…47.72 m over a −8 m origin.
const LOCAL: readonly [number, number, number, number, number, number] = [0, 0, 0.14, 1000, 1000, 47.72];

function ctx(heightOrigin: number | undefined, axis: 0 | 1 | 2 = 2) {
  return {
    adapter: {
      localBoundsAabb: () => LOCAL,
      worldUpAxis: () => axis,
      crsLabel: () => ({ name: 'NAD83(2011) / UTM zone 15N', unit: 'metre' }),
      ...(heightOrigin === undefined ? {} : { heightOrigin: () => heightOrigin }),
    },
  } as never;
}

const row = (label: string) => captured[0]!.rows.find((r) => r.label === label)?.value;

beforeEach(() => {
  captured.length = 0;
});

describe('Studio cards report source heights', () => {
  it('Height Map card reads −7.86 m … 39.72 m, not the local 14.0 cm … 47.7 m', async () => {
    await heightMapExporter.render(ctx(-8), {} as never);
    expect(row('Min Z')).toBe('-7.86 m');
    expect(row('Max Z')).toBe('39.72 m');
    expect(captured[0]!.meta.minZ).toBeCloseTo(-7.86, 9);
    expect(captured[0]!.meta.maxZ).toBeCloseTo(39.72, 9);
  });

  it('Depth Map card reads source heights on the up axis', async () => {
    await depthMapExporter.render(ctx(-8), {} as never);
    expect(row('Near Z')).toBe('-7.86 m');
    expect(row('Far Z')).toBe('39.72 m');
  });

  it('Contour Map card Z range reads source heights', async () => {
    await contourMapExporter.render(ctx(-8), {} as never);
    expect(row('Z range')).toBe('-7.86 m – 39.72 m');
  });

  it('an adapter that reports no origin keeps the local numbers', async () => {
    await heightMapExporter.render(ctx(undefined), {} as never);
    expect(row('Min Z')).toBe('0.14 m');
  });
});

describe('export adapter heightOrigin', () => {
  function entry(origin: [number, number, number], placement: unknown = null, visible = true) {
    return {
      mode: 'elevation',
      visible,
      placement,
      cloud: { sourceOrigin: origin, bounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }) },
    } as unknown as ExportAdapterCloud;
  }
  function host(over: Partial<ExportAdapterHost>): ExportAdapterHost {
    return {
      clouds: () => new Map(),
      streaming: () => null,
      ...over,
    } as ExportAdapterHost;
  }

  it('is the up-axis source origin of a lone static cloud', () => {
    const a = buildExportAdapter(host({ clouds: () => new Map([['a', entry([261000, 3195000, -8])]]) }));
    expect(a.heightOrigin!()).toBe(-8);
  });

  it('follows a Y-up frame', () => {
    const a = buildExportAdapter(host({
      worldUpAxis: () => 1,
      clouds: () => new Map([['a', entry([5, 12, 40])]]),
    }));
    expect(a.heightOrigin!()).toBe(12);
  });

  it('is the PROJECT origin for a placed layer (sourceOrigin − sourceToProject)', () => {
    // Layer origin z = 30, placed +38 above a project frame anchored at z = −8.
    const a = buildExportAdapter(host({
      clouds: () => new Map([
        ['hidden', entry([0, 0, 999], null, false)],
        ['a', entry([0, 0, 30], { sourceToProject: [0, 0, 38] })],
      ]),
    }));
    expect(a.heightOrigin!()).toBe(-8);
  });

  it('is the streaming render origin when streaming', () => {
    const a = buildExportAdapter(host({
      streaming: () => ({ cloud: { renderOrigin: [1, 2, -8] }, renderer: { colorMode: 'elevation' } }) as never,
    }));
    expect(a.heightOrigin!()).toBe(-8);
  });

  it('is 0 when nothing is loaded', () => {
    expect(buildExportAdapter(host({})).heightOrigin!()).toBe(0);
  });
});
