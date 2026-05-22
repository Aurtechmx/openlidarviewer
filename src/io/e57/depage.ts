/**
 * depage.ts
 *
 * An E57 file stores everything in fixed-size pages; the last 4 bytes of each
 * page are a checksum. "De-paging" strips those checksum bytes into one
 * contiguous logical buffer, so the XML and binary sections can then be read
 * with plain logical offsets. Pure and DOM-free.
 */

/** The result of de-paging an E57 file. */
export interface Depaged {
  /** The checksum-stripped logical bytes. */
  logical: Uint8Array;
  /** Logical bytes carried by each page (`pageSize - 4`). */
  pagePayload: number;
}

/** Strip every page's 4-byte checksum into one contiguous logical buffer. */
export function depage(buffer: ArrayBuffer, pageSize: number): Depaged {
  const payload = pageSize - 4;
  const src = new Uint8Array(buffer);
  const pageCount = Math.ceil(src.length / pageSize);
  const logical = new Uint8Array(pageCount * payload);
  for (let p = 0; p < pageCount; p++) {
    const start = p * pageSize;
    const end = Math.min(start + payload, src.length);
    logical.set(src.subarray(start, end), p * payload);
  }
  return { logical, pagePayload: payload };
}

/**
 * Convert a physical file offset to the equivalent offset into the de-paged
 * logical buffer (each page contributes `pageSize - 4` logical bytes).
 */
export function physicalToLogical(physical: number, pageSize: number): number {
  const payload = pageSize - 4;
  return Math.floor(physical / pageSize) * payload + (physical % pageSize);
}
