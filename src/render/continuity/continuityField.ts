/**
 * continuityField.ts
 *
 * The Continuity Field's pure core: what the display is currently showing, and
 * the moment what it showed stops being reusable.
 *
 * The Continuity Field reuses work across frames. Anything reused is only valid
 * while the state it was produced under still holds, so the subsystem needs one
 * answer to "is the previous frame's work still about the same picture?". That
 * answer is the display epoch: a counter that advances whenever an input the
 * history depends on changes, and stands still otherwise.
 *
 * Two rules shape the interface. History must not survive a change that alters
 * what a pixel means, and it must not be thrown away by a change that does not.
 * The second is the easier one to get wrong, so the inputs are an explicit
 * record rather than a grab bag: opening a panel, hovering a chip or moving the
 * mouse cannot reach this type, and so cannot invalidate anything.
 *
 * The caller reduces each input to a string it controls. This module does not
 * import three.js and never reads a camera, so a matrix, a clip volume and a
 * colour ramp arrive here already digested. That keeps the core pure and
 * testable in Node, and leaves the renderer owning the stateful bookkeeping,
 * matching how `refinementPhase.ts` splits its maths from the Viewer.
 *
 * Display only. Nothing here is measured geometry, and no epoch, phase or
 * metric may reach picking, measurement, terrain, export or claim evidence.
 */

/**
 * The six capabilities the Continuity Field can switch on, each gated on its
 * own evidence. They are separate flags rather than one switch because they
 * carry different risk: culling changes which points are drawn, packing changes
 * how bytes are stored, and accumulation changes what a pixel is composed from.
 */
export interface ContinuityCapabilities {
  /** Skip streaming nodes outside the view frustum. */
  readonly nodeCulling: boolean;
  /** Upload point attributes at their source widths. */
  readonly packedAttributes: boolean;
  /** Size points from local sample coverage. */
  readonly coverageSizing: boolean;
  /** Fill sub-pixel gaps between samples that already have support. */
  readonly microGapFill: boolean;
  /** Reuse shaded samples across frames within one epoch. */
  readonly temporalAccumulation: boolean;
  /** Reveal the raw samples behind any reconstruction. */
  readonly evidenceLens: boolean;
}

/**
 * Everything off. The Continuity Field ships disabled and each capability
 * graduates on its own measurement, so this is the shipped configuration until
 * one of them earns otherwise.
 */
export const CONTINUITY_DISABLED: ContinuityCapabilities = {
  nodeCulling: false,
  packedAttributes: false,
  coverageSizing: false,
  microGapFill: false,
  temporalAccumulation: false,
  evidenceLens: false,
};

/** Whether any capability is on, so a caller can skip the subsystem entirely. */
export function anyCapabilityEnabled(caps: ContinuityCapabilities): boolean {
  return Object.values(caps).some((on) => on === true);
}

/**
 * The display inputs a reused frame depends on, each already reduced to a
 * string or number by the caller that owns it.
 *
 * Adding a field here makes it invalidating. Leaving one out makes it
 * irrelevant. There is no third option, which is the point: the set of things
 * that can throw away history is reviewable in one place.
 */
export interface DisplayState {
  /** Camera transform digest. Any movement changes what every pixel sees. */
  readonly camera: string;
  /** Projection digest, including any field-of-view or ortho/perspective flip. */
  readonly projection: string;
  /** Backing-store width in device pixels. */
  readonly widthPx: number;
  /** Backing-store height in device pixels. */
  readonly heightPx: number;
  /** Device pixel ratio actually in use, which adaptive DPR steps. */
  readonly dpr: number;
  /** Render-origin digest; a rebase moves every position in the buffer. */
  readonly renderOrigin: string;
  /** Which dataset or datasets are mounted. */
  readonly dataset: string;
  /** The resident LOD frontier, when a change to it replaces drawn geometry. */
  readonly lodFrontier: string;
  /** Classification visibility mask. */
  readonly classFilter: string;
  /** Intensity and elevation windows. */
  readonly scalarFilter: string;
  /** Clip volume or section state. */
  readonly clip: string;
  /** Colour mode, ramp and range. */
  readonly colorMode: string;
  /** RGB appearance controls, which restyle without recolouring the source. */
  readonly rgbSettings: string;
  /** Point size mode, including the coverage sizing of the phase above. */
  readonly pointSizeMode: string;
  /** Splat mode and its radius multiplier. */
  readonly splatMode: string;
  /** EDL mode and parameters, where they change the composed image. */
  readonly edl: string;
  /**
   * Increments on backend or device reset. A lost device invalidates every GPU
   * resource whether or not any other input moved, so history from the old
   * device must not be reused on the new one.
   */
  readonly deviceGeneration: number;
}

