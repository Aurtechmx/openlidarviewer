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
 * Every control built so far, held weakly: a panel that rebuilds its body
 * drops its old control, and the collector takes it with its inputs. One
 * subscription serves them all, so nothing piles up per control.
 */
const controls = new Set<WeakRef<HTMLElement>>();
const inputsOf = new WeakMap<HTMLElement, readonly HTMLInputElement[]>();
let subscribed = false;

function showStyle(style: SheetStyleChoice): void {
  for (const ref of controls) {
    const row = ref.deref();
    if (!row) { controls.delete(ref); continue; }
    for (const input of inputsOf.get(row) ?? []) input.checked = input.value === style;
  }
}

/**
 * A labelled segmented control bound to the session sheet style. Every copy
 * shows the current choice, whether it is on the page, waiting to be placed,
 * or put back after a panel rebuild.
 */
export function sheetStyleControl(): HTMLElement {
  if (!subscribed) { onSheetStyleChange(showStyle); subscribed = true; }
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
  inputsOf.set(row, inputs);
  controls.add(new WeakRef(row));
  return row;
}

/** How many controls are still held, for tests. Collected ones are pruned on the next change. */
export function sheetStyleControlCount(): number {
  return controls.size;
}
