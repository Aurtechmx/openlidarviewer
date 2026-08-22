/**
 * e57StrideDecode.test.ts
 *
 * The strided E57 decode, and the disclosure that has to travel with it.
 *
 * A 616 MB, 26.9 M-record E57 needed 3.5 GB to decode whole and killed the tab
 * trying. The answer is the one LAS already has: when the estimate does not
 * fit, read ONE record per bucket instead of every record, and say so. A
 * strided load is a sample of the scan, and this project does not let a sample
 * pass as the whole — so the count that leaves the loader is the sampled count,
 * the file's declared total rides beside it, and the sampling is stated in
 * words on the cloud's load warnings.
 *
 * No committed fixture is large enough to reach the stride threshold (the plan
 * refuses to sample below 250 k points, and the biggest committed E57 declares
 * 155 k records), so this file builds its own. The builder is the inverse of
 * the reader and a multi-packet sibling of `scripts/make-e57-fixture.mjs`:
 * deterministic bytes, no randomness, no committed artifact.
 */

import { describe, it, expect } from 'vitest';
import { parseE57 } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';
import { preflightE57 } from '../src/io/e57/preflight';
import { stratifiedSampleIndices } from '../src/io/strideSample';
import { crc32c } from '../src/io/e57/crc32c';
import {
  estimateMemoryBytes,
  e57BytesPerRecord,
  planE57Decode,
} from '../src/io/loadPlan';
import type { PointAttributes } from '../src/io/loadPlan';
import { LoadError } from '../src/io/loadErrors';
import { toXyz } from '../src/io/exporters';
import { fileMetadata } from '../src/io/loadFile';

// ────────────────────────────────────────────────────────────────────────────
// A synthetic multi-packet E57
// ────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 1024;
const PAGE_PAYLOAD = PAGE_SIZE - 4;
const SIGNATURE = 'ASTM-E57';

/** Records per data packet. A multiple of 8 keeps every bytestream byte-aligned. */
const RECORDS_PER_PACKET = 4000;

/** Logical offset to physical, the inverse of the reader's `physicalToLogical`. */
function logicalToPhysical(logical: number): number {
  return Math.floor(logical / PAGE_PAYLOAD) * PAGE_SIZE + (logical % PAGE_PAYLOAD);
}

/** Point `i`'s exact coordinates. Small integers, so Float32 stores them exactly. */
function pointAt(i: number): { x: number; y: number; z: number } {
  return { x: i, y: 2 * i, z: 3 * i };
}

/** Point `i`'s colour. Deterministic, and distinct enough to catch a misalignment. */
function colorAt(i: number): [number, number, number] {
  return [i % 251, (i * 3) % 241, (i * 7) % 239];
}

const PROTOTYPE_XML =
  '        <prototype type="Structure">\n' +
  '          <cartesianX type="Float" precision="single"/>\n' +
  '          <cartesianY type="Float" precision="single"/>\n' +
  '          <cartesianZ type="Float" precision="single"/>\n' +
  '          <colorRed type="Integer" minimum="0" maximum="255"/>\n' +
  '          <colorGreen type="Integer" minimum="0" maximum="255"/>\n' +
  '          <colorBlue type="Integer" minimum="0" maximum="255"/>\n' +
  '        </prototype>\n';

function buildXml(records: number, fileOffset: number): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<e57Root type="Structure">\n' +
    '  <formatName type="String">ASTM E57 3D Imaging Data File</formatName>\n' +
    '  <guid type="String">stride-fixture-0000-0000-000000000001</guid>\n' +
    '  <e57LibraryVersion type="String">OpenLiDARViewer stride test builder</e57LibraryVersion>\n' +
    '  <data3D type="Vector" allowHeterogeneousChildren="1">\n' +
    '    <vectorChild type="Structure">\n' +
    '      <guid type="String">stride-fixture-scan-0000-0000-000000000001</guid>\n' +
    '      <name type="String">stride-grid</name>\n' +
    `      <points type="CompressedVector" fileOffset="${fileOffset}" recordCount="${records}">\n` +
    PROTOTYPE_XML +
    '        <codecs type="Vector" allowHeterogeneousChildren="1"/>\n' +
    '      </points>\n' +
    '    </vectorChild>\n' +
    '  </data3D>\n' +
    '</e57Root>\n'
  );
}

