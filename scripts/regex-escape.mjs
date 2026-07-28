/**
 * Escape every regular-expression metacharacter in a literal string.
 *
 * Several gates build a RegExp around a version number to find a heading or an
 * archive name. Those call sites escaped `.` and nothing else, which is correct
 * for the versions shipped so far and silently wrong for any that carries a
 * metacharacter: a `+build` suffix would make the `+` a quantifier, and the
 * gate would stop matching the heading it exists to check rather than report a
 * failure. Escaping the full set removes the class of bug instead of the one
 * instance of it.
 */
export function escapeRegExp(literal) {
  return String(literal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
