/**
 * Alignment must not change how a dataset's vertical axis is interpreted.
 *
 * `alignEpochClouds` rebuilds the aligned epoch as a fresh `EpochCloud` literal.
 * That literal carried crs, verticalDatum, isGeographic and linearUnitToMetres
 * under a comment saying "Unit info must survive alignment" — and omitted
 * `verticalUnitToMetres`. On a compound frame (foot heights over a metre grid)
 * the unaligned epoch knows Z is 0.3048 m per unit and the aligned one does not,
 * so the ground filter downstream silently falls back to the horizontal factor.
 * The same pair would then be interpreted one way aligned and another way not.
 */
import { describe, it, expect } from 'vitest';
import { alignEpochClouds } from '../src/terrain/change/alignEpochs';
import type { EpochCloud } from '../src/terrain/change/compareEpochs';

/** A small gridded patch, enough for the fit to have correspondences. */
function patch(dx = 0): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 24; j++) {
      out.push(i * 2 + dx, j * 2, 5 + Math.sin(i * 0.4) * Math.cos(j * 0.4));
    }
  }
  return new Float32Array(out);
}

/** Foot heights over a metre grid: the two factors genuinely differ. */
const compound = (positions: Float32Array): EpochCloud => ({
  positions,
  origin: [500_000, 4_400_000, 0],
  crs: 'EPSG:32612',
  verticalDatum: 'EPSG:6360',
  isGeographic: false,
  linearUnitToMetres: 1,
  verticalUnitToMetres: 0.3048,
});

describe('alignEpochClouds preserves the vertical scale', () => {
  it('carries verticalUnitToMetres onto the aligned epoch', () => {
    const before = compound(patch(0));
    const after = compound(patch(0.6));
    const r = alignEpochClouds(before, after);
    expect(r.after.verticalUnitToMetres, 'the aligned epoch lost its Z scale')
      .toBeCloseTo(0.3048, 12);
  });

  it('keeps it distinct from the horizontal factor', () => {
    const r = alignEpochClouds(compound(patch(0)), compound(patch(0.6)));
    expect(r.after.linearUnitToMetres).toBe(1);
    expect(r.after.verticalUnitToMetres).not.toBe(r.after.linearUnitToMetres);
  });

  it('leaves a single-unit frame undisturbed', () => {
    const metre = (p: Float32Array): EpochCloud => ({ ...compound(p), verticalUnitToMetres: undefined });
    const r = alignEpochClouds(metre(patch(0)), metre(patch(0.6)));
    expect(r.after.verticalUnitToMetres).toBeUndefined();
    expect(r.after.linearUnitToMetres).toBe(1);
  });

  it('the aligned epoch agrees with the input on every unit fact', () => {
    const after = compound(patch(0.6));
    const r = alignEpochClouds(compound(patch(0)), after);
    for (const k of ['crs', 'verticalDatum', 'isGeographic', 'linearUnitToMetres', 'verticalUnitToMetres'] as const) {
      expect(r.after[k], `aligned epoch changed ${k}`).toEqual(after[k]);
    }
  });
});

describe('the space report re-checks after EVERY await', () => {
  it('guards the floor-plan chunk load, not only the PDF chunk load', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/main.ts', 'utf8'));
    const handler = src.slice(src.indexOf('onExportReport: async ()'));
    const body = handler.slice(0, handler.indexOf('const bytes = await buildSpaceReportPdf'));
    // Two awaits precede a live read, so two checks are owed.
    expect((body.match(/spaceCtxCurrent\(ctx\)/g) ?? []).length,
      'the second await is unguarded').toBeGreaterThanOrEqual(2);
    // And the second must come after the floor-plan import, before the gather.
    const afterImport = body.slice(body.indexOf('await loadFloorPlan()'));
    expect(afterImport.indexOf('spaceCtxCurrent(ctx)'))
      .toBeLessThan(afterImport.indexOf('floorPlanPositions('));
  });
});
