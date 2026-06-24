/**
 * runFullCloudGradeAction.ts
 *
 * The orchestration for the full-cloud grade (the B-trigger), pulled out of
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
  readonly debug?: boolean;
}): Promise<void> {
  const { viewer, panel, debug } = deps;
  const source = viewer.streamingCloud;
  const decoder = viewer.streamingDecoder;
  if (!source || !decoder) {
    panel.setGradeError('Open a streaming COPC or EPT scan first.');
    return;
  }
  panel.setGradeBusy('Planning octree sample…');
  try {
    const run = await gradeFullCloud({
      source,
      decoder,
      grade: (positions, scale) => gradeSampleDensity(positions, scale),
      onProgress: (p) => {
        panel.setGradeBusy(
          `Decoding ${p.decodedNodes} / ${p.totalNodes} nodes · ` +
            `${Math.round(p.decodedPoints).toLocaleString('en-US')} pts…`,
        );
      },
    });
    panel.setGradeResult(run.coverage.label, summarizeSampleGrade(run.grade), run.coverage.note);
  } catch (err) {
    if (debug) console.warn('[full-cloud grade] failed', err);
    panel.setGradeError(
      err instanceof Error ? `Grade failed: ${err.message}` : 'Grade failed.',
    );
  }
}
