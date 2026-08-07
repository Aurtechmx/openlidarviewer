/**
 * convertDatumProvenance.test.ts — the APPROXIMATE datum caveat must reach the
 * DELIVERABLE, not just the UI report.
 *
 * The converter DOES reproject (proj4). On a degenerate datum pair (grid-less
 * NAD27, identity GDA94↔GDA2020) proj4 "succeeds" but the datum leg is only
 * approximate — metres to tens of metres off. That approximation used to live
 * ONLY in `ConvertReport.crsNote` / `.log` (UI), while the written file was
 * stamped with the clean target CRS and nothing else. A file that leaves the UI
 * then asserts an exactness it does not have.
 *
 * These pin the disclosure INTO/BESIDE the bytes:
 *   - LAS 1.2 / 1.4: a LASF_Spec Text Area Description VLR (record id 3) carries
 *     the caveat text.
 *   - ASC / XYZ: a `# datum-transform: APPROXIMATE — …` comment in the header.
 *   - `ConvertReport.provenance` now carries the machine-readable
 *     `TransformProvenance` (accuracyMetres) instead of discarding it.
 * And the exact-transform path stays byte-clean: a sufficient datum pair gets
 * NO caveat VLR and NO comment — a false disclosure would be its own dishonesty.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { loadLas } from '../src/io/loadLas';
import { loadXyz } from '../src/io/loadXyz';
import type { CrsInfo } from '../src/io/crs';

function cloudWith(crs: CrsInfo, origin: [number, number, number]): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 40, 2]),
    origin,
    sourceFormat: 'las',
    name: 'survey.las',
    metadata: { crs },
  });
}

/** GDA94 / MGA zone 55 — the source of a known-approximate datum leg. */
const GDA94_MGA55: CrsInfo = {
  source: 'wkt',
  name: 'GDA94 / MGA 55',
  epsg: 28355,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
};

/** WGS 84 / UTM zone 11N — reprojects to WGS84 geographic with NO datum leg. */
const WGS84_UTM11N: CrsInfo = {
  source: 'wkt',
  name: 'WGS 84 / UTM 11N',
  epsg: 32611,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
};

/**
 * Walk a LAS file's VLRs (1.2 header 227 / 1.4 header 375, count at byte 100)
 * and return the LASF_Spec Text Area Description (record id 3) payload, or null
 * when the file carries none. Independent of how many other VLRs precede it.
 */
function textAreaDescription(las: Uint8Array): string | null {
  const view = new DataView(las.buffer, las.byteOffset, las.byteLength);
  const headerSize = view.getUint16(94, true);
  const numVlrs = view.getUint32(100, true);
  let p = headerSize;
  for (let i = 0; i < numVlrs; i++) {
    let userId = '';
    for (let k = 0; k < 16; k++) {
      const b = las[p + 2 + k];
      if (b === 0) break;
      userId += String.fromCharCode(b);
    }
    const recordId = view.getUint16(p + 18, true);
    const recLen = view.getUint16(p + 20, true);
    const payloadStart = p + 54;
    if (userId === 'LASF_Spec' && recordId === 3) {
      let s = '';
      for (let k = 0; k < recLen; k++) {
        const b = las[payloadStart + k];
        if (b === 0) break;
        s += String.fromCharCode(b);
      }
      return s;
    }
    p = payloadStart + recLen;
  }
  return null;
}

/** Count the VLRs a LAS file declares (header byte 100). */
function vlrCount(las: Uint8Array): number {
  return new DataView(las.buffer, las.byteOffset, las.byteLength).getUint32(100, true);
}

