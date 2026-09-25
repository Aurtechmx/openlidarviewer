/**
 * stateChip.ts — OB-UI-02's seven badges (`docs/observatory/SPEC.md` §8):
 * `DECLARED ORIGIN`, `ASSUMED ORIGIN`, `RECONSTRUCTED ORIGIN`,
 * `SOURCE COMPLETE`, `RESIDENT ONLY`, `SAMPLED`, `SUGGESTED STATION`.
 *
 * Built on `src/ui/dom.ts`'s `chip()` (ASK O9-3: `dom.ts` had no chip/badge
 * primitive before this phase, so O9 adds one THERE, generic, rather than a
 * parallel Observatory-only implementation — this file only supplies the
 * fixed glyph/word/tip table `chip()` needs).
 *
 * Origin status and basis are read from the kernel's own values, never
 * inferred here: `originBadge`/`basisBadge` are total functions over the
 * kernel's `ObservationOriginStatus` / basis strings, so a panel cannot
 * accidentally show `DECLARED ORIGIN` for an assumed one.
 */
import { chip } from '../dom';
import type { ObservationOriginStatus } from '../../observation/types';

const CHIP_CLASS = 'olv-observatory-chip';

interface ChipSpec {
  readonly glyph: string;
  readonly word: string;
  readonly tip: string;
}

const ORIGIN_CHIPS: Readonly<Record<ObservationOriginStatus, ChipSpec>> = {
  DECLARED: { glyph: '◉', word: 'DECLARED ORIGIN', tip: 'The station pose came from the file’s own declaration.' },
  ASSUMED: { glyph: '○', word: 'ASSUMED ORIGIN', tip: 'A user placed this origin; it was never measured or declared by the source.' },
  RECONSTRUCTED_STRONG: { glyph: '◖', word: 'RECONSTRUCTED ORIGIN', tip: 'The origin was reconstructed with strong confidence, not declared by the source.' },
  RECONSTRUCTED_MODERATE: { glyph: '◖', word: 'RECONSTRUCTED ORIGIN', tip: 'The origin was reconstructed with moderate confidence, not declared by the source.' },
  RECONSTRUCTED_WEAK: { glyph: '◖', word: 'RECONSTRUCTED ORIGIN', tip: 'The origin was reconstructed with weak confidence, not declared by the source.' },
};

/** The three basis buckets a run's `source.basis` field can carry (`TerrainCoverageMode`-shaped, reused per SPEC §4). */
export type ObservatoryBasis = 'full' | 'resident-only' | 'sampled';

const BASIS_CHIPS: Readonly<Record<ObservatoryBasis, ChipSpec>> = {
  full: { glyph: '■', word: 'SOURCE COMPLETE', tip: 'Every declared ray of every station was traversed.' },
  'resident-only': { glyph: '□', word: 'RESIDENT ONLY', tip: 'Built only from the points that survived to the display cloud, not the source’s own no-return declarations.' },
  sampled: { glyph: '▣', word: 'SAMPLED', tip: 'A stride or threshold skipped some records; skipped voxels read NOT_READ, never SURFACE or OBSERVED_EMPTY.' },
};

const SUGGESTED_STATION_CHIP: ChipSpec = { glyph: '☆', word: 'SUGGESTED STATION', tip: 'A candidate next station — not observed, never entered into the evidence ledger.' };

export function originChip(status: ObservationOriginStatus): HTMLSpanElement {
  const spec = ORIGIN_CHIPS[status];
  return chip({ glyph: spec.glyph, word: spec.word, tip: spec.tip, className: CHIP_CLASS });
}

export function basisChip(basis: ObservatoryBasis): HTMLSpanElement {
  const spec = BASIS_CHIPS[basis];
  return chip({ glyph: spec.glyph, word: spec.word, tip: spec.tip, className: CHIP_CLASS });
}

export function suggestedStationChip(): HTMLSpanElement {
  return chip({ glyph: SUGGESTED_STATION_CHIP.glyph, word: SUGGESTED_STATION_CHIP.word, tip: SUGGESTED_STATION_CHIP.tip, className: CHIP_CLASS });
}

/** Every badge word OB-UI-02 declares, for the wording test's own allowlist. */
export const OBSERVATORY_BADGE_WORDS: readonly string[] = [
  ...Object.values(ORIGIN_CHIPS).map((c) => c.word),
  ...Object.values(BASIS_CHIPS).map((c) => c.word),
  SUGGESTED_STATION_CHIP.word,
];
