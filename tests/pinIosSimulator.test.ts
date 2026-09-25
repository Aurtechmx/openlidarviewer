/** The iOS leg's simulator pin: exact runtime and device, no fallback. */
import { describe, it, expect } from 'vitest';
import { pinSimulator } from '../scripts/pin-ios-simulator.mjs';

const RT = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const listing = {
  runtimes: [{ name: 'iOS 26.5', identifier: RT, isAvailable: true }, { name: 'iOS 26.2', identifier: 'x', isAvailable: true }],
  devices: { [RT]: [{ name: 'iPhone 17 Pro', udid: 'A', isAvailable: true }, { name: 'iPhone 17e', udid: 'B', isAvailable: true }] },
};

describe('pinSimulator', () => {
  it('resolves iOS 26.5 / iPhone 17e by exact name', () => {
    expect(pinSimulator(listing)).toEqual({ udid: 'B', name: 'iPhone 17e', runtime: 'iOS 26.5' });
  });
  it('refuses a missing runtime, naming wanted and available', () => {
    const r = pinSimulator(listing, 'iOS 27.0');
    expect(r).toEqual({ error: expect.stringContaining('"iOS 27.0"') });
    expect((r as { error: string }).error).toContain('iOS 26.5, iOS 26.2');
  });
  it('refuses a missing device instead of falling back to another iPhone', () => {
    const r = pinSimulator(listing, 'iOS 26.5', 'iPhone 17');
    expect((r as { error: string }).error).toMatch(/"iPhone 17".*iPhone 17 Pro, iPhone 17e/);
  });
});
