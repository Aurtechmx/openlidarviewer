/**
 * preflightActions.ts — bind the preflight's named remediations to what the app
 * can actually do.
 *
 * `PreflightActionId` names a DOMAIN intent ("confirm the coordinate system"),
 * not a button, so something has to say which intent this app can carry out and
 * which it cannot. That decision lives here, once, and it is honest in both
 * directions: an intent with no handler reports `canRun === false`, and the
 * surface renders it as guidance instead of a control that does nothing.
 *
 * WIRED, with the shell action each one runs:
 *
 *   set-coordinate-system  → reveal the Inspector's coordinate-system override
 *   inspect-layer-crs      → reveal the Inspector's layer list, where each
 *                            layer's declared reference and its compatibility
 *                            flag are shown
 *   solo-active-layer      → isolate the active layer (`LayerService.soloOnly`)
 *   classify-scan          → run the classification derive
 *   load-second-scan       → open the add-a-dataset file picker (the same one
 *                            the "+ Add dataset" control opens)
 *   continue-exploratory   → arm the measurement anyway. Honest because the
 *   continue-resident-only   figure keeps its own label: `measureConfidence`
 *                            already marks it approximate in the measure bar and
 *                            the Measurements panel. Only ever offered for a
 *                            MEASUREMENT tool, and only when the preflight is
 *                            not `blocked` (the model drops permissive actions
 *                            from a blocked verdict itself).
 *
 * NOT WIRED, and stated rather than faked:
 *
 *   await-full-coverage — waiting is not an action the app performs; the
 *                         streaming source refines on its own, and a control
 *                         that "waits" would do nothing.
 *   align-scans         — placement onto the shared project frame is automatic
 *                         and there is no user-invocable align step to offer.
 *
 * No DOM and no three.js: the host hands in plain callbacks.
 */

import { toolMeasurementKind, type PreflightActionId, type ToolId } from '../process/toolPreflight';
import type { MeasurementKind } from '../render/measure/types';

/**
 * What the shell can perform. Every member is optional: a host that cannot do
 * one of these simply omits it, and the action reports itself unavailable
 * instead of being offered.
 */
export interface PreflightActionHost {
  /** Reveal the coordinate-system control for the active scan. */
  openCoordinateSystem?(): void;
  /** Reveal the layer list, where each layer's declared reference is shown. */
  inspectLayerCrs?(): void;
  /** Isolate the active layer so one proven frame is in play. */
  soloActiveLayer?(): void;
  /** Derive the classes a class-dependent product needs. */
  classifyScan?(): void;
  /** Arm a measurement so the user may proceed with the stated caveat. */
  armMeasurement?(kind: MeasurementKind): void;
  /** Open the add-a-dataset file picker so a second scan can be loaded. */
  addDataset?(): void;
}

/** The actions no host can perform — see the header for why each one is here. */
export const UNPERFORMABLE_ACTIONS: readonly PreflightActionId[] = [
  'await-full-coverage',
  'align-scans',
];

/**
 * The callback for one action against one tool, or `null` when this host cannot
 * perform it. The switch is exhaustive over `PreflightActionId`, so a new action
 * added to the model fails to compile here rather than silently rendering as
 * unavailable.
 */
function handlerFor(
  host: PreflightActionHost,
  action: PreflightActionId,
  tool: ToolId,
): (() => void) | null {
  switch (action) {
    case 'set-coordinate-system':
      return host.openCoordinateSystem ? () => host.openCoordinateSystem?.() : null;
    case 'inspect-layer-crs':
      return host.inspectLayerCrs ? () => host.inspectLayerCrs?.() : null;
    case 'solo-active-layer':
      return host.soloActiveLayer ? () => host.soloActiveLayer?.() : null;
    case 'classify-scan':
      return host.classifyScan ? () => host.classifyScan?.() : null;
    case 'continue-exploratory':
    case 'continue-resident-only': {
      // Proceeding is only something the app can DO for an interactive
      // measurement — a derived product's exploratory path is the exporter's
      // own permit, and restating it here would be a second gate.
      const kind: MeasurementKind | null = toolMeasurementKind(tool);
      const arm = host.armMeasurement;
      return kind !== null && arm ? () => arm(kind) : null;
    }
    case 'load-second-scan':
      return host.addDataset ? () => host.addDataset?.() : null;
    case 'await-full-coverage':
    case 'align-scans':
      return null;
  }
}

/** Decides whether an action can run, and runs it. */
export interface PreflightActionRunner {
  /** True when this host can carry out `action` for `tool`. */
  canRun(action: PreflightActionId, tool: ToolId): boolean;
  /** Run it; returns false (and does nothing) when it cannot be carried out. */
  run(action: PreflightActionId, tool: ToolId): boolean;
}

/** Bind the action vocabulary to one host's capabilities. */
export function createPreflightActionRunner(host: PreflightActionHost): PreflightActionRunner {
  return {
    canRun(action, tool) {
      return handlerFor(host, action, tool) !== null;
    },
    run(action, tool) {
      const handler = handlerFor(host, action, tool);
      if (!handler) return false;
      handler();
      return true;
    },
  };
}