/** One data packet's six bytestreams, for records `[from, to)`. */
function packetStreams(from: number, to: number): Uint8Array[] {
  const n = to - from;
  const axes = [0, 1, 2].map(() => new Uint8Array(n * 4));
  const views = axes.map((a) => new DataView(a.buffer));
  const channels = [0, 1, 2].map(() => new Uint8Array(n));
  for (let k = 0; k < n; k++) {
    const p = pointAt(from + k);
    views[0].setFloat32(k * 4, p.x, true);
    views[1].setFloat32(k * 4, p.y, true);
    views[2].setFloat32(k * 4, p.z, true);
    const c = colorAt(from + k);
    channels[0][k] = c[0];
    channels[1][k] = c[1];
    channels[2][k] = c[2];
  }
  return [...axes, ...channels];
}

/** The CompressedVector section: a 32-byte header followed by one packet per bucket. */
function buildSection(records: number, sectionLogicalStart: number): Uint8Array {
  const packets: Uint8Array[] = [];
  for (let from = 0; from < records; from += RECORDS_PER_PACKET) {
    const streams = packetStreams(from, Math.min(from + RECORDS_PER_PACKET, records));
    const count = streams.length;
    const headerLen = 6 + count * 2;
    const bytes = streams.reduce((a, s) => a + s.length, 0);
    const packetLength = headerLen + bytes;
    if (packetLength > 65536) throw new Error('packet exceeds the uint16 length field');
    const packet = new Uint8Array(packetLength);
    const dv = new DataView(packet.buffer);
    packet[0] = 1; // DATA_PACKET
    dv.setUint16(2, packetLength - 1, true);
    dv.setUint16(4, count, true);
    streams.forEach((s, f) => dv.setUint16(6 + f * 2, s.length, true));
    let at = headerLen;
    for (const s of streams) {
      packet.set(s, at);
      at += s.length;
    }
    packets.push(packet);
  }
  const packetBytes = packets.reduce((a, p) => a + p.length, 0);
  const sectionLength = 32 + packetBytes;
  const section = new Uint8Array(sectionLength);
  const dv = new DataView(section.buffer);
  section[0] = 1; // COMPRESSED_VECTOR_SECTION
  dv.setBigUint64(8, BigInt(sectionLength), true);
  dv.setBigUint64(16, BigInt(logicalToPhysical(sectionLogicalStart + 32)), true);
  let at = 32;
  for (const p of packets) {
    section.set(p, at);
    at += p.length;
  }
  return section;
}

/** A complete, checksum-correct E57 file declaring `records` points. */
function buildE57(records: number): ArrayBuffer {
  const HEADER_LEN = 48;
  const xmlLogicalStart = HEADER_LEN;
  // The XML carries the section's physical offset, which depends on the XML's
  // own length. The offset's digit count is stable across the candidate range,
  // so one refinement pass converges; the assertion below proves it did.
  let fileOffset = 0;
  let xml = buildXml(records, fileOffset);
  for (let pass = 0; pass < 4; pass++) {
    const next = logicalToPhysical(xmlLogicalStart + Buffer.byteLength(xml, 'utf8'));
    if (next === fileOffset) break;
    fileOffset = next;
    xml = buildXml(records, fileOffset);
  }
  const xmlBytes = Buffer.from(xml, 'utf8');
  const sectionLogicalStart = xmlLogicalStart + xmlBytes.length;
  if (logicalToPhysical(sectionLogicalStart) !== fileOffset) {
    throw new Error('fileOffset did not converge — the XML length is unstable.');
  }

  const section = buildSection(records, sectionLogicalStart);
  const logicalLength = sectionLogicalStart + section.length;
  const logical = new Uint8Array(logicalLength);
  const hv = new DataView(logical.buffer);
  for (let i = 0; i < SIGNATURE.length; i++) logical[i] = SIGNATURE.charCodeAt(i);
  hv.setUint32(8, 1, true);
  hv.setUint32(12, 0, true);
  hv.setBigUint64(24, BigInt(logicalToPhysical(xmlLogicalStart)), true);
  hv.setBigUint64(32, BigInt(xmlBytes.length), true);
  hv.setBigUint64(40, BigInt(PAGE_SIZE), true);
  logical.set(xmlBytes, xmlLogicalStart);
  logical.set(section, sectionLogicalStart);

  const pageCount = Math.ceil(logicalLength / PAGE_PAYLOAD);
  hv.setBigUint64(16, BigInt(pageCount * PAGE_SIZE), true);
  const physical = new Uint8Array(pageCount * PAGE_SIZE);
  for (let p = 0; p < pageCount; p++) {
    const dst = physical.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
    dst.set(logical.subarray(p * PAGE_PAYLOAD, (p + 1) * PAGE_PAYLOAD), 0);
    new DataView(dst.buffer, dst.byteOffset + PAGE_PAYLOAD, 4).setUint32(
      0,
      crc32c(dst, 0, PAGE_PAYLOAD),
      false,
    );
  }
  return physical.buffer;
}

