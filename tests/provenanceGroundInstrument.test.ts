/**
 * provenanceGroundInstrument.test.ts
 *
 * A registered multi-station terrestrial E57 was reported as "Aerial /
 * airborne LiDAR (ALS), medium confidence" on the evidence "Density: 1.9
 * pts/m² over a 1434.0 ha footprint", and the panel then quoted USGS airborne
 * accuracy figures for a tripod survey. Two causes:
 *
 *   1. The E57 loader replaced `captureSensor` with a station count, so the
 *      declared instrument never reached `matchSensorString` — the TLS token
 *      list already carried the make.
 *   2. The density heuristic asserted an airborne capture type over a file
 *      whose own declarations describe a ground-based instrument set-up.
 *
 * The band boundaries (airborne LAS, drone survey, phone including its 7225
 * pts/m² ceiling) must be exactly where they were.
 */

import { describe, it, expect } from 'vitest';
import { classify, type CaptureType } from '../src/diagnostics/provenance';
import {
  signalsForStaticCloud,
  type StaticCloudShape,
} from '../src/diagnostics/provenanceSignals';

const AERIAL: readonly CaptureType[] = ['drone-lidar', 'aerial-als', 'spaceborne'];

/** 4000 m × 3585 m = 1434.0 ha; 27,246,000 points over it = 1.9 pts/m². */
const MINE_EXTENT = { min: [0, 0, 0] as const, max: [4000, 3585, 190] as const };
const MINE_POINTS = 27_246_000;

/** One declared field, as `readSourceMetadata` emits it. */
const f = (name: string, value: string): { name: string; value: string } => ({ name, value });

/**
 * The declared block a registered multi-station scan carries: per-scan name,
 * guid, instrument identity, serial and the atmospheric readings taken at each
 * set-up. Multi-scan files number every per-scan field ("scan 7 sensorModel").
 */
function stationBlock(
  stations: number,
  vendor: string,
  model: string,
): { standard: { name: string; value: string }[]; extensions: { name: string; value: string }[] } {
  const standard = [
    f('guid', '{6F1A9C40-0F1B-4E9A-9B4C-2D2E4A7F1C55}'),
    f('e57LibraryVersion', 'libE57 1.1.332'),
    f('creationDateTime', '2024-06-11T08:14:02Z'),
  ];
  for (let i = 1; i <= stations; i++) {
    standard.push(f(`scan ${i} name`, `ScanPos${i.toString().padStart(3, '0')}`));
    standard.push(f(`scan ${i} guid`, `{0000000${i}-0000-4000-8000-000000000000}`));
    standard.push(f(`scan ${i} sensorVendor`, vendor));
    standard.push(f(`scan ${i} sensorModel`, model));
    standard.push(f(`scan ${i} sensorSerialNumber`, 'S2220512'));
    standard.push(f(`scan ${i} temperature`, '19.4'));
    standard.push(f(`scan ${i} relativeHumidity`, '46'));
    standard.push(f(`scan ${i} atmosphericPressure`, '96350'));
  }
  return { standard, extensions: [f('rlms:pointRecordDataType', 'compressed')] };
}

/** The reported scan: 10 registered stations of one instrument over a mine. */
function mineCloud(metadata: StaticCloudShape['metadata']): StaticCloudShape {
  return {
    sourceFormat: 'e57',
    pointCount: MINE_POINTS,
    bounds: () => MINE_EXTENT,
    // A DECLARED metre unit. These tests are about what the capture classifier
    // infers, so the scan must be one whose extent is actually in metres; a
    // cloud with no declared unit now yields no metric signals at all (see
    // provenanceUnitAuthority.test.ts), which is a different question.
    metadata: { ...metadata, crs: { linearUnitToMetres: 1 } },
  };
}

