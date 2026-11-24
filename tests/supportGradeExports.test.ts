/**
 * A measurement the panel grades Unverified carries that grade and the panel's
 * caption into the PDF report, the site KML, the findings, the integrity report
 * and the chain total. An ungraded measurement says nothing about support.
 */
import { describe, expect, it } from 'vitest';
import { exportSiteKml, type KmlActionDeps } from '../src/app/kmlActions';
import * as kml from '../src/export/kmlExport';
import { resolveExportDigests } from '../src/export/exportDigests';
import { integrityReportFile, measurementsToFindings } from '../src/export/measurementReport';
import { verifyReportFile } from '../src/export/verifyReport';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { generateReport } from '../src/report/ReportEngine';
import { composeReportInputs } from '../src/report/ReportAssetComposer';
import { gradeMeasurement } from '../src/render/measure/measurementTrust';
import { aggregate, formatChainResult } from '../src/render/measure/measurementChains';
import { REPORT_MANIFEST_VERSION } from '../src/render/measure/reportManifest';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const UP: Vec3 = [0, 0, 1];
const VOID = gradeMeasurement({ vertices: [{ snappedToPoint: false, pointsWithinRadius: 0 }], crsKnown: true });
const m = (id: string, trust?: Measurement['trust'], layerId = 'stable-b'): Measurement =>
  ({ id, kind: 'distance', name: id, points: [[0, 0, 0], [3, 4, 0]], owner: { layerId, frame: 'project' }, ...(trust ? { trust } : {}) }) as Measurement;
const VERDICT = `red. ${VOID.caption}`;

async function siteKml(measurements: Measurement[]): Promise<string> {
  let out = '';
  const crs = { kind: 'projected', epsg: 32633, name: 'WGS 84 / UTM zone 33N', source: 'las-vlr', confidence: 'high', userConfirmed: true, linearUnit: 'metre', linearUnitToMetres: 1 } as ResolvedCrs;
  const deps = {
    hasViewer: () => true, geo: () => ({ origin: [500000, 5000000, 0], crsName: crs.name, name: 'b.las' }),
    crsCurrent: () => crs, upAxis: () => 'z', annotations: () => [], measurements: () => measurements, viewpoints: () => [],
    worldUp: () => UP, unitToMetres: () => 1, scanExtent: () => null, scanHullPositions: () => null,
    measurementOwnership: () => ({ layers: [{ viewerId: 'b', stableId: 'stable-b', name: 'b.las' }], activeViewerId: 'b' }),
    baseName: (n: string) => n, setError: (s: string) => { throw new Error(s); },
    downloadText: (_n: string, t: string) => { out = t; },
    loadKmlExport: async () => ({ ...kml, resolveExportDigests }),
  } as unknown as KmlActionDeps;
  await exportSiteKml(deps);
  return out;
}

describe('the support grade leaves with the figure', () => {
  it('the fixture is the grade the panel reads Unverified', () => {
    expect(VOID).toMatchObject({ grade: 'red', presentable: false });
    expect(VOID.caption).toMatch(/^Unverified/);
  });

  it('PDF report rows', () => {
    const [graded, plain] = buildMeasurementRows([m('a', VOID), m('b')], 'metric');
    expect(graded!.support).toBe(VERDICT);
    expect(graded!.value).toBe('5.0000 m');
    expect(plain!).not.toHaveProperty('support');
  });

  it('PDF report pages', async () => {
    const { PDFPage } = await import('pdf-lib');
    const drawn: string[] = [];
    const real = PDFPage.prototype.drawText;
    PDFPage.prototype.drawText = function (t: string, o?: Parameters<typeof real>[1]) { drawn.push(t); return real.call(this, t, o); };
    try {
      const run = async (measurements: Measurement[]): Promise<string> => {
        drawn.length = 0;
        const r = await generateReport(composeReportInputs({
          templateId: 'technical-report', title: 'T', metadata: { fileName: 'b.las', format: 'las', pointCount: 1 },
          visuals: [], annotations: [], measurements, unitSystem: 'metric',
        } as unknown as Parameters<typeof composeReportInputs>[0]));
        expect(r.failedSections).toEqual([]);
        return drawn.join(' ');
      };
      const text = await run([m('a', VOID)]);
      expect(text).toContain('support grade');
      expect(text.replaceAll(/\s+/g, ' ')).toContain(VERDICT);
      expect(await run([m('b')])).not.toContain('support grade');
    } finally {
      PDFPage.prototype.drawText = real;
    }
  });

  it('site KML, escaped, only for the active scan’s graded work', async () => {
    expect(await siteKml([m('a', VOID)])).toContain(`Support grade: ${VERDICT}`);
    expect(await siteKml([m('b')])).not.toContain('Support grade');
    const hostile = await siteKml([m('a', { ...VOID, caption: '</description><x> & "q"' }), m('b')]);
    expect(hostile).not.toContain('<x>');
    expect(hostile).toContain('&amp;lt;/description&amp;gt;&amp;lt;x&amp;gt; &amp;amp;');
    expect(hostile.match(/<\/description>/g)).toHaveLength(hostile.match(/<description>/g)!.length);
    const other = await siteKml([m('b'), m('a', VOID, 'stable-elsewhere')]);
    expect(other).not.toContain(VOID.caption);
  });

  it('findings: last caveat, under a figure and under a withheld one', () => {
    const [a, b] = measurementsToFindings([m('a', VOID), m('b')], UP, 1);
    expect(a).toMatchObject({ value: 5, caveats: [`Support grade: ${VERDICT}`] });
    expect(b).not.toHaveProperty('caveats');
    const [w] = measurementsToFindings([m('a', VOID)], UP, 1, 1, { geographic: true });
    expect(w!.value).toBeNull();
    expect(w!.caveats).toHaveLength(2);
    expect(w!.caveats![1]).toBe(`Support grade: ${VERDICT}`);
  });

  it('integrity report: same manifest version, still verifies, and the digest covers the grade', () => {
    const { text } = integrityReportFile([m('a', VOID)], UP, 1, 1, 'b', 'X', '2026-01-01T00:00:00Z', 0);
    expect(JSON.parse(text).version).toBe(REPORT_MANIFEST_VERSION);
    expect(text).toContain(VOID.caption);
    expect(verifyReportFile(text).valid).toBe(true);
    expect(verifyReportFile(text.replace('Support grade: red', 'Support grade: green')).valid).toBe(false);
  });

  it('chain total: says how many contributing members are graded red', () => {
    const text = (ms: Measurement[], op: 'sum' | 'count' = 'sum'): string => formatChainResult(aggregate(ms, op, 'length'));
    expect(text([m('a', VOID), m('b')])).toBe(`10.000 m (1 of 2 graded red: ${VOID.caption})`);
    expect(text([m('b'), m('c')])).toBe('10.000 m');
    expect(text([m('a', VOID)], 'count')).toBe('1 of 1');
    const slope = { ...m('s', VOID), kind: 'slope' } as Measurement;
    expect(formatChainResult(aggregate([slope], 'mean', 'grade'))).toContain(`graded red: ${VOID.caption}`);
  });
});
