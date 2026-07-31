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

/**
 * Assemble the panel state from the host — pure given the host's answers.
 * Eligibility is decided once for the app's single resolved CRS, probing the
 * converter at the FIRST layer's bounds centre (the layers share the CRS, so
 * one honest probe answers for all). Layers whose corners fail to transform
 * are omitted from the footprint list rather than drawn at guessed positions;
 * the panel's canvas label carries the count that made it.
 */
export function buildContextViewState(
  host: ContextViewHost,
  consent: ContextViewPanelState['consent'],
): ContextViewPanelState {
  const layers = host.listLayers();
  const crs = host.currentCrs();
  const converter = host.converter();

  const first = layers[0];
  const boundsFinite =
    first !== undefined &&
    [first.bounds.minX, first.bounds.minY, first.bounds.maxX, first.bounds.maxY].every(
      Number.isFinite,
    );
  const probe = first
    ? {
        x: (first.bounds.minX + first.bounds.maxX) / 2,
        y: (first.bounds.minY + first.bounds.maxY) / 2,
      }
    : { x: 0, y: 0 };
  const facts = contextFactsFrom(crs, converter, probe, boundsFinite);
  const decision = decideContextEligibility(facts);
  if (!decision.eligible) {
    return { consent, eligible: false, reasons: decision.reasons, footprints: [] };
  }

  const transform = lonLatTransformFrom(converter, crs as ResolvedCrs);
  const footprints: ContextFootprint[] = [];
  for (const layer of layers) {
    const b = layer.bounds;
    if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) continue;
    const built = buildContextFootprint(layer.id, layer.name, b, transform);
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