describe('capture type — a registered multi-station terrestrial scan', () => {
  it('carries the declared instrument, not the merge summary, as the sensor string', () => {
    const s = signalsForStaticCloud(
      mineCloud({
        // What the loader composes for a merged multi-scan file.
        captureSensor: 'VZ-1000 (10 merged scans)',
        sourceMetadata: stationBlock(10, 'RIEGL', 'VZ-1000'),
      }),
    );
    // Vendor first: the sensor matcher keys on make plus series, which the
    // bare model does not carry.
    expect(s.sensorString).toBe('RIEGL VZ-1000');
    expect(s.densityPerSqM).toBeCloseTo(1.9, 10);
  });

  it('classifies the mine scan as terrestrial at high confidence', () => {
    const fp = classify(
      signalsForStaticCloud(
        mineCloud({
          captureSensor: 'VZ-1000 (10 merged scans)',
          sourceMetadata: stationBlock(10, 'RIEGL', 'VZ-1000'),
        }),
      ),
    );
    expect(fp.captureType).toBe('terrestrial');
    expect(fp.confidence).toBe('high');
    expect(fp.label).toBe('Terrestrial Laser Scan (TLS)');
    // The panel shows what decided it, and no USGS airborne ribbon is quoted.
    expect(fp.signals).toContain('Sensor: RIEGL VZ-1000');
    expect(fp.signals.join(' ')).not.toMatch(/ha footprint/);
    expect(fp.bounds.some((b) => /USGS/.test(b.label) || /USGS/.test(b.value))).toBe(false);
  });

  it('still reads aerial at the same density when the file declares nothing', () => {
    // Without evidence, the density guess is the honest answer: 1.9 pts/m²
    // over 1434 ha is the USGS QL2 signature.
    const fp = classify(signalsForStaticCloud(mineCloud({})));
    expect(fp.captureType).toBe('aerial-als');
    expect(fp.confidence).toBe('medium');
    expect(fp.signals).toContain('Density: 1.9 pts/m² over a 1434.0 ha bounding-box footprint');
  });

  it('does not assert airborne when the declared instrument is an unrecognised make', () => {
    // Same density, same footprint, a make no token list carries. The density
    // heuristic may not contradict the file's own station declarations.
    const fp = classify(
      signalsForStaticCloud(
        mineCloud({ sourceMetadata: stationBlock(10, 'Z+F', 'IMAGER 5016') }),
      ),
    );
    expect(AERIAL).not.toContain(fp.captureType);
    expect(fp.captureType).toBe('unknown');
    expect(fp.confidence).toBe('low');
    expect(fp.label).toBe('Ground-based scan — capture method not determined');
    expect(fp.bounds).toEqual([]);
    // The density evidence stays visible, with the reason it was not enough.
    expect(fp.signals).toContain('Density: 1.9 pts/m² over a 1434.0 ha bounding-box footprint');
    const why = fp.signals.join(' ');
    expect(why).toMatch(/10 registered scan stations/);
    expect(why).toMatch(/per-scan temperature \/ relativeHumidity \/ atmosphericPressure/);
    expect(why).toMatch(/airborne capture ruled out/i);
  });
});

