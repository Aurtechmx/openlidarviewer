/**
 * src/geo/frameCompatibility.ts
 *
 * Two {@link SpatialContext}s, and the two SEPARATE permissions a consumer
 * needs before it may compare them:
 *
 *   • planimetric — may these two datasets be compared, differenced, or
 *     measured against each other in the horizontal plane?
 *   • vertical — may their HEIGHTS be compared?
 *
 * Keeping them apart is the point. The pre-existing epoch-comparison path
 * answered a single "are these compatible" question and then applied the
 * answer to both axes, which is wrong in both directions: two epochs on one
 * metre grid with two different vertical datums are planimetrically comparable
 * and vertically not, and two epochs on one vertical datum whose horizontal
 * unit is undeclared have comparable heights and no comparable footprint. A
 * consumer that reads one boolean cannot express either case, so it either
 * withholds a figure it could have reported or reports one it could not.
 *
 * Every verdict here fails CLOSED. An absent unit, an absent datum, or an
 * absent CRS identity is never resolved to a default that would let a claim
 * through — it produces `*Unverified`, and `*Comparable` stays false. A
 * PROVEN disagreement is reported distinctly (`*Conflict`) because absence of
 * evidence and evidence of absence deserve different words in the caveat.
 *
 * Pure — no DOM, no three.js, no proj4. Runs unchanged in Node tests.
 */

import type { SpatialContext } from './SpatialContext';

// ─────────────────────────────────────────────────────────────────────────────
// The verdict
// ─────────────────────────────────────────────────────────────────────────────

/** The two-axis compatibility verdict for a pair of spatial contexts. */
export interface FrameCompatibility {
  // ── Horizontal ───────────────────────────────────────────────────────────
  /** True when EITHER side is geographic — degrees never enter a linear metric. */
  readonly isGeographic: boolean;
  /** True only when BOTH sides declare a real linear unit. */
  readonly horizontalUnitKnown: boolean;
  /**
   * The linear-unit → metres factor the pair SHARES. Present only when both
   * units are known and equal; `undefined` when either is unknown or the two
   * disagree, because no single factor then describes both.
   */
  readonly horizontalUnitToMetres?: number;
  /** True when the two sides declare DIFFERENT horizontal frames (proven clash). */
  readonly horizontalFrameConflict: boolean;
  /** True when at least one side declares no usable horizontal identity. */
  readonly horizontalFrameUnverified: boolean;
  /**
   * The planimetric permission. True only when both frames are planar, both
   * linear units are known and equal, and no horizontal conflict was proven.
   */
  readonly planimetricComparable: boolean;

  // ── Vertical ─────────────────────────────────────────────────────────────
  /** True only when BOTH sides carry a real, positive vertical scale. */
  readonly verticalScaleKnown: boolean;
  /** The vertical → metres factor the pair SHARES; `undefined` when they differ. */
  readonly verticalUnitToMetres?: number;
  /** True when the two sides sit on DIFFERENT vertical references (proven clash). */
  readonly verticalFrameConflict: boolean;
  /** True when at least one side declares no vertical reference at all. */
  readonly verticalFrameUnverified: boolean;
  /**
   * The vertical permission. Decided WITHOUT reference to the horizontal
   * verdict: a shared, known vertical reference and a shared, known vertical
   * scale are necessary and sufficient.
   */
  readonly verticalComparable: boolean;

  /** Plain-language caveats, empty when both permissions are granted. */
  readonly notes: readonly string[];
}

/**
 * The horizontal identity a frame comparison keys on. EPSG when declared (the
 * authoritative form), else the CRS name, else `undefined` for "no identity" —
 * which is unverified, never a match. Two contexts that both resolve to
 * `undefined` are NOT thereby equal.
 */
function horizontalIdentity(ctx: SpatialContext): string | undefined {
  if (typeof ctx.epsg === 'number') return `epsg:${ctx.epsg}`;
  if (ctx.kind === 'unknown' || ctx.kind === 'local') return undefined;
  const name = ctx.crsName.trim();
  return name.length > 0 ? name : undefined;
}

/**
 * The CRS label when the source ACTUALLY declared one, and `null` when it did
 * not. Never the placeholder that `unknownCrs()` carries for display.
 *
 * The distinction is load-bearing wherever two datasets are checked for a
 * shared frame: a check written as `a.crs === b.crs` reads two undeclared
 * scans, both labelled "CRS unknown", as a MATCH and reports a confirmed
 * common frame that nothing established. Passing `null` keeps them on the
 * unverified branch, where they belong.
 */
