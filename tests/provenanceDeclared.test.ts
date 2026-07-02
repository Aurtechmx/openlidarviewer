/**
 * provenanceDeclared.test.ts
 *
 * v0.5.4 capture-type honesty: when a file's own declared source metadata
 * states a synthetic / procedural / reconstruction / reference origin, the
 * classifier's verdict must QUOTE the declaration and demote its density
 * heuristic to a secondary, low-confidence line — never assert a physical
 * capture type ("Drone-mounted LiDAR") the file itself contradicts.
 *
 * Also pinned: absence of declared metadata leaves the classifier's
 * behaviour byte-identical to before.
 */

import { describe, it, expect } from 'vitest';
import { classify } from '../src/diagnostics/provenance';
import type { ScanSignals } from '../src/diagnostics/provenance';
import { signalsForStaticCloud } from '../src/diagnostics/provenanceSignals';
// The keyword scan lives in the loader-side module so the startup shell
// never carries it — see diagnostics/declaredCapture.ts. The loader attach
// (loadE57 → CloudMetadata.declaredCapture) is pinned in loadE57Merge.test.ts.
import { declaredCaptureFromSourceMetadata } from '../src/diagnostics/declaredCapture';

/**
 * The Tikal probe's numeric signature: ~470 K points over a 50 × 54 m
 * footprint → ~174 pts/m² over 2 700 m², which the heuristic chain reads as
 * drone-mounted UAV ALS at medium confidence.
 */
const TIKAL_SIGNALS: ScanSignals = {
  sourceFormat: 'e57',
  pointCount: 469_703,
  extent: [50, 54, 47.16],
  densityPerSqM: 469_703 / (50 * 54),
};

const TIKAL_SOURCE_METADATA = {
  standard: [
    { name: 'sensorVendor', value: 'Aurtech' },
    { name: 'sensorModel', value: 'Procedural heritage reference reconstruction' },
    { name: 'name', value: 'Tikal Temple I synthetic reference model — A. Urias / Aurtech' },
  ],
  extensions: [
    { name: 'datasetType', value: 'synthetic_reference_reconstruction' },
    { name: 'accuracyClass', value: 'reference_based_not_survey_grade' },
  ],
};

describe('classify — declared capture demotion', () => {
  const f = classify({
    ...TIKAL_SIGNALS,
    declaredCapture: declaredCaptureFromSourceMetadata(TIKAL_SOURCE_METADATA),
  });

  it('makes the declaration the primary verdict, quoted verbatim', () => {
    expect(f.label).toBe(
      'Declared: Procedural heritage reference reconstruction (from file metadata)',
    );
  });

  it('never asserts the UAV-ALS heuristic as primary', () => {
    expect(f.label).not.toMatch(/drone|UAV/i);
    expect(f.captureType).toBe('unknown');
  });

  it('demotes the heuristic guess to a secondary, low-confidence signal line', () => {
    const demoted = f.signals.find((s) => /heuristic guess/i.test(s));
    expect(demoted).toBeDefined();
    expect(demoted).toContain('secondary, low confidence');
    expect(demoted).toContain('Drone-mounted LiDAR (UAV ALS)');
  });

  it('carries the not-verified disclosure on the declaration itself', () => {
    expect(f.signals[0]).toContain('Declared sensorModel:');
    expect(f.signals[0]).toContain('"Procedural heritage reference reconstruction"');
    expect(f.signals[0]).toContain('declared by the file, not verified by OpenLiDARViewer');
    expect(f.disclaimer).toContain('not verified by OpenLiDARViewer');
  });

  it('attaches no literature accuracy bounds to a declared synthetic source', () => {
    expect(f.bounds).toEqual([]);
  });

  it('omits the demoted-heuristic line when the heuristic itself is unknown', () => {
    const g = classify({
      sourceFormat: 'e57',
      pointCount: 10,
      declaredCapture: declaredCaptureFromSourceMetadata({
        standard: [],
        extensions: [{ name: 'datasetType', value: 'synthetic_reference_reconstruction' }],
      }),
    });
    expect(g.label).toContain('Declared: synthetic_reference_reconstruction');
    expect(g.signals.some((s) => /heuristic guess/i.test(s))).toBe(false);
  });
});

