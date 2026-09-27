/**
 * dataHome.ts
 *
 * The compact rows under the layer list on the Data home: Classes (a page in
 * Data) and Source and metadata (the Inspector's coordinate-system section).
 * A Layer Health row shows only while the right rail is collapsed, since the
 * card itself lives in the Inspector. Rows only navigate; they never change a
 * class, a layer or any analysis state. All text is set with `textContent`.
 */

import { el } from '../../ui/dom';

export interface DataHomeDeps {
  hasScan(): boolean;
  classCount(): number;
  sourceSummary(): string;
  /** True when the right rail (and so the Inspector) is collapsed. */
  inspectorCollapsed(): boolean;
  openClasses(): void;
  openSource(): void;
  openLayerHealth(): void;
  openFile(): void;
}

export interface DataHome {
  readonly element: HTMLElement;
  refresh(): void;
}

function row(label: string, onClick: () => void): { root: HTMLButtonElement; value: HTMLElement } {
  const value = el('span', { className: 'olv-data-row-value' });
  const root = el('button', { className: 'olv-data-row', type: 'button' }, [
    el('span', { className: 'olv-data-row-label', text: label }),
    value,
    el('span', { className: 'olv-data-row-go', text: '→' }),
  ]) as HTMLButtonElement;
  root.addEventListener('click', onClick);
  return { root, value };
}

export function createDataHome(d: DataHomeDeps): DataHome {
  const classes = row('Classes', () => d.openClasses());
  const source = row('Source and metadata', () => d.openSource());
  const health = row('Layer Health', () => d.openLayerHealth());
  health.value.textContent = 'In the Inspector';
  const openBtn = el('button', { className: 'olv-data-open', type: 'button', text: 'Open scan' });
  openBtn.addEventListener('click', () => d.openFile());
  const empty = el('div', { className: 'olv-data-empty' }, [
    el('p', { text: 'Open a point cloud to begin' }),
    openBtn,
  ]);
  const element = el('section', { className: 'olv-data-home' }, [empty, classes.root, source.root, health.root]);
  element.setAttribute('aria-label', 'Data');

  const refresh = (): void => {
    const scan = d.hasScan();
    empty.hidden = scan;
    classes.root.hidden = !scan;
    source.root.hidden = !scan;
    health.root.hidden = !scan || !d.inspectorCollapsed();
    const n = d.classCount();
    classes.value.textContent = n > 0 ? `${n} detected` : 'None detected';
    source.value.textContent = d.sourceSummary() || 'Not read yet';
    classes.root.setAttribute('aria-label', `Classes, ${classes.value.textContent}`);
    source.root.setAttribute('aria-label', `Source and metadata, ${source.value.textContent}`);
  };
  refresh();
  return { element, refresh };
}
