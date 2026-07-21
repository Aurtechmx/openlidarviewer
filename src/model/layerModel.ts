/**
 * layerModel.ts
 *
 * The pure logic behind the Layers manager: resolving which loaded clouds are
 * effectively visible once an isolate/solo target is applied, and detecting when
 * two or more loaded clouds DON'T share a coordinate reference — so an overlay
 * that silently mixes mismatched frames gets flagged instead of trusted.
 *
 * Pure: no DOM, no three.js, no CRS service. The viewer/UI feed plain
 * `LayerInfo` records and act on the results. This is the seam change-detection
 * (two-epoch comparison) builds on: it must know whether the two epochs share a
 * CRS before reporting change between them.
 *
 * Honesty intent: a layer with no declared CRS is reported as `unknown`, never
 * silently treated as matching — "can't compare" is a distinct state from
 * "matches". A real mismatch produces a plain-language summary the UI surfaces.
 */

export interface LayerInfo {
  readonly id: string;
  readonly name: string;
  readonly pointCount: number;
  readonly visible: boolean;
  readonly locked: boolean;
  /** Horizontal EPSG code, when known. */
  readonly epsg?: number;
  /** Human CRS label (e.g. "WGS 84 / UTM zone 12N"), when known. */
  readonly crsName?: string;
  /** Vertical datum label or `EPSG:<code>`, when the source declares one. */
  readonly verticalDatum?: string;
  /** True when the CRS is geographic (lat/lon). */
  /** Vertical CRS EPSG code, when declared — authoritative over the label. */
  readonly verticalEpsg?: number;
  readonly isGeographic?: boolean;
  /**
   * Metres per horizontal linear unit, when the CRS declares one. The frame's
   * precision gate converts the Float32 quantum through this before judging it
   * against a budget in metres; absent means the cost cannot be bounded, and
   * an unbounded cost refuses the mount rather than assuming metres.
   */
  readonly linearUnitToMetres?: number;
}

/**
 * Effective visibility once an isolate/solo target is applied. With a solo
 * target only that layer is shown; otherwise each layer keeps its own
 * `visible` flag. (Solo is a view state — it never mutates the per-layer flag,
 * so clearing solo restores exactly what the user had.)
 */
export function resolveVisibility(
  layers: readonly LayerInfo[],
  soloId: string | null,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const layer of layers) {
    out.set(layer.id, soloId !== null ? layer.id === soloId : layer.visible);
  }
  return out;
}

/** Toggle solo: clicking the already-soloed layer clears it; else solo that one. */
export function nextSolo(currentSolo: string | null, clickedId: string): string | null {
  return currentSolo === clickedId ? null : clickedId;
}

export interface CrsMismatch {
  /** True when at least two CRS-known layers don't share a horizontal CRS / vertical datum. */
  readonly hasMismatch: boolean;
  /** The reference (majority) horizontal CRS label the others are compared to, or null. */
  readonly referenceLabel: string | null;
  /** Layers that differ from the reference, each with a plain reason. */
  readonly mismatched: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  /** Layers carrying no declarable CRS — can't be compared (distinct from mismatching). */
  readonly unknown: readonly string[];
  /**
   * Layers whose heights can't be confirmed to sit on the reference's vertical
   * datum, because a datum is missing on one side or on both.
   *
   * Deliberately NOT folded into {@link mismatched}: nothing proves these
   * disagree, and callers treat `mismatched` as a proven difference. The common
   * case is one tile declaring NAVD88 (orthometric) beside a plain LAS whose Z
   * is GNSS ellipsoidal height — tens of metres apart, with no declaration
   * either way. Silence there read as agreement.
   */
  readonly verticalUnconfirmed: readonly string[];
  /** One-line plain-language summary; empty when nothing actionable. */
  readonly summary: string;
}

/** A stable horizontal-CRS key for a layer, or null when none is declared. */
export function horizontalKey(layer: LayerInfo): string | null {
  if (typeof layer.epsg === 'number') return `EPSG:${layer.epsg}`;
  const name = layer.crsName?.trim();
  if (!name) return null;
  // The CRS parsers emit "Unknown CRS" (and "Unknown CRS (truncated …)") as a
  // DISPLAY name when nothing could be parsed. Falling back to it here turned a
  // placeholder into an identity, so two un-georeferenced layers compared equal:
  // reported as sharing a coordinate system, absent from the `unknown` list, and
  // merged into the project frame as aligned. A placeholder is the absence of a
  // CRS, not one — "can't compare" stays distinct from "matches".
  if (/^Unknown CRS\b/i.test(name)) return null;
  return name;
}

