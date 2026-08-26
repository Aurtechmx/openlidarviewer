/**
 * src/ui/CatalogPanel.ts
 *
 * The public-LiDAR picker that lives in the empty state. It has two
 * jobs:
 *   1. Surface a curated dropdown of hand-vetted public COPC / EPT URLs,
 *      each verified against a known-working stream.
 *   2. Offer a coordinate-based "search by location" over Microsoft
 *      Planetary Computer's public STAC 3DEP-COPC catalog, for US points.
 *   On Open (or on a search hit) it hands the chosen URL to `onPickUrl`.
 *   The caller (main.ts) routes it through `handleRemoteUrl`, which
 *   detects COPC vs. EPT and dispatches to the matching streaming path.
 *
 * Everything streamy — opening the COPC, hierarchy descent, point
 * rendering — happens above this component in `main.ts`. The panel is
 * DOM plus the curated-locations data file plus the lazy-loaded
 * Planetary Computer client. It does no street-address geocoding.
 *
 * Why a curated picker instead of an address input
 * ─────────────────────────────────────────────────
 * The viewer does not ship a "type any street address" workflow.
 * Two prior attempts hit hard limits:
 *   - USGS TNM Products API only surfaces legacy non-streamable LAZ —
 *     zero `.copc.laz` URLs across the bboxes we tested. The address-
 *     based catalog returned tiles that wouldn't open.
 *   - Geocoder-based dispatch tied user experience to Nominatim
 *     accuracy + 3DEP's incomplete COPC migration. Most addresses
 *     produced "no coverage" responses.
 *
 * So address geocoding was removed. What remains is the curated list
 * (URLs we have verified, so first-time users see streaming work on the
 * first click) and a coordinate search against Planetary Computer for
 * the US case. Power users paste their own COPC URL into the dedicated
 * field above the picker.
 *
 * Privacy contract
 * ────────────────
 * - No street-address geocoder request fires.
 * - The curated dropdown fires no request until Open; then the only
 *   network activity is the EPT manifest GET (for EPT URLs) or COPC
 *   HEAD + range read (for COPC URLs) — the same requests the
 *   open-from-URL field has always made.
 * - The location search is the one provider request, and only when the
 *   user runs it: a bbox query to Planetary Computer's public STAC.
 * - The `?notelemetry=1` URL flag disables the whole lookup — curated
 *   dropdown and location search — since a per-tile fetch is a
 *   categorical access event the user may opt out of.
 */

import { el } from './dom';
import {
  CURATED_LOCATIONS,
  curatedSizeBytes,
  curatedUsageCategory,
  getCuratedLocation,
} from '../io/catalog/curatedLocations';
import type { PcStacItem } from '../io/catalog/planetaryComputer';
import type { Sample } from './Stage';
import { loadPlanetaryComputerCatalog } from '../lazyChunks';

/**
 * The curated entry the start screen promotes as its one-click demo.
 *
 * It must be a record whose licence the tree actually records, which a
 * test enforces. Everything the button shows is derived from that record
 * rather than restated here, so the size the cellular-data gate checks
 * cannot drift from the object being fetched.
 */
export const DEMO_SAMPLE_ID = 'flai-ch-swisssurface3d-2022';

/**
 * The "Try a sample scan" dataset, built from its catalog record.
 *
 * main.ts used to declare this object itself, with its own copy of the
 * URL and display name, so a correction to the catalog left the start
 * screen streaming the old object and nothing could see the divergence.
 * It lives beside the picker because the two surface the same record and
 * must not be able to disagree about it. Only the button copy is local.
 *
 * Undefined when the catalog no longer carries the entry: Stage then
 * hides the button rather than offering a dead URL.
 */
