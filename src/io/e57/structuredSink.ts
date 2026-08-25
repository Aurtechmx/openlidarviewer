/**
 * structuredSink.ts — the structured columns of an E57 scan, decoded beside the
 * point columns rather than through them.
 *
 * `DecodedColumns` is the E57-INGEST path: nine dimensions that agree with PDAL
 * value for value, every one of them a `Float64Array`. The acquisition grid
 * needs different columns (`rowIndex`, `columnIndex`, `returnIndex`,
 * `returnCount`, `sphericalRange`) with different requirements — integer width
 * chosen from what the file declared, and a decoded value outside those bounds
 * treated as a contradiction rather than a number to clamp. Expressing that
 * through the same map would mean widening its type, so it is expressed HERE,
 * in a sink the point decode neither reads nor writes.
 *
 * Two facts about this module are load-bearing:
 *
 *   ELIGIBILITY IS THE SCHEMA'S, NOT A SECOND OPINION. Whether a scan can carry
 *   a grid is `e57ScanSupportsStructuredRange`, and nothing here re-decides it.
 *
 *   COST IS DECLARED HERE TOO. The per-record bytes and the per-cell grid bytes
 *   the decode will allocate are computed from the same declarations that
 *   choose the columns, so the memory plan and the decode cannot disagree about
 *   what a structured scan costs. Decoding new columns without counting them is
 *   how a fail-closed ceiling stops being one.
 */

import type { E57Field, E57Scan } from './schema';
import { e57ScanSupportsStructuredRange } from './schema';
import type { E57StructuredColumnRequest, E57StructuredKind } from './compressedVector';

/** The structured prototype fields this sink decodes, by LOCAL name. */
export const E57_STRUCTURED_FIELDS = [
  'rowIndex',
  'columnIndex',
  'returnIndex',
  'returnCount',
  'sphericalRange',
] as const;

/** Without both of these a scan addresses no cell, so neither is optional. */
const REQUIRED_STRUCTURED_FIELDS = ['rowIndex', 'columnIndex'] as const;

/** A field's LOCAL name, after any extension `prefix:`. */
function localFieldName(name: string): string {
  return name.slice(name.indexOf(':') + 1);
}

/** Widest value a `Uint16Array` holds, and the same for `Uint32Array`. */
const U16_MAX = 65535;
const U32_MAX = 4294967295;

/**
 * The integer width a declared index fits in, or null when the declaration
 * cannot size one honestly.
 *
 * The DECLARED BOUND decides, never the bit width. A field packed in 11 bits
 * declares a maximum of 2047, and `2 ** 11 - 1 + minimum` only coincides with
 * that when the writer used a power-of-two range — so reading the width back
 * out of the packing would over-state the range on every other file.
 *
 * A negative minimum, an inverted range or an absent maximum all return null.
 * None of them is repairable: an index array has no representation for a
 * negative cell address, and a bound the file never stated is not a bound this
 * reader may invent.
 */
export function e57IntegerWidthFor(field: E57Field): Extract<E57StructuredKind, 'u16' | 'u32'> | null {
  if (field.type === 'float') return null;
  const minimum = field.minimum ?? 0;
  const maximum = field.maximum;
  if (maximum === undefined || !Number.isSafeInteger(maximum)) return null;
  if (!Number.isSafeInteger(minimum) || minimum < 0) return null;
  if (maximum < minimum) return null;
  if (maximum <= U16_MAX) return 'u16';
  if (maximum <= U32_MAX) return 'u32';
  return null;
}

/**
 * The structured columns to decode for one scan, or an empty list.
 *
 * `sphericalRange` decodes as a float because it is a DISTANCE the source
 * declared, not an index — it is carried as the frame's `sourceRange` and never
 * folded into intensity or a generic scalar, which would leave a measured
 * quantity indistinguishable from a display channel.
 */
export function e57StructuredRequestsForScan(scan: E57Scan): E57StructuredColumnRequest[] {
  if (!e57ScanSupportsStructuredRange(scan)) return [];
  const wanted = new Set<string>(E57_STRUCTURED_FIELDS);
  const out: E57StructuredColumnRequest[] = [];
  for (const field of scan.prototype) {
    const local = localFieldName(field.name);
    if (!wanted.has(local)) continue;
    if (local === 'sphericalRange') {
      out.push({
        name: field.name,
        local,
        kind: 'f32',
        minimum: Number.NEGATIVE_INFINITY,
        maximum: Number.POSITIVE_INFINITY,
      });
      continue;
    }
    const kind = e57IntegerWidthFor(field);
    if (kind === null) {
      // A required index the file declares without a usable bound leaves the
      // whole grid unsizeable, so the scan keeps no structured column at all
      // rather than half of one.
      if ((REQUIRED_STRUCTURED_FIELDS as readonly string[]).includes(local)) return [];
      continue;
    }
    out.push({
      name: field.name,
      local,
      kind,
      minimum: field.minimum ?? 0,
      maximum: field.maximum!,
    });
  }
  const locals = new Set(out.map((r) => r.local));
  for (const required of REQUIRED_STRUCTURED_FIELDS) if (!locals.has(required)) return [];
  return out;
}

