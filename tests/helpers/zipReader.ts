/**
 * zipReader.ts: read one stored (uncompressed) entry back out of a
 * store-only ZIP built by `buildZip`/`zipStore`, without depending on a real
 * unzip library. Shared by every spec that asserts on an export package's
 * contents (Flow Pulse, DEM), which used to carry byte-identical copies of
 * this walk.
 */

/** Extract a stored (uncompressed) entry's bytes from a store-only ZIP, or null. */
export function extractEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const wantName = new TextEncoder().encode(name);
  let p = 0;
  while (p + 30 <= zip.length && dv.getUint32(p, true) === 0x04034b50) {
    const compSize = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const nameBytes = zip.subarray(p + 30, p + 30 + nameLen);
    const dataStart = p + 30 + nameLen + extraLen;
    let match = nameBytes.length === wantName.length;
    for (let j = 0; match && j < wantName.length; j++) {
      if (nameBytes[j] !== wantName[j]) match = false;
    }
    if (match) return zip.subarray(dataStart, dataStart + compSize);
    p = dataStart + compSize;
  }
  return null;
}

/** {@link extractEntry}, decoded as UTF-8 text. Throws when the entry is absent. */
export function textOf(zip: Uint8Array, name: string): string {
  const bytes = extractEntry(zip, name);
  if (!bytes) throw new Error(`entry not found: ${name}`);
  return new TextDecoder().decode(bytes);
}

/** {@link textOf}, parsed as JSON. */
export function jsonOf<T>(zip: Uint8Array, name: string): T {
  return JSON.parse(textOf(zip, name)) as T;
}
