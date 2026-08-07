/**
 * tests/decodePoolSize.test.ts
 *
 * The decode worker pool-size policy. Pure function, so every band, cap and
 * degenerate input is pinned here rather than discovered on a user's machine.
 *
 * The contract under test:
 *   - the core bands (1-2 → 1, 3-4 → 2, 5-8 → 3, 9+ → 4);
 *   - a hard cap of 4 that nothing — device, flag or override — can exceed;
 *   - an unreadable `hardwareConcurrency` degrades conservatively, never to 0
 *     and never to the cap;
 *   - phone-class devices stay at or below the scheduler's mobile concurrency;
 *   - the result is always at least 1, so the pool can always decode;
 *   - and the opt-in rule: pooling is OFF by default, so the size a client
 *     actually builds with no flag set is 1 — the pre-pool single worker.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeWorkerPoolSize,
  resolveDecodePoolSize,
  readDecodePoolEnvironment,
  DECODE_POOL_HARD_CAP,
  DECODE_POOL_MOBILE_CAP,
  type DecodeFormat,
} from '../src/io/workerPool/decodePoolSize';

/** A desktop with enough reported memory to stay off the `low` tier clamp. */
function desktop(cores: number | undefined, format: DecodeFormat = 'copc') {
  return { hardwareConcurrency: cores, deviceMemoryGB: 8, isMobile: false, format };
}

describe('decodeWorkerPoolSize — core bands', () => {
  it('1-2 cores get a single worker', () => {
    expect(decodeWorkerPoolSize(desktop(1))).toBe(1);
    expect(decodeWorkerPoolSize(desktop(2))).toBe(1);
  });

  it('3-4 cores get two workers', () => {
    expect(decodeWorkerPoolSize(desktop(3))).toBe(2);
    expect(decodeWorkerPoolSize(desktop(4))).toBe(2);
  });

  it('5-8 cores get three workers', () => {
    expect(decodeWorkerPoolSize(desktop(5))).toBe(3);
    expect(decodeWorkerPoolSize(desktop(6))).toBe(3);
    expect(decodeWorkerPoolSize(desktop(8))).toBe(3);
  });

  it('9+ cores get four workers, and no more however many cores there are', () => {
    expect(decodeWorkerPoolSize(desktop(9))).toBe(4);
    expect(decodeWorkerPoolSize(desktop(16))).toBe(4);
    expect(decodeWorkerPoolSize(desktop(128))).toBe(4);
    expect(decodeWorkerPoolSize(desktop(1024))).toBe(DECODE_POOL_HARD_CAP);
  });

  it('never claims every core: 4+ cores keep two core-equivalents free', () => {
    for (let cores = 4; cores <= 32; cores++) {
      expect(decodeWorkerPoolSize(desktop(cores))).toBeLessThanOrEqual(cores - 2);
    }
  });
});

describe('decodeWorkerPoolSize — unreadable hardwareConcurrency', () => {
  it('undefined on a desktop assumes the 3-4 core band, not the cap', () => {
    expect(decodeWorkerPoolSize(desktop(undefined))).toBe(2);
  });

  it('undefined on mobile falls to a single worker', () => {
    expect(
      decodeWorkerPoolSize({ hardwareConcurrency: undefined, isMobile: true, format: 'ept' }),
    ).toBe(1);
  });

  it.each([0, -4, Number.NaN, Number.POSITIVE_INFINITY])(
    'a nonsense core count (%s) is treated as unknown, never as 0 workers',
    (cores) => {
      const size = decodeWorkerPoolSize(desktop(cores));
      expect(size).toBe(2);
      expect(size).toBeGreaterThanOrEqual(1);
    },
  );

  it('a fractional core count floors into its band', () => {
    expect(decodeWorkerPoolSize(desktop(4.9))).toBe(2);
    expect(decodeWorkerPoolSize(desktop(8.9))).toBe(3);
  });
});

describe('decodeWorkerPoolSize — mobile', () => {
  it('a capable phone stays at the mobile cap, below its core band', () => {
    // 8 cores would be 3 workers on a desktop; a phone reporting ample memory
    // and cores lands on the mobile ceiling instead.
    const size = decodeWorkerPoolSize({
      hardwareConcurrency: 8,
      deviceMemoryGB: 8,
      isMobile: true,
      format: 'copc',
    });
    expect(size).toBe(DECODE_POOL_MOBILE_CAP);
    expect(size).toBeLessThan(decodeWorkerPoolSize(desktop(8)));
  });

  it('a modest phone (low tier) decodes on one worker', () => {
    expect(
      decodeWorkerPoolSize({ hardwareConcurrency: 8, isMobile: true, format: 'copc' }),
    ).toBe(1);
    expect(
      decodeWorkerPoolSize({
        hardwareConcurrency: 4,
        deviceMemoryGB: 2,
        isMobile: true,
        format: 'copc',
      }),
    ).toBe(1);
  });

  it('mobile never exceeds the scheduler mobile decode concurrency of 2', () => {
    for (let cores = 1; cores <= 32; cores++) {
      const size = decodeWorkerPoolSize({
        hardwareConcurrency: cores,
        deviceMemoryGB: 8,
        isMobile: true,
        format: 'ept',
      });
      expect(size).toBeLessThanOrEqual(DECODE_POOL_MOBILE_CAP);
    }
  });
});

describe('decodeWorkerPoolSize — memory-starved devices', () => {
  it('a low-tier desktop (≤2 GB reported) drops to one worker despite its cores', () => {
    expect(
      decodeWorkerPoolSize({
        hardwareConcurrency: 16,
        deviceMemoryGB: 2,
        isMobile: false,
        format: 'copc',
      }),
    ).toBe(1);
  });

  it('the memory clamp only ever reduces — it can never raise the band', () => {
    const withMemory = decodeWorkerPoolSize(desktop(16));
    const starved = decodeWorkerPoolSize({
      hardwareConcurrency: 16,
      deviceMemoryGB: 1,
      isMobile: false,
      format: 'copc',
    });
    expect(starved).toBeLessThanOrEqual(withMemory);
  });
});

