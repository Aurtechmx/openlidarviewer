/**
 * Markdown rendering of the defect replay commands.
 *
 * The replay puts each probe's shell command into an inline code span. Two
 * things broke there and both made `verify-defect-replay.mjs` refuse to
 * recompute replay.md:
 *
 *   - the table-cell escaper was applied to code-span content, doubling every
 *     backslash, so a `-t "\"vertical\""` selector rendered as `\\"vertical\\"`
 *     and the printed command would not run;
 *   - a command containing a backtick was wrapped in a single-backtick span,
 *     which the backtick closes early.
 *
 * Code spans get no backslash processing in CommonMark, so their content goes
 * in verbatim and only the fence width has to adapt.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no types
import { mdCode, mdCell, lf } from '../scripts/defect-replay-lib.mjs';

// The exact selector from tests/benchmark/failureRecovery.test.ts that the
// replay renders, quotes and backslashes included.
const VERTICAL_COMMAND =
  'npx vitest run tests/benchmark/failureRecovery.test.ts -t '
  + '"a vertical slope reads \\"vertical\\" in the report, the same word the live tool uses" '
  + '--reporter=json --outputFile=<reporter-output> --reporter=default --testTimeout=600000';

// The selector from tests/benchmark/provenanceIntegrity.test.ts, whose title
// contains a backtick.
const PROTO_COMMAND =
  'npx vitest run tests/benchmark/provenanceIntegrity.test.ts -t '
  + '"a benchmark artifact keyed `__proto__` keeps a distinct hash" '
  + '--reporter=json --outputFile=<reporter-output> --reporter=default --testTimeout=600000';

/** Content of the outermost code span, or null when the fence is unbalanced. */
function codeSpanContent(rendered: string): string | null {
  const open = /^(`+)/.exec(rendered);
  if (!open) return null;
  const fence = open[1];
  if (!rendered.endsWith(fence)) return null;
  const inner = rendered.slice(fence.length, rendered.length - fence.length);
  // A fence of width n is closed by the first run of exactly n backticks.
  const closesEarly = new RegExp(`(?<!\`)\`{${fence.length}}(?!\`)`).test(inner);
  if (closesEarly) return null;
  // CommonMark strips one leading and one trailing space when both are present
  // and the content is not all spaces. That is what lets a span hold a literal
  // backtick at either end.
  const padded = inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '';
  return padded ? inner.slice(1, -1) : inner;
}

describe('defect replay markdown command rendering', () => {
  it('keeps backslash-escaped quotes in a command exactly as the raw record holds them', () => {
    const rendered = mdCode(VERTICAL_COMMAND);
    expect(rendered).toContain('-t "a vertical slope reads \\"vertical\\" in the report');
    expect(rendered).not.toContain('\\\\"vertical\\\\"');
    expect(codeSpanContent(rendered)).toBe(VERTICAL_COMMAND);
  });

  it('widens the fence so a command containing a backtick stays inside one span', () => {
    const rendered = mdCode(PROTO_COMMAND);
    expect(rendered.startsWith('``')).toBe(true);
    expect(codeSpanContent(rendered)).toBe(PROTO_COMMAND);
  });

  it('renders a command that is only backticks without swallowing them', () => {
    expect(codeSpanContent(mdCode('`'))).toBe('`');
    expect(codeSpanContent(mdCode('a ``` b'))).toBe('a ``` b');
  });

  it('does not escape backslashes inside a code span, unlike a table cell', () => {
    expect(mdCode('a \\ b')).toBe('`a \\ b`');
    expect(mdCell('a \\ b')).toBe('a \\\\ b');
  });

  it('flattens newlines so a command cannot break out of its span', () => {
    expect(codeSpanContent(mdCode('one\ntwo'))).toBe('one two');
  });

  it('normalises CRLF and lone CR to LF so a Windows capture renders the same bytes', () => {
    expect(lf('a\r\nb\rc')).toBe('a\nb\nc');
    expect(mdCode('a\r\nb')).toBe(mdCode('a\nb'));
    expect(mdCell('a\r\nb')).toBe(mdCell('a\nb'));
  });
});
