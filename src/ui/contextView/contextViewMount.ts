/**
 * contextViewMount.ts — the mount controller for the Context View panel.
 *
 * Everything the panel needs from the application is behind the small
 * `ContextViewHost` seam — a layer list, the resolved CRS, a converter — so
 * the `main.ts` hookup is a handful of lines: construct the controller with
 * accessors it already has, append `element`, call `refresh()` on layer or CRS
 * change, `dispose()` on teardown. All state assembly lives here, where it is
 * testable without the monolith.
 *
 * Consent is session-scoped and owned by this controller: one machine per
 * mount, never persisted to disk in this build, so a reload asks again rather
 * than remembering a grant the user gave a different session. No code in this
 * module or below it fetches a tile; the panel states that itself.
 */

import type { CoordinateConverter } from '../../geo/CoordinateConverter';
import type { ResolvedCrs } from '../../geo/CoordinateTypes';
import { decideContextEligibility } from '../../geo/context/contextEligibility';
import { buildContextFootprint, type ContextFootprint } from '../../geo/context/footprintModel';
import { contextFactsFrom, lonLatTransformFrom } from '../../geo/context/fromCrs';
import { createConsentState } from '../../geo/context/consent';
import { CONTEXT_STATUS } from '../../geo/context/statusVocabulary';
import { renderContextViewPanel, type ContextViewPanelState } from './ContextViewPanel';

/** The XY footprint bounds of one loaded layer, in its native CRS. */
export interface ContextLayerBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** One loaded layer as the context view needs it. */
export interface ContextLayerDescriptor {
  readonly id: string;
  readonly name: string;
  readonly bounds: ContextLayerBounds;
}

/** The seam to the application. All accessors, no retained references. */
export interface ContextViewHost {
  readonly listLayers: () => readonly ContextLayerDescriptor[];
  readonly currentCrs: () => ResolvedCrs | null;
  readonly converter: () => CoordinateConverter;
}

/** True when all four XY bounds of a layer are finite numbers. */
function hasFiniteBounds(layer: ContextLayerDescriptor): boolean {
  const b = layer.bounds;
  return [b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite);
}

/**
 * Assemble the panel state from the host — pure given the host's answers.
 *
 * Bounds-finiteness is judged PER LAYER, never inherited from whichever layer
 * happens to be first: one poisoned layer must not refuse its placeable
 * siblings. The converter is probed at the centre of the first layer that
 * actually has finite bounds (the layers share the app's single resolved CRS,
 * so one honest probe answers for all of them), and layers whose corners fail
 * to transform are omitted from the footprint list rather than drawn at guessed
 * positions; the panel's canvas label carries the count that made it.
 *
 * Two states exist that are NOT transform refusals, and neither may borrow the
 * transform vocabulary:
 *   - no layers at all → the `empty` state, which says exactly that;
 *   - layers present but none with finite bounds → a bounds refusal with no
 *     transform claim, because no probe was attempted.
 */
export function buildContextViewState(
  host: ContextViewHost,
  consent: ContextViewPanelState['consent'],
): ContextViewPanelState {
  const layers = host.listLayers();
  const crs = host.currentCrs();
  const converter = host.converter();

  // (1) Nothing loaded: the panel has no scan to make any claim about.
  if (layers.length === 0) {
    return { consent, eligible: false, empty: true, reasons: [], footprints: [] };
  }

  const placeable = layers.filter(hasFiniteBounds);

  // (2) Layers present, none with usable bounds. No probe point exists, so the
  // probe is not attempted — and the state must not report a probe result.
  if (placeable.length === 0) {
    const facts = contextFactsFrom(crs, converter, { x: 0, y: 0 }, false);
    const decision = decideContextEligibility(facts);
    const reasons = decision.eligible
      ? [CONTEXT_STATUS.boundsNotFinite]
      : decision.reasons.filter((r) => r !== CONTEXT_STATUS.transformUnavailable);
    return { consent, eligible: false, reasons, footprints: [] };
  }

  // (3) At least one layer can be placed: probe at its centre, for real.
  const probeLayer = placeable[0];
  const probe = {
    x: (probeLayer.bounds.minX + probeLayer.bounds.maxX) / 2,
    y: (probeLayer.bounds.minY + probeLayer.bounds.maxY) / 2,
  };
  const facts = contextFactsFrom(crs, converter, probe, true);
  const decision = decideContextEligibility(facts);
  if (!decision.eligible) {
    return { consent, eligible: false, reasons: decision.reasons, footprints: [] };
  }

  const transform = lonLatTransformFrom(converter, crs as ResolvedCrs);
  const footprints: ContextFootprint[] = [];
  for (const layer of placeable) {
    const built = buildContextFootprint(layer.id, layer.name, layer.bounds, transform);
    if ('failed' in built) continue; // refusal, never a guessed outline
    footprints.push(built);
  }
  return { consent, eligible: true, reasons: [], footprints };
}

/** The mounted controller: one element, refresh on demand, dispose to clear. */
export interface ContextViewController {
  readonly element: HTMLElement;
  readonly refresh: () => void;
  readonly dispose: () => void;
}

/**
 * Create the controller. The returned `element` is an empty container until
 * the first `refresh()`, so callers can append it wherever the layout wants
 * it before any state exists.
 */
export function createContextViewController(host: ContextViewHost): ContextViewController {
  const consent = createConsentState();
  const element = document.createElement('div');
  element.className = 'olv-context-mount';

  const refresh = (): void => {
    const panel = renderContextViewPanel(buildContextViewState(host, consent.get()), {
      onGrant: () => {
        consent.grant();
        refresh();
      },
      onDeny: () => {
        consent.deny();
        refresh();
      },
    });
    element.replaceChildren(panel);
  };

  return {
    element,
    refresh,
    dispose: () => {
      element.replaceChildren();
      element.remove();
    },
  };
}
