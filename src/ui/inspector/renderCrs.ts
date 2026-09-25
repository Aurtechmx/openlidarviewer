/**
 * renderCrs.ts
 *
 * The Inspector's "Coordinate system" section body, split out of
 * `Inspector.ts` as a lazy chunk (loaded via `loadRenderCrs()` in
 * `lazyChunks.ts`). Pulled out for its own weight and for the CRS-catalog
 * table it drags in: `listCrsEntriesByRegion()`/`getCrsEntry()` iterate a
 * large static EPSG table (global/US/Mexico/Europe/other) to populate the
 * override `<select>`, which otherwise sits in the eager `index` chunk for
 * every user regardless of whether they ever open this section.
 *
 * Pure render function — no state of its own. `Inspector.setCrs()` keeps its
 * synchronous, `void`-returning signature; it shows a loading placeholder,
 * imports this module, then calls `renderCrs` once the chunk resolves.
 */

import { el } from '../dom';
import type { ResolvedCrs } from '../../geo/CoordinateTypes';
import { listCrsEntriesByRegion, getCrsEntry } from '../../geo/CrsRegistry';

export type CrsOverride = {
  epsg: number | null;
  kind: 'projected' | 'geographic' | 'local' | 'detected';
};

/** Render the full Coordinate-system section body into `body`. */
export function renderCrs(
  body: HTMLElement,
  c: ResolvedCrs,
  onOverride: (override: CrsOverride) => void,
): void {
  body.replaceChildren();

  // ── Detected / active CRS summary ──────────────────────────────────────
  const headerRow = el('div', { className: 'olv-crs-summary' }, [
    el('span', { className: 'olv-crs-name', text: c.name }),
  ]);
  if (typeof c.epsg === 'number') {
    headerRow.append(el('span', { className: 'olv-crs-epsg', text: `EPSG:${c.epsg}` }));
  }
  body.append(headerRow);

  // Confidence + source row.
  const confidenceLabel: Record<typeof c.confidence, string> = {
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    none: 'None',
  };
  const sourceLabel: Record<typeof c.source, string> = {
    'las-vlr': 'LAS / LAZ georeference VLR',
    'copc-meta': 'COPC metadata',
    'ept-srs': 'EPT srs.wkt',
    'tileset-region': '3D Tiles region bounding volume',
    'catalog-tile': 'Public-catalog tile',
    'user-override': 'User override',
    'default-assumption': 'No metadata',
  };
  body.append(
    el('div', { className: 'olv-crs-meta' }, [
      el('span', { className: 'olv-crs-meta-row', text: `Confidence: ${confidenceLabel[c.confidence]}` }),
      el('span', { className: 'olv-crs-meta-row', text: `Source: ${sourceLabel[c.source]}` }),
    ]),
  );

  // ── Safety warnings (kind-specific) ────────────────────────────────────
  if (c.kind === 'unknown') {
    body.append(
      el('div', {
        className: 'olv-crs-warning',
        text: 'CRS unknown. Coordinates are shown in source units only.',
      }),
    );
  } else if (c.kind === 'geographic') {
    body.append(
      el('div', {
        className: 'olv-crs-warning',
        text: 'Dataset coordinates are geographic degrees. Metric distances may require projection.',
      }),
    );
  } else if (c.confidence === 'low') {
    body.append(
      el('div', {
        className: 'olv-crs-warning',
        text: 'Low-confidence detection. Confirm before using converted coordinates.',
      }),
    );
  }
  if (c.userConfirmed && c.source === 'user-override') {
    body.append(
      el('div', {
        className: 'olv-crs-warning-soft',
        text: 'CRS override active. Coordinate conversion uses your selection.',
      }),
    );
  }

  // ── Override picker ────────────────────────────────────────────────────
  const select = el('select', {
    className: 'olv-crs-select',
    ariaLabel: 'Coordinate reference system',
    tip: 'Keep the detected coordinate system, pick another, or treat the coordinates as local.',
  }) as HTMLSelectElement;
  const optDetected = document.createElement('option');
  optDetected.value = '__detected__';
  optDetected.textContent =
    c.source === 'user-override' ? 'Reset to detected' : 'Use detected';
  select.append(optDetected);
  const optLocal = document.createElement('option');
  optLocal.value = '__local__';
  optLocal.textContent = 'Local coordinates (no CRS)';
  select.append(optLocal);
  for (const group of listCrsEntriesByRegion()) {
    const og = document.createElement('optgroup');
    og.label = ({
      global: 'Global',
      'united-states': 'United States',
      mexico: 'Mexico',
      europe: 'Europe',
      other: 'Other',
    } as const)[group.region];
    for (const entry of group.entries) {
      const opt = document.createElement('option');
      opt.value = String(entry.epsg);
      opt.textContent = `${entry.label} (EPSG:${entry.epsg})`;
      opt.title = entry.note;
      // Preselect the currently active EPSG when it matches.
      if (typeof c.epsg === 'number' && entry.epsg === c.epsg) {
        opt.selected = true;
      }
      og.append(opt);
    }
    select.append(og);
  }
  select.addEventListener('change', () => {
    const v = select.value;
    if (v === '__detected__') {
      // "Use detected" — clear any override and re-run detection. Distinct
      // from "Local coordinates" below: both used to send the same
      // { epsg: null, kind: 'local' }, so choosing local silently reverted to
      // the detected CRS and a genuine local override could never persist (C3).
      onOverride({ epsg: null, kind: 'detected' });
      return;
    }
    if (v === '__local__') {
      // Pin genuine local coordinates (no CRS) — persisted, not cleared.
      onOverride({ epsg: null, kind: 'local' });
      return;
    }
    const epsg = Number.parseInt(v, 10);
    if (!Number.isFinite(epsg)) return;
    const entry = getCrsEntry(epsg);
    if (!entry) return;
    onOverride({ epsg, kind: entry.kind });
  });
  body.append(
    el('label', { className: 'olv-crs-picker-label', text: 'Override' }),
    select,
  );
}
