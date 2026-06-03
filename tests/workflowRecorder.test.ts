/**
 * workflowRecorder.test.ts
 *
 * Contract tests for the v0.3.9 workflow recorder pure-data module.
 * Covers: session capture, workflow construction, JSON serialise +
 * parse round-trip, malformed-file resilience, and the replay
 * scheduler against a fake clock.
 */

import { describe, it, expect } from 'vitest';
import {
  buildWorkflow,
  parseWorkflow,
  scheduleReplay,
  serializeWorkflow,
  WorkflowSession,
  type ReplayDeps,
  type Workflow,
  type WorkflowEvent,
} from '../src/render/workflow/workflowRecorder';

// ── WorkflowSession ─────────────────────────────────────────────────

describe('WorkflowSession — live capture', () => {
  it('starts empty', () => {
    const s = new WorkflowSession(() => 0);
    expect(s.events()).toEqual([]);
    expect(s.hasContent).toBe(false);
  });

  it('records the first event at tMs 0', () => {
    let t = 1000;
    const s = new WorkflowSession(() => t);
    s.push({ type: 'frame-all' });
    const events = s.events();
    expect(events.length).toBe(1);
    expect(events[0].tMs).toBe(0);
    expect(s.hasContent).toBe(true);
  });

  it('records subsequent events at their delta from session start', () => {
    let t = 1000;
    const s = new WorkflowSession(() => t);
    s.push({ type: 'theme', name: 'light' });
    t = 1500;
    s.push({ type: 'camera-preset', name: 'top' });
    t = 4250;
    s.push({ type: 'tool', tool: 'measure', on: true });
    const events = s.events();
    expect(events[0].tMs).toBe(0);
    expect(events[1].tMs).toBe(500);
    expect(events[2].tMs).toBe(3250);
  });

  it('returns a defensive copy of the event list', () => {
    let t = 0;
    const s = new WorkflowSession(() => t);
    s.push({ type: 'frame-all' });
    const a = s.events();
    a.push({ type: 'frame-all', tMs: 999 });
    expect(s.events().length).toBe(1); // mutation didn't leak back
  });
});

// ── buildWorkflow ───────────────────────────────────────────────────

