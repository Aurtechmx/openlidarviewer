/**
 * Withhold rule: when an artifact's owner, frame or permission cannot be
 * resolved, the result is withheld. No output borrows the active scan's units,
 * frame, permissions, classification epoch or dataset identity for a
 * measurement taken on another scan.
 *
 * The first block ports an external audit's six reproductions (all six failed
 * before this fix). Two were adapted to the rule the fix applies, and the
 * comment on each says how. The second block swaps the active and owning scans
 * across UTM, geographic, Web Mercator and geocentric frames for every
 * measurement output: CSV, GeoJSON, KML, integrity report and PDF.
 */

import { describe, test, expect } from 'vitest';
import { CrsService } from '../src/geo/CrsService';
import { geoContextForCloud, generateReportPdf, type ReportExportDeps } from '../src/app/reportExport';
import {
  exportMeasurementsFile,
  exportMeasurementIntegrityReport,
  collectMeasurementFindings,
  exportFindingsReport,
  type MeasurementExportActionDeps,
} from '../src/app/measurementExportActions';
import { exportSiteKml, type KmlActionDeps } from '../src/app/kmlActions';
import * as serializers from '../src/export/measurementExport';
import * as reportSerializers from '../src/export/measurementReport';
import * as kmlSerializers from '../src/export/kmlExport';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { stubDownloadGlobals } from './helpers/downloadGlobalsStub';
import type { PointCloud } from '../src/model/PointCloud';
import type { Measurement } from '../src/render/measure/types';
import { VERTICAL_NOT_AVAILABLE } from '../src/render/measure/types';
import type { CrsInfo } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { gradeMeasurement } from '../src/render/measure/measurementTrust';

stubDownloadGlobals('blob:owner-frame');

const utm: CrsInfo = { source: 'wkt', name: 'WGS 84 / UTM zone 12N', epsg: 32612, linearUnit: 'metre', linearUnitToMetres: 1, verticalUnitToMetres: 1, isGeographic: false };
const usFt = 1200 / 3937;
const foot: CrsInfo = { ...utm, name: 'NAD83 / Colorado North (ftUS)', epsg: 2231, linearUnit: 'us-survey-foot', linearUnitToMetres: usFt, verticalUnitToMetres: usFt };
const mercator: CrsInfo = { ...utm, name: 'WGS 84 / Pseudo-Mercator', epsg: 3857 };
const geocentric: CrsInfo = { ...utm, name: 'WGS 84 geocentric', epsg: 4978, geocentric: true } as CrsInfo;
const geographic: CrsInfo = { source: 'wkt', name: 'WGS 84', epsg: 4326, linearUnit: 'unknown', linearUnitToMetres: 1, verticalUnitToMetres: 1, isGeographic: true };

const distanceOnA: Measurement = { id: 'distance-a', name: 'Distance on A', kind: 'distance', points: [[0, 0, 0], [10, 0, 0]], pickLayers: ['layer-a'], owner: { layerId: 'layer-a', frame: 'project' } };
const heightOnA: Measurement = { id: 'height-a', name: 'Height on A', kind: 'height', points: [[0, 0, 0], [0, 0, 1]], pickLayers: ['layer-a'], owner: { layerId: 'layer-a', frame: 'project' } };

const noDigests = async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null } as never);

/**
 * Two open scans, a and b, each with its own CRS; `active` is the active one.
 * The measure view mirrors the ACTIVE scan, as the live controller does.
 */
