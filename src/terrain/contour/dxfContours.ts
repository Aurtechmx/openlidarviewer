/**
 * dxfContours.ts
 *
 * the CAD path, done last because DXF is the format tax. Each
 * contour run is emitted as an LWPOLYLINE with its elevation carried in
 * group code 38 (constant elevation), which AutoCAD / Civil 3D import as
 * the polyline's Z — so contours arrive at the right height without the
 * 3D-POLYLINE/VERTEX verbosity.
 *
 * Honesty by layer: index contours → CONTOUR_INDEX, confident
 * intermediate → CONTOUR_INTER, anything interpolated or unsupported →
 * CONTOUR_UNCERTAIN, so a surveyor can freeze the uncertain layer and
 * see only what the data supports. A minimal LAYER table is emitted so
 * the layers exist on import.
 *
 * Scope (documented, no overclaim): this writes a minimal, widely-
 * accepted ASCII DXF (TABLES + ENTITIES, LWPOLYLINE entities). It does
 * not emit a full HEADER, linetype definitions, or extended data. That
 * is sufficient for contour interchange; richer DXF is a later cycle if
 * a real Civil 3D round-trip demands it.
 *
 * Pure data: no DOM, no three.js, no I/O. Returns a DXF string.
 */

import type { ContourFeature, ContourFeatureModel } from './contourFeatureModel';

interface LayerDef {
  readonly name: string;
  readonly color: number; // AutoCAD Color Index
}

const LAYERS: ReadonlyArray<LayerDef> = [
  { name: 'CONTOUR_INDEX', color: 1 }, // red
  { name: 'CONTOUR_INTER', color: 3 }, // green
  { name: 'CONTOUR_UNCERTAIN', color: 8 }, // dark grey
];

function layerFor(f: ContourFeature): string {
  if (f.isIndex) return 'CONTOUR_INDEX';
  return f.grade === 'solid' ? 'CONTOUR_INTER' : 'CONTOUR_UNCERTAIN';
}

/** Serialise the model to a minimal ASCII DXF string. */
export function dxfContours(model: ContourFeatureModel): string {
  const out: string[] = [];
  const pair = (code: number, value: string | number) => {
    out.push(String(code));
    out.push(String(value));
  };

  // TABLES → LAYER
  pair(0, 'SECTION');
  pair(2, 'TABLES');
  pair(0, 'TABLE');
  pair(2, 'LAYER');
  pair(70, LAYERS.length);
  for (const l of LAYERS) {
    pair(0, 'LAYER');
    pair(2, l.name);
    pair(70, 0);
    pair(62, l.color);
    pair(6, 'CONTINUOUS');
  }
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');

  // ENTITIES
  pair(0, 'SECTION');
  pair(2, 'ENTITIES');
  for (const f of model.features) {
    if (f.coordinates.length < 2) continue;
    pair(0, 'LWPOLYLINE');
    pair(8, layerFor(f));
    pair(90, f.coordinates.length);
    pair(70, f.closed ? 1 : 0); // bit 1 = closed
    pair(38, f.value); // constant elevation → Z
    for (const [x, y] of f.coordinates) {
      pair(10, x);
      pair(20, y);
    }
  }
  pair(0, 'ENDSEC');
  pair(0, 'EOF');

  return out.join('\n') + '\n';
}
