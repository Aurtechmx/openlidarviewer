/**
 * AnnotationEditor.ts
 *
 * The compact inline editor card for creating or editing an annotation —
 * title, type, an optional note, and the inspection workflow (severity and
 * open/resolved status). It is a transient floating card: it opens at a screen
 * point, and on Save or Cancel it closes cleanly. A cancelled editor never
 * leaves a stale annotation behind — the controller only commits an annotation
 * on the Save callback.
 */

import { el } from './dom';
import type { AnnotationType } from '../render/annotate/types';
import { ANNOTATION_TYPES } from '../render/annotate/types';
import type { MeasurementRef } from '../render/annotate/AnnotationController';
import type { IssueInput, IssueSeverity, IssueStatus } from '../render/annotate/issueWorkflow';
import { ISSUE_SEVERITIES } from '../render/annotate/issueWorkflow';
import { severityText } from './issueSeverityStyle';
import { openConfirm, trapTab } from './Modal';

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
  /**
   * The inspection workflow to attach on save, or `null` to leave the
   * annotation's workflow exactly as it was.
   *
   * There is deliberately no "stop tracking" value. The card can mark an
   * annotation as an issue, change its severity, and resolve or reopen it; what
   * it cannot do is silently drop a block a saved session already carries,
   * because that would demote a recorded finding to an untracked note. An issue
   * raised in error is deleted with its annotation.
   */
  issue: IssueInput | null;
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

/** The two workflow states, with the label each is offered under. */
const STATUS_CHOICES: { status: IssueStatus; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'resolved', label: 'Resolved' },
];

/** Approximate card size — a fallback only, used before the card has ever
 * been laid out. Once open, `_reposition` clamps against the real measured
 * size instead, so a later content-height change (e.g. the status row
 * appearing) never leaves the card hanging off the viewport. */
const CARD_W = 264;
const CARD_H = 420;

/** Heading ids are unique per instance so `aria-labelledby` never collides
 * if more than one editor is ever mounted at once. */