describe('capture type — what counts as declared ground-based evidence', () => {
  const declared = (metadata: StaticCloudShape['metadata']): string | undefined =>
    signalsForStaticCloud(mineCloud(metadata)).declaredGroundInstrument;

  it('counts two or more registered scan stations', () => {
    expect(declared({ sourceMetadata: { standard: [
      f('scan 1 name', 'ScanPos001'),
      f('scan 2 name', 'ScanPos002'),
    ], extensions: [] } })).toBe('2 registered scan stations');
  });

  it('counts the atmospheric readings taken at a set-up, on a single-scan file', () => {
    // A single-scan file uses the plain field names, so the station count is
    // zero and the set-up readings are the evidence.
    const metadata = {
      sourceMetadata: {
        standard: [f('sensorModel', 'IMAGER 5016'), f('temperature', '19.4')],
        extensions: [],
      },
    };
    expect(declared(metadata)).toBe('per-scan temperature');
    expect(AERIAL).not.toContain(classify(signalsForStaticCloud(mineCloud(metadata))).captureType);
  });

  it('counts a recorded scanner set-up position', () => {
    const metadata = { scannerOrigin: [412_355.2, 4_601_882.7, 1_640.5] as const };
    expect(declared(metadata)).toBe('a recorded scanner set-up position');
    expect(AERIAL).not.toContain(classify(signalsForStaticCloud(mineCloud(metadata))).captureType);
  });

  it('does NOT count a bare sensor model, so an instrument-tagged file can still read aerial', () => {
    // A declared model that names a ground-based instrument is matched
    // outright a step earlier; counting an unrecognised one here would rule
    // out aerial for every file that names its sensor.
    const metadata = {
      sourceMetadata: {
        standard: [f('sensorVendor', 'Acme'), f('sensorModel', 'AeroScan 900')],
        extensions: [],
      },
    };
    expect(declared(metadata)).toBeUndefined();
    expect(classify(signalsForStaticCloud(mineCloud(metadata))).captureType).toBe('aerial-als');
  });

  it('does NOT count a LAS System Identifier — no declared block, no guard', () => {
    expect(declared({ captureSensor: 'Optech Galaxy T2000' })).toBeUndefined();
  });

  it('invariant: declared station evidence never yields an aerial capture type', () => {
    for (const densityPerSqM of [0.6, 1.9, 8, 40, 120, 400, 1500]) {
      for (const [w, d] of [[4000, 3585], [500, 400], [160, 130]] as const) {
        const fp = classify({
          sourceFormat: 'e57',
          pointCount: Math.round(densityPerSqM * w * d),
          extent: [w, d, 40],
          densityPerSqM,
          declaredGroundInstrument: '6 registered scan stations',
        });
        expect(AERIAL, `density ${densityPerSqM} over ${w}x${d}`).not.toContain(fp.captureType);
      }
    }
  });

  it('bounds that invariant: a recognised airborne instrument still decides', () => {
    // The guard is built at the seam where the indirect guesses start, after
    // the software-string and sensor-string steps have returned. Declared
    // set-up evidence therefore never reaches a recognised instrument match,
    // in either direction.
    const setUp = '10 registered scan stations, per-scan temperature';
    const byDrone = classify({
      sourceFormat: 'e57',
      pointCount: 4_320_000,
      extent: [120, 90, 40],
      densityPerSqM: 400,
      sensorString: 'DJI L2',
      declaredGroundInstrument: setUp,
    });
    expect(byDrone.captureType).toBe('drone-lidar');
    expect(byDrone.confidence).toBe('high');
    expect(byDrone.signals).toContain('Sensor: DJI L2');
    expect(byDrone.signals.join(' ')).not.toMatch(/ruled out/i);

    const bySpaceborne = classify({
      sourceFormat: 'e57',
      pointCount: 12_000,
      extent: [30_000, 30_000, 400],
      densityPerSqM: 0.00001,
      sensorString: 'GEDI L2A',
      declaredGroundInstrument: setUp,
    });
    expect(bySpaceborne.captureType).toBe('spaceborne');
    expect(bySpaceborne.confidence).toBe('high');
  });

  it('a recognised terrestrial instrument decides against an airborne density', () => {
    // 1,788,994 points over 135.4 m x 165.6 m is 79.8 pts/m² across 2.24 ha,
    // which is the drone band at provenance.ts. A declared RIEGL VZ model is
    // matched a step earlier and carries no ground set-up evidence with it.
    const slope = {
      sourceFormat: 'e57',
      pointCount: 1_788_994,
      extent: [135.351, 165.609, 49.931] as const,
      densityPerSqM: 79.81,
    };
    expect(classify(slope).captureType).toBe('drone-lidar');
    const named = classify({ ...slope, sensorString: 'RIEGL VZ-2000' });
    expect(named.captureType).toBe('terrestrial');
    expect(named.confidence).toBe('high');
    expect(named.signals).toContain('Sensor: RIEGL VZ-2000');
  });
});

