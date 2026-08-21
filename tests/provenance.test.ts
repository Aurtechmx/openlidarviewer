/**
 * provenance.test.ts
 *
 * Verifies the capture-type classifier hits the documented signatures and
 * preserves the literature citations on every accuracy bound.
 */

import { describe, it, expect } from 'vitest';
import { classify, type ScanSignals } from '../src/diagnostics/provenance';

const blank = (): ScanSignals => ({ sourceFormat: '', pointCount: 0 });

describe('provenance — software-string classification', () => {
  it('detects Polycam exports as iPhone-LiDAR with high confidence', () => {
    const f = classify({
      ...blank(),
      sourceFormat: 'glb',
      softwareString: 'Polycam 4.2.1',
    });
    expect(f.captureType).toBe('iphone-lidar');
    expect(f.confidence).toBe('high');
    expect(f.bounds.length).toBeGreaterThan(0);
    expect(f.bounds.every((b) => b.source.length > 0)).toBe(true);
  });

  it('detects 3D Scanner App exports as iPhone-LiDAR', () => {
    const f = classify({
      ...blank(),
      sourceFormat: 'ply',
      softwareString: '3D Scanner App for iPhone',
    });
    expect(f.captureType).toBe('iphone-lidar');
  });

  it('detects Scaniverse exports', () => {
    const f = classify({
      ...blank(),
      sourceFormat: 'glb',
      softwareString: 'Scaniverse 3.0',
    });
    expect(f.captureType).toBe('iphone-lidar');
  });

  it('detects FARO Scene exports as terrestrial', () => {
    const f = classify({
      ...blank(),
      sourceFormat: 'e57',
      softwareString: 'FARO SCENE 2021',
    });
    expect(f.captureType).toBe('terrestrial');
  });

  it('detects NavVis as mobile-SLAM', () => {
    const f = classify({
      ...blank(),
      sourceFormat: 'laz',
      softwareString: 'NavVis IVION',
    });
    expect(f.captureType).toBe('mobile-slam');
  });
});

describe('provenance — sensor-string classification', () => {
  it('detects iPhone via sensor string', () => {
    const f = classify({
      ...blank(),
      sourceFormat: 'laz',
      sensorString: 'Apple iPhone 15 Pro VCSEL',
    });
    expect(f.captureType).toBe('iphone-lidar');
  });

  it('detects DJI L2 as drone-LiDAR', () => {
    const f = classify({
      ...blank(),
      sourceFormat: 'laz',
      sensorString: 'DJI L2 onboard',
    });
    expect(f.captureType).toBe('drone-lidar');
  });

  it('detects RIEGL VZ as terrestrial', () => {
    const f = classify({
      ...blank(),
      sourceFormat: 'e57',
      sensorString: 'RIEGL VZ-2000i',
    });
    expect(f.captureType).toBe('terrestrial');
  });

  it('detects GEDI as spaceborne', () => {
    const f = classify({
      ...blank(),
      sourceFormat: 'h5',
      sensorString: 'NASA GEDI L2A',
    });
    expect(f.captureType).toBe('spaceborne');
  });
});

describe('provenance — format-driven defaults', () => {
  it('defaults streaming COPC to aerial-ALS with medium confidence', () => {
    const f = classify({ ...blank(), sourceFormat: 'copc', pointCount: 5_000_000 });
    expect(f.captureType).toBe('aerial-als');
    expect(f.confidence).toBe('medium');
  });

  it('defaults EPT to aerial-ALS', () => {
    const f = classify({ ...blank(), sourceFormat: 'ept', pointCount: 50_000_000 });
    expect(f.captureType).toBe('aerial-als');
  });

  it('defaults GLB to iPhone-LiDAR when no other signal', () => {
    const f = classify({ ...blank(), sourceFormat: 'glb', pointCount: 200_000 });
    expect(f.captureType).toBe('iphone-lidar');
    expect(f.confidence).toBe('medium');
  });
});

