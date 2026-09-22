/**
 * streamingPolicyWake.test.ts: a streaming policy change reaches the loop.
 *
 * The render-activity listeners sit on the CANVAS: pointer moves, clicks,
 * wheel, plus a window keydown. Every caller of the streaming policy surface
 * is a click in the streaming panel, which is DOM the canvas never sees. So on
 * a settled scene the loop is asleep, and changing the streaming colour mode
 * used to swap the material while the picture stayed as it was. The scheduler
 * has the same problem from the other side: it ticks from the loop body, so a
 * resume, a new budget or a dropped cache could not act until a frame ran.
 *
 * The heartbeat is what eventually rescued both, and it is a safety net rather
 * than a response path. A frame arrives every 250 ms, and an idle frame still
 * has to clear the gate, which takes six skips first. A colour change could
 * therefore sit unpainted for over a second.
 *
 * `input()` is used rather than `changed('style')` because the gate does not
 * read invalidation reasons yet: a reason wakes the scheduler, and the woken
 * frame can still be skipped. When the reason vocabulary becomes a draw
 * authority these are call sites to revisit.
 *
 * This pins the WAKE, not the setter's own effect, and it reads the Viewer's
 * own source to do it. A double that mirrors the setter cannot notice the
 * setter drifting away from it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FrameDemand } from '../src/render/frameDemand';

/** A demand whose signals are all quiet, so any wake must come from the call. */
function sleepingDemand(): FrameDemand {
  const d = new FrameDemand({
    nowMs: () => 0,
    tweening: () => false,
    streamingBusy: () => false,
    commitPending: () => false,
    fading: () => false,
  });
  d.gate.noteRendered(); // park the heartbeat, as a settled scene has
  return d;
}

describe('a settled viewer is asleep until something asks', () => {
  it('needs no frame and would not draw one', () => {
    const d = sleepingDemand();
    expect(d.needsFrame(0)).toBe(false);
    expect(d.shouldRender()).toBe(false);
  });

  it('is woken and armed by input(), which is what the setters call', () => {
    const d = sleepingDemand();
    d.input();
    expect(d.needsFrame(0)).toBe(true);
    expect(d.shouldRender()).toBe(true);
  });

  it('would not be armed by a reason alone, which is why input() is used', () => {
    // `changed` records the reason and wakes the scheduler, but the gate does
    // not consult reasons, so the frame it wakes is still skipped. This is the
    // gap that makes `changed('style')` the wrong call today.
    const d = sleepingDemand();
    d.changed('style');
    expect(d.needsFrame(0)).toBe(true);
    expect(d.shouldRender()).toBe(false);
  });
});

describe('the streaming policy surface tells the demand', () => {
  // Read the Viewer rather than a copy of it. A helper that mirrors the setter
  // cannot notice the setter drifting away from it, and the defect being
  // guarded is precisely a policy call that forgets to wake the loop.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'render', 'Viewer.ts'),
    'utf8',
  );

  /** The text of a Viewer method, ending at its closing brace. */
  const bodyOf = (name: string): string => {
    const at = source.indexOf(`\n  ${name}(`);
    expect(at, `${name} not found in Viewer.ts`).toBeGreaterThan(-1);
    const end = source.indexOf('\n  }\n', at);
    return source.slice(at, end);
  };

  it.each(['setStreamingColorMode', 'setStreamingQuality', 'resumeStreaming', 'clearStreamingCache'])(
    '%s wakes the loop',
    (name) => {
      expect(bodyOf(name)).toContain('_demand.input()');
    },
  );

  it('pauseStreaming does not, because stopping work needs no frame', () => {
    expect(bodyOf('pauseStreaming')).not.toContain('_demand.input()');
  });
});
