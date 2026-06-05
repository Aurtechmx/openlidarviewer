/**
 * ClassLegendPanel.ts
 *
 * The Classification legend — one row per ASPRS class actually present in the
 * loaded scan (a positive point count), each carrying the renderer's class
 * colour swatch, the ASPRS name, a live "shown" point count, and a visibility
 * checkbox. A per-row "Solo" affordance isolates a single class; a "Show all"
 * button clears any filter; and a persistent banner appears only while a filter
 * is active so the user always knows the view is partial.
 *
 * DISPLAY ONLY. The panel owns a `ClassVisibility` and reports every change
 * back through `onChange` — the host (main.ts) applies the mask to the GPU and
 * re-renders the legend. The panel never touches three.js, the GPU, or the
 * analysis pipeline; counts are labelled as "shown" (post-downsample, resident)
 * points, never full-cloud totals.
 *
 * A dumb view in the same vocabulary as MeasurePanel / AnalysePanel: a
 * `readonly element`, an `el(...)`-built DOM, collapsible head, and
 * `mount()/show()/hide()`.
 */

import { el } from './dom';
import { ClassVisibility } from '../render/class/classVisibility';
import { classColor } from '../render/colorModes';
import { classificationLabel } from '../render/pointInfo';

/** A change the panel reports back to the host after a user interaction. */
export type ClassLegendChange = (visibility: ClassVisibility) => void;

export class ClassLegendPanel {
  /** The panel element — append to the left-panels column (see main.ts). */
  readonly element: HTMLElement;

  /** Per-class "shown" point counts; only codes with count > 0 get a row. */
  private _counts = new Map<number, number>();

  /** The visibility state the panel owns and the host applies to the GPU. */
  private _visibility = new ClassVisibility();

  /** Whether the loaded cloud carries a classification channel at all. */
  private _hasChannel = false;

  /** Host callback fired after any user-driven visibility change. */
  private _onChange: ClassLegendChange | null = null;

  /** The scrolling list of class rows. */
  private readonly _list: HTMLElement;

  /** The "Filtered — showing N of M classes" banner (hidden when unfiltered). */
  private readonly _banner: HTMLElement;

  /** The "Show all" reset button. */
  private readonly _showAllBtn: HTMLButtonElement;

  /** The empty / disabled state shown when there's no classification channel. */
  private readonly _empty: HTMLElement;

