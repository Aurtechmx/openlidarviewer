/**
 * languages.ts: the languages exports can be written in.
 *
 * English is the source language: every catalog is written in English first
 * and the other languages are typed against its keys, so a missing entry
 * fails the build. A language not yet reviewed by a geomatics reviewer is
 * marked `reviewed: false`; its exports say so in their provenance.
 *
 * The fonts every sheet style uses cover these languages: WinAnsi (Classic)
 * keeps U+00A0 to U+00FF, and the Figtree faces of the Light and Dark styles
 * cover the Latin script of all five.
 */
import type { NumberStyle } from './numberStyle';

export type ExportLanguage = 'en' | 'es' | 'pt' | 'fr' | 'de';

export interface ExportLanguageInfo {
  readonly id: ExportLanguage;
  /** The language's own name, as the picker shows it. */
  readonly name: string;
  /** BCP 47 tag written into a PDF's /Lang. */
  readonly tag: string;
  /** The number style a new export in this language starts with. */
  readonly numberStyle: NumberStyle;
  /** Whether a geomatics reviewer has signed off this language's catalogs. */
  readonly reviewed: boolean;
}

export const EXPORT_LANGUAGES: ReadonlyArray<ExportLanguageInfo> = [
  { id: 'en', name: 'English', tag: 'en-US', numberStyle: 'point', reviewed: true },
  { id: 'es', name: 'Español (México)', tag: 'es-MX', numberStyle: 'point', reviewed: false },
  { id: 'pt', name: 'Português (Brasil)', tag: 'pt-BR', numberStyle: 'comma', reviewed: false },
  { id: 'fr', name: 'Français', tag: 'fr-FR', numberStyle: 'comma', reviewed: false },
  { id: 'de', name: 'Deutsch', tag: 'de-DE', numberStyle: 'comma', reviewed: false },
];

/** The entry for `id`; English for anything unknown. */
export function languageInfo(id: string | null | undefined): ExportLanguageInfo {
  return EXPORT_LANGUAGES.find((l) => l.id === id) ?? EXPORT_LANGUAGES[0];
}

/** Narrow an arbitrary value to a supported language, English otherwise. */
export function asExportLanguage(v: unknown): ExportLanguage {
  return EXPORT_LANGUAGES.some((l) => l.id === v) ? (v as ExportLanguage) : 'en';
}
