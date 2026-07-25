/**
 * measureConfidence.ts — what kind of number a displayed measurement is.
 *
 * "Distance 12.384 m" on screen reads as a bare fact, and a screenshot of it
 * can imply a certified survey figure the viewer never produced. This module
 * turns the facts the measure subsystem already tracks — did the scene resolve
 * a shared datum (`Viewer._refreshMeasureDatum`'s origin, null on conflicting
 * frames), what the mounted layers have proven about their frames
 * (`layerCompatibility.ts`), and whether the vertical reference is known —
 * into a context state every displayed value carries.
 *
 * Fail-closed: `verified` requires every fact to be positively established;
 * anything unproven demotes to `approximate`, and an incomparable layer set
 * refuses outright (`unavailable`), because a number computed across unrelated
 * frames is not a weak result — it is a meaningless one that looks like one.
 *
 * Pure data in, pure data out: no DOM, no three.js, no Viewer — the caller
 * gathers the booleans, this turns them into a state. The wording is part of
 * the contract: no label or reason may ever certify ("accurate", "survey",
 * "certified", "precise" are banned and pinned by test), because the honest
 * claim is only ever "a viewer measurement", never a credential.
 */

import type { LayerCompatibility } from '../../model/layerCompatibility';
import type { MeasurementKind } from './types';

/**
 * How the mounted layer set relates to the project frame, collapsed to the
 * four cases the confidence rule distinguishes:
 *   - `single`       — one layer (or none): it IS the frame.
 *   - `all-verified` — every layer proved the shared horizontal AND vertical
 *                      reference (`layerCompatibility` unanimity).
 *   - `mixed`        — at least one layer is unproven (`unknown` /
 *                      `horizontal-only`): the combined context exists but is
 *                      not established.
 *   - `incomparable` — a layer is in a PROVEN different frame: no combined
 *                      figure has a defined meaning.
 */
export type MeasureLayerContext = 'single' | 'all-verified' | 'mixed' | 'incomparable';

/** The scene-level facts, identical for every measurement in the scene. */
export interface MeasureSceneContext {
  /**
   * True when the scene resolved a shared origin datum — the Viewer's measure
   * datum (`_refreshMeasureDatum`) produced a non-null origin. Null/false is
   * the scene REFUSING a datum: clouds recentred on conflicting origins share
   * no frame, so coordinates are scene-local.
   */
  readonly datumResolved: boolean;
  /** What the mounted layer set has proven — see {@link MeasureLayerContext}. */
  readonly layers: MeasureLayerContext;
  /** True when the vertical reference (datum) is positively known. */
  readonly verticalReferenceKnown: boolean;
}

/** The per-measurement input: the scene facts plus the kind's height dependency. */
export interface MeasureConfidenceContext extends MeasureSceneContext {
  /** True when this measurement's NUMBER depends on the vertical axis. */
  readonly dependsOnHeight: boolean;
}

/**
 * The fail-closed default a display surface uses until the host feeds the real
 * scene facts: datum unresolved, nothing proven. A panel that never receives a
 * context renders "approximate — shared datum unresolved", never "verified".
 */
export const UNRESOLVED_SCENE_CONTEXT: MeasureSceneContext = {
  datumResolved: false,
  layers: 'single',
  verticalReferenceKnown: false,
};

/** A measurement's context state — verified / approximate / unavailable. */
export type MeasureConfidence =
  | { level: 'verified'; label: string }
  | { level: 'approximate'; label: string; reason: string }
  | { level: 'unavailable'; label: string; reason: string };

/**
 * Derive the context state for one measurement. Fail-closed: `verified` only
 * when the datum resolved AND the layer set is single or all-verified AND no
 * height caveat applies; an incomparable layer set beats every other rule.
 */
export function measureConfidence(ctx: MeasureConfidenceContext): MeasureConfidence {
  // A proven-different frame refuses before any other fact is consulted — a
  // combined figure over incomparable frames has no meaning to caveat.
  if (ctx.layers === 'incomparable') {
    return {
      level: 'unavailable',
      label: 'No shared basis',
      reason: 'layers are in incomparable frames — a combined figure has no defined meaning',
    };
  }

  const reasons: string[] = [];
  if (!ctx.datumResolved) {
    reasons.push('shared datum unresolved — coordinates are scene-local');
  }
  if (ctx.layers === 'mixed') {
    reasons.push('layer frames are not all verified — the combined context is unproven');
  }
  if (ctx.dependsOnHeight && !ctx.verticalReferenceKnown) {
    reasons.push('vertical reference unknown');
  }
  if (reasons.length > 0) {
    return {
      level: 'approximate',
      label: 'Viewer measurement · approximate',
      reason: reasons.join('; '),
    };
  }

  return { level: 'verified', label: 'Viewer measurement · datum resolved' };
}

/**
 * The kinds whose displayed NUMBER depends on the vertical reference — a pure
 * height and a cut/fill volume are meaningless without one. Horizontal kinds
 * (distance, area, …) survive an unknown vertical datum unchanged.
 */
const HEIGHT_DEPENDENT_KINDS: ReadonlySet<MeasurementKind> = new Set(['height', 'volume']);

/** Convenience: derive a kind's confidence from the scene-level facts. */
export function confidenceForKind(
  kind: MeasurementKind,
  scene: MeasureSceneContext,
): MeasureConfidence {
  return measureConfidence({ ...scene, dependsOnHeight: HEIGHT_DEPENDENT_KINDS.has(kind) });
}

/**
 * Collapse per-layer compatibility states (`classifyLayerCompatibility`) into
 * the layer-context enum. Zero or one layer is `single` (a lone layer IS the
 * frame — the classifier's own rule); any proven-different member makes the
 * whole set `incomparable`; any unproven member makes it `mixed`.
 */
export function layerContextOf(
  states: readonly LayerCompatibility[],
): MeasureLayerContext {
  if (states.length <= 1) return 'single';
  if (states.includes('incompatible')) return 'incomparable';
  return states.every((s) => s === 'verified') ? 'all-verified' : 'mixed';
}
