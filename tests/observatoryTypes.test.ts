import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_ORIGIN_STATUSES,
  COUNTER_SATURATION_MAX,
  createPresenceMask,
  isAcceptedOriginStatus,
  isSourcePresent,
  presenceMaskWordCount,
  PRESENCE_BITS_PER_WORD,
  setSourcePresent,
} from '../src/observation/types';

describe('SPEC §2.1 — per-source presence bitmask (Uint32 words, 32 sources/word)', () => {
  it('needs zero words for zero sources, and one word for 1..32 sources', () => {
    expect(presenceMaskWordCount(0)).toBe(0);
    expect(presenceMaskWordCount(1)).toBe(1);
    expect(presenceMaskWordCount(32)).toBe(1);
  });

  it('F17: source index 32 crosses into a second word', () => {
    expect(presenceMaskWordCount(33)).toBe(2);
    const mask = createPresenceMask(40);
    expect(mask.length).toBe(2);
    setSourcePresent(mask, 32);
    expect(isSourcePresent(mask, 32)).toBe(true);
    expect(isSourcePresent(mask, 31)).toBe(false);
    expect(isSourcePresent(mask, 0)).toBe(false);
    expect(mask[0]).toBe(0);
    expect(mask[1]).toBe(1);
  });

  it('packs 32 distinct sources into one word without collision', () => {
    const mask = createPresenceMask(PRESENCE_BITS_PER_WORD);
    for (let i = 0; i < PRESENCE_BITS_PER_WORD; i++) setSourcePresent(mask, i);
    expect(mask[0]).toBe(0xffffffff >>> 0); // all 32 bits set
    for (let i = 0; i < PRESENCE_BITS_PER_WORD; i++) expect(isSourcePresent(mask, i)).toBe(true);
  });

  it('refuses a source index the mask was not sized for', () => {
    const mask = createPresenceMask(1);
    expect(() => setSourcePresent(mask, 32)).toThrow();
  });
});

describe('SPEC §4 OB-INT-06 — accepted origin statuses', () => {
  it('accepts DECLARED and RECONSTRUCTED_STRONG only, by default policy', () => {
    expect(ACCEPTED_ORIGIN_STATUSES).toEqual(['DECLARED', 'RECONSTRUCTED_STRONG']);
    expect(isAcceptedOriginStatus('DECLARED')).toBe(true);
    expect(isAcceptedOriginStatus('RECONSTRUCTED_STRONG')).toBe(true);
  });

  it('refuses ASSUMED and the two weaker reconstructed grades by default (OB-INT-06)', () => {
    expect(isAcceptedOriginStatus('ASSUMED')).toBe(false);
    expect(isAcceptedOriginStatus('RECONSTRUCTED_MODERATE')).toBe(false);
    expect(isAcceptedOriginStatus('RECONSTRUCTED_WEAK')).toBe(false);
  });
});

describe('SPEC §2.1 — counter saturation ceiling', () => {
  it('is the Uint16 maximum', () => {
    expect(COUNTER_SATURATION_MAX).toBe(65535);
  });
});
