/**
 * changeBandEstimand.test.ts — the uncertainty band qualifies the volume that
 * is actually reported.
 *
 * `summarizeChange` reports the RAW net, summed over every comparable cell with
 * no level-of-detection threshold, and then computed its band from the
 * THRESHOLDED net and the above-LoD cell count. Two different estimands: the
 * figure a reader sees and the figure the band describes.
 *
 * The failure is not subtle at the boundary. A site whose every cell moves by
 * less than the level of detection has zero above-LoD cells, so the random term
 * — which scales as sqrt(N) — collapsed to +/-0 while the reported raw net was
 * the sum of every one of those real, noisy observations.
 */

import { describe, it, expect } from 'vitest';
import { compareDtms, summarizeChange } from '../src/terrain/change/compareDtms';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const COLS = 10;
const ROWS = 10;

/** A flat grid at a constant height, on a 1 m cell. */
function flat(height: number): DtmGrid {
  return {
    z: Float32Array.from({ length: COLS * ROWS }, () => height),
    // Every cell measured: dtmToChangeGrid reads `coverage` to decide which
    // heights are real, so a fixture without it compares nothing.
    coverage: Uint8Array.from({ length: COLS * ROWS }, () => 1),
    cols: COLS,
    rows: ROWS,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
  } as unknown as DtmGrid;
}

describe('the change band describes the net it is printed beside', () => {
  it('does not collapse when every cell moves below the level of detection', () => {
    // 100 cells, each +0.05 m, against a 0.10 m level of detection. Every cell
    // is individually undetectable; the raw net over all of them is 5 m3.
    const comparison = compareDtms(flat(10), flat(10.05), { levelOfDetectionM: 0.1 });
    expect(comparison.result.stats.gained + comparison.result.stats.lost,
      'the fixture must have NO above-LoD cells, or it does not exercise the bug')
      .toBe(0);
    expect(comparison.result.stats.comparable).toBe(COLS * ROWS);
    expect(Math.abs(comparison.result.stats.rawNetVolumeM3),
      'the raw net must be non-zero, or there is nothing to qualify')
      .toBeGreaterThan(0.1);

    const lines = summarizeChange(comparison, {
      horizontalUnitToMetres: 1,
      registrationSigmaM: 0.01,
    });
    const band = lines.find((l) => /uncertaint/i.test(l));
    expect(band, `no uncertainty line in: ${lines.join(' | ')}`).toBeDefined();
    // The band used to read +/-0 here because N was the above-LoD count, which
    // is zero. It must now reflect the 100 cells the reported net sums.
    expect(band).not.toMatch(/±\s*0(\.0+)?\s*m³/);
  });
});
