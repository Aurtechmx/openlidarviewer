/**
 * reclassifyUi.ts
 *
 * The manual classification-edit control panel — class picker + lasso-arm +
 * undo/redo. Lazy-loaded the first time a classification exists, so it never
 * enters the startup shell. It drives the tested Viewer engine
 * (`reclassifyLasso` / `undo|redoClassification`); the editor logic and the
 * undo/redo history live behind that seam, already unit- and e2e-covered.
 *
 * The lasso reuses the same freehand tool the volume lasso uses; on commit the
 * points inside the lasso are set to the picked class, the edit is recorded for
 * undo, and the cloud's edit epoch advances (so any stale analysis/grade is
 * invalidated downstream).
 */

import { el } from './dom';
import { LassoVolumeTool } from './LassoVolumeTool';
import { reclassifyOutcome } from './reclassifyOutcome';
import { noteEdit } from './undoRouter';
import type { Viewer } from '../render/Viewer';
import {
  AUTO_CLASSIFY_LIMITS,
  NEEDS_LOADED_SCAN,
  canRestoreOriginal,
  clearClassification,
  restoreOriginalClassification,
  type ClassLayerOutcome,
} from '../render/class/classLayer';

/** Why Clear / Restore did nothing, in the user's words. */
const NOT_RUN: Readonly<Record<Exclude<ClassLayerOutcome, 'ok'>, string>> = {
  'not-loaded': `Clear classifications ${NEEDS_LOADED_SCAN}`,
  'no-classification': 'This scan carries no classification to clear.',
  already: 'Classes are already cleared. Undo or Restore original classes brings them back.',
  'no-original': 'No original classes to restore: the classes have not been cleared or replaced.',
};

/** Common ASPRS classes offered as reclassify targets. */
const CLASSES: ReadonlyArray<readonly [number, string]> = [
  [1, 'Unclassified'],
  [2, 'Ground'],
  [3, 'Low vegetation'],
  [4, 'Medium vegetation'],
  [5, 'High vegetation'],
  [6, 'Building'],
  [7, 'Low noise'],
  [9, 'Water'],
];

export interface ReclassifyUiOptions {
  readonly canvas: HTMLCanvasElement;
  readonly getViewer: () => Viewer | null;
  readonly getActiveId: () => string | null;
  /**
   * Bring the class legend back in step after an edit and report whether the
   * target class had to be revealed. The edit only touches visible points, so
   * reclassifying into a filtered-out class hid its own result.
   */
  readonly onReclassified?: (targetClass: number) => boolean;
  readonly onToast?: (msg: string) => void;
  /**
   * Run the whole-scan heuristic classifier (ground / vegetation / building).
   * Drives the primary "Auto-classify" button; the host owns the derive so the
   * panel stays a dumb view. Absent ⇒ the button is not shown.
   */
  readonly onAutoClassify?: () => Promise<void> | void;
}

export interface ReclassifyUi {
  readonly element: HTMLElement;
  setVisible(visible: boolean): void;
  /** Re-sync the undo/redo enabled state from the Viewer history. */
  refresh(): void;
  /** Disarm the lasso if it is armed. True when it had been armed. */
  disarm(): boolean;
  dispose(): void;
}

