/**
 * streamingScanReport.ts — the streaming Scan Report rows whose wording is a
 * claim about units, provenance or basis.
 *
 * The shell assembles the streaming report (`runStreamingModules` in
 * `src/main.ts`) from the source's header, its COPC info VLR and its hierarchy
 * index, in the same `AnalysisRow` shape the static Scan Report emits. Three of
 * those groups say something the reader will act on, and each had drifted from
 * `analysis/modules/scanReport.ts`:
 *
 *  - the octree root spacing carried a literal " m" whatever the source CRS's
 *    linear unit was, so a state-plane-FEET COPC read ~3.28x too large,
 *    labelled as metres;
 *  - the LAS `system_identifier` was still called "Capture Sensor" after the
 *    static report stopped calling it that, and no file-creation label existed
 *    at all;
 *  - the Float32 in-memory quantization was disclosed on the static side only,
 *    although the streaming decoder writes the same Float32 positions against a
 *    render origin (`io/copc/copcChunkDecode.ts`).
 *
 * Each is answered by the authority that already owns the question — the
 * resolved {@link SpatialContext} for the unit gate, `ui/StreamingPanel`'s
 * `spacingRowFor` for the spacing label, `app/scanPrecision.ts` over
 * `geo/inMemoryPrecision.ts` for the step, `analysis/inMemoryPrecisionRows.ts`
 * for the sentence that prints it — rather than by a second formula written for
 * the report. Every one of them FAILS CLOSED: with no established linear unit
 * the figure stays in source units and no millimetre is invented.
 */

import type { AnalysisRow } from '../analysis/ModuleApi';
import { inMemoryPrecisionRows } from '../analysis/inMemoryPrecisionRows';
import { scanPrecision } from './scanPrecision';
import { spacingRowFor } from '../ui/StreamingPanel';
import type { SpatialContext } from '../geo/SpatialContext';
import type { CrsLinearUnit } from '../io/crs';
import { notScopedSentinel } from '../render/class/classScope';
import { streamingSourceLabel, type StreamingSourceKind } from '../render/streaming/StreamingSource';

// Re-exported so the shell reaches every streaming report row builder through
// one seam. The extent block's unit gate is the same `SpatialContext` gate the
// rows below apply, and splitting the import across two modules is how the two
// halves of one report end up maintained apart.
import { streamingExtentRows } from '../analysis/streamingExtentRows';
export { streamingExtentRows };

/** The streaming source fields the structure + precision rows read. */
export interface StreamingStructureSource {
  /** The Float64 origin every decoded node is recentred against; absent on a source that does not expose one. */
  readonly renderOrigin?: readonly [number, number, number];
  /** The octree ROOT CUBE in local space — a containment bound, never the first choice for a reach. */
  readonly localBounds?: () => readonly [number, number, number, number, number, number];
  readonly metadata?: {
    readonly header?: {
      min: readonly [number, number, number];
      max: readonly [number, number, number];
    };
    readonly info?: { spacing?: number };
  };
  readonly maxDepth?: () => number;
  readonly octree?: { nodes: () => readonly unknown[] };
}

/** The header provenance fields, in the shape the report cloud carries them. */
export interface StreamingProvenanceMetadata {
  readonly captureSensor?: string;
  readonly sourceSoftware?: string;
  readonly captureDate?: string;
}

const info = (label: string, value: string): AnalysisRow => ({ label, value, status: 'info' });

/**
 * What every other row in the streaming report is taken from.
 *
 * All of them are source DECLARATIONS — the file header, the COPC info VLR,
 * the hierarchy index — and none is a count of the nodes decoded and uploaded
 * at this instant. The two differ by orders of magnitude for most of a
 * streaming session, and without the statement a reader has no way to tell a
 * declared total from a live one.
 */
export function streamingReportBasisRow(): AnalysisRow {
  return info(
    'Report basis',
    'source-declared header and hierarchy index, not the nodes currently resident',
  );
}

