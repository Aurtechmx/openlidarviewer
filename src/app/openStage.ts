/**
 * openStage.ts — what a viewer can do with the scan right now.
 *
 * `loadProgress` already names the seven stages a file passes through, from
 * detecting its format to rendering it. Those describe what the pipeline is
 * doing. This describes something else: whether the person in front of the
 * screen can look around yet, and whether more is still arriving.
 *
 * Two vocabularies rather than one because they answer different questions and
 * move at different times. Decoding is a pipeline stage and says nothing about
 * whether a camera responds; a scan whose decode finished can still be
 * streaming nodes in. Folding them together would give one word two meanings
 * and a surface reading it would pick the wrong one.
 *
 * ── WHAT THESE STAGES DO NOT MEAN ───────────────────────────────────────────
 * Display and interaction, and nothing beyond that. `ready` means the picture
 * has stopped changing. It does not mean the source is complete, that every
 * point the file holds has arrived, that a measurement would be sound, or that
 * anything has been validated. Those are separate questions with their own
 * answers elsewhere, and a stage name that implied them would be the most
 * easily believed false claim in the application: it appears while somebody is
 * waiting and reads as permission to trust what they see.
 *
 * ── DERIVED, NOT TRACKED ────────────────────────────────────────────────────
 * There is no state machine here and nothing to keep in step. The stage is a
 * function of facts the application already holds: whether a preview is
 * mounted, whether the full cloud is attached, whether the streamer has work
 * outstanding, and where the refinement phase is. A tracked stage would be a
 * second opinion about a load that already has one.
 *
 * Pure: no DOM, no three.js. Facts in, a name out.
 */
import type { RefinementPhase } from '../render/refinementPhase';

/** What the viewer can do, in the order a load passes through. */
export type OpenStage =
  /** Nothing is drawn. The empty state or the progress line is what is shown. */
  | 'opening'
  /** A coarse subset of the file is drawn and can be looked at. */
  | 'preview'
  /** The whole cloud is attached and nothing is known to be outstanding yet. */
  | 'interactive'
  /** The cloud is attached and more detail is still arriving. */
  | 'refining'
  /** The picture has stopped changing. */
  | 'ready';

/** The order above, for a caller that wants to compare two stages. */
export const OPEN_STAGE_ORDER: readonly OpenStage[] = [
  'opening',
  'preview',
  'interactive',
  'refining',
  'ready',
];

/** What the application knows about the scan this frame. */
export interface OpenStageFacts {
  /** A coarse cloud built from part of the file is on screen. */
  readonly previewMounted: boolean;
  /** The whole cloud has been attached to the scene. */
  readonly cloudAttached: boolean;
  /** The streamer has nodes in flight or queued. */
  readonly streamingBusy: boolean;
  /**
   * Where the renderer is in its own refinement, or null before it has run a
   * frame to judge from.
   *
   * Null is not `moving`: one means nothing has been assessed and the other
   * means the camera is in motion, and reading the first as the second would
   * report a still scan as refining forever.
   */
  readonly refinement: RefinementPhase | null;
}

/**
 * The stage these facts describe.
 *
 * A preview that is up while the full cloud is still decoding is `preview`,
 * whether or not the pipeline calls itself decoding: what matters is that
 * part of the file is on screen and the rest is not.
 */
export function openStage(facts: OpenStageFacts): OpenStage {
  if (!facts.cloudAttached) return facts.previewMounted ? 'preview' : 'opening';
  if (facts.streamingBusy) return 'refining';
  if (facts.refinement === null) return 'interactive';
  return facts.refinement === 'full-refine' ? 'ready' : 'refining';
}

/**
 * Whether the viewer responds to input at this stage.
 *
 * Everything but `opening`. A preview is a smaller picture and not a lesser
 * one to drive: the camera works, the tools work, and nothing about it is
 * modal. That is the difference this vocabulary exists to make visible.
 */
export function respondsToInput(stage: OpenStage): boolean {
  return stage !== 'opening';
}

/**
 * Whether an overlay may cover the scan at this stage.
 *
 * Only while nothing is drawn. Once there is something to look at, an overlay
 * that blocks it is taking away the thing the viewer waited for, and the
 * progress it reports can be shown beside the scan rather than over it.
 */
export function mayBlockWithOverlay(stage: OpenStage): boolean {
  return stage === 'opening';
}

/**
 * A short label for a status surface.
 *
 * Deliberately plain, and deliberately not a claim. `Ready` says the picture
 * has settled; a surface that wants to say something about the data says it
 * with the evidence vocabulary, which has its own states and its own rules.
 */
export const OPEN_STAGE_LABEL: Readonly<Record<OpenStage, string>> = Object.freeze({
  opening: 'Opening',
  preview: 'Preview',
  interactive: 'Interactive',
  refining: 'Refining',
  ready: 'Ready',
});
