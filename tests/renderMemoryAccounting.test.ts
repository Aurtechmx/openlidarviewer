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
  uploadedAttributesOf,
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

describe('the readout asks for the channels it has', () => {
  // Building the capability was not the fix. Both callers of estimateGpuBytes
  // passed nothing, so the default kept the position-and-colour floor and the
  // readout still understated a classified cloud by a quarter. These pin the
  // signature that makes the difference visible at the call site.

  it('prices a classified cloud above the floor when told its channels', async () => {
    const { estimateGpuBytes } = await import('../src/render/streaming/streamingBudget');
    const floor = estimateGpuBytes(1_000_000);
    const real = estimateGpuBytes(1_000_000, { classification: true, intensity: true });
    expect(floor).toBe(24_000_000);
    expect(real).toBe(32_000_000);
    expect(real).toBeGreaterThan(floor);
  });

  it('keeps the floor for a caller that cannot name the channels', async () => {
    const { estimateGpuBytes } = await import('../src/render/streaming/streamingBudget');
    // Honest rather than optimistic: a caller that does not know what a cloud
    // carries reports the minimum it certainly has, not a guess at the rest.
    expect(estimateGpuBytes(1000)).toBe(estimateGpuBytes(1000, NONE));
  });
});

// The static half of the same bug. `pointAttributeLayout` was written to end a
// fixed 24-byte figure, and the streaming path was converted; the static path
// kept multiplying displayed points by the constant, so the readout still
// under-reported every classified cloud on screen.
describe('the static cloud estimate reads the geometry it uploaded', () => {
  /** A geometry that holds exactly the named attributes. */
  const carrier = (...names: string[]) => ({
    getAttribute: (name: string) => (names.includes(name) ? {} : undefined),
  });

  it('reports the channels a geometry actually carries', () => {
    expect(uploadedAttributesOf(carrier('aPos', 'aColor'))).toEqual(NONE);
    expect(uploadedAttributesOf(carrier('aPos', 'aColor', 'aClass', 'aIntensity'))).toEqual(BOTH);
    expect(uploadedAttributesOf(carrier('aPos', 'aColor', 'aClass'))).toEqual({
      classification: true,
      intensity: false,
    });
  });

  it('asks the geometry rather than trusting a remembered flag', () => {
    // A derived classification adds `aClass` to a cloud whose source carried
    // none. The geometry knows; a flag captured at load does not.
    const before = carrier('aPos', 'aColor');
    const after = carrier('aPos', 'aColor', 'aClass');
    expect(uploadedAttributesOf(before).classification).toBe(false);
    expect(uploadedAttributesOf(after).classification).toBe(true);
  });

  it('recovers the quarter the fixed constant dropped', () => {
    const FIXED = 24; // position + colour only, the figure that shipped
    const points = 1_000_000;
    const both = uploadedAttributesOf(carrier('aPos', 'aColor', 'aClass', 'aIntensity'));
    expect(gpuAttributeBytes(points, both)).toBe(points * 32);
    // Exactly three quarters, which is what the readout used to show.
    expect(points * FIXED).toBe(gpuAttributeBytes(points, both) * 0.75);
  });

  it('leaves a cloud with neither channel exactly where it was', () => {
    // The unclassified case must not move: this is a correction, not a retune.
    expect(gpuAttributeBytes(1000, uploadedAttributesOf(carrier('aPos', 'aColor')))).toBe(1000 * 24);
  });
});
