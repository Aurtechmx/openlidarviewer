import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, dropTinyLas, dropTinyPly } from './helpers';

/**
 * The load toast reuses one busy indicator for every open. Each open must be
 * timed from its own start: a later open never shows the time an earlier one
 * took, or the time between them.
 *
 * Each file read is held for 1.5 s by a shim on `Blob.prototype.arrayBuffer`,
 * so each open waits long enough to show its time, on any engine. The strip's
 * Processing item is read on every change, and each figure is checked against
 * the time since the open that showed it began.
 */

const HOLD_MS = 1500;

async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __rec: { t: number; s: string }[] };
    w.__rec = [];
    new MutationObserver(() => {
      const s = document.querySelector('.olv-ss-processing .olv-ss-wait')?.textContent ?? '';
      if (s && w.__rec[w.__rec.length - 1]?.s !== s) w.__rec.push({ t: performance.now(), s });
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

const seconds = (s: string): number => {
  const m = /^· (?:(\d+) min )?(\d+) s elapsed/.exec(s);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN;
};

test('each open through the load toast is timed from its own start', async ({ page }) => {
  test.slow();
  await page.addInitScript((hold) => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function (this: Blob) {
      if ((window as unknown as { __hold?: boolean }).__hold) await new Promise((r) => setTimeout(r, hold));
      return read.call(this);
    };
  }, HOLD_MS);
  await page.goto('/?test=1');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await record(page);
  await page.evaluate(() => { (window as unknown as { __hold: boolean }).__hold = true; });

  const opens: number[] = [];
  for (const drop of [dropTinyLas, dropDenseGridPly]) {
    await page.waitForTimeout(4000);
    opens.push(await page.evaluate(() => performance.now()));
    await drop(page);
    await expect(page.locator('.olv-layer')).toHaveCount(opens.length + 1, { timeout: 60_000 });
  }

  const rec = await page.evaluate(() => (window as unknown as { __rec: { t: number; s: string }[] }).__rec);
  const timed = rec.filter((r) => r.t >= opens[0]);
  expect(timed.length, JSON.stringify(rec)).toBeGreaterThan(0);
  for (const r of timed) {
    const start = r.t >= opens[1] ? opens[1] : opens[0];
    expect(seconds(r.s), `${r.s} at ${Math.round(r.t - start)} ms into its open`).toBeLessThanOrEqual(Math.ceil((r.t - start) / 1000) + 1);
  }
});
