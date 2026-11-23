/**
 * profileExportFlow.ts: one profile's sheet export, from the dialog to the
 * file. The Measurements panel and the docked workbench both run it, so there
 * is one assembly of the sheet's inputs: what a second one drops is the CRS,
 * the unit system and the provenance record, which a reader of the file cannot
 * recover from anywhere else.
 */
import { exportLocale } from '../i18n/exportLocale';
import { loadProfilePdf } from '../lazyChunks';
import type { ProfileSheetFields } from '../model/deliverableFields';
import type { DisplayUnits } from '../render/measure/format';
import type { MeasurementSummary } from '../render/measure/MeasureController';
import type { ProfileSheetExtras } from '../render/measure/profileSheetStyled';
import { profileExportFileName, safeFileStem } from '../render/measure/profileSummary';
import { profilePdfInputFor, withSheetStyle, type ProfileExportContext } from './profilePdfInput';
import { openProfileExportDialog } from './profileExportDialog';

export interface ProfileExportRequest {
  readonly summary: MeasurementSummary;
  readonly context: ProfileExportContext | null;
  readonly unitSystem: DisplayUnits;
  readonly extras: () => Promise<ProfileSheetExtras | null>;
  readonly fields: ProfileSheetFields | undefined;
  /** Keep the profile's own words on its measurement. */
  readonly saveFields?: (f: ProfileSheetFields) => void;
  readonly download: (blob: Blob, name: string) => void;
  readonly returnFocusTo?: HTMLElement | null;
}

/** The download name for what the user typed: safe, one .pdf, the default when nothing is left of it. */
export function pdfFileName(typed: string, fallback: string): string {
  const stem = safeFileStem(typed.trim().replace(/\.pdf$/i, '')).replace(/^\.+|\.+$/g, '').slice(0, 120);
  return stem === '' ? fallback : `${stem}.pdf`;
}

/** Ask, build and download. Resolves false when the user closed the dialog. */
export async function exportProfileSheet(r: ProfileExportRequest): Promise<boolean> {
  const s = r.summary;
  const fallback = profileExportFileName(r.context?.scanName, s.name, 'pdf') ?? `${safeFileStem(s.name) || 'profile'}-profile.pdf`;
  const chart = s.profileChart ?? [];
  return openProfileExportDialog({
    profileName: s.name, scanName: r.context?.scanName ?? null, lengthM: chart[chart.length - 1]?.distance ?? 0,
    unitSystem: r.unitSystem, fields: r.fields ?? {}, defaultFileName: fallback, returnFocusTo: r.returnFocusTo,
  }, async (c) => {
    const { buildProfilePdf } = await loadProfilePdf();
    // The clock is read HERE, at the app boundary. The builder takes the
    // stamp as a parameter so the same sheet is the same bytes.
    const input = await withSheetStyle(profilePdfInputFor(s, { context: r.context, unitSystem: c.unitSystem, generatedAt: new Date() }), r.extras);
    const bytes = await buildProfilePdf({ ...input, deliverable: c.deliverable, locale: exportLocale(), paper: c.paper });
    r.saveFields?.(c.fields);
    r.download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), pdfFileName(c.fileName, fallback));
  });
}