/**
 * The octree-structure rows, plus the Float32 disclosure the static report
 * already carries.
 *
 * SPACING UNIT. COPC's `info.spacing` is a root-node point spacing in the
 * SOURCE CRS's linear units, not metres. The unit decision is `spacingRowFor`,
 * the same one the Streaming panel's own Spacing row applies: metres are
 * claimed only when the resolved frame declares a real linear unit, a foot CRS
 * is converted first, a geographic CRS has no linear spacing at all, and an
 * unresolved unit stays in source units.
 *
 * IN-MEMORY RESOLUTION. Representational resolution of the stored coordinates,
 * never survey, sensor or vertical accuracy. Measured through the one canonical
 * reader (`app/scanPrecision.ts`) on the TIGHT header extent against the render
 * origin the decoder actually subtracts, with the octree root cube left as that
 * reader's own fallback for an unreadable header box — the cube over-reports
 * the reach on the short axes. A source that exposes no render origin gets NO
 * row: there is no frame to measure, and a figure taken from a guessed origin
 * would describe the guess.
 */
export function streamingStructureRows(
  cloud: StreamingStructureSource,
  ctx: SpatialContext,
): AnalysisRow[] {
  const rows: AnalysisRow[] = [];
  const header = cloud.metadata?.header;
  const ro = cloud.renderOrigin;
  if (ro && header) {
    const precision = scanPrecision({
      streaming: {
        renderOrigin: ro,
        dataBounds: () => [
          header.min[0] - ro[0], header.min[1] - ro[1], header.min[2] - ro[2],
          header.max[0] - ro[0], header.max[1] - ro[1], header.max[2] - ro[2],
        ],
        ...(cloud.localBounds ? { localBounds: cloud.localBounds } : {}),
      },
      crs: ctx,
    });
    if (precision) rows.push(...inMemoryPrecisionRows(precision));
  }
  const rootSpacing = cloud.metadata?.info?.spacing;
  if (rootSpacing !== undefined) {
    rows.push(info('Octree root spacing', spacingRowFor('copc', rootSpacing, ctx).value));
  }
  if (cloud.maxDepth) {
    try { rows.push(info('Octree depth', String(cloud.maxDepth()))); }
    catch { /* defensive — depth not always computable mid-load */ }
  }
  if (cloud.octree) {
    try { rows.push(info('Octree nodes', cloud.octree.nodes().length.toLocaleString('en-US'))); }
    catch { /* defensive */ }
  }
  return rows;
}

/**
 * Header provenance, labelled by what each LAS field IS — the same labels
 * `analysis/modules/scanReport.ts` uses, so one file cannot be described two
 * ways depending on how it was opened.
 *
 * `system_identifier` names hardware OR a producing process, software or
 * organisation, so it is never called a sensor. The File Creation Day/Year is
 * when the file was WRITTEN, which is not when the survey was flown, so it is
 * never called a capture date and acquisition timing is never inferred from it.
 */
export function streamingProvenanceRows(meta: StreamingProvenanceMetadata | undefined): AnalysisRow[] {
  const rows: AnalysisRow[] = [];
  if (meta?.captureSensor) rows.push(info('System identifier', meta.captureSensor));
  if (meta?.sourceSoftware) rows.push(info('Source Software', meta.sourceSoftware));
  if (meta?.captureDate) rows.push(info('File created', meta.captureDate));
  return rows;
}

/** The streaming cloud facts the report assembler reads; the shell's own view of a source. */
export interface StreamingReportCloud {
  readonly kind: StreamingSourceKind;
  readonly name: string;
  readonly sourcePointCount: number | null; // null where the format states no total: a tileset declares none, and its per-tile figures are decode-admission estimates rather than counts
  readonly localBounds?: () => readonly [number, number, number, number, number, number];
  readonly renderOrigin?: readonly [number, number, number]; // the Float64 origin the decoder subtracts; absent on a source that exposes none, and then no precision row is minted
  readonly metadata?: {
    readonly header?: {
      min: readonly [number, number, number];
      max: readonly [number, number, number];
      pointDataRecordFormat?: number;
    };
    readonly info?: { spacing?: number };
    readonly captureSensor?: string;
    readonly sourceSoftware?: string;
    readonly captureDate?: string;
  };
  readonly crs?: () => { readonly linearUnit?: CrsLinearUnit; readonly linearUnitToMetres?: number; readonly verticalUnitToMetres?: number } | null;
  readonly maxDepth?: () => number;
  readonly octree?: { nodes: () => readonly unknown[] };
}

