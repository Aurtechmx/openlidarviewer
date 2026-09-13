/**
 * guidanceStylesheetContracts.test.ts
 *
 * Pins stylesheet facts the guidance pass established, each one a rule that
 * was absent or wrong:
 *  - the phone sheet and mobile dock transitions honour reduced motion;
 *  - the layer-health breakpoint uses the shared 767 px edge, not 768;
 *  - a measurement handle shows itself on hover;
 *  - the corner grip's cursor matches its diagonal drag;
 *  - Process Studio badges carry a glyph beside the word.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = (name: string): string => readFileSync(`src/styles/${name}`, 'utf8');

/** The reduced-motion blocks in a sheet, joined. */
function reducedMotionBlocks(text: string): string {
  return [...text.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .join('\n');
}

describe('reduced motion reaches the phone surfaces', () => {
  it('the mobile sheet detent transition is disabled', () => {
    expect(reducedMotionBlocks(css('96-phone-sheet-story.css'))).toMatch(/\.olv-mobile-sheet[\s\S]*transition:\s*none/);
  });
  it('the mobile dock tool transitions are disabled', () => {
    expect(reducedMotionBlocks(css('99-mobile-gui-refresh.css'))).toMatch(/\.olv-dock \.olv-tool[\s\S]*transition:\s*none/);
  });
});

describe('breakpoints share one edge', () => {
  it('no stylesheet uses max-width: 768px', () => {
    for (const f of ['98-layer-health.css']) {
      expect(css(f)).not.toMatch(/max-width:\s*768px/);
    }
  });
});

describe('hover and cursor cues', () => {
  it('a measurement handle becomes visible on hover', () => {
    expect(css('70-measurement-panels.css')).toMatch(/\.olv-m-handle:hover\s*\{[^}]*fill:/);
  });
  it('the corner grip uses a diagonal resize cursor', () => {
    const rule = css('74-inspector-profile.css').match(/\.olv-mp-resize\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/cursor:\s*nwse-resize/);
    expect(rule).not.toMatch(/ew-resize/);
  });
});

describe('the findings ledger is styled at the panel scale', () => {
  it('every class the ledger emits has a rule, so nothing inherits the document default', () => {
    const sheet = css('90-converter-export.css');
    for (const cls of ['olv-findings-panel', 'olv-findings-head', 'olv-findings-list', 'olv-findings-actions',
      'olv-findings-status', 'olv-findings-empty', 'olv-findings-row', 'olv-findings-label',
      'olv-findings-value', 'olv-findings-confidence', 'olv-findings-caveats', 'olv-findings-remove']) {
      expect(sheet, `${cls} has no rule`).toMatch(new RegExp(`\\.${cls}\\b`));
    }
  });
  it('the ledger text uses the panel tokens, never a literal size', () => {
    const block = css('90-converter-export.css').match(/\.olv-findings-panel[\s\S]*?\.olv-findings-actions[^}]*\}/)?.[0] ?? '';
    expect(block).toMatch(/font-size:\s*var\(--text-xs\)/);
    expect(block).not.toMatch(/font-size:\s*\d+px/);
  });
});

describe('Process Studio badges carry a glyph beside the word', () => {
  it('ready, review and blocked each prefix a glyph', () => {
    const text = css('98b-process-studio.css');
    expect(text).toMatch(/\.olv-ps-ready \.olv-ps-badge::before\s*\{\s*content:\s*'✓ '/);
    expect(text).toMatch(/\.olv-ps-review \.olv-ps-badge::before\s*\{\s*content:\s*'⚠ '/);
    expect(text).toMatch(/\.olv-ps-blocked \.olv-ps-badge::before\s*\{\s*content:\s*'✕ '/);
  });
});
