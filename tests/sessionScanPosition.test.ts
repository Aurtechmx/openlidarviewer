// What these tests would catch:
//
//  - A session saved over west.las applied with no confirmation onto east.las,
//    a tile with the same point count, spans and EPSG 1 km away.
//  - A different file name treated as disclosure only, so an unrelated scan of
//    the same size matched 'strong'.
//  - A multi-scan session compared against its top-level origin, which is the
//    project origin, instead of the origin it stored for the summary's scan.
//  - The bounds minimum dropped on save or on read.

import { describe, it, expect } from 'vitest';
import { matchSessionToScan, parseSession, serializeSession, sessionScanOrigin, type InspectionSession, type SessionScanSummary } from '../src/io/session';
import { scanFactsFromStatic } from '../src/app/sessionScanFacts';

type V3 = [number, number, number];
const WEST_ORIGIN: V3 = [500000, 4000000, 100];
const EAST_ORIGIN: V3 = [501000, 4000000, 100];

const tile = (name: string, origin: V3) => scanFactsFromStatic({
  name,
  pointCount: 50_000,
  declaredPointCount: 50_000,
  sourceOrigin: origin,
  bounds: () => ({ min: [0, 0, 0], max: [200, 200, 20] }),
  metadata: { crs: { name: 'WGS 84 / UTM zone 13N', epsg: 32613 } },
});

const summaryOf = (name: string, origin: V3, withMin = true): SessionScanSummary => ({
  fileName: name,
  sourcePoints: 50_000,
  width: 200,
  depth: 200,
  height: 20,
  crs: 'WGS 84 / UTM zone 13N',
  epsg: 32613,
  ...(withMin ? { boundsMin: [origin[0], origin[1], origin[2]] as V3 } : {}),
});

describe('matchSessionToScan with the scan position', () => {
  it('does not match west.las onto east.las 1 km away', () => {
    const m = matchSessionToScan(summaryOf('west.las', WEST_ORIGIN), tile('east.las', EAST_ORIGIN), WEST_ORIGIN);
    expect(m.verdict).toBe('conflict');
    expect(m.reasons[0]).toContain('1000.000 units');
  });

  it('refuses the shifted tile on the stored origin when the file predates the bounds minimum', () => {
    const m = matchSessionToScan(summaryOf('tile.las', WEST_ORIGIN, false), tile('tile.las', EAST_ORIGIN), WEST_ORIGIN);
    expect(m.verdict).toBe('conflict');
  });

  it('asks before applying a shift smaller than the scan', () => {
    const near: V3 = [WEST_ORIGIN[0] + 5, WEST_ORIGIN[1], WEST_ORIGIN[2]];
    expect(matchSessionToScan(summaryOf('west.las', WEST_ORIGIN), tile('west.las', near), WEST_ORIGIN).verdict).toBe('partial');
  });

  it('keeps the same scan strong', () => {
    expect(matchSessionToScan(summaryOf('west.las', WEST_ORIGIN), tile('west.las', WEST_ORIGIN), WEST_ORIGIN).verdict).toBe('strong');
    expect(matchSessionToScan(summaryOf('west.las', WEST_ORIGIN, false), tile('west.las', WEST_ORIGIN), WEST_ORIGIN).verdict).toBe('strong');
  });

  it('returns partial, not strong, for an older file whose name differs', () => {
    const m = matchSessionToScan(summaryOf('west.las', WEST_ORIGIN, false), tile('east.las', WEST_ORIGIN));
    expect(m.verdict).toBe('partial');
  });

  it('asks when the source digests differ', () => {
    const s = { ...summaryOf('west.las', WEST_ORIGIN), sha256: 'a'.repeat(64) };
    expect(matchSessionToScan(s, { ...tile('west.las', WEST_ORIGIN), sha256: 'b'.repeat(64) }, WEST_ORIGIN).verdict).toBe('partial');
  });
});

describe('the stored origin of a multi-scan session', () => {
  const base: InspectionSession = parseSession(serializeSession({
    upAxis: 'z',
    origin: [WEST_ORIGIN[0], WEST_ORIGIN[1], WEST_ORIGIN[2]],
    unitSystem: 'metric',
    views: [],
    measurements: [],
    annotations: [],
    scanSummary: summaryOf('east.las', EAST_ORIGIN),
  }));

  it('round-trips the bounds minimum', () => {
    expect(base.scanSummary?.boundsMin).toEqual(EAST_ORIGIN);
  });

  it('reads the per-layer origin of the summary scan, not the project origin', () => {
    const session: InspectionSession = {
      ...base,
      projectFrame: {
        projectOrigin: WEST_ORIGIN,
        layers: [
          { layerId: 'w', sourceFingerprint: 'w', sourceName: 'west.las', sourceOrigin: WEST_ORIGIN, sourceToProject: [0, 0, 0], upAxis: 'z' },
          { layerId: 'e', sourceFingerprint: 'e', sourceName: 'east.las', sourceOrigin: EAST_ORIGIN, sourceToProject: [1000, 0, 0], upAxis: 'z' },
        ],
      },
    };
    expect(sessionScanOrigin(session)).toEqual(EAST_ORIGIN);
    const old = { ...session, scanSummary: summaryOf('east.las', EAST_ORIGIN, false) };
    expect(matchSessionToScan(old.scanSummary, tile('east.las', EAST_ORIGIN), sessionScanOrigin(old)).verdict).toBe('strong');
  });

  it('uses the top-level origin for a single-scan session', () => {
    expect(sessionScanOrigin(base)).toEqual(WEST_ORIGIN);
  });
});
