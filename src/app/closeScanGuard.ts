/**
 * closeScanGuard.ts
 *
 * Closing a scan removes every cloud, clears the layer state and empties the
 * crash-recovery journal, so measurements, annotations, saved views, class
 * edits and computed results go with it. This asks first when any of that
 * exists, and closes straight away when none does.
 *
 * The guard is for the user-facing Close scan control only. Programmatic
 * resets (opening a scan over another, a failed load) do not pass through it.
 */

import { openConfirmChoice, type ConfirmChoice, type ConfirmOptions } from '../ui/Modal';

/** What closing would discard, as counts and flags read from the owners. */
export interface DiscardableWork {
  readonly measurements: number;
  readonly annotations: number;
  readonly views: number;
  /** Classes on the open scan differ from its file. */
  readonly classEdits: boolean;
  /** Ready results held by the Analyse, Observatory, lab and findings owners. */
  readonly results: number;
  /** Saved work waiting in the recovery journal. */
  readonly pendingRecovery: boolean;
}

export interface CloseScanGuardDeps {
  work(): DiscardableWork;
  /** Remove the scan and clear the recovery journal. */
  close(): void;
  /** Download the session file. Absent when there is no save action. */
  saveSession?(): Promise<unknown>;
  /** The shared confirm dialog; replaceable in tests. */
  confirm?(opts: ConfirmOptions): Promise<ConfirmChoice>;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Whether any kind of discardable work exists. */
export function hasDiscardableWork(w: DiscardableWork): boolean {
  return w.measurements > 0 || w.annotations > 0 || w.views > 0 || w.classEdits || w.results > 0 || w.pendingRecovery;
}

/** One line naming what closing discards. */
export function describeDiscardableWork(w: DiscardableWork): string {
  const parts: string[] = [];
  if (w.measurements) parts.push(plural(w.measurements, 'measurement'));
  if (w.annotations) parts.push(plural(w.annotations, 'annotation'));
  if (w.views) parts.push(plural(w.views, 'saved view'));
  if (w.classEdits) parts.push('class edits that differ from the file');
  if (w.results) parts.push(plural(w.results, 'computed result'));
  if (w.pendingRecovery && parts.length === 0) parts.push('work saved for recovery in this browser');
  return parts.join(', ');
}

/**
 * Build the guarded close. Resolves true when the scan was closed, false when
 * the user cancelled (or a save failed), leaving the scan, drafts and results
 * untouched.
 */
export function createCloseScanGuard(deps: CloseScanGuardDeps): () => Promise<boolean> {
  const confirm = deps.confirm ?? openConfirmChoice;
  let pending: Promise<boolean> | null = null;
  const run = async (): Promise<boolean> => {
    const work = deps.work();
    if (!hasDiscardableWork(work)) {
      deps.close();
      return true;
    }
    const save = deps.saveSession;
    const choice = await confirm({
      title: 'Close this scan?',
      message:
        `Closing the scan discards ${describeDiscardableWork(work)}.\n` +
        (save ? 'Save the session first to keep your measurements, annotations and views.' : 'This cannot be undone.'),
      confirmLabel: 'Close without saving',
      confirmTip: 'Close the scan and discard this work.',
      cancelLabel: 'Cancel',
      cancelTip: 'Keep the scan open and leave everything as it is.',
      ...(save ? { alternateLabel: 'Save session first', alternateTip: 'Download the session file, then close the scan.' } : {}),
    });
    if (choice === 'cancel') return false;
    if (choice === 'alternate' && save) {
      try { await save(); } catch { return false; }
    }
    deps.close();
    return true;
  };
  // A second request while the dialog is open joins it rather than stacking another.
  return () => {
    if (!pending) pending = run().finally(() => { pending = null; });
    return pending;
  };
}
