/**
 * Navigation frame probe: a per-frame recorder for heavy-navigation runs.
 *
 * Loaded only under `?benchmark=nav`. While recording, the render loop reports
 * into it through {@link setNavSink}; while stopped, the sink is null and the
 * render path does nothing beyond a null check.
 *
 * Storage is a struct-of-arrays ring of typed columns sized once at
 * construction, so recording a frame writes numbers into preallocated slots and
 * allocates nothing. Inputs, spans, long tasks and quality transitions use the
 * same kind of ring. All allocation happens in {@link NavProbe.summarize}.
 *
 * Definitions used by the summary:
 * - frame time: the viewer's accepted clock delta for the frame (the value its
 *   own frame recorder keeps; the first frame after an idle gap is excluded).
 * - jank event: a frame whose time exceeds twice the median frame time of the
 *   run.
 * - jank burst: a run of two or more consecutive jank frames.
 * - input to draw: from an input event's `timeStamp` to the end of the first
 *   drawn frame at or after it.
 * - starvation: the gap between two consecutive drawn frames when an input
 *   event falls within that gap or within {@link INPUT_ACTIVE_MS} before it
 *   starts; the longest such gap is reported.
 * - long task owner: the probe span ('olv:upload', 'olv:stream', 'olv:edl',
 *   'olv:cull') with the largest time overlap with the task, else
 *   'unattributed'.
 */
import { percentileSorted } from './frameTelemetry';
import { setNavSink, type NavProbeSink, type NavSpanName, type NavUploadSample } from './navProbeHook';

/** Default frame capacity: ten minutes at 60 Hz. */
export const NAV_PROBE_FRAMES = 36_000;
/** An input keeps the loop "input active" for this long after it. */
export const INPUT_ACTIVE_MS = 250;
/** Frame-time thresholds counted by the summary, in ms. */
export const FRAME_THRESHOLDS_MS = [16.7, 33.3, 50, 100] as const;

const SPAN_NAMES: readonly NavSpanName[] = ['olv:upload', 'olv:stream', 'olv:edl', 'olv:cull'];
const STOPPED_BY = ['none', 'drained', 'time', 'bytes', 'nodes'] as const;
const PHASES = ['moving', 'coverage', 'center-refine', 'full-refine'] as const;
const QUALITY_KINDS = ['edl', 'dpr', 'phase'] as const;
const OWNERS = ['upload', 'stream', 'edl', 'cull', 'unattributed'] as const;

export type LongTaskOwner = (typeof OWNERS)[number];
export type QualityKind = (typeof QUALITY_KINDS)[number];

function phaseCode(phase: string): number {
  const i = (PHASES as readonly string[]).indexOf(phase);
  return i < 0 ? 255 : i;
}

function phaseName(code: number): string {
  return PHASES[code] ?? 'unknown';
}

/** A fixed-capacity ring index: `slot()` returns the next write position. */
class RingIndex {
  write = 0;
  count = 0;
  readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  slot(): number {
    const i = this.write;
    this.write = (this.write + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return i;
  }
  /** Physical index of the k-th oldest entry. */
  at(k: number): number {
    return (this.write - this.count + k + this.capacity) % this.capacity;
  }
  reset(): void {
    this.write = 0;
    this.count = 0;
  }
}

interface LongTaskEntryLike { startTime: number; duration: number }
interface LongTaskObserverLike { observe(o: { type: string; buffered?: boolean }): void; disconnect(): void }
type LongTaskObserverCtor = new (cb: (list: { getEntries(): LongTaskEntryLike[] }) => void) => LongTaskObserverLike;

export interface NavProbeOptions {
  frames?: number;
  now?: () => number;
  /** Long-task observer constructor; null disables it. Default: the global one when it supports 'longtask'. */
  performanceObserver?: LongTaskObserverCtor | null;
  /** Write performance.measure entries for spans. Default true. */
  measures?: boolean;
}

export interface QualityTransition { t: number; kind: QualityKind; from: number | string; to: number | string }

export interface NavProbeSummary {
  frames: number;
  drawnFrames: number;
  durationMs: number;
  frameMs: { p50: number; p95: number; p99: number; samples: number };
  cpuMs: { p50: number; p95: number; p99: number };
  over: { '16.7': number; '33.3': number; '50': number; '100': number };
  jank: { thresholdMs: number; events: number; bursts: number; longestBurst: number };
  inputToDrawMs: { p50: number; p95: number; samples: number };
  longestStarvationMs: number;
  upload: { passes: number; p95Ms: number; p95Bytes: number; totalBytes: number; stoppedBy: Record<string, number> };
  lod: { added: number; removed: number; churnPerSec: number };
  quality: { transitions: number; byKind: Record<QualityKind, number>; events: QualityTransition[] };
  longTasks: { count: number; byOwner: Record<LongTaskOwner, { count: number; totalMs: number }> };
}

/** Upper bound on transition events listed verbatim in a summary. */
const MAX_LISTED_TRANSITIONS = 200;

function sortedCopy(src: Float64Array | Float32Array, n: number): Float64Array {
  const out = new Float64Array(n);
  out.set(src.subarray(0, n));
  out.sort();
  return out;
}

function pct(sorted: Float64Array, p: number): number {
  return percentileSorted(sorted, sorted.length, p);
}

export class NavProbe implements NavProbeSink {
  readonly now: () => number;
  private readonly _obsCtor: LongTaskObserverCtor | null;
  private readonly _measures: boolean;

