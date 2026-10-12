/**
 * hudSeat.ts: keep a floating surface clear of the HUD around it.
 *
 * Some surfaces float over the stage at fixed offsets with no knowledge of
 * what else is up: the flow lane (latest result and clip chip, top centre),
 * the tools' hold-Space hint (bottom centre) and the recovery notice (bottom
 * left). Each one names the surfaces it must stay clear of and is re-seated
 * whenever one of them shows, hides, resizes or finishes a transition, the
 * same way the active-tool pill is seated (app/activeToolStatus.ts).
 *
 * The shift is written as `--olv-seat` on the surface itself (pixels, never
 * negative); its stylesheet adds that to its own top or bottom offset, so the
 * stylesheet's placement stays the fallback.
 *
 * Pure geometry plus observers; inert where the DOM APIs are missing.
 */

/** The element's box when it is laid out and painted, else null. */
export function paintedBox(n: Element | null): DOMRect | null {
  if (!n || typeof (n as HTMLElement).getBoundingClientRect !== 'function' || typeof getComputedStyle !== 'function') return null;
  const r = n.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  const s = getComputedStyle(n);
  return s.visibility === 'hidden' || s.display === 'none' ? null : r;
}

/** Painted boxes of every match of `selectors` that shares the column [x0, x1). */
export function boxesInColumn(doc: Document, selectors: readonly string[], x0: number, x1: number, self: Element): DOMRect[] {
  const out: DOMRect[] = [];
  for (const n of Array.from(doc.querySelectorAll(selectors.join(',')))) {
    if (n === self || n.contains(self) || self.contains(n)) continue;
    const r = paintedBox(n);
    if (r && r.right > x0 && r.left < x1) out.push(r);
  }
  return out;
}

/**
 * How far a surface spanning [top, bottom) must move to clear `boxes` by `gap`.
 * `down` pushes it below every box it meets in the top half of the viewport;
 * `up` lifts it above every box it meets in the bottom half. Moving past one
 * box can land on the next, so it repeats until nothing is met.
 */
export function seatShift(top: number, bottom: number, boxes: readonly DOMRect[], dir: 'down' | 'up', mid: number, gap = 8): number {
  const near = boxes.filter((r) => (dir === 'down' ? r.top < mid : r.bottom > mid));
  let shift = 0;
  for (let i = 0; i <= near.length; i++) {
    const t = dir === 'down' ? top + shift : top - shift;
    const b = dir === 'down' ? bottom + shift : bottom - shift;
    const hit = near.filter((r) => r.top < b + gap && r.bottom + gap > t);
    if (!hit.length) break;
    shift = dir === 'down'
      ? Math.max(shift, ...hit.map((r) => r.bottom + gap - top))
      : Math.max(shift, ...hit.map((r) => bottom - (r.top - gap)));
  }
  return Math.max(0, Math.round(shift));
}

/**
 * Seat `self` clear of every match of `selectors` in its column: measured at
 * its stylesheet place (`--olv-seat` cleared), then shifted `dir` as far as
 * {@link seatShift} says. Both writes land in one task, so nothing paints
 * the unseated place.
 */
export function seatClear(self: HTMLElement, selectors: readonly string[], dir: 'down' | 'up', gap = 8): void {
  const doc = self.ownerDocument;
  if (!doc || !self.isConnected) return;
  self.style.removeProperty('--olv-seat');
  const base = paintedBox(self);
  if (!base) return;
  const mid = (doc.defaultView?.innerHeight ?? 0) / 2;
  const shift = seatShift(base.top, base.bottom, boxesInColumn(doc, selectors, base.left, base.right, self), dir, mid, gap);
  if (shift > 0) self.style.setProperty('--olv-seat', `${shift}px`);
}

/**
 * Run `seat` (coalesced to one call per microtask) whenever something it
 * depends on may have moved: any element's class or hidden flag changes or
 * nodes are added or removed, `self` or a match of `selectors` resizes, the
 * window resizes, or a transition or animation ends. Seating writes only a
 * custom property on `self`, which none of these observe, so it cannot loop.
 * Returns the disposer.
 */
export function watchSeat(self: HTMLElement, selectors: readonly string[], seat: () => void): () => void {
  const doc = self.ownerDocument;
  const body = doc?.body;
  const RO = typeof ResizeObserver === 'function' ? ResizeObserver : null;
  const MO = typeof MutationObserver === 'function' ? MutationObserver : null;
  if (!doc || !body || !RO || !MO || typeof doc.querySelectorAll !== 'function') return () => {};
  // Track every candidate, shown or not, so one that appears later is sized.
  const tracked = selectors.map((s) => s.replace(/\.olv-visible|:not\([^)]*\)/g, '')).join(',');
  const sized = new Set<Element>();
  const ro = new RO(() => later());
  const track = (): void => {
    for (const n of Array.from(doc.querySelectorAll(tracked))) if (!sized.has(n)) { sized.add(n); ro.observe(n); }
    for (const n of sized) if (!n.isConnected) { sized.delete(n); ro.unobserve(n); }
  };
  let queued = false;
  function later(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!self.isConnected) return;
      track();
      seat();
    });
  }
  ro.observe(self);
  track();
  const mo = new MO(later);
  mo.observe(body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  const win = doc.defaultView;
  win?.addEventListener('resize', later);
  const ends = ['transitionend', 'animationend'] as const;
  for (const t of ends) doc.addEventListener(t, later, true);
  later();
  return () => {
    mo.disconnect();
    ro.disconnect();
    win?.removeEventListener('resize', later);
    for (const t of ends) doc.removeEventListener(t, later, true);
  };
}
