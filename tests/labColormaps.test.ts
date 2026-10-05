import { describe, expect, it } from 'vitest';
import {
  cividis, deltaE, rampGradient, rgbToLab, simulateCvd, viridis, type Deficiency, type Rgb,
} from '../src/ui/fieldSimulation/labColormaps';

const MAPS: Record<string, (t: number) => Rgb> = { viridis, cividis };
const KINDS: Deficiency[] = ['protan', 'deutan', 'tritan'];

describe.each(Object.entries(MAPS))('%s', (_name, map) => {
  it('rises in CIELAB lightness at every step', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 64; i++) {
      const l = rgbToLab(map(i / 64))[0];
      expect(l).toBeGreaterThan(prev);
      prev = l;
    }
  });

  it('spans at least 40 L* end to end', () => {
    expect(rgbToLab(map(1))[0] - rgbToLab(map(0))[0]).toBeGreaterThanOrEqual(40);
  });

  it.each(KINDS)('keeps its endpoints apart under %s colour-vision deficiency', (kind) => {
    expect(deltaE(simulateCvd(map(0), kind), simulateCvd(map(1), kind))).toBeGreaterThanOrEqual(25);
  });

  it.each(KINDS)('keeps lightness order under %s simulation', (kind) => {
    let prev = -Infinity;
    for (let i = 0; i <= 16; i++) {
      const l = rgbToLab(simulateCvd(map(i / 16), kind))[0];
      expect(l).toBeGreaterThan(prev - 0.5);
      prev = l;
    }
  });

  it('clamps out-of-range and non-finite input', () => {
    expect(map(-1)).toEqual(map(0));
    expect(map(2)).toEqual(map(1));
    expect(map(Number.NaN)).toEqual(map(0));
  });

  it('builds a legend gradient from its own stops', () => {
    const g = rampGradient(map, 3);
    expect(g.startsWith('linear-gradient(90deg,')).toBe(true);
    expect(g).toContain('0.0%');
    expect(g).toContain('100.0%');
  });
});
