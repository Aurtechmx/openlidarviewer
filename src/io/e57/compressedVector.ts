/**
 * compressedVector.ts
 *
 * Decodes an E57 CompressedVector binary section into per-field columns.
 *
 * Layout (validated against real Trimble and reference E57 files): the section
 * begins with a 32-byte header pointing at the first data packet. Each data
 * packet holds a 6-byte header, a `uint16` length per bytestream, then the
 * bytestream buffers. Every prototype field has one bytestream per packet —
 * those per-packet chunks concatenate into one continuous stream for the
 * field, which is then decoded: Float fields as raw IEEE values, Integer
 * fields as LSB-first bit-packed values offset by the field minimum.
 */

import type { E57Field } from './schema';
import { physicalToLogical } from './depage';

/** Decoded point data — one Float64 column per prototype field, by field name. */
export type DecodedColumns = Record<string, Float64Array>;

/** Section / packet type ids from the E57 standard. */
const COMPRESSED_VECTOR_SECTION = 1;
const DATA_PACKET = 1;

/** Decode a scan's CompressedVector into per-field columns. */
export function decodeCompressedVector(
  logical: Uint8Array,
  fileOffset: number,
  recordCount: number,
  prototype: E57Field[],
  pageSize: number,
): DecodedColumns {
  const view = new DataView(logical.buffer, logical.byteOffset, logical.byteLength);

  const sectionStart = physicalToLogical(fileOffset, pageSize);
  if (logical[sectionStart] !== COMPRESSED_VECTOR_SECTION) {
    throw new Error('E57: expected a CompressedVector section.');
  }
  const sectionLogicalLength = Number(view.getBigUint64(sectionStart + 8, true));
  const dataPhysicalOffset = Number(view.getBigUint64(sectionStart + 16, true));
  // The data packets belong to this section only. In a multi-scan file the
  // next scan's section header follows immediately — and a section id is also
  // 1, identical to a data-packet type — so the walk must stop at the section
  // boundary, not merely on the first non-data byte.
  const sectionEnd = sectionStart + sectionLogicalLength;

  // Collect each field's per-packet bytestream chunks.
  const fieldCount = prototype.length;
  const chunks: Uint8Array[][] = prototype.map(() => []);
  let packetAt = physicalToLogical(dataPhysicalOffset, pageSize);

  while (
    packetAt + 6 <= logical.length &&
    packetAt < sectionEnd &&
    logical[packetAt] === DATA_PACKET
  ) {
    const packetLength = view.getUint16(packetAt + 2, true) + 1;
    const bytestreamCount = view.getUint16(packetAt + 4, true);
    if (bytestreamCount !== fieldCount) {
      throw new Error('E57: packet bytestream count does not match the prototype.');
    }
    let chunkAt = packetAt + 6 + bytestreamCount * 2;
    for (let f = 0; f < fieldCount; f++) {
      const length = view.getUint16(packetAt + 6 + f * 2, true);
      chunks[f].push(logical.subarray(chunkAt, chunkAt + length));
      chunkAt += length;
    }
    packetAt += packetLength;
  }

  const columns: DecodedColumns = {};
  prototype.forEach((field, f) => {
    columns[field.name] = decodeField(concat(chunks[f]), field, recordCount);
  });
  return columns;
}

/** Join a field's per-packet chunks into one continuous buffer. */
function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Decode one field's continuous bytestream into `count` values. */
function decodeField(buffer: Uint8Array, field: E57Field, count: number): Float64Array {
  const out = new Float64Array(count);

  if (field.type === 'float') {
    const bytes = field.floatBytes ?? 8;
    if (buffer.byteLength < count * bytes) {
      throw new Error('E57: truncated float bytestream.');
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    for (let i = 0; i < count; i++) {
      out[i] = bytes === 4 ? view.getFloat32(i * 4, true) : view.getFloat64(i * 8, true);
    }
    return out;
  }

  // Integer / scaledInteger — LSB-first bit-packed, offset by the minimum.
  const bitWidth = field.bitWidth ?? 0;
  const minimum = field.minimum ?? 0;
  const scale = field.scale ?? 1;
  const offset = field.offset ?? 0;
  let bitPos = 0;
  for (let i = 0; i < count; i++) {
    let packed = 0;
    for (let k = 0; k < bitWidth; k++) {
      const byteIndex = bitPos >> 3;
      const bit = byteIndex < buffer.length ? (buffer[byteIndex] >> (bitPos & 7)) & 1 : 0;
      packed += bit * 2 ** k;
      bitPos++;
    }
    const value = packed + minimum;
    out[i] = field.type === 'scaledInteger' ? value * scale + offset : value;
  }
  return out;
}
