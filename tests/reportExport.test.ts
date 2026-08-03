import { describe, it, expect } from 'vitest';
import {
  effectiveCrsName,
  reportPointCount,
  isNonTerrainVerdict,
  exportGeoContext,
  type ReportExportDeps,
} from '../src/app/reportExport';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { Viewer } from '../src/render/Viewer';
import type { SpaceKind } from '../src/terrain/scanShape';

// ─────────────────────────────────────────────────────────────────────────────
// The pure decisions the extraction exposes — the only report/export logic that
// can be decided without a Viewer, the report engine or the DOM.
// ─────────────────────────────────────────────────────────────────────────────

// A minimal ResolvedCrs with just the two fields `effectiveCrsName` reads.
const crs = (kind: ResolvedCrs['kind'], name: string): ResolvedCrs =>
  ({ kind, name } as ResolvedCrs);

describe('effectiveCrsName — the CRS-label honesty rule', () => {
  it('names the frame for a projected CRS', () => {
    expect(effectiveCrsName(crs('projected', 'NAD83 / UTM zone 15N'))).toBe(
      'NAD83 / UTM zone 15N',
    );
  });

  it('names the frame for a geographic CRS', () => {
    expect(effectiveCrsName(crs('geographic', 'WGS 84'))).toBe('WGS 84');
  });

  it('stamps nothing for a local-coordinate CRS (no real frame to name)', () => {
    // A local scan has no georeferenced frame — stamping a name would be false.
    expect(effectiveCrsName(crs('local', 'Local coordinates (no CRS)'))).toBeUndefined();
  });

  it('stamps nothing for an unknown-kind CRS', () => {
    expect(effectiveCrsName(crs('unknown', 'EPSG:0'))).toBeUndefined();
  });

  it('stamps nothing when there is no resolved CRS at all', () => {
    expect(effectiveCrsName(null)).toBeUndefined();
  });
});

describe('reportPointCount — the file-scale honesty rule', () => {
  it('reports the declared file total when striding reduced the in-memory subset', () => {
    // A 100M-point file rendered at a 4M display budget: the PDF describes the FILE.
    expect(reportPointCount(100_000_000, 4_000_000)).toBe(100_000_000);
  });

  it('reports the rendered count when the load was not strided (declared === rendered)', () => {
    expect(reportPointCount(4_000_000, 4_000_000)).toBe(4_000_000);
  });

  it('reports the rendered count when no total was declared (undefined)', () => {
    expect(reportPointCount(undefined, 2_500_000)).toBe(2_500_000);
  });

  it('never reports a declared total smaller than the rendered count', () => {
    // A smaller "declared" is not a reduction, so it must not win over what loaded.
    expect(reportPointCount(1_000, 4_000)).toBe(4_000);
  });

  it('treats a declared total equal to zero as present but not larger, so rendered wins', () => {
    expect(reportPointCount(0, 4_000)).toBe(4_000);
  });
});

describe('isNonTerrainVerdict — the capture-lens predicate', () => {
  it('is true for a compact object scan', () => {
    expect(isNonTerrainVerdict('object')).toBe(true);
  });

  it('is true for an interior scan', () => {
    expect(isNonTerrainVerdict('interior')).toBe(true);
  });

  it('is false for a terrain scan (aerial density guess allowed)', () => {
    expect(isNonTerrainVerdict('terrain')).toBe(false);
  });

  it('is false when no verdict has been reached yet', () => {
    expect(isNonTerrainVerdict(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exportGeoContext — the origin/CRS/name resolution routing (static → streaming
// → none). Reads only accessors, so it is exercisable with a stubbed deps object.
// ─────────────────────────────────────────────────────────────────────────────

type StaticCloud = {
  sourceOrigin: readonly [number, number, number];
  name: string;
  metadata?: { crs?: { name?: string } };
};
type StreamingCloud = {
  renderOrigin: readonly [number, number, number];
  name: string;
  crs: () => { name?: string } | null;
};

/** Assemble a deps stub with only the members exportGeoContext reads. */
function makeDeps(opts: {
  activeId: string | null;
  cloud?: StaticCloud;
  streaming?: StreamingCloud;
  resolvedCrs?: ResolvedCrs | null;
}): ReportExportDeps {
  const viewer = {
    getCloud: (_id: string) => opts.cloud ?? null,
    get streamingCloud() {
      return opts.streaming ?? null;
    },
  } as unknown as Viewer;
  return {
    getViewer: () => viewer,
    scans: { activeId: opts.activeId, activeCloud: () => null },
    crsCurrent: () => opts.resolvedCrs ?? null,
  } as unknown as ReportExportDeps;
}

describe('exportGeoContext — active-scan frame resolution', () => {
  it('resolves the STATIC cloud source frame when a scan is active', () => {
    const geo = exportGeoContext(
      makeDeps({
        activeId: 'a',
        cloud: { sourceOrigin: [10, 20, 30], name: 'site.las', metadata: { crs: { name: 'EPSG:26915' } } },
        resolvedCrs: crs('projected', 'NAD83 / UTM zone 15N'),
      }),
    );
    expect(geo.origin).toEqual([10, 20, 30]);
    // The RESOLVED label wins over the raw source metadata name.
    expect(geo.crsName).toBe('NAD83 / UTM zone 15N');
    expect(geo.name).toBe('site.las');
  });

  it('falls back to the static cloud source metadata name when the resolved CRS is local', () => {
    const geo = exportGeoContext(
      makeDeps({
        activeId: 'a',
        cloud: { sourceOrigin: [1, 2, 3], name: 'scan.las', metadata: { crs: { name: 'declared-in-file' } } },
        resolvedCrs: crs('local', 'Local coordinates (no CRS)'),
      }),
    );
    // effectiveCrsName is undefined for a local CRS, so the source metadata name shows.
    expect(geo.crsName).toBe('declared-in-file');
  });

  it('resolves the STREAMING renderOrigin when no static cloud is active', () => {
    const geo = exportGeoContext(
      makeDeps({
        activeId: null,
        streaming: { renderOrigin: [100, 200, 300], name: 'remote.copc.laz', crs: () => ({ name: 'EPSG:6339' }) },
        resolvedCrs: crs('projected', 'NAD83(2011) / UTM zone 12N'),
      }),
    );
    expect(geo.origin).toEqual([100, 200, 300]);
    expect(geo.crsName).toBe('NAD83(2011) / UTM zone 12N');
    expect(geo.name).toBe('remote.copc.laz');
  });

  it('returns the zero frame with no CRS or name when nothing is loaded', () => {
    const geo = exportGeoContext(makeDeps({ activeId: null }));
    expect(geo.origin).toEqual([0, 0, 0]);
    expect(geo.crsName).toBeUndefined();
    expect(geo.name).toBeNull();
  });
});

// Exhaustiveness guard: if a new SpaceKind is added, this array must be updated,
// which forces a reviewer to decide whether it counts as non-terrain.
const ALL_VERDICTS: SpaceKind[] = ['interior', 'object', 'terrain'];
describe('isNonTerrainVerdict covers every SpaceKind', () => {
  it('classifies each known verdict without throwing', () => {
    for (const v of ALL_VERDICTS) expect(typeof isNonTerrainVerdict(v)).toBe('boolean');
  });
});