/** Records the file declares: two buckets' worth of the minimum sample, plus room. */
const RECORDS = 600_000;
const FILE = buildE57(RECORDS);

const FILE_ATTRIBUTES: PointAttributes = {
  hasColor: true,
  hasIntensity: false,
  hasClassification: false,
  hasNormals: false,
};
const COLUMNS_PER_RECORD = 6;

/**
 * A `deviceMemoryGB` whose ceiling leaves room for exactly `affordable`
 * records. Derived from the model rather than hard-coded, so a re-tune of the
 * cost constants moves these tests with it instead of silently invalidating
 * them — what each test pins is the DECISION, not the constant behind it.
 */
function deviceMemoryForAffordable(affordable: number): number {
  const fixed = estimateMemoryBytes({
    pointCount: 0,
    attributes: FILE_ATTRIBUTES,
    fileBytes: FILE.byteLength,
    format: 'e57',
    decodeColumnsPerPoint: COLUMNS_PER_RECORD,
  });
  const ceiling = fixed + affordable * e57BytesPerRecord(COLUMNS_PER_RECORD, FILE_ATTRIBUTES);
  // `memoryCeilingBytes` returns deviceMemoryGB x 1e9 x 0.6 on desktop.
  return ceiling / (1_000_000_000 * 0.6);
}

/** Comfortably above the full-decode estimate: no stride, no refusal. */
const FITS_GB = deviceMemoryForAffordable(RECORDS * 4);
/** Room for 400 k of 600 k records: stride 2, leaving 300 k points. */
const STRIDE_TWO_GB = deviceMemoryForAffordable(400_000);
/** Room for 200 k records: stride 3 would leave 200 k, under the sample floor. */
const BELOW_FLOOR_GB = deviceMemoryForAffordable(200_000);
/** Not even room for the two file copies: nothing to plan. */
const NO_ROOM_GB = 0.2;

// ────────────────────────────────────────────────────────────────────────────

describe('the synthetic multi-packet fixture', () => {
  it('declares what the builder says it declares', () => {
    const pre = preflightE57(FILE);
    expect(pre.scanCount).toBe(1);
    expect(pre.recordCount).toBe(RECORDS);
    expect(pre.columnsPerRecord).toBe(COLUMNS_PER_RECORD);
    expect(pre.attributes.hasColor).toBe(true);
  });

  it('decodes every record when nothing forces a stride', async () => {
    const cloud = await loadE57(FILE, 'stride.e57', { deviceMemoryGB: FITS_GB });
    expect(cloud.pointCount).toBe(RECORDS);
    expect(cloud.loadStride).toBe(1);
    expect(cloud.declaredPointCount).toBe(RECORDS);
    expect(cloud.decodedPointCount).toBe(RECORDS);
    expect(cloud.metadata?.loadWarnings ?? []).toEqual([]);
  });
});

