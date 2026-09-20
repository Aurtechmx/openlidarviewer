import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SUPPORT_R8 } from '../src/render/continuity/historyBudget';
import {
  censusOf,
  censusOfPacked,
  reconstructedShare,
  withinReconstructionCeiling,
} from '../src/render/continuity/supportCensus';
import { shouldFill, type Cardinals, type SupportKind } from '../src/render/continuity/microGap';
import {
  COUNT_BITS,
  MAX_PACKED_SAMPLES,
  PROVENANCE_BITS,
  SUPPORT_CODE,
  byteFromUnorm,
  maySupportReconstruction,
  nextSupport,
  packSupport,
  unormFromByte,
  unpackSampleCount,
  unpackSupportKind,
  writeIsPermitted,
  type SupportWrite,
} from '../src/render/continuity/supportProvenance';

const KINDS: readonly SupportKind[] = ['none', 'direct', 'accumulated', 'reconstructed'];
const WRITES: readonly SupportWrite[] = ['sample', 'accumulate', 'reconstruct'];

describe('the transition table', () => {
  it('lets a source sample overwrite anything', () => {
    // Including a pixel that was reconstructed a moment ago: a sample landing
    // there is exactly what the fill was standing in for.
    for (const kind of KINDS) expect(nextSupport(kind, 'sample')).toBe('direct');
  });

  it('accumulates only what came from samples', () => {
    expect(nextSupport('direct', 'accumulate')).toBe('accumulated');
    expect(nextSupport('accumulated', 'accumulate')).toBe('accumulated');
    // Nothing to retain.
    expect(nextSupport('none', 'accumulate')).toBe('none');
  });

  it('never launders a reconstructed pixel into a measured one', () => {
    // The transition that must not exist: once a filled pixel is
    // indistinguishable from a measured one it becomes evidence for filling
    // its neighbour, and the surface walks across ground nothing recorded.
    expect(nextSupport('reconstructed', 'accumulate')).toBe('reconstructed');
    expect(writeIsPermitted('reconstructed', 'accumulate')).toBe(false);
  });

  it('reconstructs only into a pixel with nothing in it', () => {
    expect(nextSupport('none', 'reconstruct')).toBe('reconstructed');
    expect(nextSupport('direct', 'reconstruct')).toBe('direct');
    expect(nextSupport('accumulated', 'reconstruct')).toBe('accumulated');
    // Never over another fill, which is how a seam becomes a patch.
    expect(nextSupport('reconstructed', 'reconstruct')).toBe('reconstructed');
  });

  it('only ever moves a pixel to a state the write names', () => {
    const expected: Readonly<Record<SupportWrite, SupportKind>> = {
      sample: 'direct',
      accumulate: 'accumulated',
      reconstruct: 'reconstructed',
    };
    for (const kind of KINDS) {
      for (const write of WRITES) {
        const next = nextSupport(kind, write);
        expect([kind, expected[write]], `${kind} + ${write}`).toContain(next);
      }
    }
  });

  it('is idempotent: applying a permitted write twice changes nothing more', () => {
    for (const kind of KINDS) {
      for (const write of WRITES) {
        const once = nextSupport(kind, write);
        expect(nextSupport(once, write)).toBe(nextSupport(once, write));
        if (write !== 'sample') expect(writeIsPermitted(once, write)).toBe(false);
      }
    }
  });
});

describe('what may justify a fill', () => {
  it('counts samples and carried-forward samples, and nothing else', () => {
    expect(maySupportReconstruction('direct')).toBe(true);
    expect(maySupportReconstruction('accumulated')).toBe(true);
    expect(maySupportReconstruction('reconstructed')).toBe(false);
    expect(maySupportReconstruction('none')).toBe(false);
  });

  it('agrees with the gap pass, which enforces the same rule from its own end', () => {
    const at = (support: SupportKind): Cardinals => ({
      left: { depth: 10, support },
      right: { depth: 10, support },
      up: { depth: 10, support },
      down: { depth: 10, support },
    });
    for (const kind of KINDS) {
      const decision = shouldFill('none', at(kind));
      expect(decision.fill, kind).toBe(maySupportReconstruction(kind));
    }
  });
});

