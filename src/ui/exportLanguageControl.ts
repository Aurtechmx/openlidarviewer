/**
 * exportLanguageControl.ts: the Language and Numbers choice shown next to an
 * export, so a report can be written in the client's language whatever
 * language the app itself is in.
 *
 * Every copy shows the session's choice (i18n/exportLocale.ts) and follows a
 * change made in any other copy. Copies are held weakly behind one
 * subscription, as the sheet style controls are, so a panel that rebuilds its
 * body leaves none behind.
 */
import {
  exportLocale,
  onExportLocaleChange,
  setExportLanguage,
  setExportNumberStyle,
  type ExportLocale,
} from '../i18n/exportLocale';
import { EXPORT_LANGUAGES, asExportLanguage } from '../i18n/languages';
import { NUMBER_STYLES } from '../i18n/numberStyle';
import { el } from './dom';

interface ControlParts {
  readonly select: HTMLSelectElement;
  readonly styles: readonly HTMLInputElement[];
}

const controls = new Set<WeakRef<HTMLElement>>();
const partsOf = new WeakMap<HTMLElement, ControlParts>();
let subscribed = false;
let controlCount = 0;

function show(parts: ControlParts, locale: ExportLocale): void {
  parts.select.value = locale.lang;
  for (const input of parts.styles) input.checked = input.value === locale.numberStyle;
}

function showAll(locale: ExportLocale): void {
  for (const ref of controls) {
    const row = ref.deref();
    if (!row) { controls.delete(ref); continue; }
    const parts = partsOf.get(row);
    if (parts) show(parts, locale);
  }
}

/** The option text: the language's own name, marked while it is a draft. */
export function languageOptionText(id: string): string {
  const info = EXPORT_LANGUAGES.find((l) => l.id === id) ?? EXPORT_LANGUAGES[0];
  return info.reviewed ? info.name : `${info.name} (draft)`;
}

/**
 * A Language picker and a Numbers segmented choice, bound to the session's
 * export language and number style, with a one-line note on what they apply to.
 */
export function exportLanguageControl(appliesTo: string): HTMLElement {
  if (!subscribed) { onExportLocaleChange(showAll); subscribed = true; }
  const id = `olv-export-lang-${++controlCount}`;
  const block = el('div', { className: 'olv-export-lang' });

  const langRow = el('div', { className: 'olv-fp-opt-row' });
  const langLabel = el('label', { className: 'olv-fp-opt-label', text: 'Language' });
  langLabel.setAttribute('for', `${id}-select`);
  const select = document.createElement('select');
  select.id = `${id}-select`;
  select.className = 'olv-export-lang-select';
  for (const lang of EXPORT_LANGUAGES) {
    const option = document.createElement('option');
    option.value = lang.id;
    option.lang = lang.tag;
    option.textContent = languageOptionText(lang.id);
    select.append(option);
  }
  select.addEventListener('change', () => setExportLanguage(asExportLanguage(select.value)));
  langRow.append(langLabel, select);

  const numRow = el('div', { className: 'olv-fp-opt-row' });
  const numLabel = el('span', { className: 'olv-fp-opt-label', text: 'Numbers' });
  numLabel.id = `${id}-numbers`;
  numRow.append(numLabel);
  const seg = document.createElement('div');
  seg.className = 'olv-fp-seg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-labelledby', numLabel.id);
  const styles: HTMLInputElement[] = [];
  for (const style of NUMBER_STYLES) {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `${id}-numbers`;
    input.id = `${id}-numbers-${style.id}`;
    input.className = 'olv-fp-seg-input';
    input.value = style.id;
    input.addEventListener('change', () => { if (input.checked) setExportNumberStyle(style.id); });
    const label = document.createElement('label');
    label.className = 'olv-fp-seg-label';
    label.htmlFor = input.id;
    label.textContent = style.sample;
    styles.push(input);
    seg.append(input, label);
  }
  numRow.append(seg);

  block.append(langRow, numRow, el('div', { className: 'olv-object-note', text: appliesTo }));
  const parts: ControlParts = { select, styles };
  show(parts, exportLocale());
  partsOf.set(block, parts);
  controls.add(new WeakRef(block));
  return block;
}

/** How many controls are still held, for tests. */
export function exportLanguageControlCount(): number {
  return controls.size;
}
