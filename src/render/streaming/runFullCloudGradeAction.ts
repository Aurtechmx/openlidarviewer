/**
 * runFullCloudGradeAction.ts
 *
 * The orchestration for the full-cloud grade, pulled out of
 * `main.ts` into its own module so it loads ONLY when the user clicks "Grade
 * full cloud". Keeping it lazy (with the adapter + grade it imports) holds the
 * live index bundle under its size budget — the same pattern the command
 * palette and export-confirm dialogs use.
 *
 * It decodes a representative breadth-first octree sample across the WHOLE
 * streaming cloud — not just the view-driven resident nodes the panel already
 * shows — and grades its density, vertical extent, and footprint coverage. The
 * decode reuses the session's existing chunk decoder (no second worker pool),
 * and the sampling plan's default 2M-point budget keeps a multi-million-point
 * cloud responsive. The result carries an honest "exact vs sampled at N%" label
 * so the figure never implies a completeness it doesn't have.
 */

import type { Viewer } from '../Viewer';
import type { StreamingPanel } from '../../ui/StreamingPanel';
import { gradeFullCloud } from './fullCloudGradeAdapter';
import { gradeSampleDensity, summarizeSampleGrade } from './sampleGrade';

/**
 * Decode + grade the active streaming cloud's full extent and render the result
 * into the streaming panel. Guards on there being a live streaming session;
 * surfaces any decode failure as a panel error rather than throwing.
 */
export async function runFullCloudGrade(deps: {
  readonly viewer: Viewer;
  readonly panel: StreamingPanel;
  readonly signal?: AbortSignal;
  readonly debug?: boolean;
}): Promise<void> {
  const { viewer, panel, signal, debug } = deps;
  const source = viewer.streamingCloud;
  const decoder = viewer.streamingDecoder;
  if (!source || !decoder) {
    panel.setGradeError('Open a streaming COPC or EPT scan first.');
    return;
  }
  panel.setGradeBusy('Planning octree sample…');
  // The decoded positions are in the source CRS's linear unit; convert spans to
  // metres so the density (pts/m²) and vertical extent read in SI rather than in
  // feet for a state-plane-feet cloud. FAIL CLOSED on an unconfirmed unit: an
  // unknown-unit CRS carries the inert placeholder linearUnitToMetres:1 (and a
  // CRS-less cloud resolves the same), so applying that factor would stamp raw
  // source spans as metres — pts/m² and vertical m for data that may be feet.
  // Metres are only claimed when the CRS declares a real linear unit, the same
  // gate the scan-report rows (streamingExtentRows) and the measure tool apply;
  // otherwise the factor stays 1 and the summary labels the figures per source
  // unit (see summarizeSampleGrade's unitConfirmed argument).
  const crs = source.crs();
  const unitConfirmed = crs != null && crs.linearUnit !== 'unknown';
  const metresPerUnit = unitConfirmed ? (crs?.linearUnitToMetres ?? 1) : 1;
  // Z gets the vertical unit when the CRS declares one separately (e.g. NAVD88
  // feet over a metre grid); otherwise it follows the horizontal factor.
  const verticalMetresPerUnit = unitConfirmed ? (crs?.verticalUnitToMetres ?? metresPerUnit) : 1;
  try {
    const run = await gradeFullCloud({
      source,
      decoder,
      signal,
      grade: (positions, scale) =>
        gradeSampleDensity(positions, scale, metresPerUnit, verticalMetresPerUnit),
      onProgress: (p) => {
        // Don't paint progress for a scan that's no longer the active one — a
        // detach/replace mid-decode must not write into the new cloud's panel.
        if (viewer.streamingCloud !== source) return;
        panel.setGradeBusy(
          `Decoding ${p.decodedNodes} / ${p.totalNodes} nodes · ` +
            `${Math.round(p.decodedPoints).toLocaleString('en-US')} pts…`,
        );
      },
    });
    // Stale-result guard: the grade decodes a multi-million-point sample over
    // several seconds. If the streaming cloud was detached or swapped for another
    // while it ran, this result describes a scan that's no longer shown — discard
    // it silently rather than paint a stale grade over a different (or absent)
    // cloud's panel.
    if (viewer.streamingCloud !== source) return;
    panel.setGradeResult(
      run.coverage.label,
      summarizeSampleGrade(run.grade, unitConfirmed),
      run.coverage.note,
    );
  } catch (err) {
    // A user-initiated cancel is not a failure — show a neutral note, not the
    // red error state.
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      panel.setGradeCancelled();
      return;
    }
    if (debug) console.warn('[full-cloud grade] failed', err);
    panel.setGradeError(
      err instanceof Error ? `Grade failed: ${err.message}` : 'Grade failed.',
    );
  }
}
