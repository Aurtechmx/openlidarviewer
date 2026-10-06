/**
 * safeText.ts: text taken from a file made safe to write into another file.
 *
 * File names, CRS names and similar strings come from the input file, and a
 * newline in one of them would start a new line in a text header or a ZIP
 * entry name. One module replaces control characters and checks entry names,
 * so every writer uses the same rule.
 *
 * Pure data. No DOM, no I/O.
 */

/** C0 and C1 controls, DEL, NEL and the Unicode line and paragraph separators. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** `text` on one line: every control character, including CR and LF, becomes a space. */
export function singleLine(text: string): string {
  return text.replace(CONTROL, ' ');
}

/**
 * A file name safe to use as one ZIP entry or download name: any directory part
 * is dropped, controls and separators become underscores, a drive prefix is
 * removed, and a name made only of dots falls back to `fallback`.
 */
export function safeEntryName(name: string, fallback = 'file'): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const leaf = (slash >= 0 ? name.slice(slash + 1) : name)
    .replace(/^[A-Za-z]:/, '')
    .replace(CONTROL, '_')
    .trim();
  return /^\.*$/.test(leaf) ? fallback : leaf;
}

/**
 * Why a ZIP entry name cannot be written, or null when it can. A relative path
 * with `/` separators is allowed; controls, backslashes, a leading slash or
 * drive letter, empty segments and `.` or `..` segments are not.
 */
export function unsafeEntryName(name: string): string | null {
  if (name.length === 0) return 'the name is empty';
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return 'the name contains a control character';
  if (name.includes('\\')) return 'the name contains a backslash';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'the name is an absolute path';
  for (const part of name.split('/')) {
    if (part === '' || part === '.' || part === '..') return 'the name has an empty, "." or ".." path segment';
  }
  return null;
}
