/**
 * streamingSettleCommit.test.ts — the "pill stayed on Auto" screenshot bug.
 *
 * User evidence (v0.4.5, streamed COPC interior): the panel reads "Streaming
 * ready", the Treat-as control shows Terrain disabled with the interior
 * reason — i.e. the settled verdict IS interior — yet the SELECTED segment is
 * still Auto. The settled soft-commit never landed.
 *
 * Root cause: the "Streaming ready" poll fired the settle one-shot on the
 * FIRST scheduler-idle frame and spent it unconditionally. The scheduler
 * often reads idle at the root level (depth 0) long before the cloud fills
 * in, so the one-shot ran on a sparse frame whose verdict was terrain
 * (planner refuses a mid-session terrain flip — no apply, no commit) or
 * undecidable (gather empty — no commit possible). Spent without committing,
 * the GENUINE settle later could never move the pill off Auto.
 *
 * Covered here:
 *   - the screenshot sequence end-to-end against the REAL planner + REAL
 *     "Treat as" control (stream → early interior verdict → routes to the
 *     Object panel → settle fires with the same verdict → the Interior pill
 *     COMMITS: aria-pressed moves off Auto onto Interior);
 *   - the regression sequence: a premature root-only idle must not spend the
 *     one-shot (depth gate), and an undecidable settled frame must leave it
 *     armed (spend-on-verdict) — both then commit on the real settle;
 *   - the pure helpers behind the two guards (`settleTargetDepth`,
 *     `settleOneShotSpent`).
 *
 * Node environment — the control runs against the same minimal DOM stub used
 * by tests/scanTypeControl.test.ts (stub-the-slice).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  planScanRoute,
  settleOneShotSpent,
  settleTargetDepth,
  SETTLE_RETRY_CAP,
  type ScanTypeOverride,
} from '../src/terrain/scanRoute';
import type { SpaceKind } from '../src/terrain/scanShape';
import type { ScanTypeControl, ScanTypeDisabledReasons } from '../src/ui/scanTypeControl';

type Handler = () => void;

/** A tiny fake element supporting only the surface the control touches. */
class FakeEl {
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly dataset: Record<string, string> = {};
  private readonly _attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  private readonly _classes = new Set<string>();
  private readonly _handlers = new Map<string, Handler[]>();
  readonly tagName: string;
  readonly classList = {
    toggle: (cls: string, force?: boolean): void => {
      const on = force === undefined ? !this._classes.has(cls) : force;
      if (on) this._classes.add(cls); else this._classes.delete(cls);
    },
    contains: (cls: string): boolean => this._classes.has(cls),
  };
  constructor(tagName: string) { this.tagName = tagName; }
  set className(v: string) {
    this._classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this._classes.add(c);
  }
  get className(): string { return [...this._classes].join(' '); }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  setAttribute(k: string, v: string): void { this._attrs.set(k, v); }
  getAttribute(k: string): string | null { return this._attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this._attrs.delete(k); }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  addEventListener(type: string, fn: Handler): void {
    const list = this._handlers.get(type) ?? [];
    list.push(fn); this._handlers.set(type, list);
  }
  find(cls: string): FakeEl | null {
    if (this.classList.contains(cls)) return this;
    for (const c of this.children) { const hit = c.find(cls); if (hit) return hit; }
    return null;
  }
  findAll(cls: string, acc: FakeEl[] = []): FakeEl[] {
    if (this.classList.contains(cls)) acc.push(this);
    for (const c of this.children) c.findAll(cls, acc);
    return acc;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

/** Segment lookup by data-value on the real control's root. */
function seg(root: FakeEl, value: ScanTypeOverride): FakeEl {
  const hit = root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === value);
  if (!hit) throw new Error(`segment ${value} not rendered`);
  return hit;
}

/**
 * A miniature of the `src/main.ts` host: the exact `applyScanRoute` wiring —
 * planner call, commit application, `setScanType` mirroring, spend decision —
 * plus the "Streaming ready" poll's depth-gated one-shot. The planner, the
 * spend rule, the depth gate, and the control are the REAL modules; only the
 * geometry gather is replaced by the verdict the classifier would return.
 */
function makeHost(control: ScanTypeControl) {
  const state = {
    override: 'auto' as ScanTypeOverride,
    pinned: false,
    lastVerdict: null as SpaceKind | null,
    committed: false,
    settledRouted: false,
    objectPanelVisible: false,
    // Settled-evaluation bookkeeping (the v0.4.5b re-arming one-shot):
    // attempt counter for SETTLE_RETRY_CAP, last-evaluated resident count
    // (re-attempts only on geometry change), last frame undecidable (a failed
    // gather may retry at once).
    attempts: 0,
    lastResident: -1,
    lastUndecided: false,
  };
  // main.ts `treatAsDisabledFor`: detection ruling the scan non-terrain
  // disables the Terrain segment with the honest reason.
  const disabledFor = (detected: SpaceKind | null): ScanTypeDisabledReasons | undefined =>
    detected !== null && detected !== 'terrain'
      ? { terrain: 'This scan reads as an interior — terrain analysis would be misleading.' }
      : undefined;
  /** main.ts `applyScanRoute`, condensed to the routing/commit/display core. */
  function route(
    detected: SpaceKind | null,
    opts: { initial?: boolean; settled?: boolean } = {},
  ): boolean {
    const initial = opts.initial === true;
    const settled = opts.settled === true;
    if (!initial && (state.pinned || state.override !== 'auto')) return true;
    const plan = planScanRoute({
      detected,
      override: state.override,
      initial,
      lastVerdict: state.lastVerdict,
      pinned: state.pinned,
      settled,
    });
    if (plan.commitDetected !== null) state.committed = true;
    if (settled) state.lastUndecided = detected === null;
    const spent = settleOneShotSpent({
      detected,
      override: state.override,
      pinned: state.pinned,
      applied: plan.apply,
      committed: plan.commitDetected !== null,
      attempts: state.attempts,
    });
    if (!plan.apply) {
      if (plan.commitDetected !== null) {
        control.set(state.override, plan.commitDetected, disabledFor(detected), true);
      }
      return spent;
    }
    state.lastVerdict = plan.effective;
    state.objectPanelVisible = plan.showObjectPanel;
    control.set(
      state.override,
      plan.effective,
      disabledFor(detected),
      state.override === 'auto' && state.committed,
    );
    return spent;
  }
  /** The "Streaming ready" poll's one-shot: depth gate + change-gated retry. */
  function readyPoll(
    cloud: { hierarchyMaxDepth: number; deepestResident: number; residentPoints?: number },
    detected: SpaceKind | null,
  ): void {
    if (state.settledRouted) return;
    if (cloud.deepestResident < settleTargetDepth(cloud.hierarchyMaxDepth)) return;
    // Re-attempt only when the resident geometry CHANGED (an identical frame
    // re-reads to the identical verdict) — except after an undecidable frame,
    // whose gather failure is not a property of the geometry.
    const resident = cloud.residentPoints ?? 0;
    if (state.attempts > 0 && resident === state.lastResident && !state.lastUndecided) return;
    state.attempts++;
    state.lastResident = resident;
    state.settledRouted = route(detected, { settled: true });
  }
  return { state, route, readyPoll };
}

async function build() {
  const { createScanTypeControl } = await import('../src/ui/scanTypeControl');
  const control = createScanTypeControl({ onChange: () => { /* host-owned */ } });
  return { control, root: control.element as unknown as FakeEl, host: makeHost(control) };
}

describe('streaming settle soft-commit (screenshot regression)', () => {
  it('stream → early interior verdict → settle (same verdict) ⇒ the Interior pill COMMITS', async () => {
    const { root, host } = await build();
    // Open-time call: nothing resident yet, verdict undecidable.
    host.route(null, { initial: true });
    expect(seg(root, 'auto').getAttribute('aria-pressed')).toBe('true');
    // Early mid-stream re-evaluation reads INTERIOR → routes to the Object
    // panel; verdict is provisional, so Auto stays selected and only SURFACES
    // the detection ("Auto (Interior)" + detected dot on the Interior pill).
    host.route('interior');
    expect(host.state.objectPanelVisible).toBe(true);
    expect(seg(root, 'auto').getAttribute('aria-pressed')).toBe('true');
    expect(seg(root, 'auto').textContent).toBe('Auto (Interior)');
    expect(seg(root, 'interior').classList.contains('is-detected')).toBe(true);
    expect(seg(root, 'interior').getAttribute('aria-pressed')).toBe('false');
    expect(seg(root, 'terrain').disabled).toBe(true); // interior reason stands
    // The genuine settle confirms the SAME verdict — a routing no-op, but the
    // pill must commit: aria-pressed moves off Auto onto Interior, the
    // detected dot stays (detection-sourced, not manual), Auto goes plain.
    const spent = host.route('interior', { settled: true });
    expect(spent).toBe(true);
    expect(seg(root, 'interior').getAttribute('aria-pressed')).toBe('true');
    expect(seg(root, 'interior').classList.contains('is-detected')).toBe(true);
    expect(seg(root, 'auto').getAttribute('aria-pressed')).toBe('false');
    expect(seg(root, 'auto').textContent).toBe('Auto');
    expect(root.find('olv-scan-type-note')?.classList.contains('olv-hidden')).toBe(true);
  });

  it('a premature root-only idle does NOT spend the one-shot — the real settle still commits', async () => {
    const { root, host } = await build();
    host.route(null, { initial: true });
    // The scheduler reads idle while only the ROOT is resident (the exact
    // reality the benchmark's coarse-stable guard documents). The depth gate
    // must skip the attempt entirely: had it run, the sparse frame's terrain
    // verdict would have been refused without a commit — one-shot wasted.
    host.readyPoll({ hierarchyMaxDepth: 6, deepestResident: 0 }, 'terrain');
    expect(host.state.settledRouted).toBe(false);
    // Geometry fills in; the growth-gated re-route reads INTERIOR.
    host.route('interior');
    expect(seg(root, 'auto').getAttribute('aria-pressed')).toBe('true');
    // The stream genuinely settles (deep residency) on the same verdict.
    host.readyPoll({ hierarchyMaxDepth: 6, deepestResident: 3 }, 'interior');
    expect(host.state.settledRouted).toBe(true);
    expect(seg(root, 'interior').getAttribute('aria-pressed')).toBe('true');
    expect(seg(root, 'auto').getAttribute('aria-pressed')).toBe('false');
  });

  it('an undecidable settled frame leaves the one-shot ARMED; the retry commits', async () => {
    const { root, host } = await build();
    host.route(null, { initial: true });
    host.route('interior');
    // Deep residency, but the gather produced nothing (verdict null) — the
    // evaluation ran and decided nothing, so the one-shot must stay armed.
    host.readyPoll({ hierarchyMaxDepth: 4, deepestResident: 2 }, null);
    expect(host.state.settledRouted).toBe(false);
    expect(seg(root, 'auto').getAttribute('aria-pressed')).toBe('true');
    // Next ready poll reaches a verdict — commit lands.
    host.readyPoll({ hierarchyMaxDepth: 4, deepestResident: 2 }, 'interior');
    expect(host.state.settledRouted).toBe(true);
    expect(seg(root, 'interior').getAttribute('aria-pressed')).toBe('true');
  });

  it('a pinned or manually-overridden session spends the one-shot without committing', async () => {
    const { root, host } = await build();
    host.route(null, { initial: true });
    host.route('interior');
    host.state.override = 'object'; // user forced Object mid-stream
    host.readyPoll({ hierarchyMaxDepth: 4, deepestResident: 2 }, 'interior');
    expect(host.state.settledRouted).toBe(true); // never retries
    expect(host.state.committed).toBe(false);
    // The control still shows the manual choice, untouched by the settle.
    expect(seg(root, 'auto').getAttribute('aria-pressed')).toBe('true'); // last render predates the override
  });

  it('settleTargetDepth: capped at 2, floored at the hierarchy’s own max depth', () => {
    expect(settleTargetDepth(0)).toBe(0); // tiny scan: root IS the whole hierarchy
    expect(settleTargetDepth(1)).toBe(1);
    expect(settleTargetDepth(2)).toBe(2);
    expect(settleTargetDepth(7)).toBe(2); // large scans wait for depth 2, no deeper
    expect(settleTargetDepth(-1)).toBe(0); // defensive: never negative
  });

  it('settleOneShotSpent: spends only on a LANDED verdict (or pinned/manual); refused + undecidable re-arm', () => {
    const base = { override: 'auto' as ScanTypeOverride, pinned: false, attempts: 1 };
    // Verdict landed: applied or committed ⇒ spent.
    expect(settleOneShotSpent({ ...base, detected: 'interior', applied: true, committed: false })).toBe(true);
    expect(settleOneShotSpent({ ...base, detected: 'interior', applied: false, committed: true })).toBe(true);
    // v0.4.5b regression: a REACHED-but-REFUSED verdict (terrain against a
    // standing interior route — the no-flip guard rejects it without a
    // commit) must NOT spend the one-shot anymore.
    expect(settleOneShotSpent({ ...base, detected: 'terrain', applied: false, committed: false })).toBe(false);
    // Undecidable still re-arms.
    expect(settleOneShotSpent({ ...base, detected: null, applied: false, committed: false })).toBe(false);
    // Pinned / manual override: never a commit to wait for ⇒ spent.
    expect(settleOneShotSpent({ ...base, detected: null, applied: false, committed: false, override: 'interior' })).toBe(true);
    expect(settleOneShotSpent({ ...base, detected: null, applied: false, committed: false, pinned: true })).toBe(true);
    // Retry cap: a permanently refused/undecidable scan stops re-evaluating.
    expect(settleOneShotSpent({ ...base, detected: 'terrain', applied: false, committed: false, attempts: SETTLE_RETRY_CAP })).toBe(true);
    expect(settleOneShotSpent({ ...base, detected: null, applied: false, committed: false, attempts: SETTLE_RETRY_CAP })).toBe(true);
  });

  it('REGRESSION (interior still not committed): settle reads terrain (refused) → re-arms → later poll reads interior → commits', async () => {
    const { root, host } = await build();
    host.route(null, { initial: true });
    // Growth-gated mid-stream re-route reads INTERIOR — Object panel up,
    // Auto still selected (provisional verdict).
    host.route('interior');
    expect(host.state.objectPanelVisible).toBe(true);
    expect(seg(root, 'auto').getAttribute('aria-pressed')).toBe('true');
    // Depth gate passes (resident spans depth 2) but the early nodes are
    // ceiling-heavy: the settled evaluation reads TERRAIN. The planner
    // refuses the mid-session terrain flip (no apply, no commit). Under the
    // v0.4.5 spend-on-verdict rule this SPENT the one-shot and stranded the
    // pill on Auto forever — it must now stay ARMED.
    host.readyPoll({ hierarchyMaxDepth: 6, deepestResident: 2, residentPoints: 100_000 }, 'terrain');
    expect(host.state.settledRouted).toBe(false);
    expect(seg(root, 'auto').getAttribute('aria-pressed')).toBe('true');
    // Same idle frame again: no resident change ⇒ no re-evaluation churn.
    const attemptsAfterRefusal = host.state.attempts;
    host.readyPoll({ hierarchyMaxDepth: 6, deepestResident: 2, residentPoints: 100_000 }, 'terrain');
    expect(host.state.attempts).toBe(attemptsAfterRefusal);
    // Geometry refines (resident grew); the next ready poll reads INTERIOR —
    // the verdict matches the standing route, the soft-commit fires, and the
    // one-shot is finally spent.
    host.readyPoll({ hierarchyMaxDepth: 6, deepestResident: 3, residentPoints: 180_000 }, 'interior');
    expect(host.state.settledRouted).toBe(true);
    expect(host.state.committed).toBe(true);
    expect(seg(root, 'interior').getAttribute('aria-pressed')).toBe('true');
    expect(seg(root, 'auto').getAttribute('aria-pressed')).toBe('false');
  });

  it('retry cap: a permanently refused verdict spends the one-shot after SETTLE_RETRY_CAP attempts', async () => {
    const { host } = await build();
    host.route(null, { initial: true });
    host.route('interior');
    // Every settle attempt reads terrain (refused) on ever-growing geometry.
    for (let i = 0; i < SETTLE_RETRY_CAP + 5 && !host.state.settledRouted; i++) {
      host.readyPoll(
        { hierarchyMaxDepth: 6, deepestResident: 2, residentPoints: 1000 + i },
        'terrain',
      );
    }
    expect(host.state.settledRouted).toBe(true); // bounded — no infinite re-eval
    expect(host.state.attempts).toBe(SETTLE_RETRY_CAP);
    expect(host.state.committed).toBe(false); // and it never lied about a commit
  });
});
