/**
 * htmlComments.mjs — locate HTML comments without rewriting the document.
 *
 * The obvious way to ignore commented-out markup is to delete comments with a
 * regex and inspect what remains. Two reasons not to.
 *
 * Static analysis reads that replace as sanitisation, because it is the exact
 * shape of an incomplete multi-character escape. Here nothing is rendered, so
 * it is not a vulnerability, but a checker cannot know that and the warning is
 * noise on every future run.
 *
 * The stronger reason: deleting text can reveal markup that was not there
 * before, so a page could hide an inline script from a checker that counts what
 * survives the delete. A guard that can be walked around is worth less than the
 * confidence it creates.
 *
 * So the document is never modified. Comment spans are located once and callers
 * ask whether an offset falls inside one.
 *
 * An unterminated comment runs to the end of input, matching how a browser
 * treats it: everything after it is comment, not markup.
 */

/** Half-open [start, end) spans covering every comment in `html`. */
export function commentRanges(html) {
  const ranges = [];
  let from = 0;
  for (;;) {
    const open = html.indexOf('<!--', from);
    if (open === -1) break;
    const close = html.indexOf('-->', open + 4);
    if (close === -1) {
      ranges.push([open, html.length]);
      break;
    }
    ranges.push([open, close + 3]);
    from = close + 3;
  }
  return ranges;
}

/** Whether `index` sits inside any comment span. */
export function insideComment(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Matches of `pattern` that are not inside a comment.
 *
 * `pattern` must be global. Returns the RegExp match objects so a caller keeps
 * both the captured groups and the offset.
 */
export function matchesOutsideComments(html, pattern) {
  const ranges = commentRanges(html);
  const kept = [];
  for (const m of html.matchAll(pattern)) {
    if (!insideComment(ranges, m.index)) kept.push(m);
  }
  return kept;
}
