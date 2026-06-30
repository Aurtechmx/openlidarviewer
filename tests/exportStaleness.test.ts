import { describe, test, expect } from 'vitest';
import {
  parseVersion,
  compareVersions,
  isExportStale,
  staleExportReason,
} from '../src/export/exportStaleness';

describe('parseVersion', () => {
  test('parses dotted versions, tolerates a leading v', () => {
    expect(parseVersion('0.5.2')).toEqual([0, 5, 2]);
    expect(parseVersion('v0.5.2')).toEqual([0, 5, 2]);
    expect(parseVersion('1.0')).toEqual([1, 0]);
  });
  test('malformed parts degrade to 0, not throw', () => {
    expect(parseVersion('0.x.2')).toEqual([0, 0, 2]);
    expect(parseVersion('')).toEqual([0]);
  });
});

describe('compareVersions', () => {
  test('orders by component', () => {
    expect(compareVersions('0.5.1', '0.5.2')).toBe(-1);
    expect(compareVersions('0.5.2', '0.5.1')).toBe(1);
    expect(compareVersions('0.5.2', '0.5.2')).toBe(0);
    expect(compareVersions('0.6.0', '0.5.9')).toBe(1);
  });
  test('zero-pads shorter versions', () => {
    expect(compareVersions('0.5', '0.5.0')).toBe(0);
    expect(compareVersions('0.5', '0.5.1')).toBe(-1);
  });
});

describe('isExportStale', () => {
  test('older produced version is stale', () => {
    expect(isExportStale('0.4.8', '0.5.2')).toBe(true);
  });
  test('same or newer is not stale', () => {
    expect(isExportStale('0.5.2', '0.5.2')).toBe(false);
    expect(isExportStale('0.6.0', '0.5.2')).toBe(false);
  });
  test('missing/blank produced version is treated as stale (can not prove current)', () => {
    expect(isExportStale(undefined, '0.5.2')).toBe(true);
    expect(isExportStale('', '0.5.2')).toBe(true);
    expect(isExportStale(null, '0.5.2')).toBe(true);
  });
});

describe('staleExportReason', () => {
  test('names both versions when stale', () => {
    const msg = staleExportReason('0.4.8', '0.5.2');
    expect(msg).toMatch(/v0\.4\.8/);
    expect(msg).toMatch(/v0\.5\.2/);
    expect(msg).toMatch(/regenerate/i);
  });
  test('null when current or newer', () => {
    expect(staleExportReason('0.5.2', '0.5.2')).toBeNull();
    expect(staleExportReason('0.6.0', '0.5.2')).toBeNull();
  });
  test('unstamped legacy export reads as "an earlier version"', () => {
    expect(staleExportReason('', '0.5.2')).toMatch(/an earlier version/);
  });
});