export function declaredFrameLabel(ctx: SpatialContext): string | null {
  return ctx.kind === 'unknown' || ctx.kind === 'local' ? null : ctx.crsName;
}

/**
 * The vertical identity a frame comparison keys on. The reference CLASS from
 * {@link SpatialContext.verticalReference} is authoritative (it already folds
 * EPSG and name into one answer), and `'unknown'` means no identity — so two
 * undeclared datums do not match each other.
 */
function verticalIdentity(ctx: SpatialContext): string | undefined {
  if (ctx.verticalReference !== 'unknown') return ctx.verticalReference;
  const declared = ctx.verticalDatum?.trim().toLowerCase();
  return declared && declared.length > 0 ? declared : undefined;
}

/** Whether a metres-per-unit factor is a real measurement rather than a placeholder. */
function realFactor(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v) && v > 0;
}

/** Two factors describe the same scale (to floating-point tolerance). */
function sameFactor(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-12;
}

/**
 * Compare two spatial contexts and return the planimetric and vertical
 * permissions separately. See the module header for why they are separate.
 */
export function compareSpatialFrames(
  a: SpatialContext,
  b: SpatialContext,
): FrameCompatibility {
  const notes: string[] = [];

  // ── Horizontal ───────────────────────────────────────────────────────────
  const isGeographic = a.isGeographic || b.isGeographic;
  if (isGeographic) {
    notes.push(
      'Geographic (degree) frame — a degree is not a linear unit, so horizontal ' +
        'distances, areas and volumes are not computable. Reproject to a projected CRS.',
    );
  }

  const horizontalUnitKnown = a.linearUnitKnown && b.linearUnitKnown;
  if (!horizontalUnitKnown && !isGeographic) {
    notes.push(
      'Horizontal linear unit is unknown on at least one side — the grid spacing has no ' +
        'confirmed metre scale, so horizontal figures cannot be reported in metres.',
    );
  }
  const unitsAgree =
    horizontalUnitKnown && sameFactor(a.linearUnitToMetres, b.linearUnitToMetres);
  const horizontalUnitToMetres = unitsAgree ? a.linearUnitToMetres : undefined;

  const idA = horizontalIdentity(a);
  const idB = horizontalIdentity(b);
  const horizontalFrameUnverified = idA === undefined || idB === undefined;
  let horizontalFrameConflict = !horizontalFrameUnverified && idA !== idB;
  if (horizontalFrameConflict) {
    notes.push(
      `Horizontal CRS differs (${a.crsName} vs ${b.crsName}) — the two are not in the same frame.`,
    );
  } else if (horizontalUnitKnown && !unitsAgree) {
    // Same declared identity (or none) yet two different linear units. One of
    // the readings must be wrong, and neither factor may stand for the pair.
    horizontalFrameConflict = true;
    notes.push(
      `Horizontal linear unit differs (${a.linearUnit} vs ${b.linearUnit}) — ` +
        'one factor cannot convert both, so horizontal figures are withheld.',
    );
  } else if (horizontalFrameUnverified) {
    notes.push(
      'Horizontal CRS is unknown on at least one side — the two cannot be confirmed to ' +
        'share a frame, so treat any horizontal comparison as unverified, not measured.',
    );
  }

  const planimetricComparable =
    !isGeographic && horizontalUnitKnown && unitsAgree && !horizontalFrameConflict
    && !horizontalFrameUnverified;

  // ── Vertical — decided on its OWN evidence, not the horizontal verdict ────
  const aScale = realFactor(a.verticalUnitToMetres) ? a.verticalUnitToMetres : undefined;
  const bScale = realFactor(b.verticalUnitToMetres) ? b.verticalUnitToMetres : undefined;
  const verticalScaleKnown = aScale !== undefined && bScale !== undefined;
  const verticalScalesAgree = verticalScaleKnown && sameFactor(aScale, bScale);
  const verticalUnitToMetres = verticalScalesAgree ? aScale : undefined;

  const vidA = verticalIdentity(a);
  const vidB = verticalIdentity(b);
  const verticalFrameUnverified = vidA === undefined || vidB === undefined;
  const verticalFrameConflict = !verticalFrameUnverified && vidA !== vidB;
  if (verticalFrameConflict) {
    notes.push(
      `Vertical reference differs (${a.verticalDatum ?? a.verticalReference} vs ` +
        `${b.verticalDatum ?? b.verticalReference}) — heights are not on a common surface.`,
    );
  } else if (verticalFrameUnverified) {
    notes.push(
      'Vertical datum is unknown on at least one side — heights cannot be confirmed on a ' +
        'common reference, so the elevation comparison is unverified.',
    );
  }
  if (!verticalScaleKnown) {
    notes.push(
      'Vertical unit is unknown on at least one side — an elevation of unstated unit has no ' +
        'metre value, so height figures are withheld rather than labelled metres.',
    );
  } else if (!verticalScalesAgree) {
    notes.push(
      'Vertical unit differs between the two — one factor cannot convert both, so height ' +
        'figures are withheld.',
    );
  }

  const verticalComparable =
    verticalScalesAgree && !verticalFrameConflict && !verticalFrameUnverified;

  return {
    isGeographic,
    horizontalUnitKnown,
    horizontalUnitToMetres,
    horizontalFrameConflict,
    horizontalFrameUnverified,
    planimetricComparable,

    verticalScaleKnown,
    verticalUnitToMetres,
    verticalFrameConflict,
    verticalFrameUnverified,
    verticalComparable,

    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The epoch-comparison adapter
// ─────────────────────────────────────────────────────────────────────────────

/** The frame facts the two-epoch pipeline reads. See {@link epochFrameOptions}. */
export interface EpochFrameOptions {
  /** True when EITHER epoch is geographic — refuses degree-based volumes. */
  readonly isGeographic: boolean;
  /** True only when BOTH epochs declare a real linear unit. */
  readonly horizontalUnitKnown: boolean;
  /**
   * Metres per horizontal source unit for the BEFORE epoch, which the change
   * pipeline treats as the reference frame (`compareEpochs` documents the same
   * rule). `undefined` when that epoch's unit is unknown — the inert
   * placeholder factor 1 is NOT a measurement and is never passed on as one.
   */
  readonly horizontalUnitToMetres?: number;
}

/** The per-epoch frame facts the change pipeline's cloud inputs carry. */
export interface EpochFrameFacts {
  /** Declared CRS label, or `null` when none was declared. See {@link declaredFrameLabel}. */
  readonly crs: string | null;
  /** Declared vertical datum label, or `null`. */
  readonly verticalDatum: string | null;
  /** Whether this epoch's frame is geographic (degrees). */
  readonly isGeographic: boolean;
  /** Metres per horizontal source unit as declared (1 is the placeholder when unknown). */
  readonly linearUnitToMetres: number;
}

/**
 * The frame facts ONE epoch contributes, read off its context. Written once so
 * the before-epoch and the after-epoch cannot be spelled differently — the two
 * literals this replaces were four `?.` chains each, and a divergence between
 * them is invisible at the call site.
 */
export function epochFrameFacts(ctx: SpatialContext): EpochFrameFacts {
  return {
    crs: declaredFrameLabel(ctx),
    verticalDatum: ctx.verticalDatum ?? null,
    isGeographic: ctx.isGeographic,
    linearUnitToMetres: ctx.linearUnitToMetres,
  };
}

/**
 * Derive the epoch-comparison frame options from the two contexts, so the
 * alignment step and the difference step read ONE answer instead of computing
 * the same three facts from two independent expressions. When those two
 * expressions drift, the alignment reports a shift in metres that the
 * difference then refuses to report at all, and nothing in the output says why.
 *
 * The richer verdict — including the vertical permission the pipeline's grid
 * checks handle separately — is available from {@link compareSpatialFrames}.
 */
export function epochFrameOptions(
  before: SpatialContext,
  after: SpatialContext,
): EpochFrameOptions {
  return {
    isGeographic: before.isGeographic || after.isGeographic,
    horizontalUnitKnown: before.linearUnitKnown && after.linearUnitKnown,
    horizontalUnitToMetres: before.linearUnitKnown ? before.linearUnitToMetres : undefined,
  };
}

/**
 * Whether two epochs' vertical scales are safe to difference directly.
 *
 * The change pipeline computes `(afterZ - beforeZ) * verticalUnitToMetres` with
 * a SINGLE factor — valid only when both epochs share the vertical scale. If
 * both declare a vertical unit and they differ (metres vs feet), subtracting
 * the raw source-unit Z values before normalising is meaningless, so the caller
 * must refuse rather than report a wrong elevation change. When either scale is
 * unknown there is no evidence of a mismatch, so the shared-factor path stands.
 */
export function epochVerticalScalesComparable(
  before: SpatialContext,
  after: SpatialContext,
): boolean {
  if (!before.verticalScaleKnown || !after.verticalScaleKnown) return true;
  const vb = before.verticalUnitToMetres;
  const va = after.verticalUnitToMetres;
  if (vb === undefined || va === undefined) return true;
  return Math.abs(vb - va) <= 1e-9 * Math.max(vb, va);
}
