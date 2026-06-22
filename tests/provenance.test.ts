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
    // The FLEXIGROBOTS profile: ~979 pts/m² over a ~0.98 ha strip. Dense aerial
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
