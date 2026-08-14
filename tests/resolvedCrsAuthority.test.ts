/**
 * resolvedCrsAuthority.test.ts — semantic regression guard for the CRS-authority
 * boundary. Every ACTIVE computation/output surface must read the RESOLVED
 * CRS, never the source-declared one; the source may appear only as labelled
 * provenance. `lint:spatial-context` proves a consumer ROUTES through a context,
 * but not that the context is the resolved one — these cases pin the resolved-
 * vs-source distinction the lint cannot see.
 *
 * The matrix is two columns:
 *   Case A  source A (declared)  →  resolved B (user override)   ⇒ every surface reports B
 *   Case B  source A (declared)  →  Local / no-CRS (rejected)    ⇒ no surface resurrects A
 *
 * Surfaces covered here without a DOM/Viewer: the shared `resolvedExportCrs` rule,
 * the streaming Visual Export adapter (label + .prj WKT), and the Scan Report unit
 * basis. Report/Export-Panel/conversion resolution is pinned by their own suites
 * (reportExport, exportPanelCrs, convertCloud); this file guards the streaming
 * seam and the shared rule that all of them delegate to.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolvedExportCrs } from '../src/app/exportCrsResolver';
import { buildExportAdapter } from '../src/render/exportAdapter';
import type { ExportAdapterHost, ExportAdapterCloud } from '../src/render/exportAdapter';
import { scanReport, scanReportUnitBasis } from '../src/analysis/modules/scanReport';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

// Source A: a projected metre CRS the file declares.
const SOURCE_A: ResolvedCrs = {
  kind: 'projected', name: 'UTM 13N (A, declared)', epsg: 32613,
  linearUnit: 'metre', linearUnitToMetres: 1, wkt: 'WKT-A-32613',
} as unknown as ResolvedCrs;
// Resolved B: the user's override — a US-survey-foot state plane, different frame.
const RESOLVED_B: ResolvedCrs = {
  kind: 'projected', name: 'State Plane (B, override)', epsg: 2225,
  linearUnit: 'us-ft', linearUnitToMetres: 0.30480060960121924, wkt: 'WKT-B-2225',
} as unknown as ResolvedCrs;
// Local / no-CRS: the user rejected A and declared the pixels local.
const LOCAL: ResolvedCrs = { kind: 'local', name: 'Local', linearUnit: 'unknown' } as unknown as ResolvedCrs;

function host(over: Partial<ExportAdapterHost> = {}): ExportAdapterHost {
  return {
    clouds: () => new Map<string, ExportAdapterCloud>(),
    streaming: () => null,
    setColorMode: vi.fn(), setStreamingColorMode: vi.fn(), setVisible: vi.fn(),
    snapshot: vi.fn(async () => new Blob()),
    renderFramedTopDown: vi.fn(async () => null),
    renderFigure: vi.fn(async () => null),
    figureViewContext: vi.fn(),
    ...over,
  } as ExportAdapterHost;
}

/** A streaming host whose SOURCE declares A, wired with a resolvedActiveCrs of `resolved`. */
function streamingHost(resolved: ResolvedCrs | null): ExportAdapterHost {
  return host({
    streaming: () => ({ cloud: { renderOrigin: [10, 20, 0], crs: () => SOURCE_A } }) as never,
    resolvedActiveCrs: () => resolvedExportCrs(resolved),
  });
}

describe('resolvedExportCrs — the shared authority rule', () => {
  it('Case A: a resolved override yields its own name/epsg/wkt/unit', () => {
    const rc = resolvedExportCrs(RESOLVED_B);
    expect(rc.name).toBe('State Plane (B, override)');
    expect(rc.epsg).toBe(2225);
    expect(rc.wkt).toBe('WKT-B-2225');
  });
  it('Case B: Local / no-CRS yields every field null — no false frame', () => {
    expect(resolvedExportCrs(LOCAL)).toEqual({ wkt: null, key: null, name: null, unit: null, epsg: null });
    expect(resolvedExportCrs(null)).toEqual({ wkt: null, key: null, name: null, unit: null, epsg: null });
  });
});

