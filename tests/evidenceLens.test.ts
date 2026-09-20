import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LENS_CLOSED,
  lensEvidence,
  lensCoverage,
  insideLens,
  admitsReconstruction,
  type Lens,
} from '../src/render/continuity/evidenceLens';

const OPEN: Lens = {
  centreXPx: 100,
  centreYPx: 100,
  radiusPx: 40,
  featherPx: 10,
  enabled: true,
};

describe('evidence lens', () => {
  it('reveals nothing while closed', () => {
    expect(lensCoverage(100, 100, LENS_CLOSED)).toBe(0);
    expect(insideLens(100, 100, LENS_CLOSED)).toBe(false);
    expect(admitsReconstruction(100, 100, LENS_CLOSED)).toBe(true);
  });

  it('is fully raw within the radius', () => {
    expect(lensCoverage(100, 100, OPEN)).toBe(1);
    expect(lensCoverage(100, 139, OPEN)).toBe(1);
    expect(lensCoverage(100 + 40, 100, OPEN)).toBe(1);
  });

  it('falls to nothing past the feather', () => {
    expect(lensCoverage(100 + 51, 100, OPEN)).toBe(0);
    expect(lensCoverage(1000, 1000, OPEN)).toBe(0);
  });

  it('blends across the feather without a step', () => {
    const mid = lensCoverage(100 + 45, 100, OPEN);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('is radially symmetric', () => {
    const r = 45;
    const a = lensCoverage(100 + r, 100, OPEN);
    for (const t of [0.3, 1.1, 2.7, 4.2]) {
      const x = 100 + r * Math.cos(t);
      const y = 100 + r * Math.sin(t);
      expect(lensCoverage(x, y, OPEN)).toBeCloseTo(a, 12);
    }
  });

  // The decision the lens exists for is hard, not faded. A rim of partly
  // invented pixels is exactly the band a viewer aims at a suspicious patch,
  // so it would be least trustworthy where it is most used.
  it('suppresses reconstruction across the whole feather, not just the radius', () => {
    const inFeather = { x: 100 + 45, y: 100 };
    expect(lensCoverage(inFeather.x, inFeather.y, OPEN)).toBeLessThan(1);
    expect(insideLens(inFeather.x, inFeather.y, OPEN)).toBe(true);
    expect(admitsReconstruction(inFeather.x, inFeather.y, OPEN)).toBe(false);
  });

  it('errs toward revealing rather than reconstructing at the boundary', () => {
    // The outer edge of the feather is the last pixel held to the lens rule.
    expect(admitsReconstruction(100 + 50, 100, OPEN)).toBe(false);
    expect(admitsReconstruction(100 + 51, 100, OPEN)).toBe(true);
  });

  it('never reconstructs anywhere the lens shows anything', () => {
    for (let d = 0; d <= 60; d += 0.5) {
      const covered = lensCoverage(100 + d, 100, OPEN) > 0;
      if (covered) expect(admitsReconstruction(100 + d, 100, OPEN)).toBe(false);
    }
  });

  it('treats a zero radius as closed', () => {
    const degenerate: Lens = { ...OPEN, radiusPx: 0 };
    expect(lensCoverage(100, 100, degenerate)).toBe(0);
    expect(insideLens(100, 100, degenerate)).toBe(false);
  });

  it('works with no feather at all', () => {
    const hard: Lens = { ...OPEN, featherPx: 0 };
    expect(lensCoverage(100 + 39, 100, hard)).toBe(1);
    expect(lensCoverage(100 + 41, 100, hard)).toBe(0);
    expect(admitsReconstruction(100 + 41, 100, hard)).toBe(true);
  });
});

describe('what the lens may claim', () => {
  // Under the lens every remaining pixel is one a sample paid for. On a streamed
  // scan that is true and still misleading: the samples present are the ones
  // that loaded, not the ones the file holds, so a thin patch could be sparse
  // ground or absent data. Opposite conclusions, identical appearance.
  it('claims complete evidence only where the source is proven complete', () => {
    expect(lensEvidence(true)).toBe('complete');
    expect(lensEvidence(false)).toBe('partial');
  });

  it('never decides completeness for itself', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/render/continuity/evidenceLens.ts', import.meta.url)),
      'utf8',
    );
    // No imports at all: it cannot reach residency to ask, and cannot alter it.
    expect(/^import\s/m.test(src)).toBe(false);
  });
});
