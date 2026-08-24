/**
 * pdfInfoDate.ts — the date a PDF stamps into its Info dictionary.
 *
 * pdf-lib defaults CreationDate and ModDate to the wall clock at
 * `PDFDocument.create()`. Two otherwise-identical builds either side of a
 * second boundary therefore embed different timestamps and stop being
 * byte-identical, which is a determinism hole no visible "generated" stamp
 * covers: the printed date can be pinned while the Info dictionary still
 * moves. `buildProfilePdf` was flaking on exactly that.
 *
 * The rule is that a deliverable's Info date comes from the same value it
 * prints, so a build with a fixed date reproduces. A builder that prints no
 * date has nothing to source from, and a wall-clock stamp there carries no
 * information a reader could use while destroying reproducibility outright,
 * so it takes the epoch instead.
 */

/**
 * The fallback Info date for a document that carries no timestamp of its own.
 *
 * Deliberately the Unix epoch rather than "now": it is visibly a placeholder
 * rather than a plausible-looking wrong date, and it is the same on every
 * machine, which is the whole point.
 */
export const PDF_EPOCH = new Date(0);

/**
 * Resolve the Info-dictionary date from whatever the caller prints.
 *
 * Accepts a Date, an ISO string, or nothing. An unparseable or non-finite
 * value falls back to the epoch rather than to the clock, because silently
 * substituting the current time is how the nondeterminism gets back in.
 */
export function pdfInfoDate(source?: Date | string | number | null): Date {
  if (source instanceof Date) {
    return Number.isFinite(source.getTime()) ? source : PDF_EPOCH;
  }
  if (typeof source === 'number') {
    return Number.isFinite(source) ? new Date(source) : PDF_EPOCH;
  }
  if (typeof source === 'string' && source.trim() !== '') {
    const parsed = new Date(source);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return PDF_EPOCH;
}
