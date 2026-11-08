/**
 * watershedReportOptions.ts: pure helpers for the watershed report's export
 * dialog: the default title and filename pre-filled from the scan, the
 * filename sanitiser, and the length limit on project notes.
 *
 * No DOM and no pdf-lib, so the dialog can import these without pulling the
 * report's lazy chunk into the main bundle.
 */
import type { ReportLanguage } from '../../simulation/flowPulse/watershed/watershedReportModel';

/** Longest project note printed on the cover, in characters. */
export const MAX_NOTES_CHARS = 400;

/** The scan name, trimmed; a plain fallback when it is blank. */
export function defaultReportTitle(p: { scanName?: string | null; basename: string }): string {
  const name = p.scanName?.trim();
  if (name) return name;
  const base = (p.basename ?? '').trim();
  return base || 'Watershed report';
}

/**
 * A user-entered filename made safe: a trailing `.pdf` dropped, path and
 * reserved characters and control codes removed, whitespace collapsed to
 * hyphens, and stray dots and hyphens trimmed from the ends. Falls back when
 * nothing usable remains.
 */
export function sanitizeReportFilename(raw: string, fallback = 'watershed-report'): string {
  let s = (raw ?? '').trim();
  s = s.replace(/\.pdf$/i, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\\/:*?"<>|\x00-\x1F]/g, '');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/-{2,}/g, '-').replace(/\.{2,}/g, '.');
  s = s.replace(/^[-.\s]+|[-.\s]+$/g, '');
  return s.length > 0 ? s : fallback;
}

/** `<basename>-watershed-report-<lang>.pdf`, with the basename sanitised. */
export function defaultReportFilename(basename: string, lang: ReportLanguage): string {
  return `${sanitizeReportFilename(basename, 'scan')}-watershed-report-${lang}.pdf`;
}

/**
 * Notes as printed: control characters and runs of whitespace collapsed to
 * single spaces, trimmed, and cut at MAX_NOTES_CHARS on a word boundary with
 * an ellipsis when longer.
 */
export function clampNotes(raw: string, max = MAX_NOTES_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const s = (raw ?? '').replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
