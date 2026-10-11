/**
 * changePropagatedLod.test.ts — the propagated minimum level of detection
 * (Wheaton et al. 2010): LoD = 1.96 · sqrt(σz_before² + σz_after² + σreg²).
 *
 * Known answer: σz 0.03 m and 0.04 m with σreg 0.12 m give a combined σ of
 * exactly 0.13 m (a 3-4-12-13 quadruple), so LoD = 1.96 × 0.13 = 0.2548 m.
 */

import { describe, it, expect } from 'vitest';
import { compareDtms, summarizeChange } from '../src/terrain/change/compareDtms';
import { buildSharedEpochDtms } from '../src/terrain/change/compareEpochs';
import { detectChange } from '../src/terrain/change/changeDetection';
import {
  describeLevelOfDetection,
  propagatedLevelOfDetection,
  VERTICAL_OFFSET_DISCLOSURE,
} from '../src/terrain/change/propagatedLod';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const COLS = 10;
const ROWS = 10;

function flat(height: number): DtmGrid {
  return {
    z: Float32Array.from({ length: COLS * ROWS }, () => height),
    coverage: Uint8Array.from({ length: COLS * ROWS }, () => 1),
    cols: COLS,
    rows: ROWS,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
    crs: 'EPSG:32610',
    verticalDatum: 'EPSG:5703',
  } as unknown as DtmGrid;
}

const KNOWN = { sigmaZBeforeM: 0.03, sigmaZAfterM: 0.04, sigmaRegM: 0.12 };