/**
 * Synthesize a scan-report row set for a streaming cloud.
 *
 * The static `runModules()` path expects a fully-resident `PointCloud`
 * (Float32Array positions, classification arrays, etc.). For a streaming
 * COPC or EPT we only ever hold a thin resident shell, so the static
 * modules can't run as-is. We instead pull the equivalent facts directly
 * from the streaming source's header + COPC info / EPT schema, which
 * carry everything the report needs: total point count, source-declared
 * bounds, spacing, octree depth, and the LAS header provenance strings
 * the provenance classifier already feeds from.
 *
 * The output is intentionally the same `AnalysisRow` shape the static
 * report uses, so the Inspector's Scan-report section renders uniformly
 * and the PDF Report Engine can consume it without a separate code path.
 *
 * Every row whose wording is a CLAIM — the unit on a length, the name of a
 * LAS header field, the Float32 step the coordinates are stored on — is
 * built against the resolved frame the caller hands in, so it says what the
 * static Scan Report says about the same file. This function is the
 * assembler; the shell only supplies the cloud and the frame.
 */
export function runStreamingModules(cloud: StreamingReportCloud, ctx: SpatialContext, classFilterActive = false): AnalysisRow[] {
  const rows: AnalysisRow[] = [];
  const info = (label: string, value: string): AnalysisRow =>
    ({ label, value, status: 'info' });
  // Streaming density/spacing are derived from the file header's full-cloud
  // totals — there is no client-side per-class breakdown to scope them to. So
  // they stay full-cloud and, when a class filter is active, carry the honesty
  // sentinel that renders "full cloud (header) — not class-scoped" rather than
  // pretending the figure honours the filter.
  const headerMetric = (label: string, value: string): AnalysisRow => {
    const row = info(label, value);
    if (classFilterActive) row.scope = notScopedSentinel();
    return row;
  };

  rows.push(info('Source', streamingSourceLabel(cloud.kind)));
  // Said once, before any figure: every number below is a source DECLARATION,
  // not a count of what is decoded and on the GPU right now.
  rows.push(streamingReportBasisRow());
  if (cloud.metadata?.header?.pointDataRecordFormat !== undefined) rows.push(info('Point format', `PDRF ${cloud.metadata.header.pointDataRecordFormat}`));
  // An absent total is reported as absent: a zero, or a summed per-tile estimate, would each read as a figure the source stands behind.
  rows.push(cloud.sourcePointCount === null ? info('Source point count', 'not stated by the source') : headerMetric('Source point count', cloud.sourcePointCount.toLocaleString('en-US')));

  // Bounds — the header's source-coordinate min/max is the TIGHT data extent
  // (a 1000×1000×138 m scan reports 138 m here). Do NOT use `localBounds`: for
  // streaming that is the octree ROOT CUBE (1000³), which over-reports the
  // vertical (and any partial-footprint) span. This matches the Streaming
  // panel's Extent row, which also reads the header.
  const header = cloud.metadata?.header;
  if (header) {
    // Convert the source-CRS units to metres before printing "m" / "pts/m²",
    // exactly as the static Scan Report and the PDF do. A state-plane-FEET COPC
    // otherwise over-reports extent ~3.28× and density ~10.8×, mislabelled as
    // metres. `streamingExtentRows` FAILS CLOSED on an unconfirmed unit
    // (placeholder `linearUnitToMetres: 1`): it drops the "m"/"pts/m²" claim
    // rather than stamping metres onto non-metre data — as measure/lasso do.
    // Reads the resolved frame the caller supplies.
    const ext = streamingExtentRows(header, ctx, cloud.sourcePointCount);
    if (!ext.unitConfirmed) {
      rows.push({
        label: 'Units',
        value: 'unconfirmed — source CRS declares no linear unit; extents shown in source units',
        status: 'warn',
      });
    }
    for (const r of ext.rows) {
      rows.push(r.scoped ? headerMetric(r.label, r.value) : info(r.label, r.value));
    }
  }

  // Streaming-specific: the octree structure, and the Float32 in-memory
  // resolution the static report already discloses. The spacing unit and the
  // precision measurement are decided against the same resolved frame the
  // extent block reads, and both fail closed on an unconfirmed unit.
  rows.push(...streamingStructureRows(cloud, ctx));

  // Header provenance, labelled by what each LAS field IS — the same labels
  // the static Scan Report uses, so the same file is never described two ways
  // depending on how it was opened.
  rows.push(...streamingProvenanceRows(cloud.metadata));

  return rows;
}

