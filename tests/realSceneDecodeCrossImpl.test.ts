/**
 * realSceneDecodeCrossImpl.test.ts — OLV's LAZ decoder vs PDAL on real airborne
 * tiles (Track C of the real-scene validation program).
 *
 * Every decoder check the project ships is against synthetic or small committed
 * fixtures. This asserts that OLV's decode of two REAL tiles — one LAS 1.0
 * point-format 1 (OLV-DS-090 Jemez) and one LAS 1.4 point-format 6 (OLV-DS-091
 * Rogue 3DEP) — reproduces PDAL's independent decode: exact point count and
 * per-dimension bounds to sub-millimetre. Point format 6 is the modern extended
 * record that synthetic fixtures rarely exercise, so this is real external
 * validity for the decoder, at E4 (cross-implementation agreement).
 *
 * The committed oracle (validation/real-scene/decode-stats/<id>.json) holds
 * OLV's stats, PDAL's stats, and their delta, generated once by
 * scripts/gen-real-scene-decode-stats.mjs (SCENE + ID env). CI reads only the
 * committed oracle — the 49/131 MB clouds and PDAL are needed only to
 * regenerate. OLV decodes in the tile's LOCAL frame (origin = header minimum)
 * so its Float32 positions stay sub-mm faithful; decoding far-from-origin UTM
 * coordinates against a [0,0,0] origin would instead cost ~cm of Float32
 * precision — a real caveat this frame choice documents.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'validation/real-scene/decode-stats');

interface DecodeOracle {
  datasetId: string;
  reference: string;
  olv: { count: number; classHistogram: Record<string, number>; zmean: number };
  pdal: { count: number; lasVersion: string; pointFormat: number; srs: string };
  delta: {
    count: number;
    xmin: number; xmax: number; ymin: number; ymax: number;
    zmin: number; zmax: number; zmean: number;
  };
}

const CASES: Array<{ id: string; lasVersion: string; pointFormat: number; srsIncludes: string }> = [
  { id: 'OLV-DS-090', lasVersion: '1.0', pointFormat: 1, srsIncludes: 'UTM zone 13N' },
  { id: 'OLV-DS-091', lasVersion: '1.4', pointFormat: 6, srsIncludes: 'UTM zone 10N' },
];

// Sub-millimetre: the only expected residual is Float32 precision in the local
// frame (~1e-5 m at these extents). A real decode error — wrong scale, offset,
// or a mis-parsed extended record — would move a bound far past this.
const BOUND_TOL_M = 1e-3;

describe('real-scene decoder cross-implementation vs PDAL', () => {
  for (const c of CASES) {
    const path = resolve(DIR, `${c.id}.json`);
    const present = existsSync(path);
    const o: DecodeOracle | null = present ? JSON.parse(readFileSync(path, 'utf8')) : null;

    describe(c.id, () => {
      it('oracle is committed and references PDAL', () => {
        expect(present, `${c.id}.json missing — regenerate with gen-real-scene-decode-stats.mjs`).toBe(true);
        expect(o!.reference).toBe('PDAL');
        expect(o!.datasetId).toBe(c.id);
      });

      it('decodes the exact PDAL point count', () => {
        expect(o!.delta.count).toBe(0);
        expect(o!.olv.count).toBe(o!.pdal.count);
        expect(o!.olv.count).toBeGreaterThan(0);
      });

      it('reproduces every PDAL coordinate bound to sub-millimetre', () => {
        const d = o!.delta;
        for (const [k, v] of Object.entries({ xmin: d.xmin, xmax: d.xmax, ymin: d.ymin, ymax: d.ymax, zmin: d.zmin, zmax: d.zmax, zmean: d.zmean })) {
          expect(v, `${c.id} ${k} delta ${v} m exceeds ${BOUND_TOL_M} m`).toBeLessThan(BOUND_TOL_M);
        }
      });

      it(`records the expected LAS version, point format, and CRS`, () => {
        expect(o!.pdal.lasVersion).toBe(c.lasVersion);
        expect(o!.pdal.pointFormat).toBe(c.pointFormat);
        expect(o!.pdal.srs).toContain(c.srsIncludes);
      });

      it('class histogram is present and sums to the decoded count', () => {
        const sum = Object.values(o!.olv.classHistogram).reduce((a, b) => a + b, 0);
        expect(sum).toBe(o!.olv.count);
      });
    });
  }
});
