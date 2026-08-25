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
import type { E57Field, E57Metadata, E57Pose, E57Scan, E57SourceMetadata } from './schema';
import { decodeCompressedVector } from './compressedVector';
import type { DecodedColumns } from './compressedVector';

/** One decoded scan. */
export interface E57ScanData {
  name: string;
  guid: string;
  /**
   * Records the decoded columns actually hold. Equal to `declaredRecordCount`
   * for an unstrided parse; `ceil(declaredRecordCount / stride)` for a strided
   * one. Every consumer that walks the columns indexes against THIS.
   */
  recordCount: number;
  /**
   * Records the file's XML declares for this scan, whatever the parse read.
   * The source count a strided load has to keep disclosing.
   */
  declaredRecordCount: number;
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
  /**
   * Declared-only source metadata (standard + extension-namespace fields),
   * or null when the file declares nothing beyond geometry.
   */
  sourceMetadata: E57SourceMetadata | null;
  /**
   * Non-fatal anomalies found while interpreting the file (a normalised or
   * degenerate pose quaternion, for example). The loader surfaces these as
   * user-visible load warnings.
   */
  warnings: string[];
}

/** Options for {@link parseE57}. */
export interface ParseE57Options {
  /**
   * Decode only the prototype columns this accepts. Omitted → every column
   * decodes (the default; callers inspecting the full prototype rely on it).
   * The loader passes a predicate to skip columns it never reads.
   *
   * The predicate answers PER SCAN: it receives the scan whose columns are
   * being decided, so a file may decode a column for one scan and skip it for
   * another. `parseE57` binds the scan before the decode rather than handing
   * `decodeCompressedVector` a scan it has no other use for. A one-argument
   * predicate stays valid and simply ignores the scan.
   */
  keepField?: (name: string, scan: E57Scan) => boolean;
  /**
   * Read one record per bucket of `stride` rather than every record. 1 (the
   * default) reads every record. The loader sets this from its decode plan when
   * a full read would not fit in memory; the sampling is stratified and
   * jittered, and every column of every scan lands on the same records.
   */
  stride?: number;
}

/** Parse an E57 file into decoded scans and file metadata. */
export function parseE57(buffer: ArrayBuffer, opts?: ParseE57Options): E57ParseResult {
  const header = parseE57Header(buffer);
  // De-page only the bytes the header declares. `parseE57Header` refuses a
  // buffer SHORTER than the declared length; a longer one carries content past
  // the end of the file its own header describes, and de-paging that content
  // would put it inside the logical buffer every offset below is resolved and
  // bounds-checked against. Bounding here is what keeps the XML range, the
  // section offsets and the packet walk inside the declared file.
  const { logical } = depage(buffer, header.pageSize, header.filePhysicalLength);

  const xmlStart = physicalToLogical(header.xmlPhysicalOffset, header.pageSize);
  // Prove the declared XML range fits the de-paged buffer before slicing it.
  // `subarray` silently clips an out-of-range end, so a corrupt xmlLogicalLength
  // would otherwise hand a truncated (or empty) document to the parser as if it
  // were complete, rather than failing (M7).
  const xmlEnd = xmlStart + header.xmlLogicalLength;
  if (!Number.isSafeInteger(xmlEnd) || xmlEnd > logical.length) {
    throw new Error('E57: the declared XML section extends past the file.');
  }
  const xmlBytes = logical.subarray(xmlStart, xmlEnd);
  const document = readE57Document(parseXml(new TextDecoder().decode(xmlBytes)));

  if (document.scans.length === 0) {
    throw new Error('E57: the file contains no 3D scans.');
  }

  // Each scan's point section must start inside the declared file. Without
  // this the offset lands in whatever the de-paged buffer happens to hold and
  // is reported as a missing section id, which names the wrong fault.
  for (const scan of document.scans) {
    if (physicalToLogical(scan.fileOffset, header.pageSize) >= logical.length) {
      throw new Error(
        `E57: scan "${scan.name}" places its point section at physical offset ` +
          `${scan.fileOffset}, past the ${header.filePhysicalLength}-byte file its ` +
          'header declares.',
      );
    }
  }

  const stride = Math.max(1, Math.floor(opts?.stride ?? 1));
  const keepField = opts?.keepField;
  const scans: E57ScanData[] = document.scans.map((scan) => ({
    name: scan.name,
    guid: scan.guid,
    // What the columns below will hold. `decodeCompressedVector` keeps one
    // record per bucket, so the two counts diverge exactly when a stride is set.
    recordCount: stride === 1 ? scan.recordCount : Math.ceil(scan.recordCount / stride),
    declaredRecordCount: scan.recordCount,
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
      { keepField: keepField && ((name: string) => keepField(name, scan)), stride },
    ),
  }));

  return {
    scans,
    metadata: document.metadata,
    sourceMetadata: document.sourceMetadata,
    warnings: document.warnings,
  };
}