function world(aCrs: CrsInfo, bCrs: CrsInfo = utm, opts: { active?: 'a' | 'b'; ms?: Measurement[] } = {}) {
  const active = opts.active ?? 'b';
  const ms = opts.ms ?? [distanceOnA];
  const crsOf = { a: aCrs, b: bCrs };
  const svc = new CrsService({ get: () => undefined, set: () => {}, clear: () => {} });
  svc.resolveForScan({ name: `${active}.las`, detected: crsOf[active], source: 'las-vlr' });
  const clouds = new Map((['a', 'b'] as const).map((id) => [id as string, {
    name: `${id}.las`, sourceFormat: 'las', sourceOrigin: [500000, 4000000, 0], pointCount: 10,
    bounds: () => ({ min: [0, 0, 0], max: [10, 10, 10] }), metadata: { crs: crsOf[id] },
  } as unknown as PointCloud]));
  const files: { name: string; text: string }[] = [];
  const refusals: string[] = [];
  const reportCalls: unknown[][] = [];
  const ctx = svc.context();
  const measure = {
    getMeasurements: () => ms, worldUp: [0, 0, 1] as [number, number, number],
    unitToMetres: ctx.linearUnitToMetres, verticalUnitToMetres: ctx.linearUnitToMetres,
    crsKnown: ctx.linearUnitKnown, geographicCrs: ctx.horizontalMetricRefused, verticalRefused: ctx.verticalMetricRefused,
    unitSystem: 'metric' as const,
  };
  const layers = { stableIdFor: (id: string) => `layer-${id}`, view: { clouds: () => ['a', 'b'], getCloud: (id: string) => clouds.get(id), layerProjectOffset: () => null } };
  const ownership = () => ({ layers: ['a', 'b'].map((id) => ({ viewerId: id, stableId: `layer-${id}`, name: `${id}.las` })), activeViewerId: active });
  const deps: MeasurementExportActionDeps = {
    measure,
    geo: () => geoContextForCloud(clouds.get(active)!, svc.current()),
    upAxis: () => 'z',
    layers: layers as never,
    frameSource: {
      activeId: () => active,
      activeGeo: () => geoContextForCloud(clouds.get(active)!, svc.current()),
      activeUpAxis: () => 'z',
      cloud: (id) => clouds.get(id),
      classificationEpoch: (id) => (id === 'a' ? 3 : 7),
      crs: svc,
    },
    refuse: (s) => refusals.push(s),
    baseName: (s) => s.replace('.las', ''),
    downloadText: (name, text) => files.push({ name, text }),
    loadMeasurementExport: async () => ({ ...serializers, resolveExportDigests: noDigests }),
    loadMeasurementReport: async () => ({
      ...reportSerializers,
      resolveExportDigests: noDigests,
      integrityReportFile: (...args: unknown[]) => {
        reportCalls.push(args);
        return (reportSerializers.integrityReportFile as (...a: unknown[]) => { filename: string; text: string })(...args);
      },
    } as never),
    activeClassificationEpoch: () => (active === 'a' ? 3 : 7),
    appVersion: 'test',
    notify: () => {},
    now: () => '2026-10-12T00:00:00Z',
  };
  return { deps, svc, clouds, files, refusals, reportCalls, measure, ownership, active };
}

/** Run the PDF assembly and capture the composer input. */
async function pdfInputs(w: ReturnType<typeof world>, withOwnership = true): Promise<Record<string, any>> {
  let captured: Record<string, any> = {};
  const deps = {
    viewerReady: Promise.resolve(),
    getViewer: () => ({ streamingCloud: null, annotate: { getAnnotations: () => [] }, measure: w.measure }),
    scans: { activeId: w.active, activeCloud: () => w.clouds.get(w.active) },
    crsCurrent: () => w.svc.current(),
    classScopeStamp: () => '',
    baseName: (s: string) => s.replace('.las', ''),
    loadReportEngine: async () => ({
      normalizeReportTemplateId: (id: string) => id,
      DEFAULT_TEMPLATE_ID: 'engineering-inspection',
      getReportTemplate: () => ({ label: 'Audit' }),
      resolveExportDigests: noDigests,
      composeReportInputs: (x: Record<string, any>) => { captured = x; return x; },
      generateReport: async () => ({ blob: new Blob(['pdf']), failedSections: [] }),
    }),
    dropZone: { setError: () => {} },
    debug: false,
    ...(withOwnership ? { measurementOwnership: w.ownership } : {}),
  } as unknown as ReportExportDeps;
  await generateReportPdf('engineering-inspection', deps);
  return captured;
}

