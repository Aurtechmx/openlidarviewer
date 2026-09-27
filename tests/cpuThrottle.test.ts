import { describe, expect, it } from 'vitest';
import { cpuThrottleFlag, parseCpuThrottle } from '../scripts/lib/cpuThrottle.mjs';
import { pairRefusals, precondition, PRECONDITION_CAL_V2 } from '../scripts/calibration-ab.mjs';

describe('CPU throttle option', () => {
  it('leaves the CPU alone when unset, empty, off or 1', () => {
    for (const v of [undefined, null, '', ' ', 'off', 'OFF', '1', 1, '1x']) expect(parseCpuThrottle(v)).toBe(1);
  });

  it('parses the pre-registered rates', () => {
    expect(parseCpuThrottle('4')).toBe(4);
    expect(parseCpuThrottle('6x')).toBe(6);
    expect(parseCpuThrottle(' 2.5 ')).toBe(2.5);
  });

  it('refuses values that are not a rate from 1 to 20', () => {
    for (const v of ['abc', '-4', '0', '0.5', '21', '4;6', 'NaN', 'Infinity', '1e3']) expect(() => parseCpuThrottle(v)).toThrow();
  });

  it('names the fingerprint flag only when throttled', () => {
    expect(cpuThrottleFlag(1)).toBeNull();
    expect(cpuThrottleFlag(4)).toBe('cpu-throttle=4x');
  });
});

describe('calibration v2 precondition and pairing', () => {
  it('holds the pre-registered share', () => {
    expect(PRECONDITION_CAL_V2.minNonzeroShare).toBe(0.6);
  });

  it('is met at 21 of 35 nonzero levels and not at 20', () => {
    const levels = (n: number) => Array.from({ length: 35 }, (_, i) => (i < n ? 1 : 0));
    expect(precondition(levels(21)).met).toBe(true);
    expect(precondition(levels(20)).met).toBe(false);
    expect(precondition([null, -1, 0]).nonzero).toBe(0);
    expect(precondition([]).met).toBe(false);
  });

  it('refuses a pair whose arms ran a different or missing CPU throttle', () => {
    const fp = (...flags: string[]) => ({ fingerprint: { flags } });
    const fixed = fp('governor=on', 'cpu-throttle=4x');
    const cal = fp('governor=on', 'calibrate=on', 'cpu-throttle=6x');
    expect(pairRefusals(fixed, cal, 4)).toContain('calibrated arm CPU throttle flag wrong');
    expect(pairRefusals(fp('governor=on'), fp('governor=on', 'calibrate=on'), 4)).toContain('fixed arm CPU throttle flag wrong');
    expect(pairRefusals(fixed, fp('governor=on', 'calibrate=on'), 1)).toContain('fixed arm CPU throttle flag wrong');
  });
});
