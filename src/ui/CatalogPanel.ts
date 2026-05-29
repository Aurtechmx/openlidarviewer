/**
 * src/ui/CatalogPanel.ts
 *
 * The verified-public-LiDAR-dataset picker that lives in the empty
 * state. It owns two responsibilities and two only:
 *   1. Surface a curated dropdown of verified public COPC / EPT URLs.
 *      Every entry was probed at release time and has a known-working
 *      stream.
 *   2. On Open click, hand the selected URL to `onPickUrl`. The caller
 *      (main.ts) routes the URL through `handleRemoteUrl`, which
 *      detects the format (COPC file vs. EPT manifest) and dispatches
 *      to the appropriate streaming path.
 *
 * Everything streamy — opening the COPC, hierarchy descent, point
 * rendering — happens above this component in `main.ts`. The panel is
 * pure DOM + the curated-locations data file. No catalog query, no
 * geocoder, no bbox computation.
 *
 * Why a curated picker instead of an address input
 * ─────────────────────────────────────────────────
 * v0.3.6 deliberately does not ship a "type any address" workflow.
 * Two prior attempts hit hard limits:
 *   - USGS TNM Products API only surfaces legacy non-streamable LAZ —
 *     zero `.copc.laz` URLs across the bboxes we tested. The address-
 *     based catalog returned tiles that wouldn't open.
 *   - Geocoder-based dispatch tied user experience to Nominatim
 *     accuracy + 3DEP's incomplete COPC migration. Most addresses
 *     produced "no coverage" responses.
 *
 * The curated list ships URLs we have verified — first-time users see
 * streaming work on the first click. Power users paste their own COPC
 * URL into the dedicated URL field above the picker. Address-based
 * search remains experimental (see `src/io/catalog/geocode.ts` and
 * `src/io/catalog/Usgs3depProvider.ts`) and is not wired into v0.3.6
 * UI.
 *
 * Privacy contract
 * ────────────────
 * - No geocoder request fires.
 * - No catalog provider request fires.
 * - The only network activity on Open click is the EPT manifest GET
 *   (for EPT URLs) or COPC HEAD + range read (for COPC URLs) — the
 *   same requests the open-from-URL field has always made.
 * - The `?notelemetry=1` URL flag disables the picker entirely; even
 *   though the picker itself makes no exploratory third-party calls,
 *   the per-tile fetch on Open is a categorical access event the user
 *   may opt out of.
 */

import { el } from './dom';
import {
  CURATED_LOCATIONS,
  getCuratedLocation,
} from '../io/catalog/curatedLocations';

export interface CatalogPanelOptions {
  /**
   * Called when the user picks a curated dataset. The caller is
   * responsible for routing the dataset's `streamUrl` into the EPT /
   * COPC streaming pipeline — typically `handleRemoteUrl(url)` in main.
   */
  readonly onPickUrl: (url: string, displayName: string) => void;
  /**
   * Optional pre-warm hook. Fired when the user changes the dropdown
   * selection (signalling intent), letting main.ts kick off the lazy
   * EPT / streaming chunk fetches before the explicit Open click. The
   * callback is fire-and-forget; failures are swallowed.
   */
  readonly onPickIntent?: (url: string) => void;
  /**
   * True when the user opted out of remote queries via
   * `?notelemetry=1`. The panel renders a kind explanation instead of
   * its picker surface.
   */
  readonly suppressed?: boolean;
}

/**
 * The catalog search panel. Pure DOM — owns its root, exposes a
 * `mount()` for callers and a `dispose()` for the empty-state teardown.
 */
export class CatalogPanel {
  readonly root: HTMLElement;

  private readonly _select: HTMLSelectElement;
  private readonly _submit: HTMLButtonElement;
  private readonly _hint: HTMLElement;
  private readonly _status: HTMLElement;
  private readonly _results: HTMLElement;
  private readonly _onPickUrl: (url: string, displayName: string) => void;
  private readonly _onPickIntent?: (url: string) => void;
  private readonly _suppressed: boolean;

