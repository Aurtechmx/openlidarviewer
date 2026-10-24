/**
 * flowParticlesRainfall.test.ts — particles over a peak-flow channel field.
 *
 * With a rainfall estimate the caller hands the particles the cells whose
 * peak flow reaches the display threshold and a strength on a log scale of
 * that flow. Pinned: spawns land only on those cells, stronger channels draw
 * more of them, brightness follows the strength, and speed still follows the
 * upstream count, a display encoding that the strength does not change.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SPEED_CELLS_PER_S, cellStrength, channelCellCount, isChannelCell, particleSpeed, spawnCells,
} from '../src/ui/fieldSimulation/flowParticles';
import { logScale } from '../src/render/flowOverlayGeometry';

// A 5 x 1 strip draining east; cell 4 is the outlet.
const base = {
  cols: 5, rows: 1,
  receiver: Int32Array.from([1, 2, 3, 4, -1]),
  upstreamCells: Uint32Array.from([1, 2, 3, 4, 5]),
  maxUpstream: 5,
};
const field = {
  ...base,
  channel: Uint8Array.from([0, 1, 1, 1, 1]),
  strength: Float32Array.from([0, 0, 0.5, 1, 1]),
};

describe('particles on a peak-flow field', () => {
  it('spawn only on channel cells with a receiver, weighted towards the stronger ones', () => {
    const cells = Array.from(spawnCells(field));
    expect(cells).not.toContain(0);
    expect(cells).not.toContain(4); // no receiver
    const count = (c: number) => cells.filter((x) => x === c).length;
    expect(count(1)).toBe(1); // strength 0: one entry
    expect(count(2)).toBe(3); // 1 + round(3 × 0.5)
    expect(count(3)).toBe(4); // 1 + 3
    expect(channelCellCount(field)).toBe(3);
  });

  it('take brightness from the strength, and speed still from the upstream count', () => {
    expect(cellStrength(field, 3)).toBe(1);
    expect(cellStrength(field, 2)).toBe(0.5);
    expect(isChannelCell(field, 0)).toBe(false);
    for (const i of [1, 2, 3]) {
      expect(particleSpeed(field, i)).toBe(particleSpeed(base, i));
      expect(particleSpeed(field, i)).toBeCloseTo(MAX_SPEED_CELLS_PER_S * logScale(base.upstreamCells[i]!, 5), 12);
    }
  });

  it('without a field, fall back to the log-scaled count threshold', () => {
    expect(isChannelCell(base, 0)).toBe(logScale(1, 5) >= 0.4);
    expect(Array.from(spawnCells(base))).toEqual(Array.from(new Set(spawnCells(base))));
  });
});
