/**
 * toolPreflight.ts — what limits a tool, and the shortest way to lift it.
 *
 * A disabled control says nothing. It does not name the condition that limits
 * it, and it does not say what would change the answer, so the user is left to
 * guess between "my data is wrong", "I picked the wrong layer" and "the app is
 * still loading". This module turns that silence into plain data: for one tool,
 * a status in the {@link Readiness} vocabulary, the conditions that produced it,
 * and the corrective actions that would clear them.
 *
 * IT DECIDES NOTHING ITSELF. Every verdict is read from the service that already
 * owns it:
 *
 *   • whether a metric claim is permitted  ← {@link SpatialContext.metricClaimsPermitted}
 *   • whether the layers share a reference ← `layerContextOf` + `measureConfidence`
 *   • what a derived product may produce   ← `ProcessService` / `evaluateCapabilities`
 *   • how much of a scan is readable       ← the normalised {@link ScanFacts.coverage}
 *
 * A second opinion about units or coverage assembled here would be the exact
 * defect the rest of the tree guards against, so this file contains no unit
 * arithmetic, no datum comparison and no coverage estimation. What it adds is
 * the mapping from an established verdict to a named condition and a corrective
 * action — and nothing else.
 *
 * Fail-closed, like the services it reads. A fact that cannot be established
 * degrades the status; it is never guessed. An omitted layer-compatibility set
 * over several scans reads as unproven, an omitted scene datum reads as
 * unresolved, and a tool with no capability verdict is blocked.
 *
 * DOMAIN-ORIENTED, not UI-specific: no DOM, no three.js, and a remediation names
 * an ACTION, not a button. Pure and Node-testable.
 */

import type { SpatialContext } from '../geo/SpatialContext';
import type { LayerCompatibility } from '../model/layerCompatibility';
import type { MeasureSceneContext } from '../render/measure/measureConfidence';
import { confidenceForKind, layerContextOf } from '../render/measure/measureConfidence';
import type { MeasurementKind } from '../render/measure/types';
import type { Coverage, ProductId, Readiness, ScanFacts } from './ProcessPlan';
import { ProcessService } from './ProcessService';

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How limited a tool is. Deliberately the SAME three words the capability model
 * uses ({@link Readiness}), aliased rather than redeclared so the two can never
 * drift into a parallel vocabulary.
 */
export type PreflightStatus = Readiness;

/** The tools a user can reach that this model reasons about. */
export type ToolId =
  | 'measure-distance'
  | 'measure-area'
  | 'measure-height'
  | 'measure-volume'
  | 'classify'
  | 'terrain-dtm'
  | 'terrain-dsm'
  | 'contours'
  | 'building-footprints'
  | 'cross-epoch-change'
  | 'cut-fill-volume';

/**
 * A corrective action, named as a DOMAIN intent. It says what would change the
 * answer, not which control does it, so a panel, a command palette and a test
 * can each bind it their own way.
 */
export type PreflightActionId =
  /** Confirm the coordinate system so the physical unit is established. */
  | 'set-coordinate-system'
  /** Proceed with the figure labelled exploratory rather than metric. */
  | 'continue-exploratory'
  /** Reduce the scene to the active layer, so one proven frame is in play. */
  | 'solo-active-layer'
  /** Look at what each layer declares about its horizontal/vertical reference. */
  | 'inspect-layer-crs'
  /** Wait until the streaming set covers everything currently visible. */
  | 'await-full-coverage'
  /** Proceed over the points that are resident now, scoped to them. */
  | 'continue-resident-only'
  /** Load the second epoch a comparison needs. */
  | 'load-second-scan'
  /** Prove the two scans' frames compatible before comparing them. */
  | 'align-scans'
  /** Derive the classes a class-dependent product needs. */
  | 'classify-scan';

/** One condition that limits the tool, with a stable greppable code. */
export interface PreflightReason {
  /** Stable UPPER_SNAKE slug — safe to switch on, safe to grep for. */
  readonly code: string;
  /** One sentence naming the condition. */
  readonly message: string;
}

/** One corrective action offered against the reasons above. */
export interface PreflightRemediation {
  readonly label: string;
  readonly action: PreflightActionId;
}

/**
 * The preflight verdict for one tool. `reasons` is empty exactly when nothing
 * limits the tool, and `remediations` is empty when there is nothing to offer —
 * so a `ready` preflight carries neither.
 */
export interface ToolPreflight {
  readonly tool: ToolId;
  readonly status: PreflightStatus;
  readonly reasons: readonly PreflightReason[];
  readonly remediations: readonly PreflightRemediation[];
}

/**
 * Everything the preflight reads. Each field is the OUTPUT of a service that
 * already established it; nothing here is a raw signal this module interprets
 * for itself.
 */