describe('classify — behaviour unchanged when metadata is absent', () => {
  it('still reads the Tikal numeric signature as drone-lidar without a declaration', () => {
    const f = classify(TIKAL_SIGNALS);
    expect(f.captureType).toBe('drone-lidar');
    expect(f.label).toBe('Drone-mounted LiDAR (UAV ALS)');
    expect(f.confidence).toBe('medium');
  });

  it('leaves software/sensor-string verdicts untouched', () => {
    const f = classify({
      sourceFormat: 'laz',
      pointCount: 1_000_000,
      softwareString: 'Polycam 4.1.0',
    });
    expect(f.captureType).toBe('iphone-lidar');
    expect(f.confidence).toBe('high');
  });
});

describe('declaredCaptureFromSourceMetadata', () => {
  it('finds the synthetic declaration and quotes sensorModel preferentially', () => {
    const d = declaredCaptureFromSourceMetadata(TIKAL_SOURCE_METADATA);
    expect(d).toMatchObject({
      field: 'sensorModel',
      value: 'Procedural heritage reference reconstruction',
    });
    // The display strings are pre-built here (lazy chunk) so the startup
    // shell carries no wording.
    expect(d?.label).toBe(
      'Declared: Procedural heritage reference reconstruction (from file metadata)',
    );
    expect(d?.signal).toContain('declared by the file, not verified by OpenLiDARViewer');
    expect(d?.disclaimer).toContain('not verified by OpenLiDARViewer');
  });

  it('falls back to datasetType when sensorModel is not declared', () => {
    const d = declaredCaptureFromSourceMetadata({
      standard: [],
      extensions: [{ name: 'datasetType', value: 'synthetic_reference_reconstruction' }],
    });
    expect(d).toMatchObject({
      field: 'datasetType',
      value: 'synthetic_reference_reconstruction',
    });
  });

  it('quotes the matched field itself when neither preferred field exists', () => {
    const d = declaredCaptureFromSourceMetadata({
      standard: [{ name: 'description', value: 'A procedural test scene' }],
      extensions: [],
    });
    expect(d).toMatchObject({ field: 'description', value: 'A procedural test scene' });
  });

  it('is case-insensitive over the keyword set', () => {
    const d = declaredCaptureFromSourceMetadata({
      standard: [{ name: 'sensorModel', value: 'SYNTHETIC rig v2' }],
      extensions: [],
    });
    expect(d?.value).toBe('SYNTHETIC rig v2');
  });

  it('returns undefined when nothing declares a non-physical origin', () => {
    expect(
      declaredCaptureFromSourceMetadata({
        standard: [
          { name: 'sensorVendor', value: 'RIEGL' },
          { name: 'sensorModel', value: 'VZ-400i' },
        ],
        extensions: [{ name: 'license', value: 'CC-BY-4.0' }],
      }),
    ).toBeUndefined();
    expect(declaredCaptureFromSourceMetadata(undefined)).toBeUndefined();
  });
});

describe('signalsForStaticCloud — declaredCapture wiring', () => {
  it('threads the load-time declaredCapture from cloud.metadata', () => {
    const signals = signalsForStaticCloud({
      sourceFormat: 'e57',
      pointCount: 469_703,
      bounds: () => ({ min: [0, 0, 0], max: [50, 54, 47.16] }),
      metadata: {
        declaredCapture: declaredCaptureFromSourceMetadata(TIKAL_SOURCE_METADATA),
      },
    });
    expect(signals.declaredCapture).toMatchObject({
      field: 'sensorModel',
      value: 'Procedural heritage reference reconstruction',
    });
    // End-to-end through classify: the declared verdict wins.
    const f = classify(signals);
    expect(f.label).toContain('Declared: Procedural heritage reference reconstruction');
  });

  it('leaves declaredCapture undefined when metadata is absent', () => {
    const signals = signalsForStaticCloud({ sourceFormat: 'laz', pointCount: 5 });
    expect(signals.declaredCapture).toBeUndefined();
  });
});
