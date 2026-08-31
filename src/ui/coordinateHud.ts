/**
 * coordinateHud.ts — a persistent corner readout of the coordinate under the
 * cursor.
 *
 * Pure DOM. It renders a {@link CursorReadout} the host has already computed
 * from {@link cursorReadout}; it never resolves a CRS, converts a coordinate, or
 * invents a unit of its own. That keeps every honesty rule in one place (the
 * model): the HUD shows the frame's real axes with their real units, badges how
 * well the frame is known, and shows lat/lon only when a conversion actually
 * succeeded. `update(null)` — or a readout with no point under the cursor —
 * hides it, so it never displays a stale or empty coordinate.
 */

import type { CursorReadout } from '../geo/cursorReadout';
import { el } from './dom';

export interface MountedCoordinateHud {
  readonly element: HTMLElement;
  /** Render the readout, or hide the HUD with `null` / no point. */
  readonly update: (readout: CursorReadout | null) => void;
}

const STATUS_LABEL: Record<CursorReadout['status'], string> = {
  georeferenced: 'georeferenced',
  local: 'local frame',
  unresolved: 'frame unresolved',
};

/** Build the coordinate HUD. Hidden until the host feeds it a point. */
export function buildCoordinateHud(): MountedCoordinateHud {
  const root = el('div', { className: 'olv-coordinate-hud olv-hidden' });
  root.setAttribute('aria-live', 'off');
  const rows = el('div', { className: 'olv-coordinate-hud-rows' });
  const geo = el('div', { className: 'olv-coordinate-hud-geo' });
  const footer = el('div', { className: 'olv-coordinate-hud-footer' });
  const crs = el('span', { className: 'olv-coordinate-hud-crs' });
  const status = el('span', { className: 'olv-coordinate-hud-status' });
  footer.append(crs, status);
  root.append(rows, geo, footer);

  const update = (readout: CursorReadout | null): void => {
    // No point under the cursor ⇒ nothing to report: hide rather than freeze the
    // last coordinate, which would read as the point still being there.
    if (!readout || !readout.position) {
      root.classList.add('olv-hidden');
      rows.replaceChildren();
      return;
    }
    rows.replaceChildren();
    for (const axis of readout.position.axes) {
      const row = el('div', { className: 'olv-coordinate-hud-row' });
      row.append(
        el('span', { className: 'olv-coordinate-hud-axis', text: axis.label }),
        el('span', { className: 'olv-coordinate-hud-value', text: axis.text }),
      );
      rows.append(row);
    }
    // Lat/lon only when a converter actually produced it (the model guarantees
    // this — `geographic` is null otherwise).
    geo.textContent = readout.geographic ? readout.geographic.text : '';
    geo.classList.toggle('olv-hidden', readout.geographic === null);

    crs.textContent = readout.crsLabel;
    status.textContent = STATUS_LABEL[readout.status];
    status.title = readout.statusNote ?? '';
    // The badge colours by how well the frame is known.
    status.dataset.status = readout.status;
    root.classList.remove('olv-hidden');
  };

  return { element: root, update };
}
