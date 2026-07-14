import type { MarkdownOptions } from 'vitepress';

/**
 * stripHtmlComments — hide HTML comments on pages rendered with `html: false`.
 *
 * The site renders the canonical repo markdown with raw HTML disabled (see
 * config.mts), which makes markdown-it treat `<` as plain text and escape it.
 * That is right for prose angle brackets ("Declared: <value>") but wrong for
 * HTML comments: the `<!-- #region -->` markers in docs/usage.md and the
 * AUTO-GENERATED header of claim-register.generated.md would surface as
 * visible `<!-- ... -->` paragraphs on the published page. GitHub hides
 * comments, so the canonical files legitimately rely on them; the site must
 * hide them the same way rather than force the canonical copies to give
 * them up.
 *
 * The rule runs after the block parser, so fenced code blocks are already
 * separated into their own tokens and are never touched — a code example can
 * still SHOW a comment. Within prose, comment spans are removed from each
 * inline token's raw content before inline parsing; inline code spans are
 * protected by segmenting on backtick runs first.
 *
 * Unresolved `<!--@include: ...-->` directives are deliberately left alone:
 * VitePress resolves real includes before markdown-it ever runs, so one that
 * survives to this point is a broken include, and scripts/lint-docs-site.mjs
 * keys on that literal text in built pages to fail the build instead of
 * letting it ship silently.
 */

/** A comment opener — except an include directive (see above). */
const COMMENT_OPEN = /<!--(?!\s*@include:)/g;

/**
 * Inline code spans, mirroring markdown-it's rule that a span opens with a
 * backtick run and closes on the next run of the same length. A close
 * approximation is enough here: an unmatched run simply falls through to the
 * prose path, which is also what markdown-it does with a stray backtick.
 */
const CODE_SPAN = /(`+)[\s\S]*?\1(?!`)/g;

/**
 * Strip comment spans from prose, leaving inline code spans intact.
 *
 * A single left-to-right scan decides precedence by whichever construct
 * opens first — matching how raw HTML works: a code span that begins before
 * a `<!--` protects it (a doc can SHOW comment syntax in inline code), while
 * a comment that begins first swallows everything to its `-->`, including
 * any backticks inside it (the generated claim-register header carries an
 * inline-code phrase inside its comment). An opener with no closer is left
 * visible on purpose: it is malformed, and scripts/lint-docs-site.mjs fails
 * the build on visible comment text rather than eating content silently.
 */
export function stripCommentsOutsideCode(content: string): string {
  let out = '';
  let p = 0;
  while (p < content.length) {
    COMMENT_OPEN.lastIndex = p;
    const open = COMMENT_OPEN.exec(content);
    if (open === null) {
      out += content.slice(p);
      break;
    }
    CODE_SPAN.lastIndex = p;
    const span = CODE_SPAN.exec(content);
    if (span !== null && span.index < open.index) {
      out += content.slice(p, span.index + span[0].length);
      p = span.index + span[0].length;
      continue;
    }
    const close = content.indexOf('-->', open.index + 4);
    if (close === -1) {
      out += content.slice(p);
      break;
    }
    out += content.slice(p, open.index);
    p = close + 3;
  }
  return out;
}

/**
 * The markdown-it instance type is derived from VitePress's own option
 * surface rather than imported from `markdown-it`, so this module tracks
 * whatever markdown-it version the pinned VitePress ships.
 */
type MarkdownIt = Parameters<NonNullable<MarkdownOptions['config']>>[0];

export function stripHtmlComments(md: MarkdownIt): void {
  md.core.ruler.after('block', 'olv_strip_html_comments', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== 'inline') continue;
      const stripped = stripCommentsOutsideCode(token.content);
      if (stripped === token.content) continue;
      if (
        stripped.trim() === '' &&
        tokens[i - 1]?.type === 'paragraph_open' &&
        tokens[i + 1]?.type === 'paragraph_close'
      ) {
        // A block that was nothing but comments (a bare region marker line,
        // the generated-file header) disappears entirely rather than leaving
        // an empty <p> in the page flow.
        tokens.splice(i - 1, 3);
        i -= 2;
      } else {
        token.content = stripped.trim();
      }
    }
  });
}
