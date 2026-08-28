/**
 * lasHeaderBytes.ts — minimal valid LAS public-header buffer for tests.
 *
 * `parseLasHeader` reads a fixed set of public-header fields and rejects a
 * buffer that is too short, unsigned, or carries a non-finite scale/offset/
 * bounds. Tests that exercise the EPT pre-decode admission gate need a buffer
 * that parses cleanly and reports a chosen point count, without pulling in a
 * real LAZ fixture. This builds exactly that: a legacy (LAS 1.2) public header
 * with a uint32 point count, positive scale, zero offset/bounds, no VLRs.
 */

/** Build a minimal, valid LAS 1.2 public header reporting `pointCount`. */
export function lasHeaderBuffer(pointCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(227);
  const view = new DataView(buffer);
  // Signature 'LASF'.
  for (let i = 0; i < 4; i++) view.setUint8(i, 'LASF'.charCodeAt(i));
  view.setUint8(25, 2); // version minor 2 → legacy uint32 point count
  view.setUint32(96, 227, true); // offset to point data
  view.setUint8(104, 0); // point data record format 0
  view.setUint16(105, 20, true); // point record length
  view.setUint32(107, pointCount >>> 0, true); // legacy point count
  // Scale X/Y/Z (must be finite and > 0).
  view.setFloat64(131, 0.001, true);
  view.setFloat64(139, 0.001, true);
  view.setFloat64(147, 0.001, true);
  // Offset + bounds default to the zeroed buffer (all finite).
  view.setUint16(94, 227, true); // header size
  view.setUint32(100, 0, true); // number of VLRs → crs parse skipped
  return buffer;
}
