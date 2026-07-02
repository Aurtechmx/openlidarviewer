/**
 * eptBinaryDecode.ts
 *
 * Decode an EPT `dataType: binary` tile into the `DecodedChunk` shape the
 * StreamingRenderer + scheduler already consume for COPC nodes.
 *
 * EPT binary tiles are tightly packed: one point per stride, with each
 * attribute laid out in the order declared by `ept.json`'s `schema` array.
 * The schema tells us the byte size + signed/unsigned/float interpretation
 * + optional scale + offset of each attribute. We materialise:
 *   • positions    — Float32Array (recentred against the render origin)
 *   • intensity    — Uint16Array
 *   • classification — Uint8Array
 *   • returnNumber, returnCount, gpsTime, rgb — filled with safe defaults
 *     when the schema doesn't carry them (EPT writers are permitted to
 *     omit attributes the source format lacked)
 *
 * For real-world EPT datasets the dominant `dataType` is `laszip`, not
 * binary; that path goes through the existing copcChunkDecode worker.
 * This module covers the binary path used by:
 *   1. the synthetic test fixture (no LAZ dependency in tests)
 *   2. any production EPT writer that selected binary for compatibility
 *
 * Pure parser — no DOM, no three.js, no I/O. Operates on an ArrayBuffer
 * the streaming source has already fetched.
 */

import type { EptSchemaField } from './eptTypes';
import type { DecodedChunk } from '../copc/copcChunkDecode';
import { LoadError } from '../loadErrors';

/**
 * Thrown when an EPT binary tile arrives shorter than the schema
 * requires. The scheduler matches on this class to decide a node is
 * eligible for re-fetch — a truncation is almost always a transport
 * problem (partial body from the CDN, network cut mid-flight), not a
 * permanent parse failure.
 */
export class EptTruncatedTileError extends Error {
  readonly expectedBytes: number;
  readonly actualBytes: number;
  constructor(message: string, expectedBytes: number, actualBytes: number) {
    super(message);
    this.name = 'EptTruncatedTileError';
    this.expectedBytes = expectedBytes;
    this.actualBytes = actualBytes;
  }
}

/**
 * Pre-computed per-attribute layout: byte offset within a point record,
 * the size, the signedness, and the scale/offset for coordinate reconstr.
 */
interface AttrLayout {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly type: EptSchemaField['type'];
  readonly scale: number;
  readonly offsetVal: number;
}

/** Walk the schema once to produce per-attribute byte offsets + total stride. */
export function computeSchemaLayout(schema: readonly EptSchemaField[]): {
  readonly attrs: readonly AttrLayout[];
  readonly stride: number;
} {
  const attrs: AttrLayout[] = [];
  let offset = 0;
  for (const f of schema) {
    attrs.push({
      name: f.name,
      offset,
      size: f.size,
      type: f.type,
      scale: f.scale ?? 1,
      offsetVal: f.offset ?? 0,
    });
    offset += f.size;
  }
  return { attrs, stride: offset };
}

/**
 * Read one signed/unsigned/float attribute value at the given byte offset.
 * Inlined into the decode loop for performance — kept as a small helper
 * for the test-only case where a single attribute is read.
 */
function readAttr(view: DataView, off: number, attr: AttrLayout): number {
  switch (attr.size) {
    case 1: return attr.type === 'signed'   ? view.getInt8(off)              : view.getUint8(off);
    case 2: return attr.type === 'signed'   ? view.getInt16(off,  true)      : view.getUint16(off,  true);
    case 4: return attr.type === 'float'    ? view.getFloat32(off, true)
          : attr.type === 'signed'         ? view.getInt32(off,   true)
                                            : view.getUint32(off,  true);
    case 8: {
      // Size 8 must branch on the declared type. The earlier code read every
      // 8-byte attribute as Float64, which reinterprets an int64/uint64's
      // two's-complement bits as IEEE-754 — an X/Y/Z stored as int64 (a
      // layout Entwine permits) decoded to garbage positions. Integers are
      // read as BigInt and converted to Number ONLY when the value is
      // exactly representable; beyond ±(2^53 − 1) the conversion would
      // silently round, so we throw the same typed malformed-file error the
      // count validator uses ("malformed" keyword included on purpose —
      // classifyLoadError recovers the category from worker-crossed
      // messages by that word).
      if (attr.type === 'float') return view.getFloat64(off, true);
      const big = attr.type === 'signed'
        ? view.getBigInt64(off, true)
        : view.getBigUint64(off, true);
      const num = Number(big);
      if (!Number.isSafeInteger(num)) {
        throw new LoadError(
          'malformed-file',
          `malformed EPT binary tile: 64-bit ${attr.type} attribute "${attr.name}" ` +
            `holds ${big}, outside the exactly-representable Number range ` +
            `(|value| must be ≤ 2^53 − 1).`,
        );
      }
      return num;
    }
    default: throw new Error(`EPT binary decode: unsupported attribute size ${attr.size}`);
  }
}

/** Find an attribute by name in the layout, or undefined. */
function findAttr(attrs: readonly AttrLayout[], name: string): AttrLayout | undefined {
  return attrs.find((a) => a.name === name);
}

