import type { Page } from '@playwright/test';

/**
 * Helpers for the long-task specs.
 *
 * Main-thread stalls are found with a 50 ms heartbeat, which works in every
 * engine (the Long Tasks API is Chromium only). The bound is 2 s, from
 * measurement: after the fix the worst block during a terrain run on a
 * 5.8M-point scan was 0.49 s at a 4x CPU slowdown, and before it the same run
 * held the thread for 17.1 s. Chrome offers "Page unresponsive" after a few
 * seconds without a response to input.
 */

export const MAX_GAP_MS = 2000;

/** Start the heartbeat and record every elapsed-time text the page shows. */
export async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __gap: number; __waits: string[]; __beat: number };
    w.__gap = 0;
    w.__waits = [];
    let last = performance.now();
    w.__beat = window.setInterval(() => {
      const now = performance.now();
      w.__gap = Math.max(w.__gap, now - last);
      last = now;
    }, 50);
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('.olv-busy-wait, .olv-ss-processing')) {
        const t = `${node.className}|${node.textContent ?? ''}`;
        if (/elapsed/.test(t) && !w.__waits.includes(t)) w.__waits.push(t);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

export async function stopWatching(page: Page): Promise<{ gap: number; waits: string[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __gap: number; __waits: string[]; __beat: number };
    clearInterval(w.__beat);
    return { gap: w.__gap, waits: w.__waits };
  });
}

export const settled = (page: Page) => page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)');

