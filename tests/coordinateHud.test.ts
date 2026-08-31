/**
 * coordinateHud.test.ts — the persistent corner coordinate readout.
 *
 * Drives the pure component through the shared recording DOM stub. It renders a
 * CursorReadout the host already computed (from cursorReadout), and enforces the
 * honesty rules at the render boundary: no point ⇒ hidden (never a stale
 * coordinate), lat/lon shown only when the readout carried it, and the CRS +
 * frame-status badge always shown alongside the axes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeDom } from './support/measurePanelDom';
import { buildCoordinateHud } from '../src/ui/coordinateHud';
import type { CursorReadout } from '../src/geo/cursorReadout';

beforeEach(() => installFakeDom());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = (root: any, sel: string): any => root.querySelector(sel);

const axis = (label: string, text: string) =>
  ({ axis: 'x' as const, label, unit: ' m', value: 0, text });

const readout = (over: Partial<CursorReadout> = {}): CursorReadout => ({
  crsLabel: 'EPSG:32612',
  status: 'georeferenced',
  statusNote: null,
  unit: { token: 'metre', metresPerUnit: 1, label: 'm', suffix: ' m', known: true },
  unitNote: null,
  position: {
    axes: [axis('Easting', '482,193.42 m'), axis('Northing', '3,218,408.17 m'), axis('Elevation', '743.82 m')],
    vertical: axis('Elevation', '743.82 m'),
    upAxis: 'z',
  },
  geographic: null,
  text: 'EPSG:32612 · E 482,193.42 m N 3,218,408.17 m Z 743.82 m',
  ...over,
});

describe('buildCoordinateHud', () => {
  it('starts hidden until a readout with a point arrives', () => {
    const { element } = buildCoordinateHud();
    expect(element.className).toContain('olv-hidden');
  });

  it('renders one row per axis, plus the CRS and status badge', () => {
    const hud = buildCoordinateHud();
    hud.update(readout());
    expect(hud.element.className).not.toContain('olv-hidden');
    expect(q(hud.element, '.olv-coordinate-hud-rows').querySelectorAll('.olv-coordinate-hud-row')).toHaveLength(3);
    expect(q(hud.element, '.olv-coordinate-hud-value').textContent).toContain('482,193.42');
    expect(q(hud.element, '.olv-coordinate-hud-crs').textContent).toBe('EPSG:32612');
    expect(q(hud.element, '.olv-coordinate-hud-status').textContent).toMatch(/georeferenced/);
  });

  it('hides on null and on a readout with no point — never a stale coordinate', () => {
    const hud = buildCoordinateHud();
    hud.update(readout());
    hud.update(null);
    expect(hud.element.className).toContain('olv-hidden');
    hud.update(readout({ position: null }));
    expect(hud.element.className).toContain('olv-hidden');
  });

  it('shows lat/lon only when the readout carried a conversion', () => {
    const hud = buildCoordinateHud();
    hud.update(readout());
    expect(q(hud.element, '.olv-coordinate-hud-geo').className).toContain('olv-hidden');
    hud.update(
      readout({
        geographic: { lat: 29.05123, lon: -111.00234, method: 'proj4', text: 'Lat 29.051230° Lon -111.002340°' } as CursorReadout['geographic'],
      }),
    );
    const geo = q(hud.element, '.olv-coordinate-hud-geo');
    expect(geo.className).not.toContain('olv-hidden');
    expect(geo.textContent).toContain('29.051230');
  });

  it('badges a local frame distinctly from a georeferenced one', () => {
    const hud = buildCoordinateHud();
    hud.update(readout({ status: 'local', statusNote: 'No CRS resolved.' }));
    const status = q(hud.element, '.olv-coordinate-hud-status');
    expect(status.textContent).toMatch(/local/);
    expect(status.dataset.status).toBe('local');
  });
});