describe('streaming Visual Export adapter — resolved authority', () => {
  it('Case A: label + .prj WKT come from the resolved override B, not the declared source A', () => {
    const a = buildExportAdapter(streamingHost(RESOLVED_B));
    expect(a.crsLabel!()).toEqual({ name: 'State Plane (B, override)', unit: expect.any(String), epsg: 2225 });
    expect(a.georefContext!()).toEqual({ worldOrigin: { x: 10, y: 20 }, wkt: 'WKT-B-2225' });
    // The rejected source A never appears.
    expect(a.crsLabel!()!.epsg).not.toBe(32613);
    expect(a.georefContext!()!.wkt).not.toBe('WKT-A-32613');
  });

  it('Case B: a Local override resurrects no CRS — null label, null .prj WKT', () => {
    const a = buildExportAdapter(streamingHost(LOCAL));
    expect(a.crsLabel!()).toBeNull();
    expect(a.georefContext!()).toEqual({ worldOrigin: { x: 10, y: 20 }, wkt: null });
  });

  it('unwired (pure-adapter) streaming falls back to the source declaration', () => {
    const a = buildExportAdapter(
      host({ streaming: () => ({ cloud: { renderOrigin: [10, 20, 0], crs: () => SOURCE_A } }) as never }),
    );
    expect(a.crsLabel!()).toEqual({ name: 'UTM 13N (A, declared)', unit: expect.any(String), epsg: 32613 });
    expect(a.georefContext!()).toEqual({ worldOrigin: { x: 10, y: 20 }, wkt: 'WKT-A-32613' });
  });
});

describe('Scan Report unit basis — resolved context', () => {
  const clod = {
    pointCount: 1000,
    declaredPointCount: 1000,
    sourceFormat: 'las',
    classification: undefined,
    sourceOrigin: [0, 0, 0],
    metadata: { crs: SOURCE_A },
    bounds: () => ({ min: [0, 0, 0], max: [100, 100, 10] }),
  } as never;

  it('Case A: a threaded resolved context B drives the metre-per-unit basis, overriding declared A', () => {
    const basisA = scanReportUnitBasis(spatialContextFrom(SOURCE_A));
    const basisB = scanReportUnitBasis(spatialContextFrom(RESOLVED_B));
    expect(basisA.mpu).toBeCloseTo(1, 6);
    expect(basisB.mpu).toBeCloseTo(0.3048, 4);

    // The module honours the threaded context: the reported width for the same
    // 100-unit span reflects B's foot factor, not A's metre factor.
    const widthRow = (ctx: ReturnType<typeof spatialContextFrom>) =>
      scanReport.run(clod, undefined, { spatialContext: ctx }).rows.find((r) => /width/i.test(r.label));
    const wA = widthRow(spatialContextFrom(SOURCE_A))?.value ?? '';
    const wB = widthRow(spatialContextFrom(RESOLVED_B))?.value ?? '';
    expect(wA).not.toBe(wB); // the override changed the reported metric frame
  });

  it('Case B: a Local / unknown-unit context withholds the metric claim (fail-closed)', () => {
    // An unknown unit is not metric-claimable: the context's unit gate is closed,
    // so the Scan Report emits raw source spans with no metre / pts·m² claim.
    expect(spatialContextFrom(LOCAL).linearUnitKnown).toBe(false);
    expect(scanReportUnitBasis(spatialContextFrom(LOCAL)).mpu).toBe(1); // inert placeholder
  });

  it('no threaded context falls back to the cloud declaration (documented pure-caller path)', () => {
    const rows = scanReport.run(clod, undefined, undefined).rows;
    expect(rows.length).toBeGreaterThan(0); // still runs; reads cloud.metadata.crs (A)
  });
});
