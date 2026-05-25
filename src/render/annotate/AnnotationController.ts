/**
 * AnnotationController.ts
 *
 * Orchestrates the annotation layer — owns the annotation list, the current
 * selection, and the active-tool state; delegates marker drawing to
 * `AnnotationOverlay`. It is the single source of truth for annotation state;
 * the panel and the overlay are views of it. Mirrors `MeasureController`.
 *
 * Browser-bound (DOM); the pure data model it relies on is `annotate/types.ts`.
 */

import type * as THREE from 'three/webgpu';
import type {
  Annotation,
  AnnotationEdit,
  AnnotationType,
  NewAnnotation,
  SavedCameraState,
  Vec3Object,
} from './types';
import { createAnnotation, editAnnotation } from './types';
import { AnnotationOverlay } from './AnnotationOverlay';
import { AnnotationEditor } from '../../ui/AnnotationEditor';
import { el } from '../../ui/dom';

/** A measurement the annotation editor can offer to link against. */
export interface MeasurementRef {
  id: string;
  name: string;
}

/**
 * Bounded depth of the annotation undo history. A snapshot is one array of
 * (immutable, shared) annotation objects, so even a full stack is cheap.
 */
const UNDO_DEPTH = 50;

/** A compact, display-ready summary of one annotation, for the panel. */
export interface AnnotationSummary {
  id: string;
  /** 1-based marker index. */
  index: number;
  title: string;
  type: AnnotationType;
  note: string;
  createdAt: number;
  updatedAt: number;
  selected: boolean;
  /** Name of the linked measurement, when one is linked and still exists. */
  linkedMeasurement?: string;
}

export class AnnotationController {
  /** The SVG marker overlay element — append to the stage overlay. */
  readonly overlay: SVGSVGElement;

  private readonly _draw = new AnnotationOverlay();
  private readonly _editor = new AnnotationEditor();
  private readonly _hint: HTMLElement;
  private readonly _hintText: HTMLElement;
  private _annotations: Annotation[] = [];
  private _selectedId: string | null = null;
  private _active = false;
  private _onChange: (() => void) | null = null;
  private _onSelect: ((id: string | null) => void) | null = null;
  /** Supplies the measurements an annotation may link to; empty by default. */
  private _measurements: () => MeasurementRef[] = () => [];
  /** Past annotation-list snapshots (most recent last) — drives undo. */
  private _undoStack: Annotation[][] = [];
  /** Snapshots undone but available to redo — cleared by any fresh edit. */
  private _redoStack: Annotation[][] = [];

  constructor() {
    this.overlay = this._draw.element;
    this._draw.setOnMarkerClick((id) => this.select(id));
    this._hintText = el('span', { className: 'olv-anno-hint-text' });
    this._hint = el('div', { className: 'olv-anno-hint olv-hidden' }, [
      el('span', { className: 'olv-anno-hint-badge', text: 'Annotate' }),
      this._hintText,
    ]);
  }

  /** Whether annotation mode is currently on. */
  get active(): boolean {
    return this._active;
  }

  /** The selected annotation's id, or null. */
  get selectedId(): string | null {
    return this._selectedId;
  }

  /** Enter or leave annotation mode. Markers stay drawn either way. */
  setActive(on: boolean): void {
    this._active = on;
    this._hint.classList.toggle('olv-hidden', !on);
    if (on) {
      this._setHint('Click a point on the scan to annotate it');
    } else {
      // Leaving the tool abandons any draft in progress — no stale annotation.
      this._editor.close();
    }
  }

  /** The instruction hint element — mount into the stage overlay. */
  get hint(): HTMLElement {
    return this._hint;
  }

  /** The inline-editor card element — mount into the stage overlay. */
  get editorElement(): HTMLElement {
    return this._editor.element;
  }

  /** Whether the create/edit editor card is currently open. */
  get isEditing(): boolean {
    return this._editor.isOpen;
  }

  /**
   * Begin creating an annotation at a picked local point: open the inline
   * editor near the click. Saving commits the annotation; cancelling discards
   * the draft entirely, so no empty annotation is ever left behind.
   *
   * `cameraState` is the viewpoint captured at the moment of the click; it is
   * attached to the annotation only if the user keeps the "Save current camera
   * view" checkbox ticked.
   */
  beginDraft(
    local: Vec3Object,
    screenX: number,
    screenY: number,
    cameraState?: SavedCameraState,
  ): void {
    this._setHint('Fill in the annotation, then Save');
    this._editor.open({
      x: screenX,
      y: screenY,
      showCamera: cameraState !== undefined,
      measurements: this._measurements(),
      onSave: (fields) => {
        this.add({
          title: fields.title,
          note: fields.note,
          type: fields.type,
          localPosition: local,
          ...(fields.captureCamera && cameraState ? { cameraState } : {}),
          ...(fields.linkedMeasurementId
            ? { linkedMeasurementId: fields.linkedMeasurementId }
            : {}),
        });
        this._setHint('Click a point on the scan to annotate it');
      },
      onCancel: () => {
        this._setHint('Click a point on the scan to annotate it');
      },
    });
  }

  /** Register the source of measurements the editor offers as link targets. */
  setMeasurementSource(source: () => MeasurementRef[]): void {
    this._measurements = source;
  }

  /** Report a click that missed the cloud — no annotation is created. */
  pickMissed(): void {
    this._setHint('No point there — click directly on the scan');
  }

