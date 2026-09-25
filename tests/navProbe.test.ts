import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NavProbe, jankStats, inputToDraw, longestStarvation } from '../src/perf/navProbe';
import { navSink, NAV_SINK_SLOT } from '../src/perf/navProbeHook';
import { buildNavJankRecord, validateJsonSchema, type NavJankEnv } from '../src/perf/navJankRecord';
import { runRenderFrame, type RenderLoopHost } from '../src/render/renderLoop';
import { GpuUploadQueue } from '../src/render/gpuUploadQueue';
import { StreamingNodeStore } from '../src/render/streaming/StreamingNodeStore';

const SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL('../validation/performance/nav-jank.schema.json', import.meta.url)), 'utf8'),
);

/** A probe on a manual clock with no measures or observer. */
function manual(frames = 64) {
  let t = 0;
  const probe = new NavProbe({ frames, now: () => t, performanceObserver: null, measures: false });
  return { probe, set: (v: number) => { t = v; } };
}

/** Record one frame of `ms` ending at `end`. */
function frame(probe: NavProbe, end: number, ms: number, drawn = true, edl = false, dpr = 1, phase = 'full-refine') {
  probe.frameBegin(end - 1);
  probe.frameMs(ms);
  probe.frameEnd(end, drawn, edl, dpr, phase);
}

const ENV: NavJankEnv = {
  commit: 'a'.repeat(40), browser: 'Test 1', os: 'Test OS', renderer: 'webgl2 / Test', dpr: 2,
  refreshEstimateHz: 60, datasetSha256: 'b'.repeat(64), trajectoryDigest: 'orbit-1', flags: ['benchmark=nav'], cache: 'cold',
};

afterEach(() => { expect(navSink()).toBeNull(); });

describe('NavProbe ring', () => {
  it('wraps at capacity, keeps the newest frames and never replaces its columns', () => {
    const { probe } = manual(8);
    const cols = Object.entries(probe as unknown as Record<string, unknown>).filter(([, v]) => ArrayBuffer.isView(v));
    expect(cols.length).toBeGreaterThan(10);
    for (let k = 0; k < 20; k++) frame(probe, 100 + k * 16, k + 1);
    expect(probe.frameCount).toBe(8);
    for (const [key, v] of cols) expect((probe as unknown as Record<string, unknown>)[key]).toBe(v);
    const s = probe.summarize();
    expect(s.frames).toBe(8);
    // The retained frames are 13..20 ms.
    expect(s.frameMs.p50).toBe(16);
    expect(s.frameMs.p99).toBe(20);
  });

  it('start/stop installs and removes the sink', () => {
    const { probe } = manual();
    probe.start();
    expect(navSink()).toBe(probe);
    expect(NAV_SINK_SLOT).toBe('__olvNavSink');
    probe.stop();
  });
});