/**
 * Decode one EPT binary tile into a {@link DecodedChunk}.
 *
 * @param buffer        The raw tile bytes as fetched from the EPT data URL.
 * @param pointCount    Expected point count from the hierarchy entry.
 * @param schema        The schema from `ept.json`.
 * @param renderOrigin  The cloud's render origin — subtracted from positions
 *                      in Float64 BEFORE narrowing to Float32 (the same
 *                      precision contract the COPC decoder follows).
 */
export function decodeEptBinaryTile(
  buffer: ArrayBuffer,
  pointCount: number,
  schema: readonly EptSchemaField[],
  renderOrigin: readonly [number, number, number],
): DecodedChunk {
  const { attrs, stride } = computeSchemaLayout(schema);
  const expectedBytes = pointCount * stride;
  if (buffer.byteLength < expectedBytes) {
    // A short tile is almost always a transport problem — partial body
    // returned by the CDN, mid-flight network cut, etc. Throw a tagged
    // error so the scheduler can distinguish "retry me" from a
    // permanent schema/parse failure and re-queue the node.
    throw new EptTruncatedTileError(
      `EPT binary tile is short: expected ${expectedBytes} bytes for ${pointCount} ` +
        `points × ${stride} stride, got ${buffer.byteLength}.`,
      expectedBytes,
      buffer.byteLength,
    );
  }

  const view = new DataView(buffer);
  const positions = new Float32Array(pointCount * 3);
  const intensity = new Uint16Array(pointCount);
  const classification = new Uint8Array(pointCount);
  // EPT writers can omit return / GPS — the COPC decoder fills zero-sized
  // arrays in the same case and the renderer treats absence gracefully.
  const returnNumber = new Uint8Array(pointCount);
  const returnCount = new Uint8Array(pointCount);
  const gpsTime = new Float64Array(pointCount);
  let rgb: Uint8Array | undefined;

  const xAttr = findAttr(attrs, 'X');
  const yAttr = findAttr(attrs, 'Y');
  const zAttr = findAttr(attrs, 'Z');
  if (!xAttr || !yAttr || !zAttr) {
    throw new Error('EPT binary decode: schema is missing X/Y/Z.');
  }
  const intensityAttr = findAttr(attrs, 'Intensity');
  const classAttr = findAttr(attrs, 'Classification');
  const rAttr = findAttr(attrs, 'Red');
  const gAttr = findAttr(attrs, 'Green');
  const bAttr = findAttr(attrs, 'Blue');
  if (rAttr && gAttr && bAttr) rgb = new Uint8Array(pointCount * 3);
  const retNumAttr = findAttr(attrs, 'ReturnNumber');
  const retCntAttr = findAttr(attrs, 'NumberOfReturns');
  const gpsAttr = findAttr(attrs, 'GpsTime');

  const [rx, ry, rz] = renderOrigin;

  // The decode loop. Position math follows the same Float64-subtract +
  // Float32-narrow contract documented in docs/coordinate-precision.md.
  for (let i = 0; i < pointCount; i++) {
    const base = i * stride;

    // X / Y / Z — read raw, apply scale + offset in Float64, subtract the
    // render origin in Float64, narrow to Float32 on assignment.
    const xRaw = readAttr(view, base + xAttr.offset, xAttr);
    const yRaw = readAttr(view, base + yAttr.offset, yAttr);
    const zRaw = readAttr(view, base + zAttr.offset, zAttr);
    positions[i * 3]     = xRaw * xAttr.scale + xAttr.offsetVal - rx;
    positions[i * 3 + 1] = yRaw * yAttr.scale + yAttr.offsetVal - ry;
    positions[i * 3 + 2] = zRaw * zAttr.scale + zAttr.offsetVal - rz;

    if (intensityAttr) {
      intensity[i] = readAttr(view, base + intensityAttr.offset, intensityAttr);
    }
    if (classAttr) {
      classification[i] = readAttr(view, base + classAttr.offset, classAttr);
    }
    if (retNumAttr) {
      returnNumber[i] = readAttr(view, base + retNumAttr.offset, retNumAttr);
    }
    if (retCntAttr) {
      returnCount[i] = readAttr(view, base + retCntAttr.offset, retCntAttr);
    }
    if (gpsAttr) {
      gpsTime[i] = readAttr(view, base + gpsAttr.offset, gpsAttr);
    }
    if (rgb && rAttr && gAttr && bAttr) {
      // EPT RGB attributes are typically uint16 0-65535 (LAS heritage);
      // narrow to uint8 0-255 with a >>8 shift.
      const r = readAttr(view, base + rAttr.offset, rAttr);
      const g = readAttr(view, base + gAttr.offset, gAttr);
      const b = readAttr(view, base + bAttr.offset, bAttr);
      rgb[i * 3]     = rAttr.size === 2 ? r >> 8 : r & 0xff;
      rgb[i * 3 + 1] = gAttr.size === 2 ? g >> 8 : g & 0xff;
      rgb[i * 3 + 2] = bAttr.size === 2 ? b >> 8 : b & 0xff;
    }
  }

  return {
    pointCount,
    positions,
    intensity,
    classification,
    returnNumber,
    returnCount,
    gpsTime,
    rgb,
  };
}
