/**
 * localizeMapSheet.ts: the contour map sheet's words and numbers in the export
 * language, through the localizer the sheets share.
 */
import { MAP_SHEET_TEXT, type MapSheetKey } from '../i18n/deliverables/mapSheet';
import { ENGLISH, type ExportLocale } from '../i18n/exportLocale';
import { sheetLocalizer, type SheetWords } from './localizeSheet';

export interface MapSheetWords extends SheetWords<MapSheetKey> {
  /** True when the sheet is not in English, so its boxes must make room for longer words. */
  readonly translated: boolean;
  /** A measurement's figure: clauses joined by middle dots, each with its own row or figures alone. */
  value(text: string): string;
}

const words = sheetLocalizer<MapSheetKey>(MAP_SHEET_TEXT, { unverified: 'vUnverified', draft: 'footDraft' });

export function mapSheetWords(locale: ExportLocale = ENGLISH, onMiss?: (text: string) => void): MapSheetWords {
  const w = words(locale, onMiss);
  return {
    ...w,
    translated: locale.lang !== 'en',
    value: (text) => text.split(/(\s+·\s+)/).map((part, i) => (i % 2 === 1 ? part : w.translate(part))).join(''),
  };
}
