/**
 * DebugOverlay.ts
 *
 * The `?debug=1` performance overlay — a small, fixed panel that reports live
 * rendering stats (frame rate, draw calls, point and memory footprint, GPU
 * backend) on a throttled cadence, plus the most recent load's telemetry and,
 * under `?benchmark=1`, a formal benchmark result.
 *
 * It is a developer diagnostic: gated entirely behind a URL flag, never shown
 * in a normal session. The overlay polls a sampler the app supplies — it holds
 * no reference to the Viewer itself, so it stays a pure DOM module.
 */

import { el } from './dom';
import type { FrameStats } from '../render/Viewer';
import type { LoadTelemetry } from '../io/loadTelemetry';
import { formatTelemetry } from '../io/loadTelemetry';

/** A live snapshot the overlay polls each tick. */
export interface DebugSample {
  /** The active GPU backend, or null before the renderer has initialised. */
  backend: 'webgpu' | 'webgl2' | null;
  /** Current frame stats, or null before the first frame has been timed. */
  stats: FrameStats | null;
}

/** Overlay refresh interval — about 4 Hz, deliberately never per frame. */
const REFRESH_MS = 250;

/** Render a byte count compactly: 25_000_000 → "23.8 MB". */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Render an integer with thousands separators: 4200000 → "4,200,000". */
function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * The `?debug=1` overlay panel. Construct it with a sampler, mount `element`,
 * then call {@link start}. The app feeds it load telemetry and, optionally, a
 * benchmark result as those become available.
 */
export class DebugOverlay {
  readonly element: HTMLElement;
  private readonly _live: HTMLElement;
  private readonly _telemetry: HTMLElement;
  private readonly _benchmark: HTMLElement;
  private readonly _sample: () => DebugSample;
  private _timer: number | undefined;

  constructor(sample: () => DebugSample) {
    this._sample = sample;

    this._live = el('pre', { className: 'olv-debug-block', text: 'initialising…' });
    this._telemetry = el('pre', {
      className: 'olv-debug-block',
      text: '(no scan loaded yet)',
    });
    this._benchmark = el('pre', { className: 'olv-debug-block' });
    this._benchmark.style.display = 'none';

    this.element = el('div', { className: 'olv-debug' }, [
      el('div', { className: 'olv-debug-title', text: 'OpenLiDARViewer · debug' }),
      el('div', { className: 'olv-debug-label', text: 'rendering' }),
      this._live,
      el('div', { className: 'olv-debug-label', text: 'last load' }),
      this._telemetry,
      this._benchmark,
    ]);
  }

  /** Begin polling the sampler. Idempotent. */
  start(): void {
    if (this._timer !== undefined) return;
    this._refresh();
    this._timer = window.setInterval(() => this._refresh(), REFRESH_MS);
  }

  /** Stop polling and release the interval timer. */
  stop(): void {
    if (this._timer !== undefined) {
      window.clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  /** Show the telemetry from the most recent file load. */
  setTelemetry(telemetry: LoadTelemetry): void {
    this._telemetry.textContent = formatTelemetry(telemetry);
  }

  /** Show a formatted benchmark result (a `?benchmark=1` run). */
  setBenchmark(text: string): void {
    this._benchmark.textContent = text;
    this._benchmark.style.display = '';
  }

  /** Re-read the sampler and repaint the live block. */
  private _refresh(): void {
    const { backend, stats } = this._sample();
    const backendLabel =
      backend === 'webgpu' ? 'WebGPU' : backend === 'webgl2' ? 'WebGL 2' : '—';

    if (!stats) {
      this._live.textContent = `backend       ${backendLabel}\n(initialising…)`;
      return;
    }

    this._live.textContent = [
      `backend       ${backendLabel}`,
      `fps           ${stats.fps.toFixed(0)}  (${stats.frameMs.toFixed(1)} ms)`,
      `draw calls    ${stats.drawCalls}`,
      `points        ${formatInt(stats.displayedPoints)} shown` +
        ` / ${formatInt(stats.totalPoints)} total`,
      `gpu estimate  ${formatBytes(stats.gpuBytesEstimate)}`,
    ].join('\n');
  }
}
