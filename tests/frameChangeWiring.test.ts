/**
 * frameChangeWiring.test.ts — the destructive frame-change cascade runs on a
 * frame CHANGE, not on every CRS broadcast.
 *
 * CrsService broadcasts on every resolution. The cascade (cancel the grade,
 * invalidate every derived classification, drop the terrain cache) used to be
 * the subscriber body, so an additive second-layer open re-resolving the same
 * CRS ran it against the first layer. The per-broadcast work still runs every
 * time; the cascade is gated on the revision.
 */

import { describe, it, expect, vi } from 'vitest';
import { wireFrameChange } from '../src/app/classLegendRefresh';

function service(revisions: number[]) {
  let fn: ((r: null) => void) | null = null;
  let i = 0;
  return {
    subscribe: (f: (r: null) => void) => { fn = f; },
    crsRevision: () => revisions[Math.min(i, revisions.length - 1)],
    /** Simulate one broadcast at the next scripted revision. */
    fire: () => { i++; fn?.(null); },
  };
}

describe('wireFrameChange', () => {
  it('runs the per-broadcast work every time and the cascade only on a new revision', () => {
    const svc = service([1, 1, 1, 2, 2]); // initial 1; broadcasts at 1, 1, 2, 2
    const onResolved = vi.fn();
    const cancel = vi.fn();
    const invalidate = vi.fn(() => []);
    const clear = vi.fn();
    wireFrameChange({
      crsService: svc, onResolved, cancelFullCloudGrade: cancel, invalidate,
      clearTerrainCache: clear, noteStale: () => {},
    });
    svc.fire(); // rev 1 == seen: same frame re-resolved (second tile of one survey)
    svc.fire(); // rev 1 again
    expect(onResolved).toHaveBeenCalledTimes(2);
    expect(cancel, 'the cascade ran for a frame that had not moved').not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();

    svc.fire(); // rev 2: the frame changed
    expect(cancel).toHaveBeenCalledTimes(1);
    // invalidate/clear are noteDerivedClassesFrameChanged's decision (it acts
    // only when a derived cloud exists); that helper has its own tests. The
    // unit here is the GATE, which `cancel` witnesses.

    svc.fire(); // rev 2 again: the SAME new frame, no second cascade
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
