/**
 * heavyLasCacheBudget.test.ts — the reopen cache keeps at most 2 GiB of tile data.
 */
import { describe, it, expect } from 'vitest';
import { OOC_CACHE_BUDGET_BYTES } from '../src/app/heavyLasExecutor';

describe('reopen cache budget', () => {
  it('caps the reopen cache at 2 GiB', () => {
    expect(OOC_CACHE_BUDGET_BYTES).toBe(2 * 1024 ** 3);
  });
});
