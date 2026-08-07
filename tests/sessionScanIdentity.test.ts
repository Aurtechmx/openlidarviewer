/**
 * sessionScanIdentity.test.ts
 *
 * A session's geometry is local to the scan it was captured over. Rebasing it
 * onto whatever cloud happens to be loaded silently realigns scan A's analysis
 * onto scan B. `matchSessionToScan` is the guard: extents are the primary,
 * reduction-stable identity signal; point count corroborates but never conflicts
 * alone; file name and CRS are disclosure only.
 */

import { describe, test, expect } from 'vitest';
import {
  matchSessionToScan,
  detectSessionSpatialConflict,
  serializeSession,
  parseSession,
  type ScanFacts,
  type DeclaredSpatialFacts,
  type SessionSpatialClaims,
} from '../src/io/session';
import type { SessionScanSummary } from '../src/io/session';
import { scanFactsFromStatic, type StaticScanCloud } from '../src/app/sessionIo';

const SCAN_A: SessionScanSummary = {
  fileName: 'site-a.laz',
  sourcePoints: 4_000_000,
  width: 120,
  depth: 80,
  height: 25,
  crs: 'NAD83 / UTM 13N',
  crsUnit: 'metre',
};

/** The loaded-cloud facts, defaulting to an exact match of SCAN_A. */
function loaded(over: Partial<ScanFacts> = {}): ScanFacts {
  return {
    fileName: 'site-a.laz',
    sourcePoints: 4_000_000,
    width: 120,
    depth: 80,
    height: 25,
    crs: 'NAD83 / UTM 13N',
    ...over,
  };
}

describe('matchSessionToScan', () => {
  test('an exact fingerprint match is strong, with nothing to disclose', () => {
    const m = matchSessionToScan(SCAN_A, loaded());
    expect(m.verdict).toBe('strong');
    expect(m.reasons).toEqual([]);
  });

  test('a point count within sampling tolerance still matches strongly', () => {
    const m = matchSessionToScan(SCAN_A, loaded({ sourcePoints: 4_000_010 }));
    expect(m.verdict).toBe('strong');
  });

  test('extents differing beyond tolerance is a conflict — refuse the rebase', () => {
    // A different area entirely: 300×200 vs 120×80.
    const m = matchSessionToScan(SCAN_A, loaded({ width: 300, depth: 200, height: 60 }));
    expect(m.verdict).toBe('conflict');
    expect(m.reasons[0]).toMatch(/extents differ/);
  });

  test('same extents but a very different point count downgrades to partial, not conflict', () => {
    // Same scan reduced for a smaller device legitimately reports fewer points.
    const m = matchSessionToScan(SCAN_A, loaded({ sourcePoints: 900_000 }));
    expect(m.verdict).toBe('partial');
    expect(m.reasons.some((r) => /point count differs/.test(r))).toBe(true);
  });

  test('loosely-agreeing extents (within 5%) are partial, not strong', () => {
    // 123 vs 120 ≈ 2.5% — consistent with, but not proof of, the same scan.
    const m = matchSessionToScan(SCAN_A, loaded({ width: 123 }));
    expect(m.verdict).toBe('partial');
  });

  test('a renamed file with identical geometry stays strong — geometry outranks the name', () => {
    // Extents + point count match exactly; a rename alone cannot demote a scan
    // that is spatially identical, so the verdict holds at strong.
    const m = matchSessionToScan(SCAN_A, loaded({ fileName: 'site-a-copy.laz' }));
    expect(m.verdict).toBe('strong');
  });

  test('a differing CRS label is disclosure only, never a standalone verdict', () => {
    // Extents conflict drives the verdict; the CRS mismatch rides along as context.
    const m = matchSessionToScan(SCAN_A, loaded({ width: 300, crs: 'EPSG:32613' }));
    expect(m.verdict).toBe('conflict');
    expect(m.reasons.some((r) => /CRS label differs/.test(r))).toBe(true);
  });

  test('a session with no scan fingerprint is partial, not silently trusted', () => {
    const m = matchSessionToScan(undefined, loaded());
    expect(m.verdict).toBe('partial');
    expect(m.reasons[0]).toMatch(/no scan fingerprint/);
  });
});

