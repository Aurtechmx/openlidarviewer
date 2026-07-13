/**
 * docsSiteStripComments.test.ts
 *
 * Pins the docs-site comment-stripping markdown rule
 * (docs-site/.vitepress/stripHtmlComments.mts). The site renders the
 * canonical repo markdown with `html: false`, which makes markdown-it escape
 * raw HTML into visible text — correct for prose angle brackets, but it would
 * surface every HTML comment (the `<!-- #region -->` markers in
 * docs/usage.md, the AUTO-GENERATED header of claim-register.generated.md)
 * as literal `<!-- ... -->` paragraphs on the published page. GitHub hides
 * comments; the site must hide them the same way.
 *
 * The rendering tests go through VitePress's real markdown factory
 * (`createMarkdownRenderer`) rather than a bare markdown-it, so the rule is
 * proven against the exact plugin stack the site builds with.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMarkdownRenderer } from 'vitepress';
import {
  stripHtmlComments,
  stripCommentsOutsideCode,
} from '../docs-site/.vitepress/stripHtmlComments.mts';

const md = await createMarkdownRenderer(
  'docs-site',
  { html: false, config: stripHtmlComments },
  '/',
);

const render = (src: string): string =>
  md.render(src, { path: 'test.md', relativePath: 'test.md', cleanUrls: false });

describe('stripCommentsOutsideCode (pure)', () => {
  it('removes a single-line comment', () => {
    expect(stripCommentsOutsideCode('a <!-- gone --> b')).toBe('a  b');
  });

  it('removes a multi-line comment', () => {
    expect(stripCommentsOutsideCode('a <!-- line one\nline two --> b')).toBe('a  b');
  });

  it('leaves a comment inside an inline code span intact', () => {
    const src = 'Markers look like `<!-- #region name -->` in the source.';
    expect(stripCommentsOutsideCode(src)).toBe(src);
  });

  it('leaves an @include directive intact so the unresolved-include guard still fires', () => {
    const src = '<!--@include: ./missing.md-->';
    expect(stripCommentsOutsideCode(src)).toBe(src);
  });

  it('strips a comment that carries an inline code span inside it', () => {
    // The generated claim-register header has this shape: the comment opens
    // before the backticks, so the comment wins and the whole thing goes.
    const src = '<!-- edit the YAML and run `npm run docs:render` to refresh --> table';
    expect(stripCommentsOutsideCode(src)).toBe(' table');
  });

  it('leaves an unterminated opener visible for the lint guard to catch', () => {
    const src = 'before <!-- never closed';
    expect(stripCommentsOutsideCode(src)).toBe(src);
  });
});

describe('docs-site markdown pipeline hides HTML comments', () => {
  it('drops a standalone region marker without leaving an empty paragraph', () => {
    const html = render('before\n\n<!-- #region embed-reference -->\n\nafter');
    expect(html).not.toContain('&lt;!--');
    expect(html).not.toContain('#region');
    expect(html).not.toContain('<p></p>');
    expect(html).toContain('<p>after</p>');
  });

  it('strips markers and the explanatory note glued to real prose (docs/usage.md shape)', () => {
    // Mirrors docs/usage.md lines 97–102: marker, multi-line note, prose, and
    // the end marker all in one contiguous block with no blank lines.
    const src = [
      '<!-- #region session-reference -->',
      '<!-- The region markers on this page let the docs site include these',
      '     sections verbatim. Keep the markers when editing. -->',
      '**Session round-trip.** The session Export saves the full working state.',
      '<!-- #endregion session-reference -->',
    ].join('\n');
    const html = render(src);
    expect(html).toContain('Session round-trip');
    expect(html).toContain('saves the full working state');
    expect(html).not.toContain('&lt;!--');
    expect(html).not.toContain('region markers on this page');
  });

  it('drops the generated claim-register header comment but keeps the table', () => {
    const src = [
      '<!--',
      '  claim-register.generated.md — AUTO-GENERATED. DO NOT EDIT.',
      '-->',
      '',
      '| Claim | Product |',
      '| --- | --- |',
      '| `MEAS-DISTANCE` | Distance measurement |',
    ].join('\n');
    const html = render(src);
    expect(html).toContain('MEAS-DISTANCE');
    expect(html).not.toContain('AUTO-GENERATED');
    expect(html).not.toContain('&lt;!--');
  });

  it('keeps an unresolved @include visible for the lint guard to catch', () => {
    // VitePress resolves real includes before markdown-it runs; one that
    // reaches the renderer is a broken include, and lint-docs-site.mjs keys
    // on the literal '@include:' text in built pages to fail the build.
    const html = render('<!--@include: ./missing.md-->');
    expect(html).toContain('@include:');
  });

  it('still SHOWS a comment inside inline code', () => {
    const html = render('Use `<!-- #region name -->` to mark a region.');
    expect(html).toContain('&lt;!--');
    expect(html).toContain('#region name');
  });

  it('still SHOWS a comment inside a fenced code block', () => {
    const html = render('```html\n<!-- shown in example -->\n```');
    // Shiki escapes `<` as `&#x3C;` rather than `&lt;`; the load-bearing
    // assertion is that the fence token was never touched by the rule.
    expect(html).toContain('shown in example');
    expect(html).toMatch(/&#x3C;!--|&lt;!--/);
  });

  it('keeps escaping prose angle brackets (the reason html:false exists)', () => {
    const html = render('Declared: <value> in the header.');
    expect(html).toContain('&lt;value&gt;');
  });
});

describe('rendering the real published sources', () => {
  it('docs/usage.md renders with zero visible comment text', () => {
    const src = readFileSync(new URL('../docs/usage.md', import.meta.url), 'utf8');
    const html = render(src);
    expect(html).not.toContain('&lt;!--');
    expect(html).not.toContain('#region');
    expect(html).toContain('Session round-trip');
  });

  it('claim-register.generated.md renders with zero visible comment text', () => {
    const src = readFileSync(
      new URL('../docs-site/validation/claim-register.generated.md', import.meta.url),
      'utf8',
    );
    const html = render(src);
    expect(html).not.toContain('&lt;!--');
    expect(html).not.toContain('AUTO-GENERATED');
    expect(html).toContain('MEAS-DISTANCE');
  });
});
