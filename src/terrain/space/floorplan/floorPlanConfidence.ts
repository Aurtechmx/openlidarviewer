/**
 * floorPlanConfidence.ts
 *
 * A small, claim-accurate presentation summary derived from a built
 * {@link FloorPlanModel}. The floor plan ships as an experimental PREVIEW, so
 * the user needs a one-glance read on how much to trust it. Every figure here
 * is already computed by the extractor — this module only buckets and labels
 * it, never re-measures.
 *
 * Honesty rules baked in:
 *   - Rooms are only counted when the segmentation actually partitioned the
 *     floor into rooms; an open or unsegmented floor never reports "N rooms".
 *   - "Openings" are the CLASSIFIED doorways (square jamb evidence), never the
 *     ragged/unknown gaps the sheet draws dashed.
 *   - "Weak wall evidence" is the share of wall rings whose observed (pre-close)
 *     outline fell below the gap-closing threshold — a boundary-sample
 *     statistic, not a survey confidence figure.
 *
 * Pure: no DOM, no three.js, no I/O — unit-testable in Node.
 */

import type { FloorPlanModel } from './extractFloorPlan';
import { OBSERVED_FRAC_MIN } from './extractFloorPlan';

/** Overall trust bucket for the preview. */
export type FloorPlanConfidenceBand = 'low' | 'moderate' | 'good';

/** Presentation-ready floor-plan confidence summary. */
export interface FloorPlanConfidence {
  /** Overall trust band, driven by the weak-wall-evidence share. */
  readonly band: FloorPlanConfidenceBand;
  /** Title-case label for {@link band} ("Good" / "Moderate" / "Low"). */
  readonly bandLabel: string;
  /**
   * Rooms label: the count as a string when the floor segmented into rooms;
   * "open space" for a single connected region; "—" when it could not be
   * partitioned. `count` is the numeric room count only in the 'rooms' case.
   */
  readonly roomsLabel: string;
  readonly roomCount: number | null;
  /** Wall rings traced. */
  readonly walls: number;
  /** Classified doorway openings (never the dashed unknown gaps). */
  readonly openings: number;
  /** Percent of wall rings whose observed outline fell below the threshold. */
  readonly weakWallPct: number;
}

function bandLabel(b: FloorPlanConfidenceBand): string {
  return b === 'good' ? 'Good' : b === 'moderate' ? 'Moderate' : 'Low';
}

/** Derive the presentation summary from a built floor-plan model. */
export function floorPlanConfidence(model: FloorPlanModel): FloorPlanConfidence {
  const walls = model.wallRings.length;
  const weakCount = model.wallRingObservedFrac.filter((f) => f < OBSERVED_FRAC_MIN).length;
  const weakWallPct = walls > 0 ? Math.round((100 * weakCount) / walls) : 100;

  // Trust band from the weak-wall share; no walls at all ⇒ low.
  const band: FloorPlanConfidenceBand =
    walls === 0 ? 'low' : weakWallPct <= 20 ? 'good' : weakWallPct <= 50 ? 'moderate' : 'low';

  let roomsLabel: string;
  let roomCount: number | null;
  if (model.roomSegmentation === 'rooms') {
    roomCount = model.rooms.length;
    roomsLabel = String(roomCount);
  } else if (model.roomSegmentation === 'open-space') {
    roomCount = null;
    roomsLabel = 'open space';
  } else {
    roomCount = null;
    roomsLabel = '—';
  }

  return {
    band,
    bandLabel: bandLabel(band),
    roomsLabel,
    roomCount,
    walls,
    openings: model.doorways.length,
    weakWallPct,
  };
}
