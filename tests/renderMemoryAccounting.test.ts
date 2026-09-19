/**
 * renderMemoryAccounting.test.ts — the render-memory figure follows the layout.
 *
 * The estimate was one constant, 24 bytes, covering an instanced position and
 * an instanced colour. The mesh builder also uploads `aClass` for a classified
 * cloud and `aIntensity` for one carrying intensity, both Float32 per point, so
 * a cloud with both used 32 bytes and was reported at 24. A readout that
 * under-reports memory is the kind of telemetry that hides a regression rather
 * than showing it.
 */

import { describe, it, expect } from 'vitest';
import {
  bytesPerPoint,
  gpuAttributeBytes,
  pointAttributeLayout,
  attributeBreakdown,
  POSITION_ATTRIBUTE,
  COLOR_ATTRIBUTE,
  CLASS_ATTRIBUTE,
  INTENSITY_ATTRIBUTE,
  attributeBytesPerPoint,
} from '../src/render/pointAttributeLayout';

const NONE = { classification: false, intensity: false };
const BOTH = { classification: true, intensity: true };

describe('what one point costs', () => {
  it('is 24 bytes for position and colour alone, the figure the old constant held', () => {
    expect(bytesPerPoint(NONE)).toBe(24);
  });

  it('adds four bytes for classification', () => {
    expect(bytesPerPoint({ classification: true, intensity: false })).toBe(28);
  });

  it('adds four bytes for intensity', () => {
    expect(bytesPerPoint({ classification: false, intensity: true })).toBe(28);
  });

  it('is 32 bytes with both, which the old constant reported as 24', () => {
    expect(bytesPerPoint(BOTH)).toBe(32);
    // The under-report the layout exists to end: three quarters of the truth.
    expect(24 / bytesPerPoint(BOTH)).toBe(0.75);
  });
});

describe('the per-attribute figures', () => {
  it.each([
    [POSITION_ATTRIBUTE, 12],
    [COLOR_ATTRIBUTE, 12],
    [CLASS_ATTRIBUTE, 4],
    [INTENSITY_ATTRIBUTE, 4],
  ])('costs %s bytes as uploaded', (attr, bytes) => {
    expect(attributeBytesPerPoint(attr)).toBe(bytes);
  });

  it('sums to the layout total, so the breakdown cannot disagree with the figure', () => {
    const n = 1_000_000;
    const parts = attributeBreakdown(n, BOTH);
    const summed = parts.reduce((t, p) => t + p.bytes, 0);
    expect(summed).toBe(gpuAttributeBytes(n, BOTH));
  });
});

describe('the layout itself', () => {
  it('always uploads position and colour', () => {
    expect(pointAttributeLayout(NONE).map((a) => a.name)).toEqual(['aPos', 'aColor']);
  });

  it('names every attribute the mesh binds, in upload order', () => {
    expect(pointAttributeLayout(BOTH).map((a) => a.name)).toEqual([
      'aPos',
      'aColor',
      'aClass',
      'aIntensity',
    ]);
  });
});

describe('scaling to a resident cloud', () => {
  it('reports a million classified points at 32 MB rather than 24', () => {
    expect(gpuAttributeBytes(1_000_000, BOTH)).toBe(32_000_000);
    expect(gpuAttributeBytes(1_000_000, NONE)).toBe(24_000_000);
  });

  it('refuses to invent bytes for a negative or fractional count', () => {
    expect(gpuAttributeBytes(-5, BOTH)).toBe(0);
    expect(gpuAttributeBytes(1.9, NONE)).toBe(24);
  });
});