describe('provenance — numeric classification', () => {
  it('classifies high density + small footprint as iPhone-LiDAR', () => {
    const f = classify({
      sourceFormat: 'ply',
      pointCount: 500_000,
      extent: [4, 4, 2],
      densityPerSqM: 5000,
    });
    expect(f.captureType).toBe('iphone-lidar');
  });

  it('classifies airborne-density + large footprint as aerial-ALS', () => {
    const f = classify({
      sourceFormat: 'laz',
      pointCount: 30_000_000,
      extent: [1000, 1500, 50],
      densityPerSqM: 4,
    });
    expect(f.captureType).toBe('aerial-als');
  });

  it('classifies dense UAV density + hectare footprint as drone-LiDAR', () => {
    // A dense-UAV profile: ~979 pts/m² over a ~0.98 ha strip. Dense aerial
    // mapping, not a TLS station — must read as drone, not terrestrial.
    const f = classify({
      sourceFormat: 'laz',
      pointCount: 9_597_830,
      extent: [78.8, 124.4, 18.9],
      densityPerSqM: 979,
    });
    expect(f.captureType).toBe('drone-lidar');
  });

  it('classifies a very dense low-altitude flight (>2000 pts/m²) as drone, not unknown', () => {
    // A slow, low-AGL DJI L2 pass can exceed 2000 pts/m² over an open mapping
    // footprint. A TLS station cannot lay down uniform density over thousands of
    // m², so this must read as drone-LiDAR (and at high confidence), not fall
    // through every band to unknown.
    const f = classify({
      sourceFormat: 'laz',
      pointCount: 30_000_000,
      extent: [120, 90, 25], // ~1.08 ha footprint
      densityPerSqM: 3200,
    });
    expect(f.captureType).toBe('drone-lidar');
    expect(f.confidence).toBe('high');
  });

  it('keeps a dense SMALL-footprint scan as terrestrial, not drone', () => {
    // A station-scale dense scan (< 2000 m²) stays TLS — the drone band only
    // claims open mapping footprints, so this partition has no overlap.
    const f = classify({
      sourceFormat: 'e57',
      pointCount: 3_000_000,
      extent: [30, 40, 15], // 1200 m²
      densityPerSqM: 400,
    });
    expect(f.captureType).toBe('terrestrial');
  });

  it('returns unknown when no signal matches', () => {
    const f = classify({ ...blank(), sourceFormat: 'xyz', pointCount: 100 });
    expect(f.captureType).toBe('unknown');
    expect(f.confidence).toBe('low');
  });
});

describe('provenance — citation discipline', () => {
  it('every accuracy bound names a source paper', () => {
    const fingerprints = [
      classify({ ...blank(), softwareString: 'Polycam' }),
      classify({ ...blank(), sensorString: 'DJI L2' }),
      classify({ ...blank(), sensorString: 'FARO Focus S350' }),
      classify({ ...blank(), softwareString: 'NavVis IVION' }),
      classify({ ...blank(), sourceFormat: 'copc' }),
      classify({ ...blank(), sensorString: 'GEDI' }),
    ];
    for (const f of fingerprints) {
      for (const b of f.bounds) {
        expect(b.source.length).toBeGreaterThan(0);
        expect(b.label.length).toBeGreaterThan(0);
        expect(b.value.length).toBeGreaterThan(0);
      }
    }
  });

  it('every fingerprint carries the not-survey-grade disclaimer', () => {
    const fingerprints = [
      classify({ ...blank(), softwareString: 'Polycam' }),
      classify({ ...blank(), sensorString: 'DJI L2' }),
      classify({ ...blank(), sourceFormat: 'copc' }),
    ];
    for (const f of fingerprints) {
      expect(f.disclaimer.toLowerCase()).toContain('not guarantees');
    }
  });
});

describe('provenance — purity', () => {
  it('classify is a pure function — same input, same output', () => {
    const input: ScanSignals = {
      sourceFormat: 'glb',
      pointCount: 200_000,
      softwareString: 'Polycam',
    };
    const a = classify(input);
    const b = classify(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('provenance — the phone density band is bounded above', () => {
  const station = (densityPerSqM: number): ScanSignals => ({
    sourceFormat: 'e57',
    pointCount: 465_603,
    extent: [4.83, 4.71, 3.92],
    densityPerSqM,
  });

  it('reads a dense small-footprint scan as a terrestrial station, not a phone', () => {
    // A terrestrial scanner in a pump room: 20473 pts/m² over 22.7 m². The band
    // used to have no upper bound, so every dense station under 100 m² read as
    // a phone and the panel then quoted walking-drift figures for a tripod.
    expect(classify(station(20_473)).captureType).toBe('terrestrial');
  });

  it('keeps a genuine phone scan inside the band', () => {
    expect(classify(station(3000)).captureType).toBe('iphone-lidar');
  });

  it('puts the boundary at the density the cited figures reach, inclusive', () => {
    // Luetzenburg 2021 measures 7,225 pts/m² at 25 cm, the phone's closest
    // working range. At the figure it is still a phone; above it, it is not.
    expect(classify(station(7225)).captureType).toBe('iphone-lidar');
    expect(classify(station(7226)).captureType).toBe('terrestrial');
  });

  it('names the ceiling in the signals, so the verdict shows its own reasoning', () => {
    const f = classify(station(20_473));
    expect(f.signals.join(' ')).toContain('7225');
  });

  it('leaves the aerial and drone bands where they were', () => {
    const aerial = classify({ sourceFormat: 'laz', pointCount: 1_280_000, extent: [400, 400, 60], densityPerSqM: 8 });
    const drone = classify({ sourceFormat: 'laz', pointCount: 4_320_000, extent: [120, 90, 40], densityPerSqM: 400 });
    expect(aerial.captureType).toBe('aerial-als');
    expect(drone.captureType).toBe('drone-lidar');
  });

  it('does not claim to separate the two inside the band', () => {
    // A phone and a station can both produce 3000 pts/m². The ceiling narrows an
    // unbounded rule; it does not resolve the overlap, and the confidence stays
    // medium on both sides so the override remains the answer for that case.
    expect(classify(station(3000)).confidence).toBe('medium');
    expect(classify(station(20_473)).confidence).toBe('medium');
  });
});
