/**
 * planView.test.ts — what plan mode remembers, and what it puts back.
 *
 * The camera work behind Plan View already existed: a top standard view, the
 * orthographic toggle, and a pan navigation mode that hands the primary drag to
 * the hand tool. Composing them is easy. The part that goes wrong is the memory.
 *
 * Two failures these tests exist to catch. Capturing the scene AFTER plan mode
 * has rewritten it stores plan's own top-down orthographic state as the thing to
 * restore, so leaving strands the user exactly where they were trying to leave.
 * And re-entering while already active overwrites a good capture with that same
 * useless one, which is the same strand reached by a double click.
 */

import { describe, it, expect } from 'vitest';
import {
  enterPlanView,
  leavePlanView,
  togglePlanView,
  planViewSurvives,
  PLAN_VIEW_OFF,
  type PlanViewContext,
  type PlanViewIntent,
} from '../src/render/camera/planView';

/** A scene the user is working in: perspective, orbiting, hand tool available. */
function scene(over: Partial<PlanViewContext> = {}): PlanViewContext {
  return { mode: 'orbit', orthographic: false, handPanAvailable: true, ...over };
}

/** The intents as a comparable shape. */
const kinds = (intents: readonly PlanViewIntent[]): string[] => intents.map((i) => i.kind);

describe('entering plan mode', () => {
  it('asks for top down, parallel projection and the hand tool', () => {
    const { state, intents } = enterPlanView(PLAN_VIEW_OFF, scene());
    expect(state.active).toBe(true);
    expect(intents).toEqual([
      { kind: 'standardView', view: 'top' },
      { kind: 'orthographic', on: true },
      { kind: 'navMode', mode: 'pan' },
    ]);
  });

  it('captures the scene as the user left it, not as plan rewrote it', () => {
    const { state } = enterPlanView(PLAN_VIEW_OFF, scene({ mode: 'fly', orthographic: false }));
    // Capturing after the intents ran would store pan + orthographic here, and
    // leaving would then put the user back into the view they just left.
    expect(state.restore).toEqual({ mode: 'fly', orthographic: false });
  });

  it('does not ask for a mode the controller would refuse', () => {
    // `NavController.setMode('pan')` returns silently when the hand tool is off,
    // so requesting it would leave plan mode orbiting while claiming otherwise.
    const { intents } = enterPlanView(PLAN_VIEW_OFF, scene({ handPanAvailable: false }));
    expect(kinds(intents)).not.toContain('navMode');
    expect(kinds(intents)).toEqual(['standardView', 'orthographic']);
  });

  it('does not ask for pan when the scene is already panning', () => {
    const { intents } = enterPlanView(PLAN_VIEW_OFF, scene({ mode: 'pan' }));
    expect(kinds(intents)).not.toContain('navMode');
  });

  it('keeps the original capture when entering twice', () => {
    const first = enterPlanView(PLAN_VIEW_OFF, scene({ mode: 'walk', orthographic: false }));
    // A second enter, with the scene now reading as plan mode set it up.
    const second = enterPlanView(first.state, scene({ mode: 'pan', orthographic: true }));
    expect(second.intents).toEqual([]);
    expect(second.state.restore).toEqual({ mode: 'walk', orthographic: false });
  });
});

describe('leaving plan mode', () => {
  it('restores the projection and the mode it captured', () => {
    const entered = enterPlanView(PLAN_VIEW_OFF, scene({ mode: 'fly' }));
    const { state, intents } = leavePlanView(entered.state);
    expect(state).toEqual(PLAN_VIEW_OFF);
    expect(intents).toEqual([
      { kind: 'orthographic', on: false },
      { kind: 'standardView', view: 'front' },
      { kind: 'navMode', mode: 'fly' },
    ]);
  });

  it('leaves the projection alone when it was already orthographic', () => {
    const entered = enterPlanView(PLAN_VIEW_OFF, scene({ orthographic: true }));
    const { intents } = leavePlanView(entered.state);
    // Flipping it off here would change a setting the user chose themselves.
    expect(intents.find((i) => i.kind === 'orthographic')).toBeUndefined();
  });

  it('leaves the mode alone when the scene was already panning', () => {
    const entered = enterPlanView(PLAN_VIEW_OFF, scene({ mode: 'pan' }));
    const { intents } = leavePlanView(entered.state);
    expect(kinds(intents)).not.toContain('navMode');
  });

  it('returns to a 3D pose rather than staying overhead', () => {
    const entered = enterPlanView(PLAN_VIEW_OFF, scene());
    const view = leavePlanView(entered.state).intents.find((i) => i.kind === 'standardView');
    expect(view).toBeDefined();
    // Top with perspective restored is neither the plan the user had nor the
    // scene they asked to get back.
    expect(view).not.toEqual({ kind: 'standardView', view: 'top' });
  });

  it('is a no-op when plan mode is already off', () => {
    const { state, intents } = leavePlanView(PLAN_VIEW_OFF);
    expect(state).toEqual(PLAN_VIEW_OFF);
    expect(intents).toEqual([]);
  });
});

describe('a full round trip', () => {
  it('returns every captured fact to where it started', () => {
    for (const ctx of [
      scene({ mode: 'orbit', orthographic: false }),
      scene({ mode: 'walk', orthographic: true }),
      scene({ mode: 'fly', orthographic: false }),
      scene({ mode: 'pan', orthographic: true }),
    ]) {
      const entered = enterPlanView(PLAN_VIEW_OFF, ctx);
      const left = leavePlanView(entered.state);

      // Whatever the scene started as, the restore either names it or the
      // absence of an intent means it never changed.
      const orthoIntent = left.intents.find((i) => i.kind === 'orthographic');
      const finalOrtho = orthoIntent ? (orthoIntent as { on: boolean }).on : true;
      expect(finalOrtho).toBe(ctx.orthographic);

      const modeIntent = left.intents.find((i) => i.kind === 'navMode');
      const finalMode = modeIntent ? (modeIntent as { mode: string }).mode : 'pan';
      expect(finalMode).toBe(ctx.mode);

      expect(left.state).toEqual(PLAN_VIEW_OFF);
    }
  });

  it('toggles in and back out', () => {
    const on = togglePlanView(PLAN_VIEW_OFF, scene());
    expect(on.state.active).toBe(true);
    const off = togglePlanView(on.state, scene({ mode: 'pan', orthographic: true }));
    expect(off.state.active).toBe(false);
  });
});

describe('when the scene drifts out from under plan mode', () => {
  it('drops the claim once the projection or the view changes by hand', () => {
    expect(planViewSurvives(true, true)).toBe(true);
    expect(planViewSurvives(false, true)).toBe(false);
    expect(planViewSurvives(true, false)).toBe(false);
  });
});
