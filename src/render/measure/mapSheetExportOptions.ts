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
import { verticalUnitSuffix } from '../../units/units';
import { companyDetails, isEmptyFields, type CompanyDetails } from '../../model/deliverableFields';

/** Sheet-size choices offered in the dialog (value drives {@link SheetSize}). */
export const SHEET_OPTIONS: ReadonlyArray<{ value: SheetSize; label: string }> = [
  { value: 'letter', label: 'Letter' },
  { value: 'a4', label: 'A4' },
  { value: 'a3', label: 'A3' },
];

/**
 * Sheet styles offered in the dialog, Light first and the default. Classic is
 * the sepia sheet without relief that every earlier version drew.
 */
export const STYLE_OPTIONS: ReadonlyArray<{ value: 'light' | 'dark' | 'classic'; label: string }> = [
  { value: 'light', label: 'Light, with shaded relief' },
  { value: 'dark', label: 'Dark, with shaded relief (for screens)' },
  { value: 'classic', label: 'Classic, lines only' },
];

/** The sheet style chosen in this tab; it lives in the sheet kit so the export layer can read it. */
export { sheetStyle, setSheetStyle, type SheetStyleChoice } from '../../export/sheetKit/sessionStyle';

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
  if (p.title?.trim()) return p.title.trim();
  const base = (p.basename ?? '').trim();
  return base ? `${base} — Contours` : 'Contours';
}

/**
 * Default Project / Notes description derived from the scan:
 * `Contours from <basename> · interval <N> <unit> · <CRS or 'no CRS'>`. The user
 * can edit it freely; this only seeds the field. The contour interval is in the
 * source VERTICAL unit — `verticalUnitToMetres` labels it honestly ('m' / 'ft' /
 * 'units'), and an absent / unknown scale yields "(vertical unit unverified)"
 * rather than a false 'm'.
 */
export function defaultMapNotes(p: {
  basename: string;
  intervalM: number | null;
  crs?: string | null;
  /** Metres per source vertical (Z) unit, for the interval's unit label. */
  verticalUnitToMetres?: number | null;
}): string {
  const base = (p.basename ?? '').trim() || 'scan';
  const interval =
    p.intervalM != null && Number.isFinite(p.intervalM)
      ? `${p.intervalM}${verticalUnitSuffix(p.verticalUnitToMetres)}`
      : 'auto';
  const crs = p.crs?.trim() ? p.crs.trim() : 'no CRS';
  return `Contours from ${base} · interval ${interval} · ${crs}`;
}

/** Notes the user typed, by the scan they were typed for. This tab only. */
const typedNotes = new Map<string, string>();
/** The Prepared by the user typed, '' when they cleared it, null when they left the suggestion. This tab only. */
let typedPreparedBy: string | null = null;

/** What the notes describe: the contours drawn and the frame they are drawn in. */
interface DrawnContours {
  readonly intervalM: number;
  readonly crs: string | null;
}

/**
 * The dialog's Notes. What the user typed for this scan is shown again; anything
 * else is made afresh from the scan, its CRS and the interval drawn. `print` is
 * what the sheet carries: text left as it was shown states the interval of the
 * contours that were drawn, which need not be the one the dialog opened on.
 * `keep` is called once a sheet was written. With no scan id nothing is kept.
 */
export function mapNotes(
  scanId: string | null,
  basename: string,
  model: DrawnContours,
  verticalUnitToMetres: () => number | null | undefined,
): { readonly shown: string; print(text: string, drawn: DrawnContours): string; keep(text: string): void } {
  const generate = (d: DrawnContours): string =>
    defaultMapNotes({ basename, intervalM: d.intervalM, crs: d.crs, verticalUnitToMetres: verticalUnitToMetres() });
  const seeded = generate(model);
  return {
    shown: (scanId === null ? undefined : typedNotes.get(scanId)) ?? seeded,
    print: (text, drawn) => (text === seeded ? generate(drawn) : text),
    keep: (text) => {
      if (scanId === null) return;
      if (text === seeded) typedNotes.delete(scanId);
      else typedNotes.set(scanId, text);
    },
  };
}

/**
 * The dialog's Prepared by: what the user typed here before, else the person or
 * company they gave with a profile export, else the one this device remembers.
 * Read only: nothing typed here goes to the company details.
 */
export function mapPreparedBy(remembered: CompanyDetails | null): { readonly shown: string; keep(text: string): void } {
  const who = isEmptyFields(companyDetails()) && remembered ? remembered : companyDetails();
  const suggested = who.preparedBy ?? who.company ?? '';
  const shown = typedPreparedBy ?? suggested;
  return { shown, keep: (text) => { if (text !== shown) typedPreparedBy = text; } };
}

/** Default output filename (without extension): a sanitised `<basename>-map`. */
export function defaultMapFilename(basename: string): string {
  const base = (basename ?? '').trim() || 'contours';
  return sanitizeMapFilename(`${base}-map`);
}

/**
 * State for the dialog's "Include annotations" checkbox, derived from how many
 * annotations the scan carries. Pure so the enable/label logic is unit-testable
 * without the DOM. The control is DISABLED (not hidden) when there is nothing to
 * include, so the option is discoverable but clearly unavailable — the earlier
 * decision to show it disabled at zero. Default OFF regardless, so a plain sheet
 * never changes unless the user asks for annotations.
 */
export function annotationsOptionState(count: number): {
  disabled: boolean;
  label: string;
  hint: string;
} {
  if (count <= 0) {
    return {
      disabled: true,
      label: 'Include annotations',
      hint: 'No annotations placed on this scan.',
    };
  }
  return {
    disabled: false,
    label: 'Include annotations',
    hint: `Plot the ${count} placed annotation${count === 1 ? '' : 's'} as numbered markers with a description table.`,
  };
}

/**
 * The map dialog's measurements option. On by default when the scan has
 * measurements; off and disabled when it has none, so a sheet without them is
 * unchanged.
 */
export function measurementsOptionState(count: number): { disabled: boolean; label: string; hint: string } {
  if (count <= 0) return { disabled: true, label: 'Include measurements', hint: 'No measurements on this scan.' };
  return {
    disabled: false,
    label: 'Include measurements',
    hint: `${count} measurement${count === 1 ? '' : 's'}. Light and Dark draw them lettered, with each figure and its support grade; Classic leaves them off.`,
  };
}

/**
 * The dialog checkbox for an option state: checked when the option is
 * available, disabled when it is not. The one function here that needs a
 * document; it is only called while the dialog is built.
 */
export function optionCheck(state: { readonly disabled: boolean }): HTMLInputElement {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'olv-modal-check';
  box.checked = !state.disabled;
  box.disabled = state.disabled;
  return box;
}
