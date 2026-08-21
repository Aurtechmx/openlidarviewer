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
 * Both files state a separate range per axis, so the comparison is per axis
 * and a decoder that swapped two of them fails it.
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
 * The XML section, reassembled from the physical file.
 *
 * E57 stores the file in 1024-byte physical pages whose last four bytes are a
 * CRC, so the XML is not one contiguous run of bytes: a slice of
 * `xmlPhysicalOffset` through `xmlLogicalLength` interleaves checksum bytes
 * into the markup and truncates the tail. On `bunnyFloat.e57` that split lands
 * inside `</cartesianBounds>`, and a reader that skips the paging silently
 * fails to find bounds the file does carry.
 *
 * This is a second implementation of the page walk rather than a call into
 * `src/io/e57`. Sharing the production depager would make the oracle depend on
 * the code it grades.
 */
function depagedXml(buf: ArrayBuffer): string {
  const head = new DataView(buf);
  const xmlOffset = Number(head.getBigUint64(24, true));
  const xmlLength = Number(head.getBigUint64(32, true));
  const PAGE = 1024;
  const PAYLOAD = PAGE - 4;

  const out = new Uint8Array(xmlLength);
  const src = new Uint8Array(buf);
  let written = 0;
  let pos = xmlOffset;
  while (written < xmlLength) {
    const pageStart = Math.floor(pos / PAGE) * PAGE;
    const take = Math.min(PAYLOAD - (pos - pageStart), xmlLength - written);
    out.set(src.subarray(pos, pos + take), written);
    written += take;
    pos = pageStart + PAGE;
  }
  return new TextDecoder().decode(out);
}

/**
 * The per-axis extent the file declares, independent of `parseE57`: if the
 * parser grew a bounds reader, this check would start grading the decoder
 * against itself.
 *
 * Only `cartesianBounds` counts as an extent. A prototype's own
 * `minimum`/`maximum` attributes state one envelope covering all three axes,
 * so a decoder that swapped X for Y would still sit inside them.
 */
