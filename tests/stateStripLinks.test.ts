import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/app/fullFileActions.css', 'utf8');
const rule = (sel: string): string => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
};

describe('state strip sample action links', () => {
  const slot = rule('.olv-ss-fullfile');
  const link = rule('.olv-ss-fullfile .olv-fullfile-link');

  it('lays the two links out as separate flex items with a gap', () => {
    expect(slot).toMatch(/display:\s*inline-flex/);
    expect(slot).toMatch(/gap:\s*var\(--space-/);
  });

  it('sets the strip type size on the slot and inherits it in the links', () => {
    expect(slot).toMatch(/font:\s*500 var\(--text-xs\)/);
    expect(slot).not.toMatch(/font-size:\s*inherit/);
    expect(link).toMatch(/font:\s*inherit/);
  });

  it('gives coarse pointers a 44 px target and forced colors a link color', () => {
    expect(css).toMatch(/pointer: coarse[^{]*\{\s*\.olv-ss-fullfile \.olv-fullfile-link \{ min-height: 44px/);
    expect(css).toMatch(/forced-colors: active[\s\S]*LinkText/);
  });
});