  // Frame columns.
  private readonly _f: RingIndex;
  private readonly _tEnd: Float64Array;
  private readonly _raf: Float32Array;
  private readonly _cpu: Float32Array;
  private readonly _upMs: Float32Array;
  private readonly _upBytes: Float64Array;
  private readonly _upNodes: Uint16Array;
  private readonly _stop: Uint8Array;
  private readonly _commits: Uint8Array;
  private readonly _lodAdd: Uint16Array;
  private readonly _lodRem: Uint16Array;
  private readonly _edl: Uint8Array;
  private readonly _dpr: Float32Array;
  private readonly _phase: Uint8Array;
  private readonly _drawn: Uint8Array;

  // Event rings.
  private readonly _in = new RingIndex(8192);
  private readonly _inT = new Float64Array(8192);
  private readonly _sp = new RingIndex(16384);
  private readonly _spName = new Uint8Array(16384);
  private readonly _spStart = new Float64Array(16384);
  private readonly _spEnd = new Float64Array(16384);
  private readonly _lt = new RingIndex(2048);
  private readonly _ltStart = new Float64Array(2048);
  private readonly _ltDur = new Float64Array(2048);
  private readonly _q = new RingIndex(4096);
  private readonly _qT = new Float64Array(4096);
  private readonly _qKind = new Uint8Array(4096);
  private readonly _qFrom = new Float32Array(4096);
  private readonly _qTo = new Float32Array(4096);

  // Current-frame accumulators.
  private _begin = NaN;
  private _curRaf = NaN;
  private _curUpMs = 0;
  private _curUpBytes = 0;
  private _curUpNodes = 0;
  private _curStop = 0;
  private _curCommits = 0;
  private _curLodAdd = 0;
  private _curLodRem = 0;
  private _prevEdl = -1;
  private _prevDpr = -1;
  private _prevPhase = -1;
  private _startedAt = 0;

  private _observer: LongTaskObserverLike | null = null;
  private _running = false;
  private _win: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = null;
  private readonly _onInput = (e: Event): void => {
    if (e.type === 'pointermove' && (e as PointerEvent).buttons === 0) return;
    this.input(e.timeStamp);
  };

  constructor(options: NavProbeOptions = {}) {
    const n = options.frames ?? NAV_PROBE_FRAMES;
    this._f = new RingIndex(n);
    this._tEnd = new Float64Array(n);
    this._raf = new Float32Array(n);
    this._cpu = new Float32Array(n);
    this._upMs = new Float32Array(n);
    this._upBytes = new Float64Array(n);
    this._upNodes = new Uint16Array(n);
    this._stop = new Uint8Array(n);
    this._commits = new Uint8Array(n);
    this._lodAdd = new Uint16Array(n);
    this._lodRem = new Uint16Array(n);
    this._edl = new Uint8Array(n);
    this._dpr = new Float32Array(n);
    this._phase = new Uint8Array(n);
    this._drawn = new Uint8Array(n);
    this.now = options.now ?? (() => performance.now());
    this._measures = options.measures ?? true;
    if (options.performanceObserver !== undefined) {
      this._obsCtor = options.performanceObserver;
    } else {
      const po = (globalThis as { PerformanceObserver?: LongTaskObserverCtor & { supportedEntryTypes?: readonly string[] } })
        .PerformanceObserver;
      this._obsCtor = po?.supportedEntryTypes?.includes('longtask') ? po : null;
    }
  }

