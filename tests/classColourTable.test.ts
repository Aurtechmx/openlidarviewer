/**
 * classColourTable.test.ts
 *
 * Colour-by-class looks each point's code up in a 256-entry table built once
 * per call. The bytes must be the ones the per-point map lookup gave, for both
 * palettes and for codes outside a byte or not integers (which keep the map
 * path). Digests recorded from the map-lookup implementation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { classColor, colorByClassification, setColorblindSafeClasses } from '../src/render/colorModes';

afterEach(() => setColorblindSafeClasses(false));

function codes(): number[] {
  let s = 77;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
  const out: number[] = [];
  for (let i = 0; i < 200_000; i++) out.push(Math.floor(rnd() * 256));
  // Codes a byte table cannot index: past a byte, negative, fractional, not a number.
  out.push(256, 300, 65_535, -1, -0, 2.5, 7.999, Number.NaN, Number.POSITIVE_INFINITY);
  return out;
}

const digest = (a: Uint8Array): string => createHash('sha256').update(a).digest('hex');

describe('colorByClassification lookup table', () => {
  it('standard palette bytes are unchanged', () => {
    const c = codes();
    expect(digest(colorByClassification(c, c.length))).toBe('85481c4c1b3470e40549119c1fa0c523e7f233e81be3936ccc855462e4ba52f7');
  });

  it('colourblind-safe palette bytes are unchanged', () => {
    setColorblindSafeClasses(true);
    const c = codes();
    expect(digest(colorByClassification(Float32Array.from(c), c.length))).toBe('4bc20a1a36303c535a51c86bbd855fbf236428478487a314e0367038054fdda5');
  });

  it('matches the legend swatch for every byte code', () => {
    const all = Array.from({ length: 256 }, (_, i) => i);
    const out = colorByClassification(Uint8Array.from(all), 256);
    for (const code of all) expect([out[code * 3], out[code * 3 + 1], out[code * 3 + 2]]).toEqual([...classColor(code)]);
  });
});
