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

/**
 * The one mark builder. `withLabel` decides whether the word is rendered beside
 * the glyph; both forms carry the same class, role and accessible name, so the
 * state reaches a screen reader identically either way.
 */
function mark(state: SciState, detail: string | undefined, withLabel: boolean): HTMLElement {
  const node = el('span', {
    className: `olv-state${withLabel ? '' : ' olv-state--glyph'} is-${state}`,
    ariaLabel: stateAriaLabel(state, detail),
  });
  node.setAttribute('role', 'img');
  node.append(el('span', { className: 'olv-state-glyph', text: STATE_GLYPH[state] }));
  if (withLabel) node.append(el('span', { className: 'olv-state-label', text: STATE_LABEL[state] }));
  return node;
}

/** Glyph and word together: the full-width form, used wherever it fits. */
export function renderStateChip(state: SciState, detail?: string): HTMLElement {
  return mark(state, detail, true);
}

/** The glyph alone, for a row that already prints its own words. */
export function renderStateGlyph(state: SciState, detail?: string): HTMLElement {
  return mark(state, detail, false);
}

/**
 * Export Health's per-axis tiers and the Dataset Story's fitness tiers, as
 * lookup tables. Translation, not judgement: the canonical model already
 * decided the tier, and these only say which mark presents it.
 */
const HEALTH_TIER_STATE: Record<HealthTier, SciState> = {
  good: 'measured',
  caution: 'review',
  blocked: 'blocked',
  info: 'info',
};

const FITNESS_TIER_STATE: Record<FitnessTier, SciState> = {
  Good: 'measured',
  Preview: 'preview',
  Limited: 'review',
  Blocked: 'blocked',
  Unknown: 'info',
};

/** Export Health's per-axis tier, translated. */
export function stateFromHealthTier(tier: HealthTier): SciState {
  return HEALTH_TIER_STATE[tier];
}

/** The Dataset Story's fitness tier, translated. */
export function stateFromFitnessTier(tier: FitnessTier): SciState {
  return FITNESS_TIER_STATE[tier];
}