  get running(): boolean {
    return this._running;
  }

  /** Frames currently held (at most the capacity). */
  get frameCount(): number {
    return this._f.count;
  }

  /** Clear all rings and start recording; installs the sink and listeners. */
  start(win?: Pick<Window, 'addEventListener' | 'removeEventListener'>): void {
    if (this._running) return;
    this.reset();
    this._running = true;
    this._startedAt = this.now();
    if (win) {
      this._win = win;
      for (const t of ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const) {
        win.addEventListener(t, this._onInput, { capture: true, passive: true });
      }
    }
    if (this._obsCtor) {
      try {
        this._observer = new this._obsCtor((list) => {
          for (const e of list.getEntries()) this.longTask(e.startTime, e.duration);
        });
        this._observer.observe({ type: 'longtask', buffered: false });
      } catch {
        this._observer = null;
      }
    }
    setNavSink(this);
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    setNavSink(null);
    this._observer?.disconnect();
    this._observer = null;
    if (this._win) {
      for (const t of ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const) {
        this._win.removeEventListener(t, this._onInput, { capture: true });
      }
      this._win = null;
    }
    if (this._measures && typeof performance.clearMeasures === 'function') {
      for (const name of SPAN_NAMES) performance.clearMeasures(name);
    }
  }

  reset(): void {
    this._f.reset();
    this._in.reset();
    this._sp.reset();
    this._lt.reset();
    this._q.reset();
    this._clearFrame();
    this._prevEdl = -1;
    this._prevDpr = -1;
    this._prevPhase = -1;
  }

  private _clearFrame(): void {
    this._begin = NaN;
    this._curRaf = NaN;
    this._curUpMs = 0;
    this._curUpBytes = 0;
    this._curUpNodes = 0;
    this._curStop = 0;
    this._curCommits = 0;
    this._curLodAdd = 0;
    this._curLodRem = 0;
  }

  // ---- sink ---------------------------------------------------------------

  frameMs(ms: number): void {
    this._curRaf = ms;
  }

  frameBegin(t: number): void {
    this._begin = t;
  }

  upload(sample: NavUploadSample | null | undefined, ms: number): void {
    this._curCommits = 1;
    this._curUpMs += ms;
    if (!sample) return;
    this._curUpBytes += sample.uploadedBytes;
    this._curUpNodes += sample.uploaded;
    this._curStop = STOPPED_BY.indexOf(sample.stoppedBy);
  }

  lodChange(added: number, removed: number): void {
    this._curLodAdd += added;
    this._curLodRem += removed;
  }

  span(name: NavSpanName, start: number, end: number): void {
    const i = this._sp.slot();
    this._spName[i] = SPAN_NAMES.indexOf(name);
    this._spStart[i] = start;
    this._spEnd[i] = end;
    if (this._measures) {
      try {
        performance.measure(name, { start, end });
      } catch {
        // measure() with options is unsupported on very old engines.
      }
    }
  }

  frameEnd(t: number, drawn: boolean, edl: boolean, dpr: number, phase: string): void {
    const i = this._f.slot();
    const edlOn = edl ? 1 : 0;
    const ph = phaseCode(phase);
    this._tEnd[i] = t;
    this._raf[i] = this._curRaf;
    this._cpu[i] = Number.isNaN(this._begin) ? NaN : t - this._begin;
    this._upMs[i] = this._curUpMs;
    this._upBytes[i] = this._curUpBytes;
    this._upNodes[i] = Math.min(this._curUpNodes, 0xffff);
    this._stop[i] = this._curStop;
    this._commits[i] = this._curCommits;
    this._lodAdd[i] = Math.min(this._curLodAdd, 0xffff);
    this._lodRem[i] = Math.min(this._curLodRem, 0xffff);
    this._edl[i] = edlOn;
    this._dpr[i] = dpr;
    this._phase[i] = ph;
    this._drawn[i] = drawn ? 1 : 0;
    if (this._prevEdl >= 0) {
      if (this._prevEdl !== edlOn) this._transition(t, 0, this._prevEdl, edlOn);
      if (this._prevDpr !== Math.fround(dpr)) this._transition(t, 1, this._prevDpr, dpr);
      if (this._prevPhase !== ph) this._transition(t, 2, this._prevPhase, ph);
    }
    this._prevEdl = edlOn;
    this._prevDpr = Math.fround(dpr);
    this._prevPhase = ph;
    this._clearFrame();
  }