describe('summary statistics', () => {
  it('percentiles and threshold counts', () => {
    const { probe } = manual(200);
    const times = [10, 16, 17, 20, 34, 40, 51, 60, 101, 120];
    times.forEach((ms, k) => frame(probe, 100 + k * 20, ms));
    const s = probe.summarize();
    expect(s.frameMs.samples).toBe(10);
    expect(s.frameMs.p50).toBe(34);
    expect(s.frameMs.p95).toBe(120);
    expect(s.over).toEqual({ '16.7': 8, '33.3': 6, '50': 4, '100': 2 });
  });

  it('frames without an accepted clock delta are excluded', () => {
    const { probe } = manual();
    probe.frameEnd(10, true, false, 1, 'full-refine');
    frame(probe, 30, 16);
    expect(probe.summarize().frameMs.samples).toBe(1);
  });

  it('jank is a frame over twice the median; a burst is two or more in a row', () => {
    expect(jankStats([10, 10, 25, 10, 25, 30, 21, 10, NaN, 25], 20)).toEqual({ events: 5, bursts: 1, longestBurst: 3 });
    const { probe } = manual();
    [16, 16, 16, 16, 40, 40, 16, 50].forEach((ms, k) => frame(probe, k * 20, ms));
    const s = probe.summarize();
    expect(s.jank.thresholdMs).toBe(32);
    expect(s.jank.events).toBe(3);
    expect(s.jank.bursts).toBe(1);
  });

  it('pairs each input with the next drawn frame', () => {
    expect(inputToDraw([5, 12, 40], [10, 20, 30])).toEqual([5, 8]);
    const { probe } = manual();
    probe.input(95);
    frame(probe, 100, 16, false);
    frame(probe, 116, 16, true);
    probe.input(117);
    frame(probe, 150, 16, true);
    const s = probe.summarize();
    expect(s.inputToDrawMs.samples).toBe(2);
    expect(s.inputToDrawMs.p50).toBe(21);
    expect(s.inputToDrawMs.p95).toBe(33);
  });

  it('starvation is the longest drawn-frame gap while input is active', () => {
    // Gap 100→400 has an input inside it; gap 500→900 has none within 250 ms.
    expect(longestStarvation([150], [100, 400, 500, 900], 250)).toBe(300);
    expect(longestStarvation([], [0, 1000], 250)).toBe(0);
    // An input shortly before the gap starts still counts.
    expect(longestStarvation([80], [100, 600], 250)).toBe(500);
  });

  it('attributes a long task to the span it overlaps most', () => {
    const { probe } = manual();
    probe.span('olv:upload', 100, 110);
    probe.span('olv:edl', 110, 180);
    probe.span('olv:stream', 300, 400);
    probe.longTask(105, 60); // 105-165: upload 5 ms, edl 55 ms
    probe.longTask(500, 80); // nothing
    probe.longTask(290, 55); // stream
    const s = probe.summarize();
    expect(probe.ownerOf(105, 165)).toBe('edl');
    expect(s.longTasks.count).toBe(3);
    expect(s.longTasks.byOwner.edl).toEqual({ count: 1, totalMs: 60 });
    expect(s.longTasks.byOwner.stream.count).toBe(1);
    expect(s.longTasks.byOwner.unattributed.count).toBe(1);
    expect(s.longTasks.byOwner.upload.count).toBe(0);
  });

  it('records quality transitions', () => {
    const { probe } = manual();
    frame(probe, 10, 16, true, true, 2, 'full-refine');
    frame(probe, 26, 16, true, false, 1, 'moving');
    frame(probe, 42, 16, true, false, 1, 'moving');
    frame(probe, 58, 16, true, true, 2, 'coverage');
    const q = probe.summarize().quality;
    expect(q.byKind).toEqual({ edl: 2, dpr: 2, phase: 2 });
    expect(q.events[2]).toEqual({ t: 26, kind: 'phase', from: 'full-refine', to: 'moving' });
  });

  it('accumulates upload and LOD churn per frame', () => {
    const { probe } = manual();
    probe.frameBegin(0);
    probe.frameMs(16);
    probe.upload({ uploaded: 3, uploadedBytes: 3000, stoppedBy: 'bytes' }, 2);
    probe.lodChange(3, 1);
    probe.frameEnd(1000, true, false, 1, 'full-refine');
    const s = probe.summarize();
    expect(s.upload).toMatchObject({ passes: 1, p95Ms: 2, p95Bytes: 3000, totalBytes: 3000 });
    expect(s.upload.stoppedBy.bytes).toBe(1);
    expect(s.lod).toEqual({ added: 3, removed: 1, churnPerSec: 4 });
  });
});

describe('render loop wiring', () => {
  function host(over: Partial<RenderLoopHost> = {}): RenderLoopHost {
    const noop = () => {};
    return new Proxy({ ...over } as RenderLoopHost, {
      get: (target, key: string) => (key in target ? (target as unknown as Record<string, unknown>)[key]
        : key === 'advanceFrameClock' ? () => 0.016
          : key === 'shouldRenderFrame' || key === 'hasStreaming' ? () => true
            : key === 'toolMode' ? () => 'orbit'
              : key === 'sweepState' ? () => 'none'
                : key === 'streamingTickDue' ? () => true
                  : key === 'navQuality' ? undefined
                    : key.endsWith('UntilMs') ? () => 0 : () => noop()),
    });
  }

  it('records one frame with spans, upload and quality while the probe runs', () => {
    let t = 0;
    const probe = new NavProbe({ frames: 8, now: () => (t += 1), performanceObserver: null, measures: false });
    probe.start();
    try {
      runRenderFrame(host({
        edlEnabled: () => true,
        pumpStreamingCommit: () => ({ uploaded: 2, uploadedBytes: 10, stoppedBy: 'drained' }),
        navQuality: () => ({ dpr: 1.5, phase: 'coverage' }),
      }));
    } finally { probe.stop(); }
    const s = probe.summarize();
    expect(s.frames).toBe(1);
    expect(s.drawnFrames).toBe(1);
    expect(s.upload.totalBytes).toBe(10);
    expect(s.cpuMs.p50).toBeGreaterThan(0);
    // Each hot section is a span: cull, edl, upload and stream, in that order.
    const owners = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((k) => probe.ownerOf(k, k + 1));
    expect(new Set(owners.filter((o) => o !== 'unattributed'))).toEqual(new Set(['cull', 'edl', 'upload', 'stream']));
  });

  it('touches nothing when no probe runs', () => {
    expect(() => runRenderFrame(host())).not.toThrow();
  });
});

describe('LOD churn from the node store', () => {
  it('counts nodes entering and leaving the resident set', () => {
    const store = new StreamingNodeStore();
    const node = store.add({
      id: '0-0-0-0', key: { depth: 0, x: 0, y: 0, z: 0 }, depth: 0, bounds: [0, 0, 0, 1, 1, 1],
      pointCount: 10, byteOffset: 0, byteSize: 0, spacing: 1,
    });
    const { probe } = manual();
    probe.start();
    try {
      probe.frameBegin(0);
      store.setState(node, 'queued');
      store.setState(node, 'resident', 10);
      store.setState(node, 'resident', 10);
      store.setState(node, 'unloaded');
      probe.frameMs(16);
      probe.frameEnd(1000, true, false, 1, 'full-refine');
    } finally { probe.stop(); }
    expect(probe.summarize().lod).toMatchObject({ added: 1, removed: 1 });
  });
});

