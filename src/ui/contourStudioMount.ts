/**
 * contourStudioMount.ts
 *
 * The lazy entry point for Contour Studio (v0.5.9 §26.1: Contour Studio must sit
 * behind a lazy boundary, not in the eager startup shell).
 *
 * This module bundles the result→state adapter, the launcher, the state
 * controller, and the workspace shell so they load as one split chunk the first
 * time an analysis completes, never as part of the initial payload. It is
 * reached only through `loadContourStudioMount()` in `lazyChunks.ts` (kept out
 * of the live source-transform), so the dynamic-import specifier stays
 * statically analysable. All DOM construction lives here rather than in the eager
 * panel, keeping the shell's contribution to the launcher near zero.
 */

import {
  contourStudioLaunchStateFromResult,
  type LaunchFrameContext,
} from '../terrain/contourStudio/contourStudioLaunchStateFromResult';
import { renderContourStudioLauncher } from './contourStudioLauncher';
import { renderContourStudioWorkspace } from './contourStudioWorkspace';
import { createContourStudioController } from '../terrain/contourStudio/contourStudioController';
import { buildContourReviewSummary } from '../terrain/contourStudio/contourReviewSummary';
import { baseContourStudioState } from '../terrain/contourStudio/contourStudioState';
import { knownUnit, unknownUnit } from '../units/units';
import type { AnalyseContoursResult } from '../terrain/contour/analyseContours';

export type { LaunchFrameContext };

export interface MountContourStudioOptions {
  readonly result: AnalyseContoursResult;
  readonly ctx: LaunchFrameContext;
  /** Where the launcher card is rendered (the panel's launcher slot). */
  readonly launcherHost: HTMLElement;
  /** The gated container the workspace shell is rendered into (above exports). */
  readonly deliverableHost: HTMLElement;
  /** Reveals `deliverableHost` — the launcher's action. */
  readonly onLaunch: () => void;
}

const WORKSPACE_HOST_CLASS = 'olv-cs-host';

/**
 * Compute the launch state and render the launcher + workspace shell into the
 * panel's hosts. Idempotent: re-mounting clears the launcher slot and reuses a
 * single workspace host inside the deliverable container, so repeated analyses
 * never stack duplicate studios.
 */
export function mountContourStudio(opts: MountContourStudioOptions): void {
  const state = contourStudioLaunchStateFromResult(opts.result, opts.ctx);

  // Launcher card.
  opts.launcherHost.replaceChildren();
  const launcher = renderContourStudioLauncher(state, { onLaunch: opts.onLaunch });
  if (launcher) opts.launcherHost.append(launcher);

  // Workspace shell — a single reusable host at the top of the deliverable
  // container, above the existing export controls.
  let host = opts.deliverableHost.querySelector(`.${WORKSPACE_HOST_CLASS}`);
  if (!host) {
    host = document.createElement('div');
    host.className = WORKSPACE_HOST_CLASS;
    opts.deliverableHost.prepend(host);
  }
  host.replaceChildren();
  const controller = createContourStudioController();
  // Review summary (PR5): recommendations surfaced from the analysis result.
  // The contour interval gate reports intervals in the surface's SOURCE vertical
  // units (feet for foot data), so we must carry the REAL scale + label from the
  // CRS — never assume metres. A foot interval is shown as "2 ft (0.61 m)", not
  // "2 m". Unknown unit ⇒ unknownUnit() ⇒ no metric claim.
  const scale = opts.ctx.verticalUnitToMetres;
  const unitKnown = scale != null && Number.isFinite(scale) && scale > 0;
  const review = buildContourReviewSummary(opts.result, {
    launch: state,
    state: baseContourStudioState(),
    verticalUnit: unitKnown ? knownUnit(scale) : unknownUnit(),
    sourceUnitLabel: (unitKnown ? opts.ctx.verticalUnitLabel : null) ?? '',
    crsProjected: opts.ctx.crsProjected,
  });
  host.append(
    renderContourStudioWorkspace({ controller, launch: state, review }),
  );
}
