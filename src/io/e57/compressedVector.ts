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
import { validateDeclaredPointCount } from '../validateCount';
import { makePrng, pickInBucket, STRIDE_SAMPLE_SEED } from '../strideSample';

/** Decoded point data — one Float64 column per prototype field, by field name. */
export type DecodedColumns = Record<string, Float64Array>;

/** Section / packet type ids from the E57 standard. */
const COMPRESSED_VECTOR_SECTION = 1;
const DATA_PACKET = 1;

/**
 * Read a little-endian uint64 that MUST be a safe integer. E57 offsets and
 * lengths above 2^53 are unsupported (a browser cannot address them anyway),
 * and coercing them through `Number` silently loses precision — so a value that
 * large is a corrupt or hostile file and fails here, named.
 */
function safeUint64(view: DataView, offset: number, what: string): number {
  const raw = view.getBigUint64(offset, true);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`E57: ${what} ${raw} exceeds the safe-integer range — unsupported.`);
  }
  return Number(raw);
}

/** Per-call decode controls for {@link decodeCompressedVector}. */
export interface DecodeCompressedVectorOptions {
  /**
   * Decode only the prototype fields this accepts (by name). The bytestream
   * walk still visits every field — the per-packet stream lengths that position
   * each column are interleaved — but a rejected field is never concatenated or
   * expanded into a Float64Array. The loader passes this to skip prototype
   * columns it does not consume (a structured scan's row/column index, say),
   * which on a tens-of-millions-of-points file is hundreds of MB of allocation
   * and per-value conversion avoided. Omitted → every field decodes.
   */
  keepField?: (name: string) => boolean;
  /**
   * Read one record per bucket of `stride` instead of every record, so the
   * columns come out `ceil(recordCount / stride)` long. 1 (the default) reads
   * every record. Every field samples the SAME record indices — the picker is
   * re-seeded per field from the one fixed seed — so the columns stay aligned
   * with each other.
   */
  stride?: number;
}

/**
 * Decode a scan's CompressedVector into per-field columns.
 *
 * With `options.stride > 1` the columns hold a stratified sample of the records
 * rather than all of them; see {@link DecodeCompressedVectorOptions}.
 */
