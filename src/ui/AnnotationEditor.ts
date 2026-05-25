/**
 * AnnotationEditor.ts
 *
 * The compact inline editor card for creating or editing an annotation —
 * title, type, and an optional note. It is a transient floating card: it opens
 * at a screen point, and on Save or Cancel it closes cleanly. A cancelled
 * editor never leaves a stale annotation behind — the controller only commits
 * an annotation on the Save callback.
 */

import { el } from './dom';
import type { AnnotationType } from '../render/annotate/types';
import { ANNOTATION_TYPES } from '../render/annotate/types';
import type { MeasurementRef } from '../render/annotate/AnnotationController';

/** The fields the editor collects. */
export interface AnnotationDraftFields {
  title: string;
  note: string;
  type: AnnotationType;
  /**
   * Whether to capture the current camera viewpoint with the annotation.
   * Only meaningful when the editor was opened with `showCamera` — on an edit
   * it is always `false`, since editing never recaptures the camera.
   */
  captureCamera: boolean;
  /** The measurement to link, or `null` for no link. */
  linkedMeasurementId: string | null;
}

/** Options for {@link AnnotationEditor.open}. */
export interface AnnotationEditorOpen {
  /** Screen coordinates to anchor the card near. */
  x: number;
  y: number;
  /** Pre-filled values (for editing an existing annotation). */
  initial?: Partial<AnnotationDraftFields>;
  /** Card heading and Save-button label. */
  heading?: string;
  saveLabel?: string;
  /** Show the "Save current camera view" checkbox — only on create. */
  showCamera?: boolean;
  /** Measurements the annotation may be linked to; an empty list hides the row. */
  measurements?: MeasurementRef[];
  onSave: (fields: AnnotationDraftFields) => void;
  onCancel: () => void;
}

const TYPE_LABEL: Record<AnnotationType, string> = {
  note: 'Note',
  info: 'Info',
  warning: 'Warning',
  issue: 'Issue',
};

/** Approximate card size, for clamping it inside the viewport. */
const CARD_W = 264;
const CARD_H = 320;

export class AnnotationEditor {
  /** The card element — mount into the stage overlay. */
  readonly element: HTMLElement;

  private readonly _heading: HTMLElement;
  private readonly _title: HTMLInputElement;
  private readonly _note: HTMLTextAreaElement;
  private readonly _saveBtn: HTMLButtonElement;
  private readonly _cameraRow: HTMLElement;
  private readonly _cameraCheck: HTMLInputElement;
  private readonly _linkRow: HTMLElement;
  private readonly _linkSelect: HTMLSelectElement;
  private readonly _typeChips = new Map<AnnotationType, HTMLButtonElement>();
  private _type: AnnotationType = 'note';
  /** Whether the link row is shown for this open() — drives how `_save` reads it. */
  private _linkVisible = false;
  /** The link the editor opened with — preserved when the row is hidden. */
  private _initialLink: string | null = null;
  private _onSave: ((f: AnnotationDraftFields) => void) | null = null;
  private _onCancel: (() => void) | null = null;

  constructor() {
    this._heading = el('span', {
      className: 'olv-anno-editor-heading',
      text: 'New annotation',
    });

    this._title = el('input', { className: 'olv-anno-editor-title' });
    this._title.type = 'text';
    this._title.placeholder = 'Title';
    this._title.maxLength = 120;

    const typeRow = el('div', { className: 'olv-anno-editor-types' });
    for (const t of ANNOTATION_TYPES) {
      const chip = el('button', {
        className: `olv-anno-chip olv-anno-chip-${t}`,
        text: TYPE_LABEL[t],
        title: `Mark this annotation as ${TYPE_LABEL[t].toLowerCase()}`,
      });
      chip.type = 'button';
      chip.addEventListener('click', () => {
        chip.blur();
        this._setType(t);
      });
      this._typeChips.set(t, chip);
      typeRow.append(chip);
    }

    this._note = el('textarea', { className: 'olv-anno-editor-note' });
    this._note.placeholder = 'Note (optional)';
    this._note.rows = 3;

    // "Save current camera view" — captures the viewpoint so "jump to
    // annotation" later restores not just the point but the whole framing.
    // Shown only when creating; an edit never recaptures the camera.
    this._cameraCheck = el('input', { className: 'olv-anno-editor-camera-box' });
    this._cameraCheck.type = 'checkbox';
    this._cameraCheck.checked = true;
    this._cameraRow = el('label', { className: 'olv-anno-editor-camera' }, [
      this._cameraCheck,
      el('span', { text: 'Save current camera view' }),
    ]);

    // "Linked measurement" — optionally ties the annotation to a measurement;
    // the row is hidden when the scan carries no measurements to link against.
    this._linkSelect = el('select', {
      className: 'olv-anno-editor-link-select',
      title: 'Link this annotation to a measurement',
    });
    this._linkRow = el('label', { className: 'olv-anno-editor-link' }, [
      el('span', { className: 'olv-anno-editor-link-label', text: 'Linked measurement' }),
      this._linkSelect,
    ]);

    const cancelBtn = el('button', { className: 'olv-anno-editor-cancel', text: 'Cancel' });
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => {
      cancelBtn.blur();
      this._cancel();
    });

