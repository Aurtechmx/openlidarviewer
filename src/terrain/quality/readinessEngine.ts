/**
 * readinessEngine.ts
 *
 * THE single source of the export-readiness verdict — one function,
 * {@link deriveReadiness}, that turns the surface verdict + georeferencing
 * knowledge into `{ tier, reason, productGrades }`. Before v0.4.5 the same
 * judgement was derived (or re-quoted with its own mapping tables) in four
 * places: terrainAssessment minted the tier + reason inline,
 * recommendedWorkflow re-graded the tier into good/caution/blocked rows with
 * its own note table, terrainProducts renamed those grades into
 * Ready/Preview/Blocked words + glyphs with a third table, and
 * exportProvenance / terrainReportContent each formatted the
 * "Tier — reason" line themselves. Any drift between those tables would have
 * let a file grade a product differently from the panel.
 *
 * Now the tables live HERE, once:
 *   - {@link deriveReadiness}    — tier + reason + product grades, from the
 *     surface tier, the surface reason, and CRS / datum knowledge. Called
 *     exactly once per analysis, by terrainAssessment; every other module is
 *     a VIEW over its output.
 *   - {@link productGradesFor}   — the inspection / deliverable grading +
 *     note table (consumed by deriveReadiness AND recommendedWorkflow, so a
 *     hand-built assessment in a test still grades through the same table).
 *   - {@link statusWordFor} / {@link glyphFor} — the grade → word / glyph
 *     vocabulary terrainProducts renders.
 *   - {@link productReasonFor}  — the per-product "Reason:" selection: the
 *     most specific engine-minted string for a non-ready row (the
 *     figure-quoting surface reason, the georef-gap export reason, or the
 *     row note), consumed by terrainProducts so the panel list and the
 *     report's products section print one full, untruncated reason each.
 *   - {@link readinessLine}      — the one "Tier — reason" formatting every
 *     provenance stamp and report row prints.
 *
 * REFACTOR-GRADE CONTRACT: every string below is byte-identical to what the
 * four consumers minted before the convergence — the engine was conformed to
 * the existing strings, not the other way round. provenanceConsistency /
 * terrainReportContent / reportEngine pin them downstream.
 *
 * Honesty contract (inherited, non-negotiable): the verdict never claims
 * survey-grade; an unknown CRS / vertical datum caps export to Preview with a
 * reason naming the gap; a sub-Good surface is named as the limitation so
 * supplying a CRS alone never reads as making the surface exportable.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/** SURFACE QUALITY tier — internal validity of the surface (CRS-independent). */
export type SurfaceTier = 'Good' | 'Preview' | 'Limited' | 'Blocked';

/** EXPORT READINESS tier — the surface verdict gated by georeferencing. */
export type ReadinessTier = 'Ready' | 'Preview' | 'Blocked';

/** Style-hook grade for one product class (the workflow-row vocabulary). */
export type ProductGradeStatus = 'good' | 'caution' | 'blocked';

/** One product-class grade: the style hook plus its rendered word + glyph. */
export interface ProductGrade {
  /** good ⇒ ✓, caution ⇒ ⚠, blocked ⇒ ✕ (style hook). */
  readonly status: ProductGradeStatus;
  /** The textual verdict — carried as TEXT so a row is never colour-only. */
  readonly statusWord: ReadinessTier;
  /** ✓ / ⚠ / ✕, decorative beside the status word. */
  readonly glyph: '✓' | '⚠' | '✕';
  /** Short, honest qualifier for caution/blocked grades (absent for good). */
  readonly note?: string;
}

/** Grades for the two product classes the workflow checklist distinguishes. */
export interface ProductGrades {
  /** Profile / Measurement / Surface sampling — needs only a valid surface. */
  readonly inspection: ProductGrade;
  /** DEM export / Contour generation / Map sheet — a georeferenced hand-off. */
  readonly deliverable: ProductGrade;
}

/** The single export-readiness verdict every consumer renders a view of. */
export interface ReadinessVerdict {
  /** Ready / Preview / Blocked. */
  readonly tier: ReadinessTier;
  /** Why the tier sits below Ready, or '' when Ready. */
  readonly reason: string;
  /** Per-product-class grades derived from the same tier. */
  readonly productGrades: ProductGrades;
}

