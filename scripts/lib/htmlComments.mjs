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
 *
 * `-->` is not the only terminator. The HTML tokenizer also closes a comment on
 * `--!>`, and treats `<!-->` and `<!--->` as complete empty comments. Searching
 * for `-->` alone finds no terminator in those three cases and marks the rest of
 * the document as comment, which hides every later <script> and every later
 * href from the checks built on this file. The end of a comment is therefore
 * found by walking the tokenizer's comment states below.
 */

/**
 * Exclusive end offset of the comment whose `<!--` ends at `after`.
 *
 * State names follow the HTML Standard's comment states so the transitions can
 * be read against the spec.
 */
function commentEnd(html, after) {
  let state = 'start';
  for (let i = after; i < html.length; i++) {
    const ch = html[i];
    switch (state) {
      case 'start': // comment start: `>` here closes an empty comment
        if (ch === '-') state = 'startDash';
        else if (ch === '>') return i + 1;
        else state = 'body';
        break;
      case 'startDash': // comment start dash: `>` here also closes
        if (ch === '-') state = 'end';
        else if (ch === '>') return i + 1;
        else state = 'body';
        break;
      case 'body':
        if (ch === '-') state = 'endDash';
        break;
      case 'endDash':
        state = ch === '-' ? 'end' : 'body';
        break;
      case 'end':
        if (ch === '>') return i + 1;
        else if (ch === '!') state = 'endBang';
        else if (ch === '-') state = 'end';
        else state = 'body';
        break;
      case 'endBang': // reached on `--!`
        if (ch === '>') return i + 1;
        else if (ch === '-') state = 'endDash';
        else state = 'body';
        break;
      /* c8 ignore next 2 */
      default:
        state = 'body';
    }
  }
  return html.length;
}

/** Half-open [start, end) spans covering every comment in `html`. */
export function commentRanges(html) {
  const ranges = [];
  let from = 0;
  for (;;) {
    const open = html.indexOf('<!--', from);
    if (open === -1) break;
    const end = commentEnd(html, open + 4);
    ranges.push([open, end]);
    if (end >= html.length) break;
    from = end;
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