  constructor(options: CatalogPanelOptions) {
    this._onPickUrl = options.onPickUrl;
    this._onPickIntent = options.onPickIntent;
    this._suppressed = options.suppressed === true;

    const title = el('label', {
      className: 'olv-catalog-title',
      text: 'or pick a verified public LiDAR dataset',
    });

    this._select = el('select', {
      className: 'olv-catalog-select',
      ariaLabel: 'Curated public LiDAR location',
    }) as HTMLSelectElement;
    // Leading placeholder option so first paint reads as a prompt, not
    // as an already-picked default.
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Pick a location…';
    placeholder.disabled = true;
    placeholder.selected = true;
    this._select.append(placeholder);
    for (const loc of CURATED_LOCATIONS) {
      const opt = document.createElement('option');
      opt.value = loc.id;
      // Render label + size inline (e.g. "Autzen Stadium · 77 MB" or
      // "Grand Canyon NP ★ · 22.4B pts") so the user can pick by
      // network budget without opening the hint. Native <option>
      // elements can't carry styled spans, so we fold both into the
      // text content with a · separator.
      opt.textContent = `${loc.label} · ${loc.sizeLabel}`;
      this._select.append(opt);
    }

    this._submit = el('button', {
      className: 'olv-catalog-btn',
      text: 'Open',
      title: 'Find a public LiDAR tile at the selected location',
    });
    this._submit.type = 'submit';
    this._submit.disabled = true;

    this._hint = el('span', {
      className: 'olv-catalog-hint',
      text: 'Verified-working public USGS EPT datasets — each URL was ' +
        'probed at build time. For other locations or your own COPC URL, ' +
        'use the URL field above.',
    });

    this._status = el('div', { className: 'olv-catalog-status' });
    this._results = el('div', { className: 'olv-catalog-results' });

    if (options.suppressed) {
      const suppressed = el('div', {
        className: 'olv-catalog-suppressed',
        text:
          'Public-LiDAR lookup is disabled while ?notelemetry=1 is set. ' +
          'Remove the flag to query public catalogs.',
      });
      this.root = el('div', { className: 'olv-catalog' }, [title, suppressed]);
      this._select.disabled = true;
      this._submit.disabled = true;
      return;
    }

    const form = el('form', { className: 'olv-catalog-form' }, [
      el('div', { className: 'olv-catalog-controls' }, [this._select, this._submit]),
      this._hint,
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this._open();
    });
    // Enable the Open button + update the hint as soon as a real
    // location is picked. Auto-fire would feel jumpy on accidental
    // dropdown taps, so we require an explicit Open click — but we DO
    // fire the pre-warm intent now, which lets main.ts kick off the
    // lazy streaming-chunk fetches behind the user's think-time. By the
    // time they click Open, the chunks are usually already cached.
    this._select.addEventListener('change', () => {
      const id = this._select.value;
      const loc = id ? getCuratedLocation(id) : undefined;
      this._submit.disabled = loc === undefined;
      this._hint.textContent = loc
        ? loc.hint
        : 'Verified-working public USGS EPT datasets — each URL was ' +
          'probed at build time. For other locations or your own COPC URL, ' +
          'use the URL field above.';
      if (loc && this._onPickIntent) {
        try { this._onPickIntent(loc.streamUrl); } catch { /* fire-and-forget */ }
      }
    });

    this.root = el('div', { className: 'olv-catalog' }, [
      title,
      form,
      this._status,
      this._results,
    ]);
  }

  /**
   * Programmatic entry — open a curated dataset by id. Used by tests +
   * deep links. Honours the same `?notelemetry=1` suppression as the
   * UI path.
   */
  searchFor(id: string): void {
    if (this._suppressed) return;
    const loc = getCuratedLocation(id);
    if (!loc) {
      this._setStatus(`No curated dataset matches "${id}".`);
      return;
    }
    this._select.value = loc.id;
    this._submit.disabled = false;
    this._open();
  }

  /** Cancel hook retained for parity with previous API — no-op now. */
  cancel(): void {
    /* The picker fires a single synchronous handoff to main; nothing
     * to cancel. The method is retained so external callers that
     * referenced the previous async query path don't break. */
  }

  /** Free DOM event listeners (the form's listener is removed with the node). */
  dispose(): void {
    this.cancel();
    this.root.remove();
  }

  private _open(): void {
    const id = this._select.value;
    const loc = id ? getCuratedLocation(id) : undefined;
    if (!loc) {
      this._setStatus('Pick a dataset to begin.');
      this._results.replaceChildren();
      return;
    }
    this._setStatus(`Opening ${loc.displayName}…`);
    this._results.replaceChildren();
    // Direct handoff — main.ts wires this into `handleRemoteUrl` which
    // detects the EPT manifest by URL pattern and routes to the EPT
    // streaming path. No catalog query, no geocoder, no bbox-vs-COPC
    // mismatch — the URL is verified-working at build time.
    this._onPickUrl(loc.streamUrl, loc.displayName);
  }

  private _setStatus(text: string): void {
    this._status.textContent = text;
  }
}

