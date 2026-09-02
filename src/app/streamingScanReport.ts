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

// Re-exported so the shell reaches every streaming report row builder through
// one seam. The extent block's unit gate is the same `SpatialContext` gate the
// rows below apply, and splitting the import across two modules is how the two
// halves of one report end up maintained apart.
export { streamingExtentRows } from '../analysis/streamingExtentRows';

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