function declaredExtent(buf: ArrayBuffer): { source: string; x: [number, number]; y: [number, number]; z: [number, number] } | null {
  const xml = depagedXml(buf);
  const block = /<cartesianBounds[\s\S]*?<\/cartesianBounds>/.exec(xml);
  if (!block) return null;
  const v: Record<string, number> = {};
  for (const m of block[0].matchAll(/<(\w+)[^>]*>([^<]+)<\/\1>/g)) v[m[1]] = Number(m[2]);
  const axes = ['xMinimum', 'xMaximum', 'yMinimum', 'yMaximum', 'zMinimum', 'zMaximum'];
  if (axes.some((k) => !Number.isFinite(v[k]))) return null;
  return {
    source: 'cartesianBounds',
    x: [v.xMinimum, v.xMaximum],
    y: [v.yMinimum, v.yMaximum],
    z: [v.zMinimum, v.zMaximum],
  };
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

  it('grades each axis against its own declared range, not one shared envelope', () => {
    // A union envelope would pass a decoder that swapped two axes. Both files
    // state three separate ranges, and on the pump the Y range does not even
    // overlap zero while X and Z straddle it, so a swap breaks containment.
    for (const path of [PUMP, BUNNY]) {
      const d = declaredExtent(bufferOf(path));
      expect(d, `${path} declares cartesianBounds`).not.toBeNull();
      expect(d!.source).toBe('cartesianBounds');
      const ranges = [d!.x, d!.y, d!.z].map((r) => `${r[0]},${r[1]}`);
      expect(new Set(ranges).size, 'the three axis ranges are distinct').toBe(3);
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
 * centimetres while the declared bounds widen at both ends of every axis.
 *
 * The two figures below are read off the file, not off the catalogue prose.
 * The libE57 catalogue describes the fixture as offset by 20 cm; that 20 cm is
 * the distance from the first return to the third, so adjacent returns sit
 * half that apart. PDAL 2.9 reading all 155,201 pixel triples reports an
 * adjacent step of 0.100000 m (min 0.099999, max 0.100001) and a
 * first-to-third span of 0.200000 m, and the declared bounds of this file
 * exceed the base pump's by 0.400000 m of span on each of the three axes.
 */
const RETURN_STEP_M = 0.1;
const RETURN_SPAN_M = 0.2;
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

  it('widens the declared bounds by the full return span on both sides of every axis', () => {
    // The catalogue states a 20 cm multiple-return offset. That 0.20 m is the
    // span from the first return to the third, so the envelope grows 0.20 m at
    // each end and the declared span grows 0.40 m per axis. This reads the
    // figure off the two files instead of off the catalogue text.
    const three = declaredExtent(bufferOf(PUMP3))!;
    const base = declaredExtent(bufferOf(PUMP))!;
    for (const axis of ['x', 'y', 'z'] as const) {
      const span = (r: [number, number]): number => r[1] - r[0];
      expect(span(three[axis]) - span(base[axis]), `${axis} span growth`).toBeCloseTo(
        RETURN_SPAN_M * 2,
        6,
      );
    }
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
    const spans: number[] = [];
    for (const v of byPixel.values()) {
      if (v.length < 3) continue;
      v.sort((a, b) => a.ri - b.ri);
      steps.push(v[1].d - v[0].d, v[2].d - v[1].d);
      spans.push(v[2].d - v[0].d);
    }
    expect(steps.length, 'pixels carrying all three returns').toBeGreaterThan(1000);
    // Every adjacent step is RETURN_STEP_M to within the file's own 1e-6
    // ScaledInteger quantum. Getting this right needs the returns, the
    // row/column indices and the scale factor all decoded correctly at once.
    for (const step of steps) expect(step).toBeCloseTo(RETURN_STEP_M, 5);
    // The first-to-third span is the 20 cm the catalogue quotes.
    for (const s of spans) expect(s).toBeCloseTo(RETURN_SPAN_M, 5);
  });
});

/**
 * Multiple registered scans. 50 MB, so read from `OLV_E57_PUMP_MULTI`.
 *
 * What this can and cannot say is worth being exact about. The file carries no
 * independent registration truth, so nothing here shows the poses are RIGHT.
 * What it shows is that a real vendor multi-station file decodes: five scans,
 * four carrying a pose, every quaternion already a unit quaternion needing no
 * repair, and the composition arithmetic reversible. `e57Pose.test.ts` covers
 * the repair policy on synthetic quaternions; this covers a real one.
 *
 * Each scan is stored in its own scanner-centred frame, which is why the raw
 * centroids all sit near the origin and applying the poses moves them apart
 * rather than together. Station spread is not misalignment.
 */
const PUMP_MULTI = process.env.OLV_E57_PUMP_MULTI ?? '';
const withMulti = PUMP_MULTI && existsSync(PUMP_MULTI) ? describe : describe.skip;

withMulti('E57 multiple registered scans (libE57 Pump)', () => {
  it('reads every station and its pose without needing to repair one', () => {
    const r = parseE57(bufferOf(PUMP_MULTI));
    expect(r.scans).toHaveLength(5);
    const posed = r.scans.filter((s) => s.pose !== null);
    expect(posed.length, 'stations carrying a pose').toBe(4);
    for (const s of posed) {
      // readPose normalises a non-unit quaternion and warns. A real writer's
      // file should give it nothing to do.
      expect(Math.hypot(...s.pose!.rotation), `${s.name} rotation is a unit quaternion`).toBeCloseTo(1, 9);
      expect(s.pose!.translation).toHaveLength(3);
      for (const t of s.pose!.translation) expect(Number.isFinite(t)).toBe(true);
    }
    const warnings = (r as unknown as { warnings?: unknown[] }).warnings ?? [];
    expect(warnings, 'no pose repair was needed').toEqual([]);
  }, 180_000);

  it('composes a pose reversibly, so the transform is a rigid motion', () => {
    const r = parseE57(bufferOf(PUMP_MULTI));
    const s = r.scans.find((x) => x.pose !== null)!;
    const [w, x, y, z] = s.pose!.rotation;
    const t = s.pose!.translation;
    const rotate = (q: readonly number[], v: readonly number[]): [number, number, number] => {
      const [qw, qx, qy, qz] = q;
      const tx = 2 * (qy * v[2] - qz * v[1]);
      const ty = 2 * (qz * v[0] - qx * v[2]);
      const tz = 2 * (qx * v[1] - qy * v[0]);
      return [
        v[0] + qw * tx + (qy * tz - qz * ty),
        v[1] + qw * ty + (qz * tx - qx * tz),
        v[2] + qw * tz + (qx * ty - qy * tx),
      ];
    };
    const c = s.columns;
    const step = Math.max(1, Math.floor(s.recordCount / 500));
    for (let i = 0; i < s.recordCount; i += step) {
      const p = [c.cartesianX[i], c.cartesianY[i], c.cartesianZ[i]] as const;
      const fwd = rotate([w, x, y, z], p).map((v, k) => v + t[k]);
      // The conjugate undoes the rotation; a rigid motion loses nothing.
      const back = rotate([w, -x, -y, -z], fwd.map((v, k) => v - t[k]));
      for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(p[k], 6);
    }
  }, 180_000);
});

/**
 * An unknown vendor extension. 587 MB, so read from `OLV_E57_OPENPITMINE`.
 *
 * The corpus publishes this file so readers can show they cope with data they
 * were never told about: it declares the Riegl `rlms` namespace and carries
 * two fields inside it. The failure this guards against is a reader that
 * treats an unrecognised prefix as corruption and refuses the file, or worse,
 * reads the extension columns as if they were part of the standard prototype
 * and shifts every subsequent field.
 *
 * OLV keeps the prefix on the column name rather than dropping or flattening
 * it, so an extension field stays distinguishable from a standard one.
 */
const OPENPIT = process.env.OLV_E57_OPENPITMINE ?? '';
const withExtension = OPENPIT && existsSync(OPENPIT) ? describe : describe.skip;

withExtension('E57 unknown vendor extension (libE57 openpitmine, Riegl rlms)', () => {
  it('reads the file, keeps the extension namespaced, and does not warn', () => {
    const r = parseE57(bufferOf(OPENPIT));
    expect(r.scans.length, 'every station decodes').toBeGreaterThan(1);
    const s = r.scans[0];
    const columns = Object.keys(s.columns);

    // The standard prototype survives alongside the extension.
    for (const need of ['cartesianX', 'cartesianY', 'cartesianZ']) {
      expect(columns, `${need} still present`).toContain(need);
    }
    // The extension fields keep their prefix, so nothing mistakes them for
    // standard attributes.
    const extension = columns.filter((c) => c.startsWith('rlms:'));
    expect(extension.length, 'rlms fields are carried, not dropped').toBeGreaterThan(0);
    for (const c of extension) expect(c).toMatch(/^rlms:[a-zA-Z]+$/);

    // An unknown extension is not a defect, so it must not raise one.
    const warnings = (r as unknown as { warnings?: unknown[] }).warnings ?? [];
    expect(warnings, 'an unrecognised namespace is not a warning').toEqual([]);
  }, 300_000);

  it('decodes coordinates that did not shift by an extension field width', () => {
    // Reading the rlms columns as part of the standard prototype would slide
    // every later field along the record and put coordinates somewhere else
    // entirely. The declared extent catches that.
    const buf = bufferOf(OPENPIT);
    const declared = declaredExtent(buf);
    const s = parseE57(buf).scans[0];
    if (declared) {
      for (const [axis, col] of [
        ['x', s.columns.cartesianX],
        ['y', s.columns.cartesianY],
        ['z', s.columns.cartesianZ],
      ] as const) {
        const [lo, hi] = extent(col);
        expect(lo, `${axis} minimum vs ${declared.source}`).toBeGreaterThanOrEqual(declared[axis][0] - 1e-3);
        expect(hi, `${axis} maximum vs ${declared.source}`).toBeLessThanOrEqual(declared[axis][1] + 1e-3);
      }
    }
    // Whether or not the file declares an extent, the values must be real.
    let nonFinite = 0;
    for (let i = 0; i < s.recordCount; i += 997) {
      if (!Number.isFinite(s.columns.cartesianX[i])) nonFinite++;
    }
    expect(nonFinite, 'sampled coordinates are finite').toBe(0);
  }, 300_000);
});
