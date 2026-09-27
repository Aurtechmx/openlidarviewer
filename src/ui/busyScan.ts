/**
 * Busy scan: the shared waiting indicator for long operations.
 *
 * A small inline SVG of a LiDAR pass. A beam sweeps left to right and leaves
 * returns behind it that settle into a ground profile, then the loop restarts.
 * It is decorative only: `aria-hidden`, no text, no role. The host keeps its
 * own text status and its own `aria-busy` / `role="status"`, which carry the
 * message for assistive tech.
 *
 * All motion is CSS (see 57-busy-scan.css), transform and opacity only, so it
 * adds nothing to the render loop. Under `prefers-reduced-motion` the CSS shows
 * the finished profile with no sweep. The mark is 1em tall and sits inline, so
 * it does not change the height of the line or button that hosts it.
 *
 * Built with createElementNS; no markup strings.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Class on the root <svg>; hosts and tests find the indicator by it. */
export const BUSY_SCAN_CLASS = 'olv-busy-scan';

/** Ground returns as [x, y] in a 40 x 20 box: a gentle ridge with a dip. */
const RETURNS: ReadonlyArray<readonly [number, number]> = [
  [3, 14], [7, 12], [11, 11], [15, 12], [19, 9],
  [23, 7], [27, 9], [31, 13], [35, 12], [38, 10],
];

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Create a detached busy indicator. */
export function createBusyScan(): SVGElement {
  const root = svgEl('svg', {
    class: BUSY_SCAN_CLASS,
    viewBox: '0 0 40 20',
    width: '40',
    height: '20',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  root.append(svgEl('line', { class: 'olv-busy-scan-beam', x1: '0', y1: '1', x2: '0', y2: '19' }));
  // Each return lights as the beam passes it; the per-dot delays live in the
  // CSS (nth-of-type), so no inline style is written here.
  for (const [x, y] of RETURNS) {
    root.append(svgEl('circle', { class: 'olv-busy-scan-pt', cx: String(x), cy: String(y), r: '1.4' }));
  }
  return root;
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