describe('approximate datum reproject — the caveat is embedded in the file', () => {
  it('LAS 1.4 carries the caveat as a LASF_Spec Text Area Description VLR', async () => {
    const { file, report } = convertCloud(
      cloudWith(GDA94_MGA55, [500000, 6000000, 100]),
      { format: 'las14', crsMode: 'reproject', targetEpsg: 7855 }, // GDA94 → GDA2020
    );
    expect(report.ok).toBe(true);
    const desc = textAreaDescription(file!.bytes);
    expect(desc).not.toBeNull();
    expect(desc).toMatch(/APPROXIMATE/);
    expect(desc).toMatch(/GDA94/);
    expect(desc).toMatch(/1\.8 m/); // the magnitude the identity omits

    // The file is still a valid LAS the app's own reader accepts (the extra VLR
    // does not corrupt the CRS or the points).
    const out = await loadLas(file!.bytes.buffer as ArrayBuffer, 'las', 'gda.las');
    expect(out.pointCount).toBe(3);
  });

  it('LAS 1.2 carries the caveat as a Text Area Description VLR too', () => {
    const { file, report } = convertCloud(
      cloudWith(GDA94_MGA55, [500000, 6000000, 100]),
      { format: 'las', crsMode: 'reproject', targetEpsg: 7855 },
    );
    expect(report.ok).toBe(true);
    const desc = textAreaDescription(file!.bytes);
    expect(desc).not.toBeNull();
    expect(desc).toMatch(/APPROXIMATE/);
    expect(desc).toMatch(/GDA94/);
  });

  it('ASC writes a # datum-transform comment beside the # crs line', () => {
    const { file, report } = convertCloud(
      cloudWith(GDA94_MGA55, [500000, 6000000, 100]),
      { format: 'asc', crsMode: 'reproject', targetEpsg: 7855 },
    );
    expect(report.ok).toBe(true);
    const text = new TextDecoder().decode(file!.bytes);
    expect(text).toMatch(/# datum-transform: APPROXIMATE/);
    expect(text).toMatch(/GDA94/);
    // The existing CRS header is still present.
    expect(text).toContain('# crs: EPSG:7855');
  });

  it('XYZ prepends a # datum-transform comment and still round-trips', async () => {
    const { file, report } = convertCloud(
      cloudWith(GDA94_MGA55, [500000, 6000000, 100]),
      { format: 'xyz', crsMode: 'reproject', targetEpsg: 7855 },
    );
    expect(report.ok).toBe(true);
    const text = new TextDecoder().decode(file!.bytes);
    expect(text.split('\n')[0]).toMatch(/^# datum-transform: APPROXIMATE/);
    expect(text).toMatch(/GDA94/);
    // loadXyz skips `#` comments, so the note does not corrupt the point list.
    const out = await loadXyz(file!.bytes.buffer as ArrayBuffer, 'gda.xyz');
    expect(out.pointCount).toBe(3);
  });

  it('threads the machine-readable TransformProvenance into the report', () => {
    const { report } = convertCloud(
      cloudWith(GDA94_MGA55, [500000, 6000000, 100]),
      { format: 'las14', crsMode: 'reproject', targetEpsg: 7855 },
    );
    expect(report.provenance).toBeTruthy();
    // The identity GDA94→GDA2020 leg is characterised at ≈ 1.8 m.
    expect(report.provenance?.accuracyMetres).toBe(1.8);
    expect(report.provenance?.operation).toMatch(/GDA/);
  });
});

describe('exact datum reproject — the deliverable stays byte-clean (no false caveat)', () => {
  it('LAS 1.4: no Text Area Description VLR when the datum pair is sufficient', () => {
    const { file, report } = convertCloud(
      cloudWith(WGS84_UTM11N, [500000, 4000000, 100]),
      { format: 'las14', crsMode: 'reproject', targetEpsg: 4326 }, // WGS84 → WGS84
    );
    expect(report.ok).toBe(true);
    expect(report.crsNote).not.toMatch(/APPROXIMATE/);
    expect(textAreaDescription(file!.bytes)).toBeNull();
  });

  it('LAS 1.2: a clean reproject adds no extra VLR (only the CRS GeoKey VLR)', () => {
    const { file } = convertCloud(
      cloudWith(WGS84_UTM11N, [500000, 4000000, 100]),
      { format: 'las', crsMode: 'reproject', targetEpsg: 4326 },
    );
    // Geographic CRS ⇒ exactly one GeoKey VLR, and no caveat VLR.
    expect(vlrCount(file!.bytes)).toBe(1);
    expect(textAreaDescription(file!.bytes)).toBeNull();
  });

  it('ASC: no datum-transform comment on a clean reproject', () => {
    const { file } = convertCloud(
      cloudWith(WGS84_UTM11N, [500000, 4000000, 100]),
      { format: 'asc', crsMode: 'reproject', targetEpsg: 4326 },
    );
    const text = new TextDecoder().decode(file!.bytes);
    expect(text).not.toMatch(/datum-transform/);
  });

  it('XYZ: no datum-transform comment on a clean reproject', () => {
    const { file } = convertCloud(
      cloudWith(WGS84_UTM11N, [500000, 4000000, 100]),
      { format: 'xyz', crsMode: 'reproject', targetEpsg: 4326 },
    );
    const text = new TextDecoder().decode(file!.bytes);
    expect(text).not.toMatch(/datum-transform/);
    // First line is data, not a comment.
    expect(text.split('\n')[0]).not.toMatch(/^#/);
  });

  it('still exposes provenance on a clean reproject (accuracyMetres null, no caveat)', () => {
    const { report } = convertCloud(
      cloudWith(WGS84_UTM11N, [500000, 4000000, 100]),
      { format: 'las14', crsMode: 'reproject', targetEpsg: 4326 },
    );
    expect(report.provenance).toBeTruthy();
    expect(report.provenance?.accuracyMetres).toBeNull();
  });
});
