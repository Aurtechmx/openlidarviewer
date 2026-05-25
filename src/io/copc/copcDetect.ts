/**
 * copcDetect.ts
 *
 * Cheap, pure COPC detection from a file's head slice. A COPC file is a LAZ
 * 1.4 file with a COPC `info` VLR as its first VLR at offset 375; a LAZ file
 * without that VLR is plain LAZ and must stay on the static loader path.
 *
 * Detection is deliberately a separate check from `sniffFormat` so that no
 * COPC concept enters the static loader registry. The preflight calls this
 * first; a positive result routes to the streaming pipeline.
 *
 * Pure — no DOM, no three.js, no I/O.
 */

/** The result of a COPC detection probe. */
export interface CopcDetection {
  isCopc: boolean;
  /** When not COPC, a short human-readable reason — for diagnostics. */
  reason?: string;
}

/** The minimum head-slice length needed to decide: 375 + 54 + 160. */
export const COPC_DETECT_MIN_BYTES = 589;

/**
 * Decide whether `headSlice` (at least {@link COPC_DETECT_MIN_BYTES} bytes from
 * the start of a file) is a COPC file. Applies the COPC 1.0 reader checks: the
 * `LASF` signature, a `copc` user id at offset 377, and record id 1 at offset
 * 393. Never throws.
 */
export function detectCopc(headSlice: ArrayBuffer): CopcDetection {
  if (headSlice.byteLength < COPC_DETECT_MIN_BYTES) {
    return { isCopc: false, reason: 'file is too short to carry a COPC header' };
  }
  const u8 = new Uint8Array(headSlice);

  // "LASF" — every LAS/LAZ/COPC file begins with this.
  if (u8[0] !== 0x4c || u8[1] !== 0x41 || u8[2] !== 0x53 || u8[3] !== 0x46) {
    return { isCopc: false, reason: 'not a LAS file (no LASF signature)' };
  }

  // The first VLR's user id (16 bytes at offset 377) must begin with "copc".
  if (
    u8[377] !== 0x63 || // c
    u8[378] !== 0x6f || // o
    u8[379] !== 0x70 || // p
    u8[380] !== 0x63 //   c
  ) {
    return { isCopc: false, reason: 'no COPC info VLR at offset 375 — plain LAZ' };
  }

  // That VLR's record id (u16 at offset 393) must be 1 (the COPC info VLR).
  const recordId = new DataView(headSlice).getUint16(393, true);
  if (recordId !== 1) {
    return { isCopc: false, reason: `COPC VLR record id is ${recordId}, expected 1` };
  }

  return { isCopc: true };
}
