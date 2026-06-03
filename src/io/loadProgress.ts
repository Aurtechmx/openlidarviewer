/**
 * loadProgress.ts
 *
 * The shared vocabulary for the staged load pipeline. A load advances
 * through a fixed sequence of named stages; each stage emits a `ProgressUpdate`
 * that the UI turns into a status line and a progress bar.
 *
 * The stages span the main thread and the parse worker:
 *  - `detecting-format`, `reading-file` — main thread, before the worker;
 *  - `parsing-metadata`, `decoding`, `optimizing` — inside the worker;
 *  - `uploading`, `rendering` — main thread, after the worker replies.
 *
 * This module has no DOM or three.js dependency, so it is unit-tested in Node.
 */

/** One stage of a file load, in pipeline order. */
export type LoadStage =
  | 'detecting-format'
  | 'reading-file'
  | 'parsing-metadata'
  | 'decoding'
  | 'optimizing'
  | 'uploading'
  | 'rendering';

/** A single progress event emitted while a file loads. */
export interface ProgressUpdate {
  /** Which pipeline stage this update belongs to. */
  stage: LoadStage;
  /** Optional human-readable detail, e.g. `"2.1M of 3.6M points"`. */
  detail?: string;
  /** Optional completion within the stage, in the range 0..1. */
  fraction?: number;
}

/** A short, plain-language label for a load stage. */
export function loadStageLabel(stage: LoadStage): string {
  switch (stage) {
    case 'detecting-format':
      return 'Detecting format';
    case 'reading-file':
      return 'Reading file';
    case 'parsing-metadata':
      return 'Parsing metadata';
    case 'decoding':
      return 'Decoding points';
    case 'optimizing':
      return 'Optimizing';
    case 'uploading':
      return 'Preparing GPU buffers';
    case 'rendering':
      return 'Rendering';
  }
}

/** Format a progress update as a single status line for the toast. */
export function formatProgress(update: ProgressUpdate): string {
  const label = loadStageLabel(update.stage);
  return update.detail ? `${label} — ${update.detail}` : `${label}…`;
}
