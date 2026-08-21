#!/usr/bin/env node
/**
 * make-e57-fixture.mjs — a project-owned SYNTHETIC E57 fixture generator.
 *
 * WHY THIS EXISTS. The E57 reader's exact-decode assertions need a fixture whose
 * every byte is known and reproducible from source. This script emits a small,
 * deterministic, project-owned E57 covering those decode paths, so the
 * assertions hold without depending on any external corpus. The libE57
 * BunnyFloat file is committed alongside it at `tests/bunnyFloat.e57` and covers
 * the same Float profile as a third-party writer produced it:
 *
 *   1. a single named scan ("synthetic-grid");
 *   2. a prototype of three Float (single-precision, 4-byte) cartesian fields
 *      plus a 1-bit Integer `cartesianInvalidState` flag;
 *   3. correct IEEE-754 single-precision cartesian decode;
 *   4. a bit-packed 1-bit invalid-state column decoding to 0/1 values.
 *
 * The output is the inverse of `src/io/e57/` (header → depage → xml → schema →
 * compressedVector). Determinism is a hard requirement: no timestamps, no
 * randomness — the same bytes every run — so the committed fixture is a stable
 * decode target. Re-run with `node scripts/make-e57-fixture.mjs` to regenerate.
 *
 * PHYSICAL vs LOGICAL. An E57 file is a sequence of 1024-byte pages; the last 4
 * bytes of every page are a big-endian CRC-32C checksum over that page's first
 * 1020 bytes.
 * "Logical" space is the file with those checksums removed (what the reader's
 * `depage` produces). We build the logical bytes first, record logical offsets,
 * convert them to the physical offsets the header/section fields store, then
 * split the logical stream into 1020-byte pages and append each page's checksum.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE_SIZE = 1024;
const PAGE_PAYLOAD = PAGE_SIZE - 4; // 1020 logical bytes per physical page
const SIGNATURE = 'ASTM-E57';

/** Logical offset → physical offset (inverse of the reader's physicalToLogical). */
function logicalToPhysical(logical) {
  const page = Math.floor(logical / PAGE_PAYLOAD);
  const within = logical % PAGE_PAYLOAD;
  return page * PAGE_SIZE + within;
}

/**
 * CRC-32C (Castagnoli, polynomial 0x1EDC6F41, reflected). The E57 page checksum.
 * Table-driven, reflected form (LSB-first), stored BIG-ENDIAN per page.
 *
 * The byte order matters and used to be wrong here: this generator wrote the
 * checksum little-endian, which no real E57 does. It went unnoticed because
 * the reader stripped page checksums without verifying them, so the fixture
 * decoded fine while being a file libE57 would have rejected. The order was
 * settled against `tests/pumpARowColumnIndexNoInvalidPoints.e57`, a genuine
 * libE57-written file, whose 2536 pages all match big-endian and none match
 * little-endian. `src/io/e57/depage.ts` now verifies every page, so a fixture
 * with the wrong byte order would fail the suite outright.
 */
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32c(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32C_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── The synthetic point cloud ────────────────────────────────────────────────
// Eight points on a deterministic line. Coordinates are exact multiples chosen
// to round-trip through IEEE-754 single precision with no rounding, so the
// decode assertions can compare against these literals directly. The invalid
// flag marks every fourth point (indices 3 and 7) as invalid.
const POINTS = Array.from({ length: 8 }, (_, i) => ({
  x: i * 0.25, // 0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75
  y: i * 0.5, // 0, 0.5, 1.0, ...
  z: i, // 0, 1, 2, ...
  invalid: i % 4 === 3 ? 1 : 0, // [0,0,0,1,0,0,0,1]
}));
const N = POINTS.length;
const SCAN_NAME = 'synthetic-grid';

// ── The XML section ──────────────────────────────────────────────────────────
// Only the elements this reader actually consumes. The `fileOffset` attribute is
// filled in after we know where the CompressedVector section lands in physical
// space, so the XML is assembled in two halves around a placeholder.
function buildXml(pointsFileOffset) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<e57Root type="Structure">\n' +
    '  <formatName type="String">ASTM E57 3D Imaging Data File</formatName>\n' +
    '  <guid type="String">synthetic-grid-fixture-0000-0000-000000000001</guid>\n' +
    '  <versionMajor type="Integer">1</versionMajor>\n' +
    '  <versionMinor type="Integer">0</versionMinor>\n' +
    '  <e57LibraryVersion type="String">OpenLiDARViewer synthetic fixture generator</e57LibraryVersion>\n' +
    '  <data3D type="Vector" allowHeterogeneousChildren="1">\n' +
    '    <vectorChild type="Structure">\n' +
    `      <guid type="String">synthetic-grid-scan-0000-0000-000000000001</guid>\n` +
    `      <name type="String">${SCAN_NAME}</name>\n` +
    `      <points type="CompressedVector" fileOffset="${pointsFileOffset}" recordCount="${N}">\n` +
    '        <prototype type="Structure">\n' +
    '          <cartesianX type="Float" precision="single"/>\n' +
    '          <cartesianY type="Float" precision="single"/>\n' +
    '          <cartesianZ type="Float" precision="single"/>\n' +
    '          <cartesianInvalidState type="Integer" minimum="0" maximum="1"/>\n' +
    '        </prototype>\n' +
    '        <codecs type="Vector" allowHeterogeneousChildren="1"/>\n' +
    '      </points>\n' +
    '    </vectorChild>\n' +
    '  </data3D>\n' +
    '</e57Root>\n'
  );
}

