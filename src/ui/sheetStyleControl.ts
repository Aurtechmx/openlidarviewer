/**
 * sheetStyleControl.ts: the Light / Dark / Classic choice shown next to the
 * export buttons of every scan type, so a room or object scan can pick the
 * style without a terrain run. Every control on the page shows the same
 * session value (sheetKit/sessionStyle.ts) and follows a change made in any
 * other one, including the map sheet dialog.
 */
import {
  onSheetStyleChange,
  setSheetStyle,
  sheetStyle,
  type SheetStyleChoice,
} from '../export/sheetKit/sessionStyle';
import { el } from './dom';

export const SHEET_STYLE_CHOICES: ReadonlyArray<{ value: SheetStyleChoice; label: string; title: string }> = [
  { value: 'light', label: 'Light', title: 'Light sheets and reports (the default).' },
  { value: 'dark', label: 'Dark', title: 'Dark sheets and reports, for screens.' },
  { value: 'classic', label: 'Classic', title: 'The layout of earlier versions.' },
];

let controlCount = 0;

/**
 * A labelled segmented control bound to the session sheet style. It drops its
 * subscription the first time a change arrives while it is off the page, so a
 * panel that rebuilds its body leaves no listeners behind.
 */
export function sheetStyleControl(): HTMLElement {
  const row = el('div', { className: 'olv-fp-opt-row olv-sheet-style' });
  row.append(el('span', { className: 'olv-fp-opt-label', text: 'Sheet style' }));
  const seg = document.createElement('div');
  seg.className = 'olv-fp-seg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', 'Sheet style for reports and drawn exports');
  const group = `olv-sheet-style-${++controlCount}`;
  const inputs: HTMLInputElement[] = [];
  for (const choice of SHEET_STYLE_CHOICES) {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = group;
    input.id = `${group}-${choice.value}`;
    input.className = 'olv-fp-seg-input';
    input.value = choice.value;
    input.checked = sheetStyle() === choice.value;
    input.addEventListener('change', () => {
      if (input.checked) setSheetStyle(choice.value);
    });
    const label = document.createElement('label');
    label.className = 'olv-fp-seg-label';
    label.htmlFor = input.id;
    label.title = choice.title;
    label.textContent = choice.label;
    inputs.push(input);
    seg.append(input, label);
  }
  row.append(seg);
  let attached = false;
  const unsubscribe = onSheetStyleChange((style) => {
    if (attached && !row.isConnected) { unsubscribe(); return; }
    if (row.isConnected) attached = true;
    for (const input of inputs) input.checked = input.value === style;
  });
  return row;
}
