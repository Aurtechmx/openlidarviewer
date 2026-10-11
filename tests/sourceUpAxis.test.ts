import { describe, expect, it } from 'vitest';
import { sourceUpAxis } from '../src/io/sniffFormat';

describe('sourceUpAxis', () => {
  it('keeps a resolved axis', () => {
    expect(sourceUpAxis('y', 'las', false)).toBe('y');
    expect(sourceUpAxis('z', 'ply', false)).toBe('z');
  });
  it('settles an undetermined axis to z for LAS and LAZ, which are z-up by specification', () => {
    expect(sourceUpAxis('unknown', 'las', false)).toBe('z');
    expect(sourceUpAxis('unknown', 'laz', false)).toBe('z');
  });
  it('settles an undetermined axis to z for a COPC/EPT stream with no resident cloud', () => {
    expect(sourceUpAxis('unknown', undefined, true)).toBe('z');
  });
  it('leaves formats that are z-up only by convention, and mesh formats, undetermined', () => {
    expect(sourceUpAxis('unknown', 'xyz', false)).toBe('unknown');
    expect(sourceUpAxis('unknown', 'ply', false)).toBe('unknown');
    expect(sourceUpAxis('unknown', undefined, false)).toBe('unknown');
  });
});