describe('the packed byte', () => {
  it('fits provenance and a count in the surface the layout already allocates', () => {
    expect(PROVENANCE_BITS + COUNT_BITS).toBe(8);
    expect(SUPPORT_R8.bytesPerPixel).toBe(1);
  });

  it('round-trips every state at every count it can hold', () => {
    for (const kind of KINDS) {
      for (const samples of [0, 1, 4, 17, MAX_PACKED_SAMPLES]) {
        const byte = packSupport(kind, samples);
        expect(byte).toBeGreaterThanOrEqual(0);
        expect(byte).toBeLessThanOrEqual(255);
        expect(unpackSupportKind(byte)).toBe(kind);
        expect(unpackSampleCount(byte)).toBe(samples);
      }
    }
  });

  it('saturates a count rather than overflowing into the provenance bits', () => {
    const byte = packSupport('reconstructed', 10_000);
    expect(unpackSampleCount(byte)).toBe(MAX_PACKED_SAMPLES);
    expect(unpackSupportKind(byte)).toBe('reconstructed');
  });

  it('stores a count nobody could produce as zero', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(unpackSampleCount(packSupport('direct', bad))).toBe(0);
      expect(unpackSupportKind(packSupport('direct', bad))).toBe('direct');
    }
  });

  it('lets a reader that wants only the state mask with three', () => {
    for (const kind of KINDS) {
      expect(packSupport(kind, 63) & 0b11).toBe(SUPPORT_CODE[kind]);
    }
  });

  it('reads an unusable byte as nothing drawn', () => {
    expect(unpackSupportKind(Number.NaN)).toBe('none');
    expect(unpackSupportKind(-8)).toBe('none');
    expect(unpackSampleCount(Number.NaN)).toBe(0);
  });
});

describe('the normalised round trip', () => {
  it('survives the texel scale both ways, for every byte', () => {
    // A bit field only survives r8unorm if both ends agree on the scale and
    // the rounding, which is why both directions live in one module.
    for (let byte = 0; byte <= 255; byte++) {
      expect(byteFromUnorm(unormFromByte(byte))).toBe(byte);
    }
  });

  it('survives it for every state and count the pack produces', () => {
    for (const kind of KINDS) {
      for (const samples of [0, 3, 63]) {
        const byte = packSupport(kind, samples);
        const back = byteFromUnorm(unormFromByte(byte));
        expect(unpackSupportKind(back)).toBe(kind);
        expect(unpackSampleCount(back)).toBe(samples);
      }
    }
  });

  it('clamps a texel value outside the range rather than wrapping it', () => {
    expect(byteFromUnorm(-1)).toBe(0);
    expect(byteFromUnorm(2)).toBe(255);
    expect(byteFromUnorm(Number.NaN)).toBe(0);
    expect(unormFromByte(400)).toBe(1);
  });
});

describe('the name', () => {
  it('is provenance, and never confidence or completeness', () => {
    // Checked against the source with the comments removed, so the header can
    // explain why those two words are wrong without tripping the check.
    const source = readFileSync(
      new URL('../src/render/continuity/supportProvenance.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/confidence|completeness/i);
    expect(code).toMatch(/export function nextSupport/);
  });
});

describe('the census reads the surface', () => {
  it('tallies packed bytes exactly as it tallies decoded kinds', () => {
    const kinds: SupportKind[] = [
      'none', 'direct', 'direct', 'accumulated', 'reconstructed', 'direct', 'none',
    ];
    const bytes = kinds.map((k, i) => packSupport(k, i));
    expect(censusOfPacked(bytes)).toEqual(censusOf(kinds));
  });

  it('counts a byte that means nothing as nothing drawn', () => {
    // A diagnostics read of an unwritten surface must not crash.
    expect(censusOfPacked([Number.NaN, -1])).toEqual({
      none: 2, direct: 0, accumulated: 0, reconstructed: 0,
    });
  });

  it('gives the reconstructed share the ceiling is checked against', () => {
    const bytes = [
      ...Array.from({ length: 90 }, () => packSupport('direct', 4)),
      ...Array.from({ length: 10 }, () => packSupport('reconstructed')),
    ];
    const census = censusOfPacked(bytes);
    expect(reconstructedShare(census)).toBeCloseTo(0.1, 9);
    expect(withinReconstructionCeiling(census)).toBe(true);
  });
});
