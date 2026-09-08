/**
 * changeExportGate.test.ts — the difference raster is not offered on a
 * comparison the panel refuses to call measured.
 *
 * `summarizeChange` has three refusals and one caveat, and the .asc export was
 * gated on ONE of the refusals (`frameIncompatible`). So a pair whose CRS was
 * merely unstated, or whose linear unit was unknown, produced a panel that
 * printed no numbers and an Export button that wrote a full grid of them.
 *
 * That asymmetry matters more for the file than for the panel. An .asc is a
 * bare header plus a rectangle of numbers: opened in a GIS it carries no note
 * about an unconfirmed frame, no "indicative, not measured" line, nothing. The
 * caveat cannot travel with it, so the export is gated on the whole
 * co-registration verdict rather than on the subset that happens to be provable.
 *
 * Two halves. The first pins the property in `compareDtms`, where it is
 * computable. The second reads `main.ts` — the gate lives inline in the compare
 * handler and there is no seam to call — and checks that the guard there is the
 * full verdict, since a future edit narrowing it back would reopen exactly this.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareDtms } from '../src/terrain/change/compareDtms';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const COLS = 2;
const ROWS = 2;

function grid(height: number, over: Partial<DtmGrid> = {}): DtmGrid {
  const n = COLS * ROWS;
  return {
    z: Float32Array.from({ length: n }, () => height),
    confidence: new Float32Array(n).fill(100),
    coverage: new Uint8Array(n).fill(1),
    counts: new Uint32Array(n).fill(1),
    interpDistanceCells: new Float32Array(n),
    cols: COLS,
    rows: ROWS,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
    crs: 'EPSG:32610',
    verticalDatum: 'EPSG:5703',
    ...over,
  } as unknown as DtmGrid;
}

describe('the co-registration verdict covers every case the summary refuses', () => {
  it('is false whenever the summary declines to report a measured figure', () => {
    const cases: ReadonlyArray<readonly [string, ReturnType<typeof compareDtms>]> = [
      ['unstated CRS', compareDtms(grid(10, { crs: null }), grid(10.5, { crs: null }))],
      ['unstated vertical datum',
        compareDtms(grid(10, { verticalDatum: null }), grid(10.5, { verticalDatum: null }))],
      ['unknown linear unit',
        compareDtms(grid(10), grid(10.5), { horizontalUnitKnown: false })],
      ['geographic grid', compareDtms(grid(10), grid(10.5), { isGeographic: true })],
      ['offset origins', compareDtms(grid(10), grid(10.5, { originH1: 0.49 }))],
      ['differing CRS', compareDtms(grid(10), grid(10.5, { crs: 'EPSG:32613' }))],
    ];
    for (const [label, cmp] of cases) {
      expect(cmp.coregistered, `"${label}" was reported as co-registered`).toBe(false);
    }
    // And a clean pair still IS co-registered, so the gate is not simply closed.
    expect(compareDtms(grid(10), grid(10.5)).coregistered).toBe(true);
  });
});

describe('main.ts gates the difference raster on that whole verdict', () => {
  it('withholds the export on anything short of co-registered', () => {
    const main = readFileSync(resolve(__dirname, '..', 'src', 'main.ts'), 'utf8');
    const start = main.indexOf('const cmp = compareDtms(');
    expect(start, 'the compare handler no longer calls compareDtms').toBeGreaterThan(0);
    const offer = main.indexOf('inspector.setDifferenceAvailable(true)', start);
    expect(offer, 'the compare handler no longer offers the difference raster')
      .toBeGreaterThan(start);
    const between = main.slice(start, offer);
    expect(between, 'the difference raster is offered without checking co-registration')
      .toMatch(/if\s*\(\s*!\s*cmp\.coregistered\s*\)/);
    // Narrowing it back to the provable subset is the regression this guards.
    expect(between).not.toMatch(/if\s*\(\s*cmp\.frameIncompatible\s*\)\s*\{\s*\n\s*inspector\.setDifferenceAvailable\(false\)/);
  });
});
