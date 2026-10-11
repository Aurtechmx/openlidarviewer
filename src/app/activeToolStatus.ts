/**
 * activeToolStatus.ts
 *
 * Reads the active pointer tool from the controllers' own state and keeps the
 * active-tool pill (`ui/activeToolIndicator.ts`) in step with it.
 *
 * Nothing here holds tool state. {@link readActiveTool} is a pure read of the
 * viewer's modes, the measurement kind and whether a draft is open; the pill's
 * Cancel calls the viewer's own mode exit, which is what Esc already runs, and
 * Finish calls the measurement controller's `finishCurrent`. Esc itself is not
 * re-bound: the viewer's handler keeps its place in the keyboard order, its
 * pointer-lock and dialog guards included.
 *
 * The wiring subscribes read-only: a MutationObserver on the tools' hint bars
 * (each controller toggles its bar on a mode change and rewrites its text on a
 * kind or draft change) plus a deferred re-read after any click, change or key
 * in the document, which covers the clip checkbox and the launcher rows.
 */

import { createActiveToolIndicator, type ActiveToolIndicator, type ActiveToolSnapshot } from '../ui/activeToolIndicator';

/** The slice of the Viewer the pill reads. */
export interface ActiveToolViewer {
  readonly measureMode: boolean;
  readonly inspectMode: boolean;
  readonly annotateMode: boolean;
  readonly measure: { readonly kind: string; firstVertexForClose(): unknown; finishCurrent(): void };
  setMeasureMode(on: boolean): void;
  setInspectMode(on: boolean): void;
  setAnnotateMode(on: boolean): void;
}

/** What the pointer is doing for each measurement kind. */
const MEASURE_LABEL: Record<string, string> = {
  distance: 'Measuring distance',
  polyline: 'Measuring path length',
  area: 'Measuring area',
  height: 'Measuring height',
  angle: 'Measuring angle',
  slope: 'Measuring slope',
  profile: 'Drawing profile',
  box: 'Drawing box',
  volume: 'Measuring volume',
};

export interface ActiveToolInputs {
  viewer: ActiveToolViewer | null;
  clipEnabled: boolean;
}

/** The pill's snapshot, read from the controllers. Pure. */
export function readActiveTool({ viewer: v, clipEnabled }: ActiveToolInputs): ActiveToolSnapshot {
  const chips = clipEnabled ? ['Clip on'] : [];
  if (!v) return { mode: null, chips };
  if (v.measureMode) {
    const kind = v.measure.kind;
    // The controller's own readiness: a polygon-type draft with enough
    // vertices to close (the same test its Finish polygon button uses).
    const canFinish = v.measure.firstVertexForClose() !== null;
    return {
      mode: {
        key: `measure:${kind}`,
        label: MEASURE_LABEL[kind] ?? 'Measuring',
        finish: canFinish ? () => v.measure.finishCurrent() : null,
        cancel: () => v.setMeasureMode(false),
      },
      chips,
    };
  }
  if (v.annotateMode) {
    return { mode: { key: 'annotate', label: 'Adding annotation', cancel: () => v.setAnnotateMode(false) }, chips };
  }
  if (v.inspectMode) {
    return { mode: { key: 'inspect', label: 'Inspecting points', cancel: () => v.setInspectMode(false) }, chips };
  }
  return { mode: null, chips };
}

export interface ActiveToolWiringDeps {
  viewer: () => ActiveToolViewer | null;
  clipEnabled: () => boolean;
  /** The stage overlay the pill floats in. */
  mount: HTMLElement;
  /** The tools' hint bars, observed for mode, kind and draft changes. */
  watch: readonly HTMLElement[];
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  observe?: (cb: () => void) => { observe(n: Node, o: MutationObserverInit): void; disconnect(): void };
}

export interface ActiveToolWiring {
  readonly indicator: ActiveToolIndicator;
  refresh(): void;
  dispose(): void;
}

export function wireActiveToolIndicator(d: ActiveToolWiringDeps): ActiveToolWiring {
  // One pill per overlay: a re-wire replaces any earlier one.
  for (const old of Array.from(d.mount.querySelectorAll('.olv-ati'))) old.remove();
  const indicator = createActiveToolIndicator();
  d.mount.append(indicator.element);

  const refresh = (): void => {
    indicator.update(readActiveTool({ viewer: d.viewer(), clipEnabled: d.clipEnabled() }));
    placeActiveToolPill(indicator.element, d.mount);
  };
  let queued = false;
  const later = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; refresh(); });
  };

  const make = d.observe ?? ((cb) => new MutationObserver(cb));
  const mo = make(refresh);
  for (const n of d.watch) mo.observe(n, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
  const doc = d.doc ?? document;
  const events = ['click', 'change', 'keyup'] as const;
  for (const t of events) doc.addEventListener(t, later, true);

  const win = typeof window === 'undefined' ? null : window;
  const onResize = (): void => placeActiveToolPill(indicator.element, d.mount);
  win?.addEventListener('resize', onResize);
  // Toasts, the touch hint and the phone sheet come and go on their own
  // timers. Re-seat when one of them changes size, toggles its class or
  // finishes a transition, coalesced to one placement per microtask.
  let seatQueued = false;
  const seatLater = (): void => {
    if (seatQueued || indicator.element.hidden) return;
    seatQueued = true;
    queueMicrotask(() => { seatQueued = false; onResize(); });
  };
  const seat = watchPillFloor(d.mount, indicator.element, seatLater);
  refresh();
  return {
    indicator,
    refresh,
    dispose: () => {
      mo.disconnect();
      win?.removeEventListener('resize', onResize);
      seat();
      for (const t of events) doc.removeEventListener(t, later, true);
      indicator.dispose();
      indicator.element.remove();
    },
  };
}

