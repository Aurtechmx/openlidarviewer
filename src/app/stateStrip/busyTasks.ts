/**
 * busyTasks.ts — report every busy indicator into the task-activity store.
 *
 * Every host that shows work in progress (file opening, streaming, the
 * Analyse run and its exports, the labs, the Observatory) draws the same
 * indicator from `ui/busyScan.ts`, carrying `BUSY_SCAN_CLASS`. This adapter
 * finds those indicators and registers each once, so the hosts report without
 * a line of their own and the eager shell does not grow. A task is live while
 * its indicator is rendered and not settled, and stays listed while its
 * panel is hidden until it settles or goes; the label is the status text the
 * host shows beside it. Progress is the fraction a progress controller last
 * drew, read back from its trail, and null for an indicator with no progress.
 *
 * Once a task has run for a second, its host also shows the elapsed time (and,
 * once the progress supports one, an estimate of the time left) beside the
 * indicator. That text is hidden from assistive technology, which hears a
 * polite update every {@link ANNOUNCE_EVERY_MS} instead of every tick.
 */

import { BUSY_SCAN_CLASS, TRAIL_FULL, TRAIL_IDLE } from '../../ui/busyScan';
import { registerTask, type TaskActivity } from '../../process/taskActivity';
import { formatWait, WAIT_SHOWN_AFTER_MS } from '../../process/waitClock';
import { announcePolite } from '../../ui/politeAnnounce';

/** Class on the elapsed-time text a host shows beside its indicator. */
export const BUSY_WAIT_CLASS = 'olv-busy-wait';
/** How often a long task is spoken to a screen reader. */
export const ANNOUNCE_EVERY_MS = 30_000;

const seen = new WeakSet<Element>();
/** Indicator per task id, and how many spoken updates each task has had. */
const indicators = new Map<number, Element>();
const spoken = new Map<number, number>();
/** The elapsed-time text written for each task, so it can be removed after the indicator is gone. */
const waits = new Map<number, Element>();
/** The elapsed time last seen per task, to notice a clock that started again. */
const lastElapsed = new Map<number, number>();

/** Progress read back from a trail length; null while the trail is idle. */
export function trailFraction(length: number): number | null {
  if (!(length > TRAIL_IDLE)) return null;
  return Math.min(1, (length - TRAIL_IDLE) / (TRAIL_FULL - TRAIL_IDLE));
}

/** The spoken-update count a task should have reached by `elapsedMs`. */
export function announcementsDue(elapsedMs: number): number {
  return Math.floor(elapsedMs / ANNOUNCE_EVERY_MS);
}

