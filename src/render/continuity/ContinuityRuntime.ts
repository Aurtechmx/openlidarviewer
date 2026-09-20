/**
 * ContinuityRuntime.ts — the one thing that owns the Continuity Field.
 *
 * Nineteen modules under this directory decide one question each: which rung a
 * backend can carry, whether a touch device may have it, when history stops
 * being reusable, where the lens is, what to give up under pressure, what to
 * do when a pass throws. Each is pure and tested on its own, and none of them
 * holds the answer from last frame.
 *
 * Somebody has to. Left to the Viewer that somebody would be a dozen fields
 * and the order they have to be updated in, on a file that is already the
 * largest in the tree and already carries the scene, the camera, the tools and
 * the export seams. This is that state, in one object, behind one call per
 * frame.
 *
 * ── WHAT IT OWNS, AND WHAT IT MUST NOT ──────────────────────────────────────
 * Presentation state only: the tier in force, the capabilities it grants, the
 * display epoch, the lens, the convergence sweep, and the counters a
 * diagnostics panel reads. Nothing here is measured geometry. No point, no
 * cloud, no terrain product, no claim and no export record may be held by this
 * object or reached from it, and nothing it decides may reach picking,
 * measurement, terrain, export or claim evidence. The field changes how the
 * scan is drawn and it may not change anything computed from it.
 *
 * GPU resources are named in the phase brief as this object's to own, and it
 * owns none, because none exist: every capability that would allocate one is
 * off, and `historyTargets` has no caller for the same reason. When a history
 * is first allocated it belongs here, and `dispose` is where it is released.
 *
 * ── ONE CALL PER FRAME ──────────────────────────────────────────────────────
 * `prepareFrame` takes what the renderer already knows and returns a plan. It
 * decides nothing the pure modules decide: it holds their previous answers,
 * feeds them this frame's inputs and keeps what comes back. The order matters
 * and is the reason this is one function rather than six the Viewer calls in
 * sequence.
 *
 * ── OFF BY DEFAULT ──────────────────────────────────────────────────────────
 * With nothing opted into, `grantedTier` returns `source` for every input
 * combination, `capabilitiesForTier('source')` is every capability off, and
 * the plan reports `active: false`. A caller that checks that flag first does
 * no continuity work at all, which is the shipped configuration until a
 * capability earns otherwise. The release decision is a flag rather than a
 * property of whichever device happens to be running.
 *
 * Pure of the browser: no DOM, no three.js, no clock. The caller passes what
 * it has, as the rest of this directory does.
 */
import type { RefinementPhase } from '../refinementPhase';
import {
  advanceEpoch,
  anyCapabilityEnabled,
  openEpoch,
  type ContinuityCapabilities,
  type ContinuityMetrics,
  type DisplayEpoch,
  type DisplayState,
} from './continuityField';
import { afterFailure, type ContinuityFailure } from './continuityFailure';
import { nextTierUnderPressure, type PressureInput } from './continuityPressure';
import { capabilitiesForTier, type BackendSupport, type ContinuityTier } from './continuityTier';
import { tierFor } from './continuityTier';
import { IDLE, nextConvergence, phaseToDraw, type ConvergenceState } from './convergence';
import { exposureFor, shouldAccumulate, type Exposure } from './convergenceExposure';
import { LENS_CLOSED, type Lens } from './evidenceLens';
import { applyLensIntent, type LensIntent, type LensSizing, type Viewport } from './lensPlacement';
import {
  grantedTier,
  lowerTier,
  tierCeilingFor,
  NO_OPT_IN,
  type CapabilityOptIn,
  type MobileFrameEvidence,
} from './mobilePolicy';
import type { PhaseCount } from './temporalPhase';

/** What the runtime is told once, when it is built. */
export interface ContinuityRuntimeOptions {
  /** What the backend was measured to support. Probed once, never guessed. */
  readonly support: BackendSupport;
  /** Touch-first hardware, which carries the tighter ceiling. */
  readonly touchFirst: boolean;
  /** What this session opted into. Nothing, unless a flag says otherwise. */
  readonly optIn?: CapabilityOptIn;
  /** Measurement that raises the touch-first ceiling, where one exists. */
  readonly mobileEvidence?: MobileFrameEvidence | null;
  /** How many phases make one accumulation sweep. */
  readonly phaseCount?: PhaseCount;
  /** How large the lens opens. */
  readonly lensSizing?: LensSizing;
}