    this._saveBtn = el('button', { className: 'olv-anno-editor-save', text: 'Save' });
    this._saveBtn.type = 'button';
    this._saveBtn.addEventListener('click', () => {
      this._saveBtn.blur();
      this._save();
    });

    this.element = el('div', { className: 'olv-anno-editor' }, [
      this._heading,
      this._title,
      typeRow,
      this._note,
      this._linkRow,
      this._cameraRow,
      el('div', { className: 'olv-anno-editor-actions' }, [cancelBtn, this._saveBtn]),
    ]);
    this.element.style.display = 'none';

    // Escape cancels the editor (not the whole tool — the propagation stops
    // here); Enter in the title field saves.
    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this._cancel();
      } else if (e.key === 'Enter' && e.target === this._title) {
        e.preventDefault();
        this._save();
      }
    });
  }

  /** Whether the editor is currently open. */
  get isOpen(): boolean {
    return this.element.style.display !== 'none';
  }

  /** Open the editor near a screen point, with optional pre-filled values. */
  open(opts: AnnotationEditorOpen): void {
    this._onSave = opts.onSave;
    this._onCancel = opts.onCancel;
    this._heading.textContent = opts.heading ?? 'New annotation';
    this._title.value = opts.initial?.title ?? '';
    this._note.value = opts.initial?.note ?? '';
    this._saveBtn.textContent = opts.saveLabel ?? 'Save';
    this._setType(opts.initial?.type ?? 'note');

    // The camera-capture row is a create-only affordance; default it checked.
    const showCamera = opts.showCamera === true;
    this._cameraRow.classList.toggle('olv-hidden', !showCamera);
    this._cameraCheck.checked = showCamera;

    // The link row offers the scan's measurements; hidden when there are none.
    const measurements = opts.measurements ?? [];
    this._linkVisible = measurements.length > 0;
    this._initialLink = opts.initial?.linkedMeasurementId ?? null;
    this._linkRow.classList.toggle('olv-hidden', !this._linkVisible);
    const none = el('option', { text: '(not linked)' });
    none.value = '';
    this._linkSelect.replaceChildren(none);
    for (const m of measurements) {
      const option = el('option', { text: m.name });
      option.value = m.id;
      this._linkSelect.append(option);
    }
    // Select the linked measurement when it still exists; else "(not linked)".
    this._linkSelect.value =
      this._initialLink && measurements.some((m) => m.id === this._initialLink)
        ? this._initialLink
        : '';

    this.element.style.display = 'flex';
    const left = Math.min(Math.max(8, opts.x + 14), window.innerWidth - CARD_W - 8);
    const top = Math.min(Math.max(8, opts.y - 24), window.innerHeight - CARD_H - 8);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;

    this._title.focus();
    this._title.select();
  }

  /** Close the editor without firing either callback. */
  close(): void {
    this.element.style.display = 'none';
    this._onSave = null;
    this._onCancel = null;
  }

  private _setType(t: AnnotationType): void {
    this._type = t;
    for (const [k, chip] of this._typeChips) {
      chip.classList.toggle('olv-anno-chip-active', k === t);
    }
  }

  private _save(): void {
    const onSave = this._onSave;
    const fields: AnnotationDraftFields = {
      title: this._title.value,
      note: this._note.value,
      type: this._type,
      captureCamera: !this._cameraRow.classList.contains('olv-hidden') && this._cameraCheck.checked,
      // When the row is shown, the select is authoritative; when hidden (no
      // measurements to choose from) the annotation's existing link is kept.
      linkedMeasurementId: this._linkVisible
        ? this._linkSelect.value || null
        : this._initialLink,
    };
    this.close();
    onSave?.(fields);
  }

  private _cancel(): void {
    const onCancel = this._onCancel;
    this.close();
    onCancel?.();
  }
}