  private _transition(t: number, kind: number, from: number, to: number): void {
    const i = this._q.slot();
    this._qT[i] = t;
    this._qKind[i] = kind;
    this._qFrom[i] = from;
    this._qTo[i] = to;
  }

  /** Record an input event time (the event's `timeStamp`). */
  input(t: number): void {
    this._inT[this._in.slot()] = t;
  }

  /** Record a long task. */
  longTask(start: number, duration: number): void {
    const i = this._lt.slot();
    this._ltStart[i] = start;
    this._ltDur[i] = duration;
  }

  // ---- summary ------------------------------------------------------------

  /** The span owner with the largest overlap with [start, end], or 'unattributed'. */
  ownerOf(start: number, end: number): LongTaskOwner {
    let best = -1;
    let bestOverlap = 0;
    for (let k = 0; k < this._sp.count; k++) {
      const i = this._sp.at(k);
      const overlap = Math.min(end, this._spEnd[i]) - Math.max(start, this._spStart[i]);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = this._spName[i];
      }
    }
    return best < 0 ? 'unattributed' : OWNERS[best];
  }

  summarize(): NavProbeSummary {
    const n = this._f.count;
    const raf = new Float64Array(n);
    const cpu = new Float64Array(n);
    const upMs: number[] = [];
    const upBytes: number[] = [];
    const drawnT: number[] = [];
    const stoppedBy: Record<string, number> = { drained: 0, time: 0, bytes: 0, nodes: 0 };
    let rafN = 0;
    let cpuN = 0;
    let lodAdded = 0;
    let lodRemoved = 0;
    let totalBytes = 0;
    const rafInOrder = new Float64Array(n).fill(NaN);
    for (let k = 0; k < n; k++) {
      const i = this._f.at(k);
      const r = this._raf[i];
      if (!Number.isNaN(r)) {
        raf[rafN++] = r;
        rafInOrder[k] = r;
      }
      const c = this._cpu[i];
      if (!Number.isNaN(c)) cpu[cpuN++] = c;
      if (this._commits[i]) {
        upMs.push(this._upMs[i]);
        upBytes.push(this._upBytes[i]);
        totalBytes += this._upBytes[i];
        const s = STOPPED_BY[this._stop[i]];
        if (s !== 'none') stoppedBy[s]++;
      }
      lodAdded += this._lodAdd[i];
      lodRemoved += this._lodRem[i];
      if (this._drawn[i]) drawnT.push(this._tEnd[i]);
    }
    const rafSorted = sortedCopy(raf, rafN);
    const cpuSorted = sortedCopy(cpu, cpuN);
    const median = pct(rafSorted, 50);
    const over = { '16.7': 0, '33.3': 0, '50': 0, '100': 0 };
    for (let k = 0; k < rafN; k++) {
      const v = raf[k];
      if (v > FRAME_THRESHOLDS_MS[0]) over['16.7']++;
      if (v > FRAME_THRESHOLDS_MS[1]) over['33.3']++;
      if (v > FRAME_THRESHOLDS_MS[2]) over['50']++;
      if (v > FRAME_THRESHOLDS_MS[3]) over['100']++;
    }
    const jank = jankStats(rafInOrder, 2 * median);

    const inputs: number[] = [];
    for (let k = 0; k < this._in.count; k++) inputs.push(this._inT[this._in.at(k)]);
    inputs.sort((a, b) => a - b);
    const i2d = inputToDraw(inputs, drawnT);
    const i2dSorted = Float64Array.from(i2d).sort();

    const byOwner = Object.fromEntries(OWNERS.map((o) => [o, { count: 0, totalMs: 0 }])) as NavProbeSummary['longTasks']['byOwner'];
    for (let k = 0; k < this._lt.count; k++) {
      const i = this._lt.at(k);
      const owner = this.ownerOf(this._ltStart[i], this._ltStart[i] + this._ltDur[i]);
      byOwner[owner].count++;
      byOwner[owner].totalMs += this._ltDur[i];
    }

    const byKind: Record<QualityKind, number> = { edl: 0, dpr: 0, phase: 0 };
    const events: QualityTransition[] = [];
    for (let k = 0; k < this._q.count; k++) {
      const i = this._q.at(k);
      const kind = QUALITY_KINDS[this._qKind[i]];
      byKind[kind]++;
      if (events.length < MAX_LISTED_TRANSITIONS) {
        const decode = (v: number): number | string => (kind === 'phase' ? phaseName(v) : v);
        events.push({ t: this._qT[i], kind, from: decode(this._qFrom[i]), to: decode(this._qTo[i]) });
      }
    }

    const first = n > 0 ? this._tEnd[this._f.at(0)] - (Number.isNaN(this._cpu[this._f.at(0)]) ? 0 : this._cpu[this._f.at(0)]) : 0;
    const durationMs = n > 0 ? this._tEnd[this._f.at(n - 1)] - first : 0;
    const upMsSorted = Float64Array.from(upMs).sort();
    const upBytesSorted = Float64Array.from(upBytes).sort();

    return {
      frames: n,
      drawnFrames: drawnT.length,
      durationMs,
      frameMs: { p50: median, p95: pct(rafSorted, 95), p99: pct(rafSorted, 99), samples: rafN },
      cpuMs: { p50: pct(cpuSorted, 50), p95: pct(cpuSorted, 95), p99: pct(cpuSorted, 99) },
      over,
      jank: { thresholdMs: 2 * median, ...jank },
      inputToDrawMs: { p50: pct(i2dSorted, 50), p95: pct(i2dSorted, 95), samples: i2d.length },
      longestStarvationMs: longestStarvation(inputs, drawnT, INPUT_ACTIVE_MS),
      upload: { passes: upMs.length, p95Ms: pct(upMsSorted, 95), p95Bytes: pct(upBytesSorted, 95), totalBytes, stoppedBy },
      lod: { added: lodAdded, removed: lodRemoved, churnPerSec: durationMs > 0 ? ((lodAdded + lodRemoved) * 1000) / durationMs : 0 },
      quality: { transitions: this._q.count, byKind, events },
      longTasks: { count: this._lt.count, byOwner },
    };
  }

