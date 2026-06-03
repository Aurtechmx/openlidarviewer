/**
 * parseE57.ts
 *
 * Orchestrates the from-scratch E57 reader: header → de-page → XML → schema →
 * CompressedVector decode. Pure and DOM-free — `parseE57` takes an
 * `ArrayBuffer` and returns plain decoded data, so the whole pipeline is
 * unit-tested in Node against a real `.e57` fixture.
 *
 * Scope: the common real-world E57 files produced by mainstream scanners —
 * Cartesian XYZ as Float, colour / intensity / classification / normals as
 * Integer or ScaledInteger, single- and multi-scan. Exotic encodings throw a
 * clear error rather than mis-decoding.
 */

import { parseE57Header } from './header';
import { depage, physicalToLogical } from './depage';
import { parseXml } from './xml';
import { readE57Document } from './schema';
import type { E57Field, E57Metadata, E57Pose } from './schema';
import { decodeCompressedVector } from './compressedVector';
import type { DecodedColumns } from './compressedVector';

/** One decoded scan. */
export interface E57ScanData {
  name: string;
  guid: string;
  recordCount: number;
  /** Decoded point columns, keyed by prototype field name. */
  columns: DecodedColumns;
  /** The prototype fields, so callers know which columns exist and their kind. */
  fields: E57Field[];
  /** Rigid-body placement in the file's global frame, or null for identity. */
  pose: E57Pose | null;
  /** Declared colour maximum for 0–255 normalisation, or null. */
  colorMax: number | null;
  /** Declared intensity maximum, or null. */
  intensityMax: number | null;
}

/** The full result of parsing an E57 file. */
export interface E57ParseResult {
  scans: E57ScanData[];
  metadata: E57Metadata;
}

/** Parse an E57 file into decoded scans and file metadata. */
export function parseE57(buffer: ArrayBuffer): E57ParseResult {
  const header = parseE57Header(buffer);
  const { logical } = depage(buffer, header.pageSize);

  const xmlStart = physicalToLogical(header.xmlPhysicalOffset, header.pageSize);
  const xmlBytes = logical.subarray(xmlStart, xmlStart + header.xmlLogicalLength);
  const document = readE57Document(parseXml(new TextDecoder().decode(xmlBytes)));

  if (document.scans.length === 0) {
    throw new Error('E57: the file contains no 3D scans.');
  }

  const scans: E57ScanData[] = document.scans.map((scan) => ({
    name: scan.name,
    guid: scan.guid,
    recordCount: scan.recordCount,
    fields: scan.prototype,
    pose: scan.pose,
    colorMax: scan.colorMax,
    intensityMax: scan.intensityMax,
    columns: decodeCompressedVector(
      logical,
      scan.fileOffset,
      scan.recordCount,
      scan.prototype,
      header.pageSize,
    ),
  }));

  return { scans, metadata: document.metadata };
}
