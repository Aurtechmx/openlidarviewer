/**
 * streamingDepthNeutral.test.ts — the scheduler refines on a depth number, not
 * on an octree voxel key.
 *
 * The refinement throttle (velocity depth cap, pressure reduction) used to read
 * `record.key.depth`. That tied the policy to a key only an octree-organised
 * source can produce, and 3D Tiles refines on geometric error over a tree that
 * is not an octree. The depth now travels on the record itself.
 *
 * These cases pin the decoupling rather than the throttle's arithmetic, which
 * streamingScheduler.test.ts already covers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('the scheduler does not read a voxel key', () => {
  it('reaches for no key field at all', () => {
    const src = read('src/render/streaming/StreamingScheduler.ts');
    expect(
      src.includes('record.key'),
      'the scheduler read a voxel key, which a source that is not an octree ' +
        'cannot supply. Use record.depth.',
    ).toBe(false);
  });

  it('states the depth it refines on', () => {
    expect(read('src/render/streaming/StreamingScheduler.ts')).toContain('record.depth');
  });
});

describe('every source states its own depth', () => {
  it.each([
    ['src/io/copc/copcHierarchy.ts', 'COPC hierarchy'],
    ['src/render/streaming/EptOctree.ts', 'EPT octree'],
    ['src/io/heavy/OlvTileSource.ts', 'out-of-core tile store'],
  ])('%s sets depth on the records it builds', (path) => {
    expect(read(path)).toContain('depth:');
  });
});