/** Inputs {@link deriveReadiness} judges — all measured upstream, never here. */
export interface ReadinessInputs {
  /** The surface-quality verdict (terrainAssessment's CRS-independent axis). */
  readonly surfaceTier: SurfaceTier;
  /**
   * The surface-quality reason line. Quoted verbatim as the verdict reason
   * when the surface is Blocked (the gate's words ARE the export story then).
   */
  readonly surfaceReason: string;
  /** True when a horizontal CRS is known. */
  readonly crsKnown: boolean;
  /** True when a vertical datum is known. */
  readonly datumKnown: boolean;
}

/** Grade → rendered word. The deliverable vocabulary, not the grade one. */
const STATUS_WORD: Readonly<Record<ProductGradeStatus, ReadinessTier>> = {
  good: 'Ready',
  caution: 'Preview',
  blocked: 'Blocked',
};

/** Grade → glyph. ✓ / ⚠ / ✕, always paired with the word (never colour-only). */
const GLYPH: Readonly<Record<ProductGradeStatus, ProductGrade['glyph']>> = {
  good: '✓',
  caution: '⚠',
  blocked: '✕',
};

/** The rendered word for a product grade (good → Ready, …). */
export function statusWordFor(status: ProductGradeStatus): ReadinessTier {
  return STATUS_WORD[status];
}

/** The glyph for a product grade (good → ✓, …). */
export function glyphFor(status: ProductGradeStatus): ProductGrade['glyph'] {
  return GLYPH[status];
}

/**
 * The one "Tier — reason" line every provenance stamp and report row prints
 * (em-dash separated; just the tier when the reason is empty/Ready).
 */
export function readinessLine(tier: ReadinessTier, reason: string): string {
  return reason ? `${tier} — ${reason}` : tier;
}