/** The host's status text beside the indicator, buttons excluded. */
export function hostText(indicator: Element): string {
  let node = indicator.parentElement;
  for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
    const parts: string[] = [];
    for (const child of Array.from(node.childNodes)) {
      if (child === indicator || (child instanceof Element && child.contains(indicator))) continue;
      if (child instanceof Element && child.tagName === 'BUTTON' && node.tagName !== 'BUTTON') continue;
      if (child instanceof Element && child.classList.contains(BUSY_WAIT_CLASS)) continue;
      parts.push(child.textContent ?? '');
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

/** True while the indicator is drawn: connected, not settled, not hidden. */
export function indicatorLive(indicator: Element): boolean {
  if (!indicator.isConnected) return false;
  if (indicator.classList.contains('is-settled')) return false;
  if (indicator.closest('.olv-hidden, [hidden]')) return false;
  const check = (indicator as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === 'function' ? check.call(indicator) : true;
}

/**
 * True while the indicator stands for running work: connected, not settled and
 * not hidden by its host. A layout that hides an ancestor (a lowered phone
 * sheet, a closed panel) does not end the work, so it does not count here.
 */
export function indicatorRunning(indicator: Element): boolean {
  return indicator.isConnected && !indicator.classList.contains('is-settled') && !indicator.closest('.olv-hidden, [hidden]');
}

/** Register every indicator in `root` not seen before. Cheap: one query. */
export function collectBusyTasks(root: ParentNode = document): void {
  for (const indicator of Array.from(root.querySelectorAll(`.${BUSY_SCAN_CLASS}`))) {
    if (seen.has(indicator)) continue;
    seen.add(indicator);
    let wasConnected = indicator.isConnected;
    const { id } = registerTask({
      label: () => hostText(indicator),
      progress: () => trailFraction(parseFloat((indicator as SVGElement).style?.getPropertyValue('--olv-bs-len') ?? '')),
      live: () => indicatorRunning(indicator),
      settled: () => indicator.classList.contains('is-settled'),
      run: () => (indicator as SVGElement).dataset?.run ?? '',
      gone: () => {
        if (indicator.isConnected) {
          wasConnected = true;
          return false;
        }
        return wasConnected;
      },
    });
    indicators.set(id, indicator);
  }
}

/**
 * The host's own text beside the indicator, with no walk upward. A button
 * host has none for this purpose: its text is a compact stand-in ("…"), and
 * the time would widen the button. Its task shows the time in the strip.
 */
function ownText(host: Element, indicator: Element): string {
  if (host.tagName === 'BUTTON') return '';
  let text = '';
  for (const child of Array.from(host.childNodes)) {
    if (child === indicator) continue;
    if (child.nodeType === 1) {
      const e = child as Element;
      if (e.tagName === 'BUTTON' || e.classList.contains(BUSY_WAIT_CLASS)) continue;
    }
    text += child.textContent ?? '';
  }
  return text.trim();
}

/** A label fit to be spoken: the host's text, or "Working" when it has no word in it. */
function spokenLabel(label: string): string {
  return /[\p{L}\p{N}]/u.test(label) ? label : 'Working';
}

/**
 * Write each live task's elapsed time beside its indicator, clear it from
 * tasks that ended or are hidden, and speak a long task's time every
 * {@link ANNOUNCE_EVERY_MS}. A host with no text of its own beside the
 * indicator (a placeholder card, a toast's icon slot, a compact button) gets
 * no inline text; the strip still shows its time.
 */
export function showBusyWaits(tasks: readonly TaskActivity[], announce: (message: string) => unknown = announcePolite): void {
  const live = new Set<number>();
  for (const t of tasks) {
    const indicator = indicators.get(t.id);
    if (!indicator) continue;
    const text = formatWait(t);
    // A clock that started again (the indicator reused for a new task) starts
    // its spoken updates again too.
    if (t.elapsedMs < (lastElapsed.get(t.id) ?? 0)) spoken.delete(t.id);
    lastElapsed.set(t.id, t.elapsedMs);
    const due = announcementsDue(t.elapsedMs);
    if (due > (spoken.get(t.id) ?? 0)) {
      spoken.set(t.id, due);
      announce(`${spokenLabel(t.label)}: ${text}.`);
    }
    const host = indicator.parentElement;
    if (!host || !indicatorLive(indicator) || t.elapsedMs < WAIT_SHOWN_AFTER_MS || !ownText(host, indicator)) continue;
    live.add(t.id);
    let wait = waits.get(t.id);
    if (!wait || wait.parentElement !== host) {
      wait?.remove();
      wait = document.createElement('span');
      wait.className = BUSY_WAIT_CLASS;
      wait.setAttribute('aria-hidden', 'true');
      host.append(wait);
      waits.set(t.id, wait);
    }
    if (wait.textContent !== text) wait.textContent = text;
  }
  for (const [id, indicator] of indicators) {
    if (live.has(id)) continue;
    waits.get(id)?.remove();
    waits.delete(id);
    if (!indicator.isConnected) {
      indicators.delete(id);
      spoken.delete(id);
      lastElapsed.delete(id);
    }
  }
}

/** Remove every elapsed-time text: the strip stopped polling (scan closed, strip disposed). */
export function clearBusyWaits(): void {
  for (const wait of waits.values()) wait.remove();
  waits.clear();
}
