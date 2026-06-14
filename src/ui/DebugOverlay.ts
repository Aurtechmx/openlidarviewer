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

/** Live COPC streaming counters — present only while a COPC scan is open. */
export interface StreamingDebugStats {
  knownNodes: number;
  visibleNodes: number;
  queuedNodes: number;
  loadingNodes: number;
  residentNodes: number;
  displayedPoints: number;
  sourcePoints: number;
  /** Compressed-cache LRU current bytes. */
  cacheBytes: number;
  /**
   * CPU-side decoded bytes currently held by resident nodes,
   * estimated from `residentPointCount × DECODED_BYTES_PER_POINT`. Optional.
   */
  decodedBytes?: number;
  /** GPU upload-estimate bytes. */
  gpuBytes: number;
  /** Most recent scheduler tick wall time, in milliseconds. */
  schedulerMs: number;
  /**
   * Aggregate scheduler-tick stats over the recent window (last 60 by
   * default). Optional — present only when the streaming benchmark is
   * collecting (the overlay shows a single-tick value otherwise).
   */
  schedulerRecent?: {
    count: number;
    p50: number;
    p95: number;
    max: number;
  };
  /** Cumulative compressed-cache outcomes since the scan opened. Optional. */
  cacheHits?: number;
  cacheMisses?: number;
  cacheEvictions?: number;
  /**
   * Decoded / GPU tier cumulative event counts. Uploads = nodes
   * becoming resident; evictions = nodes leaving the resident set. Optional.
   */
  nodesReady?: number;
  nodesEvicted?: number;
  /** Cumulative load → evict → reload events within the thrash window. Optional. */
  thrashEvents?: number;
}

/** A live snapshot the overlay polls each tick. */
export interface DebugSample {
  /** The active GPU backend, or null before the renderer has initialised. */
  backend: 'webgpu' | 'webgl2' | null;
  /** Current frame stats, or null before the first frame has been timed. */
  stats: FrameStats | null;
  /** Streaming counters, or null/absent when no COPC scan is streaming. */
  streaming?: StreamingDebugStats | null;
  /**
   * Terrain raster compute path of the MAIN-thread engine (the once-per-session
   * CPU/GPU equivalence-gate verdict), or null before any main-thread terrain
   * run. Debug/details only — never surfaced in the main UI.
   */
  terrainCompute?: { path: 'cpu' | 'gpu'; reason: string } | null;
}

/**
 * Human label for the terrain compute path — the CPU/GPU equivalence-gate
 * verdict in plain words. Pure; exported for the overlay test.
 */
