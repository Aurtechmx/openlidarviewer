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
const CONTROL_CLASS = '\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029';
/**
 * Characters that change how text displays without showing: bidi embeddings,
 * overrides and isolates, the LRM, RLM and Arabic letter marks, zero-width
 * spaces and joiners, the word joiner and invisible operators, the soft hyphen,
 * the Mongolian vowel separator and the byte-order mark. A name holding "gpj.las" behind a right-to-left
 * override reads as a different file type.
 */
const INVISIBLE_CLASS = '\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff';
const CONTROL = new RegExp(`[${CONTROL_CLASS}]`, 'g');
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, 'g');
const UNSAFE_CHAR = new RegExp(`[${CONTROL_CLASS}${INVISIBLE_CLASS}]`);

/** Characters Windows does not allow in a file name, beside the separators. */
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/g;
/** Device names Windows reserves, with or without an extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])\s*(\.|$)/i;

/**
 * Longest entry name, in UTF-8 bytes. Common file systems allow 255 bytes per
 * name; callers append suffixes such as "-scientific-artifact-passport.json"
 * (34 bytes) or a " (12)" de-duplication to a sanitised basename, so 200 leaves
 * room for those.
 */
export const MAX_ENTRY_NAME_BYTES = 200;

/** Dots and spaces Windows drops from the end of a name. */
const TRAILING = /[. ]+$/;

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/**
 * `text` on one line: every control character, including CR and LF, becomes a
 * space, and invisible bidi and zero-width characters are removed.
 */
export function singleLine(text: string): string {
  return text.replace(CONTROL, ' ').replace(INVISIBLE, '');
}

/** Cut `name` to `MAX_ENTRY_NAME_BYTES`, keeping a short extension and whole code points. */
function capBytes(name: string): string {
  if (utf8Length(name) <= MAX_ENTRY_NAME_BYTES) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  const budget = MAX_ENTRY_NAME_BYTES - utf8Length(ext);
  let stem = '';
  for (const ch of name.slice(0, name.length - ext.length)) {
    if (utf8Length(stem + ch) > budget) break;
    stem += ch;
  }
  return stem + ext;
}

/**
 * A file name safe to use as one ZIP entry or download name on any common
 * system. Any directory part is dropped. Controls, Windows-reserved characters
 * (including ":", so "C:x.las" becomes "C_x.las") become underscores, invisible
 * characters are removed, trailing dots and spaces are trimmed, a Windows device
 * name gains a leading underscore, and the result is capped at
 * `MAX_ENTRY_NAME_BYTES`. A name with nothing left but dots falls back to
 * `fallback`.
 */
export function safeEntryName(name: string, fallback = 'file'): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  let leaf = (slash >= 0 ? name.slice(slash + 1) : name)
    .replace(CONTROL, '_')
    .replace(INVISIBLE, '')
    .replace(WINDOWS_RESERVED_CHARS, '_')
    .trim();
  // Nothing but dots and spaces names no file.
  if (/^[. ]*$/.test(leaf)) return fallback;
  // A leading dot makes a hidden file in a ZIP or a download.
  leaf = leaf.replace(/^\.+/, '_').replace(TRAILING, '');
  if (WINDOWS_DEVICE.test(leaf)) leaf = `_${leaf}`;
  // Cutting can leave a dot or space at the end; trim again so the result is
  // stable when passed through this function a second time.
  leaf = capBytes(leaf).replace(TRAILING, '');
  return leaf.length === 0 ? fallback : leaf;
}

/**
 * Why a ZIP entry name cannot be written, or null when it can. A relative path
 * with `/` separators is allowed; controls, invisible characters, backslashes,
 * a leading slash or drive letter, empty segments and `.` or `..` segments are
 * not.
 */
export function unsafeEntryName(name: string): string | null {
  if (name.length === 0) return 'the name is empty';
  if (UNSAFE_CHAR.test(name)) return 'the name contains a control or invisible character';
  if (name.includes('\\')) return 'the name contains a backslash';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'the name is an absolute path';
  for (const part of name.split('/')) {
    if (part === '' || part === '.' || part === '..') return 'the name has an empty, "." or ".." path segment';
  }
  return null;
}