describe('capture type — the other bands are unchanged', () => {
  it('a genuine airborne LAS delivery still reads aerial ALS, from the declared instrument', () => {
    const s = signalsForStaticCloud({
      sourceFormat: 'laz',
      pointCount: 6_400_000,
      bounds: () => ({ min: [0, 0, 0], max: [2000, 1600, 240] }),
      metadata: { captureSensor: 'Optech Galaxy T2000', crs: { linearUnitToMetres: 1 } },
    });
    const fp = classify(s);
    expect(s.sensorString).toBe('Optech Galaxy T2000');
    expect(s.declaredGroundInstrument).toBeUndefined();
    expect(fp.captureType).toBe('aerial-als');
    // The header names an airborne instrument, so the answer is declared
    // rather than inferred from the 2 pts/m² density band it used to fall to.
    expect(fp.confidence).toBe('high');
    expect(fp.signals).toContain('Sensor: Optech Galaxy T2000');
  });

  it('a genuine airborne LAS delivery with no sensor string still reads aerial ALS from density', () => {
    const s = signalsForStaticCloud({
      sourceFormat: 'laz',
      pointCount: 6_400_000,
      bounds: () => ({ min: [0, 0, 0], max: [2000, 1600, 240] }),
      metadata: { crs: { linearUnitToMetres: 1 } },
    });
    const fp = classify(s);
    expect(fp.captureType).toBe('aerial-als');
    expect(fp.confidence).toBe('medium');
    expect(fp.signals).toContain('Density: 2.0 pts/m² over a 320.0 ha bounding-box footprint');
  });

  it('a spaceborne sensor string still wins outright', () => {
    const fp = classify({
      sourceFormat: 'laz',
      pointCount: 12_000,
      extent: [30_000, 30_000, 400],
      densityPerSqM: 0.00001,
      sensorString: 'GEDI L2A',
    });
    expect(fp.captureType).toBe('spaceborne');
    expect(fp.confidence).toBe('high');
  });

  it('a drone survey still reads drone LiDAR, by sensor and by density', () => {
    const bySensor = classify({
      sourceFormat: 'laz',
      pointCount: 4_320_000,
      extent: [120, 90, 40],
      densityPerSqM: 400,
      sensorString: 'DJI L2',
    });
    expect(bySensor.captureType).toBe('drone-lidar');
    expect(bySensor.confidence).toBe('high');

    const byDensity = classify({
      sourceFormat: 'laz',
      pointCount: 4_320_000,
      extent: [120, 90, 40],
      densityPerSqM: 400,
    });
    expect(byDensity.captureType).toBe('drone-lidar');
    expect(byDensity.confidence).toBe('medium');
  });

  it('the phone band keeps its 7225 pts/m² ceiling, inclusive', () => {
    const station = (densityPerSqM: number): CaptureType =>
      classify({
        sourceFormat: 'e57',
        pointCount: 465_603,
        extent: [4.83, 4.71, 3.92],
        densityPerSqM,
      }).captureType;
    expect(station(3000)).toBe('iphone-lidar');
    expect(station(7225)).toBe('iphone-lidar');
    expect(station(7226)).toBe('terrestrial');
  });

  it('the phone band is unchanged through the signal wiring', () => {
    // 2.4 m × 3.1 m room, 55,000 points ≈ 7392 pts/m² — above the ceiling.
    const fp = classify(
      signalsForStaticCloud({
        sourceFormat: 'ply',
        pointCount: 55_000,
        bounds: () => ({ min: [0, 0, 0], max: [2.4, 3.1, 2.5] }),
        metadata: { crs: { linearUnitToMetres: 1 } },
      }),
    );
    expect(fp.captureType).toBe('terrestrial');
    expect(
      classify(
        signalsForStaticCloud({
          sourceFormat: 'ply',
          pointCount: 22_000,
          bounds: () => ({ min: [0, 0, 0], max: [2.4, 3.1, 2.5] }),
          metadata: { crs: { linearUnitToMetres: 1 } },
        }),
      ).captureType,
    ).toBe('iphone-lidar');
  });

  it('the object-shape guard still fires, and still names geometry as the reason', () => {
    const fp = classify({
      sourceFormat: 'xyz',
      pointCount: 1_564_029,
      extent: [50, 54, 47],
      densityPerSqM: 572,
      isNonTerrain: true,
    });
    expect(fp.captureType).toBe('unknown');
    expect(fp.signals.some((s) => /ruled out by geometry/.test(s))).toBe(true);
  });
});