/** Join reason fragments into one sentence: "a, b and c". */
export function joinReasons(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/** Inspection-class rows grade off SURFACE QUALITY. */
function inspectionGrade(surfaceTier: SurfaceTier): ProductGradeStatus {
  switch (surfaceTier) {
    case 'Good':
    case 'Preview':
      return 'good';
    case 'Limited':
      return 'caution';
    case 'Blocked':
    default:
      return 'blocked';
  }
}

/** Deliverable-class rows grade off EXPORT READINESS. */
function deliverableGrade(tier: ReadinessTier): ProductGradeStatus {
  switch (tier) {
    case 'Ready':
      return 'good';
    case 'Preview':
      return 'caution';
    case 'Blocked':
    default:
      return 'blocked';
  }
}

/**
 * The deliverable note. For caution we explain WHY the deliverable is held
 * back (georeferencing incomplete vs. preview-only surface) so the row is
 * actionable at a glance; for blocked we say the gate stopped it. Never
 * survey-grade. (Moved verbatim from recommendedWorkflow.ts.)
 */
function deliverableNote(
  grade: ProductGradeStatus,
  surfaceTier: SurfaceTier,
  tier: ReadinessTier,
): string | undefined {
  if (grade === 'good') return undefined;
  if (grade === 'blocked') return 'quality gate stopped this surface';
  // caution: a known georef gap means the surface is fine but the hand-off
  // frame is incomplete; otherwise the surface itself is only preview-grade.
  const georefOnly = surfaceTier === 'Good' && tier === 'Preview';
  return georefOnly ? 'georeferencing incomplete' : 'preview only — additional validation recommended';
}

function grade(status: ProductGradeStatus, note?: string): ProductGrade {
  return note != null
    ? { status, statusWord: STATUS_WORD[status], glyph: GLYPH[status], note }
    : { status, statusWord: STATUS_WORD[status], glyph: GLYPH[status] };
}

/**
 * The product-class grading table, exposed separately from
 * {@link deriveReadiness} so recommendedWorkflow can grade a hand-built
 * assessment (which carries the two tiers but not the raw CRS/datum inputs)
 * through the SAME table the engine uses — one mapping, two entry points.
 */
export function productGradesFor(surfaceTier: SurfaceTier, tier: ReadinessTier): ProductGrades {
  const deliverable = deliverableGrade(tier);
  return {
    inspection: grade(inspectionGrade(surfaceTier)),
    deliverable: grade(deliverable, deliverableNote(deliverable, surfaceTier, tier)),
  };
}

/** Inputs {@link productReasonFor} selects from — every string minted upstream. */
export interface ProductReasonInputs {
  /** The row's own grade — a good row needs no reason. */
  readonly status: ProductGradeStatus;
  /** inspection rows blame the surface axis; deliverables the export axis. */
  readonly productClass: 'inspection' | 'deliverable';
  /** The surface-quality tier the assessment carried. */
  readonly surfaceTier: SurfaceTier;
  /**
   * The assessment's surface-quality reason — the line that already QUOTES the
   * measured figures (interpolation %, empty-cell %, edge %, sparse density).
   */
  readonly surfaceReason: string;
  /** The engine's export reason ('' when Ready) — names the georef gap(s). */
  readonly exportReason: string;
  /** The row's own short engine note — the last-resort fallback. */
  readonly note?: string;
}

/** First candidate that is a real, non-blank string (selection, never minting). */
function pickReason(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find((c) => c != null && c.trim().length > 0);
}

/**
 * The full, SPECIFIC reason for one product row — the "Reason:" line the
 * Terrain Products list and the report's products section print. Pure
 * SELECTION among strings the engines already minted (never new prose):
 *
 *   - good rows         → undefined (a ready row needs no excuse);
 *   - inspection rows   → the surface-quality reason (it quotes the measured
 *     figures, e.g. "72% of the surface is interpolated"), falling back to
 *     the row note;
 *   - deliverable rows, blocked → the surface reason verbatim ({@link
 *     deriveReadiness} already makes the gate's words THE export reason),
 *     then the export reason, then the note ("quality gate stopped this
 *     surface");
 *   - deliverable rows, caution on a Good surface → the export reason (it
 *     names the exact georef gap, e.g. "vertical datum unknown"), then the
 *     note ("georeferencing incomplete");
 *   - deliverable rows, caution on a sub-Good surface → the surface reason
 *     (the figure-quoting line IS the most specific signal; the export-grade
 *     framing already travels as the Preview status word), then the export
 *     reason, then the note.
 */
export function productReasonFor(input: ProductReasonInputs): string | undefined {
  const { status, productClass, surfaceTier, surfaceReason, exportReason, note } = input;
  if (status === 'good') return undefined;
  if (productClass === 'inspection') return pickReason(surfaceReason, note);
  if (status === 'blocked') return pickReason(surfaceReason, exportReason, note);
  return surfaceTier === 'Good'
    ? pickReason(exportReason, note)
    : pickReason(surfaceReason, exportReason, note);
}

/**
 * Derive THE export-readiness verdict. (Logic moved verbatim from
 * terrainAssessment's inline block — the strings are pinned downstream.)
 *
 * Blocked surface ⇒ export Blocked (the surface reason IS the export reason).
 * Otherwise Ready only when the surface is Good AND CRS + vertical datum are
 * both known; an unknown CRS/datum (or any sub-Good surface) holds export at
 * Preview, with a reason naming the gap — and when BOTH hold it back, naming
 * both, so supplying a CRS alone never reads as making the surface exportable.
 */
export function deriveReadiness(input: ReadinessInputs): ReadinessVerdict {
  const { surfaceTier, surfaceReason, crsKnown, datumKnown } = input;

  const georefGaps: string[] = [];
  if (!crsKnown) georefGaps.push('CRS unknown');
  if (!datumKnown) georefGaps.push('vertical datum unknown');

  let tier: ReadinessTier;
  let reason: string;
  if (surfaceTier === 'Blocked') {
    tier = 'Blocked';
    reason = surfaceReason;
  } else if (surfaceTier === 'Good' && georefGaps.length === 0) {
    tier = 'Ready';
    reason = '';
  } else {
    tier = 'Preview';
    const surfaceBelowGood = surfaceTier !== 'Good';
    if (georefGaps.length > 0 && surfaceBelowGood) {
      // BOTH hold export back: name the surface limitation AND the georef gap,
      // as one readable sentence. Naming only the georef gap would wrongly
      // imply that supplying a CRS/datum alone makes the surface exportable.
      reason = `surface quality is below export grade; ${joinReasons(georefGaps)} — validate before hand-off`;
    } else if (georefGaps.length > 0) {
      // Surface is Good — georeferencing is the only reason export is held back.
      reason = joinReasons(georefGaps);
    } else {
      // Surface itself is below Good — that's why export isn't ready.
      reason = 'surface quality is below export grade — validate before hand-off';
    }
  }

  return { tier, reason, productGrades: productGradesFor(surfaceTier, tier) };
}