describe('propagated level of detection', () => {
  it('computes the known answer from the three σ terms', () => {
    const lod = propagatedLevelOfDetection(KNOWN);
    expect(lod.basis).toBe('propagated');
    expect(lod.valueM).toBeCloseTo(0.2548, 10);
    expect(lod.missing).toEqual([]);
    // The band's random σ excludes registration (it is the separate systematic term).
    expect(lod.cellSigmaM).toBeCloseTo(0.05, 10);
    const text = describeLevelOfDetection(lod).join('\n');
    expect(text).toMatch(/0\.255 m \(propagated, 95 %\)/);
    expect(text).toMatch(/before σz 30\.0 mm/);
    expect(text).toMatch(/after σz 40\.0 mm/);
    expect(text).toMatch(/3-D RMS, a conservative proxy/);
    expect(text).toMatch(/Wheaton et al\. 2010/);
  });

  it('falls back to the fixed 0.1 m, labelled assumed, when a term is missing', () => {
    for (const missing of ['sigmaZBeforeM', 'sigmaZAfterM', 'sigmaRegM'] as const) {
      const lod = propagatedLevelOfDetection({ ...KNOWN, [missing]: null });
      expect(lod.basis).toBe('assumed');
      expect(lod.valueM).toBe(0.1);
      expect(lod.missing).toHaveLength(1);
      expect(describeLevelOfDetection(lod).join('\n')).toMatch(/assumed, not measured/);
    }
    // A zero registration RMS (no alignment applied) is a missing term, not a perfect fit.
    expect(propagatedLevelOfDetection({ ...KNOWN, sigmaRegM: 0 }).basis).toBe('assumed');
  });

  it('keeps a user override and labels it user-set', () => {
    const lod = propagatedLevelOfDetection({ ...KNOWN, userLodM: 0.05 });
    expect(lod.basis).toBe('user-set');
    expect(lod.valueM).toBe(0.05);
    expect(describeLevelOfDetection(lod)[0]).toMatch(/0\.050 m \(user-set\)/);
  });

  it('reclassifies cells and volumes against the propagated threshold', () => {
    // Every cell rises 0.2 m: above the 0.1 m default, below the 0.2548 m propagated LoD.
    const fixed = compareDtms(flat(10), flat(10.2));
    expect(fixed.levelOfDetection.basis).toBe('assumed');
    expect(fixed.result.stats.gained).toBe(COLS * ROWS);
    expect(fixed.result.stats.detectableGainVolumeM3).toBeCloseTo(20, 3);

    const prop = compareDtms(flat(10), flat(10.2), { levelOfDetection: propagatedLevelOfDetection(KNOWN) });
    expect(prop.levelOfDetectionM).toBeCloseTo(0.2548, 10);
    expect(prop.result.stats.gained).toBe(0);
    expect(prop.result.stats.unchanged).toBe(COLS * ROWS);
    expect(prop.result.stats.detectableGainVolumeM3).toBe(0);
    // The raw net is unthresholded and does not move.
    expect(prop.result.stats.rawNetVolumeM3).toBeCloseTo(fixed.result.stats.rawNetVolumeM3, 6);
  });

  it('states the LoD basis and the vertical-offset disclosure in the report', () => {
    const prop = compareDtms(flat(10), flat(10.3), { levelOfDetection: propagatedLevelOfDetection(KNOWN) });
    const lines = summarizeChange(prop, { horizontalUnitToMetres: 1, registrationSigmaM: 0.12 });
    const text = lines.join('\n');
    expect(text).toMatch(/Level of detection: 0\.255 m \(propagated, 95 %\)/);
    expect(text).toContain(VERTICAL_OFFSET_DISCLOSURE);
    expect(text).toMatch(/stable/);
    // The default-LoD caveat does not apply to a propagated threshold.
    expect(text).not.toMatch(/this build's default/);

    const assumed = summarizeChange(compareDtms(flat(10), flat(10.3)), { horizontalUnitToMetres: 1 }).join('\n');
    expect(assumed).toMatch(/0\.100 m \(assumed, not measured\)/);
    expect(assumed).toContain(VERTICAL_OFFSET_DISCLOSURE);
  });
});

describe('per-epoch hold-out σz on the shared grid', () => {
  it('returns a finite RMSEz per epoch when requested, and nothing otherwise', () => {
    // A gently sloped plane, 1 m spacing jittered deterministically, ±2 cm noise.
    const pts: number[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let x = 0; x < 40; x += 0.5) {
      for (let y = 0; y < 40; y += 0.5) {
        pts.push(x + rnd() * 0.1, y + rnd() * 0.1, 0.02 * x + (rnd() - 0.5) * 0.04);
      }
    }
    const cloud = { positions: Float32Array.from(pts), crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', linearUnitToMetres: 1 };
    expect(buildSharedEpochDtms(cloud, cloud)?.sigmaZ).toBeUndefined();
    const dtms = buildSharedEpochDtms(cloud, cloud, { holdoutSigmaZ: true });
    const s = dtms?.sigmaZ;
    expect(s?.before).not.toBeNull();
    expect(s?.before as number).toBeGreaterThan(0);
    expect(s?.before as number).toBeLessThan(0.1);
    expect(s?.after).toBeCloseTo(s?.before as number, 12);
  });
});

describe('LoD units: every term and the DoD it thresholds are metres', () => {
  const FTUS = 1200 / 3937;
  // Known answer in metres: 0.03, 0.04, 0.12 -> combined 0.13 -> LoD 0.2548 m.
  const SZ_B = 0.03;
  const SZ_A = 0.04;
  const REG = 0.12;
  const LOD = 1.96 * 0.13;

  /** Build source-unit inputs, convert with the CRS factors as upstream does, and threshold. */
  function run(hToM: number, vToM: number) {
    // Source-unit values as the hold-out and ICP would measure them.
    const rmseBSrc = SZ_B / vToM;
    const rmseASrc = SZ_A / vToM;
    const residSrc = REG / hToM;
    const lod = propagatedLevelOfDetection({
      sigmaZBeforeM: rmseBSrc * vToM,
      sigmaZAfterM: rmseASrc * vToM,
      sigmaRegM: residSrc * hToM,
    });
    // Two cells: a rise just above and just below the LoD, in SOURCE vertical units.
    const above = (LOD + 0.001) / vToM;
    const below = (LOD - 0.001) / vToM;
    const a = { width: 2, height: 1, cellSizeM: 1, values: Float32Array.from([0, 0]) };
    const b = { width: 2, height: 1, cellSizeM: 1, values: Float32Array.from([above, below]) };
    const res = detectChange(a, b, {
      levelOfDetectionM: lod.valueM,
      horizontalUnitToMetres: hToM,
      verticalUnitToMetres: vToM,
    });
    return { lod, res };
  }

  it('metre horizontal + metre vertical', () => {
    const { lod, res } = run(1, 1);
    expect(lod.basis).toBe('propagated');
    expect(lod.valueM).toBeCloseTo(LOD, 9);
    expect(Array.from(res.classes)).toEqual([1, 0]);
  });

  it('US survey foot horizontal + US survey foot vertical', () => {
    const { lod, res } = run(FTUS, FTUS);
    expect(lod.valueM).toBeCloseTo(LOD, 9);
    expect(res.diff[0]).toBeCloseTo(LOD + 0.001, 5);
    expect(Array.from(res.classes)).toEqual([1, 0]);
  });

  it('metre horizontal + US survey foot vertical (compound)', () => {
    const { lod, res } = run(1, FTUS);
    expect(lod.valueM).toBeCloseTo(LOD, 9);
    expect(res.diff[1]).toBeCloseTo(LOD - 0.001, 5);
    expect(Array.from(res.classes)).toEqual([1, 0]);
  });

  it('unknown units fall back to the assumed default and say why', () => {
    const lod = propagatedLevelOfDetection({
      sigmaZBeforeM: 0.03,
      sigmaZAfterM: 0.04,
      sigmaRegM: 0.12,
      verticalUnitKnown: false,
      horizontalUnitKnown: false,
    });
    expect(lod.basis).toBe('assumed');
    expect(lod.valueM).toBe(0.1);
    expect(lod.sigmaZBeforeM).toBeNull();
    expect(lod.sigmaRegM).toBeNull();
    const text = describeLevelOfDetection(lod).join(' ');
    expect(text).toContain('vertical unit unknown');
    expect(text).toContain('horizontal unit unknown');
    expect(text).toContain('assumed, not measured');
  });

  it('an unknown horizontal unit alone drops only σreg', () => {
    const lod = propagatedLevelOfDetection({
      sigmaZBeforeM: 0.03, sigmaZAfterM: 0.04, sigmaRegM: 0.12, horizontalUnitKnown: false,
    });
    expect(lod.basis).toBe('assumed');
    expect(lod.sigmaZBeforeM).toBe(0.03);
    expect(lod.missing).toEqual(['registration σ (horizontal unit unknown, cannot be expressed in metres)']);
  });
});