  /** Milliseconds since `start()`. */
  elapsedMs(): number {
    return this.now() - this._startedAt;
  }
}

/**
 * Jank events and bursts over frame times in recording order (NaN = no
 * sample, which neither counts nor breaks a burst's adjacency).
 */
export function jankStats(frameMs: ArrayLike<number>, thresholdMs: number): { events: number; bursts: number; longestBurst: number } {
  let events = 0;
  let bursts = 0;
  let run = 0;
  let longestBurst = 0;
  const close = (): void => {
    if (run >= 2) {
      bursts++;
      if (run > longestBurst) longestBurst = run;
    }
    run = 0;
  };
  for (let k = 0; k < frameMs.length; k++) {
    const v = frameMs[k];
    if (Number.isNaN(v)) continue;
    if (thresholdMs > 0 && v > thresholdMs) {
      events++;
      run++;
    } else {
      close();
    }
  }
  close();
  return { events, bursts, longestBurst };
}

/** For each input (ascending), the delay to the first drawn frame end at or after it. Unanswered inputs are omitted. */
export function inputToDraw(inputsAsc: readonly number[], drawnAsc: readonly number[]): number[] {
  const out: number[] = [];
  let j = 0;
  for (const t of inputsAsc) {
    while (j < drawnAsc.length && drawnAsc[j] < t) j++;
    if (j >= drawnAsc.length) break;
    out.push(drawnAsc[j] - t);
  }
  return out;
}

/** Longest gap between consecutive drawn frames that an input fell in, or within `activeMs` before. */
export function longestStarvation(inputsAsc: readonly number[], drawnAsc: readonly number[], activeMs: number): number {
  let longest = 0;
  let j = 0;
  for (let k = 1; k < drawnAsc.length; k++) {
    const a = drawnAsc[k - 1];
    const b = drawnAsc[k];
    while (j < inputsAsc.length && inputsAsc[j] < a - activeMs) j++;
    if (j < inputsAsc.length && inputsAsc[j] <= b && b - a > longest) longest = b - a;
  }
  return longest;
}
