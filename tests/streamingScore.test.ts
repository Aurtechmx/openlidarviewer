/**
 * streamingScore.test.ts — the node priority score. Guards the budget selector
 * against a degenerate / non-finite node box: a NaN projected size must score 0
 * (rejected), not slip through `NaN <= 0` being false.
 */

import { describe, it, expect } from 'vitest';
import { nodeScore } from '../src/render/streaming/streamingScore';
import type { Box6 } from '../src/io/copc/copcTypes';

const cam: readonly [number, number, number] = [0, 0, 0];

describe('nodeScore', () => {
  it('rejects a node whose box yields a non-finite projected size', () => {
    const badBox: Box6 = [NaN, 0, 0, 1, 1, 1];
    expect(nodeScore({ bounds: badBox, depth: 0, depthCap: 10, cameraPos: cam })).toBe(0);
  });

  it('scores a valid node above zero', () => {
    const box: Box6 = [0, 0, 0, 1, 1, 1];
    expect(nodeScore({ bounds: box, depth: 0, depthCap: 10, cameraPos: cam })).toBeGreaterThan(0);
  });

  it('still rejects nodes deeper than the depth cap', () => {
    const box: Box6 = [0, 0, 0, 1, 1, 1];
    expect(nodeScore({ bounds: box, depth: 11, depthCap: 10, cameraPos: cam })).toBe(0);
  });
});
