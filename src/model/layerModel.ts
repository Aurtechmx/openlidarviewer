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
  readonly isGeographic?: boolean;
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
  /** One-line plain-language summary; empty when nothing actionable. */
  readonly summary: string;
}

/** A stable horizontal-CRS key for a layer, or null when none is declared. */
function horizontalKey(layer: LayerInfo): string | null {
  if (typeof layer.epsg === 'number') return `EPSG:${layer.epsg}`;
  if (layer.crsName && layer.crsName.trim().length > 0) return layer.crsName.trim();
  return null;
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

  const empty = (summary: string): CrsMismatch => ({
    hasMismatch: false,
    referenceLabel: null,
    mismatched: [],
    unknown,
    summary,
  });

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
    if (referenceVertical !== null && vertical !== null && vertical !== referenceVertical) {
      mismatched.push({
        id: layer.id,
        reason: `vertical datum ${vertical} differs from ${referenceVertical}`,
      });
    }
  }

  if (mismatched.length === 0) return empty('');

  const n = mismatched.length;
  const unknownNote =
    unknown.length > 0
      ? ` ${unknown.length} more without a declared CRS.`
      : '';
  return {
    hasMismatch: true,
    referenceLabel,
    mismatched,
    unknown,
    summary:
      `${n} layer${n === 1 ? '' : 's'} don't share the reference CRS ` +
      `(${referenceLabel}) — an overlay may be misaligned.${unknownNote}`,
  };
}
