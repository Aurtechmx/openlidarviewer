/**
 * header.ts
 *
 * The fixed 48-byte E57 file header (ASTM E2807). Pure and DOM-free — the
 * whole E57 parser is unit-tested in Node.
 */

/** The fields recovered from an E57 file header. */
export interface E57Header {
  versionMajor: number;
  versionMinor: number;
  /** Total file length in bytes, including page checksums. */
  filePhysicalLength: number;
  /** Physical offset of the XML section. */
  xmlPhysicalOffset: number;
  /** Logical (checksum-excluded) length of the XML section. */
  xmlLogicalLength: number;
  /** Page size in bytes; the last 4 bytes of each page are a checksum. */
  pageSize: number;
}

const SIGNATURE = 'ASTM-E57';

/** Parse and validate the 48-byte E57 header. Throws on a non-E57 file. */
export function parseE57Header(buffer: ArrayBuffer): E57Header {
  if (buffer.byteLength < 48) {
    throw new Error('Not an E57 file: shorter than the 48-byte header.');
  }
  const view = new DataView(buffer);
  let signature = '';
  for (let i = 0; i < 8; i++) signature += String.fromCharCode(view.getUint8(i));
  if (signature !== SIGNATURE) {
    throw new Error('Not an E57 file: the "ASTM-E57" signature is missing.');
  }
  const pageSize = Number(view.getBigUint64(40, true));
  if (pageSize < 64) {
    throw new Error('E57 file is malformed: invalid page size.');
  }
  return {
    versionMajor: view.getUint32(8, true),
    versionMinor: view.getUint32(12, true),
    filePhysicalLength: Number(view.getBigUint64(16, true)),
    xmlPhysicalOffset: Number(view.getBigUint64(24, true)),
    xmlLogicalLength: Number(view.getBigUint64(32, true)),
    pageSize,
  };
}
