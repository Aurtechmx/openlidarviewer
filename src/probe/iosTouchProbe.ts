/**
 * iosTouchProbe.ts — records what iOS actually delivers to a touch canvas,
 * without ever asking WebGL for a context.
 *
 * The iOS simulator leg (.github/workflows/ios-simulator.yml) has a known
 * ceiling: MobileSafari's GPU process dies mid-run when the runner's
 * paravirtual GPU driver crashes under WebGL, taking the whole session with
 * it. That crash is triggered by rendering, not by touch. This probe tests
 * the other half on its own: mount OLV's real canvas, with OLV's real CSS
 * (`touch-action: none` on `.olv-canvas`) and OLV's real gesture recognisers
 * (`touchTracker.ts` / `touchGesture.ts` / `touchTapGate.ts` — all DOM-free,
 * so importing them here pulls in no renderer), and log every event the
 * platform delivers. No `<canvas>` ever gets a rendering context, so the
 * driver that crashes SimMetalHost is never asked to do anything.
 *
 * Reached only through probe.html, which is built by vite.probe.config.ts —
 * a separate Vite config, run only by `npm run build:probe`, never by
 * `npm run build` / `build:live`. A production checkout that only ever runs
 * the real build never has probe.html or this module in its `dist/`; there is
 * no runtime flag to bypass here because there is no code path that reaches
 * it. scripts/ios-touch-trace.mjs is the only caller, and the iOS workflow
 * runs the probe build as an explicit extra step before that script runs.
 *
 * Everything below is DIAGNOSTIC LOGGING plus the two recognisers OLV ships.
 * Nothing here decides how a gesture should be interpreted — that is still
 * touchGesture.ts's job, unit-tested on its own. This only watches what goes
 * in and what comes out.
 */
import { TouchTracker } from '../render/touchTracker';
import { TouchTapGate } from '../render/touchTapGate';
// The real stylesheet (src/main.ts imports the same module). This is what
// actually puts `touch-action: none` on `.olv-canvas` — without it the
// probe's canvas would let the browser claim two-finger gestures for page
// zoom/scroll, which is exactly the failure this probe exists to rule out.
import '../styles';

/** One entry in the probe's log, tagged by source so a reader can filter. */
type LogEntry =
  | {
      readonly t: number;
      readonly kind: 'pointer';
      readonly type: string;
      readonly pointerId: number;
      readonly pointerType: string;
      readonly isPrimary: boolean;
      readonly clientX: number;
      readonly clientY: number;
      readonly cancelable: boolean;
      readonly defaultPrevented: boolean;
      /** `getCoalescedEvents().length`, or -1 where the platform has none. */
      readonly coalesced: number;
    }
  | {
      readonly t: number;
      readonly kind: 'touch';
      readonly type: string;
      readonly cancelable: boolean;
      readonly defaultPrevented: boolean;
      readonly changedTouches: readonly TouchPoint[];
      readonly targetTouches: number;
    }
  | {
      readonly t: number;
      readonly kind: 'gesture';
      readonly type: string;
      readonly scale: number;
      readonly rotation: number;
    }
  | {
      readonly t: number;
      readonly kind: 'recognizer';
      readonly component: 'pinch' | 'twist' | 'pan';
      readonly dPinch: number;
      readonly dTwist: number;
      readonly dPanX: number;
      readonly dPanY: number;
    }
  | {
      readonly t: number;
      readonly kind: 'doubletap';
      readonly x: number;
      readonly y: number;
    };

interface TouchPoint {
  readonly id: number;
  readonly clientX: number;
  readonly clientY: number;
  /** `radiusX`, where WebKit reports one; -1 where the browser has none. */
  readonly radiusX: number;
  /** `force`, 0-1; -1 where the browser reports no pressure model. */
  readonly force: number;
}

