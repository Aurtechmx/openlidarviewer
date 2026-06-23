/**
 * instantAnswer.ts
 *
 * The "drop a file → here's your analysis, nothing uploaded" routing decision.
 *
 * No-upload competitors only *view* a cloud; the upload/desktop tools make you
 * hunt for an analysis button. The instant answer collapses that: the moment a
 * scan lands we name it and surface the single most-relevant analysis one click
 * away — terrain grade, volume, floor plan, or (with a second scan) a before/
 * after difference. This is the pure decision; the UI renders the banner and
 * wires the action to the existing analysis cores.
 *
 * Pure data in, pure data out — no DOM, no Viewer — so it is unit-testable and
 * the wiring can't drift from the policy.
 */

import type { SpaceKind } from '../terrain/scanShape';

/** Which analysis the instant answer offers as its primary action. */
export type InstantAction = 'terrain' | 'volume' | 'floorplan' | 'compare';

export interface InstantAnswerInput {
  /** Total clouds now loaded (a 2nd scan unlocks the before/after compare). */
  readonly cloudCount: number;
  /**
   * Detected shape of the just-loaded scan, or null when detection was
   * undecidable (sparse/ambiguous frame). Null falls back to terrain analysis,
   * which is the safe, most-common default.
   */
  readonly scanShape: SpaceKind | null;
  /** A short label for the just-loaded scan (file name), for the message. */
  readonly scanLabel?: string;
  /** The previously-loaded scan's label, for the compare offer. */
  readonly priorScanLabel?: string;
}

export interface InstantAnswer {
  /** One-line prompt shown the instant the scan lands. */
  readonly message: string;
  /** The single most-relevant analysis to offer, one click away. */
  readonly action: InstantAction;
  /** Button label for that action. */
  readonly actionLabel: string;
}

/**
 * Decide the instant answer for a freshly-loaded scan. A second scan always
 * takes precedence with the before/after offer (two epochs is an unambiguous
 * intent); otherwise route by detected shape, defaulting to terrain.
 */
export function planInstantAnswer(input: InstantAnswerInput): InstantAnswer {
  // Exactly two scans is the before/after case the comparison runs on; with a
  // third loaded, the new scan routes by its own shape instead.
  if (input.cloudCount === 2) {
    const pair = input.priorScanLabel
      ? `“${input.priorScanLabel}” vs “${input.scanLabel ?? 'this scan'}”`
      : 'the two scans';
    return {
      message: `Two scans loaded — compute the before/after change between ${pair}? Nothing leaves your device.`,
      action: 'compare',
      actionLabel: 'Compare →',
    };
  }

  switch (input.scanShape) {
    case 'object':
      return {
        message: 'Object scan ready — measure its volume? Nothing uploaded.',
        action: 'volume',
        actionLabel: 'Measure volume →',
      };
    case 'interior':
      return {
        message: 'Interior scan ready — extract the floor plan? Nothing uploaded.',
        action: 'floorplan',
        actionLabel: 'Floor plan →',
      };
    case 'terrain':
    default:
      return {
        message: 'Terrain scan ready — grade the surface and build contours? Nothing uploaded.',
        action: 'terrain',
        actionLabel: 'Analyse terrain →',
      };
  }
}
