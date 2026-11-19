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
import { LOCAL_UNIT_NAMES, type LocalLinearUnit } from '../../geo/CrsOverrideStore';

export type CrsOverride = {
  epsg: number | null;
  kind: 'projected' | 'geographic' | 'local' | 'detected';
  /** With `kind: 'local'`: the unit the user declared. */
  localUnit?: LocalLinearUnit;
};

/** The picker's local choices with a declared unit, in the order shown. */
const LOCAL_UNIT_OPTIONS: readonly (readonly [value: string, unit: LocalLinearUnit])[] = [
  ['__local_m__', 'metre'],
  ['__local_ussft__', 'us-survey-foot'],
  ['__local_ft__', 'foot'],
];

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
    'las-evlr': 'LAS / LAZ georeference EVLR (extended VLR)',
    'copc-meta': 'COPC metadata',
    'ept-srs': 'EPT srs.wkt',
    'tileset-region': '3D Tiles region bounding volume',
    'catalog-tile': 'Public-catalog tile',
    'user-override': 'User override',
    'format-specification': 'Format specification (metres)',
    'default-assumption': 'No metadata',
  };
  // The file declares no CRS; its format specification gives the metres.
  const sourceText = c.assertedBy
    ? `catalogue (${c.assertedBy}), not the file`
    : c.source === 'format-specification' && c.formatSpecification
      ? `${c.formatSpecification} specification (metres)`
      : sourceLabel[c.source];
  body.append(
    el('div', { className: 'olv-crs-meta' }, [
      el('span', { className: 'olv-crs-meta-row', text: `Confidence: ${confidenceLabel[c.confidence]}` }),
      el('span', { className: 'olv-crs-meta-row', text: `Source: ${sourceText}` }),
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
  // Why the linear unit reads as it does, or why it is withheld.
  if (c.linearUnitNote) {
    body.append(el('div', { className: 'olv-crs-warning olv-crs-unit-note', text: `${c.linearUnitNote}.` }));
  }
  if (c.userConfirmed && c.source === 'user-override') {
    body.append(
      el('div', {
        className: 'olv-crs-warning-soft',
        text: 'CRS override active. Coordinate conversion uses your selection.',
      }),
    );
  } else if (c.source === 'catalog-tile') {
    body.append(
      el('div', {
        className: 'olv-crs-warning-soft',
        text: 'CRS taken from the catalogue entry; the file declares none. Pick another if it is wrong.',
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
  // The active local choice is preselected, so the select shows it rather
  // than its first option. Only the user's own choice: a file's local frame
  // was not picked here.
  const activeLocal = c.kind === 'local' && c.source === 'user-override';
  const optLocal = document.createElement('option');
  optLocal.value = '__local__';
  optLocal.textContent = 'Local coordinates (no CRS)';
  if (activeLocal && !LOCAL_UNIT_OPTIONS.some(([, u]) => u === c.linearUnit)) optLocal.selected = true;
  select.append(optLocal);
  for (const [value, unit] of LOCAL_UNIT_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = LOCAL_UNIT_NAMES[unit];
    if (activeLocal && c.linearUnit === unit) opt.selected = true;
    select.append(opt);
  }
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
    const localUnit = LOCAL_UNIT_OPTIONS.find(([value]) => value === v)?.[1];
    if (localUnit) {
      onOverride({ epsg: null, kind: 'local', localUnit });
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
