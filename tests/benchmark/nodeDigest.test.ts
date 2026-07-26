/**
 * nodeDigest.test.ts — which digest actually ran.
 *
 * The two real implementations agree bit for bit, which is the guarantee but
 * also the reason no ordinary assertion can tell them apart: a downgrade to the
 * 20x-slower portable path produces the identical hash and surfaces nothing.
 * So this file mocks `node:crypto` to return a sentinel, making the choice
 * observable, and pins it. Kept separate from `runtime.test.ts` because the
 * mock is file-wide and the agreement tests there need the real digest.
 */
import { describe, test, expect, vi } from 'vitest';

const SENTINEL = '1'.repeat(64);

vi.mock('node:crypto', () => ({
  createHash: () => ({ update: () => ({ digest: () => SENTINEL }) }),
}));

const { hashArtifactNode, nodeSha256Hex } = await import('../../benchmarks/framework/node');

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('the Node digest is the one that runs', () => {
  test('the mock is wired, so the sentinel really does mean node:crypto', () => {
    expect(nodeSha256Hex(BYTES)).toBe(SENTINEL);
  });

  test('hashArtifactNode uses it when no options are passed', () => {
    expect(hashArtifactNode('raster', BYTES).hash).toBe(SENTINEL);
  });

  test('an options bag with an ABSENT digest still uses it', () => {
    expect(hashArtifactNode('raster', BYTES, {}).hash).toBe(SENTINEL);
  });

  test('an options bag with an EXPLICIT undefined digest still uses it', () => {
    // `{ digest: nodeSha256Hex, ...options }` let an undefined field clobber the
    // default, so `hashArtifactNode(name, value, { digest: opts.digest })` with
    // an optional field — ordinary code — silently fell back to the portable
    // implementation: same hash, 20x the time, nothing to see in the report.
    expect(hashArtifactNode('raster', BYTES, { digest: undefined }).hash).toBe(SENTINEL);
  });

  test('an explicit digest still wins', () => {
    const other = '2'.repeat(64);
    expect(hashArtifactNode('raster', BYTES, { digest: () => other }).hash).toBe(other);
  });

  test('the JSON path takes the same digest', () => {
    expect(hashArtifactNode('metrics', { n: 1 }, { digest: undefined }).hash).toBe(SENTINEL);
  });
});
