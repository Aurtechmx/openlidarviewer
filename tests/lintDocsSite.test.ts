/**
 * lintDocsSite.test.ts
 *
 * Pins the escaped-comment guard in scripts/lint-docs-site.mjs. The site
 * renders canonical markdown with `html: false`, so a raw HTML comment that
 * escapes the stripping rule (docs-site/.vitepress/stripHtmlComments.mts)
 * would ship as visible `&lt;!--` text on a published page. lint-docs-site's
 * @include grep cannot see that class, so the built-output check must fail on
 * it directly — while still allowing code examples (inline code and fenced
 * blocks) to legitimately SHOW comment syntax. Guards the guard, mirroring
 * lintUnsafeHtml.test.ts.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations.
import { htmlShowsEscapedComment } from '../scripts/lint-docs-site.mjs';

describe('lint-docs-site htmlShowsEscapedComment', () => {
  it('flags an escaped comment in visible prose', () => {
    expect(htmlShowsEscapedComment('<p>&lt;!-- #region session-reference --&gt;</p>')).toBe(true);
  });

  it('flags the escaped AUTO-GENERATED header shape', () => {
    const html = '<p>&lt;!--\nclaim-register.generated.md — AUTO-GENERATED. DO NOT EDIT.\n--&gt;</p>';
    expect(htmlShowsEscapedComment(html)).toBe(true);
  });

  it('allows a comment shown inside inline code', () => {
    expect(htmlShowsEscapedComment('<p>Use <code>&lt;!-- #region --&gt;</code> markers.</p>')).toBe(
      false,
    );
  });

  it('allows a comment shown inside a fenced block (shiki output nests spans in pre)', () => {
    const html =
      '<pre class="shiki"><code><span class="line"><span>&lt;!-- shown --&gt;</span></span></code></pre>';
    expect(htmlShowsEscapedComment(html)).toBe(false);
  });

  it('passes a clean page', () => {
    expect(htmlShowsEscapedComment('<p>Declared: &lt;value&gt; in the header.</p>')).toBe(false);
  });
});