// ── The CompressedVector binary section ──────────────────────────────────────
// Field bytestreams (concatenated, one per prototype field):
//   0,1,2: cartesian X/Y/Z as little-endian float32 — N*4 bytes each.
//   3:     cartesianInvalidState — LSB-first bit-packed 1-bit values — ceil(N/8).
function buildBytestreams() {
  const floatStream = (key) => {
    const buf = new Uint8Array(N * 4);
    const dv = new DataView(buf.buffer);
    POINTS.forEach((p, i) => dv.setFloat32(i * 4, p[key], true));
    return buf;
  };
  const invalidStream = () => {
    const buf = new Uint8Array(Math.ceil(N / 8));
    POINTS.forEach((p, i) => {
      if (p.invalid) buf[i >> 3] |= 1 << (i & 7); // LSB-first, matching the reader
    });
    return buf;
  };
  return [floatStream('x'), floatStream('y'), floatStream('z'), invalidStream()];
}

/**
 * Build the CompressedVector section as one contiguous logical block.
 *
 * Layout (see compressedVector.ts):
 *   +0        : section id byte = 1 (COMPRESSED_VECTOR_SECTION)
 *   +8  u64le : section logical length (whole section, incl. the data packet)
 *   +16 u64le : physical offset of the first data packet
 *   +32       : the data packet begins (the section header is 32 bytes)
 * Data packet:
 *   +0        : packet type byte = 1 (DATA_PACKET)
 *   +2  u16le : packetLength - 1  (total packet byte length minus one)
 *   +4  u16le : bytestream count  (= prototype field count)
 *   +6  u16le[count] : per-bytestream lengths
 *   then the bytestream buffers, concatenated.
 */
function buildCompressedVectorSection(sectionLogicalStart) {
  const streams = buildBytestreams();
  const count = streams.length;
  const streamsBytes = streams.reduce((a, s) => a + s.length, 0);
  const packetHeaderLen = 6 + count * 2; // type/flags/len/count + length table
  const packetLength = packetHeaderLen + streamsBytes;
  const sectionLength = 32 + packetLength;

  const section = new Uint8Array(sectionLength);
  const dv = new DataView(section.buffer);

  // Section header (32 bytes).
  section[0] = 1; // COMPRESSED_VECTOR_SECTION
  dv.setBigUint64(8, BigInt(sectionLength), true);
  const dataPhysicalOffset = logicalToPhysical(sectionLogicalStart + 32);
  dv.setBigUint64(16, BigInt(dataPhysicalOffset), true);

  // Data packet.
  const pkt = 32;
  section[pkt] = 1; // DATA_PACKET
  dv.setUint16(pkt + 2, packetLength - 1, true);
  dv.setUint16(pkt + 4, count, true);
  streams.forEach((s, f) => dv.setUint16(pkt + 6 + f * 2, s.length, true));
  let at = pkt + packetHeaderLen;
  for (const s of streams) {
    section.set(s, at);
    at += s.length;
  }
  return section;
}

