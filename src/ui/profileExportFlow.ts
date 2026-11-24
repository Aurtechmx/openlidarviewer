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
import { safeEntryName } from '../export/safeText';
import { profileExportFileName, safeFileStem } from '../render/measure/profileSummary';
import { profilePdfInputFor, withSheetStyle, type ProfileExportContext } from './profilePdfInput';
import { openProfileExportDialog } from './profileExportDialog';

/** What the sheet is made from, read together at one moment. */
export interface ProfileExportSource {
  readonly summary: MeasurementSummary;
  readonly context: ProfileExportContext | null;
  readonly unitSystem: DisplayUnits;
}

/** A reason the export cannot be made, in words for the user. */
export class ProfileExportRefusal extends Error {
  override readonly name = 'ProfileExportRefusal';
}

export interface ProfileExportRequest {
  /**
   * Read the profile, its frame and its units together. Called when the dialog
   * opens and again as Export is pressed, before anything is awaited: the
   * dialog can be open for minutes, and the sheet is of the profile as it is
   * then. Throws a {@link ProfileExportRefusal} when it cannot be exported.
   */
  readonly capture: () => ProfileExportSource;
  readonly extras: (s: MeasurementSummary) => Promise<ProfileSheetExtras | null>;
  readonly fields: ProfileSheetFields | undefined;
  /** The measurement itself: unexported details are held against it and go when it does. */
  readonly draftOwner?: object;
  /** Keep the profile's own words on its measurement. */
  readonly saveFields?: (f: ProfileSheetFields) => void;
  readonly download: (blob: Blob, name: string) => void;
  readonly returnFocusTo?: HTMLElement | null;
}

/** The download name for what the user typed: safe, one .pdf, the default when nothing is left of it. */
export function pdfFileName(typed: string, fallback: string): string {
  const stem = safeFileStem(typed.trim().replace(/\.pdf$/i, '')).replace(/^\.+|\.+$/g, '').slice(0, 120);
  return stem === '' ? fallback : safeEntryName(`${stem}.pdf`, fallback);
}

/** Ask, build and download. Resolves false when the user closed the dialog. */
export async function exportProfileSheet(r: ProfileExportRequest): Promise<boolean> {
  const { summary: s, context, unitSystem } = r.capture();
  const fallback = profileExportFileName(context?.scanName, s.name, 'pdf') ?? `${safeFileStem(s.name) || 'profile'}-profile.pdf`;
  const chart = s.profileChart ?? [];
  return openProfileExportDialog({
    profileName: s.name, scanName: context?.scanName ?? null, lengthM: chart[chart.length - 1]?.distance ?? 0,
    unitSystem, fields: r.fields ?? {}, defaultFileName: fallback, returnFocusTo: r.returnFocusTo, draftOwner: r.draftOwner,
  }, async (c, closed) => {
    const now = r.capture();
    // The choice between metres and feet stands only while the unit is known.
    const units = now.unitSystem === 'unverified' || c.unitSystem === 'unverified' ? now.unitSystem : c.unitSystem;
    const { buildProfilePdf } = await loadProfilePdf();
    // The clock is read HERE, at the app boundary. The builder takes the
    // stamp as a parameter so the same sheet is the same bytes.
    const input = await withSheetStyle(profilePdfInputFor(now.summary, { context: now.context, unitSystem: units, generatedAt: new Date() }), () => r.extras(now.summary));
    const bytes = await buildProfilePdf({ ...input, deliverable: c.deliverable, locale: exportLocale(), paper: c.paper });
    // Closed while the sheet was being made: the user changed their mind.
    if (closed()) return;
    r.saveFields?.(c.fields);
    r.download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), pdfFileName(c.fileName, fallback));
  });
}
