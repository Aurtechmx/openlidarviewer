/**
 * preflight.ts
 *
 * What an E57 file declares about itself, read WITHOUT decoding a point.
 *
 * An E57 states its point total in its XML section: every `data3D` scan carries
 * a `recordCount` attribute and a prototype listing the per-point fields. The
 * 48-byte file header gives the XML section's offset and length, so the whole
 * declaration is reachable from two small reads — the head slice and a few KB
 * near the end of the file.
 *
 * That is what makes a budget plan possible for E57 at all. LAS/LAZ get one
 * from `planLoad` because their public header sits in the head slice; E57's
 * equivalent facts are simply somewhere else in the file, not absent. Reading
 * them here lets the loader decide between a full decode, a strided decode and
 * a refusal BEFORE the decode allocates anything, which is the same decision
 * LAS already makes.
 *
 * Pure and DOM-free, like the rest of `io/e57`.
 */

import { parseE57Header } from './header';
import type { E57Header } from './header';
import { depagePages } from './depage';
import { parseXml } from './xml';
import { readE57Document } from './schema';
import type { E57Field, E57Scan } from './schema';
import type { PointAttributes } from '../loadPlan';

/**
 * The prototype fields `loadE57` actually reads. Every other declared field —
 * a structured scan's row/column index, spherical coordinates this loader does
 * not project — is skipped at decode, so it costs no Float64 column and must
 * not be counted in the memory estimate either. Shared with `loadE57` so the
 * estimate and the decode can never disagree about what gets materialised.
 */
export const E57_CONSUMED_FIELDS: ReadonlySet<string> = new Set([
  'cartesianX',
  'cartesianY',
  'cartesianZ',
  'cartesianInvalidState',
  'colorRed',
  'colorGreen',
  'colorBlue',
  'intensity',
  'classification',
  'normalX',
  'normalY',
  'normalZ',
]);

/**
 * A field's LOCAL name, after any extension `prefix:` — so `nor:normalX`
 * resolves to `normalX`.
 */