/** What the renderer knows at the start of a frame. */
export interface ContinuityFrameInput {
  /** The display inputs a reused frame depends on. */
  readonly display: DisplayState;
  /** The rung the quality dial asks for. A request, never a grant. */
  readonly requestedTier: ContinuityTier;
  /** Where the renderer is in its own refinement. */
  readonly refinement: RefinementPhase;
  /** The backing store, for placing the lens. */
  readonly viewport: Viewport;
  /** How the recent frames have been going. */
  readonly pressure: PressureInput;
  /** The viewer asked for reduced motion. */
  readonly reducedMotion: boolean;
}

/** What the renderer should do this frame. */
export interface ContinuityFramePlan {
  /** Whether any capability is on. False means: do nothing, draw as before. */
  readonly active: boolean;
  /** The rung in force. */
  readonly tier: ContinuityTier;
  /** What that rung grants. */
  readonly capabilities: ContinuityCapabilities;
  /** The epoch in force. */
  readonly epoch: number;
  /** Whether it advanced this frame, which is when history stops being reusable. */
  readonly epochChanged: boolean;
  /** Which display inputs changed to open it. Empty when it did not advance. */
  readonly changed: readonly (keyof DisplayState)[];
  /** Where the accumulation sweep is. */
  readonly convergence: ConvergenceState;
  /** Which phase to draw, or null when there is nothing more to add. */
  readonly phase: number | null;
  /** Whether this frame's shading should be merged into the history. */
  readonly accumulate: boolean;
  /** Which image to present. */
  readonly exposure: Exposure;
  /** The evidence lens, as placed. */
  readonly lens: Lens;
}

const DEFAULT_LENS_SIZING: LensSizing = { radiusPx: 96, featherPx: 24 };
const DEFAULT_PHASE_COUNT: PhaseCount = 4;

export class ContinuityRuntime {
  private readonly _options: ContinuityRuntimeOptions;
  private readonly _backendTier: ContinuityTier;
  private readonly _policyCeiling: ContinuityTier;
  private readonly _optIn: CapabilityOptIn;
  private readonly _phaseCount: PhaseCount;
  private readonly _lensSizing: LensSizing;

  /**
   * A ceiling that failures lower and nothing raises.
   *
   * Without it, a device that refused a history would be promoted back into
   * asking for one the moment its frame times recovered, refuse again, and
   * spend the session alternating. A refusal is evidence about the device, and
   * evidence does not expire because the next few frames were quick.
   */
  private _failureCeiling: ContinuityTier = 'full';
  private _tier: ContinuityTier;
  private _epoch: DisplayEpoch | null = null;
  private _convergence: ConvergenceState = IDLE;
  private _lens: Lens = LENS_CLOSED;
  private _framesThisEpoch = 0;
  private _epochsOpened = 0;
  private _lastFailure: ContinuityFailure | null = null;
  private _disposed = false;

  constructor(options: ContinuityRuntimeOptions) {
    this._options = options;
    this._optIn = options.optIn ?? NO_OPT_IN;
    this._phaseCount = options.phaseCount ?? DEFAULT_PHASE_COUNT;
    this._lensSizing = options.lensSizing ?? DEFAULT_LENS_SIZING;
    this._backendTier = tierFor(options.support);
    this._policyCeiling = tierCeilingFor(options.touchFirst, options.mobileEvidence ?? null);
    // Start at the bottom rather than at whatever the ceiling permits: the
    // first frame has measured nothing, and pressure promotes upward from
    // here one rung at a time.
    this._tier = 'source';
  }

  /** What the backend was measured to carry, before any policy is applied. */
  get backendTier(): ContinuityTier {
    return this._backendTier;
  }

  /** The richest rung this session may reach, given a request of `requested`. */
  ceilingFor(requested: ContinuityTier): ContinuityTier {
    return lowerTier(
      grantedTier(requested, this._backendTier, this._policyCeiling, this._optIn),
      this._failureCeiling,
    );
  }

