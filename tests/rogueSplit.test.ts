/**
 * rogueSplit.test.ts — invariants of the retrospective Rogue dev/holdout split.
 *
 * Rogue is a retrospective hardening set and never becomes E5; the split only has
 * to be honest and reproducible. These checks pin the properties a reader relies
 * on: exposure is read from the immutable ledger (not a live git scan), an exposed
 * tile (used before the split was frozen) is never in the holdout, the holdout is
 * entirely unexposed, the split covers exactly the input tiles, the assignment is
 * reproducible from manifest + exposure ledger + salt using code-unit ordering,
 * and the recorded splitDigest is the digest of the exposure set and assignment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const read = (p: string) => JSON.parse(readText(p));
const split = read('validation/e5/splits/ROGUE25.split.json') as {
  policy: { targetDevelopment: number; salt: string };
  inputCollectionDigest: string;
  exposureDigest: string;
  splitDigest: string;
  summary: { total: number; development: number; holdout: number; exposedForcedToDevelopment: string[] };
  tiles: { tileId: string; basename: string; sha256: string; exposed: boolean; set: 'development' | 'holdout' }[];
};
const input = read('validation/e5/manifests/ROGUE25.input.json') as {
  collectionDigest: string;
  tiles: { basename: string; sha256: string }[];
};
const exposureText = readText('validation/e5/splits/ROGUE25.exposure.json');
const exposure = JSON.parse(exposureText) as {
  schemaVersion: number;
  collectionDigest: string;
  exposed: { tileId: string; reason: string; evidence: string }[];
};
const builderSrc = readText('scripts/e5/build-rogue-split.mjs');

const SALT = 'ROGUE-E5-HARDENING-v1';
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const tileId = (basename: string) => (basename.match(/10T[A-Z]{2}\d+/) ?? [basename])[0];

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

  it('reads exposure from the immutable ledger, not a live git scan', () => {
    // The reproducibility bug this guards: exposure was discovered at build time
    // via git ls-files + git grep, so a later doc mentioning a tile changed the
    // split. Exposure must now come only from the pinned ledger.
    expect(builderSrc).not.toMatch(/child_process/);
    expect(builderSrc).not.toMatch(/execFileSync/);
    expect(builderSrc).not.toMatch(/ls-files|git grep/);
    expect(builderSrc).toMatch(/ROGUE25\.exposure\.json/);
  });

  it('orders by code unit, never by locale collation', () => {
    // localeCompare's ICU collation differs across machines and would make the
    // hashed ordering non-reproducible.
    expect(builderSrc).not.toMatch(/\.localeCompare\(/);
  });

  it('the exposure ledger is pinned to the same collection', () => {
    expect(exposure.collectionDigest).toBe(input.collectionDigest);
    expect(exposure.exposed.length).toBeGreaterThan(0);
    for (const e of exposure.exposed) {
      expect(e.tileId).toMatch(/^10T[A-Z]{2}\d+$/);
      expect(e.reason.length).toBeGreaterThan(0);
      expect(e.evidence.length).toBeGreaterThan(0);
    }
  });

  it('records exactly the ledger exposed set as exposed and forced to development', () => {
    const ledgerIds = exposure.exposed.map((e) => e.tileId).sort(byCodeUnit);
    expect([...split.summary.exposedForcedToDevelopment].sort(byCodeUnit)).toEqual(ledgerIds);
    const exposedInSplit = split.tiles.filter((t) => t.exposed).map((t) => t.tileId).sort(byCodeUnit);
    expect(exposedInSplit).toEqual(ledgerIds);
    for (const id of ledgerIds) {
      const t = split.tiles.find((x) => x.tileId === id)!;
      expect(t.exposed).toBe(true);
      expect(t.set).toBe('development');
    }
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

  it('reproduces the exact membership from manifest + exposure ledger + salt', () => {
    // Re-derive the assignment independently of the committed split, mirroring the
    // builder: exposed (from ledger) → development; unexposed ordered by
    // sha256(salt + fileSha256) compared by code unit, filled to the target.
    const exposedIds = new Set(exposure.exposed.map((e) => e.tileId));
    const tiles = input.tiles.map((t) => ({
      tileId: tileId(t.basename),
      exposed: exposedIds.has(tileId(t.basename)),
      orderKey: createHash('sha256').update(SALT + t.sha256).digest('hex'),
    }));
    const exposed = tiles.filter((t) => t.exposed);
    const unexposed = tiles.filter((t) => !t.exposed).sort((a, b) => byCodeUnit(a.orderKey, b.orderKey));
    const devFromUnexposed = Math.max(0, split.policy.targetDevelopment - exposed.length);
    const derived = new Map<string, 'development' | 'holdout'>();
    for (const t of exposed) derived.set(t.tileId, 'development');
    unexposed.forEach((t, i) => derived.set(t.tileId, i < devFromUnexposed ? 'development' : 'holdout'));
    for (const t of split.tiles) {
      expect(derived.get(t.tileId), `${t.tileId} set mismatch`).toBe(t.set);
    }
  });

  it('the recorded splitDigest folds in the exposure digest and the assignment', () => {
    const exposureDigest = createHash('sha256').update(exposureText).digest('hex');
    expect(split.exposureDigest).toBe(exposureDigest);
    const assignment = [...split.tiles]
      .sort((a, b) => byCodeUnit(a.tileId, b.tileId))
      .map((t) => `${t.tileId}:${t.set}`)
      .join('\n');
    const recomputed = createHash('sha256').update(`${exposureDigest}\n${assignment}`).digest('hex');
    expect(recomputed).toBe(split.splitDigest);
  });
});
