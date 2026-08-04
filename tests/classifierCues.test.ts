import { describe, it, expect } from 'vitest';
import { classifierCues } from '../src/render/class/classifierCues';

describe('classifierCues', () => {
  const colors = new Uint8Array([1, 2, 3]);
  const returnNumber = new Uint8Array([1, 1]);
  const returnCount = new Uint8Array([2, 1]);

  it('a bare XYZ cloud yields no cues', () => {
    expect(classifierCues({})).toEqual({});
  });

  it('includes colours when present', () => {
    expect(classifierCues({ colors })).toEqual({ colors });
  });

  it('includes return number + count only as a pair', () => {
    expect(classifierCues({ returnNumber, returnCount })).toEqual({ returnNumber, returnCount });
  });

  it('drops a lone return array — the cue needs both', () => {
    expect(classifierCues({ returnNumber })).toEqual({});
    expect(classifierCues({ returnCount })).toEqual({});
  });

  it('combines colours and returns', () => {
    expect(classifierCues({ colors, returnNumber, returnCount })).toEqual({
      colors,
      returnNumber,
      returnCount,
    });
  });

  it('treats empty arrays as absent', () => {
    expect(classifierCues({ colors: new Uint8Array(0) })).toEqual({});
    expect(
      classifierCues({ returnNumber: new Uint8Array(0), returnCount: new Uint8Array(0) }),
    ).toEqual({});
  });
});
