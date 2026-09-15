/**
 * stateChip.test.ts
 *
 * The scientific-state presenter. Two properties are pinned: every state has a
 * DISTINCT glyph and a word (so the state survives greyscale, forced colours
 * and every colour-vision deficiency), and the two tier mappers are literal
 * translations of the vocabularies that already exist rather than fresh
 * judgements about readiness.
 */

import { describe, it, expect, beforeAll } from 'vitest';

class FakeEl {
  className = '';
  private _text = '';
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

const {
  STATE_GLYPH, STATE_LABEL, stateAriaLabel, renderStateChip, renderStateGlyph,
  stateFromHealthTier, stateFromFitnessTier,
} = await import('../src/ui/stateChip');

describe('the state vocabulary', () => {
  it('gives every state a word', () => {
    for (const [state, label] of Object.entries(STATE_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
      expect(STATE_GLYPH[state as keyof typeof STATE_GLYPH]).toBeTruthy();
    }
  });

  it('separates the states that mean different things by shape', () => {
    // 'withheld' deliberately shares the closed-gate mark with 'blocked': both
    // say the value is not available to claim. Every other state is distinct.
    const distinct = new Set(
      Object.entries(STATE_GLYPH).filter(([s]) => s !== 'withheld').map(([, g]) => g),
    );
    expect(distinct.size).toBe(Object.keys(STATE_GLYPH).length - 1);
  });

  it('names the state in words for a screen reader, with the caller context', () => {
    expect(stateAriaLabel('blocked')).toBe('Blocked');
    expect(stateAriaLabel('review', 'Coverage')).toBe('Review: Coverage');
  });
});

describe('the rendered chip', () => {
  it('carries glyph, word, the state class and an accessible name', () => {
    const chip = renderStateChip('preview', 'DTM') as unknown as FakeEl;
    expect(chip.className).toContain('olv-state');
    expect(chip.className).toContain('is-preview');
    expect(chip.attrs.role).toBe('img');
    expect(chip.attrs['aria-label']).toBe('Preview: DTM');
    expect(chip.textContent).toContain(STATE_GLYPH.preview);
    expect(chip.textContent).toContain('Preview');
  });

  it('the glyph-only form still names the state to a screen reader', () => {
    const mark = renderStateGlyph('blocked', 'Georeferencing') as unknown as FakeEl;
    expect(mark.textContent).toBe(STATE_GLYPH.blocked);
    expect(mark.attrs['aria-label']).toBe('Blocked: Georeferencing');
    expect(mark.attrs.role).toBe('img');
  });
});

describe('the existing tiers translate, they are not re-judged', () => {
  it('maps the Export Health tiers', () => {
    expect(stateFromHealthTier('good')).toBe('measured');
    expect(stateFromHealthTier('caution')).toBe('review');
    expect(stateFromHealthTier('blocked')).toBe('blocked');
    expect(stateFromHealthTier('info')).toBe('info');
  });

  it('maps the Dataset Story fitness tiers', () => {
    expect(stateFromFitnessTier('Good')).toBe('measured');
    expect(stateFromFitnessTier('Preview')).toBe('preview');
    expect(stateFromFitnessTier('Limited')).toBe('review');
    expect(stateFromFitnessTier('Blocked')).toBe('blocked');
    expect(stateFromFitnessTier('Unknown')).toBe('info');
  });
});
