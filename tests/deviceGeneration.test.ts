import { describe, expect, it } from 'vitest';

import {
  DeviceGeneration,
  FIRST_GENERATION,
  watchContextRestore,
  wireRendererDeviceLoss,
  type DeviceEvent,
  type DeviceLossReport,
} from '../src/render/deviceGeneration';
import { HistoryTargets } from '../src/render/continuity/historyTargets';

const EVENTS: readonly DeviceEvent[] = [
  'webgpu-device-lost',
  'webgl-context-lost',
  'webgl-context-restored',
  'backend-replaced',
];

/** A canvas that records its listeners and can raise the two events. */
function fakeCanvas() {
  const listeners = new Map<string, Set<() => void>>();
  let defaultPrevented = false;
  return {
    addEventListener(type: string, fn: () => void): void {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: () => void): void {
      listeners.get(type)?.delete(fn);
    },
    raise(type: string): void {
      const event = { preventDefault: () => { defaultPrevented = true; } };
      for (const fn of [...(listeners.get(type) ?? [])]) (fn as (e: unknown) => void)(event);
    },
    count(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
    get prevented(): boolean {
      return defaultPrevented;
    },
  };
}

describe('the counter', () => {
  it('starts at the first generation with a usable device', () => {
    const g = new DeviceGeneration();
    expect(g.current).toBe(FIRST_GENERATION);
    expect(g.lost).toBe(false);
    expect(g.lastEvent).toBe(null);
  });

  it('advances on every event, so an older resource can always tell', () => {
    const g = new DeviceGeneration();
    let previous = g.current;
    for (const event of EVENTS) {
      const next = g.note(event);
      expect(next).toBeGreaterThan(previous);
      expect(g.lastEvent).toBe(event);
      previous = next;
    }
  });

  it('advances twice across a lost-then-restored cycle', () => {
    // A counter that advanced once would have to know, at the moment of the
    // loss, whether a restore is coming. A context can be lost and never
    // restored.
    const g = new DeviceGeneration();
    g.note('webgl-context-lost');
    g.note('webgl-context-restored');
    expect(g.current).toBe(FIRST_GENERATION + 2);
  });

  it('advances again on a repeated event rather than choosing a report to believe', () => {
    const g = new DeviceGeneration();
    g.note('webgl-context-lost');
    const after = g.note('webgl-context-lost');
    expect(after).toBe(FIRST_GENERATION + 2);
    expect(g.lost).toBe(true);
  });
});

describe('lost is a separate question', () => {
  it('is true while the device is gone and false once it is back', () => {
    const g = new DeviceGeneration();
    g.note('webgl-context-lost');
    expect(g.lost).toBe(true);
    g.note('webgl-context-restored');
    expect(g.lost).toBe(false);
  });

  it('is true after a WebGPU device loss and false after a backend replacement', () => {
    const g = new DeviceGeneration();
    g.note('webgpu-device-lost');
    expect(g.lost).toBe(true);
    g.note('backend-replaced');
    expect(g.lost).toBe(false);
  });

  it('makes even a current-numbered resource unusable', () => {
    // A resource from the current era is still unusable if the era ended.
    const g = new DeviceGeneration();
    const tagged = g.note('webgl-context-lost');
    expect(g.current).toBe(tagged);
    expect(g.isCurrent(tagged)).toBe(false);
  });

  it('accepts a resource from the era in force', () => {
    const g = new DeviceGeneration();
    const tagged = g.note('backend-replaced');
    expect(g.isCurrent(tagged)).toBe(true);
    expect(g.isCurrent(tagged - 1)).toBe(false);
    expect(g.isCurrent(Number.NaN)).toBe(false);
  });
});

describe('the renderer hook', () => {
  it('advances the generation when the renderer reports a loss', () => {
    const renderer: { onDeviceLost?: (info: DeviceLossReport) => void } = {};
    const g = new DeviceGeneration();
    wireRendererDeviceLoss(renderer, g);
    renderer.onDeviceLost?.({ api: 'WebGPU', message: 'Unknown reason' });
    expect(g.current).toBe(FIRST_GENERATION + 1);
    expect(g.lastEvent).toBe('webgpu-device-lost');
    expect(g.lost).toBe(true);
  });

  it('records which API lost it', () => {
    const renderer: { onDeviceLost?: (info: DeviceLossReport) => void } = {};
    const g = new DeviceGeneration();
    wireRendererDeviceLoss(renderer, g);
    renderer.onDeviceLost?.({ api: 'WebGL', message: 'ctx' });
    expect(g.lastEvent).toBe('webgl-context-lost');
  });

  it('records a loss it cannot name as a loss anyway', () => {
    // The counter exists to invalidate, and an unnamed loss is still a loss.
    const renderer: { onDeviceLost?: (info: DeviceLossReport) => void } = {};
    const g = new DeviceGeneration();
    wireRendererDeviceLoss(renderer, g);
    renderer.onDeviceLost?.({ message: 'no api field' });
    expect(g.lost).toBe(true);
  });

  it('chains the handler that was already there', () => {
    // Three's own handler logs the message and sets its internal flag. A
    // wiring that dropped it would trade a diagnostic for a counter.
    const seen: DeviceLossReport[] = [];
    const renderer: { onDeviceLost?: (info: DeviceLossReport) => void } = {
      onDeviceLost: (info) => seen.push(info),
    };
    const g = new DeviceGeneration();
    wireRendererDeviceLoss(renderer, g);
    renderer.onDeviceLost?.({ api: 'WebGL', message: 'ctx' });
    expect(seen).toEqual([{ api: 'WebGL', message: 'ctx' }]);
    expect(g.current).toBe(FIRST_GENERATION + 1);
  });

  it('still chains when the reporter throws', () => {
    const seen: DeviceLossReport[] = [];
    const renderer: { onDeviceLost?: (info: DeviceLossReport) => void } = {
      onDeviceLost: (info) => seen.push(info),
    };
    wireRendererDeviceLoss(renderer, new DeviceGeneration(), () => {
      throw new Error('diagnostics');
    });
    renderer.onDeviceLost?.({ api: 'WebGPU' });
    expect(seen.length).toBe(1);
  });

  it('puts the previous handler back on detach', () => {
    const original = (): void => {};
    const renderer: { onDeviceLost?: (info: DeviceLossReport) => void } = {
      onDeviceLost: original,
    };
    const detach = wireRendererDeviceLoss(renderer, new DeviceGeneration());
    expect(renderer.onDeviceLost).not.toBe(original);
    detach();
    expect(renderer.onDeviceLost).toBe(original);
  });

  it('does nothing without a renderer', () => {
    const g = new DeviceGeneration();
    expect(() => wireRendererDeviceLoss(null, g)()).not.toThrow();
    expect(g.current).toBe(FIRST_GENERATION);
  });
});

describe('the restore listener', () => {
  it('advances the generation and clears the lost flag', () => {
    const canvas = fakeCanvas();
    const g = new DeviceGeneration();
    g.note('webgl-context-lost');
    watchContextRestore(canvas, g);
    canvas.raise('webglcontextrestored');
    expect(g.lost).toBe(false);
    expect(g.current).toBe(FIRST_GENERATION + 2);
  });

  it('does not cancel anything, because the backend already does', () => {
    // three's WebGL backend calls preventDefault in its own listener, which is
    // what lets a restore follow. A second canceller would be a second opinion.
    const canvas = fakeCanvas();
    watchContextRestore(canvas, new DeviceGeneration());
    canvas.raise('webglcontextlost');
    expect(canvas.prevented).toBe(false);
  });

  it('reports the change to the caller', () => {
    const canvas = fakeCanvas();
    const seen: [DeviceEvent, number][] = [];
    watchContextRestore(canvas, new DeviceGeneration(), (e, n) => seen.push([e, n]));
    canvas.raise('webglcontextrestored');
    expect(seen).toEqual([['webgl-context-restored', 1]]);
  });

  it('survives a reporter that throws', () => {
    const canvas = fakeCanvas();
    const g = new DeviceGeneration();
    watchContextRestore(canvas, g, () => { throw new Error('diagnostics'); });
    expect(() => canvas.raise('webglcontextrestored')).not.toThrow();
    expect(g.current).toBe(FIRST_GENERATION + 1);
  });

  it('detaches', () => {
    const canvas = fakeCanvas();
    const g = new DeviceGeneration();
    watchContextRestore(canvas, g)();
    expect(canvas.count('webglcontextrestored')).toBe(0);
    canvas.raise('webglcontextrestored');
    expect(g.current).toBe(FIRST_GENERATION);
  });
});

describe('the history it invalidates', () => {
  it('rebuilds surfaces after a device change at the same size', () => {
    // The trap this exists for: surfaces from a dead device are the right
    // size, still referenced, and every dimension check calls them current.
    const made: string[] = [];
    const targets = new HistoryTargets((label, widthPx, heightPx) => {
      made.push(label);
      return { label, widthPx, heightPx, dispose: () => {} };
    });
    const g = new DeviceGeneration();
    targets.resize(320, 240, g.current);
    expect(targets.allocationCount).toBe(1);

    // Same size, same call: nothing happens.
    targets.resize(320, 240, g.current);
    expect(targets.allocationCount).toBe(1);

    g.note('webgl-context-restored');
    targets.resize(320, 240, g.current);
    expect(targets.allocationCount).toBe(2);
    expect(made.length).toBe(6);
  });
});
