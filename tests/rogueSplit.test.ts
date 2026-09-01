/**
 * rogueSplit.test.ts — invariants of the retrospective Rogue dev/holdout split.
 *
 * Rogue is a retrospective hardening set and never becomes E5; the split only has
 * to be honest and reproducible. These checks pin the properties a reader relies
 * on: an exposed tile (already used anywhere in the repo) is never in the holdout,
 * the holdout is entirely unexposed, the split covers exactly the input tiles, and
 * the recorded splitDigest is the digest of the recorded assignment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));
const split = read('validation/e5/splits/ROGUE25.split.json') as {
  policy: { targetDevelopment: number };
  inputCollectionDigest: string;
  splitDigest: string;
  summary: { total: number; development: number; holdout: number; exposedForcedToDevelopment: string[] };
  tiles: { tileId: string; sha256: string; exposed: boolean; set: 'development' | 'holdout' }[];
};
const input = read('validation/e5/manifests/ROGUE25.input.json') as {
  collectionDigest: string;
  tiles: { sha256: string }[];
};

describe('rogue dev/holdout split', () => {
  it('covers exactly the 25 input tiles (sha256 set equality)', () => {
    expect(split.tiles).toHaveLength(input.tiles.length);
    const a = split.tiles.map((t) => t.sha256).sort();
    const b = input.tiles.map((t) => t.sha256).sort();
    expect(a).toEqual(b);
  });

  it('is tied to the input collection it was built from', () => {
    expect(split.inputCollectionDigest).toBe(input.collectionDigest);
  });

  it('no exposed tile is in the holdout (the honesty invariant)', () => {
    const leaked = split.tiles.filter((t) => t.exposed && t.set === 'holdout');
    expect(leaked, `exposed tiles leaked into holdout: ${leaked.map((t) => t.tileId).join(', ')}`).toEqual([]);
  });

  it('the holdout is entirely unexposed', () => {
    for (const t of split.tiles.filter((t) => t.set === 'holdout')) {
      expect(t.exposed, `${t.tileId} in holdout must be unexposed`).toBe(false);
    }
  });

  it('development meets the target and the counts are consistent', () => {
    expect(split.summary.development).toBe(split.tiles.filter((t) => t.set === 'development').length);
    expect(split.summary.holdout).toBe(split.tiles.filter((t) => t.set === 'holdout').length);
    expect(split.summary.development + split.summary.holdout).toBe(split.summary.total);
    expect(split.summary.development).toBe(split.policy.targetDevelopment);
  });

  it('every recorded exposed-forced tile is exposed and in development', () => {
    for (const id of split.summary.exposedForcedToDevelopment) {
      const t = split.tiles.find((x) => x.tileId === id)!;
      expect(t.exposed).toBe(true);
      expect(t.set).toBe('development');
    }
  });

  it('the recorded splitDigest is the digest of the recorded assignment', () => {
    const recomputed = createHash('sha256')
      .update([...split.tiles].sort((a, b) => a.tileId.localeCompare(b.tileId)).map((t) => `${t.tileId}:${t.set}`).join('\n'))
      .digest('hex');
    expect(recomputed).toBe(split.splitDigest);
  });
});
