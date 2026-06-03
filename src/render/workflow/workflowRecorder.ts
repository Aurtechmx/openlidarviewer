/**
 * workflowRecorder.ts
 *
 * Pure data layer for the v0.3.9 workflow recorder (.olvworkflow).
 *
 * Three concerns:
 *
 *   1. The typed event stream.
 *      Every user action surfaced by the command palette is also a
 *      `WorkflowEvent`. The recorder writes; the player reads. The
 *      schema is closed (a discriminated union) so unknown events
 *      can never sneak in via a hand-edited file.
 *
 *   2. The file format.
 *      `.olvworkflow` is a JSON file with a stable shape:
 *      `{ kind: 'olvworkflow', version, recordedAt, events: [...] }`.
 *      `serializeWorkflow` writes a deterministic JSON blob;
 *      `parseWorkflow` validates the shape on read and returns a
 *      tagged result (`ok` / `error`) so the caller can show the
 *      user a sensible error rather than blow up the page.
 *
 *   3. The replay scheduler.
 *      Pure: given a workflow + a "now" clock + a `runEvent` callback,
 *      schedule each event at its declared offset and return a
 *      `cancel()` handle. The host (WorkflowController) supplies
 *      `setTimeout`/`clearTimeout` and the dispatcher; this module
 *      owns no timers.
 *
 * The module owns NO DOM and NO three.js. It is the canonical place
 * to evolve the workflow schema without touching the UI.
 */

// ── event types ─────────────────────────────────────────────────────

/** v0.3.9 captures camera presets, themes, and tool toggles. */
export type WorkflowEvent =
  | { readonly type: 'camera-preset'; readonly name: string; readonly tMs: number }
  | { readonly type: 'frame-all'; readonly tMs: number }
  | { readonly type: 'theme'; readonly name: string; readonly tMs: number }
  | { readonly type: 'tool'; readonly tool: string; readonly on: boolean; readonly tMs: number };

/**
 * A user-side event in flight — same shape as `WorkflowEvent` but
 * without the `tMs` (which the session stamps at push time). Defined
 * as a distributive Omit so the discriminated union is preserved.
 */
export type WorkflowEventDraft = WorkflowEvent extends infer T
  ? T extends WorkflowEvent
    ? Omit<T, 'tMs'>
    : never
  : never;

/** A complete recording. */
export interface Workflow {
  /** Always 'olvworkflow' on a valid file. */
  readonly kind: 'olvworkflow';
  /** Schema version. v0.3.9 ships v1. */
  readonly version: 1;
  /** ISO-8601 wall-clock timestamp when the recording started. */
  readonly recordedAt: string;
  /**
   * Optional free-text label the user typed when saving. The
   * UI surfaces this when listing saved workflows.
   */
  readonly title?: string;
  /**
   * Events in capture order. The first event's `tMs` is always 0;
   * subsequent events carry the delta from recording start.
   */
  readonly events: readonly WorkflowEvent[];
}

/** Build a Workflow object from a recording session. */
export function buildWorkflow(
  events: readonly WorkflowEvent[],
  opts: { readonly recordedAt?: string; readonly title?: string } = {},
): Workflow {
  const recordedAt = opts.recordedAt ?? new Date().toISOString();
  // Normalise to a frozen array + a plain object so accidental
  // mutation can't corrupt a saved-but-not-yet-serialised workflow.
  const normalised = events.map((e) => ({ ...e }) as WorkflowEvent);
  return Object.freeze({
    kind: 'olvworkflow' as const,
    version: 1 as const,
    recordedAt,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    events: Object.freeze(normalised),
  });
}

// ── recorder state machine ─────────────────────────────────────────

/**
 * A live recording session — owns the started-at clock and the
 * accumulated events. Pure: holds no timers, no DOM, no callbacks.
 */
export class WorkflowSession {
  private readonly _events: WorkflowEvent[] = [];
  private readonly _startedAt: number;
  private readonly _now: () => number;

