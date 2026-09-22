/**
 * testAutoload.ts — a `?test=1&autoload=<name>` path that loads a sample scan
 * and reports the first post-load render back to whatever opened the page.
 *
 * `ios-runtime-matrix.yml` cannot drive the app. It opens a URL with
 * `xcrun simctl openurl` and has no WebDriver session to click the "Try a
 * sample scan" button or drag a file onto the canvas, so its only channel
 * back out is HTTP, from inside the page, to the marker server that workflow
 * already runs. This module closes that loop entirely within the page. It
 * fetches the same fixture the desktop and iOS touch specs use, hands it to
 * the exact function a real drop calls, then waits for
 * {@link Viewer.onDrawnFrame}, the render loop's own "a frame was drawn"
 * signal, not a proxy for it, and posts the result. A frame drawn after that
 * promise resolves is real evidence the page got through parse, upload and a
 * paravirtual-GPU draw call. A triangle page alone only shows the second
 * half.
 *
 * Reachable only through `__OLV_TEST_SEAM__` (main.ts already strips this
 * branch from any build that does not set `OLV_TEST_SEAM=1`), so this never
 * ships to a production bundle.
 */
import type { Viewer } from '../render/Viewer';

/** How long to wait for a drawn frame before reporting a timeout. */
const RENDER_TIMEOUT_MS = 45000;

export interface TestAutoloadDeps {
  /** The exact function DropZone calls on a real drop, no separate path. */
  handleFile: (file: File) => Promise<void>;
  getViewer: () => Viewer;
  params: URLSearchParams;
}

/**
 * Arms the autoload when `?autoload=<sampleName>` is present. A no-op
 * otherwise, since every other `?test=1` caller (Playwright, the desktop
 * specs) never passes that flag.
 */
export function installTestAutoload(deps: TestAutoloadDeps): void {
  const name = deps.params.get('autoload');
  if (!name) return;
  // The marker server is a separate origin from this page (vite preview vs.
  // the workflow's own static server), so the ping needs its full origin.
  // A bare `/mark` would ask this page's own server, which has no such
  // route. `?markerOrigin=` is blank for every non-matrix caller, and a
  // blank origin makes `postMark` a no-op rather than a same-origin guess.
  const markerOrigin = deps.params.get('markerOrigin') ?? '';
  const postMark = (ok: boolean, reason: string): void => {
    if (!markerOrigin) return;
    const q = `ok=${ok ? '1' : '0'}&reason=${encodeURIComponent(reason)}`;
    void fetch(`${markerOrigin}/mark?${q}`).catch(() => { /* best-effort */ });
  };
  void (async () => {
    let res: Response;
    try {
      res = await fetch(`/samples/${name}`);
    } catch (err) {
      postMark(false, `fetch-threw:${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!res.ok) { postMark(false, `fetch-failed:${res.status}`); return; }
    const buf = await res.arrayBuffer();
    const file = new File([buf], name, { type: 'application/octet-stream' });
    try {
      await deps.handleFile(file);
    } catch (err) {
      postMark(false, `load-threw:${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const viewer = deps.getViewer();
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsubscribe?.();
      postMark(false, 'timeout-no-frame-after-load');
    }, RENDER_TIMEOUT_MS);
    unsubscribe = viewer.onDrawnFrame(() => {
      clearTimeout(timer);
      unsubscribe?.();
      postMark(true, `frame-after-load pose=${JSON.stringify(viewer.getCameraPose())}`);
    });
  })();
}
