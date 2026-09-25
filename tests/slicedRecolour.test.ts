/**
 * Sliced recolour: byte identity with the synchronous path, cancellation,
 * partial-range uploads, and the main-thread block it removes.
 *
 * The perf case prints the longest synchronous block against the longest
 * sliced batch on a synthetic cloud; it asserts byte identity, not wall time.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import {
  colorForMode,
  recolourEntry,
  writeModeColours,
  SLICED_RECOLOUR_MIN_POINTS,
  type ColorForModeOptions,
  type ColorMode,
  type CoverageColorGrid,
} from '../src/render/colorModes';
import { writeFloatColorsInto } from '../src/render/colorEncode';
import { runSlicedRecolour, SLICE_CHUNK_POINTS, type SliceScheduler } from '../src/render/slicedRecolour';

function synthCloud(n: number): PointCloud {
  const positions = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 3);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  const normals = new Float32Array(n * 3);
  const returnNumber = new Uint8Array(n);
  const gpsTime = new Float64Array(n);
  let s = 12345;
  const rnd = (): number => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  for (let i = 0; i < n; i++) {
    const x = rnd() * 500, y = rnd() * 500;
    positions[i * 3] = x; positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = 20 * Math.sin(x / 40) + 10 * Math.cos(y / 30) + rnd() * 3;
    colors[i * 3] = (i * 7) & 255; colors[i * 3 + 1] = (i * 13) & 255; colors[i * 3 + 2] = (i * 29) & 255;
    intensity[i] = Math.floor(rnd() * 65535);
    classification[i] = [1, 2, 3, 5, 6, 9][i % 6];
    normals[i * 3] = rnd() - 0.5; normals[i * 3 + 1] = rnd() - 0.5; normals[i * 3 + 2] = 1;
    returnNumber[i] = 1 + (i % 4);
    gpsTime[i] = 3e8 + i * 1e-4;
  }
  return new PointCloud({
    positions, colors, intensity, classification, normals, returnNumber, gpsTime,
    origin: [0, 0, 0], sourceFormat: 'las', name: 'synthetic.las',
  });
}

const grid: CoverageColorGrid = (() => {
  const cols = 50, rows = 50;
  const confidence = new Float32Array(cols * rows).map((_, i) => (i * 37) % 101);
  const coverage = new Uint8Array(cols * rows).map((_, i) => (i % 11 === 0 ? 0 : 1));
  return { cols, rows, cellSizeM: 10, originH1: 0, originH2: 0, confidence, coverage };
})();

const OPTS: ColorForModeOptions = { heightPercentileTrim: 5, upAxis: 2, coverageGrid: grid };
const MODES: ColorMode[] = [
  'rgb', 'elevation', 'intensity', 'classification', 'normal', 'returnNumber',
  'gpsTime', 'density', 'coverage', 'confidence',
];

interface Attr { array: Float32Array; needsUpdate: boolean; ranges: Array<{ start: number; count: number }>;
  addUpdateRange(start: number, count: number): void; clearUpdateRanges(): void }
function attr(n: number): Attr {
  return {
    array: new Float32Array(n * 3), needsUpdate: false, ranges: [],
    addUpdateRange(start, count) { this.ranges.push({ start, count }); },
    clearUpdateRanges() { this.ranges.length = 0; },
  };
}

/** Runs queued batches on demand; the clock advances a fixed step per read. */
function manualScheduler(stepMs: number): SliceScheduler & { queue: Array<() => void>; drain(): number } {
  let t = 0;
  const queue: Array<() => void> = [];
  return {
    queue,
    next: (run) => { queue.push(run); },
    now: () => (t += stepMs),
    drain() { let k = 0; while (queue.length) { queue.shift()!(); k++; } return k; },
  };
}

const digest = (a: Float32Array): string =>
  createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex');

