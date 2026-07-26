/**
 * reportFootprint.ts
 *
 * Convert a cloud's raw bounding-box extent (in its own CRS's linear units)
 * into the metres-and-pts·m⁻² footprint the report's `MetadataInputs` is
 * contracted to carry.
 *
 * Why this exists: a foot-CRS scan's bounds extent is in US-survey-feet, not
 * metres. Feeding those raw numbers straight into the report overstated the
 * headline area ~10.76× (ft² printed as m²) and graded density (pts/ft²)
 * against the USGS pts/m² Quality-Level thresholds — silently wrong on output
 * that *looks* authoritative. Both report-build paths (streaming + static)
 * funnel through here so the conversion can't drift between them.
 */

export interface FootprintInput {
  /** Raw X / Y / Z extent of the bounding box, in the source CRS linear units. */
  readonly extentX: number;
  readonly extentY: number;
  readonly extentZ: number;
  /** Total point count the density should reflect (file-scale, not strided). */
  readonly pointCount: number;
  /** Horizontal CRS unit → metres (1 for a metre CRS, ~0.3048 for feet). */
  readonly linearUnitToMetres?: number;
  /** Vertical unit → metres, when the source declares one distinct from horizontal. */
  readonly verticalUnitToMetres?: number;
  /**
   * Whether the source frame is Z-up. LAS-family, COPC and EPT are Z-up by
   * spec; PLY, OBJ and glTF load in their native Y-up frame, where Y carries
   * height and Z carries ground depth. Defaults to `true`, so a caller that
   * does not know the axis keeps the historical behaviour.
   *
   * Reading a Y-up cloud's extents as Z-up puts the building height into
   * "Depth", divides the point count by a vertical cross-section instead of the
   * ground footprint, and applies the vertical unit factor to a horizontal
   * span. The on-screen Scan Report has been axis-aware since it was written
   * (see `isZUpFormat` in io/sniffFormat); the PDF path was not, and the two
   * disagreed on every mesh-format scan.
   */
  readonly zUp?: boolean;
}

export interface FootprintMetres {
  /** Width (X) in metres. */
  readonly width: number;
  /** Depth (Y) in metres. */
  readonly depth: number;
  /** Height (Z) in metres. */
  readonly height: number;
  /** Footprint density in pts·m⁻² on the XY footprint; NaN when extent is degenerate. */
  readonly density: number;
}

/**
 * Project a raw bounding-box extent into metres + pts·m⁻². A missing or
 * non-finite unit factor falls back to 1 (treat the source as metres) so a
 * unit-less cloud degrades to today's behaviour rather than NaN.
 */
export function footprintMetres(input: FootprintInput): FootprintMetres {
  const uH = Number.isFinite(input.linearUnitToMetres) ? (input.linearUnitToMetres as number) : 1;
  const uV = Number.isFinite(input.verticalUnitToMetres) ? (input.verticalUnitToMetres as number) : uH;
  // Width is X in both conventions. The other two swap: Z-up puts depth in Y
  // and height in Z, Y-up puts height in Y and depth in Z. The vertical factor
  // follows the height, never the slot.
  const zUp = input.zUp ?? true;
  const width = input.extentX * uH;
  const depth = (zUp ? input.extentY : input.extentZ) * uH;
  const height = (zUp ? input.extentZ : input.extentY) * uV;
  const density = width > 0 && depth > 0 ? input.pointCount / (width * depth) : Number.NaN;
  return { width, depth, height, density };
}