export interface PreflightInput {
  /**
   * The loaded scans, already normalised fail-closed by `deriveScanFacts`. The
   * capability verdicts are evaluated from these, and `coverage` is read from
   * them (never estimated here).
   */
  readonly scans: readonly ScanFacts[];
  /** The frame description for the active scan — the single unit authority. */
  readonly spatial: SpatialContext;
  /**
   * What each visible layer has proven about its frame, from
   * `classifyLayerCompatibility`. Omitted over more than one scan reads as
   * unproven, which is the fail-closed answer, never "compatible".
   */
  readonly layerCompatibility?: readonly LayerCompatibility[];
  /** Whether the scene resolved a shared origin datum. Omitted ⇒ unresolved. */
  readonly datumResolved?: boolean;
  /** Whether two scans are in a proven-compatible frame; omitted ⇒ unproven. */
  readonly projectFrameCompatible?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool bindings
// ─────────────────────────────────────────────────────────────────────────────

/** Which authority answers for a tool. */
type ToolBinding =
  /** An interactive measurement: the measure-confidence + unit authorities. */
  | { readonly family: 'measure'; readonly kind: MeasurementKind }
  /** A derived product: the process capability model answers in full. */
  | { readonly family: 'product'; readonly product: ProductId };

/**
 * Every tool bound to the authority that answers for it. A full `Record` on
 * purpose: adding a `ToolId` without binding it fails to compile, so a tool can
 * never reach the model with no authority behind it.
 */
const TOOL_BINDING: Readonly<Record<ToolId, ToolBinding>> = {
  'measure-distance': { family: 'measure', kind: 'distance' },
  'measure-area': { family: 'measure', kind: 'area' },
  'measure-height': { family: 'measure', kind: 'height' },
  'measure-volume': { family: 'measure', kind: 'volume' },
  classify: { family: 'product', product: 'classify-gaps' },
  'terrain-dtm': { family: 'product', product: 'dtm' },
  'terrain-dsm': { family: 'product', product: 'dsm' },
  contours: { family: 'product', product: 'contours' },
  'building-footprints': { family: 'product', product: 'building-footprints' },
  'cross-epoch-change': { family: 'product', product: 'cross-epoch-change' },
  'cut-fill-volume': { family: 'product', product: 'volume-cut-fill' },
};

/** Every tool the model reasons about, in declaration order. */
export const ALL_TOOLS: readonly ToolId[] = Object.keys(TOOL_BINDING) as ToolId[];

/**
 * The measurement kind a tool drives, or `null` when the tool is a derived
 * product. Reads {@link TOOL_BINDING}, so a surface that has to act on a tool —
 * arm the measurement the user was refused, say — asks the binding instead of
 * keeping its own tool→kind table beside this one.
 */
export function toolMeasurementKind(tool: ToolId): MeasurementKind | null {
  const binding = TOOL_BINDING[tool];
  return binding.family === 'measure' ? binding.kind : null;
}

/**
 * The derived product a tool makes, or `null` when the tool is an interactive
 * measurement. The counterpart of {@link toolMeasurementKind}: between them a
 * surface can file every tool under the authority that answered for it without
 * keeping a second tool table of its own.
 */
export function toolProduct(tool: ToolId): ProductId | null {
  const binding = TOOL_BINDING[tool];
  return binding.family === 'product' ? binding.product : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Remediation catalogue
// ─────────────────────────────────────────────────────────────────────────────

const REMEDIATION: Readonly<Record<PreflightActionId, PreflightRemediation>> = {
  'set-coordinate-system': { label: 'Set the coordinate system', action: 'set-coordinate-system' },
  'continue-exploratory': { label: 'Continue, labelled exploratory', action: 'continue-exploratory' },
  'solo-active-layer': { label: 'Show the active layer on its own', action: 'solo-active-layer' },
  'inspect-layer-crs': { label: 'Inspect each layer’s coordinate reference', action: 'inspect-layer-crs' },
  'await-full-coverage': { label: 'Wait for full visible coverage', action: 'await-full-coverage' },
  'continue-resident-only': { label: 'Continue on the resident points', action: 'continue-resident-only' },
  'load-second-scan': { label: 'Load a second scan', action: 'load-second-scan' },
  'align-scans': { label: 'Align the two scans', action: 'align-scans' },
  'classify-scan': { label: 'Classify the scan first', action: 'classify-scan' },
};

/**
 * Actions that let the user proceed with the limitation stated rather than
 * removing it. They are only honest when the tool can actually run, so a
 * `blocked` preflight drops them and offers corrective actions alone.
 */
const PERMISSIVE: ReadonlySet<PreflightActionId> = new Set([
  'continue-exploratory',
  'continue-resident-only',
]);

/**
 * The corrective actions for each reason code the capability model emits. A code
 * with no entry has no action this model can honestly offer (an empty scan, an
 * already-complete classification), and that is stated by offering none rather
 * than by inventing a step.
 */
const ACTIONS_BY_PRODUCT_CODE: Readonly<Record<string, readonly PreflightActionId[]>> = {
  UNIT_UNKNOWN: ['set-coordinate-system', 'continue-exploratory'],
  RESIDENT_ONLY: ['await-full-coverage', 'continue-resident-only'],
  PARTIAL_COVERAGE: ['await-full-coverage', 'continue-resident-only'],
  RESIDENT_OVERLAP_ONLY: ['await-full-coverage', 'continue-resident-only'],
  VERTICAL_REF_DIFFERS: ['solo-active-layer', 'inspect-layer-crs'],
  VERTICAL_UNIT_CONFLICT: ['solo-active-layer', 'inspect-layer-crs'],
  FRAME_UNPROVEN: ['align-scans', 'inspect-layer-crs'],
  NEED_TWO_SCANS: ['load-second-scan'],
  NEEDS_CLASSIFICATION: ['classify-scan'],
  NO_BUILDING_CLASS: ['classify-scan'],
  GROUND_DERIVED: ['classify-scan', 'continue-exploratory'],
  DTM_REVIEW: ['continue-exploratory'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

/** A reason plus the actions it justifies, before de-duplication. */
interface CandidateReason {
  readonly status: PreflightStatus;
  readonly code: string;
  readonly message: string;
  readonly actions: readonly PreflightActionId[];
}

const STATUS_RANK: Readonly<Record<PreflightStatus, number>> = {
  ready: 0,
  review: 1,
  blocked: 2,
};

/** The more limiting of two statuses — a tool is as limited as its worst condition. */
function worse(a: PreflightStatus, b: PreflightStatus): PreflightStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

/**
 * Collapse the candidate reasons into one verdict: the worst status, every
 * reason in the order it was established, and the actions de-duplicated so a
 * condition named twice does not offer the same step twice.
 */
function assemble(tool: ToolId, candidates: readonly CandidateReason[]): ToolPreflight {
  let status: PreflightStatus = 'ready';
  for (const c of candidates) status = worse(status, c.status);

  const seen = new Set<PreflightActionId>();
  const remediations: PreflightRemediation[] = [];
  for (const c of candidates) {
    for (const action of c.actions) {
      if (status === 'blocked' && PERMISSIVE.has(action)) continue;
      if (seen.has(action)) continue;
      seen.add(action);
      remediations.push(REMEDIATION[action]);
    }
  }

  return {
    tool,
    status,
    reasons: candidates.map((c) => ({ code: c.code, message: c.message })),
    remediations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prepared authorities
// ─────────────────────────────────────────────────────────────────────────────

/** The services, built once so a batch preflight evaluates them a single time. */
interface PreparedAuthorities {
  readonly service: ProcessService;
  readonly scene: MeasureSceneContext;
}

/**
 * Build the authorities this input describes. The layer context is derived by
 * `layerContextOf`, never by counting here; an absent compatibility set is
 * filled with `unknown` per scan so a multi-scan scene reads as unproven — the
 * same fail-closed default the live measure wiring uses.
 */
function prepare(ctx: PreflightInput): PreparedAuthorities {
  const states: readonly LayerCompatibility[] =
    ctx.layerCompatibility ?? ctx.scans.map((): LayerCompatibility => 'unknown');
  return {
    service: ProcessService.fromFacts(ctx.scans, ctx.projectFrameCompatible),
    scene: {
      datumResolved: ctx.datumResolved === true,
      layers: layerContextOf(states),
      verticalReferenceKnown: ctx.spatial.verticalReferenceKnown,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage
// ─────────────────────────────────────────────────────────────────────────────

const COVERAGE_RANK: Readonly<Record<Coverage, number>> = {
  full: 0,
  sampled: 1,
  'resident-only': 2,
};

/**
 * The least complete coverage among the loaded scans, or `null` when every scan
 * is fully readable. Reads the normalised `ScanFacts.coverage` — the fact
 * `deriveScanFacts` already settled fail-closed — and ranks it; it estimates
 * nothing about what a streaming source has actually delivered.
 */
function coverageShortfall(scans: readonly ScanFacts[]): Coverage | null {
  let worstCoverage: Coverage = 'full';
  for (const s of scans) {
    if (COVERAGE_RANK[s.coverage] > COVERAGE_RANK[worstCoverage]) worstCoverage = s.coverage;
  }
  return worstCoverage === 'full' ? null : worstCoverage;
}

/** The coverage condition for an interactive tool, or `null` when there is none. */
function coverageReason(scans: readonly ScanFacts[]): CandidateReason | null {
  const shortfall = coverageShortfall(scans);
  if (shortfall === null) return null;
  return shortfall === 'resident-only'
    ? {
        status: 'review',
        code: 'STREAMING_RESIDENT_ONLY',
        message:
          'The streaming source is still refining: only the resident points can be read, so the figure describes that subset rather than everything in view.',
        actions: ['await-full-coverage', 'continue-resident-only'],
      }
    : {
        status: 'review',
        code: 'SAMPLED_COVERAGE',
        message:
          'Only a sample of the scan can be read, so the figure describes that sample rather than the whole scan.',
        actions: ['await-full-coverage', 'continue-resident-only'],
      };
}

// ─────────────────────────────────────────────────────────────────────────────
// The two families
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An interactive measurement. Three authorities answer, and each contributes at
 * most one condition: the spatial context on whether a metric claim is
 * permitted, `measureConfidence` on whether the visible layers share a proven
 * reference, and the normalised coverage on whether the data is still refining.
 */
function preflightMeasure(
  tool: ToolId,
  kind: MeasurementKind,
  ctx: PreflightInput,
  prepared: PreparedAuthorities,
): ToolPreflight {
  if (ctx.scans.length === 0) {
    return assemble(tool, [
      {
        status: 'blocked',
        code: 'NO_SCAN_LOADED',
        message: 'No scan is loaded, so there is nothing to measure.',
        actions: [],
      },
    ]);
  }

  const candidates: CandidateReason[] = [];

  // 1. Physical unit. The context's own gate, read whole — a figure without a
  //    confirmed unit is exploratory, and volume is the clearest case.
  if (!ctx.spatial.metricClaimsPermitted) {
    candidates.push({
      status: 'review',
      code: 'UNIT_UNRESOLVED',
      message: `The physical unit is not confirmed for “${ctx.spatial.crsName}”, so this figure stays exploratory rather than a metric claim.`,
      actions: ['set-coordinate-system', 'continue-exploratory'],
    });
  }

  // 2. Shared reference across the visible layers, from the measure-confidence
  //    ladder. `unavailable` is a refusal (no combined figure has a meaning);
  //    `approximate` names whichever facts stayed unproven, in its own words.
  const confidence = confidenceForKind(kind, prepared.scene);
  if (confidence.level === 'unavailable') {
    candidates.push({
      status: 'blocked',
      code: 'NO_SHARED_REFERENCE',
      message: `The visible layers do not share a proven reference: ${confidence.reason}.`,
      actions: ['solo-active-layer', 'inspect-layer-crs'],
    });
  } else if (confidence.level === 'approximate') {
    candidates.push({
      status: 'review',
      code: 'SHARED_REFERENCE_UNPROVEN',
      message: `The shared reference is not established: ${confidence.reason}.`,
      actions: ['solo-active-layer', 'inspect-layer-crs'],
    });
  }

  // 3. Coverage.
  const coverage = coverageReason(ctx.scans);
  if (coverage !== null) candidates.push(coverage);

  return assemble(tool, candidates);
}

/**
 * A derived product. The capability model already weighs unit, coverage, ground
 * trust, vertical reference and frame compatibility for exactly these products,
 * so its verdict is taken WHOLE — status, code and sentence — and this function
 * only attaches the corrective actions the code implies. Re-deciding any part of
 * it here would be the second opinion the model exists to prevent.
 */
function preflightProduct(
  tool: ToolId,
  product: ProductId,
  prepared: PreparedAuthorities,
): ToolPreflight {
  const capability = prepared.service.capability(product);
  if (capability == null) {
    return assemble(tool, [
      {
        status: 'blocked',
        code: 'NO_SCAN_LOADED',
        message: 'No scan is loaded, so the capability model has no verdict for this product.',
        actions: [],
      },
    ]);
  }
  if (capability.readiness === 'ready') return assemble(tool, []);
  return assemble(tool, [
    {
      status: capability.readiness,
      code: capability.reasonCode,
      message: capability.reason,
      actions: ACTIONS_BY_PRODUCT_CODE[capability.reasonCode] ?? [],
    },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

function preflightWith(
  tool: ToolId,
  ctx: PreflightInput,
  prepared: PreparedAuthorities,
): ToolPreflight {
  const binding = TOOL_BINDING[tool];
  return binding.family === 'measure'
    ? preflightMeasure(tool, binding.kind, ctx, prepared)
    : preflightProduct(tool, binding.product, prepared);
}

/** What limits one tool right now, and what would lift it. */
export function preflightFor(tool: ToolId, ctx: PreflightInput): ToolPreflight {
  return preflightWith(tool, ctx, prepare(ctx));
}

/**
 * The preflight for every tool, evaluating the shared authorities once. Use this
 * when a surface needs the whole set; the per-tool answers are identical to
 * {@link preflightFor}.
 */
export function preflightAll(ctx: PreflightInput): readonly ToolPreflight[] {
  const prepared = prepare(ctx);
  return ALL_TOOLS.map((tool) => preflightWith(tool, ctx, prepared));
}
