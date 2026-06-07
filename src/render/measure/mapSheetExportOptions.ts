/**
 * mapSheetExportOptions.ts
 *
 * Pure (no DOM, no pdf-lib) helpers for the pre-export MAP PDF dialog: the
 * sheet-size / orientation option lists, the sensible-default derivations
 * (title, project notes, output filename) pre-filled from the scan, and the
 * filename sanitiser. Kept separate from {@link ./mapSheetPdf} — which pulls
 * pdf-lib into its own lazy chunk — so these defaults can be unit-tested and
 * imported by the panel without dragging the PDF engine into the main bundle.
 *
 * Types are imported `type`-only from mapSheetPdf, so nothing here links the
 * heavy module at runtime.
 */

import type { SheetSize, SheetOrientation } from './mapSheetPdf';

/** Sheet-size choices offered in the dialog (value drives {@link SheetSize}). */
export const SHEET_OPTIONS: ReadonlyArray<{ value: SheetSize; label: string }> = [
  { value: 'letter', label: 'Letter' },
  { value: 'a4', label: 'A4' },
  { value: 'a3', label: 'A3' },
];

/** Orientation choices offered in the dialog. */
export const ORIENTATION_OPTIONS: ReadonlyArray<{ value: SheetOrientation; label: string }> = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];

/**
 * Sanitise a user-entered output filename: drop a trailing `.pdf` (re-added at
 * download time), strip path separators and characters illegal in filenames
 * plus control codes, collapse whitespace to single hyphens, and trim stray
 * leading/trailing dots, hyphens and spaces. Falls back when nothing usable
 * remains, so a download can never be triggered with an empty or unsafe name.
 */
export function sanitizeMapFilename(raw: string, fallback = 'contours-map'): string {
  let s = (raw ?? '').trim();
  // Strip a trailing extension (any case) — the single `.pdf` is re-added on download.
  s = s.replace(/\.pdf$/i, '');
  // Remove path separators, reserved filename characters, and control codes.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\\/:*?"<>|\x00-\x1F]/g, '');
  // Collapse internal whitespace to single hyphens.
  s = s.replace(/\s+/g, '-');
  // Collapse runs of hyphens / dots, then trim them off the ends.
  s = s.replace(/-{2,}/g, '-').replace(/\.{2,}/g, '.');
  s = s.replace(/^[-.\s]+|[-.\s]+$/g, '');
  return s.length > 0 ? s : fallback;
}

/** Ensure the download name ends in exactly one `.pdf` (case-normalised). */
export function ensurePdfExtension(name: string): string {
  return /\.pdf$/i.test(name) ? name.replace(/\.pdf$/i, '.pdf') : `${name}.pdf`;
}

/**
 * Default sheet title — the host's map context title when present (the
 * `<scan> — Contours` string), else derived from the export basename so the
 * field is never blank.
 */
export function defaultMapTitle(p: { title?: string | null; basename: string }): string {
  if (p.title && p.title.trim()) return p.title.trim();
  const base = (p.basename ?? '').trim();
  return base ? `${base} — Contours` : 'Contours';
}

/**
 * Default Project / Notes description derived from the scan:
 * `Contours from <basename> · interval <N> m · <CRS or 'no CRS'>`. The user can
 * edit it freely; this only seeds the field.
 */
export function defaultMapNotes(p: {
  basename: string;
  intervalM: number | null;
  crs?: string | null;
}): string {
  const base = (p.basename ?? '').trim() || 'scan';
  const interval =
    p.intervalM != null && Number.isFinite(p.intervalM) ? `${p.intervalM} m` : 'auto';
  const crs = p.crs && p.crs.trim() ? p.crs.trim() : 'no CRS';
  return `Contours from ${base} · interval ${interval} · ${crs}`;
}

/** Default output filename (without extension): a sanitised `<basename>-map`. */
export function defaultMapFilename(basename: string): string {
  const base = (basename ?? '').trim() || 'contours';
  return sanitizeMapFilename(`${base}-map`);
}
