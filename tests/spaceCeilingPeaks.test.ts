/**
 * spaceCeilingPeaks.test.ts
 *
 * The floor is the lowest strong height peak and the ceiling the highest.
 * A floor that is not quite level spreads its returns over two histogram bins,
 * while a bed or table top puts its returns in one; taking the single fullest
 * bin as the floor read the furniture top as the floor and printed a ceiling
 * height about 0.55 m short.
 */
import { describe, expect, it } from 'vitest';
import { spaceMetrics } from '../src/terrain/spaceMetrics';

function roomWithTable(): Float32Array {
  const t: number[] = [];
  const W = 4, D = 3, H = 2.45, s = 0.05;
  // Floor, sagging 3 cm towards one wall so it falls in two height bins.
  for (let x = 0; x <= W + 1e-9; x += s)
    for (let y = 0; y <= D + 1e-9; y += s) t.push(x, y, x < W / 2 ? 0 : 0.03);
  // Ceiling.
  for (let x = 0; x <= W + 1e-9; x += s)
    for (let y = 0; y <= D + 1e-9; y += s) t.push(x, y, H);
  // Walls.
  for (let z = 0; z <= H + 1e-9; z += s * 2) {
    for (let x = 0; x <= W + 1e-9; x += s * 2) { t.push(x, 0, z); t.push(x, D, z); }
    for (let y = 0; y <= D + 1e-9; y += s * 2) { t.push(0, y, z); t.push(W, y, z); }
  }
  // A large table top, sampled densely, 0.55 m above the floor.
  for (let x = 0.5; x <= 3.5 + 1e-9; x += s * 0.6)
    for (let y = 0.5; y <= 2.5 + 1e-9; y += s * 0.6) t.push(x, y, 0.55);
  return Float32Array.from(t);
}

describe('ceiling height from the lowest and highest strong peaks', () => {
  it('measures floor to ceiling, not table top to ceiling', () => {
    const m = spaceMetrics(roomWithTable(), { upAxis: 'z', spaceKind: 'interior' });
    expect(m.ceilingHeightM).not.toBeNull();
    expect(m.ceilingHeightM!).toBeGreaterThan(2.35);
    expect(m.ceilingHeightM!).toBeLessThan(2.5);
  });
});
