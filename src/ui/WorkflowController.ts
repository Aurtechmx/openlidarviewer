import { el } from './dom';
import {
  buildWorkflow,
  parseWorkflow,
  scheduleReplay,
  serializeWorkflow,
  WorkflowSession,
  type ReplayHandle,
  type Workflow,
  type WorkflowEvent,
  type WorkflowEventDraft,
} from '../render/workflow/workflowRecorder';

/**
 * WHY this flag exists (product call, v0.4.5): the workflow recorder ships
 * DISABLED this release rather than rebound. The Cmd/Ctrl+Shift+R → U rebind
 * fixed the hard-refresh collision, but shipping a chord swap mid-cycle risks
 * exactly the shortcut-collision confusion it was meant to cure, and the
 * "Replay a workflow file…" UX (recipient must already have the same scan
 * open) needs a design pass before we stand behind it. The module and its
 * pure-logic unit tests stay in the tree; flipping this to `true` restores
 * the Cmd/Ctrl+Shift+U shortcut, the three palette/shortcut-sheet actions,
 * and the on-screen badge in one place. Keep the mirror constant in
 * tests/e2e/workflowRecorder.spec.ts in sync when flipping.
 */
export const WORKFLOW_RECORDER_ENABLED: boolean = false;

/**
 * WorkflowController.ts
 *
 * The host-side glue for the v0.3.9 workflow recorder. Owns:
 *
 *   - the live `WorkflowSession` while a recording is in progress
 *   - the current `ReplayHandle` while a workflow is playing back
 *   - the on-screen status badge ("● Recording…" / "▶ Playing 2/8")
 *   - the file I/O surface (download as .olvworkflow, load from a
 *     `File` blob the user dropped or picked)
 *
 * It does NOT own:
 *   - the actual action handlers (the host injects them via
 *     `dispatcher` in `replay`)
 *   - the keystroke binding (main.ts binds Cmd-Shift-U once)
 *   - the action registry itself (the command palette holds it)
 *
 * State machine:
 *
 *     idle ──(startRecording)──> recording
 *     recording ──(stopRecording)──> idle, returns Workflow
 *     idle ──(replay)──> playing
 *     playing ──(onComplete | stopReplay)──> idle
 *
 * The badge updates on every state change so the user always knows
 * which mode the viewer is in.
 */

/** Snapshot of the controller's state for the host. */
export type WorkflowControllerState = 'idle' | 'recording' | 'playing';

/** A dispatcher the host wires to its action handlers for replay. */
export type WorkflowDispatcher = (event: WorkflowEvent) => void;

export class WorkflowController {
  /** Mount this badge into the stage overlay. */
  readonly badge: HTMLElement;

  private _state: WorkflowControllerState = 'idle';
  private _session: WorkflowSession | null = null;
  private _replay: ReplayHandle | null = null;

  private readonly _badgeLabel: HTMLElement;
  private readonly _badgeStop: HTMLButtonElement;
  private _onStateChange: ((state: WorkflowControllerState) => void) | null = null;

  constructor() {
    this._badgeLabel = el('span', { className: 'olv-workflow-badge-label' });
    this._badgeStop = el('button', {
      className: 'olv-workflow-badge-stop',
      text: 'Stop',
      title: 'Stop the recording or playback (Esc also works while idle).',
    });
    this._badgeStop.addEventListener('click', () => {
      this._badgeStop.blur();
      if (this._state === 'recording') this.stopRecording();
      else if (this._state === 'playing') this.stopReplay();
    });
    this.badge = el('div', { className: 'olv-workflow-badge olv-hidden' }, [
      el('span', { className: 'olv-workflow-badge-dot' }),
      this._badgeLabel,
      this._badgeStop,
    ]);
  }

  /** Current state — useful for the host's keyboard handler. */
  get state(): WorkflowControllerState {
    return this._state;
  }