describe('GpuUploadQueue.lastResult', () => {
  it('holds the latest pass result', () => {
    const q = new GpuUploadQueue();
    expect(q.lastResult).toBeNull();
    const r = q.process(4);
    expect(q.lastResult).toBe(r);
    expect(r.stoppedBy).toBe('drained');
  });
});

describe('nav jank record', () => {
  it('builds a schema-valid record from probe output', () => {
    const { probe } = manual();
    [16, 16, 40, 16].forEach((ms, k) => frame(probe, k * 16, ms));
    probe.longTask(0, 60);
    const rec = buildNavJankRecord(ENV, [{ name: 'orbit', summary: probe.summarize() }, { name: 'pan', summary: probe.summarize() }]);
    expect(validateJsonSchema(SCHEMA, JSON.parse(JSON.stringify(rec)))).toEqual([]);
    expect(rec.summary).toMatchObject({ runs: 2, frames: 8, jankEvents: 2, longTasks: 2 });
  });

  it('rejects a record with a bad env', () => {
    const { probe } = manual();
    frame(probe, 16, 16);
    const rec = buildNavJankRecord(ENV, [{ name: 'x', summary: probe.summarize() }]) as unknown as Record<string, unknown>;
    const bad = JSON.parse(JSON.stringify(rec));
    bad.env.cache = 'lukewarm';
    delete bad.env.datasetSha256;
    bad.extra = 1;
    const errors = validateJsonSchema(SCHEMA, bad);
    expect(errors.some((e) => e.includes('env.cache'))).toBe(true);
    expect(errors.some((e) => e.includes('missing datasetSha256'))).toBe(true);
    expect(errors.some((e) => e.includes('unexpected extra'))).toBe(true);
    expect(() => buildNavJankRecord(ENV, [])).toThrow();
  });
});

describe('active window', () => {
  it('covers first input to the loop\'s first sleep after the last input, without idle wakes', () => {
    const { probe } = manual(128);
    // Before input: two heartbeat wakes of 258 ms.
    for (const end of [100, 358]) { probe.idleWake('heartbeat'); frame(probe, end, 258); }
    probe.input(400);
    // Input: 20 ms frames, one wake after a mid-run sleep (1000 ms delta), then EDL flapping after the last input.
    for (let k = 1; k <= 10; k++) frame(probe, 400 + k * 20, 20, true, false, 1, 'moving');
    probe.idleWake('wake');
    frame(probe, 1600, 1000, true, false, 1, 'moving');
    probe.input(1590);
    for (let k = 1; k <= 5; k++) frame(probe, 1600 + k * 20, 20, true, k >= 4, 1, 'full-refine');
    // Settled: the loop sleeps; heartbeat frames toggle EDL off and on after the last input.
    probe.idleWake('heartbeat'); frame(probe, 1958, 258, true, false);
    probe.idleWake('heartbeat'); frame(probe, 2216, 258, true, true);
    const s = probe.summarize();
    expect(s.idleWakes).toEqual({ heartbeat: 4, wake: 1 });
    expect(s.frameMs.p99).toBe(1000);
    expect(s.active.endReason).toBe('sleep');
    expect(s.active.durationMs).toBe(1700 - 400);
    expect(s.active.frames).toBe(15);
    expect(s.active.frameMs).toEqual({ p50: 20, p95: 20, p99: 20, samples: 15 });
    expect(s.active.over['100']).toBe(0);
    // 358 → 420 holds the first input; the 580 → 1600 gap ends at a wake frame and is not counted.
    expect(s.active.longestStarvationMs).toBe(62);
    // EDL on at 1680, off at 1958: one flap; last transition at 2216.
    expect(s.settle.postInputEdlFlaps).toBe(1);
    expect(s.settle.timeToStationaryQualityMs).toBe(2216 - 1590);
    expect(s.settle.finalEdl).toBe(1);
    expect(validateJsonSchema(SCHEMA, buildNavJankRecord(ENV, [{ name: 'a', summary: s }]))).toEqual([]);
  });

  it('takes the EDL state from drawn frames only', () => {
    const { probe } = manual();
    frame(probe, 100, 16, true, true);
    probe.idleWake('heartbeat');
    frame(probe, 358, 258, false, false);
    frame(probe, 374, 16, true, false);
    const s = probe.summarize();
    expect(s.quality.events.filter((e) => e.kind === 'edl')).toEqual([{ t: 374, kind: 'edl', from: 1, to: 0 }]);
  });

  it('is empty without input and runs to the end when the loop never sleeps', () => {
    const { probe } = manual();
    frame(probe, 100, 16);
    expect(probe.summarize().active.endReason).toBe('no-input');
    probe.input(110);
    frame(probe, 120, 16);
    frame(probe, 136, 16);
    const a = probe.summarize().active;
    expect(a.endReason).toBe('run-end');
    expect(a.frames).toBe(2);
  });
});