describe('decodeWorkerPoolSize — overrides', () => {
  it('an explicit request wins over the device bands', () => {
    expect(decodeWorkerPoolSize({ ...desktop(16), requested: 1 })).toBe(1);
    expect(decodeWorkerPoolSize({ ...desktop(1), requested: 3 })).toBe(3);
  });

  it('an explicit request is still clamped to [1, hard cap]', () => {
    expect(decodeWorkerPoolSize({ ...desktop(16), requested: 99 })).toBe(DECODE_POOL_HARD_CAP);
    expect(decodeWorkerPoolSize({ ...desktop(16), requested: 0 })).toBe(1);
    expect(decodeWorkerPoolSize({ ...desktop(16), requested: -8 })).toBe(1);
  });

  it('a null request means "use the policy"', () => {
    expect(decodeWorkerPoolSize({ ...desktop(16), requested: null })).toBe(4);
    expect(decodeWorkerPoolSize({ ...desktop(16), requested: undefined })).toBe(4);
  });

  it('a disabled pool collapses to one worker whatever the device reports', () => {
    expect(decodeWorkerPoolSize({ ...desktop(64), poolDisabled: true })).toBe(1);
    // `poolDisabled` outranks an explicit count. It is the single lever that
    // guarantees the historical single-worker path, so nothing may override it.
    expect(
      decodeWorkerPoolSize({ ...desktop(64), poolDisabled: true, requested: 4 }),
    ).toBe(1);
  });
});

describe('decodeWorkerPoolSize — invariants', () => {
  it('is always within [1, hard cap] across a wide input sweep', () => {
    const cores = [undefined, 0, 1, 2, 3, 4, 5, 8, 9, 12, 64, Number.NaN];
    const memory = [undefined, 1, 2, 4, 8, 16];
    const formats: DecodeFormat[] = ['copc', 'ept'];
    for (const c of cores) {
      for (const m of memory) {
        for (const isMobile of [false, true]) {
          for (const format of formats) {
            const size = decodeWorkerPoolSize({
              hardwareConcurrency: c,
              deviceMemoryGB: m,
              isMobile,
              format,
            });
            expect(Number.isInteger(size)).toBe(true);
            expect(size).toBeGreaterThanOrEqual(1);
            expect(size).toBeLessThanOrEqual(DECODE_POOL_HARD_CAP);
          }
        }
      }
    }
  });

  it('both formats resolve identically today (the seam carries no branch yet)', () => {
    for (let cores = 1; cores <= 16; cores++) {
      expect(decodeWorkerPoolSize(desktop(cores, 'copc'))).toBe(
        decodeWorkerPoolSize(desktop(cores, 'ept')),
      );
    }
  });
});

describe('resolveDecodePoolSize — the opt-in rule', () => {
  const OFF = { decodePool: false, decodeWorkers: null };

  it('defaults to a single worker: pooling ships OFF', () => {
    // The whole point of the default. Without a flag both decode clients build
    // a one-worker pool, which is behaviourally the pre-pool client — whatever
    // the machine running this reports for its core count.
    expect(resolveDecodePoolSize('copc', OFF)).toBe(1);
    expect(resolveDecodePoolSize('ept', OFF)).toBe(1);
  });

  it('?decodePool=on opts in and hands the size to the device policy', () => {
    const size = resolveDecodePoolSize('copc', { decodePool: true, decodeWorkers: null });
    // The exact number depends on the host, so the assertion is the contract:
    // a legal pool size, never more than the hard cap.
    expect(Number.isInteger(size)).toBe(true);
    expect(size).toBeGreaterThanOrEqual(1);
    expect(size).toBeLessThanOrEqual(DECODE_POOL_HARD_CAP);
  });

  it('?decodeWorkers=N opts in on its own and pins the count', () => {
    // Asking for N workers and silently getting one would be a flag that lies,
    // so the count implies the opt-in even with decodePool absent.
    for (const n of [1, 2, 3, 4]) {
      expect(resolveDecodePoolSize('copc', { decodePool: false, decodeWorkers: n })).toBe(n);
    }
  });

  it('an explicit constructor size opts in and wins over the flags', () => {
    expect(resolveDecodePoolSize('ept', OFF, 3)).toBe(3);
    expect(resolveDecodePoolSize('ept', { decodePool: true, decodeWorkers: 4 }, 2)).toBe(2);
    // Still clamped — an explicit size is a maintainer's choice, not a bypass.
    expect(resolveDecodePoolSize('ept', OFF, 99)).toBe(DECODE_POOL_HARD_CAP);
    expect(resolveDecodePoolSize('ept', OFF, 0)).toBe(1);
  });

  it('never throws in a DOM-free environment', () => {
    expect(() => resolveDecodePoolSize('copc', OFF)).not.toThrow();
    expect(() => resolveDecodePoolSize('ept', { decodePool: true, decodeWorkers: null })).not.toThrow();
  });
});

describe('readDecodePoolEnvironment', () => {
  it('never throws in a DOM-free environment and yields a usable policy input', () => {
    const env = readDecodePoolEnvironment();
    expect(typeof env.isMobile).toBe('boolean');
    const size = decodeWorkerPoolSize({ ...env, format: 'copc' });
    expect(size).toBeGreaterThanOrEqual(1);
    expect(size).toBeLessThanOrEqual(DECODE_POOL_HARD_CAP);
  });
});