  constructor() {
    // Collapsible head — same pattern as the Measurements / Analyse panels.
    const title = el('div', {
      className: 'olv-cl-title olv-panel-title',
      text: 'Classes',
    });
    const collapseBtn = el('button', {
      className: 'olv-collapse-toggle',
      type: 'button',
      ariaLabel: 'Collapse Classes panel',
      title: 'Collapse this panel',
    });
    collapseBtn.append(el('span', { className: 'olv-chevron', text: '▾' }));
    const head = el('div', { className: 'olv-panel-head' }, [title, collapseBtn]);
    const toggleCollapsed = (): void => {
      this.element.classList.toggle('olv-collapsed');
    };
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapsed();
    });
    head.addEventListener('click', (e) => {
      if (e.target === head || e.target === title) toggleCollapsed();
    });

    this._banner = el('div', { className: 'olv-cl-banner olv-hidden' });
    this._banner.setAttribute('role', 'status');
    this._banner.setAttribute('aria-live', 'polite');

    this._list = el('div', { className: 'olv-cl-list' });

    this._showAllBtn = el('button', {
      className: 'olv-cl-showall',
      text: 'Show all',
      title: 'Make every class visible again',
    });
    this._showAllBtn.addEventListener('click', () => {
      this._showAllBtn.blur();
      this._visibility.showAll();
      this._render();
      this._emit();
    });

    this._empty = el('div', {
      className: 'olv-cl-empty',
      text: 'This scan has no classification data.',
    });

    this.element = el('aside', { className: 'olv-class-panel olv-hidden' }, [
      head,
      this._banner,
      this._list,
      this._empty,
      el('div', { className: 'olv-cl-footer' }, [this._showAllBtn]),
    ]);
  }

  /** Append the panel to a host container. */
  mount(parent: HTMLElement): void {
    parent.append(this.element);
  }

  /** Reveal the panel. */
  show(): void {
    this.element.classList.remove('olv-hidden');
  }

  /** Hide the panel. */
  hide(): void {
    this.element.classList.add('olv-hidden');
  }

  /** Register the host callback fired after every user-driven change. */
  onChange(cb: ClassLegendChange): void {
    this._onChange = cb;
  }

  /** The visibility state the host applies to the GPU mask. */
  getVisibility(): ClassVisibility {
    return this._visibility;
  }

  /**
   * Reset the panel for a freshly loaded scan: a brand-new visibility state
   * (everything shown) and the given per-class "shown" counts. Pass an empty
   * map (or omit) when the cloud carries no classification channel — the panel
   * then renders its empty state. This does NOT emit `onChange`; the host
   * applies the (all-visible) mask itself on load.
   */
  setClasses(counts: Map<number, number>): void {
    this._counts = new Map(counts);
    this._hasChannel = this._presentCodes().length > 0;
    this._visibility = new ClassVisibility();
    this._render();
  }

  /**
   * Fold freshly-arrived per-class counts into the running totals — the
   * streaming node-ready path. A class first seen in a deeper node appears as a
   * new row; it stays at the visibility the current state already assigns it
   * (`true` by default, but left hidden if the user has isolated another
   * class), so a late arrival never silently re-reveals points the user hid.
   * Does NOT emit `onChange` — visibility is unchanged, only the rows refresh.
   */
  mergeClasses(counts: Map<number, number>): void {
    for (const [code, n] of counts) {
      this._counts.set(code, (this._counts.get(code) ?? 0) + n);
    }
    if (this._presentCodes().length > 0) this._hasChannel = true;
    this._render();
  }

  /** Whether the panel currently has any class rows to show. */
  hasClasses(): boolean {
    return this._hasChannel;
  }

  /**
   * Present class codes (count > 0), ascending — the public view of the
   * legend's class roster. Used to derive a `ClassScope` for exported /
   * copied surfaces (the scope needs the total number of present classes,
   * which only the legend tracks for streaming scans). Mirrors the internal
   * {@link _presentCodes}.
   */
  presentCodes(): number[] {
    return this._presentCodes();
  }

  /** Present class codes (count > 0), ascending. */
  private _presentCodes(): number[] {
    const codes: number[] = [];
    for (const [code, n] of this._counts) {
      if (n > 0) codes.push(code);
    }
    return codes.sort((a, b) => a - b);
  }

  /** Notify the host that the visibility state changed. */
  private _emit(): void {
    this._onChange?.(this._visibility);
  }

  /** Rebuild the list, banner, and empty state from the current model. */
  private _render(): void {
    const codes = this._presentCodes();

    // Empty / disabled state — no classification channel on this cloud.
    if (codes.length === 0) {
      this._list.replaceChildren();
      this._list.classList.add('olv-hidden');
      this._empty.classList.remove('olv-hidden');
      this._banner.classList.add('olv-hidden');
      this._showAllBtn.disabled = true;
      return;
    }
    this._empty.classList.add('olv-hidden');
    this._list.classList.remove('olv-hidden');

    this._list.replaceChildren(...codes.map((code) => this._row(code)));

    // Persistent banner — only while a filter is active.
    if (this._visibility.isFiltered()) {
      const shown = codes.filter((c) => this._visibility.isVisible(c)).length;
      this._banner.textContent = `Filtered — showing ${shown} of ${codes.length} classes`;
      this._banner.classList.remove('olv-hidden');
    } else {
      this._banner.classList.add('olv-hidden');
    }

    this._showAllBtn.disabled = !this._visibility.isFiltered();
  }

  /** Build one class row: swatch · name · count · solo · checkbox. */
  private _row(code: number): HTMLElement {
    const on = this._visibility.isVisible(code);
    const name = classificationLabel(code);

    const swatch = el('span', { className: 'olv-cl-swatch' });
    const [r, g, b] = classColor(code);
    swatch.style.background = `rgb(${r}, ${g}, ${b})`;

    const label = el('span', { className: 'olv-cl-name', text: name, title: name });

    const count = el('span', {
      className: 'olv-cl-count',
      text: (this._counts.get(code) ?? 0).toLocaleString(),
      title: 'Shown points (post-downsample)',
    });

    // Solo — isolate this one class. ClassVisibility.isolate hides every other
    // code, so any later-arriving class stays hidden until the user shows all.
    const solo = el('button', {
      className: 'olv-cl-solo',
      text: 'Solo',
      title: `Show only ${name}`,
      ariaLabel: `Show only ${name}`,
    });
    solo.addEventListener('click', () => {
      solo.blur();
      this._visibility.isolate(code);
      this._render();
      this._emit();
    });

    const check = el('input', {
      className: 'olv-cl-check',
      type: 'checkbox',
      ariaLabel: `Toggle visibility of ${name}`,
    }) as HTMLInputElement;
    check.checked = on;
    check.addEventListener('change', () => {
      this._visibility.setVisible(code, check.checked);
      this._render();
      this._emit();
    });

    const row = el('div', { className: `olv-cl-row${on ? '' : ' is-hidden'}` }, [
      check,
      swatch,
      label,
      count,
      solo,
    ]);
    return row;
  }
}