export function buildCuratedDemoSample(): Sample | undefined {
  const loc = getCuratedLocation(DEMO_SAMPLE_ID);
  if (!loc) return undefined;
  return {
    id: loc.id,
    label: `${loc.label}, ${loc.sizeLabel}`,
    detail: `${loc.displayName}, via ${loc.mirrorProvider} · streams over your network, nothing uploaded`,
    url: loc.streamUrl,
    name: loc.displayName,
    sizeBytes: curatedSizeBytes(loc),
  };
}

export interface CatalogPanelOptions {
  /**
   * Called when the user picks a curated dataset. The caller is
   * responsible for routing the dataset's `streamUrl` into the EPT /
   * COPC streaming pipeline — typically `handleRemoteUrl(url)` in main.
   * `usageCategory` is the counter suffix for this pick, computed here
   * from the record that was picked. The caller records what it is
   * handed: it has the URL but not the entry behind it, and the
   * previous arrangement had it guess, filing every pick — European
   * COPC tiles included — as a US EPT dataset.
   */
  readonly onPickUrl: (url: string, displayName: string, usageCategory: string) => void;
  /**
   * Optional pre-warm hook. Fired when the user changes the dropdown
   * selection (signalling intent), letting main.ts kick off the lazy
   * EPT / streaming chunk fetches before the explicit Open click. The
   * callback is fire-and-forget; failures are swallowed.
   */
  readonly onPickIntent?: (url: string) => void;
  /**
   * v0.3.6 PC STAC integration. Called when the user picks a result
   * from the "Search by location" panel. main.ts uses the item's
   * EPSG to short-circuit CRS resolution (skipping a ~500-700 ms LAS
   * VLR probe), then dispatches the assetUrl through handleRemoteUrl.
   * Falls back to onPickUrl when omitted.
   */
  readonly onPickPcItem?: (item: PcStacItem) => void;
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
  private readonly _onPickUrl: (url: string, displayName: string, usageCategory: string) => void;
  private readonly _onPickIntent?: (url: string) => void;
  private readonly _onPickPcItem?: (item: PcStacItem) => void;
  private readonly _suppressed: boolean;
  /** In-flight STAC search controller, if any — supports user cancel. */
  private _pcAbort: AbortController | null = null;

  constructor(options: CatalogPanelOptions) {
    this._onPickUrl = options.onPickUrl;
    this._onPickIntent = options.onPickIntent;
    this._onPickPcItem = options.onPickPcItem;
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

    // v0.3.6: STAC search by location. Borrowed from the maplibre-gl-
    // usgs-lidar plugin's bbox-search pattern, minus the basemap
    // dependency — we don't need a map to ask the user for a lat/lon.
    // The whole feature lazy-loads the planetaryComputer module on
    // first Search click so the curated-only path stays free.
    const pcSection = this._buildPcSearch();

    this.root = el('div', { className: 'olv-catalog' }, [
      title,
      form,
      this._status,
      this._results,
      pcSection,
    ]);
  }