  /** Open the editor for an existing annotation; saving applies the edit. */
  beginEdit(id: string, screenX: number, screenY: number): void {
    const a = this.get(id);
    if (!a) return;
    this._editor.open({
      x: screenX,
      y: screenY,
      heading: 'Edit annotation',
      initial: {
        title: a.title,
        note: a.note ?? '',
        type: a.type,
        linkedMeasurementId: a.linkedMeasurementId ?? null,
      },
      measurements: this._measurements(),
      onSave: (fields) => {
        this.update(id, {
          title: fields.title,
          note: fields.note,
          type: fields.type,
          linkedMeasurementId: fields.linkedMeasurementId,
        });
      },
      onCancel: () => {
        /* editing cancelled — the annotation is left unchanged */
      },
    });
  }

  /** Register a callback fired whenever the annotation list or selection changes. */
  setOnChange(cb: () => void): void {
    this._onChange = cb;
  }

  /** Register a callback fired whenever the selection changes. */
  setOnSelect(cb: (id: string | null) => void): void {
    this._onSelect = cb;
  }

  /** A snapshot of all annotations, in list order. */
  getAnnotations(): Annotation[] {
    return this._annotations;
  }

  /** Replace every annotation — used when importing a session. */
  loadAnnotations(list: Annotation[]): void {
    this._annotations = list.slice();
    this._selectedId = null;
    // Importing a session is a fresh document — the undo history starts over.
    this._undoStack = [];
    this._redoStack = [];
    this._sync();
    this._emit();
  }

  /** Whether an undo / redo step is currently available. */
  get canUndo(): boolean {
    return this._undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this._redoStack.length > 0;
  }

  /** Step back to the previous annotation state. */
  undo(): void {
    const prev = this._undoStack.pop();
    if (prev === undefined) return;
    this._redoStack.push(this._annotations.slice());
    this._restore(prev);
  }

  /** Re-apply a state that was just undone. */
  redo(): void {
    const next = this._redoStack.pop();
    if (next === undefined) return;
    this._undoStack.push(this._annotations.slice());
    this._restore(next);
  }

  /** Compact per-annotation summaries for the Annotations panel. */
  getSummaries(): AnnotationSummary[] {
    // Resolve linked-measurement names once per call, not per annotation.
    const names = new Map(this._measurements().map((m) => [m.id, m.name]));
    return this._annotations.map((a, i) => {
      const summary: AnnotationSummary = {
        id: a.id,
        index: i + 1,
        title: a.title,
        type: a.type,
        note: a.note ?? '',
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        selected: a.id === this._selectedId,
      };
      const linked = a.linkedMeasurementId ? names.get(a.linkedMeasurementId) : undefined;
      if (linked !== undefined) summary.linkedMeasurement = linked;
      return summary;
    });
  }

  /** Look up an annotation by id. */
  get(id: string): Annotation | undefined {
    return this._annotations.find((a) => a.id === id);
  }

  /** Create and commit an annotation; it becomes the selection. */
  add(input: NewAnnotation): Annotation {
    this._snapshot();
    const a = createAnnotation(input);
    this._annotations.push(a);
    this._selectedId = a.id;
    this._sync();
    this._emit();
    return a;
  }

  /** Apply an edit to an annotation by id. */
  update(id: string, edit: AnnotationEdit): void {
    const i = this._annotations.findIndex((a) => a.id === id);
    if (i < 0) return;
    this._snapshot();
    this._annotations[i] = editAnnotation(this._annotations[i], edit);
    this._sync();
    this._emit();
  }

  /** Delete an annotation by id. */
  remove(id: string): void {
    const next = this._annotations.filter((a) => a.id !== id);
    if (next.length === this._annotations.length) return;
    this._snapshot();
    this._annotations = next;
    if (this._selectedId === id) this._selectedId = null;
    this._sync();
    this._emit();
  }

  /** Remove every annotation. */
  clear(): void {
    if (this._annotations.length === 0) return;
    this._snapshot();
    this._annotations = [];
    this._selectedId = null;
    this._sync();
    this._emit();
  }

  /** Select an annotation (or pass `null` to clear the selection). */
  select(id: string | null): void {
    if (id !== null && !this.get(id)) return;
    if (id === this._selectedId) return;
    this._selectedId = id;
    this._sync();
    this._onSelect?.(id);
    this._emit();
  }

  /** Set the hovered marker — drives the marker hover style. */
  hover(id: string | null): void {
    this._draw.setHovered(id);
  }

  /** Project markers and redraw. Called once per frame by the Viewer. */
  render(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement): void {
    this._draw.render(camera, canvas);
  }

  /** The marker SVG serialised to a string — used by the screenshot export. */
  markerSVG(): string {
    return this._draw.toSVGString();
  }

  /** Free DOM references. */
  dispose(): void {
    this._editor.close();
    this._editor.element.remove();
    this._hint.remove();
    this._draw.dispose();
  }

  /** Push the current list onto the undo stack; a fresh edit forks history. */
  private _snapshot(): void {
    this._undoStack.push(this._annotations.slice());
    if (this._undoStack.length > UNDO_DEPTH) this._undoStack.shift();
    this._redoStack = [];
  }

  /** Restore an annotation-list snapshot — used by both undo and redo. */
  private _restore(list: Annotation[]): void {
    this._annotations = list;
    // Keep the selection only if its annotation survives in the restored list.
    if (this._selectedId !== null && !this._annotations.some((a) => a.id === this._selectedId)) {
      this._selectedId = null;
    }
    // An in-progress draft is abandoned — its target list has just changed.
    this._editor.close();
    this._sync();
    this._emit();
  }

  private _sync(): void {
    this._draw.sync(this._annotations, this._selectedId);
  }

  private _setHint(text: string): void {
    this._hintText.textContent = text;
  }

  private _emit(): void {
    this._onChange?.();
  }
}