/** Bytes one value of a structured column occupies. */
export function e57StructuredValueBytes(kind: E57StructuredKind): number {
  return kind === 'u16' ? 2 : 4;
}

/** Bytes the structured columns of a scan cost PER RECORD, at their real widths. */
export function e57StructuredBytesPerRecord(
  requests: readonly E57StructuredColumnRequest[],
): number {
  let bytes = 0;
  for (const r of requests) bytes += e57StructuredValueBytes(r.kind);
  return bytes;
}

// --- what a grid costs, per cell -------------------------------------------
//
// The frame itself holds `cellState` (Uint8) and `cellToRecord` (Int32). The
// remap that carries record identity through sanitation copies both, and the
// copy is alive beside the original, so every cell is paid for twice.

/** `cellState` + `cellToRecord`, counted twice for the remap's live copy. */
export const E57_GRID_BYTES_PER_CELL = 2 * (1 + 4);
/** `sourceRange`, allocated only when the scan declares `sphericalRange`. */
export const E57_GRID_RANGE_BYTES_PER_CELL = 4;
/** `returnCellStart`, allocated only when the scan describes returns per cell. */
export const E57_GRID_RETURN_BYTES_PER_CELL = 4;

/**
 * Bytes one return costs while the CSR description is built: the `Int32` record,
 * the two `Uint16` source values, and the plain object it arrives in. Object
 * headers are not a typed-array cost and are not covered by the resident
 * allowance, and there is one per return, so they are counted rather than
 * hoped over.
 */
export const E57_RETURN_ENTRY_BYTES = 72;

/**
 * Cells the grid of an eligible scan holds, bounded by what the file can supply.
 *
 * The bound is the point. `indexBounds` is a CLAIM, and the PTX loader has
 * already been fixed twice for believing one: an 87-byte header declaring a
 * 100000 by 1000 grid allocated 900 MB before a point was read. A cell cannot
 * be evidenced by less than a byte of file, so a grid larger than the file is
 * not backed by any record and is refused here, before it is allocated and
 * before it is counted.
 */
export function e57StructuredGridCells(scan: E57Scan, fileBytes: number): number {
  if (!e57ScanSupportsStructuredRange(scan)) return 0;
  const row = scan.indexBounds!.row!;
  const column = scan.indexBounds!.column!;
  const cells = (row.maximum - row.minimum + 1) * (column.maximum - column.minimum + 1);
  if (!Number.isSafeInteger(cells) || cells <= 0) return 0;
  return cells <= Math.max(0, fileBytes) ? cells : 0;
}

/** Bytes the grid arrays of one scan cost, from the columns it will keep. */
export function e57StructuredGridBytes(scan: E57Scan, fileBytes: number): number {
  const cells = e57StructuredGridCells(scan, fileBytes);
  if (cells === 0) return 0;
  const requests = e57StructuredRequestsForScan(scan);
  if (requests.length === 0) return 0;
  const locals = new Set(requests.map((r) => r.local));
  let perCell = E57_GRID_BYTES_PER_CELL;
  if (locals.has('sphericalRange')) perCell += E57_GRID_RANGE_BYTES_PER_CELL;
  if (locals.has('returnIndex')) perCell += E57_GRID_RETURN_BYTES_PER_CELL;
  return cells * perCell;
}

/**
 * Bytes one RECORD of this scan costs beyond its point columns: the structured
 * columns themselves, plus the return-entry transient when the scan describes
 * returns per cell.
 */
export function e57StructuredBytesPerRecordForScan(scan: E57Scan, fileBytes: number): number {
  if (e57StructuredGridCells(scan, fileBytes) === 0) return 0;
  const requests = e57StructuredRequestsForScan(scan);
  if (requests.length === 0) return 0;
  const describesReturns = requests.some((r) => r.local === 'returnIndex');
  return e57StructuredBytesPerRecord(requests) + (describesReturns ? E57_RETURN_ENTRY_BYTES : 0);
}
