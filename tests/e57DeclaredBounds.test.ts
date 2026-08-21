/**
 * e57DeclaredBounds.test.ts — decode checked against what the WRITER declared.
 *
 * `parseE57` never reads `cartesianBounds`. That makes the bounds an oracle
 * rather than a self-check: the producing software wrote down the extent it
 * believed it was storing, and a decoder that disagrees is wrong about the
 * file rather than merely inconsistent with itself.
 *
 * This matters most for the ScaledInteger profile. `e57.test.ts` asserts the
 * pump fixture decodes FINITE coordinates, which a decoder that ignored the
 * 1e-6 scale factor entirely would still satisfy: its values would be a
 * million times too large and every one of them finite. The declared bounds
 * catch exactly that.
 *
 * Files are from the libE57 Example/Test Data corpus, whose licence permits
 * use and reproduction. See validation/datasets/dataset-register.yaml
 * (OLV-DS-041) and http://libe57.org/data.html.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseE57 } from '../src/io/e57/parseE57';

function bufferOf(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/**
 * The extent the file declares, read straight from the XML section and
 * deliberately independent of `parseE57`: if the parser grew a bounds reader,
 * this check would start grading the decoder against itself.
 *
 * Two forms appear in the corpus. A `cartesianBounds` element states a real
 * per-axis extent; where it is absent the prototype's own `minimum`/`maximum`
 * attributes state the envelope the writer encoded within. The pump carries
 * the first, the bunny only the second, so both are read.
 */
function declaredExtent(buf: ArrayBuffer): { source: string; x: [number, number]; y: [number, number]; z: [number, number] } | null {
  const head = new DataView(buf);
  const xmlOffset = Number(head.getBigUint64(24, true));
  const xmlLength = Number(head.getBigUint64(32, true));
  const xml = new TextDecoder().decode(new Uint8Array(buf, xmlOffset, xmlLength));

  const block = /<cartesianBounds[\s\S]*?<\/cartesianBounds>/.exec(xml);
  if (block) {
    const v: Record<string, number> = {};
    for (const m of block[0].matchAll(/<(\w+)[^>]*>([^<]+)<\/\1>/g)) v[m[1]] = Number(m[2]);
    return {
      source: 'cartesianBounds',
      x: [v.xMinimum, v.xMaximum],
      y: [v.yMinimum, v.yMaximum],
      z: [v.zMinimum, v.zMaximum],
    };
  }

  const axis = (name: string): [number, number] | null => {
    const m = new RegExp(`<${name}\\b[^>]*?minimum="([^"]+)"[^>]*?maximum="([^"]+)"`).exec(xml);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const x = axis('cartesianX');
  const y = axis('cartesianY');
  const z = axis('cartesianZ');
  // A ScaledInteger prototype states RAW integer limits, not metres, so it is
  // not an extent; only a Float prototype's bounds mean what they say here.
  if (!x || !y || !z || /<cartesianX[^>]*ScaledInteger/.test(xml)) return null;
  return { source: 'prototype', x, y, z };
}

function extent(a: ArrayLike<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < lo) lo = a[i];
    if (a[i] > hi) hi = a[i];
  }
  return [lo, hi];
}

const PUMP = fileURLToPath(new URL('./pumpARowColumnIndexNoInvalidPoints.e57', import.meta.url));
const BUNNY = fileURLToPath(new URL('./bunnyFloat.e57', import.meta.url));

