/**
 * intakeCorpusProbeLock.test.ts: the format probe over the whole intake
 * corpus with no extension. No negative may be offered a decoder, and every
 * text positive must open as PROBABLE xyz.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM generator without type declarations
import { generateCorpus } from '../validation/intake-corpus/generate.mjs';
import { chooseFormat } from '../src/io/probe/formatProbes';

type Raw = { entry: { id: string; label: string; category: string }; bytes: Uint8Array };
type Sample = { id: string; label: string; category: string; data: Uint8Array };

const samples: Sample[] = (generateCorpus() as Raw[]).map((r) => ({ ...r.entry, data: new Uint8Array(r.bytes) }));

describe('intake corpus probe lock', () => {
  const decide = (s: Sample) => chooseFormat({ bytes: s.data, complete: true, ext: '' });

  it('offers a decoder to no negative', () => {
    const negatives = samples.filter((s) => s.label === 'negative');
    expect(negatives.length).toBe(162);
    const opened = negatives.filter((s) => decide(s).decoderId !== null).map((s) => s.id);
    expect(opened).toEqual([]);
  });

  it('opens every text positive as PROBABLE xyz', () => {
    const text = samples.filter((s) => s.category === 'text-points');
    expect(text.length).toBe(32);
    for (const s of text) {
      const d = decide(s);
      expect(`${s.id} ${d.level}:${d.decoderId}`).toBe(`${s.id} PROBABLE:xyz`);
    }
  });
});
