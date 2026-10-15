/**
 * The PDF report is one request captured at the click (`generateReportPdf`).
 * Loading the report engine and hashing the source both yield; another scan
 * opening in that window must not reach the report. These tests run the real
 * report orchestration with the engine stubbed, hold each await open, switch
 * scan A for scan B (cloud, CRS, measurements, annotations, units, capture
 * fingerprint) and check every part of the composed report is still scan A's.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateReportPdf, type ReportExportDeps } from '../src/app/reportExport';
import { captureProvenance } from '../src/diagnostics/captureProvenance';
import { resolvedFromCrsInfo, type ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { CrsInfo } from '../src/io/crs';
import type { Viewer } from '../src/render/Viewer';
import { stubDownloadGlobals } from './helpers/downloadGlobalsStub';

stubDownloadGlobals('blob:snapshot-test');

const crs = (name: string, epsg: number): ResolvedCrs =>
  resolvedFromCrsInfo({ source: 'wkt', name, epsg, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false } as CrsInfo, 'las-vlr')!;

function cloud(name: string, span: number) {
  return {
    name, sourceFormat: 'las', pointCount: 100, sourceOrigin: [0, 0, 0],
    bounds: () => ({ min: [0, 0, 0], max: [span, span, 1] }),
    colors: undefined, intensity: undefined, classification: undefined, metadata: {},
  };
}

interface Scene {
  id: string;
  cloud: ReturnType<typeof cloud>;
  crs: ResolvedCrs;
  measurements: { id: string; name: string; points: number[][]; owner?: unknown }[];
  annotations: { id: string; title: string }[];
  unitToMetres: number;
  fingerprint: string;
}

const A: Scene = {
  id: 'a', cloud: cloud('scan-a.las', 40), crs: crs('WGS 84 / UTM zone 13N', 32613),
  measurements: [{ id: 'm1', name: 'Distance A', points: [[4, 2, 1], [7, 6, 1]] }],
  annotations: [{ id: 'n1', title: 'NOTE-A' }], unitToMetres: 1, fingerprint: 'capture of A',
};
const B: Scene = {
  id: 'b', cloud: cloud('scan-b.las', 10), crs: crs('NAD83 / California zone 3 (ftUS)', 2225),
  measurements: [{ id: 'm2', name: 'Distance B', points: [[0, 0, 0], [10, 0, 0]] }],
  annotations: [{ id: 'n2', title: 'NOTE-B' }], unitToMetres: 1200 / 3937, fingerprint: 'capture of B',
};

/** A live app whose active scene a test switches; the engine and the hash wait on gates. */
function harness(hold: 'engine' | 'digest') {
  let active: Scene = A;
  const viewer = {
    get streamingCloud() { return null; },
    annotate: { getAnnotations: () => active.annotations },
    measure: {
      getMeasurements: () => active.measurements,
      get unitSystem() { return active === A ? 'metric' : 'imperial'; },
      get unitToMetres() { return active.unitToMetres; },
      worldUp: [0, 0, 1], verticalUnitToMetres: 1, crsKnown: true, geographicCrs: false, verticalRefused: false,
    },
  } as unknown as Viewer;
  vi.spyOn(captureProvenance, 'fingerprint').mockImplementation(() => ({
    label: active.fingerprint, confidence: 'low', signals: [], bounds: [], disclaimer: '',
  }) as unknown as ReturnType<typeof captureProvenance.fingerprint>);

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const waiting = new Promise<void>((r) => { reached = r; });
  const digestKeys: unknown[] = [];
  const composeReportInputs = vi.fn((i: Record<string, unknown>) => i);
  const download = vi.fn();
  const engine = {
    normalizeReportTemplateId: (id: string) => id,
    DEFAULT_TEMPLATE_ID: 'technical-report',
    getReportTemplate: (id: string) => ({ label: id }),
    resolveExportDigests: async (ref: { key: unknown }, c: ResolvedCrs | null) => {
      digestKeys.push(ref.key);
      if (hold === 'digest') { reached(); await gate; }
      return { source: { sha256: `sha-of-${(ref.key as { name: string }).name}`, note: null }, crs: c?.name ?? null };
    },
    composeReportInputs,
    generateReport: async () => ({ blob: new Blob(['%PDF']), failedSections: [] }),
  };
  const deps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer,
    scans: { get activeId() { return active.id; }, activeCloud: () => active.cloud },
    crsCurrent: () => active.crs,
    classScopeStamp: () => '',
    baseName: (n: string) => n.replace(/\.[^.]+$/, ''),
    loadReportEngine: async () => {
      if (hold === 'engine') { reached(); await gate; }
      return engine;
    },
    dropZone: { setError: vi.fn() },
    debug: false,
    measurementOwnership: () => ({ layers: [{ viewerId: active.id, stableId: `stable-${active.id}`, name: active.cloud.name }], activeViewerId: active.id }),
  } as unknown as ReportExportDeps;
  return {
    deps, waiting, release, composeReportInputs, digestKeys, download,
    switchTo: (s: Scene) => {
      // Scan B opens: the active scene changes and scan A's measurement list
      // is edited in place, as the live controller's array is.
      active = s;
      A.measurements[0]!.points[1] = [99, 99, 99];
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  A.measurements[0]!.points[1] = [7, 6, 1];
});

describe('the PDF report is captured at the click', () => {
  for (const hold of ['engine', 'digest'] as const) {
    it(`keeps every part of scan A when scan B opens while the ${hold === 'engine' ? 'report engine loads' : 'source is hashed'}`, async () => {
      const h = harness(hold);
      const anchors: { download: string }[] = [];
      vi.spyOn(document, 'createElement').mockImplementation(() => {
        const a = { href: '', download: '', click() {}, remove() {} };
        anchors.push(a);
        return a as unknown as HTMLElement;
      });
      const done = generateReportPdf('technical-report', h.deps);
      await h.waiting;
      h.switchTo(B);
      h.release();
      await done;
      expect(anchors.map((a) => a.download)).toEqual(['scan-a-technical-report.pdf']);
      const inputs = h.composeReportInputs.mock.calls[0]![0] as Record<string, any>;
      expect(inputs.subtitle).toBe('scan-a.las');
      expect(inputs.metadata.fileName).toBe('scan-a.las');
      expect(inputs.metadata.crsName).toBe('WGS 84 / UTM zone 13N');
      expect(inputs.metadata.digests.source.sha256).toBe('sha-of-scan-a.las');
      expect(inputs.metadata.digests.crs).toBe('WGS 84 / UTM zone 13N');
      expect(h.digestKeys).toEqual([A.cloud]);
      expect(inputs.provenance.label).toBe('capture of A');
      expect(inputs.unitSystem).toBe('metric');
      expect(inputs.unitToMetres).toBe(1);
      expect(inputs.annotations.map((a: { title: string }) => a.title)).toEqual(['NOTE-A']);
      expect(inputs.measurements.map((m: { name: string }) => m.name)).toEqual(['Distance A']);
      // A deep copy: an edit to the live measurement after the click does not reach the PDF.
      expect(inputs.measurements[0].points).toEqual([[4, 2, 1], [7, 6, 1]]);
    });
  }
});
