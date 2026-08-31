/**
 * The streaming session-assembly contract.
 *
 * `attachStreamingCloud` used to build the whole streaming subsystem inline in a
 * real WebGL Viewer — the renderer/scheduler construction, the guarded
 * display-only node hooks, and the benchmark bookkeeping — so this wiring was
 * covered by the streaming e2e alone. Extracting it behind {@link StreamingHost}
 * makes the parts with no three.js of their own directly testable: the fade-in
 * gate, the scheduler-callback fan-out (where a wrong guard would let a legend
 * throw kill the whole stream, or a stale hook read miss a late-arriving node),
 * and the teardown order. The GPU-bound remainder (camera/nav/EDL setup) stays
 * on the Viewer and is covered by the deterministic streaming spec.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  shouldFadeIn,
  buildSchedulerCallbacks,
  disposeStreamingSession,
  type StreamingSession,
} from '../src/render/streaming/streamingAttach';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { DecodedChunk } from '../src/io/copc/copcChunkDecode';
import type { StreamingBenchmark } from '../src/render/streaming/streamingBenchmark';
import type { StreamingRenderer } from '../src/render/streaming/StreamingRenderer';

function node(id: string): StreamingNode {
  return { record: { id } } as unknown as StreamingNode;
}

function decoded(over: Partial<{ classification: Uint8Array | undefined; posBytes: number }> = {}): DecodedChunk {
  const posBytes = over.posBytes ?? 12;
  return {
    classification: 'classification' in over ? over.classification : new Uint8Array([2, 2, 6]),
    positions: { byteLength: posBytes } as unknown as Float32Array,
  } as unknown as DecodedChunk;
}

function fakeRenderer(): Pick<
  StreamingRenderer,
  'onNodeReady' | 'onNodeEvicted' | 'applyReplaceVisibility'
> {
  return {
    onNodeReady: vi.fn(),
    onNodeEvicted: vi.fn(),
    applyReplaceVisibility: vi.fn(),
  } as unknown as Pick<
    StreamingRenderer,
    'onNodeReady' | 'onNodeEvicted' | 'applyReplaceVisibility'
  >;
}

function fakeBenchmark(): StreamingBenchmark {
  return {
    recordFirstPaint: vi.fn(),
    recordNodeReady: vi.fn(),
    recordDecodedBytes: vi.fn(),
    recordNodeEvicted: vi.fn(),
    recordSchedulerTick: vi.fn(),
  } as unknown as StreamingBenchmark;
}

describe('shouldFadeIn', () => {
  it('fades in on desktop mid/high presets', () => {
    expect(shouldFadeIn(false, 'high')).toBe(true);
    expect(shouldFadeIn(false, 'balanced')).toBe(true);
  });

  it('skips the fade on mobile regardless of preset', () => {
    expect(shouldFadeIn(true, 'high')).toBe(false);
    expect(shouldFadeIn(true, 'low')).toBe(false);
  });

  it('skips the fade on the low-tier desktop preset', () => {
    expect(shouldFadeIn(false, 'low')).toBe(false);
  });
});

describe('buildSchedulerCallbacks — onNodeReady', () => {
  it('paints through the renderer then fans out to both live hooks', () => {
    const renderer = fakeRenderer();
    const classesHook = vi.fn();
    const readyHook = vi.fn();
    const cb = buildSchedulerCallbacks({
      renderer,
      benchmark: null,
      nodeClassesHook: () => classesHook,
      nodeReadyHook: () => readyHook,
    });
    const d = decoded({ classification: new Uint8Array([1, 2, 3]) });
    cb.onNodeReady(node('0-0-0-0'), d);

    expect(renderer.onNodeReady).toHaveBeenCalledWith(node('0-0-0-0'), d);
    expect(classesHook).toHaveBeenCalledWith(d.classification);
    expect(readyHook).toHaveBeenCalledTimes(1);
  });

  it('forwards the replace frontier to the renderer visibility hook', () => {
    const renderer = fakeRenderer();
    const cb = buildSchedulerCallbacks({
      renderer,
      benchmark: null,
      nodeClassesHook: () => undefined,
      nodeReadyHook: () => undefined,
    });
    const hidden = new Set(['root.pnts']);
    cb.onFrontierChanged?.(hidden);
    expect(renderer.applyReplaceVisibility).toHaveBeenCalledWith(hidden);
  });

  it('skips the class hook when the host has none, or the chunk carries no classification', () => {
    const renderer = fakeRenderer();
    const readyHook = vi.fn();

    // No class hook installed.
    buildSchedulerCallbacks({
      renderer,
      benchmark: null,
      nodeClassesHook: () => undefined,
      nodeReadyHook: () => readyHook,
    }).onNodeReady(node('a'), decoded());
    expect(readyHook).toHaveBeenCalledTimes(1);

    // Class hook installed but chunk has no classification array.
    const classesHook = vi.fn();
    buildSchedulerCallbacks({
      renderer,
      benchmark: null,
      nodeClassesHook: () => classesHook,
      nodeReadyHook: () => undefined,
    }).onNodeReady(node('b'), decoded({ classification: undefined }));
    expect(classesHook).not.toHaveBeenCalled();
  });

  it('reads the hooks FRESH on every node so a late (un)install takes effect', () => {
    const renderer = fakeRenderer();
    let liveReady: (() => void) | undefined;
    const cb = buildSchedulerCallbacks({
      renderer,
      benchmark: null,
      nodeClassesHook: () => undefined,
      nodeReadyHook: () => liveReady,
    });

    cb.onNodeReady(node('a'), decoded()); // no hook installed yet
    const readyHook = vi.fn();
    liveReady = readyHook;
    cb.onNodeReady(node('b'), decoded()); // installed between calls
    expect(readyHook).toHaveBeenCalledTimes(1);
  });

  it('never lets a throwing legend/route hook break the pipeline (renderer + benchmark still run)', () => {
    const renderer = fakeRenderer();
    const benchmark = fakeBenchmark();
    const cb = buildSchedulerCallbacks({
      renderer,
      benchmark,
      nodeClassesHook: () => () => {
        throw new Error('legend blew up');
      },
      nodeReadyHook: () => () => {
        throw new Error('reroute blew up');
      },
    });
    const d = decoded({ posBytes: 48 });
    expect(() => cb.onNodeReady(node('n1'), d)).not.toThrow();
    // The paint and the benchmark recording still happened despite the throws.
    expect(renderer.onNodeReady).toHaveBeenCalledOnce();
    expect(benchmark.recordFirstPaint).toHaveBeenCalledOnce();
    expect(benchmark.recordNodeReady).toHaveBeenCalledWith('n1');
    expect(benchmark.recordDecodedBytes).toHaveBeenCalledWith(48);
  });

  it('records nothing when no benchmark is collecting', () => {
    const renderer = fakeRenderer();
    const cb = buildSchedulerCallbacks({
      renderer,
      benchmark: null,
      nodeClassesHook: () => undefined,
      nodeReadyHook: () => undefined,
    });
    expect(() => cb.onNodeReady(node('n'), decoded())).not.toThrow();
  });
});

describe('buildSchedulerCallbacks — onNodeEvicted + onTick', () => {
  it('evicts through the renderer and records the eviction when benchmarking', () => {
    const renderer = fakeRenderer();
    const benchmark = fakeBenchmark();
    const cb = buildSchedulerCallbacks({
      renderer,
      benchmark,
      nodeClassesHook: () => undefined,
      nodeReadyHook: () => undefined,
    });
    cb.onNodeEvicted(node('gone'));
    expect(renderer.onNodeEvicted).toHaveBeenCalledWith(node('gone'));
    expect(benchmark.recordNodeEvicted).toHaveBeenCalledWith('gone');
  });

  it('omits onTick entirely without a benchmark, and wires it to recordSchedulerTick with one', () => {
    const renderer = fakeRenderer();
    expect(
      buildSchedulerCallbacks({
        renderer,
        benchmark: null,
        nodeClassesHook: () => undefined,
        nodeReadyHook: () => undefined,
      }).onTick,
    ).toBeUndefined();

    const benchmark = fakeBenchmark();
    const cb = buildSchedulerCallbacks({
      renderer,
      benchmark,
      nodeClassesHook: () => undefined,
      nodeReadyHook: () => undefined,
    });
    cb.onTick?.(7.5);
    expect(benchmark.recordSchedulerTick).toHaveBeenCalledWith(7.5);
  });
});

describe('disposeStreamingSession', () => {
  function session(close?: () => Promise<void>): {
    session: StreamingSession;
    calls: string[];
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  } {
    const calls: string[] = [];
    const stop = vi.fn(() => calls.push('stop'));
    const dispose = vi.fn(() => calls.push('dispose'));
    const s = {
      scheduler: { stop },
      renderer: { dispose },
      cloud: {
        close:
          close ??
          (() => {
            calls.push('close');
            return Promise.resolve();
          }),
      },
    } as unknown as StreamingSession;
    return { session: s, calls, stop, dispose };
  }

  it('stops the scheduler, disposes the renderer, then closes the source — in that order', () => {
    const { session: s, calls } = session();
    disposeStreamingSession(s);
    expect(calls).toEqual(['stop', 'dispose', 'close']);
  });

  it('swallows a rejected close so teardown never throws', async () => {
    const { session: s, stop, dispose } = session(() => Promise.reject(new Error('reader gone')));
    expect(() => disposeStreamingSession(s)).not.toThrow();
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    // Let the rejected close settle; the swallowing .catch must absorb it.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('tolerates a source with no close() method', () => {
    const s = {
      scheduler: { stop: vi.fn() },
      renderer: { dispose: vi.fn() },
      cloud: {},
    } as unknown as StreamingSession;
    expect(() => disposeStreamingSession(s)).not.toThrow();
  });
});