  /**
   * The plan for this frame.
   *
   * The order is the contract. The ceiling is resolved first, because a rung
   * the device cannot carry must not reach the capabilities. Pressure then
   * moves one rung inside that ceiling. The epoch advances next, since the
   * convergence sweep is defined against the epoch in force and would
   * otherwise contribute a phase to a picture that has already changed. The
   * exposure is last, reading the convergence it describes.
   */
  prepareFrame(input: ContinuityFrameInput): ContinuityFramePlan {
    const ceiling = this.ceilingFor(input.requestedTier);
    this._tier = nextTierUnderPressure(this._tier, ceiling, input.pressure);
    const capabilities = capabilitiesForTier(this._tier);

    const previous = this._epoch;
    const epoch = previous === null ? openEpoch(input.display) : advanceEpoch(previous, input.display);
    const epochChanged = previous === null || epoch.epoch !== previous.epoch;
    if (epochChanged) {
      this._epochsOpened += 1;
      this._framesThisEpoch = 0;
    }
    this._framesThisEpoch += 1;
    this._epoch = epoch;

    // Accumulation is the one capability the sweep exists for. Without it the
    // convergence state stays idle rather than advancing through phases
    // nothing will merge.
    this._convergence = capabilities.temporalAccumulation
      ? nextConvergence(this._convergence, {
        epoch: epoch.epoch,
        refinement: input.refinement,
        phaseCount: this._phaseCount,
      })
      : IDLE;

    return {
      active: anyCapabilityEnabled(capabilities),
      tier: this._tier,
      capabilities,
      epoch: epoch.epoch,
      epochChanged,
      changed: epochChanged ? epoch.changed : [],
      convergence: this._convergence,
      phase: phaseToDraw(this._convergence),
      accumulate: shouldAccumulate(this._convergence),
      exposure: exposureFor(this._convergence, input.reducedMotion),
      lens: capabilities.evidenceLens ? this._lens : LENS_CLOSED,
    };
  }

  /**
   * Move the lens.
   *
   * Intents rather than a setter, so the rule that a lifted finger keeps the
   * lens open and a departed pointer closes it stays in `lensPlacement` where
   * it is tested. The lens is placed whether or not the capability is on; what
   * the capability decides is whether the plan reports it.
   */
  setLensIntent(intent: LensIntent, viewport: Viewport): Lens {
    this._lens = applyLensIntent(this._lens, intent, viewport, this._lensSizing);
    return this._lens;
  }

  /**
   * A pass failed. Give up one rung and hold the ceiling there.
   *
   * One rung per failure rather than everything at once: a device that cannot
   * keep a history may still close gaps, and dropping to the bottom on the
   * first refusal gives up capabilities nothing implicated.
   */
  invalidate(failure: ContinuityFailure): ContinuityTier {
    const outcome = afterFailure(this._tier, failure);
    this._tier = outcome.tier;
    this._failureCeiling = lowerTier(this._failureCeiling, outcome.tier);
    this._lastFailure = failure;
    // Whatever was accumulated was accumulated under the rung that just
    // failed, so it describes a picture this session will not produce again.
    this._convergence = IDLE;
    return this._tier;
  }

  /** The last failure, for a diagnostics surface rather than for a viewer. */
  get lastFailure(): ContinuityFailure | null {
    return this._lastFailure;
  }

  /** What the subsystem is doing. Display only. */
  metrics(): ContinuityMetrics {
    return {
      epoch: this._epoch?.epoch ?? 0,
      framesThisEpoch: this._framesThisEpoch,
      epochsOpened: this._epochsOpened,
      capabilities: capabilitiesForTier(this._tier),
    };
  }

  /** Whether the runtime has been disposed. */
  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Release everything and stop.
   *
   * There is nothing to free yet, which is stated rather than left implied:
   * every capability that would allocate a GPU resource is off. The method
   * exists so that the place to release one is already decided, and so a
   * caller can stop the runtime without asking what it holds. A disposed
   * runtime returns to `source` and reports no capabilities, so a frame that
   * arrives after teardown draws as it did before the field existed.
   */
  dispose(): void {
    this._disposed = true;
    this._tier = 'source';
    this._failureCeiling = 'source';
    this._convergence = IDLE;
    this._lens = LENS_CLOSED;
    this._epoch = null;
  }

  /** The options it was built with, for a diagnostics readout. */
  get options(): ContinuityRuntimeOptions {
    return this._options;
  }
}
