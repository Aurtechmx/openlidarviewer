/**
 * mapSheetLanguage.ts: the map sheet dialog's Language and Numbers choice. The
 * Light and Dark sheets follow it; Classic is in English, so the choice is
 * disabled while the dialog's Sheet style is Classic.
 */
import { exportLanguageControl } from './exportLanguageControl';

export const MAP_SHEET_LANGUAGE_NOTE =
  'The Light and Dark sheets follow this language. The Classic sheet, the contour SVG and the PNG are in English. Translations are drafts until reviewed.';

/** The language choice for the sheet whose style `styleSelect` picks. */
export function mapSheetLanguage(styleSelect: HTMLSelectElement): HTMLElement {
  const block = exportLanguageControl(MAP_SHEET_LANGUAGE_NOTE);
  const sync = (): void => {
    for (const c of block.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) c.disabled = styleSelect.value === 'classic';
  };
  styleSelect.addEventListener('change', sync);
  sync();
  return block;
}
