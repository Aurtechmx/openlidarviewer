/**
 * ui.mjs: the iPhone.laz CRS journey in the real app, in Chromium.
 *
 * Opens the app from the Vite dev server, loads the hash-checked file through
 * the file input, reads the Coordinate system section and the Export
 * readiness rows, assigns EPSG:5514 with the section's own control, and reads
 * both again without reopening the file. Navigation is a drag and a wheel on
 * the canvas. Timings are recorded as measurements only.
 *
 * Run by run.mjs; standalone: node scripts/zenodo-study/ui.mjs <iPhone.laz> <out.json>
 */
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { startVite } from './pooled.mjs';

export async function runUi({ repo, input, headed = false }) {
  const require = createRequire(join(repo, 'package.json'));
  const { chromium } = require('playwright');
  const { child, url } = await startVite(repo);
  const browser = await chromium.launch({ headless: !headed });
  const t = {};
  const mark = (k, t0) => { t[k] = Math.round(performance.now() - t0); };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem('olv:tour:v1:completed', '1'); } catch { /* storage blocked */ } });
    await page.goto(`${url}/`);
    await page.locator('.olv-empty').waitFor({ state: 'visible', timeout: 60_000 });
    let t0 = performance.now();
    await page.locator('.olv-file-input').first().setInputFiles(input);
    await page.waitForFunction(() => document.querySelector('.olv-empty')?.classList.contains('olv-hidden'), null, { timeout: 120_000 });
    mark('openToFirstFrameMs', t0);

    const crsSection = async () => {
      const tab = page.locator('.olv-ws-tab[data-mode="data"]');
      if (await tab.count() && await tab.isVisible()) await tab.click();
      const summary = page.locator('summary', { hasText: 'Coordinate system' }).first();
      await summary.waitFor({ timeout: 30_000 });
      if (!(await summary.evaluate((s) => s.parentElement.open))) await summary.click();
      return summary.evaluate((s) => s.parentElement.innerText.replace(/\s+/g, ' ').trim());
    };
    const health = async () => {
      const tab = page.locator('.olv-ws-tab[data-mode="output"]');
      if (await tab.count() && await tab.isVisible()) await tab.click();
      const panel = page.locator('.olv-export-panel');
      await panel.waitFor({ timeout: 30_000 });
      if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
      const h = panel.locator('.olv-health');
      await h.waitFor({ timeout: 30_000 });
      return h.evaluate((el) => Object.fromEntries([...el.querySelectorAll('.olv-health-row')].map((r) => {
        const text = r.innerText.replace(/\s+/g, ' ').trim();
        return [text.split(' ').slice(0, 2).join(' '), { text, cls: r.className }];
      })));
    };

    const before = { crs: await crsSection(), health: await health() };

    // Navigate: orbit drag and wheel zoom on the canvas.
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    t0 = performance.now();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 60, { steps: 20 });
      await page.mouse.up();
      await page.mouse.wheel(0, -400);
    }
    mark('navigateMs', t0);

    // Assign EPSG:5514 with the section's own control; no re-import.
    await crsSection();
    const select = page.locator('.olv-crs-select').first();
    const options = await select.evaluate((s) => [...s.options].map((o) => o.value));
    const has5514 = options.includes('5514');
    t0 = performance.now();
    if (has5514) await select.selectOption('5514');
    await page.waitForTimeout(1000);
    mark('assignToSettledMs', t0);
    const after = { crs: await crsSection(), health: await health() };

    return {
      browser: `chromium ${browser.version()}`,
      headless: !headed,
      device: `${os.cpus()[0]?.model ?? 'unknown cpu'}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GiB, ${os.platform()} ${os.release()}`,
      viewport: '1440x900',
      before,
      assign5514Offered: has5514,
      after,
      timingsMs: t,
      pageErrors,
      notDone: ['clip', 'measure', 'export from the UI', 'reopen'],
    };
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  runUi({ repo, input: process.argv[2], headed: process.argv.includes('--headed') })
    .then((r) => { writeFileSync(process.argv[3], JSON.stringify(r, null, 2)); console.log(JSON.stringify(r, null, 2)); })
    .catch((e) => { console.error(e); process.exit(1); });
}
