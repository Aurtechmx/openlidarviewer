/**
 * pdfInfoDateDeterminism.test.ts — PDF bytes must not move with the clock.
 *
 * The bug this pins down was intermittent by nature: pdf-lib stamps
 * CreationDate and ModDate from the wall clock at `create()`, so two builds
 * only diverged when they happened to straddle a second boundary. A test that
 * simply builds twice therefore passes most of the time and fails in CI,
 * which is how it survived. Advancing the clock between the two builds turns
 * that race into a deterministic check.
 *
 * Every builder here is expected to be a pure function of its input. If one
 * gains a new clock read, this fails every run rather than one run in five.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildProfilePdf } from '../src/render/measure/profilePdf';

afterEach(() => { vi.useRealTimers(); });

/** Build once, jump the clock a full second, build again. */
async function buildAcrossASecondBoundary(build: () => Promise<Uint8Array>) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.900Z'));
  const first = Buffer.from(await build());
  vi.setSystemTime(new Date('2026-01-01T00:00:01.900Z'));
  const second = Buffer.from(await build());
  return { first, second };
}

describe('PDF builders do not read the clock', () => {
  it('buildProfilePdf is byte-identical across a second boundary', async () => {
    const input = {
      name: 'Deterministic',
      samples: Array.from({ length: 24 }, (_, i) => ({
        distanceM: i, elevationM: i * 0.5, groundElevationM: i * 0.4, count: 3,
      })),
      corridorWidthM: 4,
      groundPercentile: 25,
      crs: 'EPSG:32611',
      verticalDatum: 'NAVD88',
      generatedAt: new Date('2026-02-03T04:05:06Z'),
    } as never;
    const { first, second } = await buildAcrossASecondBoundary(() => buildProfilePdf(input));
    expect(second.equals(first)).toBe(true);
  });

});
