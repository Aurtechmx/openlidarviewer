/**
 * codeUnitOrder.mjs. One string comparator for orderings that reach a
 * committed record.
 *
 * Static analysis flags `.sort()` without a comparator and suggests
 * `String.localeCompare`. That advice is wrong for every ordering in this
 * directory. `localeCompare` orders by collation, which depends on the runtime
 * locale and on the ICU build behind it, so darwin-arm64 and linux-x64 can
 * order the same keys differently. The scripts here write snapshots, replay
 * transcripts, defect summaries and portability records that are committed and
 * re-derived on other machines, so a locale-dependent order turns a matching
 * record into a false mismatch.
 *
 * `compareCodeUnits` is UTF-16 code-unit order, the same order a default
 * `.sort()` on strings produces, fixed by the language spec and identical on
 * every host. It is written out rather than left implicit so the ordering is
 * stated in the code and the scanner has its comparator.
 *
 * The other half of the rule the scanner enforces, that a default `.sort()`
 * compares numbers as strings, is a real defect. This comparator does not
 * address it: it is for strings. Numeric arrays need `(a, b) => a - b`.
 *
 * The TypeScript tree has its own copy of this comparator in
 * `src/canonicalHash.ts`, exported as `compareCodeUnits`. The two are separate
 * because a `.ts` module cannot import a `.mjs` script helper without pulling
 * the scripts directory into the application build. They are three lines each
 * and they must stay in agreement.
 */

/** UTF-16 code-unit order. Locale-independent, so a committed order is stable. */
export function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
