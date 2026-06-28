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
import type { Viewer } from '../render/Viewer';

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
  readonly onToast?: (msg: string) => void;
}

export interface ReclassifyUi {
  readonly element: HTMLElement;
  setVisible(visible: boolean): void;
  /** Re-sync the undo/redo enabled state from the Viewer history. */
  refresh(): void;
  dispose(): void;
}

export function createReclassifyUi(opts: ReclassifyUiOptions): ReclassifyUi {
  const select = document.createElement('select');
  select.className = 'olv-reclass-select';
  select.setAttribute('data-testid', 'reclass-class');
  for (const [code, label] of CLASSES) {
    const option = document.createElement('option');
    option.value = String(code);
    option.textContent = `${code} · ${label}`;
    select.append(option);
  }
  select.value = '2'; // default to Ground

  const mkBtn = (text: string, testid: string): HTMLButtonElement => {
    const b = el('button', { className: 'olv-bc-pill', text }) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('data-testid', testid);
    return b;
  };
  const armBtn = mkBtn('Reclassify (lasso)', 'reclass-arm');
  const undoBtn = mkBtn('Undo', 'reclass-undo');
  const redoBtn = mkBtn('Redo', 'reclass-redo');

  const toast = (m: string): void => opts.onToast?.(m);

  const tool = new LassoVolumeTool(opts.canvas, {
    onCommit: (lasso) => {
      // Single-shot: disarm so the user returns to navigation after one edit.
      tool.disable();
      armBtn.classList.remove('olv-mkind-active');
      const v = opts.getViewer();
      const id = opts.getActiveId();
      if (!v || !id) return;
      const cls = Number(select.value);
      const r = v.reclassifyLasso(id, lasso, cls);
      toast(
        r.changedCount > 0
          ? `Reclassified ${r.changedCount.toLocaleString()} points → class ${cls}.`
          : 'Reclassify — no points inside the lasso.',
      );
      refresh();
    },
    onCancel: () => {
      armBtn.classList.remove('olv-mkind-active');
    },
  });

  armBtn.addEventListener('click', () => {
    if (tool.enabled) {
      tool.disable();
      armBtn.classList.remove('olv-mkind-active');
    } else {
      tool.enable();
      armBtn.classList.add('olv-mkind-active');
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
  }

  const element = el('div', { className: 'olv-reclass-panel' }, [
    el('div', { className: 'olv-reclass-head', text: 'Edit classes' }),
    el('div', { className: 'olv-bc-pills' }, [select, armBtn]),
    el('div', { className: 'olv-bc-pills' }, [undoBtn, redoBtn]),
  ]);
  refresh();

  return {
    element,
    setVisible: (visible: boolean) => element.classList.toggle('olv-hidden', !visible),
    refresh,
    dispose: () => {
      tool.disable();
      element.remove();
    },
  };
}
