/**
 * The state strip's height measurement is released on dispose: the observer
 * is disconnected, a pending frame is cancelled and the published
 * `--olv-strip-measured` property is removed, so a later mount starts clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLiveFakeDom } from './helpers/liveFakeDom';

class FakeObserver {
  static live: FakeObserver[] = [];
  connected = false;
  readonly cb: () => void;
  constructor(cb: () => void) { this.cb = cb; }
  observe(): void { this.connected = true; FakeObserver.live.push(this); }
  disconnect(): void { this.connected = false; FakeObserver.live = FakeObserver.live.filter((o) => o !== this); }
  fire(): void { if (this.connected) this.cb(); }
}

let props: Map<string, string>;
let frames: Map<number, () => void>;
let nextFrame: number;

beforeEach(() => {
  installLiveFakeDom();
  props = new Map();
  frames = new Map();
  nextFrame = 1;
  FakeObserver.live = [];
  const doc = globalThis.document as unknown as Record<string, unknown>;
  doc.documentElement = {
    style: {
      getPropertyValue: (k: string) => props.get(k) ?? '',
      setProperty: (k: string, v: string) => { props.set(k, v); },
      removeProperty: (k: string) => { props.delete(k); },
    },
  };
  vi.stubGlobal('ResizeObserver', FakeObserver);
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { const id = nextFrame++; frames.set(id, fn); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => vi.unstubAllGlobals());

const flush = (): void => { const due = [...frames.values()]; frames.clear(); for (const f of due) f(); };

describe('state strip teardown', () => {
  it('disconnects, cancels the pending frame and clears the property; a remount starts clean', async () => {
    const { createStateStrip } = await import('../src/ui/stateStrip');
    const a = createStateStrip({ open: vi.fn() });
    (a.element as unknown as { offsetHeight: number }).offsetHeight = 74;
    const obsA = FakeObserver.live[0]!;
    obsA.fire();
    flush();
    expect(props.get('--olv-strip-measured')).toBe('74px');

    (a.element as unknown as { offsetHeight: number }).offsetHeight = 50;
    obsA.fire();
    expect(frames.size).toBe(1);
    a.dispose();
    expect(obsA.connected).toBe(false);
    expect(FakeObserver.live).toHaveLength(0);
    expect(frames.size).toBe(0);
    expect(props.has('--olv-strip-measured')).toBe(false);
    obsA.fire();
    expect(frames.size).toBe(0);
    flush();
    expect(props.has('--olv-strip-measured')).toBe(false);

    const b = createStateStrip({ open: vi.fn() });
    expect(props.has('--olv-strip-measured')).toBe(false);
    (b.element as unknown as { offsetHeight: number }).offsetHeight = 50;
    FakeObserver.live[0]!.fire();
    flush();
    expect(props.get('--olv-strip-measured')).toBe('50px');
    b.dispose();
  });
});
