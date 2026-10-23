/**
 * precisionCheck.test.ts: the Performance panel's precision check and its
 * certificate.
 *
 * The check states the per-draw bound for the active loaded scan at the
 * current view against the chosen limit, in one sentence. The certificate
 * records the same result with the data, frame, draw and limit it covers, and
 * a digest of that scope: the same scope always gives the same digest, and a
 * different limit or view gives a different one.
 */
import { describe, it, expect, vi } from 'vitest';

// The source hash, held open by the race test so the scene can change under it.
const digest = vi.hoisted(() => ({
  pending: null as null | ((v: { sha256: string | null; note: string | null }) => void),
  calls: [] as unknown[],
}));
vi.mock('../src/lazyChunks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadExportDigests: async () => ({
    sourceDigestOf: (ref: { key: unknown }) => {
      digest.calls.push(ref.key);
      return new Promise((resolve) => { digest.pending = resolve; });
    },
  }),
}));

import { PRECISION_TOLERANCES, lodLine, precisionCertificate, precisionCertificateWithHash, readPrecision, type PrecisionDeps } from '../src/app/precisionCheck';
import { PointCloud } from '../src/model/PointCloud';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { CrsInfo } from '../src/io/crs';

const ORIGIN: [number, number, number] = [500_000, 4_500_000, 200];
const METRE_CRS: CrsInfo = { source: 'wkt', epsg: 32633, name: 'WGS 84 / UTM zone 33N', isGeographic: false, linearUnit: 'metre', linearUnitToMetres: 1 };

function farCloud(n = 4000): Float32Array {
  let seed = 11;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const local = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    local[3 * i] = rnd() * 1000 + 0.123;
    local[3 * i + 1] = rnd() * 1000 + 0.456;
    local[3 * i + 2] = rnd() * 80 + 0.789;
  }
  return local;
}

/** A column-major view that only translates: the camera a few hundred metres off the tile. */
function translatedView(x: number, y: number, z: number): Float64Array {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1]);
}

function deps(over: Partial<PrecisionDeps> = {}, view = translatedView(500, 500, 800)): PrecisionDeps {
  const cloud = new PointCloud({ positions: farCloud(), origin: ORIGIN, sourceFormat: 'las', name: 'tile.las', metadata: { crs: METRE_CRS } });
  const viewer = {
    activeBackend: () => 'webgpu' as const,
    cloudModelView64: (id: string) => (id === 'cloud_0' ? view : null),
    getCloud: (id: string) => (id === 'cloud_0' ? cloud : undefined),
  };
  return {
    viewer: () => viewer,
    activeId: () => 'cloud_0',
    activeCloud: () => cloud,
    context: () => spatialContextFrom(METRE_CRS),
    ...over,
  };
}

describe('the precision check', () => {
  it('offers 1 mm, 1 cm and 10 cm', () => {
    expect(PRECISION_TOLERANCES.map((t) => t.label)).toEqual(['1 mm', '1 cm', '10 cm']);
  });

  it('certifies a loaded scan within 1 mm at this view, and says so in one sentence', () => {
    const r = readPrecision(deps(), 0.001);
    expect(r.state).toBe('PASS');
    expect(r.line).toMatch(/^Rendering error at most .* mm at this view \(round-to-nearest; .* mm worst case under the spec\), inside the 1 mm limit\.$/);
    expect(r.diagnostic?.boundMetres).toBeLessThan(0.001);
  });

  it('says a limit tighter than the bound is not certified', () => {
    const r = readPrecision(deps(), 1e-7);
    expect(r.state).toBe('NOT_CERTIFIED');
    expect(r.line).toMatch(/not certified for the/);
  });

  it('asks for a scan when none is open, and declines a streamed one', () => {
    expect(readPrecision(deps({ activeCloud: () => null }), 0.001)).toMatchObject({ state: 'NO_SCAN', line: 'Open a scan to check its precision.' });
    expect(readPrecision(deps({ activeId: () => 'stream' }), 0.001).line).toMatch(/streamed scan is not checked/);
  });
});