/**
 * What owns the bottom of the scene. The pill sits above every one of these
 * that shares its column: the navigation widget, a bottom toast, the touch
 * hint, the phone state strip and sheet, the dock.
 */
const FLOOR = ['.olv-navbar', '.olv-lasso-toast.olv-visible', '.olv-touch-hint.olv-visible', '.olv-state-strip', '.olv-mobile-sheet', '.olv-dock'];

/** Tool columns at the scene's side edge (the phone measure rail). */
const SIDE = ['.olv-mkinds', '.olv-measure-actions'];

/**
 * Call `seat` whenever something the pill sits above may have moved: a FLOOR
 * or SIDE element (or the host) resizes, any element's class or hidden flag
 * changes or nodes are added (a toast shows, the sheet opens), or a
 * transition or animation ends. Returns the disposer. Inert where the
 * observers are missing.
 */
function watchPillFloor(host: HTMLElement, pill: HTMLElement, seat: () => void): () => void {
  const doc = host.ownerDocument;
  const body = doc?.body;
  const RO = typeof ResizeObserver === 'function' ? ResizeObserver : null;
  const MO = typeof MutationObserver === 'function' ? MutationObserver : null;
  if (!doc || !body || !RO || !MO) return () => {};
  const sized = new Set<Element>();
  const ro = new RO(seat);
  const track = (): void => {
    const nodes = [host, ...Array.from(doc.querySelectorAll([...FLOOR, ...SIDE].map((x) => x.replace('.olv-visible', '')).join(',')))];
    for (const n of nodes) if (!sized.has(n)) { sized.add(n); ro.observe(n); }
    for (const n of sized) if (!n.isConnected) { sized.delete(n); ro.unobserve(n); }
  };
  track();
  const mo = new MO((records) => {
    if (records.every((r) => r.target === pill || pill.contains(r.target))) return;
    if (records.some((r) => r.type === 'childList')) track();
    seat();
  });
  mo.observe(body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  const ends = ['transitionend', 'animationend'] as const;
  for (const t of ends) doc.addEventListener(t, seat, true);
  return () => {
    mo.disconnect();
    ro.disconnect();
    for (const t of ends) doc.removeEventListener(t, seat, true);
  };
}

function laidOut(n: HTMLElement | null): DOMRect | null {
  const r = n?.getBoundingClientRect();
  return n && r && r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden' ? r : null;
}

/**
 * Seat the pill just above whatever owns the bottom of the scene, centred on
 * the navigation widget when it shows (so the pill never covers the mode
 * triangle) and on the scene otherwise. The stylesheet's placement is the
 * fallback; writes happen only on a change.
 */
export function placeActiveToolPill(pill: HTMLElement, host: HTMLElement): void {
  if (pill.hidden || typeof pill.getBoundingClientRect !== 'function' || typeof getComputedStyle !== 'function') return;
  const doc = pill.ownerDocument;
  const box = host.getBoundingClientRect();
  if (box.width === 0) return;
  const gap = 8;
  const half = pill.getBoundingClientRect().width / 2;
  const nav = laidOut(doc.querySelector<HTMLElement>('.olv-navbar'));
  const want = nav ? nav.left + nav.width / 2 - box.left : box.width / 2;
  let centre = Math.min(Math.max(want, half + gap), box.width - half - gap);
  const x0 = box.left + centre - half;
  const x1 = box.left + centre + half;
  let floor = box.bottom;
  for (const sel of FLOOR) {
    for (const n of Array.from(doc.querySelectorAll<HTMLElement>(sel))) {
      if (n === pill || n.contains(pill)) continue;
      const r = laidOut(n);
      if (!r || r.right <= x0 || r.left >= x1 || r.top < box.top + box.height / 3) continue;
      floor = Math.min(floor, r.top);
    }
  }
  // On a phone the measure kinds and actions stand as a column at the edge;
  // keep the pill's row clear of any such column it would cross.
  const rowTop = floor - gap - pill.getBoundingClientRect().height;
  let lo = box.left + gap;
  let hi = box.right - gap;
  for (const sel of SIDE) {
    for (const n of Array.from(doc.querySelectorAll<HTMLElement>(sel))) {
      const r = laidOut(n);
      if (!r || r.bottom <= rowTop || r.top >= floor) continue;
      if (r.left + r.width / 2 < box.left + box.width / 2) lo = Math.max(lo, r.right + gap);
      else hi = Math.min(hi, r.left - gap);
    }
  }
  if (hi - lo >= 2 * half) centre = Math.min(Math.max(centre, lo - box.left + half), hi - box.left - half);
  const left = `${Math.round(centre)}px`;
  const bottom = `${Math.round(box.bottom - floor + gap)}px`;
  if (pill.style.left !== left) pill.style.left = left;
  if (pill.style.bottom !== bottom) pill.style.bottom = bottom;
}
