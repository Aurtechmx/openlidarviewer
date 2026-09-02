/**
 * dtmProductDigest.ts
 *
 * A SHA-256 over the actual DTM SURFACE the viewer produced — the product, not
 * the method. It answers a question `dtmMethodDigest` cannot: did two runs emit
 * the SAME grid of heights? The method digest (`liveDtmDescriptor.ts`) proves
 * only that the same algorithm was configured; two runs of one algorithm over
 * different points, or over the same points after a numerical change upstream,
 * share a method digest yet deliver different surfaces. This digest moves the
 * moment any delivered cell, any coverage state, the grid geometry, the CRS
 * codes, or the recorded method digest changes.
 *
 * WHAT IS HASHED, and why exactly this. The digest is taken over one framed
 * byte stream:
 *
 *   [4-byte LE uint32: header byte length] [header UTF-8] [Z bytes] [coverage bytes]
 *
 *   header  — a canonical, key-sorted, explicitly-typed JSON object carrying
 *             schemaVersion, cols, rows, cellSizeM, originH1, originH2,
 *             horizontalEpsg, verticalEpsg, dtype ('Float64' | 'Float32'),
 *             endianness ('LE'), the two payload byte lengths, and the optional
 *             methodDigest. The header's own length prefix and its recorded
 *             payload lengths frame every section, so no two distinct inputs
 *             concatenate to the same stream.
 *   Z bytes — the elevation array written element-by-element as EXPLICIT
 *             little-endian floats through a DataView (`setFloat64` /
 *             `setFloat32` with littleEndian = true), NOT the typed array's
 *             own `.buffer`. A raw buffer view is host-endian, so the same
 *             surface would digest differently on a big-endian machine; writing
 *             LE explicitly makes the digest platform-independent. `dtype`
 *             records the element width so a Float32 surface and a Float64
 *             surface of equal values never collide, and the endianness field
 *             records the convention the bytes were written in.
 *   coverage — the per-cell provenance array (Uint8, one byte per cell); byte
 *             order is not a concern for a single-byte element.
 *
 * The digest is deliberately blind to per-run confidence, counts, warnings and
 * prose: two runs that agree on geometry, heights, coverage, CRS and method
 * ARE the same product regardless of those. CRS codes are IN because a grid of
 * identical numbers under a different horizontal/vertical EPSG is a different
 * surface on the ground.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic. Reuses the repo's
 * synchronous byte-wise `sha256Hex` (no new crypto). Consumed by validation and
 * (later) export-provenance paths only; never imported from an eager module, so
 * it stays out of the index chunk.
 */

import { canonicalize } from '../render/measure/auditLog';
import { sha256Hex } from '../terrain/export/sha256';

/** Schema of the digested header. Bump only on a breaking layout change. */
export const DTM_PRODUCT_DIGEST_SCHEMA = 1 as const;

/**
 * The minimal projection of a DTM surface the digest reads. `DtmGrid`
 * (`terrain/ground/cellConfidence.ts`) — the shipped product — is structurally
 * assignable to this, as is the validation surface from `dtmSurfaceModel.ts`.
 * `z` accepts either float width so the digest survives the Float32 → Float64
 * flip; the element type is recorded in the digest either way.
 */
export interface DtmProductInput {
  /** Elevation per cell, row-major. */
  readonly z: Float32Array | Float64Array;
  /** Per-cell provenance/coverage state, one byte per cell, row-major. */
  readonly coverage: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
  readonly originH1: number;
  readonly originH2: number;
  /** Numeric horizontal EPSG, or null/undefined when the resolver had none. */
  readonly horizontalEpsg?: number | null;
  /** Numeric vertical EPSG, or null/undefined when none was declared. */
  readonly verticalEpsg?: number | null;
}

/** The float width of the Z array, recorded in the digest header. */
type FloatDtype = 'Float64' | 'Float32';

function floatDtype(z: Float32Array | Float64Array): FloatDtype {
  if (z instanceof Float64Array) return 'Float64';
  if (z instanceof Float32Array) return 'Float32';
  throw new TypeError('dtmProductDigest: z must be a Float32Array or Float64Array');
}

/**
 * Serialize `z` as explicit little-endian float bytes through a DataView, so
 * the byte stream is identical on any host regardless of native endianness.
 */
function zBytesLE(z: Float32Array | Float64Array, dtype: FloatDtype): Uint8Array {
  const bytesPerElem = dtype === 'Float64' ? 8 : 4;
  const out = new Uint8Array(z.length * bytesPerElem);
  const dv = new DataView(out.buffer);
  if (dtype === 'Float64') {
    for (let i = 0; i < z.length; i++) dv.setFloat64(i * 8, z[i], true);
  } else {
    for (let i = 0; i < z.length; i++) dv.setFloat32(i * 4, z[i], true);
  }
  return out;
}

/**
 * SHA-256 (lowercase hex) over a DTM surface's geometry, CRS, delivered heights
 * and coverage, plus an optional method digest. Identical surfaces yield an
 * identical digest; any change to a Z cell, a coverage state, the grid
 * geometry, the CRS codes, the float width, or `methodDigest` moves it.
 *
 * `methodDigest`, when supplied, binds a surface to the method that made it:
 * two surfaces equal in every cell but produced under different method digests
 * digest differently, so the pair (surface, method) is what is proven equal.
 */
export function dtmProductDigest(dtm: DtmProductInput, methodDigest?: string): string {
  const dtype = floatDtype(dtm.z);
  const cellCount = dtm.cols * dtm.rows;
  if (dtm.z.length !== cellCount) {
    throw new RangeError(
      `dtmProductDigest: z.length ${dtm.z.length} does not match cols*rows ${cellCount}`,
    );
  }
  if (dtm.coverage.length !== cellCount) {
    throw new RangeError(
      `dtmProductDigest: coverage.length ${dtm.coverage.length} does not match cols*rows ${cellCount}`,
    );
  }

  const zBytes = zBytesLE(dtm.z, dtype);
  const coverageBytes = dtm.coverage;

  // Explicitly-typed, key-sorted header. `?? null` normalises absent CRS codes
  // and method digest to a single form so an undefined and an explicit null
  // produce one digest.
  const headerBytes = new TextEncoder().encode(
    canonicalize({
      schemaVersion: DTM_PRODUCT_DIGEST_SCHEMA,
      cols: dtm.cols,
      rows: dtm.rows,
      cellSizeM: dtm.cellSizeM,
      originH1: dtm.originH1,
      originH2: dtm.originH2,
      horizontalEpsg: dtm.horizontalEpsg ?? null,
      verticalEpsg: dtm.verticalEpsg ?? null,
      dtype,
      endianness: 'LE',
      zByteLength: zBytes.length,
      coverageByteLength: coverageBytes.length,
      methodDigest: methodDigest ?? null,
    }),
  );

  // Frame: [header length as 4-byte LE uint32][header][Z bytes][coverage bytes].
  // The length prefix plus the two byte lengths recorded inside the header make
  // every section boundary explicit, so distinct inputs cannot alias.
  const stream = new Uint8Array(4 + headerBytes.length + zBytes.length + coverageBytes.length);
  new DataView(stream.buffer).setUint32(0, headerBytes.length, true);
  let at = 4;
  stream.set(headerBytes, at);
  at += headerBytes.length;
  stream.set(zBytes, at);
  at += zBytes.length;
  stream.set(coverageBytes, at);

  return sha256Hex(stream);
}