// ── Assemble the logical stream, then re-page it into the physical file ───────
function build() {
  // Logical layout: [48-byte header][XML][CompressedVector section].
  const HEADER_LEN = 48;
  const xmlLogicalStart = HEADER_LEN;

  // The XML length depends on the points fileOffset, which depends on where the
  // CV section starts, which depends on the XML length. Break the cycle: the
  // fileOffset is a decimal integer whose digit count is stable across the tiny
  // range of candidate offsets here, so one pass converges. Assemble with a
  // placeholder, compute the real offset, rebuild, and assert it settled.
  let pointsFileOffset = 0;
  let xml = buildXml(pointsFileOffset);
  for (let pass = 0; pass < 4; pass++) {
    const xmlBytes = Buffer.from(xml, 'utf8');
    const cvLogicalStart = xmlLogicalStart + xmlBytes.length;
    const nextOffset = logicalToPhysical(cvLogicalStart);
    if (nextOffset === pointsFileOffset) break;
    pointsFileOffset = nextOffset;
    xml = buildXml(pointsFileOffset);
  }
  const xmlBytes = Buffer.from(xml, 'utf8');
  const cvLogicalStart = xmlLogicalStart + xmlBytes.length;
  if (logicalToPhysical(cvLogicalStart) !== pointsFileOffset) {
    throw new Error('fileOffset did not converge — XML length is unstable.');
  }

  const section = buildCompressedVectorSection(cvLogicalStart);
  const logicalLength = cvLogicalStart + section.length;
  const logical = new Uint8Array(logicalLength);

  // Header (48 bytes) at logical 0.
  const hv = new DataView(logical.buffer);
  for (let i = 0; i < SIGNATURE.length; i++) logical[i] = SIGNATURE.charCodeAt(i);
  hv.setUint32(8, 1, true); // versionMajor
  hv.setUint32(12, 0, true); // versionMinor
  // filePhysicalLength is the total PAGED byte length, filled in below.
  hv.setBigUint64(24, BigInt(logicalToPhysical(xmlLogicalStart)), true); // xmlPhysicalOffset
  hv.setBigUint64(32, BigInt(xmlBytes.length), true); // xmlLogicalLength
  hv.setBigUint64(40, BigInt(PAGE_SIZE), true); // pageSize

  logical.set(xmlBytes, xmlLogicalStart);
  logical.set(section, cvLogicalStart);

  // Re-page: split logical into 1020-byte payloads, append each page's CRC-32C.
  const pageCount = Math.ceil(logicalLength / PAGE_PAYLOAD);
  const physical = new Uint8Array(pageCount * PAGE_SIZE);
  // Write filePhysicalLength now that the page count is known.
  hv.setBigUint64(16, BigInt(pageCount * PAGE_SIZE), true);
  for (let p = 0; p < pageCount; p++) {
    const src = logical.subarray(p * PAGE_PAYLOAD, (p + 1) * PAGE_PAYLOAD);
    const dst = physical.subarray(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
    dst.set(src, 0); // trailing payload bytes of the last page stay zero
    const crc = crc32c(dst.subarray(0, PAGE_PAYLOAD));
    new DataView(dst.buffer, dst.byteOffset + PAGE_PAYLOAD, 4).setUint32(0, crc, false);
  }
  return physical;
}

const out = fileURLToPath(new URL('../tests/fixtures/synthetic.e57', import.meta.url));
const bytes = build();
writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.length} bytes, ${bytes.length / PAGE_SIZE} pages)`);