describe('the precision certificate', () => {
  it('records the result and the scope it covers', () => {
    const json = precisionCertificate(deps(), 0.001, new Date('2026-10-23T00:00:00Z'));
    expect(json).not.toBeNull();
    const c = JSON.parse(json!);
    expect(c.kind).toBe('olv.draw-precision-certificate');
    expect(c.version).toBe(3);
    expect(c.method).toBe('olv.render.draw-precision-bound@1');
    expect(c.result.boundState).toBe('PASS_BOUND');
    expect(c.requirement.toleranceMetres).toBe(0.001);
    expect(c.requirement.checkedUnder).toBe('rn');
    expect(c.result.bounds.map((b: { contract: string }) => b.contract)).toEqual(['rn', 'faithful']);
    expect(c.result.bounds[0].evidence.boundState).toBe('PASS_BOUND');
    expect(c.result.bounds[1].boundMetres).toBeGreaterThan(c.result.bounds[0].boundMetres);
    // The bound is a property of the envelope, so the claim is stated over it.
    expect(c.holdsFor).toMatch(/^Every point stored within the stated local extent and storage error bound/);
    expect(c.dataset.pointsDrawn).toBe(4000);
    expect(c.frame.gradedUnder).toEqual({ linearUnitKnown: true, linearUnitToMetres: 1, verticalScaleInvalid: false });
    expect(c.frame.verticalScale).toBe('absent');
    // The translated view puts the camera at (500, 500, 800) in local coordinates.
    expect(c.camera.positionInScanCoordinates[0]).toBeCloseTo(ORIGIN[0] + 500, 6);
    expect(c.camera.positionInScanCoordinates[2]).toBeCloseTo(ORIGIN[2] + 800, 6);
    expect(c.dataset.sourceSha256).toBeNull();
    expect(c.draw.backend).toBe('webgpu');
    expect(c.camera.modelView64).toHaveLength(16);
    expect(c.frame.crs).toBe(32633);
    expect(c.frame.origin).toEqual(ORIGIN);
    expect(c.dataset.name).toBe('tile.las');
    expect(c.covers).toMatch(/Not survey accuracy/);
    expect(c.reference).toMatch(/binary64 from the stored coordinates/);
    expect(c.citation).toMatch(/Per-Draw Precision Bounds/);
    expect(c.scopeDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same digest for the same scope and a new one when the limit or the view changes', () => {
    const digest = (d: PrecisionDeps, tau: number, at: string): string => JSON.parse(precisionCertificate(d, tau, new Date(at))!).scopeDigest;
    const a = digest(deps(), 0.001, '2026-10-23T00:00:00Z');
    expect(digest(deps(), 0.001, '2026-10-24T00:00:00Z')).toBe(a);
    expect(digest(deps(), 0.01, '2026-10-23T00:00:00Z')).not.toBe(a);
    expect(digest(deps({}, translatedView(400, 500, 800)), 0.001, '2026-10-23T00:00:00Z')).not.toBe(a);
  });

  it('has nothing to certify without a loaded scan', () => {
    expect(precisionCertificate(deps({ activeCloud: () => null }), 0.001)).toBeNull();
  });
});

const crsDeps = (crs: CrsInfo): PrecisionDeps => deps({ context: () => spatialContextFrom(crs) });

describe('the vertical unit the bound is graded under', () => {
  const cases: [string, Partial<CrsInfo>, 'PASS' | 'UNGRADED'][] = [
    ['metres on every axis', { verticalLinearUnit: 'metre', verticalUnitToMetres: 1 }, 'PASS'],
    ['no vertical unit declared: the horizontal unit stands in', {}, 'PASS'],
    ['feet up over metres across', { verticalLinearUnit: 'us-survey-foot', verticalUnitToMetres: 0.3048006096 }, 'UNGRADED'],
    ['a zero vertical factor', { verticalUnitToMetres: 0 }, 'UNGRADED'],
    ['a negative vertical factor', { verticalUnitToMetres: -1 }, 'UNGRADED'],
    ['a non-finite vertical factor', { verticalUnitToMetres: Number.NaN }, 'UNGRADED'],
    ['an unreadable vertical unit with no factor', { verticalLinearUnit: 'unknown' }, 'UNGRADED'],
  ];
  for (const [name, over, state] of cases) {
    it(`${name}: ${state === 'PASS' ? 'graded in metres' : 'no metric verdict'}`, () => {
      const r = readPrecision(crsDeps({ ...METRE_CRS, ...over } as CrsInfo), 0.001);
      expect(r.state).toBe(state);
      if (state === 'UNGRADED') {
        expect(r.line).not.toMatch(/ mm|inside the|PASS/);
        const c = JSON.parse(precisionCertificate(crsDeps({ ...METRE_CRS, ...over } as CrsInfo), 0.001)!);
        expect(c.result.boundState).toBe('NOT_APPLICABLE');
        expect(c.result.bounds.every((b: { boundMetres: number | null }) => b.boundMetres === null)).toBe(true);
      }
    });
  }

  it('names the unreadable vertical unit as the reason', () => {
    const r = readPrecision(crsDeps({ ...METRE_CRS, verticalLinearUnit: 'unknown' }), 0.001);
    expect(r.diagnostic?.reason).toBe('the vertical unit could not be interpreted');
  });
});

describe('the certificate scope digest', () => {
  const digestOf = (d: PrecisionDeps, tau = 0.001, at = '2026-10-23T00:00:00Z'): string =>
    JSON.parse(precisionCertificate(d, tau, new Date(at))!).scopeDigest;
  const base = digestOf(deps());
  const otherCloud = (over: Partial<ConstructorParameters<typeof PointCloud>[0]>): PrecisionDeps => {
    const cloud = new PointCloud({ positions: farCloud(), origin: ORIGIN, sourceFormat: 'las', name: 'tile.las', metadata: { crs: METRE_CRS }, ...over });
    const viewer = {
      activeBackend: () => 'webgpu' as const,
      cloudModelView64: () => translatedView(500, 500, 800),
      getCloud: () => cloud,
    };
    return deps({ viewer: () => viewer, activeCloud: () => cloud });
  };

  // Every input that can change the result, each changed on its own.
  const mutations: [string, () => string][] = [
    ['the limit', () => digestOf(deps(), 0.01)],
    ['the camera', () => digestOf(deps({}, translatedView(400, 500, 800)))],
    ['the vertical factor', () => digestOf(crsDeps({ ...METRE_CRS, verticalUnitToMetres: 0.3048 }))],
    ['the vertical unit being unreadable', () => digestOf(crsDeps({ ...METRE_CRS, verticalLinearUnit: 'unknown' }))],
    ['the horizontal factor', () => digestOf(crsDeps({ ...METRE_CRS, linearUnit: 'foot', linearUnitToMetres: 0.3048 }))],
    ['the horizontal unit being unknown', () => digestOf(crsDeps({ ...METRE_CRS, linearUnit: 'unknown' }))],
    ['the CRS', () => digestOf(crsDeps({ ...METRE_CRS, epsg: 32634, name: 'WGS 84 / UTM zone 34N' }))],
    ['the backend', () => {
      const d = deps();
      const v = d.viewer()!;
      return digestOf({ ...d, viewer: () => ({ ...v, activeBackend: () => 'webgl2' as const }) });
    }],
    ['the origin', () => digestOf(otherCloud({ origin: [500_001, 4_500_000, 200] }))],
    ['the stored points', () => digestOf(otherCloud({ positions: farCloud(3000) }))],
  ];
  for (const [what, run] of mutations) {
    it(`changes with ${what}`, () => expect(run()).not.toBe(base));
  }

  it('does not change with the time alone, and is the same for the same request', () => {
    expect(digestOf(deps(), 0.001, '2027-01-01T00:00:00Z')).toBe(base);
    expect(digestOf(deps())).toBe(base);
  });
});

describe('a certificate waiting on the source hash', () => {
  it('describes the scan and view it was asked for, whatever changes before the hash arrives', async () => {
    const a = new PointCloud({ positions: farCloud(), origin: ORIGIN, sourceFormat: 'las', name: 'A.las', metadata: { crs: METRE_CRS } });
    const b = new PointCloud({ positions: farCloud(2000), origin: [600_000, 4_600_000, 300], sourceFormat: 'las', name: 'B.las', metadata: { crs: { ...METRE_CRS, epsg: 32634 } } });
    let active = a;
    let view = translatedView(500, 500, 800);
    const viewer = {
      activeBackend: () => 'webgpu' as const,
      cloudModelView64: () => view,
      getCloud: () => active,
    };
    const d: PrecisionDeps = {
      viewer: () => viewer,
      activeId: () => 'cloud_0',
      activeCloud: () => active,
      context: () => spatialContextFrom(active === a ? METRE_CRS : { ...METRE_CRS, epsg: 32634 }),
    };
    digest.calls.length = 0;
    const pending = precisionCertificateWithHash(d, 0.001);
    await vi.waitFor(() => expect(digest.pending).not.toBeNull());
    // The scene moves on while A's file is still being hashed.
    active = b;
    view = translatedView(100, 100, 100);
    digest.pending!({ sha256: 'a'.repeat(64), note: null });
    const c = JSON.parse((await pending)!);
    expect(digest.calls).toEqual([a]);
    expect(c.dataset.name).toBe('A.las');
    expect(c.dataset.sourceSha256).toBe('a'.repeat(64));
    expect(c.frame.crs).toBe(32633);
    expect(c.frame.origin).toEqual(ORIGIN);
    expect(c.camera.positionInScanCoordinates[0]).toBeCloseTo(ORIGIN[0] + 500, 6);
  });
});

describe('the certified level of detail', () => {
  it('is selected with every reading that asks, and the live reading never counts on its own', () => {
    expect(readPrecision(deps(), 0.01).lod).toBeNull();
    // Each deps() holds a cloud of its own, so no earlier test has counted its levels.
    const fresh = deps();
    expect(readPrecision(fresh, 100, { lod: 'live' }).lod?.pointsKept).toBeNull();
    const counted = readPrecision(fresh, 100, { lod: 'count' }).lod!;
    expect(counted.pointsKept).toBeGreaterThan(0);
    // Once counted, the live reading reuses the count.
    expect(readPrecision(fresh, 100, { lod: 'live' }).lod?.pointsKept).toBe(counted.pointsKept);
  });

  it('certifies nothing at 1 mm here: round-to-nearest passes, but the faithful bound does not', () => {
    const r = readPrecision(deps(), 0.001, { lod: 'count' });
    expect(r.state).toBe('PASS');
    expect(r.lod?.state).toBe('NONE');
    expect(r.lod!.bMetres!).toBeGreaterThan(0.001);
    expect(lodLine(r.lod)).toMatch(/^No level of detail is certified for the 1 mm limit under faithful rounding \(bound .* mm\)\.$/);
  });

  it('at 1 cm a millimetre grid fits, and keeps every point of a cloud metres apart', () => {
    const r = readPrecision(deps(), 0.01, { lod: 'count' });
    expect(r.lod!.level).toBeGreaterThan(0);
    expect(r.lod!.cellSizeMetres!).toBeLessThan(0.01);
    expect(r.lod!.pointsKept).toBe(r.lod!.pointsFull);
    expect(lodLine(r.lod)).toMatch(/^Coarsest certified level: \d+ mm cells, 100% of points \(.* ≤ 1 cm, faithful rounding\)\. Not drawn in this version\.$/);
  });

  it('names full resolution when no coarser level fits', () => {
    const r = readPrecision(deps(), 0.0015, { lod: 'count' });
    expect(r.lod?.state).toBe('CERTIFIED');
    expect(r.lod?.level).toBe(0);
    expect(lodLine(r.lod)).toMatch(/^Coarsest certified level: full resolution \(bound .* mm ≤ 1\.50 mm, faithful rounding\)\. No coarser level fits\.$/);
  });

  it('names a coarser level, its share of points and that it is not drawn, when one fits', () => {
    const r = readPrecision(deps(), 100, { lod: 'count' });
    expect(r.lod!.level).toBeGreaterThan(0);
    expect(lodLine(r.lod)).toMatch(/^Coarsest certified level: .* cells, \d+% of points \(.* ≤ .*, faithful rounding\)\. Not drawn in this version\.$/);
  });

  it('is recorded in the certificate with its rule and the narrow claim it supports', () => {
    const c = JSON.parse(precisionCertificate(deps(), 0.01, new Date('2026-10-23T00:00:00Z'))!);
    const l = c.result.levelOfDetail;
    expect(l.method).toBe('olv.render.draw-precision-lod@1');
    expect(l.rule).toMatch(/coarsest level k with sigma \* H_k \+ B_k <= tau/);
    expect(l.scope).toMatch(/single node.*not drawn/);
    expect(l.state).toBe('CERTIFIED');
    expect(l.level).toBeGreaterThan(0);
    expect(l.hMetres + l.bMetres).toBeLessThanOrEqual(0.01);
    expect(l.pointsKept).toBe(4000);
    expect(l.positionBytesFull).toBe(4000 * 12);
    expect(l.selectionMs).toBeGreaterThanOrEqual(0);
    // The level is a result, not part of the scope the digest covers.
    expect(c.scopeDigest).toBe(JSON.parse(precisionCertificate(deps(), 0.01, new Date('2027-01-01T00:00:00Z'))!).scopeDigest);
  });
});
