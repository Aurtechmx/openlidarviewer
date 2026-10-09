/**
 * dataHome.ts
 *
 * The rows under the layer list on the Data home: Classes (the class list shown
 * open for a classified scan, collapsible, with an Open Classes control to the
 * full page) and Source and metadata (the Inspector's coordinate-system section).
 * A Layer Health row shows only while the right rail is collapsed, since the
 * card itself lives in the Inspector. Rows only navigate; they never change a
 * class, a layer or any analysis state. All text is set with `textContent`.
 */

import { el } from '../../ui/dom';
import { actionTitle } from '../../ui/actionDescriptors';

export interface DataHomeDeps {
  hasScan(): boolean;
  /** Present classes with name, share of points (0 to 100) and legend colour. */
  classRows(): { code: number; name: string; share: number; color: readonly [number, number, number] }[];
  /** Where the collapse choice is kept per viewer; absent or throwing is fine. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
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

const COLLAPSE_KEY = 'olv.dataHome.classesCollapsed';

export function formatShare(share: number): string {
  if (!(share > 0)) return '0%';
  return share < 0.1 ? '<0.1%' : `${share.toFixed(share < 10 ? 1 : 0)}%`;
}

export function createDataHome(d: DataHomeDeps): DataHome {
  const classes = row('Classes', () => d.openClasses());
  // Open class list: shown instead of the compact row when classes exist.
  const readStored = (): boolean | null => {
    try {
      const v = d.storage?.getItem(COLLAPSE_KEY);
      return v === '1' ? true : v === '0' ? false : null;
    } catch {
      return null;
    }
  };
  let collapsed = readStored() ?? false; // remembered for the session, expanded by default
  const toggleLabel = el('span', { className: 'olv-data-row-label', text: 'Classes' });
  const toggleValue = el('span', { className: 'olv-data-row-value' });
  const chevron = el('span', { className: 'olv-data-row-go olv-data-class-chevron', text: '▾' });
  chevron.setAttribute('aria-hidden', 'true');
  const toggle = el('button', { className: 'olv-data-class-toggle', type: 'button' }, [toggleLabel, toggleValue, chevron]) as HTMLButtonElement;
  const list = el('ul', { className: 'olv-data-class-list' });
  list.id = 'olv-data-class-list';
  toggle.setAttribute('aria-controls', list.id);
  const openPage = el('button', { className: 'olv-data-class-open', type: 'button', text: 'Open Classes →' });
  openPage.addEventListener('click', () => d.openClasses());
  const body = el('div', { className: 'olv-data-class-body' }, [list, openPage]);
  const section = el('div', { className: 'olv-data-class-section' }, [toggle, body]);
  const applyCollapsed = (): void => {
    body.hidden = collapsed;
    section.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    applyCollapsed();
    try { d.storage?.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
  });
  const source = row('Source and metadata', () => d.openSource());
  const health = row('Layer Health', () => d.openLayerHealth());
  health.value.textContent = 'In View';
  const openBtn = el('button', { className: 'olv-data-open', type: 'button', text: actionTitle('scan.open') });
  openBtn.addEventListener('click', () => d.openFile());
  const empty = el('div', { className: 'olv-data-empty' }, [
    el('p', { text: 'Open a point cloud to begin' }),
    openBtn,
  ]);
  const element = el('section', { className: 'olv-data-home' }, [empty, classes.root, section, source.root, health.root]);
  element.setAttribute('aria-label', 'Data');

  const refresh = (): void => {
    const scan = d.hasScan();
    empty.hidden = scan;
    source.root.hidden = !scan;
    health.root.hidden = !scan || !d.inspectorCollapsed();
    const rows = scan ? d.classRows() : [];
    const n = rows.length;
    classes.root.hidden = !scan || n > 0;
    section.hidden = !scan || n === 0;
    classes.value.textContent = n > 0 ? `${n} detected` : 'None detected';
    toggleValue.textContent = `${n} detected`;
    toggle.setAttribute('aria-label', `Classes, ${n} detected`);
    applyCollapsed();
    list.replaceChildren(...rows.map((r) => {
      const sw = el('span', { className: 'olv-data-class-swatch' });
      sw.style.background = `rgb(${r.color[0]}, ${r.color[1]}, ${r.color[2]})`;
      sw.setAttribute('aria-hidden', 'true');
      return el('li', { className: 'olv-data-class-item' }, [
        sw,
        el('span', { className: 'olv-data-class-code', text: String(r.code) }),
        el('span', { className: 'olv-data-class-name', text: r.name }),
        el('span', { className: 'olv-data-class-share', text: formatShare(r.share) }),
      ]);
    }));
    source.value.textContent = d.sourceSummary() || 'Not read yet';
    classes.root.setAttribute('aria-label', `Classes, ${classes.value.textContent}`);
    source.root.setAttribute('aria-label', `Source and metadata, ${source.value.textContent}`);
  };
  refresh();
  return { element, refresh };
}