export function decodeCompressedVector(
  logical: Uint8Array,
  fileOffset: number,
  recordCount: number,
  prototype: E57Field[],
  pageSize: number,
  options?: DecodeCompressedVectorOptions,
): DecodedColumns {
  const keepField = options?.keepField;
  const stride = Math.max(1, Math.floor(options?.stride ?? 1));
  const view = new DataView(logical.buffer, logical.byteOffset, logical.byteLength);

  const sectionStart = physicalToLogical(fileOffset, pageSize);
  if (logical[sectionStart] !== COMPRESSED_VECTOR_SECTION) {
    throw new Error('E57: expected a CompressedVector section.');
  }
  // Strict uint64 — the header path already refuses a non-safe-integer length,
  // and these two section fields size the walk + a page-offset conversion, so a
  // value above 2^53 must fail loudly here rather than silently lose precision
  // (M7). `Number(getBigUint64)` alone drops bits above the safe range.
  const sectionLogicalLength = safeUint64(view, sectionStart + 8, 'CompressedVector section length');
  const dataPhysicalOffset = safeUint64(view, sectionStart + 16, 'CompressedVector data offset');
  // The data packets belong to this section only. In a multi-scan file the
  // next scan's section header follows immediately — and a section id is also
  // 1, identical to a data-packet type — so the walk must stop at the section
  // boundary, not merely on the first non-data byte.
  const sectionEnd = sectionStart + sectionLogicalLength;

  // Allocation guard — `decodeField` below allocates one Float64Array of
  // `recordCount` values PER prototype field, and `recordCount` comes from
  // an XML attribute in a possibly-remote file. Bound it by the bytes this
  // section can actually hold at the prototype's own minimal record size
  // before any column is allocated. (The truncation guards inside
  // `decodeField` then handle byte-exact shortfalls; this guard exists to
  // stop a header claiming 10^12 records from allocating terabytes first.)
  // Float fields can't pack below their IEEE width; integer fields can't
  // pack below their declared bit width — so the per-record floor is the
  // prototype's summed minimum, never less than one byte.
  let minBitsPerRecord = 0;
  for (const field of prototype) {
    minBitsPerRecord +=
      field.type === 'float' ? (field.floatBytes ?? 8) * 8 : (field.bitWidth ?? 0);
  }
  const minBytesPerRecord = Math.max(1, Math.floor(minBitsPerRecord / 8));
  // The section's own declared length is also file data — cap it by the
  // bytes genuinely present so a lying section header can't widen the bound.
  const sectionBytes = Math.max(0, Math.min(sectionLogicalLength, logical.length - sectionStart));
  const count = validateDeclaredPointCount(
    recordCount,
    sectionBytes,
    minBytesPerRecord,
    'E57 CompressedVector',
  );

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
      // A CompressedVector may hold zero records: the standard sets no lower
      // bound on `recordCount`, and libE57Format closes such a section with an
      // 8-byte data packet that declares no bytestreams and carries no length
      // table. Nothing in that packet is readable, so the walk ends here and
      // every prototype column decodes to length 0. The condition is narrow: a
      // packet that declares bytestreams still has to declare one per prototype
      // field, and a file that declares records still has to supply them.
      if (count === 0 && bytestreamCount === 0) break;
      throw new Error('E57: packet bytestream count does not match the prototype.');
    }
    // The packet must lie wholly inside this section AND the real buffer — a
    // corrupt packetLength could otherwise run the walk past the section into
    // the next scan, or past the file. `subarray` alone clamps to the buffer
    // but knows nothing of the logical section/packet boundary (pass-4 #4).
    const packetEnd = packetAt + packetLength;
    if (packetEnd > sectionEnd || packetEnd > logical.length) {
      throw new Error('E57: a data packet extends past its section or the file.');
    }
    // The 6-byte header + the uint16-per-stream length table must fit before the
    // first bytestream; a packetLength shorter than that is malformed.
    const streamsStart = packetAt + 6 + bytestreamCount * 2;
    if (streamsStart > packetEnd) {
      throw new Error('E57: packet too short for its bytestream length table.');
    }
    let chunkAt = streamsStart;
    for (let f = 0; f < fieldCount; f++) {
      const length = view.getUint16(packetAt + 6 + f * 2, true);
      // Each bytestream must end within the packet payload. Without this a
      // stream length larger than the packet consumed bytes from the NEXT
      // packet/section, decoding into plausible-but-wrong coordinates.
      if (chunkAt + length > packetEnd) {
        throw new Error('E57: a bytestream extends past its packet boundary.');
      }
      chunks[f].push(logical.subarray(chunkAt, chunkAt + length));
      chunkAt += length;
    }
    packetAt += packetLength;
  }

  const columns: DecodedColumns = {};
  prototype.forEach((field, f) => {
    if (keepField && !keepField(field.name)) return; // unconsumed column — skip decode
    columns[field.name] = decodeField(concat(chunks[f]), field, count, stride);
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

/**
 * Decode one field's continuous bytestream.
 *
 * `stride` 1 decodes all `count` values in order. A larger stride splits the
 * records into buckets of `stride` and decodes ONE record per bucket, at a
 * jittered offset drawn from a fixed seed (`strideSample.ts`) — the same
 * stratified sampling the LAS fast-load path uses, so the sample carries no
 * scan-line phase. Restarting the picker from the one seed on every field makes
 * all of a scan's columns land on the same records.
 *
 * The truncation guards below always check the bytes the FULL record count
 * needs, stride or not: a strided read touches records near the end of the
 * stream, so a short stream has to fail whether or not the sample happens to
 * skip the missing tail.
 */
function decodeField(
  buffer: Uint8Array,
  field: E57Field,
  count: number,
  stride = 1,
): Float64Array {
  const step = Math.max(1, Math.floor(stride));
  const outCount = step === 1 ? count : Math.ceil(count / step);
  const out = new Float64Array(outCount);
  const rand = step === 1 ? null : makePrng(STRIDE_SAMPLE_SEED);
  const recordAt = (b: number): number => (rand ? pickInBucket(b, step, count, rand) : b);

  if (field.type === 'float') {
    const bytes = field.floatBytes ?? 8;
    if (buffer.byteLength < count * bytes) {
      throw new Error('E57: truncated float bytestream.');
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    for (let b = 0; b < outCount; b++) {
      const i = recordAt(b);
      out[b] = bytes === 4 ? view.getFloat32(i * 4, true) : view.getFloat64(i * 8, true);
    }
    return out;
  }

  // Integer / scaledInteger — LSB-first bit-packed, offset by the minimum.
  const bitWidth = field.bitWidth ?? 0;
  const minimum = field.minimum ?? 0;
  const scale = field.scale ?? 1;
  const offset = field.offset ?? 0;
  // Truncation guard — symmetric with the float branch above. Without
  // this, missing bytes used to read as 0 bits and silently produce
  // `count` values clamped to `minimum`. For coordinates that is a
  // dataset-corrupting class of bug — every truncated point would
  // collapse to the same corner of the bounding box; for classification
  // codes every truncated point would read as the minimum class. Fail
  // loud so the caller can surface a real error instead of bad data.
  const requiredBits = count * bitWidth;
  if (requiredBits > buffer.length * 8) {
    throw new Error(
      `E57: truncated ${field.type} bytestream — ` +
        `need ${requiredBits} bits for ${count} values at ${bitWidth} bpp, ` +
        `have ${buffer.length * 8}.`,
    );
  }
  // The bit cursor is seeked per record rather than run continuously, because a
  // strided read jumps between buckets. It is also tracked as a byte index plus
  // a bit-in-byte instead of one bit offset: `count * bitWidth` passes 2^31 on a
  // large scan with a wide field, where `>> 3` would wrap to a negative index.
  for (let b = 0; b < outCount; b++) {
    const bitPos = recordAt(b) * bitWidth;
    let byteIndex = Math.floor(bitPos / 8);
    let bitInByte = bitPos - byteIndex * 8;
    let packed = 0;
    for (let k = 0; k < bitWidth; k++) {
      packed += ((buffer[byteIndex] >> bitInByte) & 1) * 2 ** k;
      bitInByte++;
      if (bitInByte === 8) {
        bitInByte = 0;
        byteIndex++;
      }
    }
    const value = packed + minimum;
    out[b] = field.type === 'scaledInteger' ? value * scale + offset : value;
  }
  return out;
}

/**
 * Test-only re-export of the private `decodeField`. The truncation
 * contract is the most consequential branch in the E57 decoder —
 * silently filling missing bits with 0 used to mint phantom
 * minimum-value coordinates — so we expose the function directly
 * to the unit suite without changing the public API.
 */
export const _testOnly_decodeField = decodeField;
