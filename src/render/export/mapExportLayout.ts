/**
 * mapExportLayout.ts
 *
 * Pure-data layout builder for "map view" exports — the
 * supplementary overlay that turns a plain PNG snapshot of the scan
 * into something a surveyor can hand off. Lays out the four standard
 * cartographic affordances:
 *
 *   1. Scale bar (already drawn by `drawScaleBar` — this module
 *      decides WHERE it lands, not how it renders).
 *   2. North arrow.
 *   3. CRS label (e.g. "EPSG:26918 — NAD83 / UTM 18N").
 *   4. Legend block (colour ramp + labels, optional).
 *
 * The composition is computed against a fixed canvas size + a
 * padding budget. The host (PNG export pipeline) reads the slot
 * rectangles and draws each element via its existing canvas helpers.
 *
 * The split exists because the PNG export already owns a canvas and
 * a drawing context — it's the layout decisions that benefit from
 * being separated and unit-tested. Pure functions are cheap; the
 * canvas wiring is the part we're deferring to a later cut.
 *
 * No DOM, no canvas. Runs unchanged in Node tests.
 */

/** A rectangular slot in canvas-pixel coordinates. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Inputs to `composeMapExportLayout`. */
export interface MapExportLayoutInput {
  /** Total canvas width in pixels. */
  readonly canvasWidth: number;
  /** Total canvas height in pixels. */
  readonly canvasHeight: number;
  /** Outer padding from the canvas edges. Defaults to 24 px. */
  readonly padding?: number;
  /** Whether to reserve a slot for the scale bar. */
  readonly includeScaleBar: boolean;
  /** Whether to reserve a slot for the north arrow. */
  readonly includeNorthArrow: boolean;
  /** Whether to reserve a slot for the CRS caption. */
  readonly includeCrsLabel: boolean;
  /**
   * Whether to reserve a slot for a legend block (e.g. the height
   * colour ramp). Optional — many exports skip this.
   */
  readonly includeLegend: boolean;
}

/** Output: each named slot, populated only when requested. */
export interface MapExportLayout {
  /** Scale-bar slot, bottom-left. Undefined when not included. */
  readonly scaleBar?: Rect;
  /** North-arrow slot, top-right. Undefined when not included. */
  readonly northArrow?: Rect;
  /** CRS-label slot, bottom-right. Undefined when not included. */
  readonly crsLabel?: Rect;
  /** Legend block slot, top-left. Undefined when not included. */
  readonly legend?: Rect;
  /**
   * Effective inner rectangle of the map itself — everything
   * remaining after the overlay slots are reserved. Useful when the
   * host needs to know where the imagery should stop bleeding into
   * a slot.
   */
  readonly mapArea: Rect;
}

const SCALE_BAR_WIDTH = 180;
const SCALE_BAR_HEIGHT = 40;
const NORTH_ARROW_SIZE = 64;
const CRS_LABEL_WIDTH = 280;
const CRS_LABEL_HEIGHT = 28;
const LEGEND_WIDTH = 180;
const LEGEND_HEIGHT = 120;
const DEFAULT_PADDING = 24;

/**
 * Compute the layout for a map-export overlay. Pure: deterministic
 * given the same input. Slot sizes are fixed by typography + icon
 * conventions; the function only decides POSITIONING within the
 * canvas. Returns rectangles in canvas-pixel coordinates where
 * (0, 0) is the top-left.
 */
export function composeMapExportLayout(
  input: MapExportLayoutInput,
): MapExportLayout {
  const pad = input.padding ?? DEFAULT_PADDING;
  const w = input.canvasWidth;
  const h = input.canvasHeight;

  const scaleBar: Rect | undefined = input.includeScaleBar
    ? {
        x: pad,
        y: h - pad - SCALE_BAR_HEIGHT,
        width: SCALE_BAR_WIDTH,
        height: SCALE_BAR_HEIGHT,
      }
    : undefined;

  const northArrow: Rect | undefined = input.includeNorthArrow
    ? {
        x: w - pad - NORTH_ARROW_SIZE,
        y: pad,
        width: NORTH_ARROW_SIZE,
        height: NORTH_ARROW_SIZE,
      }
    : undefined;

  const crsLabel: Rect | undefined = input.includeCrsLabel
    ? {
        x: w - pad - CRS_LABEL_WIDTH,
        y: h - pad - CRS_LABEL_HEIGHT,
        width: CRS_LABEL_WIDTH,
        height: CRS_LABEL_HEIGHT,
      }
    : undefined;

  const legend: Rect | undefined = input.includeLegend
    ? {
        x: pad,
        y: pad,
        width: LEGEND_WIDTH,
        height: LEGEND_HEIGHT,
      }
    : undefined;

  // The map area is whatever rectangle remains after the slots are
  // reserved. We're conservative: shrink from every edge that has a
  // slot, never expand beyond the padded frame.
  const mapArea: Rect = {
    x: pad,
    y: pad,
    width: Math.max(0, w - pad * 2),
    height: Math.max(0, h - pad * 2),
  };

  return { scaleBar, northArrow, crsLabel, legend, mapArea };
}

/**
 * Format a CRS label for the bottom-right caption. Compact form:
 * "EPSG:26918 · NAD83 / UTM 18N". When the CRS is local or unknown,
 * the label reads "Local coordinates" / "CRS unknown" instead.
 */
export function formatCrsLabel(input: {
  readonly epsg?: number;
  readonly name?: string;
  readonly kind?: 'projected' | 'geographic' | 'local' | 'unknown';
}): string {
  if (input.kind === 'local') return 'Local coordinates';
  if (input.kind === 'unknown') return 'CRS unknown';
  const parts: string[] = [];
  if (typeof input.epsg === 'number' && Number.isFinite(input.epsg)) {
    parts.push(`EPSG:${input.epsg}`);
  }
  if (input.name && input.name !== `EPSG:${input.epsg}`) {
    parts.push(input.name);
  }
  return parts.length > 0 ? parts.join(' · ') : 'CRS pending';
}
