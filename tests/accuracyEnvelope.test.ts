/**
 * accuracyEnvelope.test.ts — an accuracy figure only shows inside its validated
 * envelope, and the shared-solution confounder caps its evidence level.
 */

import { describe, it, expect } from 'vitest';
import {
  isWithinEnvelope, accuracyFigureFor, confounderCappedLevel,
  type AccuracyClaim, type ScanContext,
} from '../src/validation/accuracyEnvelope';

// The Marsh Island result: measured on coastal salt marsh, flat relief, UAS
// photogrammetry, matched vertical datum — and the ground shares the Metashape
// solution with the reference, so it carries the shared-solution confounder.
const MARSH: AccuracyClaim = {
  id: 'DTM-VERTICAL-ABSOLUTE/marsh-island',
  rmseM: 0.028,
  n: 101,
  envelope: {
    biomes: ['coastal-marsh'],
    reliefBands: ['flat'],
    sensorClasses: ['uav-photogrammetry'],
    datumMatch: 'matched',
  },
  sharedSolutionWithReference: true,
};

const marshLikeScan: ScanContext = { biome: 'coastal-marsh', reliefBand: 'flat', sensorClass: 'uav-photogrammetry', datumMatch: 'matched' };

describe('accuracy figures only transfer inside the validated envelope', () => {
  it('shows the figure for a scan matching the validated conditions', () => {
    expect(isWithinEnvelope(MARSH.envelope, marshLikeScan)).toBe(true);
    const d = accuracyFigureFor(marshLikeScan, MARSH);
    expect(d.allowed).toBe(true);
    expect(d.rmseM).toBe(0.028);
  });

  it('refuses the figure for a different biome (steep forest) — no overgeneralisation', () => {
    const forest: ScanContext = { biome: 'forest', reliefBand: 'steep', sensorClass: 'airborne-lidar', datumMatch: 'matched' };
    expect(isWithinEnvelope(MARSH.envelope, forest)).toBe(false);
    const d = accuracyFigureFor(forest, MARSH);
    expect(d.allowed).toBe(false);
    expect(d.reasonCode).toBe('OUTSIDE_ENVELOPE');
    expect(d.rmseM).toBeUndefined();
  });

  it('refuses when relief differs even if biome/sensor match (flat validation, steep scan)', () => {
    const steep: ScanContext = { ...marshLikeScan, reliefBand: 'steep' };
    expect(accuracyFigureFor(steep, MARSH).allowed).toBe(false);
  });

  it('fails closed on any unknown scan fact', () => {
    for (const bad of [
      { ...marshLikeScan, biome: 'unknown' as const },
      { ...marshLikeScan, reliefBand: 'unknown' as const },
      { ...marshLikeScan, sensorClass: 'unknown' as const },
      { ...marshLikeScan, datumMatch: 'unknown' as const },
    ]) {
      expect(accuracyFigureFor(bad, MARSH).allowed).toBe(false);
    }
  });

  it('refuses when the scan datum is weaker than the validation (matched-validated, unreconciled scan)', () => {
    const weakDatum: ScanContext = { ...marshLikeScan, datumMatch: 'unreconciled' };
    expect(isWithinEnvelope(MARSH.envelope, weakDatum)).toBe(false);
  });
});

describe('shared-solution confounder caps the evidence level', () => {
  it('a shared-solution checkpoint leg cannot reach the external tier — held at cross-implementation', () => {
    expect(confounderCappedLevel('E5_EXTERNALLY_VALIDATED', MARSH)).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
  });

  it('a genuinely independent checkpoint leg is not capped', () => {
    const independent: AccuracyClaim = { ...MARSH, sharedSolutionWithReference: false };
    expect(confounderCappedLevel('E5_EXTERNALLY_VALIDATED', independent)).toBe('E5_EXTERNALLY_VALIDATED');
  });

  it('the cap never RAISES a level (a lower nominal stays where it is)', () => {
    expect(confounderCappedLevel('E3_SYNTHETICALLY_VALIDATED', MARSH)).toBe('E3_SYNTHETICALLY_VALIDATED');
  });
});
