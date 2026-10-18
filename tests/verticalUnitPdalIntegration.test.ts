/**
 * verticalUnitPdalIntegration.test.ts — physical heights agree with PDAL.
 *
 * For each valid vertical length unit, a LAS 1.4 file is written with a
 * compound WKT (UTM 13N + a local vertical CRS in that unit) holding a
 * 100-unit rise. PDAL then reprojects the file to the same compound CRS with
 * metre heights, and the Z range it writes is the physical height in metres
 * by an independent reader. The height this build derives from the same file
 * (parsed CRS, spatial context, measurement metrics) must equal it, and the
 * factor it parses must equal the conversion factor PDAL reports.
 *
 * Runs only when `pdal` is on PATH; otherwise every case is reported as
 * skipped by name. The fixture with an angular vertical unit key is not a
 * length, so it is checked without PDAL: no metre height is derived from it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLas, writeLas14 } from '../src/convert/writeLas';
import { parseLasHeader } from '../src/io/lasHeader';
import { wktForEpsg } from '../src/io/epsgWkt';
import { spatialContextFrom, verticalMetresPerUnit } from '../src/geo/SpatialContext';
import { frameScalars } from '../src/app/measurementExportFrame';
import { measurementMetrics } from '../src/export/measurementExport';
import type { Measurement } from '../src/render/measure/types';

const HAS_PDAL = spawnSync('sh', ['-c', 'command -v pdal']).status === 0;

const UNITS: ReadonlyArray<readonly [string, number]> = [
  ['metre', 1],
  ['foot', 0.3048],
  ['US survey foot', 1200 / 3937],
  ['centimetre', 0.01],
  ['millimetre', 0.001],
  ['kilometre', 1000],
  ['yard', 0.9144],
];

const compound = (unit: string): string =>
  `COMPD_CS["UTM and local height",${wktForEpsg(32613)},VERT_CS["Local height",VERT_DATUM["Local datum",2005],${unit},AXIS["Up",UP]]]`;
const geom = { count: 2, x: new Float64Array([500000, 500000]), y: new Float64Array([4000000, 4000000]), z: new Float64Array([100, 200]) };
const height: Measurement = { id: 'h', name: 'rise', kind: 'height', points: [[0, 0, 0], [0, 0, 100]] };

let dir = '';
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'olv-vertical-pdal-')); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** The physical height this build derives from the LAS bytes, through the export metrics. */
function olvHeightMetres(bytes: Uint8Array): { factor: number | undefined; heightM: number | undefined } {
  const h = parseLasHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const ctx = spatialContextFrom(h.crs);
  const factor = verticalMetresPerUnit(ctx, 'none');
  if (factor === undefined || frameScalars(ctx).verticalScaleInvalid) return { factor, heightM: undefined };
  const rise = h.max[2] - h.min[2];
  const metrics = measurementMetrics({ ...height, points: [[0, 0, 0], [0, 0, rise]] }, [0, 0, 1], ctx.linearUnitToMetres, factor, 9);
  return { factor, heightM: metrics.vertical_m };
}

describe('physical heights match PDAL for every valid vertical length unit', () => {
  it.skipIf(!HAS_PDAL).each(UNITS)('%s (factor %s) against PDAL', (unit, factor) => {
    const src = join(dir, `${unit.replaceAll(' ', '-')}.las`);
    const out = join(dir, `${unit.replaceAll(' ', '-')}-m.las`);
    const bytes = writeLas14(geom, { wkt: compound(`UNIT["${unit}",${factor}]`) });
    writeFileSync(src, bytes);

    const meta = JSON.parse(execFileSync('pdal', ['info', src, '--metadata'], { encoding: 'utf8' })) as {
      metadata: { srs: { json: { components: Array<{ type: string; coordinate_system: { axis: Array<{ unit: string | { conversion_factor: number } }> } }> } } };
    };
    const vu = meta.metadata.srs.json.components.find((c) => c.type === 'VerticalCRS')!.coordinate_system.axis[0]!.unit;
    const pdalFactor = typeof vu === 'string' ? (vu === 'metre' ? 1 : Number.NaN) : vu.conversion_factor;

    execFileSync('pdal', ['translate', src, out, '-f', 'filters.reprojection', `--filters.reprojection.out_srs=${compound('UNIT["metre",1]')}`]);
    const summary = JSON.parse(execFileSync('pdal', ['info', out, '--summary'], { encoding: 'utf8' })) as { summary: { bounds: { minz: number; maxz: number } } };
    const pdalHeightM = summary.summary.bounds.maxz - summary.summary.bounds.minz;

    const olv = olvHeightMetres(bytes);
    expect(olv.factor).toBeCloseTo(pdalFactor, 12);
    expect(olv.heightM).toBeDefined();
    // PDAL writes the reprojected Z at its output scale (0.01 by default).
    expect(Math.abs(olv.heightM! - pdalHeightM)).toBeLessThanOrEqual(0.011);
    expect(olv.heightM!).toBeCloseTo(100 * factor, 6);
  });

  it('an angular vertical unit key derives no metre height', () => {
    const bytes = writeLas(geom, { epsg: 32613, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9102 });
    expect(olvHeightMetres(bytes).heightM).toBeUndefined();
  });
});