/** The field names, fixed so the key and the diff cannot drift apart. */
const DISPLAY_STATE_FIELDS: readonly (keyof DisplayState)[] = [
  'camera',
  'projection',
  'widthPx',
  'heightPx',
  'dpr',
  'renderOrigin',
  'dataset',
  'lodFrontier',
  'classFilter',
  'scalarFilter',
  'clip',
  'colorMode',
  'rgbSettings',
  'pointSizeMode',
  'splatMode',
  'edl',
  'deviceGeneration',
];

/**
 * A stable identity for one display state. Field values are length-prefixed
 * before joining so no combination of values can spell another state's key: a
 * camera of `a|b` with an empty projection would otherwise collide with a
 * camera of `a` and a projection of `b`.
 */
export function displayStateKey(state: DisplayState): string {
  const parts: string[] = [];
  for (const field of DISPLAY_STATE_FIELDS) {
    const raw = String(state[field]);
    parts.push(`${raw.length}:${raw}`);
  }
  return parts.join('|');
}

/** Which inputs differ between two display states, in field order. */
export function displayStateDiff(
  a: DisplayState,
  b: DisplayState,
): readonly (keyof DisplayState)[] {
  return DISPLAY_STATE_FIELDS.filter((field) => String(a[field]) !== String(b[field]));
}

/** One epoch: a number, the state that produced it, and why it last advanced. */
export interface DisplayEpoch {
  /** Monotonic. Never reused, so a stale buffer tagged with an old one is detectable. */
  readonly epoch: number;
  /** The key of the state this epoch was opened under. */
  readonly key: string;
  /**
   * The state this epoch was opened under. Carried on the epoch rather than
   * passed back in by the caller, so the key and the state it describes cannot
   * disagree and a diff cannot be computed against a state that was never in
   * force.
   */
  readonly state: DisplayState;
  /** Which inputs changed to open it. Empty for the first epoch. */
  readonly changed: readonly (keyof DisplayState)[];
}

/** The first epoch for a display state. */
export function openEpoch(state: DisplayState): DisplayEpoch {
  return { epoch: 0, key: displayStateKey(state), state, changed: [] };
}

/**
 * The epoch for `state`, given the epoch currently open. Returns that same
 * epoch when nothing relevant moved, so a caller can compare `epoch` by value
 * to decide whether history is reusable.
 *
 * Monotonic by construction: the counter only ever increases, so an epoch
 * number is never reused and a buffer carrying an old one can always be
 * recognised as stale rather than silently matching a later state.
 */
export function advanceEpoch(current: DisplayEpoch, state: DisplayState): DisplayEpoch {
  const key = displayStateKey(state);
  if (key === current.key) return current;
  return {
    epoch: current.epoch + 1,
    key,
    state,
    changed: displayStateDiff(current.state, state),
  };
}

/** What the subsystem is doing, for a diagnostics readout. Display only. */
export interface ContinuityMetrics {
  /** The epoch in force. */
  readonly epoch: number;
  /** Frames rendered since the epoch opened. */
  readonly framesThisEpoch: number;
  /** Epochs opened since the subsystem started, a measure of history churn. */
  readonly epochsOpened: number;
  /** Which capabilities are on. */
  readonly capabilities: ContinuityCapabilities;
}