describe('sliced recolour', () => {
  const N = 300_000;
  const cloud = synthCloud(N);

  it.each(MODES)('%s: sliced bytes are identical to the synchronous write', async (mode) => {
    const expected = new Float32Array(N * 3);
    writeFloatColorsInto(expected, colorForMode(mode, cloud, OPTS));
    const entry = { cloud, colorAttr: attr(N), recolourJob: undefined as object | undefined };
    const job = {}; entry.recolourJob = job;
    const sched = manualScheduler(1);
    const done = runSlicedRecolour(entry, job, mode, OPTS, () => {}, sched, 2);
    const batches = sched.drain() + 1;
    expect(await done).toBe(true);
    expect(batches).toBeGreaterThan(1);
    expect(digest(entry.colorAttr.array)).toBe(digest(expected));
    // Ranges tile the buffer exactly, in order.
    let at = 0;
    for (const r of entry.colorAttr.ranges) { expect(r.start).toBe(at); at += r.count; }
    expect(at).toBe(N * 3);
    expect(entry.recolourJob).toBeUndefined();
  });

  it('a newer job or a whole-buffer write stops a stale job', async () => {
    const entry = { cloud, colorAttr: attr(N), recolourJob: undefined as object | undefined };
    const sched = manualScheduler(1);
    const a = {}; entry.recolourJob = a;
    const first = runSlicedRecolour(entry, a, 'elevation', OPTS, () => {}, sched, 2);
    const b = {}; entry.recolourJob = b;
    const second = runSlicedRecolour(entry, b, 'classification', OPTS, () => {}, sched, 2);
    sched.drain();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    const expected = new Float32Array(N * 3);
    writeFloatColorsInto(expected, colorForMode('classification', cloud, OPTS));
    expect(digest(entry.colorAttr.array)).toBe(digest(expected));

    const c = {}; entry.recolourJob = c;
    const third = runSlicedRecolour(entry, c, 'intensity', OPTS, () => {}, sched, 2);
    writeModeColours(entry, colorForMode('rgb', cloud, OPTS));
    expect(entry.colorAttr.ranges).toHaveLength(0);
    sched.drain();
    expect(await third).toBe(false);
    const rgb = new Float32Array(N * 3);
    writeFloatColorsInto(rgb, cloud.colors!);
    expect(digest(entry.colorAttr.array)).toBe(digest(rgb));
  });

  it('small clouds keep the synchronous path', () => {
    const small = synthCloud(1000);
    const entry = { cloud: small, colorAttr: attr(1000), mode: 'rgb' as ColorMode };
    let changed = 0;
    recolourEntry(entry, 'elevation', OPTS, () => { changed++; }, () => import('../src/render/slicedRecolour'));
    const expected = new Float32Array(3000);
    writeFloatColorsInto(expected, colorForMode('elevation', small, OPTS));
    expect(entry.mode).toBe('elevation');
    expect(changed).toBe(1);
    expect(digest(entry.colorAttr.array)).toBe(digest(expected));
    expect(SLICED_RECOLOUR_MIN_POINTS).toBeGreaterThan(1000);
  });

  it('reports the longest main-thread block, synchronous vs sliced', async () => {
    const n = Number(process.env.OLV_RECOLOUR_BENCH_POINTS ?? 5_000_000);
    const big = synthCloud(n);
    const out: string[] = [];
    for (const mode of ['elevation', 'intensity', 'classification', 'rgb', 'density'] as ColorMode[]) {
      const dst = new Float32Array(n * 3);
      const t0 = performance.now();
      writeFloatColorsInto(dst, colorForMode(mode, big, OPTS));
      const sync = performance.now() - t0;

      const entry = { cloud: big, colorAttr: attr(n), recolourJob: undefined as object | undefined };
      const job = {}; entry.recolourJob = job;
      const queue: Array<() => void> = [];
      const sched: SliceScheduler = { next: (r) => { queue.push(r); }, now: () => performance.now() };
      let longest = 0, first = 0, batches = 0;
      const timed = (run: () => void): void => {
        const s = performance.now(); run(); const d = performance.now() - s;
        if (batches === 0) first = d; else longest = Math.max(longest, d);
        batches++;
      };
      let done!: Promise<boolean>;
      timed(() => { done = runSlicedRecolour(entry, job, mode, OPTS, () => {}, sched); });
      while (queue.length) timed(queue.shift()!);
      expect(await done).toBe(true);
      expect(digest(entry.colorAttr.array)).toBe(digest(dst));
      out.push(`${mode}: sync ${sync.toFixed(1)} ms | sliced first batch ${first.toFixed(1)} ms, later max ${longest.toFixed(1)} ms over ${batches} batches`);
    }
    console.log(`[slicedRecolour] ${n} points, chunk ${SLICE_CHUNK_POINTS}\n  ${out.join('\n  ')}`);
  }, 300_000);
});
