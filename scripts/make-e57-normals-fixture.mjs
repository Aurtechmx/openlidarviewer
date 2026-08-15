#!/usr/bin/env node
/**
 * make-e57-normals-fixture.mjs — a project-owned SYNTHETIC E57 fixture that
 * carries surface normals under the `nor:` extension namespace.
 *
 * WHY THIS EXISTS. Real scanner E57s store surface normals in the libE57
 * surface-normals extension, so the prototype fields are `nor:normalX/Y/Z`, not
 * the bare `normalX`. `loadE57` resolves normals by LOCAL name so those files
 * light up the Viewer's normal-shading mode; this fixture is the committed,
 * deterministic regression target for that path — a namespaced-normals file the
 * reader must decode and hand to the PointCloud as unit normals.
 *
 * It mirrors `make-e57-fixture.mjs` (same header → depage → xml → schema →
 * compressedVector inverse, same big-endian CRC-32C paging), adding three Float
 * normal fields declared under an `xmlns:nor` binding on the root. Determinism
 * is a hard requirement: no timestamps, no randomness. Regenerate with
 * `node scripts/make-e57-normals-fixture.mjs`.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE_SIZE = 1024;
const PAGE_PAYLOAD = PAGE_SIZE - 4;
const SIGNATURE = 'ASTM-E57';

function logicalToPhysical(logical) {
  const page = Math.floor(logical / PAGE_PAYLOAD);
  const within = logical % PAGE_PAYLOAD;
  return page * PAGE_SIZE + within;
}

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32c(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC32C_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Eight points; every fourth is invalid (indices 3, 7). Normals cycle through
// the three axis-aligned unit vectors, exact in single precision and unit
// length, so a decode assertion can compare against the literals directly.
const AXES = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const POINTS = Array.from({ length: 8 }, (_, i) => ({
  x: i * 0.25,
  y: i * 0.5,
  z: i,
  invalid: i % 4 === 3 ? 1 : 0,
  n: AXES[i % 3],
}));
const N = POINTS.length;
const SCAN_NAME = 'synthetic-normals';

function buildXml(pointsFileOffset) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<e57Root type="Structure" xmlns="http://www.astm.org/COMMIT/E57/2010-e57-v1.0"' +
    ' xmlns:nor="http://www.libe57.org/E57_NOR_surface_normals.txt">\n' +
    '  <formatName type="String">ASTM E57 3D Imaging Data File</formatName>\n' +
    '  <guid type="String">synthetic-normals-fixture-0000-0000-000000000001</guid>\n' +
    '  <versionMajor type="Integer">1</versionMajor>\n' +
    '  <versionMinor type="Integer">0</versionMinor>\n' +
    '  <e57LibraryVersion type="String">OpenLiDARViewer synthetic fixture generator</e57LibraryVersion>\n' +
    '  <data3D type="Vector" allowHeterogeneousChildren="1">\n' +
    '    <vectorChild type="Structure">\n' +
    '      <guid type="String">synthetic-normals-scan-0000-0000-000000000001</guid>\n' +
    `      <name type="String">${SCAN_NAME}</name>\n` +
    `      <points type="CompressedVector" fileOffset="${pointsFileOffset}" recordCount="${N}">\n` +
    '        <prototype type="Structure">\n' +
    '          <cartesianX type="Float" precision="single"/>\n' +
    '          <cartesianY type="Float" precision="single"/>\n' +
    '          <cartesianZ type="Float" precision="single"/>\n' +
    '          <cartesianInvalidState type="Integer" minimum="0" maximum="1"/>\n' +
    '          <nor:normalX type="Float" precision="single"/>\n' +
    '          <nor:normalY type="Float" precision="single"/>\n' +
    '          <nor:normalZ type="Float" precision="single"/>\n' +
    '        </prototype>\n' +
    '        <codecs type="Vector" allowHeterogeneousChildren="1"/>\n' +
    '      </points>\n' +
    '    </vectorChild>\n' +
    '  </data3D>\n' +
    '</e57Root>\n'
  );
}

function buildBytestreams() {
  const floatStream = (get) => {
    const buf = new Uint8Array(N * 4);
    const dv = new DataView(buf.buffer);
    POINTS.forEach((p, i) => dv.setFloat32(i * 4, get(p), true));
    return buf;
  };
  const invalidStream = () => {
    const buf = new Uint8Array(Math.ceil(N / 8));
    POINTS.forEach((p, i) => {
      if (p.invalid) buf[i >> 3] |= 1 << (i & 7);
    });
    return buf;
  };
  return [
    floatStream((p) => p.x),
    floatStream((p) => p.y),
    floatStream((p) => p.z),
    invalidStream(),
    floatStream((p) => p.n[0]),
    floatStream((p) => p.n[1]),
    floatStream((p) => p.n[2]),
  ];
}

function buildCompressedVectorSection(sectionLogicalStart) {
  const streams = buildBytestreams();
  const count = streams.length;
  const streamsBytes = streams.reduce((a, s) => a + s.length, 0);
  const packetHeaderLen = 6 + count * 2;
  const packetLength = packetHeaderLen + streamsBytes;
  const sectionLength = 32 + packetLength;

  const section = new Uint8Array(sectionLength);
  const dv = new DataView(section.buffer);
  section[0] = 1;
  dv.setBigUint64(8, BigInt(sectionLength), true);
  const dataPhysicalOffset = logicalToPhysical(sectionLogicalStart + 32);
  dv.setBigUint64(16, BigInt(dataPhysicalOffset), true);

  const pkt = 32;
  section[pkt] = 1;
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

function build() {
  const HEADER_LEN = 48;
  const xmlLogicalStart = HEADER_LEN;

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

  const hv = new DataView(logical.buffer);
  for (let i = 0; i < SIGNATURE.length; i++) logical[i] = SIGNATURE.charCodeAt(i);
  hv.setUint32(8, 1, true);
  hv.setUint32(12, 0, true);
  hv.setBigUint64(24, BigInt(logicalToPhysical(xmlLogicalStart)), true);
  hv.setBigUint64(32, BigInt(xmlBytes.length), true);
  hv.setBigUint64(40, BigInt(PAGE_SIZE), true);

  logical.set(xmlBytes, xmlLogicalStart);
  logical.set(section, cvLogicalStart);

  const pageCount = Math.ceil(logicalLength / PAGE_PAYLOAD);
  const physical = new Uint8Array(pageCount * PAGE_SIZE);
  hv.setBigUint64(16, BigInt(pageCount * PAGE_SIZE), true);
  for (let p = 0; p < pageCount; p++) {
    const src = logical.subarray(p * PAGE_PAYLOAD, (p + 1) * PAGE_PAYLOAD);
    const dst = physical.subarray(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
    dst.set(src, 0);
    const crc = crc32c(dst.subarray(0, PAGE_PAYLOAD));
    new DataView(dst.buffer, dst.byteOffset + PAGE_PAYLOAD, 4).setUint32(0, crc, false);
  }
  return physical;
}

const out = fileURLToPath(new URL('../tests/fixtures/synthetic-normals.e57', import.meta.url));
const bytes = build();
writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.length} bytes, ${bytes.length / PAGE_SIZE} pages)`);