let editorSeq = 0;

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
  private readonly _severityChips = new Map<IssueSeverity, HTMLButtonElement>();
  private readonly _statusChips = new Map<IssueStatus, HTMLButtonElement>();
  private readonly _statusRow: HTMLElement;
  private readonly _issueHint: HTMLElement;
  private _type: AnnotationType = 'note';
  /** The chosen severity, or null while the annotation is not tracked as an issue. */
  private _severity: IssueSeverity | null = null;
  private _status: IssueStatus = 'open';
  /**
   * The observation date the annotation opened with. The card has no control
   * for it, and `attachIssue` REPLACES the whole block, so without carrying it
   * here a date recorded in the field would be erased by an unrelated title
   * edit made back at the office.
   */
  private _observedAt: number | undefined;
  /** Whether the link row is shown for this open() — drives how `_save` reads it. */
  private _linkVisible = false;
  /** The link the editor opened with — preserved when the row is hidden. */
  private _initialLink: string | null = null;
  private _onSave: ((f: AnnotationDraftFields) => void) | null = null;
  private _onCancel: (() => void) | null = null;
  /** Whether the user has typed or clicked anything since `open()`. Reset on
   * every open; a beginEdit/beginDraft reopening a dirty card asks first
   * rather than discarding the work silently. */
  private _dirty = false;
  /** The point the card is anchored near, re-clamped on every reposition so
   * a later size change (severity row appearing, a short viewport) re-fits
   * against the card's real height rather than the CARD_H guess. */
  private _anchorX = 0;
  private _anchorY = 0;
  /** The element to restore focus to on close — the trigger, or whatever was
   * focused when `open()` ran. */
  private _returnFocusTo: HTMLElement | null = null;

  constructor() {
    this._heading = el('span', {
      className: 'olv-anno-editor-heading',
      text: 'New annotation',
    });
    this._heading.id = `olv-anno-editor-heading-${++editorSeq}`;

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
      // WebKit/Safari's default "Full Keyboard Access" leaves plain buttons
      // out of the native Tab order; an explicit tabindex is the standard
      // cross-browser fix and is what lets `trapTab` below actually trap —
      // without it Tab silently skips every chip in Safari and walks
      // straight out of the card.
      chip.tabIndex = 0;
      chip.addEventListener('click', () => {
        chip.blur();
        this._dirty = true;
        this._setType(t);
      });
      this._typeChips.set(t, chip);
      typeRow.append(chip);
    }

    this._note = el('textarea', { className: 'olv-anno-editor-note' });
    this._note.placeholder = 'Note (optional)';
    this._note.rows = 3;
    this._title.addEventListener('input', () => { this._dirty = true; });
    this._note.addEventListener('input', () => { this._dirty = true; });

    // Inspection workflow. Picking a severity is what marks the annotation as a
    // tracked issue, so there is one control for two decisions and no separate
    // "is this an issue" switch to disagree with the severity beside it. The
    // status row only appears once a severity is set: there is nothing to
    // resolve until then.
    const severityRow = el('div', { className: 'olv-anno-editor-sevs' });
    for (const s of ISSUE_SEVERITIES) {
      const chip = el('button', {
        className: `olv-anno-sev olv-anno-sev-${s}`,
        text: severityText(s),
        title: `Track this annotation as a ${s} issue`,
      });
      chip.type = 'button';
      chip.tabIndex = 0; // see the type-chip loop above for why
      chip.addEventListener('click', () => {
        chip.blur();
        this._dirty = true;
        this._setSeverity(s);
      });
      this._severityChips.set(s, chip);
      severityRow.append(chip);
    }

    this._statusRow = el('div', { className: 'olv-anno-editor-status olv-hidden' });
    for (const c of STATUS_CHOICES) {
      const chip = el('button', {
        className: `olv-anno-status olv-anno-status-${c.status}`,
        text: c.label,
        title:
          c.status === 'resolved'
            ? 'Record that this issue was dealt with. The viewer stores the status; it does not check the work.'
            : 'Keep this issue open',
      });
      chip.type = 'button';
      chip.tabIndex = 0; // see the type-chip loop above for why
      chip.addEventListener('click', () => {
        chip.blur();
        this._dirty = true;
        this._setStatus(c.status);
      });
      this._statusChips.set(c.status, chip);
      this._statusRow.append(chip);
    }

    this._issueHint = el('span', {
      className: 'olv-anno-editor-issue-hint',
      text: 'Pick a severity to track this as an inspection issue.',
    });
    const issueSection = el('div', { className: 'olv-anno-editor-issue' }, [
      el('span', { className: 'olv-anno-editor-issue-label', text: 'Inspection' }),
      severityRow,
      this._statusRow,
      this._issueHint,
    ]);

    // "Save current camera view" — captures the viewpoint so "jump to
    // annotation" later restores not just the point but the whole framing.
    // Shown only when creating; an edit never recaptures the camera.
    this._cameraCheck = el('input', { className: 'olv-anno-editor-camera-box' });
    this._cameraCheck.type = 'checkbox';
    this._cameraCheck.checked = true;
    this._cameraCheck.addEventListener('change', () => { this._dirty = true; });
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
    this._linkSelect.addEventListener('change', () => { this._dirty = true; });
    this._linkRow = el('label', { className: 'olv-anno-editor-link' }, [
      el('span', { className: 'olv-anno-editor-link-label', text: 'Linked measurement' }),
      this._linkSelect,
    ]);

    const cancelBtn = el('button', { className: 'olv-anno-editor-cancel', text: 'Cancel' });
    cancelBtn.type = 'button';
    cancelBtn.tabIndex = 0; // see the type-chip loop above for why
    cancelBtn.addEventListener('click', () => {
      cancelBtn.blur();
      this._cancel();
    });

    this._saveBtn = el('button', { className: 'olv-anno-editor-save', text: 'Save' });
    this._saveBtn.type = 'button';
    this._saveBtn.tabIndex = 0; // see the type-chip loop above for why
    this._saveBtn.addEventListener('click', () => {
      this._saveBtn.blur();
      this._save();
    });

    this.element = el('div', { className: 'olv-anno-editor olv-hidden' }, [
      this._heading,
      this._title,
      typeRow,
      this._note,
      issueSection,
      this._linkRow,
      this._cameraRow,
      el('div', { className: 'olv-anno-editor-actions' }, [cancelBtn, this._saveBtn]),
    ]);
    // A hand-rolled dialog: no backdrop (it floats beside the click that
    // opened it) and, unlike every dialog built through Modal.ts's
    // `openModal`, it does not block pointer interaction with the rest of
    // the page. `aria-modal="true"` would tell assistive tech the background
    // is inert when it functionally is not, so this card carries `role` and
    // `aria-labelledby` — the same naming contract every other dialog in this
    // app gives — but deliberately no `aria-modal`; the ARIA default
    // (absent = not modal) is the honest one here. Tab/Escape still route
    // through the same keyboard contract via `trapTab` below.
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-labelledby', this._heading.id);

    // Escape cancels the editor (not the whole tool — the propagation stops
    // here, so Viewer's window-level Escape handler never sees it); Enter in
    // the title field saves; Tab/Shift+Tab stay trapped inside the card via
    // Modal.ts's shared `trapTab`, so a stray Tab off the end can no longer
    // hand Escape to the window listener and exit the whole annotate tool.
    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this._cancel();
        return;
      }
      if (e.key === 'Enter' && e.target === this._title) {
        e.preventDefault();
        this._save();
        return;
      }
      trapTab(this.element, e);
    });

    if (typeof ResizeObserver !== 'undefined') {
      try {
        const ro = new ResizeObserver(() => {
          if (this.isOpen) this._reposition();
        });
        ro.observe(this.element);
      } catch {
        /* Static single clamp on open only — ancient engines. */
      }
    }
  }

  /** Whether the editor is currently open. */
  get isOpen(): boolean {
    return !this.element.classList.contains('olv-hidden');
  }

  /** Open the editor near a screen point, with optional pre-filled values. */
  open(opts: AnnotationEditorOpen): void {
    this._dirty = false;
    // `typeof` (not a bare `instanceof HTMLElement`) because `beginDraft`
    // runs against this class through a DOM-free unit stub with no
    // `HTMLElement` global at all (tests/annotationIssuePanel.test.ts) as
    // well as through a real DOM — this has to be a safe no-op in the former.
    this._returnFocusTo =
      typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this._onSave = opts.onSave;
    this._onCancel = opts.onCancel;
    this._heading.textContent = opts.heading ?? 'New annotation';
    this._title.value = opts.initial?.title ?? '';
    this._note.value = opts.initial?.note ?? '';
    this._saveBtn.textContent = opts.saveLabel ?? 'Save';
    this._setType(opts.initial?.type ?? 'note');

    // The workflow the annotation already carries, or none. A `type: 'issue'`
    // annotation with no block opens untracked, exactly as the model reads it:
    // the category styles the marker, the block is what says it is tracked.
    const issue = opts.initial?.issue ?? null;
    this._observedAt = issue?.observedAt;
    this._setSeverity(issue?.severity ?? null);
    this._setStatus(issue?.status ?? 'open');

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

    // Position is dynamic (anchored to a pointer event), so left/top stay as
    // inline styles. Visibility is driven by .olv-hidden so theming and
    // reduced-motion overrides hit this card the same way they hit everything
    // else (Gestalt similarity across visibility logic).
    this.element.classList.remove('olv-hidden');
    this._anchorX = opts.x;
    this._anchorY = opts.y;
    // Reposition against the card's REAL rendered size (the ResizeObserver
    // above keeps this true as content later grows/shrinks); CARD_W/CARD_H
    // only seed the very first layout if the browser hands back a 0 rect.
    this._reposition();

    this._title.focus();
    this._title.select();
  }

  /**
   * Re-clamp the card inside the current viewport from its real measured
   * size and the point it opened near. Called on open and again whenever the
   * card's content changes its height (severity/status/link rows toggling),
   * so a card that grows after opening near the bottom of a short viewport
   * re-fits instead of running off-screen with no scroll to recover it.
   */
  private _reposition(): void {
    // The unit stub's DOM-free elements don't implement layout geometry at
    // all; fall back to the guessed constants there, exactly as this method
    // behaved before it started measuring the real card.
    const rect =
      typeof this.element.getBoundingClientRect === 'function'
        ? this.element.getBoundingClientRect()
        : null;
    const w = rect?.width || CARD_W;
    const h = rect?.height || CARD_H;
    const left = Math.min(Math.max(8, this._anchorX + 14), window.innerWidth - w - 8);
    const top = Math.min(Math.max(8, this._anchorY - 24), window.innerHeight - h - 8);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  /** Close the editor without firing either callback, restoring focus to
   * whatever triggered it (the panel's Edit button, or nothing for a
   * scene-click draft with no prior focus target). */
  close(): void {
    this.element.classList.add('olv-hidden');
    this._onSave = null;
    this._onCancel = null;
    const restore = this._returnFocusTo;
    this._returnFocusTo = null;
    if (restore && typeof document.contains === 'function' && document.contains(restore)) {
      restore.focus();
    }
  }

  /**
   * The synchronous half of reopening this card for something else — a
   * beginDraft/beginEdit call arriving while it is still open. True (having
   * cancelled the stale card here, so its `onCancel` still runs) means the
   * caller may go ahead and open the new one immediately: either this card
   * was already closed, or it was untouched, and a pristine reopen has
   * nothing to lose. False means it is open AND dirty — the caller must ask
   * through {@link confirmDiscard} instead of opening over real work.
   *
   * Split from the confirm step (rather than one `async` method) so the
   * overwhelmingly common case — no conflicting draft — stays fully
   * synchronous, exactly as `beginDraft`/`beginEdit` always have: a click
   * opens the card on the same tick, with no microtask hop even a single
   * ordinary `beginDraft()` call would otherwise take on.
   */
  reopenIfPossible(): boolean {
    if (!this.isOpen) return true;
    if (!this._dirty) {
      this._cancel();
      return true;
    }
    return false;
  }

  /**
   * Ask, through the same styled confirm every other destructive choice in
   * this app uses, whether to discard the dirty open card. Only meaningful
   * right after {@link reopenIfPossible} returned false. Resolves true (and
   * cancels the card here) on "discard changes"; false (leaving it open,
   * untouched) on "keep editing" or any other dismissal.
   */
  async confirmDiscard(): Promise<boolean> {
    const discard = await openConfirm({
      title: 'Discard unsaved annotation?',
      message:
        'The annotation you were editing has unsaved changes. Opening another one discards them.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
    });
    if (discard) this._cancel();
    return discard;
  }

  private _setType(t: AnnotationType): void {
    this._type = t;
    for (const [k, chip] of this._typeChips) {
      const on = k === t;
      chip.classList.toggle('olv-anno-chip-active', on);
      chip.setAttribute('aria-pressed', String(on));
    }
  }

  /** Choose a severity — or `null`, the untracked state an editor opens in. */
  private _setSeverity(s: IssueSeverity | null): void {
    this._severity = s;
    for (const [k, chip] of this._severityChips) {
      const on = k === s;
      chip.classList.toggle('olv-anno-sev-active', on);
      chip.setAttribute('aria-pressed', String(on));
    }
    // Status and the prompt to start tracking are two views of the same state,
    // so exactly one of them is on screen at a time.
    this._statusRow.classList.toggle('olv-hidden', s === null);
    this._issueHint.classList.toggle('olv-hidden', s !== null);
  }

  private _setStatus(status: IssueStatus): void {
    this._status = status;
    for (const [k, chip] of this._statusChips) {
      const on = k === status;
      chip.classList.toggle('olv-anno-status-active', on);
      chip.setAttribute('aria-pressed', String(on));
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
      issue:
        this._severity === null
          ? null
          : {
              severity: this._severity,
              status: this._status,
              ...(this._observedAt !== undefined ? { observedAt: this._observedAt } : {}),
            },
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
