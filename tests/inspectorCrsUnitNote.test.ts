/**
 * The Inspector's coordinate-system section says why a linear unit is
 * withheld, or why it reads as it does, when the CRS carries a unit note.
 *
 * A GeoKeys file whose ProjLinearUnitsGeoKey contradicts its code, or whose
 * ProjectedCRSGeoKey holds a code that is not projected, resolves with an
 * unknown unit and a note. The note was recorded and shown nowhere, so the
 * user saw metric figures withheld with no reason.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderCrs } from '../src/ui/inspector/renderCrs';
import { resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';
import { crsFromGeoTiff } from '../src/io/crs';
import { FakeEl, findContaining } from './support/measurePanelDom';
import { installInspectorFakeDom } from './helpers/inspectorLazyHarness';

/** A GeoKeyDirectory payload from [key, value] pairs (all inline shorts). */
function geoKeys(keys: readonly (readonly [number, number])[]): Uint8Array {
  const u = new Uint16Array(4 + keys.length * 4);
  u.set([1, 1, 0, keys.length]);
  keys.forEach(([k, v], i) => u.set([k, 0, 1, v], 4 + i * 4));
  return new Uint8Array(u.buffer);
}

/** The section's "Linear unit:" row, if any. */
const unitRow = (body: FakeEl): FakeEl | undefined =>
  body.children.find((c) => c.textContent.startsWith('Linear unit:'));

function render(keys: readonly (readonly [number, number])[]): FakeEl {
  const crs = resolvedFromCrsInfo(crsFromGeoTiff(geoKeys(keys), null, null), 'las-vlr')!;
  const body = new FakeEl('div');
  renderCrs(body as unknown as HTMLElement, crs, () => {});
  return body;
}

describe('the Inspector shows the linear unit note', () => {
  beforeAll(() => installInspectorFakeDom());

  it('a 3076 that contradicts the code', () => {
    const body = render([[1024, 1], [3072, 2229], [3076, 9001]]);
    const row = unitRow(body);
    expect(row).toBeDefined();
    expect(row!.className).toBe('olv-crs-warning');
    expect(row!.textContent).toBe('Linear unit: ProjLinearUnitsGeoKey (3076) declares metres, but EPSG:2229 is defined in US survey feet; the linear unit is withheld.');
  });

  it('a 3072 that holds a geographic code', () => {
    const body = render([[1024, 1], [3072, 4326], [3076, 9001]]);
    expect(unitRow(body)?.textContent).toContain('ProjectedCRSGeoKey (3072) holds EPSG:4326, a geographic CRS');
  });

  it('no row when the CRS carries no note', () => {
    const body = render([[1024, 1], [3072, 32612], [3076, 9001]]);
    expect(unitRow(body)).toBeUndefined();
    expect(findContaining(body, 'Linear unit:')).toBeUndefined();
  });
});