/** A readable label for a layer's horizontal CRS. */
function horizontalLabel(layer: LayerInfo): string {
  return layer.crsName?.trim() || horizontalKey(layer) || 'unknown CRS';
}

/**
 * Detect whether the CRS-known layers share a coordinate reference. The most
 * common horizontal CRS is taken as the reference (first-seen breaks ties); any
 * layer whose horizontal CRS differs, or which shares the horizontal CRS but
 * declares a different vertical datum, is flagged. Fewer than two known layers
 * can't mismatch.
 */
export function detectCrsMismatch(layers: readonly LayerInfo[]): CrsMismatch {
  const known: { layer: LayerInfo; key: string }[] = [];
  const unknown: string[] = [];
  for (const layer of layers) {
    const key = horizontalKey(layer);
    if (key === null) unknown.push(layer.id);
    else known.push({ layer, key });
  }

  const empty = (summary: string, verticalUnconfirmed: string[] = []): CrsMismatch => ({
    hasMismatch: false,
    referenceLabel: null,
    mismatched: [],
    unknown,
    verticalUnconfirmed,
    summary,
  });

  /** Plain-language note for heights that can't be put on a common reference. */
  const heightNote = (n: number): string =>
    `${n} layer${n === 1 ? '' : 's'} without a declared vertical datum — ` +
    `heights can't be confirmed on a common reference.`;

  if (known.length < 2) {
    // Nothing to compare against — surface only an "unknown CRS" note if any.
    return empty(
      unknown.length > 0 && layers.length > 1
        ? `${unknown.length} layer${unknown.length === 1 ? '' : 's'} without a declared CRS — can't check alignment.`
        : '',
    );
  }

  // Reference = most common horizontal key, first-seen breaking ties.
  const counts = new Map<string, number>();
  const firstSeen: string[] = [];
  for (const { key } of known) {
    if (!counts.has(key)) firstSeen.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let referenceKey = firstSeen[0];
  for (const key of firstSeen) {
    if ((counts.get(key) ?? 0) > (counts.get(referenceKey) ?? 0)) referenceKey = key;
  }

  const referenceEntry = known.find((k) => k.key === referenceKey)!;
  const referenceVertical = referenceEntry.layer.verticalDatum ?? null;
  const referenceLabel = horizontalLabel(referenceEntry.layer);

  const mismatched: { id: string; reason: string }[] = [];
  // Heights that can't be placed on the reference's datum — see the field doc.
  // A layer is unconfirmable when IT declares no datum, or when the reference
  // declares none (nothing to compare against, so no layer's heights can be
  // confirmed). Both are "don't know", never "differ".
  const verticalUnconfirmed: string[] = [];
  for (const { layer, key } of known) {
    if (key !== referenceKey) {
      mismatched.push({
        id: layer.id,
        reason: `${horizontalLabel(layer)} differs from ${referenceLabel}`,
      });
      continue;
    }
    // Same horizontal CRS — check the vertical datum too (heights won't align
    // across different vertical datums even when the horizontal frame matches).
    const vertical = layer.verticalDatum ?? null;
    if (referenceVertical !== null && vertical !== null) {
      if (vertical !== referenceVertical) {
        mismatched.push({
          id: layer.id,
          reason: `vertical datum ${vertical} differs from ${referenceVertical}`,
        });
      }
      continue;
    }
    // Missing on one side or both. The dangerous mix is orthometric against
    // GNSS ellipsoidal height — tens of metres apart, and neither file has to
    // say so. Reported, never inferred.
    verticalUnconfirmed.push(layer.id);
  }

  if (mismatched.length === 0) {
    return empty(
      verticalUnconfirmed.length > 0 ? heightNote(verticalUnconfirmed.length) : '',
      verticalUnconfirmed,
    );
  }

  const n = mismatched.length;
  const unknownNote =
    unknown.length > 0
      ? ` ${unknown.length} more without a declared CRS.`
      : '';
  const heightSuffix =
    verticalUnconfirmed.length > 0 ? ` ${heightNote(verticalUnconfirmed.length)}` : '';
  return {
    hasMismatch: true,
    referenceLabel,
    mismatched,
    unknown,
    verticalUnconfirmed,
    summary:
      `${n} layer${n === 1 ? '' : 's'} don't share the reference CRS ` +
      `(${referenceLabel}) — an overlay may be misaligned.${unknownNote}${heightSuffix}`,
  };
}