describe('parseE57 — the strided read', () => {
  it('shortens every column to one record per bucket', () => {
    const parsed = parseE57(FILE, { stride: 4 });
    const scan = parsed.scans[0];
    expect(scan.recordCount).toBe(Math.ceil(RECORDS / 4));
    expect(scan.declaredRecordCount).toBe(RECORDS);
    for (const key of ['cartesianX', 'cartesianY', 'cartesianZ', 'colorRed']) {
      expect(scan.columns[key]).toHaveLength(Math.ceil(RECORDS / 4));
    }
  });

  it('reads the records the stratified sampler names, from the float columns', () => {
    // The same picker the LAS fast-load path uses, so a strided E57 samples the
    // file the same way a strided LAS samples its records.
    const expected = stratifiedSampleIndices(RECORDS, 5);
    const scan = parseE57(FILE, { stride: 5 }).scans[0];
    expect(scan.columns.cartesianX).toHaveLength(expected.length);
    for (let b = 0; b < expected.length; b += 977) {
      expect(scan.columns.cartesianX[b]).toBe(pointAt(expected[b]).x);
      expect(scan.columns.cartesianZ[b]).toBe(pointAt(expected[b]).z);
    }
  });

  it('reads the SAME records in the bit-packed integer columns', () => {
    // A column that sampled different records than its neighbours would put
    // one point's colour on another point's coordinates — a silent, plausible
    // corruption. Every field restarts the picker from the one fixed seed.
    const expected = stratifiedSampleIndices(RECORDS, 5);
    const scan = parseE57(FILE, { stride: 5 }).scans[0];
    for (let b = 0; b < expected.length; b += 977) {
      const [r, g, bl] = colorAt(expected[b]);
      expect(scan.columns.colorRed[b]).toBe(r);
      expect(scan.columns.colorGreen[b]).toBe(g);
      expect(scan.columns.colorBlue[b]).toBe(bl);
    }
  });

  it('samples across the whole file, not just its head', () => {
    // Plain head-truncation would pass every alignment check above and still be
    // wrong: the last bucket must come from the last records.
    const scan = parseE57(FILE, { stride: 5 }).scans[0];
    const last = scan.columns.cartesianX[scan.recordCount - 1];
    expect(last).toBeGreaterThan(RECORDS - 5);
  });

  it('a stride of 1 reads exactly what an unstrided parse reads', () => {
    const plain = parseE57(FILE).scans[0];
    const one = parseE57(FILE, { stride: 1 }).scans[0];
    expect(one.recordCount).toBe(plain.recordCount);
    expect(Array.from(one.columns.cartesianX.subarray(0, 64))).toEqual(
      Array.from(plain.columns.cartesianX.subarray(0, 64)),
    );
  });
});

