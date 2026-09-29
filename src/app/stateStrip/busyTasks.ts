/**
 * busyTasks.ts — report every busy indicator into the task-activity store.
 *
 * Every host that shows work in progress (file opening, streaming, the
 * Analyse run and its exports, the labs, the Observatory) draws the same
 * indicator from `ui/busyScan.ts`, carrying `BUSY_SCAN_CLASS`. This adapter
 * finds those indicators and registers each once, so the hosts report without
 * a line of their own and the eager shell does not grow. A task is live while
 * its indicator is rendered and not settled; the label is the status text the
 * host shows beside it. Progress is null: the hosts state it in that text.
 */

import { BUSY_SCAN_CLASS } from '../../ui/busyScan';
import { registerTask } from '../../process/taskActivity';

const seen = new WeakSet<Element>();

/** The host's status text beside the indicator, buttons excluded. */
export function hostText(indicator: Element): string {
  let node = indicator.parentElement;
  for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
    const parts: string[] = [];
    for (const child of Array.from(node.childNodes)) {
      if (child === indicator || (child instanceof Element && child.contains(indicator))) continue;
      if (child instanceof Element && child.tagName === 'BUTTON' && node.tagName !== 'BUTTON') continue;
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

/** Register every indicator in `root` not seen before. Cheap: one query. */
export function collectBusyTasks(root: ParentNode = document): void {
  for (const indicator of Array.from(root.querySelectorAll(`.${BUSY_SCAN_CLASS}`))) {
    if (seen.has(indicator)) continue;
    seen.add(indicator);
    let wasConnected = indicator.isConnected;
    registerTask({
      label: () => hostText(indicator),
      progress: () => null,
      live: () => indicatorLive(indicator),
      gone: () => {
        if (indicator.isConnected) {
          wasConnected = true;
          return false;
        }
        return wasConnected;
      },
    });
  }
}