  /**
   * Build the Planetary Computer "Search by location" disclosure. Two
   * inputs (lat, lon), a Search button, an inline status line, and a
   * results list that renders each PC STAC item as a button. Each
   * button click triggers the EPSG short-circuit + handleRemoteUrl
   * dispatch via the `onPickPcItem` callback (or falls back to
   * onPickUrl when omitted).
   */
  private _buildPcSearch(): HTMLElement {
    const summary = el('summary', {
      className: 'olv-empty-formats-summary',
      text: 'Search by location (US only — Planetary Computer)',
    });
    // v0.3.6 desktop-audit fix: discoverability. The previous helper didn't
    // explain what to type or that PC 3DEP only covers the US. The new
    // helper states the constraint up front; quick-pick city chips below
    // fill the lat/lon for users who don't carry coordinates in their head.
    const helper = el('p', {
      className: 'olv-empty-section-caption',
      text:
        'Live USGS 3DEP LiDAR (US only). Enter coordinates of a US location, ' +
        'or pick a city below to auto-fill.',
    });

    const latInput = el('input', {
      className: 'olv-catalog-input',
      type: 'number',
      ariaLabel: 'Latitude',
    });
    latInput.placeholder = 'Latitude — e.g. 40.0';
    latInput.step = 'any';
    latInput.min = '-90';
    latInput.max = '90';

    const lonInput = el('input', {
      className: 'olv-catalog-input',
      type: 'number',
      ariaLabel: 'Longitude',
    });
    lonInput.placeholder = 'Longitude — e.g. -105.27';
    lonInput.step = 'any';
    lonInput.min = '-180';
    lonInput.max = '180';

    const submit = el('button', {
      className: 'olv-catalog-btn',
      text: 'Search',
      title: 'Search Planetary Computer for 3DEP COPC tiles near this point',
    });
    submit.type = 'submit';

    // Quick-pick city chips — auto-fill the lat/lon inputs so first-time
    // users have a one-tap way to see real results. The four chosen here
    // each have dense, recent 3DEP coverage (verified at release time).
    const cities: readonly { readonly name: string; readonly lat: number; readonly lon: number }[] = [
      { name: 'Denver', lat: 39.74, lon: -104.99 },
      { name: 'Manhattan', lat: 40.78, lon: -73.97 },
      { name: 'San Francisco', lat: 37.78, lon: -122.42 },
      { name: 'Grand Canyon', lat: 36.06, lon: -112.11 },
    ];
    const quickPicks = el('div', { className: 'olv-catalog-quickpicks' });
    for (const c of cities) {
      const chip = el('button', {
        className: 'olv-catalog-quickpick',
        type: 'button',
        text: c.name,
        title: `Auto-fill coordinates for ${c.name} (${c.lat}, ${c.lon})`,
      });
      chip.addEventListener('click', () => {
        latInput.value = String(c.lat);
        lonInput.value = String(c.lon);
        // Move focus to the Search button so Enter fires the search.
        submit.focus();
      });
      quickPicks.append(chip);
    }

    const status = el('div', { className: 'olv-catalog-status' });
    const results = el('div', { className: 'olv-catalog-results' });

    const form = el('form', { className: 'olv-catalog-form' }, [
      el('div', { className: 'olv-catalog-controls' }, [latInput, lonInput, submit]),
      quickPicks,
      status,
      results,
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const lat = Number.parseFloat(latInput.value);
      const lon = Number.parseFloat(lonInput.value);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        status.textContent = 'Enter a numeric latitude and longitude.';
        return;
      }
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        status.textContent = 'Latitude must be -90..90 and longitude -180..180.';
        return;
      }
      void this._runPcSearch(lat, lon, submit, status, results);
    });

    // Distinct disclosure class so the chevron signals "expandable
    // search tool" rather than "expandable text list" — the formats
    // disclosure (olv-empty-formats) above uses the same <details>
    // element for plain text, which would confuse the user (Gestalt
    // similarity violation). A cyan accent border-left distinguishes
    // the active tool surface.
    const details = el('details', { className: 'olv-empty-formats olv-pc-search-disclosure' });
    details.append(summary, helper, form);
    return details;
  }

  /**
   * Fire a PC STAC search by lat/lon and render the results inline.
   * Cancels any in-flight search on a repeat submit. Maps any error
   * to a one-line plain-English message in the status area.
   */
  private async _runPcSearch(
    lat: number,
    lon: number,
    submit: HTMLButtonElement,
    status: HTMLElement,
    results: HTMLElement,
  ): Promise<void> {
    if (this._pcAbort) this._pcAbort.abort();
    this._pcAbort = new AbortController();
    submit.disabled = true;
    submit.textContent = 'Searching…';
    status.textContent = '';
    results.replaceChildren();
    try {
      // Reached through lazyChunks so the live transform can't scramble
      // the import specifier (see lazyChunks.ts).
      const mod = await loadPlanetaryComputerCatalog();
      const items = await mod.searchByLatLon(
        { lat, lon, signal: this._pcAbort.signal },
      );
      this._pcAbort = null;
      if (items.length === 0) {
        status.textContent = 'No PC tiles cover this point. Try a larger US metro.';
        return;
      }
      status.textContent = `Found ${items.length} tile${items.length === 1 ? '' : 's'}.`;
      for (const item of items) {
        const title = item.title ?? item.id;
        const date = item.datetime?.start?.slice(0, 10);
        const bbox = `${item.bbox[1].toFixed(2)}°N ${item.bbox[0].toFixed(2)}°E → ` +
          `${item.bbox[3].toFixed(2)}°N ${item.bbox[2].toFixed(2)}°E`;
        const detail = [
          item.source.toUpperCase(),
          item.epsg ? `EPSG:${item.epsg}` : null,
          date,
          bbox,
        ].filter(Boolean).join(' · ');
        const btn = el('button', {
          className: 'olv-catalog-result',
          type: 'button',
        }, [
          el('div', { className: 'olv-catalog-result-main' }, [
            el('span', { className: 'olv-catalog-result-name', text: title }),
          ]),
          el('span', { className: 'olv-catalog-result-detail', text: detail }),
        ]);
        btn.addEventListener('click', () => {
          if (this._onPickPcItem) {
            this._onPickPcItem(item);
          } else {
            this._onPickUrl(item.assetUrl, title, 'pc-stac');
          }
        });
        results.append(btn);
      }
    } catch (err) {
      this._pcAbort = null;
      if ((err as { name?: string })?.name === 'AbortError') return;
      const raw = err instanceof Error ? err.message : String(err ?? '');
      status.textContent = this._friendlyPcError(raw);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Search';
    }
  }

  /** Map raw PC STAC errors to a one-line plain-English status message. */
  private _friendlyPcError(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes('cors') || lower.includes('cross-origin')) {
      return 'Couldn\'t reach Planetary Computer (CORS).';
    }
    if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
      return 'Couldn\'t reach Planetary Computer — check your connection.';
    }
    if (lower.includes('http 4') || lower.includes('http 5')) {
      return 'Planetary Computer returned an error. Try again in a moment.';
    }
    return `Search failed: ${raw}`;
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

  /** Cancel any in-flight PC STAC search. */
  cancel(): void {
    if (this._pcAbort) {
      try { this._pcAbort.abort(); } catch { /* ignore */ }
      this._pcAbort = null;
    }
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
    this._setStatus(`Opening ${loc.displayName}…`, 'opening');
    this._results.replaceChildren();
    // Direct handoff — main.ts wires this into `handleRemoteUrl` which
    // detects the EPT manifest by URL pattern and routes to the EPT
    // streaming path. No catalog query, no geocoder, no bbox-vs-COPC
    // mismatch.
    this._onPickUrl(loc.streamUrl, loc.displayName, curatedUsageCategory(loc.streamUrl));
  }

  /**
   * Surface a failed open in the catalog itself. Without this the fetch error
   * was reported elsewhere (the drop zone) while the catalog kept reading
   * "Opening …" — so a blocked remote fetch (e.g. a bucket that doesn't allow
   * the current origin) looked like a silent hang.
   */
  showOpenError(message: string): void {
    this._setStatus(message, 'error');
  }

  /**
   * Clear the "Opening …" pulse once a dataset has successfully attached.
   * Without a success transition the panel kept pulsing "Opening …" after the
   * scan was already loaded (it only had opening + error states). Clears the
   * text and both state classes so the status returns to neutral/idle.
   */
  markLoaded(): void {
    this._setStatus('', 'info');
  }

  private _setStatus(text: string, kind: 'info' | 'opening' | 'error' = 'info'): void {
    this._status.textContent = text;
    this._status.classList.toggle('is-opening', kind === 'opening');
    this._status.classList.toggle('is-error', kind === 'error');
  }
}