/**
 * `detectSessionSpatialConflict` is the per-scan spatial-metadata gate (roadmap
 * P1 #5): the FILE's own declaration is the source of truth, so a session may
 * SUPPLY metadata the file omits but may never REDEFINE metadata the file
 * carries. A conflict is raised only when both sides positively declare a value
 * (a real axis for the axis field) and they differ.
 */
describe('detectSessionSpatialConflict', () => {
  const claims = (over: Partial<SessionSpatialClaims> = {}): SessionSpatialClaims => ({
    upAxis: 'z',
    epsg: 32613,
    linearUnit: 'metre',
    ...over,
  });
  const file = (over: Partial<DeclaredSpatialFacts> = {}): DeclaredSpatialFacts => ({
    upAxis: 'z',
    epsg: 32613,
    linearUnit: 'metre',
    ...over,
  });

  test('fully-agreeing metadata has no conflict', () => {
    const v = detectSessionSpatialConflict(claims(), file());
    expect(v.hasConflict).toBe(false);
    expect(v.conflicts).toEqual([]);
  });

  test('a differing EPSG is a CRS conflict, not a silent adoption', () => {
    const v = detectSessionSpatialConflict(claims({ epsg: 32613 }), file({ epsg: 32614 }));
    expect(v.hasConflict).toBe(true);
    expect(v.conflicts.map((c) => c.field)).toContain('crs');
    expect(v.conflicts.find((c) => c.field === 'crs')!.reason).toMatch(/EPSG:32613.*EPSG:32614/);
  });

  test('a differing up-axis is an axis conflict', () => {
    const v = detectSessionSpatialConflict(claims({ upAxis: 'z' }), file({ upAxis: 'y' }));
    expect(v.conflicts.map((c) => c.field)).toEqual(['axis']);
    expect(v.conflicts[0].reason).toMatch(/up-axis \(Z\).*Y-up/);
  });

  test('a differing linear unit is a unit conflict', () => {
    const v = detectSessionSpatialConflict(
      claims({ linearUnit: 'foot' }),
      file({ linearUnit: 'metre' }),
    );
    expect(v.conflicts.map((c) => c.field)).toEqual(['unit']);
    expect(v.conflicts[0].reason).toMatch(/foot.*metre/);
  });

  test('the file declaring NOTHING lets the session fill the gap — no conflict', () => {
    // File has no EPSG, an unknown axis, and an unknown unit; the session's
    // values are free to stand.
    const v = detectSessionSpatialConflict(
      claims({ epsg: 32613, linearUnit: 'foot' }),
      { upAxis: 'unknown', epsg: undefined, linearUnit: 'unknown' },
    );
    expect(v.hasConflict).toBe(false);
  });

  test('the session declaring nothing beyond its axis cannot conflict on CRS/unit', () => {
    const v = detectSessionSpatialConflict(
      { upAxis: 'z', epsg: undefined, linearUnit: undefined },
      file({ epsg: 32613, linearUnit: 'metre' }),
    );
    expect(v.hasConflict).toBe(false);
  });

  test('an unknown-unit file never conflicts on unit (fail-closed = no claim)', () => {
    const v = detectSessionSpatialConflict(
      claims({ linearUnit: 'foot' }),
      file({ linearUnit: 'unknown' }),
    );
    expect(v.conflicts.some((c) => c.field === 'unit')).toBe(false);
  });

  test('multiple divergences are all reported, CRS first', () => {
    const v = detectSessionSpatialConflict(
      claims({ epsg: 32613, upAxis: 'z', linearUnit: 'metre' }),
      file({ epsg: 32614, upAxis: 'y', linearUnit: 'foot' }),
    );
    expect(v.conflicts.map((c) => c.field)).toEqual(['crs', 'axis', 'unit']);
  });
});