const rowsOf = (c: Record<string, any>) =>
  buildMeasurementRows(c.measurements, c.unitSystem, c.unitToMetres, c.worldUp, c.verticalToMetres, c.unitsVerified, c.geographicCrs, c.verticalRefused);

/** Run the site KML with one measurement and return the document text (or the refusal). */
async function kmlOf(w: ReturnType<typeof world>): Promise<{ text: string | null; error: string | null }> {
  let text: string | null = null;
  let error: string | null = null;
  const ctx = w.svc.context();
  const deps: KmlActionDeps = {
    hasViewer: () => true,
    geo: () => geoContextForCloud(w.clouds.get(w.active)!, w.svc.current()),
    crsCurrent: () => w.svc.current(),
    upAxis: () => 'z',
    isGeographic: () => ctx.horizontalMetricRefused,
    verticalRefused: () => ctx.verticalMetricRefused,
    measurementOwnership: w.ownership,
    annotations: () => [],
    measurements: () => w.measure.getMeasurements(),
    layerCount: () => 1,
    viewpoints: () => [],
    worldUp: () => [0, 0, 1],
    unitToMetres: () => ctx.linearUnitToMetres,
    scanExtent: () => null,
    scanHullPositions: () => null,
    baseName: (s) => s.replace('.las', ''),
    downloadText: (_n, t) => { text = t; },
    setError: (m) => { error = m; },
    loadKmlExport: async () => ({ ...kmlSerializers, resolveExportDigests: noDigests }) as never,
  };
  await exportSiteKml(deps);
  return { text, error };
}

describe('audit reproductions (Oct 12): owner context is never borrowed', () => {
  test('non-active Web Mercator owner keeps the measurement refusal', async () => {
    const w = world(mercator);
    await exportMeasurementsFile('csv', w.deps);
    if (w.files.length) {
      const lines = w.files[0]!.text.split('\n');
      const col = lines[0]!.split(',').indexOf('length_m');
      expect(col < 0 || lines[1]!.split(',')[col] === '').toBe(true);
    } else expect(w.refusals.length).toBeGreaterThan(0);
  });

  test('integrity classification epoch belongs to owner A, not active B', async () => {
    const w = world(utm);
    await exportMeasurementIntegrityReport(w.deps);
    expect(w.reportCalls[0]?.[7]).toBe(3);
  });

  // Adapted: the audit asserted that B's PDF prints A's measurement at 10.00 m.
  // The rule applied is stricter: a scan-specific PDF holds only that scan's
  // measurements, so B's report withholds A's 10 m measurement and states why
  // (never 3.0480 m), and A's own report prints it at 10.00 m.
  test('PDF does not scale owner A measurements by active B feet', async () => {
    const onB = await pdfInputs(world(utm, foot, { active: 'b' }));
    expect(onB.measurements).toEqual([]);
    expect(onB.measurementsWithheld).toMatch(/^1 measurement withheld: taken on a\.las; make that scan active/);
    const onA = await pdfInputs(world(utm, foot, { active: 'a' }));
    expect(rowsOf(onA)[0]!.value).toMatch(/^10\.00+ m$/);
  });

  // Adapted: the row builder takes the frame's vertical permission as its own
  // argument (SpatialContext.verticalMetricRefused) beside the horizontal one.
  test('geocentric refusal also withholds height: ECEF Z is not local elevation', () => {
    const ctx = spatialContextFrom(geocentric);
    expect(ctx.verticalMetricRefused).toBe(true);
    const rows = buildMeasurementRows([heightOnA], 'metric', 1, [0, 0, 1], 1, false, ctx.horizontalMetricRefused, ctx.verticalMetricRefused);
    expect(rows[0]!.value).toMatch(/not available|unsupported/i);
  });

  test('adding findings refuses a measurement whose owner scan is closed', async () => {
    const w = world(foot);
    const deps = {
      ...w.deps,
      layers: { ...w.deps.layers!, view: { ...w.deps.layers!.view, clouds: () => ['b'], getCloud: (id: string) => (id === 'b' ? w.clouds.get(id) : undefined) } },
      frameSource: { ...w.deps.frameSource!, cloud: (id: string) => (id === 'b' ? w.clouds.get(id) : undefined) },
    } as MeasurementExportActionDeps;
    const findings = await collectMeasurementFindings(deps);
    expect(findings).toEqual([]);
    expect(w.refusals[0]).toMatch(/no longer open/);
  });

  test('finding export never identifies owner A measurements as active dataset B', async () => {
    const w = world(utm, foot);
    const findings = await collectMeasurementFindings(w.deps);
    await exportFindingsReport(w.deps, findings);
    if (w.files.length) expect(w.files[0]!.name).not.toMatch(/^b-/);
    else expect(w.refusals.length).toBeGreaterThan(0);
    expect(w.refusals[0]).toMatch(/taken on a\.las/);
  });
});