export function formatTerrainCompute(
  tc: { path: 'cpu' | 'gpu'; reason: string } | null | undefined,
): string {
  if (!tc) return '— (no main-thread run)';
  if (tc.path === 'gpu') return 'GPU validated';
  switch (tc.reason) {
    case 'gpu-dispatch-failed':
      return 'GPU demoted to CPU';
    case 'probe-mismatch':
      return 'CPU reference (probe mismatch)';
    case 'webgpu-unavailable':
    case 'device-request-failed':
      return 'CPU reference (no GPU)';
    case 'not-initialised':
      return 'CPU (idle)';
    default:
      return `CPU reference (${tc.reason})`;
  }
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
  private readonly _streamingLabel: HTMLElement;
  private readonly _streaming: HTMLElement;
  private readonly _telemetry: HTMLElement;
  private readonly _benchmark: HTMLElement;
  private readonly _sample: () => DebugSample;
  private _timer: number | undefined;

  constructor(sample: () => DebugSample) {
    this._sample = sample;

    this._live = el('pre', { className: 'olv-debug-block', text: 'initialising…' });
    this._streamingLabel = el('div', {
      className: 'olv-debug-label olv-hidden',
      text: 'streaming',
    });
    this._streaming = el('pre', { className: 'olv-debug-block olv-hidden' });
    this._telemetry = el('pre', {
      className: 'olv-debug-block',
      text: '(no scan loaded yet)',
    });
    this._benchmark = el('pre', { className: 'olv-debug-block olv-hidden' });

    // The title doubles as a collapse toggle: the overlay sits over the
    // top-left Analyse panel, so a developer reading it needs to tuck it out of
    // the way to reach the panel's verdict + "Re-run analysis". Collapsed, only
    // this one-line bar remains (clearing the panel below); a caret shows state.
    const caret = el('span', { className: 'olv-debug-caret', text: '▾' });
    caret.setAttribute('aria-hidden', 'true');
    const title = el('button', {
      className: 'olv-debug-title',
      type: 'button',
      ariaLabel: 'Collapse debug overlay',
    }, [el('span', { text: 'OpenLiDARViewer · debug' }), caret]);
    title.setAttribute('aria-expanded', 'true');
    title.addEventListener('click', () => this.toggleCollapsed());
    this._title = title;

    this._body = el('div', { className: 'olv-debug-body' }, [
      el('div', { className: 'olv-debug-label', text: 'rendering' }),
      this._live,
      this._streamingLabel,
      this._streaming,
      el('div', { className: 'olv-debug-label', text: 'last load' }),
      this._telemetry,
      this._benchmark,
    ]);

    this.element = el('div', { className: 'olv-debug' }, [title, this._body]);
  }

  private _title!: HTMLButtonElement;
  private _body!: HTMLElement;
  private _collapsed = false;

  /** Collapse to just the title bar, or expand back. */
  toggleCollapsed(): void {
    this.setCollapsed(!this._collapsed);
  }

  setCollapsed(collapsed: boolean): void {
    this._collapsed = collapsed;
    this.element.classList.toggle('is-collapsed', collapsed);
    this._title.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    this._title.setAttribute('aria-label', collapsed ? 'Expand debug overlay' : 'Collapse debug overlay');
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
    this._benchmark.classList.remove('olv-hidden');
  }

  /** Re-read the sampler and repaint the live block. */
  private _refresh(): void {
    const { backend, stats, streaming, terrainCompute } = this._sample();
    const backendLabel =
      backend === 'webgpu' ? 'WebGPU' : backend === 'webgl2' ? 'WebGL 2' : '—';

    if (stats) {
      this._live.textContent = [
        `backend       ${backendLabel}`,
        `fps           ${stats.fps.toFixed(0)}  (${stats.frameMs.toFixed(1)} ms)`,
        // A WebGPU backend can report 0 draw calls even while millions of
        // points are clearly on screen (the EDL post-pipeline / streaming path
        // doesn't always populate renderer.info). A bare "0" then reads as
        // false; surface "—" (unmeasured) instead so the overlay never asserts
        // an obviously-wrong count.
        `draw calls    ${stats.drawCalls > 0 || stats.displayedPoints === 0 ? stats.drawCalls : '—'}`,
        `points        ${formatInt(stats.displayedPoints)} shown` +
          ` / ${formatInt(stats.totalPoints)} total`,
        `gpu estimate  ${formatBytes(stats.gpuBytesEstimate)}`,
        `terrain comp  ${formatTerrainCompute(terrainCompute)}`,
      ].join('\n');
    } else {
      this._live.textContent = `backend       ${backendLabel}\n(initialising…)`;
    }

    if (streaming) {
      this._streamingLabel.classList.remove('olv-hidden');
      this._streaming.classList.remove('olv-hidden');
      const lines: string[] = [
        `nodes         ${streaming.residentNodes} resident / ${streaming.knownNodes} known`,
        `visible       ${streaming.visibleNodes}`,
        `queue         ${streaming.queuedNodes} queued / ${streaming.loadingNodes} decoding`,
        `points        ${formatInt(streaming.displayedPoints)} / ${formatInt(streaming.sourcePoints)}`,
      ];
      // Memory accounting — three-tier memory readout. Compressed (LRU bytes + cache
      // outcomes); decoded (CPU-side, sized from the decoded attribute set);
      // GPU (upload estimate). The decoded tier doesn't have its own cache
      // in this architecture, so it shares the upload / evict counts with
      // the GPU tier.
      if (
        streaming.cacheHits !== undefined &&
        streaming.cacheMisses !== undefined &&
        streaming.cacheEvictions !== undefined
      ) {
        const total = streaming.cacheHits + streaming.cacheMisses;
        const ratio =
          total > 0
            ? `${((100 * streaming.cacheHits) / total).toFixed(1)}%`
            : '—';
        lines.push(
          `compressed    ${formatBytes(streaming.cacheBytes)}` +
            ` · hits=${streaming.cacheHits} misses=${streaming.cacheMisses}` +
            ` (${ratio} hit) evict=${streaming.cacheEvictions}`,
        );
      } else {
        lines.push(`compressed    ${formatBytes(streaming.cacheBytes)}`);
      }
      if (streaming.decodedBytes !== undefined) {
        const events =
          streaming.nodesReady !== undefined && streaming.nodesEvicted !== undefined
            ? ` · uploads=${streaming.nodesReady} evict=${streaming.nodesEvicted}`
            : '';
        lines.push(`decoded       ${formatBytes(streaming.decodedBytes)}${events}`);
      }
      lines.push(`gpu estimate  ${formatBytes(streaming.gpuBytes)}`);
      if (streaming.thrashEvents !== undefined) {
        lines.push(`thrash        ${streaming.thrashEvents} event(s)`);
      }
      if (streaming.schedulerRecent && streaming.schedulerRecent.count > 0) {
        const r = streaming.schedulerRecent;
        lines.push(
          `scheduler     last ${streaming.schedulerMs.toFixed(1)} ms` +
            ` · n=${r.count}` +
            ` p50=${r.p50.toFixed(2)}` +
            ` p95=${r.p95.toFixed(2)}` +
            ` max=${r.max.toFixed(2)} ms`,
        );
      } else {
        lines.push(`scheduler     ${streaming.schedulerMs.toFixed(1)} ms`);
      }
      this._streaming.textContent = lines.join('\n');
    } else {
      this._streamingLabel.classList.add('olv-hidden');
      this._streaming.classList.add('olv-hidden');
    }
  }
}
