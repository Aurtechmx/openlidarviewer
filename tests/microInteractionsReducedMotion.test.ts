import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * tests/microInteractionsReducedMotion.test.ts
 *
 * The health-status dots pulse on an INFINITE animation and the chrome panels
 * slide in on mount. A viewer who asked the OS to reduce motion must get neither
 * — so 55-micro-interactions.css has to carry a `prefers-reduced-motion` guard,
 * like the other section files already do. This pins that guard so it can't be
 * dropped in a later edit.
 */
const css = readFileSync(
  fileURLToPath(new URL('../src/styles/55-micro-interactions.css', import.meta.url)),
  'utf8',
);

describe('55-micro-interactions.css reduced-motion guard', () => {
  it('declares a prefers-reduced-motion: reduce block', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it('silences the infinite health-dot pulse under reduced motion', () => {
    // The block must set animation:none for the status dots. Extract the block
    // and confirm both the selector and the reset are inside it.
    const block = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(block).toContain('.olv-status-fail');
    expect(block).toMatch(/animation:\s*none/);
  });

  it('still defines the infinite pulse it is guarding (guard is not vacuous)', () => {
    expect(css).toMatch(/olv-dot-pulse[^;]*infinite/);
  });
});
