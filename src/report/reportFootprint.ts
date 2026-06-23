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
  const width = input.extentX * uH;
  const depth = input.extentY * uH;
  const height = input.extentZ * uV;
  const density = width > 0 && depth > 0 ? input.pointCount / (width * depth) : Number.NaN;
  return { width, depth, height, density };
}
