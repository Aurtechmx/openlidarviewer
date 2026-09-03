/**
 * scanTypeProvenance.ts
 *
 * The scan-type block a Space / Object report prints, and the disclosure it
 * carries when the layout cannot describe the routed scan.
 *
 * A real export of a 1 km² airborne terrain tile printed "Scan type: Object"
 * while the on-screen "Treat scan as" pill read Terrain, and the artifact said
 * nothing about the disagreement: the report received one collapsed value
 * (three scan types folded onto its two layouts) and stamped it as the scan
 * type. So the label described the LAYOUT while claiming to describe the SCAN,
 * and neither the detector's verdict nor the user's override reached the page
 * to settle which of the two was right.
 *
 * {@link ScanTypeRecord} carries the real kind, the detector's verdict, the
 * override and whether a settled detection was committed. This turns that
 * record into footer lines worded exactly like the control (Terrain / Object /
 * Interior / Auto), so a reader can tell a DETECTED object from a FORCED one
 * and reconcile the PDF against the pill.
 *
 * When an object-envelope layout renders a terrain-routed scan the record also
 * yields {@link TERRAIN_ENVELOPE_DISCLOSURE}: the report still prints, and it
 * says the dimensions are a bounding box rather than a surveyed object.
 *
 * Pure: no DOM and no pdf-lib, so every line is unit-testable.
 */

import type { SpaceKind } from '../scanShape';
import type { ScanTypeRecord, SpaceReportLayout } from '../scanRoute';

/** The scan-type block: footer lines plus an optional disclosure sentence. */
export interface ScanTypeProvenance {
  /**
   * `Key  Value` footer lines, padded to the report's key column. These
   * REPLACE the layout's presentation-only `Scan type` line rather than joining
   * it: the stamp is bottom-anchored and the tall interior report already
   * reaches it, so the block has to cost no extra height. Always one line.
   */
  readonly lines: ReadonlyArray<string>;
  /** Non-null when the layout cannot honestly describe the routed scan. */
  readonly disclosure: string | null;
}

/** Verbatim from the "Treat scan as" control, so the two read as one answer. */
const KIND_LABEL: Record<SpaceKind, string> = {
  terrain: 'Terrain',
  object: 'Object',
  interior: 'Interior',
};

const LAYOUT_LABEL: Record<SpaceReportLayout, string> = {
  interior: 'Interior space',
  object: 'Object envelope',
};

/**
 * The standing disclosure for an object-envelope report over a terrain-routed
 * scan. The figures are real, and they measure the extent of the sampled
 * points; what they are NOT is a survey of an object, and a terrain tile's
 * envelope is the one reading that invites that mistake.
 */
export const TERRAIN_ENVELOPE_DISCLOSURE =
  'This scan is routed as Terrain. The dimensions below are the bounding box of the sampled points, ' +
  'not a surveyed object; use the terrain analysis for surface figures.';

/**
 * Same key column as the report footer's other provenance lines (a key wider
 * than the column still gets a gutter, or key and value jam into one token).
 */
const KEY_W = 16;
const kv = (k: string, v: string): string => `${k.padEnd(Math.max(KEY_W, k.length + 2))}${v}`;

/** How the "Treat as" control stood, in the control's own vocabulary. */
function treatAsLabel(record: ScanTypeRecord): string {
  if (record.override !== 'auto') return `Forced: ${KIND_LABEL[record.override]}`;
  if (record.detected === null) return 'Auto (detection undecided)';
  return record.committed ? 'Auto (settled, committed)' : 'Auto (provisional, uncommitted)';
}

/**
 * Build the scan-type block for a report.
 *
 * `current` is the route standing when the report was BUILT, which can differ
 * from the route the figures were computed under: the export handler captures
 * its inputs and then awaits a lazy chunk, so a "Treat as" pick landing in that
 * window moves the pill after the figures are fixed. Passing it in makes that
 * gap visible on the page instead of leaving a contradiction with no
 * explanation. Defaults to the recorded route (no gap to state).
 */
export function scanTypeProvenance(
  record: ScanTypeRecord,
  current: SpaceKind | null = record.routed,
): ScanTypeProvenance {
  const detected = record.detected === null ? 'not determined' : KIND_LABEL[record.detected];
  // The routed kind leads, because that is the scan; the detector's verdict and
  // the override follow, because together they are what the control displays.
  // "rendered as" is stated only where it adds something: a terrain scan has no
  // layout of its own, and for the other two the layout IS the routed kind.
  let value = `${KIND_LABEL[record.routed]}; detected ${detected}; treat as ${treatAsLabel(record)}`;
  if (record.routed === 'terrain') value += `; rendered as ${LAYOUT_LABEL[record.layout]}`;
  // A route that moved after the figures were fixed rides on the SAME line: an
  // extra one would push the interior report's footer into its caveats.
  if (current !== null && current !== record.routed) value += `; route now ${KIND_LABEL[current]}`;
  const lines = [kv('Scan type', value)];
  // Terrain has no layout of its own, so it reaches the page as an envelope.
  // Disclose it whether the figures were computed under a terrain route or the
  // route moved to terrain before the artifact was written.
  const terrainRouted = record.routed === 'terrain' || current === 'terrain';
  return {
    lines,
    disclosure: terrainRouted && record.layout === 'object' ? TERRAIN_ENVELOPE_DISCLOSURE : null,
  };
}