/** A snapshot of the two page-level signals a real gesture must never move. */
interface ViewportSnapshot {
  readonly visualViewportScale: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

const log: LogEntry[] = [];
const t0 = performance.now();
const now = (): number => performance.now() - t0;

function snapshotViewport(): ViewportSnapshot {
  const vv = window.visualViewport;
  return {
    visualViewportScale: vv ? vv.scale : 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

function touchPointsOf(list: TouchList): TouchPoint[] {
  const out: TouchPoint[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const withRadius = t as Touch & { radiusX?: number; force?: number };
    out.push({
      id: t.identifier,
      clientX: t.clientX,
      clientY: t.clientY,
      radiusX: typeof withRadius.radiusX === 'number' ? withRadius.radiusX : -1,
      force: typeof withRadius.force === 'number' ? withRadius.force : -1,
    });
  }
  return out;
}

/**
 * Build OLV's real stage markup — `.olv-stage > .olv-canvas` — the same two
 * elements `src/ui/Stage.ts` creates, with none of the panel chrome around
 * them. The CSS that matters here (`touch-action: none` on `.olv-canvas`,
 * from `src/styles/10-stage.css`) is selector-scoped to that class, so this
 * minimal shell gets the identical rule the real app gets.
 */
function buildStage(): HTMLCanvasElement {
  const root = document.createElement('div');
  root.className = 'olv-stage';
  const canvas = document.createElement('canvas');
  canvas.className = 'olv-canvas';
  root.appendChild(canvas);
  const app = document.getElementById('app');
  if (!app) throw new Error('probe.html has no #app mount');
  app.appendChild(root);
  return canvas;
}

/**
 * Wire the canvas exactly as `Viewer`'s constructor does (see
 * `src/render/Viewer.ts`, the `_onCanvasPointer*` block): touch-only
 * pointers feed `TouchTracker` and `TouchTapGate`, pointer capture is taken
 * on down and released on up/cancel, and a cancel is NOT treated as a
 * completed tap. The Viewer additionally gates this on `toolMode === 'none'`
 * and a user "two-finger twist" preference; the probe has no tools and no
 * preference UI, so it always behaves as the app does in its default,
 * out-of-the-box state.
 */
function wireRecognisers(canvas: HTMLCanvasElement): void {
  const tracker = new TouchTracker();
  const tapGate = new TouchTapGate();

  canvas.addEventListener('pointerdown', (e) => {
    logPointer(e);
    if (e.pointerType !== 'touch') return;
    tracker.down(e.pointerId, e.offsetX, e.offsetY);
    tapGate.down(tracker.size, e.offsetX, e.offsetY);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointerup still arrives */ }
  });

  canvas.addEventListener('pointermove', (e) => {
    logPointer(e);
    if (e.pointerType !== 'touch') return;
    tapGate.move(e.offsetX, e.offsetY);
    const delta = tracker.move(e.pointerId, e.offsetX, e.offsetY);
    if (!delta) return;
    const component: 'pinch' | 'twist' | 'pan' =
      delta.dPinch !== 0 ? 'pinch' : delta.dTwist !== 0 ? 'twist' : 'pan';
    log.push({
      t: now(), kind: 'recognizer', component,
      dPinch: delta.dPinch, dTwist: delta.dTwist,
      dPanX: delta.dPan.x, dPanY: delta.dPan.y,
    });
  });

  const endTouch = (e: PointerEvent): boolean => {
    if (e.pointerType !== 'touch') return false;
    tracker.up(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* released */ }
    return true;
  };

  canvas.addEventListener('pointerup', (e) => {
    logPointer(e);
    if (!endTouch(e)) return;
    const focus = tapGate.up(tracker.size, performance.now(), e.offsetX, e.offsetY);
    if (focus) log.push({ t: now(), kind: 'doubletap', x: focus.x, y: focus.y });
  });

  canvas.addEventListener('pointercancel', (e) => {
    logPointer(e);
    if (endTouch(e)) tapGate.cancel();
  });

  function logPointer(e: PointerEvent): void {
    const coalesced = typeof e.getCoalescedEvents === 'function'
      ? e.getCoalescedEvents().length
      : -1;
    log.push({
      t: now(), kind: 'pointer', type: e.type,
      pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
      clientX: e.clientX, clientY: e.clientY,
      cancelable: e.cancelable, defaultPrevented: e.defaultPrevented,
      coalesced,
    });
  }
}

/**
 * Raw `TouchEvent`s and Safari's nonstandard `GestureEvent`s, logged but fed
 * to nothing — OLV's recognisers read Pointer Events only (see
 * `wireRecognisers` above). Recorded here purely to answer, from the trace
 * itself, whether iOS hands the page anything a synthesized `PointerEvent`
 * in Playwright would not: WebKit's own zoom/rotate gesture, a `touchcancel`
 * a pointer stream never carried, or a `radiusX` / `force` no desktop
 * pointer event reports.
 */
function wireRawObservers(canvas: HTMLCanvasElement): void {
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
    canvas.addEventListener(type, (e) => {
      log.push({
        t: now(), kind: 'touch', type: e.type,
        cancelable: e.cancelable, defaultPrevented: e.defaultPrevented,
        changedTouches: touchPointsOf(e.changedTouches),
        targetTouches: e.targetTouches.length,
      });
    }, { passive: true });
  }

  // Older WebKit fires GestureEvent on the element under the touch; some
  // versions have also been seen to fire it on `window` once the target is
  // removed mid-gesture. Both are listened for; the trace records which.
  const gestureHandler = (type: string) => (e: Event) => {
    const g = e as unknown as { scale?: number; rotation?: number };
    log.push({
      t: now(), kind: 'gesture', type,
      scale: typeof g.scale === 'number' ? g.scale : Number.NaN,
      rotation: typeof g.rotation === 'number' ? g.rotation : Number.NaN,
    });
  };
  for (const target of [canvas, window] as const) {
    target.addEventListener('gesturestart', gestureHandler('gesturestart'));
    target.addEventListener('gesturechange', gestureHandler('gesturechange'));
    target.addEventListener('gestureend', gestureHandler('gestureend'));
  }
}

let before: ViewportSnapshot = snapshotViewport();

/**
 * The surface WebDriver drives through `execute/sync`. Mirrors the shape of
 * `window.__OLV_TEST_API__` (see `src/main.ts`) on purpose — same pattern,
 * a different, narrower seam for a page that has no Viewer to query.
 */
interface ProbeApi {
  readonly ready: true;
  /** Clear the log and re-snapshot the viewport, before a named gesture. */
  reset(): void;
  /** The full log since the last `reset()`, as JSON (see `LogEntry`). */
  getLog(): string;
  /** Counts and before/after viewport state, as JSON. */
  getSummary(): string;
}

function buildApi(): ProbeApi {
  return {
    ready: true,
    reset(): void {
      log.length = 0;
      before = snapshotViewport();
    },
    getLog(): string {
      return JSON.stringify(log);
    },
    getSummary(): string {
      const after = snapshotViewport();
      const counts = { pointer: 0, touch: 0, gesture: 0, recognizer: 0, doubletap: 0 };
      let touchcancel = 0;
      for (const e of log) {
        counts[e.kind] += 1;
        if (e.kind === 'touch' && e.type === 'touchcancel') touchcancel += 1;
        if (e.kind === 'pointer' && e.type === 'pointercancel') touchcancel += 1;
      }
      return JSON.stringify({ counts, touchcancel, before, after });
    },
  };
}

const canvas = buildStage();
wireRecognisers(canvas);
wireRawObservers(canvas);
(window as unknown as { __OLV_PROBE__: ProbeApi }).__OLV_PROBE__ = buildApi();