export function e57LocalFieldName(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

/** True when `loadE57` decodes a prototype field of this name, in any scan. */
export function e57FieldIsConsumed(name: string): boolean {
  return E57_CONSUMED_FIELDS.has(e57LocalFieldName(name));
}

/**
 * The fields `loadE57` decodes FOR ONE SCAN, by local name.
 *
 * Every scan currently yields {@link E57_CONSUMED_FIELDS} unchanged. The set is
 * resolved per scan so that a scan whose declarations earn it extra columns can
 * be given them WITHOUT every ordinary E57 paying for columns it never reads —
 * the cost that keeps `rowIndex`, `columnIndex` and `sphericalRange` out of the
 * global set in the first place. Widening the global set instead would expand a
 * full Float64 column per unread field on every file.
 *
 * Both the byte estimate below and the decode resolve their answer through this
 * one function, so a future scan-dependent set cannot make them disagree; the
 * estimate is what the fail-closed memory ceiling rests on.
 */
export function e57ConsumedFieldsForScan(_scan: E57Scan): ReadonlySet<string> {
  return E57_CONSUMED_FIELDS;
}

/** {@link e57ConsumedFieldsForScan} as the predicate shape `parseE57` takes. */
export function e57FieldIsConsumedForScan(name: string, scan: E57Scan): boolean {
  return e57ConsumedFieldsForScan(scan).has(e57LocalFieldName(name));
}

/** What an E57 declares, before any point is decoded. */
export interface E57Preflight {
  /** Scans declared in the file. */
  scanCount: number;
  /** Scans carrying Cartesian X/Y/Z, which are the ones that merge into points. */
  mergeableScanCount: number;
  /** Declared record total across the scans that merge. */
  recordCount: number;
  /** Declared record total across scans with no Cartesian X/Y/Z, which are skipped. */
  skippedRecordCount: number;
  /** Attributes the merged cloud will carry, decided exactly as `loadE57` decides them. */
  attributes: PointAttributes;
  /**
   * Float64 decode columns the parse materialises per merged record. The parse
   * expands one `Float64Array` per CONSUMED prototype field per scan and holds
   * every scan's columns at once, so this is the multiplier on the largest term
   * in the E57 memory estimate. Fractional when scans declare different
   * prototypes; counted over all scans (a skipped scan's columns are still
   * decoded) and divided by the records that become points, so the estimate
   * carries the skipped scan's cost rather than losing it.
   */
  columnsPerRecord: number;
}

/** Which prototype fields a scan declares, by both bare and local name. */
function fieldNames(prototype: readonly E57Field[]): { bare: Set<string>; local: Set<string> } {
  const bare = new Set<string>();
  const local = new Set<string>();
  for (const f of prototype) {
    bare.add(f.name);
    local.add(e57LocalFieldName(f.name));
  }
  return { bare, local };
}

/**
 * Summarise the declared scans into the facts a load plan needs.
 *
 * The attribute decisions mirror `loadE57` field for field: colour, intensity
 * and classification resolve by BARE prototype name, normals by LOCAL name
 * (they ride the `nor:` surface-normals extension), and an attribute counts
 * only when EVERY mergeable scan provides it. A divergence here would size the
 * estimate for arrays the merge never allocates, or miss ones it does.
 */
export function summariseE57Scans(scans: readonly E57Scan[]): E57Preflight {
  const mergeable: { bare: Set<string>; local: Set<string> }[] = [];
  let recordCount = 0;
  let skippedRecordCount = 0;
  let columnValues = 0;
  for (const scan of scans) {
    const names = fieldNames(scan.prototype);
    const consumedHere = e57ConsumedFieldsForScan(scan);
    let consumed = 0;
    for (const field of scan.prototype) {
      if (consumedHere.has(e57LocalFieldName(field.name))) consumed++;
    }
    columnValues += scan.recordCount * consumed;
    if (names.bare.has('cartesianX') && names.bare.has('cartesianY') && names.bare.has('cartesianZ')) {
      mergeable.push(names);
      recordCount += scan.recordCount;
    } else {
      skippedRecordCount += scan.recordCount;
    }
  }

  const everyBare = (field: string): boolean =>
    mergeable.length > 0 && mergeable.every((n) => n.bare.has(field));
  const everyLocal = (field: string): boolean =>
    mergeable.length > 0 && mergeable.every((n) => n.local.has(field));

  const attributes: PointAttributes = {
    hasColor: everyBare('colorRed') && everyBare('colorGreen') && everyBare('colorBlue'),
    hasIntensity: everyBare('intensity'),
    hasClassification: everyBare('classification'),
    hasNormals: everyLocal('normalX') && everyLocal('normalY') && everyLocal('normalZ'),
  };

  return {
    scanCount: scans.length,
    mergeableScanCount: mergeable.length,
    recordCount,
    skippedRecordCount,
    attributes,
    columnsPerRecord: recordCount > 0 ? columnValues / recordCount : 0,
  };
}

/** The page-aligned physical byte range that carries a file's XML section. */
export interface E57XmlPageRun {
  pageSize: number;
  /** First byte of the first page carrying XML. */
  physicalStart: number;
  /** One past the last byte of the last page carrying XML. */
  physicalEnd: number;
  /** File page index `physicalStart` sits on, for checksum error reporting. */
  firstPageIndex: number;
  /** Pages in the whole file, for checksum error reporting. */
  totalPageCount: number;
  /** Where the XML's first byte lands once the run is de-paged. */
  logicalOffset: number;
  /** Logical (checksum-excluded) XML length, from the header. */
  xmlLogicalLength: number;
}

/**
 * The page-aligned physical range a reader must fetch to recover the XML
 * section. E57 pages carry `pageSize - 4` logical bytes each, so the XML's
 * declared logical length spans `ceil((withinPage + length) / payload)` pages
 * from the page its offset lands on.
 */
export function e57XmlPageRun(header: E57Header): E57XmlPageRun {
  const { pageSize, xmlPhysicalOffset, xmlLogicalLength, filePhysicalLength } = header;
  const payload = pageSize - 4;
  const withinPage = xmlPhysicalOffset % pageSize;
  // Same ambiguity `physicalToLogical` refuses: an offset inside a page's CRC
  // trailer is not payload, and resolving it silently would read the next
  // page's first byte as though it were this one's last.
  if (withinPage >= payload) {
    throw new Error(
      `E57: physical offset ${xmlPhysicalOffset} points into a page checksum, not payload.`,
    );
  }
  const firstPageIndex = Math.floor(xmlPhysicalOffset / pageSize);
  const pagesNeeded = Math.ceil((withinPage + xmlLogicalLength) / payload);
  const physicalStart = firstPageIndex * pageSize;
  const physicalEnd = physicalStart + pagesNeeded * pageSize;
  if (!Number.isSafeInteger(physicalEnd) || physicalEnd > filePhysicalLength) {
    throw new Error('E57: the declared XML section extends past the file.');
  }
  return {
    pageSize,
    physicalStart,
    physicalEnd,
    firstPageIndex,
    totalPageCount: Math.ceil(filePhysicalLength / pageSize),
    logicalOffset: withinPage,
    xmlLogicalLength,
  };
}

/**
 * The XML page run, read from a HEAD SLICE of a file rather than the whole
 * file. `fileBytes` is the real file length, which the header's truncation
 * check needs and the slice cannot supply. For a caller holding a `File`: read
 * the head slice, call this, then fetch exactly `physicalStart`–`physicalEnd`
 * and hand those bytes to {@link preflightE57FromXmlPages}.
 */
export function e57XmlPageRunFromHead(head: ArrayBuffer, fileBytes: number): E57XmlPageRun {
  return e57XmlPageRun(parseE57Header(head, fileBytes));
}

/**
 * Read the declared facts from an already-fetched XML page run. `pages` must be
 * exactly the bytes `run.physicalStart`–`run.physicalEnd` names. Every page in
 * the run has its CRC-32C verified before its bytes are read, so a corrupt XML
 * region is refused here rather than parsed into a plausible-looking plan.
 */
export function preflightE57FromXmlPages(pages: Uint8Array, run: E57XmlPageRun): E57Preflight {
  const logical = depagePages(pages, run.pageSize, run.firstPageIndex, run.totalPageCount);
  const end = run.logicalOffset + run.xmlLogicalLength;
  if (end > logical.length) {
    throw new Error('E57: the declared XML section extends past the file.');
  }
  const xml = new TextDecoder().decode(logical.subarray(run.logicalOffset, end));
  return summariseE57Scans(readE57Document(parseXml(xml)).scans);
}

/**
 * Read the declared facts from a whole-file buffer. Reads the header and the
 * XML pages only — the point sections are never touched, so the cost is the few
 * KB of XML rather than the file.
 */
export function preflightE57(buffer: ArrayBuffer): E57Preflight {
  const header = parseE57Header(buffer);
  const run = e57XmlPageRun(header);
  const pages = new Uint8Array(buffer, run.physicalStart, run.physicalEnd - run.physicalStart);
  return preflightE57FromXmlPages(pages, run);
}