describe('loadE57 — stride or refuse', () => {
  it('strides when the full read would not fit, and keeps the sampled points', async () => {
    const plan = planE57Decode({
      sourceCount: RECORDS,
      fileBytes: FILE.byteLength,
      columnsPerRecord: COLUMNS_PER_RECORD,
      attributes: FILE_ATTRIBUTES,
      isMobile: false,
      deviceMemoryGB: STRIDE_TWO_GB,
    });
    expect(plan.stride).toBe(2);

    const cloud = await loadE57(FILE, 'stride.e57', { deviceMemoryGB: STRIDE_TWO_GB });
    expect(cloud.pointCount).toBe(Math.ceil(RECORDS / 2));
    expect(cloud.loadStride).toBe(2);
  });

  it('keeps the declared file total beside the sampled count', async () => {
    // What makes the sample legible downstream: the Health Check's
    // declared-vs-decoded row and the exporters' scope line both read these.
    const cloud = await loadE57(FILE, 'stride.e57', { deviceMemoryGB: STRIDE_TWO_GB });
    expect(cloud.declaredPointCount).toBe(RECORDS);
    expect(cloud.decodedPointCount).toBe(Math.ceil(RECORDS / 2));
    expect(cloud.decodedPointCount).toBeLessThan(cloud.declaredPointCount!);
  });

  it('states the sampling in words on the cloud', async () => {
    const cloud = await loadE57(FILE, 'stride.e57', { deviceMemoryGB: STRIDE_TWO_GB });
    const warnings = cloud.metadata?.loadWarnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Read as a sample');
    expect(warnings[0]).toContain('one record per 2');
    expect(warnings[0]).toContain('300,000 of 600,000');
    // The claim that matters: the numbers describe the sample, not the scan.
    expect(warnings[0]).toMatch(/densities/);
    expect(warnings[0]).toMatch(/COPC|EPT/);
  });

  it('the exported file declares itself a subset of the scan', async () => {
    const cloud = await loadE57(FILE, 'stride.e57', { deviceMemoryGB: STRIDE_TWO_GB });
    const header = toXyz(cloud).split('\n').slice(0, 20).join('\n');
    expect(header).toContain('SUBSET');
    expect(header).toContain('load stride 2');
    expect(header).toContain('sample of the scan');
  });

  it('the sampled colours still belong to the sampled points', async () => {
    const cloud = await loadE57(FILE, 'stride.e57', { deviceMemoryGB: STRIDE_TWO_GB });
    const kept = stratifiedSampleIndices(RECORDS, 2);
    for (let b = 0; b < kept.length; b += 4001) {
      const [r, g, bl] = colorAt(kept[b]);
      expect(cloud.colors![b * 3]).toBe(r);
      expect(cloud.colors![b * 3 + 1]).toBe(g);
      expect(cloud.colors![b * 3 + 2]).toBe(bl);
    }
  });

  it('scales no count back up to the whole scan', async () => {
    // `deriveCoreParams` builds `samplePointScale` from the RESIDENT cloud's own
    // point count (the viewer's gather reports `cloud.pointCount`), so it
    // back-scales the ANALYSIS gather's cap and nothing else. Had the loader
    // inflated any of the cloud's own counts toward the file's declared total,
    // that scale would sit on top of a count already claiming the whole scan and
    // every density would come out `stride` times too high. So the sampled count
    // is the only number the cloud reports about itself, and the declared total
    // lives in its own clearly-named field.
    const cloud = await loadE57(FILE, 'stride.e57', { deviceMemoryGB: STRIDE_TWO_GB });
    const sampled = Math.ceil(RECORDS / 2);
    expect(cloud.pointCount).toBe(sampled);
    expect(cloud.decodedPointCount).toBe(sampled);
    expect(cloud.positions).toHaveLength(sampled * 3);
    expect(cloud.colors).toHaveLength(sampled * 3);
    expect(cloud.declaredPointCount).toBe(RECORDS);
  });

  it('refuses before decoding when the sample would fall under the floor', async () => {
    await expect(
      loadE57(FILE, 'stride.e57', { deviceMemoryGB: BELOW_FLOOR_GB }),
    ).rejects.toThrow(/too large for this device/);
  });

  it('refuses before decoding when the file copies alone bust the ceiling', async () => {
    await expect(
      loadE57(FILE, 'stride.e57', { deviceMemoryGB: NO_ROOM_GB }),
    ).rejects.toThrow(LoadError);
  });

  it('the refusal names the estimate, the ceiling and the streaming alternative', async () => {
    let err: unknown;
    try {
      await loadE57(FILE, 'stride.e57', { deviceMemoryGB: NO_ROOM_GB });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LoadError);
    const refusal = err as LoadError;
    expect(refusal.category).toBe('memory-constraint');
    expect(refusal.message).toMatch(/\d+(\.\d+)?\s?(MB|GB)/);
    expect(refusal.message).toContain('budget for this device');
    expect(refusal.message).toContain('COPC');
    expect(refusal.message).toContain('EPT');
  });

  it('a refusal costs the preflight, not a decode', async () => {
    // The point of refusing here: the tab died mid-decode with no way back, so
    // the guard has to run before the allocation, not after it. A refusal that
    // took as long as a decode would be evidence it decoded first.
    const started = performance.now();
    await loadE57(FILE, 'stride.e57', { deviceMemoryGB: NO_ROOM_GB }).catch(() => undefined);
    const refusalMs = performance.now() - started;
    const decodeStarted = performance.now();
    await loadE57(FILE, 'stride.e57', { deviceMemoryGB: FITS_GB });
    const decodeMs = performance.now() - decodeStarted;
    expect(refusalMs).toBeLessThan(decodeMs / 2);
  });
});

describe('the preload summary, before the file is read', () => {
  /** The file as the browser hands it to `fileMetadata`. */
  const asFile = (): File => new File([FILE], 'stride.e57', { type: '' });

  it('states the declared point count without decoding a point', async () => {
    const meta = await fileMetadata(asFile(), { deviceMemoryGB: FITS_GB });
    expect(meta.format).toBe('e57');
    expect(meta.estimatedPointCount).toBe(RECORDS);
    expect(meta.loadModeSummary).toBe('Standard load');
  });

  it('warns that the read will be a sample, with the stride and the counts', async () => {
    const meta = await fileMetadata(asFile(), { deviceMemoryGB: STRIDE_TWO_GB });
    expect(meta.loadModeSummary).toBe('Large-file optimization enabled');
    expect(meta.warning).toContain('SAMPLE');
    expect(meta.warning).toContain('one record per 2');
    expect(meta.warning).toContain('300K of 600K');
  });

  it('warns that the open will be refused, before the whole file is read', async () => {
    // The refusal itself lives in the loader, which only runs after the browser
    // has pulled the whole file into memory. Saying it here costs two small
    // slices, so the user is not told after a multi-hundred-megabyte wait.
    const meta = await fileMetadata(asFile(), { deviceMemoryGB: NO_ROOM_GB });
    expect(meta.warning).toContain('too large for this device');
    expect(meta.warning).toContain('COPC/EPT');
  });
});
