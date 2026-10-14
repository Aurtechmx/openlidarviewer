/**
 * discardGuard.ts
 *
 * One question for every action that replaces what is on screen without being
 * the Close scan control: "is there work that would be lost, and does the user
 * want that?". Opening a streamed scan over an open one, and importing a
 * session over measurements, annotations or saved views, both ask here.
 *
 * It reuses the close-scan guard's work counts and the shared confirm dialog.
 * Save runs the session save first, Replace keeps a recovery snapshot and then
 * lets the caller discard, Cancel changes nothing. With no work at risk it asks
 * nothing and answers `none`.
 */

import { openConfirmChoice, type ConfirmChoice, type ConfirmOptions } from '../ui/Modal';
import { describeDiscardableWork, hasDiscardableWork, type DiscardableWork } from './closeScanGuard';

/** What is replacing the work: a scan opened over the current one, or a session file imported. */
export interface ReplaceRequest {
  readonly kind: 'scan' | 'import';
  /** File name shown in the question. */
  readonly name: string;
  /** The incoming session carries exactly the work already open, so nothing is lost. */
  readonly identical?: boolean;
}

/** `none`: nothing at risk, no question asked. `replace`: go ahead and discard. `cancel`: change nothing. */
export type ReplaceOutcome = 'none' | 'replace' | 'cancel';

export interface ReplaceGuardDeps {
  work(): DiscardableWork;
  /** Download the session file. Resolves true only once a file was written. */
  saveSession?(): Promise<boolean>;
  /** Keep the current work in the recovery journal. Resolves true once it is stored. */
  snapshot?(): Promise<boolean>;
  /** Tell the user something (save failed, snapshot kept). */
  notify?(message: string): void;
  /** The shared confirm dialog; replaceable in tests. */
  confirm?(opts: ConfirmOptions): Promise<ConfirmChoice>;
}

/**
 * The work an action would discard. An import replaces measurements,
 * annotations and saved views only; it leaves class edits, computed results
 * and the recovery journal alone.
 */
export function workAtRisk(work: DiscardableWork, kind: ReplaceRequest['kind']): DiscardableWork {
  if (kind === 'scan') return { ...work, results: 0, pendingRecovery: false };
  return { ...work, classEdits: false, results: 0, pendingRecovery: false };
}

/** Whether the request would discard anything. */
export function wouldLoseWork(work: DiscardableWork, req: ReplaceRequest): boolean {
  return !req.identical && hasDiscardableWork(workAtRisk(work, req.kind));
}

let pending: Promise<ReplaceOutcome> | null = null;

/**
 * Ask when work would be lost. A request made while the question is open is
 * refused (`cancel`) rather than stacking a second dialog.
 */
export function requestReplace(req: ReplaceRequest, deps: ReplaceGuardDeps): Promise<ReplaceOutcome> {
  if (pending) return Promise.resolve('cancel');
  const run = async (): Promise<ReplaceOutcome> => {
    const work = workAtRisk(deps.work(), req.kind);
    if (!wouldLoseWork(deps.work(), req)) return 'none';
    const storable = work.measurements > 0 || work.annotations > 0 || work.views > 0;
    const save = storable ? deps.saveSession : undefined;
    const what = describeDiscardableWork(work);
    const lines = [
      req.kind === 'scan'
        ? `Opening ${req.name} replaces the open scan and discards ${what}.`
        : `Importing ${req.name} replaces ${what} in the viewer.`,
    ];
    if (save) lines.push('Save the current session first to keep it.');
    else lines.push('This cannot be undone from the viewer.');
    if (work.classEdits) lines.push('The session file does not store class edits. Export the scan as LAS to keep them.');
    const choice = await (deps.confirm ?? openConfirmChoice)({
      title: req.kind === 'scan' ? 'Replace the open scan?' : 'Replace the current work?',
      message: lines.join('\n'),
      confirmLabel: 'Replace',
      confirmTip: 'Discard the current work and continue.',
      cancelLabel: 'Cancel',
      cancelTip: 'Keep the current scan and work as they are.',
      ...(save ? { alternateLabel: 'Save session, then replace', alternateTip: 'Download the current session file, then continue.' } : {}),
    });
    if (choice === 'cancel') return 'cancel';
    if (choice === 'alternate' && save) {
      let saved = false;
      try { saved = (await save()) === true; } catch { saved = false; }
      if (!saved) {
        deps.notify?.('Session not saved. The current scan and work are unchanged.');
        return 'cancel';
      }
      return 'replace';
    }
    let kept = false;
    try { kept = (await deps.snapshot?.()) === true; } catch { kept = false; }
    if (kept) deps.notify?.('The replaced work is kept for recovery in this browser.');
    return 'replace';
  };
  pending = run().finally(() => { pending = null; });
  return pending;
}