  /** Subscribe to state changes (toast, command palette label refresh). */
  setOnStateChange(cb: (state: WorkflowControllerState) => void): void {
    this._onStateChange = cb;
  }

  // ── recording ────────────────────────────────────────────────────

  /** Begin a fresh recording session. No-op if already recording / playing. */
  startRecording(): void {
    if (this._state !== 'idle') return;
    this._session = new WorkflowSession();
    this._state = 'recording';
    this._refreshBadge('● Recording…');
    this._onStateChange?.(this._state);
  }

  /**
   * Capture an event into the live recording. No-op when no session
   * is active — so the host can call this unconditionally from every
   * action handler without branching.
   */
  capture(event: WorkflowEventDraft): void {
    if (this._state !== 'recording' || !this._session) return;
    this._session.push(event);
  }

  /**
   * Stop the recording. Returns the finished workflow, or null if
   * nothing was captured (empty recordings are dropped silently).
   */
  stopRecording(): Workflow | null {
    if (this._state !== 'recording' || !this._session) return null;
    const events = this._session.events();
    this._session = null;
    this._state = 'idle';
    this._refreshBadge('');
    this._onStateChange?.(this._state);
    if (events.length === 0) return null;
    return buildWorkflow(events);
  }

  // ── replay ───────────────────────────────────────────────────────

  /**
   * Begin replaying a workflow. The host supplies `dispatch`, which
   * routes each event back to the actual handler (camera preset,
   * theme, tool toggle, frame all). No-op if already busy.
   */
  replay(workflow: Workflow, dispatch: WorkflowDispatcher): void {
    if (this._state !== 'idle') return;
    this._state = 'playing';
    this._refreshBadge(`▶ Playing 0/${workflow.events.length}`);
    this._onStateChange?.(this._state);
    let fired = 0;
    this._replay = scheduleReplay(
      workflow,
      (event) => {
        fired += 1;
        this._refreshBadge(`▶ Playing ${fired}/${workflow.events.length}`);
        dispatch(event);
      },
      {
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (h) => window.clearTimeout(h as number),
        onComplete: () => this._onReplayComplete(),
      },
    );
  }

  /** Cancel a running replay. No-op when nothing is playing. */
  stopReplay(): void {
    if (this._state !== 'playing' || !this._replay) return;
    this._replay.cancel();
    this._replay = null;
    this._state = 'idle';
    this._refreshBadge('');
    this._onStateChange?.(this._state);
  }

  private _onReplayComplete(): void {
    this._replay = null;
    this._state = 'idle';
    this._refreshBadge('');
    this._onStateChange?.(this._state);
  }

  // ── file I/O ─────────────────────────────────────────────────────

  /** Trigger a browser download of a workflow as `.olvworkflow`. */
  download(workflow: Workflow, filename?: string): void {
    const json = serializeWorkflow(workflow);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const fname =
      filename ??
      `openlidar-${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19)}.olvworkflow`;
    const a = el('a', { className: 'olv-hidden', href: url });
    a.setAttribute('download', fname);
    document.body.append(a);
    a.click();
    a.remove();
    // Defer revoke so the click has a tick to start the download.
    queueMicrotask(() => URL.revokeObjectURL(url));
  }

  /**
   * Read a `File` blob (from a file picker or drop) and return its
   * parsed Workflow. Rejects with a clear error on malformed input.
   */
  async loadFromFile(file: File): Promise<Workflow> {
    const text = await file.text();
    const result = parseWorkflow(text);
    if (!result.ok) throw new Error(result.error);
    return result.workflow;
  }

  // ── badge ────────────────────────────────────────────────────────

  private _refreshBadge(label: string): void {
    this._badgeLabel.textContent = label;
    this.badge.classList.toggle('olv-hidden', label === '');
    this.badge.classList.toggle('olv-workflow-badge-recording', this._state === 'recording');
    this.badge.classList.toggle('olv-workflow-badge-playing', this._state === 'playing');
  }
}
