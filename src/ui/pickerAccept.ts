/**
 * pickerAccept.ts: the `accept` list for a file picker, or none on iOS.
 *
 * iPhone and iPad pickers map an `accept` list to known file types and grey
 * out every file whose extension they do not recognise, so `.olvsession`,
 * `.olvworkflow`, `.laz` or `.e57` could not be picked at all. On those
 * devices the picker gets no filter; the file is checked when it is read, as
 * the Open scan picker already does. Every other system keeps the filter.
 */

/** True on an iPhone, iPod or iPad, including an iPad that reports a Mac user agent. */
export function isAppleTouchDevice(nav: { userAgent?: string; maxTouchPoints?: number } | undefined =
  typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav) return false;
  const ua = nav.userAgent ?? '';
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;
  return /\bMacintosh\b/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

/** The `accept` value to set: `accept` itself, or an empty string on iOS and iPadOS. */
export function pickerAccept(accept: string, nav?: { userAgent?: string; maxTouchPoints?: number }): string {
  return isAppleTouchDevice(nav ?? (typeof navigator === 'undefined' ? undefined : navigator)) ? '' : accept;
}