export function createReclassifyUi(opts: ReclassifyUiOptions): ReclassifyUi {
  const select = document.createElement('select');
  select.className = 'olv-reclass-select';
  select.setAttribute('aria-label', 'Target classification');
  select.setAttribute('data-tip', 'The class given to points you select with the lasso.');
  select.setAttribute('data-testid', 'reclass-class');
  for (const [code, label] of CLASSES) {
    const option = document.createElement('option');
    option.value = String(code);
    option.textContent = `${code} · ${label}`;
    select.append(option);
  }
  select.value = '2'; // default to Ground

  // Every caller below overwrites this with a specific explanation; the
  // fallback only guards a future call site that forgets to.
  const mkBtn = (text: string, testid: string, extra = ''): HTMLButtonElement => {
    const b = el('button', { className: `olv-bc-pill${extra ? ' ' + extra : ''}`, text }) as HTMLButtonElement;
    b.type = 'button';
    b.title = text;
    b.setAttribute('data-testid', testid);
    return b;
  };
  const armBtn = mkBtn('Reclassify (lasso)', 'reclass-arm', 'olv-reclass-go');
  armBtn.title = 'Draw around points to give them the class chosen above. The source file is not changed.';
  armBtn.setAttribute('aria-pressed', 'false');
  const setArmed = (armed: boolean): void => {
    armBtn.classList.toggle('olv-mkind-active', armed);
    armBtn.setAttribute('aria-pressed', armed ? 'true' : 'false');
  };
  const undoBtn = mkBtn('Undo', 'reclass-undo');
  undoBtn.title = 'Take back the last class change.';
  const redoBtn = mkBtn('Redo', 'reclass-redo');
  redoBtn.title = 'Put back the change you just undid.';
  // Primary action: derive a whole-scan classification (heuristic). Only built
  // when the host wires a handler, so the panel degrades cleanly without it.
  const autoBtn = opts.onAutoClassify
    ? mkBtn('Auto-classify scan', 'reclass-auto', 'olv-reclass-auto')
    : null;
  if (autoBtn) {
    autoBtn.title =
      `Derive ground / vegetation / building for the whole scan (heuristic, not survey-grade). ${AUTO_CLASSIFY_LIMITS}`;
    // Reflect the in-flight derive: disable + spinner while it runs, restore on
    // settle. Awaits the promise the host returns, so a slow whole-scan classify
    // reads as working rather than frozen.
    const autoLabel = autoBtn.textContent ?? 'Auto-classify scan';
    autoBtn.addEventListener('click', () => {
      if (autoBtn.disabled) return;
      autoBtn.disabled = true;
      autoBtn.classList.add('olv-reclass-auto-loading');
      autoBtn.textContent = 'Classifying…';
      void Promise.resolve(opts.onAutoClassify?.()).finally(() => {
        autoBtn.disabled = false;
        autoBtn.classList.remove('olv-reclass-auto-loading');
        autoBtn.textContent = autoLabel;
      });
    });
  }

  const toast = (m: string): void => opts.onToast?.(m);

  // Clear classifications: every point to class 1 for this session, recorded
  // so Undo restores the codes exactly. Undoable, so no confirmation modal; the
  // level-1 inline note below carries Undo and Restore original classes.
  const clearBtn = mkBtn('Clear classes', 'reclass-clear');
  clearBtn.title = 'Set every point to class 1 (Unclassified) for this session. The source file is not changed; Undo brings the classes back.';
  const limits = el('div', { className: 'olv-reclass-hint', text: `Auto-classify: ${AUTO_CLASSIFY_LIMITS}` });
  const linkBtn = (text: string, testid: string, tip: string): HTMLButtonElement => {
    const b = el('button', { className: 'olv-reclass-link', text }) as HTMLButtonElement;
    b.type = 'button';
    b.title = tip;
    b.setAttribute('data-testid', testid);
    return b;
  };
  const noteText = el('span', { text: '' });
  const noteUndo = linkBtn('Undo', 'reclass-note-undo', 'Take back the last class change.');
  const noteRestore = linkBtn('Restore original classes', 'reclass-restore', 'Put back the classes the scan had before the first clear or auto-classify. Undo takes this back too.');
  const restoreSep = el('span', { text: ' · ' });
  const note = el('div', { className: 'olv-reclass-note' }, [noteText, el('span', { text: ' · ' }), noteUndo, restoreSep, noteRestore]);
  note.setAttribute('role', 'status');
  note.setAttribute('data-testid', 'reclass-cleared-note');
  const streamNote = el('div', {
    className: 'olv-reclass-note',
    text: `Clear classes and Auto-classify need a fully loaded scan; streaming scans are not supported yet.`,
  });
  streamNote.setAttribute('data-testid', 'reclass-needs-loaded');
  const wholeScan = (run: () => ClassLayerOutcome | null, done: string): void => {
    const r = run();
    if (r === 'ok') {
      noteEdit('classification');
      toast(done);
    } else if (r) toast(NOT_RUN[r]);
    refresh();
  };
  const withActive = (fn: (v: Viewer, id: string) => ClassLayerOutcome): (() => ClassLayerOutcome | null) => () => {
    const v = opts.getViewer();
    const id = opts.getActiveId();
    return v && id ? fn(v, id) : v?.streamingCloud ? 'not-loaded' : null;
  };
  clearBtn.addEventListener('click', () => wholeScan(withActive(clearClassification),
    'Classes cleared: every point is class 1 for this session. Undo or Restore original classes brings them back.'));
  noteRestore.addEventListener('click', () => wholeScan(withActive(restoreOriginalClassification),
    'Original classes restored.'));
  noteUndo.addEventListener('click', () => undoBtn.click());

  const tool = new LassoVolumeTool(opts.canvas, {
    onCommit: (lasso) => {
      // Single-shot: disarm so the user returns to navigation after one edit.
      tool.disable();
      setArmed(false);
      const v = opts.getViewer();
      const id = opts.getActiveId();
      if (!v || !id) return;
      const cls = Number(select.value);
      const r = v.reclassifyLasso(id, lasso, cls);
      let revealed = false;
      if (r.changedCount > 0) {
        noteEdit('classification');
        revealed = opts.onReclassified?.(cls) ?? false;
      }
      toast(reclassifyOutcome(r, cls, revealed));
      refresh();
    },
    onCancel: () => {
      setArmed(false);
    },
  });

  armBtn.addEventListener('click', () => {
    if (tool.enabled) {
      tool.disable();
      setArmed(false);
    } else {
      tool.enable();
      setArmed(true);
    }
  });
  undoBtn.addEventListener('click', () => {
    const v = opts.getViewer();
    const id = opts.getActiveId();
    if (v && id && v.undoClassification(id)) {
      toast('Undid the last class edit.');
      refresh();
    }
  });
  redoBtn.addEventListener('click', () => {
    const v = opts.getViewer();
    const id = opts.getActiveId();
    if (v && id && v.redoClassification(id)) {
      toast('Redid the class edit.');
      refresh();
    }
  });

  function refresh(): void {
    const v = opts.getViewer();
    const id = opts.getActiveId();
    undoBtn.disabled = !(v && id && v.canUndoClassification(id));
    redoBtn.disabled = !(v && id && v.canRedoClassification(id));
    noteUndo.disabled = undoBtn.disabled;
    const cloud = v && id ? v.getCloud(id) : undefined;
    const prov = cloud?.classificationProvenance;
    // A streaming scan has no resident class buffer to clear or derive over.
    const streaming = !cloud && !!v?.streamingCloud;
    streamNote.classList.toggle('olv-hidden', !streaming);
    clearBtn.disabled = streaming || !cloud?.classification || prov === 'cleared';
    if (autoBtn && !autoBtn.classList.contains('olv-reclass-auto-loading')) autoBtn.disabled = streaming;
    const restorable = canRestoreOriginal(cloud);
    noteRestore.classList.toggle('olv-hidden', !restorable);
    restoreSep.classList.toggle('olv-hidden', !restorable);
    note.classList.toggle('olv-hidden', prov !== 'cleared' && !restorable);
    noteText.textContent = prov === 'cleared'
      ? `${cloud?.originalClassification ? 'Producer classes' : 'Classes'} cleared for this session`
      : 'Classes derived for this session (heuristic)';
  }

  // Full-width rows: header, the target-class select, the primary reclassify
  // action, then an undo/redo pair — so the action label never shares a row
  // with the wide select (which clipped it in the cramped left dock).
  const element = el('div', { className: 'olv-reclass-panel' }, [
    el('div', { className: 'olv-reclass-head', text: 'Edit classes' }),
    // Primary: derive the whole scan, or clear it. Manual class + lasso follow.
    el('div', { className: 'olv-reclass-actions olv-reclass-whole' }, [...(autoBtn ? [autoBtn] : []), clearBtn]),
    note,
    streamNote,
    ...(autoBtn ? [limits] : []),
    select,
    armBtn,
    el('div', { className: 'olv-reclass-actions' }, [undoBtn, redoBtn]),
  ]);
  refresh();

  return {
    disarm(): boolean {
      if (!tool.enabled) return false;
      tool.disable();
      setArmed(false);
      return true;
    },
    element,
    setVisible: (visible: boolean) => element.classList.toggle('olv-hidden', !visible),
    refresh,
    dispose: () => {
      tool.disable();
      element.remove();
    },
  };
}
