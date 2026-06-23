/**
 * loadFileWarning.test.ts
 *
 * Integration net for the large non-LAS pre-decode warning. The pure flag is
 * pinned in loadPlanNonLas.test.ts, but that flag is computed inside
 * `planLoad`, which the preflight only calls for LAS/LAZ. This test drives the
 * REAL path — `fileMetadata` → preflight → `buildSourceMetadata` →
 * `buildPreloadSummary` — for a non-LAS format, so a regression that drops the
 * warning before it reaches the user is caught here, not just in a unit of a
 * function the production path never calls.
 */

import { describe, it, expect } from 'vitest';
import { fileMetadata } from '../src/io/loadFile';
import { buildPreloadSummary } from '../src/io/preloadSummary';
import { LARGE_NON_LAS_THRESHOLD_BYTES, LARGE_STATIC_LAS_THRESHOLD_BYTES } from '../src/io/loadPlan';

/** A minimal File stand-in: only `name`, `size`, and a head `slice()` are read
 *  by the preflight, so we never allocate the pretend gigabytes. */
function fakeFile(name: string, size: number, head: string): File {
  const headBytes = new TextEncoder().encode(head);
  return {
    name,
    size,
    slice: () => ({
      arrayBuffer: async () =>
        headBytes.buffer.slice(0, headBytes.byteLength),
    }),
  } as unknown as File;
}

const PLY_HEADER = 'ply\nformat ascii 1.0\nelement vertex 1\n';
// 'LASF' magic sniffs as LAS; the rest of the header is unreadable, so there's
// no load plan — but the size-based caution fires independently of the plan.
const LAS_HEAD = 'LASF' + '\0'.repeat(60);

describe('large non-LAS pre-decode warning reaches the preload summary', () => {
  it('warns for a large PLY and the warning is in the summary the user sees', async () => {
    const big = fakeFile('huge.ply', LARGE_NON_LAS_THRESHOLD_BYTES + 1, PLY_HEADER);
    const meta = await fileMetadata(big);
    expect(meta.warning).toBeDefined();
    expect(meta.warning).toMatch(/memory|RAM|spike/i);
    // The integration point that used to drop the flag: it must appear in the
    // pre-decode lines the UI renders.
    const summary = buildPreloadSummary(meta);
    expect(summary.some((l) => /⚠/.test(l) && /memory|RAM|spike/i.test(l))).toBe(true);
  });

  it('does NOT warn for a small PLY (no false alarm on normal files)', async () => {
    const small = fakeFile('small.ply', 5 * 1024 * 1024, PLY_HEADER);
    const meta = await fileMetadata(small);
    expect(meta.warning).toBeUndefined();
    expect(buildPreloadSummary(meta).some((l) => /⚠/.test(l))).toBe(false);
  });
});

describe('large static LAS/LAZ memory caution', () => {
  it('warns a multi-GB LAS is read fully into memory and points to COPC/EPT', async () => {
    const big = fakeFile('huge.las', LARGE_STATIC_LAS_THRESHOLD_BYTES + 1, LAS_HEAD);
    const meta = await fileMetadata(big);
    expect(meta.warning).toBeDefined();
    expect(meta.warning).toMatch(/COPC|EPT/i);
    expect(buildPreloadSummary(meta).some((l) => /⚠/.test(l))).toBe(true);
  });

  it('does NOT warn for a routine-size LAS tile', async () => {
    const tile = fakeFile('tile.las', 200 * 1024 * 1024, LAS_HEAD);
    const meta = await fileMetadata(tile);
    expect(meta.warning).toBeUndefined();
  });
});