const FRAMES: ReadonlyArray<readonly [string, CrsInfo]> = [
  ['UTM', utm],
  ['geographic', geographic],
  ['Web Mercator', mercator],
  ['geocentric', geocentric],
];

/** What the OWNER frame permits for a distance and a height. */
function expected(crs: CrsInfo): { distance: boolean; height: boolean } {
  const ctx = spatialContextFrom(crs);
  return { distance: !ctx.horizontalMetricRefused, height: !ctx.verticalMetricRefused };
}

describe('owner and active frames swapped across UTM, geographic, Web Mercator and geocentric', () => {
  test('the canonical permissions per frame', () => {
    expect(expected(utm)).toEqual({ distance: true, height: true });
    expect(expected(geographic)).toEqual({ distance: false, height: true });
    expect(expected(mercator)).toEqual({ distance: false, height: true });
    expect(expected(geocentric)).toEqual({ distance: false, height: false });
  });

  for (const [ownerName, ownerCrs] of FRAMES) {
    for (const [activeName, activeCrs] of FRAMES) {
      if (ownerName === activeName) continue;
      const want = expected(ownerCrs);

      test(`CSV: owner ${ownerName}, active ${activeName} follows the owner`, async () => {
        const w = world(ownerCrs, activeCrs, { ms: [distanceOnA, heightOnA] });
        await exportMeasurementsFile('csv', w.deps);
        if (w.files.length === 0) {
          expect(w.refusals.length).toBeGreaterThan(0);
          return;
        }
        const [header, dist, height] = w.files[0]!.text.split('\n');
        const cols = header!.split(',');
        // An unverified scale renames the metre columns to source units.
        const cell = (row: string, key: string) => {
          const i = cols.indexOf(key) >= 0 ? cols.indexOf(key) : cols.indexOf(serializers.sourceUnitKey(key));
          return i >= 0 ? row.split(',')[i] ?? '' : '';
        };
        expect(cell(dist!, 'length_m') !== '').toBe(want.distance);
        expect(cell(height!, 'vertical_m') !== '').toBe(want.height);
      });

      test(`GeoJSON: owner ${ownerName}, active ${activeName} follows the owner`, async () => {
        const w = world(ownerCrs, activeCrs, { ms: [distanceOnA, heightOnA] });
        await exportMeasurementsFile('geojson', w.deps);
        if (w.files.length === 0) {
          // Only a frame lon/lat cannot place is refused outright.
          expect(w.refusals.length).toBeGreaterThan(0);
          return;
        }
        const fc = JSON.parse(w.files[0]!.text);
        const [d, h] = fc.features.map((f: { properties: Record<string, unknown> }) => f.properties);
        const v = (p: Record<string, unknown>, k: string) => p[k] ?? p[serializers.sourceUnitKey(k)];
        expect(v(d, 'length_m') != null).toBe(want.distance);
        expect(v(h, 'vertical_m') != null).toBe(want.height);
      });

      test(`integrity report: owner ${ownerName}, active ${activeName} follows the owner`, async () => {
        const w = world(ownerCrs, activeCrs, { ms: [distanceOnA, heightOnA] });
        await exportMeasurementIntegrityReport(w.deps);
        expect(w.reportCalls).toHaveLength(1);
        const args = w.reportCalls[0]!;
        expect(args[4]).toBe('a');
        expect(args[7]).toBe(3);
        const manifest = JSON.parse(w.files[0]!.text);
        const [d, h] = manifest.findings;
        expect(d.value !== null).toBe(want.distance);
        expect(h.value !== null).toBe(want.height);
      });

      test(`PDF: active ${activeName} withholds owner ${ownerName}'s measurements`, async () => {
        const c = await pdfInputs(world(ownerCrs, activeCrs, { ms: [distanceOnA, heightOnA] }));
        expect(c.measurements).toEqual([]);
        expect(c.measurementsWithheld).toMatch(/^2 measurements withheld: taken on a\.las/);
      });

      test(`KML: active ${activeName} withholds owner ${ownerName}'s measurements`, async () => {
        const k = await kmlOf(world(ownerCrs, activeCrs, { ms: [distanceOnA, heightOnA] }));
        if (k.text === null) {
          // The active frame itself cannot be placed on a lon/lat map.
          expect(k.error).not.toBeNull();
          return;
        }
        expect(k.text).not.toContain('Distance on A');
        expect(k.text).toContain('2 measurements withheld');
      });
    }

    test(`PDF and KML on the owner ${ownerName} itself apply its own permissions`, async () => {
      const want = expected(ownerCrs);
      const c = await pdfInputs(world(ownerCrs, utm, { active: 'a', ms: [distanceOnA, heightOnA] }));
      expect(c.measurementsWithheld ?? null).toBeNull();
      const rows = rowsOf(c);
      expect(/not available/.test(rows[0]!.value)).toBe(!want.distance);
      expect(/not available/.test(rows[1]!.value)).toBe(!want.height);
      const k = await kmlOf(world(ownerCrs, utm, { active: 'a', ms: [distanceOnA, heightOnA] }));
      if (k.text !== null) expect(k.text.includes('withheld')).toBe(false);
    });
  }

  test('the live grade refuses a geocentric height with the vertical reason', () => {
    const t = gradeMeasurement({ vertices: [{ snappedToPoint: true, pointsWithinRadius: 50 }, { snappedToPoint: true, pointsWithinRadius: 50 }], crsKnown: true, verticalRefused: true });
    expect(t.presentable).toBe(false);
    expect(t.reasons.join(' ')).toContain(VERTICAL_NOT_AVAILABLE);
  });

  test('a measurement with no recorded scan is withheld while several scans are open', async () => {
    const legacy: Measurement = { id: 'legacy', name: 'Legacy', kind: 'distance', points: [[0, 0, 0], [10, 0, 0]] };
    const w = world(utm, foot, { ms: [legacy] });
    await exportMeasurementIntegrityReport(w.deps);
    expect(w.reportCalls).toEqual([]);
    expect(w.refusals[0]).toMatch(/no record of the scan/);
    const c = await pdfInputs(world(utm, foot, { ms: [legacy] }));
    expect(c.measurements).toEqual([]);
  });

  test('an integrity report spanning two scans is refused rather than stamped with one epoch', async () => {
    const onB: Measurement = { ...distanceOnA, id: 'distance-b', pickLayers: ['layer-b'], owner: { layerId: 'layer-b', frame: 'project' } };
    const w = world(utm, utm, { ms: [distanceOnA, onB] });
    await exportMeasurementIntegrityReport(w.deps);
    expect(w.reportCalls).toEqual([]);
    expect(w.refusals[0]).toMatch(/a\.las and b\.las/);
  });
});