describe('buildWorkflow — Workflow construction', () => {
  it('stamps a deterministic recordedAt when one is provided', () => {
    const w = buildWorkflow([], { recordedAt: '2026-06-01T00:00:00.000Z' });
    expect(w.recordedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('uses the current ISO timestamp when no recordedAt is provided', () => {
    const w = buildWorkflow([]);
    // ISO 8601 — Z-suffixed UTC.
    expect(w.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it('freezes the event list against external mutation', () => {
    const events: WorkflowEvent[] = [{ type: 'frame-all', tMs: 0 }];
    const w = buildWorkflow(events);
    // The returned workflow's events are frozen.
    expect(Object.isFrozen(w.events)).toBe(true);
    // Mutating the input array does not leak into the workflow.
    events.push({ type: 'frame-all', tMs: 100 });
    expect(w.events.length).toBe(1);
  });

  it('omits title when not provided', () => {
    const w = buildWorkflow([]);
    expect(w.title).toBeUndefined();
  });

  it('keeps a user-supplied title', () => {
    const w = buildWorkflow([], { title: 'Quick demo' });
    expect(w.title).toBe('Quick demo');
  });
});

// ── serializeWorkflow + parseWorkflow ──────────────────────────────

describe('serializeWorkflow — deterministic JSON', () => {
  it('emits valid JSON with stable key order', () => {
    const w = buildWorkflow([{ type: 'frame-all', tMs: 0 }], {
      recordedAt: '2026-06-01T00:00:00.000Z',
    });
    const out = serializeWorkflow(w);
    const parsed = JSON.parse(out);
    expect(parsed.kind).toBe('olvworkflow');
    expect(parsed.version).toBe(1);
    expect(parsed.recordedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(parsed.events).toEqual([{ type: 'frame-all', tMs: 0 }]);
  });

  it('only includes title when set', () => {
    const without = serializeWorkflow(
      buildWorkflow([], { recordedAt: '2026-06-01T00:00:00.000Z' }),
    );
    const withTitle = serializeWorkflow(
      buildWorkflow([], {
        recordedAt: '2026-06-01T00:00:00.000Z',
        title: 'X',
      }),
    );
    expect(JSON.parse(without).title).toBeUndefined();
    expect(JSON.parse(withTitle).title).toBe('X');
  });
});

describe('parseWorkflow — file shape validation', () => {
  it('round-trips a basic workflow', () => {
    const w = buildWorkflow(
      [
        { type: 'camera-preset', name: 'top', tMs: 0 },
        { type: 'theme', name: 'light', tMs: 1500 },
        { type: 'tool', tool: 'measure', on: true, tMs: 3000 },
        { type: 'frame-all', tMs: 4200 },
      ],
      { recordedAt: '2026-06-01T00:00:00.000Z' },
    );
    const json = serializeWorkflow(w);
    const result = parseWorkflow(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workflow.events.length).toBe(4);
      expect(result.workflow.events[0]).toEqual({
        type: 'camera-preset',
        name: 'top',
        tMs: 0,
      });
    }
  });

  it('rejects non-JSON input', () => {
    const r = parseWorkflow('not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Not valid JSON/i);
  });

  it('rejects the wrong kind', () => {
    const r = parseWorkflow(JSON.stringify({ kind: 'olvsession', version: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/kind="olvworkflow"/i);
  });

  it('rejects an unsupported version', () => {
    const r = parseWorkflow(
      JSON.stringify({ kind: 'olvworkflow', version: 99 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version/);
  });

  it('rejects missing recordedAt', () => {
    const r = parseWorkflow(
      JSON.stringify({ kind: 'olvworkflow', version: 1, events: [] }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects malformed events', () => {
    const r = parseWorkflow(
      JSON.stringify({
        kind: 'olvworkflow',
        version: 1,
        recordedAt: '2026-06-01T00:00:00.000Z',
        events: [{ type: 'camera-preset' /* missing name + tMs */ }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects events with a negative tMs', () => {
    const r = parseWorkflow(
      JSON.stringify({
        kind: 'olvworkflow',
        version: 1,
        recordedAt: '2026-06-01T00:00:00.000Z',
        events: [{ type: 'frame-all', tMs: -10 }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown event type', () => {
    const r = parseWorkflow(
      JSON.stringify({
        kind: 'olvworkflow',
        version: 1,
        recordedAt: '2026-06-01T00:00:00.000Z',
        events: [{ type: 'evil-eval', tMs: 0 }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown type/);
  });
});

// ── scheduleReplay against a fake clock ────────────────────────────

interface FakeTimer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

function makeFakeDeps(): {
  deps: ReplayDeps;
  timers: FakeTimer[];
  completedCount: () => number;
} {
  const timers: FakeTimer[] = [];
  let completed = 0;
  const deps: ReplayDeps = {
    setTimeout(fn, ms) {
      const t: FakeTimer = { ms, fn, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimeout(handle) {
      (handle as FakeTimer).cancelled = true;
    },
    onComplete() {
      completed += 1;
    },
  };
  return { deps, timers, completedCount: () => completed };
}

describe('scheduleReplay — fake-clock scheduler', () => {
  function exampleWorkflow(): Workflow {
    return buildWorkflow(
      [
        { type: 'camera-preset', name: 'top', tMs: 0 },
        { type: 'theme', name: 'light', tMs: 1500 },
        { type: 'frame-all', tMs: 3000 },
      ],
      { recordedAt: '2026-06-01T00:00:00.000Z' },
    );
  }

  it('schedules one timer per event at the declared offset', () => {
    const { deps, timers } = makeFakeDeps();
    scheduleReplay(exampleWorkflow(), () => void 0, deps);
    expect(timers.length).toBe(3);
    expect(timers.map((t) => t.ms)).toEqual([0, 1500, 3000]);
  });

  it('dispatches events in order when timers fire', () => {
    const dispatched: WorkflowEvent[] = [];
    const { deps, timers } = makeFakeDeps();
    scheduleReplay(exampleWorkflow(), (e) => dispatched.push(e), deps);
    // Simulate the fake clock — fire each timer in scheduled order.
    for (const t of timers) {
      if (!t.cancelled) t.fn();
    }
    expect(dispatched.length).toBe(3);
    expect(dispatched[0].type).toBe('camera-preset');
    expect(dispatched[1].type).toBe('theme');
    expect(dispatched[2].type).toBe('frame-all');
  });

  it('fires onComplete after the last event dispatches', () => {
    const { deps, timers, completedCount } = makeFakeDeps();
    scheduleReplay(exampleWorkflow(), () => void 0, deps);
    expect(completedCount()).toBe(0);
    for (const t of timers) t.fn();
    expect(completedCount()).toBe(1);
  });

  it('cancel() stops every still-pending timer', () => {
    const { deps, timers } = makeFakeDeps();
    const handle = scheduleReplay(exampleWorkflow(), () => void 0, deps);
    handle.cancel();
    expect(timers.every((t) => t.cancelled)).toBe(true);
  });

  it('does not dispatch after cancel even if a timer fires', () => {
    const dispatched: WorkflowEvent[] = [];
    const { deps, timers } = makeFakeDeps();
    const handle = scheduleReplay(
      exampleWorkflow(),
      (e) => dispatched.push(e),
      deps,
    );
    handle.cancel();
    // A delayed call (e.g. fake timer flushed after cancel) is a no-op.
    for (const t of timers) t.fn();
    expect(dispatched.length).toBe(0);
  });

  it('an empty workflow fires onComplete immediately', () => {
    const empty = buildWorkflow([], {
      recordedAt: '2026-06-01T00:00:00.000Z',
    });
    const { deps, completedCount } = makeFakeDeps();
    scheduleReplay(empty, () => void 0, deps);
    expect(completedCount()).toBe(1);
  });
});