  /** `nowFn` defaults to `performance.now()` when available. */
  constructor(nowFn?: () => number) {
    this._now =
      nowFn ??
      (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
    this._startedAt = this._now();
  }

  /** Append an event at the current offset. */
  push(event: WorkflowEventDraft): void {
    const tMs = Math.max(0, Math.round(this._now() - this._startedAt));
    this._events.push({ ...event, tMs } as WorkflowEvent);
  }

  /** Read the current event list (a defensive copy). */
  events(): WorkflowEvent[] {
    return this._events.map((e) => ({ ...e }) as WorkflowEvent);
  }

  /** True once at least one event has been pushed. */
  get hasContent(): boolean {
    return this._events.length > 0;
  }
}

// ── file format ────────────────────────────────────────────────────

/** Result of parsing a workflow file. */
export type ParseResult =
  | { readonly ok: true; readonly workflow: Workflow }
  | { readonly ok: false; readonly error: string };

/** Serialise a workflow to deterministic JSON (stable key order). */
export function serializeWorkflow(workflow: Workflow): string {
  // Build a plain object in a fixed key order so the output is
  // byte-stable for snapshot tests and content-hashing.
  const out: Record<string, unknown> = {
    kind: workflow.kind,
    version: workflow.version,
    recordedAt: workflow.recordedAt,
  };
  if (workflow.title !== undefined) out.title = workflow.title;
  out.events = workflow.events.map((e) => ({ ...e }));
  return JSON.stringify(out, null, 2);
}

/**
 * Parse a workflow string. Validates kind + version + every event's
 * type. Never throws — returns `{ ok: false, error }` on any failure.
 */
export function parseWorkflow(input: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch (err) {
    return {
      ok: false,
      error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Workflow file must be a JSON object.' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== 'olvworkflow') {
    return {
      ok: false,
      error: `Expected kind="olvworkflow"; got ${JSON.stringify(obj.kind)}.`,
    };
  }
  if (obj.version !== 1) {
    return {
      ok: false,
      error: `Unsupported workflow version ${JSON.stringify(obj.version)}; this build reads v1.`,
    };
  }
  if (typeof obj.recordedAt !== 'string') {
    return { ok: false, error: 'Missing recordedAt timestamp.' };
  }
  if (obj.title !== undefined && typeof obj.title !== 'string') {
    return { ok: false, error: 'title must be a string when present.' };
  }
  if (!Array.isArray(obj.events)) {
    return { ok: false, error: 'events must be an array.' };
  }
  const events: WorkflowEvent[] = [];
  for (let i = 0; i < obj.events.length; i++) {
    const ev = obj.events[i];
    const parsed = parseEvent(ev, i);
    if (!parsed.ok) return parsed;
    events.push(parsed.event);
  }
  const workflow: Workflow = Object.freeze({
    kind: 'olvworkflow',
    version: 1,
    recordedAt: obj.recordedAt,
    ...(typeof obj.title === 'string' ? { title: obj.title } : {}),
    events: Object.freeze(events),
  });
  return { ok: true, workflow };
}

function parseEvent(
  raw: unknown,
  i: number,
): { ok: true; event: WorkflowEvent } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `events[${i}] is not an object.` };
  }
  const e = raw as Record<string, unknown>;
  const tMs = typeof e.tMs === 'number' && e.tMs >= 0 ? e.tMs : null;
  if (tMs === null) {
    return { ok: false, error: `events[${i}].tMs must be a non-negative number.` };
  }
  switch (e.type) {
    case 'camera-preset':
      if (typeof e.name !== 'string') {
        return { ok: false, error: `events[${i}].name must be a string.` };
      }
      return { ok: true, event: { type: 'camera-preset', name: e.name, tMs } };
    case 'frame-all':
      return { ok: true, event: { type: 'frame-all', tMs } };
    case 'theme':
      if (typeof e.name !== 'string') {
        return { ok: false, error: `events[${i}].name must be a string.` };
      }
      return { ok: true, event: { type: 'theme', name: e.name, tMs } };
    case 'tool':
      if (typeof e.tool !== 'string') {
        return { ok: false, error: `events[${i}].tool must be a string.` };
      }
      if (typeof e.on !== 'boolean') {
        return { ok: false, error: `events[${i}].on must be a boolean.` };
      }
      return {
        ok: true,
        event: { type: 'tool', tool: e.tool, on: e.on, tMs },
      };
    default:
      return {
        ok: false,
        error: `events[${i}] has unknown type ${JSON.stringify(e.type)}.`,
      };
  }
}

// ── replay scheduler ───────────────────────────────────────────────

/** Cancel a scheduled replay. Idempotent. */
export interface ReplayHandle {
  cancel(): void;
}

/** Host-provided timer hooks so the scheduler stays testable. */
export interface ReplayDeps {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Fires after every event is scheduled (not after each fires). */
  onComplete?(): void;
}

/**
 * Schedule a workflow's events for replay. Each event's `tMs` is
 * interpreted as an offset from "now"; the dispatcher is called when
 * each event fires. Cancellation stops every still-pending fire.
 *
 * Pure: this function does not own `setTimeout`. The host injects it
 * via `deps`, which makes the scheduler unit-testable against a fake
 * clock.
 */
export function scheduleReplay(
  workflow: Workflow,
  dispatch: (event: WorkflowEvent) => void,
  deps: ReplayDeps,
): ReplayHandle {
  const handles: unknown[] = [];
  let cancelled = false;
  let remaining = workflow.events.length;
  if (remaining === 0) {
    deps.onComplete?.();
    return { cancel: () => void 0 };
  }
  for (const event of workflow.events) {
    const h = deps.setTimeout(() => {
      if (cancelled) return;
      try {
        dispatch(event);
      } finally {
        remaining -= 1;
        if (remaining === 0) deps.onComplete?.();
      }
    }, event.tMs);
    handles.push(h);
  }
  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      for (const h of handles) deps.clearTimeout(h);
      handles.length = 0;
    },
  };
}
