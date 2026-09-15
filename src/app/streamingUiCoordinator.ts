/**
 * streamingUiCoordinator.ts
 *
 * The streaming panel's controls and its live status, owned in one place: the
 * quality setting, pause and resume, cache clearing, the full-cloud grade with
 * its re-entry guard and cancel, and the status poll that projects the
 * scheduler's counters into the panel. The Viewer stays the renderer and the
 * StreamingScheduler stays the scheduler; this only routes the panel's
 * intent to them and their state back to the panel.
 *
 * One snapshot per poll tick serves every reader: the panel line, the bar,
 * and whoever the shell registers on `onTick` (the settle one-shot of the
 * scan route, the streaming benchmark, the Inspector's residency detail), so
 * no two surfaces read a different instant. The poll cadence is a constant
 * the tests read. Readers unsubscribe through the function they get back.
 */
import { StreamingPanel } from '../ui/StreamingPanel';
import type { Viewer } from '../render/Viewer';
import type { StreamingQuality } from '../render/streaming/streamingBudget';
import type { StreamingSource } from '../render/streaming/StreamingSource';
import type { StreamingScheduler } from '../render/streaming/StreamingScheduler';
import type { StreamingDiagnostics } from '../render/streaming/streamingDiagnostics';
import type { SpatialContext } from '../geo/SpatialContext';

/** The poll cadence; the panel line, the bar and the tick readers share it. */
export const STREAMING_STATUS_POLL_MS = 250;

/** What one poll tick observed, handed to every reader at once. */
export interface StreamingTick {
  readonly cloud: StreamingSource;
  readonly scheduler: StreamingScheduler;
  readonly counts: ReturnType<StreamingSource['counts']>;
  readonly diagnostics: StreamingDiagnostics;
}

/** The renderer surface the panel's controls reach. */
export interface StreamingRendererPort {
  setStreamingColorMode: Viewer['setStreamingColorMode'];
  setStreamingQuality: Viewer['setStreamingQuality'];
  pauseStreaming(): void;
  resumeStreaming(): void;
  clearStreamingCache(): void;
  streamingCloud(): StreamingSource | null;
  streamingScheduler(): StreamingScheduler | null;
}

export interface StreamingUiCoordinatorDeps {
  readonly renderer: StreamingRendererPort;
  readonly isPhone: () => boolean;
  /** The grade runs over the whole Viewer through its lazily loaded action. */
  readonly getViewer: () => Viewer;
  readonly gradeContext: () => SpatialContext;
  readonly loadGrade: () => Promise<{
    runFullCloudGrade: (deps: {
      readonly viewer: Viewer;
      readonly panel: StreamingPanel;
      readonly signal?: AbortSignal;
      readonly debug?: boolean;
      readonly context: SpatialContext;
    }) => Promise<void>;
  }>;
  readonly debug: boolean;
  readonly setInterval?: (fn: () => void, ms: number) => number;
  readonly clearInterval?: (id: number) => void;
  /** Panel factory; tests hand in a fake. */
  readonly createPanel?: (callbacks: ConstructorParameters<typeof StreamingPanel>[0]) => StreamingPanel;
}

export interface StreamingUiCoordinator {
  readonly panel: StreamingPanel;
  quality(): StreamingQuality;
  /** The performance control moved the quality: record it and show it, the control applied it. */
  noteQualityFromControl(quality: StreamingQuality): void;
  /** Register a reader of every poll tick; returns the unsubscribe. */
  onTick(reader: (tick: StreamingTick) => void): () => void;
  startPolling(): void;
  stopPolling(): void;
  gradeRunning(): boolean;
  runGrade(): Promise<void>;
  cancelGrade(): void;
  /** The streaming scan closed: stop the poll, abort a grade, hide the panel. */
  endSession(): void;
}

export function createStreamingUiCoordinator(deps: StreamingUiCoordinatorDeps): StreamingUiCoordinator {
  const { renderer } = deps;
  const setInterval_ = deps.setInterval ?? ((fn, ms) => window.setInterval(fn, ms));
  const clearInterval_ = deps.clearInterval ?? ((id) => window.clearInterval(id));
  let quality: StreamingQuality = 'balanced';
  let timer: number | undefined;
  let gradeRunning = false;
  let gradeController: AbortController | null = null;
  const readers = new Set<(tick: StreamingTick) => void>();

  async function runGrade(): Promise<void> {
    if (gradeRunning) return;
    gradeRunning = true;
    gradeController = new AbortController();
    try {
      const { runFullCloudGrade } = await deps.loadGrade();
      await runFullCloudGrade({
        viewer: deps.getViewer(),
        panel,
        signal: gradeController.signal,
        debug: deps.debug,
        context: deps.gradeContext(), // the resolved frame, not the file's claim
      });
    } finally {
      gradeRunning = false;
      gradeController = null;
    }
  }
  const cancelGrade = (): void => gradeController?.abort();

  const makePanel = deps.createPanel ?? ((callbacks) => new StreamingPanel(callbacks));
  const panel = makePanel({
    onColorMode: (mode) => renderer.setStreamingColorMode(mode),
    onQuality: (q) => {
      quality = q;
      renderer.setStreamingQuality(q, deps.isPhone());
    },
    onPauseToggle: (paused) => {
      if (paused) renderer.pauseStreaming();
      else renderer.resumeStreaming();
    },
    onClearCache: () => renderer.clearStreamingCache(),
    onGradeFullCloud: () => void runGrade(),
    onCancelGrade: cancelGrade,
  });

  function stopPolling(): void {
    if (timer !== undefined) {
      clearInterval_(timer);
      timer = undefined;
    }
  }

  return {
    panel,
    quality: () => quality,
    noteQualityFromControl(q) {
      quality = q;
      panel.setQuality(q);
    },
    onTick(reader) {
      readers.add(reader);
      return () => { readers.delete(reader); };
    },
    startPolling() {
      stopPolling();
      timer = setInterval_(() => {
        const cloud = renderer.streamingCloud();
        const scheduler = renderer.streamingScheduler();
        if (!cloud || !scheduler) return;
        const counts = cloud.counts();
        const diagnostics = scheduler.diagnostics();
        panel.setStatus({
          loadedNodes: counts.resident,
          knownNodes: counts.known,
          displayedPoints: cloud.residentPointCount,
          sourcePoints: cloud.sourcePointCount,
          cacheBytes: scheduler.cacheStats().byteSize,
        });
        panel.setViewDiagnostics(diagnostics);
        const tick: StreamingTick = { cloud, scheduler, counts, diagnostics };
        for (const reader of readers) reader(tick);
      }, STREAMING_STATUS_POLL_MS);
    },
    stopPolling,
    gradeRunning: () => gradeRunning,
    runGrade,
    cancelGrade,
    endSession() {
      stopPolling();
      // The scan the grade was decoding is going away; stop it early.
      cancelGrade();
      panel.hide();
    },
  };
}
