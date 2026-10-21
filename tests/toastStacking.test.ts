/**
 * The open toast shares the stage overlay with the start screen. With no
 * stacking order the start screen, later in the document, painted its title
 * over a refusal shown while it was still up. The toast takes the raised layer
 * the tokens name for it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../src/styles/45-dock-and-panels.css', import.meta.url)), 'utf8');
const tokens = readFileSync(fileURLToPath(new URL('../src/styles/01-tokens.css', import.meta.url)), 'utf8');

describe('open toast stacking', () => {
  it('sits on the raised layer, above the start screen', () => {
    const rule = /\n\.olv-toast \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/z-index:\s*var\(--z-raised\)/);
    expect(tokens).toMatch(/--z-raised:\s*70;.*progress toast/);
  });
});
