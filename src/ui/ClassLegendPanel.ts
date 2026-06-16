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

/**
 * "Solo" / isolate glyph — three stacked layers with the top one solid and the
 * lower two faint, reading as "show only this layer". Paired with the visible
 * word "Solo" (there is no universal icon for solo, so the label carries the
 * meaning; the glyph just reinforces it and matches the app-wide icon+label
 * vocabulary).
 */
const ICON_SOLO =
  '<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" ' +
  'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 3 20 7 12 11 4 7Z" fill="currentColor" stroke="none"/>' +
  '<path d="M4 11l8 4 8-4" stroke-opacity="0.4"/>' +
  '<path d="M4 15l8 4 8-4" stroke-opacity="0.4"/></svg>';
import {
  classColor,
  setColorblindSafeClasses,
  colorblindSafeClasses,
} from '../render/colorModes';
import { classificationLabel } from '../render/pointInfo';

/** A change the panel reports back to the host after a user interaction. */
export type ClassLegendChange = (visibility: ClassVisibility) => void;

/** Fired after the user toggles the colourblind-safe class palette. */
export type ClassPaletteChange = (colorblindSafe: boolean) => void;

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

  /** Host callback fired after the colourblind-safe palette is toggled. */
  private _onPaletteChange: ClassPaletteChange | null = null;

  /** The colourblind-safe palette checkbox. */
  private _cvToggle!: HTMLInputElement;

  /** The scrolling list of class rows. */
  private readonly _list: HTMLElement;

  /** The "Filtered — showing N of M classes" banner (hidden when unfiltered). */
  private readonly _banner: HTMLElement;

  /** The "Derived (heuristic)" provenance caption (hidden unless derived). */
  private readonly _provenance: HTMLElement;

  /** "Counts accrue as the cloud streams" caption (hidden unless streaming). */
  private readonly _streamingNote: HTMLElement;

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

    // Honest "derived" caption — shown only when the classification was
    // produced by the viewer's heuristic classifier, so the legend never
    // reads as a producer's authoritative classification. Hidden by default.
    this._provenance = el('div', {
      className: 'olv-cl-derived olv-hidden',
      text: 'Derived (heuristic) — not survey-grade. Validate before relying on it.',
    });
    this._provenance.setAttribute('role', 'note');

    // Streaming caption — for a COPC/EPT scan the per-class counts are a
    // RUNNING TALLY over the nodes decoded so far (the legend folds new counts
    // as nodes arrive), so they exceed the currently-resident point count and
    // are not full-file totals. Shown only while streaming so a reviewer never
    // reads "Building 7,833" as an authoritative whole-cloud figure.
    this._streamingNote = el('div', {
      className: 'olv-cl-derived olv-hidden',
      text: 'Counts accrue as the cloud streams — points decoded so far, not full-file totals.',
    });
    this._streamingNote.setAttribute('role', 'note');

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

    // Colourblind-safe palette toggle. The class WORD and the count stay on
    // every row, so colour is supplementary — but the default ASPRS palette
    // puts green vegetation beside red buildings, the classic red/green trap.
    // This swaps to the Okabe-Ito categorical palette that survives every
    // common colour-vision-deficiency type.
    this._cvToggle = el('input', { type: 'checkbox', className: 'olv-cl-cvd-input' });
    this._cvToggle.checked = colorblindSafeClasses();
    this._cvToggle.addEventListener('change', () => {
      const on = this._cvToggle.checked;
      setColorblindSafeClasses(on);
      this._render(); // repaint the legend swatches from the new palette
      this._onPaletteChange?.(on);
    });
    const cvLabel = el('label', { className: 'olv-cl-cvd' }, [
      this._cvToggle,
      el('span', { text: 'Colourblind-safe colours' }),
    ]);
    cvLabel.title = 'Recolour the classes with a colourblind-safe (Okabe-Ito) palette';

    this.element = el('aside', { className: 'olv-class-panel olv-hidden' }, [
      head,
      this._provenance,
      this._streamingNote,
      this._banner,
      this._list,
      this._empty,
      el('div', { className: 'olv-cl-footer' }, [this._showAllBtn, cvLabel]),
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

  /** Register the host callback fired after the palette toggle changes. */
  onPaletteChange(cb: ClassPaletteChange): void {
    this._onPaletteChange = cb;
  }

  /**
   * Apply a persisted colourblind-safe preference on startup. Flips the shared
   * palette, syncs the checkbox, and repaints the swatches — without firing
   * `onPaletteChange` (the host applies the initial recolour itself on load).
   */
  setColorblindSafe(on: boolean): void {
    setColorblindSafeClasses(on);
    this._cvToggle.checked = on;
    this._render();
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
    // A fresh classification set is authoritative by default; the derive flow
    // re-flags it after this call. Reset so a derived caption never lingers
    // onto a subsequently-loaded file-classified scan.
    this.setDerivedProvenance(false);
    this.setStreamingMode(false);
    this._render();
  }

  /**
   * Show or hide the "Derived (heuristic) — not survey-grade" caption. The host
   * calls this with `true` right after applying a derived classification, so
   * the legend honestly reads as heuristic rather than authoritative.
   */
  setDerivedProvenance(on: boolean): void {
    this._provenance.classList.toggle('olv-hidden', !on);
  }

  /**
   * Show or hide the "Counts accrue as the cloud streams" caption. The host
   * calls this with `true` for a streaming COPC/EPT scan, so the per-class
   * counts (a running tally over decoded nodes) never read as full-file totals.
   */
  setStreamingMode(on: boolean): void {
    this._streamingNote.classList.toggle('olv-hidden', !on);
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

    // Solo only means something when there's more than one class to isolate
    // FROM — with a single class, "Solo" would just flip the panel into a
    // filtered state with no visible change, so it's disabled.
    const soloUseful = codes.length > 1;
    this._list.replaceChildren(...codes.map((code) => this._row(code, soloUseful)));

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
  private _row(code: number, soloUseful = true): HTMLElement {
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
      className: 'olv-cl-solo olv-cl-solo-ico',
      unsafeHtml: ICON_SOLO + '<span class="olv-cl-solo-label">Solo</span>',
      title: soloUseful ? `Show only ${name}` : 'Only one class — nothing to isolate from',
      ariaLabel: `Show only ${name}`,
    }) as HTMLButtonElement;
    solo.disabled = !soloUseful;
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