describe('E57 decode against the writer-declared bounds', () => {
  for (const [label, path] of [
    ['ScaledInteger profile (pump)', PUMP],
    ['Float profile (bunny)', BUNNY],
  ] as const) {
    it(`${label} decodes inside the extent the file declares`, () => {
      const buf = bufferOf(path);
      const declared = declaredExtent(buf);
      expect(declared, 'the file declares an extent').not.toBeNull();
      const c = parseE57(buf).scans[0].columns;
      // One quantum of slack: a ScaledInteger coordinate can only land on a
      // multiple of its scale, and the declared bound is a real number.
      const slack = 1e-5;
      for (const [axis, col] of [
        ['x', c.cartesianX],
        ['y', c.cartesianY],
        ['z', c.cartesianZ],
      ] as const) {
        const [lo, hi] = extent(col);
        const [dLo, dHi] = declared![axis];
        expect(lo, `${axis} minimum vs ${declared!.source}`).toBeGreaterThanOrEqual(dLo - slack);
        expect(hi, `${axis} maximum vs ${declared!.source}`).toBeLessThanOrEqual(dHi + slack);
      }
    });
  }

  it('the pump fills its declared extent, so the scale is applied and not merely finite', () => {
    const buf = bufferOf(PUMP);
    const b = declaredExtent(buf)!;
    const c = parseE57(buf).scans[0].columns;
    // Dropping the 1e-6 scale would put these in the millions, still finite.
    // Requiring the decoded extent to REACH the declared one pins the factor.
    for (const [axis, col] of [['x', c.cartesianX], ['y', c.cartesianY], ['z', c.cartesianZ]] as const) {
      const [lo, hi] = extent(col);
      expect(lo, `${axis} reaches its declared minimum`).toBeCloseTo(b[axis][0], 3);
      expect(hi, `${axis} reaches its declared maximum`).toBeCloseTo(b[axis][1], 3);
    }
  });

  it('the structured-scan columns stay inside their declared ranges', () => {
    const s = parseE57(bufferOf(PUMP)).scans[0];
    const c = s.columns;
    const [rLo, rHi] = extent(c.rowIndex);
    const [cLo, cHi] = extent(c.columnIndex);
    expect(rLo).toBeGreaterThanOrEqual(0);
    expect(rHi).toBeLessThanOrEqual(2047);
    expect(cLo).toBeGreaterThanOrEqual(0);
    expect(cHi).toBeLessThanOrEqual(511);
    // This is the NoInvalidPoints variant, so every point is a real return.
    const [iLo, iHi] = extent(c.cartesianInvalidState);
    expect(iLo, 'no invalid points in the NoInvalidPoints file').toBe(0);
    expect(iHi, 'no invalid points in the NoInvalidPoints file').toBe(0);
  });
});

/**
 * Multiple returns. The corpus file is 7.8 MB, too large to vendor for one
 * suite, so it is registered as acquired and read from `OLV_E57_PUMP3`.
 *
 * Its construction is the oracle: the same pump recorded three times, each
 * return one step further along its own ray. That is a RADIAL offset, not a
 * translation, which is why the three copies share a centroid to within a few
 * centimetres while the declared bounds grow by the full span on every axis.
 */
const PUMP3 = process.env.OLV_E57_PUMP3 ?? '';
const withPump3 = PUMP3 && existsSync(PUMP3) ? describe : describe.skip;

withPump3('E57 multiple returns (libE57 pumpARowColumnIndex3ReturnIndex)', () => {
  it('partitions into three equal returns of the base scan', () => {
    const three = parseE57(bufferOf(PUMP3)).scans[0];
    const base = parseE57(bufferOf(PUMP)).scans[0];
    expect(three.recordCount).toBe(base.recordCount * 3);
    const counts = new Map<number, number>();
    for (let i = 0; i < three.recordCount; i++) {
      const k = three.columns.returnIndex[i];
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([0, 1, 2]);
    for (const n of counts.values()) expect(n).toBe(base.recordCount);
    expect(extent(three.columns.returnCount)).toEqual([3, 3]);
  });

  it('steps each return one tenth of a metre further along the same ray', () => {
    const s = parseE57(bufferOf(PUMP3)).scans[0];
    const c = s.columns;
    const byPixel = new Map<number, { ri: number; d: number }[]>();
    for (let i = 0; i < s.recordCount; i++) {
      const key = c.rowIndex[i] * 100000 + c.columnIndex[i];
      let arr = byPixel.get(key);
      if (!arr) {
        if (byPixel.size >= 2000) continue;
        arr = [];
        byPixel.set(key, arr);
      }
      arr.push({ ri: c.returnIndex[i], d: Math.hypot(c.cartesianX[i], c.cartesianY[i], c.cartesianZ[i]) });
    }
    const steps: number[] = [];
    for (const v of byPixel.values()) {
      if (v.length < 3) continue;
      v.sort((a, b) => a.ri - b.ri);
      steps.push(v[1].d - v[0].d, v[2].d - v[1].d);
    }
    expect(steps.length, 'pixels carrying all three returns').toBeGreaterThan(1000);
    // Every step is 0.1 m to within the file's own 1e-6 ScaledInteger quantum.
    // Getting this right needs the returns, the row/column indices and the
    // scale factor all decoded correctly at once.
    for (const step of steps) expect(step).toBeCloseTo(0.1, 5);
  });
});
