/**
 * stateChip.ts
 *
 * How a canonical scientific state is PRESENTED. One vocabulary, authored once,
 * so the Dataset Story, Export Health and every other readiness surface name the
 * same condition the same way. The modules that COMPUTE state
 * (`intelligence/scanStory.ts`, the process plan, the export gates) stay pure
 * data and say nothing about glyphs.
 *
 * State is never carried by colour alone. Each state gets a shape-distinct
 * glyph, and the word is rendered beside it wherever there is room. A reader in
 * forced-colours mode, in greyscale print, or with any colour-vision deficiency
 * still reads the state from the glyph and the word; colour only reinforces
 * what those two already say.
 *
 * Nothing here interprets: callers pass the state the canonical model already
 * decided, and the two mappers below are literal translations of the existing
 * tier vocabularies, not fresh judgements.
 */

import { el } from './dom';
import type { FitnessTier, HealthTier } from '../intelligence/scanStory';

/** The presented states, in the order a reader ranks them. */
export type SciState =
  | 'measured'
  | 'preview'
  | 'review'
  | 'blocked'
  | 'withheld'
  | 'derived'
  | 'info';

/**
 * The state as a shape. Filled disc for a measured value, half disc for a
 * preview of one, triangle for something to look at, slashed circle for a
 * closed gate, diamond for a computed product, circled i for context.
 */
export const STATE_GLYPH: Record<SciState, string> = {
  measured: '●',
  preview: '◐',
  review: '▲',
  blocked: '⊘',
  withheld: '⊘',
  derived: '◇',
  info: 'ⓘ',
};

/** The state as a word, capitalised for display. */
export const STATE_LABEL: Record<SciState, string> = {
  measured: 'Measured',
  preview: 'Preview',
  review: 'Review',
  blocked: 'Blocked',
  withheld: 'Withheld',
  derived: 'Derived',
  info: 'Info',
};

/**
 * The accessible name for a state mark. The glyph is decoration to a screen
 * reader, so the name has to carry the state in words; `detail` appends the
 * caller's own context (the row it labels, the reason a gate is closed).
 */
export function stateAriaLabel(state: SciState, detail?: string): string {
  return detail ? `${STATE_LABEL[state]}: ${detail}` : STATE_LABEL[state];
}

/** Glyph and word together: the full-width form, used wherever it fits. */
export function renderStateChip(state: SciState, detail?: string): HTMLElement {
  const chip = el('span', {
    className: `olv-state is-${state}`,
    ariaLabel: stateAriaLabel(state, detail),
  });
  chip.setAttribute('role', 'img');
  chip.append(
    el('span', { className: 'olv-state-glyph', text: STATE_GLYPH[state] }),
    el('span', { className: 'olv-state-label', text: STATE_LABEL[state] }),
  );
  return chip;
}

/**
 * The glyph alone, for a row that already prints its own words. Same accessible
 * name as the full chip, so the state reaches a screen reader either way.
 */
export function renderStateGlyph(state: SciState, detail?: string): HTMLElement {
  const mark = el('span', {
    className: `olv-state olv-state--glyph is-${state}`,
    ariaLabel: stateAriaLabel(state, detail),
    text: STATE_GLYPH[state],
  });
  mark.setAttribute('role', 'img');
  return mark;
}

/** Export Health's per-axis tier, translated. */
export function stateFromHealthTier(tier: HealthTier): SciState {
  if (tier === 'good') return 'measured';
  if (tier === 'caution') return 'review';
  if (tier === 'blocked') return 'blocked';
  return 'info';
}

/** The Dataset Story's fitness tier, translated. */
export function stateFromFitnessTier(tier: FitnessTier): SciState {
  if (tier === 'Good') return 'measured';
  if (tier === 'Preview') return 'preview';
  if (tier === 'Limited') return 'review';
  if (tier === 'Blocked') return 'blocked';
  return 'info';
}
