/**
 * Busy scan: the shared waiting indicator for long operations.
 *
 * A geometric, nearly monochrome reduction of the OpenLiDARViewer emblem. A
 * point in a muted accent circles an invisible 3:1 orbit round a centre dot
 * that pulses gently in the host's text colour. Behind the point runs a
 * trail along the same orbit, brightest at the point and fading to nothing
 * at its tail.
 *
 * The trail shows progress. With no progress known (the default) it is a
 * short fixed tail. A host that knows how far along it is drives a controller
 * with `setProgress(fraction)`, and the trail grows from that short tail to
 * almost a full loop, so at completion it nearly closes the ellipse.
 * `complete()` lets the point come to rest at the front and the trail fade
 * out before the host removes the indicator.
 *
 * It is decorative only: `aria-hidden`, no text, no role. The host keeps its
 * own text status and its own `aria-busy` / `role="status"`. All motion is CSS
 * (see 57-busy-scan.css). Under `prefers-reduced-motion` nothing moves: the
 * point rests at the front with the trail showing current progress. The mark
 * is 1em tall and inline, so its host keeps its height.
 *
 * Built with createElementNS; no markup strings.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Class on the root <svg>; hosts and tests find the indicator by it. */
export const BUSY_SCAN_CLASS = 'olv-busy-scan';

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** The invisible orbit, centred at (20, 10), exactly 3:1, starting at its front. */
const ORBIT_PATH = 'M20 15A15 5 0 0 1 5 10A15 5 0 0 1 35 10A15 5 0 0 1 20 15';

/** Segments that make the trail, head brightest. */
export const TRAIL_SEGMENTS = 6;

/** Trail length, in hundredths of the orbit, with no progress known. */
export const TRAIL_IDLE = 15;
/** Trail length at 100% progress: nearly, never quite, a closed loop. */
export const TRAIL_FULL = 95;

/** How long a length change eases, and how long the trail takes to fade. */
export const LENGTH_EASE_MS = 300;
export const FADE_MS = 250;
/** Longest the completion waits for the point to come round to the front. */
export const SETTLE_WAIT_MS = 1000;

/** Create a detached busy indicator with a short fixed trail. */
export function createBusyScan(): SVGElement {
  const root = svgEl('svg', {
    class: BUSY_SCAN_CLASS,
    viewBox: '0 0 40 20',
    width: '40',
    height: '20',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const trail = svgEl('g', { class: 'olv-bs-trail' });
  for (let i = 0; i < TRAIL_SEGMENTS; i++) {
    trail.append(svgEl('path', { class: `olv-bs-seg olv-bs-seg-${i}`, d: ORBIT_PATH, pathLength: '100' }));
  }
  root.append(trail);
  root.append(svgEl('circle', { class: 'olv-bs-core', cx: '20', cy: '10', r: '1.25' }));
  // Drawn at the origin; the CSS carries it round the orbit on a motion path.
  root.append(svgEl('circle', { class: 'olv-bs-point', cx: '0', cy: '0', r: '1.4' }));
  return root;
}

/** A busy indicator whose trail a host can drive with its progress. */
export interface BusyScanController {
  readonly element: SVGElement;
  /**
   * Show progress, 0..1 (clamped). The trail only grows: a smaller value
   * leaves it where it is. `null` returns to the short indeterminate trail.
   */
  setProgress(fraction: number | null): void;
  /** Start again from the short trail, fading rather than snapping back. */
  reset(): void;
  /**
   * Finish: grow the trail to full, let the point come to rest at the front,
   * then fade the trail. Resolves when the fade is done; the host removes the
   * indicator (or hides its container) then.
   */
  complete(): Promise<void>;
  /** The trail length shown, in hundredths of the orbit. */
  readonly length: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Map progress (clamped to 0..1) to trail length. */
export function trailLength(fraction: number): number {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return TRAIL_IDLE + f * (TRAIL_FULL - TRAIL_IDLE);
}

export function createBusyScanController(): BusyScanController {
  const element = createBusyScan();
  let length = TRAIL_IDLE;
  let determinate = false;
  let generation = 0;
  const apply = (value: number): void => {
    length = value;
    element.style.setProperty('--olv-bs-len', value.toFixed(2));
  };
  const cls = (name: string, on: boolean): void => {
    const list = (element.getAttribute('class') ?? '').split(/\s+/).filter((c) => c && c !== name);
    if (on) list.push(name);
    element.setAttribute('class', list.join(' '));
  };
  // Fade the trail out, set the new length unseen, fade it back in.
  const fadeTo = (value: number): void => {
    const g = ++generation;
    cls('is-fading', true);
    setTimeout(() => {
      if (g !== generation) return;
      cls('is-instant', true);
      apply(value);
      setTimeout(() => {
        if (g !== generation) return;
        cls('is-instant', false);
        cls('is-fading', false);
      }, 20);
    }, FADE_MS);
  };
  apply(TRAIL_IDLE);
  return {
    element,
    get length() {
      return length;
    },
    setProgress(fraction) {
      if (fraction === null) {
        if (determinate) {
          determinate = false;
          fadeTo(TRAIL_IDLE);
        }
        return;
      }
      determinate = true;
      const next = trailLength(fraction);
      if (next > length) apply(next);
    },
    reset() {
      determinate = false;
      cls('is-settled', false);
      if (length !== TRAIL_IDLE) fadeTo(TRAIL_IDLE);
      else ++generation;
    },
    async complete() {
      const g = ++generation;
      determinate = true;
      apply(TRAIL_FULL);
      await wait(LENGTH_EASE_MS);
      if (g !== generation) return;
      // Stop at the front, where the point's loop restarts.
      const point = element.querySelector('.olv-bs-point');
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          point?.removeEventListener('animationiteration', done);
          resolve();
        };
        point?.addEventListener('animationiteration', done);
        setTimeout(done, SETTLE_WAIT_MS);
      });
      if (g !== generation) return;
      cls('is-settled', true);
      await wait(FADE_MS);
    },
  };
}

/**
 * Show the indicator in front of `text` inside `host`, replacing its content.
 * Setting `host.textContent` later (as every host does when the operation ends,
 * fails or is cancelled) removes it.
 */
export function showBusyScan(host: HTMLElement, text: string): void {
  host.replaceChildren(createBusyScan(), text);
}

/** Remove any indicator inside `host`. Safe to call when none is present. */
export function clearBusyScan(host: HTMLElement): void {
  for (const node of Array.from(host.querySelectorAll(`.${BUSY_SCAN_CLASS}`))) node.remove();
}
