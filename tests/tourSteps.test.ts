/**
 * tourSteps.test.ts
 *
 * Pure contract tests for the onboarding tour state machine.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_TOUR,
  TourSession,
  type TourStep,
  type TourStoragePort,
} from '../src/ui/onboarding/tourSteps';

function makeStorage(): TourStoragePort {
  let seen = false;
  return {
    hasSeen: () => seen,
    setSeen: () => {
      seen = true;
    },
    clear: () => {
      seen = false;
    },
  };
}

describe('TourSession — initial state', () => {
  it('starts in pending state with no current step', () => {
    const s = new TourSession(DEFAULT_TOUR, makeStorage());
    expect(s.state).toBe('pending');
    expect(s.snapshot().step).toBeNull();
  });

  it('hasSeen reflects the storage port', () => {
    const port = makeStorage();
    const s = new TourSession(DEFAULT_TOUR, port);
    expect(s.hasSeen()).toBe(false);
    port.setSeen();
    expect(s.hasSeen()).toBe(true);
  });
});

describe('TourSession.start', () => {
  it('transitions to running and broadcasts the first step', () => {
    const s = new TourSession(DEFAULT_TOUR, makeStorage());
    const seen: string[] = [];
    s.subscribe((snap) => {
      seen.push(snap.step?.id ?? 'none');
    });
    s.start();
    expect(s.state).toBe('running');
    expect(s.snapshot().step?.id).toBe(DEFAULT_TOUR[0].id);
  });

  it('skips a leading runIf=false step', () => {
    const steps: TourStep[] = [
      {
        id: 'gated',
        target: null,
        title: 'gated',
        body: '',
        placement: 'center',
        runIf: () => false,
      },
      { id: 'real', target: null, title: 'real', body: '', placement: 'center' },
    ];
    const s = new TourSession(steps, makeStorage());
    s.start();
    expect(s.snapshot().step?.id).toBe('real');
  });

  it('is idempotent — starting twice does not reset progress', () => {
    const s = new TourSession(DEFAULT_TOUR, makeStorage());
    s.start();
    s.next();
    const after = s.snapshot();
    s.start();
    expect(s.snapshot().index).toBe(after.index);
  });
});

describe('TourSession.next + back', () => {
  it('advances through every step in order', () => {
    const s = new TourSession(DEFAULT_TOUR, makeStorage());
    s.start();
    for (let i = 1; i < DEFAULT_TOUR.length; i++) {
      s.next();
      expect(s.snapshot().step?.id).toBe(DEFAULT_TOUR[i].id);
    }
  });

  it('completes after the last step', () => {
    const s = new TourSession(DEFAULT_TOUR, makeStorage());
    s.start();
    for (let i = 0; i < DEFAULT_TOUR.length; i++) s.next();
    expect(s.state).toBe('completed');
  });

  it('back goes to the previous step', () => {
    const s = new TourSession(DEFAULT_TOUR, makeStorage());
    s.start();
    s.next();
    s.back();
    expect(s.snapshot().index).toBe(0);
  });

  it('back at the first step stays at the first step', () => {
    const s = new TourSession(DEFAULT_TOUR, makeStorage());
    s.start();
    s.back();
    expect(s.snapshot().index).toBe(0);
  });
});

describe('TourSession.skip + dismiss', () => {
  it('skip sets the persisted flag and transitions to skipped', () => {
    const port = makeStorage();
    const s = new TourSession(DEFAULT_TOUR, port);
    s.start();
    s.skip();
    expect(s.state).toBe('skipped');
    expect(port.hasSeen()).toBe(true);
  });

  it('dismiss does NOT persist — tour re-shows on next session', () => {
    const port = makeStorage();
    const s = new TourSession(DEFAULT_TOUR, port);
    s.start();
    s.dismiss();
    expect(s.state).toBe('dismissed');
    expect(port.hasSeen()).toBe(false);
  });

  it('completing the natural way sets the persisted flag', () => {
    const port = makeStorage();
    const s = new TourSession(DEFAULT_TOUR, port);
    s.start();
    for (let i = 0; i < DEFAULT_TOUR.length; i++) s.next();
    expect(port.hasSeen()).toBe(true);
  });
});

describe('TourSession.reset', () => {
  it('clears the persisted flag and returns to pending', () => {
    const port = makeStorage();
    const s = new TourSession(DEFAULT_TOUR, port);
    s.start();
    s.skip();
    s.reset();
    expect(s.state).toBe('pending');
    expect(port.hasSeen()).toBe(false);
  });
});

describe('TourSession.subscribe — listener contract', () => {
  it('fires the listener immediately with the current snapshot', () => {
    const s = new TourSession(DEFAULT_TOUR, makeStorage());
    const listener = vi.fn();
    s.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe detaches the listener', () => {
    const s = new TourSession(DEFAULT_TOUR, makeStorage());
    const listener = vi.fn();
    const detach = s.subscribe(listener);
    detach();
    s.start();
    expect(listener).toHaveBeenCalledTimes(1); // only the initial fire
  });

  it('isolates a buggy subscriber so siblings still fire', () => {
    const s = new TourSession(DEFAULT_TOUR, makeStorage());
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    s.subscribe(bad);
    s.subscribe(good);
    s.start();
    expect(good).toHaveBeenCalledTimes(2);
  });
});
