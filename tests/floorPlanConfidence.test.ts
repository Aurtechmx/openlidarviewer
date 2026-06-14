/**
 * floorPlanConfidence.test.ts
 *
 * The floor-plan preview's one-glance trust summary buckets figures the
 * extractor already produced. These tests pin the honesty rules: rooms only
 * when segmented, openings = classified doorways, weak-wall % from the observed
 * fraction vs OBSERVED_FRAC_MIN, and the band thresholds.
 */

import { describe, it, expect } from 'vitest';
import { floorPlanConfidence } from '../src/terrain/space/floorplan/floorPlanConfidence';
import { OBSERVED_FRAC_MIN } from '../src/terrain/space/floorplan/extractFloorPlan';
import type { FloorPlanModel } from '../src/terrain/space/floorplan/extractFloorPlan';

/** Minimal model carrying only the fields the summary reads. */
function model(p: {
  observed: number[];
  rooms?: number;
  segmentation?: FloorPlanModel['roomSegmentation'];
  doorways?: number;
}): FloorPlanModel {
  return {
    wallRings: p.observed.map(() => ({})),
    wallRingObservedFrac: p.observed,
    rooms: Array.from({ length: p.rooms ?? 0 }, () => ({})),
    roomSegmentation: p.segmentation ?? 'rooms',
    doorways: Array.from({ length: p.doorways ?? 0 }, () => ({})),
  } as unknown as FloorPlanModel;
}

const STRONG = OBSERVED_FRAC_MIN + 0.2; // above the gap-closing threshold
const WEAK = OBSERVED_FRAC_MIN - 0.2; // below it (mostly interpolated)

describe('floorPlanConfidence', () => {
  it('counts walls, openings and the weak-wall share', () => {
    const c = floorPlanConfidence(
      model({ observed: [STRONG, STRONG, WEAK, WEAK, STRONG], doorways: 3 }),
    );
    expect(c.walls).toBe(5);
    expect(c.openings).toBe(3);
    expect(c.weakWallPct).toBe(40); // 2 of 5 below the threshold
  });

  it('bands by weak-wall share: good ≤20%, moderate ≤50%, else low', () => {
    expect(floorPlanConfidence(model({ observed: [STRONG, STRONG, STRONG, STRONG, STRONG] })).band).toBe('good');
    expect(floorPlanConfidence(model({ observed: [STRONG, STRONG, WEAK] })).band).toBe('moderate'); // 33%
    expect(floorPlanConfidence(model({ observed: [WEAK, WEAK, WEAK, STRONG] })).band).toBe('low'); // 75%
  });

  it('reports a room count ONLY when the floor segmented into rooms', () => {
    expect(floorPlanConfidence(model({ observed: [STRONG], rooms: 6, segmentation: 'rooms' })).roomsLabel).toBe('6');
    const open = floorPlanConfidence(model({ observed: [STRONG], segmentation: 'open-space' }));
    expect(open.roomsLabel).toBe('open space');
    expect(open.roomCount).toBeNull();
    expect(floorPlanConfidence(model({ observed: [STRONG], segmentation: 'unsegmented' })).roomsLabel).toBe('—');
  });

  it('reads low with a 100% weak share when there are no walls at all', () => {
    const c = floorPlanConfidence(model({ observed: [] }));
    expect(c.walls).toBe(0);
    expect(c.weakWallPct).toBe(100);
    expect(c.band).toBe('low');
  });

  it('exposes a title-case band label', () => {
    expect(floorPlanConfidence(model({ observed: [STRONG] })).bandLabel).toBe('Good');
  });
});
