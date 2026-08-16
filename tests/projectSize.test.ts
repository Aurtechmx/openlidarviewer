/**
 * projectSize.test.ts
 *
 * The Project card shows a scan's extents. They must read in physical metres
 * only when the CRS resolves a linear unit, in raw source units otherwise (never
 * a false 'm'), and the height must follow the source up-axis so a Y-up scan
 * does not report a horizontal axis as its height. `maxPhysicalDimM` is null when
 * the scale is unknown, so the card omits the metre-threshold navigation hint
 * rather than guessing.
 */
import { describe, it, expect } from 'vitest';
import { describeProjectSize } from '../src/render/camera/recommendView';

const MIN: [number, number, number] = [0, 0, 0];
// X extent 300, Y extent 200, Z extent 25.
const MAX: [number, number, number] = [300, 200, 25];
const FOOT = 0.3048;

describe('describeProjectSize', () => {
  it('metres pass through, Z is height, and maxPhysicalDimM is the largest', () => {
    const s = describeProjectSize(MIN, MAX, {
      upAxis: 'z',
      linearUnitKnown: true,
      linearUnitToMetres: 1,
      verticalUnitToMetres: 1,
    });
    expect([s.width, s.depth]).toEqual([300, 200]); // horizontal X, Y
    expect(s.height).toBe(25); // Z
    expect(s.sizeUnit).toBe('m');
    expect(s.maxPhysicalDimM).toBe(300);
  });

  it('a foot cloud reports physical metres, not the raw foot numbers', () => {
    const s = describeProjectSize(MIN, MAX, {
      upAxis: 'z',
      linearUnitKnown: true,
      linearUnitToMetres: FOOT,
      verticalUnitToMetres: FOOT,
    });
    expect(s.width).toBeCloseTo(300 * FOOT, 6);
    expect(s.height).toBeCloseTo(25 * FOOT, 6);
    expect(s.sizeUnit).toBe('m');
    expect(s.maxPhysicalDimM).toBeCloseTo(300 * FOOT, 6);
  });

  it('a Y-up scan takes its height from the Y extent', () => {
    const s = describeProjectSize(MIN, MAX, {
      upAxis: 'y',
      linearUnitKnown: true,
      linearUnitToMetres: 1,
      verticalUnitToMetres: 1,
    });
    expect(s.height).toBe(200); // Y is up
    expect([s.width, s.depth]).toEqual([300, 25]); // horizontal X, Z
  });

  it('an unknown linear unit reports source units and no metre navigation hint', () => {
    const s = describeProjectSize(MIN, MAX, {
      upAxis: 'z',
      linearUnitKnown: false,
      linearUnitToMetres: 1,
    });
    expect(s.width).toBe(300); // raw
    expect(s.sizeUnit).toBe('source units');
    expect(s.maxPhysicalDimM).toBeNull();
  });

  it('a compound frame scales horizontal and vertical separately', () => {
    const s = describeProjectSize(MIN, MAX, {
      upAxis: 'z',
      linearUnitKnown: true,
      linearUnitToMetres: 1, // metre horizontal
      verticalUnitToMetres: FOOT, // foot vertical
    });
    expect(s.width).toBe(300); // horizontal unchanged
    expect(s.height).toBeCloseTo(25 * FOOT, 6); // vertical scaled
  });
});
