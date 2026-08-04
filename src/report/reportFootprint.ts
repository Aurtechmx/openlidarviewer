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
   * Whether the source CRS declares a REAL linear unit — the fail-closed gate
   * (`isLinearUnitKnown` at the call site). `false` when the CRS is absent or
   * carries `linearUnit: 'unknown'` (the inert `linearUnitToMetres: 1`
   * placeholder). When `false` the footprint is returned in RAW SOURCE UNITS
   * with no metre / pts·m⁻² claim — multiplying a source span by the placeholder
   * 1 and stamping "m" would report feet (or degrees) as metres. Matches the
   * on-screen Scan Report (`scanReportUnitBasis`) and streaming report
   * (`streamingExtentRows`) gates.
   */
  readonly linearUnitKnown: boolean;
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

/**
 * A footprint whose CRS declares a real linear unit: extents in metres and a
 * density in pts·m⁻² the report may print with its "m" / "pts/m²" suffixes.
 */
export interface FootprintConfirmed {
  readonly unitStatus: 'confirmed';
  /** Width (X) in metres. */
  readonly widthMetres: number;
  /** Depth in metres. */
  readonly depthMetres: number;
  /** Height in metres. */
  readonly heightMetres: number;
  /** Footprint density in pts·m⁻² on the XY footprint; NaN when extent is degenerate. */
  readonly densityPerM2: number;
}

/**
 * A footprint whose CRS does NOT declare a real linear unit. The spans are the
 * RAW source-unit extents; there is no metre value and no density, because
 * converting an unknown unit to metres (or grading pts·m⁻²) would assert a
 * conversion nobody performed. The report renders these with a "source units"
 * label and an explicit "units unconfirmed" warning instead of "m" / "pts/m²".
 */
export interface FootprintUnknownUnit {
  readonly unitStatus: 'unknown';
  /** Width (X) span in raw source units. */
  readonly widthSourceUnits: number;
  /** Depth span in raw source units. */
  readonly depthSourceUnits: number;
  /** Height span in raw source units. */
  readonly heightSourceUnits: number;
}

/** Discriminated on {@link FootprintConfirmed.unitStatus} vs {@link FootprintUnknownUnit.unitStatus}. */
export type Footprint = FootprintConfirmed | FootprintUnknownUnit;

/**
 * Project a raw bounding-box extent into a footprint, FAILING CLOSED on an
 * unconfirmed linear unit.
 *
 * When `linearUnitKnown` is true the extents are converted to metres with the
 * declared unit factors and a pts·m⁻² density is computed — the historical,
 * byte-identical behaviour for a real CRS. When it is false the CRS carries no
 * usable linear unit (absent, or the `linearUnit: 'unknown'` placeholder whose
 * `linearUnitToMetres` is the inert 1), so the raw source-unit spans are
 * returned with NO metre value and NO density: stamping "m" / "pts/m²" on a
 * source span would report feet (or degrees) as metres. This mirrors the gate
 * the on-screen Scan Report (`scanReportUnitBasis`) and the streaming Scan
 * Report (`streamingExtentRows`) already apply.
 */
export function footprintMetres(input: FootprintInput): Footprint {
  // Width is X in both conventions. The other two swap: Z-up puts depth in Y
  // and height in Z, Y-up puts height in Y and depth in Z. The vertical factor
  // follows the height, never the slot.
  const zUp = input.zUp ?? true;
  const spanWidth = input.extentX;
  const spanDepth = zUp ? input.extentY : input.extentZ;
  const spanHeight = zUp ? input.extentZ : input.extentY;

  if (!input.linearUnitKnown) {
    return {
      unitStatus: 'unknown',
      widthSourceUnits: spanWidth,
      depthSourceUnits: spanDepth,
      heightSourceUnits: spanHeight,
    };
  }

  const uH = Number.isFinite(input.linearUnitToMetres) ? (input.linearUnitToMetres as number) : 1;
  const uV = Number.isFinite(input.verticalUnitToMetres) ? (input.verticalUnitToMetres as number) : uH;
  const widthMetres = spanWidth * uH;
  const depthMetres = spanDepth * uH;
  const heightMetres = spanHeight * uV;
  const densityPerM2 =
    widthMetres > 0 && depthMetres > 0 ? input.pointCount / (widthMetres * depthMetres) : Number.NaN;
  return { unitStatus: 'confirmed', widthMetres, depthMetres, heightMetres, densityPerM2 };
}
