/**
 * localizeProfile.ts: the profile sheet's words and numbers in the export
 * language, through the localizer the sheets share.
 */
import { PROFILE_SHEET_TEXT, type ProfileSheetKey } from '../i18n/deliverables/profileSheet';
import { sheetLocalizer, type SheetWords } from './localizeSheet';

export type ProfileWords = SheetWords<ProfileSheetKey>;

export const profileWords = sheetLocalizer<ProfileSheetKey>(PROFILE_SHEET_TEXT, {
  unverified: 'vUnverified',
  draft: 'footDraft',
  listed: ['cpProducer', 'cpDerived', 'cpAbsent', 'methodNone'],
  listAnd: 'listAnd',
});
