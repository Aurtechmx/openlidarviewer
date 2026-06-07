/**
 * tests/classMaskUniform.test.ts
 *
 * Coverage for the pure mask read/write helpers the GPU binding will
 * use. Keeping the lookup logic here lets us unit-test it off-GPU: a
 * ClassVisibility with one class hidden must round-trip through
 * writeMask -> classVisibleAt and agree with isVisible for every code.
 */

import { describe, it, expect } from 'vitest';
import { ClassVisibility } from '../src/render/class/classVisibility';
import {
  writeMask,
  classVisibleAt,
} from '../src/render/class/classMaskUniform';

describe('classMaskUniform', () => {
  it('writeMask returns the 256-entry mask array', () => {
    const v = new ClassVisibility();
    const mask = writeMask(v);
    expect(mask).toBeInstanceOf(Float32Array);
    expect(mask).toHaveLength(256);
  });

  it('classVisibleAt reads mask[code & 0xff] === 1', () => {
    const mask = new Float32Array(256).fill(1);
    mask[7] = 0;
    expect(classVisibleAt(mask, 7)).toBe(false);
    expect(classVisibleAt(mask, 2)).toBe(true);
    // index masking
    expect(classVisibleAt(mask, 7 + 256)).toBe(false);
  });

  it('round-trips a ClassVisibility with one class hidden, per code', () => {
    const v = new ClassVisibility();
    v.setVisible(6, false);
    const mask = writeMask(v);
    for (let code = 0; code < 256; code++) {
      expect(classVisibleAt(mask, code)).toBe(v.isVisible(code));
    }
  });
});
