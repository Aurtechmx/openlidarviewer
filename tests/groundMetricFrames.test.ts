/**
 * Web Mercator (EPSG:3857) and geocentric (EPSG:4978) frames declare a metre
 * linear unit, yet neither is a ground plane in metres: Mercator grid metres
 * grow with latitude (1000 m of ground at 37.7°N spans ~1264 grid metres), and
 * geocentric X/Y are not a ground plane at all. Extent, density and spacing
 * figures on these frames stay in source units and state why.
 */
import { describe, expect, it } from 'vitest';
import { scanReport, scanReportUnitBasis } from '../src/analysis/modules/scanReport';
import { streamingExtentRows } from '../src/analysis/streamingExtentRows';
import { footprintMetres } from '../src/report/reportFootprint';
import { footprintToMetadataExtent } from '../src/app/reportExport';
import { buildDatasetSummary } from '../src/report/ReportMetadataSection';
import { groundMetresPermitted, horizontalGroundRefusal, spatialContextFrom } from '../src/geo/SpatialContext';
import { GEOCENTRIC_REASON, WEB_MERCATOR_REASON } from '../src/geo/CrsValidation';
import { PointCloud } from '../src/model/PointCloud';
import { createInspectorCardRefreshers } from '../src/app/inspectorCardRefreshers';
import type { CrsInfo } from '../src/io/crs';

const utm: CrsInfo = { source: 'wkt', name: 'WGS 84 / UTM zone 10N', epsg: 32610, linearUnit: 'metre', linearUnitToMetres: 1, verticalUnitToMetres: 1, isGeographic: false };
const mercator: CrsInfo = { ...utm, name: 'WGS 84 / Pseudo-Mercator', epsg: 3857 };
const geocentric: CrsInfo = { ...utm, name: 'WGS 84 geocentric', epsg: 4978, geocentric: true } as CrsInfo;

const k = 1 / Math.cos((37.7 * Math.PI) / 180);
const header = { min: [0, 0, 0] as [number, number, number], max: [1000 * k, 1000 * k, 50] as [number, number, number] };

describe.each([
  ['EPSG:3857', mercator, WEB_MERCATOR_REASON],
  ['EPSG:4978', geocentric, GEOCENTRIC_REASON],
])('%s claims no ground metres', (_label, crs, reason) => {
  const ctx = spatialContextFrom(crs);

  it('the shared gate refuses and names the reason', () => {
    expect(ctx.linearUnitKnown).toBe(true);
    expect(groundMetresPermitted(ctx)).toBe(false);
    expect(horizontalGroundRefusal(ctx)).toBe(reason);
  });

  it('scan report basis and rows', () => {
    const b = scanReportUnitBasis(ctx);
    expect(b.unitKnown).toBe(false);
    expect(b.lengthUnit).not.toBe(' m');
    expect(b.densityUnit).not.toContain('pts/m²');
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 1]),
      origin: [0, 0, 0], sourceFormat: 'las', name: 'f', metadata: { crs },
    });
    const r = scanReport.run(cloud, undefined, { spatialContext: ctx } as never);
    const v = (l: string) => r.rows.find((x) => x.label === l)?.value ?? '';
    for (const l of ['Width', 'Depth', 'Density', 'Spacing']) {
      expect(v(l)).not.toMatch(/\bm\b|pts\/m²|\bcm\b|\bmm\b/);
    }
    expect(r.rows.some((x) => x.value.includes(reason))).toBe(true);
  });

  it('Dataset Intelligence gives no density tier, as the scan report gives no pts/m²', () => {
    let last: Record<string, unknown> = {};
    const inspector = {
      setDatasetIntelligence: (x: Record<string, unknown>) => { last = x; },
      clearDatasetIntelligence: () => {},
      setProvenance: () => {},
    } as never;
    const tile = {
      pointCount: 1000,
      metadata: { crs },
      bounds: { min: [0, 0, 0], max: [1500, 1500, 300] },
    };
    createInspectorCardRefreshers(inspector, () => ctx).refreshDatasetIntelligenceFromStaticCloud(tile as never);
    expect(last.bboxSpansM).toBeUndefined();
    expect(last.bboxVolume).toBeUndefined();
  });

  it('streaming extent rows', () => {
    const out = streamingExtentRows(header, ctx, 2_500_000);
    expect(out.unitConfirmed).toBe(false);
    expect(out.refusalReason).toBe(reason);
    for (const row of out.rows.filter((x) => x.label !== 'Height' && x.label !== 'Density basis')) {
      expect(row.value).not.toMatch(/ m$|pts\/m²/);
    }
  });

  it('PDF footprint and dataset summary', () => {
    const fp = footprintMetres({
      extentX: header.max[0], extentY: header.max[1], extentZ: 50, pointCount: 2_500_000,
      linearUnitToMetres: 1, verticalUnitToMetres: 1, linearUnitKnown: ctx.linearUnitKnown,
      horizontalRefusal: horizontalGroundRefusal(ctx) ?? undefined,
    });
    expect(fp.unitStatus).toBe('unknown');
    const ext = footprintToMetadataExtent(fp);
    expect(Number.isFinite(ext.density)).toBe(false);
    const rows = buildDatasetSummary({
      fileName: 'f.copc.laz', format: 'COPC', sourcePointCount: 2_500_000, ...ext,
      hasRgb: false, hasIntensity: false, hasClassification: false,
    } as never);
    const units = rows.find((x) => x.label === 'Units');
    expect(units?.value).toContain(reason);
    expect(rows.some((x) => x.label === 'Density')).toBe(false);
  });
});

describe('a projected metre CRS is unchanged', () => {
  it('UTM still claims metres', () => {
    const ctx = spatialContextFrom(utm);
    expect(groundMetresPermitted(ctx)).toBe(true);
    expect(horizontalGroundRefusal(ctx)).toBeNull();
    expect(streamingExtentRows(header, ctx, 1).unitConfirmed).toBe(true);
  });
});

describe('COPC octree root spacing', () => {
  it.each([['EPSG:3857', mercator], ['EPSG:4978', geocentric]])('%s reads source units', async (_l, crs) => {
    const { spacingRowFor } = await import('../src/ui/StreamingPanel');
    expect(spacingRowFor('copc', 2.5, spatialContextFrom(crs)).value).toBe('2.50 (source units)');
  });
});
