/**
 * tests/htmlComments.test.ts
 *
 * commentRanges() decides which markup the CSP and asset lints are allowed to
 * ignore, so anything it calls a comment is invisible to both. When it treated
 * `-->` as the only terminator, `<!-->`, `<!--->` and `--!>` each left it with
 * no terminator to find, and it marked the rest of the document as comment:
 * `<!--><script>init()</script>` appended to a shipped page passed
 * lint:csp-html while the deployed page carried an inline script that
 * script-src refuses.
 *
 * These cases pin the tokenizer's four comment terminators, the end-of-input
 * behaviour a browser also has, and the fact that quoting does not protect a
 * `-->` inside comment text.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs helper shared with the lint scripts, no types
import { commentRanges, insideComment, matchesOutsideComments } from '../scripts/lib/htmlComments.mjs';

type Range = [number, number];

/** What the CSP lint counts: inline <script> tags the helper does not hide. */
function visibleScripts(html: string): number {
  return (matchesOutsideComments(html, /<script\b[^>]*>/gi) as unknown[]).length;
}

describe('commentRanges', () => {
  it('treats <!--> as a complete empty comment', () => {
    const html = '<!--><script>x</script>';
    expect(commentRanges(html) as Range[]).toEqual([[0, 5]]);
    expect(visibleScripts(html)).toBe(1);
  });

  it('treats <!---> as a complete empty comment', () => {
    const html = '<!---><script>x</script>';
    expect(commentRanges(html) as Range[]).toEqual([[0, 6]]);
    expect(visibleScripts(html)).toBe(1);
  });

  it('closes a comment on --!>', () => {
    const html = '<!-- n --!><script>x</script>';
    expect(commentRanges(html) as Range[]).toEqual([[0, 11]]);
    expect(visibleScripts(html)).toBe(1);
  });

  it('closes a comment on -->', () => {
    const html = '<!-- n --><script>x</script>';
    expect(commentRanges(html) as Range[]).toEqual([[0, 10]]);
    expect(visibleScripts(html)).toBe(1);
  });

  it('does not nest: an inner <!-- is comment text, and the first --> ends both', () => {
    const html = '<!-- <!-- --><script>x</script>';
    expect(commentRanges(html) as Range[]).toEqual([[0, 13]]);
    expect(visibleScripts(html)).toBe(1);
  });

  it('runs an unterminated comment to the end of input, as a browser does', () => {
    const html = '<p>a</p><!-- never closed <script>x</script>';
    expect(commentRanges(html) as Range[]).toEqual([[8, html.length]]);
    expect(visibleScripts(html)).toBe(0);
  });

  it('ends at a --> inside quoted comment text, because the tokenizer ignores quotes', () => {
    const html = '<!-- a "-->" b --><script>x</script>';
    // The comment stops at the first -->, so `" b -->` is markup and the
    // <script> that follows is visible.
    expect(commentRanges(html) as Range[]).toEqual([[0, 11]]);
    expect(visibleScripts(html)).toBe(1);
  });

  it('finds every comment in a document with several', () => {
    const html = '<a><!--one--><b><!--two--><c><!--three-->';
    expect(commentRanges(html) as Range[]).toEqual([
      [3, 13],
      [16, 26],
      [29, 41],
    ]);
  });

  it('returns nothing for a document with no comments', () => {
    const html = '<p>plain markup, 4 > 3, a--b</p>';
    expect(commentRanges(html) as Range[]).toEqual([]);
    expect(insideComment([], 0)).toBe(false);
  });
});

describe('insideComment', () => {
  it('treats a span as half-open: the opening offset is in, the closing one is out', () => {
    const ranges = commentRanges('<!-- x -->y') as Range[];
    expect(insideComment(ranges, 0)).toBe(true);
    expect(insideComment(ranges, 9)).toBe(true);
    expect(insideComment(ranges, 10)).toBe(false);
  });
});
