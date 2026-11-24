/**
 * exportLocale.ts: the language and number style chosen for exports in this tab.
 *
 * Chosen at export, apart from the language of the app itself, so a sheet can
 * go to a client in their language. Module state on purpose, as the sheet
 * style is: it lasts the session and is never written to storage. English with
 * point decimals until the user picks another. Picking a language moves the
 * number style to that language's usual one; the user can then change it.
 */
import { asExportLanguage, languageInfo, type ExportLanguage } from './languages';
import { asNumberStyle, type NumberStyle } from './numberStyle';

export interface ExportLocale {
  readonly lang: ExportLanguage;
  readonly numberStyle: NumberStyle;
}

export const ENGLISH: ExportLocale = { lang: 'en', numberStyle: 'point' };

let current: ExportLocale = ENGLISH;
const listeners = new Set<(locale: ExportLocale) => void>();

/**
 * The locale for a deliverable written only in `offered` languages: English
 * when the session's language is another one, with the number style as chosen.
 */
export function offeredLocale<L extends ExportLanguage>(locale: ExportLocale, offered: readonly L[]): { readonly lang: L | 'en'; readonly numberStyle: NumberStyle } {
  const lang = offered.find((l) => l === locale.lang) ?? 'en';
  return { lang, numberStyle: locale.numberStyle };
}

/** The language and number style the next export uses. */
export function exportLocale(): ExportLocale {
  return current;
}

function publish(next: ExportLocale): void {
  if (next.lang === current.lang && next.numberStyle === current.numberStyle) return;
  current = next;
  for (const fn of [...listeners]) fn(next);
}

/** Choose the export language; the number style follows the language's usual one. */
export function setExportLanguage(lang: ExportLanguage): void {
  const id = asExportLanguage(lang);
  publish({ lang: id, numberStyle: languageInfo(id).numberStyle });
}

/** Choose the number style, keeping the language. */
export function setExportNumberStyle(style: NumberStyle): void {
  publish({ lang: current.lang, numberStyle: asNumberStyle(style) });
}

/** Call `fn` whenever the export language or number style changes. Returns the unsubscribe function. */
export function onExportLocaleChange(fn: (locale: ExportLocale) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