/**
 * The WRITER side of the same identity fact, round-tripped. `exportSession`
 * (main.ts) builds its `scanSummary` inline from the active cloud and is only
 * reachable through the app entry's viewer / DOM wiring, so it is not
 * unit-addressable here. The behaviour under test is its field rule: the exported
 * summary must store the SOURCE point count — `declaredPointCount ??
 * decodedPointCount ?? pointCount`, the SAME ladder the reader's
 * `scanFactsFromStatic` uses — so a session exported under one device's point
 * budget reimports strongly under another's. Pinned here at the serialize /
 * parse + match layer; the one-line writer change in main.ts (the static
 * `scanSummary.sourcePoints`) is what makes the real export emit it.
 */
describe('session round-trip — the exported scan count is source-stable across devices', () => {
  // The SAME source file loaded at two very different budgets. Its header count
  // is device-independent; the held `pointCount` is not. Extents are held equal
  // so the point count is the only variable — the field the writer change fixes.
  const HEADER = 4_000_000;
  const bounds = () => ({ min: [0, 0, 0] as const, max: [120, 80, 25] as const });
  const crsMeta = { crs: { name: 'NAD83 / UTM 13N', epsg: 26913 } };
  const exportDeviceCloud: StaticScanCloud = {
    name: 'site-a.laz',
    pointCount: 250_000, // heavily strided + voxel-downsampled on the export device
    declaredPointCount: HEADER,
    decodedPointCount: 250_000,
    bounds,
    metadata: crsMeta,
  };
  const reimportDeviceCloud: StaticScanCloud = {
    name: 'site-a.laz',
    pointCount: 3_900_000, // near-full load on a larger device
    declaredPointCount: HEADER,
    decodedPointCount: 3_900_000,
    bounds,
    metadata: crsMeta,
  };

  // The summary the fixed writer emits for the static branch: `sourcePoints` via
  // the source-stable ladder (mirrored through the reader's shared rule), every
  // other field exactly as exportSession builds it.
  const exported = scanFactsFromStatic(exportDeviceCloud);
  const exportedSummary: SessionScanSummary = {
    fileName: exported.fileName!,
    sourcePoints: exported.sourcePoints!,
    width: exported.width!,
    depth: exported.depth!,
    height: exported.height!,
    ...(exported.crs ? { crs: exported.crs } : {}),
    ...(exported.epsg != null ? { epsg: exported.epsg } : {}),
  };

  const roundTrip = (summary: SessionScanSummary): SessionScanSummary | undefined =>
    parseSession(
      serializeSession({
        upAxis: 'z',
        origin: [0, 0, 0],
        unitSystem: 'imperial',
        views: [],
        measurements: [],
        annotations: [],
        scanSummary: summary,
      }),
    ).scanSummary;

  test('the serialized scanSummary stores the DECLARED header count, not the strided display sample', () => {
    const back = roundTrip(exportedSummary);
    expect(back?.sourcePoints).toBe(HEADER);
    // The pre-fix writer stored the decimated held count; that value is gone.
    expect(back?.sourcePoints).not.toBe(exportDeviceCloud.pointCount);
  });

  test('a strided export reimports STRONGLY on a fuller device', () => {
    const back = roundTrip(exportedSummary);
    const reimport = scanFactsFromStatic(reimportDeviceCloud);
    expect(matchSessionToScan(back, reimport).verdict).toBe('strong');
  });

  test('the pre-fix decimated count would downgrade that reimport to partial — the instability removed', () => {
    // What the writer stored BEFORE main.ts aligned to the ladder: the held
    // count (250k), against a 3.9M-point reimport of the same file.
    const preFix: SessionScanSummary = {
      ...exportedSummary,
      sourcePoints: exportDeviceCloud.pointCount,
    };
    const back = roundTrip(preFix);
    const reimport = scanFactsFromStatic(reimportDeviceCloud);
    const m = matchSessionToScan(back, reimport);
    expect(m.verdict).toBe('partial');
    expect(m.reasons.some((r) => /point count differs/.test(r))).toBe(true);
  });
});
