/**
 * contourStudioMount.ts
 *
 * The lazy entry point for the Contour Studio launcher (v0.5.9 §26.1: Contour
 * Studio must sit behind a lazy boundary, not in the eager startup shell).
 *
 * This module bundles the result→state adapter and the launcher DOM builder so
 * they load as a single split chunk the first time an analysis completes, never
 * as part of the initial payload. It is reached only through
 * `loadContourStudioMount()` in `lazyChunks.ts` (kept out of the live
 * source-transform), so the dynamic-import specifier stays statically analysable.
 */

import {
  contourStudioLaunchStateFromResult,
  type LaunchFrameContext,
} from '../terrain/contourStudio/contourStudioLaunchStateFromResult';
import { renderContourStudioLauncher } from './contourStudioLauncher';
import type { AnalyseContoursResult } from '../terrain/contour/analyseContours';

export type { LaunchFrameContext };

/**
 * Compute the launch state from a result + frame context and render the
 * launcher element, or `null` when the state is not visible (before analysis).
 * `onLaunch` reveals the gated contour export controls.
 */
export function buildContourLauncher(
  result: AnalyseContoursResult,
  ctx: LaunchFrameContext,
  onLaunch: () => void,
): HTMLElement | null {
  const state = contourStudioLaunchStateFromResult(result, ctx);
  return renderContourStudioLauncher(state, { onLaunch });
}
