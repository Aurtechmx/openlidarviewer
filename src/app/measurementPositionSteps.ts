/**
 * measurementPositionSteps.ts: the step a measurement's positions are held at,
 * read from the layer(s) it was taken on.
 *
 * A measurement names its layers (`pickLayers`, else its owner). Each layer's
 * buffer holds the points less that layer's placement offset, so the step is
 * read there; a measurement spanning layers is held at the coarser of them. A
 * measurement that names no open layer is read with no offset, as an unplaced
 * scan holds it. The active layer never stands in for the owner.
 */
import type { Measurement } from '../render/measure/types';
import { coarserSteps, positionSteps, type AxisSteps } from '../render/measure/geometry';

/** An open layer as the step read needs it. */
export interface StepLayer {
  readonly stableId: string | null;
  readonly projectOffset: readonly [number, number, number] | null;
}

/** A resolver from a measurement to the step its positions are held at. */
export function positionStepsResolver(layers: readonly StepLayer[]): (m: Measurement) => AxisSteps | null {
  return (m) => {
    const ids = m.pickLayers && m.pickLayers.length > 0 ? m.pickLayers : m.owner?.layerId ? [m.owner.layerId] : [];
    const own = layers.filter((l) => l.stableId !== null && ids.includes(l.stableId));
    if (own.length === 0) return positionSteps(m.points, null);
    let steps: AxisSteps | null = null;
    for (const l of own) {
      const s = positionSteps(m.points, l.projectOffset ? [l.projectOffset[0], l.projectOffset[1], l.projectOffset[2]] : null);
      if (!s) return null;
      steps = coarserSteps(steps, s);
    }
    return steps;
  };
}

/**
 * A resolver for measurements that all belong to the active scan, as the report
 * and the site file write: the step is read at that scan's placement offset.
 */
export function activeScanPositionSteps(
  offset: readonly [number, number, number] | null,
): (m: Measurement) => AxisSteps | null {
  const o: [number, number, number] | null = offset ? [offset[0], offset[1], offset[2]] : null;
  return (m) => positionSteps(m.points, o);
}
