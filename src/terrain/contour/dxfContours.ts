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
 * see only what the data supports. Elevation labels (when supplied) land
 * on their own CONTOUR_TEXT layer as TEXT entities, so they can be frozen
 * / restyled independently of the linework. A minimal LAYER table is
 * emitted so the layers exist on import.
 *
 * Units: a minimal HEADER section declares `$INSUNITS` so CAD imports stop
 * prompting for (or silently assuming) drawing units — the v0.4.4 file had
 * no HEADER at all, leaving every import unit-ambiguous.
 *
 * Scope (documented, no overclaim): this writes a minimal, widely-
 * accepted ASCII DXF (HEADER + TABLES + ENTITIES; LWPOLYLINE + TEXT
 * entities). It does not emit linetype definitions or extended data. That
 * is sufficient for contour interchange; richer DXF is a later cycle if
 * a real Civil 3D round-trip demands it.
 *
 * Pure data: no DOM, no three.js, no I/O. Returns a DXF string.
 */

import type { ContourFeature, ContourFeatureModel } from './contourFeatureModel';
import { contourShapeStyleLabel } from './contourShapeStyle';
import { decimalsForInterval, type ContourLabel } from './labelPlacement';
import { provenanceLines, type ExportProvenance } from '../export/exportProvenance';

interface LayerDef {
  readonly name: string;
  readonly color: number; // AutoCAD Color Index
}

const LAYERS: ReadonlyArray<LayerDef> = [
  { name: 'CONTOUR_INDEX', color: 1 }, // red
  { name: 'CONTOUR_INTER', color: 3 }, // green
  { name: 'CONTOUR_UNCERTAIN', color: 8 }, // dark grey
  { name: 'CONTOUR_TEXT', color: 7 }, // white/black — elevation labels
];

function layerFor(f: ContourFeature): string {
  if (f.isIndex) return 'CONTOUR_INDEX';
  return f.grade === 'solid' ? 'CONTOUR_INTER' : 'CONTOUR_UNCERTAIN';
}

/** The drawing's linear unit, for the `$INSUNITS` header variable. */
export type DxfLinearUnit = 'metre' | 'foot' | 'us-survey-foot' | 'unknown';

/**
 * `$INSUNITS` codes (DXF reference, table for the INSUNITS system variable):
 * 6 = meters, 2 = feet, 21 = US survey feet, 0 = unitless. "Unitless" is the
 * honest stamp when the caller genuinely doesn't know — CAD then prompts,
 * which beats silently assuming.
 */
const INSUNITS: Record<DxfLinearUnit, number> = {
  metre: 6,
  foot: 2,
  'us-survey-foot': 21,
  unknown: 0,
};

/** Options for {@link dxfContours}. */
export interface DxfContourOptions {
  /** Unified provenance, emitted as leading 999 comments. */
  readonly provenance?: ExportProvenance;
  /**
   * Elevation labels (same placements the SVG/PDF use). Emitted as TEXT
   * entities on the CONTOUR_TEXT layer; decimals derive from the model's
   * contour interval so sub-metre levels stay distinguishable.
   */
  readonly labels?: ReadonlyArray<ContourLabel>;
  /**
   * Drawing linear unit for `$INSUNITS`. Default 'metre' — the converter /
   * terrain stack's standing assumption (every unit-aware path defaults its
   * `unitToMetres` to 1); callers that resolve a feet CRS pass it explicitly.
   */
  readonly linearUnit?: DxfLinearUnit;
}

/**
 * Serialise the model to a minimal ASCII DXF string. When the unified
 * {@link ExportProvenance} is supplied, the full provenance block is emitted as
 * leading group-code-999 comments (ignored by CAD readers) so the file is
 * self-describing with the SAME provenance every other export carries. Without
 * provenance it falls back to the lone shape-style comment (back-compat).
 *
 * Accepts a bare `ExportProvenance` as the second argument for back-compat
 * with pre-v0.4.5 callers; new callers pass {@link DxfContourOptions}.
 */
export function dxfContours(
  model: ContourFeatureModel,
  optsOrProvenance?: ExportProvenance | DxfContourOptions,
): string {
  // Back-compat shim: the legacy second argument was the provenance object
  // itself; tell the two shapes apart by the provenance-only `software` field.
  const opts: DxfContourOptions =
    optsOrProvenance && 'software' in optsOrProvenance
      ? { provenance: optsOrProvenance as ExportProvenance }
      : ((optsOrProvenance as DxfContourOptions | undefined) ?? {});
  const provenance = opts.provenance;

  const out: string[] = [];
  const pair = (code: number, value: string | number) => {
    out.push(String(code));
    out.push(String(value));
  };

  // Provenance comments (group code 999 — ignored by CAD readers) so the file is
  // self-describing. With the unified provenance every line is stamped; without
  // it, the lone shape-style comment is kept for back-compat.
  if (provenance) {
    for (const line of provenanceLines(provenance)) pair(999, line);
  } else {
    pair(999, `OpenLiDARViewer contour style: ${contourShapeStyleLabel(model.contourStyle)}`);
  }

  // HEADER → $INSUNITS, so CAD knows the drawing unit instead of prompting.
  pair(0, 'SECTION');
  pair(2, 'HEADER');
  pair(9, '$INSUNITS');
  pair(70, INSUNITS[opts.linearUnit ?? 'metre']);
  pair(0, 'ENDSEC');

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

  // Elevation labels — TEXT entities on their own layer, at the same placed
  // positions the SVG/PDF labels use. Text height scales with the drawing
  // extent (≈ 1/100th of the long side, clamped) so labels are legible on a
  // 30 m room and a 3 km site alike, deterministically.
  const labels = opts.labels ?? [];
  if (labels.length > 0 && model.bbox) {
    const extent = Math.max(
      model.bbox.maxX - model.bbox.minX,
      model.bbox.maxY - model.bbox.minY,
    );
    const textHeight = Math.max(0.2, Math.min(5, extent / 100));
    const decimals = decimalsForInterval(model.intervalM);
    for (const lab of labels) {
      // Keep labels readable: DXF rotation (code 50) is degrees CCW; fold the
      // tangent into (−90°, 90°] so no label imports upside-down.
      let deg = (lab.angleRad * 180) / Math.PI;
      if (deg > 90) deg -= 180;
      else if (deg < -90) deg += 180;
      pair(0, 'TEXT');
      pair(8, 'CONTOUR_TEXT');
      pair(10, lab.x);
      pair(20, lab.y);
      pair(30, lab.value); // sit the label at its contour's elevation
      pair(40, textHeight);
      pair(50, Number(deg.toFixed(2)));
      pair(1, lab.value.toFixed(decimals));
    }
  }
  pair(0, 'ENDSEC');
  pair(0, 'EOF');

  return out.join('\n') + '\n';
}
